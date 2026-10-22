// 기준 문서 합치기·되돌리기 — ID 이어 매기기, 구조 다시 정하기, 보관본, 거듭 되돌리기, 거절, 끊긴 합치기 정리, 삭제 (FR-WB-099, DR-WB-006, ERR-WB-013)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as convert from '../lib/guide_convert.js';
import { mergeBlocks } from '../lib/guide_merge.js';

async function freshStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sourceanchor-guide-merge-test-'));
  process.env.WORKSPACE = dir;
  return import(`../lib/store.js?workspace=${encodeURIComponent(dir)}`);
}
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const ids = guide => guide.blocks.flatMap(b => [b.id, ...b.sentences.map(s => s.id)]);
const texts = guide => guide.blocks.flatMap(b => b.sentences.map(s => s.text));
const R1 = '# PART 6 Electrical Equipment\n\n## CHAPTER 1 ELECTRICAL EQUIPMENT\n\n### Section 1 General\n\n101. General 이 장은 전기 설비에 적용한다. 둘째 문장이다.\n\n- 첫 항목\n- 둘째 항목';
const R2 = '## CHAPTER 2 CONTROL SYSTEMS\n\n### Section 1 General\n\n101. General 이 장은 제어 시스템에 적용한다.\n\n| 항목 | 값 |\n| --- | --- |\n| 전압 | 440 V |';
const R3 = '## CHAPTER 3 ANNEX\n\n부록 문장이다.';

test('블록 이어 매기기: 앞 본문 ID 는 그대로, 등록 때 ID 는 블록 번호를, 쪽 기준 ID 는 쪽을 앞 본문의 마지막 값에 잇고 위치(쪽·문단)도 옮긴다 — 입력은 고치지 않는다', () => {
  const block = (id, loc, more = {}) => ({ id, kind: 'paragraph', loc, sentences: [{ id: `${id}.s1`, text: id }], ...more });
  const target = { id: 'G-001', blocks: [block('G-001.p1.b1', { page: 1 }), block('G-001.p3.b1', { page: 3 }), block('G-001.b7', { page: 4 })] };
  const member = { id: 'G-004', blocks: [
    block('G-004.p1.b1', { page: 1 }),
    { id: 'G-004.p2.b2', kind: 'table', loc: { page: 2 }, sentences: [], table: { columns: ['a', 'b'], rows: [{ header: 'x', cells: [{ id: 'G-004.p2.b2.r1c1', text: '1' }] }] } },
    block('G-004.b3', { page: 2 }),
  ] };
  const before = JSON.stringify(member);
  const merged = mergeBlocks(target, member);
  assert.deepEqual(merged.map(b => [b.id, b.loc.page]), [['G-001.p1.b1', 1], ['G-001.p3.b1', 3], ['G-001.b7', 4], ['G-001.p5.b1', 5], ['G-001.p6.b2', 6], ['G-001.b10', 6]]);
  assert.deepEqual([merged[3].sentences[0].id, merged[4].table.rows[0].cells[0].id, merged[5].sentences[0].id], ['G-001.p5.b1.s1', 'G-001.p6.b2.r1c1', 'G-001.b10.s1']);
  assert.equal(JSON.stringify(member), before);
  assert.ok(target.blocks.every(b => !('parent' in b)));
  // 문단 순번(텍스트·Markdown)도 잇는다
  const text = mergeBlocks({ id: 'G-002', blocks: [block('G-002.b1', { para: 1 }), block('G-002.b2', { para: 2 })] }, { id: 'G-003', blocks: [block('G-003.b1', { para: 1 })] });
  assert.deepEqual(text.map(b => [b.id, b.loc.para]), [['G-002.b1', 1], ['G-002.b2', 2], ['G-002.b3', 3]]);
});

