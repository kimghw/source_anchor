// 편집기에서 고른 문장의 작성 근거: 문장 유형, 수치 대조, 계산식, 연결된 원문 위치.
// 작성 화면 위에 떠 있는 창으로 뜨고, 작성자가 1열과 2열 사이의 열로 넣거나 다시 창으로 꺼낸다 (FR-WB-010).
import { SOURCE_TYPES } from '../shared/model.js';
import { computeCalc, evidenceNumbers, formatNumber, problemText, SENTENCE_TYPES, STATUS } from '../shared/text.js';
import { dropZone } from './dnd.js';
import { check, emit, linkAnchors, on, primarySentence, setCalc, setEvidenceOpen, setReviewed, setSentenceType, state, unlinkEvidence } from './state.js';
import { alignedNumber, fill, flash, fractionWidth, h, moveWindow, placeWindow } from './util.js';

let root, body, modeBtn;
let calcEditing = false;
// 표시 방식 — 떠 있는 창(기본)이거나 1열과 2열 사이의 열. 고른 방식은 브라우저에 남긴다
let floating = (() => { try { return localStorage.getItem('sa.evidence') !== 'docked'; } catch { return true; } })();
let windowBox = null; // 열로 넣어 둔 동안 기억하는 창의 자리·크기

export function initEvidence(container) {
  root = container;
  body = h('div.ev-scroll');
  modeBtn = h('button.btn.small.ghost', { type: 'button', onclick: () => setFloating(!floating) });
  root.append(
    h('header.col-head', { onpointerdown: event => { if (floating) moveWindow(root, event); } },
      h('div.col-title', h('span.col-index.anchor', '⚓'), '작성 근거'),
      h('div.col-head-actions',
        modeBtn,
        h('button.icon-btn', { type: 'button', title: '작성 근거 닫기 (문장을 클릭하면 다시 뜹니다)', 'aria-label': '작성 근거 닫기', onclick: () => setEvidenceOpen(false) }, '✕'))),
    body,
  );
  window.addEventListener('resize', () => { if (floating && !root.hidden) placeWindow(root, root.offsetLeft, root.offsetTop); });
  applyMode();
  dropZone(root, {
    accepts: payload => payload.from === 'source' && Boolean(primarySentence()),
    onDrop: (event, payload) => linkAnchors(primarySentence().id, payload.anchors),
  });
  let shownId = null;
  const update = () => {
    const id = primarySentence()?.id ?? null;
    if (id !== shownId) calcEditing = false;
    shownId = id;
    render();
  };
  on('doc', update);
  on('select', update);
}

// ───────────────────────────── 창 · 열 ─────────────────────────────

function applyMode() {
  root.classList.toggle('is-floating', floating);
  modeBtn.textContent = floating ? '열로 넣기' : '창으로 꺼내기';
  modeBtn.title = floating ? '작성 근거를 1열과 2열 사이의 열로 넣습니다' : '작성 근거를 작성 화면 위에 떠 있는 창으로 꺼냅니다';
}

function setFloating(value) {
  const { left, top, width, height } = root.style;
  if (floating) windowBox = { left, top, width, height };
  floating = value;
  // 열일 때는 창의 자리·크기(끌어 옮긴 자리, 모서리로 바꾼 크기)가 남아 있으면 안 된다 — 다시 꺼낼 때 되돌린다
  Object.assign(root.style, floating && windowBox ? windowBox : { left: '', top: '', width: '', height: '' });
  try { localStorage.setItem('sa.evidence', floating ? 'floating' : 'docked'); } catch { /* 남기지 못해도 화면은 그대로 쓴다 */ }
  applyMode();
  render();
}

// 창이 처음 뜨는 자리 — 편집기 바로 오른쪽(열로 넣었을 때의 자리)이라 고른 문장을 가리지 않는다
function home() {
  const editor = root.parentElement.querySelector('.col-editor').getBoundingClientRect();
  return [editor.right + 8, editor.top + 8];
}

function render() {
  root.hidden = !state.evidenceOpen;
  root.previousElementSibling.hidden = root.hidden || floating; // 열 너비 조절 손잡이 — 열일 때만 있다
  if (root.hidden) return;
  if (floating) placeWindow(root, ...(root.style.left ? [root.offsetLeft, root.offsetTop] : home()));
  const s = primarySentence();
  if (!s) {
    body.replaceChildren(h('div.empty', h('div.empty-icon', '⚓'), h('p', '편집기에서 문장을 클릭하면 그 문장을 어떤 원문에 근거해 썼는지 여기에 표시합니다.')));
    return;
  }
  const result = check(s);
  fill(body,
    state.sel.doc.length > 1 && h('p.ev-note', `문장 ${state.sel.doc.length}개를 선택했습니다. 마지막으로 고른 문장의 근거를 표시합니다.`),
    sentenceSection(s, result),
    numbersSection(s, result),
    calcSection(s, result),
    evidenceSection(s, result),
  );
}

