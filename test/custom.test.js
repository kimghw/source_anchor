// 사용자 지정 문서 — 만들기·저장·목록·삭제·번호 불변, 장의 원문으로 등록(늘 새 원문), 한도·거절, 보고서 격리 (FR-WB-088, 089, DR-WB-007, ERR-WB-010)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function freshStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sourceanchor-custom-test-'));
  process.env.WORKSPACE = dir;
  return import(`../lib/store.js?workspace=${encodeURIComponent(dir)}`);
}

test('사용자 지정 문서: 만들기·저장·목록·읽기·삭제, 지운 번호는 다시 쓰지 않고, 다른 보고서에 나타나지 않으며, 다시 불러와도 남는다', async () => {
  const store = await freshStore();
  const { book } = await store.loadBookState();
  const a = await store.createCustomDoc({ bookId: book.id, title: ' 통계 모음 ' });
  assert.deepEqual([a.doc.id, a.doc.title, a.doc.markdown, a.doc.picks, a.doc.registrations], ['C-001', '통계 모음', '', [], []]);
  const b = await store.createCustomDoc({ bookId: book.id, title: '' });
  assert.deepEqual([b.doc.id, b.doc.title], ['C-002', '제목 없는 문서']);
  assert.deepEqual(b.custom.map(d => d.id), ['C-001', 'C-002']);
  const saved = await store.saveCustomDoc({ bookId: book.id, id: 'C-001', markdown: '첫 문장. 둘째 문장.', picks: [{ chapterId: 'R-001', sourceId: 'S-001', anchorId: 'S-001.b1.s1', text: '첫 문장.', loc: '문단 1', at: 't' }] });
  assert.deepEqual([saved.doc.markdown, saved.doc.picks.length, saved.doc.picks[0].anchorId], ['첫 문장. 둘째 문장.', 1, 'S-001.b1.s1']);
  const summary = (await store.loadBookState(book.id)).custom;
  assert.deepEqual(summary.map(d => [d.id, d.chars, d.picks, d.registrations]), [['C-001', 12, 1, 0], ['C-002', 0, 0, 0]]);
  assert.ok(summary.every(d => d.markdown === undefined)); // 목록에는 본문이 없다
  assert.equal((await store.getCustomDoc(book.id, 'C-001')).markdown, '첫 문장. 둘째 문장.');
  await assert.rejects(store.getCustomDoc(book.id, 'C-009'), /찾지 못했습니다/);
  assert.deepEqual((await store.deleteCustomDoc(book.id, 'C-001')).custom.map(d => d.id), ['C-002']);
  await assert.rejects(store.deleteCustomDoc(book.id, 'C-001'), /찾지 못했습니다/);
  assert.equal((await store.createCustomDoc({ bookId: book.id, title: '셋' })).doc.id, 'C-003'); // 지운 번호는 다시 쓰지 않는다
  const other = await store.createBook({ title: '다른 보고서' });
  assert.deepEqual(other.custom, []);
  await assert.rejects(store.getCustomDoc(other.book.id, 'C-002'), /찾지 못했습니다/);
  const again = await import(`../lib/store.js?reload3=${Date.now()}`);
  assert.deepEqual((await again.loadBookState(book.id)).custom.map(d => d.id), ['C-002', 'C-003']);
  assert.deepEqual((await again.customDocList(book.id)).map(d => d.id), ['C-002', 'C-003']);
  await store.deleteBook(book.id);
  await assert.rejects(fs.access(path.join(process.env.WORKSPACE, 'projects', book.id, 'custom')));
  await fs.rm(process.env.WORKSPACE, { recursive: true, force: true });
});

