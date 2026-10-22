// 새 탭 Markdown 미리보기 (FR-WB-075 (c), FR-PL-011) — 열람 화면의 「Markdown ↗」가 md_view.html?src=<보관 Markdown 파일 주소>&title=<제목> 으로 연다.
// 이 서버의 /api/ 주소만 받는다. 글 그대로의 파일은 머리줄의 「파일 그대로 ↗」로 연다.
import { renderMarkdown } from './md_preview.js';
import { fill, h } from './util.js';

const params = new URLSearchParams(location.search);
const src = params.get('src') || '';
const title = params.get('title') || 'Markdown';
const usable = src.startsWith('/api/') && !src.startsWith('//');
const page = h('main.src-doc.md-preview', h('p.muted', usable ? 'Markdown 파일을 읽는 중…' : '열 Markdown 파일의 주소가 없습니다.'));
document.title = `${title} — Markdown 미리보기`;
fill(document.getElementById('md-view'),
  h('header.md-view-head',
    h('div.md-view-title', h('span.type-badge', 'Markdown 미리보기'), h('span', title)),
    usable && h('a.btn.small.ghost', { href: src, target: '_blank', rel: 'noopener noreferrer', title: '보관한 Markdown 파일을 글 그대로 엽니다' }, '파일 그대로 ↗')),
  page);

if (usable) {
  fetch(src)
    .then(res => (res.ok ? res.text() : res.json().catch(() => ({})).then(body => Promise.reject(new Error(body.error || res.statusText)))))
    .then(text => fill(page, renderMarkdown(text)))
    .catch(err => fill(page, h('p.muted', `Markdown 파일을 읽지 못했습니다 — ${err.message}`)));
}
