import assert from 'node:assert/strict';
import test from 'node:test';
import { markdownToDrafts } from '../lib/ingest.js';
import { buildSampleReport } from './fixtures/sample_report.js';
import { evalCalc, extractNumbers, headingText, splitSentences, verifySentence } from '../public/shared/text.js';

test('문장 분리: 소수점에서 끊지 않고 번호·약어는 다음 조각에 붙인다', () => {
  assert.deepEqual(splitSentences('고용률은 48.6%였다. 이는 2.7%p 높다.'), ['고용률은 48.6%였다.', '이는 2.7%p 높다.']);
  assert.deepEqual(splitSentences('1. 개요 p. 12 참고.'), ['1. 개요 p. 12 참고.']);
});

test('수치 추출: 단위를 붙이고 기간·연령 범위·표 번호는 대조에서 뺀다', () => {
  const nums = extractNumbers('청년(15~29세) 취업자는 2025년 126,910명, 예산 86.0억 원, 2.7%p, 표 2 기준 -3.5%');
  assert.deepEqual(nums.filter(n => !n.period).map(n => [n.value, n.unit]), [[126910, '명'], [86, '억원'], [2.7, '%p'], [-3.5, '%']]);
  assert.deepEqual(nums.filter(n => n.period).map(n => n.raw), ['2025', '2']);
  assert.deepEqual(extractNumbers('영업이익은 2025 기준 -12.5억 원이다.').filter(n => !n.period).map(n => n.value), [-12.5]);
});

test('계산식: 사칙연산·괄호·변수만 허용한다', () => {
  assert.equal(evalCalc('(a - b) × 2', { a: 5, b: 3 }), 4);
  assert.throws(() => evalCalc('a; process.exit()', { a: 1 }));
  assert.throws(() => evalCalc('a + c', { a: 1 }));
});

test('샘플 보고서: 규칙 검사가 수치 불일치와 근거 없음을 잡아낸다', () => {
  const { doc, evidence } = buildSampleReport();
  const status = Object.fromEntries(doc.blocks.flatMap(b => b.sentences).map(s => [s.id, verifySentence(s, evidence)]));
  assert.equal(status['T-0003'].status, 'reviewed');
  assert.equal(status['T-0004'].calc.display, '2.7');
  assert.equal(status['T-0005'].status, 'mismatch');
  assert.equal(status['T-0006'].calc.display, '8,670');
  assert.equal(status['T-0008'].calc.display, '45.6');
  assert.equal(status['T-0009'].status, 'missing');
  assert.equal(status['T-0011'].status, 'na');
});

test('단위가 다르면 값이 같아도 일치로 보지 않는다 (% 와 %p)', () => {
  const { doc, evidence } = buildSampleReport();
  const s = { ...doc.blocks[1].sentences[1], text: '2025년 청년 고용률은 48.6%p였다.' };
  const result = verifySentence(s, evidence);
  assert.equal(result.status, 'mismatch');
  assert.equal(result.numbers.find(n => n.raw === '48.6').problem, 'unit');
});

test('같은 대상·기간의 근거끼리 값이 다르면 출처 충돌로 표시한다', () => {
  const { doc, evidence } = buildSampleReport();
  const base = doc.blocks[1].sentences[1]; // 고용률 48.6% — 근거 하나
  const other = { ...evidence[base.evidence[0]], id: 'E-9999', sourceId: 'S-999', figure: { ...evidence[base.evidence[0]].figure, value: 48.1, display: '48.1' } };
  const result = verifySentence({ ...base, evidence: [...base.evidence, 'E-9999'] }, { ...evidence, 'E-9999': other });
  assert.equal(result.status, 'conflict');
});

test('문장을 고치면 원문 대조 확인이 풀린다', () => {
  const { doc, evidence } = buildSampleReport();
  const s = { ...doc.blocks[1].sentences[1], text: '2025년 한빛시 청년 고용률은 48.6%였다.' };
  assert.equal(verifySentence(s, evidence).status, 'stale');
});

test('Markdown 수집: 표 제목·단위와 목록을 인식한다', () => {
  const drafts = markdownToDrafts('# 제목\n\n첫 문단.\n\n표 1. 지표 (단위: %)\n| 구분 | 2024 | 2025 |\n|---|---|---|\n| A | 1.5 | 12.25 |\n\n- 하나\n- 둘');
  assert.deepEqual(drafts.map(d => d.kind), ['heading', 'paragraph', 'table', 'list']);
  assert.deepEqual([drafts[2].table.title, drafts[2].table.unit], ['표 1. 지표', '%']);
  assert.deepEqual(drafts[3].items, ['하나', '둘']);
});

test('제목 줄 판별: # 표시·번호로 시작하고 종결 부호 없이 짧게 끝나는 글만 제목이다 (FR-WB-026)', () => {
  assert.equal(headingText('## 개요'), '개요');
  assert.equal(headingText('1. 추진 배경'), '1. 추진 배경');
  assert.equal(headingText('1.1 국내 동향'), '1.1 국내 동향');
  assert.equal(headingText('제1장 총칙'), '제1장 총칙');
  assert.equal(headingText('가. 대상 선박'), '가. 대상 선박');
  assert.equal(headingText('1. 추진 배경 국제해사기구는 원격운항 상선의 기준을 정했다.'), null); // 문장으로 끝난다
  assert.equal(headingText('2025년 시험운항 승인은 12건이었다'), null); // 서술형 어미
  assert.equal(headingText('추진 배경'), null); // 번호 없는 줄은 bare 일 때만
  assert.equal(headingText('추진 배경', { bare: true }), '추진 배경');
  assert.equal(headingText('- 원격 제어', { bare: true }), null); // 목록 항목은 제목이 아니다
  assert.equal(headingText('3 명이 참여했다', { bare: true }), null);
});
