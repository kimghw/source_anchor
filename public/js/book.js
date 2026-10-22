// 보고서(메인문서) 화면 — 1열 목차·지시문(장 제목·여섯 절 지시문 편집), 2열 에이전트, 3열 작성 기준·원문(기준 문서 관리 + 장별 원문 읽기 전용).
// 장 목록·순서·수준·열기·추가·삭제는 0열 장 탐색기(explorer.js)가 맡는다 (FR-WB-061, 072, 079).
// 장의 작성 화면과 같은 상단 머리줄을 쓰고, 두 화면은 여기서 갈아 끼운다 (FR-WB-071, 074).
import { effectiveText, guideKind, hasChildren, REPORT_SECTIONS } from '../shared/instructions.js';
import { SOURCE_TYPES } from '../shared/model.js';
import { outlineNumbers } from '../shared/toc.js';
import { initBookChat, sendBookMessage, setBookView } from './book_chat.js';
import { acceptGuideDrops, guideReader, guidesGroup } from './book_guides.js';
import { collapseButton } from './columns.js';
import { addChapter, showExplorer } from './explorer.js';
import { readerDoc } from './reader_doc.js';
import { readerPane } from './source_view.js';
import { api, state } from './state.js';
import { instructionsEditor } from './toc_editor.js';
import { fill, flash, formatDate, h, moveWindow, placeWindow, toast } from './util.js';

const $ = id => document.getElementById(id);

let view = { book: { id: null, title: '', instructions: '' }, chapters: [], sources: [], guides: [], analyses: [], books: [] };
let openSource = null; // 3열에서 열람 중인 원문 (장 ID + 원문 번호로 가린다 — 장이 다르면 같은 번호가 있다)
let openGuide = null; // 3열에서 열람 중인 기준 문서 ID (FR-WB-085)
let agentBusy = false; // 2열 에이전트가 답하는 중 — 추출 요청 버튼을 잠근다 (FR-WB-086)
let pendingSave = Promise.resolve(); // 진행 중인 지시문 저장 — 추출 요청은 이것이 끝난 뒤 보낸다
const foldedInstructions = new Set(['report']); // 공통 설정은 필요할 때 펼친다. 이후에는 사용자의 접힘 상태를 유지한다.
let columnReaderHandle = null; // 3열 열람 화면의 부품 — 에이전트 답의 원문 위치 링크가 본문 보기로 돌려 그 자리를 보여 준다
const popups = new Map(); // 떠 있는 원문 창 — 원문마다 하나 (FR-WB-078)

// openChapter · reveal 은 app.js 가 값으로 넘긴다(documents.js 가 book.js 를 import 하므로 여기서 import 하면 순환) — 2열 에이전트 답의 문장 링크가 쓴다 (FR-WB-076)
export function initBook({ openChapter, reveal }) {
  window.addEventListener('resize', () => { for (const win of popups.values()) placeWindow(win, win.offsetLeft, win.offsetTop); });
  acceptGuideDrops($('book-sources'), { bookId: () => view.book?.id, changed: refreshBook }); // 3열에 파일을 놓으면 기준 문서 등록 (FR-WB-085)
  initBookChat($('book-chat'), {
    bookChanged: applyBookState,
    reload: () => openBook(view.book.id),
    showChapter: id => {
      const row = $('book-chapters').querySelector(`.toc-row[data-id="${CSS.escape(id)}"]`);
      row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      flash(row);
    },
    running: value => {
      agentBusy = value;
      const button = $('book-chapters').querySelector('.btn-extract');
      if (button) button.disabled = !canExtract();
    },
    showSource: (chapterId, sourceId, anchorId) => {
      openSource = `${chapterId}/${sourceId}`;
      openGuide = null;
      renderSources();
      if (anchorId) revealAnchor(anchorId);
    },
    openChapter: async (chapterId, sentenceId) => {
      await openChapter(chapterId); // documents.js 가 저장·열기·실패 안내를 맡는다
      if (sentenceId && state.doc.id === chapterId) reveal(sentenceId);
    },
  });
}

