// Word 양식(docx)의 본문 문단·표를 문서 순서대로 읽고(scanDocx), 칸·문단에 값을 써 넣는다(fillDocx) — word/document.xml 원문 문자열을 구간 절개로만 고친다.
// 번호(p·t·r·c)는 스캔과 기입이 같은 구간 함수로 센다. 칸·문단의 분류와 번호 매기기는 lib/forms.js 가 한다. 형식: references/docx_hwpx_format.md
import { readZip, writeZip } from './zip.js';
import { elementSpans, escapeXml, innerSpan, unescapeXml } from './xml_spans.js';

const DOCUMENT = 'word/document.xml';
const NOTES = [[/<w:drawing[\s>]/, '그림 있음'], [/<w:fldChar[\s/>]/, '필드 있음'], [/<w:sdt[\s>]/, '콘텐츠 컨트롤 있음']]; // 문단 안
const LOCKS = [[/<w:tbl[\s>]/, '중첩 표'], [/<w:sdt[\s>]/, '콘텐츠 컨트롤']]; // 칸 안, 문단 밖
const TEXT = /<w:t(?:\s[^>]*)?(?<!\/)>([\s\S]*?)<\/w:t>|<w:(br|tab)(?=[\s/>])[^>]*>/g;

const notWord = () => Object.assign(new Error('Word 문서(docx)가 아닙니다 — word/document.xml 이 없습니다'), { format: true });

function documentXml(data) {
  const xml = readZip(data).read(DOCUMENT);
  if (!xml) throw notWord();
  return xml.toString('utf8');
}

// ── 구간 — 스캔과 기입이 같이 쓴다

const inside = (xml, span) => innerSpan(xml, span) ?? { start: span.end, end: span.end }; // 자기 닫힘이면 빈 범위
const kids = (xml, span, name) => elementSpans(xml, name, { ...inside(xml, span), prefix: 'w' });
const content = (xml, span) => { const { start, end } = inside(xml, span); return xml.slice(start, end); };
const nth = (list, i) => (Number.isInteger(i) ? list[i] : undefined);

// 본문의 최상위 문단·표 (표 안 문단은 elementSpans 가 뺀다)
function blocks(xml) {
  const start = xml.search(/<w:body[\s>]/);
  const close = xml.lastIndexOf('</w:body>');
  if (start < 0 || close < start) throw notWord();
  const body = { start, end: close + '</w:body>'.length };
  return { paras: kids(xml, body, 'p'), tables: kids(xml, body, 'tbl') };
}

// start 에서 열리는 <w:name> 요소 전체 — 같은 이름 중첩(rPrChange 안 rPr 등)을 세어 끝을 찾는다
function balanced(xml, name, start) {
  if (start < 0) return '';
  const re = new RegExp(`<(/?)w:${name}(?=[\\s/>])[^>]*>`, 'g');
  re.lastIndex = start;
  for (let depth = 0, m; (m = re.exec(xml));) {
    depth += m[1] ? -1 : m[0].endsWith('/>') ? 0 : 1;
    if (depth <= 0) return xml.slice(start, m.index + m[0].length);
  }
  return '';
}

// 첫 자식이 <w:name> 이면 그 요소 전체, 아니면 '' (tcPr·pPr 는 첫 자식이다)
const leading = (s, name) => { const m = new RegExp(`^\\s*(?=<w:${name}[\\s/>])`).exec(s); return m ? balanced(s, name, m[0].length) : ''; };
const tagOf = (s, name) => new RegExp(`<w:${name}(?=[\\s/>])[^>]*>`).exec(s)?.[0];
const attr = (tag, name) => tag?.match(new RegExp(`\\sw:${name}=(["'])(.*?)\\1`))?.[2];
const num = v => (v == null ? null : Number(v));
const labels = (rules, s) => rules.filter(([re]) => re.test(s)).map(([, label]) => label).join(' · ');

// ── 스캔

// 문단 글: w:t 를 잇고 br → \n, tab → \t (pPr 의 탭 위치는 글이 아니다). 공백은 그대로.
function paraText(inner) {
  const pPr = leading(inner, 'pPr');
  return [...inner.slice(inner.indexOf(pPr) + pPr.length).matchAll(TEXT)]
    .map(m => (m[1] != null ? unescapeXml(m[1]) : m[2] === 'br' ? '\n' : '\t')).join('');
}

function paragraphItem(xml, span, p) {
  const inner = content(xml, span);
  const pPr = leading(inner, 'pPr');
  const note = labels(NOTES, xml.slice(span.start, span.end));
  const hints = { style: attr(tagOf(pPr, 'pStyle'), 'val') ?? null, outlineLvl: num(attr(tagOf(pPr, 'outlineLvl'), 'val')), ilvl: num(attr(tagOf(pPr, 'ilvl'), 'val')) };
  return { kind: 'paragraph', section: 0, p, text: paraText(inner), hints, ...(note && { note }) };
}

function cellBody(xml, tc) {
  const inner = inside(xml, tc);
  const ps = kids(xml, tc, 'p');
  let gaps = '', at = inner.start; // 칸 안, 최상위 문단 밖
  for (const s of ps) { gaps += xml.slice(at, s.start); at = s.end; }
  gaps += xml.slice(at, inner.end);
  const locked = labels(LOCKS, gaps);
  const note = labels(NOTES, ps.map(s => xml.slice(s.start, s.end)).join(''));
  return { text: ps.map(s => paraText(content(xml, s))).join('\n'), ...(locked && { locked }), ...(note && { note }) };
}

