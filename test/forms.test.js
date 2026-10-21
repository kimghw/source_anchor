// 양식 조립 — 형식 판별·번호 매김(본문 노드·빈 필드)·값 검사(잠긴 칸·필드)·파일·내보내기(새 사본 기입·재스캔 확인)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scanDocx } from '../lib/docx_form.js';
import { FILE_LIMIT, applyFormPatch, buildForm, detectFormat, exportForm, formSummary, loadForms, readOriginal, removeFormFiles, rewriteForm, scanForm, unitIndex, unitText, writeForm } from '../lib/forms.js';
import { scanHwpx } from '../lib/hwpx_form.js';
import { readZip, writeZip } from '../lib/zip.js';
import { bodyPara, cellXml, docxHeading, docxOf, docxSentence, docxTable, emptyZip, hwpxOf, hwpxRows, secOf, sectionXml, tablePara } from './fixtures/form_docs.js';

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

test('detectFormat: docx·hwpx·ZIP 아님·다른 ZIP', () => {
  assert.equal(detectFormat(tableDocx), 'docx');
  assert.equal(detectFormat(hwpxDoc), 'hwpx');
  assert.equal(detectFormat(Buffer.from('hello')), null);
  assert.equal(detectFormat(writeZip(emptyZip(), { 'ppt/presentation.xml': '<p:presentation/>' })), null);
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
  assert.deepEqual(form.nodes[2], { kind: 'heading', level: 1, text: '□ 기술 개요', section: 0, p: 3 });
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
  assert.deepEqual(formSummary(form), { id: 'F-001', title: '회의록', fileName: '회의록.docx', format: 'docx', units: 9, changed: 0, updatedAt: form.updatedAt });
});

test('buildForm 거절: 확장자·내용·표 없음·채울 단위 없음·크기·빈 파일', async () => {
  await assert.rejects(build(tableDocx, '회의록.txt'), status(400, /docx·hwpx 양식만 올릴 수 있습니다/));
  await assert.rejects(build(hwpxDoc, '회의록.docx'), status(400, /파일 내용이 확장자와 다릅니다/));
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

test('exportForm: 2,000칸 표에 값 1,000개 — 값마다 표를 다시 훑지 않는다 (docx·hwpx)', async () => {
  const docx = docxOf(`<w:tbl>${Array.from({ length: 200 }, (_, r) => `<w:tr>${Array.from({ length: 10 }, (_, c) => `<w:tc><w:p><w:r><w:t>r${r}c${c}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`);
  const hwpx = hwpxOf([sectionXml(Array.from({ length: 200 }, (_, r) => Array.from({ length: 10 }, (_, c) => cellXml({ r, c, text: `r${r}c${c}` }))))]);
  for (const [data, fileName, scan] of [[docx, '큰.docx', scanDocx], [hwpx, '큰.hwpx', scanHwpx]]) {
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
