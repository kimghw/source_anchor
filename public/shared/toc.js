// 목차(장 목록)의 수준(헤딩 단계)과 순서 규칙 — 0열 장 탐색기(브라우저)와 목차 저장(서버)이 함께 쓴다 (FR-WB-079).
// 장은 평평한 배열이고 level(1 ~ MAX_LEVEL)로 상·하위를 나타낸다. 첫 장은 1, 각 장은 바로 앞 장의 수준 + 1 을 넘지 않는다.
// 장을 옮기면(순서·수준) 그 장의 하위 장(바로 뒤에 이어지는 더 깊은 장들)이 함께 움직인다.
// 양식 문서의 헤딩을 장 후보로 고르는 규칙(headingCandidates)도 여기 둔다 — 목차 후보 대화상자(브라우저)와 서버가 같은 판단을 한다 (FR-WB-093).
export const MAX_LEVEL = 3;

// 수준을 규칙 안으로 맞춘다 — 저장할 때와 불러올 때 항상 거친다
export function normalizeLevels(list) {
  let prev = 0;
  return list.map(ch => {
    const wanted = Number.isInteger(ch.level) ? ch.level : Math.trunc(Number(ch.level)) || 1;
    const level = Math.max(1, Math.min(wanted, prev + 1, MAX_LEVEL));
    prev = level;
    return { ...ch, level };
  });
}

// i 번째 장의 하위 장이 끝나는 자리(그다음 index)
export function subtreeEnd(list, i) {
  let end = i + 1;
  while (end < list.length && list[end].level > list[i].level) end++;
  return end;
}

// 같은 상위 장 아래의 이웃(형제) — 없으면 -1
function prevSibling(list, i) {
  let j = i - 1;
  while (j >= 0 && list[j].level > list[i].level) j--;
  return j >= 0 && list[j].level === list[i].level ? j : -1;
}
function nextSibling(list, i) {
  const end = subtreeEnd(list, i);
  return end < list.length && list[end].level === list[i].level ? end : -1;
}

export const canMoveUp = (list, i) => prevSibling(list, i) >= 0;
export const canMoveDown = (list, i) => nextSibling(list, i) >= 0;
export const canPromote = (list, i) => list[i].level > 1;
export function canDemote(list, i) {
  if (i === 0 || list[i].level > list[i - 1].level) return false;
  const deepest = Math.max(...list.slice(i, subtreeEnd(list, i)).map(ch => ch.level));
  return deepest < MAX_LEVEL;
}

// 장을 하위 장과 함께 앞 이웃의 앞으로 옮긴다
export function moveUp(list, i) {
  const j = prevSibling(list, i);
  if (j < 0) return list;
  const end = subtreeEnd(list, i);
  return [...list.slice(0, j), ...list.slice(i, end), ...list.slice(j, i), ...list.slice(end)];
}

// 장을 하위 장과 함께 뒤 이웃의 뒤로 옮긴다
export function moveDown(list, i) {
  const k = nextSibling(list, i);
  if (k < 0) return list;
  const end = subtreeEnd(list, k);
  return [...list.slice(0, i), ...list.slice(k, end), ...list.slice(i, k), ...list.slice(end)];
}

// 수준을 하위 장과 함께 한 단계 올리거나(상위로, -1) 내린다(하위로, +1)
export function shiftLevel(list, i, delta) {
  if (delta < 0 ? !canPromote(list, i) : !canDemote(list, i)) return list;
  const end = subtreeEnd(list, i);
  return list.map((ch, k) => (k >= i && k < end ? { ...ch, level: ch.level + delta } : ch));
}

// 장 하나를 목차의 자리에 끼운다 — after 는 장 ID(그 장 바로 뒤) · 'start' · 'end'(없거나 모르는 ID 도 끝). 수준은 normalizeLevels 가 맞춘다 (FR-WB-076)
export function insertAfter(list, item, after) {
  let at = list.length;
  if (after === 'start') at = 0;
  else if (after && after !== 'end') {
    const i = list.findIndex(ch => ch.id === after);
    if (i >= 0) at = i + 1;
  }
  return [...list.slice(0, at), item, ...list.slice(at)];
}

// 장을 하위 장과 함께 다른 자리로 옮긴다 — after 는 장 ID(그 장 바로 뒤) · 'start' · 'end' · null(자리는 그대로). level 이 있으면 그 수준으로(하위 장도 같은 만큼).
// 자기 자신·자기 하위 장 뒤로는 옮길 수 없고, 기준 장이 없으면 null. 결과는 규칙 안으로 맞춘 목록 (FR-WB-076, 079)
export function moveAfter(list, id, after, level = null) {
  const i = list.findIndex(ch => ch.id === id);
  if (i < 0) return null;
  const end = subtreeEnd(list, i);
  const block = list.slice(i, end);
  const rest = [...list.slice(0, i), ...list.slice(end)];
  let at = i;
  if (after === 'start') at = 0;
  else if (after === 'end') at = rest.length;
  else if (after) {
    const j = rest.findIndex(ch => ch.id === after);
    if (j < 0) return null;
    at = j + 1;
  }
  const delta = level == null ? 0 : level - block[0].level;
  const moved = block.map(ch => ({ ...ch, level: Math.max(1, Math.min(MAX_LEVEL, ch.level + delta)) }));
  return normalizeLevels([...rest.slice(0, at), ...moved, ...rest.slice(at)]);
}

