// hwp 양식 — 레코드·글자 코덱(hwp_file), 섹션·표·본문 문단 스캔(좌표·병합·폭·높이·힌트·잠김·주의)과 칸·필드 기입(서식 승계·위치 대응·nParas·bit31·다른 스트림 보존)
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCfb, readCfb } from '../lib/cfb.js';
import { TAG, ctrlMaskOf, decodeText, docParaShapes, docStyles, encodeRecord, encodeText, isHwp, openHwp, parseRecords } from '../lib/hwp_file.js';
import { fillHwp, scanHwp } from '../lib/hwp_form.js';
import { hwpOf, hwpRows as rowsOf, sectionItems, tablePara } from './fixtures/hwp_docs.js';

const doc = hwpOf({ sections: [sectionItems()] });
const hints = (style = '바탕글', outlineLvl = null, ilvl = null) => ({ style, outlineLvl, ilvl });
const cell = (r, c, text, more = {}) => ({ r, c, colspan: 1, rowspan: 1, text, ...more });
const tablesOf = data => scanHwp(data).items.filter(i => i.kind === 'table');
const cellOf = (data, r, c, t = 0) => tablesOf(data)[t].rows.flatMap(row => row.cells).find(x => x.r === r && x.c === c);
const paraTexts = data => scanHwp(data).items.filter(i => i.kind === 'paragraph' && i.text).map(i => i.text);
const recordsOf = (data, n = 0) => openHwp(data).sections[n].records;
const isCell = (r, row, col) => r.tag === TAG.LIST_HEADER && r.data.length === 47 && r.data.readUInt16LE(10) === row && r.data.readUInt16LE(8) === col;
// 칸(r, c)의 문단들 — LIST_HEADER 와 같은 level 의 PARA_HEADER 와 그 자식 레코드
function cellParas(records, row, col) {
  const j = records.findIndex(r => isCell(r, row, col));
  const level = records[j].level;
  const out = [];
  for (let k = j + 1; k < records.length && (records[k].level > level || records[k].tag === TAG.PARA_HEADER); k++) {
    if (records[k].level === level) out.push({ header: records[k].data, kids: [] });
    else out.at(-1).kids.push(records[k]);
  }
  return { nParas: records[j].data.readInt16LE(0), level, paras: out };
}
const headOf = h => ({ nChars: h.readUInt32LE(0) & 0x7FFFFFFF, last: !!(h.readUInt32LE(0) & 0x80000000), mask: h.readUInt32LE(4), paraShape: h.readUInt16LE(8), style: h[10], brk: h[11], nCharShape: h.readUInt16LE(12), nRangeTag: h.readUInt16LE(14), nLineSeg: h.readUInt16LE(16) });
const kidTags = kids => kids.map(k => k.tag);
const charShapeOf = kids => kids.find(k => k.tag === TAG.PARA_CHAR_SHAPE).data.readUInt32LE(4);

// ── hwp_file

test('parseRecords·encodeRecord: 헤더 DWORD 왕복, 확장 크기 헤더, start·end, 경계 오류', () => {
  const big = Buffer.alloc(0x1234, 9);
  const buf = Buffer.concat([encodeRecord(0x42, 0, Buffer.from([1, 2])), encodeRecord(0x43, 1, Buffer.alloc(0)), encodeRecord(0x4D, 2, big)]);
  const recs = parseRecords(buf);
  assert.deepEqual(recs.map(r => [r.tag, r.level, r.data.length, r.start, r.end]), [[0x42, 0, 2, 0, 6], [0x43, 1, 0, 6, 10], [0x4D, 2, 0x1234, 10, 10 + 8 + 0x1234]]);
  assert.ok(recs[2].data.equals(big));
  assert.equal(buf.readUInt32LE(10) >>> 20, 0xFFF);
  assert.equal(encodeRecord(0x42, 0, Buffer.alloc(0xFFE)).length, 4 + 0xFFE);
  assert.throws(() => parseRecords(buf.subarray(0, 20)), err => err.format === true && /손상/.test(err.message));
  assert.throws(() => parseRecords(Buffer.concat([buf, Buffer.from([1, 2])])), err => err.format === true);
  assert.deepEqual(parseRecords(Buffer.alloc(0)), []);
});

