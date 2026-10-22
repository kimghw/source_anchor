// 0열 장 탐색기 — 보고서(뿌리)와 장들을 목차 순서·수준(헤딩 단계)대로 보여 준다. 장을 클릭하면 그 장의 본문(작성 화면)이,
// 보고서를 클릭하면 보고서 화면이 열린다 (FR-WB-061, 074). 장의 순서(↑↓)·수준(⇤⇥)·추가·삭제도 여기서 한다 (FR-WB-072, 079).
// 목차는 처음에 수준 1 장만 보이고, 장마다 펼침 표시(▸)나 모두 펼치기로 하위 장과 세부 장(본문의 제목)을 펼친다 (FR-WB-061).
// "사용자 지정 문서" 탭은 원문들에서 뽑아 만든 문서의 목록이다 — 열기·새로 만들기·삭제 (FR-WB-088).
// "장" 탭의 장 목차 아래에는 양식 묶음을 둔다 — 작업공간 공통이라 어느 보고서에서나 같은 목록. 올리기·열기·목차로 가져오기(⇪)·삭제 (FR-WB-090, 093).
// 네 화면이 함께 쓰므로 어느 화면 모듈도 import 하지 않는다 — 화면을 여는 진입점은 app.js 가 넘긴다.
import { docHeadings } from '../shared/model.js';
import { canDemote, canMoveDown, canMoveUp, canPromote, moveDown, moveUp, outlineNumbers, shiftLevel } from '../shared/toc.js';
import { collapseButton } from './columns.js';
import { api, emit, flushSave, on, state } from './state.js';
import { fill, formatDate, h, toast } from './util.js';

let root = null;
let view = { book: null, chapters: [], current: null, custom: [], currentCustom: null, forms: [], currentForm: null }; // current: 열어 둔 장 ID(null 이면 보고서 화면) · currentCustom·currentForm: 열어 둔 사용자 지정 문서·양식 ID
let tab = 'chapters'; // 0열 탭 — 'chapters' | 'custom' (FR-WB-088)
const go = { openBook: async () => {}, openChapter: async () => {}, bookChanged: () => {}, reveal: () => {}, openCustom: async () => {}, newCustom: async () => {}, openForm: async () => {}, uploadForm: async () => {}, flushForm: async () => true, importToc: async () => {} };
const action = (label, title, enabled, fn) => h('button.icon-btn', { type: 'button', title, disabled: !enabled, onclick: fn }, label);
const expanded = new Set(); // 펼친 장 ID — 처음에는 수준 1 장만 보인다 (FR-WB-061)
let revealed = null; // 마지막으로 위의 장들을 펼쳐 보인 열린 장 — 열린 장이 바뀔 때만 다시 펼친다
let formsOpen = false; // 양식 묶음 펼침 — 처음에는 접혀 머리만 보인다 (FR-WB-090)
let revealedForm = null; // 마지막으로 묶음을 펼쳐 보인 열린 양식 — 열린 양식이 바뀔 때만 다시 펼친다
let headingKey = ''; // 열어 둔 장의 제목 목록 — 바뀌었을 때만 다시 그린다

export function initExplorer(container, handlers) {
  root = container;
  Object.assign(go, handlers);
  // 작성 화면에서 자동 저장이 장 목록을 갱신하면 탐색기도 따라간다
  on('docs', () => { if (view.current !== null) showExplorer({ book: state.book, chapters: state.docs, current: state.doc.id, custom: state.custom, forms: state.forms }); });
  // 열어 둔 장에서 제목 블록이 생기거나 바뀌면 세부 항목도 바로 따라간다 (FR-WB-061)
  on('doc', () => { if (view.current !== null && JSON.stringify(docHeadings(state.doc)) !== headingKey) render(); });
  render();
}

