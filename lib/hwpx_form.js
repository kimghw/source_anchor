// 한글 양식(hwpx)의 섹션별 최상위 문단·표를 문서 순서대로 읽고(scanHwpx), 칸·문단에 값을 써 넣는다(fillHwpx) — Contents/section<n>.xml 원문 문자열을 구간 절개로만 고친다.
// 번호(section·p·t·r·c)는 스캔과 기입이 같은 구간 함수로 센다. 접두사는 hp: 고정이 아니라 문서에서 잡는다. 형식: references/docx_hwpx_format.md
import { readZip, writeZip } from './zip.js';
import { elementSpans, escapeXml, innerSpan, outside, unescapeXml } from './xml_spans.js';

const SECTION = /^Contents\/section(\d+)\.xml$/;
const DRAWING = /<[A-Za-z][-\w.]*:(pic|container|rect|line|ellipse|ole|equation)[\s/>]/;
const TEXT = /<([A-Za-z][-\w.]*):t(?:\s[^>]*)?(?<!\/)>([\s\S]*?)<\/\1:t>/g;
const RUN = /<[A-Za-z][-\w.]*:run(?=[\s/>])([^>]*)>/;
const SETTINGS = /<[A-Za-z][-\w.]*:(secPr|ctrl)[\s/>]/; // 구역·단·머리말 같은 문서 설정 — 문단을 바꾸면 사라진다

const notHwpx = () => Object.assign(new Error('한글 문서(hwpx)가 아닙니다 — Contents/section*.xml 이 없습니다'), { format: true });

// 섹션 파일 번호순 → [{ name, n, xml }]
function sections(data) {
  const zip = readZip(data);
  const list = zip.names.flatMap(name => {
    const m = SECTION.exec(name);
    return m ? [{ name, n: Number(m[1]), xml: zip.read(name).toString('utf8') }] : [];
  }).sort((a, b) => a.n - b.n);
  if (!list.length) throw notHwpx();
  return list;
}

// ── 구간 — 스캔과 기입이 같이 쓴다

const inside = (xml, span) => innerSpan(xml, span) ?? { start: span.end, end: span.end }; // 자기 닫힘이면 빈 범위
const kids = (xml, span, name) => elementSpans(xml, name, inside(xml, span));
const nth = (list, i) => (Number.isInteger(i) ? list[i] : undefined);
const num = (tag, name) => { const v = tag?.match(new RegExp(`\\s${name}="(-?\\d+)"`))?.[1]; return v == null ? null : Number(v); };

// 섹션의 최상위 문단마다 그 안의 바깥 표들(표를 품은 문단은 표 자리다)
const blocks = xml => elementSpans(xml, 'p').map(span => ({ span, tables: kids(xml, span, 'tbl') }));

// 칸 안(중첩 표 밖)의 첫 <pfx:local …> 태그 — cellAddr 등은 subList 뒤에 오기도 한다
function tagIn(xml, tc, nested, local) {
  const { start, end } = inside(xml, tc);
  for (const m of xml.slice(start, end).matchAll(new RegExp(`<[A-Za-z][-\\w.]*:${local}(?=[\\s/>])[^>]*>`, 'g'))) {
    if (outside(start + m.index, nested)) return m[0];
  }
}

// 표 → Map('r,c' → { r, c, tc, nested }) — cellAddr(두 속성 다) 우선, 없으면 (tr 순번, tc 순번). 같은 좌표는 첫 것.
function cellMap(xml, tbl) {
  const map = new Map();
  kids(xml, tbl, 'tr').forEach((tr, ri) => kids(xml, tr, 'tc').forEach((tc, ci) => {
    const nested = kids(xml, tc, 'tbl');
    const addr = tagIn(xml, tc, nested, 'cellAddr');
    const [row, col] = [num(addr, 'rowAddr'), num(addr, 'colAddr')];
    const [r, c] = row != null && col != null ? [row, col] : [ri, ci];
    if (!map.has(`${r},${c}`)) map.set(`${r},${c}`, { r, c, tc, nested });
  }));
  return map;
}