test('decodeText·encodeText: 탭·줄 바꿈·문단 끝·확장 제어(ctrl id)·그 밖 제어 글자', () => {
  const text = ' 가\t나\n다 & <라> ';
  const enc = encodeText(text);
  assert.equal(enc.length, (text.length - 1 + 8 + 1) * 2); // 탭 8 유닛 + 문단 끝 1
  assert.equal(enc.readUInt16LE(enc.length - 2), 13);
  assert.deepEqual(decodeText(enc), { text, ctrls: [] });
  assert.equal(ctrlMaskOf(enc), (1 << 9) | (1 << 10));
  assert.equal(ctrlMaskOf(encodeText('가')), 0);
  assert.deepEqual(decodeText(encodeText('a\u0001b\u001Fc')), { text: 'abc', ctrls: [] });
  assert.equal(encodeText('').length, 2);
  // 확장 제어: 코드 11 + ' lbt' + 8B + 코드 11 → ctrls 에 id, 글에서는 빠진다. 글자형 제어(24~31) 1 유닛
  const ext = Buffer.alloc(16);
  ext.writeUInt16LE(11, 0);
  Buffer.from(' lbt', 'latin1').copy(ext, 2);
  ext.writeUInt16LE(11, 14);
  const field = Buffer.from(ext);
  field.writeUInt16LE(3, 0);
  Buffer.from('kmb%', 'latin1').copy(field, 2);
  field.writeUInt16LE(3, 14);
  const nb = Buffer.alloc(2);
  nb.writeUInt16LE(30, 0);
  const raw = Buffer.concat([ext, Buffer.from('앞', 'utf16le'), field, nb, Buffer.from('뒤', 'utf16le'), encodeText('')]);
  assert.deepEqual(decodeText(raw), { text: '앞뒤', ctrls: [{ code: 11, id: 'tbl ' }, { code: 3, id: '%bmk' }] });
  assert.equal(ctrlMaskOf(raw), (1 << 11) | (1 << 3) | (1 << 30));
});

test('openHwp: 머리글·DocInfo 스타일·문단 모양·섹션, 형식 오류(OLE 아님·FileHeader 없음·암호·배포용)', () => {
  const { header, docInfo, sections, cfb } = openHwp(doc);
  assert.deepEqual(header, { version: '5.1.0.1', compressed: true, encrypted: false, distribution: false });
  assert.deepEqual(docStyles(docInfo).map(s => [s.name, s.eng, s.paraShape]), [['바탕글', 'Normal', 0], ['본문', 'Body', 0], ['개요 1', 'Outline 1', 2], ['표내용', 'Table Text', 0]]);
  assert.deepEqual(docParaShapes(docInfo), [{ headType: 0, level: 0 }, { headType: 3, level: 1 }, { headType: 1, level: 0 }, { headType: 1, level: 1 }, { headType: 2, level: 2 }, { headType: 1, level: 3 }]);
  assert.deepEqual(sections.map(s => [s.name, s.n]), [['BodyText/Section0', 0]]);
  assert.ok(sections[0].records.length > 10 && sections[0].buf.length > 100);
  assert.ok(cfb.has('PrvText'));
  assert.equal(isHwp(doc), true);
  assert.equal(isHwp(Buffer.from('PK\x03\x04')), false);
  assert.equal(isHwp(createCfb({ a: Buffer.from('1') })), false);
  assert.throws(() => openHwp(Buffer.from('hello')), err => err.format === true && /OLE 복합 문서가 아닙니다/.test(err.message));
  assert.throws(() => openHwp(createCfb({ DocInfo: Buffer.from('x') })), err => err.format === true && /FileHeader 가 없습니다/.test(err.message));
  assert.throws(() => scanHwp(hwpOf({ sections: [sectionItems()], encrypted: true })), err => err.format === true && /암호가 걸린 한글 문서/.test(err.message));
  assert.throws(() => scanHwp(hwpOf({ sections: [sectionItems()], distribution: true })), err => err.format === true && /배포용 한글 문서/.test(err.message));
  assert.throws(() => scanHwp(hwpOf({ sections: [] })), err => err.format === true && /BodyText/.test(err.message));
  assert.throws(() => fillHwp(Buffer.from('hello'), []), err => err.format === true);
});

