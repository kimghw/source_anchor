// 장 작성 화면 3열의 「보고서 전체」 탭 — 그 장이 속한 보고서의 기준 문서 묶음(book_guides.js)과 모든 장의 원문을 장별로 보여 준다 (FR-WB-104).
// 다른 장의 원문은 읽기 전용 본문(reader_doc.js)으로만 연다 — 고르거나 끌 수 없어 이 장의 편집기·근거·채팅으로 넘어가지 않는다 (DR-WB-002).
// 이 장의 원문은 받은 목록 대신 지금 화면의 원문(state.sources)을 쓰고, 누르면 「이 장 원문」 탭에서 연다.
// 목록은 GET /api/book?remember=0 으로 받는다 — 화면을 다시 열 때의 자리는 이 장으로 남는다 (FR-WB-074).
// sources.js 가 이 모듈을 부르므로 sources.js 를 import 하지 않는다(순환 금지) — 이 장의 원문 열기·다시 그리기는 handlers(openOwn·redraw)로 받는다.
import { SOURCE_TYPES } from '../shared/model.js';
import { guideReader, guidesGroup } from './book_guides.js';
import { readerDoc } from './reader_doc.js';
import { readerPane } from './source_view.js';
import { api, state } from './state.js';
import { fill, h } from './util.js';

let data = null; // 받은 보고서 상태 { book, chapters, sources, guides }
let loadedFor = null; // data 를 받을 때 열려 있던 장 ID — 다른 장을 열면 다시 받는다
let pending = null; // 받는 중인 장 ID — 그 사이 다른 장을 열었으면 늦게 온 답은 버린다
let failure = null; // 받지 못한 사유 { docId, message } — 다시 받기를 누를 때까지 저절로 다시 받지 않는다
let openSource = null; // 열람 중인 다른 장의 원문 `${장}/${번호}` — 장이 다르면 같은 번호가 있다
let openGuide = null; // 열람 중인 기준 문서 ID

const sourceKey = s => `${s.chapterId}/${s.id}`;
const fresh = () => loadedFor === state.doc?.id;
// 목록이 달라졌는지 — 같으면 다시 그리지 않아 열람 중인 문서가 그대로 남는다
const signature = d => JSON.stringify([d.guides, d.chapters.map(ch => [ch.id, ch.title]), d.sources.map(s => [s.chapterId, s.id, s.title])]);

// 목차 순서의 모든 장 원문 — 이 장의 것은 지금 화면의 원문이라 추가·거부·삭제가 곧바로 보인다
const allSources = () => data.chapters.flatMap(ch => (ch.id === state.doc.id
  ? state.sources.map(s => ({ ...s, chapterId: ch.id, chapterTitle: ch.title }))
  : data.sources.filter(s => s.chapterId === ch.id)));

// 탭에 붙일 수 — 기준 문서 · 모든 장 원문. 받기 전에는 없다
export function reportCount() {
  return fresh() ? `${data.guides.length} · ${allSources().length}` : '';
}

// 탭을 고를 때 — 받아 둔 목록이 있으면 그것을 보여 주면서 다시 받는다(없으면 drawReport 가 받는다)
export function refreshReport(handlers) {
  if (fresh() && pending !== state.doc.id) load(state.doc.id, handlers);
}

async function load(docId, { redraw }) {
  pending = docId;
  try {
    const got = await api('GET', `/api/book?report=${encodeURIComponent(state.book.id)}&remember=0`);
    if (pending !== docId) return;
    failure = null;
    if (loadedFor === docId && signature(got) === signature(data)) return;
    data = got;
    loadedFor = docId;
  } catch (err) {
    if (pending !== docId) return;
    failure = { docId, message: err.message };
    if (loadedFor === docId) return; // 앞서 받은 목록은 그대로 둔다
  } finally {
    if (pending === docId) pending = null;
  }
  redraw();
}

