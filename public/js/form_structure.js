// 양식 1열의 구조 조절 — 제목·필드 줄의 수준(1~FORM_LEVEL_MAX)·종류(제목/필드) 조작, 아직 보내지 않은 구조 변경 묶음, 구조 규칙 머리줄·대화상자 (FR-WB-094, 095, DR-WB-009).
// forms.js 의 위성 — forms.js 가 import 한다. 노드 갱신·다시 그리기·저장은 forms.js 가 맡고, 여기는 부품과 양식을 모르는 계산만 둔다.
// 화면 모듈(book.js·documents.js·analysis.js·explorer.js·forms.js)을 import 하지 않는다.
import { api } from './state.js';
import { fill, formatDate, h, toast } from './util.js';

export const FORM_LEVEL_MAX = 6; // 서버(lib/forms.js FORM_LEVEL_MAX)와 같다 — 스캔은 1~3 만 매기고 작성자가 더 깊게 둘 수 있다 (FR-WB-094)
export const KIND_LABEL = { heading: '제목', field: '필드' };
const KIND_TO = { heading: '제목으로', field: '필드로' };
// 「규칙으로 수준 정하기」 가 2열 양식 에이전트에게 보내는 정해진 요청문 (FR-WB-095)
export const STRUCTURE_REQUEST = '구조 규칙(<form_rules>)을 참고해 이 양식의 제목·필드 수준과 상하관계를 정해 주세요. 규칙과 같은 제목 아래 같은 글은 그대로 따르고, 비슷한 패턴(같은 이름표 줄 아래의 글머리 줄 등)은 유추해 적용하며, 바꿀 단위마다 structure 수정안으로 내 주세요.';
const RULES_URL = '/api/form-rules';

// ───────────────────────────── 줄 조작 ─────────────────────────────

// 제목 바로 뒤에 끼운 빈 필드(empty·after)는 제목이 될 수 없다 — 서버도 거절한다 (FR-WB-094)
export const canSwitchKind = node => node.kind === 'heading' || !(node.empty || node.after);

// 제목·필드 줄 끝의 조작 — ⇤ 상위로 · ⇥ 하위로 · 「제목으로」/「필드로」 + 조절·규칙 표시. 단추는 줄에 마우스를 올리거나 포커스가 있을 때만 보인다(CSS).
// handlers.level(i, delta) · handlers.kind(i, kind) 는 forms.js 의 것. 누른 뒤의 disabled·표시는 paintStructRow 가 맞춘다
export function structControls(node, i, handlers) {
  const other = node.kind === 'heading' ? 'field' : 'heading';
  const box = h('div.form-struct', { role: 'group', 'aria-label': `${KIND_LABEL[node.kind]} 구조 조절` },
    h('span.form-struct-mark', { hidden: true }),
    h('button.icon-btn.struct-up', { type: 'button', onclick: () => handlers.level(i, -1) }, '⇤'),
    h('button.icon-btn.struct-down', { type: 'button', onclick: () => handlers.level(i, +1) }, '⇥'),
    canSwitchKind(node) && h('button.icon-btn.struct-kind', { type: 'button', onclick: () => handlers.kind(i, other),
      title: node.kind === 'heading'
        ? `필드로 — 이 제목을 채우는 필드로 바꿉니다. 번호는 ${Number.isInteger(node.n) && node.n > 0 ? `되돌린 #${node.n}` : '새로'} 붙습니다`
        : `제목으로 — #${node.n} 을 제목으로 바꿉니다. 번호는 사라지되 되돌리면 같은 번호를 쓰고, 적은 값·지침이 있으면 지워집니다(확인합니다)` }, KIND_TO[other]));
  paintStruct(box, node);
  return box;
}

// 줄(h3.form-heading · div.form-field)의 수준 class 와 조작 상태를 노드에 맞춘다 — 수준만 바뀌면 다시 그리지 않고 이것만 부른다
export function paintStructRow(row, node) {
  for (const name of [...row.classList]) if (/^lvl-\d+$/.test(name)) row.classList.remove(name);
  row.classList.add(`lvl-${node.level}`);
  const box = row.querySelector(':scope > .form-struct');
  if (box) paintStruct(box, node);
}

