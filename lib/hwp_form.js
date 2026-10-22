// 한글 양식(hwp, 5.0 바이너리)의 섹션별 최상위 문단·표를 문서 순서대로 읽고(scanHwp), 칸·문단에 값을 써 넣는다(fillHwp) — BodyText/Section<n> 스트림의 레코드 열을 구간 절개로만 고친다.
// items·fills 계약과 번호(section·p·t·r·c)는 hwpx_form.js 와 같고, 스캔과 기입이 같은 구간 함수로 센다. 손대지 않은 레코드·스트림은 바이트 그대로 둔다. 형식: references/hwp_format.md
import zlib from 'node:zlib';
import { writeCfb } from './cfb.js';
import { TAG, ctrlId, ctrlMaskOf, decodeText, docParaShapes, docStyles, encodeRecord, encodeText, guard, openHwp } from './hwp_file.js';

const TABLE_ID = 'tbl ';
// 문서 설정: 구역·단·머리말·꼬리말·각주·미주·쪽 번호·감추기·새 번호 컨트롤 — 문단을 바꾸면 사라진다(자동 번호·책갈피·필드는 아니다). hwpx 의 secPr·colPr·header·footer·footNote·endNote·pageNum·pageHiding·newNum 과 대응
const SETTINGS = new Set(['secd', 'cold', 'head', 'foot', 'fn  ', 'en  ', 'pgnp', 'pghd', 'nwno']);
const LAST_IN_LIST = 0x80000000; // PARA_HEADER nChars 의 bit31 — 목록(칸·구역)의 마지막 문단
const CELL_HEADER = 36; // 표 칸 LIST_HEADER 의 최소 길이(실제 47B) — 캡션 등 짧은 목록 머리는 칸이 아니다
const LINE_SEG = 36;

// ── 구간 — 스캔과 기입이 같이 쓴다. 자리는 레코드 index 다.

const nth = (list, i) => (Number.isInteger(i) ? list[i] : undefined);
const idOf = r => (r.tag === TAG.CTRL_HEADER && r.data.length >= 4 ? ctrlId(r.data) : null);
const lastFlag = header => !!(header.readUInt32LE(0) & LAST_IN_LIST);

// 문단(PARA_HEADER i)의 글·제어: 바로 다음 레코드가 한 단계 아래 PARA_TEXT 일 때만 글이 있다(빈 문단은 PARA_TEXT 가 없다)
function paraAt(records, i) {
  const next = records[i + 1];
  const { text, ctrls } = next?.tag === TAG.PARA_TEXT && next.level === records[i].level + 1 ? decodeText(next.data) : { text: '', ctrls: [] };
  return { i, text, ctrls };
}

// 목록(LIST_HEADER j)의 범위 끝: 목록의 문단은 LIST_HEADER 와 같은 level 의 PARA_HEADER 로 이어지고, 그보다 얕거나 같은 level 의 다른 레코드에서 끝난다
function listEnd(records, j) {
  const level = records[j].level;
  let k = j + 1;
  while (k < records.length && (records[k].level > level || (records[k].level === level && records[k].tag === TAG.PARA_HEADER))) k++;
  return k;
}

// 섹션의 최상위 문단(level 0 PARA_HEADER)마다 그 블록(다음 level 0 레코드 앞까지)과 안의 바깥 표들(level 1 'tbl ' 컨트롤; 표를 품은 문단은 표 자리다)
function blocks(records) {
  const out = [];
  for (let i = 0; i < records.length; i++) {
    if (records[i].tag !== TAG.PARA_HEADER || records[i].level !== 0) continue;
    let end = i + 1;
    while (end < records.length && records[end].level > 0) end++;
    const tables = [];
    for (let j = i + 1; j < end; j++) if (records[j].level === 1 && idOf(records[j]) === TABLE_ID) tables.push(j);
    out.push({ i, end, tables });
  }
  return out;
}

// 표(CTRL_HEADER ci) → Map('r,c' → { r, c, colspan, rowspan, w, h, i, end }) — TABLE 레코드 뒤 한 단계 아래 LIST_HEADER 가 칸. 같은 좌표는 첫 것.
function cellMap(records, ci) {
  const map = new Map();
  const level = records[ci].level + 1;
  let seenTable = false;
  for (let j = ci + 1; j < records.length && records[j].level > records[ci].level; j++) {
    const r = records[j];
    if (r.level !== level) continue;
    if (r.tag === TAG.TABLE) seenTable = true;
    if (r.tag !== TAG.LIST_HEADER || !seenTable || r.data.length < CELL_HEADER) continue;
    const d = r.data;
    const cell = { c: d.readUInt16LE(8), r: d.readUInt16LE(10), colspan: d.readUInt16LE(12), rowspan: d.readUInt16LE(14), w: d.readUInt32LE(16), h: d.readUInt32LE(20), i: j, end: listEnd(records, j) };
    if (!map.has(`${cell.r},${cell.c}`)) map.set(`${cell.r},${cell.c}`, cell);
  }
  return map;
}

