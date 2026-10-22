// 보고서 화면 2열 — 보고서 에이전트. 주제로 초기 목차를 제안하고, 장 사이에 다르게 쓴 용어·표기와 겹치는 내용·자료를 찾아 편별을 제안한다.
// 본문은 쓰지 않는다 — 본문은 장의 작성 화면에서 그 장의 에이전트와 쓴다 (FR-WB-076, 077).
// 목차·지시문은 직접 바꾸지 않고 목차 수정안(장 추가·제목·지시문·순서·삭제) 한 건씩으로 내며, 작성자가 건마다 반영·거부하거나 추가의견을 보낸다.
// 반영 의견·거부 사유·추가의견은 작성요령 「수정안 검토 의견」에 한 줄씩 남겨 에이전트가 참조한다 — 의견 칸은 늘 보이고 단추 한 번에 결정한다 (FR-WB-103 — 칸과 기록은 toc_review.js).
// 대상 장이 이미 없어진 수정안은 반영하지 않고 그렇게 표시한다 (ERR-WB-007).
// 대화는 답이 끝날 때마다 서버가 보관하고, 「새 대화」로 닫을 때 장·주제로 분류하며 「지난 대화」에서 다시 열어 이어 간다 (FR-WB-101 — book_chat_history.js).
// 채팅 부품(스트림·Markdown·사용량 표시)은 chat.js 의 것을 함께 쓴다. book.js 가 이 모듈을 부르므로 book.js 를 import 하지 않는다 — 화면 조작은 handlers 로 받는다.
import { parseInstructions, SECTIONS } from '../shared/instructions.js';
import { moveAfter } from '../shared/toc.js';
import { chatHistory, classifyDialog, listChats, openChat } from './book_chat_history.js';
import { collapseButton } from './columns.js';
import { describeUsage, modelOptions, renderMarkdown, streamChat, TOOL_LABELS } from './chat.js';
import { api } from './state.js';
import { noteCard } from './note_cards.js';
import { diffText } from './suggest.js';
import { recordReview, reviewBox, reviewResult, reviewWhat, reviewWhatAll } from './toc_review.js';
import { fill, h, toast } from './util.js';

let log, form, input, sendBtn, modelSelect, ctxMeter, history, historyBtn;
const go = { bookChanged: () => {}, reload: async () => {}, showChapter: () => {}, showSource: () => {}, openChapter: async () => {}, running: () => {} };
let view = { book: { id: null, title: '' }, chapters: [] };
let conversationId = null;
let chatId = null; // 이 대화가 보관된 번호 — 첫 답이 끝나면 서버가 알려 준다 (FR-WB-101)
let running = false;
let abort = null;
let lastModel = null;
let models = [];
let usageByModel = {}; // 이 대화에서 응답한 모델별 컨텍스트 사용량 (FR-WB-058)
let batches = []; // 목차 수정안 묶음 [{ id, model, busy?, reviewed?, items: [{ …, decision: 'pending' | 'accepted' | 'rejected' | 'gone' | 'stale' | 'commented', busy?, reviewed? }] }] — reviewed 는 toc_review.js

const SUGGESTIONS = [
  { label: '용어와 표기를 일관되게', text: '장 사이에 같은 대상을 다르게 쓴 용어·표기·단위를 찾아 어느 장이 어떻게 썼는지 알려 줘' },
  { label: '겹치는 내용 정리하기', text: '여러 장에 겹치거나 비슷한 내용과 자료를 찾아 어느 장이 맡을지 제안해 줘' },
  { label: '장별 지시문 검토하기', text: '각 장의 지시문이 목차의 역할과 맞는지 검토하고 고칠 점을 수정안으로 내 줘' },
];
const EMPTY_SUGGESTIONS = [{ label: '보고서 제목으로 목차 제안받기', text: '이 보고서의 제목을 주제로 초기 목차와 장별 지시문을 제안해 줘' }];

