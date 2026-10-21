// 2열 에이전트 채팅 — 모델을 골라 묻고, 에이전트가 낸 수정안을 문장·문단 단위로 반영하거나 거부한다.
import { anchorLoc, anchorText, SOURCE_TYPES } from '../shared/model.js';
import { SENTENCE_TYPES, STATUS } from '../shared/text.js';
import { collapseButton } from './columns.js';
import { dropZone, startDrag } from './dnd.js';
import { revealSentences } from './editor.js';
import { api, attach, detach, emit, findSentence, flushSave, insertAnchors, insertProposals, on, selectDoc, setSources, state } from './state.js';
import { addBatch, blockKey, decide, diffText, markPlaced } from './suggest.js';
import { fill, flash, h, toast } from './util.js';

let log, input, sendBtn, chips, modelSelect, ctxMeter;
let conversationId = null;
let running = false;
let abort = null;
let lastModel = null;
let models = [];
let usageByModel = {}; // 이 대화에서 응답한 모델별 컨텍스트 사용량 { used, window, approx } (FR-WB-058)

const SUGGESTIONS = [
  '선택한 문장이 근거와 맞는지 검토하고 틀린 곳은 고쳐 줘',
  '근거 없는 문장에 맞는 원문을 찾아 연결해 줘',
  '원문의 핵심 수치로 한 문단을 추가해 줘',
];
// 원문이 없는 문서(새 문서)에서는 조사부터 시작한다
const EMPTY_SUGGESTIONS = [
  '이 문서 제목의 주제로 공식 자료를 찾아 수집하고 개요 문단을 제안해 줘',
];

export function initChat(root) {
  modelSelect = h('select.model-select', { title: '에이전트 모델', 'aria-label': '에이전트 모델', onchange: () => { renderUsage(); try { localStorage.setItem('sa.model', modelSelect.value); } catch { /* 저장하지 못해도 이번 대화에는 적용된다 */ } } });
  ctxMeter = h('span.ctx-meter', { hidden: true });
  log = h('div.chat-log');
  chips = h('div.chips');
  input = h('textarea', { rows: 2, 'aria-label': '에이전트에게 요청', placeholder: '조사할 주제나 다듬을 내용을 알려주세요…', title: '문장이나 원문을 끌어다 놓으면 함께 보냅니다.' });
  sendBtn = h('button.btn', { type: 'submit' }, '보내기');
  const form = h('form.composer', { onsubmit: event => { event.preventDefault(); running ? stop() : send(input.value); } }, chips, h('div.composer-row', input, sendBtn),
    h('div.composer-hint', h('span', '문장을 끌어와 함께 보내세요'), h('span', '↵ 전송 · Shift + ↵ 줄바꿈')));
  root.append(
    h('header.col-head',
      h('div.col-title', h('span.col-index', '2'), '에이전트', modelSelect, ctxMeter),
      h('div.col-head-actions',
        h('button.btn.small.ghost', { type: 'button', title: '이 대화에서 갈라져 나온 별도 창에서 질문·답변만 주고받습니다. 이 대화에는 남지 않습니다.', onclick: () => emit('open-branch') }, '분기 질문'),
        h('button.btn.small.ghost', { type: 'button', onclick: newChat }, '새 대화'),
        collapseButton(root, '2열 에이전트'))),
    log,
    form,
  );

  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  log.addEventListener('dragstart', onDragStart);
  log.addEventListener('click', onLogClick);

  // 원문 문장·표 셀, 보고서 문장을 채팅 열 어디에든 놓으면 메시지에 첨부한다
  dropZone(root, {
    accepts: payload => payload.from !== 'proposal',
    onDrop: (event, payload) => {
      attach(payload.from === 'source' ? payload.anchors.map(id => ({ kind: 'anchor', id })) : payload.sentences.map(id => ({ kind: 'doc', id })));
      input.focus();
    },
  });

  on('attachments', renderChips);
  on('sources', renderChips);
  on('suggestions', renderChangeCards);
  on('doc-opened', newChat); // 다른 문서를 열면 대화도 새로 시작한다
  newChat();
  loadModels();
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

// 모델 선택 상자의 항목 — 보고서 화면의 채팅(book_chat.js)도 같은 모양으로 만든다
export const modelOptions = (list, chosen) => list.map(m => h('option', { value: m.key, disabled: !m.available, selected: m.key === chosen, title: `${m.cli} CLI · ${m.model}` }, m.available ? m.label : `${m.label} (${m.cli} CLI 없음)`));

// 분기 질문 창(branch.js)이 갈라져 나올 주 대화 — 지금 대화 ID, 고른 모델, 모델 목록
export const mainChat = () => ({ conversationId, model: modelSelect.value, models });

// 채팅 머리줄의 컨텍스트 사용량 — 고른 모델이 이 대화에서 응답한 적이 있을 때만 보인다 (FR-WB-058)
const tokens = n => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));

