// SourceAnchor 로컬 서버 — 정적 화면, 작업공간 JSON API, 에이전트 채팅 스트림.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgent } from './agent.js';
import { describeAgentConfig, discoverSkills, saveAgentConfig } from './lib/agent_config.js';
import { PREVIEW_LIMIT } from './lib/analyses.js';
import { downloadDisposition } from './lib/http_names.js';
import { markedFile } from './lib/marked_file.js';
import * as store from './lib/store.js';

const PORT = Number(process.env.PORT) || 8105;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MAX_BODY = 5 * 1024 * 1024;
const GUIDE_BODY_LIMIT = 8 * 1024 * 1024; // 기준 문서 올리기 — 5MiB 파일의 base64(약 6.7MiB)와 서지정보 (FR-WB-085)
const FORM_BODY_LIMIT = 28 * 1024 * 1024; // 양식 올리기 — 20MiB 파일(docx·hwpx·hwp)의 base64(약 26.7MiB)와 제목·파일 이름 (FR-WB-090, DR-WB-008)
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.wasm': 'application/wasm' };

const agent = createAgent({ loadState: store.loadState, addSource: store.addSource, bookAgentState: store.bookAgentState, formAgentState: store.formAgentState, bookGuides: store.fullGuides,
  saveBookChat: store.saveBookChat, getBookChat: store.getBookChat, bookChatContext: store.bookChatContext,
  analysisAgentState: store.analysisAgentState, seedAnalysisResults: store.seedAnalysisResults, syncAnalysisResults: store.syncAnalysisResults, saveAnalysisMessages: store.saveAnalysisMessages });

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

