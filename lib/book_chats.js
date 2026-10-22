// 보고서 화면 대화 보관 — 에이전트가 답을 마칠 때마다 문답을 보관하고, 작성자가 닫을 때 장·주제·제목으로 분류한다 (FR-WB-101, DR-WB-010).
//   workspace/projects/<보고서 ID>/chats/<CV-번호>.json  { id, title, classified, chapterId, topic, messages: [{ role, text, model?, at }], createdAt, updatedAt }
// updatedAt 은 마지막 문답 시각이다 — 분류를 바꿔도 그대로 둔다.
// 파일 조작과 분류 제안의 글(프롬프트·답 해석)만 한다. 보고서 찾기·번호 발급(main.json 의 chatSeq)은 lib/store.js 가, 모델 호출은 agent.js 가 한다.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { outlineNumbers } from '../public/shared/toc.js';

export const TITLE_LIMIT = 100;
export const TOPIC_LIMIT = 40;
const EXCERPT = 40; // 제목을 비웠을 때 첫 질문에서 따오는 글자 수
const FENCE = '```sourceanchor'; // agent.js 의 답 블록 표시와 같다
const FILE_RE = /^CV-\d{3,}\.json$/;
const ID_RE = /^CV-\d{3,}$/;
const LABEL_MESSAGE_LIMIT = 4_000; // 분류 제안에 넣는 문답 하나의 글자 수
const LABEL_CONVERSATION_LIMIT = 30_000; // 분류 제안에 넣는 대화 전체의 글자 수 — 넘으면 첫 문답과 최근 문답만

const fail = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const dirOf = dir => path.join(dir, 'chats');
const fileOf = (dir, id) => path.join(dirOf(dir), `${id}.json`);
const oneLine = (value, limit) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);

export const cleanTitle = title => oneLine(title, TITLE_LIMIT);
export const cleanTopic = topic => oneLine(topic, TOPIC_LIMIT);
export const chatId = seq => `CV-${String(seq).padStart(3, '0')}`;

// 같은 대화 파일을 읽고 고치는 일은 차례로 한다 — 답이 끝나 보관하는 것과 분류 저장·삭제가 겹쳐도 한쪽이 다른 쪽을 덮지 않게
const queues = new Map();
function serial(key, fn) {
  const next = (queues.get(key) || Promise.resolve()).catch(() => {}).then(fn);
  queues.set(key, next);
  next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
  return next;
}

