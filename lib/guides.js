// 기준 문서 — 작성요령(규정·규칙·요령·요구사항)·참고문헌 문서를 보고서 단위로 보관한다 (FR-WB-085, DR-WB-006).
//   workspace/projects/<보고서 ID>/guides/<G-번호>.json   서지정보·종류·문장·표 단위 본문(블록)
//   … /guides/<G-번호>.md                                 변환한 Markdown (원본과 한 쌍) — 문장마다 줄 앞에 [ID] (DR-WB-006)
//   … /guides/originals/<G-번호>.<확장자>                 올린 원본 파일 (붙여 넣은 문서에는 없다)
//   … /guides/parts/<G-번호>/part-NN.md                   PDF 에이전트 변환의 20쪽 묶음 Markdown (lib/guide_convert.js — FR-WB-097)
//   … /guides/merged/<G-번호>.json · <G-번호>@<n>.json    합친 문서(FR-WB-099)의 되돌리기용 보관본 — 붙은 문서 · 놓은 문서의 n 번째 합치기 직전
// 장의 원문(S-번호)과 모양은 같지만 근거로 인용하지 않는다 — 앵커 색인(buildAnchorIndex)은 장의 원문만 본다.
// 파일·캐시 조작은 lib/store.js 가 이 모듈을 불러 한다. 이 모듈은 store 를 import 하지 않는다.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { guideKind } from '../public/shared/instructions.js';
import { buildBlocks } from '../public/shared/model.js';
import { convertDocument } from './collect.js';
import { markdownDrafts, OFFICE_FORMATS, officeDocument, textDrafts } from './guide_formats.js';
import { mergeBlocks, mergedCount } from './guide_merge.js';
import { cleanNote, NOTE_METHOD } from './guide_notes.js';
import { isStructured, itemNodes, structure } from './guide_outline.js';
import { markdownToDrafts } from './ingest.js';
import { sourceMarkdown } from './source_md.js';

