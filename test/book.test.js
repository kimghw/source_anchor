// 보고서 화면 에이전트 — 장 추가 수정안 반영(목차의 자리·수준·지시문), 에이전트가 읽는 보고서 상태, 목차 수정안 검사 (FR-WB-076, 077, ERR-WB-007)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { reviewToc } from '../agent.js';

// store 는 WORKSPACE 를 불러올 때 읽으므로, 임시 폴더를 정한 뒤에 가져온다
async function freshStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sourceanchor-book-test-'));
  process.env.WORKSPACE = dir;
  return import(`../lib/store.js?workspace=${encodeURIComponent(dir)}`);
}

const shape = chapters => chapters.map(ch => `${ch.title}${ch.level}`).join(' ');

test('장 추가 수정안 반영: after(장 ID · start · end)와 level·instructions 대로 목차에 끼우고, 기준 장이 없으면 거절한다', async () => {
  const store = await freshStore();
  const { book } = await store.loadBookState();
  await store.insertChapter({ bookId: book.id, title: 'a', after: 'end' });
  await store.insertChapter({ bookId: book.id, title: 'c', after: 'end', level: 1 });
  const ids = (await store.loadBookState(book.id)).chapters.map(ch => ch.id);
  await store.insertChapter({ bookId: book.id, title: 'b', after: ids[0], level: 2, instructions: '  a 의 세부 — 2024년 이후만  ' });
  await store.insertChapter({ bookId: book.id, title: 'z', after: 'start', level: 3 }); // 첫 장은 1 로 맞춘다
  const state = await store.loadBookState(book.id);
  assert.equal(shape(state.chapters), 'z1 a1 b2 c1');
  assert.equal(state.chapters[2].instructions, 'a 의 세부 — 2024년 이후만');
  await assert.rejects(store.insertChapter({ bookId: book.id, title: 'x', after: 'R-999' }), /기준 장이 이 보고서에 없습니다/);
  // 탐색기의 새 장(createReport)은 여전히 끝에 붙고 그 장의 작성 화면 상태를 돌려준다
  const created = await store.createReport({ bookId: book.id, title: 'tail' });
  assert.equal(created.doc.title, 'tail');
  assert.equal(shape((await store.loadBookState(book.id)).chapters), 'z1 a1 b2 c1 tail1');
  await fs.rm(process.env.WORKSPACE, { recursive: true, force: true });
});

test('에이전트가 읽는 보고서 상태: 목차 순서대로 장마다 지시문·본문·근거·원문이 붙고, 마지막으로 보던 자리는 바뀌지 않는다', async () => {
  const store = await freshStore();
  const { book } = await store.loadBookState();
  await store.insertChapter({ bookId: book.id, title: 'a', instructions: '범위 a' });
  const b = (await store.insertChapter({ bookId: book.id, title: 'b', level: 2 })).chapters[1];
  await store.addSource({ docId: b.id, title: '자료', type: 'text', markdown: '첫 문장이다. 둘째 문장이다.' });
  await store.saveReport({ doc: { id: b.id, title: 'b', blocks: [{ id: 'P-01', kind: 'paragraph', sentences: [{ id: 'T-0001', text: '본문 문장.', type: 'fact', evidence: [] }] }] }, evidence: {} });
  const before = await store.lastPlace();
  const agentState = await store.bookAgentState(book.id);
  assert.deepEqual(agentState.chapters.map(ch => [ch.title, ch.level, ch.instructions, ch.doc.blocks.length, ch.sources.length]), [['a', 1, '범위 a', 0, 0], ['b', 2, '', 1, 1]]);
  assert.equal(agentState.chapters[1].sources[0].blocks[0].sentences.length, 2);
  assert.deepEqual(await store.lastPlace(), before);
  await fs.rm(process.env.WORKSPACE, { recursive: true, force: true });
});

test('목차 수정안 검사: 없는 장·자기 하위 장 뒤·빈 제목·같은 값은 제외하고, 나머지는 화면이 반영할 항목으로 바꾼다', () => {
  const chapters = [
    { id: 'R-001', title: '서론', instructions: '배경', level: 1, doc: { blocks: [] }, sources: [] },
    { id: 'R-002', title: '본론', instructions: '', level: 2, doc: { blocks: [{ id: 'P-01', kind: 'paragraph', sentences: [{ id: 'T-0001', text: '.', type: 'fact', evidence: [] }] }] }, sources: [{ id: 'S-001' }] },
    { id: 'R-003', title: '결론', instructions: '', level: 1, doc: { blocks: [] }, sources: [] },
  ];
  const items = reviewToc([
    { op: 'add', title: ' 방법 ', level: 2, after: 'R-001', instructions: '절차만', reason: 'r1' },
    { op: 'add', title: '' },
    { op: 'add', title: '끝', after: 'R-999' },
    { op: 'rename', chapter_id: 'R-003', title: '맺음말' },
    { op: 'rename', chapter_id: 'R-003', title: '결론' },
    { op: 'instructions', chapter_id: 'R-001', instructions: '배경과 목적' },
    { op: 'move', chapter_id: 'R-003', after: 'start' },
    { op: 'move', chapter_id: 'R-001', after: 'R-002' },
    { op: 'move', chapter_id: 'R-002', level: 7 },
    { op: 'delete', chapter_id: 'R-002', reason: '겹침' },
    { op: 'delete', chapter_id: 'R-777' },
    { op: 'explode' },
  ], chapters);
  const valid = items.filter(i => !i.invalid);
  assert.deepEqual(valid.map(i => i.op), ['add', 'rename', 'instructions', 'move', 'delete']);
  assert.deepEqual(items.filter(i => i.invalid).map(i => i.problems[0]), [
    'title 이 비어 있습니다', 'after 가 이 보고서에 없는 장: R-999', 'R-003 의 제목이 지금과 같습니다',
    'R-001 를 자기 자신이나 자기 하위 장 뒤로 옮길 수 없습니다', 'level 은 1~3 이어야 합니다: 7', '이 보고서에 없는 장: R-777', '알 수 없는 op: explode',
  ]);
  const [add, rename, instructions, move, del] = valid;
  assert.deepEqual([add.title, add.level, add.after, add.afterTitle, add.instructions], ['방법', 2, 'R-001', '서론', '절차만']);
  assert.deepEqual([rename.chapterTitle, rename.before, rename.title], ['결론', '결론', '맺음말']);
  assert.deepEqual([instructions.before, instructions.instructions], ['배경', '배경과 목적']);
  assert.deepEqual([move.chapterId, move.after, move.level], ['R-003', 'start', null]);
  assert.deepEqual([del.chapterTitle, del.sentences, del.sources], ['본론', 1, 1]);
  assert.ok(valid.every(i => typeof i.id === 'string' && i.id.length > 10));
});
