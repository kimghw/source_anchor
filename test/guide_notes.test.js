// 작성자 요청 작성요령 — 블록의 guides 항목 검사, 에이전트에게 주는 요청 문서 표시, 저장·고침·낡은 수정안 거절, 요청 문서 위 합치기 거절 (FR-WB-100, ERR-WB-013, 014)
// 목차 수정안 검토 의견 — 줄 형식, 「수정안 검토 의견」 문서에 더하기·에이전트의 줄 더하기 거절 (FR-WB-103, ERR-WB-017)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { guidesText, parseBlock } from '../agent.js';
import { NOTE_RULE, REVIEW_TOPIC, reviewLine, reviewNotes } from '../lib/guide_notes.js';

async function freshStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sourceanchor-guide-notes-test-'));
  process.env.WORKSPACE = dir;
  return import(`../lib/store.js?workspace=${encodeURIComponent(dir)}`);
}
const note = { id: 'G-004', kind: 'guideline', title: '문체', note: true, noteText: '- 문장은 짧게 쓴다.', blocks: [] };
const uploaded = { id: 'G-001', kind: 'guideline', title: '선급 규칙', fileName: 'rules.pdf', blocks: [] };

test('블록: 장·보고서·양식 에이전트 블록의 "guides" 를 읽고, 규칙은 한 블록에 함께 넣으라고 알린다', () => {
  const text = 'ok\n```sourceanchor\n{"toc": [], "guides": [{"topic": "문체", "text": "- 짧게 쓴다."}]}\n```';
  assert.deepEqual(parseBlock(text).guides, [{ topic: '문체', text: '- 짧게 쓴다.' }]);
  assert.deepEqual(parseBlock('답만').guides, []);
  assert.deepEqual(parseBlock('```sourceanchor\n{bad\n```').guides, []);
  assert.match(NOTE_RULE, /same single fenced block/);
  assert.match(NOTE_RULE, /"guides": \[\{"topic": "문체", "guide_id": "G-012", "text": "- 문장은 짧게 쓴다\.\\n- /); // 프롬프트에는 \n 이 글자로 보인다
});

test('검사: 새 주제·id 로 고침·id 없이 같은 주제(지금 글 뒤에 없던 줄만 더함)는 카드로, 올린 문서·없는 문서·같은 글·빈 글·중복 주제·긴 글은 사유와 함께 뺀다', () => {
  const items = reviewNotes([
    { topic: ' 표기  ', text: '- 단위는 SI 로 쓴다.\r\n- 천 단위 쉼표', reason: '작성자 요청' },
    { topic: '문체', guide_id: 'G-004', text: '- 문장은 짧게 쓴다.\n- 존댓말을 쓰지 않는다.' },
    { topic: '인용', guide_id: 'G-001', text: '- 출처를 적는다.' },
    { topic: '인용', guide_id: 'G-009', text: '- 출처를 적는다.' },
    { topic: '빈 글', text: '   ' },
    { topic: '', text: '- 무엇' },
    { topic: '표기', text: '- 두 번째' },
    { topic: '긴 글', text: 'x'.repeat(12_001) },
  ], [note, uploaded]);
  assert.deepEqual(items.map(i => [i.topic, i.guideId, i.invalid ?? false]), [['표기', null, false], ['문체', 'G-004', false], ['인용', null, true], ['인용', null, true], ['빈 글', null, true], ['', null, true], ['표기', null, true], ['긴 글', null, true]]);
  assert.deepEqual([items[0].text, items[0].before, items[0].reason], ['- 단위는 SI 로 쓴다.\n- 천 단위 쉼표', '', '작성자 요청']);
  assert.deepEqual([items[1].text, items[1].before], ['- 문장은 짧게 쓴다.\n- 존댓말을 쓰지 않는다.', '- 문장은 짧게 쓴다.']);
  assert.deepEqual(items.slice(2).map(i => i.problems[0]), [
    'G-001 는 작성자가 올린 기준 문서라 고칠 수 없습니다 — 요청은 주제별 요청 문서로 내세요', '이 보고서에 없는 기준 문서: G-009', '빈 글: text 가 비어 있습니다', 'topic 이 비어 있습니다',
    '같은 주제(표기)가 두 번 왔습니다 — 한 항목으로 합치세요', '긴 글: 글은 12,000자까지입니다 (12,001자)',
  ]);
  // guide_id 없이 같은 주제가 오면 그 문서의 고침 — 지금 글은 그대로, 없던 줄만 뒤에
  const [merged] = reviewNotes([{ topic: '문체', text: '- 존댓말을 쓰지 않는다.\n- 문장은 짧게 쓴다.' }], [note]);
  assert.deepEqual([merged.guideId, merged.text, merged.before], ['G-004', '- 문장은 짧게 쓴다.\n- 존댓말을 쓰지 않는다.', '- 문장은 짧게 쓴다.']);
  const [same] = reviewNotes([{ topic: '문체', guide_id: 'G-004', text: '- 문장은 짧게 쓴다.' }], [note]);
  assert.equal(same.problems[0], 'G-004 의 글이 지금과 같습니다');
});

test('에이전트에게: 기준 문서 목록에서 요청 문서임과 지금 글을 알린다', () => {
  const text = guidesText([{ ...uploaded, collectedAt: '2026-10-22' }, { ...note, collectedAt: '2026-10-22' }]);
  assert.match(text, /- G-004 \[작성요령\] 문체 — file guides\/G-004\.md — request note on this topic \(the writer's standing requests\); current text:\n {4}- 문장은 짧게 쓴다\./);
  assert.doesNotMatch(text.split('\n')[0], /request note/);
});

test('저장: 새 주제는 작성요령 요청 문서로 생기고, 같은 문서의 고침은 판이 오르며, 낡은 수정안·그 사이 생긴 같은 주제·지운 문서는 409, 요청 문서 위 합치기는 거절한다', async () => {
  const store = await freshStore();
  const { book } = await store.loadBookState();
  await store.addGuide({ bookId: book.id, kind: 'reference', markdown: '# 참고\n\n참고 문장이다.' });
  const created = await store.saveGuideNote({ bookId: book.id, topic: ' 문체 ', text: '- 문장은 짧게 쓴다.\n- 존댓말을 쓰지 않는다.' });
  assert.deepEqual([created.guide.id, created.guide.kind, created.guide.title, created.guide.note, created.guide.method, created.guide.snapshot], ['G-002', 'guideline', '문체', true, '에이전트가 정리한 작성자 요청', undefined]);
  const saved = await store.getGuide(book.id, 'G-002');
  assert.equal(saved.noteText, '- 문장은 짧게 쓴다.\n- 존댓말을 쓰지 않는다.');
  assert.deepEqual(saved.blocks.map(b => [b.kind, b.sentences.map(s => [s.id, s.text])]), [['list', [['G-002.b1.s1', '문장은 짧게 쓴다.'], ['G-002.b1.s2', '존댓말을 쓰지 않는다.']]]]);
  assert.match((await store.readGuideFile(book.id, 'G-002', 'markdown')).data.toString('utf8'), /^- \[G-002\.b1\.s2\] 존댓말을 쓰지 않는다\.$/m);

  await assert.rejects(store.saveGuideNote({ bookId: book.id, topic: '문체', text: '- 다른 글' }), err => err.status === 409 && /그 사이에 생겼습니다/.test(err.message));
  await assert.rejects(store.saveGuideNote({ bookId: book.id, topic: '문체', guideId: 'G-002', text: '- 새 글', before: '- 옛 글' }), err => err.status === 409 && /다시 요청하세요/.test(err.message));
  await assert.rejects(store.saveGuideNote({ bookId: book.id, topic: '참고', guideId: 'G-001', text: '- 고침', before: '' }), err => err.status === 409);
  await assert.rejects(store.saveGuideNote({ bookId: book.id, topic: '', text: '- 무엇' }), err => err.status === 400);

  const updated = await store.saveGuideNote({ bookId: book.id, topic: '문체', guideId: 'G-002', text: '- 문장은 짧게 쓴다.\n- 존댓말을 쓰지 않는다.\n- 숫자는 천 단위마다 쉼표를 넣는다.', before: saved.noteText });
  assert.deepEqual([updated.guide.id, updated.guide.version, updated.guide.title], ['G-002', 'V-002', '문체']);
  const after = await store.getGuide(book.id, 'G-002');
  assert.deepEqual(after.blocks[0].sentences.map(s => s.id), ['G-002.b1.s1', 'G-002.b1.s2', 'G-002.b1.s3'], '앞 줄의 ID 는 그대로');
  assert.equal(after.collectedAt, saved.collectedAt);

  // 요청 문서 위에는 합치지 않는다 — 요청 문서를 다른 문서에 붙이는 것은 된다
  await assert.rejects(store.mergeGuide({ bookId: book.id, id: 'G-002', from: 'G-001' }), err => err.status === 400 && /요청 문서에는 다른 문서를 합칠 수 없습니다/.test(err.message));
  // 지운 문서의 고침은 409
  await store.deleteGuide(book.id, 'G-002');
  await assert.rejects(store.saveGuideNote({ bookId: book.id, topic: '문체', guideId: 'G-002', text: '- 또', before: after.noteText }), err => err.status === 409);
  // 다시 불러와도 요청 문서 표시와 글이 남는다
  const again = await store.saveGuideNote({ bookId: book.id, topic: '표기', text: '- 단위는 SI 로 쓴다.' });
  const reload = await import(`../lib/store.js?reload=${Date.now()}`);
  const kept = await reload.getGuide(book.id, again.guide.id);
  assert.deepEqual([kept.note, kept.noteText, (await reload.guideList(book.id)).find(g => g.id === kept.id).note], [true, '- 단위는 SI 로 쓴다.', true]);
});

test('검토 의견 줄: 「- [반영|거부|의견] 수정안: 의견」 한 줄 — 줄바꿈은 한 칸, 빈 의견·긴 의견·모르는 결정은 사유', () => {
  assert.deepEqual(reviewLine({ action: 'reject', what: '장 추가 「특수화물선」', comment: '과업\n  범위 밖이다 ' }), { line: '- [거부] 장 추가 「특수화물선」: 과업 범위 밖이다' });
  assert.equal(reviewLine({ action: 'accept', what: '보고서 공통 지시문 변경', comment: '좋다' }).line, '- [반영] 보고서 공통 지시문 변경: 좋다');
  assert.equal(reviewLine({ action: 'comment', what: '지시문 변경 「개요」(R-002)', comment: '표 예시를 넣어 줘' }).line, '- [의견] 지시문 변경 「개요」(R-002): 표 예시를 넣어 줘');
  assert.equal(reviewLine({ action: 'reject', what: '장 삭제', comment: '  ' }).problem, '의견이 비어 있습니다');
  assert.equal(reviewLine({ action: 'reject', what: '장 삭제', comment: 'x'.repeat(1001) }).problem, '의견은 1,000자까지입니다 (1,001자)');
  assert.match(reviewLine({ action: 'delete', what: '장 삭제', comment: '왜' }).problem, /action/);
  assert.match(reviewLine({ action: 'reject', what: ' ', comment: '왜' }).problem, /what/);
});

test('에이전트: 쓰는 규칙은 작성요령으로, 검토 의견 문서는 줄을 더하거나 새로 만들 수 없고 빼거나 고치는 것만 카드로 낸다', () => {
  assert.match(NOTE_RULE, /never put the rule itself into an instruction proposal/);
  assert.match(NOTE_RULE, /「내용」 and 「작성요령」/);
  assert.ok(NOTE_RULE.includes(`「${REVIEW_TOPIC}」 (marked "review note" in <guides>)`));
  const review = { id: 'G-007', kind: 'guideline', title: REVIEW_TOPIC, note: true, noteText: '- [거부] 장 추가 「특수화물선」: 과업 범위 밖이다\n- [반영] 보고서 공통 지시문 변경: 좋다', blocks: [] };
  const one = raw => reviewNotes([raw], [note, review])[0];
  assert.match(reviewNotes([{ topic: REVIEW_TOPIC, text: '- [거부] 무엇: 왜' }], [note]).at(0).problems[0], /작성자가 목차 수정안을 검토할 때만 생깁니다/);
  assert.match(one({ topic: REVIEW_TOPIC, guide_id: 'G-007', text: `${review.noteText}\n- [거부] 장 삭제: 필요하다` }).problems[0], /줄을 더할 수 없습니다/);
  assert.match(one({ topic: REVIEW_TOPIC, text: '- 새 줄' }).problems[0], /줄을 더할 수 없습니다/, 'guide_id 없이 같은 주제면 없던 줄을 뒤에 더하는 고침이 된다');
  const dropped = one({ topic: REVIEW_TOPIC, guide_id: 'G-007', text: '- [반영] 보고서 공통 지시문 변경: 좋다' });
  assert.deepEqual([dropped.invalid ?? false, dropped.guideId, dropped.before], [false, 'G-007', review.noteText]);
  const changed = one({ topic: REVIEW_TOPIC, guide_id: 'G-007', text: '- [거부] 장 추가 「특수화물선」: 이제는 넣어도 된다\n- [반영] 보고서 공통 지시문 변경: 좋다' });
  assert.equal(changed.invalid ?? false, false, '작성자가 바꾼 의견의 줄을 고치는 것은 된다');
  assert.match(guidesText([{ ...review, collectedAt: '2026-10-22' }]), /— review note \(the writer's comments on earlier toc proposals — see the rule on it\); current text:\n {4}- \[거부\] 장 추가/);
});

test('검토 의견 저장: 첫 의견은 「수정안 검토 의견」 요청 문서를 만들고 다음 의견은 줄을 더해 판을 올리며, 잇단 의견도 줄을 잃지 않고, 빈·긴 의견과 12,000자 넘는 문서는 400', async () => {
  const store = await freshStore();
  const { book } = await store.loadBookState();
  const first = await store.addReviewNote({ bookId: book.id, action: 'reject', what: '장 추가 「특수화물선」', comment: '과업 범위 밖이다' });
  assert.deepEqual([first.guide.id, first.guide.title, first.guide.note, first.guide.kind, first.guide.method], ['G-001', REVIEW_TOPIC, true, 'guideline', '에이전트가 정리한 작성자 요청']);
  const [a, b] = await Promise.all([
    store.addReviewNote({ bookId: book.id, action: 'accept', what: '보고서 공통 지시문 변경', comment: '좋다' }),
    store.addReviewNote({ bookId: book.id, action: 'comment', what: '지시문 변경 「개요」(R-001)', comment: '표 예시를\n넣어 줘' }),
  ]);
  assert.deepEqual([a.guide.version, b.guide.version], ['V-002', 'V-003']);
  const saved = await store.getGuide(book.id, 'G-001');
  assert.equal(saved.noteText, '- [거부] 장 추가 「특수화물선」: 과업 범위 밖이다\n- [반영] 보고서 공통 지시문 변경: 좋다\n- [의견] 지시문 변경 「개요」(R-001): 표 예시를 넣어 줘');
  assert.deepEqual(saved.blocks.map(blk => blk.sentences.length), [3], '세 줄이 목록 블록 하나');
  await assert.rejects(store.addReviewNote({ bookId: book.id, action: 'reject', what: '장 삭제', comment: '' }), err => err.status === 400 && /의견이 비어/.test(err.message));
  await assert.rejects(store.addReviewNote({ bookId: book.id, action: 'reject', what: '장 삭제', comment: 'x'.repeat(1001) }), err => err.status === 400);
  for (let i = 0; i < 11; i += 1) await store.addReviewNote({ bookId: book.id, action: 'reject', what: `장 추가 「${i}」`, comment: 'x'.repeat(990) });
  await assert.rejects(store.addReviewNote({ bookId: book.id, action: 'reject', what: '장 추가 「끝」', comment: 'x'.repeat(990) }), err => err.status === 400 && /12,000자까지/.test(err.message) && /정리하거나 지운 뒤/.test(err.message));
  // 작성자가 이름을 바꾸거나 지우면 다음 의견은 새 문서를 만든다
  await store.deleteGuide(book.id, 'G-001');
  const next = await store.addReviewNote({ bookId: book.id, action: 'reject', what: '장 삭제 「부록」(R-003)', comment: '남긴다' });
  assert.deepEqual([next.guide.id, next.guide.version], ['G-002', 'V-001']);
});
