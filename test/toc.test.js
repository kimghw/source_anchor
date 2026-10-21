// 목차의 수준(헤딩 단계)·순서 규칙 (FR-WB-079)
import assert from 'node:assert/strict';
import test from 'node:test';
import { canDemote, canMoveDown, canMoveUp, canPromote, insertAfter, MAX_LEVEL, moveAfter, moveDown, moveUp, normalizeLevels, outlineNumbers, shiftLevel, subtreeEnd } from '../public/shared/toc.js';

const toc = (...spec) => spec.map((s, i) => ({ id: `R-${String(i + 1).padStart(3, '0')}`, title: s.replace(/\d/g, ''), level: Number(s.match(/\d/)[0]) }));
const shape = list => list.map(ch => `${ch.title}${ch.level}`).join(' ');

test('수준 맞추기: 첫 장은 1, 앞 장 + 1 을 넘지 않고, 1 ~ MAX_LEVEL 안에 둔다 — 없는 값은 1', () => {
  assert.equal(shape(normalizeLevels(toc('a2', 'b3', 'c1', 'd3', 'e2'))), 'a1 b2 c1 d2 e2');
  assert.equal(shape(normalizeLevels([{ title: 'a' }, { title: 'b', level: '2' }, { title: 'c', level: 9 }, { title: 'd', level: 0 }])), `a1 b2 c${MAX_LEVEL} d1`);
});

test('하위 장의 범위: 바로 뒤에 이어지는 더 깊은 장까지', () => {
  const list = toc('a1', 'b2', 'c3', 'd2', 'e1');
  assert.deepEqual([0, 1, 2, 3, 4].map(i => subtreeEnd(list, i)), [4, 3, 3, 4, 5]);
});

test('순서 바꾸기: 같은 상위 장 아래의 이웃과 하위 장을 데리고 자리를 바꾼다', () => {
  const list = toc('a1', 'b2', 'c3', 'd2', 'e1', 'f2');
  assert.equal(shape(moveUp(list, 3)), 'a1 d2 b2 c3 e1 f2'); // d 가 b(와 c) 앞으로
  assert.equal(shape(moveDown(list, 1)), 'a1 d2 b2 c3 e1 f2'); // b 가 c 를 데리고 d 뒤로
  assert.equal(shape(moveDown(list, 0)), 'e1 f2 a1 b2 c3 d2'); // a 는 b·c·d 를 데리고 e(와 f) 뒤로
  assert.equal(shape(moveUp(list, 4)), 'e1 f2 a1 b2 c3 d2');
  // 이웃이 없으면 그대로: 첫 장, 상위 장의 첫 하위 장, 마지막 하위 장
  assert.equal(canMoveUp(list, 0), false);
  assert.equal(canMoveUp(list, 1), false); // b 앞은 상위 장 a
  assert.equal(canMoveDown(list, 3), false); // d 뒤는 상위로 올라간 e
  assert.equal(canMoveDown(list, 5), false);
  assert.equal(moveUp(list, 1), list);
});

test('수준 옮기기: 하위로는 앞 장 + 1 까지, 상위로는 1 까지 — 하위 장이 함께 움직이고 최대 수준을 넘지 않는다', () => {
  const list = toc('a1', 'b2', 'c3', 'd2', 'e1');
  assert.equal(canDemote(list, 0), false); // 첫 장은 하위로 못 간다
  assert.equal(canDemote(list, 1), false); // b 를 3 으로 내리면 c 가 4 — 최대 수준 초과
  assert.equal(canDemote(list, 3), true);
  assert.equal(shape(shiftLevel(list, 3, +1)), 'a1 b2 c3 d3 e1');
  assert.equal(canDemote(list, 4), true); // e 는 1 → 2 (앞 장 d 가 2)
  assert.equal(canPromote(list, 0), false);
  assert.equal(shape(shiftLevel(list, 1, -1)), 'a1 b1 c2 d2 e1'); // b 가 c 를 데리고 올라간다
  assert.equal(shiftLevel(list, 0, -1), list);
  assert.equal(shiftLevel(list, 1, +1), list);
  // 옮긴 결과는 항상 규칙에 맞는다
  for (let i = 0; i < list.length; i++) for (const delta of [-1, 1]) assert.equal(shape(normalizeLevels(shiftLevel(list, i, delta))), shape(shiftLevel(list, i, delta)));
});

test('목차 번호: 수준에 따라 1 · 1.1 · 1.2 · 2 로 매긴다', () => {
  assert.deepEqual(outlineNumbers(toc('a1', 'b2', 'c3', 'd2', 'e1', 'f2')), ['1', '1.1', '1.1.1', '1.2', '2', '2.1']);
});

test('끼우기·옮기기(보고서 에이전트의 목차 수정안): after 는 장 ID 바로 뒤 · start · end — 옮길 때는 하위 장을 데리고 가고 수준은 규칙 안으로', () => {
  const list = toc('a1', 'b2', 'c3', 'd2', 'e1');
  const x = { id: 'R-009', title: 'x', level: 2 };
  assert.equal(shape(insertAfter(list, x, 'start')), 'x2 a1 b2 c3 d2 e1'); // 수준은 부르는 쪽이 normalizeLevels 로 맞춘다
  assert.equal(shape(insertAfter(list, x, 'R-001')), 'a1 x2 b2 c3 d2 e1');
  assert.equal(shape(insertAfter(list, x, 'end')), 'a1 b2 c3 d2 e1 x2');
  assert.equal(shape(insertAfter(list, x, 'R-999')), 'a1 b2 c3 d2 e1 x2'); // 모르는 기준은 끝
  assert.equal(shape(moveAfter(list, 'R-002', 'R-004')), 'a1 d2 b2 c3 e1'); // b 가 c 를 데리고 d 뒤로
  assert.equal(shape(moveAfter(list, 'R-002', 'start', 1)), 'b1 c2 a1 d2 e1'); // 맨 앞으로 올리며 수준 1 — c 도 한 단계 올라간다
  assert.equal(shape(moveAfter(list, 'R-005', 'R-001', 2)), 'a1 e2 b2 c3 d2');
  assert.equal(shape(moveAfter(list, 'R-004', null, 3)), 'a1 b2 c3 d3 e1'); // 자리는 그대로, 수준만
  assert.equal(shape(moveAfter(list, 'R-001', 'end', 2)), 'e1 a2 b3 c3 d3'); // 규칙 밖의 수준은 맞춘다 (c 는 4 가 못 된다)
  assert.equal(moveAfter(list, 'R-001', 'R-003'), null); // 자기 하위 장 뒤로는 못 간다
  assert.equal(moveAfter(list, 'R-001', 'R-999'), null); // 기준 장이 없다
  assert.equal(moveAfter(list, 'R-999', 'start'), null);
});