// 행 → { height, fixedHeight, cells: [{ c, g(그리드 열), span, merge, tc }] }
function parseRow(xml, tr) {
  const tcs = kids(xml, tr, 'tc');
  const { start, end } = inside(xml, tr);
  const height = tagOf(xml.slice(start, tcs[0]?.start ?? end), 'trHeight'); // trPr 는 첫 칸 앞
  let g = 0;
  const cells = tcs.map((tc, c) => {
    const pr = leading(content(xml, tc), 'tcPr');
    const span = Math.max(Number(attr(tagOf(pr, 'gridSpan'), 'val')) || 1, 1);
    const vMerge = tagOf(pr, 'vMerge');
    const cell = { c, g, span, merge: vMerge ? (attr(vMerge, 'val') ?? 'continue') : null, tc };
    g += span;
    return cell;
  });
  const val = attr(height, 'val');
  return { height: val == null ? null : Number(val) / 20, fixedHeight: attr(height, 'hRule') === 'exact', cells };
}

// 시작 칸 아래로 같은 그리드 열에 이어짐 칸이 있는 연속 행 수 + 1
function rowspan(rows, r, g) {
  let n = 1;
  while (rows[r + n]?.cells.find(x => x.g === g)?.merge === 'continue') n++;
  return n;
}

function tableItem(xml, span, t) {
  const trs = kids(xml, span, 'tr');
  const { start, end } = inside(xml, span);
  const widths = [...xml.slice(start, trs[0]?.start ?? end).matchAll(/<w:gridCol(?=[\s/>])[^>]*>/g)].map(m => Number(attr(m[0], 'w')));
  const total = widths.reduce((a, b) => a + b, 0);
  const cols = widths.length && widths.every(w => w > 0) ? widths.map(w => Math.round((w / total) * 1000) / 10) : null;
  const parsed = trs.map(tr => parseRow(xml, tr));
  const rows = parsed.map(({ height, fixedHeight, cells }, r) => ({
    height, fixedHeight,
    cells: cells.filter(x => x.merge !== 'continue').map(x => ({
      r, c: x.c, colspan: x.span, rowspan: x.merge === 'restart' ? rowspan(parsed, r, x.g) : 1, ...cellBody(xml, x.tc),
    })),
  }));
  return { kind: 'table', t, section: 0, cols, rows };
}

export function scanDocx(data) {
  const xml = documentXml(data);
  const { paras, tables } = blocks(xml);
  const items = [
    ...paras.map((s, p) => [s.start, paragraphItem(xml, s, p)]),
    ...tables.map((s, t) => [s.start, tableItem(xml, s, t)]),
  ].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
  return { format: 'docx', items };
}

// ── 기입

// 문단 서식 껍데기: pPr, 그리고 rPr 가 있는 첫 런의 rPr → 없으면 문단 표시 rPr(pPr 안) → 없으면 ''
function shell(xml, span) {
  const inner = content(xml, span);
  const pPr = leading(inner, 'pPr');
  const run = /<w:r(?=[\s>])[^>]*>\s*(?=<w:rPr[\s>])/.exec(inner);
  return [pPr, run ? balanced(inner, 'rPr', run.index + run[0].length) : balanced(pPr, 'rPr', pPr.search(/<w:rPr[\s>]/))];
}

const paragraphs = (text, pPr = '', rPr = '') => String(text).replace(/\r\n?/g, '\n').split('\n')
  .map(line => `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`).join('');

// 칸: 첫 최상위 문단 시작 ~ 마지막 최상위 문단 끝을 줄마다 한 문단으로 (문단이 없으면 </w:tc> 바로 앞에 넣는다)
function cellEvent(xml, tables, { t, r, c }, text) {
  const tbl = nth(tables, t);
  const tr = tbl && nth(kids(xml, tbl, 'tr'), r);
  const tc = tr && nth(kids(xml, tr, 'tc'), c);
  if (!tc) throw new Error(`칸을 찾지 못했습니다: T${t} r${r} c${c}`);
  const ps = kids(xml, tc, 'p');
  if (!ps.length) { const at = inside(xml, tc).end; return { start: at, end: at, xml: paragraphs(text) }; }
  return { start: ps[0].start, end: ps.at(-1).end, xml: paragraphs(text, ...shell(xml, ps[0])) };
}

// 필드: 본문 문단 p 를 줄마다 한 문단으로(그 문단의 서식), after 면 p 는 두고 바로 뒤에 맨몸 문단을 넣는다
function fieldEvent(xml, paras, { p, after }, text) {
  const span = nth(paras, p);
  if (!span) throw new Error(`문단을 찾지 못했습니다: p${p}`);
  if (after) return { start: span.end, end: span.end, xml: paragraphs(text) };
  return { start: span.start, end: span.end, xml: paragraphs(text, ...shell(xml, span)) };
}

export function fillDocx(data, fills) {
  const xml = documentXml(data);
  const { paras, tables } = blocks(xml);
  // 뒤에서부터 바꿔 앞 색인이 밀리지 않게 한다. 같은 시작이면 넓은 교체가 먼저(빈 끼우기는 그 앞에 붙는다)
  const events = fills.map(({ unit, text }) => (unit.kind === 'field' ? fieldEvent(xml, paras, unit, text) : cellEvent(xml, tables, unit, text)))
    .sort((a, b) => b.start - a.start || b.end - a.end);
  let out = xml;
  events.forEach((e, i) => {
    const prev = events[i - 1];
    if (prev && (e.end > prev.start || (e.start === prev.start && e.end === prev.end))) throw new Error('같은 자리를 두 번 채울 수 없습니다');
    out = out.slice(0, e.start) + e.xml + out.slice(e.end);
  });
  return writeZip(data, { [DOCUMENT]: out });
}
