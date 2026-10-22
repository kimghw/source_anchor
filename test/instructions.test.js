// 장 지시문의 여섯 절 구성 — 절 나누기·합치기·보존·한도 (FR-WB-073)
import assert from 'node:assert/strict';
import test from 'node:test';
import { ancestorsOf, effectiveText, formatInstructions, GUIDE_KIND_DEFAULT, GUIDE_KINDS, guideKind, hasChildren, INSTRUCTIONS_LIMIT, instructionsProblem, parseInstructions, REPORT_SECTIONS, SECTIONS } from '../public/shared/instructions.js';

const empty = () => Object.fromEntries(SECTIONS.map(s => [s.key, '']));

test('여섯 절: 절 제목과 정확히 같은 줄만 경계이고, 합칠 때는 순서를 고정하며 빈 절은 쓰지 않는다 — 왕복이 같다', () => {
  assert.deepEqual(SECTIONS.map(s => s.title), ['문체 및 예시', '헤딩 순서', '제약조건', '규정 및 규칙', '작성요령', '작성 요구사항']);
  const text = '## 제약조건\n2024년 이후만\n\n## 문체 및 예시\n짧게 쓴다.\n예: 문장.\n';
  const p = parseInstructions(text);
  assert.equal(p.preamble, '');
  assert.equal(p.sections.style, '짧게 쓴다.\n예: 문장.');
  assert.equal(p.sections.constraints, '2024년 이후만');
  assert.equal(p.sections.rules, '');
  const out = formatInstructions(p);
  assert.equal(out, '## 문체 및 예시\n짧게 쓴다.\n예: 문장.\n\n## 제약조건\n2024년 이후만');
  assert.equal(formatInstructions(parseInstructions(out)), out);
  assert.equal(parseInstructions('## 제약조건:\r\n가\r\n').sections.constraints, '가'); // CRLF 와 제목 뒤 콜론
  assert.equal(parseInstructions('# 작성요령\n나').sections.tips, '나'); // # 하나여도 절 제목
  assert.equal(formatInstructions({}), '');
  assert.deepEqual(parseInstructions(''), { preamble: '', sections: empty() });
});

test('보존: 절 없이 적힌 옛 지시문·다른 제목·중복 제목·코드 울타리 안의 제목은 지우거나 옮기지 않는다', () => {
  const legacy = '국내 제도 현황만 다룬다. 표 1개 이상.';
  assert.deepEqual(parseInstructions(legacy), { preamble: legacy, sections: empty() });
  assert.equal(formatInstructions(parseInstructions(legacy)), legacy); // 고치지 않고 저장하면 그대로다
  const mixed = '머리말\n\n## 헤딩 순서\n## 1. 개요\n## 2. 본론\n\n## 참고\n따로 적은 절\n\n## 헤딩 순서\n두 번째\n\n## 제약조건\n```\n## 문체 및 예시\n```\n끝';
  const p = parseInstructions(mixed);
  assert.equal(p.preamble, '머리말');
  assert.equal(p.sections.headings, '## 1. 개요\n## 2. 본론\n\n## 참고\n따로 적은 절\n\n## 헤딩 순서\n두 번째'); // 다른 제목·중복 제목은 본문으로 남는다
  assert.equal(p.sections.constraints, '```\n## 문체 및 예시\n```\n끝'); // 울타리 안의 제목은 경계가 아니다
  assert.equal(p.sections.style, '');
  const out = formatInstructions(p);
  for (const piece of ['머리말', '## 1. 개요', '## 참고\n따로 적은 절', '## 헤딩 순서\n두 번째', '```\n## 문체 및 예시\n```\n끝']) assert.ok(out.includes(piece), piece);
  assert.deepEqual(parseInstructions(out), p);
});

test('한도: 12,000자까지는 문제 없음, 넘으면 이유를 돌려준다 · 기준 문서 종류는 작성요령·참고문헌 둘', () => {
  assert.equal(INSTRUCTIONS_LIMIT, 12_000);
  assert.equal(instructionsProblem('a'.repeat(INSTRUCTIONS_LIMIT)), null);
  assert.match(instructionsProblem('a'.repeat(INSTRUCTIONS_LIMIT + 1)), /12,000자까지입니다 \(12,001자\)/);
  assert.deepEqual(GUIDE_KINDS, { guideline: '작성요령', reference: '참고문헌' });
  assert.equal(GUIDE_KIND_DEFAULT, 'guideline');
  assert.deepEqual(['guideline', 'reference', 'regulation', 'rule', 'requirement', 'other', 'bogus', undefined].map(guideKind), ['guideline', 'reference', 'guideline', 'guideline', 'guideline', 'reference', 'guideline', 'guideline']);
});

test('하위 장 적용·합친 지시문: 상위 장은 목차에서 바로 앞의 더 얕은 장들이고, 공통·상위 장은 헤딩 순서를 빼고 물려주며 끈 장은 물려주지 않는다 (FR-WB-087)', () => {
  const chapters = [
    { id: 'R-001', title: 'ㄱ', level: 1, instructions: '## 헤딩 순서\n1. 개요\n\n## 제약조건\n표 1개' },
    { id: 'R-002', title: 'ㄱ-1', level: 2, instructions: '## 작성요령\n요령 a', cascade: false },
    { id: 'R-003', title: 'ㄱ-1-a', level: 3, instructions: '' },
    { id: 'R-004', title: 'ㄴ', level: 1, instructions: '머리말만' },
  ];
  assert.deepEqual(ancestorsOf(chapters, 2).map(c => c.id), ['R-001', 'R-002']);
  assert.deepEqual(ancestorsOf(chapters, 3), []);
  assert.deepEqual([hasChildren(chapters, 0), hasChildren(chapters, 1), hasChildren(chapters, 2), hasChildren(chapters, 3)], [true, true, false, false]);
  const book = { instructions: '## 문체 및 예시\n짧게', chapters };
  assert.equal(effectiveText(book, 'R-003'), '## 문체 및 예시\n[보고서 공통]\n짧게\n\n## 제약조건\n[상위 장 R-001 ㄱ]\n표 1개'); // R-002 는 적용을 꺼서 빠지고, R-001 의 헤딩 순서는 물려주지 않는다
  assert.equal(effectiveText(book, 'R-001'), '## 문체 및 예시\n[보고서 공통]\n짧게\n\n## 헤딩 순서\n[이 장 R-001 ㄱ]\n1. 개요\n\n## 제약조건\n[이 장 R-001 ㄱ]\n표 1개');
  assert.equal(effectiveText(book, 'R-001', { own: false }), '## 문체 및 예시\n[보고서 공통]\n짧게');
  assert.equal(effectiveText(book, 'R-004'), '[이 장 R-004 ㄴ]\n머리말만\n\n## 문체 및 예시\n[보고서 공통]\n짧게');
  assert.equal(effectiveText({ instructions: '', chapters }, 'R-003'), '## 제약조건\n[상위 장 R-001 ㄱ]\n표 1개');
  assert.equal(effectiveText(null, 'R-009'), '');
  assert.match(instructionsProblem('## 헤딩 순서\n가', { report: true }), /헤딩 순서 절을 둘 수 없습니다/);
  assert.equal(instructionsProblem('## 제약조건\n가', { report: true }), null);
  assert.deepEqual(REPORT_SECTIONS.map(s => s.key), ['style', 'constraints', 'rules', 'tips', 'requirements']);
});
