// hwp 테스트 붙박이 자료 — createCfb + encodeRecord 로 FileHeader·DocInfo(STYLE·PARA_SHAPE)·BodyText/Section<n> 을 조립한다 (hwp_file·hwp_form·forms 테스트가 같이 쓴다).
// 레코드 배치는 실제 파일에서 확인한 것(references/hwp_format.md): 칸 문단은 LIST_HEADER 와 같은 level, 빈 문단은 PARA_TEXT 없음, 목록의 마지막 문단은 nChars bit31.
import zlib from 'node:zlib';
import { createCfb } from '../../lib/cfb.js';
import { TAG, encodeRecord, encodeText } from '../../lib/hwp_file.js';

const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; };
const wstr = s => Buffer.concat([u16(s.length), Buffer.from(s, 'utf16le')]);
// 제어 글자 코드 — ctrl id 별 (확장형: 뒤에 CTRL_HEADER 레코드가 따른다)
const CODE = { secd: 2, cold: 2, head: 16, foot: 16, 'fn  ': 17, 'en  ': 17, atno: 18, pgnp: 21, pghd: 21, nwno: 21, bokm: 22, 'tbl ': 11, 'gso ': 11 };
const codeOf = id => (id.startsWith('%') ? 3 : CODE[id] ?? 11);
const reversed = id => Buffer.from(id, 'latin1').reverse();

// ── DocInfo

// STYLE: 한글 이름·영문 이름·속성(종류 0 문단)·다음 스타일·언어·문단 모양 id·글자 모양 id
export const styleRecord = ({ name, eng = name, paraShape = 0, charShape = 0 }) => encodeRecord(TAG.STYLE, 0, Buffer.concat([wstr(name), wstr(eng), Buffer.from([0, 0]), u16(0x0412), u16(paraShape), u16(charShape)]));
// PARA_SHAPE 58B: 속성1 bits 23–24 문단 머리 종류(0 없음·1 개요·2 번호·3 글머리표), bits 25–27 수준
export const paraShapeRecord = ({ headType = 0, level = 0 } = {}) => {
  const b = Buffer.alloc(58);
  b.writeUInt32LE((((headType & 3) << 23) | ((level & 7) << 25)) >>> 0, 0);
  return encodeRecord(TAG.PARA_SHAPE, 0, b);
};
const docInfoOf = ({ styles, paraShapes, sections }) => {
  const props = Buffer.alloc(26);
  props.writeUInt16LE(sections, 0);
  return Buffer.concat([encodeRecord(TAG.DOCUMENT_PROPERTIES, 0, props), ...styles.map(styleRecord), ...paraShapes.map(paraShapeRecord)]);
};

export const fileHeader = ({ compressed = true, encrypted = false, distribution = false } = {}) => {
  const b = Buffer.alloc(256);
  b.write('HWP Document File', 0, 'latin1');
  b.writeUInt32LE(0x05010001, 32);
  b.writeUInt32LE((compressed ? 1 : 0) | (encrypted ? 2 : 0) | (distribution ? 4 : 0), 36);
  return b;
};

// ── 본문 레코드

// 확장 제어 글자 16B: 코드 + id(역순) + 8B 0 + 코드
function ctrlChar(id) {
  const b = Buffer.alloc(16);
  b.writeUInt16LE(codeOf(id), 0);
  reversed(id).copy(b, 2);
  b.writeUInt16LE(codeOf(id), 14);
  return b;
}

// 문단 하나: { text, style, paraShape, charShape, brk, ctrls: ['secd', '%bmk', 'gso ' …], tables: [tableSpec], last, instance, lines }
// PARA_HEADER 24B + (글 있으면) PARA_TEXT + PARA_CHAR_SHAPE + PARA_LINE_SEG(36B × lines) + 컨트롤 레코드들(level +1)
export function paraRecords(level, spec) {
  const { text = '', style = 0, paraShape = 0, charShape = 0, brk = 0, ctrls = [], tables = [], last = false, instance = 0, lines = 1 } = typeof spec === 'string' ? { text: spec } : spec;
  const ids = [...ctrls, ...tables.map(() => 'tbl ')];
  const body = Buffer.concat([...ids.map(ctrlChar), encodeText(text)]);
  const nChars = body.length / 2;
  let mask = 0;
  for (const id of ids) mask |= 1 << codeOf(id);
  if (text.includes('\t')) mask |= 1 << 9;
  if (text.includes('\n')) mask |= 1 << 10;
  const h = Buffer.alloc(24);
  h.writeUInt32LE((nChars | (last ? 0x80000000 : 0)) >>> 0, 0);
  h.writeUInt32LE(mask >>> 0, 4);
  h.writeUInt16LE(paraShape, 8);
  h[10] = style;
  h[11] = brk;
  h.writeUInt16LE(1, 12);
  h.writeUInt16LE(0, 14);
  h.writeUInt16LE(lines, 16);
  h.writeUInt32LE(instance, 18);
  const cs = Buffer.alloc(8);
  cs.writeUInt32LE(charShape, 4);
  const ls = Buffer.alloc(36 * lines);
  for (let i = 0; i < lines; i++) { ls.writeUInt32LE(i * 10, i * 36); ls.writeInt32LE(1000, i * 36 + 8); ls.writeInt32LE(900, i * 36 + 12); }
  const out = [encodeRecord(TAG.PARA_HEADER, level, h)];
  if (nChars > 1) out.push(encodeRecord(TAG.PARA_TEXT, level + 1, body));
  out.push(encodeRecord(TAG.PARA_CHAR_SHAPE, level + 1, cs), encodeRecord(TAG.PARA_LINE_SEG, level + 1, ls));
  for (const id of ctrls) out.push(ctrlRecord(level + 1, id));
  for (const tbl of tables) out.push(...tableRecords(level + 1, tbl));
  return out;
}

