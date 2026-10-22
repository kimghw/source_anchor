// 기준 문서의 구조 계층 (DR-WB-006) — 문장 ID 를 정할 때(등록·에이전트 변환·옛 문서를 처음 읽을 때) 함께 정한다.
//   구조 마디: 제목 블록 + 인쇄된 번호로 시작하는 문단 블록(1.1.1 · 1.1 · 1. · 제3조 · ① · 가. · (1) · (a) …)
//   번호로 시작하는 목록 항목은 itemNodes 가 항목 하나씩 문단 블록(item 표시)으로 떼어 마디가 된다 — 그 점 번호는 제목·문단의 점 번호와 따로 익힌다
//   (규칙집의 제목 「101. General」 아래 항목 「1. Application」이 같은 「한 마디 점 번호」라 형제가 되지 않게)
//   블록 필드: parent(상위 마디의 블록 ID, 맨 위면 null) — 마디는 depth(맨 위 1)·number(인쇄된 번호, 없으면 '')도 갖는다
// 깊이는 번호 체계로 정한다. Part·편 < Chapter·장 < Section·절·Appendix·Annex < 관 은 고정 순위, 점 번호는 마디 수만큼 아래(1 < 1.1 < 1.1.1),
// 그 밖의 체계(조·①·가.·(1)·번호 없는 제목의 # 수준 …)는 문서에서 처음 나온 자리의 바로 아래 순위로 익혀 두고 다시 나오면 같은 순위로 본다.
// 열린 마디 가운데 순위가 같거나 아래인 것을 닫고 붙이므로, 20쪽 묶음을 따로 옮겨도 문서 전체를 한 줄로 이어 같은 규칙으로 정해진다.
// store·화면을 모르는 순수 함수 — lib/guides.js(등록·읽기)·lib/guide_convert.js(조립)·lib/source_md.js(구조 목록)·agent.js(블록별 위치)가 쓴다.

// 제목에서만 보는 고정 순위 체계 — 문단 첫머리의 "Part of …"·"Section 3 applies …" 를 마디로 잘못 보지 않게 대소문자를 가린다
const FIXED = [
  [/^(?:PART|Part|Pt\.?)\s+(?:[A-Z]|\d{1,3}|[IVX]{1,4})\b/, 1],
  [/^(?:CHAPTER|Chapter|Ch\.?)\s+\d{1,3}[A-Z]?\b/, 2],
  [/^(?:SECTION|Section|Sec\.?|APPENDIX|Appendix|ANNEX|Annex)\s+(?:\d{1,3}[A-Z]?|[A-Z]|[IVX]{1,4})\b/, 3],
];
// 제목·문단 모두에서 보는 체계 — [이름, 정규식, 고정 순위(없으면 익힌다)]
const MARKS = [
  ['편', /^제\s*\d+\s*편/, 1], ['장', /^제\s*\d+\s*장/, 2], ['절', /^제\s*\d+\s*절/, 3], ['관', /^제\s*\d+\s*관/, 4],
  ['조', /^제\s*\d+\s*조(?:의\s*\d+)?/, null],
  ['roman', /^[IVX]{1,5}\.(?=\s)/, null],
  ['hangul', /^[가-하]\.(?=\s)/, null],
  ['hangul-paren', /^\(?[가-하]\)(?=\s)/, null],
  ['paren', /^\(\d{1,3}\)(?=\s)/, null],
  ['paren-upper', /^\([A-Z]\)(?=\s)/, null],
  ['paren-lower', /^\([a-z]\)(?=\s)/, null],
  ['alpha-paren', /^[a-z]\)(?=\s)/, null],
  ['num-paren', /^\d{1,3}\)(?=\s)/, null],
  ['circled', /^[①-⑳]/, null],
  ['alpha', /^[A-Z]\.(?=\s)/, null],
];
const DOTTED = /^(\d{1,3}(?:\.\d{1,3})*)(\.?)(?=\s|$)/;

// 블록 글 — 문장을 잇는다(등록 때 본문은 문장 나누기가 「가.」 같은 번호를 따로 떼어 낼 수 있다)
const blockText = block => (block.sentences || []).map(s => s.text).join(' ');