function paintStruct(box, node) {
  const label = KIND_LABEL[node.kind];
  const up = box.querySelector('.struct-up');
  const down = box.querySelector('.struct-down');
  up.disabled = node.level <= 1;
  up.title = up.disabled ? '수준 1 — 더 올릴 수 없습니다' : `⇤ 상위로 — 이 ${label}의 수준을 ${node.level} 에서 ${node.level - 1} 로`;
  down.disabled = node.level >= FORM_LEVEL_MAX;
  down.title = down.disabled ? `수준 ${FORM_LEVEL_MAX} — 더 내릴 수 없습니다` : `⇥ 하위로 — 이 ${label}의 수준을 ${node.level} 에서 ${node.level + 1} 로`;
  if (up.disabled && document.activeElement === up) down.focus(); // 끝까지 간 단추가 비활성이 되면 포커스를 반대 단추로 — 키보드로 계속 조절할 수 있게
  else if (down.disabled && document.activeElement === down) up.focus();
  const mark = box.querySelector('.form-struct-mark');
  const was = node.orig ? `처음에는 ${KIND_LABEL[node.orig.kind] ?? node.orig.kind} 수준 ${node.orig.level}` : '';
  mark.hidden = !(node.user || node.rule);
  mark.textContent = node.user ? '조절' : '규칙';
  mark.classList.toggle('is-rule', !node.user);
  mark.title = node.user ? `작성자가 정한 구조 — ${was}. 이 상하관계는 구조 규칙으로 남아 같은 양식의 다른 문서에 다시 쓰입니다` : `구조 규칙 ${node.rule} 으로 맞춘 구조 — ${was}`;
}

// 서버(lib/forms.js applyStructure)와 같은 표시 — 첫 변경 전 상태를 orig 로 남기고 user 를 켠다. 처음 상태로 돌아오면 orig·user·rule 을 뗀다(규칙도 지워진다)
export function noteStructure(node, before) {
  if (!node.orig) node.orig = { kind: before.kind, level: before.level };
  if (node.orig.kind === node.kind && node.orig.level === node.level) {
    delete node.orig;
    delete node.user;
    delete node.rule;
  } else node.user = true;
}

// 서버가 돌려준 구조와 화면의 구조가 같은지 — 종류·수준·번호·조절 표시(orig·user·rule)만 본다. 다르면 forms.js 가 본문을 다시 그린다
export const structureKey = nodes => (Array.isArray(nodes) ? nodes : []).map(nd => [nd.kind, nd.level ?? '', nd.n ?? '', nd.orig ? `${nd.orig.kind}${nd.orig.level}` : '', nd.user ? 'u' : '', nd.rule ?? ''].join('|')).join('\n');

// ───────────────────────────── 아직 보내지 않은 구조 변경 ─────────────────────────────
// nodes index → { i, level, kind } — 같은 노드를 여러 번 바꾸면 마지막 상태만 남는다. putForm 이 보내는 순간 비우고, 실패하면 되돌려 넣는다 (FR-WB-094)

const pendingStructure = new Map();
export const recordStructure = (i, node) => pendingStructure.set(i, { i, level: node.level, kind: node.kind });
export function takeStructure() {
  const list = [...pendingStructure.values()];
  pendingStructure.clear();
  return list;
}
// 보내지 못한 것을 되돌려 넣는다 — 그새 같은 노드를 또 바꿨으면 그 새 상태가 우선
export function restoreStructure(list) {
  for (const entry of list) if (!pendingStructure.has(entry.i)) pendingStructure.set(entry.i, entry);
}
export const clearStructure = () => pendingStructure.clear(); // 다른 양식을 열 때 — 양식 밖에 남은 변경은 버린다

// ───────────────────────────── 구조 규칙 (FR-WB-095, DR-WB-009) ─────────────────────────────
// 작업공간 수준의 규칙 — 같은 양식으로 다른 문서를 올릴 때 (앞 제목, 글)이 같은 노드를 자동으로 맞추고, 에이전트가 수준을 정할 때 참고한다

let ruleCount = null; // 규칙 수 — 머리줄 「구조 규칙 N」. null 은 아직 모른다(불러오지 못했다)
let ruleHead = null; // 1열 머리줄의 두 단추 { count, ask } — 1열을 다시 그리면 바뀐다

// 1열 머리줄의 「구조 규칙 N」(누르면 대화상자) · 「규칙으로 수준 정하기」(규칙이 없으면 disabled — request 는 forms.js 가 2열로 보내는 손잡이)
export function rulesHeadControls({ request }) {
  const count = h('button.btn.small.ghost.form-rules-btn', { type: 'button', onclick: () => openRulesDialog() }, '구조 규칙 …');
  const ask = h('button.btn.small.ghost', { type: 'button', onclick: request }, '규칙으로 수준 정하기');
  ruleHead = { count, ask };
  paintRuleHead();
  refreshRules();
  return [count, ask];
}

