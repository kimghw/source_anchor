// 기준 문서의 형식별 변환 (DR-WB-006) — Word(docx)·한글(hwpx·hwp) 파일과 텍스트 파일을 블록 초안으로 바꾼다. 문장·수치는 요약하거나 고치지 않는다.
// Word·한글: 양식 스캐너(lib/docx_form.js·hwpx_form.js·hwp_form.js)가 읽은 본문 문단·표를 문서 순서대로 옮긴다 —
//   제목 스타일(Heading n·제목 n·개요 n)이나 개요 수준이 있는 문단은 그 수준의 제목, 자동 번호·글머리표 문단은 목록 항목, 그 밖은 문단.
//   표는 병합한 칸의 글을 그 칸이 덮는 칸마다 되풀이하고, 칸 하나뿐인 표(글상자처럼 쓴 것)는 그 안의 문단으로 옮긴다.
//   양식 스캐너는 docx 의 스타일 ID 만 주고 hwpx 에는 힌트가 없어(양식의 헤딩 판별은 글 모양 규칙이 맡는다), 스타일 이름·개요 수준은 여기서
//   word/styles.xml · Contents/header.xml 로 찾는다. 자동 번호·글머리표의 번호 글자는 파일에 글로 없어 옮기지 않는다.
// 텍스트: Markdown 표시로 읽지 않는다 — 빈 줄과 구조 마디 번호(lib/guide_outline.js)로 시작하는 줄에서 문단을 나눈다.
import { scanDocx } from './docx_form.js';
import { startsNode } from './guide_outline.js';
import { isHwp } from './hwp_file.js';
import { scanHwp } from './hwp_form.js';
import { scanHwpx } from './hwpx_form.js';
import { literalLines, markdownToDrafts } from './ingest.js';
import { elementSpans } from './xml_spans.js';
import { readZip } from './zip.js';

export const OFFICE_FORMATS = { docx: 'Word', hwpx: '한글', hwp: '한글' };
const STYLE_HEADING = /^(?:heading|제목|개요|outline)\s*(\d)/i; // Word 의 Heading n·제목 n, 한글의 개요 n (lib/form_outline.js 와 같은 이름 규칙)
const fail = message => Object.assign(new Error(message), { format: true });
const attrOf = (tag, name) => tag?.match(new RegExp(`\\s(?:[\\w.-]+:)?${name}="([^"]*)"`))?.[1];
const oneLine = text => String(text ?? '').replace(/\s+/g, ' ').trim();

// 제목 수준(1~6), 제목이 아니면 0 — 문단의 개요 수준이 스타일 이름보다 앞선다(OOXML 개요 수준 9 는 본문)
function headingLevel({ style, outlineLvl }) {
  if (outlineLvl != null && outlineLvl < 9) return Math.min(outlineLvl + 1, 6);
  const name = String(style ?? '').trim();
  const m = name.match(STYLE_HEADING);
  if (m) return Math.min(Number(m[1]) || 1, 6);
  return /^(title|제목)$/i.test(name) ? 1 : 0;
}

// word/styles.xml → 스타일 ID → { style(이름), outlineLvl(바탕 스타일을 따라 찾는다) }
function docxStyles(data) {
  const xml = readZip(data).read('word/styles.xml')?.toString('utf8') ?? '';
  const styles = new Map();
  for (const m of xml.matchAll(/<w:style\s([^>]*?)(?:\/>|>([\s\S]*?)<\/w:style>)/g)) {
    const body = m[2] ?? '';
    const val = name => attrOf(body.match(new RegExp(`<w:${name}\\s[^>]*>`))?.[0], 'val');
    styles.set(attrOf(` ${m[1]}`, 'styleId'), { name: val('name'), outline: val('outlineLvl'), basedOn: val('basedOn') });
  }
  const outline = (id, seen = new Set()) => {
    const s = styles.get(id);
    if (!s || seen.has(id)) return null;
    return s.outline != null ? Number(s.outline) : outline(s.basedOn, seen.add(id));
  };
  return hints => ({ ...hints, style: styles.get(hints.style)?.name ?? hints.style, outlineLvl: hints.outlineLvl ?? outline(hints.style) });
}

// Contents/header.xml 의 스타일 이름·문단 모양의 머리(개요·번호·글머리표) + 섹션마다 최상위 문단의 여는 태그 → 항목(section, p)의 힌트
function hwpxHints(data) {
  const zip = readZip(data);
  const header = zip.read('Contents/header.xml')?.toString('utf8') ?? '';
  const heads = new Map();
  for (const m of header.matchAll(/<[\w.-]+:paraPr\s([^>]*)>([\s\S]*?)<\/[\w.-]+:paraPr>/g)) {
    const tag = m[2].match(/<[\w.-]+:heading\s[^>]*>/)?.[0];
    if (tag) heads.set(attrOf(` ${m[1]}`, 'id'), { type: attrOf(tag, 'type'), level: Number(attrOf(tag, 'level')) || 0 });
  }
  const styles = new Map([...header.matchAll(/<[\w.-]+:style\s[^>]*>/g)].map(m => [attrOf(m[0], 'id'), attrOf(m[0], 'name')]));
  const opens = new Map(zip.names.flatMap(name => {
    const n = /^Contents\/section(\d+)\.xml$/.exec(name)?.[1];
    if (n == null) return [];
    const xml = zip.read(name).toString('utf8');
    return [[Number(n), elementSpans(xml, 'p').map(s => xml.slice(s.start, xml.indexOf('>', s.start) + 1))]];
  }));
  return item => {
    const tag = opens.get(item.section)?.[item.p];
    const head = heads.get(attrOf(tag, 'paraPrIDRef'));
    return { style: styles.get(attrOf(tag, 'styleIDRef')) ?? null, outlineLvl: head?.type === 'OUTLINE' ? head.level : null, ilvl: head && ['NUMBER', 'BULLET'].includes(head.type) ? head.level : null };
  };
}

