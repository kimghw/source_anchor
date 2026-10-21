// 사용자 지정 문서 — 작성자가 보고서의 원문들에서 문장·표를 골라 넣고 직접 써서 만드는 문서. 보고서 단위로 보관하고, 장의 원문으로 등록할 수 있다 (FR-WB-088, 089, DR-WB-007).
//   workspace/projects/<보고서 ID>/custom/<C-번호>.json  { id, title, markdown, picks: [{ chapterId, sourceId, anchorId, text, loc, at }], registrations: [{ chapterId, sourceId, at }], createdAt, updatedAt }
// 파일·캐시 조작은 lib/store.js 가 이 모듈을 불러 한다. 원문으로 등록하는 것(addSource)도 store 가 한다 — 이 모듈은 store 를 import 하지 않는다.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const MARKDOWN_LIMIT = 100_000; // 본문 글자 수 상한 (DR-WB-007)
export const PICKS_LIMIT = 2_000; // 출처 목록 건수 상한
const TITLE_LIMIT = 200;
const PICK_TEXT_LIMIT = 300;

const fail = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const dirOf = dir => path.join(dir, 'custom');
const fileOf = (dir, id) => path.join(dirOf(dir), `${id}.json`);
const text = (value, limit) => String(value ?? '').trim().slice(0, limit);

export const cleanTitle = title => text(title, TITLE_LIMIT) || '제목 없는 문서';

export async function loadCustomDocs(dir) {
  const files = (await fs.readdir(dirOf(dir)).catch(() => [])).filter(f => /^C-\d{3,}\.json$/.test(f)).sort();
  const docs = [];
  for (const f of files) docs.push(JSON.parse(await fs.readFile(path.join(dirOf(dir), f), 'utf8')));
  return docs;
}

export function newCustomDoc(id, title) {
  const at = now();
  return { id, title: cleanTitle(title), markdown: '', picks: [], registrations: [], createdAt: at, updatedAt: at };
}

// 화면이 보낸 변경을 검사해 문서에 반영한다 — 한도를 넘으면 자르지 않고 거절한다 (ERR-WB-010)
export function applyCustomPatch(doc, { title, markdown, picks }) {
  if (title !== undefined) doc.title = cleanTitle(title);
  if (markdown !== undefined) {
    if (typeof markdown !== 'string') throw fail(400, 'markdown 은 문자열이어야 합니다');
    if (markdown.length > MARKDOWN_LIMIT) throw fail(400, `본문은 ${MARKDOWN_LIMIT.toLocaleString()}자까지입니다 (${markdown.length.toLocaleString()}자)`);
    doc.markdown = markdown;
  }
  if (picks !== undefined) {
    if (!Array.isArray(picks)) throw fail(400, 'picks 는 배열이어야 합니다');
    if (picks.length > PICKS_LIMIT) throw fail(400, `출처 목록은 ${PICKS_LIMIT.toLocaleString()}건까지입니다 (${picks.length.toLocaleString()}건)`);
    doc.picks = picks.map(p => {
      const pick = { chapterId: text(p?.chapterId, 20), sourceId: text(p?.sourceId, 20), anchorId: text(p?.anchorId, 40), text: text(p?.text, PICK_TEXT_LIMIT), loc: text(p?.loc, 80), at: text(p?.at, 40) || now() };
      if (!pick.chapterId || !pick.sourceId || !pick.anchorId) throw fail(400, '출처에는 장·원문·원문 위치가 있어야 합니다');
      return pick;
    });
  }
  doc.updatedAt = now();
  return doc;
}

export async function writeCustomDoc(dir, doc) {
  await fs.mkdir(dirOf(dir), { recursive: true });
  const file = fileOf(dir, doc.id);
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(doc, null, 2));
  await fs.rename(tmp, file);
}

export async function removeCustomDoc(dir, doc) {
  await fs.rm(fileOf(dir, doc.id), { force: true });
}

// 목록·탐색기에 싣는 요약 — 본문은 빼고 크기와 건수만
export const customSummary = d => ({ id: d.id, title: d.title, chars: d.markdown.length, picks: d.picks.length, registrations: d.registrations.length, createdAt: d.createdAt, updatedAt: d.updatedAt });
