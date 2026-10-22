// 양식 화면 2열 — 양식 에이전트. 작성자가 #번호로 가리킨 칸·필드의 값을 제안받아 단위마다 반영하거나 거부한다 (FR-WB-091).
// 에이전트는 값을 직접 써 넣지 않는다 — 단위 한 건씩의 수정안(전후 글·사유·근거 위치)으로 내고, 반영한 값만 1열 양식에 들어간다.
// 제안을 낸 뒤 그 단위의 글이 달라졌으면 반영하지 않고 그렇게 표시한다. 채팅 부품(스트림·Markdown·사용량 표시)은 chat.js 의 것을 함께 쓴다.
// 제목·필드의 수준·종류(상하관계) 제안도 같은 방식의 구조 수정안 카드로 — 반영하면 forms.js 가 1열을 바꾸고 저장하며 구조 규칙으로 남긴다 (FR-WB-095).
// forms.js 가 이 모듈을 부르므로 forms.js·book.js·book_chat.js 를 import 하지 않는다 — 1열·3열 조작은 handlers 로 받는다.
import { describeUsage, modelOptions, renderMarkdown, streamChat, TOOL_LABELS } from './chat.js';
import { collapseButton } from './columns.js';
import { api } from './state.js';
import { noteCard } from './note_cards.js';
import { diffText } from './suggest.js';
import { fill, h, toast } from './util.js';

let log, input, sendBtn, modelSelect, ctxMeter;
const go = { cellText: () => '', applyValue: () => false, revealCell: () => {}, markProposal: () => {}, showSource: () => {}, openChapter: async () => {}, flush: async () => true, applyStructure: () => false, nodeState: () => null, revealNode: () => {}, guidesChanged: async () => {} };
let view = { bookId: null, form: null };
let conversationId = null;
let running = false;
let abort = null;
let lastModel = null;
let models = [];
let usageByModel = {}; // 이 대화에서 응답한 모델별 컨텍스트 사용량 (FR-WB-058)
// 수정안 묶음 — 카드의 data-batch 는 key. 값: { key, id, model, items: [{ id, cell, kind, text, reason, anchors, before, label, decision }] } · 구조: { key, id, model, structure: true, items: [{ id, structure: true, target, i, text, before: { kind, level }, level, kind, reason, decision }] }
// decision: 'pending' | 'accepted' | 'rejected' | 'stale'
let batches = [];

const SUGGESTIONS = [
  { label: '빈 칸 채우기', text: '비어 있는 칸과 필드를 각 번호의 지침에 따라 채워 줘' },
  { label: '이 칸 고치기', text: '#N 을 … 로 고쳐 줘', prefill: true }, // 번호와 내용은 작성자가 채워 보낸다 — 입력창에 넣기만 한다
];

export function initFormChat(root, handlers) {
  Object.assign(go, handlers);
  modelSelect = h('select.model-select', { title: '양식 에이전트 모델', 'aria-label': '양식 에이전트 모델', onchange: () => { renderUsage(); try { localStorage.setItem('sa.model', modelSelect.value); } catch { /* 저장하지 못해도 이번 대화에는 적용된다 */ } } });
  ctxMeter = h('span.ctx-meter', { hidden: true });
  log = h('div.chat-log');
  input = h('textarea', { rows: 2, 'aria-label': '양식 에이전트에게 요청', placeholder: '채울 칸을 #번호로 가리켜 알려주세요…' });
  sendBtn = h('button.btn', { type: 'submit' }, '보내기');
  const form = h('form.composer', { onsubmit: event => { event.preventDefault(); running ? stop() : send(input.value); } }, h('div.composer-row', input, sendBtn),
    h('div.composer-hint', h('span', '#번호로 칸과 필드를 가리키세요'), h('span', '↵ 전송 · Shift + ↵ 줄바꿈')));
  root.append(
    h('header.col-head',
      h('div.col-title', h('span.col-index', '2'), '에이전트', modelSelect, ctxMeter),
      h('div.col-head-actions', h('button.btn.small.ghost', { type: 'button', onclick: newChat }, '새 대화'), collapseButton(root, '2열 에이전트'))),
    log,
    form,
  );
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  log.addEventListener('click', onLogClick);
  newChat();
  loadModels();
}

