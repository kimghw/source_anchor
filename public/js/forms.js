// 양식 화면 — 작성자가 올린 docx·hwpx·hwp 양식의 칸·필드에 값을 채운다 (FR-WB-090 ~ 092).
// 1열 양식(머리줄 + 문서 순서의 헤딩·필드·표 — 번호 배지·제자리 편집·번호별 지침·자동 저장·내려받기·목차로 가져오기) · 2열 양식 에이전트 · 3열 보고서의 작성 기준·원문(보고서 화면 3열과 같은 구성, 읽기 전용).
// 0열 탐색기 「장」 탭의 양식 묶음에서 열린다. 보고서·장·사용자 지정 문서 화면 모듈(book.js·documents.js·custom_docs.js)을 import 하지 않는다 — 화면 전환 진입점은 app.js 가 넘긴다.
// 양식의 제목(헤딩)을 보고서의 장으로 가져오는 목차 후보 대화상자는 toc_import.js — 올린 직후·1열 머리줄·0열 양식 행(importToc)에서 연다 (FR-WB-093).
// 제목·필드 줄의 수준·종류 조절(번호 불변)과 구조 규칙 머리줄·대화상자의 부품은 form_structure.js — 노드 갱신·다시 그리기·저장은 여기서 한다 (FR-WB-094, 095).
// 한글에서 보는 것처럼 그리는 미리보기는 form_preview.js — 1열 머리줄 「구조 / 미리보기」 전환, 지금 값을 기입한 사본을 쪽 단위로(읽기 전용, hwp·hwpx) (FR-WB-096).
import { SOURCE_TYPES } from '../shared/model.js';
import { headingCandidates } from '../shared/toc.js';
import { guideReader, guidesGroup } from './book_guides.js';
import { collapseButton } from './columns.js';
import { applyBookData, showExplorer } from './explorer.js';
import { initFormChat, sendFormMessage, setFormView } from './form_chat.js';
import { formPreview, previewable } from './form_preview.js';
import { canSwitchKind, clearStructure, FORM_LEVEL_MAX, noteStructure, paintStructRow, recordStructure, restoreStructure, rulesHeadControls, setRules, structControls, STRUCTURE_REQUEST, structureKey, takeStructure } from './form_structure.js';
import { readerDoc } from './reader_doc.js';
import { readerPane } from './source_view.js';
import { api, flushSave, state } from './state.js';
import { openTocImport } from './toc_import.js';
import { debounce, fill, flash, h, toast } from './util.js';

const $ = id => document.getElementById(id);
const go = { openBook: async () => {}, openChapter: async () => {}, reveal: () => {} }; // openChapter·reveal — 2열 에이전트 답의 장·문장 링크가 쓴다
const FILE_LIMIT = 20 * 1024 * 1024; // 서버(lib/forms.js FILE_LIMIT)와 같다 — 올리기 전에 먼저 거른다 (DR-WB-008)
const FILE_LIMIT_TEXT = `${FILE_LIMIT / 1024 / 1024}MiB`;
let bookId = null;
let form = null; // 열어 둔 양식 { id, title, fileName, format, nodes, tables, values, instructions, … }
let book = null; // 보고서 상태 { book, chapters, sources, guides, custom, forms } — 3열·탐색기
let openSource = null; // 3열에서 열람 중인 원문 (장 ID/원문 번호)
let openGuide = null; // 3열에서 열람 중인 기준 문서 ID
let readerHandle = null; // 3열 열람 화면의 부품 — 에이전트 답의 원문 위치 링크가 본문 보기로 돌려 그 자리를 보여 준다
let units = new Map(); // 번호 → { text(원본 글), locked, note, where(지침 상자 머리줄의 자리) } — 칸과 필드가 같은 단위다
let guideN = null; // 지침 상자에 열어 둔 번호
let pending = false; // 아직 서버에 보내지 않은 값·지침·제목 변경이 있다
let saveState = null;
let preview = null; // 1열 미리보기 부품(form_preview.js) — 양식을 열 때마다 새로 만들고 떠날 때 놓아 준다 (FR-WB-096)
let previewOn = false; // 1열이 미리보기를 보이고 있다

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
  initFormChat($('form-chat'), { ...cells, showSource, openChapter: openChapterFromForm, flush: flushFormSave, applyStructure, nodeState, revealNode, guidesChanged: () => reload() }); // 2열 양식 에이전트 (FR-WB-091) — applyStructure·nodeState·revealNode 는 구조 수정안 카드가 쓴다 (FR-WB-095)
  window.addEventListener('beforeunload', () => {
    if (!form) return;
    document.activeElement?.closest('.cell-text')?.blur(); // 편집 중인 칸을 먼저 확정한다 — 확정 전 글은 아직 저장 대상이 아니다
    save.flush();
  });
}