// ── 스캔

test('scanHwp: 문단 글·힌트, 표 좌표·병합·폭·높이·글', () => {
  const { format, items } = scanHwp(doc);
  assert.equal(format, 'hwp');
  assert.deepEqual(items[0], { kind: 'paragraph', section: 0, p: 0, text: '신상 조서', hints: hints() });
  assert.deepEqual(items[1], {
    kind: 'table', t: 0, section: 0, cols: [30, 70], rows: [
      { height: 2.82, fixedHeight: false, cells: [cell(0, 0, '제안자'), cell(0, 1, '홍길동')] },
      { height: 5, fixedHeight: false, cells: [cell(1, 0, '기관', { rowspan: 2 }), cell(1, 1, '한국선급\n연구소')] },
      { height: 2.82, fixedHeight: false, cells: [cell(2, 1, '')] },
    ],
  });
  assert.equal(items.length, 2);
  assert.deepEqual(scanHwp(hwpOf({ sections: [sectionItems()], compressed: false })).items, items);
});

test('scanHwp: 힌트 — 스타일 이름, 개요 수준(headType 1), 번호·글머리표 수준(headType 2·3)', () => {
  const data = hwpOf({ sections: [[{ text: '1. 개요', style: 2, paraShape: 2 }, { text: '1-1. 범위', style: 3, paraShape: 3 }, { text: '① 항목', paraShape: 5 }, { text: 'ㅇ 글머리', style: 1, paraShape: 1 }, { text: '가. 번호', paraShape: 4 }, { text: '없는 모양', style: 9, paraShape: 99 }, tablePara(rowsOf())]] });
  assert.deepEqual(scanHwp(data).items.filter(i => i.kind === 'paragraph').map(i => [i.text, i.hints]), [
    ['1. 개요', hints('개요 1', 0)], ['1-1. 범위', hints('표내용', 1)], ['① 항목', hints('바탕글', 3)], ['ㅇ 글머리', hints('본문', null, 1)], ['가. 번호', hints('바탕글', null, 2)], ['없는 모양', hints(null)],
  ]);
});

test('scanHwp: 같은 좌표 둘이면 첫 것, 열 폭 — 병합 칸 경계는 다른 행에서, rowspan 아래 틈은 아는 경계에서 잇는다', () => {
  const colsOf = rows => tablesOf(hwpOf({ sections: [[tablePara(rows)]] }))[0].cols;
  assert.deepEqual(colsOf([[{ r: 0, c: 0, text: '머리', colspan: 2, w: 10000 }], [{ r: 1, c: 0, text: '가', w: 3000 }, { r: 1, c: 1, text: '나', w: 7000 }]]), [30, 70]);
  assert.deepEqual(colsOf([[{ r: 0, c: 0, text: '세로', rowspan: 2, w: 2000 }, { r: 0, c: 1, text: '가', w: 8000 }], [{ r: 1, c: 1, text: '나', w: 8000 }]]), [20, 80]);
  assert.equal(colsOf([[{ r: 0, c: 0, text: '머리', colspan: 2, w: 10000 }]]), null); // 가운데 경계를 모른다
  const twice = tablesOf(hwpOf({ sections: [[tablePara([[{ r: 0, c: 0, text: '첫' }, { r: 0, c: 0, text: '둘째' }]])]] }))[0];
  assert.deepEqual(twice.rows[0].cells, [cell(0, 0, '첫')]);
  assert.equal(twice.rows[0].height, 2.82);
  assert.equal(tablesOf(hwpOf({ sections: [[tablePara([[{ r: 0, c: 0, text: '높이 없음', h: 0 }]])]] }))[0].rows[0].height, null);
});