// 사용량 표시 글 — 보고서 화면의 채팅(book_chat.js)도 같은 표시를 쓴다
export function describeUsage(u, label) {
  const ratio = u.window ? u.used / u.window : null;
  const percent = ratio == null ? '' : ` · ${ratio < 0.01 ? '1% 미만' : `${Math.round(ratio * 100)}%`}`;
  return {
    text: `${u.approx ? '약 ' : ''}${tokens(u.used)}${u.window ? ` / ${tokens(u.window)}` : ''}${percent}`,
    high: ratio != null && ratio >= 0.8,
    title: `${label} 의 현재 컨텍스트 사용량: ${u.used.toLocaleString()} 토큰${u.window ? ` / 컨텍스트 창 ${u.window.toLocaleString()} 토큰` : ''}${u.approx ? ' — 어림값(이 응답의 모든 호출을 더한 값이라 실제보다 클 수 있습니다)' : ''}. 서브에이전트의 사용량은 포함하지 않습니다.`,
  };
}

function renderUsage() {
  const u = usageByModel[modelSelect.value];
  ctxMeter.hidden = !u;
  if (!u) return;
  const shown = describeUsage(u, modelLabel(modelSelect.value));
  ctxMeter.textContent = shown.text;
  ctxMeter.classList.toggle('is-high', shown.high);
  ctxMeter.title = shown.title;
}

function newChat() {
  if (running) stop();
  conversationId = null;
  lastModel = null;
  usageByModel = {};
  renderUsage();
  log.replaceChildren(h('div.chat-welcome',
    h('span.welcome-eyebrow', '리서치 에이전트'),
    h('h2.welcome-title', '좋은 글의 시작,\n확실한 근거에서'),
    h('p', '자료를 찾고, 근거를 연결하고, 문장을 함께 다듬으세요. 필요한 자료는 웹에서 찾아 수집합니다.'),
    h('div.suggestions', (state.sources.length ? SUGGESTIONS : EMPTY_SUGGESTIONS).map((text, i) => h('button.suggestion', { type: 'button', title: text, onclick: () => send(text) },
      state.sources.length ? ['선택한 문장 검토하기', '문장에 근거 연결하기', '핵심 수치로 문단 쓰기'][i] : '이 주제로 자료 조사 시작하기'))),
    h('p.welcome-note', '수정안은 검토한 뒤 원하는 문장만 반영할 수 있습니다.')));
}

// ───────────────────────────── 첨부 ─────────────────────────────

function itemText(item) {
  if (item.kind === 'doc') return findSentence(item.id)?.sentence.text;
  const anchor = state.anchors.get(item.id);
  return anchor && anchorText(anchor);
}

function renderChips() {
  chips.replaceChildren(...state.attachments.map(item =>
    h('span.chip', { class: `chip-${item.kind}`, title: itemText(item) || '' },
      h('span.chip-kind', item.kind === 'doc' ? '보고서' : '원문'),
      h('span.chip-text', itemText(item) || item.id),
      h('button', { type: 'button', title: '첨부 해제', onclick: () => detach(item) }, '✕'))));
}

// ───────────────────────────── 보내기 · 받기 ─────────────────────────────