// 3열 열람 화면을 본문 보기로 돌려 그 원문 위치를 보여 준다
function revealAnchor(anchorId) {
  columnReaderHandle?.setMode('body');
  const node = $('book-sources').querySelector(`[data-aid="${CSS.escape(anchorId)}"]`);
  if (!node) return toast('이 원문에 없는 위치입니다.', 'error');
  node.scrollIntoView({ block: 'center' });
  flash(node, 'is-anchor-flash');
}

// ───────────────────────────── 화면 전환 ─────────────────────────────

// 두 화면은 상단 머리줄을 함께 쓴다 — 장에만 있는 것(검증 요약·실행 취소·내보내기·저장 표시)은 접는다.
// 연결 입구는 어느 화면에서도 그대로 보인다 (FR-WB-053).
export function showBookScreen(on) {
  $('workspace').hidden = on;
  $('book-workspace').hidden = !on;
  $('doc-controls').hidden = on;
  $('book-controls').hidden = !on;
  $('analysis-workspace').hidden = true; // 데이터 분석 화면(analysis.js)은 두 화면 어느 쪽으로 가든 닫힌다 — 답하던 분석 에이전트는 이어 간다 (FR-WB-088, 106)
  $('analysis-controls').hidden = true;
  $('form-workspace').hidden = true; // 양식 화면(forms.js)도 같다 (FR-WB-090)
  $('form-controls').hidden = true;
  document.body.classList.remove('on-analysis', 'on-form');
  for (const id of ['summary', 'save-state', 'btn-undo', 'btn-redo', 'btn-export']) $(id).hidden = on;
  document.body.classList.toggle('on-book', on);
  if (!on) closePopups(); // 떠 있는 원문 창은 보고서 화면의 것이다 — 장의 작성 화면에는 다른 장의 원문이 보이지 않는다 (DR-WB-002)
}

export async function openBook(bookId) {
  const data = await api('GET', bookId ? `/api/book?report=${encodeURIComponent(bookId)}` : '/api/book');
  view = data;
  resetView();
  history.replaceState(null, '', `?report=${encodeURIComponent(data.book.id)}`);
  showBookScreen(true);
  render();
}

// 0열 탐색기가 목차(순서·수준)를 고치거나 장을 지운 뒤 돌려준 보고서 상태를 반영한다 — 열람 중인 원문·떠 있는 창은 그대로 둔다
export function applyBookState(data) {
  view = data;
  render();
}

// 다른 보고서를 열거나 만들거나 지웠을 때 — 열람 중인 원문·떠 있는 창은 앞 보고서의 것이다
function resetView() {
  openSource = null;
  openGuide = null;
  closePopups();
}

const sourceKey = s => `${s.chapterId}/${s.id}`;

// ───────────────────────────── 그리기 ─────────────────────────────

function render() {
  renderHead();
  renderChapters();
  setBookView({ book: view.book, chapters: view.chapters }); // 2열 보고서 에이전트(book_chat.js) — 목차가 바뀌면 안내·수정안 카드를 맞춘다 (FR-WB-076)
  renderSources();
  showExplorer({ book: view.book, chapters: view.chapters, current: null, analyses: view.analyses, forms: view.forms }); // 0열: 보고서가 열려 있다
}

function renderHead() {
  const title = h('input.book-title', {
    value: view.book.title, 'aria-label': '보고서 제목', placeholder: '보고서 제목',
    onchange: () => save({ title: title.value }),
  });
  fill($('book-controls'),
    h('span.book-kind', '보고서'),
    title,
    h('button.btn.small.ghost', { type: 'button', title: '보고서 목록', onclick: openBookMenu }, `보고서 ${view.books.length} ▾`),
    h('button.btn.small', { type: 'button', onclick: newBook }, '＋ 새 보고서'));
}

