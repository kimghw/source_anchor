// 기준 문서 구조 계층 — 번호 체계로 깊이·상위 마디 정하기(선급 규칙·법령·보고서), 문단 첫 숫자·「Part of」는 마디가 아님,
// Markdown 구조 목록·제목 깊이, 미리보기 구조 블록, 에이전트 블록별 구조 위치, 옛 문서 읽을 때 채우기 (DR-WB-006)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { guidesText } from '../agent.js';
import { pageBlocks, parseConverted } from '../lib/guide_convert.js';
import { itemNodes, outlineOf, structure, structurePaths } from '../lib/guide_outline.js';
import { sourceMarkdown } from '../lib/source_md.js';
import { markdownHtml } from '../public/js/md_preview.js';
import { buildBlocks } from '../public/shared/model.js';

const RULES = `<!-- p.1 -->
# Part C Machinery, Electricity, Automation and Fire Protection

# CHAPTER 2 ELECTRICAL INSTALLATIONS

- Section 1 General
- Section 2 General Design Requirements

<!-- p.2 -->
# Section 1 General

## 1 Application

### 1.1 General

1.1.1 The requirements of this Chapter apply to electrical installations on ships.
In particular, they apply to the components of electrical installations for:

- primary essential services
- secondary essential services

Part of the installation is not covered.

50 V installations are not covered either.

1.1.2 The Society may consider modified requirements.

## 2 Documentation to be submitted

### 2.1

2.1.1 The documents listed in Tab 1 are to be submitted.

| No. | Documents |
|---|---|
| 1 | General arrangement |

<!-- p.21 -->
2.1.2 This clause starts the next batch of pages.

# Section 2 General Design Requirements

## 1 Environmental conditions
<!-- end -->`;

const byText = (blocks, start) => blocks.find(b => b.kind !== 'list' && (b.sentences[0]?.text || '').startsWith(start)); // 장 목차 목록의 「Section 1 General」은 건너뛴다

test('구조 계층(선급 규칙): Part → CHAPTER → Section → 1 → 1.1 → 1.1.1, 목록·표·번호 없는 문단은 바로 앞 마디 아래, 묶음이 바뀌어도 이어진다', () => {
  const blocks = structure(pageBlocks('G-003', parseConverted(RULES, 1)));
  const node = start => byText(blocks, start);
  const chain = b => (b ? [...chain(blocks.find(x => x.id === b.parent)), b.number] : []);
  assert.deepEqual(chain(node('1.1.1')), ['Part C', 'CHAPTER 2', 'Section 1', '1', '1.1', '1.1.1']);
  assert.deepEqual([node('Part C').depth, node('CHAPTER 2').depth, node('Section 1').depth, node('1 Application').depth, node('1.1 General').depth, node('1.1.1').depth], [1, 2, 3, 4, 5, 6]);
  assert.equal(blocks.find(b => b.kind === 'list' && b.sentences[0].text === 'primary essential services').parent, node('1.1.1').id);
  assert.equal(node('Part of the installation').parent, node('1.1.1').id, '「Part of …」 문단은 마디가 아니다');
  assert.equal(node('Part of the installation').depth, undefined);
  assert.equal(node('50 V installations').parent, node('1.1.1').id, '문장 첫 숫자는 마디가 아니다');
  assert.equal(node('1.1.2').parent, node('1.1 General').id);
  assert.equal(blocks.find(b => b.kind === 'table').parent, node('2.1.1').id);
  assert.equal(node('2.1.2').parent, node('2.1').id, '21쪽(다음 묶음)의 조항도 앞 묶음의 2.1 아래');
  assert.equal(node('Section 2').parent, node('CHAPTER 2').id);
  assert.equal(node('1 Environmental').parent, node('Section 2').id);
  assert.equal(blocks.find(b => b.kind === 'list').parent, node('CHAPTER 2').id); // 장 목차 목록
  // 다시 정해도 같다
  const again = structure(structuredClone(blocks));
  assert.deepEqual(again.map(b => [b.id, b.parent, b.depth, b.number]), blocks.map(b => [b.id, b.parent, b.depth, b.number]));
  // 블록별 구조 위치 — 마디는 자신까지, 그 밖의 블록은 상위 마디까지
  const paths = structurePaths(blocks);
  assert.equal(paths.get(blocks.find(b => b.kind === 'table').id), 'Part C › CHAPTER 2 › Section 1 › 2 › 2.1 › 2.1.1');
  assert.equal(paths.get(node('1.1.1').id), 'Part C › CHAPTER 2 › Section 1 › 1 › 1.1 › 1.1.1');
});

const drafts = list => list.map(([kind, text, level]) => (kind === 'heading' ? { kind, text, level: level || 1, loc: { para: 1 } } : { kind: 'paragraph', text, loc: { para: 1 } }));