function paintRuleHead(error = null) {
  if (!ruleHead) return;
  const n = ruleCount;
  ruleHead.count.textContent = n == null ? '구조 규칙 …' : `구조 규칙 ${n}`;
  ruleHead.count.title = error ? `구조 규칙을 불러오지 못했습니다: ${error}` : '작성자가 양식에서 정한 제목·필드의 수준·종류 규칙 — 같은 양식으로 다른 문서를 올릴 때 자동으로 맞추고, 에이전트가 수준을 정할 때 참고합니다. 눌러서 목록을 보고 지웁니다';
  ruleHead.ask.disabled = !n;
  ruleHead.ask.title = n
    ? '구조 규칙을 참고해 이 양식의 제목·필드 수준과 상하관계를 정하는 structure 수정안을 2열 에이전트에게 요청합니다'
    : '구조 규칙이 없습니다 — 1열에서 제목·필드의 수준이나 종류를 조절하면 규칙으로 남습니다';
}

// 저장 응답(rules)·대화상자의 삭제가 돌려준 목록으로 머리줄을 맞춘다
export function setRules(rules) {
  if (!Array.isArray(rules)) return;
  ruleCount = rules.length;
  paintRuleHead();
}

export async function refreshRules() {
  try {
    setRules((await api('GET', RULES_URL)).rules);
  } catch (err) {
    paintRuleHead(err.message); // 머리줄은 「구조 규칙 …」 로 남고 사유는 title 에
  }
}

// 규칙 목록 대화상자 — 줄마다 앞 제목 · 글 · 「필드 L1 → 제목 L1」 · 어느 양식(파일 이름 · 보고서/양식 번호) · 시각 · ✕ 삭제
export async function openRulesDialog() {
  if (document.querySelector('dialog.form-rules')) return;
  let rules;
  try {
    ({ rules } = await api('GET', RULES_URL));
  } catch (err) {
    return toast(`구조 규칙을 불러오지 못했습니다: ${err.message}`, 'error');
  }
  if (!Array.isArray(rules)) rules = [];
  setRules(rules);
  const list = h('div.form-rule-rows', { 'aria-label': '구조 규칙 목록' });
  const change = r => `${KIND_LABEL[r.from?.kind] ?? '?'} L${r.from?.level ?? '?'} → ${KIND_LABEL[r.kind] ?? r.kind} L${r.level}`;
  const whence = r => [r.fileName, [r.bookId, r.formId].filter(Boolean).join('/')].filter(Boolean).join(' · ');
  const row = r => h('div.form-rule', { dataset: { id: r.id } },
    h('div.form-rule-main',
      h('div.form-rule-ctx', { title: r.heading ? `앞 제목: ${r.heading}` : '앞에 제목이 없는 최상위 자리' }, r.heading || '(최상위)'),
      h('div.form-rule-text', { title: r.text }, r.text || '(빈 글)')),
    h('span.form-rule-change', { title: '처음 스캔 결과 → 작성자가 정한 종류·수준' }, change(r)),
    h('span.form-rule-meta', `${r.id} · ${whence(r) || '어느 양식인지 모름'} · ${formatDate(r.at)}`),
    h('button.icon-btn', { type: 'button', title: `${r.id} 삭제 — 이 규칙으로는 더 맞추지 않습니다. 이미 맞춘 양식은 그대로입니다`, 'aria-label': `${r.id} 삭제`, onclick: () => remove(r) }, '✕'));
  const paint = () => fill(list, rules.length ? rules.map(row) : h('p.muted.form-rules-empty', '아직 규칙이 없습니다 — 1열에서 제목·필드의 수준이나 종류를 조절하면 여기에 남습니다.'));
  async function remove(r) {
    try {
      ({ rules } = await api('DELETE', `${RULES_URL}/${encodeURIComponent(r.id)}`));
      if (!Array.isArray(rules)) rules = [];
      setRules(rules);
      paint();
      toast(`${r.id} 규칙을 지웠습니다`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  const dialog = h('dialog.dialog.form-rules', { 'aria-labelledby': 'form-rules-title' },
    h('h2', { id: 'form-rules-title' }, '구조 규칙'),
    h('p.muted', '작성자가 양식에서 정한 제목·필드의 수준·종류입니다. 같은 제목 아래 같은 글이 있는 문서를 올리면 자동으로 맞추고, 그 밖에는 에이전트가 참고해 수준을 정합니다. 1열에서 처음 상태로 되돌리면 그 규칙은 지워집니다.'),
    list,
    h('div.row-actions.end', h('button.btn.ghost', { type: 'button', onclick: () => dialog.close() }, '닫기')));
  paint();
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}
