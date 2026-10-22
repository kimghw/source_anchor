// 양식 저장소 — 올리기·목록·조회·저장·삭제·번호 불변·작업공간 공통(보고서를 넘어 같은 목록, 보고서를 지워도 남음, 옛 보고서 아래 양식 옮기기)·재시작 후 유지, 거절된 올리기, 원본·내보내기 파일, 내려받기 이름,
// 구조 조절 저장 → 작업공간 수준 구조 규칙 파일·목록·삭제·올릴 때 적용·에이전트 상태 (FR-WB-090 ~ 092, 094, 095, DR-WB-008, DR-WB-009, ERR-WB-011)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RULES_FILE } from '../lib/form_rules.js';
import { buildForm, scanForm } from '../lib/forms.js';
import { downloadDisposition } from '../lib/http_names.js';
import { docxHeading, docxOf, docxSentence, docxTable } from './fixtures/form_docs.js';

async function freshStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sourceanchor-form-test-'));
  process.env.WORKSPACE = dir;
  return import(`../lib/store.js?workspace=${encodeURIComponent(dir)}`);
}

const docx = docxOf(docxTable);
const upload = (store, bookId, extra = {}) => store.addForm({ bookId, fileName: '회의록.docx', data: docx.toString('base64'), ...extra });
const formsDir = () => path.join(process.env.WORKSPACE, 'forms'); // 양식은 작업공간 공통 — 보고서 폴더 아래가 아니다 (DR-WB-008)

test('양식: 올리기·목록·조회·저장·삭제, 지운 번호는 다시 쓰지 않고, 작업공간 공통이라 다른 보고서에서도 같은 목록이며, 다시 불러와도 남고, 보고서를 지워도 남는다', async () => {
  const store = await freshStore();
  const { book } = await store.loadBookState();
  const a = await upload(store, book.id);
  assert.deepEqual([a.form.id, a.form.title], ['F-001', '회의록']);
  assert.equal(a.forms[0].units, 9);
  assert.equal(a.forms[0].tables, undefined); // 목록에는 구조가 없다
  assert.equal(a.forms[0].nodes, undefined);
  const b = await upload(store, book.id, { title: ' 둘째 ' });
  assert.deepEqual([b.form.id, b.form.title], ['F-002', '둘째']);
  const saved = await store.saveForm({ bookId: book.id, id: 'F-001', values: { 3: '새 과제' }, instructions: { 3: '한 줄로' } });
  assert.deepEqual([saved.form.values, saved.form.instructions, saved.forms[0].changed], [{ 3: '새 과제' }, { 3: '한 줄로' }, 1]);
  assert.equal((await store.getForm(book.id, 'F-001')).values[3], '새 과제');
  await assert.rejects(store.saveForm({ bookId: book.id, id: 'F-001', title: '바뀜', values: { 99: 'x' } }), /없는 단위/);
  assert.equal((await store.getForm(book.id, 'F-001')).title, '회의록'); // 거절된 저장은 캐시도 그대로
  await assert.rejects(store.getForm(book.id, 'F-009'), /찾지 못했습니다/);
  await assert.rejects(store.getForm('M-999', 'F-001'), /보고서를 찾지 못했습니다/); // 맥락 보고서는 있어야 한다
  assert.deepEqual((await store.deleteForm(book.id, 'F-001')).forms.map(f => f.id), ['F-002']);
  await assert.rejects(store.deleteForm(book.id, 'F-001'), /찾지 못했습니다/);
  assert.equal((await upload(store, book.id)).form.id, 'F-003'); // 지운 번호는 다시 쓰지 않는다
  assert.deepEqual((await store.loadBookState(book.id)).forms.map(f => f.id), ['F-002', 'F-003']);
  assert.equal(JSON.parse(await fs.readFile(path.join(process.env.WORKSPACE, 'workspace.json'), 'utf8')).formSeq, 3); // 번호는 작업공간 파일에
  assert.deepEqual((await fs.readdir(formsDir())).sort(), ['F-002.json', 'F-003.json', 'originals']);
  // 양식은 보고서에 속하지 않는다 — 새 보고서에서도 같은 목록·같은 값이고, 거기서 올린 것도 같은 번호 체계를 쓴다
  const other = await store.createBook({ title: '다른 보고서' });
  assert.deepEqual(other.forms.map(f => f.id), ['F-002', 'F-003']);
  assert.equal((await store.getForm(other.book.id, 'F-002')).title, '둘째');
  assert.equal((await upload(store, other.book.id)).form.id, 'F-004');
  assert.deepEqual((await store.loadBookState(book.id)).forms.map(f => f.id), ['F-002', 'F-003', 'F-004']);
  const again = await import(`../lib/store.js?reload=${Date.now()}`);
  assert.deepEqual((await again.formList(book.id)).map(f => f.id), ['F-002', 'F-003', 'F-004']);
  assert.equal((await again.formAgentState(book.id, 'F-002')).form.id, 'F-002');
  assert.equal((await again.formAgentState(other.book.id, 'F-002')).book.id, other.book.id); // 에이전트가 읽는 보고서는 양식을 연 쪽
  await again.deleteBook(book.id);
  assert.deepEqual((await again.formList(other.book.id)).map(f => f.id), ['F-002', 'F-003', 'F-004']); // 보고서를 지워도 양식은 남는다
  assert.deepEqual((await fs.readdir(formsDir())).sort(), ['F-002.json', 'F-003.json', 'F-004.json', 'originals']);
  await fs.rm(process.env.WORKSPACE, { recursive: true, force: true });
});

