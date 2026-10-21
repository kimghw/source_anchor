// 로컬 파일 작업공간 — 보고서(메인문서) 하나가 폴더 하나이고, 그 안에 장(하위문서)이 들어간다 (DR-WB-005).
//   workspace/projects/<보고서 ID>/main.json                  목차: 장의 순서·수준(level)·제목·지시문
//   workspace/projects/<보고서 ID>/chapters/<장 ID>/report.json  그 장의 본문과 근거
//   … /chapters/<장 ID>/sources/<번호>.json + 변환한 Markdown <번호>.md, snapshots/ 내려받은 원본
// 원문은 장이 소유하고 장끼리 함께 쓰지 않는다 (DR-WB-002) — 보고서 화면에서만 읽기 전용으로 모아 본다 (FR-WB-075).
// 채택을 거부한 자료는 파일을 그대로 둔 채 rejected 로 표시한다 (DR-WB-003).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { instructionsProblem } from '../public/shared/instructions.js';
import { allSentences, buildAnchorIndex, buildBlocks, docHeadings, nextId } from '../public/shared/model.js';
import { insertAfter, normalizeLevels } from '../public/shared/toc.js';
import * as customDocs from './custom_docs.js';
import * as guides from './guides.js';
import { markdownToDrafts } from './ingest.js';
import { sourceMarks as marksOf } from './marks.js';
import { sourceMarkdown } from './source_md.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WORKSPACE = process.env.WORKSPACE || path.join(ROOT, 'workspace');
const PROJECTS_DIR = path.join(WORKSPACE, 'projects');
const LAST_FILE = path.join(WORKSPACE, 'workspace.json');
const LEGACY_DIR = path.join(PROJECTS_DIR, 'default'); // 원문을 모든 문서가 함께 쓰던 때의 폴더
const BOOK_ID = /^M-\d{3,}$/;
const REPORT_ID = /^R-\d{3,}$/;

// { books: Map(보고서 ID → { id, title, chapters: [{ id, title, instructions, level }], updatedAt }),  level: 헤딩 수준 1~3 (public/shared/toc.js)
//   chapters: Map(장 ID → { bookId, doc, evidence, updatedAt, sources }), lastBookId, lastDocId, view }
// 장 ID 는 작업공간 안에서 유일하다 — 장 하나만 알면 폴더를 찾을 수 있다.
let cache = null;

const fail = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function readJsonDir(dir) {
  const files = (await fs.readdir(dir).catch(() => [])).filter(f => f.endsWith('.json')).sort();
  return Promise.all(files.map(f => readJson(path.join(dir, f))));
}

const bookDir = id => path.join(PROJECTS_DIR, id);
const bookFile = id => path.join(bookDir(id), 'main.json');
const chapterDir = (bookId, chapterId) => path.join(bookDir(bookId), 'chapters', chapterId);
const projectDir = id => chapterDir(cache.chapters.get(id).bookId, id);
const sourceFile = (docId, sourceId) => path.join(projectDir(docId), 'sources', `${sourceId}.json`);
const markdownFile = (docId, sourceId) => path.join(projectDir(docId), 'sources', `${sourceId}.md`);

// 원문의 Markdown 파일 — 내려받은 원본과 한 쌍으로 둔다 (DR-PL-002)
async function writeMarkdown(docId, source) {
  await fs.writeFile(markdownFile(docId, source.id), sourceMarkdown(source));
}

async function writeReport({ doc, evidence, updatedAt }) {
  await writeJson(path.join(projectDir(doc.id), 'report.json'), { doc, evidence, updatedAt });
}

// 마지막으로 보던 자리 — 보고서, 그 보고서에서 연 장, 보던 화면(보고서 화면 book · 장의 작성 화면 chapter) (FR-WB-074)
async function rememberLast({ bookId = cache.lastBookId, docId = cache.lastDocId, view = cache.view }) {
  if (cache.lastBookId === bookId && cache.lastDocId === docId && cache.view === view) return;
  Object.assign(cache, { lastBookId: bookId, lastDocId: docId, view });
  await writeJson(LAST_FILE, { lastBookId: bookId, lastDocId: docId, view });
}

async function writeBook(book) {
  book.updatedAt = now();
  await writeJson(bookFile(book.id), book);
}

