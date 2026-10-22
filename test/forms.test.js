// 양식 조립 — 형식 판별·번호 매김(본문 노드·빈 필드)·값 검사(잠긴 칸·필드)·파일·내보내기(새 사본 기입·재스캔 확인)·구조 조절(수준·종류·번호 불변)·구조 규칙 적용
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scanDocx } from '../lib/docx_form.js';
import { upsertRule } from '../lib/form_rules.js';
import { FILE_LIMIT, FORM_LEVEL_MAX, applyFormPatch, applyStructure, buildForm, detectFormat, exportForm, formSummary, loadForms, readOriginal, removeFormFiles, rewriteForm, scanForm, unitIndex, unitText, writeForm } from '../lib/forms.js';
import { createCfb, readCfb } from '../lib/cfb.js';
import { scanHwp } from '../lib/hwp_form.js';
import { scanHwpx } from '../lib/hwpx_form.js';
import { readZip, writeZip } from '../lib/zip.js';
import { bodyPara, cellXml, docxHeading, docxOf, docxSentence, docxTable, emptyZip, hwpxOf, hwpxRows, secOf, sectionXml, tablePara } from './fixtures/form_docs.js';
import { hwpOf, hwpRows, sectionItems, tablePara as hwpTablePara } from './fixtures/hwp_docs.js';

const status = (code, re = /./) => err => err.status === code && re.test(err.message);
const build = (data, fileName = '회의록.docx') => buildForm({ id: 'F-001', fileName, data });
const cells = form => form.tables.flatMap(t => t.rows.flatMap(row => row.cells));
const paraTexts = data => scanDocx(data).items.filter(i => i.kind === 'paragraph' && i.text).map(i => i.text);

// Task 3 표 하나(칸 9개 — #1 제목 … #8 중첩 표 잠김, #9 문단 없는 칸)
const tableDocx = docxOf(docxTable);
// Task 3 본문 + 표 앞 「□ 기술 개요」 헤딩: 헤딩 p0 · ilvl 문장 p1 · 빈 문단 p2 · □ 헤딩 p3 · 표 · 끝 글 p4
const bodyDocx = docxOf(`${docxHeading}${docxSentence}<w:p/><w:p><w:r><w:t>□ 기술 개요</w:t></w:r></w:p>${docxTable}<w:p><w:r><w:t>끝 글</w:t></w:r></w:p>`);
// 필드 #1 「신상 조서」 + 2열 표(#2 제안자 · #3 홍길동 · #4 기관 · #5 한국선급\n연구소 · #6 빈 칸)
const hwpxDoc = hwpxOf([sectionXml(hwpxRows())]);
// hwp(5.0 바이너리) 로 같은 모양 — 필드 #1 「신상 조서」 + 2열 표
const hwpDoc = hwpOf({ sections: [sectionItems()] });

test('detectFormat: docx·hwpx·hwp·ZIP 아님·다른 ZIP·다른 OLE', () => {
  assert.equal(detectFormat(tableDocx), 'docx');
  assert.equal(detectFormat(hwpxDoc), 'hwpx');
  assert.equal(detectFormat(hwpDoc), 'hwp');
  assert.equal(detectFormat(Buffer.from('hello')), null);
  assert.equal(detectFormat(writeZip(emptyZip(), { 'ppt/presentation.xml': '<p:presentation/>' })), null);
  assert.equal(detectFormat(createCfb({ WordDocument: Buffer.from('doc') })), null);
});

test('scanForm 번호: 표 칸은 행 → 칸 순으로 1부터 잇고 이어짐 칸은 번호가 없다', () => {
  const { format, nodes, tables } = scanForm(tableDocx);
  assert.equal(format, 'docx');
  assert.deepEqual(nodes, [{ kind: 'table', t: 0 }]);
  assert.deepEqual(tables[0].rows.map(row => row.cells.map(x => [x.c, x.n])), [[[0, 1]], [[0, 2], [1, 3], [2, 4]], [[1, 5], [2, 6]], [[0, 7], [1, 8], [2, 9]]]);
  assert.equal(tables[0].kind, undefined);
});

test('scanForm 번호: hwpx 섹션 둘 — 둘째 섹션 번호가 첫 섹션 뒤를 잇는다', () => {
  const { format, nodes, tables } = scanForm(hwpxOf([sectionXml(hwpxRows()), sectionXml(hwpxRows())]));
  assert.equal(format, 'hwpx');
  assert.deepEqual(nodes.map(x => [x.kind, x.n ?? x.t, x.section ?? null]), [['field', 1, 0], ['table', 0, null], ['field', 7, 1], ['table', 1, null]]);
  assert.deepEqual(tables.map(t => [t.section, t.rows.flatMap(row => row.cells.map(x => x.n))]), [[0, [2, 3, 4, 5, 6]], [1, [8, 9, 10, 11, 12]]]);
});

