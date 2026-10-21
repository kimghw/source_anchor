// 양식 화면 — 작성자가 올린 docx·hwpx 양식의 칸·필드에 값을 채운다 (FR-WB-090 ~ 092).
// 1열 양식(머리줄 + 문서 순서의 헤딩·필드·표 — 번호 배지·제자리 편집·번호별 지침·자동 저장·내려받기) · 2열 양식 에이전트 · 3열 보고서의 작성 기준·원문(보고서 화면 3열과 같은 구성, 읽기 전용).
// 0열 탐색기 「장」 탭의 양식 묶음에서 열린다. 보고서·장·사용자 지정 문서 화면 모듈(book.js·documents.js·custom_docs.js)을 import 하지 않는다 — 화면 전환 진입점은 app.js 가 넘긴다.
import { SOURCE_TYPES } from '../shared/model.js';
import { guideReader, guidesGroup } from './book_guides.js';
import { collapseButton } from './columns.js';
import { showExplorer } from './explorer.js';
import { readerDoc } from './reader_doc.js';
import { readerPane } from './source_view.js';
import { api, flushSave } from './state.js';
import { debounce, fill, flash, h, toast } from './util.js';

const $ = id => document.getElementById(id);
const go = { openBook: async () => {}, openChapter: async () => {} }; // openChapter — 에이전트 답의 원문 위치 링크가 쓴다
const FILE_LIMIT = 5 * 1024 * 1024; // 서버(lib/forms.js FILE_LIMIT)와 같다 — 올리기 전에 먼저 거른다
let bookId = null;
let form = null; // 열어 둔 양식 { id, title, fileName, format, nodes, tables, values, instructions, … }
let book = null; // 보고서 상태 { book, chapters, sources, guides, custom, forms } — 3열·탐색기
let openSource = null; // 3열에서 열람 중인 원문 (장 ID/원문 번호)
let openGuide = null; // 3열에서 열람 중인 기준 문서 ID
let units = new Map(); // 번호 → { text(원본 글), locked, note, where(지침 상자 머리줄의 자리) } — 칸과 필드가 같은 단위다
let guideN = null; // 지침 상자에 열어 둔 번호
let pending = false; // 아직 서버에 보내지 않은 값·지침·제목 변경이 있다
let saveState = null;

const formsUrl = (owner, id = '') => `/api/books/${encodeURIComponent(owner)}/forms${id ? `/${encodeURIComponent(id)}` : ''}`;
const bookUrl = owner => (owner ? `/api/book?report=${encodeURIComponent(owner)}` : '/api/book');
const sourceKey = s => `${s.chapterId}/${s.id}`;

export function initForms(handlers) {
  Object.assign(go, handlers);
  saveState = h('span.custom-save-state', { role: 'status' }, '저장됨');
  fill($('form-controls'),
    h('button.btn.small.ghost.to-book', { type: 'button', title: '보고서 화면으로', onclick: leave }, '↩ 보고서'),
    h('span.doc-kind', '양식'),
    h('span.doc-current.form-current'));
  acceptFormDrops($('form-workspace'));
  window.addEventListener('beforeunload', () => { if (form) save.flush(); });
}

// ───────────────────────────── 열기 · 올리기 · 떠나기 ─────────────────────────────

// 탐색기·주소(?form=)에서 연다. 쓰던 장을 먼저 저장하고, 저장하지 못하면 옮기지 않는다 (FR-WB-062, ERR-WB-006)
export async function openForm(wantedBookId, id) {
  try {
    await flushSave();
  } catch (err) {
    return toast(`저장하지 못해 이동하지 않았습니다: ${err.message}`, 'error');
  }
  if (!(await save.flush())) return; // 열어 둔 양식의 값·지침을 저장하지 못하면 옮기지 않는다 — 적은 글은 화면에 남는다 (ERR-WB-011)
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
  if (!(await save.flush())) return; // 저장하지 못하면 옮기지 않는다 (ERR-WB-011)
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
  renderHead();
  renderEditor();
  renderSources();
  explore();
  setSaveState('저장됨');
}

