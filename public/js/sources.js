// 3열 원문 — 열어 둔 문서에 수집한 자료 목록과 원문 보기. 문장·표 셀 단위로 고르고, 끌거나 버튼으로 다른 열에 넘긴다.
import { anchorText, blockLoc, SOURCE_TYPES } from '../shared/model.js';
import { collapseButton } from './columns.js';
import { startDrag } from './dnd.js';
import { previewUrl } from './md_preview.js';
import { revealSentences } from './editor.js';
import { noteDialog, readerPane } from './source_view.js';
import { api, attach, citedAnchors, flushSave, inSourceOrder, insertAnchors, linkAnchors, on, primarySentence, selectAnchor, selectDoc, setSources, state } from './state.js';
import { alignedNumber, fill, flash, formatDate, fractionWidth, h, toast } from './util.js';

let root, body, selbar, headCount;
let reader = null; // 열어 둔 원문의 열람 부품 (source_view.js) — 보기 방식 전환·참조 띠 다시 읽기

const anchorNode = id => body.querySelector(`[data-aid="${id}"]`);

export function initSources(container) {
  root = container;
  headCount = h('span.count');
  body = h('div.src-scroll');
  selbar = h('div.selbar', { hidden: true });
  root.append(
    h('header.col-head',
      h('div.col-title', h('span.col-index', '3'), '원문', headCount),
      h('div.col-head-actions', h('button.btn.small', { type: 'button', onclick: openAddDialog }, '＋ 원문 추가'), collapseButton(root, '3열 원문'))),
    body,
    selbar,
  );

  body.addEventListener('click', onClick);
  body.addEventListener('dragstart', event => {
    const node = event.target.closest?.('[data-aid]');
    if (!node) return;
    const id = node.dataset.aid;
    const ids = state.sel.anchors.includes(id) ? inSourceOrder(state.sel.anchors) : [id];
    startDrag(event, { from: 'source', anchors: ids }, ids.map(a => anchorText(state.anchors.get(a))).join(' '));
  });

  on('sources', render);
  on('doc', updateMarks);
  on('select', updateMarks);
  on('open-anchor', openAnchor);
}

// 근거가 가리키는 원문 위치를 연다: 자료 열기 → 위치로 스크롤 → 강조
export function openAnchor(anchorId) {
  const anchor = state.anchors.get(anchorId);
  if (!anchor) return toast('원문에서 이 위치를 찾지 못했습니다.', 'error');
  if (state.activeSourceId !== anchor.source.id) {
    state.activeSourceId = anchor.source.id;
    render();
  }
  reader?.setMode('body'); // 원본·Markdown 을 보고 있었으면 본문으로 돌아와 그 자리를 강조한다
  const node = anchorNode(anchorId);
  node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  flash(node, 'is-anchor-flash');
  // 표 셀이면 행·열 제목도 함께 강조해 값이 무엇의 언제 수치인지 보이게 한다
  if (node?.tagName === 'TD') {
    const row = node.parentElement;
    const table = node.closest('table');
    flash(row.cells[0], 'is-anchor-flash');
    flash(table.tHead.rows[0].cells[node.cellIndex], 'is-anchor-flash');
  }
}

// ───────────────────────────── 그리기 ─────────────────────────────

function render() {
  headCount.textContent = String(state.sources.length);
  const source = state.sources.find(s => s.id === state.activeSourceId);
  if (!source) state.activeSourceId = null;
  if (!source) reader = null;
  body.classList.toggle('is-reader', Boolean(source)); // 열람 중에는 부품(reader-pane)이 스크롤을 맡는다
  body.replaceChildren(...(source ? renderReader(source) : renderList()));
  body.scrollTop = 0;
  updateMarks();
}

function renderList() {
  const cited = citedAnchors();
  const usesOf = source => [...cited.keys()].filter(a => state.anchors.get(a)?.source.id === source.id).length;
  return [
    !state.sources.length && h('div.empty', h('p', '이 문서에 수집한 원문이 없습니다.'), h('p', '에이전트에게 쓸 주제를 말하면 직접 검색해 자료를 찾아 원문으로 수집합니다. 가지고 있는 자료는 “＋ 원문 추가”로 붙여 넣으세요.')),
    state.sources.map(source => sourceCard(source, usesOf(source))),
    state.rejected.length > 0 && h('div.src-section-head', { title: '에이전트는 이 자료를 원문으로 쓰지 않고, 같은 URL 을 다시 채택하지 못합니다' }, '채택 거부한 자료', h('span.count', String(state.rejected.length))),
    state.rejected.map(rejectedCard),
  ].flat().filter(Boolean);
}