// 칸의 문단들: LIST_HEADER 와 같은 level 의 PARA_HEADER
function cellParas(records, cell) {
  const out = [];
  for (let k = cell.i + 1; k < cell.end; k++) if (records[k].tag === TAG.PARA_HEADER && records[k].level === records[cell.i].level) out.push(k);
  return out;
}

const ctrlIdsIn = (records, from, to) => { const out = []; for (let k = from; k < to; k++) { const id = idOf(records[k]); if (id) out.push(id); } return out; };

// ── 스캔

const settingsIn = para => para.ctrls.some(c => SETTINGS.has(c.id));
// 그리기 개체('gso ')·필드('%…' 컨트롤 또는 글자 코드 3 필드 시작) — 범위 안(중첩 포함)의 컨트롤로 본다. 둘 다면 ' · ' 로 잇는다(hwpx 와 같은 순서)
function noteOf(records, from, to, paras) {
  const ids = ctrlIdsIn(records, from, to);
  return [
    ids.includes('gso ') && '그리기 개체 있음',
    (ids.some(id => id.startsWith('%')) || paras.some(p => p.ctrls.some(c => c.code === 3))) && '필드 있음',
  ].filter(Boolean).join(' · ');
}

function paragraphItem(records, block, section, p, styles, shapes) {
  const para = paraAt(records, block.i);
  const h = records[block.i].data;
  const shape = shapes[h.readUInt16LE(8)];
  const hints = { style: styles[h[10]]?.name ?? null, outlineLvl: shape?.headType === 1 ? shape.level : null, ilvl: shape && (shape.headType === 2 || shape.headType === 3) ? shape.level : null };
  const note = noteOf(records, block.i, block.end, [para]);
  return { kind: 'paragraph', section, p, text: para.text, hints, ...(settingsIn(para) && { locked: '문서 설정' }), ...(note && { note }) };
}

function cellItem(records, cell) {
  const paras = cellParas(records, cell).map(k => paraAt(records, k));
  const locked = ctrlIdsIn(records, cell.i + 1, cell.end).includes(TABLE_ID) ? '중첩 표' : paras.some(settingsIn) ? '문서 설정' : '';
  const note = noteOf(records, cell.i + 1, cell.end, paras);
  const item = { r: cell.r, c: cell.c, colspan: Math.max(cell.colspan, 1), rowspan: Math.max(cell.rowspan, 1), text: paras.map(p => p.text).join('\n'), ...(locked && { locked }), ...(note && { note }) };
  return { cell: item, w: cell.w, h: cell.h };
}

// 열 폭 %: 행마다 왼쪽 경계에서 칸 폭(HWPUNIT)을 더해 열 경계(edge[c])를 모은다 — 병합 칸 사이 경계도 다른 행에서 풀린다. 경계가 다 모이지 않으면 null (hwpx 와 같은 알고리즘)
function columns(rows) {
  const ncols = Math.max(0, ...rows.flat().map(x => x.cell.c + x.cell.colspan));
  const edge = [0];
  for (let pass = 0; pass < 3; pass++) {
    for (const row of rows) {
      let x = edge[row[0].cell.c], expected = row[0].cell.c;
      for (const { cell: { c, colspan }, w } of row) {
        const at = edge[c] ?? (c === expected ? x : undefined); // 위 행 rowspan 아래 틈은 그 경계를 알 때만 잇는다
        if (at == null) break;
        edge[c] = at;
        x = w > 0 ? at + w : undefined; // 폭 모름 → 다음 칸은 제 경계를 알 때만
        if (x != null) edge[c + colspan] ??= x;
        expected = c + colspan;
      }
    }
  }
  const diffs = Array.from({ length: ncols }, (_, i) => edge[i + 1] - edge[i]);
  return ncols && diffs.every(d => d > 0) ? diffs.map(d => Math.round((d / edge[ncols]) * 1000) / 10) : null;
}

function tableItem(records, ci, t, section) {
  const cells = [...cellMap(records, ci).values()].map(x => cellItem(records, x));
  const rows = [...Map.groupBy(cells, x => x.cell.r)].sort(([a], [b]) => a - b).map(([, row]) => row.sort((a, b) => a.cell.c - b.cell.c));
  return {
    kind: 'table', t, section, cols: columns(rows),
    rows: rows.map(row => {
      const hs = row.filter(x => x.cell.rowspan === 1 && x.h > 0).map(x => x.h);
      return { height: hs.length ? Math.min(...hs) / 100 : null, fixedHeight: false, cells: row.map(x => x.cell) };
    }),
  };
}

