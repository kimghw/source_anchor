// 스킬 — 기준 문서의 셋째 종류: 머리말(name·description) 읽기, 등록·설명 고치기, 에이전트에게 가는 목록 (FR-WB-105, DR-WB-006)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { guidesText } from '../agent.js';
import { isSkill, skillsBlock, SKILL_RULE, splitFront } from '../lib/guide_skills.js';

async function freshStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sourceanchor-skills-test-'));
  process.env.WORKSPACE = dir;
  return import(`../lib/store.js?workspace=${encodeURIComponent(dir)}`);
}
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const SKILL = '---\nname: scope-label\ndescription: "조항마다 적용범위를 라벨링할 때 쓴다"\n---\n# 적용범위 라벨링\n\n모든 조항 끝에 [적용: 대상] 라벨을 붙인다.\n';
const words = guide => guide.blocks.flatMap(b => b.sentences.map(s => s.text)).join('\n');

test('머리말: name·description 을 읽고 본문에서 뺀다 — 따옴표·여러 줄 값, 머리말이 아닌 가로줄은 그대로', () => {
  assert.deepEqual(splitFront(SKILL), { body: '# 적용범위 라벨링\n\n모든 조항 끝에 [적용: 대상] 라벨을 붙인다.\n', name: 'scope-label', description: '조항마다 적용범위를 라벨링할 때 쓴다' });
  assert.deepEqual(splitFront('﻿---\r\nname: a\r\ndescription: >\r\n  첫 줄\r\n  둘째 줄\r\nlicense: x\r\n---\r\n본문'), { body: '본문', name: 'a', description: '첫 줄 둘째 줄' });
  assert.deepEqual(splitFront('본문만'), { body: '본문만', name: '', description: '' });
  assert.deepEqual(splitFront('---\n가로줄 사이의 글\n---\n뒤'), { body: '---\n가로줄 사이의 글\n---\n뒤', name: '', description: '' }); // 「이름: 값」 줄이 없으면 머리말이 아니다
});

test('스킬 등록: 붙여 넣은 본문·SKILL.md 파일 모두 머리말의 name 이 제목, description 이 설명이 되고 머리말은 본문에 없다 · 설명은 고치고 비울 수 있다', async () => {
  const store = await freshStore();
  const { book } = await store.loadBookState();
  const pasted = await store.addGuide({ bookId: book.id, kind: 'skill', title: '---', markdown: SKILL });
  assert.deepEqual([pasted.guide.kind, pasted.guide.title, pasted.guide.description], ['skill', 'scope-label', '조항마다 적용범위를 라벨링할 때 쓴다']);
  const filed = await store.addGuide({ bookId: book.id, kind: 'skill', fileName: 'SKILL.md', data: b64(SKILL) });
  assert.deepEqual([filed.guide.title, filed.guide.description, filed.guide.snapshot], ['scope-label', '조항마다 적용범위를 라벨링할 때 쓴다', 'originals/G-002.md']); // 원본은 머리말까지 그대로 보관
  for (const id of ['G-001', 'G-002']) {
    const text = words(await store.getGuide(book.id, id));
    assert.ok(text.includes('모든 조항 끝에 [적용: 대상] 라벨을 붙인다.'));
    assert.ok(!/name:|description:|---/.test(text));
  }
  const plain = await store.addGuide({ bookId: book.id, kind: 'skill', title: '부록 작성', markdown: '# 부록 작성\n\n부록은 표로 정리한다.' });
  assert.deepEqual([plain.guide.title, plain.guide.description], ['부록 작성', undefined]);

  const edited = await store.updateGuide({ bookId: book.id, id: 'G-003', description: '  부록을   만들 때 ' });
  assert.equal(edited.guide.description, '부록을 만들 때');
  assert.equal((await store.updateGuide({ bookId: book.id, id: 'G-003', title: '부록' })).guide.description, '부록을 만들 때'); // 설명을 보내지 않으면 그대로
  assert.equal((await store.updateGuide({ bookId: book.id, id: 'G-003', description: ' ' })).guide.description, undefined);
  assert.deepEqual(store.listGuides(book.id).map(g => [g.id, g.kind, g.description]), [['G-001', 'skill', '조항마다 적용범위를 라벨링할 때 쓴다'], ['G-002', 'skill', '조항마다 적용범위를 라벨링할 때 쓴다'], ['G-003', 'skill', undefined]]);
});

test('에이전트에게: <guides> 의 스킬 줄에 설명이, <skills> 에 스킬만 실리고 스킬이 없으면 <skills> 가 없다 · 규칙은 스킬을 따르되 근거로 쓰지 않게 한다', () => {
  const block = { id: 'G-001.b1', kind: 'paragraph', sentences: [{ id: 'G-001.b1.s1', text: '라벨을 붙인다.' }] };
  const skill = { id: 'G-001', kind: 'skill', title: 'scope-label', description: '적용범위를 라벨링할 때', fileName: 'SKILL.md', collectedAt: 't', blocks: [block] };
  const bare = { ...skill, id: 'G-002', title: '부록', description: undefined, fileName: '' };
  const rule = { ...skill, id: 'G-003', kind: 'guideline', title: '작성 규정', description: undefined, fileName: '' };
  assert.equal(isSkill(skill) && !isSkill(rule), true);
  const text = guidesText([skill, bare, rule]);
  assert.ok(text.includes('- G-001 [스킬] scope-label (SKILL.md) — skill, description: 적용범위를 라벨링할 때 — file guides/G-001.md'));
  assert.ok(text.includes('- G-002 [스킬] 부록 — skill, no description — open it to see what it is for — file guides/G-002.md'));
  assert.ok(text.includes('- G-003 [작성요령] 작성 규정 — file guides/G-003.md'));
  const skills = skillsBlock([skill, bare, rule]);
  assert.ok(skills.startsWith('<skills>\n') && skills.endsWith('</skills>'));
  assert.ok(skills.includes('- G-001 scope-label — description: 적용범위를 라벨링할 때 — file guides/G-001.md'));
  assert.ok(!skills.includes('G-003'));
  assert.equal(skillsBlock([rule]), '');
  assert.match(SKILL_RULE, /스킬 적용: <id> <name>/);
  assert.match(SKILL_RULE, /never cite it as the source of a fact/);
});
