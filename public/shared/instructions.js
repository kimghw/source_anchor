// 장 지시문(프롬프트)의 구성 — 여섯 절(문체 및 예시·헤딩 순서·제약조건·규정 및 규칙·작성요령·작성 요구사항)을 Markdown 문자열 하나로 둔다 (FR-WB-073).
// 저장·API·목차 수정안·에이전트는 문자열 하나를 보고, 화면(toc_editor.js)만 절마다 나눠 편집한다.
// 절에 속하지 않는 글(절 제목 없이 적힌 글, 다른 제목의 절, 중복된 절 제목)은 지우거나 옮기지 않고 그대로 보존한다 — 브라우저와 서버가 같은 파일을 쓴다.
// 보고서 공통 지시문과 "하위 장에도 적용"하는 상위 장의 지시문은 헤딩 순서를 뺀 다섯 절만 하위에 적용되고, 장에 적용되는 지시문은 절마다 출처를 붙여 합친다 (FR-WB-087).
export const SECTIONS = [
  { key: 'style', title: '문체 및 예시', hint: '문장 길이·어조·용어 표기, 본보기 문장' },
  { key: 'headings', title: '헤딩 순서', hint: '이 장 안의 소제목과 그 순서', ownOnly: true },
  { key: 'constraints', title: '제약조건', hint: '범위·기간·분량·표와 그림의 수, 다른 장에 넘길 것' },
  { key: 'rules', title: '규정 및 규칙', hint: '기준 문서에서 에이전트가 뽑아 채운다', extracted: true },
  { key: 'tips', title: '작성요령', hint: '기준 문서에서 에이전트가 뽑아 채운다', extracted: true },
  { key: 'requirements', title: '작성 요구사항', hint: '기준 문서에서 에이전트가 뽑아 채운다', extracted: true },
];
export const REPORT_SECTIONS = SECTIONS.filter(s => !s.ownOnly); // 보고서 공통 지시문과 하위 장에 물려주는 절 — 헤딩 순서는 그 장에만 있다
export const INSTRUCTIONS_LIMIT = 12_000; // 지시문 한 편(여섯 절 + 보존한 글)의 글자 수 상한 — 넘으면 자르지 않고 거절한다
export const GUIDE_KINDS = { guideline: '작성요령', reference: '참고문헌' }; // 기준 문서의 종류 (FR-WB-085) — 작성요령: 보고서를 쓸 때 따를 규정·규칙·요령·요구사항(지시문의 세 절을 채우는 자료), 참고문헌: 쓰면서 참고하는 문헌(규칙을 뽑지 않는다)
export const GUIDE_KIND_DEFAULT = 'guideline'; // 종류를 모를 때와 등록 대화상자의 첫 기본값
const LEGACY_GUIDE_KINDS = { regulation: 'guideline', rule: 'guideline', requirement: 'guideline', other: 'reference' }; // 두 종류가 되기 전(2026-10-22)의 다섯 종류
// 어떤 값이든 두 종류 가운데 하나로 — 서버는 저장·읽기에서, 화면은 탭에 나눌 때 같은 규칙을 쓴다(옛 서버가 남긴 값도 어느 탭에는 보인다) (DR-WB-006)
export const guideKind = kind => (GUIDE_KINDS[kind] ? kind : (LEGACY_GUIDE_KINDS[kind] ?? GUIDE_KIND_DEFAULT));

const titles = new Map(SECTIONS.map(s => [s.title, s.key]));
const HEADING = /^#{1,3}\s+(.+?)\s*:?\s*$/;
const FENCE = /^\s*(```|~~~)/;

// 절 제목 줄인지 — 여섯 절의 이름과 정확히 같은 제목만 절 경계다. 다른 제목(예: 헤딩 순서 절에 적은 "## 1. 개요")은 본문이다
export const sectionKeyOf = line => titles.get(line.match(HEADING)?.[1] ?? '') ?? null;

const trimLines = lines => {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b).join('\n');
};

// 문자열 → { preamble, sections: { style, headings, … } }. 코드 울타리 안의 제목은 경계로 보지 않고, 같은 절이 두 번 나오면 두 번째 제목 줄부터는 앞 절의 본문으로 남긴다
export function parseInstructions(text) {
  const sections = Object.fromEntries(SECTIONS.map(s => [s.key, []]));
  const preamble = [];
  let current = preamble;
  let inFence = false;
  const seen = new Set();
  for (const line of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    const key = !inFence ? sectionKeyOf(line) : null;
    if (key && !seen.has(key)) {
      seen.add(key);
      current = sections[key];
      continue;
    }
    current.push(line);
  }
  return { preamble: trimLines(preamble), sections: Object.fromEntries(SECTIONS.map(s => [s.key, trimLines(sections[s.key])])) };
}

// { preamble, sections } → 문자열. 비어 있는 절은 쓰지 않는다 — 절 없이 적힌 옛 지시문은 그대로 되돌아온다
export function formatInstructions({ preamble = '', sections = {} } = {}) {
  const parts = [];
  if (String(preamble).trim()) parts.push(String(preamble).trim());
  for (const s of SECTIONS) {
    const body = String(sections[s.key] || '').trim();
    if (body) parts.push(`## ${s.title}\n${body}`);
  }
  return parts.join('\n\n');
}