test('scanHwp: 중첩 표 잠김 — 중첩 칸의 좌표·글은 바깥 칸 것이 아니다, 칸 문단의 단 설정은 문서 설정 잠김', () => {
  const nested = { r: 0, c: 1, paras: [{ text: '앞', tables: [{ rows: [[{ r: 3, c: 4, text: '안', rowspan: 3, w: 100 }]] }] }] };
  const cols = { r: 0, c: 2, paras: [{ text: '단', ctrls: ['cold'] }, '둘째'] };
  const [tbl] = tablesOf(hwpOf({ sections: [[tablePara([[{ r: 0, c: 0, text: '라벨' }, nested, cols]])]] }));
  assert.deepEqual(tbl.rows[0].cells, [cell(0, 0, '라벨'), cell(0, 1, '앞', { locked: '중첩 표' }), cell(0, 2, '단\n둘째', { locked: '문서 설정' })]);
  assert.equal(tbl.rows.length, 1);
  assert.deepEqual(tbl.cols, [33.3, 33.3, 33.3]);
});

test('scanHwp: 주의 — 그리기 개체·필드(% 컨트롤·글자 코드 3), 자동 번호·책갈피는 아무것도 아니다', () => {
  const data = hwpOf({ sections: [[{ text: '그림', ctrls: ['gso '] }, { text: '책갈피', ctrls: ['%bmk'] }, { text: '둘 다', ctrls: ['gso ', '%unk'] }, { text: '번호', ctrls: ['atno', 'bokm'] }, tablePara([[{ r: 0, c: 0, paras: [{ text: '칸', ctrls: ['gso '] }] }, { r: 0, c: 1, paras: ['앞', { text: '필드', ctrls: ['%clk'] }] }]])]] });
  const { items } = scanHwp(data);
  assert.deepEqual(items.slice(0, 4).map(i => [i.text, i.note ?? null, i.locked ?? null]), [['그림', '그리기 개체 있음', null], ['책갈피', '필드 있음', null], ['둘 다', '그리기 개체 있음 · 필드 있음', null], ['번호', null, null]]);
  assert.deepEqual(items[4].rows[0].cells, [cell(0, 0, '칸', { note: '그리기 개체 있음' }), cell(0, 1, '앞\n필드', { note: '필드 있음' })]);
});

test('scanHwp: 문서 설정(구역·단·머리말·쪽 번호 컨트롤)이 든 문단은 잠긴다', () => {
  const data = hwpOf({ sections: [[{ text: '머리글', ctrls: ['secd', 'cold'] }, { text: '쪽', ctrls: ['pgnp'] }, { text: '머리말', ctrls: ['head'] }, { text: '각주', ctrls: ['fn  '] }, '본문', tablePara(rowsOf())]] });
  const { items } = scanHwp(data);
  assert.deepEqual(items[0], { kind: 'paragraph', section: 0, p: 0, text: '머리글', hints: hints(), locked: '문서 설정' });
  assert.deepEqual(items.slice(1, 5).map(i => i.locked ?? null), ['문서 설정', '문서 설정', '문서 설정', null]);
});

test('scanHwp: 글 — 탭·줄 바꿈·공백 그대로, 빈 문단, 표를 품은 문단은 표 자리(글은 버린다), 섹션 둘·표 순번', () => {
  const items = scanHwp(hwpOf({ sections: [[' 가\t나\n다 ', '', tablePara(rowsOf(), { text: '표 앞 글' }), '끝'], sectionItems()] })).items;
  assert.deepEqual(items.map(i => [i.kind, i.section, i.p ?? i.t, i.text ?? null]), [['paragraph', 0, 0, ' 가\t나\n다 '], ['paragraph', 0, 1, ''], ['table', 0, 0, null], ['paragraph', 0, 3, '끝'], ['paragraph', 1, 0, '신상 조서'], ['table', 1, 1, null]]);
  const two = hwpOf({ sections: [[tablePara(rowsOf(), { tables: [{ rows: rowsOf() }, { rows: [[{ r: 0, c: 0, text: '둘째 표' }]] }] })]] });
  assert.deepEqual(tablesOf(two).map(t => [t.t, t.rows.length]), [[0, 3], [1, 1]]);
});

