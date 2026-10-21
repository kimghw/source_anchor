// 깊이를 세는 구간 스캐너 — 중첩 표 제외·자기 닫힘·접두사 무관·tcPr 걸러내기와 XML 이스케이프
import assert from 'node:assert/strict';
import test from 'node:test';
import { elementSpans, escapeXml, innerSpan, outside, unescapeXml } from '../lib/xml_spans.js';

test('elementSpans: 최상위만, 중첩 표 제외, 자기 닫힘, 접두사 무관', () => {
  const xml = '<hs:sec><hp:p><hp:run><hp:tbl><hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:tbl><hp:tr><hp:tc/></hp:tr></hp:tbl></hp:run></hp:p></hp:subList></hp:tc></hp:tr></hp:tbl></hp:run></hp:p><ns0:p/></hs:sec>';
  const tbls = elementSpans(xml, 'tbl');
  assert.equal(tbls.length, 1); // 바깥 표 하나 — 안쪽 표는 삼킨다
  const tcs = elementSpans(xml, 'tc', innerSpan(xml, tbls[0]));
  assert.equal(tcs.length, 1); // 바깥 칸 하나 — 안쪽 표의 tc 는 제외
  const ps = elementSpans(xml, 'p', innerSpan(xml, tcs[0]));
  assert.equal(ps.length, 1); // 칸 안 최상위 문단 하나(그 안의 중첩 표 문단은 제외)
  const top = elementSpans(xml, 'p');
  assert.deepEqual(top.map(s => [s.selfClosed, s.prefix]), [[false, 'hp'], [true, 'ns0']]);
  assert.equal(innerSpan(xml, top[1]), null);
});

test('tcPr 는 tc 로 잡지 않고, 깊이는 같은 이름과 tbl 중첩만 센다', () => {
  const xml = '<w:tc><w:tcPr><w:tcW w:w="1"/></w:tcPr><w:p/></w:tc>';
  assert.equal(elementSpans(xml, 'tc').length, 1);
  assert.equal(elementSpans(xml, 'p').length, 1); // p 는 tc 와 다른 이름이라 tc 안에 있어도 깊이 0 — 칸 안 문단만 원하면 범위를 innerSpan(tc) 로 준다
});

test('elementSpans: {start,end} 범위·자기 닫힘 표·표 바깥 문단만', () => {
  const xml = '<w:p/><w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl><w:tbl/><w:p><w:r/></w:p>';
  assert.equal(elementSpans(xml, 'tbl').length, 2); // 자기 닫힘 표도 센다
  assert.equal(elementSpans(xml, 'p').length, 2); // 표 안 문단은 제외
  const first = elementSpans(xml, 'tbl')[0];
  assert.equal(elementSpans(xml, 'p', { start: first.start, end: first.end }).length, 0); // 범위 안에서 연 tbl 안
  const inner = innerSpan(xml, first);
  assert.equal(elementSpans(xml, 'tr', inner).length, 1);
  assert.equal(elementSpans(xml, 'p', { lo: 0, hi: 6 }).length, 1);
});

test('outside: 어느 구간에도 없으면 true', () => {
  const spans = [{ start: 5, end: 10 }];
  assert.equal(outside(4, spans), true);
  assert.equal(outside(5, spans), false);
  assert.equal(outside(10, spans), true);
});

test('escape/unescape', () => {
  assert.equal(escapeXml('a & <b> "c"'), 'a &amp; &lt;b&gt; "c"');
  assert.equal(unescapeXml('&lt;&amp;&#65;&#x41;&quot;&apos;'), '<&AA"\'');
});

test('innerSpan: 닫는 태그 바로 뒤에 상위 닫는 태그가 와도 자기 닫는 태그 앞까지', () => {
  const xml = '<hs:sec><hp:p><hp:run><hp:tbl><hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:tbl><hp:tr><hp:tc/></hp:tr></hp:tbl></hp:run></hp:p></hp:subList></hp:tc></hp:tr></hp:tbl></hp:run></hp:p><ns0:p/></hs:sec>';
  const [tbl] = elementSpans(xml, 'tbl');
  const tblIn = innerSpan(xml, tbl);
  assert.equal(xml.slice(tblIn.start, tblIn.end), '<hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:tbl><hp:tr><hp:tc/></hp:tr></hp:tbl></hp:run></hp:p></hp:subList></hp:tc></hp:tr>');
  const [tc] = elementSpans(xml, 'tc', tblIn);
  const tcIn = innerSpan(xml, tc);
  assert.equal(xml.slice(tcIn.start, tcIn.end), '<hp:subList><hp:p><hp:run><hp:tbl><hp:tr><hp:tc/></hp:tr></hp:tbl></hp:run></hp:p></hp:subList>');
  const small = '<a:x><w:p><w:r/></w:p></a:x>';
  const [p] = elementSpans(small, 'p');
  const pIn = innerSpan(small, p);
  assert.equal(small.slice(pIn.start, pIn.end), '<w:r/>');
});