// 한도 검사 — 넘으면 이유를, 아니면 null. report: 보고서 공통 지시문은 헤딩 순서 절을 둘 수 없다 (FR-WB-087)
export function instructionsProblem(text, { report = false } = {}) {
  const n = String(text || '').length;
  if (n > INSTRUCTIONS_LIMIT) return `지시문은 ${INSTRUCTIONS_LIMIT.toLocaleString()}자까지입니다 (${n.toLocaleString()}자)`;
  if (report && parseInstructions(text).sections.headings) return '보고서 공통 지시문에는 헤딩 순서 절을 둘 수 없습니다 — 헤딩 순서는 장의 지시문에 적습니다';
  return null;
}

// ───────────────────────────── 하위 장에 적용 · 합친 지시문 (FR-WB-087) ─────────────────────────────

const level = ch => ch.level || 1;
export const hasChildren = (chapters, i) => i >= 0 && i + 1 < chapters.length && level(chapters[i + 1]) > level(chapters[i]);
export const cascades = ch => ch.cascade !== false; // "하위 장에도 적용" — 없으면 적용

// 장의 상위 장들 — 얕은 수준부터, 목차에서 바로 앞에 있는 더 얕은 장들
export function ancestorsOf(chapters, index) {
  const list = [];
  let depth = level(chapters[index]);
  for (let i = index - 1; i >= 0 && depth > 1; i--) {
    if (level(chapters[i]) < depth) {
      list.unshift(chapters[i]);
      depth = level(chapters[i]);
    }
  }
  return list;
}

// 장에 적용되는 지시문의 층 — [{ label, keys, parsed }] 보고서 공통 → 하위 장에도 적용하는 상위 장 → 이 장(own 이 true 일 때).
// 공통·상위 장은 헤딩 순서를 빼고, 이 장은 여섯 절 모두. book: { instructions, chapters: [{ id, title, level, instructions, cascade }] }
export function effectiveLayers(book, chapterId, { own = true } = {}) {
  const chapters = book?.chapters || [];
  const i = chapters.findIndex(ch => ch.id === chapterId);
  const upper = REPORT_SECTIONS.map(s => s.key);
  const layers = [{ label: '보고서 공통', keys: upper, parsed: parseInstructions(book?.instructions) }];
  if (i >= 0) {
    for (const ch of ancestorsOf(chapters, i)) if (cascades(ch)) layers.push({ label: `상위 장 ${ch.id} ${ch.title}`, keys: upper, parsed: parseInstructions(ch.instructions) });
    if (own) layers.push({ label: `이 장 ${chapters[i].id} ${chapters[i].title}`, keys: SECTIONS.map(s => s.key), parsed: parseInstructions(chapters[i].instructions), own: true });
  }
  return layers.filter(l => l.parsed.preamble || l.keys.some(k => l.parsed.sections[k]));
}

// 합친 지시문 글 — 절마다 [출처] 를 붙여 층 순서대로. 빈 결과는 ''
export function effectiveText(book, chapterId, options) {
  const layers = effectiveLayers(book, chapterId, options);
  const entry = (label, text) => `[${label}]\n${text}`;
  const parts = [];
  const preambles = layers.filter(l => l.parsed.preamble).map(l => entry(l.label, l.parsed.preamble));
  if (preambles.length) parts.push(preambles.join('\n'));
  for (const s of SECTIONS) {
    const entries = layers.filter(l => l.keys.includes(s.key) && l.parsed.sections[s.key]).map(l => entry(l.label, l.parsed.sections[s.key]));
    if (entries.length) parts.push(`## ${s.title}\n${entries.join('\n')}`);
  }
  return parts.join('\n\n');
}