test('scanForm 본문 노드: 헤딩·필드·빈 문단 빠짐·끝 헤딩 아래 빈 필드·표 자리', async () => {
  const { form } = await build(bodyDocx);
  const N = cells(form).length;
  assert.equal(N, 9);
  assert.deepEqual(form.nodes.map(x => [x.kind, x.n ?? null, x.level ?? null]), [['heading', null, 1], ['field', 1, 2], ['heading', null, 1], ['field', 2, 2], ['table', null, null], ['field', N + 3, 1]]);
  assert.deepEqual(form.nodes[0], { kind: 'heading', level: 1, text: '1. 제안 개요', section: 0, p: 0, by: 'style' }); // Heading1 스타일
  assert.deepEqual(form.nodes[2], { kind: 'heading', level: 1, text: '□ 기술 개요', section: 0, p: 3, by: 'text' });
  assert.deepEqual(form.nodes[3], { kind: 'field', n: 2, level: 2, text: '', empty: true, section: 0, p: form.nodes[2].p, after: true });
  assert.deepEqual(form.nodes[1], { kind: 'field', n: 1, level: 2, text: '본문 문장이다.', section: 0, p: 1 });
  assert.equal(cells(form)[0].n, 3);
  const index = unitIndex(form);
  assert.equal(index.size, N + 3);
  assert.equal(index.get(2).kind, 'field');
  assert.equal(unitText(index.get(2)), '');
  assert.equal(unitText(index.get(1)), '본문 문장이다.');
  assert.deepEqual({ ...index.get(5), cell: undefined }, { kind: 'cell', t: 0, r: 1, c: 1, cell: undefined });
  assert.equal(unitText(index.get(5)), '과제명');
});

test('scanForm 빈 필드: 다음이 헤딩·표·끝인 헤딩마다 하나(수준 +1, 최대 3), 필드가 바로 뒤따르면 없다', () => {
  const data = hwpxOf([secOf([bodyPara('□ 개요'), bodyPara('○ 본문 글임'), bodyPara('□ 배경'), bodyPara('◆ 세부'), tablePara(hwpxRows()), bodyPara('■ 맺음')].join(''))]);
  assert.deepEqual(scanForm(data).nodes.map(x => [x.kind, x.n ?? null, x.level ?? null, x.p ?? null, x.after ?? false]), [
    ['heading', null, 1, 0, false], ['field', 1, 1, 1, false],
    ['heading', null, 1, 2, false], ['field', 2, 2, 2, true],
    ['heading', null, 3, 3, false], ['field', 3, 3, 3, true],
    ['table', null, null, null, false],
    ['heading', null, 2, 5, false], ['field', 9, 3, 5, true],
  ]);
});

test('buildForm: 양식 — 제목 기본값은 파일 이름, 해시·원본 경로·빈 값과 지침', async () => {
  const { form, original } = await build(tableDocx);
  assert.equal(original, tableDocx);
  const { nodes, tables, hash, createdAt, updatedAt, ...rest } = form;
  assert.deepEqual(rest, { id: 'F-001', title: '회의록', fileName: '회의록.docx', format: 'docx', original: 'originals/F-001.docx', values: {}, instructions: {} });
  assert.deepEqual([nodes.length, tables.length], [1, 1]);
  assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(createdAt, updatedAt);
  assert.equal((await buildForm({ id: 'F-002', title: '  회의 기록  ', fileName: '조서.HWPX', data: hwpxDoc })).form.title, '회의 기록');
  assert.deepEqual(formSummary(form), { id: 'F-001', title: '회의록', fileName: '회의록.docx', format: 'docx', units: 9, changed: 0, structured: 0, updatedAt: form.updatedAt });
});

