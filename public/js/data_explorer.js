// 데이터 분석 화면 3열 — 자료 탐색기 (FR-WB-107). 작업공간의 모든 보고서를 파일 탐색기처럼 펼쳐 기준 문서·장별 원문·다른 분석의 결과 파일을 보고
// (이름을 누르면 읽기 전용 열람), 고르기 칸으로 그 분석의 입력 자료에 넣고 뺀다. 폴더의 칸은 그 아래 항목 전부를 넣고 빼며, 일부만 들어 있으면 그렇게 표시한다.
// 보고서 상태는 펼칠 때 받아(GET /api/book?report=…&remember=0 — 마지막 자리를 바꾸지 않는다) 기억하고, 분석의 결과 파일은 그 분석을 펼칠 때 받는다.
// 고른 것(입력 자료)은 analysis.js 가 가진다 — selected() 로 열쇠 모음을 읽고 toggle(items, on) 으로 바꾼다. 화면 모듈을 import 하지 않는다.
import { GUIDE_KINDS, guideKind } from '../shared/instructions.js';
import { SOURCE_TYPES } from '../shared/model.js';
import { outlineNumbers } from '../shared/toc.js';
import { guideReader } from './book_guides.js';
import { collapseButton } from './columns.js';
import { readerDoc } from './reader_doc.js';
import { readerPane } from './source_view.js';
import { api } from './state.js';
import { fill, flash, h, toast } from './util.js';

// 입력 자료 하나를 가리키는 열쇠 — 서버(lib/analyses.js inputKey)와 같은 꼴
export const inputKey = i => (i.kind === 'result' ? `result:${i.bookId}/${i.analysisId}/${i.path}` : i.kind === 'source' ? `source:${i.bookId}/${i.chapterId}/${i.id}` : `guide:${i.bookId}/${i.id}`);
const KIND_LABEL = { source: '원문', guide: '기준 문서', result: '결과 파일' };
export const inputKindLabel = kind => KIND_LABEL[kind] || kind;
const size = n => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const resultUrl = (bookId, analysisId, rel) => `/api/books/${encodeURIComponent(bookId)}/analyses/${encodeURIComponent(analysisId)}/results/${rel.split('/').map(encodeURIComponent).join('/')}`;

