// PDF 원본 위 형광 표시 (FR-PL-012) — poppler 의 pdftotext -bbox-layout 으로 낱말 좌표를 얻어 인용·메모 위치를 찾고,
// lib/pdf_annot.js 로 형광 주석을 덧붙인 사본을 만든다. xpdf 의 pdftotext 에는 -bbox 가 없어 poppler 만 쓴다 (references/web_collect.md).
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { annotatePdf } from './pdf_annot.js';

const CITE_COLOR = [1, 0.92, 0.23]; // 인용 — 노랑
const NOTE_COLOR = [0.62, 0.92, 0.7]; // 메모 — 연두
const BOTH_COLOR = [1, 0.78, 0.4]; // 인용 + 메모 — 주황

let poppler; // 찾은 poppler pdftotext 경로. '' 이면 없다

const safeReaddir = dir => { try { return fs.readdirSync(dir); } catch { return []; } };

// poppler 의 pdftotext 를 찾는다 — PDFTOTEXT_POPPLER, winget 설치 폴더, PATH 순. -v 출력에 Poppler 가 있어야 한다
export function findPoppler() {
  if (poppler !== undefined) return poppler;
  const exe = process.platform === 'win32' ? 'pdftotext.exe' : 'pdftotext';
  const cands = [process.env.PDFTOTEXT_POPPLER];
  const winget = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  for (const pkg of safeReaddir(winget).filter(n => /poppler/i.test(n))) {
    for (const ver of safeReaddir(path.join(winget, pkg)).filter(n => /^poppler-/i.test(n))) cands.push(path.join(winget, pkg, ver, 'Library', 'bin', exe));
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) cands.push(path.join(dir, exe));
  poppler = cands.filter(Boolean).find(file => {
    if (!fs.existsSync(file)) return false;
    const r = spawnSync(file, ['-v'], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
    return /poppler/i.test(`${r.stdout || ''}${r.stderr || ''}`);
  }) || '';
  return poppler;
}

const decodeXml = t => t.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-f]+|#\d+);/gi, (w, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[n.toLowerCase()] ?? String.fromCodePoint(n[1] === 'x' || n[1] === 'X' ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10)));

