// 데이터 분석 화면 — 에이전트와 함께 보고서의 기준 문서·원문을 분석해 결과를 파일로 남긴다 (FR-WB-088, 106, 107).
// 1열 입력 자료(고른 자료 — 빼기·열기)와 결과 파일(결과 폴더 위치, 파일 목록, 내용 보기·내려받기·삭제) · 2열 분석 에이전트(analysis_chat.js) ·
// 3열 자료 탐색기(data_explorer.js — 작업공간 전체의 기준 문서·장별 원문·다른 분석의 결과 파일을 보고 입력 자료로 고른다).
// 0열 탐색기 「데이터 분석」 탭에서 열린다. 보고서·장·양식 화면 모듈(book.js·documents.js·forms.js)을 import 하지 않는다 — 화면 전환 진입점은 app.js 가 넘긴다.
import { analysisBusy, initAnalysisChat, setAnalysisView } from './analysis_chat.js';
import { collapseButton } from './columns.js';
import { dataExplorer, inputKey, inputKindLabel } from './data_explorer.js';
import { redrawExplorer, showExplorer } from './explorer.js';
import { api, flushSave } from './state.js';
import { debounce, fill, formatDate, h, toast } from './util.js';

export { analysisBusy }; // 0열 목록의 「답하는 중」 표시 — app.js 가 탐색기에 넘긴다

const $ = id => document.getElementById(id);
const go = { openBook: async () => {}, flushForm: async () => true };
let bookId = null;
let book = null; // 보고서 상태 { book, chapters, sources, guides, analyses, forms } — 3열·탐색기
let analysis = null; // 열어 둔 분석 { id, title, messages, inputs, createdAt, updatedAt }
let inputs = []; // 입력 자료 — 서버가 이름을 붙여 준다 [{ kind, bookId, chapterId?, id?, analysisId?, path?, key, bookTitle, parentTitle, title, missing? }]
let results = []; // [{ path, ext, size, updatedAt, invalid? }]
let folder = ''; // 결과 폴더 — 작업공간 안의 실제 위치
let openPath = null; // 1열에서 내용을 보고 있는 결과 파일
let pending = false; // 아직 보내지 않은 제목 변경이 있다
let sourcesCol = null;
let saveState = null;

const bookUrl = owner => (owner ? `/api/book?report=${encodeURIComponent(owner)}` : '/api/book');
const analysisUrl = (owner, id = '') => `/api/books/${encodeURIComponent(owner)}/analyses${id ? `/${encodeURIComponent(id)}` : ''}`;
const resultUrl = (rel, download = false) => `${analysisUrl(bookId, analysis.id)}/results/${rel.split('/').map(encodeURIComponent).join('/')}${download ? '?download=1' : ''}`;
const size = n => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function initAnalyses(handlers) {
  Object.assign(go, handlers);
  saveState = h('span.screen-save-state', { role: 'status' }, '저장됨');
  fill($('analysis-controls'),
    h('button.btn.small.ghost.to-book', { type: 'button', title: '보고서 화면으로', onclick: leave }, '↩ 보고서'),
    h('span.doc-kind', '데이터 분석'),
    h('span.doc-current.analysis-current'));
  sourcesCol = dataExplorer($('analysis-sources'), { label: '3열 자료 탐색기', selected: () => new Set(inputs.map(i => i.key)), toggle: setInputs });
  initAnalysisChat($('analysis-chat'), {
    resultsChanged, busyChanged: () => redrawExplorer(), openResult: rel => openResult(rel),
    openGuide: (owner, id, at) => sourcesCol.openGuide(owner, id, at), openSource: (owner, chapterId, sourceId, at) => sourcesCol.openSource(owner, chapterId, sourceId, at),
  });
  window.addEventListener('beforeunload', () => { if (pending) save.flush(); });
}

// ───────────────────────────── 열기 · 만들기 · 떠나기 ─────────────────────────────

