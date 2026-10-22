// 선택 질문 창 — 2열 채팅에서 고른 답변(여러 개)이나 끌어 고른 글을 맥락으로, 그 부분만 따로 묻고 답하는 떠 있는 창 (FR-WB-102, ERR-WB-016).
// 띄울 때마다 새 창·새 대화다. 창은 띄운 채팅 열이 보일 때만 보인다(다른 화면으로 옮기면 숨는다). 수정안·자료 수집은 하지 않는다.
// 채팅 모듈은 이 모듈을 import 하지 않는다 — app.js 가 채팅 열마다 enableAsk 로 그 채팅의 부품(대상·모델·링크·클릭)을 넘긴다.
import { cleanExcerpts } from '../shared/ask.js';
import { modelOptions, renderMarkdown, streamChat, TOOL_LABELS } from './chat.js';
import { api } from './state.js';
import { fill, h, moveWindow, placeWindow, toast } from './util.js';

const homes = []; // 채팅 열마다 { root, opts, picked: Set<답변 말풍선>, bar, windows: [창] }
const stack = []; // 떠 있는 창의 앞뒤 순서 — 누른 창을 맨 앞으로
let opened = 0; // 띄운 창 수 — 새 창을 조금씩 비껴 놓는다
let floatBtn = null; // 끌어 고른 글 옆의 「선택 질문」 버튼 (모든 채팅 열이 함께 쓴다)
let floatTarget = null; // { home, range, piece }

const SUGGESTIONS = ['이 부분을 쉽게 풀어서 설명해 줘', '이 내용이 원문과 맞는지 근거를 확인해 줘'];

// opts: { scope() → 대화 대상({ docId } | { bookId } | { bookId, formId }, 없으면 null), models() → { model, models },
//         render?(raw) → 답의 노드(기본: chat.js renderMarkdown), click?(event) — 답 속 ID 링크, flush?() — 보내기 전에 저장 }
export function enableAsk(root, opts) {
  const home = { root, opts, picked: new Set(), bar: null, windows: [] };
  homes.push(home);
  // 답변 말풍선의 「선택」 단추는 처음 가리킬 때 모델 표시 줄에 붙인다 — 말풍선의 자식 수를 바꾸지 않는다(채팅 모듈이 빈 답을 그것으로 가린다)
  root.addEventListener('pointerover', event => addPickButton(event.target));
  root.addEventListener('focusin', event => addPickButton(event.target));
  root.addEventListener('click', event => {
    const bubble = event.target.closest('.msg-pick')?.closest('.msg-agent');
    if (!bubble) return;
    if (home.picked.has(bubble)) home.picked.delete(bubble);
    else home.picked.add(bubble);
    syncPicks(home);
  });
  // 새 대화로 기록이 비워지면 고른 답변도 풀린다 — 고른 말풍선이 빠질 때만 맞춘다(막대를 다시 그리는 변화에 다시 반응하지 않게)
  const holdsPicked = node => node.nodeType === Node.ELEMENT_NODE && [...home.picked].some(bubble => node.contains(bubble));
  new MutationObserver(records => {
    if (home.picked.size && records.some(r => [...r.removedNodes].some(holdsPicked))) syncPicks(home);
  }).observe(root, { childList: true, subtree: true });
  // 채팅 열이 보이지 않으면(다른 화면) 이 열에서 띄운 창도 숨긴다 — display:none 이 되면 크기가 0 으로 바뀌어 알림이 온다
  new ResizeObserver(() => syncWindows(home)).observe(root);
  if (homes.length === 1) watchSelection();
}

// ───────────────────────────── 답변 고르기 ─────────────────────────────

function addPickButton(target) {
  const label = target.closest?.('.chat-log > .msg-agent')?.querySelector(':scope > .msg-model');
  if (!label || label.querySelector('.msg-pick')) return;
  const picked = label.parentElement.classList.contains('is-picked');
  label.append(h('button.msg-pick', { type: 'button', title: '이 답변을 골라 그 부분만 따로 묻습니다 (선택 질문)', 'aria-pressed': String(picked) }, picked ? '✓ 선택됨' : '선택'));
}