// 짧은 레코드로 범위를 벗어나면 형식 오류(guard) — 손상된 파일은 올리지 않고 사유를 알린다 (ERR-WB-011)
export function scanHwp(data) {
  return guard(() => {
    const { docInfo, sections } = openHwp(data);
    const styles = docStyles(docInfo), shapes = docParaShapes(docInfo);
    const items = [];
    let t = 0;
    for (const { n, records } of sections) {
      blocks(records).forEach((block, p) => {
        if (!block.tables.length) items.push(paragraphItem(records, block, n, p, styles, shapes));
        for (const ci of block.tables) items.push(tableItem(records, ci, t++, n));
      });
    }
    return { format: 'hwp', items };
  });
}

// ── 기입

// 문단 템플릿: 원 PARA_HEADER 바이트(크기 22·24 그대로), 첫 글자 모양 id, 첫 줄 정렬 36B
function template(records, k) {
  const level = records[k].level;
  let charShape = 0, lineSeg = null;
  for (let j = k + 1; j < records.length && records[j].level > level; j++) {
    const r = records[j];
    if (r.level !== level + 1) continue;
    if (r.tag === TAG.PARA_CHAR_SHAPE && r.data.length >= 8 && charShape === 0) charShape = r.data.readUInt32LE(4);
    if (r.tag === TAG.PARA_LINE_SEG && r.data.length >= LINE_SEG && !lineSeg) lineSeg = Buffer.from(r.data.subarray(0, LINE_SEG));
  }
  return { header: Buffer.from(records[k].data), charShape, lineSeg: lineSeg ?? Buffer.alloc(LINE_SEG) };
}

// 기본 서식(원래 문단이 없을 때): 섹션 첫 문단의 헤더 크기·줄 정렬에 문단 모양·스타일·글자 모양 0
function bare(records) {
  const k = records.findIndex(r => r.tag === TAG.PARA_HEADER);
  const tpl = k >= 0 ? template(records, k) : { header: Buffer.alloc(24), lineSeg: Buffer.alloc(LINE_SEG) };
  const header = Buffer.from(tpl.header);
  header.writeUInt16LE(0, 8);
  header[10] = 0;
  header[11] = 0;
  header.writeUInt32LE(0, 18);
  return { header, charShape: 0, lineSeg: tpl.lineSeg };
}

// 새 문단 레코드들(PARA_HEADER + 글 있으면 PARA_TEXT + PARA_CHAR_SHAPE + PARA_LINE_SEG) — 빈 줄은 nChars 1 에 PARA_TEXT 없음(실제 파일의 빈 문단과 같다).
// 단 나누기(@11)는 첫 줄만, 글자 모양 1·range tag 0·줄 정렬 1, 줄 정렬의 글자 시작은 0(한글이 열 때 다시 배치한다)
function paragraph(tpl, line, level, { first, last }) {
  const body = line ? encodeText(line) : null;
  const header = Buffer.from(tpl.header);
  header.writeUInt32LE(((body ? body.length / 2 : 1) | (last ? LAST_IN_LIST : 0)) >>> 0, 0);
  header.writeUInt32LE(body ? ctrlMaskOf(body) : 0, 4);
  if (!first) header[11] = 0;
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(0, 14);
  header.writeUInt16LE(1, 16);
  if (header.length >= 24) header.writeUInt16LE(0, 22);
  const charShape = Buffer.alloc(8);
  charShape.writeUInt32LE(tpl.charShape, 4);
  const lineSeg = Buffer.from(tpl.lineSeg);
  lineSeg.writeUInt32LE(0, 0);
  return [
    encodeRecord(TAG.PARA_HEADER, level, header),
    ...(body ? [encodeRecord(TAG.PARA_TEXT, level + 1, body)] : []),
    encodeRecord(TAG.PARA_CHAR_SHAPE, level + 1, charShape),
    encodeRecord(TAG.PARA_LINE_SEG, level + 1, lineSeg),
  ];
}

// 값의 줄마다 한 문단 — 글 있는 줄은 원래 글 있는 문단 서식을 차례로(넘치면 마지막), 빈 줄(또는 글 있는 문단이 없으면)은 같은 자리 문단 서식, 원래 문단이 없으면 기본 서식.
// last 면 마지막 새 문단에 '목록의 마지막' 표시(원래 마지막 문단이 켜져 있었을 때)
function paragraphs(records, ks, text, level, last) {
  const tpls = ks.length ? ks.map(k => template(records, k)) : [bare(records)];
  const content = ks.flatMap((k, i) => (paraAt(records, k).text.trim() ? [i] : []));
  let used = 0;
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  return lines.flatMap((line, i) => {
    const tpl = tpls[line.trim() && content.length ? content[Math.min(used++, content.length - 1)] : Math.min(i, tpls.length - 1)];
    return paragraph(tpl, line, level, { first: i === 0, last: last && i === lines.length - 1 });
  });
}

