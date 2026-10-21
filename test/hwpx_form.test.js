// hwpx 양식 — 섹션·표·본문 문단 스캔(좌표·병합·폭·높이·글·접두사·잠김)과 칸·필드 기입(서식 승계·위치 대응·이스케이프·다른 멤버 보존)
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fillHwpx, scanHwpx } from '../lib/hwpx_form.js';
import { readZip, writeZip } from '../lib/zip.js';
import { bodyPara, cellXml, emptyZip, hwpxOf, hwpxRows as rowsOf, secOf, sectionXml, tablePara } from './fixtures/form_docs.js';

const sectionOf = (data, n = 0) => readZip(data).read(`Contents/section${n}.xml`).toString('utf8');

const doc = hwpxOf([sectionXml(rowsOf())]);
const cell = (r, c, text, more = {}) => ({ r, c, colspan: 1, rowspan: 1, text, ...more });
const tablesOf = data => scanHwpx(data).items.filter(i => i.kind === 'table');
const cellOf = (data, r, c, t = 0) => tablesOf(data)[t].rows.flatMap(row => row.cells).find(x => x.r === r && x.c === c);

test('scanHwpx: 좌표·병합·폭·높이·글·접두사', () => {
  const { format, items } = scanHwpx(doc);
  assert.equal(format, 'hwpx');
  assert.deepEqual(items[0], { kind: 'paragraph', section: 0, p: 0, text: '신상 조서', hints: {} });
  assert.deepEqual(items[1], {
    kind: 'table', t: 0, section: 0, cols: [30, 70], rows: [
      { height: 2.82, fixedHeight: false, cells: [cell(0, 0, '제안자'), cell(0, 1, '홍길동')] },
      { height: 5, fixedHeight: false, cells: [cell(1, 0, '기관', { rowspan: 2 }), cell(1, 1, '한국선급\n연구소')] },
      { height: 2.82, fixedHeight: false, cells: [cell(2, 1, '')] },
    ],
  });
  assert.equal(items.length, 2);
  assert.deepEqual(scanHwpx(hwpxOf([sectionXml(rowsOf({ pfx: 'ns0' }), 'ns0', 'ss')])).items, items);
});

test('scanHwpx: cellAddr 가 subList 앞에 있어도 같다', () => {
  assert.deepEqual(scanHwpx(hwpxOf([sectionXml(rowsOf({ addrAfter: false }))])).items, scanHwpx(doc).items);
});

test('scanHwpx: cellAddr 없으면 순번', () => {
  const bare = x => x.replace(/<hp:cellAddr[^>]*\/>/, '');
  const half = cellXml({ r: 7, c: 7, text: '라' }).replace(' rowAddr="7"', ''); // 한쪽 속성만 있으면 순번
  const data = hwpxOf([sectionXml([[bare(cellXml({ r: 0, c: 0, text: '가' })), bare(cellXml({ r: 0, c: 3, text: '나' }))], [bare(cellXml({ r: 1, c: 5, text: '다' })), half]])]);
  assert.deepEqual(tablesOf(data)[0].rows.map(row => row.cells.map(x => [x.r, x.c, x.text])), [[[0, 0, '가'], [0, 1, '나']], [[1, 0, '다'], [1, 1, '라']]]);
});

test('scanHwpx: 중첩 표 잠김 — 중첩 칸의 cellAddr·cellSpan·글은 바깥 칸 것이 아니다', () => {
  const inner = cellXml({ r: 3, c: 4, text: '안', rowSpan: 3, w: 100 });
  const outer = cellXml({ r: 0, c: 1, text: '앞' }).replace('</hp:run>', `</hp:run><hp:run charPrIDRef="1"><hp:tbl id="10"><hp:tr>${inner}</hp:tr></hp:tbl></hp:run>`);
  const data = hwpxOf([sectionXml([[cellXml({ r: 0, c: 0, text: '라벨' }), outer]])]);
  const [tbl] = tablesOf(data);
  assert.deepEqual(tbl.rows[0].cells, [cell(0, 0, '라벨'), cell(0, 1, '앞', { locked: '중첩 표' })]);
  assert.equal(tbl.rows.length, 1);
  assert.deepEqual(tbl.cols, [50, 50]);
});

