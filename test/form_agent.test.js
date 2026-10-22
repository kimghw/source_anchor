// 양식 화면 에이전트 — 답 블록의 form·structure 키, 셀·필드 값 제안 검사, 구조(수준·종류) 수정안 검사, 에이전트에게 주는 양식 글(h<i> 제목 id)·구조 규칙·파일 대체, 보고서 전체 앵커 색인
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBlock } from '../agent.js';
import { bookAnchorIndex, FORM_INSTRUCTIONS, formBlock, formFileText, formText, reviewForm, reviewStructure, rulesBlock } from '../lib/form_agent.js';
import { buildForm, unitIndex } from '../lib/forms.js';
import { docxHeading, docxOf, docxSentence, docxTable } from './fixtures/form_docs.js';

// nodes: h0 헤딩 「1. 제안 개요」 · i1 필드 #1 · h2 헤딩 「□ 기술 개요」 · i3 빈 필드 #2(after) · i4 표(#3 제목 고정 높이 … #7 장소 · #8 x & y · #9 필드 있음 · #10 중첩 표 잠김 · #11) · i5 필드 #12
const bodyDocx = docxOf(`${docxHeading}${docxSentence}<w:p/><w:p><w:r><w:t>□ 기술 개요</w:t></w:r></w:p>${docxTable}<w:p><w:r><w:t>끝 글</w:t></w:r></w:p>`);
const fixture = async () => {
  const { form } = await buildForm({ id: 'F-001', title: '제안서', fileName: '제안서.docx', data: bodyDocx });
  return { ...form, values: { 8: '값' }, instructions: { 8: '장소는 시·군까지만' } };
};
const lockedOf = form => [...unitIndex(form)].find(([, u]) => (u.cell ?? u.node).locked)[0];
const fence = json => `설명입니다.\n\`\`\`sourceanchor\n${json}\n\`\`\``;

test('parseBlock: form·structure 키 — 펜스 안의 배열, 펜스 없음·깨진 JSON 은 빈 배열', () => {
  const parsed = parseBlock(fence('{"form":[{"cell":7,"text":"x"}]}'));
  assert.equal(parsed.form.length, 1);
  assert.deepEqual(parsed.changes, []);
  assert.deepEqual(parsed.structure, []);
  assert.deepEqual(parseBlock('펜스 없는 답').form, []);
  assert.deepEqual(parseBlock('펜스 없는 답').structure, []);
  const broken = parseBlock(fence('{"form":['));
  assert.deepEqual([broken.form, broken.structure], [[], []]);
  assert.match(broken.error, /JSON/);
  // form 과 structure 는 같은 블록에 함께 온다 — 배열이 아니면 빈 배열
  const both = parseBlock(fence('{"form":[{"cell":7,"text":"x"}],"structure":[{"target":"#1052","level":2},{"target":"h27","kind":"field"}]}'));
  assert.deepEqual([both.form.length, both.structure.length, both.structure[1].target], [1, 2, 'h27']);
  assert.deepEqual(parseBlock(fence('{"structure":{"target":"#1"}}')).structure, []);
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
  assert.equal(reviewForm([{ cell: 8, text: 'a\u0002b\r\nc' }], form, index)[0].text, 'ab\nc'); // XML 1.0 금지 글자는 뺀다
});