export const GUIDE_FILE_LIMIT = 5 * 1024 * 1024; // 올리는 원본 파일 하나의 크기 상한 (FR-WB-085)
const TITLE_LIMIT = 300;
const NAME_LIMIT = 260;
const REJECTED_EXT = { '.doc': 'DOC', '.xlsx': 'XLSX', '.xls': 'XLS', '.ppt': 'PPT(예전 형식)' }; // 변환기가 없는 형식은 먼저 거절한다 (ERR-WB-008)
const CONTENT_TYPES = { '.pdf': 'application/pdf', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.html': 'text/html', '.htm': 'text/html', '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain' };
const MARKDOWN_EXT = new Set(['.md', '.markdown']);

const fail = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const guidesDir = dir => path.join(dir, 'guides');
const jsonFile = (dir, id) => path.join(guidesDir(dir), `${id}.json`);
const mdFile = (dir, id) => path.join(guidesDir(dir), `${id}.md`);
export const partsDir = (dir, id) => path.join(guidesDir(dir), 'parts', id);
export const originalFile = (dir, guide) => (guide.snapshot ? path.join(guidesDir(dir), guide.snapshot) : null);
const guideMarkdown = guide => sourceMarkdown(guide, { ids: true }); // 기준 문서의 Markdown 은 문장마다 ID 를 적는다 (DR-WB-006)
const HAS_IDS = /^(?:#{1,6} |- )?\[G-\d{3,}\./m;

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

export const cleanKind = guideKind; // 저장·수정·읽기에서 두 종류로 맞춘다 — 규칙은 shared/instructions.js (DR-WB-006)
export const cleanTitle = title => String(title || '').trim().slice(0, TITLE_LIMIT);

// 보고서 폴더의 기준 문서를 모두 읽는다 — 구조 계층이 없는 옛 문서는 정해 json 에 남기고, Markdown 파일이 없거나 문장 ID·구조 목록이 없는 옛 형식이면 다시 쓴다 (DR-WB-006)
export async function loadGuides(dir) {
  const files = (await fs.readdir(guidesDir(dir)).catch(() => [])).filter(f => /^G-\d{3,}\.json$/.test(f)).sort();
  const list = [];
  for (const f of files) {
    const guide = JSON.parse(await fs.readFile(path.join(guidesDir(dir), f), 'utf8'));
    guide.kind = cleanKind(guide.kind); // 옛 종류는 읽을 때 두 종류로 맞춘다 — 파일은 다음에 고칠 때 바뀐다
    const restructured = !isStructured(guide.blocks);
    if (restructured) await writeJson(jsonFile(dir, guide.id), { ...guide, blocks: structure(guide.blocks) });
    const md = restructured ? null : await fs.readFile(mdFile(dir, guide.id), 'utf8').catch(() => null);
    if (md === null || (guide.blocks.length && !HAS_IDS.test(md))) await fs.writeFile(mdFile(dir, guide.id), guideMarkdown(guide));
    list.push(guide);
  }
  // 합치기·되돌리기가 중간에 끊겨 합친 문서에 든 문서가 목록에 남았으면 합친 쪽을 따른다 — 그 문서는 merged/ 에 보관본이 있다 (ERR-WB-013)
  const absorbed = new Set(list.flatMap(g => (g.merges || []).map(m => m.id)));
  for (const g of list.filter(g => absorbed.has(g.id))) {
    await fs.rm(mdFile(dir, g.id), { force: true });
    await fs.rm(jsonFile(dir, g.id), { force: true });
  }
  return list.filter(g => !absorbed.has(g.id));
}

// 올린 파일(data) 또는 붙여 넣은 본문(markdown)을 기준 문서 하나로 바꾼다. 변환에 실패하면 status 400 오류 — 아무것도 남기지 않는다 (ERR-WB-008)
// note: 에이전트가 정리한 작성자 요청 문서 — 본문(markdown)을 요청 목록 그대로 noteText 에도 둔다 (FR-WB-100)
export async function buildGuide({ id, kind, title, fileName, data, markdown, note = false }) {
  const name = String(fileName || '').trim().slice(0, NAME_LIMIT);
  let converted;
  if (data) {
    if (!Buffer.isBuffer(data)) throw fail(400, '파일 내용이 필요합니다');
    if (data.length > GUIDE_FILE_LIMIT) throw fail(413, `파일이 ${GUIDE_FILE_LIMIT / 1024 / 1024}MiB 를 넘습니다 (${(data.length / 1024 / 1024).toFixed(1)}MiB)`);
    if (!data.length) throw fail(400, '빈 파일입니다');
    const ext = path.extname(name).toLowerCase();
    if (REJECTED_EXT[ext]) throw fail(400, `지원하지 않는 형식(${REJECTED_EXT[ext]})입니다 — PDF·PPT(pptx)·HTML·Markdown·텍스트·Word(docx)·한글(hwpx·hwp)로 바꿔 올려 주세요`);
    try {
      // 형식별 변환 (DR-WB-006) — Word·한글은 문단·표 구조로, 텍스트는 글자 그대로(번호 줄에서 문단을 나눈다), Markdown 은 표시대로(번호 목록의 번호는 글자로, 굵게 등은 빼고) 읽는다
      if (OFFICE_FORMATS[ext.slice(1)]) converted = officeDocument(data, ext.slice(1), name);
      else {
        converted = await convertDocument({ data, contentType: CONTENT_TYPES[ext] || '', name, minChars: 1 });
        if (ext === '.txt' && converted.type === 'text') converted.drafts = textDrafts(converted.markdown);
        if (MARKDOWN_EXT.has(ext) && converted.type === 'text') converted.drafts = markdownDrafts(converted.markdown);
        if (MARKDOWN_EXT.has(ext) && converted.snapshot?.ext === 'txt') converted.snapshot.ext = 'md'; // 원본은 올린 형식 그대로 보관한다
      }
    } catch (err) {
      if (err.collect || err.format) throw fail(400, err.message);
      throw err;
    }
  } else {
    const text = String(markdown || '');
    if (!text.trim()) throw fail(400, '본문이 비어 있습니다');
    converted = { type: 'text', title: '', markdown: text, drafts: markdownDrafts(text) };
  }
  const drafts = itemNodes(converted.drafts ?? markdownToDrafts(converted.markdown)); // 번호로 시작하는 목록 항목도 구조 마디로 뗀다
  if (!drafts.length) throw fail(400, '문서에서 본문을 얻지 못했습니다');
  const guide = {
    id,
    version: 'V-001',
    kind: cleanKind(kind),
    type: converted.type,
    title: cleanTitle(title) || cleanTitle(converted.title) || name || '제목 없는 기준 문서',
    fileName: name,
    publisher: '',
    publishedAt: '',
    url: '',
    collectedAt: now(),
    method: data ? '작성자가 올린 파일' : note ? NOTE_METHOD : '작성자가 붙여 넣은 본문',
    hash: 'sha256:' + crypto.createHash('sha256').update(data ?? String(markdown)).digest('hex'),
    ...(converted.snapshot ? { snapshot: `originals/${id}.${converted.snapshot.ext}` } : {}),
    blocks: structure(buildBlocks(id, drafts)), // 문장 ID 와 함께 구조 계층(상위 마디·번호·깊이)도 정한다 (DR-WB-006)
    ...(note && !data ? { note: true, noteText: cleanNote(markdown) } : {}),
  };
  return { guide, snapshotData: converted.snapshot?.data ?? null };
}

// 요청 문서의 글을 바꾼 새 판을 쓰고 돌려준다 — 종류·제목·등록 시각은 그대로, 본문·문장 ID 는 새 글로 (FR-WB-100)
export async function updateNote(dir, guide, text) {
  const { guide: built } = await buildGuide({ id: guide.id, kind: guide.kind, title: guide.title, markdown: text, note: true });
  const next = { ...built, kind: guide.kind, title: guide.title, collectedAt: guide.collectedAt, version: nextVersion(guide.version) };
  await rewriteGuide(dir, next);
  return next;
}

// 파일 세 가지(원본·json·Markdown)를 쓴다 — 하나라도 실패하면 쓴 것을 되돌려 일부만 남지 않게 한다 (ERR-WB-008)
export async function writeGuide(dir, guide, snapshotData) {
  try {
    if (guide.snapshot) {
      await fs.mkdir(path.join(guidesDir(dir), 'originals'), { recursive: true });
      await fs.writeFile(path.join(guidesDir(dir), guide.snapshot), snapshotData);
    }
    await fs.mkdir(guidesDir(dir), { recursive: true });
    await fs.writeFile(mdFile(dir, guide.id), guideMarkdown(guide));
    await writeJson(jsonFile(dir, guide.id), guide);
  } catch (err) {
    await removeGuideFiles(dir, guide);
    throw err;
  }
}

export async function rewriteGuide(dir, guide) {
  await writeJson(jsonFile(dir, guide.id), guide);
  await fs.writeFile(mdFile(dir, guide.id), guideMarkdown(guide)); // 제목이 Markdown 머리말에 들어간다
}

// 본문은 그대로 두고 json 만 — 변환 진행 상태를 남길 때 (lib/guide_convert.js)
export const writeGuideJson = (dir, guide) => writeJson(jsonFile(dir, guide.id), guide);

// 합친 문서면 그 안에 든 문서들(보관본 — 그 문서가 또 합친 문서면 그 안까지)의 파일과 합치기 직전 보관본도 지운다 (FR-WB-099)
export async function removeGuideFiles(dir, guide) {
  await fs.rm(jsonFile(dir, guide.id), { force: true });
  await fs.rm(mdFile(dir, guide.id), { force: true });
  if (guide.snapshot) await fs.rm(path.join(guidesDir(dir), guide.snapshot), { force: true });
  await fs.rm(partsDir(dir, guide.id), { recursive: true, force: true });
  for (const [i, m] of (guide.merges || []).entries()) {
    const member = await readArchive(dir, m.id).catch(() => null);
    if (member) await removeGuideFiles(dir, member);
    await fs.rm(archiveFile(dir, m.id), { force: true });
    await fs.rm(archiveFile(dir, `${guide.id}@${i + 1}`), { force: true });
  }
}

// ───────────────────────────── 합치기 · 되돌리기 (FR-WB-099, ERR-WB-013) ─────────────────────────────
// 붙은 문서의 원본·묶음 파일은 제자리(originals/·parts/)에 그대로 두고, 두 문서의 합치기 직전 json 을 merged/ 에 둔다 — 식별자는 다시 쓰지 않으므로 겹치지 않는다

const archiveFile = (dir, name) => path.join(guidesDir(dir), 'merged', `${name}.json`);
const readArchive = async (dir, name) => JSON.parse(await fs.readFile(archiveFile(dir, name), 'utf8'));
const nextVersion = version => `V-${String((Number(String(version || 'V-001').slice(2)) || 1) + 1).padStart(3, '0')}`;

// 끌어 온 문서(member)를 놓은 문서(target) 뒤에 이어 붙인 문서를 쓰고 돌려준다 — 인자는 고치지 않는다.
// 붙은 문서의 json·md 는 마지막에 지운다: 그 앞에서 실패하면 놓은 문서를 직전 상태로 다시 쓰고 보관본을 지워 두 문서가 그대로 남는다
export async function mergeGuides(dir, target, member) {
  const n = (target.merges?.length || 0) + 1;
  const merged = {
    ...structuredClone(target),
    version: nextVersion(target.version),
    blocks: mergeBlocks(target, member),
    merges: [...(target.merges || []), { id: member.id, title: member.title, fileName: member.fileName, docs: mergedCount(member), at: now() }],
  };
  try {
    await writeJson(archiveFile(dir, `${target.id}@${n}`), target);
    await writeJson(archiveFile(dir, member.id), member);
    await rewriteGuide(dir, merged);
    await fs.rm(mdFile(dir, member.id), { force: true });
    await fs.rm(jsonFile(dir, member.id));
  } catch (err) {
    await rewriteGuide(dir, target).catch(() => {});
    await fs.rm(archiveFile(dir, `${target.id}@${n}`), { force: true }).catch(() => {});
    await fs.rm(archiveFile(dir, member.id), { force: true }).catch(() => {});
    throw err;
  }
  return merged;
}

// 마지막 합치기를 푼다 → { restored(놓은 문서 — 합치기 직전 그대로, 판만 하나 올린다), member(붙었던 문서 — 합치기 직전 그대로) }
export async function unmergeGuide(dir, target) {
  const n = target.merges?.length || 0;
  if (!n) throw fail(400, '합친 문서가 아닙니다');
  const last = target.merges[n - 1];
  const [before, member] = await Promise.all([readArchive(dir, `${target.id}@${n}`), readArchive(dir, last.id)])
    .catch(() => { throw fail(500, `합치기 전 보관본(${target.id}·${last.id})을 찾지 못했습니다`); });
  const restored = { ...before, kind: cleanKind(before.kind), version: nextVersion(target.version) };
  member.kind = cleanKind(member.kind);
  try {
    await rewriteGuide(dir, member);
    await rewriteGuide(dir, restored);
  } catch (err) {
    await rewriteGuide(dir, target).catch(() => {});
    await fs.rm(mdFile(dir, member.id), { force: true }).catch(() => {});
    await fs.rm(jsonFile(dir, member.id), { force: true }).catch(() => {});
    throw err;
  }
  await fs.rm(archiveFile(dir, `${target.id}@${n}`), { force: true });
  await fs.rm(archiveFile(dir, member.id), { force: true });
  return { restored, member };
}

// 보관한 원본 파일 또는 Markdown 파일 — 붙여 넣은 문서에는 원본이 없다
export async function readGuideFile(dir, guide, kind) {
  if (kind === 'original' && !guide.snapshot) throw fail(404, '이 기준 문서는 붙여 넣은 본문이라 올린 원본이 없습니다');
  const file = kind === 'original' ? path.join(guidesDir(dir), guide.snapshot) : mdFile(dir, guide.id);
  const data = await fs.readFile(file).catch(() => { throw fail(404, '보관한 파일을 찾지 못했습니다'); });
  return { data, name: path.basename(file), ...(kind === 'original' && guide.fileName ? { downloadName: guide.fileName } : {}) }; // 내려받는 원본(Word·한글·PPT)은 올린 파일 이름으로
}

// 에이전트 변환 상태의 요약 — 목록 줄의 표시(대기·진행 묶음 수·완료·일부 자동 변환·멈춤·건너뜀)에 쓴다 (FR-WB-097)
export function convertSummary(c) {
  if (!c) return undefined;
  const parts = c.parts || [];
  return { state: c.state, model: c.model || '', reason: c.reason || '', finishedAt: c.finishedAt || '', total: parts.length, done: parts.filter(p => p.state === 'done' || p.state === 'fallback').length, fallback: parts.filter(p => p.state === 'fallback').map(p => `${p.from}–${p.to}`) };
}

// 목록에 싣는 요약 — 본문(블록)은 빼고 열람 화면이 보기 방식을 정하는 데 필요한 것(snapshot)은 남긴다
export const guideSummary = g => ({ id: g.id, version: g.version, kind: g.kind, type: g.type, title: g.title, fileName: g.fileName, snapshot: g.snapshot, collectedAt: g.collectedAt, method: g.method, chars: g.blocks.reduce((n, b) => n + b.sentences.reduce((m, s) => m + s.text.length, 0), 0), ...(g.convert ? { convert: convertSummary(g.convert) } : {}), ...(g.merges?.length ? { merges: g.merges, docs: mergedCount(g) } : {}), ...(g.note ? { note: true } : {}) });
