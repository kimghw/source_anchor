// 보관한 PDF 원본에 형광(Highlight) 주석을 덧붙인다 (FR-PL-012). 원본 바이트는 그대로 두고 뒤에 증분 갱신(incremental update)만 붙인다 —
// 원본이 xref 표를 쓰면 xref 표로, xref 스트림을 쓰면 xref 스트림으로 이어 쓴다(PDFium 은 두 방식이 섞인 사슬을 읽지 못한다).
// 객체 스트림(/ObjStm) 안의 페이지 객체는 풀어 읽고, 고친 페이지 객체는 평문으로 다시 낸다. 파일 구조는 references/pdf_format.md
import zlib from 'node:zlib';

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);
const isWs = ch => WS.has(ch.charCodeAt(0));
const isRegular = ch => !isWs(ch) && !DELIM.has(ch);

// ───────────────────────────── 객체 읽기 ─────────────────────────────

function skipWs(s, i) {
  while (i < s.length) {
    const ch = s[i];
    if (isWs(ch)) i++;
    else if (ch === '%') { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; }
    else break;
  }
  return i;
}

// 값 하나 → { value, end }. 사전은 { dict: Map }, 이름은 { name }, 문자열은 원문 그대로 { str }, 참조는 { ref: [번호, 세대] }, 키워드는 { kw }
function parseValue(s, i) {
  i = skipWs(s, i);
  if (i >= s.length) throw new Error('PDF 객체가 끝났습니다');
  const ch = s[i];
  if (ch === '<') {
    if (s[i + 1] === '<') return parseDict(s, i + 2);
    const end = s.indexOf('>', i + 1);
    if (end < 0) throw new Error('16진 문자열이 닫히지 않았습니다');
    return { value: { str: s.slice(i, end + 1) }, end: end + 1 };
  }
  if (ch === '(') return parseLiteral(s, i);
  if (ch === '[') {
    const items = [];
    let p = i + 1;
    for (;;) {
      p = skipWs(s, p);
      if (p >= s.length) throw new Error('배열이 닫히지 않았습니다');
      if (s[p] === ']') return { value: items, end: p + 1 };
      const r = parseValue(s, p);
      items.push(r.value);
      p = r.end;
    }
  }
  if (ch === '/') {
    let p = i + 1;
    while (p < s.length && isRegular(s[p])) p++;
    return { value: { name: s.slice(i + 1, p) }, end: p };
  }
  if (DELIM.has(ch)) throw new Error(`뜻밖의 글자 ${ch}`);
  let p = i;
  while (p < s.length && isRegular(s[p])) p++;
  const tok = s.slice(i, p);
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
    if (/^\d+$/.test(tok)) {
      const m = /^[\s\0]+(\d+)[\s\0]+R(?=[\s\0()<>[\]{}/%]|$)/.exec(s.slice(p, p + 40));
      if (m) return { value: { ref: [Number(tok), Number(m[1])] }, end: p + m[0].length };
    }
    return { value: Number(tok), end: p };
  }
  if (tok === 'true') return { value: true, end: p };
  if (tok === 'false') return { value: false, end: p };
  if (tok === 'null') return { value: null, end: p };
  if (!tok) throw new Error('빈 토큰');
  return { value: { kw: tok }, end: p };
}

function parseDict(s, i) {
  const dict = new Map();
  let p = i;
  for (;;) {
    p = skipWs(s, p);
    if (s.startsWith('>>', p)) return { value: { dict }, end: p + 2 };
    if (s[p] !== '/') throw new Error('사전의 키가 이름이 아닙니다');
    const key = parseValue(s, p);
    const val = parseValue(s, key.end);
    dict.set(key.value.name, val.value);
    p = val.end;
  }
}

function parseLiteral(s, i) {
  let depth = 0;
  for (let p = i; p < s.length; p++) {
    const ch = s[p];
    if (ch === '\\') { p++; continue; }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return { value: { str: s.slice(i, p + 1) }, end: p + 1 };
  }
  throw new Error('문자열이 닫히지 않았습니다');
}

// "N G obj" 뒤의 본체 — 값, (있으면) 스트림 자리, endobj 까지의 끝
function parseObjectBody(s, i) {
  const r = parseValue(s, i);
  let p = skipWs(s, r.end);
  let stream = null;
  if (s.startsWith('stream', p)) {
    p += 6;
    if (s[p] === '\r') p++;
    if (s[p] === '\n') p++;
    const len = r.value?.dict?.get('Length');
    const direct = typeof len === 'number';
    const es = s.indexOf('endstream', direct ? p + len : p);
    if (es < 0) throw new Error('endstream 이 없습니다');
    stream = { start: p, end: direct ? p + len : es, lengthRef: direct ? null : len };
    p = es + 9;
  }
  p = skipWs(s, p);
  if (s.startsWith('endobj', p)) p += 6;
  return { value: r.value, stream, end: p };
}