// 칸: LIST_HEADER 부터 칸 끝까지를 nParas 를 고친 LIST_HEADER + 새 문단들로 바꾼다. 표의 칸 지도는 한 번 기입하는 동안 표 항목에 남겨 둔다 — 값마다 표 전체를 다시 훑지 않게
function cellEvent(tables, { t, r, c }, text) {
  const tbl = nth(tables, t);
  const cell = tbl && (tbl.cells ??= cellMap(tbl.sec.records, tbl.ci)).get(`${r},${c}`);
  if (!cell) throw new Error(`칸을 찾지 못했습니다: T${t} r${r} c${c}`);
  const { sec } = tbl;
  const { records } = sec;
  const ks = cellParas(records, cell);
  const level = records[cell.i].level;
  const paras = paragraphs(records, ks, text, level, ks.length ? lastFlag(records[ks.at(-1)].data) : true);
  const list = Buffer.from(records[cell.i].data);
  list.writeInt16LE(paras.filter(b => (b.readUInt32LE(0) & 0x3FF) === TAG.PARA_HEADER).length, 0); // nParas = 새 문단 수(레코드 헤더의 tag 로 센다)
  return { sec, start: cell.i, end: cell.end, bytes: [encodeRecord(TAG.LIST_HEADER, level, list), ...paras] };
}

// 필드: 섹션의 최상위 문단 p(표를 품은 문단은 필드가 아니다)의 블록을 그 서식으로 바꾼다. after 면 블록은 두고 바로 뒤에 기본 서식 문단을 넣는다.
// 문서 설정이 든 문단은 바꾸지 않는다 — after 는 그 문단을 남기므로 허용한다. 구역의 마지막 문단 뒤에 끼우면 '목록의 마지막' 표시를 새 마지막 문단으로 옮긴다(머리 레코드만 고친다)
function fieldEvent(secs, { section, p, after }, text) {
  const sec = secs.find(s => s.n === section);
  const block = sec && nth(sec.blocks, p);
  if (!block || block.tables.length) throw new Error(`문단을 찾지 못했습니다: p${p}`);
  const { records } = sec;
  const last = lastFlag(records[block.i].data);
  if (after) {
    const paras = paragraphs(records, [], text, 0, last);
    if (!last) return { sec, start: block.end, end: block.end, bytes: paras };
    const header = Buffer.from(records[block.i].data);
    header.writeUInt32LE(header.readUInt32LE(0) & ~LAST_IN_LIST, 0);
    return { sec, start: block.i, end: block.end, bytes: [encodeRecord(TAG.PARA_HEADER, 0, header), raw(sec, block.i + 1, block.end), ...paras] };
  }
  if (settingsIn(paraAt(records, block.i))) throw new Error(`잠긴 문단입니다: p${p}`);
  return { sec, start: block.i, end: block.end, bytes: paragraphs(records, [block.i], text, 0, last) };
}

// 레코드 [from, to) 의 원 바이트
const raw = (sec, from, to) => (from < to ? sec.buf.subarray(sec.records[from].start, sec.records[to - 1].end) : Buffer.alloc(0));

export function fillHwp(data, fills) {
  return guard(() => {
    const { header, sections } = openHwp(data);
    const secs = sections.map(s => ({ ...s, blocks: blocks(s.records) }));
    const tables = secs.flatMap(sec => sec.blocks.flatMap(b => b.tables.map(ci => ({ sec, ci }))));
    const events = fills.map(({ unit, text }) => (unit.kind === 'field' ? fieldEvent(secs, unit, text) : cellEvent(tables, unit, text)));
    const replace = {};
    for (const sec of secs) {
      // 앞에서부터 원 레코드 조각과 새 레코드를 모아 한 번에 잇는다(값마다 섹션 전체를 복사하지 않는다). 같은 시작이면 빈 끼우기가 넓은 교체 앞에 온다
      const mine = events.filter(e => e.sec === sec).sort((a, b) => a.start - b.start || a.end - b.end);
      if (!mine.length) continue;
      const parts = [];
      let at = 0;
      mine.forEach((e, i) => {
        const prev = mine[i - 1];
        if (prev && (e.start < prev.end || (e.start === prev.start && e.end === prev.end))) throw new Error('같은 자리를 두 번 채울 수 없습니다');
        parts.push(raw(sec, at, e.start), ...e.bytes);
        at = e.end;
      });
      parts.push(raw(sec, at, sec.records.length));
      const body = Buffer.concat(parts);
      replace[sec.name] = header.compressed ? zlib.deflateRawSync(body) : body;
    }
    return writeCfb(data, replace);
  });
}
