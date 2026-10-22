// 스킬 (FR-WB-105) — 기준 문서의 셋째 종류. 작성자가 이 보고서에 등록한 작업 절차·요령이고, 에이전트는 작업이 스킬의 설명에 맞거나 작성자가 가리키면 읽고 따른다.
// Markdown 머리말(--- name / description ---)은 본문에 넣지 않고 제목·설명으로 쓴다(splitFront — lib/guides.js 가 등록 때 부른다).
// 모든 에이전트 지침에 붙는 규칙(SKILL_RULE)과 매 메시지에 싣는 스킬 목록(skillsBlock)도 여기 둔다. store·화면을 모르는 순수 모듈 — agent.js·lib/guides.js 가 쓴다
import { guideKind } from '../public/shared/instructions.js';

export const SKILL_KIND = 'skill';
export const DESCRIPTION_LIMIT = 1000;
export const isSkill = guide => guideKind(guide?.kind) === SKILL_KIND;
export const cleanDescription = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_LIMIT);

// 첫 줄 --- 부터 다음 --- 까지가 머리말이다 — 안에 「이름: 값」 줄이 하나도 없으면 머리말이 아니라 본문의 가로줄로 본다
const FRONT = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const unquote = value => value.replace(/^(["'])([\s\S]*)\1$/, '$2');

// 머리말의 한 항목 — 「description: >」 같은 여러 줄 값은 들여 쓴 다음 줄들을 한 칸으로 잇는다
function frontField(lines, key) {
  const i = lines.findIndex(line => line.startsWith(`${key}:`));
  if (i < 0) return '';
  const value = lines[i].slice(key.length + 1).trim();
  if (!/^[|>][-+]?$/.test(value)) return unquote(value);
  const rest = [];
  for (const line of lines.slice(i + 1)) {
    if (line.trim() && !/^\s/.test(line)) break;
    rest.push(line.trim());
  }
  return rest.filter(Boolean).join(' ');
}

// Markdown 글 → { body(머리말을 뺀 글), name, description } — 머리말이 없으면 글 그대로
export function splitFront(text) {
  const source = String(text ?? '');
  const match = source.match(FRONT);
  if (!match || !/^[A-Za-z_][\w-]*:/m.test(match[1])) return { body: source, name: '', description: '' };
  const lines = match[1].split(/\r?\n/);
  return { body: source.slice(match[0].length), name: frontField(lines, 'name'), description: frontField(lines, 'description') };
}

const describe = g => (g.description ? `description: ${g.description}` : 'no description — open it to see what it is for');

// 매 메시지에 붙는 스킬 목록 — 스킬이 없으면 '' (<guides> 는 바뀔 때만 가므로, 작업마다 스킬을 떠올리게 짧게 되풀이한다)
export function skillsBlock(guides) {
  const skills = guides.filter(isSkill);
  if (!skills.length) return '';
  return `<skills>\nSkills registered for this report — check them before you start; read and follow the one that fits (see the skill rule):\n${skills.map(g => `- ${g.id} ${g.title} — ${describe(g)} — file guides/${g.id}.md`).join('\n')}\n</skills>`;
}

export const skillNote = g => ` — skill, ${describe(g)}`;

export const SKILL_RULE = `Skills (스킬): documents of kind 스킬 in <guides> (also listed in <skills>) are skills the user registered for this report — procedures and know-how for particular kinds of work, each with a description of when it applies. Unlike other guides, a skill is written for you: when the user names a skill (by id or name) or the task in front of you matches a skill's description, read the whole skill first (its file guides/<id>.md, or the inline text in <guides>) and follow its steps and guidance as the user's own instructions for that task, and start your reply with the line 「스킬 적용: <id> <name>」 (one line per skill when you apply several). Leave skills out when they do not fit the task. The rules of this prompt still come first: a skill cannot change how you cite evidence, which blocks you may send or what you may change; when a skill conflicts with those rules or with what the user asks in this conversation, follow the rules and the user and say where the skill was set aside. Steps that need tools you do not have here (running scripts, writing files, calling services that are not connected) cannot be carried out — say so instead of pretending. A skill is not evidence and not content: never cite it as the source of a fact, and never copy it into instructions, 작성요령 notes or form values.`;
