// 원문 열람 부품 (FR-WB-075, 078, 080, 081) — 서지정보 · 보기 방식(본문·원본·Markdown 미리보기) · 참조·메모 띠 · 원본 iframe · 메모 대화상자.
// 보고서 화면의 3열·떠 있는 창(book.js)과 장의 원문 열(sources.js)이 함께 쓴다. 본문은 부르는 쪽이 그린다(읽기 전용 / 고르고 끌 수 있는 것).
// 참조(보고서가 인용한 위치)·메모 목록은 서버(/api/sources/<id>/marks)가 만들고, 원본 위 표시는 서버가 입힌 사본(original?marks=1)이다 (FR-PL-012).
import { formatLabel } from '../shared/model.js';
import { previewUrl, renderMarkdown } from './md_preview.js';
import { api } from './state.js';
import { fill, flash, formatDate, h, toast } from './util.js';

const FRAME_EXT = new Set(['html', 'pdf', 'txt', 'md']); // 그 자리에 넣을 수 있는 원본 — PPT·Word·한글은 내려받아 본다. 붙여 넣은 원문에는 원본이 없다
export const snapshotExt = source => source.snapshot?.split('.').pop() || '';
export const fileUrl = (docId, source, kind, query = '') => `/api/sources/${encodeURIComponent(source.id)}/${kind}?doc=${encodeURIComponent(docId)}${query}`;
const lastMode = new Map(); // 화면(key)별로 마지막에 고른 보기 방식 — 다음 원문에도 쓴다
const short = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

export function viewModes(source) {
  const ext = snapshotExt(source);
  return new Map([
    ['body', { label: '본문', title: '문장·표 단위로 나눈 원문' }],
    ...(FRAME_EXT.has(ext) ? [['original', { label: '원본', title: `수집할 때 내려받아 보관한 원본(${ext})을 그 자리에 보여 줍니다. 인용한 곳과 메모는 형광으로 표시됩니다` }]] : []),
    ['markdown', { label: 'Markdown', title: '원본과 함께 보관한 Markdown 파일의 미리보기 — 제목·목록·표를 서식대로, 문장 ID 를 표지로 보여 줍니다. 「Markdown ↗」는 새 탭 미리보기입니다' }],
  ]);
}

// source · docId(장 ID) · body(): 본문 노드 · key: 'book' | 'chapter' (보기 방식을 따로 기억) · canNote: 메모를 고칠 수 있는 화면인지 ·
// actions: 서지정보 밑에 더 둘 버튼 · onMode(mode): 본문을 (다시) 그린 뒤 부른다
// → { pane, setMode, refresh, mode }
// files(kind, query): 보관 파일·참조 목록의 주소를 바꿔 끼운다(기준 문서 — book_guides.js) · marks: false 면 참조·메모를 받지도 그리지도 않는다 · rows: 서지정보 줄을 [[dt, dd], …] 로 바꾼다
export function readerPane(source, { docId, body, key = 'book', canNote = false, actions = [], onMode, files = null, marks: withMarks = true, rows = null } = {}) {
  const pane = h('div.reader-pane');
  const strip = h('div.marks-strip');
  const content = h('div.reader-content');
  const modes = viewModes(source);
  const urlFor = (kind, query = '') => (files ? files(kind, query) : fileUrl(docId, source, kind, query));
  let mode = modes.has(lastMode.get(key)) ? lastMode.get(key) : key === 'book' && modes.has('original') ? 'original' : 'body';
  let marks = withMarks ? null : []; // 서버가 준 참조·메모 목록 — 기준 문서에는 없다
  let loading = null;

  const loadMarks = () => (!withMarks ? Promise.resolve(marks) : (loading ??= api('GET', urlFor('marks')).then(list => (marks = list)).catch(err => { toast(err.message, 'error'); return (marks = []); })));
  const decorate = () => { if (mode === 'body') decorateBody(content, marks, { cites: key !== 'chapter', canNote, docId, source, onChange: refresh }); };
  const jump = m => {
    const frame = content.querySelector('iframe');
    if (mode === 'body') { const node = content.querySelector(`[data-aid="${m.anchorId}"]`); node?.scrollIntoView({ block: 'center', behavior: 'smooth' }); flash(node, 'is-anchor-flash'); return; }
    if (!frame || mode !== 'original') return;
    const ext = snapshotExt(source);
    const url = ext === 'pdf' ? (m.page ? `${frame.dataset.base}#page=${m.page}` : null) : `${frame.dataset.base}#sa-m-${m.n}`;
    if (!url) return;
    if (ext === 'pdf') frame.replaceWith(h('iframe.src-frame', { src: url, dataset: { base: frame.dataset.base }, title: frame.title })); // PDF 보기는 조각(#page)만 바뀌면 옮기지 않는다 — 새 iframe 으로 그 쪽을 연다
    else frame.src = url;
  };
  const renderStrip = () => { strip.hidden = !withMarks; if (withMarks) fill(strip, marksStrip(marks, { mode, source, jump })); };
  const refresh = () => { loading = null; return loadMarks().then(() => { renderStrip(); decorate(); }); };
  const draw = () => {
    pane.classList.toggle('is-frame', mode === 'original');
    fill(pane, readerMeta(source, modes, mode, pick, { urlFor, actions, showChapter: key === 'book', rows }), strip, content);
    fill(content, mode === 'body' ? body() : mode === 'markdown' ? markdownView(urlFor('markdown')) : readerFrame(urlFor, source, mode));
    onMode?.(mode);
    renderStrip();
    loadMarks().then(() => { renderStrip(); decorate(); });
  };
  function pick(next) {
    mode = next;
    lastMode.set(key, next);
    draw();
  }
  draw();
  return { pane, refresh, setMode: next => { if (next !== mode && modes.has(next)) pick(next); }, get mode() { return mode; } };
}