function openBookMenu() {
  const dialog = h('dialog.dialog.book-menu',
    h('h2', '보고서'),
    h('div.book-rows', view.books.map(b => h('div.book-row', { class: b.id === view.book.id ? 'is-current' : '' },
      h('button.book-open', { type: 'button', onclick: async () => { dialog.close(); await openBook(b.id).catch(err => toast(err.message, 'error')); } },
        h('span.book-row-title', b.title),
        h('span.book-row-meta', `${b.id} · 장 ${b.chapters} · ${formatDate(b.updatedAt)}${b.id === view.book.id ? ' · 현재 보고서' : ''}`)),
      h('button.icon-btn', { type: 'button', title: '보고서 삭제', onclick: () => { dialog.close(); removeBook(b); } }, '✕')))),
    h('div.row-actions.end', h('button.btn.ghost', { type: 'button', onclick: () => dialog.close() }, '닫기')));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

// 1열 — 목차·지시문. 장마다 목차 번호·제목과 여섯 절 지시문(toc_editor.js)을 고친다 (FR-WB-072, 073). 순서·수준·열기·추가·삭제는 0열 탐색기가 맡는다.
// 머리줄의 요청 버튼은 2열 에이전트에게 작성요령 문서(참고문헌 제외)에서 규정 및 규칙·작성요령·작성 요구사항을 뽑아 지시문 수정안으로 내 달라고 보낸다 (FR-WB-086)
const EXTRACT_REQUEST = '기준 문서 가운데 작성요령 종류(<guides> 의 작성요령 — 참고문헌은 제외)에서 장마다 그 장에 해당하는 규정 및 규칙·작성요령·작성 요구사항을 뽑아, 장별 지시문의 그 세 절을 채운 지시문 변경 수정안을 장마다 한 건씩 내 주세요. 문체 및 예시·헤딩 순서·제약조건 절과 제가 직접 적은 글은 그대로 두고, 뽑은 항목마다 기준 문서 ID 와 위치를 붙여 주세요.';
const hasGuideline = () => view.guides.some(g => guideKind(g.kind) === 'guideline'); // 참고문헌만 있으면 뽑을 규칙이 없다
const canExtract = () => hasGuideline() && view.chapters.length > 0 && !agentBusy;

async function requestExtract() {
  await pendingSave; // 고치던 지시문의 저장이 끝난 뒤에 보낸다
  if (!canExtract()) return toast(hasGuideline() ? '에이전트의 답변이 끝나면 다시 요청하세요.' : '작성 기준·원문에서 작성요령 문서를 먼저 등록하세요.', 'error');
  sendBookMessage(EXTRACT_REQUEST);
}

function renderChapters() {
  const numbers = outlineNumbers(view.chapters);
  const layers = { instructions: view.book.instructions, chapters: view.chapters };
  const rows = view.chapters.map((ch, i) => {
    const title = h('input.toc-title', { value: ch.title, 'aria-label': '장 제목', onchange: () => saveToc(list => { list[i].title = title.value; }) });
    const inherited = effectiveText(layers, ch.id, { own: false }); // 보고서 공통·하위 장에도 적용하는 상위 장에서 물려받는 지시문 — 읽기 전용 (FR-WB-087)
    const details = h('details.toc-instructions', { open: !foldedInstructions.has(ch.id), ontoggle: () => { if (details.open) foldedInstructions.delete(ch.id); else foldedInstructions.add(ch.id); } },
      h('summary', '지시문', h('span.toc-instr-meta', ch.instructions ? `${ch.instructions.length.toLocaleString()}자` : '비어 있음')),
      inherited && h('details.toc-inherited',
        h('summary', `물려받는 지시문 ${inherited.length.toLocaleString()}자`, h('span.toc-instr-meta', '— 보고서 공통·상위 장에서, 읽기 전용')),
        h('pre.toc-inherited-text', inherited)),
      instructionsEditor(ch, { save: text => saveInstructions(ch.id, text) }),
      hasChildren(view.chapters, i) && h('label.toc-cascade',
        h('input', { type: 'checkbox', checked: ch.cascade !== false, onchange: event => saveToc(list => { list[i].cascade = event.target.checked; }) }),
        '이 장의 문체 및 예시·제약조건·규정 및 규칙·작성요령·작성 요구사항을 하위 장에도 적용 (헤딩 순서 제외)'));
    return h('div.toc-row', { class: `lvl-${ch.level || 1}`, dataset: { id: ch.id } },
      h('div.toc-head', h('span.toc-no', numbers[i]), title, h('span.id', ch.id)),
      details);
  });
  // 보고서 공통 지시문 — 다섯 절(헤딩 순서 제외), 모든 장에 적용 (FR-WB-087)
  const report = h('details.toc-instructions.toc-report', { open: !foldedInstructions.has('report'), ontoggle: () => { if (report.open) foldedInstructions.delete('report'); else foldedInstructions.add('report'); } },
    h('summary', '보고서 공통 지시문', h('span.toc-instr-meta', view.book.instructions ? `${view.book.instructions.length.toLocaleString()}자` : '비어 있음'), h('span.toc-instr-meta', '— 모든 장에 적용, 헤딩 순서는 장마다')),
    instructionsEditor({ id: 'report', title: '보고서 공통', instructions: view.book.instructions }, { save: saveReportInstructions, sections: REPORT_SECTIONS, report: true }));

  fill($('book-chapters'),
    h('header.col-head',
      h('div.col-title', h('span.col-index', '1'), '목차·지시문', h('span.count', String(view.chapters.length))),
      h('div.col-head-actions',
        h('button.btn.small.btn-extract', { type: 'button', disabled: !canExtract(), onclick: requestExtract,
          title: '등록한 작성요령 문서(참고문헌 제외)에서 규정 및 규칙·작성요령·작성 요구사항을 추출해 장별 지시문 수정안을 요청합니다. 장과 작성요령 문서를 추가한 뒤 사용할 수 있으며, 에이전트가 답변하는 동안에는 기다려 주세요.' }, '작성요령으로 지시문 제안'),
        collapseButton($('book-chapters'), '1열 목차·지시문'))),
    h('div.chapter-list',
      h('div.workspace-intro',
        h('span.workspace-eyebrow', 'REPORT WORKSPACE'),
        h('h1.workspace-title', view.book.title),
        h('p.workspace-description', '목차를 설계하고, 작성 방향을 정하세요.'),
        h('div.workspace-meta',
          h('span', `장 ${view.chapters.length}개`),
          h('span', `원문 ${view.sources.length}개`),
          h('span', `기준 문서 ${view.guides.length}개`))),
      h('div.toc-row.toc-row-report', report),
      rows.length ? rows : h('div.empty',
        h('div.empty-icon', { 'aria-hidden': 'true' }, '≡'),
        h('h3.empty-title', '첫 장을 만들어보세요'),
        h('p.muted', '직접 장을 추가하거나, 에이전트에게 목차를 제안받으세요.'),
        h('button.btn.empty-action', { type: 'button', onclick: addChapter }, '＋ 첫 장 만들기')),
      rows.length > 0 && h('p.muted.toc-note', '장 탐색기에서 순서와 수준을 조정하고, 장을 열어 본문을 작성하세요. 기준 문서를 등록하면 위의 제안 버튼으로 장별 지시문을 요청할 수 있습니다.')));
}

// 3열 — 작성 기준·원문. 기준 문서 묶음(등록·열람·수정·삭제 — book_guides.js) 아래에 장별로 묶은 원문 목록(읽기 전용).
// 기준 문서나 원문을 누르면 열 안이 열람 화면으로 바뀐다 (FR-WB-075, 085)
function renderSources() {
  const source = view.sources.find(s => sourceKey(s) === openSource);
  if (!source) openSource = columnReaderHandle = null;
  const guide = view.guides.find(g => g.id === openGuide);
  if (!guide) openGuide = null;
  fill($('book-sources'),
    h('header.col-head', h('div.col-title', h('span.col-index', '3'), '작성 기준·원문', h('span.count', `${view.guides.length} · ${view.sources.length}`)), h('div.col-head-actions', collapseButton($('book-sources'), '3열 작성 기준·원문'))),
    guide ? guideReader(view.book.id, guide, { back: () => { openGuide = null; renderSources(); } })
      : source ? columnReader(source) : sourceList());
}

// 기준 문서를 등록·고치기·삭제한 뒤 — 보고서 상태를 다시 받아 그린다(열람 중인 원문·떠 있는 창은 그대로)
const refreshBook = async () => applyBookState(await api('GET', `/api/book?report=${encodeURIComponent(view.book.id)}`));

function sourceList() {
  const byChapter = new Map(view.chapters.map(ch => [ch.id, []]));
  for (const source of view.sources) byChapter.get(source.chapterId)?.push(source);
  const groups = view.chapters.filter(ch => byChapter.get(ch.id).length).map(ch => h('section.book-source-group',
    h('h3.book-source-chapter', ch.title, h('span.count', String(byChapter.get(ch.id).length))),
    byChapter.get(ch.id).map(sourceRow)));
  return h('div.book-source-list',
    guidesGroup(view.book.id, view.guides, { open: g => { openGuide = g.id; openSource = null; renderSources(); }, changed: refreshBook }),
    h('h3.book-source-chapter.book-source-part', '장별 원문', h('span.count', String(view.sources.length))),
    groups.length ? groups : h('div.empty', h('div.empty-icon', { 'aria-hidden': 'true' }, '▤'), h('h3.empty-title', '보고서의 자료를 한곳에'), h('p.muted', '장을 열고 원문을 수집하면 이곳에서 함께 살펴볼 수 있습니다.')),
    view.sources.length > 0 && h('p.muted.book-source-note', '보고서의 모든 원문을 함께 살펴보세요. 원문 추가·채택 거부·근거 연결은 각 장의 작성 화면에서 할 수 있습니다.'));
}

// 목록의 한 건 — 제목 줄을 누르면 3열에서, 창 버튼을 누르면 떠 있는 창으로 연다
function sourceRow(source) {
  return h('div.book-source',
    h('button.book-source-head', { type: 'button', title: `${source.chapterId} · ${source.id} · ${source.title}\n원문 열기`, onclick: () => { openSource = sourceKey(source); openGuide = null; renderSources(); } },
      h('span.type-badge', { class: `type-${source.type}` }, SOURCE_TYPES[source.type] ?? source.type),
      h('span.book-source-title', source.title),
      h('span.book-source-publisher', source.publisher || '발행처 미상'),
      h('span.book-source-id', `${source.chapterId} · ${source.id}`)),
    h('button.icon-btn.book-source-pop', { type: 'button', title: '떠 있는 창으로 보기', 'aria-label': `${source.chapterId} · ${source.id} 떠 있는 창으로 보기`, onclick: () => openPopup(source) }, '⧉'));
}

// 목록 순서(장 순서 → 원문 번호)의 원문 — 열람 화면의 앞·다음 이동에 쓴다
const orderedSources = () => view.chapters.flatMap(ch => view.sources.filter(s => s.chapterId === ch.id));

// ───────────────────────────── 원문 열람 ─────────────────────────────

// 3열의 열람 화면 — 목록으로 돌아가기, 앞·다음 원문, 떠 있는 창으로 띄우기
function columnReader(source) {
  const list = orderedSources();
  const i = list.indexOf(source);
  const go = s => { openSource = sourceKey(s); openGuide = null; renderSources(); };
  columnReaderHandle = bookReader(source);
  return h('div.book-reader',
    h('nav.src-tabs',
      h('button.src-tab.back', { type: 'button', onclick: () => { openSource = null; renderSources(); } }, '← 목록'),
      h('button.src-tab', { type: 'button', disabled: i <= 0, title: '앞 원문', 'aria-label': '앞 원문', onclick: () => go(list[i - 1]) }, '‹'),
      h('button.src-tab', { type: 'button', disabled: i >= list.length - 1, title: '다음 원문', 'aria-label': '다음 원문', onclick: () => go(list[i + 1]) }, '›'),
      h('span.book-reader-pos', `${i + 1} / ${list.length}`),
      h('button.src-tab.book-reader-pop', { type: 'button', title: '이 원문을 떠 있는 창으로도 띄웁니다', onclick: () => openPopup(source) }, '⧉ 창으로')),
    columnReaderHandle.pane);
}

// 열람 부품(source_view.js — 서지정보·보기 방식·참조 띠·원본 iframe)에 읽기 전용 본문을 끼운다. 참조·메모 표시는 부품이 서버에서 받아 입힌다 (FR-WB-080)
const bookReader = source => readerPane(source, { docId: source.chapterId, key: 'book', body: () => readerDoc(source) });

// ───────────────────────────── 떠 있는 창 ─────────────────────────────
// 원문 하나를 보고서 화면 위에 떠 있는 창으로 띄운다 — 원문마다 창 하나, 머리줄을 끌어 옮기고 모서리로 크기를 바꾼다 (FR-WB-078)
let popupZ = 40;

function openPopup(source) {
  const key = sourceKey(source);
  if (popups.has(key)) return raisePopup(popups.get(key), true);
  const win = h('section.src-popup', { role: 'dialog', 'aria-label': `원문 ${source.chapterId} · ${source.id}`, tabIndex: -1,
    onpointerdown: () => raisePopup(win),
    onkeydown: event => { if (event.key === 'Escape' && !event.isComposing) closePopup(key); } },
    h('header.col-head', { onpointerdown: event => moveWindow(win, event) },
      h('div.col-title',
        h('span.type-badge', { class: `type-${source.type}` }, SOURCE_TYPES[source.type] ?? source.type),
        h('span.src-popup-title', { title: source.title }, source.title),
        h('span.count', `${source.chapterId} · ${source.id}`)),
      h('div.col-head-actions',
        h('button.icon-btn', { type: 'button', title: '원문 패널에서 보기', 'aria-label': '원문 패널에서 보기', onclick: () => { openSource = key; openGuide = null; renderSources(); } }, '⇥'),
        h('button.icon-btn', { type: 'button', title: '닫기 (Esc)', 'aria-label': '원문 창 닫기', onclick: () => closePopup(key) }, '✕'))),
    bookReader(source).pane);
  popups.set(key, win);
  document.body.append(win);
  const n = (popups.size - 1) % 6; // 창마다 조금씩 비껴 놓는다
  placeWindow(win, window.innerWidth - win.offsetWidth - 24 - n * 28, 64 + n * 28);
  raisePopup(win);
  win.focus();
}

function raisePopup(win, blink = false) {
  win.style.zIndex = String(++popupZ);
  if (blink) { flash(win, 'is-flash'); win.focus(); }
}

function closePopup(key) {
  popups.get(key)?.remove();
  popups.delete(key);
}

function closePopups() {
  for (const key of [...popups.keys()]) closePopup(key);
}

// ───────────────────────────── 고치기 ─────────────────────────────

async function save(patch) {
  try {
    view = await api('PUT', '/api/book', { bookId: view.book.id, ...patch });
    render();
  } catch (err) {
    toast(err.message, 'error');
    render(); // 서버가 거절했으면 화면을 저장된 값으로 되돌린다
  }
}

// 지시문 하나를 저장한다 — 실패하면 화면을 되돌리지 않고(적은 글을 남기고) 던진다. 편집기(toc_editor.js)가 알린다 (FR-WB-073)
function saveInstructions(id, text) {
  const list = view.chapters.map(ch => ({ id: ch.id, title: ch.title, instructions: ch.id === id ? text : ch.instructions, level: ch.level, cascade: ch.cascade }));
  const run = api('PUT', '/api/book', { bookId: view.book.id, chapters: list }).then(data => { view = data; render(); });
  pendingSave = run.catch(() => {});
  return run;
}

// 보고서 공통 지시문을 저장한다 — 실패하면 화면을 되돌리지 않고 던진다 (FR-WB-087)
function saveReportInstructions(text) {
  const run = api('PUT', '/api/book', { bookId: view.book.id, instructions: text }).then(data => { view = data; render(); });
  pendingSave = run.catch(() => {});
  return run;
}

// 목차를 통째로 보내 제목·하위 장 적용 여부를 저장한다 — 순서·수준·지시문은 그대로 함께 보낸다 (FR-WB-072, 079, 087)
function saveToc(mutate) {
  const list = view.chapters.map(ch => ({ id: ch.id, title: ch.title, instructions: ch.instructions, level: ch.level, cascade: ch.cascade }));
  mutate(list);
  return save({ chapters: list });
}

async function newBook() {
  try {
    view = await api('POST', '/api/books', { title: '' });
    resetView();
    history.replaceState(null, '', `?report=${encodeURIComponent(view.book.id)}`);
    render();
    $('book-controls').querySelector('.book-title')?.select();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeBook(b) {
  const chapters = b.chapters ?? 0;
  if (!confirm(`“${b.title}” 보고서를 삭제할까요? 여기에 속한 장 ${chapters}개와 그 장들에 수집한 원문, 기준 문서가 모두 함께 지워지며 되돌릴 수 없습니다.`)) return;
  try {
    view = await api('DELETE', `/api/books/${encodeURIComponent(b.id)}`);
    resetView();
    history.replaceState(null, '', `?report=${encodeURIComponent(view.book.id)}`);
    render();
  } catch (err) {
    toast(err.message, 'error');
  }
}