export function initBookChat(root, handlers) {
  Object.assign(go, handlers);
  modelSelect = h('select.model-select', { title: '보고서 에이전트 모델', 'aria-label': '보고서 에이전트 모델', onchange: () => { renderUsage(); try { localStorage.setItem('sa.model', modelSelect.value); } catch { /* 저장하지 못해도 이번 대화에는 적용된다 */ } } });
  ctxMeter = h('span.ctx-meter', { hidden: true });
  log = h('div.chat-log');
  history = chatHistory({ ctx: () => ({ bookId: view.book.id, chatId, chapters: view.chapters, model: modelSelect.value, modelLabel: modelLabel(modelSelect.value) }), open: openPast });
  input = h('textarea', { rows: 2, 'aria-label': '보고서 에이전트에게 요청', placeholder: '보고서 주제나 검토할 내용을 알려주세요…' });
  sendBtn = h('button.btn', { type: 'submit' }, '보내기');
  form = h('form.composer', { onsubmit: event => { event.preventDefault(); running ? stop() : send(input.value); } }, h('div.composer-row', input, sendBtn),
    h('div.composer-hint', h('span', '목차와 지시문을 함께 정리하세요'), h('span', '↵ 전송 · Shift + ↵ 줄바꿈')));
  root.append(
    h('header.col-head',
      h('div.col-title', h('span.col-index', '2'), '에이전트', modelSelect, ctxMeter),
      h('div.col-head-actions',
        historyBtn = h('button.btn.small.ghost', { type: 'button', title: '이 보고서에 보관된 대화를 장별·주제별로 보고 다시 열어 이어 갑니다', onclick: () => showHistory(!history.isOpen()) }, '지난 대화'),
        h('button.btn.small.ghost', { type: 'button', title: '지금 대화를 닫고 새로 시작합니다 — 문답이 있으면 장·주제로 분류해 보관합니다', onclick: async () => { if (await closeChat()) newChat(); } }, '새 대화'),
        collapseButton(root, '2열 에이전트'))),
    history.el,
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

// book.js 가 보고서 상태를 그릴 때마다 부른다 — 다른 보고서를 열었으면 대화를 새로 시작하고, 같은 보고서면 안내와 수정안 카드만 다시 맞춘다
export function setBookView(next) {
  const changed = next.book.id !== view.book.id;
  view = { book: next.book, chapters: next.chapters || [] };
  if (changed) {
    newChat(); // 앞 보고서의 대화는 보관된 채 남는다 (FR-WB-101 (a))
    showHistory(false);
  } else {
    renderWelcome();
    renderTocCards();
    if (history.isOpen()) history.redraw();
  }
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

function newChat() {
  if (running) stop();
  conversationId = null;
  chatId = null;
  lastModel = null;
  usageByModel = {};
  batches = [];
  renderUsage();
  log.replaceChildren(h('div.chat-welcome'));
  renderWelcome();
}

// 지금 대화를 닫는다 — 보관된 문답이 있으면 닫기 창에서 장·주제로 분류해 보관하거나 버린다. 취소하면 false (FR-WB-101 (b))
async function closeChat() {
  if (running) stop(); // 답하던 요청은 문답에 들지 않는다
  if (!chatId || !view.book.id) return true;
  let chats;
  try {
    chats = await listChats(view.book.id);
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
  const chat = chats.find(c => c.id === chatId);
  if (!chat) return true; // 그사이 지워졌다
  const result = await classifyDialog({ bookId: view.book.id, chat, chats, chapters: view.chapters, model: modelSelect.value, modelLabel: modelLabel(modelSelect.value) });
  if (result && history.isOpen()) history.refresh();
  return result !== null;
}

// 지난 대화를 2열에 다시 연다 — 지금 대화를 먼저 닫고, 질문과 답의 글을 그대로 보인다. 이어 보내면 서버가 앞선 문답을 맥락으로 준다 (FR-WB-101 (d))
async function openPast(id) {
  if (id === chatId) return showHistory(false);
  if (!(await closeChat())) return;
  let data;
  try {
    data = await openChat(view.book.id, id);
  } catch (err) {
    toast(err.message, 'error');
    if (err.status === 404) history.refresh();
    return;
  }
  newChat();
  conversationId = data.conversationId;
  chatId = data.chat.id;
  fill(log,
    h('div.notice', `지난 대화 「${data.chat.title}」를 다시 열었습니다. 이어서 보내면 앞선 문답을 맥락으로 이어받아 답합니다.`),
    data.chat.messages.map(m => (m.role === 'user' ? h('div.msg.msg-user', h('div.msg-text', m.text))
      : h('div.msg.msg-agent', h('div.msg-model', modelLabel(m.model)), m.text && h('div.msg-text', renderMarkdown(m.text, bookLinks)),
        m.blocks > 0 && h('div.notice', '이 답에 있던 수정안 카드는 지난 대화에서 다시 열리지 않습니다 — 필요하면 다시 요청하세요.')))));
  showHistory(false);
  scrollToEnd();
}

// 지난 대화 목록을 대화 기록 자리에 펼치거나 접는다 — 펼친 동안에는 보내기 칸을 감춘다
function showHistory(visible) {
  history.show(visible);
  log.hidden = visible;
  form.hidden = visible;
  historyBtn.textContent = visible ? '대화로 돌아가기' : '지난 대화';
  historyBtn.classList.toggle('is-on', visible);
}

// 안내와 제안 — 장이 없는 보고서에서는 목차 요청부터 (FR-WB-072)
function renderWelcome() {
  const welcome = log.querySelector('.chat-welcome');
  if (!welcome) return;
  fill(welcome,
    h('span.welcome-eyebrow', '보고서 에이전트'),
    h('h2.welcome-title', view.chapters.length ? '보고서의 흐름을 다듬으세요' : '생각을 목차로 정리하세요'),
    h('p', view.chapters.length ? '장 사이의 용어와 표기를 맞추고, 겹치는 내용을 정리할 수 있도록 도와드립니다.' : '쓰고 싶은 주제를 알려주세요. 목차와 장별 지시문을 함께 제안합니다.'),
    h('div.suggestions', (view.chapters.length ? SUGGESTIONS : EMPTY_SUGGESTIONS).map(({ label, text }) => h('button.suggestion', { type: 'button', title: text, onclick: () => send(text) }, label))),
    h('p.muted.welcome-note', '제안은 검토 후 원하는 항목만 반영하세요. 본문은 장 탐색기에서 장을 열어 작성할 수 있습니다.'));
}

// ───────────────────────────── 보내기 · 받기 ─────────────────────────────

// 1열 머리줄의 요청 버튼(book.js)이 정해진 요청문을 이 대화로 보낸다 (FR-WB-086)
export const sendBookMessage = text => send(text);

async function send(text) {
  text = text.trim();
  if (!text || running || !view.book.id) return;
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
    chat: ev => { chatId = ev.chatId; }, // 답을 보관한 번호 (FR-WB-101 (a))
    text_start: () => { raw = ''; textEl = h('div.msg-text'); bubble.append(textEl); },
    text: ev => { raw += ev.d; textEl.replaceChildren(...renderMarkdown(raw, bookLinks)); },
    tool: ev => bubble.append(h('div.tool', h('span.tool-name', TOOL_LABELS[ev.name] || ev.name), h('span.tool-summary', ev.summary || ''))),
    toc: ev => {
      batches.push({ id: ev.id, model: ev.model, items: ev.items.map(item => ({ ...item, decision: 'pending' })) });
      bubble.append(h('div.proposal', { dataset: { batch: ev.id } }));
      renderTocCards();
    },
    hits: ev => bubble.append(hitsCard(ev)),
    guides: ev => bubble.append(noteCard(ev, { saved: () => go.reload() })), // 작성요령 저장 카드 — 저장하면 3열 기준 문서 목록을 다시 받는다 (FR-WB-100)
    notice: ev => bubble.append(h('div.notice', ev.text)),
    usage: ev => { usageByModel[ev.model] = ev; renderUsage(); },
    error: ev => bubble.append(h('div.notice.is-error', ev.message)),
  };

  try {
    abort = new AbortController();
    await streamChat({ conversationId, chatId, text, model, bookId: view.book.id }, abort.signal, ev => {
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
  go.running(value); // 1열의 추출 요청 버튼을 잠그거나 푼다
  sendBtn.textContent = value ? '중지' : '보내기';
  sendBtn.classList.toggle('danger', value);
  modelSelect.disabled = value;
  renderTocCards(); // 답하는 중에는 추가의견을 보낼 수 없다 (FR-WB-103)
}

function scrollToEnd() {
  log.scrollTop = log.scrollHeight;
}

// 자격(CLI)이 없을 때 서버가 돌려주는, 모든 장의 원문에서 찾은 문장 — 장 표시가 붙은 ID 를 누르면 3열에서 연다
function hitsCard(ev) {
  if (!ev.details?.length) return h('div.notice', '수집한 원문에서 관련 문장을 찾지 못했습니다.');
  return h('div.proposal',
    h('div.proposal-head', h('span', `원문 검색 결과 ${ev.details.length}건`)),
    ev.details.map(hit => h('div.proposal-item.hit.toc-item',
      h('div.proposal-text', hit.text),
      h('div.proposal-meta', refButton(hit.id), h('span.muted', hit.where)))));
}

// ───────────────────────────── 답 속의 링크 ─────────────────────────────
// 장 표시가 붙은 ID(R-002 · R-002/S-001 · R-002/S-001.b5.s2 · R-002/T-0005)를 그 자리를 여는 링크로 바꾼다 — chat.js renderMarkdown 에 끼운다 (FR-WB-076)

const BOOK_ID_RE = /\b(R-\d{3,})(?:\/(S-\d{3}(?:\.b\d+\.(?:s\d+|r\d+c\d+))?|T-\d{4}))?\b/g;
const wrap = (text, code) => (code ? h('code', text) : text);

function refTitle(ref) {
  const [chapterId, rest] = ref.split('/');
  const name = view.chapters.find(ch => ch.id === chapterId)?.title ?? '이 보고서에 없는 장';
  if (!rest) return `${name}\n목차·지시문에서 이 장 보기`;
  if (rest.startsWith('T-')) return `${name} › ${rest}\n누르면 이 장의 작성 화면에서 그 문장을 보여 줍니다`;
  return `${name} › ${rest}\n원문 패널에서 열기`;
}

const refButton = ref => h('button.ref', { type: 'button', class: ref.includes('/T-') ? 'ref-doc' : '', dataset: { bookRef: ref }, title: refTitle(ref) }, ref);

function bookLinks(text, code = false) {
  const nodes = [];
  let at = 0;
  for (const m of text.matchAll(BOOK_ID_RE)) {
    if (at < m.index) nodes.push(wrap(text.slice(at, m.index), code));
    nodes.push(refButton(m[0]));
    at = m.index + m[0].length;
  }
  if (at < text.length) nodes.push(wrap(text.slice(at), code));
  return nodes;
}

function onLogClick(event) {
  const ref = event.target.closest('[data-book-ref]');
  if (ref) {
    const [chapterId, rest] = ref.dataset.bookRef.split('/');
    if (!view.chapters.some(ch => ch.id === chapterId)) return toast('이 보고서에 없는 장입니다.', 'error');
    if (!rest) return go.showChapter(chapterId);
    if (rest.startsWith('T-')) return go.openChapter(chapterId, rest);
    return go.showSource(chapterId, rest.split('.')[0], rest.includes('.') ? rest : null);
  }
}

// 선택 질문 창(ask.js — app.js 가 이어 준다)이 이 채팅에서 띄울 때 쓰는 부품: 보고서, 고른 모델, 장 표시가 붙은 ID 링크와 그 클릭 (FR-WB-102)
export const bookAsk = {
  scope: () => (view.book.id ? { bookId: view.book.id } : null),
  models: () => ({ model: modelSelect.value, models }),
  render: raw => renderMarkdown(raw, bookLinks),
  click: onLogClick,
};

const batchOf = node => batches.find(b => b.id === node.closest('[data-batch]')?.dataset.batch);

// ───────────────────────────── 목차 수정안 카드 ─────────────────────────────

const TOC_OP = { add: '장 추가', rename: '제목 변경', instructions: '지시문 변경', report_instructions: '보고서 공통 지시문 변경', move: '순서 변경', delete: '장 삭제' };
const DECISION = { accepted: '반영됨', rejected: '거부됨', gone: '대상 장이 없어져 반영하지 않았습니다', stale: '수정안을 낸 뒤 지시문이 달라져 반영하지 않았습니다 — 다시 요청하세요', commented: '추가의견을 보냈습니다 — 반영하지 않고 에이전트의 고친 수정안을 기다립니다' };
const exists = id => view.chapters.some(ch => ch.id === id);
// 지시문 변경 수정안은 낼 때의 지시문(before)을 기준으로 한다 — 그 뒤 작성자가 고쳤으면 반영하지 않는다 (ERR-WB-009)
const isStale = item => (item.op === 'report_instructions' && (item.before || '') !== (view.book.instructions || ''))
  || (item.op === 'instructions' && exists(item.chapterId) && (item.before || '') !== (view.chapters.find(ch => ch.id === item.chapterId)?.instructions || ''));
// 대상 장(또는 기준 장)이 이미 없어진 수정안 (ERR-WB-007)
const targetGone = item => (item.chapterId && !exists(item.chapterId)) || (item.after && !['start', 'end'].includes(item.after) && !exists(item.after));
const chapterLabel = item => `${item.chapterTitle || item.chapterId} (${item.chapterId})`;
const whereText = item => (item.after === 'start' ? '맨 앞' : !item.after || item.after === 'end' ? '맨 뒤' : `${item.afterTitle || item.after} (${item.after}) 뒤`);
const diffNodes = (before, after) => diffText(before, after).map(d => (d.kind === 'same' ? d.text : h(d.kind, d.text)));

// 수정안 상태가 바뀌거나 목차가 바뀔 때마다 채팅 안의 카드들을 다시 그린다
function renderTocCards() {
  for (const batch of batches) for (const item of batch.items) if (item.decision === 'pending' && targetGone(item)) item.decision = 'gone';
  for (const card of log.querySelectorAll('[data-batch]')) {
    const batch = batches.find(b => b.id === card.dataset.batch);
    if (!batch) continue;
    const pending = batch.items.filter(i => i.decision === 'pending');
    fill(card,
      h('div.proposal-head',
        h('span', h('span.kind-chip', { title: '보고서 내용(장 구성·다룰 내용·범위·순서)에 관한 수정안 — 쓰는 규칙은 작성요령 저장 카드로 옵니다' }, '내용'), `${batch.model} 목차 수정안 ${batch.items.length}건`, pending.length < batch.items.length && h('span.muted', ` · 남은 검토 ${pending.length}건`))),
      pending.length > 1 && reviewBox(batch, {
        label: '남은 수정안 모두에 대한 의견',
        placeholder: `남은 ${pending.length}건 모두에 대한 의견 (선택)`,
        title: '적고 「모두 반영」·「모두 거부」를 누르면 작성요령 「수정안 검토 의견」에 한 줄로 남습니다. 비우면 결정만 합니다',
        actions: [
          { text: '모두 반영', primary: true, blocked: batch.busy ? '반영하는 중입니다' : '', run: comment => decideAll(batch, true, comment) },
          { text: '모두 거부', blocked: batch.busy ? '반영하는 중입니다' : '', run: comment => decideAll(batch, false, comment) },
        ],
      }),
      reviewResult(batch),
      batch.items.map(item => tocItem(batch, item)),
      pending.length > 0 && h('div.proposal-foot', '반영하기 전에는 목차와 지시문이 바뀌지 않습니다. 반영한 장 추가·삭제는 실행 취소할 수 없습니다.'));
  }
}

function tocItem(batch, item) {
  let body;
  const stale = item.decision === 'pending' && isStale(item);
  if (item.op === 'add') body = [h('div.proposal-text', h('strong', item.title), h('span.muted', ` · 수준 ${item.level} · ${whereText(item)}`)), item.instructions && h('details.toc-instr-details', { open: item.instructions.length <= 600 }, h('summary', `지시문 ${item.instructions.length.toLocaleString()}자`), h('div.toc-instr', item.instructions))];
  else if (item.op === 'rename') body = [h('div.toc-target', chapterLabel(item)), h('div.proposal-text', diffNodes(item.before, item.title))];
  else if (item.op === 'instructions') body = [h('div.toc-target', chapterLabel(item)), instructionsDiff(item.before, item.instructions), stale && h('div.notice.is-error.toc-stale', '이 장의 지시문이 수정안을 낸 뒤 달라졌습니다 — 반영할 수 없으니 다시 요청하세요.')];
  else if (item.op === 'report_instructions') body = [h('div.toc-target', '보고서 공통 지시문 — 모든 장에 적용'), instructionsDiff(item.before, item.instructions), stale && h('div.notice.is-error.toc-stale', '보고서 공통 지시문이 수정안을 낸 뒤 달라졌습니다 — 반영할 수 없으니 다시 요청하세요.')];
  else if (item.op === 'move') body = [h('div.proposal-text', chapterLabel(item), h('span.muted', ` → ${item.after ? whereText(item) : '같은 자리'}${item.level ? ` · 수준 ${item.level}` : ''}`))];
  else body = [h('div.proposal-text', h('del', chapterLabel(item))), h('div.toc-target', `이 장의 문장 ${item.sentences}개와 원문 ${item.sources}건도 함께 지워집니다`)];
  return h('div.proposal-item.toc-item', { class: `is-${item.decision}`, dataset: { item: item.id } },
    h('div.change-head', h('span.op-badge', { class: `toc-${item.op}` }, TOC_OP[item.op])),
    body,
    item.reason && h('div.change-reason', item.reason),
    item.decision !== 'pending' ? [h('div.change-decision', { class: ['gone', 'stale'].includes(item.decision) ? `is-${item.decision}` : '' }, DECISION[item.decision]), reviewResult(item)]
      : reviewBox(item, {
        label: '이 수정안에 대한 의견',
        placeholder: '의견 (선택) — 비우면 결정만 합니다',
        title: '적고 반영·거부하면 작성요령 「수정안 검토 의견」에 남아 에이전트가 참조합니다. 추가의견은 여기 적어야 보낼 수 있습니다',
        actions: [
          { text: '✓ 반영', primary: true, blocked: item.busy || batch.busy ? '반영하는 중입니다' : stale ? '지시문이 수정안을 낸 뒤 달라져 반영할 수 없습니다' : '', run: comment => decide(batch, item, true, comment) },
          { text: '✕ 거부', blocked: item.busy || batch.busy ? '반영하는 중입니다' : '', run: comment => decide(batch, item, false, comment) },
          { text: '💬 추가의견', needsText: true, title: '반영·거부하지 않고 칸에 적은 의견을 에이전트에게 보내 고친 수정안을 받습니다', blocked: item.busy || batch.busy ? '반영하는 중입니다' : running ? '에이전트가 답하는 중에는 추가의견을 보낼 수 없습니다' : '', run: comment => sendComment(item, comment) },
        ],
      }));
}

// 지시문 변경 — 절마다 나눠 바뀐 절만 diff 로 보여 주고, 너무 긴 절은 diff 대신 전후 전문으로 보여 준다(diffText 는 글자 수의 곱만큼 일한다) (FR-WB-073, 076)
const DIFF_LIMIT = 3000;
function instructionsDiff(before, after) {
  if (!before) return h('div.toc-instr', after);
  const a = parseInstructions(before);
  const b = parseInstructions(after);
  const parts = [['preamble', '그 밖의 글'], ...SECTIONS.map(s => [s.key, s.title])].map(([key, title]) => {
    const x = key === 'preamble' ? a.preamble : a.sections[key];
    const y = key === 'preamble' ? b.preamble : b.sections[key];
    if (!x && !y) return null;
    if (x === y) return h('div.toc-diff-section.is-same', h('span.toc-diff-title', title), h('span.muted', ' — 변경 없음'));
    const body = x.length + y.length > DIFF_LIMIT
      ? [x && h('div.toc-instr', h('del', x)), y && h('div.toc-instr', h('ins', y))]
      : h('div.toc-instr', diffNodes(x, y));
    return h('div.toc-diff-section', h('span.toc-diff-title', title), body);
  }).filter(Boolean);
  return h('div.toc-diff', parts);
}

// ───────────────────────────── 반영 · 거부 ─────────────────────────────

const CANCELLED = Symbol('cancelled');

// comment: 칸에 적은 반영 의견·거부 사유(비었으면 결정만) — 반영하지 못하면(실패·취소·ERR-WB-007·009) 남기지 않는다 (FR-WB-103 (a))
async function decide(batch, item, accept, comment = '') {
  if (item.decision !== 'pending' || item.busy) return;
  if (!accept) {
    item.decision = 'rejected';
    renderTocCards();
    return keepReview(item, 'reject', comment);
  }
  if (targetGone(item)) {
    item.decision = 'gone';
    return renderTocCards();
  }
  if (isStale(item)) { // 그 사이 작성자가 지시문을 고쳤다 — 옛 전문으로 덮어쓰지 않는다 (ERR-WB-009)
    item.decision = 'stale';
    return renderTocCards();
  }
  item.busy = true;
  try {
    const data = await apply(item);
    if (data === CANCELLED) return;
    item.decision = 'accepted';
    if (data) go.bookChanged(data); // 보고서 상태를 다시 그린다 — 그때 setBookView 가 카드도 다시 그린다
    else await go.reload();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    item.busy = false;
  }
  renderTocCards();
  if (item.decision === 'accepted') await keepReview(item, 'accept', comment);
}

// 「모두 반영」·「모두 거부」 — 의견은 그렇게 결정된 수정안 전체에 대한 한 줄로 남긴다
async function decideAll(batch, accept, comment = '') {
  if (!batch || batch.busy) return;
  batch.busy = true;
  renderTocCards();
  const decided = [];
  try {
    for (const item of batch.items) {
      if (item.decision !== 'pending') continue;
      await decide(batch, item, accept);
      if (item.decision === (accept ? 'accepted' : 'rejected')) decided.push(item);
    }
  } finally {
    batch.busy = false;
  }
  renderTocCards();
  if (decided.length) await keepReview(batch, accept ? 'accept' : 'reject', comment, reviewWhatAll(decided, item => TOC_OP[item.op]));
}

// 추가의견 — 그 수정안을 반영하지 않은 채 닫고 종류·대상과 의견을 같은 대화로 보낸다. 에이전트는 고친 목차 수정안이나 작성요령 저장 수정안으로 답한다 (FR-WB-103 (b))
function sendComment(item, comment) {
  if (running || !comment) return;
  const what = reviewWhat(item, TOC_OP[item.op]);
  item.decision = 'commented';
  const draft = input.value; // 입력창에 쓰던 글은 그대로 둔다
  send(`목차 수정안 [${what}]에 대한 추가의견: ${comment}`);
  input.value = draft;
  return keepReview(item, 'comment', comment, what);
}

// 적은 의견을 작성요령 「수정안 검토 의견」에 남긴다 — 남기지 못해도 결정은 그대로이고 사유를 카드에 보인다 (FR-WB-103 (c), ERR-WB-017)
async function keepReview(target, action, comment, what = reviewWhat(target, TOC_OP[target.op])) {
  if (!comment) return;
  target.reviewed = { action, comment, saving: true };
  renderTocCards();
  Object.assign(target.reviewed, await recordReview(view.book.id, action, what, comment), { saving: false });
  if (target.reviewed.noted) await go.reload(); // 3열 작성요령 목록을 다시 받는다 — 그때 카드도 다시 그린다
  renderTocCards();
}

// 수정안 한 건을 서버에 반영한다 → 새 보고서 상태 (장 삭제는 null — 상태를 다시 받는다)
async function apply(item) {
  const bookId = view.book.id;
  if (item.op === 'add') return api('POST', '/api/book/chapters', { bookId, title: item.title, instructions: item.instructions, level: item.level, after: item.after });
  if (item.op === 'report_instructions') return api('PUT', '/api/book', { bookId, instructions: item.instructions }); // 보고서 공통 지시문 (FR-WB-087)
  if (item.op === 'delete') {
    // 장을 지우면 그 장의 원문도 함께 지워진다 — 먼저 확인을 받는다 (FR-WB-072)
    if (!confirm(`“${item.chapterTitle}” 장을 삭제할까요? 이 장의 본문과 수집한 원문 ${item.sources}건도 함께 지워지며 되돌릴 수 없습니다.`)) return CANCELLED;
    await api('DELETE', `/api/reports/${encodeURIComponent(item.chapterId)}`);
    return null;
  }
  let list = view.chapters.map(({ id, title, instructions, level, cascade }) => ({ id, title, instructions, level, cascade }));
  if (item.op === 'move') {
    list = moveAfter(list, item.chapterId, item.after, item.level);
    if (!list) throw new Error('옮길 자리를 찾지 못했습니다');
  } else {
    const target = list.find(ch => ch.id === item.chapterId);
    if (item.op === 'rename') target.title = item.title;
    else target.instructions = item.instructions;
  }
  return api('PUT', '/api/book', { bookId, chapters: list });
}