// 예전 작업공간(자료 공용)을 문서별 프로젝트로 옮긴다. 자료를 인용한 문서가 자료를 가져가고(인용한 문서가 없으면 첫 문서),
// 아무것도 인용하지 않은 문서는 원문 없이 시작한다.
async function migrateLegacy() {
  // 이 단계에서는 아직 보고서가 없다 — 문서마다 폴더를 두던 그때의 자리에 그대로 쓰고, migrateFlatChapters 가 보고서 밑으로 옮긴다
  const flatDir = id => path.join(PROJECTS_DIR, id);
  const flatSource = (docId, sourceId) => path.join(flatDir(docId), 'sources', `${sourceId}.json`);
  const flatReport = ({ doc, evidence, updatedAt }) => writeJson(path.join(flatDir(doc.id), 'report.json'), { doc, evidence, updatedAt });
  const sources = await readJsonDir(path.join(LEGACY_DIR, 'sources'));
  let reports = await readJsonDir(path.join(LEGACY_DIR, 'reports'));
  const single = await readJson(path.join(LEGACY_DIR, 'report.json')).catch(() => null); // 문서가 하나뿐이던 때의 파일
  if (single && !reports.length) reports = [single];
  if (sources.length && !reports.length) reports = [{ doc: { id: 'R-001', title: '제목 없는 문서', blocks: [] }, evidence: {} }];
  if (!reports.length) return;
  const citing = reports.filter(r => Object.keys(r.evidence || {}).length);
  const owners = new Set((citing.length ? citing : reports.slice(0, 1)).map(r => r.doc.id));
  for (const report of reports) {
    if (owners.has(report.doc.id)) for (const source of sources) await writeJson(flatSource(report.doc.id, source.id), source);
    await flatReport({ ...report, updatedAt: report.updatedAt || now() });
  }
  const legacy = await readJson(path.join(LEGACY_DIR, 'project.json')).catch(() => ({}));
  if (legacy.lastDocId) await writeJson(LAST_FILE, { lastDocId: legacy.lastDocId });
  await fs.rm(LEGACY_DIR, { recursive: true, force: true });
}

// 문서 하나가 곧 프로젝트이던 작업공간(projects/R-001/)을 보고서 → 장 구조로 옮긴다.
// 그때의 문서는 서로 독립이었으므로 문서마다 보고서를 하나씩 만들고 그 문서를 첫 장으로 둔다.
async function migrateFlatChapters() {
  const names = await fs.readdir(PROJECTS_DIR).catch(() => []);
  const flat = names.filter(name => REPORT_ID.test(name)).sort();
  if (!flat.length) return;
  const taken = names.filter(name => BOOK_ID.test(name));
  for (const chapterId of flat) {
    const report = await readJson(path.join(PROJECTS_DIR, chapterId, 'report.json')).catch(() => null);
    const title = report?.doc?.title?.trim() || '제목 없는 보고서';
    const bookId = nextId('M', taken, 3);
    taken.push(bookId);
    await fs.mkdir(path.join(bookDir(bookId), 'chapters'), { recursive: true });
    await fs.rename(path.join(PROJECTS_DIR, chapterId), chapterDir(bookId, chapterId));
    await writeJson(bookFile(bookId), { id: bookId, title, chapters: [{ id: chapterId, title, instructions: '' }], updatedAt: report?.updatedAt || now() });
  }
}

// 한 장의 본문·근거·원문을 읽어 캐시에 넣는다
async function loadChapter(bookId, chapterId) {
  const report = await readJson(path.join(chapterDir(bookId, chapterId), 'report.json')).catch(() => null);
  if (!report) return;
  cache.chapters.set(chapterId, { bookId, ...report, sources: [] });
  const sources = await readJsonDir(path.join(chapterDir(bookId, chapterId), 'sources'));
  // Markdown 파일 없이 수집되어 있던 원문에도 만들어 둔다 (DR-PL-002)
  for (const source of sources) await fs.access(markdownFile(chapterId, source.id)).catch(() => writeMarkdown(chapterId, source));
  cache.chapters.get(chapterId).sources = sources;
}

async function load() {
  if (cache) return cache;
  await migrateLegacy();
  await migrateFlatChapters();
  cache = { books: new Map(), chapters: new Map(), guides: new Map(), custom: new Map(), lastBookId: null, lastDocId: null, view: 'chapter' }; // guides: Map(보고서 ID → [기준 문서]) — main.json 에는 발급한 번호(guideSeq)만 둔다
  const ids = (await fs.readdir(PROJECTS_DIR).catch(() => [])).filter(name => BOOK_ID.test(name)).sort();
  for (const bookId of ids) {
    const book = await readJson(bookFile(bookId)).catch(() => null);
    if (!book) continue;
    book.chapters = (book.chapters || []).filter(ch => REPORT_ID.test(ch.id));
    cache.books.set(bookId, book);
    cache.guides.set(bookId, await guides.loadGuides(bookDir(bookId)));
    cache.custom.set(bookId, await customDocs.loadCustomDocs(bookDir(bookId)));
    for (const ch of book.chapters) await loadChapter(bookId, ch.id);
    book.chapters = normalizeLevels(book.chapters.filter(ch => cache.chapters.has(ch.id))); // 파일이 사라진 장은 목차에서 뺀다. 수준은 규칙 안으로(없으면 1)
  }
  const last = await readJson(LAST_FILE).catch(() => ({}));
  Object.assign(cache, { lastBookId: last.lastBookId ?? null, lastDocId: last.lastDocId ?? null, view: last.view === 'book' ? 'book' : 'chapter' });
  if (!cache.books.size) await createBook({ title: '' }); // 빈 작업공간은 장이 없는 빈 보고서 하나로 시작한다 (FR-WB-064)
  return cache;
}

