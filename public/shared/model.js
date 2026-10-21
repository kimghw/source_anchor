// 원문 구조(자료 → 블록 → 문장·표 셀)와 근거 레코드 — 브라우저와 서버가 같은 파일을 쓴다.
//
// 자료   S-001            { id, version, type: pdf|web|pptx|text, title, publisher, publishedAt, url, collectedAt, hash, blocks }
// 블록   S-001.b7         { id, kind: heading|paragraph|list|table|note, loc: { page | slide | para }, sentences, table? }
// 문장   S-001.b7.s2      { id, text }
// 표 셀  S-001.b7.r1c3    { id, text, value }   ← 문장과 셀을 합쳐 "앵커"라고 부른다
// 근거   E-0001           { id, sourceId, version, blockId, anchorId, anchorKind, loc, quote, figure? }

import { parseNumber, splitSentences } from './text.js';

export const SOURCE_TYPES = { pdf: 'PDF', web: '웹', pptx: 'PPT', text: '텍스트' };

// 블록 초안 [{ kind, loc, text | items | table, key? }] 에 ID 를 붙여 자료 블록으로 만든다
export function buildBlocks(sourceId, drafts) {
  return drafts.map((d, i) => {
    const id = `${sourceId}.b${i + 1}`;
    const block = { id, kind: d.kind, loc: d.loc || {}, ...(d.level ? { level: d.level } : {}), ...(d.key ? { key: d.key } : {}) };
    const texts = d.kind === 'list' ? d.items : d.kind === 'table' ? d.table.notes || [] : d.kind === 'heading' ? [d.text] : splitSentences(d.text);
    block.sentences = texts.map((text, j) => ({ id: `${id}.s${j + 1}`, text: String(text).trim() })).filter(s => s.text);
    if (d.kind === 'table') {
      const t = d.table;
      block.table = {
        title: t.title || '',
        unit: t.unit || '',
        denominator: t.denominator || '',
        periodIn: t.periodIn || 'columns',
        columns: t.columns,
        rows: t.rows.map((row, r) => ({
          header: String(row[0]),
          cells: row.slice(1).map((text, c) => ({ id: `${id}.r${r + 1}c${c + 1}`, text: String(text), value: parseNumber(text) })),
        })),
      };
    }
    return block;
  });
}

export function buildAnchorIndex(sources) {
  const index = new Map();
  for (const source of sources) {
    for (const block of source.blocks) {
      for (const sentence of block.sentences || []) index.set(sentence.id, { kind: 'sentence', source, block, sentence });
      block.table?.rows.forEach(row => row.cells.forEach((cell, c) => {
        index.set(cell.id, { kind: 'cell', source, block, row, cell, column: block.table.columns[c + 1] });
      }));
    }
  }
  return index;
}

export function blockLoc(source, block) {
  const loc = block.loc || {};
  if (loc.page != null) return `p.${loc.page}`;
  if (loc.slide != null) return `슬라이드 ${loc.slide}`;
  if (loc.para != null) return `문단 ${loc.para}`;
  return '';
}

export function anchorLoc(anchor) {
  const parts = [blockLoc(anchor.source, anchor.block)];
  if (anchor.block.table) parts.push(anchor.block.table.title || '표');
  if (anchor.kind === 'cell') parts.push(`${anchor.row.header} × ${anchor.column}`);
  else if (anchor.block.table) parts.push('주석');
  return parts.filter(Boolean).join(' · ');
}

export function anchorText(anchor) {
  if (anchor.kind === 'sentence') return anchor.sentence.text;
  const unit = anchor.block.table.unit;
  return `${anchor.row.header} · ${anchor.column}: ${anchor.cell.text}${unit ? ' ' + unit : ''}`;
}

// 앵커에서 근거 레코드(ID 제외)를 만든다. 표 셀이면 값·단위·기간·대상·분모를 함께 남긴다.
export function evidenceFromAnchor(index, anchorId) {
  const a = index.get(anchorId);
  if (!a) return null;
  const ev = {
    sourceId: a.source.id,
    version: a.source.version,
    blockId: a.block.id,
    anchorId,
    anchorKind: a.kind,
    loc: anchorLoc(a),
    quote: anchorText(a),
  };
  if (a.kind === 'cell' && a.cell.value != null) {
    const t = a.block.table;
    const byColumn = t.periodIn !== 'rows';
    ev.figure = {
      value: a.cell.value,
      display: a.cell.text,
      unit: t.unit,
      period: byColumn ? a.column : a.row.header,
      subject: byColumn ? a.row.header : a.column,
      denominator: t.denominator,
      tableTitle: t.title,
    };
  }
  return ev;
}

// 표 셀을 편집기로 넘겼을 때 넣을 문장 초안 — 사용자가 다듬는 것을 전제로 값·단위·기간·대상만 정확히 옮긴다
export function draftFromEvidence(ev) {
  if (!ev.figure) return ev.quote;
  const f = ev.figure;
  return `${f.subject}${topicParticle(f.subject)} ${f.period} 기준 ${f.display}${f.unit}이다.`;
}

// 마지막 글자에 받침이 있으면 "은", 없으면 "는". 한글로 끝나지 않으면 둘 다 적는다.
function topicParticle(word) {
  const code = String(word).trim().charCodeAt(String(word).trim().length - 1) - 0xac00;
  if (!(code >= 0 && code <= 11171)) return '은(는)';
  return code % 28 ? '은' : '는';
}

export function nextId(prefix, existingIds, width = 4) {
  let max = 0;
  for (const id of existingIds) {
    const m = String(id).match(new RegExp(`^${prefix}-(\\d+)$`));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${String(max + 1).padStart(width, '0')}`;
}

export function allSentences(doc) {
  return doc.blocks.flatMap(b => b.sentences);
}

// 본문의 제목(헤딩) 블록 — 장 탐색기가 세부 항목으로 보여 준다. 제목의 첫 문장 ID 로 그 자리를 찾는다 (FR-WB-061)
export function docHeadings(doc) {
  return (doc?.blocks || []).filter(b => b.kind === 'heading' && b.sentences?.length).map(b => ({ id: b.sentences[0].id, text: b.sentences.map(s => s.text).join(' ') }));
}
