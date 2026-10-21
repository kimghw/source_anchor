// 원문 하나의 참조·메모 목록 (FR-PL-012, FR-WB-080) — 보고서 문장이 인용한 원문 위치(근거)와 작성자 메모(DR-PL-003)를
// 원문 위치(앵커)마다 하나로 모아 원문 순서대로 번호를 붙인다. 본문 보기·웹 스냅샷·PDF 표시와 참조 띠가 모두 이 목록을 쓴다.
import { allSentences, anchorLoc, buildAnchorIndex } from '../public/shared/model.js';

// owner: 장 { doc, evidence } · source: 그 장의 원문 → [{ n, anchorId, kind, text, row?, column?, loc, page, slide, cites: [{ id, text }], notes: [{ id, text, at }] }]
export function sourceMarks(owner, source) {
  const anchors = buildAnchorIndex([source]);
  const byAnchor = new Map();
  const get = id => {
    if (!byAnchor.has(id)) byAnchor.set(id, { anchorId: id, cites: [], notes: [] });
    return byAnchor.get(id);
  };
  for (const s of allSentences(owner.doc)) {
    for (const evId of s.evidence || []) {
      const ev = owner.evidence?.[evId];
      if (ev?.sourceId === source.id && anchors.has(ev.anchorId)) get(ev.anchorId).cites.push({ id: s.id, text: s.text });
    }
  }
  for (const note of source.notes || []) if (anchors.has(note.anchorId)) get(note.anchorId).notes.push({ id: note.id, text: note.text, at: note.at });
  const order = [...anchors.keys()];
  return [...byAnchor.values()]
    .sort((a, b) => order.indexOf(a.anchorId) - order.indexOf(b.anchorId))
    .map((m, i) => {
      const a = anchors.get(m.anchorId);
      return {
        n: i + 1,
        ...m,
        kind: a.kind,
        text: a.kind === 'sentence' ? a.sentence.text : a.cell.text,
        ...(a.kind === 'cell' ? { row: a.row.header, column: a.column } : {}),
        loc: anchorLoc(a),
        page: a.block.loc?.page ?? null,
        slide: a.block.loc?.slide ?? null,
      };
    });
}
