// 한글 5.0 바이너리(hwp) 컨테이너·레코드·글자 코덱 — OLE 복합 문서(lib/cfb.js) 안의 FileHeader·DocInfo·BodyText/Section<n> 스트림을 풀어 레코드로 나누고,
// 문단 글(PARA_TEXT)을 읽고 쓴다. 섹션 스트림을 다시 잇는 쪽(lib/hwp_form.js)이 손대지 않은 레코드를 원 바이트 그대로 둘 수 있게 레코드마다 start·end 를 남긴다 (FR-WB-090, FR-WB-092).
// 형식: references/hwp_format.md
import zlib from 'node:zlib';
import { readCfb } from './cfb.js';

export const TAG = {
  DOCUMENT_PROPERTIES: 0x10, PARA_SHAPE: 0x19, STYLE: 0x1A,
  PARA_HEADER: 0x42, PARA_TEXT: 0x43, PARA_CHAR_SHAPE: 0x44, PARA_LINE_SEG: 0x45, PARA_RANGE_TAG: 0x46, CTRL_HEADER: 0x47, LIST_HEADER: 0x48, TABLE: 0x4D,
};
const CFB_SIGNATURE = Buffer.from('d0cf11e0a1b11ae1', 'hex');
const SIGNATURE = 'HWP Document File';
const SECTION = /^BodyText\/Section(\d+)$/;
const SIZE_EXTENDED = 0xFFF; // 레코드 헤더의 크기 칸이 이 값이면 다음 DWORD 가 실제 크기
// 제어 글자(코드 < 32): 확장형(뒤에 CTRL_HEADER 레코드가 따르고 정보 앞 4B 가 ctrl id)·인라인형은 8 유닛(16B) — 코드 2B + 12B 정보 + 코드 2B. 나머지(0·10·13·24~31)는 1 유닛
const EXTENDED = new Set([1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23]);
const INLINE = new Set([4, 5, 6, 7, 8, 9, 19, 20]);
const TAB = 9, LINE_BREAK = 10, PARA_END = 13;

const fail = message => Object.assign(new Error(message), { format: true });

// 짧은 레코드(이름 길이가 데이터를 넘는 STYLE, 4B 미만 PARA_SHAPE, 22B 미만 PARA_HEADER …)는 범위를 벗어난 읽기·쓰기(RangeError)로 드러난다 — 형식 오류로 바꿔 던진다.
// RangeError 만 바꾼다: 기입이 던지는 '칸을 찾지 못했습니다' 같은 보통 오류는 그대로 올라가야 한다
export const guard = fn => {
  try {
    return fn();
  } catch (err) {
    if (err instanceof RangeError) throw fail('한글 문서 레코드가 손상되었습니다');
    throw err;
  }
};

// ── 레코드

// 스트림(압축을 푼 것) → [{ tag, level, data, start, end }] — start·end 는 buf 안의 레코드 전체 바이트 범위(헤더 포함). 경계가 맞지 않으면 형식 오류
export function parseRecords(buf) {
  const out = [];
  let o = 0;
  while (o + 4 <= buf.length) {
    const start = o;
    const head = buf.readUInt32LE(o);
    const tag = head & 0x3FF, level = (head >>> 10) & 0x3FF;
    let size = head >>> 20;
    o += 4;
    if (size === SIZE_EXTENDED) {
      if (o + 4 > buf.length) throw fail('한글 문서 레코드가 손상되었습니다');
      size = buf.readUInt32LE(o);
      o += 4;
    }
    if (o + size > buf.length) throw fail('한글 문서 레코드가 손상되었습니다');
    out.push({ tag, level, data: buf.subarray(o, o + size), start, end: o + size });
    o += size;
  }
  if (o !== buf.length) throw fail('한글 문서 레코드가 손상되었습니다');
  return out;
}