// root: 3열 요소 · label: 접기 단추의 이름 · selected(): 지금 입력 자료의 열쇠 모음 · toggle(items, on): 넣기·빼기(analysis.js 가 저장한다)
// → { show({ bookId, analysisId, book }, { reset }), refresh(), openSource(보고서?, 장, 원문, 위치?), openGuide(보고서?, 문서, 위치?), openInput(입력 자료) }
export function dataExplorer(root, { label, selected, toggle }) {
  let currentBook = null; // 지금 보고서 ID
  let currentAnalysis = null; // 지금 분석 ID — 그 결과 파일은 입력 자료 후보에서 뺀다
  let books = []; // [{ id, title }] — 지금 보고서가 맨 위
  const states = new Map(); // 보고서 ID → 보고서 상태 { book, chapters, sources, guides, analyses }
  const loading = new Set(); // 받는 중인 보고서·분석
  const resultsOf = new Map(); // `보고서/분석` → [결과 파일]
  const open = new Set(); // 펼친 폴더의 열쇠
  let viewing = null; // 열람 중인 항목 { kind, bookId, chapterId?, id?, analysisId?, path? }
  let reveal = null; // 열람 화면을 그린 뒤 비출 위치
  let readerHandle = null;

  async function loadBook(bookId) {
    if (states.has(bookId) || loading.has(bookId)) return states.get(bookId);
    loading.add(bookId);
    try {
      states.set(bookId, await api('GET', `/api/book?report=${encodeURIComponent(bookId)}&remember=0`));
    } catch (err) {
      toast(`보고서를 불러오지 못했습니다: ${err.message}`, 'error');
    } finally {
      loading.delete(bookId);
    }
    return states.get(bookId);
  }

  async function loadResults(bookId, analysisId) {
    const key = `${bookId}/${analysisId}`;
    if (resultsOf.has(key) || loading.has(key)) return resultsOf.get(key);
    loading.add(key);
    try {
      resultsOf.set(key, (await api('GET', `/api/books/${encodeURIComponent(bookId)}/analyses/${encodeURIComponent(analysisId)}`)).results);
    } catch (err) {
      toast(`결과 파일 목록을 받지 못했습니다: ${err.message}`, 'error');
    } finally {
      loading.delete(key);
    }
    return resultsOf.get(key);
  }

  // ───────────────────────────── 그리기 ─────────────────────────────

  function render() {
    const scroll = root.querySelector('.data-tree')?.scrollTop ?? 0;
    fill(root,
      h('header.col-head', h('div.col-title', h('span.col-index', '3'), '자료 탐색기', h('span.count', `입력 ${selected().size}`)), h('div.col-head-actions', collapseButton(root, label))),
      viewing ? preview() : tree());
    const body = root.querySelector('.data-tree');
    if (body) body.scrollTop = scroll;
  }

  // 항목(잎)과 폴더의 입력 자료 — 폴더의 칸은 그 아래 잎을 모두 넣고 뺀다
  const sourceItem = (bookId, s) => ({ kind: 'source', bookId, chapterId: s.chapterId, id: s.id });
  const guideItem = (bookId, g) => ({ kind: 'guide', bookId, id: g.id });
  const resultItem = (bookId, analysisId, r) => ({ kind: 'result', bookId, analysisId, path: r.path });

  function check(items, { load = null } = {}) {
    const keys = selected();
    const picked = items.filter(i => keys.has(inputKey(i))).length;
    const box = h('input.dt-check', { type: 'checkbox', checked: items.length > 0 && picked === items.length, disabled: !items.length && !load, title: '이 분석의 입력 자료로 넣거나 뺍니다', 'aria-label': '입력 자료로 고르기',
      onchange: async () => toggle(load ? await load() : items, box.checked) });
    box.indeterminate = picked > 0 && picked < items.length;
    return box;
  }

  const row = (depth, parts, picked = false) => h('div.dt-row', { class: picked ? 'is-picked' : '', style: `--depth:${depth}` }, parts);
  const fold = (key, onOpen) => h('button.dt-fold', { type: 'button', 'aria-expanded': String(open.has(key)), 'aria-label': open.has(key) ? '접기' : '펼치기', onclick: async () => { if (!open.delete(key)) { open.add(key); await onOpen?.(); } render(); } }, open.has(key) ? '▾' : '▸');
  const folderName = (key, text, onOpen) => h('button.dt-name.dt-folder', { type: 'button', title: text, onclick: async () => { if (!open.delete(key)) { open.add(key); await onOpen?.(); } render(); } }, text);
  const leafName = (text, title, item) => h('button.dt-name', { type: 'button', title: `${title}\n누르면 내용을 봅니다`, onclick: () => { viewing = item; render(); } }, text);
  const empty = (depth, text) => h('div.dt-empty', { style: `--depth:${depth}` }, text);

  function tree() {
    return h('div.data-tree',
      h('p.data-hint', '고르면 이 분석의 입력 자료가 되어 에이전트가 먼저 읽습니다. 다른 보고서의 자료도 고를 수 있습니다. 이름을 누르면 내용을 봅니다.'),
      books.map(b => bookNode(b)));
  }

  function bookNode(b) {
    const key = `book:${b.id}`;
    const state = states.get(b.id);
    const load = () => loadBook(b.id);
    return [
      row(0, [fold(key, load), h('span.dt-icon', { 'aria-hidden': 'true' }, '▣'), folderName(key, b.title || b.id, load), h('span.dt-meta', b.id === currentBook ? '지금 보고서' : b.id)]),
      open.has(key) && (state ? [guidesNode(b.id, state), chaptersNode(b.id, state), analysesNode(b.id, state)] : empty(1, '불러오는 중…')),
    ];
  }

  function guidesNode(bookId, state) {
    const key = `guides:${bookId}`;
    const items = state.guides.map(g => guideItem(bookId, g));
    const keys = selected();
    return [
      row(1, [fold(key), check(items), h('span.dt-icon', { 'aria-hidden': 'true' }, '▤'), folderName(key, '기준 문서'), h('span.dt-meta', String(state.guides.length))]),
      open.has(key) && (state.guides.length
        ? state.guides.map(g => row(2, [h('span.dt-fold'), check([guideItem(bookId, g)]), h('span.dt-icon', { 'aria-hidden': 'true' }, '◇'),
          leafName(g.title, `${g.id} ${g.title}`, { kind: 'guide', bookId, id: g.id }),
          h('span.dt-meta', `${GUIDE_KINDS[guideKind(g.kind)]}${['queued', 'running'].includes(g.convert?.state) ? ' · 변환 중' : ''}`)], keys.has(inputKey(guideItem(bookId, g)))))
        : empty(2, '기준 문서가 없습니다.')),
    ];
  }

  function chaptersNode(bookId, state) {
    const key = `chapters:${bookId}`;
    const numbers = outlineNumbers(state.chapters);
    const byChapter = new Map(state.chapters.map(ch => [ch.id, []]));
    for (const s of state.sources) byChapter.get(s.chapterId)?.push(s);
    const withSources = state.chapters.map((ch, i) => ({ ch, number: numbers[i], sources: byChapter.get(ch.id) })).filter(c => c.sources.length);
    const keys = selected();
    return [
      row(1, [fold(key), check(state.sources.map(s => sourceItem(bookId, s))), h('span.dt-icon', { 'aria-hidden': 'true' }, '▤'), folderName(key, '장별 원문'), h('span.dt-meta', String(state.sources.length))]),
      open.has(key) && (withSources.length ? withSources.map(({ ch, number, sources }) => {
        const chKey = `chapter:${bookId}/${ch.id}`;
        return [
          row(2, [fold(chKey), check(sources.map(s => sourceItem(bookId, s))), h('span.dt-icon', { 'aria-hidden': 'true' }, '§'), folderName(chKey, `${number} ${ch.title}`), h('span.dt-meta', String(sources.length))]),
          open.has(chKey) && sources.map(s => row(3, [h('span.dt-fold'), check([sourceItem(bookId, s)]), h('span.type-badge', { class: `type-${s.type}` }, SOURCE_TYPES[s.type] ?? s.type),
            leafName(s.title, `${ch.id} · ${s.id} · ${s.title}${s.publisher ? ` — ${s.publisher}` : ''}`, { kind: 'source', bookId, chapterId: ch.id, id: s.id }),
            h('span.dt-meta', s.id)], keys.has(inputKey(sourceItem(bookId, s))))),
        ];
      }) : empty(2, '수집한 원문이 없습니다.')),
    ];
  }

  function analysesNode(bookId, state) {
    const key = `analyses:${bookId}`;
    const list = (state.analyses || []).filter(a => !(bookId === currentBook && a.id === currentAnalysis));
    const keys = selected();
    return [
      row(1, [fold(key), h('span.dt-check-gap'), h('span.dt-icon', { 'aria-hidden': 'true' }, '▤'), folderName(key, '데이터 분석'), h('span.dt-meta', String(list.length))]),
      open.has(key) && (list.length ? list.map(a => {
        const aKey = `analysis:${bookId}/${a.id}`;
        const results = resultsOf.get(`${bookId}/${a.id}`);
        const load = () => loadResults(bookId, a.id);
        const loadItems = async () => ((await load()) || []).map(r => resultItem(bookId, a.id, r));
        return [
          row(2, [fold(aKey, load), check((results || []).map(r => resultItem(bookId, a.id, r)), { load: results ? null : loadItems }), h('span.dt-icon', { 'aria-hidden': 'true' }, '◆'), folderName(aKey, a.title, load), h('span.dt-meta', `결과 ${a.results ?? 0}`)]),
          open.has(aKey) && (!results ? empty(3, '불러오는 중…') : results.length
            ? results.map(r => row(3, [h('span.dt-fold'), check([resultItem(bookId, a.id, r)]), h('span.dt-icon', { 'aria-hidden': 'true' }, '◇'),
              leafName(r.path, `${a.id} · ${r.path}`, { kind: 'result', bookId, analysisId: a.id, path: r.path }), h('span.dt-meta', size(r.size))], keys.has(inputKey(resultItem(bookId, a.id, r)))))
            : empty(3, '결과 파일이 없습니다.')),
        ];
      }) : empty(2, '다른 분석이 없습니다.')),
    ];
  }

  // ───────────────────────────── 열람 ─────────────────────────────

  function preview() {
    const item = viewing;
    const state = states.get(item.bookId);
    const back = () => { viewing = null; readerHandle = null; render(); };
    const picked = selected().has(inputKey(item));
    const nav = pos => h('nav.src-tabs',
      h('button.src-tab.back', { type: 'button', onclick: back }, '← 탐색기'),
      h('span.book-reader-pos', pos),
      h('button.btn.small.ghost.dt-pick', { type: 'button', onclick: () => toggle([item], !picked) }, picked ? '입력에서 빼기' : '입력에 넣기'));
    const bookTitle = state?.book.title || item.bookId;
    if (item.kind === 'source') {
      const source = state?.sources.find(s => s.chapterId === item.chapterId && s.id === item.id);
      if (!source) return h('div.book-reader', nav(`${bookTitle} · ${item.chapterId} · ${item.id}`), h('p.muted.reader-note', '이 원문을 찾지 못했습니다 — 지워졌거나 채택이 거부되었을 수 있습니다.'));
      readerHandle = readerPane(source, { docId: source.chapterId, key: 'analysis', body: () => readerDoc(source) });
      const at = reveal;
      reveal = null;
      if (at) requestAnimationFrame(() => showAnchor(at));
      return h('div.book-reader', nav(`${bookTitle} · ${source.chapterId} · ${source.id}`), readerHandle.pane);
    }
    if (item.kind === 'guide') {
      const guide = state?.guides.find(g => g.id === item.id);
      if (!guide) return h('div.book-reader', nav(`${bookTitle} · ${item.id}`), h('p.muted.reader-note', '이 기준 문서를 찾지 못했습니다.'));
      const at = reveal;
      reveal = null;
      const reader = guideReader(item.bookId, guide, { back, reveal: at });
      reader.querySelector('.src-tabs')?.replaceWith(nav(`${bookTitle} · ${guide.id}`)); // 목록 단추 대신 탐색기 단추·넣기 단추
      return reader;
    }
    const body = h('pre.result-preview', h('span.muted', '읽는 중…'));
    fetch(resultUrl(item.bookId, item.analysisId, item.path)).then(async res => {
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `읽지 못했습니다 (${res.status})`);
      body.textContent = await res.text();
    }).catch(err => { body.textContent = err.message; });
    return h('div.book-reader', nav(`${bookTitle} · ${item.analysisId} · ${item.path}`), body);
  }

  function showAnchor(anchorId) {
    readerHandle?.setMode('body');
    const node = root.querySelector(`[data-aid="${CSS.escape(anchorId)}"]`) || root.querySelector(`[data-aid^="${CSS.escape(`${anchorId}.`)}"]`); // 블록 ID 면 그 첫 문장
    if (!node) return toast('이 원문에 없는 위치입니다.', 'error');
    node.scrollIntoView({ block: 'center' });
    flash(node, 'is-anchor-flash');
  }

  // 장 ID 는 작업공간 안에서 유일하다 — 보고서 표시가 없는 링크는 지금 보고서, 그다음 받아 둔 보고서에서 찾는다
  const bookOfChapter = chapterId => [currentBook, ...states.keys()].find(id => states.get(id)?.chapters.some(ch => ch.id === chapterId));

  return {
    // 분석을 열 때 — 지금 보고서 상태(목록 books 포함)를 받는다. reset: 다른 분석·보고서면 열람·펼침을 처음으로
    show({ bookId, analysisId, book }, { reset = false } = {}) {
      if (reset) { viewing = null; readerHandle = null; open.clear(); resultsOf.clear(); }
      if (bookId !== currentBook) states.clear();
      currentBook = bookId;
      currentAnalysis = analysisId;
      states.set(bookId, book);
      books = [...(book.books || []).filter(b => b.id === bookId), ...(book.books || []).filter(b => b.id !== bookId)];
      if (!books.length) books = [{ id: bookId, title: book.book.title }];
      if (reset) open.add(`book:${bookId}`);
      render();
    },
    refresh: render,
    async openSource(bookId, chapterId, sourceId, anchorId = null) {
      const owner = bookId || bookOfChapter(chapterId) || currentBook;
      const state = await loadBook(owner);
      if (!state?.sources.some(s => s.chapterId === chapterId && s.id === sourceId)) return toast('이 원문을 찾지 못했습니다.', 'error');
      viewing = { kind: 'source', bookId: owner, chapterId, id: sourceId };
      reveal = anchorId;
      render();
    },
    async openGuide(bookId, guideId, anchorId = null) {
      const owner = bookId || currentBook;
      const state = await loadBook(owner);
      if (!state?.guides.some(g => g.id === guideId)) return toast('이 기준 문서를 찾지 못했습니다.', 'error');
      viewing = { kind: 'guide', bookId: owner, id: guideId };
      reveal = anchorId;
      render();
    },
    // 1열 입력 자료 목록에서 누를 때
    async openInput(input) {
      if (input.kind === 'source') return this.openSource(input.bookId, input.chapterId, input.id);
      if (input.kind === 'guide') return this.openGuide(input.bookId, input.id);
      await loadBook(input.bookId);
      viewing = { kind: 'result', bookId: input.bookId, analysisId: input.analysisId, path: input.path };
      render();
    },
  };
}