test('scanHwpx: 열 폭 — 병합 칸 경계는 다른 행에서, rowspan 아래 틈은 아는 경계에서 잇는다', () => {
  const colsOf = rows => tablesOf(hwpxOf([sectionXml(rows)]))[0].cols;
  assert.deepEqual(colsOf([[cellXml({ r: 0, c: 0, text: '머리', colSpan: 2, w: 10000 })], [cellXml({ r: 1, c: 0, text: '가', w: 3000 }), cellXml({ r: 1, c: 1, text: '나', w: 7000 })]]), [30, 70]);
  assert.deepEqual(colsOf([[cellXml({ r: 0, c: 0, text: '세로', rowSpan: 2, w: 2000 }), cellXml({ r: 0, c: 1, text: '가', w: 8000 })], [cellXml({ r: 1, c: 1, text: '나', w: 8000 })]]), [20, 80]);
  assert.equal(colsOf([[cellXml({ r: 0, c: 0, text: '머리', colSpan: 2, w: 10000 })]]), null); // 가운데 경계를 모른다
});

test('scanHwpx: 그리기 개체 주의', () => {
  const pic = cellXml({ r: 0, c: 0, text: '그림' }).replace('</hp:run>', '</hp:run><hp:run charPrIDRef="1"><hp:pic id="5"/></hp:run>');
  const data = hwpxOf([secOf(`<hp:p paraPrIDRef="3"><hp:run charPrIDRef="5"><hp:rect id="1"/><hp:t>글</hp:t></hp:run></hp:p>${tablePara([[pic]])}`)]);
  const [para, tbl] = scanHwpx(data).items;
  assert.equal(para.note, '그리기 개체 있음');
  assert.deepEqual(tbl.rows[0].cells[0], cell(0, 0, '그림', { note: '그리기 개체 있음' }));
});

test('scanHwpx: 글 — tab·lineBreak·그 밖 태그·엔티티·<t/>·공백 그대로', () => {
  const body = '<hp:p paraPrIDRef="3"><hp:run charPrIDRef="5"><hp:t> 가<hp:tab width="10"/>나<hp:lineBreak/>다<hp:markpenBegin color="#FF0"/>&amp;&lt;라 </hp:t><hp:t/></hp:run></hp:p>';
  assert.equal(scanHwpx(hwpxOf([secOf(body)])).items[0].text, ' 가\t나\n다&<라 ');
});

test('scanHwpx: 섹션 둘', () => {
  const data = hwpxOf([sectionXml(rowsOf()), sectionXml(rowsOf())]);
  assert.deepEqual(scanHwpx(data).items.filter(i => i.kind === 'table').map(t => [t.section, t.t]), [[0, 0], [1, 1]]);
});

const bodyDoc = hwpxOf([secOf([bodyPara('□ 제안 개요'), bodyPara('○ 배경 설명임'), bodyPara(''), tablePara(rowsOf()), bodyPara('끝')].join(''))]);

test('scanHwpx: 본문 문단 항목', () => {
  const { items } = scanHwpx(bodyDoc);
  assert.deepEqual(items.map(i => i.kind), ['paragraph', 'paragraph', 'paragraph', 'table', 'paragraph']);
  assert.deepEqual(items[0], { kind: 'paragraph', section: 0, p: 0, text: '□ 제안 개요', hints: {} });
  assert.equal(items[1].p, 1);
  assert.equal(items[4].p, 4);
  assert.equal(items[2].text, '');
});

test('fillHwpx: 필드 문단 교체·헤딩 뒤 끼우기', () => {
  const filled = fillHwpx(bodyDoc, [
    { unit: { kind: 'field', section: 0, p: 1 }, text: 'a\nb' },
    { unit: { kind: 'field', section: 0, p: 0, after: true }, text: '새 본문' },
  ]);
  const xml = sectionOf(filled);
  assert.ok(xml.includes('<hp:p paraPrIDRef="3"><hp:run charPrIDRef="5"><hp:t>a</hp:t></hp:run></hp:p><hp:p paraPrIDRef="3"><hp:run charPrIDRef="5"><hp:t>b</hp:t></hp:run></hp:p>'));
  assert.ok(!xml.includes('○ 배경 설명임'));
  assert.ok(xml.includes(`${bodyPara('□ 제안 개요')}<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>새 본문</hp:t></hp:run></hp:p>`));
  const { items } = scanHwpx(filled);
  assert.deepEqual(items.filter(i => i.kind === 'paragraph' && i.text).map(i => i.text), ['□ 제안 개요', '새 본문', 'a', 'b', '끝']);
});

