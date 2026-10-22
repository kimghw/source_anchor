// 데이터 분석 — 작성자가 에이전트와 함께 보고서의 기준 문서·원문을 분석해 결과를 파일로 남기는 작업 단위 (FR-WB-088, 106, DR-WB-007, ERR-WB-010).
//   workspace/projects/<보고서 ID>/analyses/<A-번호>/analysis.json  { id, title, messages: [{ role, text, model?, at }], createdAt, updatedAt }
//   workspace/projects/<보고서 ID>/analyses/<A-번호>/results/…      결과 파일 — 에이전트가 작업 폴더의 results/ 에 쓴 상대 경로 그대로
// 파일 조작과 결과 폴더 맞추기만 한다. 보고서 찾기·번호 발급(main.json 의 analysisSeq)은 lib/store.js 가, 에이전트 실행은 agent.js 가 한다.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const RESULT_EXTS = ['.json', '.yaml', '.yml', '.csv', '.md', '.txt']; // DR-WB-007
export const RESULT_FILE_LIMIT = 20 * 1024 * 1024;
export const RESULT_COUNT_LIMIT = 500;
export const PREVIEW_LIMIT = 2 * 1024 * 1024; // 1열 내용 보기에 싣는 바이트 수 — 넘으면 잘렸다고 표시한다 (FR-WB-088)
const TITLE_LIMIT = 200;
const SEGMENT_LIMIT = 120;
const PATH_LIMIT = 300;
const ID_RE = /^A-\d{3,}$/;
const BAD_SEGMENT = /[<>:"|?*\\\u0000-\u001f]/; // Windows 에서 파일 이름에 쓸 수 없는 글자와 제어 문자

const fail = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const dirOf = bookDir => path.join(bookDir, 'analyses');
const analysisDir = (bookDir, id) => path.join(dirOf(bookDir), id);
const recordFile = (bookDir, id) => path.join(analysisDir(bookDir, id), 'analysis.json');
export const resultsDir = (bookDir, id) => path.join(analysisDir(bookDir, id), 'results');
const sha1 = data => crypto.createHash('sha1').update(data).digest('hex');
const BOM = String.fromCharCode(0xfeff);

export const cleanTitle = title => String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_LIMIT) || '제목 없는 분석';
export const analysisId = seq => `A-${String(seq).padStart(3, '0')}`;

// 같은 분석 파일을 고치는 일은 차례로 한다 — 답이 끝나 문답을 보관하는 것과 제목 저장이 겹쳐도 한쪽이 다른 쪽을 덮지 않게
const queues = new Map();
function serial(key, fn) {
  const next = (queues.get(key) || Promise.resolve()).catch(() => {}).then(fn);
  queues.set(key, next);
  next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
  return next;
}

async function writeAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

// ───────────────────────────── 분석 기록 ─────────────────────────────

export async function loadAnalyses(bookDir) {
  const names = (await fs.readdir(dirOf(bookDir)).catch(() => [])).filter(name => ID_RE.test(name)).sort();
  const list = [];
  for (const name of names) {
    const record = await fs.readFile(recordFile(bookDir, name), 'utf8').then(JSON.parse).catch(() => null);
    if (record?.id === name) list.push(record);
  }
  return list;
}

export function newAnalysis(id, title) {
  const at = now();
  return { id, title: cleanTitle(title), messages: [], createdAt: at, updatedAt: at };
}

const toMessages = messages => messages.map(m => ({ role: m.role, text: String(m.text ?? ''), ...(m.model ? { model: m.model } : {}), at: m.at || now() }));

export function writeAnalysis(bookDir, record) {
  const file = recordFile(bookDir, record.id);
  return serial(file, () => writeAtomic(file, JSON.stringify({ id: record.id, title: record.title, messages: toMessages(record.messages), createdAt: record.createdAt, updatedAt: record.updatedAt }, null, 2)));
}

