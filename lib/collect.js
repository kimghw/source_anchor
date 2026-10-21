// 에이전트가 채택한 자료를 URL 에서 직접 내려받아 원문 등록에 쓸 값으로 바꾼다 (FR-WB-043).
// 본문은 내려받은 것을 그대로 옮긴다 — 에이전트가 옮겨 적은 글은 받지 않는다. 공개 주소만 허용한다 (NFR-WB-002).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { htmlToMarkdown } from './html.js';
import { literalLines, markdownToDrafts } from './ingest.js';
import { pptxToMarkdown } from './pptx.js';

const FETCH_TIMEOUT_MS = Number(process.env.COLLECT_TIMEOUT_MS) || 30_000;
const MAX_BYTES = 50 * 1024 * 1024; // 그림이 많은 PPT 는 수십 MB 다
const ZIP_MAGIC = Buffer.from('504b0304', 'hex'); // pptx 를 비롯한 Office 문서(OOXML)는 ZIP 이다
const OLE_MAGIC = Buffer.from('d0cf11e0a1b11ae1', 'hex'); // 예전 Office 형식(.ppt·.doc·.xls)과 암호가 걸린 Office 문서
const MAX_REDIRECTS = 5;
const MIN_BODY_CHARS = 200; // 이보다 짧으면 본문을 얻지 못한 것으로 본다 (스크립트로 그리는 페이지, 접근 차단 안내문)
const USER_AGENT = 'Mozilla/5.0 (compatible; SourceAnchor/0.1; local research tool)';

const fail = message => Object.assign(new Error(message), { collect: true });

// ───────────────────────────── 공개 주소 확인 ─────────────────────────────

export function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const lower = address.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  return lower === '::' || lower === '::1' || lower.startsWith('::ffff:') || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}

// 이름을 푼 주소 가운데 하나라도 이 컴퓨터·내부망이면 연결하지 않는다. 연결에 쓰는 조회 자체를 막으므로 확인 뒤에 주소가 바뀌어도 통하지 않는다.
function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (addresses.some(a => isPrivateAddress(a.address))) return callback(fail(`이 컴퓨터·내부망 주소로는 수집하지 않습니다: ${hostname}`));
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