test('applyStructure 거절: 배열 아님·없는 노드·표 자리·수준 범위·종류·빈 필드를 제목으로 — 바뀌는 것이 없는 항목은 무시', async () => {
  const { form } = await build(bodyDocx);
  const snapshot = structuredClone(form);
  assert.throws(() => applyStructure(form, { i: 1 }), status(400, /배열/));
  assert.throws(() => applyStructure(form, [{ i: 99, level: 2 }]), status(400, /없는 노드/));
  assert.throws(() => applyStructure(form, [{ i: '1', level: 2 }]), status(400, /없는 노드/));
  assert.throws(() => applyStructure(form, [{ i: 4, level: 2 }]), status(400, /^표 자리는 바꿀 수 없습니다$/));
  assert.throws(() => applyStructure(form, [{ i: 1, level: 0 }]), status(400, /1~6/));
  assert.throws(() => applyStructure(form, [{ i: 1, level: FORM_LEVEL_MAX + 1 }]), status(400, /1~6/));
  assert.throws(() => applyStructure(form, [{ i: 1, level: 2.5 }]), status(400, /1~6/));
  assert.throws(() => applyStructure(form, [{ i: 1, kind: 'table' }]), status(400, /heading 또는 field/));
  assert.throws(() => applyStructure(form, [{ i: 3, kind: 'heading' }]), status(400, /#2 은 헤딩 바로 뒤의 빈 필드라 제목으로 바꿀 수 없습니다/));
  assert.deepEqual(applyStructure(form, [{ i: 1, level: 2 }, { i: 0, kind: 'heading', level: 1 }, { i: 1 }]), []);
  assert.deepEqual(form, snapshot); // 거절·무시는 아무것도 바꾸지 않는다
});

test('applyStructure: 수준·종류를 바꾸고 번호는 흔들지 않는다 — 필드→제목은 번호를 남기고 값·지침을 지우며, 제목→필드는 남긴 번호 또는 최댓값 + 1, 되돌리면 orig·user 가 떨어진다', async () => {
  const { form, original } = await build(bodyDocx);
  const scan = structuredClone(form.nodes);
  applyFormPatch(form, { values: { 12: '맺음 값' }, instructions: { 12: '짧게', 1: '길게' } });
  const changes = applyStructure(form, [{ i: 1, level: 3 }, { i: 5, kind: 'heading' }, { i: 0, kind: 'field' }]);
  assert.deepEqual(changes, [
    { i: 1, before: { kind: 'field', level: 2 }, after: { kind: 'field', level: 3 }, reverted: false },
    { i: 5, before: { kind: 'field', level: 1 }, after: { kind: 'heading', level: 1 }, reverted: false },
    { i: 0, before: { kind: 'heading', level: 1 }, after: { kind: 'field', level: 1 }, reverted: false },
  ]);
  assert.deepEqual(form.nodes[1], { ...scan[1], level: 3, orig: { kind: 'field', level: 2 }, user: true });
  assert.deepEqual(form.nodes[5], { kind: 'heading', n: 12, level: 1, text: '끝 글', section: 0, p: 4, by: 'user', orig: { kind: 'field', level: 1 }, user: true }); // 번호 12 는 남는다
  assert.deepEqual(form.nodes[0], { kind: 'field', level: 1, text: '1. 제안 개요', section: 0, p: 0, n: 13, orig: { kind: 'heading', level: 1, by: 'style' }, user: true }); // 최댓값 12 + 1
  assert.deepEqual([form.values, form.instructions], [{}, { 1: '길게' }]); // 제목이 된 #12 의 값·지침은 지운다
  const index = unitIndex(form);
  assert.deepEqual([index.has(12), index.has(13), index.size], [false, true, 12]);
  assert.equal(formSummary(form).structured, 3);
  assert.throws(() => applyFormPatch(form, { values: { 12: 'x' } }), status(400, /#12 은 이 양식에 없는 단위입니다/));
  // 제목에서 만든 필드는 여느 필드처럼 채워져 그 문단이 값의 줄로 바뀐다
  applyFormPatch(form, { values: { 13: '새 제목\n둘째', 1: 'A' } });
  assert.deepEqual(paraTexts(exportForm(form, original).data), ['새 제목', '둘째', 'A', '□ 기술 개요', '끝 글']);
  // 되돌리기 — 같은 번호를 다시 쓰고 orig·user 가 떨어진다. 제목에 남은 번호 13 은 그대로(다시 필드로 만들면 13)
  assert.deepEqual(applyStructure(form, [{ i: 5, kind: 'field' }, { i: 1, level: 2 }]).map(c => c.reverted), [true, true]);
  assert.deepEqual(form.nodes[5], scan[5]);
  assert.deepEqual(form.nodes[1], scan[1]);
  assert.ok(form.values[13]);
  assert.deepEqual(applyStructure(form, [{ i: 0, kind: 'heading' }]), [{ i: 0, before: { kind: 'field', level: 1 }, after: { kind: 'heading', level: 1 }, reverted: true }]);
  assert.deepEqual(form.nodes[0], { ...scan[0], n: 13 });
  assert.deepEqual(form.values, { 1: 'A' }); // 제목으로 돌아간 #13 의 값은 지운다 — 화면이 보낸 values 에 #13 이 남아 있으면 그 뒤의 값 패치가 없는 단위로 거절한다
  assert.equal(formSummary(form).structured, 0);
  applyStructure(form, [{ i: 0, kind: 'field' }]);
  assert.equal(form.nodes[0].n, 13);
  // 수준만 여러 번: 제목 1 → 4 → 1 (depth·by 는 되돌아온다)
  const deep = { ...scan[2], depth: 4 };
  form.nodes[2] = { ...deep };
  applyStructure(form, [{ i: 2, level: 4 }]);
  assert.deepEqual(form.nodes[2], { ...deep, level: 4, orig: { kind: 'heading', level: 1, by: 'text', depth: 4 }, user: true });
  applyStructure(form, [{ i: 2, kind: 'field' }]);
  assert.deepEqual(form.nodes[2], { kind: 'field', level: 4, text: '□ 기술 개요', section: 0, p: 3, n: 14, orig: { kind: 'heading', level: 1, by: 'text', depth: 4 }, user: true });
  applyStructure(form, [{ i: 2, kind: 'heading', level: 1 }]);
  assert.deepEqual(form.nodes[2], { ...deep, n: 14 });
});

test('applyStructure: 값·지침이 있는 필드를 제목으로 바꾸면 그 값·지침이 지워지고 다른 번호는 그대로 — 제목이 된 필드는 unitIndex 에서 빠진다', async () => {
  const { form } = await build(bodyDocx);
  applyFormPatch(form, { values: { 1: '본문 값', 3: '칸 값' }, instructions: { 1: '지침', 3: '칸 지침' } });
  applyStructure(form, [{ i: 1, kind: 'heading', level: 2 }]);
  assert.deepEqual([form.values, form.instructions], [{ 3: '칸 값' }, { 3: '칸 지침' }]);
  assert.deepEqual(form.nodes.map(x => [x.kind, x.n ?? null]), [['heading', null], ['heading', 1], ['heading', null], ['field', 2], ['table', null], ['field', 12]]);
  assert.equal(unitIndex(form).size, 11);
});

test('scanForm + 규칙: 앞 제목·글이 같은 노드만 규칙대로(orig·rule·by rule) — 빈 필드와 번호는 규칙을 적용한 뒤에, 글이 다르면 적용하지 않는다', async () => {
  // 스캔 nodes: 제목 「1. 제안 개요」 › 필드 「본문 문장이다.」 · 제목 「□ 기술 개요」 › 표 › 필드 「끝 글」
  let rules = upsertRule([], { heading: '1. 제안 개요', text: ' 본문  문장이다. ', kind: 'heading', level: 2, from: { kind: 'field', level: 2 } });
  rules = upsertRule(rules, { heading: '', text: '끝 글', kind: 'field', level: 4 }); // 「끝 글」의 앞 제목은 「□ 기술 개요」 — 맞지 않는다
  rules = upsertRule(rules, { heading: '1. 제안 개요', text: '□ 기술 개요', kind: 'field', level: 1 }); // 제목 → 필드
  rules = upsertRule(rules, { heading: '□ 기술 개요', text: '끝 글', kind: 'field', level: 6 }); // 표를 건너뛴 앞 제목 — SR-003 이 그 제목을 필드로 만들어도 열쇠는 스캔 상태
  const { nodes, rulesApplied } = scanForm(bodyDocx, rules);
  assert.equal(rulesApplied, 3);
  assert.deepEqual(nodes.map(x => [x.kind, x.n ?? null, x.level ?? null, x.rule ?? null]), [
    ['heading', null, 1, null], ['field', 1, 2, null], ['heading', null, 2, 'SR-001'], ['field', 2, 1, 'SR-003'], ['table', null, null, null], ['field', 12, 6, 'SR-004'],
  ]);
  assert.deepEqual(nodes[1], { kind: 'field', n: 1, level: 2, text: '', empty: true, section: 0, p: 0, after: true }); // 다음이 (규칙이 만든) 제목이 된 첫 제목 아래 빈 필드
  assert.deepEqual(nodes[2], { kind: 'heading', level: 2, text: '본문 문장이다.', section: 0, p: 1, orig: { kind: 'field', level: 2 }, rule: 'SR-001', by: 'rule' });
  assert.deepEqual(nodes[3], { kind: 'field', level: 1, text: '□ 기술 개요', section: 0, p: 3, orig: { kind: 'heading', level: 1, by: 'text' }, rule: 'SR-003', n: 2 });
  const { form, rulesApplied: built } = await buildForm({ id: 'F-001', fileName: '회의록.docx', data: bodyDocx, rules });
  assert.equal(built, 3);
  assert.equal(formSummary(form).structured, 3);
  assert.deepEqual((await build(bodyDocx)).rulesApplied, 0);
  assert.equal(scanForm(bodyDocx, [upsertRule([], { heading: '1. 제안 개요', text: '본문 문장이다', kind: 'heading', level: 2 })[0]]).rulesApplied, 0); // 글이 다르다(마침표)
  // 규칙이 만든 필드는 되돌리면 번호를 지키고 orig·rule 이 떨어진다 (by 는 돌아온다)
  assert.deepEqual(applyStructure(form, [{ i: 3, kind: 'heading' }]), [{ i: 3, before: { kind: 'field', level: 1 }, after: { kind: 'heading', level: 1 }, reverted: true }]);
  assert.deepEqual(form.nodes[3], { kind: 'heading', level: 1, text: '□ 기술 개요', section: 0, p: 3, n: 2, by: 'text' });
});

test('헤딩 노드도 locked·note 를 싣는다 — 필드로 바꾸면 잠긴 단위라 값을 거절하고, 빈 필드 수준은 깊은 제목 아래서 제목과 같다', async () => {
  const sealed = docxOf(`<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:sectPr/></w:pPr><w:r><w:t>1. 제안 개요</w:t></w:r></w:p>${docxSentence}${docxTable}`);
  const { form, original } = await build(sealed);
  assert.deepEqual(form.nodes[0], { kind: 'heading', level: 1, text: '1. 제안 개요', section: 0, p: 0, by: 'style', locked: '구역 설정' });
  applyStructure(form, [{ i: 0, kind: 'field' }]);
  assert.deepEqual(form.nodes[0], { kind: 'field', level: 1, text: '1. 제안 개요', section: 0, p: 0, locked: '구역 설정', n: 11, orig: { kind: 'heading', level: 1, by: 'style' }, user: true });
  assert.throws(() => applyFormPatch(form, { values: { 11: 'x' } }), status(400, /#11 은 잠긴 단위입니다\(구역 설정\)/));
  form.values = { 11: 'x' };
  assert.throws(() => exportForm(form, original), status(409, /#11 은 잠긴 단위입니다/));
  const deep = scanForm(bodyDocx, [upsertRule([], { heading: '1. 제안 개요', text: '□ 기술 개요', kind: 'heading', level: 5 })[0]]).nodes;
  assert.deepEqual(deep.slice(2, 4).map(x => [x.kind, x.level]), [['heading', 5], ['field', 5]]);
});

test('buildForm 거절: 확장자·내용·표 없음·채울 단위 없음·크기·빈 파일', async () => {
  await assert.rejects(build(tableDocx, '회의록.txt'), status(400, /docx·hwpx·hwp 양식만 올릴 수 있습니다/));
  await assert.rejects(build(hwpxDoc, '회의록.docx'), status(400, /파일 내용이 확장자와 다릅니다/));
  await assert.rejects(build(hwpDoc, '회의록.hwpx'), status(400, /파일 내용이 확장자와 다릅니다/));
  await assert.rejects(build(createCfb({ WordDocument: Buffer.from('doc') }), '회의록.hwp'), status(400, /확장자와 다릅니다/));
  await assert.rejects(build(hwpOf({ sections: [sectionItems()], encrypted: true }), '회의록.hwp'), status(400, /암호가 걸린 한글 문서는 올릴 수 없습니다/));
  await assert.rejects(build(hwpOf({ sections: [sectionItems()], distribution: true }), '회의록.hwp'), status(400, /배포용 한글 문서는 올릴 수 없습니다/));
  await assert.rejects(build(hwpOf({ sections: [['표 없음']] }), '회의록.hwp'), status(400, /표가 없는/));
  await assert.rejects(build(Buffer.from('hello'), '회의록.docx'), status(400, /확장자와 다릅니다/));
  await assert.rejects(build(docxOf(`${docxHeading}${docxSentence}`)), status(400, /표가 없는/));
  await assert.rejects(build(docxOf('<w:tbl></w:tbl>')), status(400, /채울 칸이나 문단이 없는 문서입니다/));
  await assert.rejects(build(Buffer.alloc(FILE_LIMIT + 1)), status(413));
  await assert.rejects(build(Buffer.alloc(0)), status(400, /빈 파일/));
  await assert.rejects(build('PK…'), status(400));
});

test('applyFormPatch: 없는 번호·잠긴 칸·원본과 같은 값·CRLF·길이·지침·제목·통째 교체', async () => {
  const { form } = await build(tableDocx);
  assert.equal(cells(form).find(x => x.locked)?.n, 8);
  assert.throws(() => applyFormPatch(form, { values: { 99: 'x' } }), status(400, /#99/));
  assert.throws(() => applyFormPatch(form, { values: { '01': 'x' } }), status(400, /#01/));
  assert.throws(() => applyFormPatch(form, { values: { 8: 'x' } }), status(400, /#8 은 잠긴 단위입니다\(중첩 표\)/));
  assert.throws(() => applyFormPatch(form, { values: { 1: 'x'.repeat(20_001) } }), status(400, /20,000자/));
  assert.throws(() => applyFormPatch(form, { values: { 1: 3 } }), status(400, /문자열/));
  assert.throws(() => applyFormPatch(form, { values: [] }), status(400));
  assert.throws(() => applyFormPatch(form, { instructions: { 99: '지침' } }), status(400, /#99/));
  assert.throws(() => applyFormPatch(form, { instructions: { 1: 'x'.repeat(4001) } }), status(400, /4,000자/));
  applyFormPatch(form, { values: { 1: '제목', 3: 'a\r\nb', 4: '', 9: '' }, instructions: { 1: '', 3: '짧게', 8: '잠긴 칸에도 지침은 둔다' } });
  assert.deepEqual(form.values, { 3: 'a\nb', 4: '' }); // #1 은 원본과 같고, #9 는 원래 빈 칸
  assert.deepEqual(form.instructions, { 3: '짧게', 8: '잠긴 칸에도 지침은 둔다' });
  applyFormPatch(form, { values: { 5: 'v' } });
  assert.deepEqual(form.values, { 5: 'v' });
  assert.deepEqual(form.instructions, { 3: '짧게', 8: '잠긴 칸에도 지침은 둔다' });
  applyFormPatch(form, { title: '  ' });
  assert.equal(form.title, '회의록');
  applyFormPatch(form, { title: '새 제목' });
  assert.equal(form.title, '새 제목');
  assert.equal(formSummary(form).changed, 1);
});

test('applyFormPatch 필드 값: 저장되고, 문서·구역 설정이 든 필드는 잠긴 단위로 거절된다', async () => {
  const { form } = await build(bodyDocx);
  applyFormPatch(form, { values: { 1: '첫 줄\n둘째', 2: '새 본문' } });
  assert.deepEqual(form.values, { 1: '첫 줄\n둘째', 2: '새 본문' });
  assert.ok(form.nodes.every(x => !x.locked));
  const sealed = await build(docxOf(`${docxSentence}<w:p><w:pPr><w:sectPr/></w:pPr><w:r><w:t>구역 끝 글</w:t></w:r></w:p>${docxTable}`));
  assert.deepEqual(sealed.form.nodes[1], { kind: 'field', n: 2, level: 1, text: '구역 끝 글', section: 0, p: 1, locked: '구역 설정' });
  assert.equal(formSummary(sealed.form).units, 11);
  assert.throws(() => applyFormPatch(sealed.form, { values: { 2: 'x' } }), status(400, /#2 은 잠긴 단위입니다\(구역 설정\)/));
  sealed.form.values = { 2: 'x' };
  assert.throws(() => exportForm(sealed.form, sealed.original), status(409, /#2 은 잠긴 단위입니다/));
});

test('exportForm 본문 확인: 필드는 값의 줄로, 빈 필드는 헤딩 뒤에 — 빈 값은 글 열에서 빠진다', async () => {
  const { form, original } = await build(bodyDocx);
  applyFormPatch(form, { values: { 1: 'A\nB', 2: '새 본문' } });
  assert.deepEqual(paraTexts(exportForm(form, original).data), ['1. 제안 개요', 'A', 'B', '□ 기술 개요', '새 본문', '끝 글']);
  applyFormPatch(form, { values: { 1: '', 12: '  끝\n\n다음  ' } });
  assert.deepEqual(paraTexts(exportForm(form, original).data), ['1. 제안 개요', '□ 기술 개요', '  끝', '다음  ']);
});

test('exportForm: 두 칸만 바뀐다·이름·값이 없으면 원본 그대로·잠긴 칸이나 없는 번호는 409', async () => {
  const { form, original } = await build(tableDocx);
  applyFormPatch(form, { values: { 3: '새 과제', 6: '둘\n째' } });
  const out = exportForm(form, original);
  assert.equal(out.name, 'F-001.docx');
  assert.equal(out.downloadName, '회의록.docx');
  const expected = scanDocx(original);
  const at = (scan, r, c) => scan.items[0].rows[r].cells.find(x => x.c === c);
  at(expected, 1, 1).text = '새 과제';
  at(expected, 2, 2).text = '둘\n째';
  assert.deepEqual(scanDocx(out.data), expected);
  assert.deepEqual(readZip(out.data).names, readZip(original).names);
  form.values = {};
  assert.ok(exportForm(form, original).data.equals(original));
  form.values = { 8: 'x' };
  assert.throws(() => exportForm(form, original), status(409, /#8 은 잠긴 단위입니다\(중첩 표\)/));
  form.values = { 99: 'x' };
  assert.throws(() => exportForm(form, original), status(409, /#99/));
});

test('exportForm hwpx: 두 칸만 바뀐다·값이 없으면 원본 그대로·잠긴 칸 409', async () => {
  const { form, original } = await build(hwpxDoc, '조서.hwpx');
  applyFormPatch(form, { values: { 3: '김철수', 6: '부산\n해운대' } });
  const out = exportForm(form, original);
  assert.deepEqual([out.name, out.downloadName], ['F-001.hwpx', '조서.hwpx']);
  const expected = scanHwpx(original);
  const at = (scan, r, c) => scan.items[1].rows.flatMap(row => row.cells).find(x => x.r === r && x.c === c);
  at(expected, 0, 1).text = '김철수';
  at(expected, 2, 1).text = '부산\n해운대';
  assert.deepEqual(scanHwpx(out.data), expected);
  form.values = {};
  assert.ok(exportForm(form, original).data.equals(original));
  const inner = cellXml({ r: 3, c: 4, text: '안' });
  const nested = cellXml({ r: 0, c: 1, text: '앞' }).replace('</hp:run>', `</hp:run><hp:run charPrIDRef="1"><hp:tbl id="10"><hp:tr>${inner}</hp:tr></hp:tbl></hp:run>`);
  const locked = await build(hwpxOf([sectionXml([[cellXml({ r: 0, c: 0, text: '라벨' }), nested]])]), '잠김.hwpx');
  assert.equal(cells(locked.form)[1].locked, '중첩 표');
  locked.form.values = { 3: 'x' };
  assert.throws(() => exportForm(locked.form, locked.original), status(409, /#3 은 잠긴 단위입니다\(중첩 표\)/));
});

test('hwp: buildForm·scanForm 번호(hwpx 와 같은 모양)·헤딩 by·exportForm 두 칸과 필드만 바뀐다·값이 없으면 원본 그대로·잠긴 칸 409', async () => {
  const { form, original } = await build(hwpDoc, '조서.HWP');
  const { nodes, tables, hash, createdAt, updatedAt, ...rest } = form;
  assert.deepEqual(rest, { id: 'F-001', title: '조서', fileName: '조서.HWP', format: 'hwp', original: 'originals/F-001.hwp', values: {}, instructions: {} });
  assert.deepEqual(nodes.map(x => [x.kind, x.n ?? x.t]), [['field', 1], ['table', 0]]);
  assert.deepEqual(tables[0].rows.flatMap(row => row.cells.map(x => [x.r, x.c, x.n, x.text])), [[0, 0, 2, '제안자'], [0, 1, 3, '홍길동'], [1, 0, 4, '기관'], [1, 1, 5, '한국선급\n연구소'], [2, 1, 6, '']]);
  assert.equal(formSummary(form).units, 6);
  const outline = scanForm(hwpOf({ sections: [[{ text: '1. 개요', style: 2, paraShape: 2 }, { text: '① 세부', paraShape: 5 }, '□ 글 규칙', hwpTablePara(hwpRows())]] })).nodes.filter(n => n.kind === 'heading');
  assert.deepEqual(outline.map(h => [h.text, h.level, h.by, h.depth ?? null]), [['1. 개요', 1, 'outline', null], ['① 세부', 3, 'outline', 4], ['□ 글 규칙', 1, 'text', null]]); // 「개요 1」 스타일 + 개요 수준 → outline
  applyFormPatch(form, { values: { 1: '새 조서', 3: '김철수', 6: '부산\n해운대' } });
  const out = exportForm(form, original);
  assert.deepEqual([out.name, out.downloadName], ['F-001.hwp', '조서.HWP']);
  const expected = scanHwp(original);
  const at = (scan, r, c) => scan.items[1].rows.flatMap(row => row.cells).find(x => x.r === r && x.c === c);
  expected.items[0].text = '새 조서';
  at(expected, 0, 1).text = '김철수';
  at(expected, 2, 1).text = '부산\n해운대';
  assert.deepEqual(scanHwp(out.data), expected);
  assert.deepEqual(readCfb(out.data).names, readCfb(original).names);
  for (const name of readCfb(original).names.filter(n => n !== 'BodyText/Section0')) assert.deepEqual(readCfb(out.data).read(name), readCfb(original).read(name), name);
  form.values = {};
  assert.ok(exportForm(form, original).data.equals(original));
  const nested = { r: 0, c: 1, paras: [{ text: '앞', tables: [{ rows: [[{ r: 3, c: 4, text: '안' }]] }] }] };
  const locked = await build(hwpOf({ sections: [[hwpTablePara([[{ r: 0, c: 0, text: '라벨' }, nested]])]] }), '잠김.hwp');
  assert.equal(cells(locked.form)[1].locked, '중첩 표');
  assert.throws(() => applyFormPatch(locked.form, { values: { 2: 'x' } }), status(400, /#2 은 잠긴 단위입니다\(중첩 표\)/));
  locked.form.values = { 2: 'x' };
  assert.throws(() => exportForm(locked.form, locked.original), status(409, /#2 은 잠긴 단위입니다\(중첩 표\)/));
  const sealed = await build(hwpOf({ sections: [[{ text: '구역', ctrls: ['secd'] }, hwpTablePara(hwpRows())]] }), '구역.hwp');
  assert.deepEqual(sealed.form.nodes[0], { kind: 'field', n: 1, level: 1, text: '구역', section: 0, p: 0, locked: '문서 설정' });
  sealed.form.values = { 1: 'x' };
  assert.throws(() => exportForm(sealed.form, sealed.original), status(409, /#1 은 잠긴 단위입니다\(문서 설정\)/));
});

test('exportForm 확인: 저장한 구조와 결과가 다르면 409 — 단위 번호나 본문 위치를 알린다', async () => {
  const { form, original } = await build(bodyDocx);
  applyFormPatch(form, { values: { 1: 'A' } });
  const heading = structuredClone(form);
  heading.nodes[0].text = '바뀐 제목';
  assert.throws(() => exportForm(heading, original), status(409, /^기입 결과가 완전하지 않습니다 — 본문 1번째 문단: 기대 "바뀐 제목" 실제 "1\. 제안 개요"$/));
  const field = structuredClone(form);
  field.nodes.at(-1).text = '다른 끝';
  assert.throws(() => exportForm(field, original), status(409, /— #12: 기대 "다른 끝" 실제 "끝 글"$/));
  const cell = structuredClone(form);
  cell.tables[0].rows[2].cells.shift(); // #7(행2 c1)이 빠진 구조
  assert.throws(() => exportForm(cell, original), status(409, /— #8: 기대 "T0 r2 c2" 실제 "T0 r2 c1"$/));
});

const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;
test('값의 XML 1.0 금지 글자는 저장·내보내기에서 빠지고 짝 없는 서로게이트는 U+FFFD 가 된다 — 내보낸 XML 에 남지 않는다', async () => {
  for (const [data, fileName, member] of [[tableDocx, '회의록.docx', 'word/document.xml'], [hwpxDoc, '조서.hwpx', 'Contents/section0.xml']]) {
    const { form, original } = await build(data, fileName);
    applyFormPatch(form, { values: { 3: 'soft\u0002hyphen\u000bvt\tend\uFFFF', 6: 'a\uD800b' } });
    assert.deepEqual(form.values, { 3: 'softhyphenvt\tend', 6: 'a\uFFFDb' });
    form.values[3] = 'old\u0001value'; // 고치기 전에 저장한 값도 내보낼 때 거른다
    const xml = readZip(exportForm(form, original).data).read(member).toString('utf8');
    assert.doesNotMatch(xml, FORBIDDEN);
    assert.ok(xml.includes('oldvalue') && xml.includes('a\uFFFDb'));
  }
});

test('exportForm: 칸 문단을 감싼 customXml 처럼 기입이 XML 짝을 깨면 파일을 내주지 않고 409', async () => {
  const wrapped = docxOf(`<w:tbl><w:tr><w:tc><w:tcPr/><w:customXml w:element="x"><w:p><w:r><w:t>가</w:t></w:r></w:p></w:customXml><w:p><w:r><w:t>나</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`);
  const { form, original } = await build(wrapped);
  assert.equal(cells(form)[0].text, '가\n나');
  applyFormPatch(form, { values: { 1: '새 값' } });
  assert.throws(() => exportForm(form, original), status(409, /^기입 결과의 XML 구조가 어긋났습니다$/));
});

test('exportForm: 2,000칸 표에 값 1,000개 — 값마다 표를 다시 훑지 않는다 (docx·hwpx·hwp)', async () => {
  const docx = docxOf(`<w:tbl>${Array.from({ length: 200 }, (_, r) => `<w:tr>${Array.from({ length: 10 }, (_, c) => `<w:tc><w:p><w:r><w:t>r${r}c${c}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`);
  const hwpx = hwpxOf([sectionXml(Array.from({ length: 200 }, (_, r) => Array.from({ length: 10 }, (_, c) => cellXml({ r, c, text: `r${r}c${c}` }))))]);
  const hwp = hwpOf({ sections: [[hwpTablePara(Array.from({ length: 200 }, (_, r) => Array.from({ length: 10 }, (_, c) => ({ r, c, text: `r${r}c${c}` }))))]] });
  for (const [data, fileName, scan] of [[docx, '큰.docx', scanDocx], [hwpx, '큰.hwpx', scanHwpx], [hwp, '큰.hwp', scanHwp]]) {
    const { form, original } = await build(data, fileName);
    const ns = cells(form).map(x => x.n).filter(n => n % 2);
    assert.equal(ns.length, 1000);
    applyFormPatch(form, { values: Object.fromEntries(ns.map(n => [n, `값 ${n}\n둘째`])) });
    const t0 = performance.now();
    const out = exportForm(form, original);
    const ms = performance.now() - t0;
    assert.ok(ms < 3000, `${fileName}: ${Math.round(ms)}ms`); // 이 기계 수십 ms — 값마다 다시 훑으면 hwpx 는 9초 넘게 걸렸다
    const got = scan(out.data).items.find(i => i.kind === 'table').rows.flatMap(row => row.cells);
    assert.equal(got.filter(x => x.text.endsWith('\n둘째')).length, 1000);
  }
});

test('파일: 원본·json 쓰기 → 읽기 → 다시 쓰기 → 지우기', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sourceanchor-forms-test-'));
  try {
    const { form, original } = await build(tableDocx);
    await writeForm(dir, form, original);
    assert.deepEqual(await loadForms(dir), [form]);
    assert.ok((await readOriginal(dir, form)).equals(original));
    applyFormPatch(form, { values: { 3: 'v' } });
    await rewriteForm(dir, form);
    assert.deepEqual((await loadForms(dir))[0].values, { 3: 'v' });
    await removeFormFiles(dir, form);
    assert.deepEqual(await loadForms(dir), []);
    await assert.rejects(readOriginal(dir, form), status(404));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
