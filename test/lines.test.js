// 편집기에 여러 줄·제목 형태의 글을 넣으면 줄마다 제목·문단 블록으로 나뉜다 (FR-WB-026)
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyServerState, linesToSegments, state, undo, updateSentenceText } from '../public/js/state.js';

const open = (blocks = []) => applyServerState({ sources: [], doc: { id: 'R-001', title: '시험', blocks }, evidence: {}, docs: [] });
const layout = () => state.doc.blocks.map(b => `${b.kind === 'heading' ? 'H' : 'P'}[${b.sentences.map(s => s.text).join(' | ')}]`).join(' ');
const para = (id, ...texts) => ({ id, kind: 'paragraph', sentences: texts.map((text, i) => ({ id: `T-${id}${i}`, text, type: 'fact', evidence: [] })) });

test('줄 나누기: 번호 제목·# 제목·빈 줄·본문 줄 앞의 짧은 줄을 제목과 문단으로 나눈다', () => {
  const segments = linesToSegments('1. 추진 배경\n국제해사기구는 기준을 정했다. 국내도 따른다.\n\n한국도 지침을 냈다.\n## 연구 목표\n원격 제어\n완전 자율\n선원 미승선\n추진 배경\n본문이 이어지는 문장이다.');
  assert.deepEqual(segments, [
    { kind: 'heading', text: '1. 추진 배경' },
    { kind: 'paragraph', sentences: ['국제해사기구는 기준을 정했다.', '국내도 따른다.'] },
    { kind: 'paragraph', sentences: ['한국도 지침을 냈다.'] },
    { kind: 'heading', text: '연구 목표' },
    { kind: 'paragraph', sentences: ['원격 제어', '완전 자율', '선원 미승선'] }, // 짧은 줄이 연달아 있으면 문장들이다
    { kind: 'heading', text: '추진 배경' }, // 본문 줄 바로 앞의 짧은 줄은 제목
    { kind: 'paragraph', sentences: ['본문이 이어지는 문장이다.'] },
  ]);
  assert.deepEqual(linesToSegments('  \n\n'), []);
});

test('문장 고치기: 여러 줄을 넣으면 원래 문단의 앞·뒤 문장을 지킨 채 제목·문단 블록이 끼어들고, 실행 취소 한 번으로 돌아간다', () => {
  open([para('P-01', '첫 문장.', '둘째 문장.', '셋째 문장.')]);
  updateSentenceText('T-P-011', '둘째 문장을 고쳤다.\n1. 새 절\n새 절의 문장이다.');
  assert.equal(layout(), 'P[첫 문장. | 둘째 문장을 고쳤다.] H[1. 새 절] P[새 절의 문장이다. | 셋째 문장.]');
  assert.equal(state.doc.blocks[0].sentences[1].id, 'T-P-011'); // 첫 조각이 원래 문장의 ID 를 이어받는다
  assert.deepEqual(state.sel.doc, [state.doc.blocks[2].sentences[0].id]);
  undo();
  assert.equal(layout(), 'P[첫 문장. | 둘째 문장. | 셋째 문장.]');
});

test('문장 고치기: 문단의 문장을 제목 형태로 고치면 그 자리에서 제목 블록으로 나뉘고, 마지막 조각이 제목이면 뒤 문장은 새 문단이 된다', () => {
  open([para('P-01', '첫 문장.', '1. 추진 배경 국제해사기구는 기준을 정했다.', '셋째 문장.')]);
  updateSentenceText('T-P-011', '1. 추진 배경\n국제해사기구는 기준을 정했다.');
  assert.equal(layout(), 'P[첫 문장.] H[1. 추진 배경] P[국제해사기구는 기준을 정했다. | 셋째 문장.]');
  assert.equal(state.doc.blocks[1].sentences[0].id, 'T-P-011');
  open([para('P-01', '첫 문장.', '둘째 문장.', '셋째 문장.')]);
  updateSentenceText('T-P-011', '## 요약');
  assert.equal(layout(), 'P[첫 문장.] H[요약] P[셋째 문장.]');
  // 제목 블록에서 여러 줄을 넣으면 첫 줄은 제목으로 남고 나머지는 아래 블록이 된다
  updateSentenceText('T-P-011', '요약 정리\n요약의 첫 문장이다.\n\n요약의 둘째 문단이다.');
  assert.equal(layout(), 'P[첫 문장.] H[요약 정리] P[요약의 첫 문장이다.] P[요약의 둘째 문단이다.] P[셋째 문장.]'); // 뒤의 문단은 이미 따로 있다
  // 한 줄짜리 보통 문장은 예전처럼 같은 문단에서 문장만 나뉜다
  open([para('P-01', '첫 문장.')]);
  updateSentenceText('T-P-010', '고친 문장. 덧붙인 문장.');
  assert.equal(layout(), 'P[고친 문장. | 덧붙인 문장.]');
  open();
});

test('제목 줄 나누기: 문단에 섞인 "1. 추진 배경" 같은 문장들을 제목 블록으로 나누고, 순서·근거는 그대로이며 실행 취소 한 번으로 돌아간다', async () => {
  const { headingSentencesIn, splitHeadingSentences } = await import('../public/js/state.js');
  const block = para('P-01', '본 계획서는 추진계획을 제시한다.', '1. 추진 배경', '국제해사기구는 기준을 정했다.', '국내도 따른다.', '2. 연구 목표', '## 세부 목표', '지연시간을 측정한다.');
  block.sentences[2].evidence = ['E-001'];
  open([block]);
  assert.deepEqual(headingSentencesIn(state.doc.blocks[0]).map(s => s.text), ['1. 추진 배경', '2. 연구 목표', '## 세부 목표']);
  assert.equal(splitHeadingSentences('P-01'), 3);
  assert.equal(layout(), 'P[본 계획서는 추진계획을 제시한다.] H[1. 추진 배경] P[국제해사기구는 기준을 정했다. | 국내도 따른다.] H[2. 연구 목표] H[세부 목표] P[지연시간을 측정한다.]');
  assert.equal(state.doc.blocks[0].id, 'P-01'); // 첫 문단은 원래 블록을 지킨다
  assert.deepEqual(state.doc.blocks[2].sentences[0].evidence, ['E-001']); // 근거 연결은 그대로
  assert.equal(headingSentencesIn(state.doc.blocks[2]).length, 0);
  undo();
  assert.equal(layout(), 'P[본 계획서는 추진계획을 제시한다. | 1. 추진 배경 | 국제해사기구는 기준을 정했다. | 국내도 따른다. | 2. 연구 목표 | ## 세부 목표 | 지연시간을 측정한다.]');
  assert.equal(splitHeadingSentences('P-99'), 0);
  open();
});
