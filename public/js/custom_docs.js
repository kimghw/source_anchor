// 사용자 지정 문서 화면 — 원문들에서 문장·표를 골라 넣어 새 문서를 쓰고, 장의 원문으로 등록한다 (FR-WB-088, 089).
// 1열 문서(제목·Markdown 본문, 자동 저장) · 2열 출처(뽑아 넣은 원문 위치)와 원문 등록 · 3열 보고서 전체 원문(누르면 문장·표 셀이 1열 커서 자리에 들어간다).
// 0열 탐색기의 "사용자 지정 문서" 탭에서 열린다. 보고서·장 화면 모듈(book.js·documents.js)을 import 하지 않는다 — 화면 전환 진입점은 app.js 가 넘긴다.
import { blockLoc, SOURCE_TYPES } from '../shared/model.js';
import { collapseButton } from './columns.js';
import { showExplorer } from './explorer.js';
import { readerDoc } from './reader_doc.js';
import { readerPane } from './source_view.js';
import { api, flushSave } from './state.js';
import { debounce, fill, flash, formatDate, h, toast } from './util.js';

const $ = id => document.getElementById(id);
const go = { openBook: async () => {} };
let bookId = null;
let doc = null; // 열어 둔 문서 { id, title, markdown, picks, registrations, updatedAt }
let book = null; // 보고서 상태 { book, chapters, sources, custom } — 3열 원문·등록할 장·탐색기
let openSource = null; // 3열에서 열람 중인 원문 (장 ID/원문 번호)
let readerHandle = null;
let textarea = null;
let saveState = null;

const customUrl = (id = '') => `/api/books/${encodeURIComponent(bookId)}/custom${id ? `/${encodeURIComponent(id)}` : ''}`;
const sourceKey = s => `${s.chapterId}/${s.id}`;
const chapterTitle = id => book?.chapters.find(ch => ch.id === id)?.title || id;

export function initCustomDocs(handlers) {
  Object.assign(go, handlers);
  saveState = h('span.custom-save-state', '저장됨');
  fill($('custom-controls'),
    h('button.btn.small.ghost.to-book', { type: 'button', title: '보고서 화면으로', onclick: leave }, '↩ 보고서'),
    h('span.doc-kind', '사용자 지정 문서'),
    h('span.doc-current.custom-current'));
  window.addEventListener('beforeunload', () => { if (doc) save.flush(); });
}

// ───────────────────────────── 열기 · 떠나기 ─────────────────────────────