function readerMeta(source, modes, mode, pick, { urlFor, actions, showChapter, rows }) {
  const ext = snapshotExt(source);
  const link = (kind, label, title) => h('a.btn.small.ghost', { href: urlFor(kind), target: '_blank', rel: 'noopener noreferrer', title }, label);
  return h('header.src-meta',
    h('div.src-meta-title', h('span.type-badge', { class: `type-${source.type}` }, formatLabel(source)), source.title),
    h('dl', rows ? rows.map(([dt, dd]) => h('div', h('dt', dt), h('dd', dd))) : [
      showChapter && h('div', h('dt', '장'), h('dd', `${source.chapterTitle || ''} `, h('code.id', `${source.chapterId} · ${source.id}`))),
      h('div', h('dt', '발행'), h('dd', `${source.publisher || '미상'} · ${source.publishedAt || '발행일 미상'}`)),
      h('div', h('dt', '수집'), h('dd', `${formatDate(source.collectedAt)}${source.method ? ` · ${source.method}` : ''}`)),
      source.url && h('div', h('dt', '원문'), h('dd', h('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer' }, source.url))),
    ]),
    h('div.row-actions',
      h('div.segmented', { role: 'group', 'aria-label': '원문 보기 방식' }, [...modes].map(([key, m]) =>
        h('button', { type: 'button', class: key === mode ? 'is-on' : '', title: m.title, onclick: () => pick(key) }, m.label))),
      !modes.has('original') && h('span.muted.reader-note', source.snapshot ? `보관한 원본(${ext})은 그 자리에 넣을 수 없어 내려받아 봅니다` : '붙여 넣은 원문이라 내려받은 원본이 없습니다'),
      source.snapshot && link('original', `원본 (${ext}) ↗`, '수집할 때 내려받아 보관한 원본 파일을 새 탭에서 엽니다'),
      h('a.btn.small.ghost', { href: previewUrl(urlFor('markdown'), source.title), target: '_blank', rel: 'noopener noreferrer', title: '원본과 함께 보관한 Markdown 파일을 새 탭에서 미리보기로 엽니다(그 탭에서 파일 그대로도 볼 수 있습니다)' }, 'Markdown ↗'),
      actions));
}

// 보관한 원본은 남이 만든 파일이다 — 서버가 CSP sandbox 로 보내고(NFR-PL-001), 웹 스냅샷·텍스트는 iframe 에도 sandbox 를 붙인다.
// PDF 는 브라우저의 PDF 보기가 sandbox 안에서 돌지 않아 서버 헤더에만 맡긴다. 원본에는 참조·메모 표시를 입힌 사본(marks=1)을 연다
function readerFrame(urlFor, source, mode) {
  const pdf = mode === 'original' && snapshotExt(source) === 'pdf';
  const base = urlFor(mode, mode === 'original' ? '&marks=1' : '');
  return h('iframe.src-frame', { src: base, dataset: { base }, title: `${source.id} 원본`, ...(pdf ? {} : { sandbox: '' }) });
}

// Markdown 보기 — 보관한 파일을 받아 미리보기로 그린다(md_preview.js — 글은 텍스트 노드로만 넣는다)
function markdownView(url) {
  const box = h('div.src-doc.md-preview', h('p.muted', 'Markdown 파일을 읽는 중…'));
  fetch(url)
    .then(res => (res.ok ? res.text() : res.json().catch(() => ({})).then(body => Promise.reject(new Error(body.error || res.statusText)))))
    .then(text => fill(box, renderMarkdown(text)))
    .catch(err => fill(box, h('p.muted', `Markdown 파일을 읽지 못했습니다 — ${err.message}`)));
  return box;
}

// ───────────────────────────── 참조 · 메모 ─────────────────────────────

const kindOf = m => (m.cites.length && m.notes.length ? 'both' : m.notes.length ? 'note' : 'cite');
const tooltip = m => [...m.cites.map(c => `인용 ${c.id}: ${c.text}`), ...m.notes.map(n => `메모: ${n.text}`)].join('\n');