// ── 기입

test('fillHwp: 칸 한 줄 — 원 문단 서식 승계, nParas·bit31·글자 모양·줄 정렬, 재스캔', () => {
  const filled = fillHwp(doc, [{ unit: { kind: 'cell', t: 0, r: 0, c: 1 }, text: '김철수' }]);
  assert.equal(cellOf(filled, 0, 1).text, '김철수');
  const { nParas, level, paras } = cellParas(recordsOf(filled), 0, 1);
  assert.equal(nParas, 1);
  assert.equal(level, 2);
  assert.equal(paras.length, 1);
  assert.deepEqual(headOf(paras[0].header), { nChars: 4, last: true, mask: 0, paraShape: 0, style: 0, brk: 0, nCharShape: 1, nRangeTag: 0, nLineSeg: 1 });
  assert.deepEqual(kidTags(paras[0].kids), [TAG.PARA_TEXT, TAG.PARA_CHAR_SHAPE, TAG.PARA_LINE_SEG]);
  assert.ok(paras[0].kids.every(k => k.level === 3));
  assert.equal(paras[0].kids[2].data.length, 36);
  assert.equal(paras[0].kids[2].data.readUInt32LE(0), 0);
  assert.equal(paras[0].kids[2].data.readInt32LE(8), 1000); // 원 문단 줄 높이
  const expected = scanHwp(doc);
  expected.items[1].rows[0].cells[1].text = '김철수';
  assert.deepEqual(scanHwp(filled), expected);
});

test('fillHwp: 여러 줄·빈 값·탭 — 글 있는 줄은 글 있는 문단 서식을 차례로, 빈 줄은 PARA_TEXT 없이 nChars 1, 탭은 제어 마스크 bit 9', () => {
  const filled = fillHwp(doc, [
    { unit: { kind: 'cell', t: 0, r: 1, c: 1 }, text: 'a\r\nb\nc\t탭' },
    { unit: { kind: 'cell', t: 0, r: 0, c: 1 }, text: '' },
    { unit: { kind: 'cell', t: 0, r: 2, c: 1 }, text: '\n' },
  ]);
  assert.equal(cellOf(filled, 1, 1).text, 'a\nb\nc\t탭');
  assert.equal(cellOf(filled, 0, 1).text, '');
  assert.equal(cellOf(filled, 2, 1).text, '\n');
  const records = recordsOf(filled);
  const multi = cellParas(records, 1, 1);
  assert.equal(multi.nParas, 3);
  assert.deepEqual(multi.paras.map(p => [headOf(p.header).paraShape, charShapeOf(p.kids), headOf(p.header).last, headOf(p.header).nChars, headOf(p.header).mask]), [[1, 12, false, 2, 0], [4, 13, false, 2, 0], [4, 13, true, 1 + 8 + 1 + 1, 1 << 9]]);
  const empty = cellParas(records, 0, 1);
  assert.equal(empty.nParas, 1);
  assert.deepEqual([headOf(empty.paras[0].header).nChars, headOf(empty.paras[0].header).last, kidTags(empty.paras[0].kids)], [1, true, [TAG.PARA_CHAR_SHAPE, TAG.PARA_LINE_SEG]]);
  const blank = cellParas(records, 2, 1);
  assert.equal(blank.nParas, 2);
  assert.deepEqual(blank.paras.map(p => [headOf(p.header).nChars, headOf(p.header).last]), [[1, false], [1, true]]);
  for (const name of ['FileHeader', 'DocInfo', 'PrvText', 'BinData/BIN0001.png']) assert.deepEqual(readCfb(filled).read(name), readCfb(doc).read(name), name);
  assert.deepEqual(readCfb(filled).names, readCfb(doc).names);
});