// 탐색기·주소(?custom=)에서 연다. 쓰던 장을 먼저 저장하고, 저장하지 못하면 옮기지 않는다 (FR-WB-062, ERR-WB-006)
export async function openCustomDoc(wantedBookId, id) {
  try {
    await flushSave();
  } catch (err) {
    return toast(`저장하지 못해 이동하지 않았습니다: ${err.message}`, 'error');
  }
  try {
    const state = await api('GET', wantedBookId ? `/api/book?report=${encodeURIComponent(wantedBookId)}` : '/api/book');
    bookId = state.book.id;
    const { doc: loaded } = await api('GET', customUrl(id));
    book = state;
    doc = loaded;
    openSource = null;
    history.replaceState(null, '', `?report=${encodeURIComponent(bookId)}&custom=${encodeURIComponent(doc.id)}`);
    showCustomScreen(true);
    render();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// 빈 문서를 만들고 곧바로 연다
export async function newCustomDoc(wantedBookId) {
  try {
    const created = await api('POST', `/api/books/${encodeURIComponent(wantedBookId)}/custom`, { title: '' });
    await openCustomDoc(wantedBookId, created.doc.id);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function leave() {
  await save.flush();
  await go.openBook(bookId).catch(err => toast(err.message, 'error'));
}

// 세 화면은 상단 머리줄을 함께 쓴다 — 장에만 있는 것은 접는다. 보고서·장 화면을 열면 book.js showBookScreen 이 이 화면을 숨긴다
function showCustomScreen(on) {
  $('workspace').hidden = true;
  $('book-workspace').hidden = true;
  $('custom-workspace').hidden = !on;
  $('doc-controls').hidden = true;
  $('book-controls').hidden = true;
  $('custom-controls').hidden = !on;
  for (const id of ['summary', 'save-state', 'btn-undo', 'btn-redo', 'btn-export']) $(id).hidden = true;
  document.body.classList.remove('on-book');
  document.body.classList.toggle('on-custom', on);
}

// ───────────────────────────── 저장 ─────────────────────────────

async function saveNow() {
  if (!doc) return;
  try {
    const res = await api('PUT', customUrl(doc.id), { title: doc.title, markdown: doc.markdown, picks: doc.picks });
    doc.updatedAt = res.doc.updatedAt;
    book.custom = res.custom;
    saveState.textContent = '저장됨';
    saveState.classList.remove('is-error');
    showExplorer({ book: book.book, chapters: book.chapters, current: null, custom: book.custom, currentCustom: doc.id });
  } catch (err) {
    saveState.textContent = '저장 실패';
    saveState.classList.add('is-error');
    toast(err.message, 'error');
  }
}
const save = debounce(saveNow, 700);
function queueSave() {
  saveState.textContent = '저장 중…';
  save();
}

// ───────────────────────────── 그리기 ─────────────────────────────

function render() {
  renderHead();
  renderEditor();
  renderSide();
  renderSources();
  showExplorer({ book: book.book, chapters: book.chapters, current: null, custom: book.custom, currentCustom: doc.id });
}

function renderHead() {
  fill($('custom-controls').querySelector('.custom-current'), doc.title || '제목 없는 문서', h('span.doc-current-id', doc.id));
}

// 1열 — 제목과 본문. 고치면 자동 저장한다
function renderEditor() {
  const title = h('input.custom-title', { value: doc.title, placeholder: '문서 제목', 'aria-label': '문서 제목', oninput: () => { doc.title = title.value; renderHead(); queueSave(); } });
  textarea = h('textarea.custom-text', {
    value: doc.markdown, 'aria-label': '문서 본문',
    placeholder: '3열에서 원문을 열어 문장이나 표 셀을 누르면 여기 커서 자리에 들어옵니다. 직접 써도 됩니다 — Markdown 제목(#)·목록(-)·표(| … |)를 인식합니다.',
    oninput: () => { doc.markdown = textarea.value; updateCounter(); queueSave(); },
  });
  fill($('custom-editor'),
    h('header.col-head', h('div.col-title', h('span.col-index', '1'), '문서', h('span.count', doc.id)), h('div.col-head-actions', saveState, collapseButton($('custom-editor'), '1열 문서'))),
    h('div.custom-body', title, textarea,
      h('p.muted.custom-hint', h('span.custom-counter'), ' · 원문에서 가져온 글은 요약하거나 고치지 말고 그대로 두는 편이 근거로 쓰기 좋습니다. 장의 원문으로 등록하면 문장·표 단위로 나뉘어 새 원문이 됩니다.')));
  updateCounter();
}

const updateCounter = () => { const el = $('custom-editor').querySelector('.custom-counter'); if (el) el.textContent = `${doc.markdown.length.toLocaleString()}자 · 출처 ${doc.picks.length}곳`; };

// 커서 자리에 글을 넣는다 — 문장은 앞에 공백을, 표(block)는 앞뒤에 빈 줄을 맞춘다
function insertText(text, { block = false } = {}) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  const lead = block ? (before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '') : (before && !/\s$/.test(before) ? ' ' : '');
  const tail = block ? (after && !after.startsWith('\n') ? '\n\n' : '') : '';
  const insert = lead + text + tail;
  textarea.value = before + insert + after;
  const caret = start + insert.length;
  textarea.setSelectionRange(caret, caret);
  textarea.focus();
  doc.markdown = textarea.value;
  updateCounter();
  queueSave();
}

// 표 하나를 Markdown 표로 — 서버(lib/source_md.js)와 같은 규칙: 칸의 | 는 ｜ 로
const cellText = t => String(t ?? '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '｜');
const rowText = cells => `| ${cells.map(cellText).join(' | ')} |`;
function tableMarkdown(block) {
  const t = block.table;
  const caption = [t.title, t.unit && `(단위: ${t.unit})`].filter(Boolean).join(' ');
  return [...(caption ? [caption, ''] : []), rowText(t.columns), rowText(t.columns.map(() => '---')), ...t.rows.map(r => rowText([r.header, ...r.cells.map(c => c.text)]))].join('\n');
}

// 3열에서 문장·표 셀·표를 눌렀다 — 1열에 넣고 2열 출처에 기록한다 (FR-WB-088)
function onPick(source, { anchorId, text, kind, block }) {
  if (kind === 'table') insertText(tableMarkdown(block), { block: true });
  else insertText(text);
  doc.picks.push({ chapterId: source.chapterId, sourceId: source.id, anchorId, text: kind === 'table' ? `표: ${block.table.title || '(제목 없음)'}` : text, loc: blockLoc(source, block), at: new Date().toISOString() });
  renderSide();
  updateCounter();
  const node = $('custom-sources').querySelector(`[data-aid="${CSS.escape(anchorId)}"]`);
  if (node) flash(node, 'is-anchor-flash');
}

// 2열 — 원문 등록과 출처 목록
function renderSide() {
  const select = h('select', { 'aria-label': '등록할 장' }, book.chapters.map(ch => h('option', { value: ch.id }, `${ch.title} (${ch.id})`)));
  fill($('custom-side'),
    h('header.col-head', h('div.col-title', h('span.col-index', '2'), '출처·등록', h('span.count', String(doc.picks.length))), h('div.col-head-actions', collapseButton($('custom-side'), '2열 출처·등록'))),
    h('div.custom-side-body',
      h('section.custom-register',
        h('h3', '장의 원문으로 등록'),
        h('p.muted', '이 문서를 고른 장의 새 원문(S-번호)으로 등록합니다. 등록한 뒤 문서를 고치면 다시 등록해야 하고, 그때는 새 원문이 생깁니다(앞의 원문은 그대로).'),
        book.chapters.length
          ? h('div.field-row', h('label.field', '장', select), h('button.btn.custom-register-btn', { type: 'button', onclick: () => register(select.value) }, '원문으로 등록'))
          : h('p.muted', '등록할 장이 없습니다. 먼저 0열에서 장을 추가하세요.'),
        doc.registrations.length
          ? h('ul.custom-regs', doc.registrations.map(r => h('li', `${chapterTitle(r.chapterId)} · ${r.chapterId}/${r.sourceId} · ${formatDate(r.at)}`)))
          : h('p.muted.custom-regs-empty', '아직 등록하지 않았습니다.')),
      h('section.custom-picks',
        h('h3', '출처 — 뽑아 넣은 원문 위치'),
        doc.picks.length
          ? doc.picks.map((p, i) => h('div.custom-pick',
            h('button.custom-pick-open', { type: 'button', title: '3열에서 이 위치를 봅니다', onclick: () => reveal(p) },
              h('span.book-source-id', `${p.chapterId} · ${p.anchorId}${p.loc ? ` · ${p.loc}` : ''}`),
              h('span.custom-pick-text', p.text)),
            h('button.icon-btn', { type: 'button', title: '출처 목록에서 빼기 — 본문은 그대로', 'aria-label': `${p.anchorId} 출처 빼기`, onclick: () => { doc.picks.splice(i, 1); renderSide(); updateCounter(); queueSave(); } }, '✕')))
          : h('p.muted', '3열에서 원문을 열어 문장이나 표 셀을 누르면 여기에 어디에서 왔는지 기록됩니다.'))));
}

// 등록 — 저장을 먼저 끝내고 서버가 새 원문을 만든다 (FR-WB-089, ERR-WB-010)
async function register(chapterId) {
  try {
    await save.flush();
    const res = await api('POST', `${customUrl(doc.id)}/register`, { chapterId });
    doc = res.doc;
    toast(`“${chapterTitle(chapterId)}” 장의 원문 ${res.source.id} 로 등록했습니다.`);
    book = await api('GET', `/api/book?report=${encodeURIComponent(bookId)}`);
    renderSide();
    renderSources();
    showExplorer({ book: book.book, chapters: book.chapters, current: null, custom: book.custom, currentCustom: doc.id });
  } catch (err) {
    toast(err.message, 'error');
  }
}

// 출처 항목을 눌렀다 — 3열에서 그 원문을 열고 위치를 강조한다
function reveal(pick) {
  const source = book.sources.find(s => s.chapterId === pick.chapterId && s.id === pick.sourceId);
  if (!source) return toast('이 원문은 더 이상 없습니다.', 'error');
  openSource = sourceKey(source);
  renderSources();
  readerHandle?.setMode('body');
  const node = $('custom-sources').querySelector(`[data-aid="${CSS.escape(pick.anchorId)}"]`) || $('custom-sources').querySelector(`[data-block="${CSS.escape(pick.anchorId)}"]`);
  if (!node) return toast('이 원문에 없는 위치입니다.', 'error');
  node.scrollIntoView({ block: 'center' });
  flash(node, 'is-anchor-flash');
}

// 3열 — 보고서의 모든 장의 원문. 누르면 열람 화면으로 바뀌고, 열람 화면의 문장·표 셀은 눌러서 문서에 넣는다
function renderSources() {
  const source = book.sources.find(s => sourceKey(s) === openSource);
  if (!source) openSource = readerHandle = null;
  fill($('custom-sources'),
    h('header.col-head', h('div.col-title', h('span.col-index', '3'), '원문', h('span.count', String(book.sources.length))), h('div.col-head-actions', collapseButton($('custom-sources'), '3열 원문'))),
    source ? reader(source) : sourceList());
}

function sourceList() {
  const byChapter = new Map(book.chapters.map(ch => [ch.id, []]));
  for (const s of book.sources) byChapter.get(s.chapterId)?.push(s);
  const groups = book.chapters.filter(ch => byChapter.get(ch.id).length).map(ch => h('section.book-source-group',
    h('h3.book-source-chapter', ch.title, h('span.count', String(byChapter.get(ch.id).length))),
    byChapter.get(ch.id).map(s => h('div.book-source',
      h('button.book-source-head', { type: 'button', title: `${s.chapterId} · ${s.id} · ${s.title}\n누르면 열어서 문장·표를 고를 수 있습니다`, onclick: () => { openSource = sourceKey(s); renderSources(); } },
        h('span.type-badge', { class: `type-${s.type}` }, SOURCE_TYPES[s.type] ?? s.type),
        h('span.book-source-title', s.title),
        h('span.book-source-publisher', s.publisher || '발행처 미상'),
        h('span.book-source-id', `${s.chapterId} · ${s.id}`))))));
  return h('div.book-source-list',
    groups.length ? groups : h('div.empty', h('div.empty-icon', '🗂'), h('p', '아직 수집한 원문이 없습니다.'), h('p.muted', '원문은 장의 작성 화면에서 수집합니다.')),
    book.sources.length > 0 && h('p.muted.book-source-note', '원문을 열어 문장이나 표 셀을 누르면 1열 문서의 커서 자리에 들어가고 2열 출처에 기록됩니다.'));
}

function reader(source) {
  readerHandle = readerPane(source, { docId: source.chapterId, key: 'custom', body: () => readerDoc(source, { onPick: pick => onPick(source, pick) }) });
  return h('div.book-reader',
    h('nav.src-tabs',
      h('button.src-tab.back', { type: 'button', onclick: () => { openSource = null; renderSources(); } }, '← 목록'),
      h('span.book-reader-pos', `${source.chapterId} · ${source.id}`),
      h('span.muted.custom-pick-hint', '문장·표 셀을 누르면 문서에 들어갑니다')),
    readerHandle.pane);
}
