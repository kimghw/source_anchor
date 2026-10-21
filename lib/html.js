// 내려받은 HTML 을 Markdown 으로 바꾼다 — 글자는 그대로 두고(요약·수정 없음) 제목·문단·목록·표 구조만 옮긴다.
// 결과는 lib/ingest.js 의 markdownToDrafts 가 읽는 형식이다: 블록 사이는 빈 줄, 목록은 "- ", 표는 | 칸 | 칸 |.

import { literalLines } from './ingest.js';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'noscript', 'template', 'textarea', 'title']); // 안쪽을 태그로 해석하지 않는다
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'textarea', 'title', 'head', 'svg', 'iframe', 'object', 'canvas', 'video', 'audio', 'nav', 'footer', 'aside', 'button', 'select', 'dialog']);
const BLOCK = new Set(['address', 'article', 'blockquote', 'body', 'caption', 'center', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'form', 'header', 'hr', 'html', 'li', 'main', 'p', 'pre', 'section', 'summary', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr']);
// 끝 태그를 생략할 수 있는 요소: 여는 태그가 오면 [닫을 요소, 그 너머로는 닫지 않는 경계]
const IMPLIED_END = {
  li: [['li'], ['ul', 'ol']], dt: [['dt', 'dd'], ['dl']], dd: [['dt', 'dd'], ['dl']], option: [['option'], ['select']],
  tr: [['tr', 'td', 'th'], ['table']], td: [['td', 'th'], ['tr', 'table']], th: [['td', 'th'], ['tr', 'table']],
  thead: [['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], ['table']], tbody: [['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], ['table']], tfoot: [['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], ['table']],
};
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', times: '×', divide: '÷', minus: '−', plusmn: '±', deg: '°', permil: '‰', bull: '•', sect: '§', para: '¶', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', larr: '←', rarr: '→', uarr: '↑', darr: '↓', le: '≤', ge: '≥', ne: '≠', asymp: '≈', euro: '€', yen: '¥', pound: '£', cent: '¢', sup2: '²', sup3: '³', frac12: '½', micro: 'µ' };
const MAX_SPAN = 50;

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, name) => {
    if (name[0] !== '#') return ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? whole;
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function parseAttrs(text) {
  const attrs = {};
  for (const m of text.matchAll(/([^\s=\/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) attrs[m[1].toLowerCase()] ??= decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return attrs;
}

// 너그러운 HTML 파서 — { tag, attrs, children } 와 { text } 로 된 나무를 만든다
export function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const top = () => stack.at(-1);
  const closeImplied = ([names, bounds]) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (names.includes(stack[i].tag)) { stack.length = i; return; }
      if (bounds.includes(stack[i].tag)) return;
    }
  };
  const token = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?\]\]>|<[!?][^>]*>|<\/([a-zA-Z][^\s>\/]*)[^>]*>|<([a-zA-Z][^\s>\/]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+|<)/g;
  for (let m; (m = token.exec(html));) {
    if (m[4] != null) top().children.push({ text: decodeEntities(m[4]) });
    else if (m[1]) {
      const tag = m[1].toLowerCase();
      const at = stack.findLastIndex(n => n.tag === tag);
      if (at > 0) stack.length = at;
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      if (IMPLIED_END[tag]) closeImplied(IMPLIED_END[tag]);
      else if (BLOCK.has(tag) || tag === 'table' || tag === 'ul' || tag === 'ol' || /^h[1-6]$/.test(tag)) closeImplied([['p'], ['table', 'td', 'th', 'li', 'div', 'button']]);
      const node = { tag, attrs: parseAttrs(m[3]), children: [] };
      top().children.push(node);
      if (RAW_TEXT.has(tag)) {
        const end = html.slice(token.lastIndex).search(new RegExp(`</${tag}\\b`, 'i'));
        const stop = end < 0 ? html.length : token.lastIndex + end;
        node.children.push({ text: tag === 'title' || tag === 'textarea' ? decodeEntities(html.slice(token.lastIndex, stop)) : '' });
        const close = html.indexOf('>', stop);
        token.lastIndex = close < 0 ? html.length : close + 1;
      } else if (!VOID.has(tag) && !/\/\s*$/.test(m[3])) stack.push(node);
    }
  }
  return root;
}

// ───────────────────────────── 나무 읽기 ─────────────────────────────

export const clean = text => text.replace(/[\s\u00a0\u200b\ufeff]+/g, ' ').trim(); // 줄 바꿈 없는 공백·폭 없는 공백도 공백으로 본다
const isHidden = n => n.attrs.hidden != null || n.attrs['aria-hidden'] === 'true' || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(n.attrs.style || '');
// 사이트 머리말(메뉴가 든 header)은 본문이 아니다. 글 제목이 든 header 는 남긴다.
const isSkipped = n => SKIP.has(n.tag) || isHidden(n) || (n.tag === 'header' && find(n, c => c.tag === 'nav')) || ['navigation', 'contentinfo', 'search'].includes(n.attrs.role);
const isHeading = n => /^h[1-6]$/.test(n.tag);

export function find(node, test) {
  for (const child of node.children || []) {
    if (child.text != null) continue;
    if (test(child)) return child;
    const inner = find(child, test);
    if (inner) return inner;
  }
  return null;
}

export function findAll(node, test, stopAt = () => false, out = []) {
  for (const child of node.children || []) {
    if (child.text != null) continue;
    if (test(child)) out.push(child);
    if (!stopAt(child)) findAll(child, test, stopAt, out);
  }
  return out;
}

function textOf(node, except = () => false) {
  if (node.text != null) return node.text;
  if (isSkipped(node) || except(node)) return '';
  if (node.tag === 'br') return ' ';
  const inner = node.children.map(c => textOf(c, except)).join('');
  return BLOCK.has(node.tag) || isHeading(node) ? ` ${inner} ` : inner;
}

// 본문 영역을 고른다: main → 하나뿐인 article → 흔한 본문 id → body. 고른 영역이 지나치게 짧으면 body 로 되돌린다.
function mainContent(root) {
  const body = find(root, n => n.tag === 'body') || root;
  const articles = findAll(body, n => n.tag === 'article');
  const picked = find(body, n => n.tag === 'main' || n.attrs.role === 'main')
    || (articles.length === 1 ? articles[0] : null)
    || find(body, n => /^(content|contents|main-content|main_content|main|article)$/i.test(n.attrs.id || ''));
  if (!picked) return body;
  return clean(textOf(picked)).length >= Math.min(500, clean(textOf(body)).length / 4) ? picked : body;
}

// ───────────────────────────── Markdown 으로 ─────────────────────────────

export const cellText = text => clean(text).replace(/\|/g, '｜'); // 표 칸 구분자와 겹치지 않게 한다
const span = (cell, name) => Math.max(1, Math.min(MAX_SPAN, parseInt(cell.attrs[name], 10) || 1));

// 병합된 칸을 풀어 네모난 격자로 만든다. 제목 줄의 가로 병합과 세로 병합은 같은 글을 되풀이해 두어, 값이 어느 행·열의 것인지 잃지 않게 한다.
function tableGrid(rows, headerCount) {
  const grid = [];
  rows.forEach((tr, r) => {
    grid[r] ??= [];
    let c = 0;
    for (const cell of tr.children.filter(n => n.tag === 'td' || n.tag === 'th')) {
      while (grid[r][c] !== undefined) c++;
      const text = cellText(textOf(cell));
      const cols = span(cell, 'colspan');
      for (let dr = 0; dr < span(cell, 'rowspan') && r + dr < rows.length; dr++) {
        for (let dc = 0; dc < cols; dc++) (grid[r + dr] ??= [])[c + dc] = dc === 0 || r < headerCount ? text : '';
      }
      c += cols;
    }
  });
  const width = Math.max(0, ...grid.map(row => row.length));
  return grid.map(row => Array.from({ length: width }, (_, c) => row[c] ?? ''));
}

function tableBlocks(table, walk) {
  const isTable = n => n.tag === 'table';
  const isCell = n => n.tag === 'td' || n.tag === 'th';
  const asText = () => findAll(table, isCell, isTable).flatMap(cell => walk(cell));
  // 표 안에 표가 있으면 배치용 표다 — 칸의 내용을 본문처럼 읽는다
  if (find(table, isTable)) return asText();
  const rows = findAll(table, n => n.tag === 'tr', isTable);
  // 제목 줄: thead 안의 줄이거나 th 로만 된 줄이 위에서부터 이어지는 만큼 (모든 줄이 그렇다면 첫 줄만)
  const inHead = new Set(findAll(table, n => n.tag === 'thead', isTable).flatMap(head => head.children));
  let headerCount = rows.findIndex(tr => !inHead.has(tr) && tr.children.some(n => n.tag === 'td'));
  if (headerCount < 1) headerCount = 1;
  const grid = tableGrid(rows, headerCount);
  const body = grid.slice(headerCount).filter(row => row.some(Boolean));
  if (!body.length || grid[0].length < 2) return asText();
  const caption = find(table, n => n.tag === 'caption');
  const blocks = caption && clean(textOf(caption)) ? [clean(textOf(caption))] : [];
  // 제목 줄이 여러 줄이면 열마다 위에서 아래로 이어 붙인다 ("2025년" + "남자" → "2025년 남자")
  const header = grid[0].map((_, c) => [...new Set(grid.slice(0, headerCount).map(row => row[c]).filter(Boolean))].join(' '));
  const line = row => `| ${row.join(' | ')} |`;
  return [...blocks, [line(header), line(header.map(() => '---')), ...body.map(line)].join('\n')];
}

function toBlocks(node) {
  const blocks = [];
  let inline = '';
  const flush = () => {
    const text = clean(inline);
    inline = '';
    if (text) blocks.push(literalLines(text)); // "1. …" 로 시작하는 문단(법령의 호 등)이 목록으로 읽혀 번호를 잃지 않게 한다
  };
  const isList = n => n.tag === 'ul' || n.tag === 'ol';
  const visit = n => {
    if (n.text != null) { inline += n.text; return; }
    if (isSkipped(n)) return;
    if (n.tag === 'br') { inline += ' '; return; }
    if (isHeading(n)) {
      flush();
      const text = clean(textOf(n));
      if (text) blocks.push(`${'#'.repeat(Number(n.tag[1]))} ${text}`);
    } else if (isList(n)) {
      flush();
      // 목록 안의 목록은 같은 목록의 항목으로 편다
      const items = findAll(n, c => c.tag === 'li').map(li => clean(textOf(li, isList))).filter(Boolean);
      if (items.length) blocks.push(items.map(item => `- ${item}`).join('\n'));
    } else if (n.tag === 'table') {
      flush();
      blocks.push(...tableBlocks(n, toBlocks));
    } else if (BLOCK.has(n.tag)) {
      flush();
      n.children.forEach(visit);
      flush();
    } else n.children.forEach(visit);
  };
  node.children.forEach(visit);
  flush();
  return blocks;
}

function metaOf(root) {
  const metas = findAll(root, n => n.tag === 'meta');
  const meta = (...names) => metas.find(m => names.includes((m.attrs.property || m.attrs.name || '').toLowerCase()) && m.attrs.content)?.attrs.content.trim() || '';
  const title = find(root, n => n.tag === 'title');
  const time = find(root, n => n.tag === 'time' && n.attrs.datetime);
  const date = meta('article:published_time', 'og:article:published_time', 'date', 'pubdate', 'dc.date', 'dc.date.issued', 'citation_publication_date') || time?.attrs.datetime || '';
  return {
    title: meta('og:title', 'citation_title') || clean(title ? textOf({ ...title, tag: 'span' }) : ''),
    siteName: meta('og:site_name', 'citation_publisher', 'dc.publisher'),
    publishedAt: date.match(/\d{4}[-./]\d{1,2}[-./]\d{1,2}/)?.[0].replace(/[./]/g, '-').replace(/-(\d)(?=-|$)/g, '-0$1') ?? '',
  };
}

export function htmlToMarkdown(html) {
  const root = parseHtml(String(html ?? ''));
  return { ...metaOf(root), markdown: toBlocks(mainContent(root)).join('\n\n') };
}
