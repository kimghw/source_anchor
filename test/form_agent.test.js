// 양식 화면 에이전트 — 답 블록의 form 키, 셀·필드 값 제안 검사, 에이전트에게 주는 양식 글·파일 대체, 보고서 전체 앵커 색인
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBlock } from '../agent.js';
import { bookAnchorIndex, formBlock, formFileText, formText, reviewForm } from '../lib/form_agent.js';
import { buildForm, unitIndex } from '../lib/forms.js';
import { docxHeading, docxOf, docxSentence, docxTable } from './fixtures/form_docs.js';

// 헤딩 「1. 제안 개요」 · 필드 #1 · 헤딩 「□ 기술 개요」 · 빈 필드 #2 · 표(#3 제목 고정 높이 … #7 장소 · #8 x & y · #9 필드 있음 · #10 중첩 표 잠김 · #11) · 필드 #12
const bodyDocx = docxOf(`${docxHeading}${docxSentence}<w:p/><w:p><w:r><w:t>□ 기술 개요</w:t></w:r></w:p>${docxTable}<w:p><w:r><w:t>끝 글</w:t></w:r></w:p>`);
const fixture = async () => {
  const { form } = await buildForm({ id: 'F-001', title: '제안서', fileName: '제안서.docx', data: bodyDocx });
  return { ...form, values: { 8: '값' }, instructions: { 8: '장소는 시·군까지만' } };
};
const lockedOf = form => [...unitIndex(form)].find(([, u]) => (u.cell ?? u.node).locked)[0];
const fence = json => `설명입니다.\n\`\`\`sourceanchor\n${json}\n\`\`\``;

test('parseBlock: form 키 — 펜스 안의 form 배열, 펜스 없음·깨진 JSON 은 빈 배열', () => {
  const parsed = parseBlock(fence('{"form":[{"cell":7,"text":"x"}]}'));
  assert.equal(parsed.form.length, 1);
  assert.deepEqual(parsed.changes, []);
  assert.deepEqual(parseBlock('펜스 없는 답').form, []);
  const broken = parseBlock(fence('{"form":['));
  assert.deepEqual(broken.form, []);
  assert.match(broken.error, /JSON/);
});

test('reviewForm: 유효한 칸·필드 제안과 무효 사유', async () => {
  const form = await fixture();
  const index = new Map([['R-001/S-001.b1.s1', {}]]);
  const locked = lockedOf(form);
  const [cell, field, rowspan, notInt, missing, isLocked, same, unqualified, tooLong, notString] = reviewForm([
    { cell: 8, text: '새 값', reason: '사용자 말', anchors: ['R-001/S-001.b1.s1'] },
    { cell: 2, text: '본문 한 줄' },
    { cell: 7, text: '장소 칸' },
    { cell: 'a', text: 'x' },
    { cell: 99, text: 'x' },
    { cell: locked, text: 'x' },
    { cell: 8, text: '값' },
    { cell: 8, text: 'y', anchors: ['S-001.b1.s1'] },
    { cell: 8, text: 'z'.repeat(21_000) },
    { cell: 8, text: 3 },
  ], form, index);
  assert.equal(cell.invalid, undefined);
  assert.deepEqual([cell.cell, cell.kind, cell.text, cell.before, cell.label, cell.reason, cell.anchors], [8, 'cell', '새 값', '값', '장소', '사용자 말', ['R-001/S-001.b1.s1']]);
  assert.match(cell.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual([field.invalid, field.kind, field.before, field.label], [undefined, 'field', '', '□ 기술 개요']);
  assert.equal(rowspan.label, 'A'); // 왼쪽 칸이 위 행에서 세로 병합으로 내려온 칸
  assert.deepEqual(notInt.problems, ['cell 은 정수여야 합니다']);
  assert.deepEqual(missing.problems, ['#99 은 이 양식에 없는 단위입니다']);
  assert.deepEqual(isLocked.problems, [`#${locked} 은 잠긴 단위입니다(중첩 표)`]);
  assert.deepEqual(same.problems, ['#8: 현재 글과 같습니다']);
  assert.deepEqual(unqualified.problems, ['#8: 원문에 없는 anchor: S-001.b1.s1']);
  assert.match(tooLong.problems[0], /^#8: 값은 20,000자까지입니다/);
  assert.deepEqual(notString.problems, ['#8: text 는 문자열이어야 합니다']);
  for (const item of [notInt, missing, isLocked, same, unqualified, tooLong, notString]) assert.equal(item.invalid, true);
});

test('formText·formBlock: 헤딩·필드·바뀐 칸·잠긴 칸·고정 높이·지침, 크면 파일로', async () => {
  const form = await fixture();
  const text = formText(form);
  assert.match(text.split('\n')[0], /^F-001 제안서 \| docx \| units 12 \| changed 1 \| locked #10$/);
  assert.match(text, /^# 1\. 제안 개요$/m);
  assert.match(text, /^#1 \[L2\] "본문 문장이다\."$/m);
  assert.match(text, /^#2 \[L2\] \(empty — body of the heading above\)$/m);
  assert.match(text, /^row 0 \(fixed height\): #3 "제목"$/m);
  assert.match(text, /^row 1: #4 "A" \| #5 "과제명" \| #6 "값1⏎둘째⏎"$/m);
  assert.match(text, /#8\* "값"/);
  assert.match(text, /#10 \[locked: 중첩 표\] ""/);
  assert.match(text, /instructions:\n#8: 장소는 시·군까지만/);
  assert.match(text, /notes:\n#9: 필드 있음/);
  assert.match(formText({ ...form, values: { 8: 'v'.repeat(500) } }), /#8\* "v{240}…"/);
  assert.match(formFileText({ ...form, values: { 8: '첫 줄\n둘째 줄' } }), /#8\* "첫 줄\n {8}둘째 줄"/);
  assert.equal(formBlock(form), `<form>\n${text}\n</form>`);
  const big = { ...form, instructions: { 8: 'w'.repeat(70_000) } };
  const block = formBlock(big);
  assert.match(block, /form\/F-001\.md/);
  assert.match(block, /units 12/);
  assert.ok(!block.includes('w'.repeat(1000)));
  assert.ok(formFileText(big).includes('w'.repeat(70_000)));
});

test('bookAnchorIndex: 장마다 원문 앵커를 장 ID 로 한정한다', () => {
  const source = { id: 'S-001', blocks: [{ id: 'S-001.b1', sentences: [{ id: 'S-001.b1.s1', text: '문장' }] }] };
  const index = bookAnchorIndex({ chapters: [{ id: 'R-001', sources: [source] }, { id: 'R-002', sources: [source] }] });
  assert.deepEqual([...index.keys()], ['R-001/S-001.b1.s1', 'R-002/S-001.b1.s1']);
});