// 칸의 문단 자리: 첫 subList, 없으면 칸 자체
const holder = (xml, tc) => kids(xml, tc, 'subList')[0] ?? tc;

// ── 스캔

// 문단 글: t 본문을 잇고(tab → \t, lineBreak → \n, 그 밖 태그는 뺀다) 중첩 표 안은 뺀다. 공백은 그대로.
function paraText(xml, span) {
  const { start, end } = inside(xml, span);
  const nested = elementSpans(xml, 'tbl', { start, end });
  return [...xml.slice(start, end).matchAll(TEXT)].filter(m => outside(start + m.index, nested))
    .map(m => unescapeXml(m[2].replace(/<[^>]*>/g, tag => (/^<[\w.-]+:tab[\s/>]/.test(tag) ? '\t' : /^<[\w.-]+:lineBreak[\s/>]/.test(tag) ? '\n' : '')))).join('');
}

const noteOf = (xml, span) => (DRAWING.test(xml.slice(span.start, span.end)) ? '그리기 개체 있음' : '');
const settingsIn = (xml, span) => SETTINGS.test(xml.slice(span.start, span.end)); // 문단 항목엔 표가 없으니(표를 품으면 표 자리) 중첩 표를 뺄 일이 없다

function paragraphItem(xml, span, section, p) {
  const note = noteOf(xml, span);
  return { kind: 'paragraph', section, p, text: paraText(xml, span), hints: {}, ...(settingsIn(xml, span) && { locked: '문서 설정' }), ...(note && { note }) };
}

function cellItem(xml, { r, c, tc, nested }) {
  const span = tagIn(xml, tc, nested, 'cellSpan');
  const sz = tagIn(xml, tc, nested, 'cellSz');
  const locked = nested.length ? '중첩 표' : '';
  const note = noteOf(xml, tc);
  const cell = {
    r, c, colspan: Math.max(num(span, 'colSpan') ?? 1, 1), rowspan: Math.max(num(span, 'rowSpan') ?? 1, 1),
    text: kids(xml, holder(xml, tc), 'p').map(s => paraText(xml, s)).join('\n'), ...(locked && { locked }), ...(note && { note }),
  };
  return { cell, w: num(sz, 'width'), h: num(sz, 'height') };
}

// 열 폭 %: 행마다 왼쪽 경계에서 칸 폭을 더해 열 경계(edge[c])를 모은다 — 병합 칸 사이 경계도 다른 행에서 풀린다. 경계가 다 모이지 않으면 null.
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

function tableItem(xml, span, t, section) {
  const cells = [...cellMap(xml, span).values()].map(x => cellItem(xml, x));
  const rows = [...Map.groupBy(cells, x => x.cell.r)].sort(([a], [b]) => a - b).map(([, row]) => row.sort((a, b) => a.cell.c - b.cell.c));
  return {
    kind: 'table', t, section, cols: columns(rows),
    rows: rows.map(row => {
      const hs = row.filter(x => x.cell.rowspan === 1 && x.h > 0).map(x => x.h);
      return { height: hs.length ? Math.min(...hs) / 100 : null, fixedHeight: false, cells: row.map(x => x.cell) };
    }),
  };
}

export function scanHwpx(data) {
  const items = [];
  let t = 0;
  for (const { n, xml } of sections(data)) {
    blocks(xml).forEach(({ span, tables }, p) => {
      if (!tables.length) items.push(paragraphItem(xml, span, n, p));
      for (const tbl of tables) items.push(tableItem(xml, tbl, t++, n));
    });
  }
  return { format: 'hwpx', items };
}

// ── 기입

const bare = pfx => ({ open: `<${pfx}:p paraPrIDRef="0" styleIDRef="0">`, pfx, attrs: ' charPrIDRef="0"' });

// 문단 템플릿: 원래 여는 태그 그대로(자기 닫힘은 / 를 뗀다) + 첫 run 속성 그대로(끝 / 를 뗀다)
function template(xml, span) {
  const open = xml.slice(span.start, xml.indexOf('>', span.start) + 1).replace(/\s*\/>$/, '>');
  const run = RUN.exec(xml.slice(span.start, span.end));
  return { open, pfx: span.prefix, attrs: run ? run[1].replace(/\s*\/?\s*$/, '') : ' charPrIDRef="0"' };
}