// → 헤더 DWORD(+ 확장 크기) + data
export function encodeRecord(tag, level, data) {
  const body = Buffer.from(data);
  const extended = body.length >= SIZE_EXTENDED;
  const head = Buffer.alloc(extended ? 8 : 4);
  head.writeUInt32LE(((tag & 0x3FF) | (level & 0x3FF) << 10 | (extended ? SIZE_EXTENDED : body.length) << 20) >>> 0, 0);
  if (extended) head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

// CTRL_HEADER 의 id(또는 확장 제어 글자의 정보 앞 4B) — 바이트 역순으로 적혀 있다(' lbt' → 'tbl ')
export const ctrlId = (buf, at = 0) => Buffer.from(buf.subarray(at, at + 4)).reverse().toString('latin1');

// ── 글자 코덱

// PARA_TEXT → { text, ctrls: [{ code, id }] } — 탭(9) → '\t', 줄 바꿈(10) → '\n', 문단 끝(13)·그 밖 제어는 뺀다. ctrls 는 확장형 제어(CTRL_HEADER 가 따르는 것)만
export function decodeText(buf) {
  let text = '';
  const ctrls = [];
  let run = 0; // 보통 글자 구간의 시작
  for (let i = 0; i + 2 <= buf.length;) {
    const code = buf.readUInt16LE(i);
    if (code >= 32) { i += 2; continue; }
    if (i > run) text += buf.toString('utf16le', run, i);
    if (EXTENDED.has(code) || INLINE.has(code)) {
      if (EXTENDED.has(code)) ctrls.push({ code, id: ctrlId(buf, i + 2) });
      if (code === TAB) text += '\t';
      i += 16;
    } else {
      if (code === LINE_BREAK) text += '\n';
      i += 2;
    }
    run = i;
  }
  if (buf.length - run >= 2) text += buf.toString('utf16le', run, buf.length - (buf.length - run) % 2);
  return { text, ctrls };
}

// 글 → PARA_TEXT 바이트(UTF-16LE): '\t' 는 인라인 탭 제어(코드 9 + 12B 0 + 코드 9), '\n' 은 코드 10, 끝에 문단 끝(0x000D). 그 밖 제어 글자는 뺀다
export function encodeText(text) {
  const parts = [];
  let run = '';
  const flush = () => { if (run) parts.push(Buffer.from(run, 'utf16le')); run = ''; };
  for (const ch of String(text)) {
    const code = ch.charCodeAt(0);
    if (code >= 32) { run += ch; continue; }
    flush();
    if (code === TAB) { const tab = Buffer.alloc(16); tab.writeUInt16LE(TAB, 0); tab.writeUInt16LE(TAB, 14); parts.push(tab); }
    if (code === LINE_BREAK) { const br = Buffer.alloc(2); br.writeUInt16LE(LINE_BREAK, 0); parts.push(br); }
  }
  flush();
  const end = Buffer.alloc(2);
  end.writeUInt16LE(PARA_END, 0);
  parts.push(end);
  return Buffer.concat(parts);
}

// 문단 헤더의 제어 마스크: 문단에 든 제어 글자(문단 끝 13 제외)마다 비트 — 실제 파일이 그렇게 적는다
export function ctrlMaskOf(buf) {
  let mask = 0;
  for (let i = 0; i + 2 <= buf.length;) {
    const code = buf.readUInt16LE(i);
    if (code >= 32) { i += 2; continue; }
    if (code !== PARA_END) mask |= 1 << code;
    i += EXTENDED.has(code) || INLINE.has(code) ? 16 : 2;
  }
  return mask >>> 0;
}

// ── 문서 정보

const wstr = (buf, o) => { const n = buf.readUInt16LE(o); return [buf.toString('utf16le', o + 2, o + 2 + n * 2), o + 2 + n * 2]; };

// STYLE → [{ name, eng, paraShape, charShape }] (id 순)
export function docStyles(docInfo) {
  return guard(() => docInfo.filter(r => r.tag === TAG.STYLE).map(({ data }) => {
    const [name, o1] = wstr(data, 0);
    const [eng, o2] = wstr(data, o1);
    return { name, eng, paraShape: data.readUInt16LE(o2 + 4), charShape: data.readUInt16LE(o2 + 6) };
  }));
}

// PARA_SHAPE → [{ headType (0 없음·1 개요·2 번호·3 글머리표), level (0~6) }] (id 순) — 속성1 bits 23–24·25–27
export function docParaShapes(docInfo) {
  return guard(() => docInfo.filter(r => r.tag === TAG.PARA_SHAPE).map(({ data }) => {
    const attr = data.readUInt32LE(0);
    return { headType: (attr >>> 23) & 3, level: (attr >>> 25) & 7 };
  }));
}

// ── 컨테이너

// OLE 서명 + FileHeader 서명 — 형식 판별용(lib/forms.js detectFormat). 읽지 못하는 파일은 false
export function isHwp(data) {
  if (!Buffer.isBuffer(data) || !data.subarray(0, 8).equals(CFB_SIGNATURE)) return false;
  try {
    return readCfb(data).read('FileHeader')?.toString('latin1', 0, SIGNATURE.length) === SIGNATURE;
  } catch (err) {
    if (err.format) return false;
    throw err;
  }
}

function inflate(raw, name) {
  try {
    return zlib.inflateRawSync(raw);
  } catch {
    throw fail(`한글 문서의 ${name} 스트림을 풀지 못했습니다`);
  }
}

// → { header: { version, compressed, encrypted, distribution }, docInfo: Record[], sections: [{ name, n, buf, records }], cfb }
// 암호·배포용 문서는 읽을 수 없다. buf 는 압축을 푼 섹션 스트림(레코드의 start·end 기준)
export function openHwp(data) {
  const cfb = readCfb(data);
  const fh = cfb.read('FileHeader');
  if (!fh || fh.length < 40 || fh.toString('latin1', 0, SIGNATURE.length) !== SIGNATURE) throw fail('한글 문서(hwp)가 아닙니다 — FileHeader 가 없습니다');
  const v = fh.readUInt32LE(32), attr = fh.readUInt32LE(36);
  const header = { version: [v >>> 24, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF].join('.'), compressed: !!(attr & 1), encrypted: !!(attr & 2), distribution: !!(attr & 4) };
  if (header.encrypted) throw fail('암호가 걸린 한글 문서는 올릴 수 없습니다');
  if (header.distribution) throw fail('배포용 한글 문서는 올릴 수 없습니다');
  const unpack = name => (header.compressed ? inflate(cfb.read(name), name) : cfb.read(name));
  const docInfo = cfb.has('DocInfo') ? parseRecords(unpack('DocInfo')) : [];
  const sections = cfb.names.flatMap(name => { const m = SECTION.exec(name); return m ? [Number(m[1])] : []; }).sort((a, b) => a - b).map(n => {
    const name = `BodyText/Section${n}`;
    const buf = unpack(name);
    return { name, n, buf, records: parseRecords(buf) };
  });
  if (!sections.length) throw fail('한글 문서(hwp)가 아닙니다 — BodyText/Section 이 없습니다');
  return { header, docInfo, sections, cfb };
}
