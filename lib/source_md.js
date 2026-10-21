// 원문 하나를 Markdown 파일 내용으로 바꾼다 — 내려받은 원본과 한 쌍으로 보관하는 파일이다 (DR-PL-002).
// 화면·근거가 쓰는 블록에서 만들므로 문장과 수치는 화면에 보이는 원문과 같다. 요약하거나 고치지 않는다.
import path from 'node:path';
import { blockLoc } from '../public/shared/model.js';
import { literalLines } from './ingest.js';

const cellText = text => String(text ?? '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '｜'); // 표 구분자와 겹치는 글자는 lib/html.js 와 같은 규칙으로 바꾼다
const row = cells => `| ${cells.map(cellText).join(' | ')} |`;

function tableLines(block, previous) {
  const t = block.table;
  const caption = [t.title, t.unit && `(단위: ${t.unit})`].filter(Boolean).join(' ');
  const titled = previous?.kind === 'heading' && t.title && previous.sentences.some(s => s.text.includes(t.title)); // 바로 위 제목이 곧 표 제목이면 다시 적지 않는다
  return [
    ...(caption && !titled ? [caption, ''] : []),
    row(t.columns),
    row(t.columns.map(() => '---')),
    ...t.rows.map(r => row([r.header, ...r.cells.map(c => c.text)])),
    ...block.sentences.flatMap(s => ['', literalLines(s.text)]), // 표의 주석
  ];
}

function blockLines(block, previous) {
  if (block.kind === 'table') return tableLines(block, previous);
  if (block.kind === 'heading') return [`${'#'.repeat(block.level || 2)} ${block.sentences.map(s => s.text).join(' ')}`];
  if (block.kind === 'list') return block.sentences.map(s => `- ${s.text}`);
  return [literalLines(block.sentences.map(s => s.text).join(' '))]; // "1. …" 처럼 시작하는 본문이 목록으로 읽히지 않게 한다
}

export function sourceMarkdown(source) {
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

  // 페이지(PDF)·슬라이드(PPT)가 바뀌는 곳에 위치 표시를 남긴다. 웹·텍스트는 문단마다 위치가 달라 표시하지 않는다.
  let lastLoc = null;
  source.blocks.forEach((block, i) => {
    const paged = block.loc?.page != null || block.loc?.slide != null;
    const loc = paged ? blockLoc(source, block) : null;
    if (loc && loc !== lastLoc) lines.push(`<!-- ${loc} -->`, '');
    lastLoc = loc ?? lastLoc;
    const body = blockLines(block, source.blocks[i - 1]);
    if (body.length) lines.push(...body, '');
  });
  return lines.join('\n');
}