// 상단 머리줄 — 양식 제목은 그 자리에서 고치고 자동 저장한다. 비우면 서버가 파일 이름을 쓴다
function renderHead() {
  const title = h('input.book-title', { value: form.title, placeholder: form.fileName, 'aria-label': '양식 제목', oninput: () => { form.title = title.value; queueSave(); } });
  fill($('form-controls').querySelector('.form-current'), title, h('span.doc-current-id', form.id));
}

// 1열 — 머리줄(번호·형식·채우는 단위 수 · 저장 상태 · 내려받기 · 원본), 내려받기 실패 사유, 양식 본문, 지침 상자(번호마다 바꿔 쓰는 하나)
function renderEditor() {
  guideN = null; // 지침 상자는 닫힌 채로 다시 그린다
  const count = book.forms.find(f => f.id === form.id)?.units ?? 0;
  fill($('form-editor'),
    h('header.col-head', h('div.col-title', h('span.col-index', '1'), '양식', h('span.count', `${form.id} · ${form.format} · 단위 ${count}`)),
      h('div.col-head-actions', saveState,
        h('button.btn.small', { type: 'button', title: `지금 값을 올린 원본의 새 사본에 기입해 같은 형식(${form.format})으로 내려받습니다`, onclick: event => download(event.currentTarget) }, '⬇ 문서로 내려받기'),
        h('a.btn.small.ghost', { href: `${formsUrl(bookId, form.id)}/original`, target: '_blank', title: '올린 원본 파일 그대로' }, '원본'),
        collapseButton($('form-editor'), '1열 양식'))),
    h('div.form-export-error', { role: 'alert', hidden: true }),
    formBody(),
    h('div.cell-guide', { role: 'region', hidden: true }));
}

// ───────────────────────────── 1열 본문 — 헤딩 · 필드 · 표 ─────────────────────────────
// 칸과 필드는 같은 단위다 — 번호(data-n) 하나로 글·배지·지침 상자·편집을 함께 쓴다 (FR-WB-090)

const unitText = n => units.get(n)?.text ?? '';
const cellText = n => form.values[n] ?? unitText(n); // 지금 글 — 적은 값, 없으면 원본 글
const unitNode = n => $('form-editor').querySelector(`[data-n="${n}"]`);
const rowHeight = pt => `height:${Math.min(320, Math.max(28, Math.round(pt * 1.33)))}px`;

// 원본 글과 같으면 바꾼 값이 아니다 — 서버도 같은 규칙으로 뺀다
function setValue(n, text) {
  if (text === unitText(n)) delete form.values[n];
  else form.values[n] = text;
}

const mark = (node, n) => {
  node.classList.toggle('is-changed', n in form.values);
  node.classList.toggle('is-empty', cellText(n) === '');
};

// 단위 하나의 표시만 고친다 — 전체를 다시 그리지 않는다
function paint(n, withText) {
  const node = unitNode(n);
  if (!node) return;
  if (withText) node.querySelector('.cell-text').textContent = cellText(n);
  mark(node, n);
}

// 2열 양식 에이전트(Task 10 form_chat.js)가 handlers 로 받는 손잡이 — initFormChat($('form-chat'), { ...cells, showSource, openChapter }) (FR-WB-091)
function applyValue(n, text) {
  setValue(n, String(text).replace(/\r\n?/g, '\n'));
  paint(n, true);
  markProposal(n, false);
  queueSave();
}
function revealCell(n) {
  const node = unitNode(n);
  if (!node) return;
  node.scrollIntoView({ block: 'center' });
  flash(node, 'is-anchor-flash');
}
const markProposal = (n, on) => unitNode(n)?.classList.toggle('has-proposal', on);
const cells = { cellText, applyValue, revealCell, markProposal }; // 아직 쓰는 곳이 없다 — 2열 에이전트가 붙으면 initForms 에서 넘긴다

// form.nodes 순서대로 그린다. 필드의 자리 표시는 바로 앞 헤딩
function formBody() {
  units = new Map();
  let heading = '';
  const body = h('div.form-body');
  for (const node of form.nodes) {
    if (node.kind === 'heading') {
      heading = node.text;
      body.append(h(`h3.form-heading.lvl-${node.level}`, node.text));
    } else if (node.kind === 'field') {
      units.set(node.n, { text: node.text, locked: node.locked, note: node.note, where: `본문 · ${heading || '—'}` });
      body.append(unitBox(`div.form-field.lvl-${node.level}`, node.n));
    } else if (node.kind === 'table') body.append(tableBox(node.t));
  }
  return body;
}