test('합치기·되돌리기: 끌어 온 문서가 놓은 문서 뒤에 이어지고 판이 오르며, 거듭 되돌리면 반대 차례로 합치기 직전 그대로 돌아온다', async () => {
  const store = await freshStore();
  const { book } = await store.loadBookState();
  const add = markdown => store.addGuide({ bookId: book.id, kind: 'guideline', markdown });
  await add(R1);
  await store.addGuide({ bookId: book.id, kind: 'reference', fileName: '02_R.md', data: b64(R2) });
  await add(R3);
  const original = await Promise.all(['G-001', 'G-002', 'G-003'].map(id => store.getGuide(book.id, id).then(g => structuredClone(g))));
  const dir = path.join(process.env.WORKSPACE, 'projects', book.id, 'guides');

  const first = await store.mergeGuide({ bookId: book.id, id: 'G-001', from: 'G-002' });
  assert.deepEqual(first.guides.map(g => [g.id, g.version, g.docs ?? 1]), [['G-001', 'V-002', 2], ['G-003', 'V-001', 1]]);
  assert.deepEqual(first.guide.merges.map(m => [m.id, m.title, m.fileName, m.docs]), [['G-002', '02_R.md', '02_R.md', 1]]);
  const merged = await store.getGuide(book.id, 'G-001');
  const n = original[0].blocks.length;
  assert.deepEqual(ids(merged).slice(0, ids(original[0]).length), ids(original[0])); // 앞 본문의 ID 는 그대로
  assert.deepEqual(merged.blocks.slice(n).map(b => b.id), original[1].blocks.map((_, i) => `G-001.b${n + i + 1}`));
  assert.deepEqual(texts(merged), [...texts(original[0]), ...texts(original[1])]);
  assert.equal(merged.blocks.at(-1).table.rows[0].cells[0].id, `G-001.b${n + original[1].blocks.length}.r1c1`);
  // 구조는 합친 본문 전체로 — CHAPTER 2 가 PART 6 아래 CHAPTER 1 과 같은 단계
  const byText = text => merged.blocks.find(b => b.sentences[0]?.text.startsWith(text));
  assert.deepEqual([byText('CHAPTER 2').parent, byText('CHAPTER 2').depth], [byText('PART 6').id, 2]);
  assert.deepEqual(merged.blocks.slice(0, n).map(b => [b.parent, b.depth]), original[0].blocks.map(b => [b.parent, b.depth]));
  // 보관 — 붙은 문서는 목록·최상위 파일에서 빠지고 merged/ 에 두 보관본, Markdown 파일에 이어진 ID
  assert.deepEqual((await fs.readdir(path.join(dir, 'merged'))).sort(), ['G-001@1.json', 'G-002.json']);
  await assert.rejects(fs.access(path.join(dir, 'G-002.json')));
  await assert.rejects(fs.access(path.join(dir, 'G-002.md')));
  assert.ok((await fs.access(path.join(dir, 'originals', 'G-002.md')).then(() => true)));
  assert.match(await fs.readFile(path.join(dir, 'G-001.md'), 'utf8'), new RegExp(`\\[G-001\\.b${n + 1}\\.s1\\] CHAPTER 2 CONTROL SYSTEMS`));
  await assert.rejects(store.getGuide(book.id, 'G-002'), /찾지 못했습니다/);

  const second = await store.mergeGuide({ bookId: book.id, id: 'G-001', from: 'G-003' });
  assert.deepEqual(second.guides.map(g => [g.id, g.version, g.docs]), [['G-001', 'V-003', 3]]);
  // 다시 불러와도 합친 상태 그대로
  const again = await import(`../lib/store.js?reload=${Date.now()}`);
  assert.deepEqual((await again.loadBookState(book.id)).guides.map(g => [g.id, g.docs]), [['G-001', 3]]);

  const undo1 = await store.unmergeGuide({ bookId: book.id, id: 'G-001' });
  assert.deepEqual(undo1.guides.map(g => [g.id, g.version, g.docs ?? 1]), [['G-001', 'V-004', 2], ['G-003', 'V-001', 1]]);
  assert.deepEqual(await store.getGuide(book.id, 'G-003'), original[2]);
  const undo2 = await store.unmergeGuide({ bookId: book.id, id: 'G-001' });
  assert.deepEqual(undo2.guides.map(g => [g.id, g.kind, g.version, g.merges]), [['G-001', 'guideline', 'V-005', undefined], ['G-002', 'reference', 'V-001', undefined], ['G-003', 'guideline', 'V-001', undefined]]);
  assert.deepEqual(await store.getGuide(book.id, 'G-001'), { ...original[0], version: 'V-005' });
  assert.deepEqual(await store.getGuide(book.id, 'G-002'), original[1]);
  assert.deepEqual(await fs.readdir(path.join(dir, 'merged')), []);
  assert.match(await fs.readFile(path.join(dir, 'G-002.md'), 'utf8'), /\[G-002\.b1\.s1\] CHAPTER 2 CONTROL SYSTEMS/);
  // 다시 불러와도 되돌린 그대로
  const third = await import(`../lib/store.js?reload=${Date.now() + 1}`);
  assert.deepEqual((await third.loadBookState(book.id)).guides.map(g => [g.id, g.version]), [['G-001', 'V-005'], ['G-002', 'V-001'], ['G-003', 'V-001']]);
});