test('옮기기: 보고서 아래(projects/<M>/forms/)에 두던 양식은 처음 읽을 때 작업공간 공통으로 옮기고, 겹치는 번호는 새 번호를 받으며 그 규칙의 formId 도 따라간다', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sourceanchor-form-test-'));
  process.env.WORKSPACE = dir;
  const legacy = async (bookId, form, original) => {
    await fs.mkdir(path.join(dir, 'projects', bookId, 'forms', 'originals'), { recursive: true });
    await fs.writeFile(path.join(dir, 'projects', bookId, 'forms', `${form.id}.json`), JSON.stringify(form));
    await fs.writeFile(path.join(dir, 'projects', bookId, 'forms', form.original), original);
  };
  const { form: f1 } = await buildForm({ id: 'F-001', fileName: '회의록.docx', data: docx });
  const { form: f2 } = await buildForm({ id: 'F-002', fileName: '계획서.docx', data: bodyDocx });
  for (const [bookId, seq] of [['M-001', 3], ['M-002', 1]]) {
    await fs.mkdir(path.join(dir, 'projects', bookId), { recursive: true });
    await fs.writeFile(path.join(dir, 'projects', bookId, 'main.json'), JSON.stringify({ id: bookId, title: bookId, chapters: [], formSeq: seq }));
  }
  await legacy('M-001', { ...f1, values: { 3: '값' } }, docx);
  await legacy('M-001', f2, bodyDocx);
  await legacy('M-002', { ...f1, title: '둘째 보고서의 것' }, docx); // M-002/F-001 — 번호가 겹친다
  await fs.writeFile(path.join(dir, RULES_FILE), JSON.stringify({ rules: [
    { id: 'SR-001', heading: '', text: '1. 제안 개요', kind: 'heading', level: 3, fileName: '계획서.docx', bookId: 'M-001', formId: 'F-002', at: 't' },
    { id: 'SR-002', heading: '', text: 'x', kind: 'field', level: 2, fileName: '회의록.docx', bookId: 'M-002', formId: 'F-001', at: 't' },
  ] }));
  const store = await import(`../lib/store.js?workspace=${encodeURIComponent(dir)}&migrate=1`);
  const state = await store.loadBookState('M-002');
  assert.deepEqual(state.forms.map(f => [f.id, f.title, f.changed]), [['F-001', '회의록', 1], ['F-002', '계획서', 0], ['F-004', '둘째 보고서의 것', 0]]); // M-001 의 formSeq 3 을 이어받아 F-004
  assert.ok((await store.readFormFile('M-001', 'F-004', 'original')).data.equals(docx));
  assert.equal((await store.getForm('M-002', 'F-004')).original, 'originals/F-004.docx');
  assert.deepEqual((await store.formRules()).rules.map(r => [r.id, r.bookId, r.formId]), [['SR-001', 'M-001', 'F-002'], ['SR-002', 'M-002', 'F-004']]);
  assert.deepEqual((await fs.readdir(path.join(dir, 'forms'))).sort(), ['F-001.json', 'F-002.json', 'F-004.json', 'originals']);
  for (const bookId of ['M-001', 'M-002']) {
    await assert.rejects(fs.access(path.join(dir, 'projects', bookId, 'forms')));
    assert.equal('formSeq' in JSON.parse(await fs.readFile(path.join(dir, 'projects', bookId, 'main.json'), 'utf8')), false);
  }
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'workspace.json'), 'utf8')).formSeq, 4);
  assert.equal((await upload(store, 'M-001')).form.id, 'F-005');
  const fresh = await import(`../lib/store.js?reload=${Date.now()}`);
  assert.deepEqual((await fresh.formList('M-001')).map(f => f.id), ['F-001', 'F-002', 'F-004', 'F-005']); // 두 번째 읽기는 옮길 것이 없다
  await fs.rm(dir, { recursive: true, force: true });
});