// 목록의 자료 한 건 — 한 줄에 형식·제목·발행기관만 두고, 나머지는 접어 두었다가 펼치기(▸)를 누르면 보여 준다 (FR-WB-004).
// 펼칠 때 목록을 다시 그리지 않는다(스크롤 위치 유지). 펼친 상태는 목록을 다시 그려도 남는다.
const expanded = new Set();

function card(source, { onopen, note, details, className = '' }) {
  const open = expanded.has(source.id);
  const detailsNode = h('div.src-card-details', { hidden: !open }, details);
  const toggle = h('button.src-card-toggle', { type: 'button', 'aria-expanded': String(open), title: '원문 번호·발행일·수집 정보 펼치기/접기', onclick: () => {
    const now = !expanded.delete(source.id);
    if (now) expanded.add(source.id);
    detailsNode.hidden = !now;
    toggle.textContent = now ? '▾' : '▸';
    toggle.setAttribute('aria-expanded', String(now));
    node.classList.toggle('is-open', now);
  } }, open ? '▾' : '▸');
  const node = h('div.src-card', { class: `${className} ${open ? 'is-open' : ''}` },
    h('div.src-card-line',
      toggle,
      h(onopen ? 'button.src-card-open' : 'div.src-card-open', { type: onopen ? 'button' : null, title: `${source.id} · ${source.title} · ${source.publisher || '발행처 미상'}${onopen ? '\n누르면 원문을 엽니다' : ''}`, onclick: onopen },
        h('span.type-badge', { class: `type-${source.type}` }, SOURCE_TYPES[source.type]),
        h('span.src-card-title', source.title),
        h('span.src-card-publisher', source.publisher || '발행처 미상'))),
    note,
    detailsNode);
  return node;
}

function sourceCard(source, uses) {
  return card(source, {
    onopen: () => { state.activeSourceId = source.id; render(); },
    details: [
      h('div.src-card-meta', h('code.id', source.id), ` · 발행 ${source.publishedAt || '미상'}`, source.sample && [' · ', h('span.sample-badge', '가상 샘플')], uses > 0 && [' · ', h('span.uses', `인용 ${uses}곳`)]),
      h('div.src-card-meta', `수집 ${formatDate(source.collectedAt)} · ${source.method || ''}`),
      source.adoptReason && h('div.src-card-reason', `채택 이유: ${source.adoptReason}`),
      h('div.row-actions', h('button.btn.small.ghost.danger', { type: 'button', onclick: () => rejectSource(source) }, '채택 거부')),
    ],
  });
}

// 거부 목록의 자료 — 거부 이유는 접은 상태에서도 보인다. 본문은 열 수 없다 (FR-WB-046)
function rejectedCard(source) {
  return card(source, {
    className: 'is-rejected',
    note: h('div.src-card-note', `거부 이유: ${source.rejected.reason}`),
    details: [
      h('div.src-card-meta', h('code.id', source.id), ` · 발행 ${source.publishedAt || '미상'} · 거부 ${formatDate(source.rejected.at)}`),
      source.url && h('div.src-card-meta', h('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer' }, source.url)),
      source.adoptReason && h('div.src-card-reason', `채택 이유: ${source.adoptReason}`),
      h('div.row-actions',
        fileLinks(source),
        h('button.btn.small.ghost', { type: 'button', onclick: () => rejectSource(source) }, '이유 고치기'),
        h('button.btn.small.ghost', { type: 'button', title: '같은 원문 번호로 원문 목록에 되돌립니다', onclick: () => restoreSource(source) }, '채택으로 되돌리기'),
        h('button.btn.small.ghost.danger', { type: 'button', title: '보관한 파일을 지웁니다. 에이전트가 이 URL 을 다시 채택할 수 있게 됩니다', onclick: () => removeSource(source) }, '목록에서 지우기')),
    ],
  });
}

