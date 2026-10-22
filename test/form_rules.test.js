// 양식 구조 규칙 — 열쇠(앞 제목, 글)·덮어쓰기·삭제·매칭·스캔 노드에 적용·에이전트용 글·파일 왕복·500 상한 (FR-WB-095, DR-WB-009)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LEVEL_MAX, RULES_FILE, RULES_LIMIT, applyRules, cleanKey, contextOf, loadRules, matchRule, removeRule, rulesText, saveRules, upsertRule } from '../lib/form_rules.js';

const status = (code, re = /./) => err => err.status === code && re.test(err.message);
const h = (text, level = 1, more = {}) => ({ kind: 'heading', level, text, section: 0, p: 0, by: 'text', ...more });
const f = (text, level = 1, more = {}) => ({ kind: 'field', n: 0, level, text, section: 0, p: 0, ...more });
const add = (rules, heading, text, kind, level, more = {}) => upsertRule(rules, { heading, text, kind, level, ...more });

test('cleanKey·contextOf: 공백을 하나로 모으고, 앞 제목은 스캔 때 제목(orig 가 있으면 그 종류)으로 센다', () => {
  assert.equal(cleanKey('  a \n\t b  '), 'a b');
  assert.equal(cleanKey(null), '');
  const nodes = [h(' 1. 개요 '), f('x'), { kind: 'table', t: 0 }, f('y'), h('2. 본문', 1, { orig: { kind: 'field', level: 1 }, by: 'user' }), f('z'), f('w', 1, { orig: { kind: 'heading', level: 1, by: 'style' } }), f('v')];
  assert.equal(contextOf(nodes, 0), '');
  assert.equal(contextOf(nodes, 1), '1. 개요');
  assert.equal(contextOf(nodes, 3), '1. 개요'); // 표 자리는 건너뛴다
  assert.equal(contextOf(nodes, 5), '1. 개요'); // 작성자가 필드에서 만든 제목은 스캔 때 필드 — 앞 제목이 아니다
  assert.equal(contextOf(nodes, 7), 'w'); // 작성자가 제목에서 만든 필드는 스캔 때 제목 — 앞 제목이다
});

test('upsertRule: 새 id 는 안 쓴 다음 SR-번호, 같은 열쇠는 id 를 지키고 교체, 열쇠는 공백을 정리해 비교, from·출처·시각', () => {
  let rules = add([], '1. 개요', '본문  글', 'heading', 2, { from: { kind: 'field', level: 1 }, fileName: 'a.docx', bookId: 'M-001', formId: 'F-001' });
  assert.equal(rules.length, 1);
  const { at, ...first } = rules[0];
  assert.deepEqual(first, { id: 'SR-001', heading: '1. 개요', text: '본문 글', kind: 'heading', level: 2, from: { kind: 'field', level: 1 }, fileName: 'a.docx', bookId: 'M-001', formId: 'F-001' });
  assert.match(at, /^\d{4}-\d{2}-\d{2}T/);
  rules = add(rules, '', 'x', 'field', 3);
  assert.deepEqual(rules.map(r => [r.id, r.heading, r.from ?? null, r.fileName]), [['SR-001', '1. 개요', { kind: 'field', level: 1 }, 'a.docx'], ['SR-002', '', null, '']]);
  const replaced = add(rules, ' 1.  개요 ', ' 본문 글 ', 'field', 4);
  assert.deepEqual(replaced.map(r => [r.id, r.kind, r.level, r.from ?? null]), [['SR-001', 'field', 4, null], ['SR-002', 'field', 3, null]]);
  assert.equal(rules[0].kind, 'heading'); // 입력 배열은 그대로
  const gap = add(removeRule(replaced, 'SR-001'), 'q', 'r', 'heading', 1);
  assert.deepEqual(gap.map(r => r.id), ['SR-002', 'SR-003']); // 지운 번호 뒤를 잇는다
  assert.throws(() => add([], 'h', '   ', 'heading', 1), status(400, /글이 비어/));
  assert.throws(() => add([], 'h', 't', 'table', 1), status(400, /heading 또는 field/));
  assert.throws(() => add([], 'h', 't', 'field', 0), status(400, /1~6/));
  assert.throws(() => add([], 'h', 't', 'field', LEVEL_MAX + 1), status(400, /1~6/));
  assert.throws(() => add([], 'h', 't', 'field', 1.5), status(400));
});

test(`upsertRule 상한: ${RULES_LIMIT}건을 넘는 새 규칙은 거절하고 기존 열쇠의 교체는 된다`, () => {
  let rules = [];
  for (let i = 0; i < RULES_LIMIT; i++) rules = add(rules, 'h', `t${i}`, 'field', 2);
  assert.equal(rules.length, RULES_LIMIT);
  assert.equal(rules.at(-1).id, `SR-${RULES_LIMIT}`);
  assert.throws(() => add(rules, 'h', 'new', 'field', 2), status(400, /500건까지/));
  assert.equal(add(rules, 'h', 't0', 'heading', 1).length, RULES_LIMIT);
});