function syncPicks(home) {
  for (const bubble of home.picked) if (!bubble.isConnected) home.picked.delete(bubble);
  for (const bubble of home.root.querySelectorAll('.msg-agent.is-picked')) if (!home.picked.has(bubble)) markPicked(bubble, false);
  for (const bubble of home.picked) markPicked(bubble, true);
  renderBar(home);
}

function markPicked(bubble, on) {
  bubble.classList.toggle('is-picked', on);
  const button = bubble.querySelector(':scope > .msg-model > .msg-pick');
  if (!button) return;
  button.textContent = on ? '✓ 선택됨' : '선택';
  button.setAttribute('aria-pressed', String(on));
}

// 고른 답변 수와 「선택 질문」·「선택 해제」 — 입력창 바로 위
function renderBar(home) {
  if (!home.bar?.isConnected) {
    home.bar = h('div.ask-bar', { role: 'status' });
    const composer = home.root.querySelector('.composer');
    if (composer) composer.before(home.bar);
    else home.root.append(home.bar);
  }
  const count = home.picked.size;
  home.bar.hidden = !count;
  if (!count) return;
  fill(home.bar,
    h('span.ask-bar-count', `답변 ${count}개 선택`),
    h('button.btn.small', { type: 'button', title: '고른 답변만 맥락으로 따로 묻는 창을 띄웁니다', onclick: () => openFromPicks(home) }, '↳ 선택 질문'),
    h('button.btn.small.ghost', { type: 'button', onclick: () => { home.picked.clear(); syncPicks(home); } }, '선택 해제'));
}

function openFromPicks(home) {
  const bubbles = [...home.picked].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const pieces = bubbles.map(bubble => ({
    kind: 'answer',
    question: questionOf(bubble),
    text: [...bubble.querySelectorAll(':scope > .msg-text')].map(el => el.innerText.replace(/\n{2,}/g, '\n').trim()).filter(Boolean).join('\n\n'), // 문단(<p>) 사이의 빈 줄은 한 줄로
  }));
  if (openWindow(home, pieces)) {
    home.picked.clear();
    syncPicks(home);
  }
}

// 답을 끌어낸 작성자 메시지 — 그 답 앞의 가장 가까운 작성자 말풍선
function questionOf(bubble) {
  for (let el = bubble.previousElementSibling; el; el = el.previousElementSibling) {
    if (el.classList.contains('msg-user')) return el.querySelector('.msg-text')?.innerText.trim() || '';
  }
  return '';
}

// ───────────────────────────── 끌어 고른 글 ─────────────────────────────

function watchSelection() {
  floatBtn = h('button.btn.small.ask-float', {
    type: 'button', hidden: true, title: '끌어 고른 글만 맥락으로 따로 묻는 창을 띄웁니다',
    onpointerdown: event => event.preventDefault(), // 누르는 사이 글 선택이 풀리지 않게
    onclick: () => {
      const target = floatTarget;
      hideFloat();
      if (target && openWindow(target.home, [target.piece])) document.getSelection()?.removeAllRanges();
    },
  }, '↳ 선택 질문');
  document.body.append(floatBtn);
  // 끌기를 마친 뒤(또는 Shift+방향키로 고른 뒤)에만 띄운다 — 끄는 동안 버튼이 따라다니지 않게
  document.addEventListener('pointerup', () => setTimeout(checkSelection));
  document.addEventListener('keyup', event => { if (event.shiftKey || event.key === 'Shift') checkSelection(); });
  document.addEventListener('selectionchange', () => { if (!floatBtn.hidden && document.getSelection()?.isCollapsed) hideFloat(); });
  document.addEventListener('scroll', () => { if (!floatBtn.hidden) placeFloat(); }, true);
  window.addEventListener('resize', () => { if (!floatBtn.hidden) placeFloat(); });
}

function checkSelection() {
  const selection = document.getSelection();
  const text = selection && !selection.isCollapsed && selection.rangeCount ? selection.toString().trim() : '';
  const range = text ? selection.getRangeAt(0) : null;
  const node = range?.commonAncestorContainer;
  const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  const log = el?.closest('.chat-log');
  const home = log && homes.find(x => x.root.contains(log));
  if (!home) return hideFloat();
  const answer = el.closest('.msg-agent');
  floatTarget = { home, range: range.cloneRange(), piece: { kind: 'excerpt', question: answer ? questionOf(answer) : '', text } };
  floatBtn.hidden = false;
  placeFloat();
}