// 파일 전체에서 "N G obj" 를 훑어 객체를 모은다. 같은 번호가 여럿이면 뒤에 있는 것(증분 갱신)이 이긴다.
function indexObjects(s) {
  const objs = new Map();
  const put = (num, entry) => { const cur = objs.get(num); if (!cur || entry.pos >= cur.pos) objs.set(num, entry); };
  const re = /(\d+)[\s\0]+(\d+)[\s\0]+obj(?=[\s\0<[(/%]|$)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > 0 && isRegular(s[m.index - 1])) continue;
    try {
      const body = parseObjectBody(s, m.index + m[0].length);
      put(Number(m[1]), { num: Number(m[1]), gen: Number(m[2]), value: body.value, stream: body.stream, pos: m.index });
      if (body.end > re.lastIndex) re.lastIndex = body.end; // 스트림 안쪽은 훑지 않는다
    } catch { /* 스트림 안의 우연한 일치 — 건너뛴다 */ }
  }
  return { objs, put };
}

const resolver = objs => v => (v?.ref ? objs.get(v.ref[0])?.value : v);

// 스트림 데이터를 꺼내 FlateDecode(+PNG 예측)까지 푼다. 다른 필터는 null
function decodedStream(buf, obj, resolve) {
  const dict = obj.value.dict;
  let end = obj.stream.end;
  const len = obj.stream.lengthRef ? resolve(obj.stream.lengthRef) : null;
  if (typeof len === 'number') end = obj.stream.start + len;
  let data = buf.subarray(obj.stream.start, end);
  const filters = [resolve(dict.get('Filter'))].flat().filter(Boolean).map(f => resolve(f)?.name);
  const parms = [resolve(dict.get('DecodeParms'))].flat();
  if (!filters.length) return data;
  if (filters.some(f => f !== 'FlateDecode')) return null;
  try { data = zlib.inflateSync(data); } catch { try { data = zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { return null; } }
  const p = resolve(parms[0])?.dict;
  return p ? unpredict(data, p, resolve) : data;
}

function unpredict(data, parms, resolve) {
  const pred = resolve(parms.get('Predictor')) ?? 1;
  if (pred < 10) return data;
  const columns = resolve(parms.get('Columns')) ?? 1;
  const colors = resolve(parms.get('Colors')) ?? 1;
  const bpc = resolve(parms.get('BitsPerComponent')) ?? 8;
  const bpp = Math.ceil((colors * bpc) / 8);
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = Buffer.alloc(rows * rowLen);
  let prev = Buffer.alloc(rowLen);
  for (let r = 0; r < rows; r++) {
    const ft = data[r * (rowLen + 1)];
    const row = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const cur = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let x = row[i];
      if (ft === 1) x += a;
      else if (ft === 2) x += b;
      else if (ft === 3) x += (a + b) >> 1;
      else if (ft === 4) { const pp = a + b - c; const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); x += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = x & 255;
    }
    prev = cur;
  }
  return out;
}

// 객체 스트림(/ObjStm) 안의 객체들을 풀어 색인에 넣는다
function expandObjectStreams(buf, s, objs, put) {
  const resolve = resolver(objs);
  for (const obj of [...objs.values()]) {
    if (!obj.stream || resolve(obj.value?.dict?.get('Type'))?.name !== 'ObjStm') continue;
    const data = decodedStream(buf, obj, resolve);
    if (!data) continue;
    const text = data.toString('latin1');
    const n = resolve(obj.value.dict.get('N'));
    const first = resolve(obj.value.dict.get('First'));
    if (!Number.isInteger(n) || !Number.isInteger(first)) continue;
    const header = text.slice(0, first).trim().split(/[\s\0]+/).map(Number);
    for (let k = 0; k < n; k++) {
      const num = header[2 * k];
      const off = header[2 * k + 1];
      if (!Number.isInteger(num) || !Number.isInteger(off)) break;
      try { put(num, { num, gen: 0, value: parseValue(text, first + off).value, stream: null, pos: obj.pos }); } catch { /* 깨진 항목은 건너뛴다 */ }
    }
  }
}