// 원본 배치 그대로 — 열 폭 비율(colgroup), 가로·세로 병합(colspan·rowspan), 행 높이. 병합으로 가려진 이어짐 칸은 서버가 이미 뺐다
function tableBox(t) {
  const { cols, rows } = form.tables[t];
  const fixed = `고정 높이 행 — 긴 값은 ${form.format === 'hwpx' ? '한글' : 'Word '}에서 잘릴 수 있습니다`;
  return h('figure.form-table', { dataset: { t } },
    h('div.table-wrap', h('table.form-grid', { dataset: { t } },
      Array.isArray(cols) && h('colgroup', cols.map(w => h('col', { style: `width:${w}%` }))),
      h('tbody', rows.map(row => h('tr', { style: typeof row.height === 'number' ? rowHeight(row.height) : null },
        row.cells.map(cell => {
          units.set(cell.n, { text: cell.text, locked: cell.locked, note: cell.note, where: `행 ${cell.r + 1} 열 ${cell.c + 1}` });
          return unitBox('td.form-cell', cell.n, { colspan: cell.colspan, rowspan: cell.rowspan, title: row.fixedHeight ? fixed : null });
        })))))));
}

// 번호 배지(누르면 지침 상자) + 글(누르면 편집). Enter 는 줄 바꿈, Ctrl+Enter 는 확정, Esc 는 되돌림. 잠긴 단위는 편집하지 않고 배지 title 에 이유를 둔다
function unitBox(spec, n, attrs = {}) {
  const u = units.get(n);
  let before = '', seen = '';
  const text = h('div.cell-text', {
    'aria-label': `#${n} ${u.where}`,
    onfocus: () => { before = cellText(n); seen = text.innerText; },
    onkeydown: event => {
      if (event.isComposing || event.keyCode === 229) return; // 한글 조합 중의 Enter·Esc 는 글자 확정이다
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); text.blur(); }
      else if (event.key === 'Escape') { event.preventDefault(); text.textContent = before; text.blur(); }
    },
    onblur: () => { if (text.innerText !== seen) commit(n, text); },
  }, cellText(n));
  if (u.locked) text.contentEditable = 'false';
  else {
    text.contentEditable = 'plaintext-only';
    if (text.contentEditable !== 'plaintext-only') text.contentEditable = 'true';
  }
  const badge = h('button.cell-n', {
    type: 'button', class: form.instructions[n] ? 'has-guide' : null, 'aria-label': `#${n} 지침`,
    title: [`#${n} — 눌러서 이 번호의 작성 지침을 씁니다`, u.locked && `잠김: ${u.locked} — 고칠 수 없습니다`, u.note].filter(Boolean).join('\n'),
    onclick: event => { event.stopPropagation(); toggleGuide(n); },
  }, `#${n}`);
  const box = h(spec, { ...attrs, dataset: { n }, class: u.locked ? 'is-locked' : null, onclick: event => { if (event.target === event.currentTarget && !u.locked) text.focus(); } }, badge, text);
  mark(box, n);
  return box;
}

// 편집을 마쳤다 — contenteditable 이 끝에 붙이는 줄 바꿈 하나를 떼고 값으로 둔다. 창이 포커스를 잃은 것뿐이면(그 칸이 아직 활성) 글을 다시 쓰지 않는다
function commit(n, text) {
  setValue(n, text.innerText.replace(/\r\n?/g, '\n').replace(/\n$/, ''));
  paint(n, document.activeElement !== text);
  queueSave();
}

// ───────────────────────────── 지침 상자 ─────────────────────────────
// 배지를 누른 번호의 작성 지침 — 1열 아래 하나를 번호마다 바꿔 쓴다. 에이전트가 그 번호를 채울 때 따른다 (FR-WB-090, 091)

const guideBox = () => $('form-editor').querySelector('.cell-guide');

