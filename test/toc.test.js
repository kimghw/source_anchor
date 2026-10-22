// 목차의 수준(헤딩 단계)·순서 규칙 (FR-WB-079) · 양식 문서의 헤딩을 장 후보로 고르는 규칙 (FR-WB-093)
import assert from 'node:assert/strict';
import test from 'node:test';
import { canDemote, canMoveDown, canMoveUp, canPromote, headingCandidates, insertAfter, MAX_LEVEL, moveAfter, moveDown, moveUp, normalizeGroups, normalizeLevels, outlineNumbers, shiftLevel, subtreeEnd } from '../public/shared/toc.js';

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

const h = (text, level, extra) => ({ kind: 'heading', level, text, section: 0, p: 0, ...extra });
const pick = (list, ...keys) => list.map(c => keys.map(k => c[k]));

test('장 후보: 헤딩 노드만 문서 순서로, i 는 nodes 안의 index — by 는 없으면 text, depth 는 없으면 level, 수준은 1~MAX_LEVEL 안으로', () => {
  const nodes = [
    { kind: 'field', n: 1, level: 1, text: '본문' },
    h('1. 개요', 1, { by: 'outline' }),
    { kind: 'table', t: 0 },
    h('1-1. 목표', 2, { by: 'outline' }),
    h('① 세부', 3, { by: 'outline', depth: 4 }),
    h('□ 글 규칙 제목', 1),
    { kind: 'field', n: 2, level: 2, text: '- 글머리', after: true },
    h('제목 스타일', 9, { by: 'style' }),
    h('모르는 출처', 0, { by: 'magic' }),
  ];
  const list = headingCandidates(nodes);
  assert.deepEqual(pick(list, 'i', 'title', 'level', 'depth', 'by'), [
    [1, '1. 개요', 1, 1, 'outline'], [3, '1-1. 목표', 2, 2, 'outline'], [4, '① 세부', 3, 4, 'outline'],
    [5, '□ 글 규칙 제목', 1, 1, 'text'], [7, '제목 스타일', MAX_LEVEL, MAX_LEVEL, 'style'], [8, '모르는 출처', 1, 1, 'text'],
  ]);
  assert.deepEqual(Object.keys(list[0]).sort(), ['by', 'depth', 'i', 'level', 'selected', 'text', 'title']);
  assert.deepEqual(headingCandidates([]), []);
  assert.deepEqual(headingCandidates(undefined), []);
  assert.deepEqual(headingCandidates([{ kind: 'table', t: 0 }, { kind: 'field', n: 1, level: 1, text: '1. 글' }]), []); // 필드는 번호로 시작해도 후보가 아니다
});

test('장 후보 제목: 공백 정리 + 뒤의 「※ …」 작성 안내 떼기 — 떼면 비는 제목은 떼기 전 것, 원문 text 는 그대로(툴팁)', () => {
  const raw = '  2.\t추진   전략 ※ 세부 내용은 별첨 ※ 참고 ';
  const [a, b, c, d] = headingCandidates([h(raw, 1), h('※ 작성 안내만', 1), h('   ', 2), h(undefined, 1)]);
  assert.deepEqual([a.text, a.title], [raw, '2. 추진 전략']);
  assert.deepEqual([b.text, b.title], ['※ 작성 안내만', '※ 작성 안내만']);
  assert.deepEqual([c.text, c.title], ['   ', '']);
  assert.deepEqual([d.text, d.title], ['', '']);
  assert.equal(headingCandidates([h('가. 항목※바로 붙은 안내', 2)])[0].title, '가. 항목');
});

test('장 후보 기본 선택: 개요·스타일 헤딩이 하나라도 있으면 그것만(깊이 ≤ MAX_LEVEL) 고르고 글 헤딩은 후보로만 — 없으면 글 헤딩을 모두 고른다', () => {
  const structured = [h('1.', 1, { by: 'outline' }), h('□ 글', 1), h('1-1.', 2, { by: 'outline' }), h('①', 3, { by: 'outline', depth: 4 }), h('제목', 2, { by: 'style' }), h('제목 깊은', 3, { by: 'style', depth: 5 }), h('1. 목차 페이지', 1)];
  assert.deepEqual(pick(headingCandidates(structured), 'title', 'selected'), [['1.', true], ['□ 글', false], ['1-1.', true], ['①', false], ['제목', true], ['제목 깊은', false], ['1. 목차 페이지', false]]);
  const plain = [h('□ 개요', 1), h('■ 세부', 2), h('1.1.1.1 깊은', 3, { depth: 4 })]; // 글 헤딩뿐이면 깊이와 무관하게 모두
  assert.deepEqual(pick(headingCandidates(plain), 'title', 'selected'), [['□ 개요', true], ['■ 세부', true], ['1.1.1.1 깊은', true]]);
  assert.deepEqual(pick(headingCandidates([h('①', 3, { by: 'outline', depth: 4 }), h('□ 글', 1)]), 'selected'), [[false], [false]]); // 깊은 개요 헤딩만 있으면 고른 것이 없다 — 사용자가 고른다
  // 고른 후보를 기존 목차 뒤에 붙이면 normalizeLevels 가 수준을 규칙 안으로 맞춘다 (미리보기·만들기가 같은 규칙)
  const chosen = headingCandidates(structured).filter(c => c.selected).map(({ title, level }) => ({ title, level }));
  assert.deepEqual(normalizeLevels([{ title: '기존', level: 1 }, ...chosen]).map(ch => `${ch.title}${ch.level}`), ['기존1', '1.1', '1-1.2', '제목2']);
});