test('fillHwpx: 없는 문단·표를 품은 문단은 필드가 아니다', () => {
  assert.throws(() => fillHwpx(bodyDoc, [{ unit: { kind: 'field', section: 0, p: 99 }, text: 'x' }]), /문단을 찾지 못했습니다: p99/);
  assert.throws(() => fillHwpx(bodyDoc, [{ unit: { kind: 'field', section: 1, p: 0 }, text: 'x' }]), /문단을 찾지 못했습니다: p0/);
  assert.throws(() => fillHwpx(bodyDoc, [{ unit: { kind: 'field', section: 0, p: 3 }, text: 'x' }]), /문단을 찾지 못했습니다: p3/);
});

test('누름틀(ctrl 안 fieldBegin)만 든 문단은 채울 수 있고 필드 있음을 알린다', () => {
  const field = '<hp:p paraPrIDRef="3"><hp:run charPrIDRef="1"><hp:ctrl><hp:fieldBegin id="1" type="CLICK_HERE"/></hp:ctrl></hp:run><hp:run charPrIDRef="1"><hp:t>이름</hp:t></hp:run><hp:run charPrIDRef="1"><hp:ctrl><hp:fieldEnd beginIDRef="1"/></hp:ctrl></hp:run></hp:p>';
  const both = cellXml({ r: 0, c: 0, text: '칸' }).replace('</hp:run>', '</hp:run><hp:run charPrIDRef="1"><hp:pic id="5"/><hp:ctrl><hp:fieldBegin id="2" type="CLICK_HERE"/></hp:ctrl></hp:run>');
  const data = hwpxOf([secOf(`${field}${tablePara([[both]])}`)]);
  const [para, tbl] = scanHwpx(data).items;
  assert.deepEqual(para, { kind: 'paragraph', section: 0, p: 0, text: '이름', hints: {}, note: '필드 있음' });
  assert.equal(tbl.rows[0].cells[0].note, '그리기 개체 있음 · 필드 있음');
  const filled = fillHwpx(data, [{ unit: { kind: 'field', section: 0, p: 0 }, text: '홍길동' }]);
  assert.equal(scanHwpx(filled).items[0].text, '홍길동');
});

test('문서 설정(secPr·colPr 를 품은 ctrl)이 든 문단은 잠긴다 — 바꾸기는 거절, 뒤에 끼우기는 그 문단을 남긴다', () => {
  const head = '<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="1"><hp:secPr id="" textDirection="HORIZONTAL"/></hp:run><hp:run charPrIDRef="1"><hp:t>머리글</hp:t></hp:run></hp:p>';
  const cols = '<hp:p paraPrIDRef="3"><hp:run charPrIDRef="5"><hp:ctrl><hp:colPr id="" type="NEWSPAPER" colCount="1"/></hp:ctrl><hp:t>단</hp:t></hp:run></hp:p>';
  const data = hwpxOf([secOf(`${head}${cols}${bodyPara('본문')}`)]);
  const { items } = scanHwpx(data);
  assert.deepEqual(items[0], { kind: 'paragraph', section: 0, p: 0, text: '머리글', hints: {}, locked: '문서 설정' });
  assert.equal(items[1].locked, '문서 설정');
  assert.equal(items[2].locked, undefined);
  assert.throws(() => fillHwpx(data, [{ unit: { kind: 'field', section: 0, p: 0 }, text: 'x' }]), /잠긴 문단입니다: p0/);
  assert.throws(() => fillHwpx(data, [{ unit: { kind: 'field', section: 0, p: 1 }, text: 'x' }]), /잠긴 문단/);
  const after = sectionOf(fillHwpx(data, [{ unit: { kind: 'field', section: 0, p: 0, after: true }, text: '뒤' }]));
  assert.ok(after.includes(`${head}<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>뒤</hp:t></hp:run></hp:p>`));
});

