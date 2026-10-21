// 원문 본문을 읽기 전용으로 그린다 — 보고서 화면의 3열·떠 있는 창(book.js)과 기준 문서 열람(book_guides.js)이 함께 쓴다 (FR-WB-075, 085).
// 문장·표 셀은 고르거나 끌 수 없다(작성 화면의 원문 열과 다르다). 문장마다 원문 위치 ID 를 붙여 참조·메모 표시(source_view.js decorateBody)가 자리를 찾는다.
// 페이지(PDF)·슬라이드(PPT)가 바뀌는 곳에 표시를 넣는다.
// onPick({ anchorId, text, kind: 'sentence' | 'cell' | 'table', block }) 을 주면 문장·표 셀을 눌러 고를 수 있고 표마다 "표 넣기" 버튼이 붙는다 — 사용자 지정 문서 (FR-WB-088)
import { blockLoc } from '../shared/model.js';
import { alignedNumber, fractionWidth, h, isNumeric } from './util.js';

export function readerDoc(source, { onPick = null } = {}) {
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
    container.append(blockNode(source, block, loc, onPick));
  }
  return doc;
}

// 고를 수 있는 조각의 속성 — 누르거나 Enter 로 고른다
const pickable = (onPick, pick) => (onPick ? { class: 'is-pickable', role: 'button', tabIndex: 0, title: '누르면 문서에 넣습니다', onclick: () => onPick(pick), onkeydown: event => { if (event.key === 'Enter') onPick(pick); } } : {});
const sentenceSpan = (s, block, onPick) => h('span.src-ro', { dataset: { aid: s.id }, ...pickable(onPick, { anchorId: s.id, text: s.text, kind: 'sentence', block }) }, s.text);
const spans = (block, onPick) => block.sentences.flatMap((s, i) => (i ? [' ', sentenceSpan(s, block, onPick)] : [sentenceSpan(s, block, onPick)]));

function blockNode(source, block, loc, onPick) {
  if (block.kind === 'heading') return h(`h${Math.min(block.level || 2, 3) + 2}.src-h`, spans(block, onPick));
  if (block.kind === 'list') return h('ul.src-list', block.sentences.map(s => h('li', sentenceSpan(s, block, onPick))));
  if (block.kind === 'table' && block.table) return tableNode(block, onPick);
  return h('p.src-p', source.type !== 'pdf' && source.type !== 'pptx' && h('span.para-loc', loc), spans(block, onPick));
}

function tableNode(block, onPick) {
  const t = block.table;
  const cols = t.columns || [];
  const rows = t.rows || [];
  const widths = cols.slice(1).map((_, c) => fractionWidth(rows.map(row => row.cells[c]?.text)));
  return h('figure.src-table', { dataset: { block: block.id } },
    h('figcaption', h('span', t.title || '표'), t.unit && h('span.unit', `단위: ${t.unit}`),
      onPick && h('button.btn.small.ghost.pick-table', { type: 'button', title: '이 표를 통째로 Markdown 표로 문서에 넣습니다', onclick: () => onPick({ anchorId: block.id, text: t.title || '표', kind: 'table', block }) }, '표 넣기')),
    h('div.table-wrap', h('table.num-table',
      h('thead', h('tr', cols.map((name, i) => h(i ? 'th.is-num' : 'th', name)))),
      h('tbody', rows.map(row => h('tr',
        h('th', { scope: 'row' }, row.header),
        row.cells.map((cell, c) => h('td.src-ro-cell', { class: isNumeric(cell.text) ? 'is-num' : '', dataset: { aid: cell.id }, ...pickable(onPick, { anchorId: cell.id, text: cell.text, kind: 'cell', block }) }, alignedNumber(cell.text, widths[c])))))))),
    block.sentences.map(s => h('p.src-note', sentenceSpan(s, block, onPick))));
}