// 3열 몸통(node)에 목록 또는 열람 화면을 그린다 — handlers.openOwn(id): 이 장의 원문을 「이 장 원문」 탭에서 연다 · handlers.redraw(): 탭과 이 몸통을 다시 그린다
export function drawReport(node, handlers) {
  const docId = state.doc.id;
  if (!fresh()) {
    if (failure?.docId === docId) {
      return fill(node, h('div.empty', h('p', `보고서의 기준 문서와 원문을 받지 못했습니다: ${failure.message}`),
        h('button.btn.small', { type: 'button', onclick: () => { failure = null; handlers.redraw(); } }, '다시 받기')));
    }
    if (pending !== docId) load(docId, handlers);
    return fill(node, h('p.muted.reader-loading', '보고서의 기준 문서와 원문을 받는 중…'));
  }
  const sources = allSources();
  const source = sources.find(s => sourceKey(s) === openSource && s.chapterId !== docId);
  if (!source) openSource = null;
  const guide = data.guides.find(g => g.id === openGuide);
  if (!guide) openGuide = null;
  fill(node, guide ? guideReader(data.book.id, guide, { back: () => { openGuide = null; handlers.redraw(); } })
    : source ? reader(source, handlers) : list(sources, handlers));
}

// 기준 문서 묶음(등록·열람·수정·삭제 — 파일 끌어 놓기는 보고서 화면에서만) + 목차 순서의 장별 원문
function list(sources, handlers) {
  const docId = state.doc.id;
  const groups = data.chapters.map(ch => ({ ch, items: sources.filter(s => s.chapterId === ch.id) })).filter(g => g.items.length);
  return h('div.book-source-list',
    guidesGroup(data.book.id, data.guides, { open: g => { openGuide = g.id; openSource = null; handlers.redraw(); }, changed: () => load(docId, handlers), dropHint: false }),
    h('h3.book-source-chapter.book-source-part', '장별 원문', h('span.count', String(sources.length))),
    groups.length
      ? groups.map(({ ch, items }) => h('section.book-source-group', { class: ch.id === docId ? 'is-own' : null },
        h('h3.book-source-chapter', ch.title, ch.id === docId && h('span.kind-badge', '이 장'), h('span.count', String(items.length))),
        items.map(s => sourceRow(s, s.chapterId === docId ? () => handlers.openOwn(s.id) : () => { openSource = sourceKey(s); openGuide = null; handlers.redraw(); }))))
      : h('div.empty', h('p', '아직 수집한 원문이 없습니다.'), h('p.muted', '원문은 각 장의 작성 화면에서 수집합니다.')),
    sources.length > 0 && h('p.muted.book-source-note', '다른 장의 원문은 읽기만 할 수 있습니다. 이 장의 원문을 누르면 「이 장 원문」 탭에서 열려 근거로 연결할 수 있습니다.'));
}

function sourceRow(s, open) {
  const own = s.chapterId === state.doc.id;
  return h('div.book-source',
    h('button.book-source-head', { type: 'button', title: `${s.chapterId} · ${s.id} · ${s.title}\n${own ? '「이 장 원문」 탭에서 열기' : '원문 열기 (읽기 전용)'}`, onclick: open },
      h('span.type-badge', { class: `type-${s.type}` }, SOURCE_TYPES[s.type] ?? s.type),
      h('span.book-source-title', s.title),
      h('span.book-source-publisher', s.publisher || '발행처 미상'),
      h('span.book-source-id', `${s.chapterId} · ${s.id}`)));
}

// 다른 장 원문의 열람 화면 — 보고서 화면 3열과 같은 읽기 전용 부품(서지정보·소속 장·보기 방식·참조 표시)
function reader(source, handlers) {
  const pane = readerPane(source, { docId: source.chapterId, key: 'book', body: () => readerDoc(source) });
  return h('div.book-reader',
    h('nav.src-tabs',
      h('button.src-tab.back', { type: 'button', onclick: () => { openSource = null; handlers.redraw(); } }, '← 목록'),
      h('span.book-reader-pos', `${source.chapterId} · ${source.id} · 읽기 전용`)),
    pane.pane);
}