// ───────────────────────────── 문장 · 상태 ─────────────────────────────

function sentenceSection(s, result) {
  const canReview = ['ok', 'stale', 'reviewed'].includes(result.status);
  return h('section.ev-section',
    h('div.ev-sentence-head',
      h('code.id', s.id),
      h('div.segmented', { role: 'group', 'aria-label': '문장 유형' }, Object.entries(SENTENCE_TYPES).map(([type, meta]) =>
        h('button', { type: 'button', class: s.type === type ? 'is-on' : '', title: meta.hint, onclick: () => setSentenceType(s.id, type) }, meta.label)))),
    h('blockquote.ev-sentence', s.text),
    h('div.ev-status', { class: `st-${result.status}` },
      h('span.badge', STATUS[result.status].label),
      h('span.ev-status-hint', STATUS[result.status].hint)),
    canReview && h('label.check',
      h('input', { type: 'checkbox', checked: result.status === 'reviewed', onchange: event => setReviewed(s.id, event.target.checked) }),
      '원문을 열어 기간·대상·조건까지 대조했습니다'),
  );
}

// ───────────────────────────── 수치 대조 ─────────────────────────────

function numbersSection(s, result) {
  const numbers = result.numbers.filter(n => !n.period);
  if (!numbers.length) return null;
  const frac = fractionWidth(numbers.map(n => n.raw));
  return h('section.ev-section',
    h('h3', '수치 대조', h('span.count', `${numbers.filter(n => !n.problem).length} / ${numbers.length} 일치`)),
    h('table.num-table',
      h('thead', h('tr', h('th.is-num', '문장의 수치'), h('th', '단위'), h('th', '대조한 근거'), h('th', '판정'))),
      h('tbody', numbers.map(n => h('tr', { class: n.problem ? 'is-bad' : 'is-ok' },
        h('td.is-num', alignedNumber(n.raw, frac)),
        h('td.unit', n.unit || '—'),
        h('td', n.match ? (n.match.calc ? '계산식' : refButton(n.match.evId)) : '—'),
        h('td.verdict', n.problem ? problemText(n) : '일치'))))),
  );
}

function refButton(evId) {
  return h('button.ref', { type: 'button', title: '아래 근거 카드로 이동', onclick: () => flash(body.querySelector(`[data-ev="${evId}"]`)) }, evId);
}

// ───────────────────────────── 계산식 ─────────────────────────────

// 연결된 근거의 수치에 a, b, c … 이름을 붙인다
function variables(s) {
  const vars = [];
  for (const evId of s.evidence) {
    evidenceNumbers(state.evidence[evId]).forEach((num, n) => vars.push({ name: String.fromCharCode(97 + vars.length), ev: evId, n, num }));
  }
  return vars.slice(0, 26);
}

function calcSection(s, result) {
  if (calcEditing) return calcForm(s);
  if (!s.calc) {
    const usable = variables(s).length >= 1;
    return usable && result.numbers.some(n => n.problem) ? h('section.ev-section',
      h('button.btn.small.ghost', { type: 'button', onclick: () => { calcEditing = true; render(); } }, '＋ 계산식 추가 (차이·비율처럼 계산한 수치)')) : null;
  }
  const calc = result.calc;
  const frac = fractionWidth([...calc.inputs.map(i => i.raw), calc.ok ? calc.display : '']);
  return h('section.ev-section',
    h('h3', '계산한 수치', h('span.count', '코드로 다시 계산')),
    h('div.calc-expr', h('code', s.calc.expr), calc.ok ? h('span', ` = ${calc.display}${calc.unit}`) : h('span.is-bad', ` → ${calc.error}`)),
    h('table.num-table',
      h('thead', h('tr', h('th', '입력'), h('th.is-num', '값'), h('th', '단위'), h('th', '근거'))),
      h('tbody',
        calc.inputs.map(i => h('tr', h('td', h('code', i.name)), h('td.is-num', alignedNumber(i.raw, frac)), h('td.unit', i.unit || '—'), h('td', refButton(i.evId)))),
        calc.ok && h('tr.is-total', h('td', '결과'), h('td.is-num', alignedNumber(calc.display, frac)), h('td.unit', calc.unit || '—'), h('td.muted', `소수 ${calc.round}자리 반올림`)))),
    h('div.row-actions',
      h('button.btn.small.ghost', { type: 'button', onclick: () => { calcEditing = true; render(); } }, '수정'),
      h('button.btn.small.ghost.danger', { type: 'button', onclick: () => setCalc(s.id, null) }, '계산식 삭제')),
  );
}