// 탭 줄 + 열람 부품(source_view.js — 서지정보·보기 방식·참조 띠·원본 iframe). 본문은 여기서 문장·표 셀 단위로 그린다 (FR-WB-003, 080)
function renderReader(source) {
  const tabs = h('nav.src-tabs',
    h('button.src-tab.back', { type: 'button', onclick: () => { state.activeSourceId = null; render(); } }, '← 목록'),
    state.sources.map(s => h('button.src-tab', { type: 'button', class: s.id === source.id ? 'is-on' : '', title: s.title, onclick: () => { state.activeSourceId = s.id; render(); } }, s.id)));
  reader = readerPane(source, {
    docId: state.doc.id,
    key: 'chapter',
    canNote: true,
    actions: [
      h('button.btn.small.ghost.danger', { type: 'button', onclick: () => rejectSource(source) }, '채택 거부'),
      h('button.btn.small.ghost.danger', { type: 'button', onclick: () => removeSource(source) }, '자료 삭제'),
    ],
    body: () => renderDoc(source),
    onMode: updateMarks, // 본문을 다시 그렸으면 인용·선택 표시도 다시 입힌다
  });
  return [tabs, reader.pane];
}

// 페이지·슬라이드가 바뀌는 곳에 구분선을 넣고, PPT 는 슬라이드 단위 카드로 묶는다
function renderDoc(source) {
  const doc = h('div.src-doc', { class: `src-${source.type}` });
  let container = doc;
  let lastLoc = null;
  for (const block of source.blocks) {
    const loc = blockLoc(source, block);
    if (loc !== lastLoc) {
      lastLoc = loc;
      if (source.type === 'pptx') {
        container = h('section.slide', h('div.loc-mark', loc));
        doc.append(container);
      } else if (source.type === 'pdf') {
        doc.append(h('div.loc-mark.page-mark', loc));
      }
    }
    container.append(renderBlock(source, block, loc));
  }
  return doc;
}

const sentenceSpan = s => h('span.src-sent', { draggable: true, dataset: { aid: s.id } }, s.text);

function renderBlock(source, block, loc) {
  const showLoc = source.type !== 'pdf' && source.type !== 'pptx';
  if (block.kind === 'heading') return h(`h${Math.min(block.level || 2, 3) + 2}.src-h`, block.sentences.map(sentenceSpan));
  if (block.kind === 'list') return h('ul.src-list', block.sentences.map(s => h('li', sentenceSpan(s))));
  if (block.kind === 'table') return renderTable(block);
  const p = h('p.src-p', showLoc && h('span.para-loc', loc));
  block.sentences.forEach((s, i) => p.append(i ? ' ' : '', sentenceSpan(s)));
  return p;
}

function renderTable(block) {
  const t = block.table;
  const fracs = t.columns.slice(1).map((_, c) => fractionWidth(t.rows.map(r => r.cells[c]?.text)));
  return h('figure.src-table',
    h('figcaption', h('span', t.title || '표'), t.unit && h('span.unit', `단위: ${t.unit}`)),
    h('div.table-wrap', h('table.num-table',
      h('thead', h('tr', t.columns.map((col, i) => h(i ? 'th.is-num' : 'th', col)))),
      h('tbody', t.rows.map(row => h('tr',
        h('th', { scope: 'row' }, row.header),
        row.cells.map((cell, c) => h('td.is-num.src-cell', { draggable: true, dataset: { aid: cell.id } }, alignedNumber(cell.text, fracs[c])))))))),
    block.sentences.map(s => h('p.src-note', sentenceSpan(s))),
  );
}

// 보고서가 인용한 곳 · 지금 고른 문장의 근거 · 선택 상태를 표시한다
function updateMarks() {
  const cited = citedAnchors();
  const selected = new Set(state.sel.anchors);
  const primary = primarySentence();
  const supporting = new Set((primary?.evidence || []).map(id => state.evidence[id]?.anchorId));
  for (const node of body.querySelectorAll('[data-aid]')) {
    const id = node.dataset.aid;
    const uses = cited.get(id)?.length || 0;
    node.classList.toggle('is-cited', uses > 0);
    node.classList.toggle('is-supporting', supporting.has(id));
    node.classList.toggle('is-selected', selected.has(id));
    node.title = uses ? `보고서 문장 ${uses}개가 인용한 위치 (${id})` : id;
  }
  renderSelbar(cited);
}