test('구조 계층(법령·보고서): 처음 나온 체계를 그 자리 아래 단계로 익히고 다시 나오면 같은 단계로 본다', () => {
  const law = structure(buildBlocks('G-001', drafts([
    ['heading', '제1장 총칙'], ['paragraph', '제1조(목적) 이 법은 선박의 안전을 정한다.'], ['paragraph', '① 이 법은 모든 선박에 적용한다.'],
    ['paragraph', '1. 여객선'], ['paragraph', '가. 국제 항해 여객선'], ['paragraph', '2. 화물선'], ['paragraph', '② 다만 군함은 제외한다.'],
    ['paragraph', '제2조(정의) 이 법에서 쓰는 말의 뜻은 다음과 같다.'], ['heading', '제2장 검사'], ['paragraph', '제3조(정기검사) 정기검사를 받아야 한다.'],
  ])));
  assert.deepEqual(law.map(b => [b.number, b.depth]), [['제1장', 1], ['제1조', 2], ['①', 3], ['1.', 4], ['가.', 5], ['2.', 4], ['②', 3], ['제2조', 2], ['제2장', 1], ['제3조', 2]]);

  const report = structure(buildBlocks('G-002', drafts([
    ['paragraph', '이 보고서는 시험 결과를 정리한다.'], ['heading', '1. 개요', 1], ['heading', '1.1 배경', 2], ['paragraph', '가. 기술 동향을 본다.'],
    ['paragraph', '(1) 국내 동향이다.'], ['paragraph', '본문 문단이다.'], ['heading', '1.2 범위', 2], ['heading', '참고 사항', 3], ['heading', '2. 본론', 1],
  ])));
  assert.deepEqual(report.map(b => [b.number ?? null, b.depth ?? null]), [[null, null], ['1.', 1], ['1.1', 2], ['가.', 3], ['(1)', 4], [null, null], ['1.2', 2], ['', 3], ['2.', 1]]);
  assert.equal(report[0].parent, null, '첫 마디 앞의 문단은 맨 위');
  assert.equal(report[5].parent, report[4].id);
  assert.equal(report[7].parent, report[6].id, '번호 없는 제목은 앞 마디 아래 단계로 익힌다');
});

test('목록 항목 마디: 번호로 시작하는 항목은 항목 하나씩 문단 블록으로 떼어 마디가 되고, 그 점 번호는 제목의 점 번호와 따로 익힌다(101. 아래 1. → (1) → (A))', () => {
  const md = `## Section 1 General\n\n#### 101. General\n\n- 1. Application\n  - (1) The requirements apply to ships. For small ships they may be modified.\n  - (2) Except where stated.\n- 2. Terminology\n  - (1) Dangerous spaces are:\n    - (A) Zone 0\n    - (B) Zone 1\n    - (a) gas pipes\n  - 메모 항목\n  - 또 다른 메모\n- 3. Passenger ships\n  Body text of clause 3.\n\n#### 102. Drawings\n\n- 1. Plans`;
  const blocks = structure(pageBlocks('G-001', itemNodes(parseConverted(`<!-- p.1 -->\n${md}`, 1))));
  const paths = structurePaths(blocks);
  assert.deepEqual(blocks.map(b => [b.kind, b.sentences.map(s => s.text).join(' / ').slice(0, 24), b.depth ?? null]), [
    ['heading', 'Section 1 General', 1], ['heading', '101. General', 2],
    ['paragraph', '1. Application', 3], ['paragraph', '(1) The requirements app', 4], ['paragraph', '(2) Except where stated.', 4],
    ['paragraph', '2. Terminology', 3], ['paragraph', '(1) Dangerous spaces are', 4], ['paragraph', '(A) Zone 0', 5], ['paragraph', '(B) Zone 1', 5], ['paragraph', '(a) gas pipes', 6],
    ['list', '메모 항목 / 또 다른 메모', null],
    ['paragraph', '3. Passenger ships', 3], ['paragraph', 'Body text of clause 3.', null],
    ['heading', '102. Drawings', 2], ['paragraph', '1. Plans', 3],
  ]);
  assert.deepEqual(blocks[3].sentences.map(s => s.id), ['G-001.p1.b4.s1', 'G-001.p1.b4.s2'], '떼어 낸 항목은 문장마다 ID');
  assert.equal(paths.get(blocks[10].id), 'Section 1 › 101. › 2. › (1) › (B) › (a)', '번호 없는 항목은 목록으로 남아 앞 마디 아래');
  assert.equal(paths.get(blocks[12].id), 'Section 1 › 101. › 3.');
  // 항목이 아닌 문단의 점 번호는 그대로 제목과 같은 체계다 — 1.1 제목 아래 1.1.1 문단
  const plain = structure(buildBlocks('G-002', drafts([['heading', '1 General', 1], ['heading', '1.1 Scope', 2], ['paragraph', '1.1.1 The rules apply.'], ['heading', '1.2 Terms', 2]])));
  assert.deepEqual(plain.map(b => b.depth), [1, 2, 3, 2]);
});