function checkUrl(raw, allowPrivate) {
  let url;
  try { url = new URL(raw); } catch { throw fail('URL 형식이 아닙니다'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw fail('http·https 주소만 수집합니다');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && net.isIP(host) && isPrivateAddress(host)) throw fail(`이 컴퓨터·내부망 주소로는 수집하지 않습니다: ${host}`);
  return url;
}

// ───────────────────────────── 내려받기 ─────────────────────────────

function get(url, allowPrivate) {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).get(url, {
      lookup: allowPrivate ? undefined : publicLookup,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain;q=0.9,*/*;q=0.5', 'Accept-Language': 'ko,en;q=0.8', 'Accept-Encoding': 'gzip, deflate, br' },
    }, res => {
      const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
      const body = encoding === 'gzip' ? res.pipe(zlib.createGunzip()) : encoding === 'deflate' ? res.pipe(zlib.createInflate()) : encoding === 'br' ? res.pipe(zlib.createBrotliDecompress()) : res;
      const chunks = [];
      let size = 0;
      body.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BYTES) return req.destroy(fail(`파일이 너무 큽니다 (${MAX_BYTES / 1024 / 1024}MB 초과)`));
        chunks.push(chunk);
      });
      body.on('error', reject);
      body.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: Buffer.concat(chunks) }));
    });
    const timer = setTimeout(() => req.destroy(fail(`응답이 ${Math.round(FETCH_TIMEOUT_MS / 1000)}초를 넘었습니다`)), FETCH_TIMEOUT_MS);
    req.on('close', () => clearTimeout(timer));
    req.on('error', err => reject(err.collect ? err : fail(`연결하지 못했습니다 (${err.code || err.message})`)));
  });
}

async function download(raw, allowPrivate) {
  let url = checkUrl(raw, allowPrivate);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await get(url, allowPrivate);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      url = checkUrl(new URL(res.headers.location, url).href, allowPrivate); // 리디렉션으로 내부 주소에 닿는 것도 막는다
      continue;
    }
    if (res.status !== 200) throw fail(`서버가 ${res.status} 로 응답했습니다`);
    return { url: url.href, contentType: String(res.headers['content-type'] || '').toLowerCase(), data: res.data };
  }
  throw fail('리디렉션이 너무 많습니다');
}

// 글자 집합: 응답 머리말 → 문서 앞부분의 meta → UTF-8. 국내 기관 페이지에는 EUC-KR 이 남아 있다.
function decodeText(data, contentType) {
  const head = data.subarray(0, 4096).toString('latin1');
  const label = contentType.match(/charset=["']?([\w-]+)/)?.[1] || head.match(/<meta[^>]+charset=["']?\s*([\w-]+)/i)?.[1] || 'utf-8';
  try {
    return new TextDecoder(label).decode(data);
  } catch {
    return new TextDecoder('utf-8').decode(data);
  }
}

// ───────────────────────────── 본문이 다른 주소에 있는 페이지 ─────────────────────────────

// 본문을 담은 안쪽 문서의 주소를 찾는다. 같은 사이트 안에서만 따라간다.
//  - 국가법령정보센터(law.go.kr): 껍데기(lsInfoP.do)가 본문을 lsInfoR.do(조문 — 시행일 efYd 가 있어야 한다)나
//    lsRvsDocInfoR.do(제정·개정이유)에서 불러온다 (references/web_collect.md)
//  - 그 밖: 본문이 없는 껍데기 페이지가 품은 첫 iframe
function innerDocumentUrl(url, html, thin) {
  const here = new URL(url);
  if (/(^|\.)law\.go\.kr$/.test(here.hostname) && /\/lsInfoP\.do$/.test(here.pathname)) {
    const lsiSeq = here.searchParams.get('lsiSeq');
    const efYd = here.searchParams.get('efYd') || html.match(/\befYd\s*=\s*'(\d{8})'/)?.[1];
    if (lsiSeq && here.searchParams.get('viewCls') === 'lsRvsDocInfoR') return `${here.origin}/LSW/lsRvsDocInfoR.do?lsiSeq=${lsiSeq}`;
    return lsiSeq && efYd ? `${here.origin}/LSW/lsInfoR.do?lsiSeq=${lsiSeq}&efYd=${efYd}` : null;
  }
  if (!thin) return null;
  const src = html.match(/<i?frame\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/i)?.[1];
  if (!src || /^(about:|javascript:|data:)/i.test(src)) return null;
  const next = new URL(src.replace(/&amp;/g, '&'), here);
  return next.hostname === here.hostname ? next.href : null;
}

// HTML 을 Markdown 으로 바꾸되, 본문이 안쪽 문서에 있으면 두 번까지 따라 들어간다. 보관할 원본(data)은 본문을 얻은 문서다.
async function readHtml({ url, text, data }, allowPrivate) {
  let page = { ...htmlToMarkdown(text), data };
  for (let hop = 0; hop < 2; hop++) {
    const next = innerDocumentUrl(url, text, page.markdown.length < MIN_BODY_CHARS);
    if (!next) break;
    const inner = await download(next, allowPrivate);
    ({ url } = inner);
    text = decodeText(inner.data, inner.contentType);
    const innerPage = htmlToMarkdown(text);
    page = { ...innerPage, title: page.title || innerPage.title, siteName: page.siteName || innerPage.siteName, publishedAt: page.publishedAt || innerPage.publishedAt, data: inner.data };
  }
  return page;
}

// ───────────────────────────── PDF ─────────────────────────────

// pdftotext(poppler·xpdf)가 있으면 PDF 를 페이지 단위 글로 바꾼다. Windows 에서는 Git 에 딸려 온 것도 찾는다.
function findPdfToText() {
  if (process.env.PDFTOTEXT) return process.env.PDFTOTEXT;
  const exe = process.platform === 'win32' ? 'pdftotext.exe' : 'pdftotext';
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const nearGit = dirs.filter(dir => fs.existsSync(path.join(dir, process.platform === 'win32' ? 'git.exe' : 'git'))).map(dir => path.join(dir, '..', 'mingw64', 'bin'));
  return [...dirs, ...nearGit].map(dir => path.join(dir, exe)).find(file => fs.existsSync(file)) ?? null;
}

let pdfToText;
async function pdfPages(data) {
  pdfToText ??= findPdfToText() || '';
  if (!pdfToText) throw fail('PDF 를 글로 바꾸는 pdftotext 를 찾지 못했습니다');
  const file = path.join(os.tmpdir(), `sourceanchor-${crypto.randomUUID()}.pdf`);
  await fs.promises.writeFile(file, data);
  try {
    const text = await new Promise((resolve, reject) => {
      const child = spawn(pdfToText, ['-enc', 'UTF-8', file, '-'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = [];
      child.stdout.on('data', chunk => chunks.push(chunk));
      child.on('error', () => reject(fail('pdftotext 를 실행하지 못했습니다')));
      child.on('close', code => (code === 0 ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(fail('PDF 에서 글을 꺼내지 못했습니다 (암호가 걸렸거나 손상된 파일)'))));
    });
    return text.split('\f');
  } finally {
    await fs.promises.rm(file, { force: true });
  }
}

// ───────────────────────────── PPT ─────────────────────────────

// pptx 를 슬라이드별 블록 초안으로 바꾼다. 위치는 슬라이드 번호로 남긴다 (FR-PL-004)
function pptxSlides(data) {
  let deck;
  try {
    deck = pptxToMarkdown(data);
  } catch (err) {
    throw err.format ? fail(`${err.message} — 웹 페이지·PDF·PPT(pptx)·텍스트만 수집합니다`) : err;
  }
  if (deck.slides.join('').length < MIN_BODY_CHARS) throw fail('PPT 에서 글을 얻지 못했습니다 (그림으로 된 슬라이드일 수 있습니다)');
  return { title: deck.title, drafts: deck.slides.flatMap((markdown, i) => markdownToDrafts(markdown).map(d => ({ ...d, loc: { slide: i + 1 } }))) };
}

// ───────────────────────────── 외부 인터페이스 ─────────────────────────────

// 내려받거나 올린 파일의 바이트를 본문으로 바꾼다 → { type, title, publisher?, publishedAt?, drafts | markdown, snapshot }.
// web({ url, allowPrivate })이 있으면 내려받은 페이지다 — 본문이 안쪽 문서에 있을 때 같은 사이트 안에서 따라 들어간다. 올린 파일은 따라가지 않는다.
// minChars 보다 짧은 본문은 얻지 못한 것으로 본다(내려받은 페이지는 MIN_BODY_CHARS — 스크립트로 그리는 페이지·차단 안내문). 기준 문서(lib/guides.js)도 이 변환기를 쓴다.
export async function convertDocument({ data, contentType = '', name = '', web = null, minChars = MIN_BODY_CHARS }) {
  const isPdf = contentType.includes('application/pdf') || data.subarray(0, 5).toString('latin1') === '%PDF-';
  if (isPdf) {
    const pages = await pdfPages(data);
    // 위치는 페이지로 남긴다 (FR-PL-004)
    const drafts = pages.flatMap((text, i) => markdownToDrafts(literalLines(text)).map(d => ({ ...d, loc: { page: i + 1 } })));
    if (drafts.reduce((sum, d) => sum + (d.text || '').length, 0) < minChars) throw fail('PDF 에서 글을 얻지 못했습니다 (그림으로 된 PDF 일 수 있습니다)');
    return { type: 'pdf', title: name, drafts, snapshot: { ext: 'pdf', data } };
  }
  if (data.subarray(0, 4).equals(ZIP_MAGIC)) {
    const deck = pptxSlides(data);
    return { type: 'pptx', title: deck.title || name, drafts: deck.drafts, snapshot: { ext: 'pptx', data } };
  }
  if (data.subarray(0, 8).equals(OLE_MAGIC)) throw fail('예전 Office 형식(.ppt·.doc·.xls)이거나 암호가 걸린 파일이라 읽지 못합니다 — 같은 자료의 pptx 나 PDF 판을 찾으세요');

  const text = decodeText(data, contentType);
  if (contentType.includes('html') || /^\s*(<!doctype html|<html|<div|<table)/i.test(text)) {
    const page = web ? await readHtml({ url: web.url, text, data }, web.allowPrivate) : { ...htmlToMarkdown(text), data };
    if (page.markdown.length < minChars) throw fail('페이지에서 본문을 얻지 못했습니다 (스크립트로 그리는 페이지이거나 접근이 막힌 페이지일 수 있습니다)');
    return { type: 'web', title: page.title || name, publisher: page.siteName || '', publishedAt: page.publishedAt || '', markdown: page.markdown, snapshot: { ext: 'html', data: page.data } };
  }
  if (contentType.startsWith('text/') || !contentType) {
    if (text.trim().length < minChars) throw fail('본문이 비어 있습니다');
    return { type: 'text', title: name, markdown: text, snapshot: { ext: 'txt', data } };
  }
  throw fail(`지원하지 않는 형식입니다 (${contentType.split(';')[0]}) — 웹 페이지·PDF·PPT(pptx)·텍스트만 수집합니다`);
}

// item: 에이전트가 채택한 자료 { url, title?, publisher?, published_at?, reason? }
// → lib/store.js addSource 에 넘길 값. 실패하면 사유를 담은 Error(collect: true)를 던진다.
export async function collectSource(item, { allowPrivate = false } = {}) {
  const { url, contentType, data } = await download(String(item.url || '').trim(), allowPrivate);
  const base = {
    url,
    title: String(item.title || '').trim(),
    publisher: String(item.publisher || '').trim() || new URL(url).hostname,
    publishedAt: String(item.published_at || '').trim(),
    adoptReason: String(item.reason || '').trim().slice(0, 300),
    method: '에이전트가 검색해 채택 · 서버가 URL 에서 직접 내려받음',
  };
  const { title, publisher, publishedAt, ...body } = await convertDocument({ data, contentType, name: path.basename(new URL(url).pathname), web: { url, allowPrivate } });
  return { ...base, ...body, title: base.title || title, publisher: String(item.publisher || '').trim() || publisher || base.publisher, publishedAt: base.publishedAt || publishedAt };
}
