// 내려받은 PPT(pptx)를 슬라이드별 Markdown 으로 바꾼다 — 글자는 그대로 두고(요약·수정 없음) 제목·글상자·표 구조만 옮긴다.
// 결과는 lib/ingest.js 의 markdownToDrafts 가 읽는 형식이다. 슬라이드 번호(위치)는 부르는 쪽이 붙인다.
// 파일 구조는 references/pptx_format.md 참고.
import path from 'node:path';
import { splitSentences } from '../public/shared/text.js';
import { cellText, clean, find, findAll, parseHtml } from './html.js';
import { literalLines } from './ingest.js';
import { readZip } from './zip.js';

const SKIP_PLACEHOLDERS = new Set(['sldnum', 'dt', 'ftr', 'hdr', 'sldimg']); // 쪽 번호·날짜·바닥글 — 본문이 아니다
const TITLE_PLACEHOLDERS = new Set(['title', 'ctrtitle']);

const fail = message => Object.assign(new Error(message), { format: true });

// parseHtml 은 태그 이름을 소문자로 바꾼다: <a:tbl> → a:tbl. 이름공간 접두사는 파일마다 다를 수 있어 뒤쪽 이름만 본다.
const local = node => node.tag.slice(node.tag.indexOf(':') + 1);
const named = name => node => local(node) === name;
const isOn = value => value === '1' || value === 'true';
const parseXml = buffer => parseHtml(buffer.toString('utf8'));

// 문단(a:p) 하나의 글: 조각(a:r)의 글(a:t)을 이어 붙인다. 줄 바꿈(a:br)은 공백, 쪽 번호·날짜 필드는 뺀다.
function paragraphText(paragraph) {
  let text = '';
  const visit = node => {
    if (node.text != null) return;
    if (local(node) === 't') text += node.children.map(c => c.text ?? '').join('');
    else if (local(node) === 'br') text += ' ';
    else if (local(node) !== 'fld' || !/^(slidenum|datetime)/i.test(node.attrs.type || '')) node.children.forEach(visit);
  };
  paragraph.children.forEach(visit);
  return clean(text);
}

const paragraphsOf = node => findAll(node, named('p')).map(paragraphText).filter(Boolean);

// 글상자(p:sp) → 제목 자리는 제목, 짧은 항목이 여럿이면 목록, 그 밖에는 문단
function shapeBlocks(shape) {
  const placeholder = (find(shape, named('ph'))?.attrs.type || '').toLowerCase();
  const body = find(shape, named('txbody'));
  if (!body || SKIP_PLACEHOLDERS.has(placeholder)) return [];
  const paragraphs = paragraphsOf(body);
  if (!paragraphs.length) return [];
  if (TITLE_PLACEHOLDERS.has(placeholder)) return [`# ${paragraphs.join(' ')}`];
  // 항목마다 앵커 하나가 되도록 목록으로 옮긴다. 문장이 여럿인 문단이 섞여 있으면 문장 단위로 고를 수 있게 문단으로 둔다.
  if (paragraphs.length > 1 && paragraphs.every(p => splitSentences(p).length <= 1)) return [paragraphs.map(p => `- ${p}`).join('\n')];
  return paragraphs.map(literalLines);
}

