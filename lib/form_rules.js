// 양식 구조 규칙 — 작성자가 양식 화면에서 손으로 정한 제목·필드의 종류·수준(상하관계)을 작업공간 수준 파일 <WORKSPACE>/form_rules.json 하나에 보관하고,
// 다음 양식을 올릴 때 같은 (앞 제목, 글) 노드에 자동으로 적용하며, 에이전트에게는 영어 한 줄씩 알려 비슷한 패턴을 유추하게 한다 (FR-WB-095, DR-WB-009).
// 규칙 하나 = { id: 'SR-001', heading, text, kind, level, from: { kind, level }, fileName, bookId, formId, at } — 열쇠는 (heading, text).
// heading 은 그 노드 바로 앞 제목의 글, text 는 그 노드의 글(둘 다 공백을 하나로 모으고 앞뒤를 뗀 것). 같은 열쇠의 조절은 덮어쓴다.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { nextId } from '../public/shared/model.js';

export const RULES_LIMIT = 500; // 작업공간의 규칙 수 상한 (DR-WB-009)
export const RULES_FILE = 'form_rules.json';
export const LEVEL_MAX = 6; // 제목·필드 수준 상한 — forms.js 의 FORM_LEVEL_MAX 가 이것을 재수출한다 (FR-WB-094)
const KINDS = ['heading', 'field'];
const TEXT_LIMIT = 200; // 에이전트에게 보이는 글의 길이 — 비교는 시스템이 전문으로 한다

const fail = (status, message) => Object.assign(new Error(message), { status });
export const cleanKey = text => String(text ?? '').replace(/\s+/g, ' ').trim();

// 노드의 스캔 때 종류 — 작성자·규칙이 종류를 바꾼 노드는 orig 에 스캔 때 종류가 있다. 열쇠의 「앞 제목」은 늘 스캔 상태로 세어
// 조절한 순서와 무관하게 같은 열쇠가 나오고, 올릴 때(규칙 적용 전 nodes)와 저장할 때(조절 뒤 nodes)가 같은 열쇠를 본다
const scanKind = node => node?.orig?.kind ?? node?.kind;

// i 번 노드 바로 앞 제목(스캔 때 제목인 노드)의 글, 없으면 ''
export function contextOf(nodes, i) {
  for (let k = i - 1; k >= 0; k--) if (scanKind(nodes[k]) === 'heading') return cleanKey(nodes[k].text);
  return '';
}

const rulesFile = dir => path.join(dir, RULES_FILE);
const isRule = r => r && typeof r === 'object' && typeof r.id === 'string' && typeof r.text === 'string' && KINDS.includes(r.kind) && Number.isInteger(r.level);

// 파일이 없거나 읽지 못하면 조용히 빈 목록 — 규칙은 보조 정보라 양식 기능을 막지 않는다
export async function loadRules(dir) {
  try {
    const data = JSON.parse(await fs.readFile(rulesFile(dir), 'utf8'));
    return (Array.isArray(data?.rules) ? data.rules : []).filter(isRule);
  } catch {
    return [];
  }
}

// 임시 파일에 쓰고 이름을 바꾼다 — 쓰다 멈춰도 깨진 파일이 남지 않는다
export async function saveRules(dir, rules) {
  const file = rulesFile(dir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ rules }, null, 2));
  await fs.rename(tmp, file);
}

const sameKey = (rule, heading, text) => rule.heading === heading && rule.text === text;

// (앞 제목, 글)이 같은 규칙 — 글이 다르면 규칙은 적용하지 않는다(비슷한 패턴은 에이전트 몫)
export function matchRule(rules, heading, text) {
  const [h, t] = [cleanKey(heading), cleanKey(text)];
  if (!t) return undefined;
  return rules.find(rule => sameKey(rule, h, t));
}

