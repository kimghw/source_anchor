// 서식 본문 문단 분류 — 헤딩·필드·빈 문단과 수준
import assert from 'node:assert/strict';
import test from 'node:test';
import { classify } from '../lib/form_outline.js';

test('classify: 헤딩·필드·빈 문단과 수준', () => {
  assert.deepEqual(classify('1. 제안 개요'), { kind: 'heading', level: 1 });
  assert.deepEqual(classify('1.2 세부 목표'), { kind: 'heading', level: 2 });
  assert.deepEqual(classify('□ 제안 배경 및 필요성'), { kind: 'heading', level: 1 });
  assert.deepEqual(classify('■ 기술 개요'), { kind: 'heading', level: 2 });
  assert.deepEqual(classify('아무 글', { style: 'Heading2' }), { kind: 'heading', level: 2 });
  assert.deepEqual(classify('아무 글', { outlineLvl: 0 }), { kind: 'heading', level: 1 });
  assert.deepEqual(classify('□ 본 과제는 전력 변환 시스템의 효율을 높이는 것을 목표로 한다.'), { kind: 'field', level: 1 }); // 종결 부호 → 문장
  assert.deepEqual(classify('○ (배경) 현재 전력 변환 손실이 큼'), { kind: 'field', level: 1 });
  assert.deepEqual(classify('- 세부 근거는 다음과 같음'), { kind: 'field', level: 2 });
  assert.deepEqual(classify('· 셋째 수준'), { kind: 'field', level: 3 });
  assert.deepEqual(classify('본문 문장입니다.', { ilvl: 1 }), { kind: 'field', level: 2 });
  assert.deepEqual(classify('   '), { kind: 'blank', level: 0 });
});

test('classify: 요 로 끝나는 명사는 헤딩, 서술 어미는 문장', () => {
  assert.deepEqual(classify('1. 해주세요'), { kind: 'field', level: 1 });
  assert.deepEqual(classify('2. 사업 개요 및 필요'), { kind: 'heading', level: 1 });
});

test('classify: 제목 스타일·번호 깊이·수준 상한', () => {
  assert.deepEqual(classify('글', { style: '제목 3' }), { kind: 'heading', level: 3 });
  assert.deepEqual(classify('글', { style: 'Title' }), { kind: 'heading', level: 1 });
  assert.deepEqual(classify('1.2.3 아주 세부'), { kind: 'heading', level: 3 });
  assert.deepEqual(classify('가. 항목'), { kind: 'heading', level: 2 });
  assert.deepEqual(classify('글', { style: 'Heading9' }), { kind: 'heading', level: 3 });
  assert.deepEqual(classify('본문 문장입니다.', { ilvl: 5 }), { kind: 'field', level: 3 });
});

test('classify: outlineLvl 9 는 본문', () => {
  assert.deepEqual(classify('본문', { outlineLvl: 9 }), { kind: 'field', level: 1 });
});