// 블록이 구조 마디인지 — { style, number, rank?, segments? } 또는 null
function markOf(block) {
  const heading = block.kind === 'heading';
  if (!heading && block.kind !== 'paragraph') return null;
  const text = blockText(block).trim();
  if (!text) return null;
  if (heading) for (const [re, rank] of FIXED) {
    const m = text.match(re);
    if (m) return { style: `fixed${rank}`, number: m[0], rank };
  }
  for (const [style, re, rank] of MARKS) {
    const m = text.match(re);
    if (m) return { style, number: m[0].trim(), ...(rank ? { rank } : {}) };
  }
  const dotted = text.match(DOTTED);
  // 문단은 1.1 처럼 두 마디 이상이거나 "1." 처럼 점으로 끝나야 번호로 본다 — "50 V installations …" 같은 문장 첫 숫자는 마디가 아니다
  if (dotted && (heading || dotted[1].includes('.') || dotted[2])) {
    const segments = dotted[1].split('.').length;
    return block.item ? { style: `item-num${segments}`, number: dotted[1] + dotted[2] } : { style: 'num', number: dotted[1] + dotted[2], segments };
  }
  return heading ? { style: `h${block.level || 1}`, number: '' } : null;
}

// 문단 첫머리가 구조 마디 번호인지 — 텍스트 파일을 문단으로 나눌 때 쓴다 (lib/guide_formats.js)
export const startsNode = line => Boolean(markOf({ kind: 'paragraph', sentences: [{ text: line }] }));

// 블록 초안에서 인쇄된 번호로 시작하는 목록 항목을 항목 하나씩 문단 초안(item: true)으로 뗀다 — 번호 없는 항목이 이어지면 목록으로 남긴다 (DR-WB-006).
// 등록(lib/guides.js)과 에이전트 변환 조립(lib/guide_convert.js)이 구조를 정하기 전에 쓴다
export const itemNodes = drafts => drafts.flatMap(d => {
  if (d.kind !== 'list') return [d];
  const out = [];
  let run = null;
  for (const item of d.items) {
    if (startsNode(item)) {
      run = null;
      out.push({ kind: 'paragraph', loc: d.loc, text: item, item: true });
    } else if (run) run.items.push(item);
    else out.push(run = { kind: 'list', loc: d.loc, items: [item] });
  }
  return out;
});

// 블록 목록에 parent·depth·number 를 적는다(다시 불러도 같다) → 같은 배열
export function structure(blocks) {
  const learned = new Map();
  let numBase = null; // 한 마디 점 번호(1, 2 …)의 순위 — 처음 나온 점 번호로 정한다
  const open = []; // 열린 마디 [{ id, rank }]
  for (const block of blocks) {
    delete block.depth;
    delete block.number;
    const mark = markOf(block);
    if (!mark) {
      block.parent = open.at(-1)?.id ?? null;
      continue;
    }
    const below = open.length ? open.at(-1).rank + 1 : 1;
    let rank = mark.rank;
    if (mark.style === 'num') {
      numBase ??= below - (mark.segments - 1);
      rank = numBase + mark.segments - 1;
    } else if (rank == null) {
      if (!learned.has(mark.style)) learned.set(mark.style, below);
      rank = learned.get(mark.style);
    }
    while (open.length && open.at(-1).rank >= rank) open.pop();
    block.parent = open.at(-1)?.id ?? null;
    block.depth = open.length + 1;
    block.number = mark.number;
    open.push({ id: block.id, rank });
  }
  return blocks;
}

export const isStructured = blocks => blocks.every(b => 'parent' in b);

// 마디의 이름 — 인쇄된 번호, 없으면 제목 앞부분
const short = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
export const nodeLabel = block => block.number || short(blockText(block), 30);
export const nodeTitle = block => short(blockText(block), 80);

// 블록마다 구조 위치 — 위에서부터 마디 이름을 › 로 잇는다(마디 자신을 포함). 마디가 없는 문서는 빈 지도
export function structurePaths(blocks) {
  const byId = new Map(blocks.map(b => [b.id, b]));
  const memo = new Map();
  const chain = id => {
    if (!id || !byId.has(id)) return [];
    if (!memo.has(id)) memo.set(id, [...chain(byId.get(id).parent), nodeLabel(byId.get(id))]);
    return memo.get(id);
  };
  const paths = new Map();
  for (const b of blocks) {
    const path = b.depth ? chain(b.id) : chain(b.parent);
    if (path.length) paths.set(b.id, path.join(' › '));
  }
  return paths;
}

// 구조 마디 목록 — [{ id, depth, number, title, parent, loc }] (loc 은 부르는 쪽이 넘긴 함수로)
export const outlineOf = (blocks, locOf = () => '') => blocks.filter(b => b.depth).map(b => ({ id: b.id, depth: b.depth, number: b.number, title: nodeTitle(b), parent: b.parent, loc: locOf(b) }));
