// 서식 본문 문단 분류 — 헤딩·필드·빈 문단과 수준, 헤딩의 출처(by)와 자르지 않은 깊이(depth)
import assert from 'node:assert/strict';
import test from 'node:test';
import { classify } from '../lib/form_outline.js';

test('classify: 헤딩·필드·빈 문단과 수준 — 헤딩에는 출처(by)가 붙고 필드에는 없다', () => {
  assert.deepEqual(classify('1. 제안 개요'), { kind: 'heading', level: 1, by: 'text' });
  assert.deepEqual(classify('1.2 세부 목표'), { kind: 'heading', level: 2, by: 'text' });
  assert.deepEqual(classify('□ 제안 배경 및 필요성'), { kind: 'heading', level: 1, by: 'text' });
  assert.deepEqual(classify('■ 기술 개요'), { kind: 'heading', level: 2, by: 'text' });
  assert.deepEqual(classify('아무 글', { style: 'Heading2' }), { kind: 'heading', level: 2, by: 'style' });
  assert.deepEqual(classify('아무 글', { outlineLvl: 0 }), { kind: 'heading', level: 1, by: 'outline' });
  assert.deepEqual(classify('□ 본 과제는 전력 변환 시스템의 효율을 높이는 것을 목표로 한다.'), { kind: 'field', level: 1 }); // 종결 부호 → 문장
  assert.deepEqual(classify('○ (배경) 현재 전력 변환 손실이 큼'), { kind: 'field', level: 1 });
  assert.deepEqual(classify('- 세부 근거는 다음과 같음'), { kind: 'field', level: 2 });
  assert.deepEqual(classify('· 셋째 수준'), { kind: 'field', level: 3 });
  assert.deepEqual(classify('본문 문장입니다.', { ilvl: 1 }), { kind: 'field', level: 2 });
  assert.deepEqual(classify('   '), { kind: 'blank', level: 0 });
});

test('classify: 요 로 끝나는 명사는 헤딩, 서술 어미는 문장', () => {
  assert.deepEqual(classify('1. 해주세요'), { kind: 'field', level: 1 });
  assert.deepEqual(classify('2. 사업 개요 및 필요'), { kind: 'heading', level: 1, by: 'text' });
});

test('classify: 제목 스타일·번호 깊이·수준 상한 — 3 을 넘는 깊이는 depth 로 남는다', () => {
  assert.deepEqual(classify('글', { style: '제목 3' }), { kind: 'heading', level: 3, by: 'style' });
  assert.deepEqual(classify('글', { style: 'Title' }), { kind: 'heading', level: 1, by: 'style' });
  assert.deepEqual(classify('1.2.3 아주 세부'), { kind: 'heading', level: 3, by: 'text' });
  assert.deepEqual(classify('가. 항목'), { kind: 'heading', level: 2, by: 'text' });
  assert.deepEqual(classify('글', { style: 'Heading9' }), { kind: 'heading', level: 3, by: 'style', depth: 9 });
  assert.deepEqual(classify('본문 문장입니다.', { ilvl: 5 }), { kind: 'field', level: 3 });
});

test('classify: 한글 「개요 n」 스타일은 제목 스타일이고 outlineLvl·글 번호의 깊이도 depth 로 — 힌트가 글보다 앞선다', () => {
  assert.deepEqual(classify('1-1. 연구 목표', { style: '개요 2' }), { kind: 'heading', level: 2, by: 'style' });
  assert.deepEqual(classify('① 세부 항목', { style: '개요 4' }), { kind: 'heading', level: 3, by: 'style', depth: 4 });
  assert.deepEqual(classify('① 세부 항목', { style: '개요4' }), { kind: 'heading', level: 3, by: 'style', depth: 4 });
  assert.deepEqual(classify('(1) 추진 방법', { outlineLvl: 2 }), { kind: 'heading', level: 3, by: 'outline' });
  assert.deepEqual(classify('① 세부', { outlineLvl: 3 }), { kind: 'heading', level: 3, by: 'outline', depth: 4 });
  assert.deepEqual(classify('1.1.1.1 아주 깊은 제목'), { kind: 'heading', level: 3, by: 'text', depth: 4 });
  assert.deepEqual(classify('본 과제의 목표는 다음과 같다.', { style: '개요 1' }), { kind: 'heading', level: 1, by: 'style' }); // 스타일이 글 규칙보다 앞선다
  assert.deepEqual(classify('1. 개요', { style: '개요 1', outlineLvl: 0 }), { kind: 'heading', level: 1, by: 'outline' }); // 개요 수준이 스타일 이름보다 앞선다 — 한글의 「개요 n」 문단은 둘 다 있다
  assert.deepEqual(classify('글', { style: 'Heading1', outlineLvl: 2 }), { kind: 'heading', level: 3, by: 'outline' });
  assert.deepEqual(classify('글', { style: '바탕글' }), { kind: 'field', level: 1 });
  assert.deepEqual(classify('글', { style: '개요' }), { kind: 'field', level: 1 }); // 숫자 없는 「개요」 는 제목 스타일이 아니다
});

test('classify: outlineLvl 9 는 본문', () => {
  assert.deepEqual(classify('본문', { outlineLvl: 9 }), { kind: 'field', level: 1 });
});

test('classify: 글머리 기호 → 필드 수준 — ㅇ·○·●·•·◦·「o 」 1, -·–·— 2, ·⋅ㆍ∙ 3, 그 밖은 1', () => {
  for (const line of ['ㅇ 항목', '○ 항목', '● 항목', '• 항목', '◦ 항목', 'o 항목']) assert.deepEqual(classify(line), { kind: 'field', level: 1 }, line);
  for (const line of ['- 항목', '– 항목', '— 항목']) assert.deepEqual(classify(line), { kind: 'field', level: 2 }, line);
  for (const line of ['· 항목', '⋅ 항목', 'ㆍ 항목', '∙ 항목']) assert.deepEqual(classify(line), { kind: 'field', level: 3 }, line);
  assert.deepEqual(classify('open 항목'), { kind: 'field', level: 1 }); // 「o 」 는 뒤에 공백이 있어야 글머리표다
  assert.deepEqual(classify('  ·  앞 공백이 있어도 셋째  '), { kind: 'field', level: 3 });
  assert.deepEqual(classify('- 목록', { ilvl: 0 }), { kind: 'field', level: 1 }); // ilvl 힌트가 기호보다 앞선다
});
