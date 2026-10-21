// 기준 문서 — 규정·규칙·작성요령·작성 요구사항이 담긴 문서를 보고서 단위로 보관한다 (FR-WB-085, DR-WB-006).
//   workspace/projects/<보고서 ID>/guides/<G-번호>.json   서지정보·종류·문장·표 단위 본문(블록)
//   … /guides/<G-번호>.md                                 변환한 Markdown (원본과 한 쌍)
//   … /guides/originals/<G-번호>.<확장자>                 올린 원본 파일 (붙여 넣은 문서에는 없다)
// 장의 원문(S-번호)과 모양은 같지만 근거로 인용하지 않는다 — 앵커 색인(buildAnchorIndex)은 장의 원문만 본다.
// 파일·캐시 조작은 lib/store.js 가 이 모듈을 불러 한다. 이 모듈은 store 를 import 하지 않는다.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { GUIDE_KINDS } from '../public/shared/instructions.js';
import { buildBlocks } from '../public/shared/model.js';
import { convertDocument } from './collect.js';
import { markdownToDrafts } from './ingest.js';
import { sourceMarkdown } from './source_md.js';

export const GUIDE_FILE_LIMIT = 5 * 1024 * 1024; // 올리는 원본 파일 하나의 크기 상한 (FR-WB-085)
const TITLE_LIMIT = 300;
const NAME_LIMIT = 260;
const REJECTED_EXT = { '.docx': 'DOCX', '.doc': 'DOC', '.xlsx': 'XLSX', '.xls': 'XLS', '.hwp': 'HWP', '.hwpx': 'HWPX', '.ppt': 'PPT(예전 형식)' }; // 변환기가 없는 형식은 먼저 거절한다 (ERR-WB-008)
const CONTENT_TYPES = { '.pdf': 'application/pdf', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.html': 'text/html', '.htm': 'text/html', '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain' };

const fail = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const guidesDir = dir => path.join(dir, 'guides');
const jsonFile = (dir, id) => path.join(guidesDir(dir), `${id}.json`);
const mdFile = (dir, id) => path.join(guidesDir(dir), `${id}.md`);

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

export const cleanKind = kind => (GUIDE_KINDS[kind] ? kind : 'other');
export const cleanTitle = title => String(title || '').trim().slice(0, TITLE_LIMIT);

// 보고서 폴더의 기준 문서를 모두 읽는다 — Markdown 파일이 없으면 만들어 둔다 (DR-WB-006)
export async function loadGuides(dir) {
  const files = (await fs.readdir(guidesDir(dir)).catch(() => [])).filter(f => /^G-\d{3,}\.json$/.test(f)).sort();
  const list = [];
  for (const f of files) {
    const guide = JSON.parse(await fs.readFile(path.join(guidesDir(dir), f), 'utf8'));
    await fs.access(mdFile(dir, guide.id)).catch(() => fs.writeFile(mdFile(dir, guide.id), sourceMarkdown(guide)));
    list.push(guide);
  }
  return list;
}

// 올린 파일(data) 또는 붙여 넣은 본문(markdown)을 기준 문서 하나로 바꾼다. 변환에 실패하면 status 400 오류 — 아무것도 남기지 않는다 (ERR-WB-008)
export async function buildGuide({ id, kind, title, fileName, data, markdown }) {
  const name = String(fileName || '').trim().slice(0, NAME_LIMIT);
  let converted;
  if (data) {
    if (!Buffer.isBuffer(data)) throw fail(400, '파일 내용이 필요합니다');
    if (data.length > GUIDE_FILE_LIMIT) throw fail(413, `파일이 ${GUIDE_FILE_LIMIT / 1024 / 1024}MiB 를 넘습니다 (${(data.length / 1024 / 1024).toFixed(1)}MiB)`);
    if (!data.length) throw fail(400, '빈 파일입니다');
    const ext = path.extname(name).toLowerCase();
    if (REJECTED_EXT[ext]) throw fail(400, `지원하지 않는 형식(${REJECTED_EXT[ext]})입니다 — PDF·PPT(pptx)·HTML·Markdown·텍스트로 바꿔 올려 주세요`);
    try {
      converted = await convertDocument({ data, contentType: CONTENT_TYPES[ext] || '', name, minChars: 1 });
    } catch (err) {
      if (err.collect) throw fail(400, err.message);
      throw err;
    }
  } else {
    const text = String(markdown || '');
    if (!text.trim()) throw fail(400, '본문이 비어 있습니다');
    converted = { type: 'text', title: '', markdown: text };
  }
  const drafts = converted.drafts ?? markdownToDrafts(converted.markdown);
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
    method: data ? '작성자가 올린 파일' : '작성자가 붙여 넣은 본문',
    hash: 'sha256:' + crypto.createHash('sha256').update(data ?? String(markdown)).digest('hex'),
    ...(converted.snapshot ? { snapshot: `originals/${id}.${converted.snapshot.ext}` } : {}),
    blocks: buildBlocks(id, drafts),
  };
  return { guide, snapshotData: converted.snapshot?.data ?? null };
}

// 파일 세 가지(원본·json·Markdown)를 쓴다 — 하나라도 실패하면 쓴 것을 되돌려 일부만 남지 않게 한다 (ERR-WB-008)
export async function writeGuide(dir, guide, snapshotData) {
  try {
    if (guide.snapshot) {
      await fs.mkdir(path.join(guidesDir(dir), 'originals'), { recursive: true });
      await fs.writeFile(path.join(guidesDir(dir), guide.snapshot), snapshotData);
    }
    await fs.mkdir(guidesDir(dir), { recursive: true });
    await fs.writeFile(mdFile(dir, guide.id), sourceMarkdown(guide));
    await writeJson(jsonFile(dir, guide.id), guide);
  } catch (err) {
    await removeGuideFiles(dir, guide);
    throw err;
  }
}

export async function rewriteGuide(dir, guide) {
  await writeJson(jsonFile(dir, guide.id), guide);
  await fs.writeFile(mdFile(dir, guide.id), sourceMarkdown(guide)); // 제목이 Markdown 머리말에 들어간다
}

export async function removeGuideFiles(dir, guide) {
  await fs.rm(jsonFile(dir, guide.id), { force: true });
  await fs.rm(mdFile(dir, guide.id), { force: true });
  if (guide.snapshot) await fs.rm(path.join(guidesDir(dir), guide.snapshot), { force: true });
}

// 보관한 원본 파일 또는 Markdown 파일 — 붙여 넣은 문서에는 원본이 없다
export async function readGuideFile(dir, guide, kind) {
  if (kind === 'original' && !guide.snapshot) throw fail(404, '이 기준 문서는 붙여 넣은 본문이라 올린 원본이 없습니다');
  const file = kind === 'original' ? path.join(guidesDir(dir), guide.snapshot) : mdFile(dir, guide.id);
  const data = await fs.readFile(file).catch(() => { throw fail(404, '보관한 파일을 찾지 못했습니다'); });
  return { data, name: path.basename(file) };
}

// 목록에 싣는 요약 — 본문(블록)은 빼고 열람 화면이 보기 방식을 정하는 데 필요한 것(snapshot)은 남긴다
export const guideSummary = g => ({ id: g.id, kind: g.kind, type: g.type, title: g.title, fileName: g.fileName, snapshot: g.snapshot, collectedAt: g.collectedAt, method: g.method, chars: g.blocks.reduce((n, b) => n + b.sentences.reduce((m, s) => m + s.text.length, 0), 0) });
