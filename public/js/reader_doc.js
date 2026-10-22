// 원문 본문을 읽기 전용으로 그린다 — 보고서 화면의 3열·떠 있는 창(book.js)과 기준 문서 열람(book_guides.js), 양식·데이터 분석 화면의 3열(report_sources.js)이 함께 쓴다 (FR-WB-075, 085).
// 문장·표 셀은 고르거나 끌 수 없다(작성 화면의 원문 열과 다르다). 문장마다 원문 위치 ID 를 붙여 참조·메모 표시(source_view.js decorateBody)와 위치 링크가 자리를 찾는다.
// 페이지(PDF)·슬라이드(PPT)가 바뀌는 곳에 표시를 넣는다.
import { blockLoc } from '../shared/model.js';
import { alignedNumber, fractionWidth, h, isNumeric } from './util.js';

export function readerDoc(source) {
  const doc = h('div.src-doc', { class: `src-${source.type}` });
  let container = doc;
  let lastLoc = null;
  for (const block of source.blocks) {
    const loc = blockLoc(source, block);
    if (loc !== lastLoc) {
      lastLoc = loc;
      if (source.type === 'pptx') doc.append(container = h('section.slide', h('div.loc-mark', loc)));
      else if (source.type === 'pdf') doc.append(h('div.loc-mark.page-mark', loc));
    }
    container.append(blockNode(source, block, loc));
  }
  return doc;
}

const sentenceSpan = s => h('span.src-ro', { dataset: { aid: s.id } }, s.text);
const spans = block => block.sentences.flatMap((s, i) => (i ? [' ', sentenceSpan(s)] : [sentenceSpan(s)]));

function blockNode(source, block, loc) {
  if (block.kind === 'heading') return h(`h${Math.min(block.level || 2, 3) + 2}.src-h`, spans(block));
  if (block.kind === 'list') return h('ul.src-list', block.sentences.map(s => h('li', sentenceSpan(s))));
  if (block.kind === 'table' && block.table) return tableNode(block);
  return h('p.src-p', source.type !== 'pdf' && source.type !== 'pptx' && h('span.para-loc', loc), spans(block));
}

function tableNode(block) {
  const t = block.table;
  const cols = t.columns || [];
  const rows = t.rows || [];
  const widths = cols.slice(1).map((_, c) => fractionWidth(rows.map(row => row.cells[c]?.text)));
  return h('figure.src-table', { dataset: { block: block.id } },
    h('figcaption', h('span', t.title || '표'), t.unit && h('span.unit', `단위: ${t.unit}`)),
    h('div.table-wrap', h('table.num-table',
      h('thead', h('tr', cols.map((name, i) => h(i ? 'th.is-num' : 'th', name)))),
      h('tbody', rows.map(row => h('tr',
        h('th', { scope: 'row' }, row.header),
        row.cells.map((cell, c) => h('td.src-ro-cell', { class: isNumeric(cell.text) ? 'is-num' : '', dataset: { aid: cell.id } }, alignedNumber(cell.text, widths[c])))))))),
    block.sentences.map(s => h('p.src-note', sentenceSpan(s))));
}