// 화면이 바뀔 때마다 부른다 — chapters 는 서버의 장 목록([{ id, title, level, instructions, sentences, sources, updatedAt }]),
// custom 은 사용자 지정 문서 요약 목록([{ id, title, picks, registrations, updatedAt }]), currentCustom 은 그 화면에서 열어 둔 문서,
// forms 는 양식 요약 목록([{ id, title, fileName, format, units, changed, updatedAt }]), currentForm 은 양식 화면에서 열어 둔 양식
export function showExplorer({ book, chapters, current, custom, currentCustom, forms, currentForm }) {
  view = { book, chapters: chapters || [], current: current ?? null, custom: custom || view.custom || [], currentCustom: currentCustom ?? null, forms: forms || view.forms || [], currentForm: currentForm ?? null };
  if (view.currentCustom) tab = 'custom';
  else if (view.current !== null || view.currentForm) tab = 'chapters';
  // 접힌 장 아래의 장이 열리면 그 위의 장들을 펼쳐 보이게 한다 — 그 뒤에 작성자가 접은 것은 그대로 둔다
  if (view.current !== null && view.current !== revealed) {
    for (const p of outlineTree(view.chapters).find(it => it.ch.id === view.current)?.parents || []) expanded.add(p.ch.id);
  }
  revealed = view.current;
  if (view.currentForm && view.currentForm !== revealedForm) formsOpen = true;
  revealedForm = view.currentForm;
  render();
}

// ───────────────────────────── 그리기 ─────────────────────────────

const onBook = () => view.current === null && !view.currentForm; // 보고서 화면(또는 사용자 지정 문서 화면) — 양식 화면도 장은 열려 있지 않다
const sourceCount = ch => (view.current && ch.id === state.doc.id ? state.sources.length : ch.sources ?? 0);

// 목차의 장마다 조상 장(수준 1부터)과 바로 아래 하위 장 수 — 장은 위의 장이 모두 펼쳐져 있어야 보인다 (FR-WB-061)
function outlineTree(list) {
  const stack = [];
  return list.map(ch => {
    while (stack.length && (stack.at(-1).ch.level || 1) >= (ch.level || 1)) stack.pop();
    const item = { ch, parents: [...stack], kids: 0 };
    if (stack.length) stack.at(-1).kids++;
    stack.push(item);
    return item;
  });
}

function render() {
  if (!root) return;
  headingKey = view.current !== null ? JSON.stringify(docHeadings(state.doc)) : '';
  const list = view.chapters;
  const numbers = outlineNumbers(list);
  const tree = outlineTree(list);
  const holder = tree.find(it => it.ch.id === view.current)?.parents.find(p => !expanded.has(p.ch.id)); // 열어 둔 장을 접어 숨긴 가장 바깥 장
  const tabs = h('div.tree-tabs', { role: 'tablist' },
    h('button', { type: 'button', role: 'tab', class: tab === 'chapters' ? 'is-on' : '', 'aria-selected': String(tab === 'chapters'), onclick: () => { tab = 'chapters'; render(); } }, `장 ${list.length}`),
    h('button', { type: 'button', role: 'tab', class: tab === 'custom' ? 'is-on' : '', 'aria-selected': String(tab === 'custom'), title: '원문들에서 문장·표를 골라 넣어 만든 문서 — 장의 원문으로 등록할 수 있습니다', onclick: () => { tab = 'custom'; render(); } }, `사용자 지정 문서 ${view.custom.length}`));
  if (tab === 'custom') {
    fill(root,
      h('header.col-head', h('div.col-title', h('span.col-index', '0'), '사용자 지정 문서', h('span.count', String(view.custom.length))), h('div.col-head-actions', collapseButton(root, '0열 탐색기'))),
      tabs,
      customList());
    return;
  }
  fill(root,
    h('header.col-head', h('div.col-title', h('span.col-index', '0'), '장', h('span.count', String(list.length))), h('div.col-head-actions', collapseButton(root, '0열 장 탐색기'))),
    tabs,
    h('div.tree',
      h('button.tree-root', { type: 'button', class: onBook() ? 'is-current' : '', title: '보고서 화면 — 목차·지시문, 기준 문서와 장별 원문', onclick: toBook },
        h('span.book-kind', '보고서'),
        h('span.tree-title', view.book?.title || '제목 없는 보고서')),
      list.length
        ? [foldTools(tree), tree.map((it, i) => (it.parents.every(p => expanded.has(p.ch.id)) ? [row(it, i, numbers[i], it === holder), expanded.has(it.ch.id) && subRows(it.ch)] : null))]
        : h('div.tree-empty', h('p', '이 보고서에는 아직 장이 없습니다.'), h('p.muted', '아래에서 장을 추가하거나, 보고서 화면의 에이전트에게 목차를 요청하세요.')),
      h('div.tree-add', h('button.btn.small', { type: 'button', onclick: addChapter }, '＋ 장 추가')),
      formsGroup()));
}