function toggleGuide(n) {
  if (guideN === n) return closeGuide();
  guideN = n;
  const saved = form.instructions[n] ?? '';
  const now = cellText(n);
  const area = h('textarea', {
    rows: 4, value: saved, 'aria-label': `#${n} 작성 지침`, placeholder: '이 번호를 채울 때 따를 지침 — 예: 시·군까지만 적는다',
    oninput: () => {
      const dirty = area.value !== saved;
      saveBtn.disabled = !dirty;
      closeBtn.textContent = dirty ? '변경 취소' : '닫기';
    },
    onkeydown: event => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); closeGuide(); } },
  });
  const saveBtn = h('button.btn.small', { type: 'button', disabled: true, onclick: () => {
    const value = area.value.replace(/\r\n?/g, '\n');
    if (value.trim()) form.instructions[n] = value;
    else delete form.instructions[n];
    unitNode(n)?.querySelector('.cell-n').classList.toggle('has-guide', n in form.instructions);
    queueSave();
    closeGuide();
  } }, '저장');
  const closeBtn = h('button.btn.small.ghost', { type: 'button', onclick: closeGuide }, '닫기');
  const box = fill(guideBox(),
    h('label.field', h('span.cell-guide-head', h('strong', `#${n}`), ` · ${units.get(n).where} · 현재: "${now.length > 80 ? `${now.slice(0, 80)}…` : now}"`), area),
    h('div.row-actions.end', closeBtn, saveBtn));
  box.setAttribute('aria-label', `#${n} 지침`);
  box.hidden = false;
  area.focus();
}

// 닫으면 그 번호의 배지로 포커스를 돌려준다 (적다 만 지침은 버린다)
function closeGuide() {
  const n = guideN;
  guideN = null;
  fill(guideBox()).hidden = true;
  unitNode(n)?.querySelector('.cell-n').focus();
}

// ───────────────────────────── 저장 · 내려받기 ─────────────────────────────

const setSaveState = (text, error = false) => {
  saveState.textContent = text;
  saveState.classList.toggle('is-error', error);
};

// 제목·값·지침을 통째로 보낸다. 서버가 원본과 같은 값을 빼고 돌려주므로, 보내는 동안 더 고친 것이 없을 때만 받아 쓴다.
// 실패하면 적은 글은 화면에 남기고 false — 옮기기 전 저장이 실패하면 옮기지 않는다 (ERR-WB-011)
async function saveNow() {
  const f = form;
  if (!f || !pending) return true;
  pending = false;
  try {
    const res = await api('PUT', formsUrl(bookId, f.id), { title: f.title, values: f.values, instructions: f.instructions });
    if (f !== form) return true;
    if (!pending) Object.assign(f, { values: res.form.values, instructions: res.form.instructions });
    f.updatedAt = res.form.updatedAt;
    book.forms = res.forms;
    if (!pending) setSaveState('저장됨');
    if (!$('form-workspace').hidden) explore(); // 그새 다른 화면으로 옮겼으면 탐색기는 그 화면의 것이다
    return true;
  } catch (err) {
    if (f === form) {
      pending = true;
      setSaveState('저장 실패', true);
    }
    toast(`양식을 저장하지 못했습니다: ${err.message}`, 'error');
    return false;
  }
}
const save = debounce(saveNow, 700);
function queueSave() {
  pending = true;
  setSaveState('저장 중…');
  save();
}

// 저장을 먼저 끝내고 서버가 원본 새 사본에 기입·재확인한 파일을 받는다. 재확인이 실패하면 사유를 1열 머리줄 아래에 남긴다 (FR-WB-092)
async function download(button) {
  if (!(await save.flush())) return;
  const note = $('form-editor').querySelector('.form-export-error');
  button.disabled = true;
  try {
    const res = await fetch(`${formsUrl(bookId, form.id)}/export`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `내려받지 못했습니다 (${res.status})`);
    const link = h('a', { href: URL.createObjectURL(await res.blob()), download: form.fileName });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    note.hidden = true;
  } catch (err) {
    fill(note, err.message).hidden = false;
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
  }
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
    guidesGroup(bookId, book.guides, { open: g => { openGuide = g.id; openSource = null; renderSources(); }, changed: reload, dropHint: false }), // 이 화면에 놓은 파일은 양식으로 올라간다
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
