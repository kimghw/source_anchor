// 로컬 파일 작업공간 — 보고서(메인문서) 하나가 폴더 하나이고, 그 안에 장(하위문서)이 들어간다 (DR-WB-005).
//   workspace/projects/<보고서 ID>/main.json                  목차: 장의 순서·수준(level)·제목·지시문
//   workspace/projects/<보고서 ID>/chapters/<장 ID>/report.json  그 장의 본문과 근거
//   … /chapters/<장 ID>/sources/<번호>.json + 변환한 Markdown <번호>.md, snapshots/ 내려받은 원본
//   workspace/forms/<양식 ID>.json + forms/originals/<양식 ID>.<ext>  양식 — 보고서에 속하지 않는 작업공간 공통 문서 (DR-WB-008); 번호(formSeq)는 workspace.json
// 원문은 장이 소유하고 장끼리 함께 쓰지 않는다 (DR-WB-002) — 보고서 화면에서만 읽기 전용으로 모아 본다 (FR-WB-075).
// 채택을 거부한 자료는 파일을 그대로 둔 채 rejected 로 표시한다 (DR-WB-003).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { instructionsProblem } from '../public/shared/instructions.js';
import { allSentences, buildAnchorIndex, buildBlocks, docHeadings, nextId } from '../public/shared/model.js';
import { insertAfter, MAX_LEVEL, normalizeLevels } from '../public/shared/toc.js';
import * as chats from './book_chats.js';
import * as customDocs from './custom_docs.js';
import * as structureRules from './form_rules.js';
import * as forms from './forms.js';
import * as convert from './guide_convert.js';
import { cleanTopic, isReviewNote, noteProblem, REVIEW_TOPIC, reviewLine } from './guide_notes.js';
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
//   chapters: Map(장 ID → { bookId, doc, evidence, updatedAt, sources }), forms: [양식 — 작업공간 공통 (DR-WB-008)], formSeq, formRules: [양식 구조 규칙 — 작업공간 수준 (DR-WB-009)], lastBookId, lastDocId, view }
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
// 작업공간 파일(workspace.json) — 마지막 자리와 양식 번호(formSeq). 한 파일이므로 어느 쪽을 바꿔도 다른 쪽을 함께 쓴다
const writeWorkspace = () => writeJson(LAST_FILE, { lastBookId: cache.lastBookId, lastDocId: cache.lastDocId, view: cache.view, formSeq: cache.formSeq });