// 보고서를 찾는다
async function book(bookId) {
  await load();
  const found = cache.books.get(bookId);
  if (!found) throw fail(404, `보고서를 찾지 못했습니다: ${bookId}`);
  return found;
}

async function project(docId) {
  await load();
  const found = cache.chapters.get(docId);
  if (!found) throw fail(404, `장을 찾지 못했습니다: ${docId}`);
  return found;
}

// owner.sources 에는 채택을 거부한 자료도 들어 있다(번호를 다시 쓰지 않고, 거부를 취소하면 그대로 돌아오게).
const adopted = owner => owner.sources.filter(s => !s.rejected);
// 거부 목록에는 본문 없이 서지정보와 거부 이유만 싣는다 (FR-WB-046)
const rejectedList = owner => owner.sources.filter(s => s.rejected).map(({ blocks, ...meta }) => meta);

// 한 보고서의 장 목록 — 목차 순서 그대로다 (FR-WB-061)
function listChapters(bookId) {
  return cache.books.get(bookId).chapters.map(ch => {
    const owner = cache.chapters.get(ch.id);
    return { id: ch.id, title: ch.title, instructions: ch.instructions || '', level: ch.level || 1, cascade: ch.cascade !== false, updatedAt: owner.updatedAt, sentences: allSentences(owner.doc).length, sources: adopted(owner).length, headings: docHeadings(owner.doc) };
  });
}

