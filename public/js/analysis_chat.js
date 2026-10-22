// 데이터 분석 화면 2열 — 분석 에이전트 (FR-WB-106). 분석마다 대화(채팅 기록·대화 ID·진행 중인 응답)를 따로 두어,
// 다른 분석이나 다른 화면으로 옮겨도 답하던 응답은 이어 가고 다시 열면 그대로 보인다. 브라우저를 새로 고치면 서버가 그 응답을 멈춘다.
// 에이전트는 보고서를 바꾸지 않는다 — 결과는 작업 폴더의 results/ 에 파일로 남고, 서버가 거둘 때마다 results 이벤트로 1열을 갱신하게 한다.
// 문답은 분석에 보관되어 다시 열면 보이고, 「새 대화」는 확인 뒤 보관한 문답을 비운다(결과 파일은 남는다).
// analysis.js 가 이 모듈을 부르므로 화면 모듈을 import 하지 않는다 — 1열·3열 조작과 탐색기 다시 그리기는 handlers 로 받는다.
import { describeUsage, modelOptions, renderMarkdown, streamChat, TOOL_LABELS } from './chat.js';
import { collapseButton } from './columns.js';
import { api } from './state.js';
import { fill, h, toast } from './util.js';

let root, input, sendBtn, newBtn, modelSelect, ctxMeter;
const go = { resultsChanged: () => {}, busyChanged: () => {}, openResult: () => {}, openGuide: () => {}, openSource: () => {} };
const sessions = new Map(); // `보고서 ID/분석 ID` → { bookId, analysisId, log, conversationId, running, abort, lastModel, usageByModel }
let current = null; // 보이는 분석의 대화
let models = [];

const keyOf = (bookId, analysisId) => `${bookId}/${analysisId}`;
const FENCE_RE = /```sourceanchor[\s\S]*?(```|$)/g; // 분석 화면은 블록을 다루지 않는다 — 보관한 답에 있어도 보이지 않게

const SUGGESTIONS = [
  { label: '문서 구성 살펴보기', text: '기준 문서들의 구성(부·장·절)과 분량을 살펴보고, 어떻게 나눠 분석하면 좋을지 제안해 줘' },
  { label: '서브에이전트로 나눠 추출', text: 'G-001 문서를 서브에이전트 10개에 구간을 나눠 맡겨 … 을 추출하고, 구간별 JSON 과 통합 JSON 을 results 에 남겨 줘', prefill: true },
];

export function initAnalysisChat(container, handlers) {
  root = container;
  Object.assign(go, handlers);
  modelSelect = h('select.model-select', { title: '분석 에이전트 모델', 'aria-label': '분석 에이전트 모델', onchange: () => { renderUsage(); try { localStorage.setItem('sa.model', modelSelect.value); } catch { /* 저장하지 못해도 이번 대화에는 적용된다 */ } } });
  ctxMeter = h('span.ctx-meter', { hidden: true });
  input = h('textarea', { rows: 2, 'aria-label': '분석 에이전트에게 요청', placeholder: '무엇을 분석해 어떤 파일로 남길지 알려 주세요…' });
  sendBtn = h('button.btn', { type: 'submit' }, '보내기');
  newBtn = h('button.btn.small.ghost', { type: 'button', title: '이 분석의 문답을 비웁니다 — 결과 파일은 남습니다', onclick: newChat }, '새 대화');
  const form = h('form.composer', { onsubmit: event => { event.preventDefault(); current?.running ? stop(current) : send(input.value); } }, h('div.composer-row', input, sendBtn),
    h('div.composer-hint', h('span', '결과는 1열에 파일로 쌓입니다'), h('span', '↵ 전송 · Shift + ↵ 줄바꿈')));
  root.append(
    h('header.col-head',
      h('div.col-title', h('span.col-index', '2'), '분석 에이전트', modelSelect, ctxMeter),
      h('div.col-head-actions', newBtn, collapseButton(root, '2열 분석 에이전트'))),
    h('div.chat-log'), // 자리만 — 분석을 열면 그 대화의 기록으로 바꾼다
    form,
  );
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  loadModels();
}

// 그 분석의 에이전트가 이 창에서 답하는 중인가 — 0열 목록의 표시와 삭제 막기에 쓴다 (FR-WB-106 (e), ERR-WB-010)
export const analysisBusy = (bookId, analysisId) => Boolean(sessions.get(keyOf(bookId, analysisId))?.running);