function calcForm(s) {
  const vars = variables(s);
  const expr = h('input', { type: 'text', value: s.calc?.expr ?? '', placeholder: '예: b - a  또는  b / a * 100', spellcheck: false });
  const unit = h('input', { type: 'text', value: s.calc?.unit ?? '', placeholder: '%p' });
  const round = h('input', { type: 'number', min: 0, max: 6, value: s.calc?.round ?? 1 });
  const preview = h('div.calc-preview');
  const build = () => {
    const used = new Set(expr.value.match(/[A-Za-z_]\w*/g) || []);
    return { expr: expr.value.trim(), unit: unit.value.trim(), round: Number(round.value) || 0, inputs: Object.fromEntries(vars.filter(v => used.has(v.name)).map(v => [v.name, { ev: v.ev, n: v.n }])) };
  };
  const update = () => {
    const out = expr.value.trim() ? computeCalc(build(), state.evidence) : null;
    preview.className = `calc-preview ${out && !out.ok ? 'is-bad' : ''}`;
    preview.textContent = !out ? '식을 입력하면 결과를 미리 계산합니다.' : out.ok ? `= ${formatNumber(out.value, out.round)}${out.unit}` : out.error;
    return out;
  };
  for (const input of [expr, unit, round]) input.addEventListener('input', update);
  const frac = fractionWidth(vars.map(v => v.num.raw));
  const form = h('form.calc-form', {
    onsubmit: event => {
      event.preventDefault();
      if (!update()?.ok) return;
      calcEditing = false;
      setCalc(s.id, build());
    },
  },
    h('table.num-table',
      h('thead', h('tr', h('th', '변수'), h('th.is-num', '값'), h('th', '단위'), h('th', '근거'))),
      h('tbody', vars.map(v => h('tr', h('td', h('code', v.name)), h('td.is-num', alignedNumber(v.num.raw, frac)), h('td.unit', v.num.unit || '—'), h('td.muted', `${v.ev} · ${state.evidence[v.ev].loc}`))))),
    h('label.field', '계산식', expr),
    h('div.field-row', h('label.field', '결과 단위', unit), h('label.field', '소수 자릿수', round)),
    preview,
    h('div.row-actions',
      h('button.btn.small', { type: 'submit' }, '저장'),
      h('button.btn.small.ghost', { type: 'button', onclick: () => { calcEditing = false; render(); } }, '취소')),
  );
  update();
  return h('section.ev-section', h('h3', '계산식'), form);
}

// ───────────────────────────── 연결된 근거 ─────────────────────────────

function evidenceSection(s, result) {
  const picked = state.sel.anchors.filter(a => !result.evidence.some(ev => ev.anchorId === a));
  return h('section.ev-section',
    h('h3', '연결된 근거', h('span.count', String(result.evidence.length))),
    result.evidence.map(ev => evidenceCard(s, ev)),
    h('div.ev-drop',
      h('p', '원문의 문장이나 표 셀을 여기로 끌어다 놓으면 이 문장의 근거로 연결합니다.'),
      picked.length > 0 && h('button.btn.small', { type: 'button', onclick: () => linkAnchors(s.id, picked) }, `원문에서 선택한 ${picked.length}개 연결`)),
  );
}

function evidenceCard(s, ev) {
  const source = state.sources.find(src => src.id === ev.sourceId);
  const alive = state.anchors.has(ev.anchorId);
  const f = ev.figure;
  return h('article.ev-card', { dataset: { ev: ev.id } },
    h('header',
      h('span.type-badge', { class: `type-${source?.type}` }, SOURCE_TYPES[source?.type] || '자료'),
      h('span.ev-card-title', source?.title || `${ev.sourceId} (삭제된 자료)`),
      h('code.id', ev.id)),
    h('div.ev-loc', ev.loc, h('span.muted', ` · ${ev.version}`)),
    f ? h('dl.figure',
      h('div.figure-value', h('dt', '값'), h('dd', h('span.num', f.display), h('span.unit', f.unit))),
      h('div', h('dt', '기간'), h('dd', f.period || '—')),
      h('div', h('dt', '대상'), h('dd', f.subject || '—')),
      h('div.figure-wide', h('dt', '분모'), h('dd', f.denominator || '표에 명시 없음')),
      h('div.figure-wide', h('dt', '표'), h('dd', f.tableTitle || '—')))
      : h('blockquote.ev-quote', ev.quote),
    h('div.row-actions',
      h('button.btn.small', { type: 'button', disabled: !alive, onclick: () => emit('open-anchor', ev.anchorId) }, '원문 위치 열기 →'),
      source?.url && h('a.btn.small.ghost', { href: source.url, target: '_blank', rel: 'noopener noreferrer' }, '원 URL ↗'),
      h('button.btn.small.ghost.danger', { type: 'button', onclick: () => unlinkEvidence(s.id, ev.id) }, '연결 해제')),
  );
}