async function send(text) {
  text = text.trim();
  if (!text || running) return;
  const model = modelSelect.value;
  const attachments = state.attachments.filter(item => itemText(item));
  log.querySelector('.chat-welcome')?.remove();
  if (lastModel && lastModel !== model) log.append(h('div.notice', `모델을 ${modelLabel(lastModel)} → ${modelLabel(model)} 로 바꿨습니다. 앞선 대화 내용을 함께 전달합니다.`));
  lastModel = model;
  log.append(h('div.msg.msg-user',
    attachments.length > 0 && h('div.msg-attach', attachments.map(item => h('div.msg-attach-item', h('span.chip-kind', item.kind === 'doc' ? '보고서' : '원문'), itemText(item)))),
    h('div.msg-text', text)));
  input.value = '';
  detach();

  const bubble = h('div.msg.msg-agent', h('div.msg-model', modelLabel(model)), h('div.typing', h('span'), h('span'), h('span')));
  log.append(bubble);
  scrollToEnd();
  setRunning(true);

  let textEl = null;
  let raw = '';
  const handlers = {
    start: ev => { conversationId = ev.conversationId; },
    text_start: () => { raw = ''; textEl = h('div.msg-text'); bubble.append(textEl); },
    text: ev => { raw += ev.d; textEl.replaceChildren(...renderMarkdown(raw)); },
    tool: ev => bubble.append(h('div.tool', h('span.tool-name', TOOL_LABELS[ev.name] || ev.name), h('span.tool-summary', ev.summary || ''))),
    changes: ev => {
      addBatch(ev);
      bubble.append(h('div.proposal', { dataset: { batch: ev.id } }));
      renderChangeCards();
    },
    hits: ev => bubble.append(hitsCard(ev)),
    // 에이전트가 채택한 자료를 서버가 내려받아 등록했다 — 원문 열에 곧바로 반영한다 (그사이 다른 문서를 열었으면 건드리지 않는다)
    collected: ev => {
      if (ev.docId === state.doc.id) setSources(ev.sources);
      bubble.append(collectedCard(ev));
    },
    notice: ev => bubble.append(h('div.notice', ev.text)),
    usage: ev => { usageByModel[ev.model] = ev; renderUsage(); },
    error: ev => bubble.append(h('div.notice.is-error', ev.message)),
  };
  // 답변 중에는 점 세 개를 말풍선 맨 아래에 계속 둔다 (CLI 는 첫 글자가 나오기까지 시간이 걸린다)
  const typing = bubble.querySelector('.typing');

  try {
    await flushSave(); // 에이전트는 서버에 저장된 보고서를 읽는다
    abort = new AbortController();
    await streamChat({ conversationId, text, model, docId: state.doc.id, context: { selected: state.sel.doc, attachments } }, abort.signal, ev => {
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

// /api/chat 에 보내고, 서버가 한 줄에 하나씩 흘려보내는 이벤트(NDJSON)를 onEvent 로 넘긴다 — 분기 질문 창도 함께 쓴다
export async function streamChat(body, signal, onEvent) {
  const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify(body) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `요청 실패 (${res.status})`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) if (line) onEvent(JSON.parse(line));
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

export const TOOL_LABELS = { Read: '원문 읽기', Grep: '원문 검색', Glob: '파일 찾기', WebSearch: '웹 검색', WebFetch: '웹 페이지 읽기', Collect: '원문 수집' };

// ───────────────────────────── 수정안 카드 ─────────────────────────────

const OP_LABEL = { replace: '수정', insert: '추가', delete: '삭제' };
const DECISION_LABEL = { accepted: '반영됨', rejected: '거부됨' };

// 수정안 상태가 바뀔 때마다 채팅 안의 카드들을 다시 그린다
function renderChangeCards() {
  for (const card of log.querySelectorAll('[data-batch]')) {
    const items = state.suggestions.filter(s => s.batchId === card.dataset.batch);
    const pending = items.filter(s => s.decision === 'pending');
    fill(card,
      h('div.proposal-head',
        h('span', `${items[0]?.model ?? ''} 수정안 ${items.length}건`, pending.length < items.length && h('span.muted', ` · 남은 검토 ${pending.length}건`)),
        pending.length > 1 && h('span.proposal-head-actions',
          h('button.btn.small', { type: 'button', dataset: { decideAll: 'ok' } }, '모두 반영'),
          h('button.btn.small.ghost', { type: 'button', dataset: { decideAll: 'no' } }, '모두 거부'))),
      items.map(changeItem),
      pending.length > 0 && h('div.proposal-foot', '편집기에서도 문장마다 ✓/✕ 로, 문단 단위로 반영·거부할 수 있습니다.'));
  }
}

function changeItem(s) {
  const unplaced = s.op === 'insert' && s.after == null;
  const structure = s.block === 'heading' ? ' · 제목' : s.block === 'paragraph' ? ' · 새 문단 시작' : '';
  const where = s.op === 'insert' ? (unplaced ? '위치는 직접 지정' : (findSentence(s.after) ? `${s.after} 뒤` : s.after === 'start' ? '문서 맨 앞' : `${s.after} 뒤`) + structure) : s.sentenceId;
  const body = s.op === 'replace' ? diffText(s.before, s.text).map(d => (d.kind === 'same' ? d.text : h(d.kind, d.text)))
    : s.op === 'delete' ? [h('del', s.before)] : [s.text];
  return h('div.proposal-item', { class: `st-${s.status} is-${s.decision}`, draggable: s.decision === 'pending' && s.op === 'insert', dataset: { sugg: s.id } },
    h('div.change-head',
      h('span.op-badge', { class: `op-${s.op}` }, OP_LABEL[s.op]),
      s.op === 'insert' ? h('span.muted', where) : h('button.ref.ref-doc', { type: 'button', dataset: { docRef: s.sentenceId } }, where),
      s.op !== 'delete' && s.type !== 'fact' && h('span.sent-tag', SENTENCE_TYPES[s.type].label)),
    h('div.proposal-text', body),
    s.reason && h('div.change-reason', s.reason),
    s.op !== 'delete' && h('div.proposal-meta',
      h('span.badge', STATUS[s.status].label),
      s.anchors.map(a => h('button.ref', { type: 'button', dataset: { anchor: a }, title: refTitle(a) }, a)),
      s.calc && h('span.muted', `계산: ${s.calc.expr}`)),
    s.problems.length > 0 && h('div.proposal-problems', s.problems.join(' · ')),
    s.decision === 'pending' ? h('div.change-actions',
      h('button.btn.small', { type: 'button', dataset: { decide: 'ok' } }, unplaced ? '← 넣기' : '✓ 반영'),
      h('button.btn.small.ghost', { type: 'button', dataset: { decide: 'no' } }, '✕ 거부'),
      !unplaced && h('button.btn.small.ghost', { type: 'button', dataset: { decideBlock: '1' }, title: '같은 문단의 수정안을 한꺼번에 반영합니다' }, '문단 전체 반영'))
      : h('div.change-decision', DECISION_LABEL[s.decision]));
}

// 자격(CLI)이 없을 때 서버가 돌려주는 원문 검색 결과 — 원문 문장처럼 끌어서 쓸 수 있다
export function hitsCard(ev) {
  if (!ev.anchors.length) return h('div.notice', '수집한 원문에서 관련 문장을 찾지 못했습니다.');
  return h('div.proposal',
    h('div.proposal-head', h('span', `원문 검색 결과 ${ev.anchors.length}건`)),
    ev.anchors.map(id => {
      const anchor = state.anchors.get(id);
      return h('div.proposal-item.hit', { draggable: true, dataset: { hit: id } },
        h('div.proposal-text', anchorText(anchor)),
        h('div.proposal-meta',
          h('span.type-badge', { class: `type-${anchor.source.type}` }, SOURCE_TYPES[anchor.source.type]),
          h('button.ref', { type: 'button', dataset: { anchor: id }, title: refTitle(id) }, anchorLoc(anchor)),
          h('button.btn.small', { type: 'button', dataset: { insertHit: id } }, '← 넣기')));
    }));
}

// 자료 수집 결과 — 등록된 원문은 ID 를 눌러 원문 열에서 열고, 실패한 자료는 사유를 보여 준다
function collectedCard(ev) {
  const added = ev.results.filter(r => r.ok && !r.duplicate).length;
  return h('div.proposal',
    h('div.proposal-head', h('span', `원문 수집 — 새로 등록 ${added}건${added < ev.results.length ? ` · 그 밖 ${ev.results.length - added}건` : ''}`)),
    ev.results.map(r => h('div.proposal-item.collected', { class: r.ok ? '' : 'is-failed' },
      h('div.proposal-text', r.ok ? [h('button.ref', { type: 'button', dataset: { source: r.id }, title: '원문 열에서 엽니다' }, r.id), ' ', r.title] : r.url),
      h('div.change-reason', !r.ok ? `수집하지 못했습니다 — ${r.error}` : r.duplicate ? '이미 수집한 자료입니다' : r.url))));
}

function refTitle(anchorId) {
  const anchor = state.anchors.get(anchorId);
  return anchor ? `${anchor.source.title} · ${anchorLoc(anchor)}\n${anchorText(anchor)}` : anchorId;
}

// 채팅 기록 안의 끌기·클릭 — 분기 질문 창의 기록도 같은 처리기를 쓴다 (ID 링크, 원문 검색 결과)
export function onDragStart(event) {
  const hit = event.target.closest?.('[data-hit]');
  if (hit) return startDrag(event, { from: 'source', anchors: [hit.dataset.hit] }, hit.querySelector('.proposal-text').textContent);
  const s = state.suggestions.find(x => x.id === event.target.closest?.('[data-sugg]')?.dataset.sugg);
  if (!s || s.op !== 'insert' || s.decision !== 'pending') return event.preventDefault();
  // 추가 제안은 편집기의 원하는 위치로 끌어다 놓을 수 있다
  startDrag(event, { from: 'proposal', proposals: [s], suggestionIds: [s.id] }, s.text);
}

export function onLogClick(event) {
  const target = event.target;
  const ref = target.closest('[data-anchor], [data-doc-ref], [data-source]');
  if (ref?.dataset.anchor) return emit('open-anchor', ref.dataset.anchor);
  if (ref?.dataset.source) {
    if (!state.sources.some(s => s.id === ref.dataset.source)) return toast('이 문서의 원문 목록에 없는 자료입니다.', 'error');
    state.activeSourceId = ref.dataset.source;
    return emit('sources');
  }
  if (ref?.dataset.docRef) {
    if (!findSentence(ref.dataset.docRef)) return toast('보고서에 없는 문장입니다.', 'error');
    selectDoc(ref.dataset.docRef);
    return revealSentences([ref.dataset.docRef]);
  }
  const hitBtn = target.closest('[data-insert-hit]');
  if (hitBtn) return revealSentences(insertAnchors([hitBtn.dataset.insertHit]));

  const all = target.closest('[data-decide-all]');
  if (all) return revealSentences(decide(state.suggestions.filter(s => s.batchId === all.closest('[data-batch]').dataset.batch), all.dataset.decideAll === 'ok'));

  const item = target.closest('[data-sugg]');
  const s = item && state.suggestions.find(x => x.id === item.dataset.sugg);
  if (!s) return;
  if (target.closest('[data-decide-block]')) return revealSentences(decide(state.suggestions.filter(x => blockKey(x) === blockKey(s)), true));
  const button = target.closest('[data-decide]');
  if (!button) {
    // 카드를 누르면 편집기에서 그 수정안 위치를 보여 준다
    const node = document.querySelector(`#col-editor [data-sugg="${s.id}"]`) || (s.resultId && document.querySelector(`.sent[data-sid="${s.resultId}"]`));
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return flash(node);
  }
  if (button.dataset.decide === 'ok' && s.op === 'insert' && s.after == null) return markPlaced([s.id], revealAndReturn(insertProposals([s])));
  revealSentences(decide([s], button.dataset.decide === 'ok'));
}

function revealAndReturn(ids) {
  revealSentences(ids);
  return ids;
}

// ───────────────────────────── 답변 표시 ─────────────────────────────

const ID_RE = /\b(S-\d{3}\.b\d+\.(?:s\d+|r\d+c\d+)|T-\d{4}|E-\d{4})\b/g;

// 굵게·코드·목록만 지원하는 작은 Markdown. ID 는 해당 위치를 여는 링크로 바꾼다 — link(text, code) 를 주면 그 규칙으로(보고서 화면은 장 표시가 붙은 ID).
export function renderMarkdown(text, link = linkIds) {
  const out = [];
  let list = null;
  for (const line of text.split('\n')) {
    const item = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/);
    if (item) {
      if (!list) out.push(list = h('ul'));
      list.append(h('li', inline(item[1], link)));
      continue;
    }
    list = null;
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (heading) out.push(h('p.md-h', inline(heading[1], link)));
    else if (line.trim()) out.push(h('p', inline(line, link)));
  }
  return out;
}

function inline(text, link) {
  const nodes = [];
  for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
    if (part.startsWith('**') && part.length > 4) nodes.push(h('strong', link(part.slice(2, -2))));
    else if (part.startsWith('`') && part.length > 2) nodes.push(...link(part.slice(1, -1), true));
    else nodes.push(...link(part));
  }
  return nodes;
}

function linkIds(text, code = false) {
  const nodes = [];
  let at = 0;
  for (const m of text.matchAll(ID_RE)) {
    const id = m[1];
    const evidence = id.startsWith('E-') ? state.evidence[id] : null;
    const anchorId = id.startsWith('S-') ? id : evidence?.anchorId;
    if (at < m.index) nodes.push(wrap(text.slice(at, m.index), code));
    nodes.push(anchorId ? h('button.ref', { type: 'button', dataset: { anchor: anchorId }, title: refTitle(anchorId) }, id)
      : id.startsWith('T-') ? h('button.ref.ref-doc', { type: 'button', dataset: { docRef: id }, title: findSentence(id)?.sentence.text || '' }, id)
      : wrap(id, true));
    at = m.index + id.length;
  }
  if (at < text.length) nodes.push(wrap(text.slice(at), code));
  return nodes;
}

const wrap = (text, code) => (code ? h('code', text) : text);