// PDF 파일 → 페이지마다 { number, width, height, words: [{ text, x1, y1, x2, y2, line }] }. 좌표는 왼쪽 위 원점, pt 단위
export async function pdfWordPages(file) {
  const exe = findPoppler();
  if (!exe) throw Object.assign(new Error('PDF 낱말 좌표를 얻는 poppler pdftotext 가 없습니다'), { missing: true });
  const xml = await new Promise((resolve, reject) => {
    const child = spawn(exe, ['-bbox-layout', file, '-'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    child.stdout.on('data', c => chunks.push(c));
    child.on('error', () => reject(new Error('pdftotext 를 실행하지 못했습니다')));
    child.on('close', code => (code === 0 ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(new Error('PDF 에서 낱말 좌표를 얻지 못했습니다'))));
  });
  const pages = [];
  let page = null;
  let line = 0;
  for (const m of xml.matchAll(/<page width="([\d.]+)" height="([\d.]+)">|<line [^>]*>|<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)) {
    if (m[1] !== undefined) { page = { number: pages.length + 1, width: Number(m[1]), height: Number(m[2]), words: [] }; pages.push(page); line = 0; }
    else if (m[0].startsWith('<line')) line++;
    else if (page) page.words.push({ text: decodeXml(m[7]), x1: Number(m[3]), y1: Number(m[4]), x2: Number(m[5]), y2: Number(m[6]), line });
  }
  return pages;
}

const norm = t => String(t ?? '').normalize('NFKC').replace(/­/g, '').replace(/[\s ]+/g, ' ').trim();

// 페이지의 낱말을 한 줄 글로 잇고, 글자 위치 → 낱말 을 찾을 수 있게 한다
function pageText(page) {
  let text = '';
  const spans = [];
  for (const w of page.words) {
    const t = norm(w.text);
    if (!t) { spans.push(null); continue; }
    if (text) text += ' ';
    spans.push([text.length, text.length + t.length]);
    text += t;
  }
  return { text, spans };
}

function findIn(text, needle, from = 0) {
  if (!needle) return -1;
  let at = text.indexOf(needle, from);
  if (at < 0) at = text.toLowerCase().indexOf(needle.toLowerCase(), from);
  return at;
}

// 글 조각이 놓인 낱말들을 줄 단위 사각형으로 — 못 찾으면 null. 긴 문장은 앞머리만으로도 찾아 본다
export function locateText(page, needle, { after = null } = {}) {
  const { text, spans } = pageText(page);
  const target = norm(needle);
  if (!target || !text) return null;
  let from = 0;
  if (after) { const a = findIn(text, norm(after)); if (a >= 0) from = a; }
  let at = findIn(text, target, from);
  let len = target.length;
  if (at < 0 && from > 0) { at = findIn(text, target); }
  if (at < 0 && target.length > 48) {
    const head = target.slice(0, 48).replace(/\s\S*$/, ''); // 낱말 경계에서 자른다
    at = findIn(text, head);
    len = head.length;
  }
  if (at < 0) return null;
  const hit = page.words.filter((w, i) => spans[i] && spans[i][1] > at && spans[i][0] < at + len);
  const byLine = new Map();
  for (const w of hit) {
    const q = byLine.get(w.line) || { x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 };
    byLine.set(w.line, { x1: Math.min(q.x1, w.x1), y1: Math.min(q.y1, w.y1), x2: Math.max(q.x2, w.x2), y2: Math.max(q.y2, w.y2) });
  }
  return [...byLine.values()];
}

// marks: lib/marks.js 가 만든 참조·메모 목록. 형광을 붙인 PDF 사본과, 위치를 찾은 표시 번호 목록을 돌려준다
export async function markPdf(buffer, marks) {
  const file = path.join(os.tmpdir(), `sourceanchor-mark-${crypto.randomUUID()}.pdf`);
  await fs.promises.writeFile(file, buffer);
  let pages;
  try { pages = await pdfWordPages(file); } finally { await fs.promises.rm(file, { force: true }); }
  const annots = [];
  const found = [];
  for (const m of marks) {
    const page = pages[m.page - 1];
    if (!page) continue;
    const quads = m.kind === 'cell' ? locateText(page, m.text, { after: m.row }) : locateText(page, m.text);
    if (!quads?.length) continue;
    found.push(m.n);
    const kind = m.cites.length && m.notes.length ? 'both' : m.notes.length ? 'note' : 'cite';
    annots.push({
      page: m.page,
      quadsTop: quads,
      color: kind === 'both' ? BOTH_COLOR : kind === 'note' ? NOTE_COLOR : CITE_COLOR,
      title: `[${m.n}] SourceAnchor`,
      contents: markContents(m),
    });
  }
  if (!annots.length) return { data: buffer, found };
  return { data: annotateTop(buffer, annots), found };
}

// 참조·메모를 주석의 내용 글로 — 다른 PDF 보기(Acrobat 등)는 이 글을 보여 준다
export function markContents(m) {
  return [
    ...m.cites.map(c => `인용 ${c.id}: ${c.text}`),
    ...m.notes.map(n => `메모: ${n.text}`),
  ].join('\n');
}

// poppler 좌표(왼쪽 위 원점, 아래로 +y) → PDF 좌표(페이지 상자 기준, 왼쪽 아래 원점). 페이지 상자는 pdf_annot 이 읽어 넘긴다
function annotateTop(buffer, annots) {
  return annotatePdf(buffer, annots.map(a => ({
    ...a,
    quads: page => {
      const [bx1, by1, , by2] = page.box.map(Number);
      const height = by2 - by1;
      if (page.rotate % 360 !== 0) return []; // 회전한 페이지는 좌표를 맞추지 못해 표시를 건너뛴다
      return a.quadsTop.map(q => [bx1 + q.x1, by1 + height - q.y2, bx1 + q.x2, by1 + height - q.y1]);
    },
  })));
}
