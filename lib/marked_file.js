// 참조·메모 표시를 입힌 원본 (FR-PL-012) — 웹 스냅샷은 <mark> 를 끼운 HTML(UTF-8)로, PDF 는 형광 주석을 덧붙인 사본으로.
// 그 밖의 형식(텍스트·PPT)은 원본 그대로다. 보관한 파일은 바꾸지 않는다. 같은 원본·같은 표시 목록이면 만든 것을 다시 쓴다.
import crypto from 'node:crypto';
import { markHtml } from './html_marks.js';
import { markPdf } from './pdf_marks.js';

const cache = new Map(); // 키 → { data, name, utf8, found, missing }
const CACHE_MAX = 12;

function decodeHtml(data) {
  const head = data.subarray(0, 4096).toString('latin1');
  const label = head.match(/<meta[^>]+charset=["']?\s*([\w-]+)/i)?.[1] || 'utf-8';
  try { return new TextDecoder(label).decode(data); } catch { return new TextDecoder('utf-8').decode(data); }
}

// { data, name } (store.readSourceFile 의 원본) + marks (lib/marks.js) → { data, name, utf8?, found: [표시 번호], missing?: 사유 }
export async function markedFile({ data, name }, marks) {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext !== 'html' && ext !== 'pdf') return { data, name, found: [] };
  const key = `${name}:${crypto.createHash('sha256').update(data).digest('hex').slice(0, 24)}:${crypto.createHash('sha256').update(JSON.stringify(marks)).digest('hex').slice(0, 24)}`;
  if (cache.has(key)) return cache.get(key);
  let result;
  if (ext === 'html') {
    const { html, found } = markHtml(decodeHtml(data), marks);
    result = { data: Buffer.from(html, 'utf8'), name, utf8: true, found };
  } else {
    try {
      const { data: marked, found } = await markPdf(data, marks);
      result = { data: marked, name, found };
    } catch (err) {
      result = { data, name, found: [], missing: err.missing ? 'PDF 위 형광은 poppler 의 pdftotext 가 있어야 합니다' : err.message };
    }
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return result;
}