// 표(a:tbl) → Markdown 표. 병합된 칸은 이어지는 칸(hMerge·vMerge)으로 자리가 남아 있다. lib/html.js 의 표와 같은 규칙으로 푼다:
// 제목 줄의 가로 병합과 세로 병합은 같은 글을 되풀이해, 값이 어느 행·열의 것인지 잃지 않게 한다.
function tableBlocks(table) {
  const rows = findAll(table, named('tr')).map(tr => tr.children.filter(n => n.tag && local(n) === 'tc'));
  if (!rows.length) return [];
  const span = (cell, name) => Math.max(1, parseInt(cell.attrs[name], 10) || 1);
  // 제목 줄 수: 첫 줄에서 세로로 병합된 칸의 높이. 첫 줄에 가로 병합이 있으면 그 아래 줄까지 제목이다 ("2024년" 아래 "상반기·하반기")
  let headerCount = Math.max(...rows[0].map(cell => span(cell, 'rowspan')));
  if (headerCount === 1 && rows[0].some(cell => span(cell, 'gridspan') > 1)) headerCount = 2;
  headerCount = Math.max(1, Math.min(headerCount, rows.length - 1));

  const grid = rows.map(() => []);
  rows.forEach((row, r) => row.forEach((cell, c) => {
    const above = isOn(cell.attrs.vmerge);
    const left = isOn(cell.attrs.hmerge);
    if (above) grid[r][c] = left && r >= headerCount ? '' : grid[r - 1]?.[c] ?? '';
    else if (left) grid[r][c] = r < headerCount ? grid[r][c - 1] ?? '' : '';
    else grid[r][c] = cellText(paragraphsOf(cell).join(' '));
  }));
  const width = Math.max(...grid.map(row => row.length));
  const body = grid.slice(headerCount).map(row => Array.from({ length: width }, (_, c) => row[c] ?? '')).filter(row => row.some(Boolean));
  if (!body.length || width < 2) return grid.flat().filter(Boolean).map(literalLines);
  const header = Array.from({ length: width }, (_, c) => [...new Set(grid.slice(0, headerCount).map(row => row[c]).filter(Boolean))].join(' '));
  const line = row => `| ${row.join(' | ')} |`;
  return [[line(header), line(header.map(() => '---')), ...body.map(line)].join('\n')];
}

// 슬라이드의 도형을 놓인 순서대로 읽는다. 묶은 도형(p:grpSp) 안으로 들어가고, 대체 내용(mc:AlternateContent)은 한쪽만 읽는다.
function collectBlocks(node, out) {
  for (const child of node.children) {
    if (child.text != null) continue;
    const name = local(child);
    if (name === 'sp') out.push(...shapeBlocks(child));
    else if (name === 'graphicframe') out.push(...findAll(child, named('tbl')).flatMap(tableBlocks));
    else if (name === 'alternatecontent') collectBlocks(child.children.find(c => c.tag && local(c) === 'choice') || child, out);
    else collectBlocks(child, out);
  }
  return out;
}

function slideMarkdown(xml) {
  const blocks = collectBlocks(parseXml(xml), []);
  const isTitle = block => block.startsWith('# ');
  return [...blocks.filter(isTitle), ...blocks.filter(block => !isTitle(block))].join('\n\n'); // 제목 도형이 뒤에 놓여 있어도 제목을 먼저 둔다
}

// 슬라이드 파일을 발표 순서대로: presentation.xml 의 목록(p:sldIdLst)과 관계 파일을 따른다. 없으면 파일 이름의 번호 순서.
function slideNames(zip) {
  const presentation = zip.read('ppt/presentation.xml');
  const relations = zip.read('ppt/_rels/presentation.xml.rels');
  if (presentation && relations) {
    const targets = new Map(findAll(parseXml(relations), named('relationship')).map(n => [n.attrs.id, n.attrs.target || '']));
    const names = findAll(parseXml(presentation), named('sldid'))
      .map(n => targets.get(n.attrs['r:id']))
      .filter(Boolean)
      .map(target => path.posix.normalize(target.startsWith('/') ? target.slice(1) : `ppt/${target}`))
      .filter(name => zip.has(name));
    if (names.length) return names;
  }
  const number = name => Number(name.match(/(\d+)\.xml$/)[1]);
  return zip.names.filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => number(a) - number(b));
}

// → { title, slides: [슬라이드별 Markdown — 글이 없는 슬라이드는 ''] }. 읽지 못하면 사유를 담은 Error(format: true).
export function pptxToMarkdown(data) {
  const zip = readZip(data);
  const names = slideNames(zip);
  if (!names.length) throw fail('ZIP 으로 묶인 파일이지만 PowerPoint 문서(pptx)가 아닙니다');
  const slides = names.map(name => slideMarkdown(zip.read(name)));
  const core = zip.read('docProps/core.xml');
  const firstTitle = slides.map(md => md.match(/^# (.+)$/m)?.[1]).find(Boolean);
  return { title: firstTitle || (core ? coreTitle(parseXml(core)) : ''), slides };
}

// 문서 속성의 제목(dc:title). PowerPoint 가 넣는 기본값("PowerPoint 프레젠테이션")은 제목이 아니다.
function coreTitle(core) {
  const node = find(core, named('title'));
  const title = clean(node ? node.children.map(c => c.text ?? '').join('') : '');
  return /^(powerpoint\s|슬라이드\s*\d+$|slide\s*\d+$)/i.test(title) ? '' : title;
}