// forms.js 가 양식을 그리거나 단위를 손으로 고칠 때마다 부른다 — 다른 양식이거나 다른 맥락 보고서(양식은 공통이지만 에이전트가 읽는 원문이 달라진다)면 대화를 새로 시작하고, 같으면 카드의 반영 가능 여부만 다시 맞춘다
export function setFormView(next) {
  const changed = next.bookId !== view.bookId || next.form?.id !== view.form?.id;
  view = next;
  if (changed) newChat();
  else renderFormCards();
}

// 1열 머리줄의 정해진 요청(「규칙으로 수준 정하기」)을 이 대화로 보낸다 — 답하는 중이거나 양식이 없으면 보내지 않고 알린다 (FR-WB-095)
export function sendFormMessage(text) {
  if (!view.form) return false;
  if (running) {
    toast('에이전트의 답변이 끝나면 다시 요청하세요.', 'error');
    return false;
  }
  send(text);
  return true;
}

async function loadModels() {
  try {
    const status = await api('GET', '/api/agent/status');
    models = status.models;
    let saved = null;
    try { saved = localStorage.getItem('sa.model'); } catch { /* 기본 모델을 쓴다 */ }
    fill(modelSelect, modelOptions(models, models.find(m => m.key === saved && m.available)?.key ?? status.default));
  } catch {
    fill(modelSelect, h('option', '모델 목록을 불러오지 못했습니다'));
  }
}

const modelLabel = key => models.find(m => m.key === key)?.label ?? key;

function renderUsage() {
  const u = usageByModel[modelSelect.value];
  ctxMeter.hidden = !u;
  if (!u) return;
  const shown = describeUsage(u, modelLabel(modelSelect.value));
  ctxMeter.textContent = shown.text;
  ctxMeter.classList.toggle('is-high', shown.high);
  ctxMeter.title = shown.title;
}

// 새 대화 — 남은 수정안의 1열 표시도 거둔다
function newChat() {
  if (running) stop();
  for (const n of pendingCells()) go.markProposal(n, false);
  conversationId = null;
  lastModel = null;
  usageByModel = {};
  batches = [];
  renderUsage();
  log.replaceChildren(h('div.chat-welcome',
    h('span.welcome-eyebrow', '양식 에이전트'),
    h('h2.welcome-title', '칸과 필드를 번호로 채우세요'),
    h('p', '1열 배지의 번호(#5 처럼)로 채울 칸과 필드를 가리키면, 번호별 지침과 보고서의 원문을 바탕으로 값을 제안합니다.'),
    h('div.suggestions', SUGGESTIONS.map(({ label, text, prefill }) => h('button.suggestion', { type: 'button', title: text, onclick: () => { if (!prefill) return send(text); input.value = text; input.focus(); } }, label))),
    h('p.muted.welcome-note', '제안은 칸마다 검토해 반영하거나 거부하세요. 반영하기 전에는 양식이 바뀌지 않습니다.')));
}

// ───────────────────────────── 보내기 · 받기 ─────────────────────────────