test('거절된 올리기는 파일·번호를 남기지 않는다', async () => {
  const store = await freshStore();
  const { book } = await store.loadBookState();
  await assert.rejects(store.addForm({ bookId: book.id, fileName: '메모.txt', data: Buffer.from('hi').toString('base64') }), err => err.status === 400);
  await assert.rejects(store.addForm({ bookId: book.id, fileName: '회의록.docx', data: 123 }), err => err.status === 400 && /base64/.test(err.message));
  assert.deepEqual(await fs.readdir(formsDir()).catch(() => []), []);
  assert.equal((await upload(store, book.id)).form.id, 'F-001');
  await fs.rm(process.env.WORKSPACE, { recursive: true, force: true });
});

test('readFormFile: 원본은 올린 그대로, 내보내기는 값이 든 새 사본, 잠긴 칸 값이면 409', async () => {
  const store = await freshStore();
  const { book } = await store.loadBookState();
  await upload(store, book.id);
  const original = await store.readFormFile(book.id, 'F-001', 'original');
  assert.ok(original.data.equals(docx));
  assert.deepEqual([original.name, original.downloadName], ['F-001.docx', '회의록.docx']);
  await store.saveForm({ bookId: book.id, id: 'F-001', values: { 3: '새 과제' } });
  const exported = await store.readFormFile(book.id, 'F-001', 'export');
  assert.deepEqual([exported.name, exported.downloadName], ['F-001.docx', '회의록.docx']);
  const cell = scanForm(exported.data).tables[0].rows.flatMap(row => row.cells).find(x => x.n === 3);
  assert.equal(cell.text, '새 과제');
  (await store.getForm(book.id, 'F-001')).values[8] = 'x'; // #8 은 중첩 표가 든 잠긴 칸 — 파일에 직접 써 넣은 경우
  await assert.rejects(store.readFormFile(book.id, 'F-001', 'export'), err => err.status === 409);
  await fs.rm(process.env.WORKSPACE, { recursive: true, force: true });
});

// 제목 「1. 제안 개요」 + 필드 #1 「본문 문장이다.」 + 표(칸 #2 ~ #10)
const bodyDocx = docxOf(`${docxHeading}${docxSentence}${docxTable}`);