// ───────────────────────────── 열기 · 올리기 · 떠나기 ─────────────────────────────

// 탐색기·주소(?form=)에서 연다. 쓰던 장을 먼저 저장하고, 저장하지 못하면 옮기지 않는다 (FR-WB-062, ERR-WB-006)
export async function openForm(wantedBookId, id) {
  try {
    await flushSave();
  } catch (err) {
    return toast(`저장하지 못해 이동하지 않았습니다: ${err.message}`, 'error');
  }
  if (!(await flushFormSave())) return; // 열어 둔 양식의 값·지침을 저장하지 못하면 옮기지 않는다 — 적은 글은 화면에 남는다 (ERR-WB-011)
  save.cancel();
  pending = false; // 양식 화면 밖에 남은 저장(보던 양식을 지운 뒤 등)은 버린다
  clearStructure(); // 보내지 못한 구조 변경도 — 다른 양식에 보내면 안 된다
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

// docx·hwpx·hwp 파일 하나를 보고서의 새 양식으로 올리고 곧바로 연다 — 형식·크기는 먼저 거르고, 구조를 읽지 못하면 서버가 사유를 돌려준다 (FR-WB-090, ERR-WB-011).
// 열기까지 끝나면 문서에서 찾은 제목이 있을 때 목차 후보 대화상자를 바로 연다 (FR-WB-093). 서버가 구조 규칙으로 맞춘 노드가 있으면 그 건수를 알린다 (FR-WB-095)
export async function uploadForm(wantedBookId, file) {
  if (!/\.(docx|hwpx|hwp)$/i.test(file.name)) return toast(`양식은 docx·hwpx·hwp 파일만 올릴 수 있습니다: ${file.name}`, 'error');
  if (file.size > FILE_LIMIT) return toast(`파일이 ${FILE_LIMIT_TEXT} 를 넘습니다 (${(file.size / 1024 / 1024).toFixed(1)}MiB)`, 'error');
  try {
    const { form: created, rulesApplied } = await api('POST', formsUrl(wantedBookId), { fileName: file.name, data: await readBase64(file) });
    if (rulesApplied > 0) toast(`구조 규칙 ${rulesApplied}건을 적용했습니다`);
    await openForm(wantedBookId, created.id);
    if (form?.id === created.id && candidateCount(form)) openCandidates(book, form); // 열지 못했으면(저장 실패 등) 묻지 않는다
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ───────────────────────────── 목차로 가져오기 (FR-WB-093) ─────────────────────────────

const candidateCount = f => headingCandidates(f?.nodes).length; // 장 후보가 될 제목(헤딩)의 수 — 0 이면 가져올 것이 없다

// 0열 양식 행의 「⇪」와 1열 머리줄 「⇪ 목차로 가져오기」 — 보고서 상태(지금 목차)와 양식을 받아 목차 후보 대화상자를 연다. 어느 화면에서든 쓴다.
// 보고서 상태는 늘 다시 받는다 — 양식 화면에서 0열로 목차를 고친 뒤에는 받아 둔 것이 낡아 있다. 열어 둔 양식이면 구조는 받아 둔 것을 쓴다
export async function importToc(wantedBookId, formId) {
  try {
    const data = await api('GET', bookUrl(wantedBookId));
    const own = !$('form-workspace').hidden && form?.id === formId && bookId === data.book.id;
    const target = own ? form : (await api('GET', formsUrl(data.book.id, formId))).form;
    openCandidates(data, target);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// 만든 뒤 — 양식 화면이 열려 있으면 받아 둔 보고서 상태를 새 목차로 맞춰 3열·탐색기를 다시 그리고, 다른 화면(보고서·장·사용자 지정 문서)이면 그 화면이 맞춘다(explorer.js applyBookData)
function openCandidates(data, target) {
  return openTocImport({ bookId: data.book.id, form: target, chapters: data.chapters, onDone: result => {
    if (!$('form-workspace').hidden && book && book.book.id === result.book.id) {
      book.chapters = result.chapters;
      book.forms = result.forms;
      renderSources();
      explore();
    } else applyBookData(result);
  } });
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

// 양식 화면을 떠나기 전 — 예약된 저장과 보내는 중인 저장을 끝낸다. 실패하면 false(알림은 저장이 한 번 띄운다). 양식 화면이 아니면 할 일이 없다.
// 0열 탐색기(explorer.js leaving)는 app.js 가 넘긴 이 함수로 장·보고서·문서로 옮기기 전에 부른다 (ERR-WB-011)
export async function flushFormSave() {
  if ($('form-workspace').hidden) return true;
  return save.flush();
}

async function leave() {
  if (!(await flushFormSave())) return; // 저장하지 못하면 옮기지 않는다 (ERR-WB-011)
  preview?.destroy(); // 그려 둔 문서를 놓아 준다 — 다시 열면 새로 그린다
  preview = null;
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
  setFormView({ bookId, form }); // 2열 — 다른 양식이면 새 대화, 같으면 수정안 카드와 1열의 대기 표시를 다시 맞춘다
  renderSources();
  explore();
  setSaveState('저장됨');
}

// 상단 머리줄 — 양식 제목은 그 자리에서 고치고 자동 저장한다. 비우면 서버가 파일 이름을 쓴다
function renderHead() {
  const title = h('input.book-title', { value: form.title, placeholder: form.fileName, 'aria-label': '양식 제목', oninput: () => { form.title = title.value; queueSave(); } });
  fill($('form-controls').querySelector('.form-current'), title, h('span.doc-current-id', form.id));
}

// 1열 — 머리줄(번호·형식·채우는 단위 수 · 저장 상태 · 구조 규칙 · 규칙으로 수준 정하기 · 목차로 가져오기 · 내려받기 · 원본), 내려받기 실패 사유, 양식 본문, 지침 상자(번호마다 바꿔 쓰는 하나)
function renderEditor() {
  guideN = null; // 지침 상자는 닫힌 채로 다시 그린다
  preview?.destroy(); // 구조 보기로 시작한다 — 미리보기는 누를 때 지금 값으로 새로 그린다 (FR-WB-096)
  preview = null;
  previewOn = false;
  $('form-editor').classList.remove('is-preview');
  const count = book.forms.find(f => f.id === form.id)?.units ?? 0;
  const candidates = candidateCount(form);
  fill($('form-editor'),
    h('header.col-head', h('div.col-title', h('span.col-index', '1'), '양식', h('span.count', `${form.id} · ${form.format} · 단위 ${count}`)),
      h('div.col-head-actions', viewSwitch(), saveState,
        rulesHeadControls({ request: () => sendFormMessage(STRUCTURE_REQUEST) }), // 「구조 규칙 N」 · 「규칙으로 수준 정하기」 — 정해진 요청문을 2열로 (FR-WB-095)
        h('button.btn.small.ghost', { type: 'button', disabled: !candidates, title: candidates ? `이 양식에서 찾은 제목 ${candidates}개를 장·챕터·헤딩 후보로 골라 보고서의 장으로 만듭니다` : '이 양식에서 장 후보로 삼을 제목(헤딩)을 찾지 못했습니다', onclick: () => importToc(bookId, form.id) }, '⇪ 목차로 가져오기'),
        h('button.btn.small', { type: 'button', title: `지금 값을 올린 원본의 새 사본에 기입해 같은 형식(${form.format})으로 내려받습니다`, onclick: event => download(event.currentTarget) }, '⬇ 문서로 내려받기'),
        h('a.btn.small.ghost', { href: `${formsUrl(bookId, form.id)}/original`, target: '_blank', title: '올린 원본 파일 그대로' }, '원본'),
        collapseButton($('form-editor'), '1열 양식'))),
    h('div.form-export-error', { role: 'alert', hidden: true }),
    formBody(),
    h('div.form-preview', { role: 'region', 'aria-label': '미리보기' }), // 구조 보기와 번갈아 보인다 — CSS #form-editor.is-preview
    h('div.cell-guide', { role: 'region', hidden: true }));
}

// ───────────────────────────── 구조 / 미리보기 전환 (FR-WB-096) ─────────────────────────────
// 미리보기 = 지금 값을 기입한 사본(/export — 기입 + 재스캔 확인을 그대로 거친다)을 한글에서 보는 것처럼 쪽 단위로 그린 것. 읽기 전용, hwp·hwpx 만.
// 전환 전에 저장을 끝내고, 저장하지 못하면 구조 보기에 남는다 — 적은 글이 빠진 사본을 그리면 안 된다

function viewSwitch() {
  const ok = previewable(form.format);
  return h('div.segmented.form-view', { role: 'group', 'aria-label': '1열 보기' },
    h('button', { type: 'button', class: previewOn ? null : 'is-on', onclick: () => setPreview(false) }, '구조'),
    h('button', { type: 'button', class: previewOn ? 'is-on' : null, disabled: !ok, title: ok ? '지금 값을 기입한 사본을 한글에서 보는 것처럼 쪽 단위로 그립니다 — 읽기 전용' : '미리보기는 hwp·hwpx 양식만 지원합니다 — docx 는 구조 보기만 됩니다', onclick: () => setPreview(true) }, '미리보기'));
}

async function setPreview(on) {
  if (on === previewOn || !form) return;
  if (on) {
    if (!previewable(form.format)) return;
    const id = form.id;
    if (!(await flushFormSave())) return;
    if (form?.id !== id) return; // 기다리는 사이 다른 양식을 열었다 — 그 양식은 구조 보기로 시작한다
  }
  previewOn = on;
  const editor = $('form-editor');
  editor.classList.toggle('is-preview', on);
  editor.querySelectorAll('.form-view button').forEach((button, i) => button.classList.toggle('is-on', (i === 1) === on));
  if (!on) return;
  preview ??= formPreview(editor.querySelector('.form-preview'));
  preview.show(`${formsUrl(bookId, form.id)}/export`);
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
  preview?.markStale(); // 그려 둔 미리보기는 낡았다 — 다음에 보일 때 다시 기입해 그린다 (FR-WB-096)
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

// 2열 양식 에이전트(form_chat.js)가 handlers 로 받는 손잡이 (FR-WB-091). 반영 — 잠긴 단위는 넣지 않고 false (수정안은 대기 그대로)
function applyValue(n, text) {
  if (units.get(n)?.locked) {
    toast('잠긴 단위입니다', 'error');
    return false;
  }
  setValue(n, String(text).replace(/\r\n?/g, '\n'));
  paint(n, true);
  queueSave();
  return true;
}
function revealCell(n) {
  if (previewOn) setPreview(false); // 미리보기에서는 단위를 비출 수 없다 — 구조 보기로 돌아간다 (FR-WB-096)
  const node = unitNode(n);
  if (!node) return toast(`#${n} 은 이 양식에 없는 번호입니다.`, 'error');
  node.scrollIntoView({ block: 'center' });
  flash(node, 'is-anchor-flash');
}
const markProposal = (n, on) => unitNode(n)?.classList.toggle('has-proposal', on);
const cells = { cellText, applyValue, revealCell, markProposal };

// 2열 답·카드의 원문 위치 링크 — 3열에서 그 원문을 열고, 위치가 있으면 본문 보기로 돌려 비춘다
function showSource(chapterId, sourceId, anchorId) {
  if (!book.sources.some(s => s.chapterId === chapterId && s.id === sourceId)) return toast('이 보고서에 없는 원문입니다.', 'error');
  openSource = `${chapterId}/${sourceId}`;
  openGuide = null;
  renderSources();
  if (!anchorId) return;
  readerHandle?.setMode('body');
  const node = $('form-sources').querySelector(`[data-aid="${CSS.escape(anchorId)}"]`);
  if (!node) return toast('이 원문에 없는 위치입니다.', 'error');
  node.scrollIntoView({ block: 'center' });
  flash(node, 'is-anchor-flash');
}

// 2열 답의 장·문장 링크 — 양식 저장을 먼저 끝내고(실패하면 옮기지 않는다) 그 장의 작성 화면을 열어 문장을 보여 준다 (ERR-WB-011)
async function openChapterFromForm(chapterId, sentenceId) {
  if (!(await flushFormSave())) return;
  await go.openChapter(chapterId); // documents.js 가 저장·열기·실패 안내를 맡는다
  if (sentenceId && state.doc?.id === chapterId) go.reveal(sentenceId);
}

// form.nodes 순서대로 그린다. 필드의 자리 표시는 바로 앞 헤딩과 수준. 제목·필드 줄은 data-i(nodes index)로 구조 조절·수정안 카드가 찾고, 줄 끝에 구조 조작을 둔다 (FR-WB-094)
const fieldWhere = (heading, level) => `본문 · ${heading || '—'} · 수준 ${level}`;
function formBody() {
  units = new Map();
  let heading = '';
  const body = h('div.form-body');
  form.nodes.forEach((node, i) => {
    if (node.kind === 'heading') {
      heading = node.text;
      body.append(h(`h3.form-heading.lvl-${node.level}`, { dataset: { i } }, h('span.form-heading-text', node.text), structControls(node, i, structHandlers)));
    } else if (node.kind === 'field') {
      units.set(node.n, { text: node.text, locked: node.locked, note: node.note, heading, where: fieldWhere(heading, node.level) });
      const box = unitBox(`div.form-field.lvl-${node.level}`, node.n);
      box.dataset.i = i;
      box.append(structControls(node, i, structHandlers));
      body.append(box);
    } else if (node.kind === 'table') body.append(tableBox(node.t));
  });
  return body;
}

// ───────────────────────────── 구조 조절 (FR-WB-094) ─────────────────────────────
// 제목·필드 줄의 수준(1~FORM_LEVEL_MAX)·종류를 작성자가 바꾼다 — 번호는 흔들지 않는다: 필드 → 제목이 된 노드는 n 을 남겨 되돌리면 같은 번호, 제목 → 필드는 남긴 n 이 있으면 그것, 없으면 (모든 번호의 최댓값 + 1).
// 수준만 바뀌면 그 줄만 고치고, 종류가 바뀌면 본문을 다시 그린다(units 재구성). 변경은 form_structure.js 의 대기 묶음에 모아 다음 저장에 함께 보낸다

const rowNode = i => $('form-editor').querySelector(`.form-body [data-i="${i}"]`);
const structHandlers = { level: (i, delta) => applyStructure(i, { level: (form?.nodes[i]?.level ?? 0) + delta }), kind: (i, kind) => applyStructure(i, { kind }) };

// 1열 줄 조작과 2열 structure 수정안 카드(form_chat.js)가 쓴다 — level·kind 는 바꿀 것만. 불가하면(표 자리·범위 밖·빈 필드·확인 거부·바뀌는 것 없음) false
function applyStructure(i, { level, kind } = {}) {
  const node = form?.nodes[i];
  if (!node || (node.kind !== 'heading' && node.kind !== 'field')) return false;
  const before = { kind: node.kind, level: node.level };
  const next = { kind: kind ?? node.kind, level: level ?? node.level };
  if (!['heading', 'field'].includes(next.kind) || !Number.isInteger(next.level) || next.level < 1 || next.level > FORM_LEVEL_MAX) return false;
  if (next.kind === before.kind && next.level === before.level) return false;
  if (next.kind !== before.kind && !switchKind(node, next.kind)) return false;
  node.level = next.level;
  noteStructure(node, before);
  recordStructure(i, node);
  if (next.kind !== before.kind) redrawBody();
  else {
    const row = rowNode(i);
    if (row) paintStructRow(row, node);
    const u = node.kind === 'field' ? units.get(node.n) : null;
    if (u) {
      u.where = fieldWhere(u.heading, node.level);
      row?.querySelector('.cell-text')?.setAttribute('aria-label', `#${node.n} ${u.where}`);
    }
  }
  queueSave();
  setFormView({ bookId, form }); // 이 자리를 겨눈 구조 수정안은 이제 낡았다 — 2열 카드를 다시 맞춘다
  return true;
}

// 종류 바꾸기 — 필드 → 제목: 번호는 노드에 남고 값·지침은 지운다(있으면 confirm). 제목 → 필드: 남긴 번호, 없으면 새 번호. 제목 바로 뒤의 빈 필드는 제목이 될 수 없다
function switchKind(node, kind) {
  if (kind === 'heading') {
    if (!canSwitchKind(node)) {
      toast('제목 바로 뒤의 빈 필드는 제목으로 바꿀 수 없습니다', 'error');
      return false;
    }
    if ((node.n in form.values || node.n in form.instructions) && !confirm(`#${node.n} 을 제목으로 바꾸면 이 번호에 적은 값과 지침이 지워집니다. 계속할까요?`)) return false;
    delete form.values[node.n];
    delete form.instructions[node.n];
  } else if (!Number.isInteger(node.n) || node.n < 1) node.n = nextUnitNumber();
  node.kind = kind;
  return true;
}

// 새 번호 — 칸·필드 번호와 제목이 남겨 둔 번호를 통틀어 최댓값 + 1 (되돌릴 때 번호가 겹치지 않게)
function nextUnitNumber() {
  let max = 0;
  for (const node of form.nodes) {
    if (Number.isInteger(node.n)) max = Math.max(max, node.n);
    if (node.kind === 'table') for (const row of form.tables[node.t].rows) for (const cell of row.cells) max = Math.max(max, cell.n);
  }
  return max + 1;
}

// 종류가 바뀌거나 서버가 돌려준 구조가 다를 때 — 본문만 다시 그린다(units 재구성, 번호는 그대로). 스크롤은 그대로 두고, 사라진 번호의 지침 상자는 닫는다
function redrawBody() {
  const old = $('form-editor').querySelector('.form-body');
  if (!old) return;
  const keep = old.scrollTop;
  const next = formBody();
  old.replaceWith(next);
  next.scrollTop = keep;
  if (guideN != null && !units.has(guideN)) closeGuide();
}

// 2열 구조 수정안 카드의 낡음 판정 — 그 자리의 지금 종류·수준·글 (없으면 null)
function nodeState(i) {
  const node = form?.nodes[i];
  return node ? { kind: node.kind, level: node.level, text: node.text } : null;
}

// 2열 카드의 「제목」 배지 — 1열에서 그 줄을 비춘다 (필드는 revealCell)
function revealNode(i) {
  if (previewOn) setPreview(false); // 구조 보기로 돌아가 비춘다 (FR-WB-096)
  const row = rowNode(i);
  if (!row) return toast('이 양식에 없는 자리입니다.', 'error');
  row.scrollIntoView({ block: 'center' });
  flash(row, 'is-anchor-flash');
}

// 원본 배치 그대로 — 열 폭 비율(colgroup), 가로·세로 병합(colspan·rowspan), 행 높이. 병합으로 가려진 이어짐 칸은 서버가 이미 뺐다
function tableBox(t) {
  const { cols, rows } = form.tables[t];
  const fixed = `고정 높이 행 — 긴 값은 ${form.format === 'docx' ? 'Word ' : '한글'}에서 잘릴 수 있습니다`;
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
  setFormView({ bookId, form }); // 이 단위를 겨눈 수정안은 이제 반영할 수 없다 — 2열 카드를 다시 맞춘다
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

// 제목·값·지침을 통째로, 구조 변경은 모아 둔 것만 보낸다. 서버가 원본과 같은 값을 빼고 돌려주므로, 보내는 동안 더 고친 것이 없을 때만 받아 쓴다.
// 구조를 보냈으면 번호·조절 표시는 서버 것으로 두되 보이는 구조가 다를 때만 다시 그린다. 실패하면 적은 글은 화면에 남기고 false — 옮기기 전 저장이 실패하면 옮기지 않는다 (ERR-WB-011, FR-WB-094)
async function putForm() {
  const f = form;
  if (!f || !pending) return true;
  pending = false;
  const structure = takeStructure(); // 보내는 순간 비운다 — 그새 또 바꾼 것은 다음 저장에
  try {
    const res = await api('PUT', formsUrl(bookId, f.id), { title: f.title, values: f.values, instructions: f.instructions, ...(structure.length && { structure }) });
    if (f !== form) return true;
    if (!pending) {
      Object.assign(f, { values: res.form.values, instructions: res.form.instructions });
      if (structure.length && Array.isArray(res.form.nodes)) {
        const changed = structureKey(res.form.nodes) !== structureKey(f.nodes);
        f.nodes = res.form.nodes;
        if (changed) redrawBody();
      }
    }
    f.updatedAt = res.form.updatedAt;
    book.forms = res.forms;
    setRules(res.rules); // 구조를 바꿨으면 규칙이 생기거나 지워졌다 — 머리줄 「구조 규칙 N」 (FR-WB-095)
    if (!pending) setSaveState('저장됨');
    if (!$('form-workspace').hidden) explore(); // 그새 다른 화면으로 옮겼으면 탐색기는 그 화면의 것이다
    return true;
  } catch (err) {
    if (f === form) {
      pending = true;
      restoreStructure(structure); // 보내지 못한 구조 변경은 다음 저장에 다시
      setSaveState('저장 실패', true);
    }
    toast(`양식을 저장하지 못했습니다: ${err.message}`, 'error');
    return false;
  }
}
// 저장은 한 줄로 잇는다 — flush 는 보내는 중인 PUT 이 끝난 뒤에 남은 변경을 보내고 그 결과로 판단한다
let inflight = Promise.resolve(true);
const saveNow = () => (inflight = inflight.then(putForm));
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
  if (!source) openSource = readerHandle = null;
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
  readerHandle = readerPane(source, { docId: source.chapterId, key: 'form', body: () => readerDoc(source) });
  return h('div.book-reader',
    h('nav.src-tabs',
      h('button.src-tab.back', { type: 'button', onclick: () => { openSource = null; renderSources(); } }, '← 목록'),
      h('span.book-reader-pos', `${source.chapterId} · ${source.id}`)),
    readerHandle.pane);
}