async function rememberLast({ bookId = cache.lastBookId, docId = cache.lastDocId, view = cache.view }) {
  if (cache.lastBookId === bookId && cache.lastDocId === docId && cache.view === view) return;
  Object.assign(cache, { lastBookId: bookId, lastDocId: docId, view });
  await writeWorkspace();
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

// 보고서 아래(projects/<M>/forms/)에 두던 양식을 작업공간 공통(<WORKSPACE>/forms/)으로 옮긴다 — 값·지침·구조·원본은 그대로, 번호가 겹치면 뒤의 것이 새 번호를 받고
// 그 양식을 가리키던 구조 규칙의 formId 도 따라간다. 보고서마다 두던 formSeq 는 이어받아 지운 번호를 다시 쓰지 않는다. 원본이 없는 양식은 그 자리에 둔다(지우지 않는다).
// 돌려주는 값은 작업공간의 발급 기준 번호(지금까지 쓴 가장 큰 번호) (DR-WB-008)
async function migrateBookForms(bookIds, seq) {
  const numOf = id => Number(String(id).slice(2)) || 0;
  const taken = new Set((await forms.loadForms(WORKSPACE)).map(f => f.id));
  seq = Math.max(seq, ...[...taken].map(numOf));
  let rules = cache.formRules;
  for (const bookId of bookIds) {
    const book = await readJson(bookFile(bookId)).catch(() => null);
    if (!book) continue;
    seq = Math.max(seq, Number(book.formSeq) || 0);
    for (const form of await forms.loadForms(bookDir(bookId))) {
      const original = await forms.readOriginal(bookDir(bookId), form).catch(() => null);
      if (!original) continue;
      const id = taken.has(form.id) ? `F-${String(seq + 1).padStart(3, '0')}` : form.id;
      seq = Math.max(seq, numOf(id));
      await forms.writeForm(WORKSPACE, { ...form, id, original: `originals/${id}.${form.format}` }, original);
      await forms.removeFormFiles(bookDir(bookId), form);
      taken.add(id);
      if (id !== form.id) rules = rules.map(rule => (rule.bookId === bookId && rule.formId === form.id ? { ...rule, formId: id } : rule));
    }
    await fs.rmdir(path.join(bookDir(bookId), 'forms', 'originals')).catch(() => {}); // 비었을 때만 없어진다
    await fs.rmdir(path.join(bookDir(bookId), 'forms')).catch(() => {});
    if ('formSeq' in book) {
      delete book.formSeq;
      await writeJson(bookFile(bookId), book);
    }
  }
  if (rules !== cache.formRules) {
    await structureRules.saveRules(WORKSPACE, rules);
    cache.formRules = rules;
  }
  return seq;
}

async function load() {
  if (cache) return cache;
  await migrateLegacy();
  await migrateFlatChapters();
  cache = { books: new Map(), chapters: new Map(), guides: new Map(), custom: new Map(), forms: [], formSeq: 0, formRules: [], lastBookId: null, lastDocId: null, view: 'chapter' }; // guides: Map(보고서 ID → [기준 문서]) — main.json 에는 발급한 번호(guideSeq)만 둔다
  const last = await readJson(LAST_FILE).catch(() => ({}));
  Object.assign(cache, { lastBookId: last.lastBookId ?? null, lastDocId: last.lastDocId ?? null, view: last.view === 'book' ? 'book' : 'chapter', formSeq: Number(last.formSeq) || 0 });
  cache.formRules = await structureRules.loadRules(WORKSPACE); // 양식 구조 규칙 — 보고서를 넘어 같은 양식을 다시 쓸 때 참조한다 (FR-WB-095)
  const ids = (await fs.readdir(PROJECTS_DIR).catch(() => [])).filter(name => BOOK_ID.test(name)).sort();
  const seq = await migrateBookForms(ids, cache.formSeq);
  if (seq !== cache.formSeq) {
    cache.formSeq = seq;
    await writeWorkspace(); // 옮기며 이어받은 번호를 바로 남긴다 — 다음 실행에서 지운 번호를 다시 쓰지 않도록
  }
  cache.forms = await forms.loadForms(WORKSPACE); // 양식은 보고서에 속하지 않는다 — 어느 보고서에서 열어도 같은 목록 (FR-WB-090, DR-WB-008)
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
  if (!cache.books.size) await createBook({ title: '' }); // 빈 작업공간은 장이 없는 빈 보고서 하나로 시작한다 (FR-WB-064)
  // 대기·진행 중이던 기준 문서 변환은 넘긴 순서대로 이어 한다 — 검사를 통과한 묶음은 다시 하지 않는다 (FR-WB-097)
  const unfinished = [...cache.guides].flatMap(([bookId, list]) => list.filter(g => ['queued', 'running'].includes(g.convert?.state)).map(guide => ({ bookId, guide })));
  unfinished.sort((a, b) => String(a.guide.convert.requestedAt).localeCompare(String(b.guide.convert.requestedAt)));
  for (const { bookId, guide } of unfinished) if (!convert.isQueued(convert.keyOf(bookId, guide.id))) await queueConvert(bookId, guide, 'rest');
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
    forms: listForms(), // 0열 「장」 탭의 양식 묶음 — 작업공간 공통 (FR-WB-090)
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
  return { book: { id: current.id, title: current.title, instructions: current.instructions || '' }, chapters: listChapters(id), sources, guides: listGuides(id), custom: listCustomDocs(id), forms: listForms(), books: listBooks() };
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
  try {
    await writeReport(created);
  } catch (err) {
    cache.chapters.delete(id); // 파일이 없는 장을 캐시에 남기지 않는다 — 다음 장이 같은 번호를 다시 쓴다
    await fs.rm(chapterDir(current.id, id), { recursive: true, force: true }).catch(() => {}); // projectDir 은 캐시를 보므로 쓰지 않는다
    throw err;
  }
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

// 양식 문서에서 고른 제목(헤딩)들을 빈 장으로 만들어 목차 끝에 순서대로 이어 붙인다 — 수준은 규칙 안으로 맞추고 보고서 화면 상태를 돌려준다.
// chapters: [{ title, level }] 1 ~ IMPORT_LIMIT 건. 제목은 앞뒤 공백을 떼고 TITLE_LIMIT 자로 자르며 비면 '제목 없는 장', level 은 정수 1~MAX_LEVEL 이 아니면 1.
// 검사는 장을 하나라도 만들기 전에 끝내 거절된 요청은 파일을 남기지 않는다 (FR-WB-093)
const IMPORT_LIMIT = 500;
const TITLE_LIMIT = 200;
export async function importChapters({ bookId, chapters }) {
  const current = await book(bookId);
  if (!Array.isArray(chapters) || !chapters.length) throw fail(400, 'chapters 는 비어 있지 않은 배열이어야 합니다');
  if (chapters.length > IMPORT_LIMIT) throw fail(400, `장은 한 번에 ${IMPORT_LIMIT}개까지 만들 수 있습니다 (${chapters.length}개)`);
  const wanted = chapters.map(ch => ({
    title: String(ch?.title ?? '').trim().slice(0, TITLE_LIMIT),
    level: Number.isInteger(ch?.level) && ch.level >= 1 && ch.level <= MAX_LEVEL ? ch.level : 1,
  }));
  // 장 파일을 다 만든 뒤에 목차에 붙인다 — 도중에 실패하면 만든 장을 캐시·폴더에서 걷어 내 목차(캐시)와 main.json 이 어긋나지 않게 한다
  const made = [];
  try {
    for (const { title, level } of wanted) {
      const entry = await makeChapter(current, title);
      entry.level = level;
      made.push(entry);
    }
  } catch (err) {
    for (const entry of made) {
      cache.chapters.delete(entry.id);
      await fs.rm(chapterDir(current.id, entry.id), { recursive: true, force: true }).catch(() => {});
    }
    throw err;
  }
  current.chapters = normalizeLevels([...current.chapters, ...made]);
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

// 보고서를 지우면 그 보고서의 장과 원문·거부 목록을 함께 지운다 (DR-WB-005). 양식은 작업공간 공통이라 남는다 (DR-WB-008)
export async function deleteBook(id) {
  const current = await book(id);
  await convert.cancelBook(id);
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
// 작성요령·참고문헌 문서 — 보고서가 소유하고 다른 보고서에 나타나지 않는다. 파일 처리는 lib/guides.js.

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
export async function addGuide({ bookId, kind, title, fileName, data, markdown, note = false }) {
  const current = await book(bookId);
  if (data != null && typeof data !== 'string') throw fail(400, 'data 는 base64 문자열이어야 합니다');
  const seq = Math.max(current.guideSeq || 0, ...guidesOf(current.id).map(g => Number(g.id.slice(2)) || 0)) + 1;
  const id = `G-${String(seq).padStart(3, '0')}`;
  const { guide, snapshotData } = await guides.buildGuide({ id, kind, title, fileName, data: data != null ? Buffer.from(data, 'base64') : null, markdown, note });
  await guides.writeGuide(bookDir(current.id), guide, snapshotData);
  current.guideSeq = seq;
  await writeBook(current);
  cache.guides.set(current.id, [...guidesOf(current.id), guide]);
  if (guide.type === 'pdf') await queueConvert(current.id, guide, 'all'); // 등록 때 본문으로 곧바로 쓰고, 에이전트 변환은 줄에 세운다 (FR-WB-097)
  return { guide: guides.guideSummary(guide), guides: listGuides(current.id) };
}

// 목록만 — 변환 상태를 화면이 몇 초마다 다시 받는다 (FR-WB-097)
export async function guideList(bookId) {
  const current = await book(bookId);
  return listGuides(current.id);
}

// 기준 문서 PDF 에이전트 변환 — 줄·에이전트·검사·조립은 lib/guide_convert.js (FR-WB-097, ERR-WB-012)
const queueConvert = (bookId, guide, mode) => convert.enqueue({ key: convert.keyOf(bookId, guide.id), dir: bookDir(bookId), guide, mode });

// action: start(처음부터 다시) · rest(검사를 통과한 묶음은 두고 남은 묶음만) · stop(멈추기 — 본문은 그대로)
export async function convertGuide({ bookId, id, action }) {
  const current = await book(bookId);
  const guide = findGuide(current.id, id);
  if (action === 'stop') {
    if (!(await convert.stop(convert.keyOf(current.id, id)))) throw fail(409, '대기·진행 중인 변환이 없거나 본문을 바꾸는 중입니다');
  } else if (action === 'start' || action === 'rest') {
    if (guide.type !== 'pdf' || !guide.snapshot) throw fail(400, 'PDF 로 올린 기준 문서만 변환합니다');
    if (guide.merges?.length) throw fail(409, '합친 문서는 변환할 수 없습니다 — 합치기를 되돌린 뒤 문서마다 변환해 주세요'); // (ERR-WB-013)
    await queueConvert(current.id, guide, action === 'rest' ? 'rest' : 'all');
  } else {
    throw fail(400, 'action 은 start · rest · stop 가운데 하나여야 합니다');
  }
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

// 끌어 놓은 문서(from)를 이 문서(id) 뒤에 이어 붙인다 · 마지막 합치기를 푼다 — 본문·보관본은 lib/guides.js (FR-WB-099, ERR-WB-013)
export async function mergeGuide({ bookId, id, from }) {
  const current = await book(bookId);
  const [target, member] = [findGuide(current.id, id), findGuide(current.id, from)];
  if (target === member) throw fail(400, '같은 문서에는 합칠 수 없습니다');
  if (target.note) throw fail(400, '에이전트가 정리한 작성자 요청 문서에는 다른 문서를 합칠 수 없습니다');
  if ([target, member].some(g => convert.isQueued(convert.keyOf(current.id, g.id)))) throw fail(409, '에이전트 변환 대기·진행 중인 문서는 합칠 수 없습니다 — 변환이 끝나거나 멈춘 뒤 합쳐 주세요');
  const merged = await guides.mergeGuides(bookDir(current.id), target, member);
  cache.guides.set(current.id, guidesOf(current.id).flatMap(g => (g === member ? [] : g === target ? [merged] : [g])));
  return { guide: guides.guideSummary(merged), guides: listGuides(current.id) };
}

export async function unmergeGuide({ bookId, id }) {
  const current = await book(bookId);
  const target = findGuide(current.id, id);
  const { restored, member } = await guides.unmergeGuide(bookDir(current.id), target);
  cache.guides.set(current.id, [...guidesOf(current.id).map(g => (g === target ? restored : g)), member].sort((a, b) => a.id.localeCompare(b.id)));
  return { guide: guides.guideSummary(restored), guides: listGuides(current.id) };
}

// 에이전트가 정리한 작성자 요청을 주제별 작성요령 문서로 저장한다 — 카드의 저장. before 는 수정안을 낼 때의 글 (FR-WB-100, ERR-WB-014)
export async function saveGuideNote({ bookId, topic, guideId, text, before = '' }) {
  const current = await book(bookId);
  const problem = noteProblem(topic, text);
  if (problem) throw fail(400, problem);
  if (!guideId) {
    if (guidesOf(current.id).some(g => g.note && g.title === cleanTopic(topic))) throw fail(409, `「${cleanTopic(topic)}」 주제의 작성요령이 그 사이에 생겼습니다 — 다시 요청하세요`);
    return addGuide({ bookId: current.id, kind: 'guideline', title: cleanTopic(topic), markdown: text, note: true });
  }
  const guide = guidesOf(current.id).find(g => g.id === guideId);
  if (!guide?.note || (guide.noteText || '') !== String(before)) throw fail(409, '수정안을 낸 뒤 이 작성요령 문서가 달라졌거나 지워졌습니다 — 다시 요청하세요');
  const next = await guides.updateNote(bookDir(current.id), guide, text);
  cache.guides.set(current.id, guidesOf(current.id).map(g => (g === guide ? next : g)));
  return { guide: guides.guideSummary(next), guides: listGuides(current.id) };
}

// 목차 수정안에 작성자가 적은 반영 의견·거부 사유·추가의견을 「수정안 검토 의견」 요청 문서에 한 줄 더한다 — 그 제목의 요청 문서가 없으면 만든다.
// 같은 보고서의 의견은 차례대로 더한다(잇달아 거부해도 줄을 잃지 않게) (FR-WB-103, ERR-WB-017)
const reviewQueue = new Map();
export function addReviewNote({ bookId, action, what, comment }) {
  const run = (reviewQueue.get(bookId) || Promise.resolve()).then(() => appendReview({ bookId, action, what, comment }));
  reviewQueue.set(bookId, run.catch(() => {}));
  return run;
}
async function appendReview({ bookId, action, what, comment }) {
  const current = await book(bookId);
  const { line, problem } = reviewLine({ action, what, comment });
  if (problem) throw fail(400, problem);
  const guide = guidesOf(current.id).find(isReviewNote);
  const text = guide?.noteText ? `${guide.noteText}\n${line}` : line;
  const tooLong = noteProblem(REVIEW_TOPIC, text);
  if (tooLong) throw fail(400, `${tooLong} — 「${REVIEW_TOPIC}」을 정리하거나 지운 뒤 다시 남기세요`);
  return saveGuideNote({ bookId: current.id, topic: REVIEW_TOPIC, guideId: guide?.id, text, before: guide?.noteText || '' });
}

// 보관 파일까지 지운다 — 이미 반영된 장의 지시문은 바꾸지 않는다 (FR-WB-085)
export async function deleteGuide(bookId, id) {
  const current = await book(bookId);
  const guide = findGuide(current.id, id);
  cache.guides.set(current.id, guidesOf(current.id).filter(g => g !== guide));
  await convert.cancel(convert.keyOf(current.id, id)); // 변환을 끊고 그 기록이 끝난 뒤에 지운다 — 지운 파일이 되살아나지 않게
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

// ───────────────────────────── 보고서 화면 대화 보관 (FR-WB-101, DR-WB-010) ─────────────────────────────
// 파일 조작은 lib/book_chats.js. 보고서 폴더 안에 두어 보고서를 지우면 함께 지워진다.

export async function bookChatList(bookId) {
  const current = await book(bookId);
  return chats.listChats(bookDir(current.id));
}

export async function getBookChat(bookId, id) {
  const current = await book(bookId);
  return chats.readChat(bookDir(current.id), id);
}

// 에이전트가 답을 마칠 때마다 — id 가 없으면 새 번호로 만들고, 있으면 문답만 바꾼다(그사이 지워졌으면 null).
// 번호는 지운 뒤에도 다시 쓰지 않는다 — 발급한 마지막 번호를 main.json(chatSeq)에 둔다. 발급은 await 없이 해 동시에 끝난 답끼리 겹치지 않는다
export async function saveBookChat({ bookId, id, messages }) {
  const current = await book(bookId);
  if (id) return chats.saveMessages(bookDir(current.id), id, messages);
  current.chatSeq = (current.chatSeq || 0) + 1;
  const [created] = await Promise.all([chats.createChat(bookDir(current.id), chats.chatId(current.chatSeq), messages), writeBook(current)]);
  return created;
}

// 닫을 때의 분류 — 장은 이 보고서의 목차에 있어야 한다 (ERR-WB-015)
export async function classifyBookChat({ bookId, id, chapterId = null, topic, title }) {
  const current = await book(bookId);
  if (chapterId && !current.chapters.some(ch => ch.id === chapterId)) throw fail(400, '이 보고서의 목차에 없는 장입니다');
  return chats.chatSummary(await chats.classifyChat(bookDir(current.id), id, { chapterId, topic, title }));
}

export async function deleteBookChat(bookId, id) {
  const current = await book(bookId);
  await chats.removeChat(bookDir(current.id), id);
  return { chats: await chats.listChats(bookDir(current.id)) };
}

// 분류 제안에 주는 것 — 대화 전문, 목차, 이 보고서의 보관 대화에서 쓴 주제
export async function bookChatContext(bookId, id) {
  const current = await book(bookId);
  const [chat, list] = await Promise.all([chats.readChat(bookDir(current.id), id), chats.listChats(bookDir(current.id))]);
  return { chat, chapters: current.chapters.map(ch => ({ id: ch.id, title: ch.title, level: ch.level || 1 })), topics: [...new Set(list.map(c => c.topic).filter(Boolean))] };
}

// ───────────────────────────── 양식 (FR-WB-090 ~ 092, 094, 095, DR-WB-008, DR-WB-009) ─────────────────────────────
// 작성자가 올린 docx·hwpx·hwp 양식 — 보고서에 속하지 않는 작업공간 공통 문서다(<WORKSPACE>/forms/). 어느 보고서에서 열어도 같은 목록·같은 값이고 보고서를 지워도 남는다.
// 경로의 bookId 는 맥락 보고서(양식 화면 3열의 원문·에이전트가 읽는 보고서)라 있는 보고서인지만 본다. 칸·필드 값을 채워 새 사본으로 내려받는다. 파일 처리는 lib/forms.js.
// 양식의 헤딩을 장으로 가져오는 것은 importChapters(위) 다 (FR-WB-093). 작성자가 조절한 상하관계는 작업공간 수준 구조 규칙으로 남긴다(lib/form_rules.js).

// 목록 — 구조 없이
export function listForms() {
  return cache.forms.map(forms.formSummary);
}

export async function formList(bookId) {
  await book(bookId);
  return listForms();
}

function findForm(id) {
  const found = cache.forms.find(f => f.id === id);
  if (!found) throw fail(404, '양식을 찾지 못했습니다');
  return found;
}

export async function getForm(bookId, id) {
  await book(bookId);
  return findForm(id);
}

// 파일은 base64 문자열로 받는다. 번호는 작업공간 안에서 고유하고 삭제한 뒤에도 다시 쓰지 않는다(workspace.json formSeq) — 쓰기에 성공한 뒤에만 올려서 거절된 올리기는 번호도 파일도 남기지 않는다.
// 올릴 때 작업공간의 구조 규칙을 적용하고 그 건수(rulesApplied)를 알린다 (FR-WB-095)
export async function addForm({ bookId, title, fileName, data }) {
  await book(bookId);
  if (typeof data !== 'string') throw fail(400, 'data 는 base64 문자열이어야 합니다');
  const seq = Math.max(cache.formSeq || 0, ...cache.forms.map(f => Number(f.id.slice(2)) || 0)) + 1;
  const built = await forms.buildForm({ id: `F-${String(seq).padStart(3, '0')}`, title, fileName, data: Buffer.from(data, 'base64'), rules: cache.formRules });
  await forms.writeForm(WORKSPACE, built.form, built.original);
  cache.formSeq = seq;
  await writeWorkspace();
  cache.forms = [...cache.forms, built.form];
  return { form: built.form, forms: listForms(), rulesApplied: built.rulesApplied };
}

// 구조 조절(structure)이 있으면 값 패치보다 먼저 반영하고(값 검사는 바뀐 단위 기준), 바뀐 노드마다 구조 규칙을 남긴다 —
// 원래(스캔) 상태로 되돌린 노드는 그 규칙을 지운다. 헤딩 바로 뒤의 빈 필드는 글이 없어 규칙을 남기지 않는다 (FR-WB-094, FR-WB-095)
export async function saveForm({ bookId, id, title, values, instructions, structure }) {
  const current = await book(bookId); // 맥락 보고서 — 규칙에 「그때 열어 둔 보고서」로 남는다
  const form = findForm(id);
  const draft = structuredClone(form); // 거절되면 캐시도 그대로
  const changes = structure === undefined ? [] : forms.applyStructure(draft, structure);
  forms.applyFormPatch(draft, { title, values, instructions });
  let rules = cache.formRules;
  for (const { i, after, reverted } of changes) {
    const node = draft.nodes[i];
    if (node.empty) continue;
    const key = { heading: structureRules.contextOf(draft.nodes, i), text: node.text };
    rules = reverted
      ? structureRules.removeRule(rules, key)
      : structureRules.upsertRule(rules, { ...key, kind: after.kind, level: after.level, from: node.orig, fileName: draft.fileName, bookId: current.id, formId: id });
  }
  await forms.rewriteForm(WORKSPACE, draft);
  if (rules !== cache.formRules) {
    await structureRules.saveRules(WORKSPACE, rules);
    cache.formRules = rules;
  }
  Object.assign(form, draft);
  return { form, forms: listForms(), rules: cache.formRules };
}

// ── 구조 규칙 — 작업공간 수준 <WORKSPACE>/form_rules.json (FR-WB-095, DR-WB-009)

export function listFormRules() {
  return cache.formRules;
}

export async function formRules() {
  await load();
  return { rules: listFormRules() };
}

export async function deleteFormRule(id) {
  await load();
  if (!cache.formRules.some(rule => rule.id === id)) throw fail(404, '구조 규칙을 찾지 못했습니다');
  const rules = structureRules.removeRule(cache.formRules, id);
  await structureRules.saveRules(WORKSPACE, rules);
  cache.formRules = rules;
  return { rules };
}

export async function deleteForm(bookId, id) {
  await book(bookId);
  const form = findForm(id);
  cache.forms = cache.forms.filter(f => f !== form);
  await forms.removeFormFiles(WORKSPACE, form);
  return { forms: listForms() };
}

// 올린 원본 그대로, 또는 값을 기입한 새 사본(다시 읽어 확인한 것) (FR-WB-092)
export async function readFormFile(bookId, id, kind) {
  await book(bookId);
  const form = findForm(id);
  const original = await forms.readOriginal(WORKSPACE, form);
  if (kind === 'original') return { data: original, name: `${form.id}.${form.format}`, downloadName: form.fileName };
  return forms.exportForm(form, original);
}

// 양식 에이전트가 읽는 상태: 양식 하나(구조·값·지침 전체)와 양식을 연 맥락 보고서 전체, 작업공간의 구조 규칙(프롬프트 <form_rules>) (FR-WB-091, 095)
export async function formAgentState(bookId, formId) {
  const current = await book(bookId);
  return { form: findForm(formId), book: await bookAgentState(current.id), rules: cache.formRules };
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