async function send(text) {
  text = text.trim();
  if (!text || running || !view.form) return;
  const model = modelSelect.value;
  log.querySelector('.chat-welcome')?.remove();
  if (lastModel && lastModel !== model) log.append(h('div.notice', `모델을 ${modelLabel(lastModel)} → ${modelLabel(model)} 로 바꿨습니다. 앞선 대화 내용을 함께 전달합니다.`));
  lastModel = model;
  log.append(h('div.msg.msg-user', h('div.msg-text', text)));
  input.value = '';
  const typing = h('div.typing', h('span'), h('span'), h('span'));
  const bubble = h('div.msg.msg-agent', h('div.msg-model', modelLabel(model)), typing);
  log.append(bubble);
  scrollToEnd();
  setRunning(true);

  let textEl = null;
  let raw = '';
  const handlers = {
    start: ev => { conversationId = ev.conversationId; },
    text_start: () => { raw = ''; textEl = h('div.msg-text'); bubble.append(textEl); },
    text: ev => { raw += ev.d; textEl.replaceChildren(...renderMarkdown(raw, formLinks)); },
    tool: ev => bubble.append(h('div.tool', h('span.tool-name', TOOL_LABELS[ev.name] || ev.name), h('span.tool-summary', ev.summary || ''))),
    form: ev => {
      batches.push({ key: ev.id, id: ev.id, model: ev.model, items: ev.items.map(item => ({ ...item, decision: 'pending' })) });
      bubble.append(h('div.proposal', { dataset: { batch: ev.id } }));
      renderFormCards();
    },
    structure: ev => { // 제목·필드의 수준·종류 수정안 — 값 수정안과 같은 턴에 올 수 있으므로 카드 열쇠를 따로 둔다 (FR-WB-095)
      const key = `structure:${ev.id}`;
      batches.push({ key, id: ev.id, model: ev.model, structure: true, items: ev.items.map(item => ({ ...item, structure: true, decision: 'pending' })) });
      bubble.append(h('div.proposal', { dataset: { batch: key } }));
      renderFormCards();
    },
    guides: ev => bubble.append(noteCard(ev, { saved: () => go.guidesChanged() })), // 작성요령 저장 카드 — 저장하면 3열 기준 문서 목록을 다시 받는다 (FR-WB-100)
    notice: ev => bubble.append(h('div.notice', ev.text)),
    usage: ev => { usageByModel[ev.model] = ev; renderUsage(); },
    error: ev => bubble.append(h('div.notice.is-error', ev.message)),
  };

  try {
    abort = new AbortController();
    // 에이전트는 서버에 저장된 양식을 읽는다 — 아직 보내지 않은 값·지침을 먼저 저장해야 수정안의 '전' 글이 지금 글과 맞는다
    if (!(await go.flush())) throw new Error('양식을 저장하지 못해 보내지 않았습니다 — 저장된 뒤 다시 보내세요.');
    await streamChat({ conversationId, text, model, bookId: view.bookId, formId: view.form.id }, abort.signal, ev => {
      handlers[ev.t]?.(ev);
      bubble.append(typing);
      scrollToEnd();
    });
  } catch (err) {
    if (err.name !== 'AbortError') bubble.append(h('div.notice.is-error', err.message));
  } finally {
    typing.remove();
    for (const el of bubble.querySelectorAll('.msg-text')) if (!el.textContent.trim()) el.remove();
    if (bubble.childElementCount <= 1) bubble.append(h('div.notice', '중지했습니다.'));
    setRunning(false);
  }
}

function stop() {
  if (conversationId) api('POST', '/api/chat/stop', { conversationId }).catch(() => {});
  abort?.abort();
}

function setRunning(value) {
  running = value;
  sendBtn.textContent = value ? '중지' : '보내기';
  sendBtn.classList.toggle('danger', value);
  modelSelect.disabled = value;
}

function scrollToEnd() {
  log.scrollTop = log.scrollHeight;
}

// ───────────────────────────── 답 속의 링크 ─────────────────────────────
// #번호는 1열의 그 단위를 비추는 링크로, 장 표시가 붙은 ID(R-002 · R-002/S-001 · R-002/S-001.b5.s2 · R-002/T-0005)는 그 자리를 여는 링크로 — 앞쪽은 book_chat.js BOOK_ID_RE 와 같은 규칙