// startxref 가 가리키는 마지막 xref 절과 그 트레일러(Root·Info·ID). /Prev 사슬을 따라 빠진 항목을 채운다
function readTrailer(s, objs) {
  const at = s.lastIndexOf('startxref');
  const offset = at >= 0 ? Number(/startxref[\s\0]+(\d+)/.exec(s.slice(at))?.[1]) : NaN;
  const info = { prev: Number.isFinite(offset) ? offset : null, classic: true, root: null, infoRef: null, id: null };
  const seen = new Set();
  let pos = info.prev;
  for (let hops = 0; pos != null && !seen.has(pos) && hops < 16; hops++) {
    seen.add(pos);
    let dict = null;
    const p = skipWs(s, pos);
    const stream = !s.startsWith('xref', p);
    try {
      if (!stream) { const t = s.indexOf('trailer', p); dict = t < 0 ? null : parseValue(s, t + 7).value?.dict ?? null; }
      else { const o = s.indexOf('obj', p); dict = o < 0 ? null : parseObjectBody(s, o + 3).value?.dict ?? null; }
    } catch { dict = null; }
    if (hops === 0) info.classic = !stream;
    if (!dict) break;
    info.root ??= dict.get('Root') ?? null;
    info.infoRef ??= dict.get('Info') ?? null;
    info.id ??= dict.get('ID') ?? null;
    pos = typeof dict.get('XRefStm') === 'number' && !seen.has(dict.get('XRefStm')) ? dict.get('XRefStm') : typeof dict.get('Prev') === 'number' ? dict.get('Prev') : null;
  }
  return info;
}

// 페이지 나무를 걸어 페이지 객체를 순서대로 모은다. 상자·회전은 부모에게서 물려받는다
function listPages(objs, rootRef) {
  const resolve = resolver(objs);
  const catalog = resolve(rootRef)?.dict;
  const out = [];
  const walk = (ref, inherited, depth) => {
    if (depth > 64 || !ref?.ref) return;
    const obj = objs.get(ref.ref[0]);
    const dict = obj?.value?.dict;
    if (!dict) return;
    const inh = { ...inherited };
    for (const k of ['MediaBox', 'CropBox', 'Rotate']) if (dict.has(k)) inh[k] = resolve(dict.get(k));
    const type = resolve(dict.get('Type'))?.name;
    if (type === 'Pages' || (type !== 'Page' && dict.has('Kids'))) { for (const kid of resolve(dict.get('Kids')) || []) walk(kid, inh, depth + 1); return; }
    const box = (inh.CropBox || inh.MediaBox || [0, 0, 612, 792]).map(v => resolve(v));
    out.push({ num: obj.num, gen: obj.gen, dict, box, rotate: Number(inh.Rotate) || 0 });
  };
  walk(catalog?.get('Pages'), {}, 0);
  return out;
}

// ───────────────────────────── 쓰기 ─────────────────────────────

const num = v => (Number.isInteger(v) ? String(v) : Number(v).toFixed(2).replace(/\.?0+$/, ''));

function ser(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return num(v);
  if (Array.isArray(v)) return `[${v.map(ser).join(' ')}]`;
  if (v.ref) return `${v.ref[0]} ${v.ref[1]} R`;
  if (v.name !== undefined) return `/${v.name}`;
  if (v.str !== undefined) return v.str;
  if (v.dict) return `<<${[...v.dict].map(([k, val]) => `/${k} ${ser(val)}`).join(' ')}>>`;
  if (v.kw) return v.kw;
  throw new Error('쓸 수 없는 값');
}

// 한글이 들어가도 되게 UTF-16BE(BOM) 16진 문자열로 쓴다
export const pdfText = text => `<FEFF${Buffer.from(String(text ?? ''), 'utf16le').swap16().toString('hex').toUpperCase()}>`;

