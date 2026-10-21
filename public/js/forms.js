// 양식 화면 — 작성자가 올린 docx·hwpx 양식의 칸·필드에 값을 채운다 (FR-WB-090 ~ 092).
// 1열 양식(머리줄 + 본문) · 2열 양식 에이전트 · 3열 보고서의 작성 기준·원문(보고서 화면 3열과 같은 구성, 읽기 전용).
// 0열 탐색기 「장」 탭의 양식 묶음에서 열린다. 보고서·장·사용자 지정 문서 화면 모듈(book.js·documents.js·custom_docs.js)을 import 하지 않는다 — 화면 전환 진입점은 app.js 가 넘긴다.
import { SOURCE_TYPES } from '../shared/model.js';
import { guideReader, guidesGroup } from './book_guides.js';
import { collapseButton } from './columns.js';
import { showExplorer } from './explorer.js';
import { readerDoc } from './reader_doc.js';
import { readerPane } from './source_view.js';
import { api, flushSave } from './state.js';
import { fill, h, toast } from './util.js';

const $ = id => document.getElementById(id);
const go = { openBook: async () => {}, openChapter: async () => {} }; // openChapter — 에이전트 답의 원문 위치 링크가 쓴다
const FILE_LIMIT = 5 * 1024 * 1024; // 서버(lib/forms.js FILE_LIMIT)와 같다 — 올리기 전에 먼저 거른다
let bookId = null;
let form = null; // 열어 둔 양식 { id, title, fileName, format, nodes, tables, values, instructions, … }
let book = null; // 보고서 상태 { book, chapters, sources, guides, custom, forms } — 3열·탐색기
let openSource = null; // 3열에서 열람 중인 원문 (장 ID/원문 번호)
let openGuide = null; // 3열에서 열람 중인 기준 문서 ID

const formsUrl = (owner, id = '') => `/api/books/${encodeURIComponent(owner)}/forms${id ? `/${encodeURIComponent(id)}` : ''}`;
const bookUrl = owner => (owner ? `/api/book?report=${encodeURIComponent(owner)}` : '/api/book');
const sourceKey = s => `${s.chapterId}/${s.id}`;

export function initForms(handlers) {
  Object.assign(go, handlers);
  fill($('form-controls'),
    h('button.btn.small.ghost.to-book', { type: 'button', title: '보고서 화면으로', onclick: leave }, '↩ 보고서'),
    h('span.doc-kind', '양식'),
    h('span.doc-current.form-current'));
  acceptFormDrops($('form-workspace'));
}

// ───────────────────────────── 열기 · 올리기 · 떠나기 ─────────────────────────────

// 탐색기·주소(?form=)에서 연다. 쓰던 장을 먼저 저장하고, 저장하지 못하면 옮기지 않는다 (FR-WB-062, ERR-WB-006)
export async function openForm(wantedBookId, id) {
  try {
    await flushSave();
  } catch (err) {
    return toast(`저장하지 못해 이동하지 않았습니다: ${err.message}`, 'error');
  }
  try {
    const state = await api('GET', bookUrl(wantedBookId));
    const { form: loaded } = await api('GET', formsUrl(state.book.id, id));
    bookId = state.book.id;
    book = state;
    form = loaded;
    openSource = openGuide = null;
    history.replaceState(null, '', `?report=${encodeURIComponent(bookId)}&form=${encodeURIComponent(form.id)}`);
    showFormScreen(true);
    render();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// docx·hwpx 파일 하나를 보고서의 새 양식으로 올리고 곧바로 연다 — 형식·크기는 먼저 거르고, 구조를 읽지 못하면 서버가 사유를 돌려준다 (FR-WB-090, ERR-WB-011)
export async function uploadForm(wantedBookId, file) {
  if (!/\.(docx|hwpx)$/i.test(file.name)) return toast(`양식은 docx·hwpx 파일만 올릴 수 있습니다: ${file.name}`, 'error');
  if (file.size > FILE_LIMIT) return toast(`파일이 5MiB 를 넘습니다 (${(file.size / 1024 / 1024).toFixed(1)}MiB)`, 'error');
  try {
    const { form: created } = await api('POST', formsUrl(wantedBookId), { fileName: file.name, data: await readBase64(file) });
    await openForm(wantedBookId, created.id);
  } catch (err) {
    toast(err.message, 'error');
  }
}

const readBase64 = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
  reader.onerror = () => reject(new Error('파일을 읽지 못했습니다'));
  reader.readAsDataURL(file);
});