// 양식 묶음 — 모든 보고서가 함께 쓰는 양식(view.book 은 맥락 보고서). 올리기(docx·hwpx·hwp)·열기·목차로 가져오기·삭제. 양식 화면과 목차 후보 대화상자는 forms.js (FR-WB-090, 093)
// 머리를 누르면 목록과 올리기 단추를 펼치거나 접는다 — 접혀 열어 둔 양식이 숨으면 머리에 표시한다
function formsGroup() {
  const holds = !formsOpen && view.forms.some(f => f.id === view.currentForm);
  return h('div.tree-forms', { class: holds ? 'has-current' : '' },
    h('button.tree-group', { type: 'button', 'aria-expanded': String(formsOpen), title: `양식 ${formsOpen ? '접기' : '펼치기'}${holds ? ' — 지금 열어 둔 양식이 이 안에 있습니다' : ''}\n양식은 모든 보고서가 함께 씁니다 — 어느 보고서에서 열어도 같은 목록이고, 3열의 원문은 지금 보고서의 것입니다`, onclick: () => { formsOpen = !formsOpen; render(); } },
      h('span.tree-group-fold', formsOpen ? '▾' : '▸'), '양식', h('span.count', String(view.forms.length))),
    formsOpen && formsList());
}

function formsList() {
  return [
    view.forms.map(f => h('div.tree-row.form-row', { class: f.id === view.currentForm ? 'is-current' : '' },
      h('span.tree-fold.is-empty'),
      h('button.tree-node', { type: 'button', title: f.id === view.currentForm ? '지금 열어 둔 양식' : `이 양식을 연다\n${f.fileName}`, onclick: () => openForm(f) },
        h('span.tree-no', f.id),
        h('span.tree-title', f.title || f.fileName),
        h('span.tree-meta', `${f.format} · 단위 ${f.units ?? 0} · 바뀐 ${f.changed ?? 0} · ${formatDate(f.updatedAt)}`)),
      h('div.tree-actions',
        action('⇪', '목차로 가져오기 — 이 양식의 제목(헤딩)들을 장 후보로 골라 보고서의 장으로 만듭니다', true, () => go.importToc(view.book.id, f.id)),
        action('✕', '양식 삭제 — 올린 원본과 적은 값·지침이 함께 지워집니다', true, () => removeForm(f))))),
    h('div.tree-add', h('button.btn.small', { type: 'button', title: 'docx·hwpx·hwp 양식 파일을 올립니다 — 양식 화면에 끌어다 놓아도 됩니다', onclick: pickForm }, '＋ 양식 올리기'))];
}

async function openForm(f) {
  if (f.id === view.currentForm) return;
  await go.openForm(view.book?.id, f.id); // forms.js 가 저장·열기·실패 안내를 맡는다
}