test('fillHwp: 빈 줄은 그 자리 문단(스페이서) 서식, 글 있는 줄은 글 있는 문단 서식, 단 나누기는 첫 줄만', () => {
  const paras = [{ text: '제목', paraShape: 7, charShape: 1, brk: 4 }, { text: '', paraShape: 7, charShape: 2 }, { text: '본문', paraShape: 9, charShape: 3 }];
  const data = hwpOf({ sections: [[tablePara([[{ r: 0, c: 0, paras }, { r: 0, c: 1, paras }]])]] });
  const records = recordsOf(fillHwp(data, [{ unit: { kind: 'cell', t: 0, r: 0, c: 0 }, text: '새 제목\n\n새 본문' }, { unit: { kind: 'cell', t: 0, r: 0, c: 1 }, text: 'A\nB' }]));
  const shapes = (r, c) => cellParas(records, r, c).paras.map(p => [headOf(p.header).paraShape, charShapeOf(p.kids), headOf(p.header).brk, headOf(p.header).nChars]);
  assert.deepEqual(shapes(0, 0), [[7, 1, 4, 5], [7, 2, 0, 1], [9, 3, 0, 5]]);
  assert.deepEqual(shapes(0, 1), [[7, 1, 4, 2], [9, 3, 0, 2]]);
});

test('fillHwp: 문단 없는 칸 — 기본 서식(모양·스타일·글자 모양 0)으로 넣고 nParas 를 세운다', () => {
  const data = hwpOf({ sections: [['앞', tablePara([[{ r: 0, c: 0, paras: [] }, { r: 0, c: 1, text: '옆', paraShape: 5 }]])]] });
  assert.equal(cellParas(recordsOf(data), 0, 0).nParas, 0);
  const filled = fillHwp(data, [{ unit: { kind: 'cell', t: 0, r: 0, c: 0 }, text: 'v\nw' }]);
  const { nParas, paras } = cellParas(recordsOf(filled), 0, 0);
  assert.equal(nParas, 2);
  assert.deepEqual(paras.map(p => [headOf(p.header).paraShape, headOf(p.header).style, charShapeOf(p.kids), headOf(p.header).last]), [[0, 0, 0, false], [0, 0, 0, true]]);
  assert.equal(paras[0].kids.at(-1).data.length, 36);
  assert.equal(cellOf(filled, 0, 0).text, 'v\nw');
  assert.equal(cellOf(filled, 0, 1).text, '옆');
});

const bodyDoc = hwpOf({ sections: [[{ text: '□ 제안 개요', style: 1, paraShape: 2 }, { text: '○ 배경 설명임', paraShape: 1, charShape: 5, brk: 3 }, '', tablePara(rowsOf()), '끝']] });

test('fillHwp: 필드 문단 교체·헤딩 뒤 끼우기 — 바꾼 문단은 원 서식, 끼운 문단은 기본 서식, 모두 level 0', () => {
  const filled = fillHwp(bodyDoc, [
    { unit: { kind: 'field', section: 0, p: 1 }, text: 'a\nb' },
    { unit: { kind: 'field', section: 0, p: 0, after: true }, text: '새 본문' },
  ]);
  assert.deepEqual(paraTexts(filled), ['□ 제안 개요', '새 본문', 'a', 'b', '끝']);
  const records = recordsOf(filled);
  const tops = records.filter(r => r.tag === TAG.PARA_HEADER && r.level === 0).map(r => headOf(r.data));
  assert.deepEqual(tops.map(h => [h.paraShape, h.style, h.brk, h.last]), [[2, 1, 0, false], [0, 0, 0, false], [1, 0, 3, false], [1, 0, 0, false], [0, 0, 0, false], [0, 0, 0, false], [0, 0, 0, true]]);
  const kids = records.slice(records.findIndex(r => r.tag === TAG.PARA_HEADER && r.level === 0 && r.data.readUInt16LE(8) === 1) + 1, undefined).slice(0, 3);
  assert.deepEqual(kids.map(k => [k.tag, k.level]), [[TAG.PARA_TEXT, 1], [TAG.PARA_CHAR_SHAPE, 1], [TAG.PARA_LINE_SEG, 1]]);
  assert.equal(kids[1].data.readUInt32LE(4), 5);
  assert.equal(scanHwp(filled).items.length, scanHwp(bodyDoc).items.length + 2);
});