test('장 후보 출처 user·rule: 작성자·구조 규칙이 제목으로 둔 것은 개요·스타일처럼 구조적이라 기본 선택 — by 가 없어도 필드였던 노드(orig)의 user·rule 로 안다 (FR-WB-094, 095)', () => {
  // 명시된 by — 글 헤딩과 섞이면 글 헤딩은 후보로만
  const explicit = [h('□ 글', 1), h('[공동연구개발기관2]', 1, { by: 'user' }), h('o 규정 공백 분석', 2, { by: 'rule' })];
  assert.deepEqual(pick(headingCandidates(explicit), 'title', 'by', 'selected'), [['□ 글', 'text', false], ['[공동연구개발기관2]', 'user', true], ['o 규정 공백 분석', 'rule', true]]);
  // by 없이 — 필드였던(orig.kind 'field') 노드를 작성자(user)가 바꿨으면 user, 규칙(rule)이 맞췄으면 rule, 둘 다면 user. 제목이었던 노드의 수준만 조절한 것은 출처가 그대로
  const derived = [
    h('필드였던 것 · 작성자', 1, { orig: { kind: 'field', level: 1 }, user: true }),
    h('필드였던 것 · 규칙', 2, { orig: { kind: 'field', level: 1 }, rule: 'SR-001' }),
    h('필드였던 것 · 규칙 뒤 작성자', 2, { orig: { kind: 'field', level: 1 }, rule: 'SR-002', user: true }),
    h('제목이었던 것 · 수준만', 2, { by: 'outline', orig: { kind: 'heading', level: 1 }, user: true }),
    h('제목이었던 글 헤딩 · 수준만', 2, { orig: { kind: 'heading', level: 1 }, user: true }),
  ];
  assert.deepEqual(pick(headingCandidates(derived), 'by', 'selected'), [['user', true], ['rule', true], ['user', true], ['outline', true], ['text', false]]);
  // 작성자가 둘 수 있는 깊은 수준(4~6)은 목차 수준 안으로 자른다 — 명시된 depth 가 MAX_LEVEL 을 넘으면 후보로만
  assert.deepEqual(pick(headingCandidates([h('깊은 작성자 제목', 5, { by: 'user' }), h('깊이 명시', 3, { by: 'user', depth: 5 })]), 'level', 'depth', 'selected'), [[MAX_LEVEL, MAX_LEVEL, true], [MAX_LEVEL, 5, false]]);
  // 모르는 출처는 글 — 필드였던 노드가 아니면 user·rule 표시가 있어도 글
  assert.deepEqual(pick(headingCandidates([h('모르는 출처', 1, { by: 'magic', user: true })]), 'by', 'selected'), [['text', true]]);
});

test('형제 묶음 맞추기(normalizeGroups): 상위 제목이 빠진 묶음은 형제와 그 하위가 같은 만큼 함께 올라가고, 묶음보다 얕은 장이 오면 묶음이 끝난다', () => {
  const list = toc('a1', 'b3', 'c3', 'd2', 'e3', 'f3');
  assert.equal(shape(normalizeGroups(list)), 'a1 b2 c2 d2 e3 f3'); // b·c 는 형제로 남고(normalizeLevels 는 c 를 b 의 하위로), d 부터는 원래 수준
  assert.equal(shape(normalizeGroups(toc('a3', 'b3', 'c2'))), 'a1 b1 c2'); // 맨 앞 묶음은 1 로 — 뒤의 2 는 하위
  assert.equal(shape(normalizeGroups(toc('a3', 'b3'), 1)), 'a2 b2'); // 앞 장이 1 이면 2 로
  assert.equal(shape(normalizeGroups(toc('a3', 'b3'), 2)), 'a3 b3'); // 앞 장이 2 면 그대로
  assert.equal(shape(normalizeGroups(toc('a1', 'b2', 'c3', 'd1'))), 'a1 b2 c3 d1'); // 규칙에 맞는 목록은 그대로
  assert.deepEqual(normalizeGroups([{ title: 'x', level: '2' }, { title: 'y', level: 9 }]).map(ch => ch.level), [1, 2]); // 없는 값·범위 밖은 normalizeLevels 처럼
  for (const spec of [['a1', 'b3', 'c3', 'd2'], ['a2', 'b3', 'c1', 'd3', 'e3', 'f2']]) assert.equal(shape(normalizeLevels(normalizeGroups(toc(...spec)))), shape(normalizeGroups(toc(...spec)))); // 결과는 늘 규칙 안
});