// 파일 고르기 창을 띄우고, 고르면 쓰던 장을 저장한 뒤 올린다 — 형식·크기 검사와 실패 안내는 forms.js
function pickForm() {
  const input = h('input', { type: 'file', accept: '.docx,.hwpx,.hwp', onchange: async () => {
    const [file] = input.files;
    if (file && view.book && await leaving()) await go.uploadForm(view.book.id, file);
  } });
  input.click();
}

async function removeForm(f) {
  if (!confirm(`“${f.title || f.fileName}” 양식을 삭제할까요? 올린 원본과 적은 값·지침이 함께 지워지며 되돌릴 수 없습니다.`)) return;
  try {
    const { forms } = await api('DELETE', `/api/books/${encodeURIComponent(view.book.id)}/forms/${encodeURIComponent(f.id)}`);
    state.forms = view.forms = forms; // 장 화면이 다시 그릴 때 쓰는 목록도 맞춘다
    if (view.currentForm === f.id || onBook()) return go.openBook(view.book.id); // 보던 양식을 지웠으면 보고서 화면으로, 보고서 화면이면 그 상태를 다시 받는다
    render();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// 사용자 지정 문서 목록 — 열기·새로 만들기·삭제. 문서 화면은 custom_docs.js (FR-WB-088)
function customList() {
  return h('div.tree.tree-custom',
    h('p.tree-hint', '원문들에서 문장·표를 골라 넣어 새 문서를 만들고, 장의 원문으로 등록해 근거로 쓸 수 있습니다.'),
    view.custom.length
      ? view.custom.map(doc => h('div.tree-row.custom-row', { class: doc.id === view.currentCustom ? 'is-current' : '' },
        h('span.tree-fold.is-empty'),
        h('button.tree-node', { type: 'button', title: doc.id === view.currentCustom ? '지금 열어 둔 문서' : '이 문서를 연다', onclick: () => openCustom(doc) },
          h('span.tree-no', doc.id),
          h('span.tree-title', doc.title || '제목 없는 문서'),
          h('span.tree-meta', `출처 ${doc.picks ?? 0} · 등록 ${doc.registrations ?? 0} · ${formatDate(doc.updatedAt)}`)),
        h('div.tree-actions', action('✕', '문서 삭제 — 등록한 원문은 장에 남습니다', true, () => removeCustom(doc)))))
      : h('div.tree-empty', h('p', '아직 사용자 지정 문서가 없습니다.'), h('p.muted', '새 문서를 만들어 원문들에서 데이터를 뽑아 담으세요.')),
    h('div.tree-add', h('button.btn.small', { type: 'button', onclick: newCustom }, '＋ 새 문서')));
}

async function openCustom(doc) {
  if (doc.id === view.currentCustom || !(await leaving())) return;
  await go.openCustom(view.book?.id, doc.id);
}

async function newCustom() {
  if (!(await leaving())) return;
  await go.newCustom(view.book?.id);
}

async function removeCustom(doc) {
  if (!confirm(`“${doc.title}” 문서를 삭제할까요? 되돌릴 수 없습니다. 이 문서로 등록한 원문은 장에 그대로 남습니다.`)) return;
  try {
    const { custom } = await api('DELETE', `/api/books/${encodeURIComponent(view.book.id)}/custom/${encodeURIComponent(doc.id)}`);
    view.custom = custom;
    if (view.currentCustom === doc.id) return go.openBook(view.book.id); // 보던 문서를 지웠으면 보고서 화면으로
    render();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// 모두 펼치기·모두 접기 — 하위 장이나 세부 장이 있는 장이 하나라도 있을 때만 (FR-WB-061)
function foldTools(tree) {
  const foldable = tree.filter(it => it.kids || headingsOf(it.ch).length);
  if (!foldable.length) return null;
  return h('div.tree-tools',
    h('button.btn.small.ghost', { type: 'button', title: '하위 장과 세부 장을 모두 펼칩니다', disabled: foldable.every(it => expanded.has(it.ch.id)), onclick: () => { for (const it of foldable) expanded.add(it.ch.id); render(); } }, '모두 펼치기'),
    h('button.btn.small.ghost', { type: 'button', title: '수준 1 장만 남기고 모두 접습니다', disabled: !foldable.some(it => expanded.has(it.ch.id)), onclick: () => { expanded.clear(); render(); } }, '모두 접기'));
}

// holdsCurrent: 이 장이 접혀 그 아래에 열어 둔 장이 숨어 있다
function row({ ch, kids }, i, number, holdsCurrent) {
  const list = view.chapters;
  const current = ch.id === view.current;
  const heads = headingsOf(ch).length;
  const isOpen = expanded.has(ch.id);
  const inside = [kids && `하위 장 ${kids}개`, heads && `세부 장 ${heads}개`].filter(Boolean).join(' · ');
  return h('div.tree-row', { class: `lvl-${ch.level || 1}${current ? ' is-current' : ''}${holdsCurrent ? ' has-current' : ''}` },
    inside
      ? h('button.tree-fold', { type: 'button', title: `${inside} ${isOpen ? '접기' : '펼치기'}`, 'aria-expanded': String(isOpen), onclick: () => { if (!expanded.delete(ch.id)) expanded.add(ch.id); render(); } }, isOpen ? '▾' : '▸')
      : h('span.tree-fold.is-empty'),
    // 장을 클릭하면 열면서 펼친다 — 이미 열어 둔 장이면 펼치기만 한다
    h('button.tree-node', { type: 'button', title: current ? '지금 열어 둔 장' : holdsCurrent ? '이 장 아래에 지금 열어 둔 장이 있습니다 — 펼쳐서 볼 수 있습니다' : '이 장의 본문을 연다', onclick: () => { if (inside && !isOpen) { expanded.add(ch.id); render(); } openChapter(ch); } },
      h('span.tree-no', number),
      h('span.tree-title', ch.title || '제목 없는 장')),
    h('div.tree-actions',
      action('↑', '위로 — 같은 수준의 앞 장과 자리를 바꿉니다 (하위 장도 함께)', canMoveUp(list, i), () => saveChapters(moveUp(list, i))),
      action('↓', '아래로 — 같은 수준의 다음 장과 자리를 바꿉니다 (하위 장도 함께)', canMoveDown(list, i), () => saveChapters(moveDown(list, i))),
      action('⇤', '상위 수준으로 (헤딩 한 단계 올리기)', canPromote(list, i), () => saveChapters(shiftLevel(list, i, -1))),
      action('⇥', '하위 수준으로 (헤딩 한 단계 내리기)', canDemote(list, i), () => saveChapters(shiftLevel(list, i, +1))),
      action('✕', '장 삭제', true, () => removeChapter(ch))));
}

// 장의 세부 장 — 본문의 제목(헤딩) 블록. 열어 둔 장은 편집 중인 본문에서, 다른 장은 서버가 준 목록에서 (FR-WB-061)
const headingsOf = ch => (view.current !== null && ch.id === state.doc.id ? docHeadings(state.doc) : ch.headings || []);

function subRows(ch) {
  return headingsOf(ch).map(head => h('div.tree-row.tree-sub', { class: `lvl-${ch.level || 1}` },
    h('button.tree-node.tree-sub-node', { type: 'button', title: `${ch.title || '제목 없는 장'} › ${head.text}\n누르면 편집기에서 이 제목 자리로 갑니다`, onclick: () => openHeading(ch, head) },
      h('span.tree-no', '§'),
      h('span.tree-title', head.text))));
}

// 세부 장을 누르면 그 장을 열고(이미 열려 있으면 그대로) 편집기에서 그 제목으로 옮긴다
async function openHeading(ch, head) {
  if (ch.id !== view.current) {
    await openChapter(ch);
    if (state.doc.id !== ch.id) return; // 저장 실패 등으로 열지 못했다
  }
  go.reveal(head.id);
}

// ───────────────────────────── 열기 ─────────────────────────────

// 다른 화면으로 가기 전에 쓰던 장을, 양식 화면이면 양식의 값·지침을 저장한다 — 저장하지 못하면 옮기지 않는다 (FR-WB-062, ERR-WB-006, ERR-WB-011)
async function leaving() {
  try {
    await flushSave();
  } catch (err) {
    toast(`저장하지 못해 이동하지 않았습니다: ${err.message}`, 'error');
    return false;
  }
  return go.flushForm(); // 실패 알림은 forms.js 가 띄운다
}

async function toBook() {
  if (onBook() || !(await leaving())) return;
  await go.openBook(view.book?.id).catch(err => toast(err.message, 'error'));
}

async function openChapter(ch) {
  if (ch.id === view.current || !(await leaving())) return;
  await go.openChapter(ch.id); // documents.js 가 열기·실패 안내를 맡는다
}

// 빈 장을 목차 끝에 만들고 곧바로 그 장의 작성 화면으로 연다 (FR-WB-072). 머리줄의 "＋ 새 장"도 이 함수를 쓴다.
export async function addChapter() {
  if (!(await leaving())) return;
  try {
    const created = await api('POST', '/api/reports', { bookId: view.book?.id, title: '' });
    await go.openChapter(created.doc.id, created);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ───────────────────────────── 목차 고치기 ─────────────────────────────

// 목차를 통째로 보내 순서·수준을 저장한다 (FR-WB-072, 079). 제목·지시문은 보고서 화면 1열이 같은 API 로 고친다.
async function saveChapters(list) {
  if (list === view.chapters) return;
  try {
    applyBookData(await api('PUT', '/api/book', { bookId: view.book.id, chapters: list.map(({ id, title, instructions, level }) => ({ id, title, instructions, level })) }));
  } catch (err) {
    toast(err.message, 'error');
  }
}

// 서버가 돌려준 보고서 상태(GET /api/book 과 같은 모양)를 지금 화면에 맞게 반영한다 — 목차 고치기와 목차 후보 가져오기(forms.js, FR-WB-093)가 쓴다
export function applyBookData(data) {
  if (view.currentForm || view.currentCustom) return showExplorer({ ...view, book: data.book, chapters: data.chapters, forms: data.forms }); // 양식·사용자 지정 문서 화면은 그대로 두고 탐색기만
  if (view.current === null) return go.bookChanged(data); // 보고서 화면은 자기 상태를 바꾸고 다시 그린다 — 그때 탐색기도 다시 그려진다
  state.docs = data.chapters;
  if (state.book) state.book = { ...state.book, title: data.book.title, chapters: data.chapters };
  emit('docs');
  showExplorer({ book: state.book, chapters: state.docs, current: state.doc.id, custom: state.custom, forms: state.forms });
}

// 장을 지우면 그 장의 원문도 함께 지워진다 — 먼저 확인을 받는다 (FR-WB-072)
async function removeChapter(ch) {
  if (!confirm(`“${ch.title}” 장을 삭제할까요? 이 장에 수집한 원문 ${sourceCount(ch)}건도 함께 지워지며 되돌릴 수 없습니다.`)) return;
  try {
    const { docs } = await api('DELETE', `/api/reports/${encodeURIComponent(ch.id)}`);
    // 쓰던 장을 지웠으면 같은 보고서의 남은 장으로, 남은 장이 없으면 보고서 화면으로 간다
    if (view.current === ch.id) return docs.length ? go.openChapter(docs[0].id) : go.openBook(view.book.id);
    if (view.current === null && await go.flushForm()) return go.openBook(view.book.id); // 보고서 화면은 3열 전체 원문도 바뀐다 — 다시 받는다. 양식 화면에서 양식 저장이 실패하면 머물고 탐색기만 고친다
    state.docs = docs;
    emit('docs');
    showExplorer({ ...view, chapters: docs });
  } catch (err) {
    toast(err.message, 'error');
  }
}