test('fillHwp: 구역의 마지막 문단 뒤에 끼우면 목록의 마지막 표시가 새 마지막 문단으로 옮겨 간다', () => {
  const filled = fillHwp(bodyDoc, [{ unit: { kind: 'field', section: 0, p: 4, after: true }, text: '뒤\n더 뒤' }]);
  assert.deepEqual(paraTexts(filled), ['□ 제안 개요', '○ 배경 설명임', '끝', '뒤', '더 뒤']);
  const tops = recordsOf(filled).filter(r => r.tag === TAG.PARA_HEADER && r.level === 0).map(r => headOf(r.data).last);
  assert.deepEqual(tops, [false, false, false, false, false, false, true]);
  const replaced = fillHwp(bodyDoc, [{ unit: { kind: 'field', section: 0, p: 4 }, text: '마지막\n둘' }]);
  assert.deepEqual(recordsOf(replaced).filter(r => r.tag === TAG.PARA_HEADER && r.level === 0).map(r => headOf(r.data).last), [false, false, false, false, false, true]);
});

test('fillHwp: 없는 문단·표를 품은 문단은 필드가 아니다, 잠긴 문단은 거절·뒤에 끼우기는 허용, 없는 칸, 같은 자리 두 번', () => {
  assert.throws(() => fillHwp(bodyDoc, [{ unit: { kind: 'field', section: 0, p: 99 }, text: 'x' }]), /문단을 찾지 못했습니다: p99/);
  assert.throws(() => fillHwp(bodyDoc, [{ unit: { kind: 'field', section: 1, p: 0 }, text: 'x' }]), /문단을 찾지 못했습니다: p0/);
  assert.throws(() => fillHwp(bodyDoc, [{ unit: { kind: 'field', section: 0, p: 3 }, text: 'x' }]), /문단을 찾지 못했습니다: p3/);
  const sealed = hwpOf({ sections: [[{ text: '머리글', ctrls: ['secd', 'cold'] }, '본문', tablePara(rowsOf())]] });
  assert.throws(() => fillHwp(sealed, [{ unit: { kind: 'field', section: 0, p: 0 }, text: 'x' }]), /잠긴 문단입니다: p0/);
  const after = fillHwp(sealed, [{ unit: { kind: 'field', section: 0, p: 0, after: true }, text: '뒤' }]);
  assert.deepEqual(scanHwp(after).items.slice(0, 3).map(i => [i.text, i.locked ?? null]), [['머리글', '문서 설정'], ['뒤', null], ['본문', null]]);
  assert.throws(() => fillHwp(doc, [{ unit: { kind: 'cell', t: 0, r: 9, c: 0 }, text: 'x' }]), /칸을 찾지 못했습니다: T0 r9 c0/);
  assert.throws(() => fillHwp(doc, [{ unit: { kind: 'cell', t: 3, r: 0, c: 0 }, text: 'x' }]), /칸을 찾지 못했습니다: T3 r0 c0/);
  const twice = { unit: { kind: 'cell', t: 0, r: 1, c: 1 }, text: 'x' };
  assert.throws(() => fillHwp(doc, [twice, twice]), /같은 자리/);
  const again = { unit: { kind: 'field', section: 0, p: 0, after: true }, text: 'x' };
  assert.throws(() => fillHwp(bodyDoc, [again, again]), /같은 자리/);
  assert.throws(() => fillHwp(bodyDoc, [{ unit: { kind: 'field', section: 0, p: 1 }, text: 'x' }, { unit: { kind: 'field', section: 0, p: 1 }, text: 'y' }]), /같은 자리/);
});

test('fillHwp: 둘째 섹션 기입은 둘째 스트림만 바꾼다, 압축하지 않은 문서는 그대로 압축하지 않는다', () => {
  const data = hwpOf({ sections: [sectionItems(), sectionItems()] });
  const filled = fillHwp(data, [{ unit: { kind: 'cell', t: 1, r: 0, c: 1 }, text: '새 값' }]);
  assert.deepEqual(readCfb(filled).read('BodyText/Section0'), readCfb(data).read('BodyText/Section0'));
  assert.notDeepEqual(readCfb(filled).read('BodyText/Section1'), readCfb(data).read('BodyText/Section1'));
  assert.equal(cellOf(filled, 0, 1, 1).text, '새 값');
  assert.equal(cellOf(filled, 0, 1, 0).text, '홍길동');
  const plain = hwpOf({ sections: [sectionItems()], compressed: false });
  const out = fillHwp(plain, [{ unit: { kind: 'cell', t: 0, r: 0, c: 1 }, text: '새 값' }]);
  assert.equal(cellOf(out, 0, 1).text, '새 값');
  assert.doesNotThrow(() => parseRecords(readCfb(out).read('BodyText/Section0')));
});