export function removeAnalysis(bookDir, id) {
  const file = recordFile(bookDir, id);
  return serial(file, () => fs.rm(analysisDir(bookDir, id), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
}

// 목록·탐색기에 싣는 요약 — 문답은 빼고 결과 파일 수만
export const analysisSummary = (record, results) => ({ id: record.id, title: record.title, results, messages: record.messages.length, createdAt: record.createdAt, updatedAt: record.updatedAt });

// ───────────────────────────── 결과 파일 ─────────────────────────────

// 결과 폴더 기준 상대 경로(/ 로 잇는다)를 검사한다 → 문제가 없으면 null
export function resultPathProblem(rel) {
  const parts = String(rel ?? '').split('/');
  if (!rel || rel.length > PATH_LIMIT) return '경로가 비었거나 너무 깁니다';
  if (parts.some(p => !p || p === '.' || p === '..' || p.length > SEGMENT_LIMIT || BAD_SEGMENT.test(p) || /[. ]$/.test(p))) return '쓸 수 없는 경로입니다';
  if (!RESULT_EXTS.includes(path.extname(rel).toLowerCase())) return `남길 수 있는 형식(${RESULT_EXTS.join(' ')})이 아닙니다`;
  return null;
}

function resultFile(bookDir, id, rel) {
  const problem = resultPathProblem(rel);
  if (problem) throw fail(400, `${rel}: ${problem}`);
  return path.join(resultsDir(bookDir, id), ...rel.split('/'));
}

// 폴더 아래의 파일을 모두 — 상대 경로(/), 크기, 수정 시각. 링크는 따라가지 않는다
async function walk(root, prefix = '') {
  const out = [];
  for (const entry of await fs.readdir(path.join(root, ...prefix.split('/').filter(Boolean)), { withFileTypes: true }).catch(() => [])) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await walk(root, rel));
    else if (entry.isFile()) {
      const full = path.join(root, ...rel.split('/'));
      const stat = await fs.stat(full).catch(() => null);
      if (stat) out.push({ rel, full, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return out;
}

// JSON 파일이 JSON 으로 읽히는지 — 같은 파일(경로·크기·수정 시각)은 한 번만 읽는다
const jsonChecks = new Map();
async function jsonInvalid(file) {
  const key = `${file.full}|${file.size}|${file.mtimeMs}`;
  if (!jsonChecks.has(key)) {
    let invalid = false;
    try {
      const text = await fs.readFile(file.full, 'utf8');
      JSON.parse(text.startsWith(BOM) ? text.slice(1) : text);
    } catch {
      invalid = true;
    }
    if (jsonChecks.size > 2000) jsonChecks.clear();
    jsonChecks.set(key, invalid);
  }
  return jsonChecks.get(key);
}

// 1열 목록 — 경로 순서. JSON 은 형식 오류 여부를 붙인다 (FR-WB-088)
export async function listResults(bookDir, id) {
  const files = (await walk(resultsDir(bookDir, id))).filter(f => !f.rel.endsWith('.tmp')).sort((a, b) => a.rel.localeCompare(b.rel));
  return Promise.all(files.map(async f => {
    const ext = path.extname(f.rel).toLowerCase();
    return { path: f.rel, ext: ext.slice(1), size: f.size, updatedAt: new Date(f.mtimeMs).toISOString(), ...(ext === '.json' && f.size <= RESULT_FILE_LIMIT && await jsonInvalid(f) ? { invalid: true } : {}) };
  }));
}

export async function readResult(bookDir, id, rel) {
  const file = resultFile(bookDir, id, rel);
  try {
    return { data: await fs.readFile(file), name: path.basename(file) };
  } catch (err) {
    if (err.code === 'ENOENT') throw fail(404, `결과 파일을 찾지 못했습니다: ${rel}`);
    throw err;
  }
}

export async function deleteResult(bookDir, id, rel) {
  const file = resultFile(bookDir, id, rel);
  await fs.rm(file, { force: true });
  await pruneEmpty(resultsDir(bookDir, id), path.dirname(file));
}

// 파일을 지운 뒤 비게 된 하위 폴더를 결과 폴더까지 거슬러 지운다
async function pruneEmpty(root, dir) {
  while (dir.startsWith(root + path.sep)) {
    if ((await fs.readdir(dir).catch(() => ['?'])).length) return;
    await fs.rmdir(dir).catch(() => {});
    dir = path.dirname(dir);
  }
}

// ───────────────────────────── 작업 폴더와 맞추기 (FR-WB-106 (c)) ─────────────────────────────
// known: 지난번에 맞춘 때의 작업 폴더 파일 — Map(상대 경로 → { size, mtimeMs, hash, skipped? }). 크기·수정 시각이 같으면 다시 읽지 않는다.

// 응답을 시작할 때 작업 폴더의 results/ 를 그 분석의 지금 결과 파일로 채운다 → known
export async function seedResults(bookDir, id, viewRoot) {
  await fs.rm(viewRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await fs.mkdir(viewRoot, { recursive: true });
  await fs.cp(resultsDir(bookDir, id), viewRoot, { recursive: true }).catch(err => { if (err.code !== 'ENOENT') throw err; });
  const known = new Map();
  for (const f of await walk(viewRoot)) known.set(f.rel, { size: f.size, mtimeMs: f.mtimeMs, hash: sha1(await fs.readFile(f.full)) });
  return known;
}

// 작업 폴더에서 새로 생기거나 바뀐 파일을 분석에 저장하고, 작업 폴더에서 사라진 파일은 분석에서도 지운다.
// 작성자가 그사이 1열에서 지운 파일은 작업 폴더에서 바뀌지 않았으면 되살리지 않는다. 허용하지 않는 파일은 남기지 않고 한 번만 알린다 (ERR-WB-010)
// → { saved: [경로], removed: [경로], skipped: [{ path, reason }], known }
export async function syncResults(bookDir, id, viewRoot, known) {
  const saved = [];
  const removed = [];
  const skipped = [];
  const next = new Map();
  let count = 0;
  for (const f of (await walk(viewRoot)).sort((a, b) => a.rel.localeCompare(b.rel))) {
    const prev = known.get(f.rel);
    if (prev && prev.size === f.size && prev.mtimeMs === f.mtimeMs) {
      next.set(f.rel, prev);
      if (!prev.skipped) count++;
      continue;
    }
    const problem = resultPathProblem(f.rel) || (f.size > RESULT_FILE_LIMIT ? `${RESULT_FILE_LIMIT / 1024 / 1024}MiB 를 넘습니다` : null) || (count >= RESULT_COUNT_LIMIT ? `한 분석의 결과 파일은 ${RESULT_COUNT_LIMIT}개까지입니다` : null);
    if (problem) {
      next.set(f.rel, { size: f.size, mtimeMs: f.mtimeMs, skipped: true });
      skipped.push({ path: f.rel, reason: problem });
      continue;
    }
    const data = await fs.readFile(f.full).catch(() => null);
    if (!data) continue; // 그사이 지워졌다 — 다음에 맞출 때 사라진 파일로 다룬다
    const entry = { size: f.size, mtimeMs: f.mtimeMs, hash: sha1(data) };
    next.set(f.rel, entry);
    count++;
    if (prev && !prev.skipped && prev.hash === entry.hash) continue; // 수정 시각만 바뀌었다
    try {
      await writeAtomic(path.join(resultsDir(bookDir, id), ...f.rel.split('/')), data);
      saved.push(f.rel);
    } catch (err) {
      next.delete(f.rel); // 다음에 맞출 때 다시 해 본다
      skipped.push({ path: f.rel, reason: `저장하지 못했습니다: ${err.message}` });
    }
  }
  for (const [rel, prev] of known) {
    if (next.has(rel) || prev.skipped || resultPathProblem(rel)) continue;
    await deleteResult(bookDir, id, rel).catch(() => {});
    removed.push(rel);
  }
  return { saved, removed, skipped, known: next };
}
