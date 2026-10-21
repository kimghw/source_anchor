// docx 양식 — 본문·표 스캔(번호·병합·폭·높이·글·잠김·주의)과 칸·필드 기입(서식 승계·이스케이프·다른 칸 보존)
import assert from 'node:assert/strict';
import test from 'node:test';
import { fillDocx, scanDocx } from '../lib/docx_form.js';
import { readZip, writeZip } from '../lib/zip.js';
import { docxHeading as heading, docxOf, docxP as p, docxSentence as sentence, docxTable as table, docxTc as tc, emptyZip } from './fixtures/form_docs.js';

const documentOf = data => readZip(data).read('word/document.xml').toString('utf8');

const doc = docxOf(`${heading}${sentence}<w:p/>${table}<w:p><w:r><w:t>끝 글</w:t></w:r></w:p>`);

const tableOf = data => scanDocx(data).items.find(i => i.kind === 'table');
const cellOf = (data, r, c) => tableOf(data).rows[r].cells.find(x => x.c === c);
const cell = (r, c, text, more = {}) => ({ r, c, colspan: 1, rowspan: 1, text, ...more });

test('scanDocx: 번호·병합·폭·높이·글·잠김·주의', () => {
  const tables = scanDocx(doc).items.filter(i => i.kind === 'table');
  assert.equal(tables.length, 1);
  const [{ cols, rows }] = tables;
  assert.deepEqual(cols, [20, 30, 50]);
  assert.equal(rows[0].height, 31);
  assert.equal(rows[0].fixedHeight, true);
  assert.equal(rows[1].height, null);
  assert.equal(rows[1].fixedHeight, false);
  assert.deepEqual(rows[0].cells, [cell(0, 0, '제목', { colspan: 3 })]);
  assert.deepEqual(rows[1].cells, [cell(1, 0, 'A', { rowspan: 2 }), cell(1, 1, '과제명'), cell(1, 2, '값1\n둘째\n')]);
  assert.deepEqual(rows[2].cells, [cell(2, 1, '장소'), cell(2, 2, 'x & y\tz')]); // 이어짐 칸(c0)은 빠진다
  assert.deepEqual(rows[3].cells, [cell(3, 0, '', { note: '필드 있음' }), cell(3, 1, '', { locked: '중첩 표' }), cell(3, 2, '')]);
});

test('scanDocx: 본문 항목 순서·hints·빈 문단', () => {
  const { format, items } = scanDocx(doc);
  assert.equal(format, 'docx');
  assert.deepEqual(items.map(i => i.kind), ['paragraph', 'paragraph', 'paragraph', 'table', 'paragraph']);
  assert.deepEqual(items[0], { kind: 'paragraph', section: 0, p: 0, text: '1. 제안 개요', hints: { style: 'Heading1', outlineLvl: null, ilvl: null } });
  assert.equal(items[0].hints.style, 'Heading1');
  assert.equal(items[1].hints.ilvl, 1);
  assert.equal(items[2].text, '');
  assert.equal(items[4].p, 3);
  assert.equal(items[3].t, 0);
  assert.equal(items[3].section, 0);
});

test('scanDocx: tcPr 자기 닫힘·없음, tblGrid 없음, 탭 위치는 글이 아니다', () => {
  const plain = docxOf('<w:tbl><w:tr><w:tc><w:tcPr/><w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>옛</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>둘</w:t></w:r></w:p></w:tc></w:tr></w:tbl>');
  const tbl = tableOf(plain);
  assert.equal(tbl.cols, null);
  assert.deepEqual(tbl.rows, [{ height: null, fixedHeight: false, cells: [cell(0, 0, '옛'), cell(0, 1, '둘')] }]);
});

test('fillDocx: 필드 문단 교체·헤딩 뒤 끼우기', () => {
  const filled = fillDocx(doc, [
    { unit: { kind: 'field', section: 0, p: 1 }, text: '첫 줄\n둘째 줄' },
    { unit: { kind: 'field', section: 0, p: 0, after: true }, text: '새 본문' },
  ]);
  const xml = documentOf(filled);
  const shell = '<w:pPr><w:numPr><w:ilvl w:val="1"/></w:numPr></w:pPr>';
  assert.ok(xml.includes(`<w:p>${shell}<w:r><w:t xml:space="preserve">첫 줄</w:t></w:r></w:p><w:p>${shell}<w:r><w:t xml:space="preserve">둘째 줄</w:t></w:r></w:p>`));
  assert.ok(!xml.includes('본문 문장이다.'));
  assert.ok(xml.includes(`${heading}<w:p><w:r><w:t xml:space="preserve">새 본문</w:t></w:r></w:p>`));
  const { items } = scanDocx(filled);
  assert.deepEqual(items.filter(i => i.kind === 'paragraph' && i.text).map(i => i.text), ['1. 제안 개요', '새 본문', '첫 줄', '둘째 줄', '끝 글']);
  assert.deepEqual(items.map(i => i.kind === 'table' ? 'table' : i.text), ['1. 제안 개요', '새 본문', '첫 줄', '둘째 줄', '', 'table', '끝 글']);
});

