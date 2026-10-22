// 선택 질문 창의 고른 글 검사와 프롬프트 블록 (FR-WB-102, ERR-WB-016)
import assert from 'node:assert/strict';
import test from 'node:test';
import { ASK_NOTE, excerptsBlock } from '../lib/ask_agent.js';
import { ASK_CHARS_MAX, ASK_PIECES_MAX, cleanExcerpts } from '../public/shared/ask.js';

test('고른 글: 다듬고 글 없는 조각은 뺀다 — kind 는 answer 아니면 excerpt, 질문은 2,000자까지', () => {
  const pieces = cleanExcerpts([
    { kind: 'answer', question: '  목차를 비교해 줘 ', text: '  네 규칙서의 전기 파트를 비교했습니다. ' },
    { kind: 'answer', question: '중지된 질문', text: '   ' },
    { kind: '???', text: '끌어 고른 문단', question: 'q'.repeat(3000) },
    null,
  ]);
  assert.deepEqual(pieces.map(p => [p.kind, p.text]), [['answer', '네 규칙서의 전기 파트를 비교했습니다.'], ['excerpt', '끌어 고른 문단']]);
  assert.equal(pieces[0].question, '목차를 비교해 줘');
  assert.equal(pieces[1].question.length, 2000);
});

test('고른 글: 비었거나 조각·글자 수 한도를 넘으면 사유를 담아 던진다 (ERR-WB-016)', () => {
  assert.throws(() => cleanExcerpts([]), /비어 있습니다/);
  assert.throws(() => cleanExcerpts([{ kind: 'answer', text: '' }]), /비어 있습니다/);
  assert.throws(() => cleanExcerpts('not a list'), /비어 있습니다/);
  assert.throws(() => cleanExcerpts(Array.from({ length: ASK_PIECES_MAX + 1 }, () => ({ text: '가' }))), /20개까지/);
  assert.equal(cleanExcerpts(Array.from({ length: ASK_PIECES_MAX }, () => ({ text: '가' }))).length, ASK_PIECES_MAX);
  assert.throws(() => cleanExcerpts([{ text: 'a'.repeat(ASK_CHARS_MAX) }, { text: 'b' }]), /100,000자를 넘습니다/);
  assert.equal(cleanExcerpts([{ text: 'a'.repeat(ASK_CHARS_MAX) }]).length, 1);
});

test('고른 글 블록: 조각마다 종류·작성자 메시지·글을 차례로 — 질문이 없으면 그 줄을 뺀다', () => {
  const block = excerptsBlock(cleanExcerpts([{ kind: 'answer', question: '비교해 줘', text: '답 하나' }, { kind: 'excerpt', text: '끌어 고른 글' }]));
  assert.match(block, /^<picked_excerpts>\n--- excerpt 1: a whole answer from the main chat\nthe user message it answered:\n비교해 줘\nthe answer:\n답 하나\n\n--- excerpt 2: a part of the main chat the user dragged over\nthe excerpt:\n끌어 고른 글\n<\/picked_excerpts>$/);
  assert.match(ASK_NOTE, /<picked_excerpts>/);
  assert.match(ASK_NOTE, /Never end a reply with a fenced sourceanchor block/);
});