test('fillHwpx: 서식 승계·여러 줄 위치 대응·자기 닫힘 run·CRLF·이스케이프', () => {
  const filled = fillHwpx(doc, [
    { unit: { kind: 'cell', t: 0, r: 1, c: 1 }, text: 'a\r\nb\nc' },
    { unit: { kind: 'cell', t: 0, r: 2, c: 1 }, text: 'x & y' },
  ]);
  const xml = sectionOf(filled);
  const a = '<hp:p id="200" paraPrIDRef="7" styleIDRef="0"><hp:run charPrIDRef="12"><hp:t>a</hp:t></hp:run></hp:p>';
  const b = '<hp:p id="201" paraPrIDRef="8" styleIDRef="0"><hp:run charPrIDRef="13"><hp:t>b</hp:t></hp:run></hp:p>';
  const c = '<hp:p id="201" paraPrIDRef="8" styleIDRef="0"><hp:run charPrIDRef="13"><hp:t>c</hp:t></hp:run></hp:p>';
  assert.ok(xml.includes(`vertAlign="CENTER">${a}${b}${c}</hp:subList>`));
  const cellAt = (s, at) => s.slice(s.lastIndexOf('<hp:tc', at), s.indexOf('</hp:tc>', at));
  assert.ok(cellAt(sectionOf(doc), sectionOf(doc).indexOf('id="200"')).includes('linesegarray'));
  assert.ok(!cellAt(xml, xml.indexOf('id="200"')).includes('linesegarray'));
  assert.ok(xml.includes('<hp:run charPrIDRef="22"><hp:t>x &amp; y</hp:t></hp:run>'));
  assert.equal(cellOf(filled, 1, 1).text, 'a\nb\nc');
  assert.equal(cellOf(filled, 2, 1).text, 'x & y');
  for (const name of ['mimetype', 'version.xml', 'Contents/header.xml']) assert.deepEqual(readZip(filled).read(name), readZip(doc).read(name));
  const [row0, row1] = rowsOf();
  for (const x of [...row0, row1[0]]) assert.ok(xml.includes(x));
});

test('fillHwpx: 빈 줄은 그 자리 문단(스페이서) 서식, 글 있는 줄은 글 있는 문단 서식', () => {
  const paras = [['제목', 7, 1], ['', 7, 2], ['본문', 9, 3]];
  const data = hwpxOf([sectionXml([[cellXml({ r: 0, c: 0, paras }), cellXml({ r: 0, c: 1, paras })]])]);
  const xml = sectionOf(fillHwpx(data, [{ unit: { kind: 'cell', t: 0, r: 0, c: 0 }, text: '새 제목\n\n새 본문' }, { unit: { kind: 'cell', t: 0, r: 0, c: 1 }, text: 'A\nB' }]));
  const p = (id, pr, ch, t) => `<hp:p id="${id}" paraPrIDRef="${pr}" styleIDRef="0"><hp:run charPrIDRef="${ch}"><hp:t>${t}</hp:t></hp:run></hp:p>`;
  assert.ok(xml.includes(`vertAlign="CENTER">${p(200, 7, 1, '새 제목')}${p(201, 7, 2, '')}${p(202, 9, 3, '새 본문')}</hp:subList>`));
  assert.ok(xml.includes(`vertAlign="CENTER">${p(200, 7, 1, 'A')}${p(202, 9, 3, 'B')}</hp:subList>`));
});

test('fillHwpx: 여러 줄 값의 쪽·단 나눔은 첫 줄 문단에만', () => {
  const field = '<hp:p id="5" paraPrIDRef="3" styleIDRef="0" pageBreak="1" columnBreak="1" merged="0"><hp:run charPrIDRef="5"><hp:t>옛 글</hp:t></hp:run></hp:p>';
  const xml = sectionOf(fillHwpx(hwpxOf([secOf(`${field}${tablePara(rowsOf())}`)]), [{ unit: { kind: 'field', section: 0, p: 0 }, text: '하나\n둘\n셋' }]));
  const line = (pb, t) => `<hp:p id="5" paraPrIDRef="3" styleIDRef="0" pageBreak="${pb}" columnBreak="${pb}" merged="0"><hp:run charPrIDRef="5"><hp:t>${t}</hp:t></hp:run></hp:p>`;
  assert.ok(xml.includes(`${line(1, '하나')}${line(0, '둘')}${line(0, '셋')}`));
});