test('formText·formBlock: 헤딩·필드·바뀐 칸·잠긴 칸·고정 높이·지침, 크면 파일로', async () => {
  const form = await fixture();
  const text = formText(form);
  assert.match(text.split('\n')[0], /^F-001 제안서 \| docx \| units 12 \| changed 1 \| locked #10$/);
  assert.match(text, /^h0 # 1\. 제안 개요$/m); // 제목은 nodes index 를 id 로 (구조 수정안의 대상)
  assert.match(text, /^h2 # □ 기술 개요$/m);
  assert.match(text, /^#1 \[L2\] "본문 문장이다\."$/m);
  const deep = { ...form, nodes: form.nodes.map((x, i) => (i <= 1 ? { ...x, level: 6 } : x)) }; // 작성자가 둔 수준 4~6 도 그대로
  assert.match(formText(deep), /^h0 ###### 1\. 제안 개요$/m);
  assert.match(formText(deep), /^#1 \[L6\] "본문 문장이다\."$/m);
  assert.match(text, /^#2 \[L2\] \(empty — body of the heading above\)$/m);
  assert.match(text, /^row 0 \(fixed height\): #3 "제목"$/m);
  assert.match(text, /^row 1: #4 "A" \| #5 "과제명" \| #6 "값1⏎둘째⏎"$/m);
  assert.match(text, /#8\* "값"/);
  assert.match(text, /#10 \[locked: 중첩 표\] ""/);
  assert.match(text, /instructions:\n#8: 장소는 시·군까지만/);
  assert.match(text, /notes:\n#9: 필드 있음/);
  assert.match(formText({ ...form, values: { 8: 'v'.repeat(500) } }), /#8\* "v{240}…"/);
  assert.match(formFileText({ ...form, values: { 8: '첫 줄\n둘째 줄' } }), /#8\* "첫 줄\n {8}둘째 줄"/);
  const heading = { ...form, nodes: form.nodes.map((x, i) => (i ? x : { ...x, text: `첫 줄\n${'h'.repeat(300)}` })) }; // 헤딩도 한 줄로, <form> 에서는 240자에서 자른다
  assert.ok(formText(heading).split('\n').includes(`h0 # 첫 줄⏎${'h'.repeat(236)}…`));
  assert.ok(formFileText(heading).split('\n').includes(`h0 # 첫 줄⏎${'h'.repeat(300)}`));
  assert.equal(formBlock(form), `<form>\n${text}\n</form>`);
  const big = { ...form, instructions: { 8: 'w'.repeat(70_000) } };
  const block = formBlock(big);
  assert.match(block, /form\/F-001\.md/);
  assert.match(block, /units 12/);
  assert.ok(!block.includes('w'.repeat(1000)));
  assert.ok(formFileText(big).includes('w'.repeat(70_000)));
});

test('rulesBlock: 규칙이 없으면 빈 글, 있으면 <form_rules> 안에 규칙마다 영어 한 줄', () => {
  assert.equal(rulesBlock([]), '');
  assert.equal(rulesBlock(undefined), '');
  const rules = [
    { id: 'SR-001', heading: '1. 제안 개요', text: '[공동연구개발기관2]', kind: 'heading', level: 2, from: { kind: 'field', level: 1 } },
    { id: 'SR-002', heading: '', text: '□ 기술 개요', kind: 'field', level: 3, from: { kind: 'heading', level: 1 } },
  ];
  const block = rulesBlock(rules);
  const lines = block.split('\n');
  assert.deepEqual([lines[0], lines.at(-1), lines.length], ['<form_rules>', '</form_rules>', 4]);
  assert.match(lines[1], /「1\. 제안 개요」.*「\[공동연구개발기관2\]」.*heading level 2.*field level 1/);
  assert.match(lines[2], /「□ 기술 개요」.*field level 3.*heading level 1/);
  // 지침이 <form_rules> 와 structure 블록·h<i> 제목 id 를 설명한다
  for (const part of ['<form_rules>', '"structure"', 'h<i>', '"target": "#1052"', '"target": "h27"']) assert.ok(FORM_INSTRUCTIONS.includes(part), part);
});

test('reviewStructure: 유효한 수준·종류 변경과 무효 사유', async () => {
  const form = await fixture();
  const [level, toField, toHeading, both, strLevel, badFormat, notString, missing, missingH, cell, table, notHeading, empty, badLevel, lowLevel, badKind, nothing, sameLevel, sameKind] = reviewStructure([
    { target: '#1', level: 3, reason: '하위 글머리' },
    { target: 'h0', kind: 'field' },
    { target: '#12', kind: 'heading', level: 2 },
    { target: 'h2', kind: 'field', level: 4 },
    { target: '#1', level: '6' },
    { target: 'x1', level: 2 },
    { target: 12, level: 2 },
    { target: '#99', level: 2 },
    { target: 'h99', level: 2 },
    { target: '#5', level: 2 },
    { target: 'h4', level: 2 },
    { target: 'h1', level: 3 },
    { target: '#2', kind: 'heading' },
    { target: '#1', level: 7 },
    { target: '#1', level: 0 },
    { target: '#1', kind: 'table' },
    { target: '#1' },
    { target: '#1', level: 2 },
    { target: 'h0', kind: 'heading' },
  ], form);
  assert.equal(level.invalid, undefined);
  assert.match(level.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual([level.target, level.i, level.text, level.before, level.level, level.kind, level.reason, level.problems], ['#1', 1, '본문 문장이다.', { kind: 'field', level: 2 }, 3, null, '하위 글머리', []]);
  assert.deepEqual([toField.invalid, toField.i, toField.text, toField.before, toField.level, toField.kind], [undefined, 0, '1. 제안 개요', { kind: 'heading', level: 1 }, null, 'field']);
  assert.deepEqual([toHeading.invalid, toHeading.i, toHeading.before, toHeading.level, toHeading.kind], [undefined, 5, { kind: 'field', level: 1 }, 2, 'heading']);
  assert.deepEqual([both.invalid, both.i, both.before, both.level, both.kind], [undefined, 2, { kind: 'heading', level: 1 }, 4, 'field']);
  assert.deepEqual([strLevel.invalid, strLevel.level], [undefined, 6]); // 숫자 글은 숫자로, 6 까지
  assert.deepEqual(badFormat.problems, ['target 은 #번호(필드) 또는 h번호(제목)여야 합니다: x1']);
  assert.deepEqual(notString.problems, ['target 은 #번호(필드) 또는 h번호(제목)여야 합니다: 12']);
  assert.deepEqual(missing.problems, ['#99 은 이 양식에 없는 단위입니다']);
  assert.deepEqual(missingH.problems, ['h99 은 이 양식에 없는 제목입니다']);
  assert.deepEqual(cell.problems, ['#5 은 표의 칸입니다 — 표 자리는 바꿀 수 없습니다']);
  assert.deepEqual(table.problems, ['h4 은 표 자리입니다 — 표 자리는 바꿀 수 없습니다']);
  assert.deepEqual(notHeading.problems, ['h1 은 제목이 아닙니다 — 필드는 #1 으로 가리키세요']);
  assert.deepEqual(empty.problems, ['#2 은 제목 바로 뒤의 빈 필드입니다 — 제목으로 바꿀 수 없습니다']);
  assert.deepEqual(badLevel.problems, ['#1: level 은 1~6 사이의 정수여야 합니다: 7']);
  assert.deepEqual(lowLevel.problems, ['#1: level 은 1~6 사이의 정수여야 합니다: 0']);
  assert.deepEqual(badKind.problems, ['#1: kind 는 heading 또는 field 여야 합니다: table']);
  assert.deepEqual(nothing.problems, ['#1: level 이나 kind 가 필요합니다']);
  assert.deepEqual(sameLevel.problems, ['#1: 바뀌는 것이 없습니다']);
  assert.deepEqual(sameKind.problems, ['h0: 바뀌는 것이 없습니다']);
  for (const item of [badFormat, notString, missing, missingH, cell, table, notHeading, empty, badLevel, lowLevel, badKind, nothing, sameLevel, sameKind]) assert.equal(item.invalid, true);
  assert.deepEqual([badFormat.i, badFormat.before, empty.i, empty.before], [null, null, 3, { kind: 'field', level: 2 }]); // 대상을 찾은 뒤의 무효는 i·before 를 싣는다
  // 빈 필드의 수준은 바꿀 수 있고, 문단 뒤에 끼우는(after) 필드는 빈 표시가 없어도 종류를 바꿀 수 없다
  assert.deepEqual([reviewStructure([{ target: '#2', level: 3 }], form)[0].invalid, reviewStructure([{ target: '#2', level: 3 }], form)[0].level], [undefined, 3]);
  const afterOnly = { ...form, nodes: form.nodes.map(x => (x.n === 2 ? { ...x, empty: undefined, after: true } : x)) };
  assert.deepEqual(reviewStructure([{ target: '#2', kind: 'heading' }], afterOnly)[0].problems, ['#2 은 문단 뒤에 끼우는 필드입니다 — 종류를 바꿀 수 없습니다']);
  assert.equal(reviewStructure([{ target: '#1', level: 3, reason: 'r'.repeat(400) }], form)[0].reason.length, 300);
  assert.deepEqual(reviewStructure([null, {}], form).map(x => x.problems), [['target 은 #번호(필드) 또는 h번호(제목)여야 합니다: (없음)'], ['target 은 #번호(필드) 또는 h번호(제목)여야 합니다: (없음)']]);
});

test('bookAnchorIndex: 장마다 원문 앵커를 장 ID 로 한정한다', () => {
  const source = { id: 'S-001', blocks: [{ id: 'S-001.b1', sentences: [{ id: 'S-001.b1.s1', text: '문장' }] }] };
  const index = bookAnchorIndex({ chapters: [{ id: 'R-001', sources: [source] }, { id: 'R-002', sources: [source] }] });
  assert.deepEqual([...index.keys()], ['R-001/S-001.b1.s1', 'R-002/S-001.b1.s1']);
});