test('removeRule·matchRule: id 또는 열쇠로 지우고(새 배열), 공백만 다른 글은 같은 규칙이며 빈 글은 어느 규칙과도 맞지 않는다', () => {
  const rules = add(add([], 'A', 'x', 'heading', 2), '', 'y', 'field', 3);
  assert.deepEqual(removeRule(rules, 'SR-001').map(r => r.id), ['SR-002']);
  assert.deepEqual(removeRule(rules, { heading: ' A ', text: 'x ' }).map(r => r.id), ['SR-002']);
  assert.deepEqual(removeRule(rules, { heading: '', text: 'y' }).map(r => r.id), ['SR-001']);
  assert.deepEqual(removeRule(rules, 'SR-009').map(r => r.id), ['SR-001', 'SR-002']);
  assert.notEqual(removeRule(rules, 'SR-009'), rules);
  assert.equal(rules.length, 2);
  assert.equal(matchRule(rules, 'A', ' x\n')?.id, 'SR-001');
  assert.equal(matchRule(rules, '', 'y')?.id, 'SR-002');
  assert.equal(matchRule(rules, 'B', 'x'), undefined); // 앞 제목이 다르면 다른 자리
  assert.equal(matchRule(rules, 'A', 'x2'), undefined); // 글이 다르면 적용하지 않는다 — 에이전트 몫
  assert.equal(matchRule(rules, 'A', ''), undefined);
});

test('applyRules: (앞 제목, 글)이 같은 노드만 규칙의 종류·수준으로 — orig·rule 을 남기고 필드→제목은 번호를 떼며 by rule, 제목→필드는 번호 자리를 받고 by 를 뗀다', () => {
  const nodes = [h('A'), f('x'), f('y', 1, { locked: '문서 설정' }), { kind: 'table', t: 0 }, h('B', 2, { by: 'outline', depth: 4 }), f('x'), f('z', 2), h('C')];
  let rules = add([], 'A', 'x', 'heading', 2); // 필드 → 제목
  rules = add(rules, 'A', 'y', 'field', 3); // 필드 수준만
  rules = add(rules, 'A', 'B', 'field', 1); // 제목 → 필드 (제목 B 의 앞 제목은 A)
  rules = add(rules, 'x', 'z', 'field', 5); // 새로 만든 제목 x 아래가 아니라 스캔 때 제목(B) 아래다 — 적용되지 않는다
  rules = add(rules, 'B', 'C', 'heading', 1); // 이미 그 종류·수준 — 바뀌는 것이 없다
  const before = structuredClone(nodes);
  const { nodes: out, applied } = applyRules(nodes, rules);
  assert.deepEqual(nodes, before); // 입력은 그대로
  assert.deepEqual(applied, [{ i: 1, ruleId: 'SR-001' }, { i: 2, ruleId: 'SR-002' }, { i: 4, ruleId: 'SR-003' }]);
  assert.deepEqual(out[1], { kind: 'heading', level: 2, text: 'x', section: 0, p: 0, orig: { kind: 'field', level: 1 }, rule: 'SR-001', by: 'rule' });
  assert.deepEqual(out[2], { kind: 'field', n: 0, level: 3, text: 'y', section: 0, p: 0, locked: '문서 설정', orig: { kind: 'field', level: 1 }, rule: 'SR-002' });
  assert.deepEqual(out[4], { kind: 'field', level: 1, text: 'B', section: 0, p: 0, orig: { kind: 'heading', level: 2, by: 'outline', depth: 4 }, rule: 'SR-003', n: 0 });
  assert.deepEqual([out[0], out[3], out[5], out[6], out[7]], [nodes[0], nodes[3], nodes[5], nodes[6], nodes[7]]);
  assert.deepEqual(applyRules(nodes, []), { nodes, applied: [] });
  const levelOnly = applyRules([h('A', 1, { depth: 4, by: 'outline' })], add([], '', 'A', 'heading', 4));
  assert.deepEqual(levelOnly.nodes[0], { kind: 'heading', level: 4, text: 'A', section: 0, p: 0, by: 'outline', orig: { kind: 'heading', level: 1, by: 'outline', depth: 4 }, rule: 'SR-001', depth: 4 });
});

test('rulesText: 규칙마다 영어 한 줄 — 앞 제목(없으면 at top level)·글·바뀐 종류와 수준·이전 상태, 긴 글은 자른다, 없으면 빈 글', () => {
  const rules = add(add([], '1. 개요', 'o 본문 글', 'heading', 2, { from: { kind: 'field', level: 1 } }), '', 'x'.repeat(250), 'field', 3);
  const lines = rulesText(rules).split('\n');
  assert.equal(lines[0], '- under 「1. 개요」: 「o 본문 글」 → heading level 2 (was field level 1)');
  assert.equal(lines[1], `- at top level: 「${'x'.repeat(200)}…」 → field level 3`);
  assert.equal(rulesText([]), '');
  assert.equal(rulesText(undefined), '');
});

test('파일: 없으면 빈 목록, 쓰기(임시 파일 → 이름 바꾸기) → 읽기 왕복, 깨진 파일·모양이 다른 항목은 조용히 뺀다', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sourceanchor-form-rules-test-'));
  try {
    assert.deepEqual(await loadRules(dir), []);
    assert.deepEqual(await loadRules(path.join(dir, 'none')), []);
    const rules = add(add([], 'A', 'x', 'heading', 2, { fileName: 'a.docx' }), '', 'y', 'field', 1);
    await saveRules(dir, rules);
    assert.deepEqual(await loadRules(dir), rules);
    assert.deepEqual(await fs.readdir(dir), [RULES_FILE]); // 임시 파일이 남지 않는다
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, RULES_FILE), 'utf8')), { rules });
    await saveRules(dir, []);
    assert.deepEqual(await loadRules(dir), []);
    await fs.writeFile(path.join(dir, RULES_FILE), JSON.stringify({ rules: [rules[0], { id: 'SR-009' }, 'x', { ...rules[1], level: '1' }] }));
    assert.deepEqual(await loadRules(dir), [rules[0]]);
    await fs.writeFile(path.join(dir, RULES_FILE), '{ broken');
    assert.deepEqual(await loadRules(dir), []);
    await fs.writeFile(path.join(dir, RULES_FILE), '[]');
    assert.deepEqual(await loadRules(dir), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
