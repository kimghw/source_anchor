// 웹 스냅샷(HTML) 위 형광·메모 (FR-PL-012) — 보관한 HTML 문자열에서 인용·메모가 붙은 문장(표 셀은 값)을 찾아 <mark> 로 감싸고,
// 참조·메모 목록을 여닫이(<details>)로 문서 머리에 끼운다. 스크립트는 넣지 않고 인라인 <style> 만 쓴다 — 서버가 보내는
// CSP(sandbox; default-src 'none'; style-src 'unsafe-inline')와 맞는다 (NFR-PL-001). 태그를 가로지르지 않도록 글 조각(text run)마다 따로 감싼다.
import { clean, decodeEntities } from './html.js';

// 안쪽을 글로 보지 않는 요소 — 스크립트·스타일·머리말 등. 열린 태그부터 닫는 태그까지 통째로 건너뛴다
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'textarea', 'title', 'head', 'svg', 'iframe', 'object', 'select']);
// 글이 이어지지 않는 경계 — 문장 찾기가 이 경계를 넘지 않는다. <br> 은 경계가 아니라 공백이다(lib/html.js 의 변환과 같다 — 줄 바꿈으로 나뉜 글도 한 문장이 된다)
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'html', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul']);
const TOKEN = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?\]\]>|<[!?][^>]*>|<\/([a-zA-Z][^\s>/]*)[^>]*>|<([a-zA-Z][^\s>/]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+|<)/g;
const ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi;

const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const short = (t, n = 80) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

// 원문 HTML 을 훑어 글 조각을 한 줄 글로 잇는다. 글자마다 원문의 어느 자리에서 왔는지(run, rawStart, rawEnd) 남겨 두어
// 찾은 자리에 <mark> 를 끼울 수 있게 한다. 공백은 하나로 접고, 블록 경계는 '\n' 으로 둔다
function textMap(html) {
  let text = '';
  const at = []; // text[i] → { run, start, end } (원문 오프셋) 또는 null(경계·접힌 공백)
  let run = 0;
  let lastSpace = true;
  const pushChar = (ch, start, end) => {
    if (/[\s ​﻿]/.test(ch)) { if (lastSpace) return; text += ' '; at.push(null); lastSpace = true; return; }
    text += ch; at.push({ run, start, end }); lastSpace = false;
  };
  const boundary = () => { if (text.at(-1) !== '\n') { text += '\n'; at.push(null); } lastSpace = true; };
  TOKEN.lastIndex = 0;
  for (let m; (m = TOKEN.exec(html));) {
    if (m[4] != null) {
      if (m[4] === '<') continue;
      const base = m.index;
      let p = 0;
      for (const e of m[4].matchAll(ENTITY)) {
        for (let i = p; i < e.index; i++) pushChar(m[4][i], base + i, base + i + 1);
        const decoded = decodeEntities(e[0]);
        for (const ch of decoded) pushChar(ch, base + e.index, base + e.index + e[0].length);
        p = e.index + e[0].length;
      }
      for (let i = p; i < m[4].length; i++) pushChar(m[4][i], base + i, base + i + 1);
      run++;
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      if (SKIP.has(tag)) {
        const close = html.slice(TOKEN.lastIndex).search(new RegExp(`</${tag}\\b`, 'i'));
        if (close >= 0) { const gt = html.indexOf('>', TOKEN.lastIndex + close); TOKEN.lastIndex = gt < 0 ? html.length : gt + 1; }
        boundary();
      } else if (BLOCK.has(tag)) boundary();
      else if (tag === 'br') { pushChar(' ', m.index, m.index); run++; }
      else run++;
    } else if (m[1]) {
      if (BLOCK.has(m[1].toLowerCase())) boundary();
      else run++;
    }
  }
  return { text, at };
}

function findIn(text, needle, from = 0) {
  if (!needle) return -1;
  let i = text.indexOf(needle, from);
  if (i < 0) i = text.toLowerCase().indexOf(needle.toLowerCase(), from);
  return i;
}

// 표시 하나가 놓인 글 범위 [시작, 끝) — 표 셀은 행 제목 뒤에서 값을 찾는다. 긴 문장은 앞머리만으로도 찾아 본다
function locate(map, m) {
  const target = clean(m.text);
  if (!target) return null;
  let from = 0;
  if (m.kind === 'cell' && m.row) { const r = findIn(map.text, clean(m.row)); if (r >= 0) from = r; }
  let i = findIn(map.text, target, from);
  let len = target.length;
  if (i < 0 && from > 0) i = findIn(map.text, target);
  if (i < 0 && target.length > 48) { const head = target.slice(0, 48).replace(/\s\S*$/, ''); i = findIn(map.text, head); len = head.length; }
  if (i < 0 || (m.kind === 'cell' && from === 0 && target.length < 2)) return null;
  return [i, i + len];
}

// 표시 종류 — 인용만·메모만·둘 다
const kindOf = m => (m.cites.length && m.notes.length ? 'both' : m.notes.length ? 'note' : 'cite');
const KIND_LABEL = { cite: '인용', note: '메모', both: '인용·메모' };