// 데이터 분석의 결과 파일 — 에이전트가 쓴 글 파일이다. 내려받기는 원래 이름으로, 보기는 앞 PREVIEW_LIMIT 바이트만 글로 보낸다 (FR-WB-088).
// 어느 쪽이든 이 서버의 출처로 해석되지 않게 nosniff 와 sandbox 를 건다
function sendResultFile(res, { data, name }, download) {
  const body = download ? data : data.subarray(0, PREVIEW_LIMIT);
  res.writeHead(200, {
    'Content-Type': download && name.toLowerCase().endsWith('.json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Content-Disposition': download ? downloadDisposition(name.replace(/[^\x20-\x7e]|"/g, '_'), name) : 'inline',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'X-Total-Size': String(data.length),
  });
  res.end(body);
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
  if (route === 'GET /api/book') return sendJson(res, 200, await store.loadBookState(url.searchParams.get('report') || undefined, { remember: url.searchParams.get('remember') !== '0' })); // remember=0: 장 화면에서 엿볼 때 (FR-WB-104)
  if (route === 'PUT /api/book') return sendJson(res, 200, await store.saveToc(await readBody(req)));
  // 보고서 에이전트의 장 추가 수정안 반영 — 목차의 원하는 자리에 빈 장을 만든다 (FR-WB-076)
  if (route === 'POST /api/book/chapters') return sendJson(res, 201, await store.insertChapter(await readBody(req)));
  // 양식 문서에서 고른 제목(헤딩)들을 빈 장으로 — 목차 끝에 순서대로 이어 붙인다 (FR-WB-093)
  if (route === 'POST /api/book/chapters/import') return sendJson(res, 201, await store.importChapters(await readBody(req)));
  if (route === 'POST /api/books') return sendJson(res, 201, await store.createBook(await readBody(req)));
  // 데이터 분석 — 목록·만들기·열기·제목 저장·삭제, 문답 비우기(새 대화), 결과 파일 보기·내려받기(?download=1)·삭제 (FR-WB-088, 106, ERR-WB-010)
  // 에이전트가 답하는 중인 분석은 지우거나 문답을 비우지 못한다
  const analysis = url.pathname.match(/^\/api\/books\/([^/]+)\/analyses(?:\/([^/]+)(?:\/(messages|results)(?:\/(.+))?)?)?$/);
  if (analysis) {
    const [bookId, id, part] = [decodeURIComponent(analysis[1]), analysis[2] && decodeURIComponent(analysis[2]), analysis[3]];
    const rel = analysis[4] ? analysis[4].split('/').map(decodeURIComponent).join('/') : null;
    const busy = () => id && agent.analysisRunning(bookId, id);
    const refuse = () => sendJson(res, 409, { error: '이 분석의 에이전트가 답하는 중입니다. 중지하거나 끝난 뒤에 다시 하세요.' });
    if (req.method === 'GET' && !id) return sendJson(res, 200, { analyses: await store.analysisList(bookId) });
    if (req.method === 'POST' && !id) return sendJson(res, 201, await store.createAnalysis({ ...(await readBody(req)), bookId }));
    if (req.method === 'GET' && id && !part) return sendJson(res, 200, await store.getAnalysis(bookId, id));
    if (req.method === 'PUT' && id && !part) return sendJson(res, 200, await store.renameAnalysis({ ...(await readBody(req)), bookId, id }));
    if (req.method === 'DELETE' && id && !part) return busy() ? refuse() : sendJson(res, 200, await store.deleteAnalysis(bookId, id));
    if (req.method === 'DELETE' && part === 'messages' && !rel) return busy() ? refuse() : sendJson(res, 200, await store.clearAnalysisMessages(bookId, id));
    if (req.method === 'GET' && part === 'results' && rel) return sendResultFile(res, await store.readAnalysisResult(bookId, id, rel), url.searchParams.get('download') === '1');
    if (req.method === 'DELETE' && part === 'results' && rel) return sendJson(res, 200, await store.deleteAnalysisResult(bookId, id, rel));
  }
  // 보고서 화면·장 화면 대화 보관 — 목록 · 다시 열기(screen: 'chapter' 면 장 에이전트로) · 분류 제안 · 분류 저장 · 삭제. 보관은 에이전트가 답을 마칠 때마다 한다 (FR-WB-101, DR-WB-010)
  const chat = url.pathname.match(/^\/api\/books\/([^/]+)\/chats(?:\/([^/]+))?(?:\/(open|suggest))?$/);
  if (chat) {
    const [bookId, id, action] = [decodeURIComponent(chat[1]), chat[2] && decodeURIComponent(chat[2]), chat[3]];
    if (req.method === 'GET' && !id) return sendJson(res, 200, { chats: await store.bookChatList(bookId) });
    if (req.method === 'POST' && id && action === 'open') return sendJson(res, 200, await agent.openBookChat({ bookId, chatId: id, screen: (await readBody(req)).screen }));
    if (req.method === 'POST' && id && action === 'suggest') {
      const body = await readBody(req);
      const abort = new AbortController(); // 작성자가 제안을 기다리지 않고 창을 닫으면 모델 호출도 멈춘다
      res.on('close', () => { if (!res.writableEnded) abort.abort(); });
      return sendJson(res, 200, await agent.suggestChatLabel({ bookId, chatId: id, model: body.model }, abort.signal));
    }
    if (req.method === 'PUT' && id && !action) return sendJson(res, 200, { chat: await store.classifyBookChat({ ...(await readBody(req)), bookId, id }) });
    if (req.method === 'DELETE' && id && !action) return sendJson(res, 200, await store.deleteBookChat(bookId, id));
  }
  // 양식 구조 규칙 — 작업공간 수준: 목록 · 삭제. 규칙은 양식 저장(PUT forms/<F> 의 structure)이 남긴다 (FR-WB-095, DR-WB-009)
  if (route === 'GET /api/form-rules') return sendJson(res, 200, await store.formRules());
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/form-rules/')) return sendJson(res, 200, await store.deleteFormRule(decodeURIComponent(url.pathname.slice('/api/form-rules/'.length))));
  // 양식 — 목록 · 올리기(base64) · 읽기 · 저장(값·지침·제목과 구조 조절 structure) · 삭제 · 올린 원본/값을 기입한 사본 내려받기 (FR-WB-090 ~ 092, 094)
  const form = url.pathname.match(/^\/api\/books\/([^/]+)\/forms(?:\/([^/]+))?(?:\/(original|export))?$/);
  if (form) {
    const [bookId, id, file] = [decodeURIComponent(form[1]), form[2] && decodeURIComponent(form[2]), form[3]];
    if (req.method === 'GET' && !id) return sendJson(res, 200, { forms: await store.formList(bookId) });
    if (req.method === 'POST' && !id) return sendJson(res, 201, await store.addForm({ ...(await readBody(req, FORM_BODY_LIMIT)), bookId }));
    if (req.method === 'GET' && id && file) return sendSourceFile(res, await store.readFormFile(bookId, id, file));
    if (req.method === 'GET' && id) return sendJson(res, 200, { form: await store.getForm(bookId, id) });
    if (req.method === 'PUT' && id && !file) return sendJson(res, 200, await store.saveForm({ ...(await readBody(req)), bookId, id }));
    if (req.method === 'DELETE' && id && !file) return sendJson(res, 200, await store.deleteForm(bookId, id));
  }
  // 기준 문서 — 목록은 GET /api/book 에 실려 간다(변환 상태만 다시 받을 때는 GET …/guides). 여기서는 하나의 본문 · 등록(파일은 base64 로 한 요청에 하나) · 종류/제목/설명 고치기 · 삭제 · 보관 파일 열기 (FR-WB-085)
  // PDF 에이전트 변환: POST …/guides/<G>/convert { action: start | rest | stop } (FR-WB-097)
  // 합치기: POST …/guides/<G>/merge { from: <끌어 온 문서> } · 마지막 합치기 되돌리기: POST …/guides/<G>/unmerge (FR-WB-099)
  const guide = url.pathname.match(/^\/api\/books\/([^/]+)\/guides(?:\/([^/]+))?(?:\/(original|markdown|convert|merge|unmerge))?$/);
  if (guide) {
    const [bookId, id, file] = [decodeURIComponent(guide[1]), guide[2] && decodeURIComponent(guide[2]), guide[3]];
    if (req.method === 'GET' && !id) return sendJson(res, 200, { guides: await store.guideList(bookId) });
    if (req.method === 'POST' && !id) return sendJson(res, 201, await store.addGuide({ ...(await readBody(req, GUIDE_BODY_LIMIT)), bookId }));
    if (req.method === 'POST' && id && file === 'convert') return sendJson(res, 200, await store.convertGuide({ ...(await readBody(req)), bookId, id }));
    if (req.method === 'POST' && id && file === 'merge') return sendJson(res, 200, await store.mergeGuide({ ...(await readBody(req)), bookId, id }));
    if (req.method === 'POST' && id && file === 'unmerge') return sendJson(res, 200, await store.unmergeGuide({ bookId, id }));
    if (req.method === 'GET' && id && (file === 'original' || file === 'markdown')) return sendSourceFile(res, await store.readGuideFile(bookId, id, file));
    if (req.method === 'GET' && id) return sendJson(res, 200, await store.getGuide(bookId, id));
    if (req.method === 'PUT' && id && !file) return sendJson(res, 200, await store.updateGuide({ ...(await readBody(req)), bookId, id }));
    if (req.method === 'DELETE' && id && !file) return sendJson(res, 200, await store.deleteGuide(bookId, id));
  }
  // 에이전트가 정리한 작성자 요청을 주제별 작성요령 문서로 저장 — 카드의 저장: { topic, guideId?, text, before } (FR-WB-100)
  const note = url.pathname.match(/^\/api\/books\/([^/]+)\/guide-notes$/);
  if (note && req.method === 'POST') return sendJson(res, 200, await store.saveGuideNote({ ...(await readBody(req)), bookId: decodeURIComponent(note[1]) }));
  // 목차 수정안에 적은 반영 의견·거부 사유·추가의견을 「수정안 검토 의견」에 한 줄 더한다: { action: accept|reject|comment, what, comment } (FR-WB-103)
  const review = url.pathname.match(/^\/api\/books\/([^/]+)\/review-notes$/);
  if (review && req.method === 'POST') return sendJson(res, 200, await store.addReviewNote({ ...(await readBody(req)), bookId: decodeURIComponent(review[1]) }));
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
