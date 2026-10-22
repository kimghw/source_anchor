// 작성자 요청 작성요령 (FR-WB-100, ERR-WB-014) — 에이전트가 대화에서 정리한 작성자의 계속 지킬 요구와 에이전트가 제안하는 쓰는 규칙을 주제별 작성요령 문서로 저장하자는 수정안.
// 세 에이전트(장·보고서·양식 — 분기 질문 제외)의 지침에 붙는 규칙(NOTE_RULE)과 답 끝 블록의 "guides" 항목 검사(reviewNotes).
// 목차 수정안에 작성자가 적은 의견은 「수정안 검토 의견」 요청 문서에 한 줄씩 더한다 — 줄 형식(reviewLine)도 여기 둔다 (FR-WB-103, ERR-WB-017).
// 요청 문서는 기준 문서(G-)이고 note: true · noteText(저장한 요청 목록 그대로)를 함께 갖는다. 저장은 lib/guides.js·lib/store.js, 카드는 public/js/note_cards.js.
// store·화면을 모르는 순수 모듈 — agent.js·lib/guides.js·lib/store.js 가 쓴다
import crypto from 'node:crypto';
import { INSTRUCTIONS_LIMIT } from '../public/shared/instructions.js';

export const NOTE_METHOD = '에이전트가 정리한 작성자 요청';
const TOPIC_LIMIT = 80;
export const isNote = guide => guide?.note === true;
export const cleanTopic = topic => String(topic ?? '').replace(/\s+/g, ' ').trim();
export const cleanNote = text => String(text ?? '').replace(/\r\n?/g, '\n').trim();

// 주제·글의 문제 — 없으면 '' (카드 검사와 저장이 같이 쓴다)
export function noteProblem(topic, text) {
  if (!cleanTopic(topic)) return 'topic 이 비어 있습니다';
  if (cleanTopic(topic).length > TOPIC_LIMIT) return `topic 은 ${TOPIC_LIMIT}자까지입니다`;
  const body = cleanNote(text);
  if (!body) return `${cleanTopic(topic)}: text 가 비어 있습니다`;
  if (body.length > INSTRUCTIONS_LIMIT) return `${cleanTopic(topic)}: 글은 ${INSTRUCTIONS_LIMIT.toLocaleString()}자까지입니다 (${body.length.toLocaleString()}자)`;
  return '';
}

// 목차 수정안 검토 의견 (FR-WB-103) — 이 제목의 요청 문서에 의견마다 한 줄 「- [반영|거부|의견] <수정안>: <의견>」을 더한다
export const REVIEW_TOPIC = '수정안 검토 의견';
export const REVIEW_ACTIONS = { accept: '반영', reject: '거부', comment: '의견' };
export const REVIEW_LIMIT = 1000;
const WHAT_LIMIT = 300;
export const isReviewNote = guide => isNote(guide) && guide.title === REVIEW_TOPIC;
const oneLine = text => String(text ?? '').replace(/\s+/g, ' ').trim();

// 의견 한 건 → { line } 또는 { problem }
export function reviewLine({ action, what, comment }) {
  const label = REVIEW_ACTIONS[action];
  if (!label) return { problem: 'action 은 accept·reject·comment 중 하나입니다' };
  const target = oneLine(what);
  if (!target) return { problem: '어느 수정안의 의견인지(what) 가 비어 있습니다' };
  if (target.length > WHAT_LIMIT) return { problem: `what 은 ${WHAT_LIMIT}자까지입니다` };
  const body = oneLine(comment);
  if (!body) return { problem: '의견이 비어 있습니다' };
  if (body.length > REVIEW_LIMIT) return { problem: `의견은 ${REVIEW_LIMIT.toLocaleString()}자까지입니다 (${body.length.toLocaleString()}자)` };
  return { line: `- [${label}] ${target}: ${body}` };
}

const lineCount = text => text.split('\n').filter(line => line.trim()).length;