// 표 아닌 컨트롤: CTRL_HEADER(id 역순 + 더미) — 'gso ' 는 글상자처럼 LIST_HEADER(30B) 와 문단 하나를 거느린다
function ctrlRecord(level, id) {
  const rec = encodeRecord(TAG.CTRL_HEADER, level, Buffer.concat([reversed(id), Buffer.alloc(id === 'gso ' ? 42 : 8)]));
  if (id !== 'gso ') return rec;
  const list = Buffer.alloc(30);
  list.writeInt16LE(1, 0);
  return Buffer.concat([rec, encodeRecord(TAG.LIST_HEADER, level + 1, list), ...paraRecords(level + 1, { text: '글상자 글', last: true })]);
}

// 칸: { r, c, colspan, rowspan, w, h, text | paras: [paraSpec|string] } — paras 가 비면 문단 없는 칸(nParas 0). 마지막 문단에 bit31
export function cellRecords(level, { r, c, colspan = 1, rowspan = 1, w = 8504, h = 282, text = '', paras = null }) {
  const specs = (paras ?? [{ text }]).map(p => (typeof p === 'string' ? { text: p } : p));
  const list = Buffer.alloc(47);
  list.writeInt16LE(specs.length, 0);
  list.writeUInt32LE(0x10020, 4);
  list.writeUInt16LE(c, 8);
  list.writeUInt16LE(r, 10);
  list.writeUInt16LE(colspan, 12);
  list.writeUInt16LE(rowspan, 14);
  list.writeUInt32LE(w, 16);
  list.writeUInt32LE(h, 20);
  list.writeUInt16LE(3, 32);
  list.writeUInt32LE(w, 34);
  return [encodeRecord(TAG.LIST_HEADER, level, list), ...specs.flatMap((p, i) => paraRecords(level, { ...p, last: i === specs.length - 1 }))];
}

// 표: { rows: [[cellSpec]], cols } → CTRL_HEADER 'tbl '(46B) + TABLE(level +1) + 칸들(level +1)
export function tableRecords(level, { rows, cols }) {
  const ctrl = Buffer.alloc(46);
  reversed('tbl ').copy(ctrl, 0);
  const ncols = cols ?? Math.max(0, ...rows.flat().map(x => x.c + (x.colspan ?? 1)));
  const tbl = Buffer.alloc(18 + rows.length * 2 + 4);
  tbl.writeUInt16LE(rows.length, 4);
  tbl.writeUInt16LE(ncols, 6);
  rows.forEach((row, i) => tbl.writeUInt16LE(row.length, 18 + i * 2));
  return [encodeRecord(TAG.CTRL_HEADER, level, ctrl), encodeRecord(TAG.TABLE, level + 1, tbl), ...rows.flat().flatMap(cell => cellRecords(level + 1, cell))];
}

// 섹션: 항목(문단 spec | 글 | tablePara) 들 — 마지막 최상위 문단에 bit31
export const sectionOf = items => Buffer.concat(items.flatMap((item, i) => paraRecords(0, { ...(typeof item === "string" ? { text: item } : item), last: i === items.length - 1 })));
export const tablePara = (rows, more = {}) => ({ text: '', tables: [{ rows }], ...more });

// ── 파일

export const DEFAULT_STYLES = [{ name: '바탕글', eng: 'Normal' }, { name: '본문', eng: 'Body' }, { name: '개요 1', eng: 'Outline 1', paraShape: 2 }, { name: '표내용', eng: 'Table Text' }];
export const DEFAULT_SHAPES = [{}, { headType: 3, level: 1 }, { headType: 1, level: 0 }, { headType: 1, level: 1 }, { headType: 2, level: 2 }, { headType: 1, level: 3 }];

// { styles, paraShapes, sections: [[items]], compressed, encrypted, distribution, extra: { 스트림: Buffer } } → hwp 파일 Buffer
export function hwpOf({ styles = DEFAULT_STYLES, paraShapes = DEFAULT_SHAPES, sections = [], compressed = true, encrypted = false, distribution = false, extra = {} } = {}) {
  const pack = buf => (compressed ? zlib.deflateRawSync(buf) : buf);
  return createCfb({
    FileHeader: fileHeader({ compressed, encrypted, distribution }),
    DocInfo: pack(docInfoOf({ styles, paraShapes, sections: sections.length })),
    ...Object.fromEntries(sections.map((items, n) => [`BodyText/Section${n}`, pack(sectionOf(items))])),
    PrvText: Buffer.from('미리보기', 'utf16le'),
    'BinData/BIN0001.png': Buffer.alloc(5000, 7),
    ...extra,
  });
}

// 2열 표(칸 5개): 폭 3000/7000, 행0 높이 282, 행1 c0 rowSpan 2, 행1 c1 문단 둘(서식 다름), 행2 c1 빈 칸 — hwpxRows 와 같은 모양
export const hwpRows = () => [
  [{ r: 0, c: 0, text: '제안자', w: 3000 }, { r: 0, c: 1, text: '홍길동', w: 7000 }],
  [{ r: 1, c: 0, text: '기관', rowspan: 2, w: 3000, h: 782 }, { r: 1, c: 1, w: 7000, h: 500, paras: [{ text: '한국선급', paraShape: 1, charShape: 12 }, { text: '연구소', paraShape: 4, charShape: 13 }] }],
  [{ r: 2, c: 1, text: '', w: 7000 }],
];
// 필드 「신상 조서」 + 2열 표
export const sectionItems = (rows = hwpRows()) => ['신상 조서', tablePara(rows)];