function renderSelbar(cited) {
  const ids = inSourceOrder(state.sel.anchors);
  selbar.hidden = !ids.length;
  if (!ids.length) return;
  const target = primarySentence();
  const citing = [...new Set(ids.flatMap(a => cited.get(a) || []))];
  fill(selbar,
    h('span.selbar-count', `원문 ${ids.length}곳 선택`),
    h('button.btn.small', { type: 'button', title: '선택한 문장 뒤(없으면 문서 끝)에 근거가 연결된 문장으로 넣습니다', onclick: () => { revealSentences(insertAnchors(ids)); selectAnchor(null); } }, '← 편집기에 넣기'),
    h('button.btn.small', { type: 'button', disabled: !target, title: target ? `${target.id} 의 근거로 연결합니다` : '편집기에서 문장을 먼저 고르세요', onclick: () => { linkAnchors(target.id, ids); selectAnchor(null); } }, '⚓ 근거로 연결'),
    h('button.btn.small', { type: 'button', onclick: () => { attach(ids.map(id => ({ kind: 'anchor', id }))); selectAnchor(null); } }, '← 채팅에 첨부'),
    ids.length === 1 && h('button.btn.small.ghost', { type: 'button', title: '이 원문 위치에 메모를 남깁니다', onclick: () => {
      const anchor = state.anchors.get(ids[0]);
      noteDialog({ docId: state.doc.id, source: anchor.source, anchorId: ids[0], anchorText: anchorText(anchor) }, () => { reader?.refresh(); selectAnchor(null); });
    } }, '✎ 메모'),
    citing.length > 0 && h('button.btn.small.ghost', { type: 'button', onclick: () => { selectDoc(citing[0]); revealSentences(citing); } }, `인용한 문장 ${citing.length}개 보기`),
    h('button.icon-btn', { type: 'button', title: '선택 해제', onclick: () => selectAnchor(null) }, '✕'),
  );
}

function onClick(event) {
  const node = event.target.closest('[data-aid]');
  if (!node) return;
  selectAnchor(node.dataset.aid, event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'toggle' : state.sel.anchors.length === 1 && state.sel.anchors[0] === node.dataset.aid ? 'toggle' : 'single');
}

// ───────────────────────────── 채택 거부 · 거부 목록 ─────────────────────────────

const fileUrl = (source, kind) => `/api/sources/${encodeURIComponent(source.id)}/${kind}?doc=${encodeURIComponent(state.doc.id)}`;

// 보관한 원본과 Markdown 파일을 새 탭에서 연다 (FR-PL-011) — 붙여 넣은 원문에는 내려받은 원본이 없다. Markdown 은 미리보기(md_view.html)로 연다
function fileLinks(source) {
  const link = (href, label, title) => h('a.btn.small.ghost', { href, target: '_blank', rel: 'noopener noreferrer', title }, label);
  return [
    source.snapshot && link(fileUrl(source, 'original'), `원본 열기 (${source.snapshot.split('.').pop()})`, '수집할 때 내려받아 보관한 원본 파일을 엽니다'),
    link(previewUrl(fileUrl(source, 'markdown'), source.title), 'Markdown 열기', '원본과 함께 보관한 Markdown 파일을 미리보기로 엽니다(그 탭에서 파일 그대로도 볼 수 있습니다)'),
  ];
}