test('fillDocx: 서식 승계·여러 줄·이스케이프·빈 값·문단 없는 칸·CRLF·다른 칸 보존', () => {
  const filled = fillDocx(doc, [
    { unit: { kind: 'cell', t: 0, r: 1, c: 1 }, text: 'A & B\r\n  둘째  ' },
    { unit: { kind: 'cell', t: 0, r: 1, c: 2 }, text: '' },
    { unit: { kind: 'cell', t: 0, r: 3, c: 2 }, text: '새 글' },
  ]);
  const xml = documentOf(filled);
  assert.ok(xml.includes('<w:p><w:pPr><w:jc w:val="center"/><w:rPr><w:sz w:val="20"/></w:rPr></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">A &amp; B</w:t></w:r></w:p>'));
  assert.ok(xml.includes('<w:t xml:space="preserve">  둘째  </w:t>'));
  assert.ok(!xml.includes('과제명'));
  assert.ok(xml.includes('<w:tc><w:tcPr></w:tcPr><w:p><w:r><w:t xml:space="preserve"></w:t></w:r></w:p></w:tc>')); // 행1 c2: 빈 문단 하나
  assert.ok(xml.includes('<w:tc><w:tcPr></w:tcPr><w:p><w:r><w:t xml:space="preserve">새 글</w:t></w:r></w:p></w:tc>'));
  assert.equal(cellOf(filled, 1, 1).text, 'A & B\n  둘째  ');
  assert.equal(cellOf(filled, 1, 2).text, '');
  assert.equal(cellOf(filled, 3, 2).text, '새 글');
  assert.ok(xml.includes(tc(p('제목'), '<w:gridSpan w:val="3"/>')));
  assert.deepEqual(readZip(filled).read('[Content_Types].xml'), readZip(doc).read('[Content_Types].xml'));
});

test('fillDocx: 문단 표시 rPr 폴백·중첩 rPr 통째 승계', () => {
  const plain = docxOf('<w:tbl><w:tr><w:tc><w:p><w:pPr><w:rPr><w:i/></w:rPr></w:pPr><w:r><w:t>옛</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:rPr><w:b/><w:rPrChange w:id="1"><w:rPr><w:i/></w:rPr></w:rPrChange></w:rPr><w:t>둘</w:t></w:r></w:p></w:tc></w:tr></w:tbl>');
  const xml = documentOf(fillDocx(plain, [{ unit: { kind: 'cell', t: 0, r: 0, c: 0 }, text: '새' }, { unit: { kind: 'cell', t: 0, r: 0, c: 1 }, text: '셋' }]));
  assert.ok(xml.includes('<w:p><w:pPr><w:rPr><w:i/></w:rPr></w:pPr><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">새</w:t></w:r></w:p>'));
  assert.ok(xml.includes('<w:p><w:r><w:rPr><w:b/><w:rPrChange w:id="1"><w:rPr><w:i/></w:rPr></w:rPrChange></w:rPr><w:t xml:space="preserve">셋</w:t></w:r></w:p>'));
});

test('fillDocx: 여러 줄 값의 앞 쪽 나눔은 첫 문단에만 — 둘째 줄부터는 그 자리에서 끈다', () => {
  const data = docxOf(`<w:p><w:pPr><w:keepNext/><w:pageBreakBefore/><w:jc w:val="left"/></w:pPr><w:r><w:t>옛 글</w:t></w:r></w:p>${table}`);
  const xml = documentOf(fillDocx(data, [{ unit: { kind: 'field', section: 0, p: 0 }, text: '하나\n둘\n셋' }]));
  const off = '<w:pPr><w:keepNext/><w:pageBreakBefore w:val="0"/><w:jc w:val="left"/></w:pPr>';
  assert.ok(xml.includes(`<w:p><w:pPr><w:keepNext/><w:pageBreakBefore/><w:jc w:val="left"/></w:pPr><w:r><w:t xml:space="preserve">하나</w:t></w:r></w:p><w:p>${off}<w:r><w:t xml:space="preserve">둘</w:t></w:r></w:p><w:p>${off}<w:r>`));
  assert.equal(xml.match(/<w:pageBreakBefore\/>/g).length, 1);
});

test('scanDocx: 각주·미주·메모 참조 표시가 든 문단·칸은 참조 표시 있음', () => {
  const data = docxOf(`<w:p><w:r><w:t>본문</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:commentReference w:id="0"/></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r></w:p></w:tc></w:tr></w:tbl>`);
  const [para, tbl] = scanDocx(data).items;
  assert.equal(para.note, '참조 표시 있음');
  assert.equal(tbl.rows[0].cells[0].note, '필드 있음 · 참조 표시 있음');
});

test('fillDocx: 없는 칸·없는 문단·같은 자리 두 번', () => {
  assert.throws(() => fillDocx(doc, [{ unit: { kind: 'cell', t: 0, r: 9, c: 0 }, text: 'x' }]), /칸을 찾지 못했습니다: T0 r9 c0/);
  assert.throws(() => fillDocx(doc, [{ unit: { kind: 'field', section: 0, p: 99 }, text: 'x' }]), /문단을 찾지 못했습니다: p99/);
  const twice = { unit: { kind: 'cell', t: 0, r: 1, c: 1 }, text: 'x' };
  assert.throws(() => fillDocx(doc, [twice, twice]), Error);
});

test('구역 설정(pPr 안 sectPr)이 든 문단은 잠긴다', () => {
  const data = docxOf(`${heading}<w:p><w:pPr><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr></w:p>`);
  const { items } = scanDocx(data);
  assert.deepEqual(items[1], { kind: 'paragraph', section: 0, p: 1, text: '', hints: { style: null, outlineLvl: null, ilvl: null }, locked: '구역 설정' });
  assert.equal(items[0].locked, undefined);
  assert.throws(() => fillDocx(data, [{ unit: { kind: 'field', section: 0, p: 1 }, text: 'x' }]), /잠긴 문단입니다: p1/);
});

test('scanDocx: document.xml 없음', () => {
  const zip = writeZip(emptyZip(), { '[Content_Types].xml': '<Types/>' });
  assert.throws(() => scanDocx(zip), err => err.format === true && /format|Word/.test(err.message));
});