const pdfDate = d => `D:${d.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;

// 형광 주석 — quads 는 PDF 좌표(왼쪽 아래 원점)의 [x1 y1 x2 y2] 사각형들(줄마다 하나)
function highlightBody(a, page, nm, now) {
  const quads = a.quads.map(([x1, y1, x2, y2]) => [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]);
  const rect = [Math.min(...quads.map(q => q[0])), Math.min(...quads.map(q => q[1])), Math.max(...quads.map(q => q[2])), Math.max(...quads.map(q => q[3]))];
  const qp = quads.flatMap(([l, b, r, t]) => [l, t, r, t, l, b, r, b]); // 왼쪽 위 · 오른쪽 위 · 왼쪽 아래 · 오른쪽 아래
  const color = (a.color || [1, 0.92, 0.23]).map(num).join(' ');
  return `<< /Type /Annot /Subtype /Highlight /Rect [${rect.map(num).join(' ')}] /QuadPoints [${qp.map(num).join(' ')}] /C [${color}] /CA 1 /F 4 /P ${page.num} ${page.gen} R /NM (${nm}) /T ${pdfText(a.title || 'SourceAnchor')} /Contents ${pdfText(a.contents || '')} /M (${pdfDate(now)}) >>`;
}

// 원본 PDF 를 읽어 페이지 상자와 회전을 돌려준다 (좌표 변환은 부르는 쪽이 한다)
export function pdfPages(buffer) {
  const s = buffer.toString('latin1');
  const { objs, put } = indexObjects(s);
  expandObjectStreams(buffer, s, objs, put);
  const trailer = readTrailer(s, objs);
  const resolve = resolver(objs);
  let rootRef = trailer.root?.ref ? trailer.root : null;
  if (!rootRef) {
    const cat = [...objs.values()].find(o => resolve(o.value?.dict?.get('Type'))?.name === 'Catalog');
    if (!cat) throw new Error('PDF 카탈로그를 찾지 못했습니다');
    rootRef = { ref: [cat.num, cat.gen] };
  }
  const pages = listPages(objs, rootRef);
  if (!pages.length) throw new Error('PDF 페이지를 찾지 못했습니다');
  return { pages, objs, trailer, rootRef, resolve, buffer };
}

// annots: [{ page(1부터), quads: [[x1, y1, x2, y2] …] (PDF 좌표) 또는 페이지({ box, rotate })를 받아 사각형을 돌려주는 함수, color?, title?, contents? }]
// → 주석을 덧붙인 PDF. 표시할 사각형이 하나도 없으면 원본을 그대로 돌려준다
export function annotatePdf(buffer, annots, { now = new Date() } = {}) {
  const { pages, objs, trailer, rootRef, resolve } = pdfPages(buffer);
  let nextNum = Math.max(...objs.keys()) + 1;
  const byPage = new Map();
  for (const a of annots) {
    const page = pages[a.page - 1];
    if (!page) continue;
    const quads = typeof a.quads === 'function' ? a.quads(page) : a.quads;
    if (!quads?.length) continue;
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push({ ...a, quads });
  }
  const newObjs = [];
  for (const [page, list] of byPage) {
    const refs = [];
    for (const a of list) {
      const n = nextNum++;
      refs.push({ ref: [n, 0] });
      newObjs.push({ num: n, gen: 0, body: highlightBody(a, page, `sa-${n}`, now) });
    }
    const dict = new Map(page.dict);
    const old = resolve(dict.get('Annots'));
    dict.set('Annots', [...(Array.isArray(old) ? old : []), ...refs]);
    newObjs.push({ num: page.num, gen: page.gen, body: ser({ dict }) });
  }
  if (!newObjs.length) return buffer;

  const s = buffer.toString('latin1');
  let out = /[\r\n]$/.test(s) ? '' : '\n';
  const base = buffer.length;
  const offsets = new Map();
  for (const o of newObjs) {
    offsets.set(o.num, base + out.length);
    out += `${o.num} ${o.gen} obj\n${o.body}\nendobj\n`;
  }
  const trailerEntries = [`/Root ${ser(rootRef)}`, trailer.infoRef && `/Info ${ser(trailer.infoRef)}`, trailer.id && `/ID ${ser(trailer.id)}`, trailer.prev != null && `/Prev ${trailer.prev}`].filter(Boolean).join(' ');
  const entries = newObjs.map(o => ({ num: o.num, gen: o.gen, off: offsets.get(o.num) }));
  const startxref = base + out.length;
  if (trailer.classic) {
    entries.sort((a, b) => a.num - b.num);
    out += 'xref\n';
    for (const run of runs(entries)) {
      out += `${run[0].num} ${run.length}\n`;
      for (const e of run) out += `${String(e.off).padStart(10, '0')} ${String(e.gen).padStart(5, '0')} n \n`;
    }
    out += `trailer\n<< /Size ${nextNum} ${trailerEntries} >>\nstartxref\n${startxref}\n%%EOF\n`;
  } else {
    const xnum = nextNum++;
    entries.push({ num: xnum, gen: 0, off: startxref });
    entries.sort((a, b) => a.num - b.num);
    const data = Buffer.alloc(entries.length * 7);
    entries.forEach((e, k) => { data[k * 7] = 1; data.writeUInt32BE(e.off, k * 7 + 1); data.writeUInt16BE(e.gen, k * 7 + 5); });
    const index = runs(entries).flatMap(run => [run[0].num, run.length]);
    out += `${xnum} 0 obj\n<< /Type /XRef /Size ${nextNum} /W [1 4 2] /Index [${index.join(' ')}] ${trailerEntries} /Length ${data.length} >>\nstream\n${data.toString('latin1')}\nendstream\nendobj\n`;
    out += `startxref\n${startxref}\n%%EOF\n`;
  }
  return Buffer.concat([buffer, Buffer.from(out, 'latin1')]);
}

// 번호가 이어지는 묶음으로 나눈다 (xref 절·Index 용)
function runs(entries) {
  const out = [];
  for (const e of entries) {
    const last = out.at(-1);
    if (last && last.at(-1).num + 1 === e.num) last.push(e);
    else out.push([e]);
  }
  return out;
}