// analysis.js 가 분석을 열 때 부른다 — 그 분석의 대화가 있으면 그대로(진행 중인 답 포함), 없으면 보관한 문답으로 기록을 그린다
export function setAnalysisView({ bookId, analysis }) {
  const key = keyOf(bookId, analysis.id);
  if (!sessions.has(key)) sessions.set(key, { bookId, analysisId: analysis.id, log: newLog(), conversationId: null, running: false, abort: null, lastModel: null, usageByModel: {} });
  current = sessions.get(key);
  if (!current.running && !current.conversationId) fillLog(current, analysis.messages);
  root.querySelector('.chat-log').replaceWith(current.log);
  setRunningView();
  renderUsage();
  scrollToEnd(current);
}

function newLog() {
  const log = h('div.chat-log');
  log.addEventListener('click', onLogClick);
  return log;
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
  const u = current?.usageByModel[modelSelect.value];
  ctxMeter.hidden = !u;
  if (!u) return;
  const shown = describeUsage(u, modelLabel(modelSelect.value));
  ctxMeter.textContent = shown.text;
  ctxMeter.classList.toggle('is-high', shown.high);
  ctxMeter.title = shown.title;
}

// 보관한 문답으로 기록을 다시 그린다 — 없으면 처음 안내
function fillLog(session, messages = []) {
  if (!messages.length) return session.log.replaceChildren(welcome());
  session.log.replaceChildren(...messages.map(m => (m.role === 'user'
    ? h('div.msg.msg-user', h('div.msg-text', m.text))
    : h('div.msg.msg-agent', h('div.msg-model', modelLabel(m.model)), h('div.msg-text', renderMarkdown(m.text.replace(FENCE_RE, '').trim(), analysisLinks))))));
}

function welcome() {
  return h('div.chat-welcome',
    h('span.welcome-eyebrow', '분석 에이전트'),
    h('h2.welcome-title', '자료를 분석해 파일로 남기세요'),
    h('p', '보고서의 기준 문서와 장별 원문을 읽고, 결과를 이 분석의 결과 폴더에 JSON·YAML 등 파일로 남깁니다. 연결한 서브에이전트에게 구간을 나눠 맡길 수 있습니다(응답 한 번에 40개, 동시에 10개까지).'),
    h('div.suggestions', SUGGESTIONS.map(({ label, text, prefill }) => h('button.suggestion', { type: 'button', title: text, onclick: () => { if (!prefill) return send(text); input.value = text; input.focus(); } }, label))),
    h('p.muted.welcome-note', '보고서의 본문·원문·목차는 바뀌지 않습니다. 결과 파일은 1열에서 보고 내려받을 수 있습니다.'));
}