// 고른 글의 끝 줄 바로 아래 — 창 밖으로 나가지 않게
function placeFloat() {
  const rects = floatTarget?.range.getClientRects();
  const rect = rects?.length ? rects[rects.length - 1] : floatTarget?.range.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) return hideFloat();
  floatBtn.style.left = `${Math.max(8, Math.min(window.innerWidth - floatBtn.offsetWidth - 8, rect.right - floatBtn.offsetWidth / 2))}px`;
  floatBtn.style.top = `${Math.max(8, Math.min(window.innerHeight - floatBtn.offsetHeight - 8, rect.bottom + 6))}px`;
}

function hideFloat() {
  if (floatBtn) floatBtn.hidden = true;
  floatTarget = null;
}

// ───────────────────────────── 창 ─────────────────────────────

// 고른 글이 비었거나 한도를 넘으면 열지 않고 알린다 (ERR-WB-016) → 열었으면 true
function openWindow(home, pieces) {
  let excerpts;
  try {
    excerpts = cleanExcerpts(pieces);
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
  const scope = home.opts.scope();
  if (!scope) {
    toast('이 화면에서 열린 대상이 없어 선택 질문을 띄울 수 없습니다.', 'error');
    return false;
  }
  const { model, models } = home.opts.models();
  const w = { home, scope, excerpts, models, conversationId: null, running: false, abort: null };
  w.modelSelect = h('select.model-select', { title: '선택 질문에 답할 모델', 'aria-label': '선택 질문 모델' }, modelOptions(models, model));
  w.log = h('div.chat-log');
  w.input = h('textarea', { rows: 2, placeholder: '고른 글에 대해 물어볼 내용을 적어 주세요.' });
  w.sendBtn = h('button.btn', { type: 'submit' }, '보내기');
  const form = h('form.composer', { onsubmit: event => { event.preventDefault(); w.running ? stop(w) : send(w, w.input.value); } }, h('div.composer-row', w.input, w.sendBtn));
  const chars = excerpts.reduce((n, p) => n + p.text.length, 0);
  const answers = excerpts.filter(p => p.kind === 'answer').length;
  w.el = h('section.branch-window.ask-window', { role: 'dialog', 'aria-label': '선택 질문' },
    h('header.col-head.branch-head', { onpointerdown: event => moveWindow(w.el, event) },
      h('div.col-title', h('span.col-index', '↳'), '선택 질문', w.modelSelect),
      h('div.col-head-actions',
        h('button.icon-btn', { type: 'button', title: '닫기 — 이 창의 대화를 끝냅니다', 'aria-label': '선택 질문 창 닫기', onclick: () => close(w) }, '✕'))),
    h('details.ask-excerpts', { open: chars <= 300 }, // 짧을 때만 펼쳐 둔다 — 길면 문답 자리를 차지한다
      h('summary', `${answers ? `고른 답변 ${answers}개` : '끌어 고른 글'} · ${chars.toLocaleString()}자`),
      excerpts.map((p, i) => h('div.ask-excerpt',
        h('div.ask-excerpt-head', p.kind === 'answer' ? `답변 ${i + 1}` : '끌어 고른 글'),
        p.question && h('div.ask-excerpt-question', { title: '이 답을 끌어낸 작성자 메시지' }, p.question),
        h('div.ask-excerpt-text', p.text)))),
    w.log,
    form);

  w.input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  if (home.opts.click) w.log.addEventListener('click', home.opts.click);
  w.el.addEventListener('pointerdown', () => raise(w), true);
  w.log.append(h('div.chat-welcome',
    h('p', '고른 글만 맥락으로 따로 묻는 창입니다. 여기서 나눈 문답은 2열 대화에 남지 않습니다.'),
    h('p.muted', '질문·답변만 합니다 — 수정안과 자료 수집은 2열 채팅에서 요청하세요.'),
    h('div.suggestions', SUGGESTIONS.map(text => h('button.suggestion', { type: 'button', onclick: () => send(w, text) }, text)))));

  home.windows.push(w);
  stack.push(w);
  document.body.append(w.el);
  const step = (opened++ % 6) * 28;
  placeWindow(w.el, window.innerWidth - w.el.offsetWidth - 24 - step, 64 + step);
  raise(w);
  w.input.focus();
  return true;
}

function close(w) {
  if (w.running) stop(w);
  w.el.remove();
  w.home.windows.splice(w.home.windows.indexOf(w), 1);
  stack.splice(stack.indexOf(w), 1);
}

// 누른 창을 맨 앞으로 — 분기 질문 창(z-index 40) 위에 쌓는다
function raise(w) {
  stack.splice(stack.indexOf(w), 1);
  stack.push(w);
  stack.forEach((x, i) => { x.el.style.zIndex = String(41 + i); });
}

function syncWindows(home) {
  const shown = home.root.getClientRects().length > 0;
  for (const w of home.windows) {
    if (w.el.hidden !== shown) continue;
    w.el.hidden = !shown;
    if (shown) placeWindow(w.el, w.el.offsetLeft, w.el.offsetTop); // 숨은 사이 창 크기가 바뀌었을 수 있다
  }
}

window.addEventListener('resize', () => { for (const w of stack) if (!w.el.hidden) placeWindow(w.el, w.el.offsetLeft, w.el.offsetTop); });

// ───────────────────────────── 보내기 · 받기 ─────────────────────────────

async function send(w, text) {
  text = text.trim();
  if (!text || w.running) return;
  const model = w.modelSelect.value;
  w.log.querySelector('.chat-welcome')?.remove();
  const typing = h('div.typing', h('span'), h('span'), h('span'));
  const bubble = h('div.msg.msg-agent', h('div.msg-model', w.models.find(m => m.key === model)?.label ?? model), typing);
  w.log.append(h('div.msg.msg-user', h('div.msg-text', text)), bubble);
  w.input.value = '';
  scrollToEnd(w);
  setRunning(w, true);

  const render = w.home.opts.render || (raw => renderMarkdown(raw));
  let textEl = null;
  let raw = '';
  const handlers = {
    start: ev => { w.conversationId = ev.conversationId; },
    text_start: () => { raw = ''; textEl = h('div.msg-text'); bubble.append(textEl); },
    text: ev => { raw += ev.d; textEl.replaceChildren(...render(raw)); },
    tool: ev => bubble.append(h('div.tool', h('span.tool-name', TOOL_LABELS[ev.name] || ev.name), h('span.tool-summary', ev.summary || ''))),
    notice: ev => bubble.append(h('div.notice', ev.text)),
    error: ev => bubble.append(h('div.notice.is-error', ev.message)),
  };

  try {
    await w.home.opts.flush?.(); // 에이전트는 서버에 저장된 내용을 읽는다
    w.abort = new AbortController();
    // 고른 글은 매번 함께 보낸다 — 서버가 대화를 잃었어도(다시 띄웠거나 오래된 대화를 치웠으면) 같은 맥락으로 다시 시작한다
    await streamChat({ conversationId: w.conversationId, text, model, ...w.scope, ask: { excerpts: w.excerpts } }, w.abort.signal, ev => {
      handlers[ev.t]?.(ev);
      bubble.append(typing);
      scrollToEnd(w);
    });
  } catch (err) {
    if (err.name !== 'AbortError') bubble.append(h('div.notice.is-error', err.message));
  } finally {
    typing.remove();
    for (const el of bubble.querySelectorAll('.msg-text')) if (!el.textContent.trim()) el.remove();
    if (bubble.childElementCount <= 1) bubble.append(h('div.notice', '중지했습니다.'));
    setRunning(w, false);
  }
}

// 이 창만 멈춘다 — 2열 대화와 다른 창은 다른 대화 ID 로 따로 돈다
function stop(w) {
  if (w.conversationId) api('POST', '/api/chat/stop', { conversationId: w.conversationId }).catch(() => {});
  w.abort?.abort();
}

function setRunning(w, value) {
  w.running = value;
  w.sendBtn.textContent = value ? '중지' : '보내기';
  w.sendBtn.classList.toggle('danger', value);
  w.modelSelect.disabled = value;
}

function scrollToEnd(w) {
  w.log.scrollTop = w.log.scrollHeight;
}
