// 원문 하나를 Markdown 파일 내용으로 바꾼다 — 내려받은 원본과 한 쌍으로 보관하는 파일이다 (DR-PL-002).
// 화면·근거가 쓰는 블록에서 만들므로 문장과 수치는 화면에 보이는 원문과 같다. 요약하거나 고치지 않는다.
// ids: true — 문장마다 줄 앞에 [ID] 를 적고 문단의 문장은 한 줄에 하나씩, 표는 위에 표 블록 ID 를 둔다. 기준 문서의 Markdown 파일 형식이다 (DR-WB-006).
//   구조 계층(lib/guide_outline.js)이 있으면 머리말 다음에 구조 목록(<!-- outline --> … <!-- /outline -->)을 두고 제목은 그 깊이만큼의 # 로 적는다
import path from 'node:path';
import { blockLoc } from '../public/shared/model.js';
import { outlineOf } from './guide_outline.js';
import { literalLines } from './ingest.js';

const cellText = text => String(text ?? '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '｜'); // 표 구분자와 겹치는 글자는 lib/html.js 와 같은 규칙으로 바꾼다
const row = cells => `| ${cells.map(cellText).join(' | ')} |`;

const tagged = (s, ids) => (ids ? `[${s.id}] ${s.text}` : s.text);

function tableLines(block, previous, ids) {
  const t = block.table;
  const caption = [t.title, t.unit && `(단위: ${t.unit})`].filter(Boolean).join(' ');
  const titled = previous?.kind === 'heading' && t.title && previous.sentences.some(s => s.text.includes(t.title)); // 바로 위 제목이 곧 표 제목이면 다시 적지 않는다
  return [
    ...(ids ? [`<!-- table ${block.id} -->`] : []),
    ...(caption && !titled ? [caption, ''] : []),
    row(t.columns),
    row(t.columns.map(() => '---')),
    ...t.rows.map(r => row([r.header, ...r.cells.map(c => c.text)])),
    ...block.sentences.flatMap(s => ['', ids ? tagged(s, ids) : literalLines(s.text)]), // 표의 주석
  ];
}

function blockLines(block, previous, ids) {
  if (block.kind === 'table') return tableLines(block, previous, ids);
  if (block.kind === 'heading') return [`${'#'.repeat(ids && block.depth ? Math.min(block.depth, 6) : block.level || 2)} ${block.sentences.map(s => tagged(s, ids)).join(' ')}`];
  if (block.kind === 'list') return block.sentences.map(s => `- ${tagged(s, ids)}`);
  if (ids) return block.sentences.map(s => tagged(s, ids)); // [ID] 로 시작하는 줄은 목록·제목 표시로 읽히지 않는다
  return [literalLines(block.sentences.map(s => s.text).join(' '))]; // "1. …" 처럼 시작하는 본문이 목록으로 읽히지 않게 한다
}

export function sourceMarkdown(source, { ids = false } = {}) {
  const meta = {
    id: source.id,
    version: source.version,
    type: source.type,
    title: source.title,
    publisher: source.publisher || '미상',
    published: source.publishedAt || '미상',
    url: source.url || '',
    collected: source.collectedAt,
    method: source.method || '',
    adopt_reason: source.adoptReason || '',
    original: source.snapshot ? path.posix.basename(source.snapshot) : '', // 붙여 넣은 원문은 내려받은 원본이 없다
    hash: source.hash,
  };
  const lines = ['---', ...Object.entries(meta).map(([key, value]) => `${key}: ${JSON.stringify(String(value ?? ''))}`), '---', ''];
  const outline = ids ? outlineOf(source.blocks, block => blockLoc(source, block)) : [];
  if (outline.length) lines.push('<!-- outline -->', ...outline.map(n => `${'  '.repeat(n.depth - 1)}- [${n.id}] ${n.title}${n.loc ? ` · ${n.loc}` : ''}`), '<!-- /outline -->', '');

  // 페이지(PDF)·슬라이드(PPT)가 바뀌는 곳에 위치 표시를 남긴다. 웹·텍스트는 문단마다 위치가 달라 표시하지 않는다.
  let lastLoc = null;
  source.blocks.forEach((block, i) => {
    const paged = block.loc?.page != null || block.loc?.slide != null;
    const loc = paged ? blockLoc(source, block) : null;
    if (loc && loc !== lastLoc) lines.push(`<!-- ${loc} -->`, '');
    lastLoc = loc ?? lastLoc;
    const body = blockLines(block, source.blocks[i - 1], ids);
    if (body.length) lines.push(...body, '');
  });
  return lines.join('\n');
}
