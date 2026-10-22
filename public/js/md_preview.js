// Markdown 미리보기 (FR-WB-075 (c), FR-WB-085) — 보관한 Markdown 파일(원문·기준 문서)을 markdown-it(public/vendor/markdown-it, MIT)으로 정리해 그린다.
// 3열 열람 화면의 「Markdown」 보기와 새 탭 미리보기(md_view.html)가 함께 쓴다.
// 안전: html: false — 파일 안의 HTML·스크립트는 글자로만 보인다. 그림(외부 자원)은 끄고, 링크는 markdown-it 이 거르는 주소만 새 탭으로 연다.
// 이 시스템의 표시는 작은 플러그인으로 읽는다:
//   머리말(--- … ---) → 접힌 「파일 머리말」 · 구조 목록 <!-- outline --> … <!-- /outline --> → 접힌 「구조 · 마디 N」(중첩 목록 — DR-WB-006)
//   <!-- p.N --> · <!-- 슬라이드 N --> → 쪽 구분선 · <!-- table ID --> → 표 ID 표지 · 그 밖의 <!-- … --> → 버린다
//   문장 앞의 [ID](G-001.p2.b3.s1 · S-001.b7.s2) → 문장 ID 표지 · 줄바꿈은 그대로(기준 문서는 한 줄이 한 문장) · 숫자뿐인 표 칸은 오른쪽 정렬
import '../vendor/markdown-it/markdown-it.min.js';
import { h } from './util.js';

const NUMBER_CELL = /^[-+−]?[\d,]*\.?\d+\s*%?$/;
const ID = /^\[([A-Z]-\d{3,}(?:\.[a-z]\d+(?:c\d+)?)+)\]/;
const COMMENT = /^<!--\s*([\s\S]*?)\s*-->$/;

const md = globalThis.markdownit({ html: false, breaks: true, linkify: false, typographer: false }).disable('image');
const escape = md.utils.escapeHtml;

// 한 줄짜리 <!-- … --> — 문단 사이에 붙어 있어도 문단을 끊는다
md.block.ruler.before('paragraph', 'sa_comment', (state, startLine, endLine, silent) => {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const m = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]).trim().match(COMMENT);
  if (!m) return false;
  if (silent) return true;
  const token = state.push('sa_mark', '', 0);
  token.meta = /^(p\.\d+|슬라이드 \d+)$/.test(m[1]) ? { page: m[1] } : /^table\s+\S+$/.test(m[1]) ? { table: m[1].split(/\s+/)[1] } : {};
  token.map = [startLine, startLine + 1];
  state.line = startLine + 1;
  return true;
}, { alt: ['paragraph'] });
md.renderer.rules.sa_mark = (tokens, idx) => {
  const { page, table } = tokens[idx].meta;
  if (page) return `<div class="md-page">${escape(page)}</div>\n`;
  if (table) return `<div class="md-table-id"><code class="md-id" title="표 블록 ID — 칸 ID 는 r&lt;행&gt;c&lt;열&gt;">${escape(table)}</code></div>\n`;
  return '';
};

// 문장 ID 표지
md.inline.ruler.before('link', 'sa_id', (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 0x5b) return false;
  const m = state.src.slice(state.pos).match(ID);
  if (!m) return false;
  if (!silent) state.push('sa_id', 'code', 0).content = m[1];
  state.pos += m[0].length;
  return true;
});
md.renderer.rules.sa_id = (tokens, idx) => `<code class="md-id" title="문장 ID">${escape(tokens[idx].content)}</code>`;

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener noreferrer');
  return self.renderToken(tokens, idx, options);
};
md.renderer.rules.td_open = (tokens, idx, options, env, self) => {
  if (NUMBER_CELL.test(tokens[idx + 1]?.content?.trim() ?? '')) tokens[idx].attrJoin('class', 'md-num');
  return self.renderToken(tokens, idx, options);
};

// 줄 앞 역슬래시(lib/ingest.js literalLines — 번호로 시작하는 본문을 목록으로 읽지 않게 붙인 것): 「\1. 」은 「1\. 」로(CommonMark 이스케이프), 그 밖의 숫자 앞 \ 는 뗀다
const unliteral = text => text.replace(/^(\s*)\\(\d+)([.)])(?=\s)/gm, '$1$2\\$3').replace(/^(\s*)\\(?=\d)/gm, '$1');
const fieldValue = raw => { try { return raw.startsWith('"') ? JSON.parse(raw) : raw; } catch { return raw; } };

// 새 탭 미리보기(md_view.html)의 주소 — src 는 보관한 Markdown 파일의 /api/ 주소
export const previewUrl = (src, title = '') => `md_view.html?src=${encodeURIComponent(src)}${title ? `&title=${encodeURIComponent(title)}` : ''}`;

// 파일 글 → { front: [[키, 값]], outline: 마디 수 | 0, html } — DOM 없이 만든다(시험)
export function markdownHtml(text) {
  let rest = String(text ?? '').replace(/\r\n?/g, '\n');
  let front = [];
  const head = rest.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (head) {
    front = head[1].split('\n').map(l => l.match(/^([\w-]+):\s?(.*)$/)).filter(Boolean).map(([, k, v]) => [k, fieldValue(v.trim())]).filter(([, v]) => v !== '');
    rest = rest.slice(head[0].length);
  }
  let outline = '';
  let nodes = 0;
  rest = rest.replace(/^<!-- outline -->\n([\s\S]*?)\n<!-- \/outline -->\n?/m, (_, list) => {
    nodes = list.split('\n').filter(l => /^\s*- /.test(l)).length;
    outline = `<details class="md-outline"><summary>구조 · 마디 ${nodes}</summary>${md.render(list)}</details>\n`;
    return '';
  });
  return { front, outline: nodes, html: outline + md.render(unliteral(rest)) };
}

export function renderMarkdown(text) {
  const { front, html } = markdownHtml(text);
  const body = h('div.md-body');
  body.innerHTML = html; // markdown-it(html: false)가 만든 글 — 파일의 HTML 은 이미 글자로 바뀌어 있다
  return h('div.md-render',
    front.length > 0 && h('details.md-front', h('summary', '파일 머리말'), h('dl', front.map(([k, v]) => h('div', h('dt', k), h('dd', v))))),
    body,
    !body.textContent.trim() && h('p.muted', 'Markdown 파일에 본문이 없습니다.'));
}