export async function readChat(dir, id) {
  if (!ID_RE.test(String(id))) throw fail(404, '보관된 대화를 찾지 못했습니다');
  try {
    return JSON.parse(await fs.readFile(fileOf(dir, id), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') throw fail(404, '보관된 대화를 찾지 못했습니다 — 이미 지워졌을 수 있습니다');
    throw err;
  }
}

async function writeChat(dir, chat) {
  await fs.mkdir(dirOf(dir), { recursive: true });
  const file = fileOf(dir, chat.id);
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(chat, null, 2));
  await fs.rename(tmp, file);
}

const toMessages = (messages, at) => messages.map(m => ({ role: m.role, text: m.text, ...(m.model ? { model: m.model } : {}), at: m.at || at }));

// 첫 문답이 끝났을 때 — 분류 안 됨으로 만든다
export function createChat(dir, id, messages) {
  return serial(fileOf(dir, id), async () => {
    const at = now();
    const chat = { id, title: '', classified: false, chapterId: null, topic: '', messages: toMessages(messages, at), createdAt: at, updatedAt: at };
    await writeChat(dir, chat);
    return chat;
  });
}

// 그 뒤 답이 끝날 때마다 — 문답 전체를 바꾸고 분류는 그대로 둔다. 그사이 지워졌으면 되살리지 않고 null
export function saveMessages(dir, id, messages) {
  return serial(fileOf(dir, id), async () => {
    const chat = await readChat(dir, id).catch(err => { if (err.status === 404) return null; throw err; });
    if (!chat) return null;
    const at = now();
    chat.messages = toMessages(messages, at);
    chat.updatedAt = at;
    await writeChat(dir, chat);
    return chat;
  });
}

// 닫을 때 — 장(없으면 보고서 전체)·주제·제목을 정한다. 장이 목차에 있는지는 store 가 본다
export function classifyChat(dir, id, { chapterId = null, topic = '', title = '' }) {
  return serial(fileOf(dir, id), async () => {
    const chat = await readChat(dir, id);
    Object.assign(chat, { classified: true, chapterId: chapterId || null, topic: cleanTopic(topic), title: cleanTitle(title) });
    await writeChat(dir, chat);
    return chat;
  });
}

export function removeChat(dir, id) {
  return serial(fileOf(dir, id), async () => {
    await readChat(dir, id);
    await fs.rm(fileOf(dir, id), { force: true });
  });
}

// 제목을 비웠으면 첫 질문의 앞부분
export function titleOf(chat) {
  if (chat.title) return chat.title;
  const first = oneLine(chat.messages.find(m => m.role === 'user')?.text, 1000);
  return !first ? '제목 없는 대화' : first.length > EXCERPT ? `${first.slice(0, EXCERPT).trimEnd()}…` : first;
}

// 목록에 싣는 요약 — 문답 글은 빼고 수와 답한 모델만
export const chatSummary = chat => ({
  id: chat.id, title: titleOf(chat), classified: Boolean(chat.classified), chapterId: chat.chapterId || null, topic: chat.topic || '',
  exchanges: chat.messages.filter(m => m.role === 'user').length,
  models: [...new Set(chat.messages.map(m => m.model).filter(Boolean))],
  createdAt: chat.createdAt, updatedAt: chat.updatedAt,
});

// 마지막 문답이 최근인 것부터. 쓰는 중인 임시 파일과 읽을 수 없는 파일은 건너뛴다
export async function listChats(dir) {
  const files = (await fs.readdir(dirOf(dir)).catch(() => [])).filter(f => FILE_RE.test(f));
  const chats = [];
  for (const f of files) {
    try { chats.push(chatSummary(JSON.parse(await fs.readFile(path.join(dirOf(dir), f), 'utf8')))); } catch { /* 건너뛴다 */ }
  }
  return chats.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

// 블록에 수정안이 들어 있었는지 — 빈 배열뿐인 블록은 아니고, 읽을 수 없는 블록은 들어 있던 것으로 본다
const hasItems = body => {
  try { return Object.values(JSON.parse(body) || {}).some(v => Array.isArray(v) && v.length > 0); } catch { return true; }
};

// 답의 글에서 수정안 블록(```sourceanchor … ```)을 뺀다 — blocks 는 수정안이 들어 있던 블록 수
export function answerText(text) {
  let out = '';
  let rest = String(text || '');
  let blocks = 0;
  for (;;) {
    const at = rest.indexOf(FENCE);
    if (at < 0) { out += rest; break; }
    out += rest.slice(0, at);
    const end = rest.indexOf('```', at + FENCE.length);
    if (hasItems(rest.slice(at + FENCE.length, end < 0 ? undefined : end))) blocks += 1;
    if (end < 0) break;
    rest = rest.slice(end + 3);
  }
  return { text: out.replace(/\n{3,}/g, '\n\n').trim(), blocks };
}

// 다시 열 때 화면에 보일 문답 — 답 끝의 수정안 블록은 빼고 있었는지만 알린다 (FR-WB-101 (d))
export const visibleMessages = chat => chat.messages.map(m => (m.role === 'assistant'
  ? { role: 'assistant', model: m.model || null, at: m.at, ...answerText(m.text) }
  : { role: 'user', text: m.text, at: m.at }));

// ───────────────────────────── 분류 제안 (FR-WB-101 (b), ERR-WB-015) ─────────────────────────────

export const LABEL_INSTRUCTIONS = `You file away a conversation between a report writer and SourceAnchor's report-level assistant so that the writer can find it again later. The report is split into chapters listed in <toc>.

Reply with one JSON object and nothing else:
{"chapter": "<chapter id from <toc>, or null>", "topic": "<topic>", "title": "<title>"}

- chapter: the id (R-…) of the one chapter the conversation mainly works on. Use null when it is about the whole report, about several chapters equally, or about no chapter.
- topic: at most 20 characters, a short noun phrase naming the kind of work (for example terminology, chapter order, instructions review). When one of <existing_topics> fits, copy it exactly so that conversations on the same topic are grouped together; otherwise coin a new one.
- title: at most 40 characters, saying what this particular conversation asked or settled.

Write topic and title in the language the writer used. Do not use any tools.`;

// 대화가 길면 첫 문답과, 한도 안에 드는 최근 문답만 넣는다
function conversationText(chat) {
  const lines = chat.messages.map(m => {
    const text = m.role === 'assistant' ? answerText(m.text).text : String(m.text || '').trim();
    return `${m.role}: ${text.length > LABEL_MESSAGE_LIMIT ? `${text.slice(0, LABEL_MESSAGE_LIMIT)} …(truncated)` : text}`;
  });
  const total = lines.reduce((n, l) => n + l.length + 2, 0);
  if (total <= LABEL_CONVERSATION_LIMIT) return lines.join('\n\n');
  const head = lines.slice(0, 2);
  const tail = [];
  let size = head.reduce((n, l) => n + l.length + 2, 0);
  for (let i = lines.length - 1; i >= 2 && size + lines[i].length + 2 <= LABEL_CONVERSATION_LIMIT; i--) {
    tail.unshift(lines[i]);
    size += lines[i].length + 2;
  }
  return [...head, `(… ${lines.length - head.length - tail.length} messages omitted …)`, ...tail].join('\n\n');
}

export function labelPrompt(chat, chapters, topics) {
  const numbers = outlineNumbers(chapters.map(ch => ({ level: ch.level || 1 })));
  const toc = chapters.length ? chapters.map((ch, i) => `${ch.id} | ${numbers[i]} | ${ch.title}`).join('\n') : '(the report has no chapters)';
  return [
    `<toc>\n${toc}\n</toc>`,
    `<existing_topics>\n${topics.length ? topics.join('\n') : '(none yet)'}\n</existing_topics>`,
    `<conversation>\n${conversationText(chat)}\n</conversation>`,
    'Classify this conversation. Reply with the JSON object only.',
  ].join('\n\n');
}

// 답에서 JSON 을 꺼내 검사한다 — 목차에 없는 장은 보고서 전체(null)로 둔다. 형식이 맞지 않으면 던진다
export function parseLabel(text, chapters) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  let value = null;
  try { value = start >= 0 && end > start ? JSON.parse(raw.slice(start, end + 1)) : null; } catch { /* 아래에서 알린다 */ }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('에이전트의 제안 형식이 맞지 않습니다.');
  const chapterId = typeof value.chapter === 'string' && chapters.some(ch => ch.id === value.chapter.trim()) ? value.chapter.trim() : null;
  return { chapterId, topic: cleanTopic(value.topic), title: cleanTitle(value.title) };
}