// 같은 열쇠는 교체(id 유지), 새 규칙은 안 쓴 다음 SR-번호. 상한을 넘으면 거절 → 새 배열
export function upsertRule(rules, { heading, text, kind, level, from, fileName, bookId, formId }) {
  const [h, t] = [cleanKey(heading), cleanKey(text)];
  if (!t) throw fail(400, '구조 규칙의 글이 비어 있습니다');
  if (!KINDS.includes(kind)) throw fail(400, '구조 규칙의 종류는 heading 또는 field 여야 합니다');
  if (!Number.isInteger(level) || level < 1 || level > LEVEL_MAX) throw fail(400, `구조 규칙의 수준은 1~${LEVEL_MAX} 의 정수여야 합니다`);
  const was = rules.find(rule => sameKey(rule, h, t));
  if (!was && rules.length >= RULES_LIMIT) throw fail(400, `구조 규칙은 ${RULES_LIMIT}건까지입니다 — 쓰지 않는 규칙을 지워 주세요`);
  const rule = {
    id: was?.id ?? nextId('SR', rules.map(r => r.id), 3), heading: h, text: t, kind, level,
    ...(from && KINDS.includes(from.kind) && Number.isInteger(from.level) && { from: { kind: from.kind, level: from.level } }),
    fileName: String(fileName ?? ''), bookId: String(bookId ?? ''), formId: String(formId ?? ''), at: new Date().toISOString(),
  };
  return was ? rules.map(r => (r === was ? rule : r)) : [...rules, rule];
}

// id('SR-001') 또는 열쇠 { heading, text } 로 지운다 → 새 배열(없으면 그대로인 복사본)
export function removeRule(rules, idOrKey) {
  if (typeof idOrKey === 'string') return rules.filter(rule => rule.id !== idOrKey);
  const [h, t] = [cleanKey(idOrKey?.heading), cleanKey(idOrKey?.text)];
  return rules.filter(rule => !sameKey(rule, h, t));
}

// 스캔한 nodes(번호를 매기기 전)에 규칙을 적용한다 — 제목·필드 노드마다 (앞 제목, 글)이 같은 규칙의 종류·수준으로 두고
// 바뀐 노드에 orig(스캔 때 종류·수준·출처)와 rule(규칙 id)을 남긴다. 열쇠의 앞 제목은 입력 nodes 기준이라 적용 순서와 무관하다 (FR-WB-095)
export function applyRules(nodes, rules) {
  const applied = [];
  if (!Array.isArray(rules) || !rules.length) return { nodes: nodes.map(node => ({ ...node })), applied };
  const out = nodes.map((node, i) => {
    if (node.kind !== 'heading' && node.kind !== 'field') return { ...node };
    const rule = matchRule(rules, contextOf(nodes, i), node.text);
    if (!rule || (rule.kind === node.kind && rule.level === node.level)) return { ...node };
    const { by, depth, n, ...rest } = node;
    const next = { ...rest, kind: rule.kind, level: rule.level, orig: { kind: node.kind, level: node.level, ...(by && { by }), ...(depth && { depth }) }, rule: rule.id };
    if (rule.kind === 'heading') next.by = node.kind === 'heading' ? by : 'rule'; // 필드에서 만든 제목은 규칙이 만든 것(목차 후보에서 구조적으로 본다)
    else next.n = n ?? 0; // 제목에서 만든 필드는 번호를 받는다(스캔이 뒤에 매긴다)
    if (next.kind === 'heading' && depth) next.depth = depth;
    applied.push({ i, ruleId: rule.id });
    return next;
  });
  return { nodes: out, applied };
}

const clipText = text => (text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text);

// 에이전트용 — 규칙마다 영어 한 줄: `- under 「heading」: 「text」 → heading level 2 (was field level 1)`, 제목이 없으면 `at top level`
export function rulesText(rules) {
  return (rules ?? []).map(rule => {
    const where = rule.heading ? `under 「${clipText(rule.heading)}」` : 'at top level';
    const was = rule.from ? ` (was ${rule.from.kind} level ${rule.from.level})` : '';
    return `- ${where}: 「${clipText(rule.text)}」 → ${rule.kind} level ${rule.level}${was}`;
  }).join('\n');
}
