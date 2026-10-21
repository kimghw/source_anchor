// 양식 저장소 — 올리기·목록·조회·저장·삭제·번호 불변·보고서 격리·재시작 후 유지, 거절된 올리기, 원본·내보내기 파일, 내려받기 이름 (FR-WB-090 ~ 092, DR-WB-008, ERR-WB-011)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scanForm } from '../lib/forms.js';
import { downloadDisposition } from '../lib/http_names.js';
import { docxOf, docxTable } from './fixtures/form_docs.js';

async function freshStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sourceanchor-form-test-'));
  process.env.WORKSPACE = dir;
  return import(`../lib/store.js?workspace=${encodeURIComponent(dir)}`);
}

const docx = docxOf(docxTable);
const upload = (store, bookId, extra = {}) => store.addForm({ bookId, fileName: '회의록.docx', data: docx.toString('base64'), ...extra });
const formsDir = bookId => path.join(process.env.WORKSPACE, 'projects', bookId, 'forms');

test('양식: 올리기·목록·조회·저장·삭제, 지운 번호는 다시 쓰지 않고, 다른 보고서에 나타나지 않으며, 다시 불러와도 남고, 보고서와 함께 지워진다', async () => {
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
  assert.deepEqual((await store.deleteForm(book.id, 'F-001')).forms.map(f => f.id), ['F-002']);
  await assert.rejects(store.deleteForm(book.id, 'F-001'), /찾지 못했습니다/);
  assert.equal((await upload(store, book.id)).form.id, 'F-003'); // 지운 번호는 다시 쓰지 않는다
  assert.deepEqual((await store.loadBookState(book.id)).forms.map(f => f.id), ['F-002', 'F-003']);
  const other = await store.createBook({ title: '다른 보고서' });
  assert.deepEqual(other.forms, []);
  await assert.rejects(store.getForm(other.book.id, 'F-002'), /찾지 못했습니다/);
  const again = await import(`../lib/store.js?reload=${Date.now()}`);
  assert.deepEqual((await again.formList(book.id)).map(f => f.id), ['F-002', 'F-003']);
  assert.equal((await again.formAgentState(book.id, 'F-002')).form.id, 'F-002');
  assert.equal((await again.formAgentState(book.id, 'F-002')).book.id, book.id);
  await store.deleteBook(book.id);
  await assert.rejects(fs.access(formsDir(book.id)));
  await fs.rm(process.env.WORKSPACE, { recursive: true, force: true });
});

test('거절된 올리기는 파일·번호를 남기지 않는다', async () => {
  const store = await freshStore();
  const { book } = await store.loadBookState();
  await assert.rejects(store.addForm({ bookId: book.id, fileName: '메모.txt', data: Buffer.from('hi').toString('base64') }), err => err.status === 400);
  await assert.rejects(store.addForm({ bookId: book.id, fileName: '회의록.docx', data: 123 }), err => err.status === 400 && /base64/.test(err.message));
  assert.deepEqual(await fs.readdir(formsDir(book.id)).catch(() => []), []);
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

test('내려받기 이름: ASCII 이름 뒤에 한글 원래 이름이 filename* 로 붙고, 원래 이름이 없으면 붙지 않는다', () => {
  const header = downloadDisposition('F-001.docx', '회의록.docx');
  assert.ok(header.includes('filename="F-001.docx"'));
  assert.ok(header.includes("filename*=UTF-8''%ED%9A%8C%EC%9D%98%EB%A1%9D.docx"));
  assert.equal(downloadDisposition('a.pdf'), 'attachment; filename="a.pdf"');
});