test('원문으로 등록: 고른 장에 새 원문(S-번호)이 생기고 출처가 남으며, 다시 등록하면 앞의 원문은 그대로 두고 새 원문을 만든다 · 빈 본문·없는 장은 거절', async () => {
  const store = await freshStore();
  const { book } = await store.loadBookState();
  const ch = (await store.insertChapter({ bookId: book.id, title: '본론' })).chapters[0];
  const other = (await store.insertChapter({ bookId: book.id, title: '결론' })).chapters[1];
  await store.addSource({ docId: other.id, title: '통계', type: 'text', markdown: '2024년 수출은 100억 달러였다.' });
  const { doc } = await store.createCustomDoc({ bookId: book.id, title: '수출 요약' });
  await assert.rejects(store.registerCustomDoc({ bookId: book.id, id: doc.id, chapterId: ch.id }), /본문이 비어 있습니다/);
  await store.saveCustomDoc({ bookId: book.id, id: doc.id, markdown: '2024년 수출은 100억 달러였다.\n\n| 연도 | 수출 |\n|---|---|\n| 2024 | 100 |', picks: [{ chapterId: other.id, sourceId: 'S-001', anchorId: 'S-001.b1.s1', text: '2024년 수출은 100억 달러였다.', loc: '문단 1', at: 't' }] });
  await assert.rejects(store.registerCustomDoc({ bookId: book.id, id: doc.id, chapterId: 'R-999' }), /이 보고서의 장이 아닙니다/);
  const first = await store.registerCustomDoc({ bookId: book.id, id: doc.id, chapterId: ch.id });
  assert.deepEqual([first.source.id, first.source.type, first.source.title, first.source.publisher], ['S-001', 'text', '수출 요약', '작성자']);
  assert.equal(first.source.method, `사용자 지정 문서 ${doc.id} 에서 만듦 · 출처 1곳`);
  assert.deepEqual(first.source.origin, { customId: doc.id, picks: [{ chapterId: other.id, sourceId: 'S-001', anchorId: 'S-001.b1.s1' }] });
  assert.ok(first.source.blocks.some(b => b.kind === 'table')); // 표도 표로 나뉜다
  assert.deepEqual(first.doc.registrations.map(r => [r.chapterId, r.sourceId]), [[ch.id, 'S-001']]);
  const state = await store.loadState(ch.id);
  assert.deepEqual(state.sources.map(s => [s.id, s.method.startsWith('사용자 지정 문서')]), [['S-001', true]]);
  // 고쳐서 다시 등록 — 새 번호, 앞의 원문 그대로
  await store.saveCustomDoc({ bookId: book.id, id: doc.id, markdown: '2024년 수출은 100억 달러였다. 전년보다 늘었다.' });
  const second = await store.registerCustomDoc({ bookId: book.id, id: doc.id, chapterId: ch.id, title: '수출 요약 v2' });
  assert.deepEqual([second.source.id, second.source.title], ['S-002', '수출 요약 v2']);
  const after = await store.loadState(ch.id);
  assert.deepEqual(after.sources.map(s => s.id), ['S-001', 'S-002']);
  assert.equal(after.sources[0].blocks.length, first.source.blocks.length);
  assert.equal(second.doc.registrations.length, 2);
  // 문서를 지워도 등록한 원문은 남는다
  await store.deleteCustomDoc(book.id, doc.id);
  assert.deepEqual((await store.loadState(ch.id)).sources.map(s => s.id), ['S-001', 'S-002']);
  // 한도
  const { doc: big } = await store.createCustomDoc({ bookId: book.id, title: '큰 문서' });
  await assert.rejects(store.saveCustomDoc({ bookId: book.id, id: big.id, markdown: 'x'.repeat(100_001) }), /100,000자까지/);
  await assert.rejects(store.saveCustomDoc({ bookId: book.id, id: big.id, picks: [{ chapterId: 'R-001' }] }), /장·원문·원문 위치/);
  assert.equal((await store.getCustomDoc(book.id, big.id)).markdown, ''); // 거절된 저장은 남지 않는다
  await fs.rm(process.env.WORKSPACE, { recursive: true, force: true });
});
