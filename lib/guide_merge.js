// 기준 문서 합치기의 본문 (FR-WB-099, DR-WB-006) — 끌어 온 문서(member)의 블록을 놓은 문서(target)의 식별자로 다시 매겨 뒤에 잇는다.
// 앞 본문의 ID 는 그대로 두고, 붙는 블록은 블록 번호·쪽·슬라이드·문단 순번을 앞 본문의 마지막 값에 이어서 매긴다 —
// 등록 때 ID(G-007.b41 → G-006.b<앞 마지막 b + 41>)는 블록 번호를, 에이전트 변환 ID(G-007.p21.b3 → G-006.p<앞 마지막 쪽 + 21>.b3)는 쪽을 잇는다.
// 문장·표 칸 ID 는 블록 ID 를 따라간다. 구조 계층은 합친 본문 전체로 다시 정한다 — structure 는 앞에서부터 한 번 훑으므로 앞 본문의 결과는 그대로다.
// 입력은 고치지 않는다(되돌리기용 보관본이 그대로 남아야 한다). store·파일을 모르는 순수 함수 — lib/guides.js 가 보관 파일과 함께 쓴다.
import { structure } from './guide_outline.js';

const BLOCK_ID = /\.(?:p(\d+)\.)?b(\d+)$/;
const LOCS = ['page', 'slide', 'para'];
const highest = values => values.reduce((max, v) => Math.max(max, Number(v) || 0), 0);

export function mergeBlocks(target, member) {
  const ids = target.blocks.map(b => BLOCK_ID.exec(b.id) || []);
  const shift = Object.fromEntries(LOCS.map(key => [key, highest(target.blocks.map(b => b.loc?.[key]))]));
  shift.page = Math.max(shift.page, highest(ids.map(m => m[1])));
  const blockBase = highest(ids.filter(m => m[2] && !m[1]).map(m => m[2]));
  const moved = member.blocks.map(block => {
    const m = BLOCK_ID.exec(block.id);
    if (!m) throw new Error(`블록 ID 를 읽지 못했습니다: ${block.id}`);
    const id = m[1] ? `${target.id}.p${Number(m[1]) + shift.page}.b${m[2]}` : `${target.id}.b${Number(m[2]) + blockBase}`;
    const copy = structuredClone(block);
    const rename = x => { x.id = id + x.id.slice(block.id.length); };
    copy.id = id;
    copy.sentences?.forEach(rename);
    copy.table?.rows.forEach(row => row.cells.forEach(rename));
    for (const key of LOCS) if (copy.loc?.[key] != null) copy.loc[key] += shift[key];
    return copy;
  });
  return structure([...structuredClone(target.blocks), ...moved]);
}

// 합친 문서에 든 원래 문서 수 — 놓은 문서 하나 + 붙은 문서마다 그 안에 든 수
export const mergedCount = guide => 1 + (guide.merges || []).reduce((sum, m) => sum + (m.docs || 1), 0);