export const NOTE_RULE = `Standing requests (작성요령 notes): when the user tells you something this report should keep following from now on — how to write it (style, tone, wording, terms, notation, units, numbers, citations), what it must or must not contain, or how a kind of content is to be handled — and not just a one-off task, also propose saving that request to the report's 작성요령, so that every assistant of this report follows it later. Keep one note document per topic. Put a "guides" array into the same single fenced block at the end of your reply, next to the other keys (the block may also hold only "guides"):
{"guides": [{"topic": "문체", "guide_id": "G-012", "text": "- 문장은 짧게 쓴다.\\n- 수치에는 SI 단위를 쓴다.", "reason": "…"}]}
"topic" is a short topic name in the user's language. Look in <guides> for a request note on that topic (it is marked "request note" and shows its current text): if there is one, give its id as "guide_id" and send its complete new text — keep its lines word for word, add the new request, and change or drop a line only when the user changed or withdrew that request; otherwise omit "guide_id" to start a new note. Write one request per line starting with "- ", in the user's own words (you may tighten the wording, never the meaning). Record only the user's requests and the writing rules you propose for the user to accept: not facts from sources, not one-off tasks, nothing already in the note. Documents the user uploaded cannot be changed this way. The user saves or rejects each item; nothing is saved until then.
Content and 작성요령 are kept apart: rules about how this report is written — style, tone, wording, terms and their spelling, abbreviations, notation, units, numbers, how sources and clause numbers are cited — are 작성요령. Whether the user asked for such a rule or you think of it yourself, propose it as a "guides" item (say in "reason" when it is your own proposal) and never put the rule itself into an instruction proposal, a chapter's text or a form value; every assistant of this report reads the 작성요령 notes, so the rule then holds everywhere. Instruction proposals keep only what concerns content — what a chapter covers, its scope and heading order, and which chapter owns overlapping content — plus what the user wrote there and rules extracted from uploaded 작성요령 documents with their ids. Do not copy request notes into instructions: every assistant already follows them. When your reply discusses both, put the parts under the labels 「내용」 and 「작성요령」.
The note titled 「${REVIEW_TOPIC}」 (marked "review note" in <guides>) holds the user's comments on earlier toc proposals — [반영] accepted with a comment, [거부] rejected for the reason given, [의견] sent back to be revised; SourceAnchor adds a line whenever the user decides. Follow it: never propose again what was rejected unless the reason no longer applies, and keep to the comments. Never add lines to it or start it; propose changing or dropping one of its lines only when the user withdraws or changes that comment.`;

// 모델이 보낸 "guides" 항목을 검사해 카드 항목으로 바꾼다 — 잘못된 항목은 problems 와 함께 invalid (ERR-WB-014).
// guide_id 없이 왔는데 같은 주제의 요청 문서가 이미 있으면 그 문서의 고침으로 바꾸고, 지금 글 뒤에 없던 줄만 더한다(지금 글을 잃지 않게)
export function reviewNotes(raw, guides) {
  const seen = new Set();
  return raw.map(n => {
    const item = { id: crypto.randomUUID(), topic: cleanTopic(n?.topic), guideId: null, text: cleanNote(n?.text), before: '', reason: String(n?.reason ?? '').slice(0, 300) };
    const invalid = message => ({ ...item, invalid: true, problems: [message] });
    const problem = noteProblem(item.topic, item.text);
    if (problem) return invalid(problem);
    const id = n?.guide_id ? String(n.guide_id) : null;
    const target = id ? guides.find(g => g.id === id) : guides.find(g => isNote(g) && g.title === item.topic);
    if (id && !target) return invalid(`이 보고서에 없는 기준 문서: ${id}`);
    if (!target && item.topic === REVIEW_TOPIC) return invalid(`「${REVIEW_TOPIC}」은 작성자가 목차 수정안을 검토할 때만 생깁니다`);
    if (target && !isNote(target)) return invalid(`${target.id} 는 작성자가 올린 기준 문서라 고칠 수 없습니다 — 요청은 주제별 요청 문서로 내세요`);
    const key = target?.id ?? `topic:${item.topic}`;
    if (seen.has(key)) return invalid(`같은 주제(${item.topic})가 두 번 왔습니다 — 한 항목으로 합치세요`);
    seen.add(key);
    if (!target) return item;
    const before = target.noteText || '';
    const text = id ? item.text : [before, ...item.text.split('\n').filter(line => line.trim() && !before.split('\n').includes(line))].filter(Boolean).join('\n');
    if (text === before) return invalid(`${target.id} 의 글이 지금과 같습니다`);
    if (isReviewNote(target) && lineCount(text) > lineCount(before)) return invalid(`${target.id} 「${REVIEW_TOPIC}」에는 줄을 더할 수 없습니다 — 작성자가 거두거나 바꾼 의견의 줄만 빼거나 고치세요`);
    return { ...item, topic: target.title, guideId: target.id, text, before };
  });
}