test('fillHwpx: 문단 없는 칸', () => {
  const data = hwpxOf([sectionXml([[cellXml({ r: 0, c: 0, paras: [] })]])]);
  const filled = fillHwpx(data, [{ unit: { kind: 'cell', t: 0, r: 0, c: 0 }, text: 'v' }]);
  assert.ok(sectionOf(filled).includes('vertAlign="CENTER"><hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>v</hp:t></hp:run></hp:p></hp:subList>'));
  assert.equal(cellOf(filled, 0, 0).text, 'v');
});

test('fillHwpx: 둘째 섹션 기입은 둘째 멤버만 바꾼다', () => {
  const data = hwpxOf([sectionXml(rowsOf()), sectionXml(rowsOf())]);
  const filled = fillHwpx(data, [{ unit: { kind: 'cell', t: 1, r: 0, c: 1 }, text: '새 값' }]);
  assert.deepEqual(readZip(filled).read('Contents/section0.xml'), readZip(data).read('Contents/section0.xml'));
  assert.equal(cellOf(filled, 0, 1, 1).text, '새 값');
  assert.equal(cellOf(filled, 0, 1, 0).text, '홍길동');
});

test('fillHwpx: 없는 칸·같은 자리 두 번', () => {
  assert.throws(() => fillHwpx(doc, [{ unit: { kind: 'cell', t: 0, r: 9, c: 0 }, text: 'x' }]), /칸을 찾지 못했습니다: T0 r9 c0/);
  assert.throws(() => fillHwpx(doc, [{ unit: { kind: 'cell', t: 3, r: 0, c: 0 }, text: 'x' }]), /칸을 찾지 못했습니다: T3 r0 c0/);
  const twice = { unit: { kind: 'cell', t: 0, r: 1, c: 1 }, text: 'x' };
  assert.throws(() => fillHwpx(doc, [twice, twice]), /같은 자리/);
});

test('scanHwpx: 섹션 파일 없음', () => {
  const zip = writeZip(emptyZip(), { mimetype: 'application/hwp+zip', 'Contents/header.xml': '<hh:head/>' });
  assert.throws(() => scanHwpx(zip), err => err.format === true && /한글|hwpx/.test(err.message));
  assert.throws(() => fillHwpx(zip, []), err => err.format === true);
});

const SAMPLE = 'E:/dev/AIComp/demo/samples/기술수요조사서.hwpx';
(existsSync(SAMPLE) ? test : test.skip)('실제 파일: 기술수요조사서.hwpx 스캔·기입·재스캔', () => {
  const data = readFileSync(SAMPLE);
  const scanned = scanHwpx(data);
  const tables = scanned.items.filter(i => i.kind === 'table');
  assert.equal(tables.length, 2);
  assert.equal(tables.flatMap(t => t.rows.flatMap(row => row.cells)).length, 43);
  assert.equal(tables[1].cols.length, 11);
  assert.ok(Math.abs(tables[1].cols.reduce((a, b) => a + b, 0) - 100) <= 0.5);
  const tbl = tables.find(t => t.rows.some(row => row.cells.some(x => x.text)));
  const target = tbl.rows.flatMap(row => row.cells).find(x => x.text);
  const filled = fillHwpx(data, [{ unit: { kind: 'cell', t: tbl.t, r: target.r, c: target.c }, text: '값 & 기입\n둘째 줄' }]);
  const expected = structuredClone(scanned);
  expected.items.find(i => i.kind === 'table' && i.t === tbl.t).rows.flatMap(row => row.cells).find(x => x.r === target.r && x.c === target.c).text = '값 & 기입\n둘째 줄';
  assert.deepEqual(scanHwpx(filled), expected);
  const before = readZip(data), after = readZip(filled);
  assert.deepEqual(after.names, before.names);
  for (const name of before.names.filter(n => n !== 'Contents/section0.xml')) assert.deepEqual(after.read(name), before.read(name), name);
});