test('구조 목록·제목 깊이: Markdown 머리말 다음에 구조 목록(깊이만큼 들여쓰기·블록 ID·쪽), 제목은 깊이만큼의 #, 미리보기는 구조 블록으로 읽는다', () => {
  const blocks = structure(pageBlocks('G-003', parseConverted(RULES, 1)));
  const md = sourceMarkdown({ id: 'G-003', version: 'V-002', type: 'pdf', title: 'BV', collectedAt: 't', hash: 'h', blocks }, { ids: true });
  const lines = md.split('\n');
  const start = lines.indexOf('<!-- outline -->');
  assert.ok(start > 0 && start < lines.indexOf('<!-- p.1 -->'));
  for (const line of ['- [G-003.p1.b1] Part C Machinery, Electricity, Automation and Fire Protection · p.1', '    - [G-003.p2.b1] Section 1 General · p.2', '##### [G-003.p2.b3.s1] 1.1 General', '#### [G-003.p2.b2.s1] 1 Application']) {
    assert.ok(lines.includes(line), line);
  }
  assert.ok(lines.includes('<!-- /outline -->'));
  assert.ok(lines.some(l => l.startsWith('          - [G-003.p2.b4] 1.1.1 The requirements of this Chapter apply') && l.endsWith('… · p.2')), '조항 마디의 제목은 80자에서 줄인다');
  const preview = markdownHtml(md);
  assert.equal(preview.outline, outlineOf(blocks).length);
  const [outlineHtml, bodyHtml] = preview.html.split('</details>');
  const nesting = (outlineHtml.match(/<\/?ul>/g) || []).reduce(([d, max], tag) => (tag === '<ul>' ? [d + 1, Math.max(max, d + 1)] : [d - 1, max]), [0, 0])[1];
  assert.equal(nesting, Math.max(...outlineOf(blocks).map(n => n.depth)), '구조 깊이만큼 중첩 목록');
  assert.ok(!bodyHtml.includes('>G-003.p2.b1</code>'), '구조 목록은 본문에 다시 나오지 않는다');
  // 장의 원문 Markdown(ids 없음)에는 구조 목록이 없다
  assert.ok(!sourceMarkdown({ id: 'S-001', version: 'V-001', type: 'pdf', title: 't', collectedAt: 't', hash: 'h', blocks }).includes('<!-- outline -->'));
});

test('에이전트: 기준 문서 블록의 머리줄에 구조 위치를 붙인다', () => {
  const blocks = structure(pageBlocks('G-003', parseConverted(RULES, 1)));
  const text = guidesText([{ id: 'G-003', kind: 'guideline', title: 'BV', fileName: 'bv.pdf', collectedAt: 't', hash: 'h', type: 'pdf', blocks }]);
  const listId = blocks.find(b => b.kind === 'list' && b.sentences[0].text === 'primary essential services').id;
  assert.ok(text.includes(`── ${listId} list @ p.2 · Part C › CHAPTER 2 › Section 1 › 1 › 1.1 › 1.1.1`), text.slice(0, 400));
  assert.ok(text.includes('── G-003.p1.b1 heading @ p.1 · Part C\n'));
});

test('옛 문서: 구조 계층이 없는 기준 문서는 읽을 때 정해 json 과 Markdown(구조 목록)에 남긴다', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sourceanchor-outline-test-'));
  process.env.WORKSPACE = dir;
  const store = await import(`../lib/store.js?workspace=${encodeURIComponent(dir)}`);
  const { book } = await store.loadBookState();
  await store.addGuide({ bookId: book.id, kind: 'guideline', markdown: '# 1. 총칙\n\n1.1 이 규정은 보고서에 적용한다.\n\n본문 문단이다.\n\n# 2. 문체\n\n2.1 문장은 짧게 쓴다.' });
  const added = await store.getGuide(book.id, 'G-001');
  assert.deepEqual(added.blocks.map(b => [b.number ?? null, b.depth ?? null]), [['1.', 1], ['1.1', 2], [null, null], ['2.', 1], ['2.1', 2]]);
  // 옛 형식으로 되돌린다 — parent·depth·number 가 없는 json, 구조 목록이 없는 Markdown
  const guidesDir = path.join(dir, 'projects', book.id, 'guides');
  const old = JSON.parse(await fs.readFile(path.join(guidesDir, 'G-001.json'), 'utf8'));
  old.blocks = old.blocks.map(({ parent, depth, number, ...b }) => b);
  await fs.writeFile(path.join(guidesDir, 'G-001.json'), JSON.stringify(old));
  await fs.writeFile(path.join(guidesDir, 'G-001.md'), '[G-001.b1.s1] 1. 총칙\n');
  const again = await import(`../lib/store.js?reload=${Date.now()}`);
  assert.equal((await again.getGuide(book.id, 'G-001')).blocks[1].parent, 'G-001.b1');
  assert.equal(JSON.parse(await fs.readFile(path.join(guidesDir, 'G-001.json'), 'utf8')).blocks[4].parent, 'G-001.b4');
  const md = await fs.readFile(path.join(guidesDir, 'G-001.md'), 'utf8');
  assert.ok(md.includes('<!-- outline -->') && md.includes('  - [G-001.b2] 1.1 이 규정은 보고서에 적용한다.'), md.slice(0, 600));
});