// 보고서 목록 (FR-WB-070)
function listBooks() {
  return [...cache.books.values()]
    .map(b => ({ id: b.id, title: b.title, chapters: b.chapters.length, updatedAt: b.updatedAt }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

// 목차에 적힌 장의 제목은 장 본문의 제목과 같은 것을 가리킨다 — 한쪽을 고치면 다른 쪽도 맞춘다
function syncChapterTitle(bookId, chapterId, title) {
  const entry = cache.books.get(bookId).chapters.find(ch => ch.id === chapterId);
  if (entry && entry.title !== title) {
    entry.title = title;
    return true;
  }
  return false;
}

// 화면·에이전트가 쓰는 상태: 장 하나(docId 가 없으면 마지막으로 연 장)와 그 장의 원문·거부 목록,
// 그 장이 속한 보고서의 목차와 이 장의 지시문 (FR-WB-073)
export async function loadState(docId) {
  await load();
  const id = cache.chapters.has(docId) ? docId : cache.chapters.has(cache.lastDocId) ? cache.lastDocId : [...cache.chapters.keys()][0];
  if (docId && docId !== id) throw fail(404, `장을 찾지 못했습니다: ${docId}`);
  if (!id) throw fail(409, '이 보고서에는 아직 장이 없습니다. 보고서 화면에서 장을 추가하세요.');
  const owner = cache.chapters.get(id);
  await rememberLast({ bookId: owner.bookId, docId: id, view: 'chapter' });
  const current = cache.books.get(owner.bookId);
  return {
    sources: adopted(owner), rejected: rejectedList(owner), doc: owner.doc, evidence: owner.evidence,
    docs: listChapters(owner.bookId),
    custom: listCustomDocs(owner.bookId), // 0열 "사용자 지정 문서" 탭 (FR-WB-088)
    book: { id: current.id, title: current.title, instructions: current.instructions || '', chapters: current.chapters.map(ch => ({ ...ch, cascade: ch.cascade !== false })) }, // 공통 지시문·하위 장 적용 여부 — 장 에이전트의 합친 지시문에 쓴다 (FR-WB-087)
    instructions: current.chapters.find(ch => ch.id === id)?.instructions || '',
  };
}

// 보고서 화면이 쓰는 상태: 목차와 보고서 전체 원문(어느 장의 것인지 붙여서, 읽기 전용) (FR-WB-071, 075)
export async function loadBookState(bookId) {
  await load();
  const id = cache.books.has(bookId) ? bookId : cache.books.has(cache.lastBookId) ? cache.lastBookId : listBooks()[0].id;
  if (bookId && bookId !== id) throw fail(404, `보고서를 찾지 못했습니다: ${bookId}`);
  await rememberLast({ bookId: id, view: 'book' });
  const current = cache.books.get(id);
  const sources = current.chapters.flatMap(ch =>
    adopted(cache.chapters.get(ch.id)).map(source => ({ ...source, chapterId: ch.id, chapterTitle: ch.title })));
  return { book: { id: current.id, title: current.title, instructions: current.instructions || '' }, chapters: listChapters(id), sources, guides: listGuides(id), custom: listCustomDocs(id), books: listBooks() };
}

// 보고서 화면 에이전트가 읽는 상태: 목차의 장마다 지시문·본문·근거·채택한 원문을 붙인다 (FR-WB-077). 마지막으로 보던 자리는 바꾸지 않는다.
export async function bookAgentState(bookId) {
  const current = await book(bookId);
  const chapters = current.chapters.map(ch => {
    const owner = cache.chapters.get(ch.id);
    return { id: ch.id, title: ch.title, instructions: ch.instructions || '', level: ch.level || 1, cascade: ch.cascade !== false, doc: owner.doc, evidence: owner.evidence, sources: adopted(owner) };
  });
  return { id: current.id, title: current.title, instructions: current.instructions || '', chapters, guides: guidesOf(current.id) };
}

// 화면을 다시 열 때 어디로 갈지. 마지막으로 보던 장·보고서가 없어졌으면 남은 자리로 물러서고 그 사실을 알린다 (FR-WB-074, ERR-WB-005).
export async function lastPlace() {
  await load();
  const docId = cache.chapters.has(cache.lastDocId) ? cache.lastDocId : null;
  const bookId = cache.books.has(cache.lastBookId) ? cache.lastBookId : listBooks()[0].id;
  const gone = docId !== cache.lastDocId || bookId !== cache.lastBookId;
  if (gone) await rememberLast({ bookId, docId, view: docId ? cache.view : 'book' });
  return { view: docId ? cache.view : 'book', bookId, docId, gone };
}

export async function saveReport({ doc, evidence }) {
  await load();
  if (!doc || !REPORT_ID.test(doc.id) || !Array.isArray(doc.blocks) || typeof evidence !== 'object' || evidence === null) throw fail(400, 'doc.id · doc.blocks · evidence 가 필요합니다');
  const current = await project(doc.id);
  Object.assign(current, { doc, evidence, updatedAt: now() });
  await writeReport(current);
  if (syncChapterTitle(current.bookId, doc.id, doc.title)) await writeBook(cache.books.get(current.bookId));
  return { docs: listChapters(current.bookId) };
}

// 빈 장 하나를 만들어 파일과 캐시에 넣는다 — 목차에 끼우는 것은 부르는 쪽이 한다. 새 장은 본문도 원문도 없이 시작한다 (FR-WB-060)
async function makeChapter(current, title) {
  const id = nextId('R', [...cache.chapters.keys()], 3);
  const name = String(title || '').trim() || '제목 없는 장';
  const created = { bookId: current.id, doc: { id, title: name, blocks: [] }, evidence: {}, updatedAt: now(), sources: [] };
  cache.chapters.set(id, created);
  await writeReport(created);
  return { id, title: name, instructions: '', level: 1, cascade: true };
}

// 빈 장을 보고서 끝에 만들고 그 장의 작성 화면 상태를 돌려준다 (FR-WB-072)
export async function createReport({ bookId, title }) {
  await load();
  const current = await book(bookId ?? cache.lastBookId ?? listBooks()[0]?.id);
  const entry = await makeChapter(current, title);
  current.chapters.push(entry);
  await writeBook(current);
  return loadState(entry.id);
}

// 보고서 에이전트의 장 추가 수정안을 반영한다 — 빈 장을 목차의 원하는 자리(after: 장 ID 바로 뒤 · start · end)에 원하는 수준·지시문으로 넣고
// 보고서 화면 상태를 돌려준다. 기준 장이 없어졌으면 거절한다 (FR-WB-076, ERR-WB-007)
export async function insertChapter({ bookId, title, instructions, level, after }) {
  const current = await book(bookId);
  const anchor = after == null || after === '' ? 'end' : String(after);
  if (!['start', 'end'].includes(anchor) && !current.chapters.some(ch => ch.id === anchor)) throw fail(404, `기준 장이 이 보고서에 없습니다: ${anchor}`);
  const entry = await makeChapter(current, title);
  entry.instructions = cleanInstructions(instructions);
  entry.level = Number.isInteger(level) ? level : 1;
  current.chapters = normalizeLevels(insertAfter(current.chapters, entry, anchor));
  await writeBook(current);
  return loadBookState(bookId);
}

// ───────────────────────────── 보고서(메인문서) ─────────────────────────────

// 빈 보고서를 만든다 — 장은 작성자가 추가하거나 에이전트가 목차로 제안한다 (FR-WB-070, 072)
export async function createBook({ title }) {
  await load(); // 첫 보고서는 load() 안에서 만들어진다 — 그때 cache 는 이미 채워져 있어 여기서 다시 읽지 않는다
  const id = nextId('M', [...cache.books.keys()], 3);
  const created = { id, title: String(title || '').trim() || '제목 없는 보고서', instructions: '', chapters: [], updatedAt: now() };
  cache.books.set(id, created);
  cache.guides.set(id, []);
  cache.custom.set(id, []);
  await writeBook(created);
  await rememberLast({ bookId: id, docId: null, view: 'book' });
  return loadBookState(id);
}

// 보고서를 지우면 그 보고서의 장과 원문·거부 목록을 함께 지운다 (DR-WB-005)
export async function deleteBook(id) {
  const current = await book(id);
  for (const ch of current.chapters) cache.chapters.delete(ch.id);
  cache.books.delete(id);
  cache.guides.delete(id);
  cache.custom.delete(id);
  if (!cache.chapters.has(cache.lastDocId)) cache.lastDocId = null;
  await fs.rm(bookDir(id), { recursive: true, force: true });
  if (!cache.books.size) return createBook({ title: '' });
  return loadBookState(listBooks()[0].id);
}

// 지시문 — 앞뒤 공백을 떼고, 한도를 넘으면 자르지 않고 거절한다 (FR-WB-073)
function cleanInstructions(text, options) {
  const clean = String(text || '').trim();
  const problem = instructionsProblem(clean, options);
  if (problem) throw fail(400, problem);
  return clean;
}

// 목차를 저장한다 — 장의 순서·수준·제목·지시문만 바꾼다. 장을 지우는 것은 deleteReport 가 한다 (FR-WB-072, 073, 079).
// 수준은 규칙(첫 장 1, 앞 장 + 1 이하, 1~3) 안으로 맞춰 저장한다 — 거절하지 않고 맞춘다.
export async function saveToc({ bookId, title, instructions, chapters }) {
  const current = await book(bookId);
  if (title !== undefined) current.title = String(title).trim() || '제목 없는 보고서';
  if (instructions !== undefined) current.instructions = cleanInstructions(instructions, { report: true }); // 보고서 공통 지시문 — 헤딩 순서 절은 거절 (FR-WB-087)
  if (chapters !== undefined) {
    if (!Array.isArray(chapters)) throw fail(400, 'chapters 는 배열이어야 합니다');
    const known = new Map(current.chapters.map(ch => [ch.id, ch]));
    const next = [];
    for (const ch of chapters) {
      const was = known.get(ch?.id);
      if (!was || !known.delete(ch.id)) throw fail(400, `이 보고서의 장이 아니거나 중복된 장입니다: ${ch?.id}`);
      next.push({ id: ch.id, title: String(ch.title || '').trim() || '제목 없는 장', instructions: cleanInstructions(ch.instructions), level: ch.level ?? was.level, cascade: ch.cascade === undefined ? was.cascade !== false : Boolean(ch.cascade) });
    }
    if (known.size) throw fail(400, `목차에서 빠진 장이 있습니다: ${[...known.keys()].join(', ')}. 장을 지우려면 장 삭제를 쓰세요.`);
    current.chapters = normalizeLevels(next);
    // 장 제목은 본문의 제목과 같은 것을 가리킨다
    for (const ch of next) {
      const owner = cache.chapters.get(ch.id);
      if (owner.doc.title !== ch.title) {
        owner.doc.title = ch.title;
        owner.updatedAt = now();
        await writeReport(owner);
      }
    }
  }
  await writeBook(current);
  return loadBookState(bookId);
}

// 장을 지우면 그 장의 원문도 함께 지운다. 장이 하나도 없는 보고서는 그대로 둔다 (FR-WB-063, 072).
export async function deleteReport(id) {
  const owner = await project(id);
  const dir = projectDir(id);
  const current = cache.books.get(owner.bookId);
  current.chapters = normalizeLevels(current.chapters.filter(ch => ch.id !== id)); // 상위 장이 빠지면 하위 장의 수준을 규칙 안으로 올린다
  cache.chapters.delete(id);
  await fs.rm(dir, { recursive: true, force: true });
  await writeBook(current);
  if (cache.lastDocId === id) await rememberLast({ docId: current.chapters[0]?.id ?? null, view: current.chapters.length ? cache.view : 'book' });
  return { docs: listChapters(owner.bookId) };
}

// 원문을 문서에 등록한다. drafts 가 없으면 markdown 을 나눠 만든다. snapshot { ext, data } 은 내려받은 원본이다 (FR-PL-002).
export async function addSource({ docId, title, type, publisher, publishedAt, url, markdown, drafts, method, adoptReason, snapshot, origin }) {
  const owner = await project(docId);
  drafts ??= markdownToDrafts(markdown);
  if (!drafts.length) throw fail(400, '본문이 비어 있습니다');
  const id = nextId('S', owner.sources.map(s => s.id), 3);
  const source = {
    id,
    version: 'V-001',
    type: ['pdf', 'web', 'pptx', 'text'].includes(type) ? type : 'text',
    title: String(title || '').trim() || '제목 없는 자료',
    publisher: String(publisher || '').trim(),
    publishedAt: String(publishedAt || '').trim(),
    url: String(url || '').trim(),
    collectedAt: now(),
    method: String(method || '').trim() || '사용자가 붙여 넣은 본문',
    adoptReason: String(adoptReason || '').trim(),
    ...(origin ? { origin } : {}), // 사용자 지정 문서에서 만든 원문 — 어느 문서·어느 원문 위치에서 왔는지 (FR-WB-089)
    hash: 'sha256:' + crypto.createHash('sha256').update(snapshot?.data ?? String(markdown)).digest('hex'),
    ...(snapshot ? { snapshot: `snapshots/${id}.${snapshot.ext}` } : {}),
    blocks: buildBlocks(id, drafts),
  };
  if (snapshot) {
    await fs.mkdir(path.join(projectDir(docId), 'snapshots'), { recursive: true });
    await fs.writeFile(path.join(projectDir(docId), source.snapshot), snapshot.data);
  }
  await writeJson(sourceFile(docId, id), source);
  await writeMarkdown(docId, source);
  owner.sources.push(source);
  return source;
}

function findSource(owner, id) {
  const source = owner.sources.find(s => s.id === id);
  if (!source) throw fail(404, '자료를 찾지 못했습니다');
  return source;
}

const isCited = (owner, id) => Object.values(owner.evidence).some(ev => ev.sourceId === id);

// 원문 목록의 자료든 거부 목록의 자료든 지운다 — 원본과 Markdown 파일도 함께 지운다 (DR-PL-002)
export async function deleteSource(docId, id) {
  const owner = await project(docId);
  const removed = findSource(owner, id);
  if (isCited(owner, id)) throw fail(409, '이 자료를 인용한 문장이 있어 삭제할 수 없습니다. 먼저 근거 연결을 해제하세요.');
  owner.sources.splice(owner.sources.indexOf(removed), 1);
  await fs.rm(sourceFile(docId, id), { force: true });
  await fs.rm(markdownFile(docId, id), { force: true });
  if (removed.snapshot) await fs.rm(path.join(projectDir(docId), removed.snapshot), { force: true });
}

// 작성자가 채택을 거부한다 — 이미 거부한 자료면 이유만 고친다 (FR-WB-045, 046, ERR-WB-004)
export async function rejectSource({ docId, id, reason }) {
  const owner = await project(docId);
  const source = findSource(owner, id);
  reason = String(reason || '').trim().slice(0, 500);
  if (!reason) throw fail(400, '거부 이유를 적어 주세요');
  if (!source.rejected && isCited(owner, id)) throw fail(409, '이 자료를 인용한 문장이 있어 채택을 거부할 수 없습니다. 먼저 근거 연결을 해제하세요.');
  source.rejected = { reason, at: source.rejected?.at ?? now() };
  await writeJson(sourceFile(docId, id), source);
  return { rejected: rejectedList(owner) };
}

// 거부를 취소한다 — 같은 원문 번호·원문 위치로 원문 목록에 돌아온다 (FR-WB-046)
export async function restoreSource({ docId, id }) {
  const owner = await project(docId);
  const source = findSource(owner, id);
  delete source.rejected;
  await writeJson(sourceFile(docId, id), source);
  return { source, rejected: rejectedList(owner) };
}

// 보관한 원본 파일 또는 Markdown 파일 (FR-PL-011). 붙여 넣은 원문에는 원본이 없다.
export async function readSourceFile(docId, id, kind) {
  const source = findSource(await project(docId), id);
  if (kind === 'original' && !source.snapshot) throw fail(404, '이 자료는 붙여 넣은 원문이라 내려받은 원본이 없습니다');
  const file = kind === 'original' ? path.join(projectDir(docId), source.snapshot) : markdownFile(docId, id);
  const data = await fs.readFile(file).catch(() => { throw fail(404, '보관한 파일을 찾지 못했습니다'); });
  return { data, name: path.basename(file) };
}

// ───────────────────────────── 기준 문서 (FR-WB-085, DR-WB-006) ─────────────────────────────
// 규정·규칙·작성요령·작성 요구사항 문서 — 보고서가 소유하고 다른 보고서에 나타나지 않는다. 파일 처리는 lib/guides.js.

const guidesOf = bookId => cache.guides.get(bookId) || [];

// 화면 목록 — 본문(블록) 없이
export function listGuides(bookId) {
  return guidesOf(bookId).map(guides.guideSummary);
}

// 에이전트가 읽는 기준 문서 — 본문까지 (FR-WB-073, 077)
export async function fullGuides(bookId) {
  await book(bookId);
  return guidesOf(bookId);
}

function findGuide(bookId, id) {
  const found = guidesOf(bookId).find(g => g.id === id);
  if (!found) throw fail(404, '기준 문서를 찾지 못했습니다');
  return found;
}

export async function getGuide(bookId, id) {
  await book(bookId);
  return findGuide(bookId, id);
}

// 올린 파일(data: base64) 또는 붙여 넣은 본문으로 기준 문서를 등록한다. 번호는 삭제한 뒤에도 다시 쓰지 않는다 — 발급한 마지막 번호를 main.json(guideSeq)에 둔다.
// 변환에 실패하면 아무것도 남기지 않는다 (ERR-WB-008)
export async function addGuide({ bookId, kind, title, fileName, data, markdown }) {
  const current = await book(bookId);
  if (data != null && typeof data !== 'string') throw fail(400, 'data 는 base64 문자열이어야 합니다');
  const seq = Math.max(current.guideSeq || 0, ...guidesOf(current.id).map(g => Number(g.id.slice(2)) || 0)) + 1;
  const id = `G-${String(seq).padStart(3, '0')}`;
  const { guide, snapshotData } = await guides.buildGuide({ id, kind, title, fileName, data: data != null ? Buffer.from(data, 'base64') : null, markdown });
  await guides.writeGuide(bookDir(current.id), guide, snapshotData);
  current.guideSeq = seq;
  await writeBook(current);
  cache.guides.set(current.id, [...guidesOf(current.id), guide]);
  return { guide: guides.guideSummary(guide), guides: listGuides(current.id) };
}

// 종류·제목을 고친다
export async function updateGuide({ bookId, id, kind, title }) {
  const current = await book(bookId);
  const guide = findGuide(current.id, id);
  if (kind !== undefined) guide.kind = guides.cleanKind(kind);
  if (title !== undefined) guide.title = guides.cleanTitle(title) || guide.fileName || '제목 없는 기준 문서';
  await guides.rewriteGuide(bookDir(current.id), guide);
  return { guide: guides.guideSummary(guide), guides: listGuides(current.id) };
}

// 보관 파일까지 지운다 — 이미 반영된 장의 지시문은 바꾸지 않는다 (FR-WB-085)
export async function deleteGuide(bookId, id) {
  const current = await book(bookId);
  const guide = findGuide(current.id, id);
  cache.guides.set(current.id, guidesOf(current.id).filter(g => g !== guide));
  await guides.removeGuideFiles(bookDir(current.id), guide);
  return { guides: listGuides(current.id) };
}

// 올린 원본 파일 또는 Markdown 파일
export async function readGuideFile(bookId, id, kind) {
  const current = await book(bookId);
  return guides.readGuideFile(bookDir(current.id), findGuide(current.id, id), kind);
}

// ───────────────────────────── 사용자 지정 문서 (FR-WB-088, 089, DR-WB-007) ─────────────────────────────
// 작성자가 원문들에서 문장·표를 골라 넣어 쓴 문서 — 보고서가 소유한다. 파일 처리는 lib/custom_docs.js.

const customOf = bookId => cache.custom.get(bookId) || [];

// 목록 — 본문 없이
export function listCustomDocs(bookId) {
  return customOf(bookId).map(customDocs.customSummary);
}

export async function customDocList(bookId) {
  await book(bookId);
  return listCustomDocs(bookId);
}

function findCustom(bookId, id) {
  const found = customOf(bookId).find(d => d.id === id);
  if (!found) throw fail(404, '사용자 지정 문서를 찾지 못했습니다');
  return found;
}

export async function getCustomDoc(bookId, id) {
  await book(bookId);
  return findCustom(bookId, id);
}

// 번호는 삭제한 뒤에도 다시 쓰지 않는다 — 발급한 마지막 번호를 main.json(customSeq)에 둔다
export async function createCustomDoc({ bookId, title }) {
  const current = await book(bookId);
  const seq = Math.max(current.customSeq || 0, ...customOf(current.id).map(d => Number(d.id.slice(2)) || 0)) + 1;
  const doc = customDocs.newCustomDoc(`C-${String(seq).padStart(3, '0')}`, title);
  await customDocs.writeCustomDoc(bookDir(current.id), doc);
  current.customSeq = seq;
  await writeBook(current);
  cache.custom.set(current.id, [...customOf(current.id), doc]);
  return { doc, custom: listCustomDocs(current.id) };
}

export async function saveCustomDoc({ bookId, id, title, markdown, picks }) {
  const current = await book(bookId);
  const doc = findCustom(current.id, id);
  const draft = customDocs.applyCustomPatch(structuredClone(doc), { title, markdown, picks }); // 거절되면 캐시도 그대로
  await customDocs.writeCustomDoc(bookDir(current.id), draft);
  Object.assign(doc, draft);
  return { doc, custom: listCustomDocs(current.id) };
}

// 문서를 지워도 이미 등록한 원문은 그대로 둔다 (DR-WB-007)
export async function deleteCustomDoc(bookId, id) {
  const current = await book(bookId);
  const doc = findCustom(current.id, id);
  cache.custom.set(current.id, customOf(current.id).filter(d => d !== doc));
  await customDocs.removeCustomDoc(bookDir(current.id), doc);
  return { custom: listCustomDocs(current.id) };
}

// 고른 장의 새 원문으로 등록한다 — 붙여 넣은 원문과 같은 규칙으로 문장·표 단위로 나누고, 어느 문서·어느 원문 위치에서 왔는지 남긴다.
// 다시 등록하면 기존 원문(앵커가 인용될 수 있다)을 바꾸지 않고 새 원문을 만든다 (FR-WB-089, ERR-WB-010)
export async function registerCustomDoc({ bookId, id, chapterId, title }) {
  const current = await book(bookId);
  const doc = findCustom(current.id, id);
  if (!current.chapters.some(ch => ch.id === chapterId)) throw fail(404, '이 보고서의 장이 아닙니다');
  if (!doc.markdown.trim()) throw fail(400, '문서 본문이 비어 있습니다');
  const source = await addSource({
    docId: chapterId, title: String(title || '').trim() || doc.title, type: 'text', publisher: '작성자', markdown: doc.markdown,
    method: `사용자 지정 문서 ${doc.id} 에서 만듦 · 출처 ${doc.picks.length}곳`,
    origin: { customId: doc.id, picks: doc.picks.map(({ chapterId: from, sourceId, anchorId }) => ({ chapterId: from, sourceId, anchorId })) },
  });
  doc.registrations.push({ chapterId, sourceId: source.id, at: now() });
  doc.updatedAt = now();
  await customDocs.writeCustomDoc(bookDir(current.id), doc);
  return { source, doc, custom: listCustomDocs(current.id) };
}

// ───────────────────────────── 참조 · 메모 ─────────────────────────────

// 원문 하나의 참조(보고서 문장이 인용한 위치)·메모 목록 (FR-PL-012, FR-WB-080)
export async function sourceMarks(docId, id) {
  const owner = await project(docId);
  return marksOf(owner, findSource(owner, id));
}

const noteText = text => {
  const t = String(text || '').trim().slice(0, 2000);
  if (!t) throw fail(400, '메모 내용을 적어 주세요');
  return t;
};

// 작성자 메모 — 원문 위치(앵커)에 붙여 원문 파일(sources/<번호>.json 의 notes)에 함께 보관한다 (DR-PL-003, FR-WB-081)
export async function addNote({ docId, id, anchorId, text }) {
  const owner = await project(docId);
  const source = findSource(owner, id);
  if (!buildAnchorIndex([source]).has(anchorId)) throw fail(400, '이 원문에 없는 위치입니다');
  const note = { id: nextId('N', (source.notes || []).map(n => n.id), 3), anchorId, text: noteText(text), at: now() };
  source.notes = [...(source.notes || []), note];
  await writeJson(sourceFile(docId, id), source);
  return { note, notes: source.notes };
}

export async function updateNote({ docId, id, noteId, text }) {
  const owner = await project(docId);
  const source = findSource(owner, id);
  const note = (source.notes || []).find(n => n.id === noteId);
  if (!note) throw fail(404, '메모를 찾지 못했습니다');
  Object.assign(note, { text: noteText(text), at: now() });
  await writeJson(sourceFile(docId, id), source);
  return { note, notes: source.notes };
}

export async function deleteNote(docId, id, noteId) {
  const owner = await project(docId);
  const source = findSource(owner, id);
  if (!(source.notes || []).some(n => n.id === noteId)) throw fail(404, '메모를 찾지 못했습니다');
  source.notes = source.notes.filter(n => n.id !== noteId);
  await writeJson(sourceFile(docId, id), source);
  return { notes: source.notes };
}