test('구조 조절 저장: 규칙이 작업공간 파일에 남고(되돌리면 지워지고), 다음 올리기에 적용되며(rulesApplied), 목록·삭제·에이전트 상태·재시작 후에도 남는다', async () => {
  const store = await freshStore();
  const rulesFile = path.join(process.env.WORKSPACE, RULES_FILE);
  const { book } = await store.loadBookState();
  assert.deepEqual(await store.formRules(), { rules: [] });
  assert.deepEqual(store.listFormRules(), []);
  const a = await upload(store, book.id, { fileName: '계획서.docx', data: bodyDocx.toString('base64') });
  assert.equal(a.rulesApplied, 0);
  assert.deepEqual(a.form.nodes.map(x => [x.kind, x.n ?? null, x.level]), [['heading', null, 1], ['field', 1, 2], ['table', null, undefined]]);
  // 거절된 구조 조절은 캐시·파일 모두 그대로
  await assert.rejects(store.saveForm({ bookId: book.id, id: 'F-001', structure: [{ i: 2, level: 2 }] }), err => err.status === 400 && /표 자리/.test(err.message));
  await assert.rejects(fs.access(rulesFile));
  assert.equal((await store.getForm(book.id, 'F-001')).nodes[1].orig, undefined);
  // 필드 #1 → 제목 수준 2, 제목 → 수준 3: 규칙 둘
  const saved = await store.saveForm({ bookId: book.id, id: 'F-001', structure: [{ i: 1, kind: 'heading', level: 2 }, { i: 0, level: 3 }], values: {} });
  assert.deepEqual(saved.form.nodes.map(x => [x.kind, x.n ?? null, x.level, x.orig ?? null]), [['heading', null, 3, { kind: 'heading', level: 1, by: 'style' }], ['heading', 1, 2, { kind: 'field', level: 2 }], ['table', null, undefined, null]]);
  assert.deepEqual(saved.rules.map(({ at, ...r }) => r), [
    { id: 'SR-001', heading: '1. 제안 개요', text: '본문 문장이다.', kind: 'heading', level: 2, from: { kind: 'field', level: 2 }, fileName: '계획서.docx', bookId: book.id, formId: 'F-001' },
    { id: 'SR-002', heading: '', text: '1. 제안 개요', kind: 'heading', level: 3, from: { kind: 'heading', level: 1 }, fileName: '계획서.docx', bookId: book.id, formId: 'F-001' },
  ]);
  assert.deepEqual(JSON.parse(await fs.readFile(rulesFile, 'utf8')).rules, saved.rules);
  assert.deepEqual(saved.forms[0].structured, 2);
  assert.deepEqual((await store.formRules()).rules, saved.rules);
  assert.equal((await store.formAgentState(book.id, 'F-001')).rules, store.listFormRules());
  // 같은 양식을 다시 올리면 규칙이 적용된다 — 다른 보고서에서도(작업공간 수준)
  const other = await store.createBook({ title: '다른 보고서' });
  const b = await upload(store, other.book.id, { fileName: '계획서2.docx', data: bodyDocx.toString('base64') });
  assert.deepEqual([b.form.id, b.rulesApplied], ['F-002', 2]); // 양식 번호는 작업공간 공통이라 다른 보고서에서 올려도 이어진다
  // 규칙이 만든 제목 「본문 문장이다.」 가 첫 제목 바로 뒤에 오므로 두 제목 아래 빈 필드가 하나씩 생긴다 — 번호는 규칙 적용 뒤에 매긴다
  assert.deepEqual(b.form.nodes.map(x => [x.kind, x.n ?? null, x.level, x.rule ?? null, x.by ?? null]), [['heading', null, 3, 'SR-002', 'style'], ['field', 1, 3, null, null], ['heading', null, 2, 'SR-001', 'rule'], ['field', 2, 3, null, null], ['table', null, undefined, null, null]]);
  assert.equal(b.forms[0].structured, 2);
  assert.equal((await upload(store, other.book.id)).rulesApplied, 0); // 표만 있는 양식 — 맞는 노드가 없다
  // 같은 열쇠의 조절은 덮어쓴다(id 유지) — 수준 2 → 4. 되돌리면 그 규칙은 지워진다
  const again = await store.saveForm({ bookId: book.id, id: 'F-001', structure: [{ i: 1, level: 4 }] });
  assert.deepEqual(again.rules.map(r => [r.id, r.kind, r.level]), [['SR-001', 'heading', 4], ['SR-002', 'heading', 3]]);
  const reverted = await store.saveForm({ bookId: book.id, id: 'F-001', structure: [{ i: 1, kind: 'field', level: 2 }] });
  assert.deepEqual(reverted.rules.map(r => r.id), ['SR-002']);
  assert.equal(reverted.form.nodes[1].orig, undefined);
  assert.deepEqual(JSON.parse(await fs.readFile(rulesFile, 'utf8')).rules.map(r => r.id), ['SR-002']);
  // 구조 없이 저장하면 규칙은 그대로
  assert.deepEqual((await store.saveForm({ bookId: book.id, id: 'F-001', values: { 3: 'v' } })).rules.map(r => r.id), ['SR-002']);
  // 규칙 삭제 — 없는 id 는 404. 재시작해도 남는다
  await assert.rejects(store.deleteFormRule('SR-001'), err => err.status === 404);
  const more = await store.saveForm({ bookId: other.book.id, id: b.form.id, structure: [{ i: 3, level: 5 }] }); // 헤딩 바로 뒤의 빈 필드 #2 — 글이 없어 규칙을 남기지 않는다
  assert.deepEqual(more.rules.map(r => r.id), ['SR-002']);
  assert.equal(more.form.nodes[3].level, 5);
  const fresh = await import(`../lib/store.js?reload=${Date.now()}`);
  assert.deepEqual((await fresh.formRules()).rules.map(r => r.id), ['SR-002']);
  assert.deepEqual((await fresh.deleteFormRule('SR-002')).rules, []);
  assert.deepEqual(JSON.parse(await fs.readFile(rulesFile, 'utf8')), { rules: [] });
  assert.equal((await fresh.formAgentState(other.book.id, 'F-001')).rules.length, 0);
  assert.equal((await fresh.getForm(other.book.id, b.form.id)).nodes[3].level, 5); // 규칙을 지워도 이미 조절한 양식은 그대로
  await fs.rm(process.env.WORKSPACE, { recursive: true, force: true });
});

test('내려받기 이름: ASCII 이름 뒤에 한글 원래 이름이 filename* 로 붙고, 원래 이름이 없으면 붙지 않는다', () => {
  const header = downloadDisposition('F-001.docx', '회의록.docx');
  assert.ok(header.includes('filename="F-001.docx"'));
  assert.ok(header.includes("filename*=UTF-8''%ED%9A%8C%EC%9D%98%EB%A1%9D.docx"));
  assert.equal(downloadDisposition('a.pdf'), 'attachment; filename="a.pdf"');
});
