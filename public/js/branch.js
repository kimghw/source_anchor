// 분기 질문 창 — 2열 채팅(주 대화)에서 갈라져 나와 질문·답변만 주고받는, 작성 화면 위에 떠 있는 창 (FR-WB-048~049).
// 첫 질문이 그때까지 끝난 주 대화의 문답을 이어받고, 여기서 나눈 문답은 주 대화에 들어가지 않는다. 수정안·자료 수집은 하지 않는다.
import { hitsCard, mainChat, onDragStart, onLogClick, renderMarkdown, streamChat, TOOL_LABELS } from './chat.js';
import { api, flushSave, on, state } from './state.js';
import { h, moveWindow, placeWindow } from './util.js';

let win = null; // 처음 띄울 때 만든다. 닫으면 숨기기만 해서 다시 띄우면 하던 문답이 그대로 있다
let log, input, sendBtn, modelSelect;
let conversationId = null;
let running = false;
let abort = null;

export function initBranch() {
  on('open-branch', open);
  on('doc-opened', () => { if (win) newBranch(); }); // 다른 문서를 열면 분기도 새로 시작한다
  window.addEventListener('resize', () => { if (win && !win.hidden) placeWindow(win, win.offsetLeft, win.offsetTop); });
}

function build() {
  modelSelect = h('select.model-select', { title: '분기 질문에 답할 모델', 'aria-label': '분기 질문 모델' });
  log = h('div.chat-log');
  input = h('textarea', { rows: 2, placeholder: '2열 대화와 따로 물어볼 내용을 적어 주세요. 편집기에서 고른 문장은 함께 전달됩니다.' });
  sendBtn = h('button.btn', { type: 'submit' }, '보내기');
  const form = h('form.composer', { onsubmit: event => { event.preventDefault(); running ? stop() : send(input.value); } }, h('div.composer-row', input, sendBtn));
  win = h('section.branch-window', { role: 'dialog', 'aria-label': '분기 질문', hidden: true },
    h('header.col-head.branch-head', { onpointerdown: event => moveWindow(win, event) },
      h('div.col-title', h('span.col-index', '↳'), '분기 질문', modelSelect),
      h('div.col-head-actions',
        h('button.btn.small.ghost', { type: 'button', title: '이 창의 문답을 비우고, 지금의 2열 대화에서 다시 갈라져 나옵니다', onclick: newBranch }, '새 분기'),
        h('button.icon-btn', { type: 'button', title: '닫기 (다시 띄우면 하던 문답이 그대로 있습니다)', 'aria-label': '분기 질문 창 닫기', onclick: close }, '✕'))),
    log,
    form);

  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  win.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.isComposing) close(); });
  log.addEventListener('dragstart', onDragStart);
  log.addEventListener('click', onLogClick);
  document.body.append(win);
  newBranch();
}

function open() {
  if (!win) build();
  if (!modelSelect.options.length) {
    const { model, models } = mainChat(); // 처음에는 2열에서 고른 모델로 시작한다
    modelSelect.replaceChildren(...models.map(m => h('option', { value: m.key, disabled: !m.available, selected: m.key === model, title: `${m.cli} CLI · ${m.model}` }, m.available ? m.label : `${m.label} (${m.cli} CLI 없음)`)));
  }
  if (win.hidden) {
    win.hidden = false;
    if (!win.style.left) placeWindow(win, window.innerWidth - win.offsetWidth - 24, 64);
    else placeWindow(win, win.offsetLeft, win.offsetTop);
  }
  input.focus();
}

function close() {
  win.hidden = true;
}

function newBranch() {
  if (running) stop();
  conversationId = null;
  log.replaceChildren(h('div.chat-welcome',
    h('p', '2열 대화의 맥락을 이어받아 따로 묻는 창입니다. 여기서 나눈 문답은 2열 대화에 남지 않습니다.'),
    h('p.muted', '질문·답변만 합니다 — 보고서 수정안과 자료 수집은 2열 채팅에서 요청하세요.')));
}

// ───────────────────────────── 보내기 · 받기 ─────────────────────────────

const modelLabel = key => mainChat().models.find(m => m.key === key)?.label ?? key;

async function send(text) {
  text = text.trim();
  if (!text || running) return;
  const model = modelSelect.value;
  const first = !conversationId;
  const selected = state.sel.doc;
  log.querySelector('.chat-welcome')?.remove();
  const question = h('div.msg.msg-user',
    selected.length > 0 && h('div.msg-attach', h('div.msg-attach-item', h('span.chip-kind', '보고서'), `편집기에서 고른 문장 ${selected.length}개 (${selected.join(', ')})`)),
    h('div.msg-text', text));
  const typing = h('div.typing', h('span'), h('span'), h('span'));
  const bubble = h('div.msg.msg-agent', h('div.msg-model', modelLabel(model)), typing);
  log.append(question, bubble);
  input.value = '';
  scrollToEnd();
  setRunning(true);

  let textEl = null;
  let raw = '';
  const handlers = {
    start: ev => {
      conversationId = ev.conversationId;
      // 갈라져 나온 자리를 밝힌다 (FR-WB-048)
      if (first) question.before(h('div.notice', ev.inherited ? `2열 대화의 최근 문답 ${ev.inherited}건을 이어받아 갈라져 나왔습니다.` : '이어받을 2열 대화가 없어 빈 맥락으로 시작합니다.'));
    },
    text_start: () => { raw = ''; textEl = h('div.msg-text'); bubble.append(textEl); },
    text: ev => { raw += ev.d; textEl.replaceChildren(...renderMarkdown(raw)); },
    tool: ev => bubble.append(h('div.tool', h('span.tool-name', TOOL_LABELS[ev.name] || ev.name), h('span.tool-summary', ev.summary || ''))),
    hits: ev => bubble.append(hitsCard(ev)),
    notice: ev => bubble.append(h('div.notice', ev.text)),
    error: ev => bubble.append(h('div.notice.is-error', ev.message)),
  };

  try {
    await flushSave(); // 에이전트는 서버에 저장된 보고서를 읽는다
    abort = new AbortController();
    await streamChat({ conversationId, text, model, docId: state.doc.id, context: { selected, attachments: [] }, branch: true, branchOf: mainChat().conversationId }, abort.signal, ev => {
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

// 분기만 멈춘다 — 2열 대화는 다른 대화 ID 로 따로 돌고 있다 (FR-WB-049)
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
