// 에이전트 추가 수정안의 문단·제목 구조(FR-WB-034) · 문단 나누기(FR-WB-025)
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyServerState, splitBlockAt, state, undo } from '../public/js/state.js';
import { addBatch, blockKey, decide, isNewParagraph, newParagraphHome } from '../public/js/suggest.js';

// 문서를 새로 연다 — 예약된 자동 저장도 함께 취소된다(시험에는 서버가 없다)
const open = (blocks = []) => applyServerState({ sources: [], doc: { id: 'R-001', title: '시험', blocks }, evidence: {}, docs: [] });
const insert = (id, after, block = null) => ({ id, op: 'insert', after, block, sentenceId: null, text: id, type: 'connective', anchors: [], calc: null, reason: '', status: 'na', problems: [] });
const find = id => state.suggestions.find(s => s.id === id);
const layout = () => state.doc.blocks.map(b => `${b.kind === 'heading' ? 'H' : 'P'}[${b.sentences.map(s => s.text).join(' ')}]`).join(' ');

// 제목 → (표시 없는 문장도 제목 다음이면 새 문단) → 새 문단 → 제목 → 새 문단
const DRAFT = [insert('h1', 'start', 'heading'), insert('a', 'start'), insert('b', 'start'), insert('c', 'start', 'paragraph'), insert('d', 'start'), insert('h2', 'start', 'heading'), insert('e', 'start', 'paragraph')];
const EXPECTED = 'H[h1] P[a b] P[c d] H[h2] P[e]';

test('빈 문서에 낸 초안은 제안된 제목·문단 구조대로 들어간다 — 한 문단으로 합쳐지지 않는다', () => {
  open();
  addBatch({ id: 'B1', model: 'Opus', items: DRAFT });
  assert.deepEqual(DRAFT.map(s => isNewParagraph(find(s.id))), DRAFT.map(() => true));
  // 문단 단위 반영·거부의 단위는 제안된 문단 하나다
  assert.equal(blockKey(find('a')), blockKey(find('b')));
  assert.equal(new Set(['h1', 'a', 'c', 'h2', 'e'].map(id => blockKey(find(id)))).size, 5);
  decide(state.suggestions, true);
  assert.equal(layout(), EXPECTED);
  undo(); // 한꺼번에 반영한 것은 실행 취소 한 단계다
  assert.equal(layout(), '');
  open();
});

test('일부만, 제안 순서와 다르게 반영해도 각 문장은 제안된 문단에 제안된 순서로 들어간다', () => {
  open();
  addBatch({ id: 'B1', model: 'Opus', items: DRAFT });
  for (const id of ['d', 'a']) decide([find(id)], true);
  assert.equal(layout(), 'P[a] P[d]');
  decide(state.suggestions.filter(s => blockKey(s) === blockKey(find('c'))), true); // 문단 단위 반영: 그 문단의 남은 문장만
  assert.equal(layout(), 'P[a] P[c d]');
  for (const id of ['e', 'b', 'h2', 'h1']) decide([find(id)], true);
  assert.equal(layout(), EXPECTED);
  open();
});

test('문장 뒤에 넣는 수정안: 표시가 없으면 그 문단에 이어 붙고, 새 문단 표시부터는 그 문단 뒤의 새 문단이 된다', () => {
  const sentence = (id, text) => ({ id, text, type: 'connective', evidence: [] });
  open([{ id: 'P-01', kind: 'paragraph', sentences: [sentence('T-0001', '하나'), sentence('T-0002', '둘')] }, { id: 'P-02', kind: 'paragraph', sentences: [sentence('T-0003', '셋')] }]);
  addBatch({ id: 'B2', model: 'Opus', items: [insert('x', 'T-0001'), insert('y', 'T-0001', 'paragraph'), insert('z', 'T-0001'), insert('w', 'P-02')] });
  assert.deepEqual(['x', 'y', 'z', 'w'].map(id => isNewParagraph(find(id))), [false, true, true, true]);
  assert.deepEqual([blockKey(find('x')), newParagraphHome(find('y')), newParagraphHome(find('w'))], ['P-01', 'P-01', 'P-02']); // 새 문단은 기준 문단 바로 뒤에 보여 준다
  for (const id of ['z', 'w', 'x', 'y']) decide([find(id)], true);
  assert.equal(layout(), 'P[하나 x 둘] P[y z] P[셋] P[w]');
  open();
});

test('문단 나누기: 고른 문장부터 새 문단이 되고 순서·근거는 그대로이며 실행 취소 한 번으로 돌아간다', () => {
  const sentence = (id, evidence = []) => ({ id, text: id, type: 'fact', evidence });
  open([{ id: 'P-01', kind: 'paragraph', sentences: [sentence('T-0001'), sentence('T-0002'), sentence('T-0003', ['E-0001']), sentence('T-0004')] }]);
  splitBlockAt('T-0001'); // 첫 문장에서는 나눌 것이 없다
  assert.equal(state.doc.blocks.length, 1);
  splitBlockAt('T-0003');
  assert.equal(layout(), 'P[T-0001 T-0002] P[T-0003 T-0004]');
  assert.deepEqual([state.doc.blocks[1].id, state.doc.blocks[1].sentences[0].evidence], ['P-02', ['E-0001']]);
  undo();
  assert.equal(layout(), 'P[T-0001 T-0002 T-0003 T-0004]');
  open();
});