// 양식 화면 어디에나 파일을 끌어다 놓으면 새 양식으로 올린다. 화면 밖에 놓은 파일로 브라우저가 이동하지 않게 하는 창 전체 막기는 book_guides.js acceptGuideDrops 가 이미 건다
function acceptFormDrops(node) {
  const files = event => event.dataTransfer?.types?.includes('Files');
  let depth = 0;
  const leaveDrop = () => { depth = 0; node.classList.remove('is-drop-target'); };
  node.addEventListener('dragenter', event => { if (files(event)) { depth++; node.classList.add('is-drop-target'); } });
  node.addEventListener('dragover', event => { if (files(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
  node.addEventListener('dragleave', event => { if (files(event) && --depth <= 0) leaveDrop(); });
  node.addEventListener('drop', event => {
    if (!files(event)) return;
    event.preventDefault();
    leaveDrop();
    const [file] = event.dataTransfer.files;
    if (file && bookId) uploadForm(bookId, file);
  });
}

async function leave() {
  await go.openBook(bookId).catch(err => toast(err.message, 'error'));
}

// 네 화면은 상단 머리줄을 함께 쓴다 — 장에만 있는 것은 접는다. 다른 화면을 열면 book.js showBookScreen · custom_docs.js showCustomScreen 이 이 화면을 숨긴다
function showFormScreen(on) {
  $('workspace').hidden = true;
  $('book-workspace').hidden = true;
  $('custom-workspace').hidden = true;
  $('form-workspace').hidden = !on;
  $('doc-controls').hidden = true;
  $('book-controls').hidden = true;
  $('custom-controls').hidden = true;
  $('form-controls').hidden = !on;
  for (const id of ['summary', 'save-state', 'btn-undo', 'btn-redo', 'btn-export']) $(id).hidden = true;
  document.body.classList.remove('on-book', 'on-custom');
  document.body.classList.toggle('on-form', on);
}

// ───────────────────────────── 그리기 ─────────────────────────────

const explore = () => showExplorer({ book: book.book, chapters: book.chapters, current: null, custom: book.custom, forms: book.forms, currentForm: form.id });

function render() {
  fill($('form-controls').querySelector('.form-current'), form.title || form.fileName, h('span.doc-current-id', form.id));
  renderEditor();
  renderSources();
  explore();
}

// 1열 — 머리줄(번호·형식·채우는 단위 수)과 양식 본문
function renderEditor() {
  const units = book.forms.find(f => f.id === form.id)?.units ?? 0;
  fill($('form-editor'),
    h('header.col-head', h('div.col-title', h('span.col-index', '1'), '양식', h('span.count', `${form.id} · ${form.format} · 단위 ${units}`)), h('div.col-head-actions', collapseButton($('form-editor'), '1열 양식'))),
    h('div.form-body'));
}

// 기준 문서를 등록·고치기·삭제한 뒤 — 보고서 상태를 다시 받아 3열과 탐색기를 그린다
async function reload() {
  book = await api('GET', bookUrl(bookId));
  renderSources();
  explore();
}

// 3열 — 작성 기준·원문. 기준 문서 묶음 아래에 장별로 묶은 원문 목록(읽기 전용). 누르면 열 안이 열람 화면으로 바뀐다 (FR-WB-090)
function renderSources() {
  const source = book.sources.find(s => sourceKey(s) === openSource);
  if (!source) openSource = null;
  const guide = book.guides.find(g => g.id === openGuide);
  if (!guide) openGuide = null;
  fill($('form-sources'),
    h('header.col-head', h('div.col-title', h('span.col-index', '3'), '작성 기준·원문', h('span.count', `${book.guides.length} · ${book.sources.length}`)), h('div.col-head-actions', collapseButton($('form-sources'), '3열 작성 기준·원문'))),
    guide ? guideReader(bookId, guide, { back: () => { openGuide = null; renderSources(); } })
      : source ? reader(source) : sourceList());
}

function sourceList() {
  const byChapter = new Map(book.chapters.map(ch => [ch.id, []]));
  for (const s of book.sources) byChapter.get(s.chapterId)?.push(s);
  const groups = book.chapters.filter(ch => byChapter.get(ch.id).length).map(ch => h('section.book-source-group',
    h('h3.book-source-chapter', ch.title, h('span.count', String(byChapter.get(ch.id).length))),
    byChapter.get(ch.id).map(s => h('div.book-source',
      h('button.book-source-head', { type: 'button', title: `${s.chapterId} · ${s.id} · ${s.title}\n원문 열기`, onclick: () => { openSource = sourceKey(s); openGuide = null; renderSources(); } },
        h('span.type-badge', { class: `type-${s.type}` }, SOURCE_TYPES[s.type] ?? s.type),
        h('span.book-source-title', s.title),
        h('span.book-source-publisher', s.publisher || '발행처 미상'),
        h('span.book-source-id', `${s.chapterId} · ${s.id}`))))));
  return h('div.book-source-list',
    guidesGroup(bookId, book.guides, { open: g => { openGuide = g.id; openSource = null; renderSources(); }, changed: reload }),
    h('h3.book-source-chapter.book-source-part', '장별 원문', h('span.count', String(book.sources.length))),
    groups.length ? groups : h('div.empty', h('div.empty-icon', { 'aria-hidden': 'true' }, '▤'), h('p', '아직 수집한 원문이 없습니다.'), h('p.muted', '원문은 장의 작성 화면에서 수집합니다.')));
}

function reader(source) {
  const pane = readerPane(source, { docId: source.chapterId, key: 'form', body: () => readerDoc(source) }).pane;
  return h('div.book-reader',
    h('nav.src-tabs',
      h('button.src-tab.back', { type: 'button', onclick: () => { openSource = null; renderSources(); } }, '← 목록'),
      h('span.book-reader-pos', `${source.chapterId} · ${source.id}`)),
    pane);
}