// 「새 대화」 — 보관한 문답을 비우고 다음 메시지부터 새 대화로 (결과 파일은 남는다)
async function newChat() {
  const session = current;
  if (!session || session.running) return;
  if (!confirm('이 분석의 문답을 비우고 새 대화를 시작할까요? 결과 파일은 그대로 남습니다.')) return;
  try {
    await api('DELETE', `/api/books/${encodeURIComponent(session.bookId)}/analyses/${encodeURIComponent(session.analysisId)}/messages`);
    session.conversationId = null;
    session.lastModel = null;
    session.usageByModel = {};
    fillLog(session, []);
    renderUsage();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ───────────────────────────── 보내기 · 받기 ─────────────────────────────

async function send(text) {
  text = text.trim();
  const session = current;
  if (!text || !session || session.running) return;
  const model = modelSelect.value;
  const { log } = session;
  log.querySelector('.chat-welcome')?.remove();
  if (session.lastModel && session.lastModel !== model) log.append(h('div.notice', `모델을 ${modelLabel(session.lastModel)} → ${modelLabel(model)} 로 바꿨습니다. 앞선 대화 내용을 함께 전달합니다.`));
  session.lastModel = model;
  log.append(h('div.msg.msg-user', h('div.msg-text', text)));
  input.value = '';
  const typing = h('div.typing', h('span'), h('span'), h('span'));
  const bubble = h('div.msg.msg-agent', h('div.msg-model', modelLabel(model)), typing);
  log.append(bubble);
  scrollToEnd(session);
  setRunning(session, true);

  let textEl = null;
  let raw = '';
  const handlers = {
    start: ev => { session.conversationId = ev.conversationId; },
    text_start: () => { raw = ''; textEl = h('div.msg-text'); bubble.append(textEl); },
    text: ev => { raw += ev.d; textEl.replaceChildren(...renderMarkdown(raw.replace(FENCE_RE, ''), analysisLinks)); },
    tool: ev => bubble.append(h('div.tool', h('span.tool-name', TOOL_LABELS[ev.name] || ev.name), h('span.tool-summary', ev.summary || ''))),
    results: () => go.resultsChanged(session.bookId, session.analysisId),
    notice: ev => bubble.append(h('div.notice', ev.text)),
    usage: ev => { session.usageByModel[ev.model] = ev; if (session === current) renderUsage(); },
    error: ev => bubble.append(h('div.notice.is-error', ev.message)),
  };

  try {
    session.abort = new AbortController();
    await streamChat({ conversationId: session.conversationId, text, model, bookId: session.bookId, analysisId: session.analysisId }, session.abort.signal, ev => {
      handlers[ev.t]?.(ev);
      bubble.append(typing);
      scrollToEnd(session);
    });
  } catch (err) {
    if (err.name !== 'AbortError') bubble.append(h('div.notice.is-error', err.message));
  } finally {
    typing.remove();
    for (const el of bubble.querySelectorAll('.msg-text')) if (!el.textContent.trim()) el.remove();
    if (bubble.childElementCount <= 1) bubble.append(h('div.notice', '중지했습니다.'));
    setRunning(session, false);
    go.resultsChanged(session.bookId, session.analysisId); // 끝날 때 거둔 것까지 1열·0열에 맞춘다
  }
}

function stop(session) {
  if (session.conversationId) api('POST', '/api/chat/stop', { conversationId: session.conversationId }).catch(() => {});
  session.abort?.abort();
}

function setRunning(session, value) {
  session.running = value;
  if (session === current) setRunningView();
  go.busyChanged();
}

function setRunningView() {
  const value = Boolean(current?.running);
  sendBtn.textContent = value ? '중지' : '보내기';
  sendBtn.classList.toggle('danger', value);
  modelSelect.disabled = value;
  newBtn.disabled = value;
}

// 보이는 대화일 때만 끝으로 내린다 — 뒤에서 답하는 대화는 다시 열 때 내린다
function scrollToEnd(session) {
  if (session === current) session.log.scrollTop = session.log.scrollHeight;
}

// ───────────────────────────── 답 속의 링크 ─────────────────────────────
// 기준 문서 위치(G-003 · G-003.b12.s2 · G-001.p21.b3.s2)와 장 표시가 붙은 원문 위치(R-002/S-001 · R-002/S-001.b5.s2)는 3열 자료 탐색기에서 열고 —
// 앞에 보고서 표시(M-003/…)가 있으면 그 보고서의 것, 없으면 지금 보고서의 것 (FR-WB-107 (d)) — 결과 파일 경로(results/…)는 1열에서 연다

const LINK_RE = /(?:\b(M-\d{3,})\/)?\b(G-\d{3,}(?:\.(?:p\d+|b\d+|s\d+|r\d+c\d+))*)\b|(?:\b(M-\d{3,})\/)?\b(R-\d{3,})\/(S-\d{3}(?:\.b\d+\.(?:s\d+|r\d+c\d+))?)\b|(?<![\w/.-])results\/([^\s`'"<>()[\]{},;]+\.(?:json|ya?ml|csv|md|txt))/g;
const wrap = (text, code) => (code ? h('code', text) : text);

function analysisLinks(text, code = false) {
  const nodes = [];
  let at = 0;
  for (const m of text.matchAll(LINK_RE)) {
    if (at < m.index) nodes.push(wrap(text.slice(at, m.index), code));
    if (m[2]) nodes.push(h('button.ref', { type: 'button', dataset: { guideRef: m[2], bookRef: m[1] ?? '' }, title: `${m[0]}\n3열에서 이 기준 문서${m[2].includes('.') ? '의 이 위치' : ''}를 엽니다` }, m[0]));
    else if (m[4]) nodes.push(h('button.ref', { type: 'button', dataset: { sourceRef: `${m[4]}/${m[5]}`, bookRef: m[3] ?? '' }, title: `${m[0]}\n3열에서 이 원문을 엽니다` }, m[0]));
    else nodes.push(h('button.ref.result-ref', { type: 'button', dataset: { resultRef: m[6] }, title: `${m[0]}\n1열에서 이 결과 파일을 엽니다` }, m[0]));
    at = m.index + m[0].length;
  }
  if (at < text.length) nodes.push(wrap(text.slice(at), code));
  return nodes;
}

function onLogClick(event) {
  const guide = event.target.closest('[data-guide-ref]');
  if (guide) {
    const ref = guide.dataset.guideRef;
    return go.openGuide(guide.dataset.bookRef || null, ref.split('.')[0], ref.includes('.') ? ref : null);
  }
  const source = event.target.closest('[data-source-ref]');
  if (source) {
    const [chapterId, rest] = source.dataset.sourceRef.split('/');
    return go.openSource(source.dataset.bookRef || null, chapterId, rest.split('.')[0], rest.includes('.') ? rest : null);
  }
  const result = event.target.closest('[data-result-ref]');
  if (result) go.openResult(result.dataset.resultRef);
}