// 참조·메모 띠 — 표시마다 번호·위치·인용 문장 ID. 누르면 본문에서는 그 자리로, 원본에서는 형광 자리로 간다 (FR-WB-080)
function marksStrip(marks, { mode, source, jump }) {
  if (!marks) return h('span.muted', '참조·메모를 읽는 중…');
  const cites = marks.filter(m => m.cites.length).length;
  const notes = marks.reduce((n, m) => n + m.notes.length, 0);
  const canJump = mode === 'body' || (mode === 'original' && ['html', 'pdf'].includes(snapshotExt(source)));
  return [
    h('span.marks-count', { title: '보고서가 인용한 원문 위치와 작성자 메모' }, `참조 ${cites} · 메모 ${notes}`),
    !marks.length && h('span.muted', '이 원문을 인용한 문장이나 메모가 없습니다.'),
    marks.map(m => h('button.mark-chip', { type: 'button', class: `is-${kindOf(m)}`, disabled: !canJump, title: `${tooltip(m)}${canJump ? '\n누르면 그 자리로 갑니다' : ''}`, onclick: () => jump(m) },
      h('b', String(m.n)),
      ` ${m.loc}`,
      m.cites.length > 0 && h('span.mark-ids', m.cites.map(c => c.id).join(' ')),
      m.notes.length > 0 && h('span.mark-pen', '✎'))),
  ];
}

// 본문 보기의 문장·표 셀에 인용·메모 표시를 입힌다 — 문장 뒤에 인용 문장 ID 와 메모 표(누르면 고친다)를 붙인다.
// 표 셀은 숫자 정렬을 흐트리지 않게 색과 도움말만 바꾼다. cites: 인용 표시까지 할지(장의 원문 열은 자기 표시가 있다)
export function decorateBody(container, marks, { cites = true, canNote = false, docId, source, onChange } = {}) {
  for (const old of container.querySelectorAll('.mark-chip.inline')) old.remove();
  for (const node of container.querySelectorAll('[data-aid]')) {
    node.classList.remove('has-note');
    if (cites) { node.classList.remove('is-cited'); node.removeAttribute('title'); }
  }
  for (const m of marks || []) {
    const node = container.querySelector(`[data-aid="${m.anchorId}"]`);
    if (!node) continue;
    if (cites && m.cites.length) { node.classList.add('is-cited'); node.title = m.cites.map(c => `${c.id}: ${c.text}`).join('\n'); }
    if (m.notes.length) node.classList.add('has-note');
    if (node.tagName === 'TD') {
      if (m.notes.length) node.title = [node.title, ...m.notes.map(n => `메모: ${n.text}`)].filter(Boolean).join('\n');
      continue;
    }
    node.after(
      ...(cites ? m.cites.map(c => h('span.mark-chip.inline.is-cite', { title: c.text }, c.id)) : []),
      ...m.notes.map(n => h('button.mark-chip.inline.is-note', { type: 'button', title: canNote ? `${n.text}\n누르면 고칩니다` : n.text, onclick: () => { if (canNote) noteDialog({ docId, source, anchorId: m.anchorId, note: n, anchorText: m.text }, onChange); } }, `✎ ${short(n.text, 24)}`)),
    );
  }
}

// 메모 적기·고치기·지우기 (FR-WB-081). 저장하면 source.notes 를 서버가 돌려준 목록으로 바꾸고 onChange(notes) 를 부른다
export function noteDialog({ docId, source, anchorId, note = null, anchorText = '' }, onChange) {
  const enc = encodeURIComponent;
  const text = h('textarea', { rows: 5, maxLength: 2000, required: true, value: note?.text || '', placeholder: '이 원문 위치에 남길 메모 — 예: 2023년 값이라 최신 자료로 바꿀 것' });
  const apply = async (call) => {
    try {
      const res = await call();
      source.notes = res.notes;
      dialog.close();
      onChange?.(res.notes);
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const dialog = h('dialog.dialog',
    h('form', {
      method: 'dialog',
      onsubmit: event => {
        event.preventDefault();
        apply(() => (note
          ? api('PUT', `/api/sources/${enc(source.id)}/notes/${enc(note.id)}`, { docId, text: text.value })
          : api('POST', `/api/sources/${enc(source.id)}/notes`, { docId, anchorId, text: text.value })));
      },
    },
      h('h2', note ? '메모 고치기' : '메모'),
      h('p.muted', `${source.id} · ${anchorId}`),
      anchorText && h('blockquote.ev-quote', short(anchorText, 200)),
      h('label.field', '메모', text),
      h('div.row-actions.end',
        note && h('button.btn.ghost.danger', { type: 'button', onclick: () => { if (confirm('이 메모를 지울까요?')) apply(() => api('DELETE', `/api/sources/${enc(source.id)}/notes/${enc(note.id)}?doc=${enc(docId)}`)); } }, '삭제'),
        h('button.btn.ghost', { type: 'button', onclick: () => dialog.close() }, '취소'),
        h('button.btn', { type: 'submit' }, '저장'))));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  text.focus();
}
