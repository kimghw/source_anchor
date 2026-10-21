// 목차(장 목록)의 수준(헤딩 단계)과 순서 규칙 — 0열 장 탐색기(브라우저)와 목차 저장(서버)이 함께 쓴다 (FR-WB-079).
// 장은 평평한 배열이고 level(1 ~ MAX_LEVEL)로 상·하위를 나타낸다. 첫 장은 1, 각 장은 바로 앞 장의 수준 + 1 을 넘지 않는다.
// 장을 옮기면(순서·수준) 그 장의 하위 장(바로 뒤에 이어지는 더 깊은 장들)이 함께 움직인다.
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
