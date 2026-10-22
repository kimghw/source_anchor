// Markdown 미리보기 — markdown-it 으로 그린 글: 머리말·구조 목록·쪽 표시·표 ID·문장 ID 표지·줄바꿈·표·숫자 칸, HTML·그림·javascript: 링크는 막는다,
// 장의 원문 Markdown(역슬래시 줄)도 같은 규칙, 새 탭 미리보기 주소 (FR-WB-075 (c), DR-WB-006)
import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceMarkdown } from '../lib/source_md.js';
import { markdownHtml, previewUrl } from '../public/js/md_preview.js';

const GUIDE = `---
id: "G-001"
version: "V-002"
url: ""
---

<!-- outline -->
- [G-001.p2.b1] Section 1 General · p.2
  - [G-001.p2.b2] 1.1.1 The requirements apply to ships. · p.2
<!-- /outline -->

<!-- p.2 -->

# [G-001.p2.b1.s1] Section 1 General

[G-001.p2.b2.s1] 1.1.1 The requirements apply to ships.
[G-001.p2.b2.s2] In particular, they apply to cables.
<!-- some note -->
- [G-001.p2.b3.s1] primary essential services

<!-- table G-001.p2.b4 -->
Table 1 : Documents

| No. | Documents | Rating |
| --- | --- | --- |
| 1 | General ｜ arrangement | 12.5 |

<script>alert(1)</script>

![x](https://example.org/a.png) [site](https://example.org) [bad](javascript:alert(1))
<!-- end -->`;

test('미리보기: 머리말은 따로, 구조 목록은 접힌 중첩 목록, 쪽 표시·표 ID·문장 ID 는 표지로, 문단 줄바꿈은 그대로, 숫자 칸은 오른쪽', () => {
  const { front, outline, html } = markdownHtml(GUIDE);
  assert.deepEqual(front, [['id', 'G-001'], ['version', 'V-002']]); // 빈 값은 뺀다
  assert.equal(outline, 2);
  assert.match(html, /^<details class="md-outline"><summary>구조 · 마디 2<\/summary><ul>\n<li><code class="md-id" title="문장 ID">G-001\.p2\.b1<\/code> Section 1 General · p\.2\n<ul>/);
  assert.ok(html.includes('<div class="md-page">p.2</div>'));
  assert.ok(html.includes('<h1><code class="md-id" title="문장 ID">G-001.p2.b1.s1</code> Section 1 General</h1>'));
  assert.ok(html.includes('<code class="md-id" title="문장 ID">G-001.p2.b2.s1</code> 1.1.1 The requirements apply to ships.<br>\n<code class="md-id" title="문장 ID">G-001.p2.b2.s2</code>'));
  assert.ok(!html.includes('some note') && !html.includes('&lt;!--'), '그 밖의 주석은 버린다');
  assert.ok(html.includes('<li><code class="md-id" title="문장 ID">G-001.p2.b3.s1</code> primary essential services</li>'));
  assert.ok(html.includes('<div class="md-table-id"><code class="md-id"') && html.includes('>G-001.p2.b4</code></div>'));
  assert.ok(html.includes('<td class="md-num">12.5</td>') && html.includes('<td>General ｜ arrangement</td>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !html.includes('<script>'), 'HTML 은 글자로');
  assert.ok(!html.includes('<img'), '그림(외부 자원)은 불러오지 않는다');
  assert.ok(html.includes('<a href="https://example.org" target="_blank" rel="noopener noreferrer">site</a>'));
  assert.ok(!html.includes('href="javascript:'));
});

test('미리보기: 장의 원문 Markdown(ID 없음)의 역슬래시 줄은 번호 그대로 문단, 새 탭 미리보기 주소', () => {
  const source = { id: 'S-001', version: 'V-001', type: 'pdf', title: '승인 현황', collectedAt: 't', hash: 'h', blocks: [
    { id: 'S-001.b1', kind: 'heading', level: 2, loc: { page: 1 }, sentences: [{ id: 'S-001.b1.s1', text: '시험운항 승인 현황' }] },
    { id: 'S-001.b2', kind: 'paragraph', loc: { page: 1 }, sentences: [{ id: 'S-001.b2.s1', text: '1. 승인은 3건이다.' }, { id: 'S-001.b2.s2', text: '반려는 없다.' }] },
    { id: 'S-001.b3', kind: 'paragraph', loc: { page: 2 }, sentences: [{ id: 'S-001.b3.s1', text: '2025년 기준이다.' }] },
  ] };
  const { html, outline } = markdownHtml(sourceMarkdown(source));
  assert.equal(outline, 0);
  assert.ok(html.includes('<h2>시험운항 승인 현황</h2>'));
  assert.ok(html.includes('<p>1. 승인은 3건이다. 반려는 없다.</p>'), html);
  assert.ok(html.includes('<p>2025년 기준이다.</p>'));
  assert.ok(!html.includes('<ol'));
  assert.equal(previewUrl('/api/books/M-005/guides/G-003/markdown', 'BV 규칙'), 'md_view.html?src=%2Fapi%2Fbooks%2FM-005%2Fguides%2FG-003%2Fmarkdown&title=BV%20%EA%B7%9C%EC%B9%99');
});