test('거절: 자기 자신·없는 문서·합친 적 없는 문서 되돌리기·합친 문서 변환·변환 대기·진행 중인 문서는 사유와 함께 거절하고 아무것도 바꾸지 않는다 (ERR-WB-013)', async () => {
  const store = await freshStore();
  const { book } = await store.loadBookState();
  for (const markdown of [R1, R2, R3]) await store.addGuide({ bookId: book.id, kind: 'guideline', markdown });
  await store.addGuide({ bookId: book.id, kind: 'guideline', fileName: 'x.txt', data: b64('제1조 변환 대상이다.') });
  await assert.rejects(store.mergeGuide({ bookId: book.id, id: 'G-001', from: 'G-001' }), err => err.status === 400 && /같은 문서/.test(err.message));
  await assert.rejects(store.mergeGuide({ bookId: book.id, id: 'G-001', from: 'G-009' }), err => err.status === 404);
  await assert.rejects(store.unmergeGuide({ bookId: book.id, id: 'G-001' }), err => err.status === 400 && /합친 문서가 아닙니다/.test(err.message));
  // 합친 문서는 변환하지 않는다 — PDF 로 올린 문서처럼 꾸며 본다
  await store.mergeGuide({ bookId: book.id, id: 'G-001', from: 'G-002' });
  Object.assign(await store.getGuide(book.id, 'G-001'), { type: 'pdf', snapshot: 'originals/G-004.txt' });
  await assert.rejects(store.convertGuide({ bookId: book.id, id: 'G-001', action: 'start' }), err => err.status === 409 && /합친 문서는 변환할 수 없습니다/.test(err.message));
  // 변환 대기·진행 중 — 쪽 글 얻기를 붙잡아 진행 중으로 둔다
  let release;
  Object.assign(convert.deps, { cliAvailable: () => true, disabled: () => '', pdfPages: () => new Promise((_, reject) => { release = () => reject(new Error('시험 끝')); }) });
  Object.assign(await store.getGuide(book.id, 'G-004'), { type: 'pdf' });
  await store.convertGuide({ bookId: book.id, id: 'G-004', action: 'start' });
  assert.ok(convert.isQueued(convert.keyOf(book.id, 'G-004')));
  await assert.rejects(store.mergeGuide({ bookId: book.id, id: 'G-001', from: 'G-004' }), err => err.status === 409 && /변환 대기·진행 중/.test(err.message));
  await assert.rejects(store.mergeGuide({ bookId: book.id, id: 'G-004', from: 'G-003' }), err => err.status === 409);
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  release();
  await convert.whenIdle();
  assert.deepEqual((await store.guideList(book.id)).map(g => [g.id, g.docs ?? 1]), [['G-001', 2], ['G-003', 1], ['G-004', 1]]);
});

test('끊긴 합치기·삭제: 합친 문서에 든 문서가 목록 파일로 남아 있으면 불러올 때 정리하고, 합친 문서를 지우면 붙은 문서의 원본·보관본도 지운다', async () => {
  const store = await freshStore();
  const { book } = await store.loadBookState();
  await store.addGuide({ bookId: book.id, kind: 'guideline', markdown: R1 });
  await store.addGuide({ bookId: book.id, kind: 'guideline', fileName: '02_R.md', data: b64(R2) });
  await store.addGuide({ bookId: book.id, kind: 'guideline', fileName: '03.txt', data: b64(R3) });
  await store.mergeGuide({ bookId: book.id, id: 'G-002', from: 'G-003' }); // 합친 문서를 다시 합친다
  await store.mergeGuide({ bookId: book.id, id: 'G-001', from: 'G-002' });
  const dir = path.join(process.env.WORKSPACE, 'projects', book.id, 'guides');
  assert.deepEqual((await store.guideList(book.id)).map(g => [g.id, g.docs]), [['G-001', 3]]);
  // 붙은 문서의 json 이 최상위에 다시 생긴 상태(합치기 도중 끊김)를 흉내 낸다
  await fs.copyFile(path.join(dir, 'merged', 'G-002.json'), path.join(dir, 'G-002.json'));
  const again = await import(`../lib/store.js?reload=${Date.now()}`);
  assert.deepEqual((await again.loadBookState(book.id)).guides.map(g => g.id), ['G-001']);
  await assert.rejects(fs.access(path.join(dir, 'G-002.json')));
  // 되돌리면 합친 문서였던 G-002 가 그 합침(G-003)과 함께 돌아온다
  await again.unmergeGuide({ bookId: book.id, id: 'G-001' });
  assert.deepEqual((await again.guideList(book.id)).map(g => [g.id, g.docs ?? 1]), [['G-001', 1], ['G-002', 2]]);
  await again.mergeGuide({ bookId: book.id, id: 'G-001', from: 'G-002' });
  await again.deleteGuide(book.id, 'G-001');
  assert.deepEqual((await again.guideList(book.id)), []);
  assert.deepEqual(await fs.readdir(path.join(dir, 'merged')), []);
  assert.deepEqual(await fs.readdir(path.join(dir, 'originals')), []);
  assert.deepEqual((await fs.readdir(dir)).filter(f => f.endsWith('.json') || f.endsWith('.md')), []);
});