// 표 항목 → 초안. 칸을 행마다 차례로 빈 자리에 놓아(위 행의 세로 병합이 차지한 자리는 건너뛴다) 병합 칸의 글을 덮는 칸마다 되풀이한다.
// 칸 안의 줄은 " / " 로 잇는다(PDF 에이전트 변환과 같은 표기). 칸 하나뿐인 표는 그 안의 줄마다 문단으로
function tableDrafts(item, nextPara) {
  const grid = [];
  for (const row of item.rows) {
    let col = 0;
    for (const cell of row.cells) {
      while (grid[cell.r]?.[col] !== undefined) col++;
      const text = String(cell.text ?? '').split('\n').map(oneLine).filter(Boolean).join(' / ');
      for (let r = cell.r; r < cell.r + cell.rowspan; r++) for (let c = col; c < col + cell.colspan; c++) (grid[r] ??= [])[c] = text;
      col += cell.colspan;
    }
  }
  const rows = Array.from(grid, row => row ?? []);
  const width = Math.max(0, ...rows.map(row => row.length));
  if (!width) return [];
  if (width === 1 && rows.length === 1) return rows[0][0].split(' / ').filter(Boolean).map(text => ({ kind: 'paragraph', loc: { para: nextPara() }, text }));
  const [columns, ...body] = rows.map(row => Array.from({ length: width }, (_, c) => row[c] ?? ''));
  return [{ kind: 'table', loc: { para: nextPara() }, table: { title: '', unit: '', columns, rows: body } }];
}

// 스캐너 항목(문서 순서) → 초안. 빈 문단은 건너뛰고 목록을 끊는다
function itemDrafts(items, hintsOf) {
  const drafts = [];
  let para = 0;
  let list = null;
  const nextPara = () => ++para;
  for (const item of items) {
    if (item.kind === 'table') {
      list = null;
      drafts.push(...tableDrafts(item, nextPara));
      continue;
    }
    const text = oneLine(item.text);
    const hints = text ? hintsOf(item) : null;
    const level = hints ? headingLevel(hints) : 0;
    if (text && !level && hints.ilvl != null) {
      if (list) list.items.push(text);
      else drafts.push(list = { kind: 'list', loc: { para: nextPara() }, items: [text] });
      continue;
    }
    list = null;
    if (text) drafts.push(level ? { kind: 'heading', level, loc: { para: nextPara() }, text } : { kind: 'paragraph', loc: { para: nextPara() }, text });
  }
  return drafts;
}

// Word·한글 파일 → { type, title, drafts, snapshot }. 확장자와 내용이 다르거나 손상·암호·배포용이면 format 표시가 붙은 오류 (ERR-WB-008)
export function officeDocument(data, format, name) {
  let drafts;
  if (format === 'hwp') {
    if (!isHwp(data)) throw fail('한글 문서(hwp)가 아닙니다 — 파일이 손상되었거나 다른 형식입니다');
    drafts = itemDrafts(scanHwp(data).items, item => item.hints);
  } else if (format === 'docx') {
    const styled = docxStyles(data);
    drafts = itemDrafts(scanDocx(data).items, item => styled(item.hints));
  } else {
    const hints = hwpxHints(data);
    drafts = itemDrafts(scanHwpx(data).items, hints);
  }
  return { type: format, title: name, drafts, snapshot: { ext: format, data } };
}

// Markdown 파일·붙여 넣은 본문 → 초안. 번호 목록의 번호(1. 1))는 인쇄된 번호라 글자로 남기고(「- 1. …」 항목으로 바꾼다 — markdownToDrafts 는 번호를 뗀다),
// 굵게·기울임·인용 표시는 문장 글에 남기지 않는다. 번호로 시작하는 항목을 마디로 떼는 것은 부르는 쪽(itemNodes)이 한다
const EMPHASIS = [
  [/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1'],
  [/__(?=\S)(.+?)(?<=\S)__/g, '$1'],
  [/(^|[\s(（[【"'“‘])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?=$|[\s.,;:!?)）\]】"'”’])/g, '$1$2'], // *a.c.* — 곱셈·각주 표시처럼 짝이 없거나 글자에 붙은 * 는 그대로
];
export function markdownDrafts(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n').map(line => {
    let text = line.replace(/^(\s*)>\s?/, '$1');
    for (const [re, to] of EMPHASIS) text = text.replace(re, to);
    return text.replace(/^(\s*)(\d{1,3}[.)])(\s+)/, '$1- $2$3');
  });
  return markdownToDrafts(lines.join('\n'));
}

// 텍스트 파일의 글 → 초안. 줄의 「1.」「- 」「#」 같은 첫머리는 Markdown 표시가 아니라 글자다
export function textDrafts(text) {
  const lines = [];
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    if (lines.length && lines.at(-1).trim() && startsNode(line.trim())) lines.push(''); // 번호로 시작하는 줄은 새 문단
    lines.push(line);
  }
  return markdownToDrafts(literalLines(lines.join('\n')));
}