function tooltip(m) {
  return [...m.cites.map(c => `인용 ${c.id}: ${c.text}`), ...m.notes.map(n => `메모: ${n.text}`)].join('\n');
}

const STYLE = `<style id="sa-style">
.sa-m{background:#ffe95c;color:inherit;box-decoration-break:clone;-webkit-box-decoration-break:clone}
.sa-m.sa-note{background:#b8ecc6}.sa-m.sa-both{background:#ffc97a}
.sa-tag{display:inline-block;margin-left:3px;padding:0 5px;border-radius:9px;background:#b45309;color:#fff;font:bold 10px/16px sans-serif;vertical-align:super;text-decoration:none}
.sa-m:target{outline:3px solid #d97706;outline-offset:1px}
#sa-panel{position:fixed;top:8px;right:8px;z-index:2147483647;max-width:360px;max-height:70vh;overflow:auto;box-sizing:border-box;padding:6px 10px 8px;border:1px solid #d9a441;border-radius:8px;background:#fffbe6;color:#1f2937;box-shadow:0 6px 18px rgba(0,0,0,.18);font:12px/1.5 -apple-system,"Segoe UI","Malgun Gothic",sans-serif;text-align:left}
#sa-panel summary{cursor:pointer;font-weight:700}
#sa-panel ol{margin:6px 0 0;padding-left:20px}#sa-panel li{margin:4px 0}#sa-panel li.sa-miss{color:#6b7280}
#sa-panel a{color:#1d4ed8;font-weight:700;text-decoration:none}#sa-panel .sa-k{color:#6b7280}#sa-panel .sa-q{color:#374151}
</style>`;

// marks: lib/marks.js 의 참조·메모 목록. 표시를 입힌 HTML 과 위치를 찾은 표시 번호를 돌려준다
export function markHtml(html, marks) {
  const map = textMap(html);
  const inserts = []; // { at, html, order } — 뒤에서부터 끼운다
  const found = [];
  for (const m of marks) {
    const range = locate(map, m);
    if (!range) continue;
    // 범위의 글자들을 글 조각(run)별로 묶어 조각마다 따로 감싼다
    const runs = new Map();
    for (let i = range[0]; i < range[1]; i++) {
      const pos = map.at[i];
      if (!pos) continue;
      const r = runs.get(pos.run) || { start: pos.start, end: pos.end };
      runs.set(pos.run, { start: Math.min(r.start, pos.start), end: Math.max(r.end, pos.end) });
    }
    if (!runs.size) continue;
    found.push(m.n);
    const kind = kindOf(m);
    const title = esc(tooltip(m));
    let first = true;
    let last = null;
    for (const r of runs.values()) {
      inserts.push({ at: r.start, order: 2, html: `<mark class="sa-m sa-${kind}"${first ? ` id="sa-m-${m.n}"` : ''} title="${title}">` });
      inserts.push({ at: r.end, order: 0, html: '</mark>' });
      first = false;
      last = r;
    }
    inserts.push({ at: last.end, order: 1, html: `<sup class="sa-tag" title="${title}">${m.n}</sup>` });
  }
  // 같은 자리에서는 왼쪽부터 닫기 → 번호표 → 열기 순이 되어야 한다. 뒤에서부터 끼우므로(나중에 끼운 것이 왼쪽에 놓인다) 열기(2) → 번호표(1) → 닫기(0) 순으로 끼운다
  inserts.sort((a, b) => b.at - a.at || b.order - a.order);
  let out = html;
  for (const ins of inserts) out = out.slice(0, ins.at) + ins.html + out.slice(ins.at);

  const items = marks.map(m => {
    const hit = found.includes(m.n);
    const head = hit ? `<a href="#sa-m-${m.n}">${m.n}</a>` : `<b>${m.n}</b>`;
    const lines = [...m.cites.map(c => `<span class="sa-k">인용 ${esc(c.id)}</span> <span class="sa-q">${esc(short(c.text))}</span>`), ...m.notes.map(n => `<span class="sa-k">메모</span> <span class="sa-q">${esc(short(n.text))}</span>`)];
    return `<li${hit ? '' : ' class="sa-miss"'}>${head} <span class="sa-k">${KIND_LABEL[kindOf(m)]} · ${esc(m.loc || '')}${hit ? '' : ' · 원본에서 자리를 찾지 못함'}</span><br>${lines.join('<br>')}</li>`;
  });
  const cites = marks.filter(m => m.cites.length).length;
  const notes = marks.reduce((n, m) => n + m.notes.length, 0);
  const panel = `${STYLE}<details id="sa-panel" open><summary>참조 ${cites} · 메모 ${notes}${found.length < marks.length ? ` · 자리 못 찾음 ${marks.length - found.length}` : ''}</summary>${items.length ? `<ol>${items.join('')}</ol>` : '<p class="sa-k">이 원문을 인용한 문장이나 메모가 없습니다.</p>'}</details>`;
  const body = /<body[^>]*>/i.exec(out);
  out = body ? out.slice(0, body.index + body[0].length) + panel + out.slice(body.index + body[0].length) : panel + out;
  return { html: out, found };
}
