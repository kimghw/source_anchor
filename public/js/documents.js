// 장(하위문서) 머리줄 — 보고서 화면으로 올라가기, 열어 둔 장 표시, 새 장 추가. 장을 여는 진입점(openChapter)도 여기 있다.
// 장 목록·순서·수준·삭제는 0열 장 탐색기(explorer.js)가 맡는다 (FR-WB-061, 072, 074).
import { openBook, showBookScreen } from './book.js';
import { addChapter, showExplorer } from './explorer.js';
import { api, applyServerState, emit, flushSave, on, state } from './state.js';
import { fill, h, toast } from './util.js';

let current;

export function initDocuments(container) {
  current = h('span.doc-current', { title: '열어 둔 장 — 다른 장은 0열 탐색기에서 엽니다' });
  container.append(
    h('button.btn.small.ghost.to-book', { type: 'button', title: '보고서 화면으로 — 목차·지시문, 기준 문서와 장별 원문을 봅니다', onclick: toBook }, '↩ 보고서'),
    h('span.doc-kind', '장'),
    current,
    h('button.btn.small', { type: 'button', title: '이 보고서에 빈 장을 추가합니다 — 원문도 빈 상태로 시작합니다', onclick: addChapter }, '＋ 새 장'));
  on('doc', render);
  on('docs', render);
}

// 주소의 ?doc= 에 적힌 문서(없거나 지워졌으면 마지막으로 연 문서)를 연다
export async function openInitialDocument() {
  const wanted = new URLSearchParams(location.search).get('doc');
  const data = await api('GET', wanted ? `/api/state?doc=${encodeURIComponent(wanted)}` : '/api/state').catch(err => (wanted ? api('GET', '/api/state') : Promise.reject(err)));
  show(data);
}

function show(data) {
  applyServerState(data);
  history.replaceState(null, '', `?doc=${encodeURIComponent(data.doc.id)}`);
  showBookScreen(false);
  showExplorer({ book: state.book, chapters: state.docs, current: state.doc.id, custom: state.custom });
  emit('doc-opened');
}

// 장을 여는 진입점 — 탐색기·새 장 만들기가 쓴다. 쓰던 장을 먼저 저장하고, 저장하지 못하면 옮기지 않는다 (FR-WB-062, 074, ERR-WB-006).
// 이미 받아 둔 상태(data)가 있으면 다시 받지 않는다.
export async function openChapter(id, data) {
  try {
    await flushSave();
  } catch (err) {
    return toast(`저장하지 못해 이동하지 않았습니다: ${err.message}`, 'error');
  }
  try {
    show(data ?? await api('GET', `/api/state?doc=${encodeURIComponent(id)}`));
  } catch (err) {
    toast(err.message, 'error');
  }
}

// 쓰던 장을 저장하고 보고서 화면으로 올라간다 (FR-WB-062, 074, ERR-WB-006)
async function toBook() {
  try {
    await flushSave();
  } catch (err) {
    return toast(`저장하지 못해 이동하지 않았습니다: ${err.message}`, 'error');
  }
  await openBook(state.book?.id).catch(err => toast(err.message, 'error'));
}

function render() {
  fill(current, state.doc.title || '제목 없는 장', h('span.doc-current-id', state.doc.id));
}
