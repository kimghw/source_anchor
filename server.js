// SourceAnchor 로컬 서버 — 정적 화면, 작업공간 JSON API, 에이전트 채팅 스트림.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgent } from './agent.js';
import { describeAgentConfig, discoverSkills, saveAgentConfig } from './lib/agent_config.js';
import { downloadDisposition } from './lib/http_names.js';
import { markedFile } from './lib/marked_file.js';
import * as store from './lib/store.js';

const PORT = Number(process.env.PORT) || 8105;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MAX_BODY = 5 * 1024 * 1024;
const GUIDE_BODY_LIMIT = 8 * 1024 * 1024; // 기준 문서 올리기 — 5MiB 파일의 base64(약 6.7MiB)와 서지정보 (FR-WB-085)
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const agent = createAgent({ loadState: store.loadState, addSource: store.addSource, bookAgentState: store.bookAgentState, bookGuides: store.fullGuides });

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

// 보관한 원본은 남이 만든 파일이다 — 이 서버의 출처로 스크립트가 돌거나 밖으로 요청이 나가지 않게 연다 (FR-PL-011).
// 웹 스냅샷은 sandbox 로 출처를 떼고 스크립트·외부 자원을 막아 보여 주고, PDF 는 브라우저 보기로, 그 밖의 파일은 내려받게 한다.
const FILE_TYPES = { '.html': 'text/html', '.pdf': 'application/pdf', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain' };
function sendSourceFile(res, { data, name, utf8 = false, downloadName }) {
  const type = FILE_TYPES[path.extname(name)];
  res.writeHead(200, {
    'Content-Type': utf8 && type === 'text/html' ? 'text/html; charset=utf-8' : type || 'application/octet-stream', // 표시를 입힌 스냅샷은 UTF-8 로 다시 쓴 것이다
    'Content-Disposition': type ? `inline; filename="${name}"` : downloadDisposition(name, downloadName),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...(type === 'application/pdf' ? {} : { 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:" }),
  });
  res.end(data);
}

async function readBody(req, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('요청 본문이 너무 큽니다'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  } catch {
    throw Object.assign(new Error('JSON 본문을 해석하지 못했습니다'), { status: 400 });
  }
}

// 다른 사이트의 페이지가 이 로컬 서버로 요청을 보내 보고서를 바꾸거나 API 비용을 쓰게 하지 못하도록,
// 상태를 바꾸는 요청은 같은 출처의 JSON 요청만 받는다.
function isTrustedWrite(req) {
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) return false;
  return (req.headers['content-type'] || '').startsWith('application/json');
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  if (req.method !== 'GET' && !isTrustedWrite(req)) return sendJson(res, 403, { error: '허용되지 않은 출처의 요청입니다' });

  if (route === 'GET /api/state') return sendJson(res, 200, await store.loadState(url.searchParams.get('doc') || undefined));
  if (route === 'PUT /api/report') return sendJson(res, 200, { ok: true, ...(await store.saveReport(await readBody(req))) });
  // 장(하위문서): 새로 만들기 · 삭제 (여는 것은 GET /api/state?doc=<id>)
  if (route === 'POST /api/reports') return sendJson(res, 201, await store.createReport(await readBody(req)));
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/reports/')) return sendJson(res, 200, await store.deleteReport(decodeURIComponent(url.pathname.slice('/api/reports/'.length))));
  // 보고서(메인문서): 보고서 화면 상태 · 새로 만들기 · 삭제 · 목차 저장 (FR-WB-070 ~ 073)
  if (route === 'GET /api/book') return sendJson(res, 200, await store.loadBookState(url.searchParams.get('report') || undefined));
  if (route === 'PUT /api/book') return sendJson(res, 200, await store.saveToc(await readBody(req)));
  // 보고서 에이전트의 장 추가 수정안 반영 — 목차의 원하는 자리에 빈 장을 만든다 (FR-WB-076)
  if (route === 'POST /api/book/chapters') return sendJson(res, 201, await store.insertChapter(await readBody(req)));
  if (route === 'POST /api/books') return sendJson(res, 201, await store.createBook(await readBody(req)));
  // 사용자 지정 문서 — 목록·만들기·읽기·저장·삭제·장의 원문으로 등록 (FR-WB-088, 089)
  const custom = url.pathname.match(/^\/api\/books\/([^/]+)\/custom(?:\/([^/]+))?(?:\/(register))?$/);
  if (custom) {
    const [bookId, id, action] = [decodeURIComponent(custom[1]), custom[2] && decodeURIComponent(custom[2]), custom[3]];
    if (req.method === 'GET' && !id) return sendJson(res, 200, { custom: await store.customDocList(bookId) });
    if (req.method === 'POST' && !id) return sendJson(res, 201, await store.createCustomDoc({ ...(await readBody(req)), bookId }));
    if (req.method === 'POST' && id && action) return sendJson(res, 201, await store.registerCustomDoc({ ...(await readBody(req)), bookId, id }));
    if (req.method === 'GET' && id && !action) return sendJson(res, 200, { doc: await store.getCustomDoc(bookId, id) });
    if (req.method === 'PUT' && id && !action) return sendJson(res, 200, await store.saveCustomDoc({ ...(await readBody(req)), bookId, id }));
    if (req.method === 'DELETE' && id && !action) return sendJson(res, 200, await store.deleteCustomDoc(bookId, id));
  }
  // 양식 — 목록 · 올리기(base64) · 읽기 · 저장 · 삭제 · 올린 원본/값을 기입한 사본 내려받기 (FR-WB-090 ~ 092)
  const form = url.pathname.match(/^\/api\/books\/([^/]+)\/forms(?:\/([^/]+))?(?:\/(original|export))?$/);
  if (form) {
    const [bookId, id, file] = [decodeURIComponent(form[1]), form[2] && decodeURIComponent(form[2]), form[3]];
    if (req.method === 'GET' && !id) return sendJson(res, 200, { forms: await store.formList(bookId) });
    if (req.method === 'POST' && !id) return sendJson(res, 201, await store.addForm({ ...(await readBody(req, GUIDE_BODY_LIMIT)), bookId }));
    if (req.method === 'GET' && id && file) return sendSourceFile(res, await store.readFormFile(bookId, id, file));
    if (req.method === 'GET' && id) return sendJson(res, 200, { form: await store.getForm(bookId, id) });
    if (req.method === 'PUT' && id && !file) return sendJson(res, 200, await store.saveForm({ ...(await readBody(req)), bookId, id }));
    if (req.method === 'DELETE' && id && !file) return sendJson(res, 200, await store.deleteForm(bookId, id));
  }
  // 기준 문서 — 목록은 GET /api/book 에 실려 간다. 여기서는 하나의 본문 · 등록(파일은 base64 로 한 요청에 하나) · 종류/제목 고치기 · 삭제 · 보관 파일 열기 (FR-WB-085)
  const guide = url.pathname.match(/^\/api\/books\/([^/]+)\/guides(?:\/([^/]+))?(?:\/(original|markdown))?$/);
  if (guide) {
    const [bookId, id, file] = [decodeURIComponent(guide[1]), guide[2] && decodeURIComponent(guide[2]), guide[3]];
    if (req.method === 'POST' && !id) return sendJson(res, 201, await store.addGuide({ ...(await readBody(req, GUIDE_BODY_LIMIT)), bookId }));
    if (req.method === 'GET' && id && file) return sendSourceFile(res, await store.readGuideFile(bookId, id, file));
    if (req.method === 'GET' && id) return sendJson(res, 200, await store.getGuide(bookId, id));
    if (req.method === 'PUT' && id && !file) return sendJson(res, 200, await store.updateGuide({ ...(await readBody(req)), bookId, id }));
    if (req.method === 'DELETE' && id && !file) return sendJson(res, 200, await store.deleteGuide(bookId, id));
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/books/')) return sendJson(res, 200, await store.deleteBook(decodeURIComponent(url.pathname.slice('/api/books/'.length))));
  // 화면을 다시 열 때 마지막으로 보던 자리 (FR-WB-074)
  if (route === 'GET /api/place') return sendJson(res, 200, await store.lastPlace());
  // 원문은 문서마다 따로 둔다: 추가는 본문의 docId, 삭제는 ?doc=<id> 로 문서를 가리킨다
  if (route === 'POST /api/sources') {
    const { docId, title, type, publisher, publishedAt, url: sourceUrl, markdown } = await readBody(req);
    return sendJson(res, 201, await store.addSource({ docId, title, type, publisher, publishedAt, url: sourceUrl, markdown }));
  }
  // 자료 하나에 딸린 조작: 채택 거부(이유 고치기 포함) · 거부 취소 · 보관한 원본·Markdown 파일 열기(원본은 ?marks=1 로 참조·메모 표시를 입힌 사본) ·
  // 참조·메모 목록 · 메모 추가/고치기/삭제 (FR-PL-011, 012, FR-WB-081)
  const sub = url.pathname.match(/^\/api\/sources\/([^/]+)\/(reject|restore|original|markdown|marks|notes)(?:\/([^/]+))?$/);
  if (sub) {
    const [id, action, noteId] = [decodeURIComponent(sub[1]), sub[2], sub[3] && decodeURIComponent(sub[3])];
    const docId = url.searchParams.get('doc');
    if (req.method === 'POST' && action === 'reject') return sendJson(res, 200, await store.rejectSource({ ...(await readBody(req)), id }));
    if (req.method === 'POST' && action === 'restore') return sendJson(res, 200, await store.restoreSource({ ...(await readBody(req)), id }));
    if (req.method === 'GET' && action === 'markdown') return sendSourceFile(res, await store.readSourceFile(docId, id, 'markdown'));
    if (req.method === 'GET' && action === 'original') {
      const file = await store.readSourceFile(docId, id, 'original');
      return sendSourceFile(res, url.searchParams.get('marks') ? await markedFile(file, await store.sourceMarks(docId, id)) : file);
    }
    if (req.method === 'GET' && action === 'marks') return sendJson(res, 200, await store.sourceMarks(docId, id));
    if (action === 'notes') {
      if (req.method === 'POST' && !noteId) return sendJson(res, 201, await store.addNote({ ...(await readBody(req)), id }));
      if (req.method === 'PUT' && noteId) return sendJson(res, 200, await store.updateNote({ ...(await readBody(req)), id, noteId }));
      if (req.method === 'DELETE' && noteId) return sendJson(res, 200, await store.deleteNote(docId, id, noteId));
    }
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/sources/')) {
    await store.deleteSource(url.searchParams.get('doc'), decodeURIComponent(url.pathname.slice('/api/sources/'.length)));
    return sendJson(res, 200, { ok: true });
  }
  if (route === 'GET /api/agent/status') return sendJson(res, 200, await agent.status());
  // 에이전트 연결 설정(MCP 서버·스킬). discovered 는 표준 위치에서 찾은, 연결할 수 있는 스킬 목록이다.
  if (route === 'GET /api/agent/config') return sendJson(res, 200, { ...(await describeAgentConfig()), discovered: await discoverSkills() });
  if (route === 'PUT /api/agent/config') {
    await saveAgentConfig(await readBody(req));
    return sendJson(res, 200, { ...(await describeAgentConfig()), discovered: await discoverSkills() });
  }
  if (route === 'POST /api/chat/stop') return sendJson(res, 200, agent.stop((await readBody(req)).conversationId));
  if (route === 'POST /api/chat') {
    const body = await readBody(req);
    if (typeof body.text !== 'string' || !body.text.trim()) return sendJson(res, 400, { error: 'text 가 필요합니다' });
    // 이벤트를 한 줄에 하나씩 JSON 으로 흘려보낸다 (NDJSON)
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const emit = event => { if (!res.writableEnded) res.write(JSON.stringify(event) + '\n'); };
    let conversationId = body.conversationId;
    res.on('close', () => { if (!res.writableEnded) agent.stop(conversationId); });
    try {
      await agent.send(body, event => {
        if (event.t === 'start') conversationId = event.conversationId;
        emit(event);
      });
    } catch (err) {
      emit({ t: 'error', message: err.message });
      emit({ t: 'done' });
    }
    return res.end();
  }
  return sendJson(res, 404, { error: '없는 API 입니다' });
}

async function handleStatic(res, url) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.resolve(PUBLIC_DIR, rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: '접근할 수 없는 경로입니다' });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: '파일을 찾지 못했습니다' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (req.method === 'GET') await handleStatic(res, url);
    else sendJson(res, 405, { error: '허용되지 않은 메서드입니다' });
  } catch (err) {
    if (!err.status) console.error(err);
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`SourceAnchor → http://localhost:${PORT}`);
});
