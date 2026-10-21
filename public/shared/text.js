// 문장 분리 · 수치 추출 · 계산식 · 규칙 기반 검증 — 브라우저와 서버(agent.js)가 같은 파일을 쓴다.

const segmenter = new Intl.Segmenter('ko', { granularity: 'sentence' });

export function splitSentences(text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const out = [];
  let carry = '';
  for (const { segment } of segmenter.segment(clean)) {
    const piece = (carry + segment).trim();
    carry = '';
    if (!piece) continue;
    // "1." 같은 번호나 "p." 같은 약어에서 끊긴 조각은 다음 조각에 붙인다
    if (/^(?:\d+|[A-Za-z]{1,3})\.$/.test(piece) || /(?:^|\s)(?:p|pp|No|vs|Fig)\.$/i.test(piece)) {
      carry = piece + ' ';
      continue;
    }
    out.push(piece);
  }
  if (carry.trim()) out.push(carry.trim());
  return out;
}

// ───────────────────────────── 제목 줄 판별 ─────────────────────────────

// 제목 형태의 글: 마크다운 # 표시로 시작하거나, "1." "1.1" "제1장" "가." "(1)" 같은 번호로 시작하고
// 문장 종결 부호(. ! ? 。)나 서술형 어미(…다 / …요) 없이 짧게 끝나는 글. 편집기·에이전트 수정안이 함께 쓴다 (FR-WB-026, 034).
// 제목이면 표시(#)를 뗀 글을, 아니면 null 을 돌려준다.
// bare: 번호가 없는 짧은 줄도 제목으로 본다 — 여러 줄을 붙여 넣었을 때 본문 줄 앞의 짧은 줄을 가리는 데만 쓴다.
const HEADING_MARK = /^#{1,6}\s+(\S.*)$/;
const HEADING_NUMBER = /^(?:\d{1,2}(?:\.\d{1,2}){0,3}\.?|[IVX]{1,4}\.|[가-힣]\.|\(\d{1,2}\)|\d{1,2}\)|제\s?\d{1,3}\s?[장절편부항])\s+\S/;
const SENTENCE_END = /(?:[.!?。]["'”’)]?|[다요])$/;
const LIST_MARK = /^[-*•·]\s/;
export function headingText(text, { bare = false } = {}) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  const marked = clean.match(HEADING_MARK);
  if (marked) return marked[1].trim();
  if (!clean || clean.length > 60 || SENTENCE_END.test(clean) || LIST_MARK.test(clean)) return null;
  if (HEADING_NUMBER.test(clean)) return clean;
  return bare && clean.length <= 40 && !/[,;:]$/.test(clean) ? clean : null;
}

// ───────────────────────────── 수치 추출 ─────────────────────────────

const RANGE_RE = /\d+(?:\.\d+)?\s?[~∼–-]\s?\d+(?:\.\d+)?\s?(?:세|년|월|일|분기|시|차)/g;
const NUM_RE = /(?<![\w.,])[-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g;
const UNIT_RE = /^\s?(%p|%|퍼센트포인트|퍼센트|천\s?명|만\s?명|명|조\s?원|억\s?원|만\s?원|천\s?원|원|개월|개사|개소|개|건|배|가구|곳|대|년도|년|월|일|분기|세|시간|시|분|위|회|차|호|쪽|번|GWh|MWh|kWh|MW|kW|km|kg|톤|㎡)/;
// 기간·순번을 나타내는 단위가 붙은 숫자는 근거 수치와 대조하지 않는다
const PERIOD_UNITS = new Set(['개월', '년도', '년', '월', '일', '분기', '세', '시', '분', '차', '호', '쪽', '번']);
const LABEL_BEFORE = /(?:표|그림|제|슬라이드|부록|[Pp]\.|Table|Fig\.?)\s?$/;

export function normUnit(unit) {
  const u = String(unit ?? '').replace(/\s+/g, '');
  if (u === '퍼센트') return '%';
  if (u === '퍼센트포인트') return '%p';
  return u;
}

export function parseNumber(text) {
  const m = String(text ?? '').trim().replace(/−/g, '-').match(/^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/);
  return m ? Number(m[0].replace(/,/g, '')) : null;
}

// [{ raw, value, unit, decimals, start, end, period }] — end 는 단위까지 포함한 끝 위치
export function extractNumbers(text) {
  const src = String(text ?? '');
  const masked = src.replace(RANGE_RE, m => ' '.repeat(m.length));
  const out = [];
  for (const m of masked.matchAll(NUM_RE)) {
    const start = m.index;
    const numEnd = start + m[0].length;
    const unitMatch = masked.slice(numEnd).match(UNIT_RE);
    const unit = unitMatch ? normUnit(unitMatch[1]) : '';
    const label = LABEL_BEFORE.test(masked.slice(Math.max(0, start - 6), start));
    out.push({
      raw: m[0],
      value: Number(m[0].replace(/,/g, '').replace('−', '-')),
      unit,
      decimals: (m[0].split('.')[1] || '').length,
      start,
      end: unitMatch ? numEnd + unitMatch[0].length : numEnd,
      // 단위 없이 쓴 네 자리 연도("2025 기준")도 기간으로 본다
      period: label || PERIOD_UNITS.has(unit) || (!unit && /^(?:19|20)\d{2}$/.test(m[0])),
    });
  }
  return out;
}

export function formatNumber(value, decimals = 0) {
  if (value == null || Number.isNaN(value)) return '';
  const s = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return (value < 0 ? '−' : '') + s;
}

// ───────────────────────────── 계산식 ─────────────────────────────

// 사칙연산·괄호·변수만 허용한다 (eval 을 쓰지 않는다)
export function evalCalc(expr, vars) {
  const tokens = String(expr ?? '').match(/\s*(\d+(?:\.\d+)?|[A-Za-z_]\w*|[-+*/()×÷−])/g)?.map(t => t.trim()) ?? [];
  if (tokens.join('') !== String(expr ?? '').replace(/\s+/g, '')) throw new Error('계산식에 쓸 수 없는 문자가 있습니다');
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  function primary() {
    const t = next();
    if (t === undefined) throw new Error('계산식이 끝나지 않았습니다');
    if (t === '(') {
      const v = additive();
      if (next() !== ')') throw new Error('괄호가 닫히지 않았습니다');
      return v;
    }
    if (t === '-' || t === '−') return -primary();
    if (/^\d/.test(t)) return Number(t);
    if (/^[A-Za-z_]/.test(t)) {
      if (!(t in vars)) throw new Error(`변수 ${t} 의 입력값이 없습니다`);
      return vars[t];
    }
    throw new Error(`예상하지 못한 기호: ${t}`);
  }
  function multiplicative() {
    let v = primary();
    while (['*', '/', '×', '÷'].includes(peek())) {
      const op = next();
      const r = primary();
      v = op === '*' || op === '×' ? v * r : v / r;
    }
    return v;
  }
  function additive() {
    let v = multiplicative();
    while (['+', '-', '−'].includes(peek())) {
      const op = next();
      const r = multiplicative();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  const result = additive();
  if (pos < tokens.length) throw new Error(`예상하지 못한 기호: ${peek()}`);
  if (!Number.isFinite(result)) throw new Error('계산 결과가 유한한 수가 아닙니다');
  return result;
}

// 근거 하나에서 대조에 쓸 수 있는 수치 목록
export function evidenceNumbers(ev) {
  if (!ev) return [];
  if (ev.figure && ev.figure.value != null) {
    return [{ raw: ev.figure.display, value: ev.figure.value, unit: normUnit(ev.figure.unit), decimals: (String(ev.figure.display).split('.')[1] || '').length }];
  }
  return extractNumbers(ev.quote).filter(n => !n.period);
}

// calc: { expr, unit, round, inputs: { a: { ev: 'E-0001', n: 0 } } }
export function computeCalc(calc, evidenceById) {
  const inputs = [];
  const vars = {};
  try {
    for (const [name, ref] of Object.entries(calc.inputs || {})) {
      const ev = evidenceById[ref.ev];
      const num = evidenceNumbers(ev)[ref.n ?? 0];
      if (!ev || !num) throw new Error(`입력값 ${name} 의 근거(${ref.ev})에서 수치를 찾지 못했습니다`);
      vars[name] = num.value;
      inputs.push({ name, evId: ref.ev, ...num });
    }
    const exact = evalCalc(calc.expr, vars);
    const round = Number.isInteger(calc.round) ? calc.round : 1;
    const value = Number(exact.toFixed(round));
    return { ok: true, inputs, exact, value, round, display: formatNumber(value, round), unit: normUnit(calc.unit) };
  } catch (err) {
    return { ok: false, inputs, error: err.message };
  }
}

// ───────────────────────────── 규칙 기반 검증 ─────────────────────────────

export const SENTENCE_TYPES = {
  fact: { label: '사실', hint: '출처 기반 사실 — 근거 필수' },
  interpretation: { label: '해석', hint: '근거 기반 해석 — 근거 필수' },
  proposal: { label: '제안', hint: '작성자 제안 — 근거 선택' },
  connective: { label: '연결', hint: '연결 문장 — 근거 불필요' },
};
const NEEDS_EVIDENCE = new Set(['fact', 'interpretation']);

export const STATUS = {
  reviewed: { label: '확인 완료', hint: '규칙 검사를 통과했고 사람이 원문과 대조했습니다.' },
  ok: { label: '규칙 통과', hint: '인용이 있고 수치가 근거와 일치합니다. 의미가 맞는지는 원문 대조가 필요합니다.' },
  stale: { label: '재확인 필요', hint: '원문 대조 이후 문장이 바뀌었습니다. 근거를 다시 확인하세요.' },
  mismatch: { label: '수치 불일치', hint: '문장의 수치나 단위가 연결된 근거와 다릅니다.' },
  conflict: { label: '출처 충돌', hint: '같은 대상·기간의 수치인데 연결된 근거끼리 값이 다릅니다. 기준일·정의·개정 여부를 비교해 확인하세요.' },
  missing: { label: '근거 없음', hint: '사실·해석 문장인데 연결된 근거가 없습니다.' },
  na: { label: '근거 불필요', hint: '제안·연결 문장입니다.' },
};

// 인용 존재와 수치·단위 일치만 본다. 문장이 근거의 의미를 벗어나는지는 사람이 확인한다.
export function verifySentence(sentence, evidenceById) {
  const evs = (sentence.evidence || []).map(id => evidenceById[id]).filter(Boolean);
  const pool = [];
  for (const ev of evs) evidenceNumbers(ev).forEach((n, i) => pool.push({ ...n, evId: ev.id, n: i }));
  const calc = sentence.calc ? computeCalc(sentence.calc, evidenceById) : null;
  if (calc?.ok) pool.push({ value: calc.value, unit: calc.unit, calc: true, raw: calc.display });

  const numbers = extractNumbers(sentence.text);
  for (const num of numbers) {
    if (num.period) continue;
    const same = pool.filter(p => Math.abs(p.value - num.value) < 1e-9);
    const hit = same.find(p => !p.unit || !num.unit || p.unit === num.unit);
    num.match = hit || null;
    num.problem = hit ? null : !evs.length ? 'no-evidence' : same.length ? 'unit' : 'value';
    if (!hit && same.length) num.conflict = same[0];
  }

  // 출처 충돌: 같은 대상·기간·단위의 수치 근거인데 값이 서로 다르다
  const figures = evs.filter(ev => ev.figure?.value != null).map(ev => ev.figure);
  const conflict = figures.some((a, i) => figures.slice(i + 1).some(b => a.subject === b.subject && a.period === b.period && normUnit(a.unit) === normUnit(b.unit) && a.value !== b.value));

  const checked = numbers.filter(n => !n.period);
  let status;
  if (!evs.length) status = NEEDS_EVIDENCE.has(sentence.type) ? 'missing' : 'na';
  else if (conflict) status = 'conflict';
  else if (checked.some(n => n.problem) || (calc && !calc.ok)) status = 'mismatch';
  else if (sentence.reviewedText != null) status = sentence.reviewedText === sentence.text ? 'reviewed' : 'stale';
  else status = 'ok';
  return { status, numbers, calc, evidence: evs };
}

export function problemText(num) {
  if (num.problem === 'unit') return `값은 같지만 단위가 다릅니다 (근거: ${num.conflict.raw}${num.conflict.unit})`;
  if (num.problem === 'value') return '연결된 근거에 이 값이 없습니다';
  if (num.problem === 'no-evidence') return '연결된 근거가 없습니다';
  return '';
}
