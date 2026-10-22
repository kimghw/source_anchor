// 열 비율 제안 — 열린 열 구성마다 4가지, 몫의 합 100, 직접 적은 비율은 열린 열 수만큼 (FR-WB-084)
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRatio, ratioPresets } from '../public/js/columns.js';

const view = presets => presets.map(p => `${p.label} ${p.ratio.join('/')}`);

test('모든 열이 열려 있으면 0~3열 비율 4가지를 제안한다', () => {
  assert.deepEqual(view(ratioPresets('탐색기', '편집기', ['에이전트', '원문'])),
    ['균등 25/25/25/25', '편집기 넓게 15/55/15/15', '에이전트 넓게 15/40/30/15', '원문 넓게 15/40/15/30']);
});

test('접힌 열은 빼고 열린 열만으로 제안한다', () => {
  // 3열이 접혔다
  assert.deepEqual(view(ratioPresets('탐색기', '편집기', ['에이전트'])),
    ['균등 33/34/33', '편집기 넓게 15/65/20', '편집기·에이전트 반반 15/43/42', '에이전트 넓게 15/30/55']);
  // 0열이 접혔다
  assert.deepEqual(view(ratioPresets(undefined, '목차·지시문', ['에이전트', '작성 기준·원문'])),
    ['균등 34/33/33', '목차·지시문 넓게 70/15/15', '에이전트 넓게 55/30/15', '작성 기준·원문 넓게 55/15/30']);
  // 0열·3열이 접혔다
  assert.deepEqual(view(ratioPresets(undefined, '편집기', ['에이전트'])),
    ['균등 50/50', '편집기 넓게 75/25', '편집기 조금 넓게 60/40', '에이전트 넓게 35/65']);
  // 2열·3열이 접혔다 — 0열 너비만 고른다
  assert.deepEqual(view(ratioPresets('탐색기', '편집기', [])),
    ['탐색기 좁게 10/90', '탐색기 보통 15/85', '탐색기 넓게 20/80', '탐색기 아주 넓게 25/75']);
});

test('1열이 접히면 그 오른쪽의 첫 열린 열이 주 열로 이름이 붙는다', () => {
  assert.deepEqual(view(ratioPresets('탐색기', '에이전트', ['원문']))[1], '에이전트 넓게 15/65/20');
});

test('열린 열이 하나뿐이면 제안이 없다', () => {
  assert.deepEqual(ratioPresets('탐색기', undefined, []), []);
  assert.deepEqual(ratioPresets(undefined, '편집기', []), []);
});

test('제안마다 몫의 수가 열린 열 수와 같고 합이 100 이다', () => {
  const shapes = [['탐색기', '편', ['a', 'b']], [undefined, '편', ['a', 'b']], ['탐색기', '편', ['a']], [undefined, '편', ['a']], ['탐색기', '편', []]];
  for (const [explorer, main, sides] of shapes) {
    const count = (explorer ? 1 : 0) + 1 + sides.length;
    const presets = ratioPresets(explorer, main, sides);
    assert.equal(presets.length, 4);
    for (const p of presets) {
      assert.equal(p.ratio.length, count, p.label);
      assert.equal(p.ratio.reduce((a, b) => a + b, 0), 100, p.label);
    }
  }
});

test('직접 적은 비율은 열린 열 수만큼의 양수여야 하고 합 100 으로 환산한다', () => {
  assert.deepEqual(parseRatio('15/50/15/20'), [15, 50, 15, 20]);
  assert.deepEqual(parseRatio('1 2 1', 3), [25, 50, 25]);
  assert.equal(parseRatio('15/50/15/20', 3), null);
  assert.equal(parseRatio('15/50', 4), null);
  assert.equal(parseRatio('15/0/85', 3), null);
  assert.equal(parseRatio('a/b', 2), null);
});