test('fillHwp: 손대지 않은 레코드는 원 바이트 그대로 — 칸 하나를 바꾸면 그 칸의 레코드만 다르다', () => {
  const same = fillHwp(doc, [{ unit: { kind: 'cell', t: 0, r: 0, c: 0 }, text: '제안자' }]); // 같은 글 → 섹션 스트림까지 같다
  assert.deepEqual(readCfb(same).read('BodyText/Section0'), readCfb(doc).read('BodyText/Section0'));
  const filled = fillHwp(doc, [{ unit: { kind: 'cell', t: 0, r: 0, c: 0 }, text: '제안자!' }]);
  const before = recordsOf(doc), after = recordsOf(filled);
  assert.equal(after.length, before.length);
  const j = before.findIndex(r => isCell(r, 0, 0));
  const differ = before.map((r, i) => (r.data.equals(after[i].data) && r.level === after[i].level && r.tag === after[i].tag ? null : i)).filter(i => i != null);
  assert.deepEqual(differ, [j + 1, j + 2]); // PARA_HEADER(nChars)·PARA_TEXT 만 — 글자 모양·줄 정렬·LIST_HEADER·다른 칸은 같다
});

test('짧은 레코드(STYLE·PARA_SHAPE·PARA_HEADER)는 범위 오류가 아니라 형식 오류 — 올리기가 500 이 아니라 사유를 돌려준다', async () => {
  const zlib = await import('node:zlib');
  const { fileHeader, paraShapeRecord, styleRecord } = await import('./fixtures/hwp_docs.js');
  const pack = buf => zlib.deflateRawSync(buf);
  const goodInfo = Buffer.concat([styleRecord({ name: '바탕글' }), paraShapeRecord()]);
  const cases = [
    ['STYLE 2B', pack(encodeRecord(TAG.STYLE, 0, Buffer.alloc(2))), pack(encodeRecord(TAG.PARA_HEADER, 0, Buffer.alloc(24)))],
    ['PARA_SHAPE 2B', pack(Buffer.concat([styleRecord({ name: '바탕글' }), encodeRecord(TAG.PARA_SHAPE, 0, Buffer.alloc(2))])), pack(encodeRecord(TAG.PARA_HEADER, 0, Buffer.alloc(24)))],
    ['PARA_HEADER 8B', pack(goodInfo), pack(encodeRecord(TAG.PARA_HEADER, 0, Buffer.alloc(8)))],
  ];
  for (const [name, docInfo, section] of cases) {
    const bad = createCfb({ FileHeader: fileHeader(), DocInfo: docInfo, 'BodyText/Section0': section });
    assert.throws(() => scanHwp(bad), err => err.format === true && /손상/.test(err.message), name);
  }
  // 기입 쪽: 10B 문단 머리는 스캔은 지나지만 기입에서 쓰기 범위를 벗어난다 — 역시 형식 오류
  const short = createCfb({ FileHeader: fileHeader(), DocInfo: pack(goodInfo), 'BodyText/Section0': pack(encodeRecord(TAG.PARA_HEADER, 0, Buffer.alloc(10))) });
  assert.throws(() => fillHwp(short, [{ unit: { kind: 'field', section: 0, p: 0, after: true }, text: 'x' }]), err => err.format === true);
  assert.throws(() => fillHwp(doc, [{ unit: { kind: 'cell', t: 0, r: 9, c: 9 }, text: 'x' }]), err => !err.format && /칸을 찾지 못했습니다/.test(err.message)); // 보통 오류는 그대로
});