// 목차 번호 — "1", "1.1", "1.2", "2" … (규칙에 맞는 목록을 전제한다)
export function outlineNumbers(list) {
  const counters = [];
  return list.map(ch => {
    counters.length = ch.level;
    counters[ch.level - 1] = (counters[ch.level - 1] || 0) + 1;
    return counters.join('.');
  });
}

// 형제 묶음을 함께 맞춘다 — 앞 장보다 두 단계 넘게 깊은 장이 오면 그 장만이 아니라 그 뒤로 이어지는 같은 깊이 이상의 장들(형제와 그 하위)을 같은 만큼 함께 올린다.
// 문서에서 뽑은 후보처럼 상위 제목이 빠진 묶음(「7.」 아래 「(2)」「(3)」)에 쓴다 — normalizeLevels 는 첫 장만 올려 「(3)」이 「(2)」의 하위가 되지만 여기서는 형제로 남는다.
// prev 는 앞에 이미 있는 장의 수준(없으면 0). 결과는 normalizeLevels 를 거쳐도 바뀌지 않는다 (FR-WB-093)
export function normalizeGroups(list, prev = 0) {
  const groups = []; // 올린 묶음 — { depth: 묶음이 시작된 깊이, shift: 그 깊이부터 올리는 단수 }
  return list.map(ch => {
    const wanted = Math.max(1, Math.min(MAX_LEVEL, Number.isInteger(ch.level) ? ch.level : Math.trunc(Number(ch.level)) || 1));
    while (groups.length && wanted < groups.at(-1).depth) groups.pop(); // 묶음보다 얕은 장이 오면 그 묶음은 끝난다
    const shift = groups.at(-1)?.shift ?? 0;
    let level = wanted - shift;
    if (level > prev + 1) {
      groups.push({ depth: wanted, shift: shift + level - (prev + 1) });
      level = prev + 1;
    }
    prev = Math.max(1, level);
    return { ...ch, level: prev };
  });
}

// 양식 문서(form.nodes)의 헤딩 노드를 장 후보로 — 문서 순서, i 는 nodes 안의 index (FR-WB-093).
// title 은 공백을 정리하고 뒤의 「※ …」 작성 안내를 뗀 것(떼면 비는 제목은 떼기 전 것) — 화면에서 고칠 수 있고 원문 text 는 툴팁에 쓴다.
// by 는 헤딩의 출처('outline' 문단 개요 수준 · 'style' 제목 스타일 · 'text' 글 모양 규칙 · 'user' 작성자가 제목으로 바꾼 것 · 'rule' 구조 규칙이 제목으로 맞춘 것, 없으면 'text'), depth 는 자르지 않은 깊이(없으면 level).
// by 가 없어도 필드였던 노드(orig.kind 'field')를 작성자(user)·규칙(rule)이 제목으로 바꿨으면 그 출처로 본다 (FR-WB-094, 095).
// 기본 선택: 개요·스타일·작성자·규칙 헤딩이 하나라도 있으면 그것만(깊이 ≤ MAX_LEVEL) 고르고 글 헤딩은 후보로만 둔다 — 없으면 글 헤딩을 모두 고른다.
const HEADING_BY = ['outline', 'style', 'text', 'user', 'rule'];
const madeBy = node => (node.orig?.kind === 'field' ? (node.user ? 'user' : node.rule ? 'rule' : null) : null);
export function headingCandidates(nodes) {
  const found = [];
  (Array.isArray(nodes) ? nodes : []).forEach((node, i) => {
    if (node?.kind !== 'heading') return;
    const text = String(node.text ?? '');
    const clean = text.replace(/\s+/g, ' ').trim();
    const level = Math.max(1, Math.min(MAX_LEVEL, Math.trunc(Number(node.level)) || 1));
    const depth = Number.isInteger(node.depth) && node.depth >= 1 ? node.depth : level;
    found.push({ i, text, title: clean.replace(/\s*※.*$/, '') || clean, level, depth, by: HEADING_BY.includes(node.by) ? node.by : madeBy(node) ?? 'text', selected: false });
  });
  const structured = found.some(c => c.by !== 'text');
  for (const c of found) c.selected = structured ? c.by !== 'text' && c.depth <= MAX_LEVEL : true;
  return found;
}
