// 기준 문서(규정·규칙·작성요령·작성 요구사항) 보관·거절·격리, 지시문 한도, 에이전트 프롬프트 블록 (FR-WB-073, 077, 085, DR-WB-006, ERR-WB-008)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chapterBlockText, guidesText, reviewToc, tocText } from '../agent.js';
import { INSTRUCTIONS_LIMIT } from '../public/shared/instructions.js';

// store 는 WORKSPACE 를 불러올 때 읽으므로, 임시 폴더를 정한 뒤에 가져온다
async function freshStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sourceanchor-guides-test-'));
  process.env.WORKSPACE = dir;
  return import(`../lib/store.js?workspace=${encodeURIComponent(dir)}`);
}
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const html = title => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>제1조 목적. 이 규정은 보고서 작성 기준을 정한다.</p><p>제2조 문체. 문장은 짧게 쓴다.</p></body></html>`;

test('기준 문서 등록: 붙여 넣은 본문과 올린 파일(html·txt)을 보고서에 두고 목록·본문·에이전트 상태·보관 파일로 내며, 다른 보고서에는 나타나지 않는다', async () => {
  const store = await freshStore();
  const { book } = await store.loadBookState();
  const a = await store.addGuide({ bookId: book.id, kind: 'regulation', title: ' 작성 규정 ', markdown: '# 규정\n\n제1조 목적. 이 규정은 보고서 작성 기준을 정한다.\n\n제2조 문체. 문장은 짧게 쓴다.' });
  assert.deepEqual([a.guide.id, a.guide.kind, a.guide.type, a.guide.title, a.guide.snapshot], ['G-001', 'regulation', 'text', '작성 규정', undefined]);
  const b = await store.addGuide({ bookId: book.id, kind: 'guideline', fileName: 'tips.html', data: b64(html('작성요령')) });
  assert.deepEqual([b.guide.id, b.guide.kind, b.guide.type, b.guide.title, b.guide.snapshot], ['G-002', 'guideline', 'web', '작성요령', 'originals/G-002.html']);
  const c = await store.addGuide({ bookId: book.id, kind: 'bogus', fileName: 'req.txt', data: b64('작성 요구사항 첫 줄.\n둘째 줄.') });
  assert.deepEqual([c.guide.id, c.guide.kind, c.guide.type, c.guide.title, c.guide.fileName], ['G-003', 'other', 'text', 'req.txt', 'req.txt']);
  assert.deepEqual(c.guides.map(g => g.id), ['G-001', 'G-002', 'G-003']);

  const state = await store.loadBookState(book.id);
  assert.deepEqual(state.guides.map(g => [g.id, g.kind, g.type]), [['G-001', 'regulation', 'text'], ['G-002', 'guideline', 'web'], ['G-003', 'other', 'text']]);
  assert.ok(state.guides.every(g => g.blocks === undefined && g.chars > 0)); // 목록에는 본문이 없다
  const full = await store.getGuide(book.id, 'G-002');
  assert.ok(full.blocks.some(bl => bl.sentences.some(s => s.text.includes('제2조'))));
  assert.ok(full.blocks.every(bl => bl.id.startsWith('G-002.')));
  // 에이전트가 읽는 상태에는 본문까지 실린다
  const agentState = await store.bookAgentState(book.id);
  assert.deepEqual(agentState.guides.map(g => g.id), ['G-001', 'G-002', 'G-003']);
  assert.ok(agentState.guides[0].blocks.length > 0);
  assert.deepEqual((await store.fullGuides(book.id)).map(g => g.id), ['G-001', 'G-002', 'G-003']);
  // 보관 파일 — 원본은 올린 파일에만 있다
  const original = await store.readGuideFile(book.id, 'G-002', 'original');
  assert.equal(original.name, 'G-002.html');
  assert.ok(original.data.toString('utf8').includes('<h1>작성요령</h1>'));
  assert.ok((await store.readGuideFile(book.id, 'G-001', 'markdown')).data.toString('utf8').includes('제1조'));
  await assert.rejects(store.readGuideFile(book.id, 'G-001', 'original'), /올린 원본이 없습니다/);
  await assert.rejects(store.getGuide(book.id, 'G-009'), /찾지 못했습니다/);
  // 다른 보고서에는 나타나지 않는다
  const other = await store.createBook({ title: '다른 보고서' });
  assert.deepEqual(other.guides, []);
  assert.deepEqual((await store.bookAgentState(other.book.id)).guides, []);
  await assert.rejects(store.getGuide(other.book.id, 'G-001'), /찾지 못했습니다/);
  // 다시 불러와도 그대로다 (파일에서 읽는다)
  const again = await import(`../lib/store.js?reload=${Date.now()}`);
  assert.deepEqual((await again.loadBookState(book.id)).guides.map(g => g.id), ['G-001', 'G-002', 'G-003']);
  await fs.rm(process.env.WORKSPACE, { recursive: true, force: true });
});

test('기준 문서 거절·고치기·삭제: 지원하지 않는 형식·빈 본문·큰 파일은 등록하지 않고 파일을 남기지 않으며, 지운 번호는 다시 쓰지 않고, 보고서를 지우면 함께 지운다', async () => {
  const store = await freshStore();
  const { book } = await store.loadBookState();
  const guidesDir = path.join(process.env.WORKSPACE, 'projects', book.id, 'guides');
  await assert.rejects(store.addGuide({ bookId: book.id, kind: 'rule', fileName: 'a.docx', data: b64('PK-docx') }), /지원하지 않는 형식\(DOCX\)/);
  await assert.rejects(store.addGuide({ bookId: book.id, kind: 'rule', markdown: '   ' }), /본문이 비어 있습니다/);
  await assert.rejects(store.addGuide({ bookId: book.id, kind: 'rule', fileName: 'big.txt', data: Buffer.alloc(5 * 1024 * 1024 + 1, 97).toString('base64') }), /5MiB 를 넘습니다/);
  await assert.rejects(store.addGuide({ bookId: book.id, kind: 'rule', fileName: 'old.bin', data: Buffer.from('d0cf11e0a1b11ae100', 'hex').toString('base64') }), /예전 Office 형식/);
  await assert.rejects(store.addGuide({ bookId: book.id, kind: 'rule', fileName: 'x.txt', data: 123 }), /base64/);
  assert.deepEqual(await fs.readdir(guidesDir).catch(() => []), []); // 실패는 아무것도 남기지 않는다
  assert.deepEqual((await store.loadBookState(book.id)).guides, []);

  await store.addGuide({ bookId: book.id, kind: 'rule', markdown: '규칙 하나.' });
  await store.addGuide({ bookId: book.id, kind: 'rule', markdown: '규칙 둘.' });
  assert.deepEqual((await store.deleteGuide(book.id, 'G-001')).guides.map(g => g.id), ['G-002']);
  await assert.rejects(fs.access(path.join(guidesDir, 'G-001.json')));
  await assert.rejects(fs.access(path.join(guidesDir, 'G-001.md')));
  await assert.rejects(store.deleteGuide(book.id, 'G-001'), /찾지 못했습니다/);
  const third = await store.addGuide({ bookId: book.id, kind: 'rule', markdown: '규칙 셋.' });
  assert.equal(third.guide.id, 'G-003'); // 지운 번호는 다시 쓰지 않는다
  const edited = await store.updateGuide({ bookId: book.id, id: 'G-003', kind: 'requirement', title: ' 새 제목 ' });
  assert.deepEqual([edited.guide.kind, edited.guide.title], ['requirement', '새 제목']);
  assert.ok((await store.readGuideFile(book.id, 'G-003', 'markdown')).data.toString('utf8').includes('새 제목'));
  assert.equal((await store.updateGuide({ bookId: book.id, id: 'G-003', title: '' })).guide.title, '제목 없는 기준 문서');

  const other = await store.createBook({ title: '남는 보고서' });
  await store.deleteBook(book.id);
  await assert.rejects(fs.access(guidesDir));
  assert.deepEqual((await store.loadBookState(other.book.id)).guides, []);
  await fs.rm(process.env.WORKSPACE, { recursive: true, force: true });
});

test('지시문 한도: 저장·장 추가·목차 수정안 모두 12,000자를 넘으면 자르지 않고 거절하고, 저장된 값은 그대로 둔다', async () => {
  const store = await freshStore();
  const { book } = await store.loadBookState();
  const ok = 'a'.repeat(INSTRUCTIONS_LIMIT);
  const long = `${ok}b`;
  const state = await store.insertChapter({ bookId: book.id, title: 'a', instructions: ok });
  const ch = state.chapters[0];
  assert.equal(ch.instructions.length, INSTRUCTIONS_LIMIT);
  await assert.rejects(store.insertChapter({ bookId: book.id, title: 'b', instructions: long }), /12,000자까지입니다 \(12,001자\)/);
  await assert.rejects(store.saveToc({ bookId: book.id, chapters: [{ id: ch.id, title: 'a', instructions: long, level: 1 }] }), /12,000자까지/);
  assert.deepEqual((await store.loadBookState(book.id)).chapters.map(c => [c.title, c.instructions.length]), [['a', INSTRUCTIONS_LIMIT]]);
  const chapters = [{ id: ch.id, title: 'a', instructions: ok, level: 1, doc: { blocks: [] }, sources: [] }];
  const items = reviewToc([
    { op: 'instructions', chapter_id: ch.id, instructions: long },
    { op: 'add', title: 'c', instructions: long },
    { op: 'instructions', chapter_id: ch.id, instructions: '## 제약조건\n짧게' },
  ], chapters);
  assert.deepEqual(items.map(i => (i.invalid ? i.problems[0] : 'ok')), ['지시문은 12,000자까지입니다 (12,001자)', '지시문은 12,000자까지입니다 (12,001자)', 'ok']);
  assert.equal(items[2].before, ok);
  // 보고서 공통 지시문 수정안 — 헤딩 순서 절 거절, 같은 값 거절 (FR-WB-087)
  const report = reviewToc([
    { op: 'report_instructions', instructions: '## 헤딩 순서\n가' },
    { op: 'report_instructions', instructions: '## 문체 및 예시\n짧게' },
    { op: 'report_instructions', instructions: '' },
  ], chapters, { instructions: '' });
  assert.match(report[0].problems[0], /헤딩 순서 절을 둘 수 없습니다/);
  assert.deepEqual([report[1].invalid, report[1].before, report[1].instructions], [undefined, '', '## 문체 및 예시\n짧게']);
  assert.match(report[2].problems[0], /지금과 같습니다/);
  await fs.rm(process.env.WORKSPACE, { recursive: true, force: true });
});

test('보고서 공통 지시문·하위 장 적용 여부: 저장·불러오기, 헤딩 순서 절 거절, 장·에이전트 상태에 실린다 (FR-WB-087, DR-WB-005)', async () => {
  const store = await freshStore();
  const { book } = await store.loadBookState();
  await store.insertChapter({ bookId: book.id, title: 'ㄱ', instructions: '## 제약조건\n표 1개' });
  const sub = (await store.insertChapter({ bookId: book.id, title: 'ㄱ-1', level: 2 })).chapters[1];
  let state = await store.saveToc({ bookId: book.id, instructions: '## 문체 및 예시\n짧게 쓴다.' });
  assert.equal(state.book.instructions, '## 문체 및 예시\n짧게 쓴다.');
  assert.deepEqual(state.chapters.map(c => c.cascade), [true, true]);
  await assert.rejects(store.saveToc({ bookId: book.id, instructions: '## 헤딩 순서\n1. 개요' }), /헤딩 순서 절을 둘 수 없습니다/);
  state = await store.saveToc({ bookId: book.id, chapters: state.chapters.map((c, i) => ({ id: c.id, title: c.title, instructions: c.instructions, level: c.level, cascade: i === 0 ? false : undefined })) });
  assert.deepEqual(state.chapters.map(c => c.cascade), [false, true]);
  const chapterState = await store.loadState(sub.id);
  assert.equal(chapterState.book.instructions, '## 문체 및 예시\n짧게 쓴다.');
  assert.deepEqual(chapterState.book.chapters.map(c => [c.id, c.cascade]), [[state.chapters[0].id, false], [sub.id, true]]);
  const agentState = await store.bookAgentState(book.id);
  assert.equal(agentState.instructions, '## 문체 및 예시\n짧게 쓴다.');
  assert.deepEqual(agentState.chapters.map(c => c.cascade), [false, true]);
  const again = await import(`../lib/store.js?reload2=${Date.now()}`);
  const loaded = await again.loadBookState(book.id);
  assert.equal(loaded.book.instructions, '## 문체 및 예시\n짧게 쓴다.');
  assert.deepEqual(loaded.chapters.map(c => c.cascade), [false, true]);
  await fs.rm(process.env.WORKSPACE, { recursive: true, force: true });
});

test('프롬프트 블록: 장 대화의 <chapter> 는 지시문 전문·목차(이 장 표시)를, <guides> 는 기준 문서 목록·본문을 담고, 보고서 대화의 <toc> 는 지시문이 길면 파일만 알린다', () => {
  const chapters = [{ id: 'R-001', title: '서론', level: 1, instructions: '## 제약조건\n2024년 이후' }, { id: 'R-002', title: '본론', level: 2, instructions: '' }];
  const block = chapterBlockText({ doc: { id: 'R-002', title: '본론' }, book: { title: '보고서', instructions: '## 문체 및 예시\n짧게 쓴다.', chapters }, instructions: '' });
  assert.ok(block.startsWith('<chapter>\nreport: 보고서\n') && block.endsWith('</chapter>'));
  assert.ok(block.includes('this chapter: R-002 | 1.1 | 본론'));
  assert.ok(block.includes('## 문체 및 예시\n[보고서 공통]\n짧게 쓴다.')); // 보고서 공통은 모든 장에 (FR-WB-087)
  assert.ok(block.includes('## 제약조건\n[상위 장 R-001 서론]\n2024년 이후')); // 상위 장의 다섯 절이 하위 장에
  assert.ok(!block.includes('(none yet)'));
  assert.ok(block.includes('▶ R-002 | 1.1 | level 2 | 본론'));
  assert.ok(block.includes('  R-001 | 1 | level 1 | 서론'));
  const noCascade = chapterBlockText({ doc: { id: 'R-002', title: '본론' }, book: { title: '보고서', chapters: chapters.map(c => (c.id === 'R-001' ? { ...c, cascade: false } : c)) }, instructions: '' });
  assert.ok(noCascade.includes('(none yet)')); // 하위 장에 적용을 끄면 물려받지 않는다
  const withInstr = chapterBlockText({ doc: { id: 'R-001', title: '서론' }, book: { title: '보고서', chapters }, instructions: chapters[0].instructions });
  assert.ok(withInstr.includes('## 제약조건\n[이 장 R-001 서론]\n2024년 이후'));
  assert.ok(chapterBlockText({ doc: { id: 'R-009', title: '홀로' }, book: null, instructions: '' }).includes('not in a report outline'));

  assert.ok(guidesText([]).includes('no reference documents'));
  const guide = { id: 'G-001', kind: 'regulation', title: '작성 규정', fileName: 'r.pdf', collectedAt: 't', hash: 'h', type: 'pdf',
    blocks: [{ id: 'G-001.b1', kind: 'paragraph', loc: { page: 3 }, sentences: [{ id: 'G-001.b1.s1', text: '제1조 목적.' }] }] };
  const g = guidesText([guide]);
  assert.ok(g.includes('- G-001 [규정] 작성 규정 (r.pdf) — file guides/G-001.md'));
  assert.ok(g.includes('[G-001.b1.s1] 제1조 목적.'));

  const full = chapters.map(ch => ({ ...ch, doc: { blocks: [] }, sources: [] }));
  const toc = tocText(full, '## 문체 및 예시\n짧게');
  assert.ok(toc.startsWith('report instructions (apply to every chapter; five sections, no 헤딩 순서): \n        ## 문체 및 예시\n        짧게\n'));
  assert.ok(toc.includes('R-001 | 1 | level 1 | 서론 | applies to its sub-chapters\n    instructions: \n        ## 제약조건\n        2024년 이후\n    sentences: 0 | sources: 0'));
  assert.ok(toc.includes('R-002 | 1.1 | level 2 | 본론\n    instructions: (none)'));
  assert.ok(tocText(full.map(c => (c.id === 'R-001' ? { ...c, cascade: false } : c))).includes('서론 | does NOT apply to its sub-chapters'));
  assert.ok(tocText([]).endsWith('(no chapters yet)'));
  const bigToc = tocText(full.map(ch => ({ ...ch, instructions: 'x'.repeat(40_000) })));
  assert.ok(bigToc.includes('instructions: (40000 chars — read toc/R-001.md)'));
  assert.ok(!bigToc.includes('xxxxx'));
});
