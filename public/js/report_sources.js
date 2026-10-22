// 보고서의 작성 기준·원문 열 — 기준 문서 묶음 아래에 장별로 묶은 원문 목록(읽기 전용). 누르면 열 안이 열람 화면으로 바뀐다.
// 양식 화면(forms.js)과 데이터 분석 화면(analysis.js)의 3열이 함께 쓴다 (FR-WB-090, 088). 화면 모듈을 import 하지 않는다.
import { SOURCE_TYPES } from '../shared/model.js';
import { guideReader, guidesGroup } from './book_guides.js';
import { collapseButton } from './columns.js';
import { readerDoc } from './reader_doc.js';
import { readerPane } from './source_view.js';
import { fill, flash, h, toast } from './util.js';

const sourceKey = s => `${s.chapterId}/${s.id}`;

// root: 3열 요소 · key: 원문 보기 방식을 기억하는 화면 이름 · label: 접기 단추의 이름 · reload: 기준 문서를 고친 뒤 보고서 상태를 다시 받는다
// → { show(bookId, book), reset(), openSource(장 ID, 원문 번호, 원문 위치?), openGuide(문서 ID, 문장 ID?) }
export function reportSourcesColumn(root, { key, label, reload }) {
  let bookId = null;
  let book = null; // 보고서 상태 { book, chapters, sources, guides, … }
  let openSource = null; // 열람 중인 원문 (장 ID/원문 번호)
  let openGuide = null; // 열람 중인 기준 문서 ID
  let reveal = null; // 열람 화면을 그린 뒤 비출 원문·문서 위치
  let readerHandle = null;

  function render() {
    const source = book.sources.find(s => sourceKey(s) === openSource);
    if (!source) openSource = readerHandle = null;
    const guide = book.guides.find(g => g.id === openGuide);
    if (!guide) openGuide = null;
    fill(root,
      h('header.col-head', h('div.col-title', h('span.col-index', '3'), '작성 기준·원문', h('span.count', `${book.guides.length} · ${book.sources.length}`)), h('div.col-head-actions', collapseButton(root, label))),
      guide ? guideReader(bookId, guide, { back: () => { openGuide = null; render(); }, reveal: takeReveal() })
        : source ? reader(source) : sourceList());
  }

  const takeReveal = () => { const at = reveal; reveal = null; return at; };

  function sourceList() {
    const byChapter = new Map(book.chapters.map(ch => [ch.id, []]));
    for (const s of book.sources) byChapter.get(s.chapterId)?.push(s);
    const groups = book.chapters.filter(ch => byChapter.get(ch.id).length).map(ch => h('section.book-source-group',
      h('h3.book-source-chapter', ch.title, h('span.count', String(byChapter.get(ch.id).length))),
      byChapter.get(ch.id).map(s => h('div.book-source',
        h('button.book-source-head', { type: 'button', title: `${s.chapterId} · ${s.id} · ${s.title}\n원문 열기`, onclick: () => { openSource = sourceKey(s); openGuide = null; render(); } },
          h('span.type-badge', { class: `type-${s.type}` }, SOURCE_TYPES[s.type] ?? s.type),
          h('span.book-source-title', s.title),
          h('span.book-source-publisher', s.publisher || '발행처 미상'),
          h('span.book-source-id', `${s.chapterId} · ${s.id}`))))));
    return h('div.book-source-list',
      guidesGroup(bookId, book.guides, { open: g => { openGuide = g.id; openSource = null; render(); }, changed: reload, dropHint: false }), // 이 열에 놓은 파일은 기준 문서로 올라가지 않는다
      h('h3.book-source-chapter.book-source-part', '장별 원문', h('span.count', String(book.sources.length))),
      groups.length ? groups : h('div.empty', h('div.empty-icon', { 'aria-hidden': 'true' }, '▤'), h('p', '아직 수집한 원문이 없습니다.'), h('p.muted', '원문은 장의 작성 화면에서 수집합니다.')));
  }

  function reader(source) {
    readerHandle = readerPane(source, { docId: source.chapterId, key, body: () => readerDoc(source) });
    const at = takeReveal();
    if (at) requestAnimationFrame(() => showAnchor(at));
    return h('div.book-reader',
      h('nav.src-tabs',
        h('button.src-tab.back', { type: 'button', onclick: () => { openSource = null; render(); } }, '← 목록'),
        h('span.book-reader-pos', `${source.chapterId} · ${source.id}`)),
      readerHandle.pane);
  }

  function showAnchor(anchorId) {
    readerHandle?.setMode('body');
    const node = root.querySelector(`[data-aid="${CSS.escape(anchorId)}"]`) || root.querySelector(`[data-aid^="${CSS.escape(`${anchorId}.`)}"]`); // 블록 ID 면 그 첫 문장
    if (!node) return toast('이 원문에 없는 위치입니다.', 'error');
    node.scrollIntoView({ block: 'center' });
    flash(node, 'is-anchor-flash');
  }

  return {
    // reset: 다른 보고서·다른 화면으로 열 때 열람 중이던 것을 닫는다
    show(nextBookId, nextBook, { reset = false } = {}) {
      bookId = nextBookId;
      book = nextBook;
      if (reset) openSource = openGuide = readerHandle = null;
      render();
    },
    // 2열 답의 원문 위치 링크 — 그 원문을 열고, 위치가 있으면 본문 보기로 돌려 비춘다
    openSource(chapterId, sourceId, anchorId = null) {
      if (!book.sources.some(s => s.chapterId === chapterId && s.id === sourceId)) return toast('이 보고서에 없는 원문입니다.', 'error');
      openSource = `${chapterId}/${sourceId}`;
      openGuide = null;
      reveal = anchorId;
      render();
    },
    // 2열 답의 기준 문서 위치 링크(G-003 · G-003.b12.s2) — 그 문서를 열고, 위치가 있으면 비춘다
    openGuide(guideId, anchorId = null) {
      if (!book.guides.some(g => g.id === guideId)) return toast('이 보고서에 없는 기준 문서입니다.', 'error');
      openGuide = guideId;
      openSource = null;
      reveal = anchorId;
      render();
    },
  };
}