const LINK_RE = /\b(R-\d{3,})(?:\/(S-\d{3}(?:\.b\d+\.(?:s\d+|r\d+c\d+))?|T-\d{4}))?\b|(?<![\w#&])#(\d+)(?!\w)/g;
const wrap = (text, code) => (code ? h('code', text) : text);

function refTitle(ref) {
  const rest = ref.split('/')[1];
  if (!rest) return `${ref}\n누르면 이 장의 작성 화면을 엽니다`;
  if (rest.startsWith('T-')) return `${ref}\n누르면 이 장의 작성 화면에서 그 문장을 보여 줍니다`;
  return `${ref}\n3열에서 이 원문 열기`;
}

const refButton = ref => h('button.ref', { type: 'button', class: ref.includes('/T-') ? 'ref-doc' : '', dataset: { bookRef: ref }, title: refTitle(ref) }, ref);
const cellButton = n => h('button.ref.cell-ref', { type: 'button', dataset: { cell: n }, title: `#${n} — 1열에서 이 단위 보기` }, `#${n}`);

function formLinks(text, code = false) {
  const nodes = [];
  let at = 0;
  for (const m of text.matchAll(LINK_RE)) {
    if (at < m.index) nodes.push(wrap(text.slice(at, m.index), code));
    nodes.push(m[3] ? cellButton(m[3]) : refButton(m[0]));
    at = m.index + m[0].length;
  }
  if (at < text.length) nodes.push(wrap(text.slice(at), code));
  return nodes;
}

function onLogClick(event) {
  const cell = event.target.closest('[data-cell]');
  if (cell) return go.revealCell(Number(cell.dataset.cell));
  const node = event.target.closest('[data-node]');
  if (node) return go.revealNode(Number(node.dataset.node)); // 구조 수정안의 「제목」 배지 — 1열의 그 제목 줄
  const ref = event.target.closest('[data-book-ref]');
  if (ref) {
    const [chapterId, rest] = ref.dataset.bookRef.split('/');
    if (!rest || rest.startsWith('T-')) return go.openChapter(chapterId, rest ?? null); // 양식 화면에는 목차가 없다 — 장만 가리키면 그 장의 작성 화면을 연다
    return go.showSource(chapterId, rest.split('.')[0], rest.includes('.') ? rest : null);
  }
  const all = event.target.closest('[data-decide-all]');
  if (all) return decideAll(batchOf(all), all.dataset.decideAll === 'ok');
  const button = event.target.closest('[data-decide]');
  const item = button && batchOf(button)?.items.find(i => i.id === button.closest('[data-item]')?.dataset.item);
  if (!item) return;
  decide(item, button.dataset.decide === 'ok');
  renderFormCards();
}

// 선택 질문 창(ask.js — app.js 가 이어 준다)이 이 채팅에서 띄울 때 쓰는 부품: 양식과 맥락 보고서, 고른 모델, #번호·장 ID 링크와 그 클릭, 보내기 전 양식 저장 (FR-WB-102)
export const formAsk = {
  scope: () => (view.form ? { bookId: view.bookId, formId: view.form.id } : null),
  models: () => ({ model: modelSelect.value, models }),
  render: raw => renderMarkdown(raw, formLinks),
  click: onLogClick,
  flush: async () => { if (!(await go.flush())) throw new Error('양식을 저장하지 못해 보내지 않았습니다 — 저장된 뒤 다시 보내세요.'); },
};

const batchOf = node => batches.find(b => b.key === node.closest('[data-batch]')?.dataset.batch);

// ───────────────────────────── 양식 수정안 카드 ─────────────────────────────

const DECISION = { accepted: '반영됨', rejected: '거부됨', stale: '수정안을 낸 뒤 이 칸의 글이 달라져 반영하지 않았습니다 — 다시 요청하세요' };
const STRUCTURE_DECISION = { accepted: '반영됨 — 1열이 바뀌었고 구조 규칙으로 남습니다', rejected: '거부됨', stale: '수정안을 낸 뒤 이 자리의 구조가 달라져 반영하지 않았습니다 — 다시 요청하세요' };
const pendingItems = () => batches.flatMap(b => b.items).filter(i => i.decision === 'pending');
const pendingCells = () => new Set(pendingItems().filter(i => !i.structure).map(i => i.cell));
// 수정안은 낼 때의 글(before)을 기준으로 한다 — 그 뒤 작성자가 고쳤거나 다른 제안을 반영했으면 반영하지 않는다 (FR-WB-091).
// 구조 수정안은 그 자리의 종류·수준·글(before·text)이 지금과 같을 때만 — 작성자가 1열에서 조절했거나 다른 제안을 반영했으면 낡은 것 (FR-WB-095)
const isStale = item => (item.structure ? isStaleStructure(item) : item.before !== go.cellText(item.cell));
function isStaleStructure(item) {
  const now = go.nodeState(item.i);
  if (!now || now.kind !== item.before?.kind || now.level !== item.before?.level) return true;
  return item.text != null && squash(now.text) !== squash(item.text); // 글은 공백 차이를 무시하고 — 에이전트 검사가 정리한 글을 줄 수 있다
}
const squash = text => String(text ?? '').replace(/\s+/g, ' ').trim();

// 수정안 상태가 바뀌거나 1열이 다시 그려지거나 단위를 손으로 고칠 때마다 채팅 안의 카드들과 1열의 대기 표시를 다시 맞춘다
function renderFormCards() {
  for (const card of log.querySelectorAll('[data-batch]')) {
    const batch = batches.find(b => b.key === card.dataset.batch);
    if (!batch) continue;
    const pending = batch.items.filter(i => i.decision === 'pending');
    fill(card,
      h('div.proposal-head',
        h('span', `${batch.model} ${batch.structure ? '구조' : '양식'} 수정안 ${batch.items.length}건`, pending.length < batch.items.length && h('span.muted', ` · 남은 검토 ${pending.length}건`)),
        pending.length > 1 && h('span.proposal-head-actions',
          h('button.btn.small', { type: 'button', dataset: { decideAll: 'ok' } }, '모두 반영'),
          h('button.btn.small.ghost', { type: 'button', dataset: { decideAll: 'no' } }, '모두 거부'))),
      batch.items.map(batch.structure ? structureItem : formItem),
      pending.length > 0 && h('div.proposal-foot', batch.structure ? '반영하면 1열의 제목·필드가 바뀌어 저장되고, 정한 상하관계는 구조 규칙으로 남습니다.' : '반영하기 전에는 양식이 바뀌지 않습니다.'));
  }
  for (const n of pendingCells()) go.markProposal(n, true);
}

// 구조 수정안 한 건 — 대상 배지(#n 은 1열의 그 단위, 「제목」은 그 제목 줄을 비춘다) · 글 앞 40자 · 변경 「필드 → 제목」「수준 1 → 2」 · 사유 · 반영/거부 (FR-WB-095)
const KIND_LABEL = { heading: '제목', field: '필드' };
const clip = (text, max = 40) => {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
};
function structureItem(item) {
  const stale = item.decision === 'pending' && isStale(item);
  const before = item.before ?? {};
  const field = before.kind === 'field';
  const changes = [
    item.kind && item.kind !== before.kind && `${KIND_LABEL[before.kind] ?? before.kind} → ${KIND_LABEL[item.kind] ?? item.kind}`,
    item.level && item.level !== before.level && `수준 ${before.level} → ${item.level}`,
  ].filter(Boolean);
  return h('div.proposal-item.structure-item', { class: `is-${item.decision}`, dataset: { item: item.id } },
    h('div.change-head',
      h('button.op-badge.op-structure', { type: 'button', dataset: field ? { cell: String(item.target).slice(1) } : { node: item.i }, title: field ? `${item.target} — 1열에서 이 단위 보기` : '1열에서 이 제목 줄 보기' }, field ? item.target : '제목'),
      h('span.structure-text', { title: item.text }, clip(item.text) || '(빈 글)')),
    h('div.structure-change', changes.length ? changes.map(c => h('span.structure-delta', c)) : h('span.muted', '바뀌는 것이 없습니다')),
    stale && h('div.notice.is-error.toc-stale', '이 자리의 글이나 구조가 수정안을 낸 뒤 달라졌습니다 — 반영할 수 없으니 다시 요청하세요.'),
    item.reason && h('div.change-reason', item.reason),
    item.decision === 'pending'
      ? h('div.change-actions',
        h('button.btn.small', { type: 'button', dataset: { decide: 'ok' }, disabled: stale }, '✓ 반영'),
        h('button.btn.small.ghost', { type: 'button', dataset: { decide: 'no' } }, '✕ 거부'))
      : h('div.change-decision', { class: item.decision === 'stale' ? 'is-stale' : '' }, STRUCTURE_DECISION[item.decision]));
}

function formItem(item) {
  const stale = item.decision === 'pending' && isStale(item);
  return h('div.proposal-item.form-item', { class: `is-${item.decision}`, dataset: { item: item.id } },
    h('div.change-head', h('span.op-badge.op-replace', `#${item.cell}`), item.label && h('span.muted', ` · ${item.label} ${item.kind === 'field' ? '아래' : '옆'}`)),
    h('div.proposal-text', valueDiff(item.before ?? '', item.text)),
    stale && h('div.notice.is-error.toc-stale', '이 칸의 글이 수정안을 낸 뒤 달라졌습니다 — 반영할 수 없으니 다시 요청하세요.'),
    item.reason && h('div.change-reason', item.reason),
    h('div.proposal-meta', item.anchors?.length ? item.anchors.map(refButton) : h('span.muted', '근거 없음')),
    item.decision === 'pending'
      ? h('div.change-actions',
        h('button.btn.small', { type: 'button', dataset: { decide: 'ok' }, disabled: stale }, '✓ 반영'),
        h('button.btn.small.ghost', { type: 'button', dataset: { decide: 'no' } }, '✕ 거부'))
      : h('div.change-decision', { class: item.decision === 'stale' ? 'is-stale' : '' }, DECISION[item.decision]));
}

// 전후 글 — diffText 는 토막 수의 곱만큼 일하므로 긴 글은 diff 대신 전후 전문으로 보여 준다
const DIFF_LIMIT = 3000;
const valueDiff = (before, after) => (before.length + after.length > DIFF_LIMIT
  ? [before && h('div', h('del', before)), after && h('div', h('ins', after))]
  : diffText(before, after).map(d => (d.kind === 'same' ? d.text : h(d.kind, d.text))));

// ───────────────────────────── 반영 · 거부 ─────────────────────────────

// 한 건을 정한다 — 반영은 forms.js 가 1열에 넣고 저장한다(잠긴 단위면 false → 대기 그대로). 한 칸에는 한 값이므로 같은 칸의 다른 대기 제안은 거둔다.
// 구조 수정안도 forms.js 가 노드를 바꾸고 저장한다(빈 필드·확인 거부면 false → 대기 그대로) — 같은 자리의 다른 대기 제안은 거둔다
function decide(item, accept) {
  if (item.decision !== 'pending') return;
  if (!accept) item.decision = 'rejected';
  else if (isStale(item)) item.decision = 'stale';
  else if (item.structure) {
    if (!go.applyStructure(item.i, { level: item.level ?? undefined, kind: item.kind ?? undefined })) return;
    item.decision = 'accepted';
    for (const other of pendingItems()) if (other.structure && other.i === item.i) other.decision = 'rejected';
  } else if (go.applyValue(item.cell, item.text)) {
    item.decision = 'accepted';
    for (const other of pendingItems()) if (!other.structure && other.cell === item.cell) other.decision = 'rejected';
  } else return;
  if (!item.structure && !pendingCells().has(item.cell)) go.markProposal(item.cell, false);
}

function decideAll(batch, accept) {
  if (!batch) return;
  for (const item of batch.items) decide(item, accept);
  renderFormCards();
}