// 값의 줄마다 한 문단 — 글 있는 줄은 원래 글 있는 문단 서식을 차례로(넘치면 마지막), 빈 줄(또는 글 있는 문단이 없으면)은 같은 자리 문단 서식
function paragraphs(xml, spans, text, pfx) {
  const tpls = spans.length ? spans.map(s => template(xml, s)) : [bare(pfx)];
  const content = spans.flatMap((s, i) => (paraText(xml, s).trim() ? [i] : []));
  let used = 0;
  return String(text).replace(/\r\n?/g, '\n').split('\n').map((line, i) => {
    const { open, pfx: p, attrs } = tpls[line.trim() && content.length ? content[Math.min(used++, content.length - 1)] : Math.min(i, tpls.length - 1)];
    return `${open}<${p}:run${attrs}><${p}:t>${escapeXml(line)}</${p}:t></${p}:run></${p}:p>`;
  }).join('');
}

// 칸: 첫 subList 안 첫 최상위 문단 시작 ~ 마지막 문단 끝을 교체(문단이 없으면 subList 안 끝에 넣는다)
function cellEvent(tables, { t, r, c }, text) {
  const tbl = nth(tables, t);
  const cell = tbl && cellMap(tbl.sec.xml, tbl.span).get(`${r},${c}`);
  if (!cell) throw new Error(`칸을 찾지 못했습니다: T${t} r${r} c${c}`);
  const { sec } = tbl;
  const box = holder(sec.xml, cell.tc);
  const ps = kids(sec.xml, box, 'p');
  if (!ps.length) { const at = inside(sec.xml, box).end; return { sec, start: at, end: at, xml: paragraphs(sec.xml, [], text, cell.tc.prefix) }; }
  return { sec, start: ps[0].start, end: ps.at(-1).end, xml: paragraphs(sec.xml, ps, text) };
}

// 필드: 섹션의 최상위 문단 p(표를 품은 문단은 필드가 아니다)를 그 서식으로, after 면 p 는 두고 바로 뒤에 기본 서식 문단을 넣는다.
// 문서 설정(secPr·ctrl)이 든 문단은 바꾸지 않는다 — after 는 그 문단을 남기므로 허용한다.
function fieldEvent(secs, { section, p, after }, text) {
  const sec = secs.find(s => s.n === section);
  const block = sec && nth(sec.blocks, p);
  if (!block || block.tables.length) throw new Error(`문단을 찾지 못했습니다: p${p}`);
  const { span } = block;
  if (after) return { sec, start: span.end, end: span.end, xml: paragraphs(sec.xml, [], text, span.prefix) };
  if (settingsIn(sec.xml, span)) throw new Error(`잠긴 문단입니다: p${p}`);
  return { sec, start: span.start, end: span.end, xml: paragraphs(sec.xml, [span], text) };
}

export function fillHwpx(data, fills) {
  const secs = sections(data).map(s => ({ ...s, blocks: blocks(s.xml) }));
  const tables = secs.flatMap(sec => sec.blocks.flatMap(b => b.tables.map(span => ({ sec, span }))));
  const events = fills.map(({ unit, text }) => (unit.kind === 'field' ? fieldEvent(secs, unit, text) : cellEvent(tables, unit, text)));
  const replace = {};
  for (const sec of secs) {
    // 뒤에서부터 바꿔 앞 색인이 밀리지 않게 한다. 같은 시작이면 넓은 교체가 먼저(빈 끼우기는 그 앞에 붙는다)
    const mine = events.filter(e => e.sec === sec).sort((a, b) => b.start - a.start || b.end - a.end);
    if (!mine.length) continue;
    let out = sec.xml;
    mine.forEach((e, i) => {
      const prev = mine[i - 1];
      if (prev && (e.end > prev.start || (e.start === prev.start && e.end === prev.end))) throw new Error('같은 자리를 두 번 채울 수 없습니다');
      out = out.slice(0, e.start) + e.xml + out.slice(e.end);
    });
    replace[sec.name] = out;
  }
  return writeZip(data, replace);
}