// 채택을 거부한다(원문 목록의 자료) 또는 거부 이유를 고친다(거부 목록의 자료) (FR-WB-045, 046)
function rejectSource(source) {
  const editing = Boolean(source.rejected);
  const reason = h('textarea', { required: true, rows: 4, maxLength: 500, value: source.rejected?.reason || '', placeholder: '예: 2차 자료라서 원발행처 자료로 바꾼다 · 주제와 기간이 맞지 않는다 · 제조사 홍보물이라 근거로 쓰지 않는다' });
  const dialog = h('dialog.dialog',
    h('form', {
      method: 'dialog',
      onsubmit: async event => {
        event.preventDefault();
        try {
          await flushSave(); // 방금 연결한 근거까지 저장한 뒤에 서버가 인용 여부를 가린다 (ERR-WB-004)
          const { rejected } = await api('POST', `/api/sources/${encodeURIComponent(source.id)}/reject`, { docId: state.doc.id, reason: reason.value });
          if (state.activeSourceId === source.id) state.activeSourceId = null;
          expanded.delete(source.id);
          setSources(state.sources.filter(s => s.id !== source.id), rejected);
          dialog.close();
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    },
      h('h2', editing ? '거부 이유 고치기' : '채택 거부'),
      h('p.muted', `${source.id} · ${source.title}`),
      !editing && h('p.muted', '이 자료를 원문 목록에서 빼고 거부 목록에 둡니다. 에이전트는 이 자료를 원문으로 쓰지 않고 같은 URL 을 다시 채택하지 못하며, 이유를 다음 자료 선택에 참고합니다. 거부 목록에서 언제든 되돌릴 수 있습니다.'),
      h('label.field', '거부 이유', reason),
      h('div.row-actions.end',
        h('button.btn.ghost', { type: 'button', onclick: () => dialog.close() }, '취소'),
        h('button.btn', { type: 'submit', class: editing ? '' : 'danger' }, editing ? '저장' : '채택 거부'))));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  reason.focus();
}

async function restoreSource(source) {
  try {
    const restored = await api('POST', `/api/sources/${encodeURIComponent(source.id)}/restore`, { docId: state.doc.id });
    expanded.delete(source.id);
    setSources([...state.sources, restored.source].sort((a, b) => a.id.localeCompare(b.id)), restored.rejected);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ───────────────────────────── 원문 추가 · 삭제 ─────────────────────────────

// 원문 목록의 자료든 거부 목록의 자료든 보관한 파일까지 지운다
async function removeSource(source) {
  if (!confirm(`“${source.title}” 자료를 ${source.rejected ? '거부 목록에서 지울까요? 보관한 원본과 Markdown 파일도 지워지고, 에이전트가 이 자료를 다시 채택할 수 있게 됩니다.' : '삭제할까요? 보관한 원본과 Markdown 파일도 함께 지워집니다.'}`)) return;
  try {
    await flushSave();
    await api('DELETE', `/api/sources/${encodeURIComponent(source.id)}?doc=${encodeURIComponent(state.doc.id)}`);
    if (state.activeSourceId === source.id) state.activeSourceId = null;
    setSources(state.sources.filter(s => s.id !== source.id), state.rejected.filter(s => s.id !== source.id));
  } catch (err) {
    toast(err.message, 'error');
  }
}

function openAddDialog() {
  const field = (label, input) => h('label.field', label, input);
  const title = h('input', { type: 'text', required: true, placeholder: '자료 제목' });
  const type = h('select', Object.entries(SOURCE_TYPES).map(([value, label]) => h('option', { value, selected: value === 'web' }, label)));
  const publisher = h('input', { type: 'text', placeholder: '발행기관' });
  const publishedAt = h('input', { type: 'date' });
  const url = h('input', { type: 'url', placeholder: 'https://…' });
  const markdown = h('textarea', { required: true, rows: 12, placeholder: '본문을 붙여 넣으세요. Markdown 제목(#), 목록(-), 표(| 구분 | 2024 | 2025 |)를 인식합니다.\n표 바로 위에 “표 1. 제목 (단위: %)” 줄을 두면 제목과 단위로 씁니다.' });
  const dialog = h('dialog.dialog',
    h('form', {
      method: 'dialog',
      onsubmit: async event => {
        event.preventDefault();
        try {
          const source = await api('POST', '/api/sources', { docId: state.doc.id, title: title.value, type: type.value, publisher: publisher.value, publishedAt: publishedAt.value, url: url.value, markdown: markdown.value });
          state.activeSourceId = source.id;
          setSources([...state.sources, source]);
          dialog.close();
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    },
      h('h2', '원문 추가'),
      h('p.muted', '문장을 요약하거나 수치를 고치지 않고 그대로 나눠 담습니다. 위치는 문단 순번으로 기록합니다.'),
      field('제목', title),
      h('div.field-row', field('형식', type), field('발행처', publisher), field('발행일', publishedAt)),
      field('원문 URL', url),
      field('본문', markdown),
      h('div.row-actions.end',
        h('button.btn.ghost', { type: 'button', onclick: () => dialog.close() }, '취소'),
        h('button.btn', { type: 'submit' }, '추가'))));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}