// 탐색기·주소(?analysis=)에서 연다. 쓰던 장·양식을 먼저 저장하고, 저장하지 못하면 옮기지 않는다 (FR-WB-062, ERR-WB-006, ERR-WB-011)
export async function openAnalysis(wantedBookId, id) {
  try {
    await flushSave();
  } catch (err) {
    return toast(`저장하지 못해 이동하지 않았습니다: ${err.message}`, 'error');
  }
  if (!(await go.flushForm())) return;
  if (pending) await save.flush(); // 보던 분석의 제목
  try {
    const state = await api('GET', bookUrl(wantedBookId));
    const opened = await api('GET', analysisUrl(state.book.id, id));
    bookId = state.book.id;
    book = state;
    ({ analysis, inputs, results, folder } = opened);
    openPath = null;
    history.replaceState(null, '', `?report=${encodeURIComponent(bookId)}&analysis=${encodeURIComponent(analysis.id)}`);
    showAnalysisScreen(true);
    renderHead();
    renderResults();
    setAnalysisView({ bookId, analysis }); // 2열 — 그 분석의 대화(진행 중이면 그대로)
    sourcesCol.show({ bookId, analysisId: analysis.id, book }, { reset: true });
    explore();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// 빈 분석을 만들고 곧바로 연다
export async function newAnalysis(wantedBookId) {
  try {
    const created = await api('POST', analysisUrl(wantedBookId || bookId), { title: '' });
    await openAnalysis(wantedBookId, created.analysis.id);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// 보고서 화면으로 — 답하던 분석 에이전트는 멈추지 않는다 (FR-WB-106 (e))
async function leave() {
  if (pending) await save.flush();
  await go.openBook(bookId).catch(err => toast(err.message, 'error'));
}

// 네 화면은 상단 머리줄을 함께 쓴다 — 장에만 있는 것은 접는다. 다른 화면을 열면 book.js showBookScreen · forms.js showFormScreen 이 이 화면을 숨긴다
function showAnalysisScreen(on) {
  $('workspace').hidden = true;
  $('book-workspace').hidden = true;
  $('form-workspace').hidden = true;
  $('analysis-workspace').hidden = !on;
  $('doc-controls').hidden = true;
  $('book-controls').hidden = true;
  $('form-controls').hidden = true;
  $('analysis-controls').hidden = !on;
  for (const el of ['summary', 'save-state', 'btn-undo', 'btn-redo', 'btn-export']) $(el).hidden = true;
  document.body.classList.remove('on-book', 'on-form');
  document.body.classList.toggle('on-analysis', on);
}

const onScreen = () => !$('analysis-workspace').hidden;
const explore = () => showExplorer({ book: book.book, chapters: book.chapters, current: null, analyses: book.analyses, forms: book.forms, currentAnalysis: analysis.id });

// ───────────────────────────── 제목 ─────────────────────────────

// 상단 머리줄 — 분석 제목은 그 자리에서 고치고 자동 저장한다. 비우면 서버가 「제목 없는 분석」으로 둔다
function renderHead() {
  const title = h('input.book-title', { value: analysis.title, placeholder: '제목 없는 분석', 'aria-label': '분석 제목', oninput: () => { analysis.title = title.value; queueSave(); } });
  fill($('analysis-controls').querySelector('.analysis-current'), title, h('span.doc-current-id', analysis.id), saveState);
}

async function saveNow() {
  if (!pending) return;
  pending = false;
  const target = { owner: bookId, id: analysis.id, title: analysis.title };
  try {
    const res = await api('PUT', analysisUrl(target.owner, target.id), { title: target.title });
    if (target.owner === bookId) book.analyses = res.analyses;
    saveState.textContent = '저장됨';
    saveState.classList.remove('is-error');
    if (onScreen() && analysis.id === target.id) explore();
  } catch (err) {
    saveState.textContent = '저장 실패';
    saveState.classList.add('is-error');
    toast(err.message, 'error');
  }
}
const save = debounce(saveNow, 700);
function queueSave() {
  pending = true;
  saveState.textContent = '저장 중…';
  save();
}

// ───────────────────────────── 1열 결과 파일 ─────────────────────────────

// 서버가 결과를 거둘 때마다(results 이벤트)와 응답이 끝날 때 — 0열 결과 수와, 그 분석을 보고 있으면 1열 목록을 맞춘다
async function resultsChanged(owner, id) {
  try {
    if (onScreen() && owner === bookId && id === analysis.id) {
      ({ inputs, results, folder } = await api('GET', analysisUrl(owner, id)));
      renderResults();
    }
    if (owner === bookId) redrawExplorer(book.analyses = (await api('GET', analysisUrl(owner))).analyses);
  } catch { /* 다음 이벤트에서 다시 맞춘다 */ }
}

async function refresh() {
  await resultsChanged(bookId, analysis.id);
}

function renderResults() {
  const root = $('analysis-results');
  const opened = results.find(r => r.path === openPath);
  if (!opened) openPath = null;
  fill(root,
    h('header.col-head',
      h('div.col-title', h('span.col-index', '1'), '결과 파일', h('span.count', String(results.length))),
      h('div.col-head-actions', h('button.btn.small.ghost', { type: 'button', title: '결과 파일 목록을 다시 받습니다', onclick: refresh }, '새로 고침'), collapseButton(root, '1열 결과 파일'))),
    opened ? preview(opened) : resultList());
}

// ───────────────────────────── 1열 입력 자료 (FR-WB-107) ─────────────────────────────

// 3열 자료 탐색기의 고르기 칸 · 1열의 빼기 — 목록을 통째로 저장하고, 서버가 붙여 준 이름으로 다시 그린다
async function setInputs(items, on) {
  const target = { owner: bookId, id: analysis.id };
  const keys = new Set(items.map(inputKey));
  const next = on ? [...inputs, ...items.filter(i => !inputs.some(x => x.key === inputKey(i)))] : inputs.filter(i => !keys.has(i.key));
  try {
    const res = await api('PUT', `${analysisUrl(target.owner, target.id)}/inputs`, { inputs: next.map(({ kind, bookId: owner, chapterId, id, analysisId, path }) => ({ kind, bookId: owner, chapterId, id, analysisId, path })) });
    if (target.owner !== bookId || target.id !== analysis.id) return; // 그사이 다른 분석을 열었다
    inputs = res.inputs;
    book.analyses = res.analyses;
  } catch (err) {
    toast(err.message, 'error');
  }
  if (!openPath) renderResults();
  sourcesCol.refresh();
}

function inputSection() {
  const missing = inputs.filter(i => i.missing).length;
  return h('section.analysis-inputs',
    h('div.analysis-inputs-head',
      h('span', '입력 자료 ', h('span.count', String(inputs.length)), missing > 0 && h('span.input-missing', ` 없어짐 ${missing}`)),
      inputs.length > 0 && h('button.btn.small.ghost', { type: 'button', title: '입력 자료를 모두 뺍니다', onclick: () => { if (confirm(`입력 자료 ${inputs.length}개를 모두 뺄까요?`)) setInputs(inputs, false); } }, '모두 빼기')),
    inputs.length
      ? h('ul.input-list', inputs.map(i => h('li.input-row', { class: i.missing ? 'is-missing' : '' },
        h('button.input-open', { type: 'button', title: `${i.bookTitle} › ${i.parentTitle} › ${i.title}${i.missing ? '\n없어진 자료입니다 — 에이전트에게 넘기지 않습니다' : '\n누르면 3열에서 엽니다'}`, onclick: () => !i.missing && sourcesCol.openInput(i) },
          h('span.input-kind', inputKindLabel(i.kind)),
          h('span.input-path', `${i.bookId === bookId ? '' : `${i.bookTitle} › `}${i.parentTitle} › ${i.title}`),
          i.missing && h('span.input-missing', '없어짐')),
        h('button.icon-btn', { type: 'button', title: '입력 자료에서 빼기', 'aria-label': `${i.title} 빼기`, onclick: () => setInputs([i], false) }, '✕'))))
      : h('p.analysis-inputs-empty', '3열 자료 탐색기에서 고르면 여기에 들어오고, 에이전트가 먼저 읽습니다. 고르지 않으면 이 보고서의 기준 문서·원문을 읽습니다.'));
}

function folderLine() {
  return h('div.analysis-folder',
    h('span.analysis-folder-label', '결과 폴더'),
    h('code.analysis-folder-path', { title: '작업공간 안의 실제 위치 — 파일 탐색기에서 열 수 있습니다' }, folder),
    h('button.btn.small.ghost', { type: 'button', title: '경로를 클립보드에 복사합니다', onclick: () => navigator.clipboard.writeText(folder).then(() => toast('결과 폴더 경로를 복사했습니다.'), () => toast('복사하지 못했습니다.', 'error')) }, '경로 복사'));
}

function resultList() {
  if (!results.length) {
    return h('div.analysis-body', inputSection(), folderLine(), h('div.empty', h('div.empty-icon', { 'aria-hidden': 'true' }, '▤'), h('p', '아직 결과 파일이 없습니다.'), h('p.muted', '2열의 분석 에이전트에게 무엇을 분석해 어떤 파일로 남길지 알려 주세요.')));
  }
  return h('div.analysis-body', inputSection(), folderLine(),
    h('ul.result-list', results.map(r => h('li.result-row', { class: r.invalid ? 'is-invalid' : '' },
      h('button.result-open', { type: 'button', title: `${r.path}\n누르면 내용을 봅니다`, onclick: () => openResult(r.path) },
        h('span.result-path', r.path),
        h('span.result-meta', h('span.result-ext', r.ext.toUpperCase()), h('span', size(r.size)), h('span', formatDate(r.updatedAt)), r.invalid && h('span.result-invalid', 'JSON 형식 오류'))),
      h('div.result-actions',
        h('a.icon-btn', { href: resultUrl(r.path, true), download: r.path.split('/').pop(), title: '내려받기', 'aria-label': `${r.path} 내려받기` }, '⤓'),
        h('button.icon-btn', { type: 'button', title: '결과 파일 삭제', 'aria-label': `${r.path} 삭제`, onclick: () => removeResult(r) }, '✕'))))));
}

function openResult(rel) {
  if (!results.some(r => r.path === rel)) return toast(`결과 파일이 없습니다: ${rel}`, 'error');
  openPath = rel;
  renderResults();
}

// 내용 보기 — JSON 은 들여쓰기해서, 그 밖은 글 그대로. 서버는 앞 2MiB 만 보낸다 (FR-WB-088)
function preview(r) {
  const body = h('pre.result-preview', h('span.muted', '읽는 중…'));
  const note = h('p.muted.result-note');
  fetch(resultUrl(r.path)).then(async res => {
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `읽지 못했습니다 (${res.status})`);
    const text = await res.text();
    const total = Number(res.headers.get('X-Total-Size')) || text.length;
    const cut = new Blob([text]).size < total;
    let shown = text;
    if (r.ext === 'json' && !cut && !r.invalid) {
      try { shown = JSON.stringify(JSON.parse(text.replace(/^﻿/, '')), null, 2); } catch { /* 글 그대로 */ }
    }
    body.textContent = shown;
    note.textContent = cut ? `파일이 커서 앞부분만 보입니다 (${size(total)} 가운데 앞 ${size(new Blob([text]).size)}). 전체는 내려받아 보세요.` : '';
  }).catch(err => { body.textContent = err.message; });
  return h('div.analysis-body.result-view',
    h('nav.src-tabs',
      h('button.src-tab.back', { type: 'button', onclick: () => { openPath = null; renderResults(); } }, '← 목록'),
      h('span.book-reader-pos', r.path)),
    h('div.result-view-head',
      h('span.result-meta', h('span.result-ext', r.ext.toUpperCase()), h('span', size(r.size)), h('span', formatDate(r.updatedAt)), r.invalid && h('span.result-invalid', 'JSON 형식 오류 — 글 그대로 보입니다')),
      h('div.result-actions',
        h('a.btn.small.ghost', { href: resultUrl(r.path, true), download: r.path.split('/').pop() }, '내려받기'),
        h('button.btn.small.ghost.danger', { type: 'button', onclick: () => removeResult(r) }, '삭제'))),
    note,
    body);
}

async function removeResult(r) {
  if (!confirm(`결과 파일 “${r.path}” 을 삭제할까요? 되돌릴 수 없습니다. 에이전트가 다시 쓰지 않는 한 돌아오지 않습니다.`)) return;
  try {
    const res = await api('DELETE', resultUrl(r.path));
    results = res.results;
    book.analyses = res.analyses;
    if (openPath === r.path) openPath = null;
    renderResults();
    explore();
  } catch (err) {
    toast(err.message, 'error');
  }
}
