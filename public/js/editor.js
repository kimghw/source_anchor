// 1열 편집기 — 문장 단위 편집기. 클릭: 작성 근거 보기 · 더블클릭: 고치기 · 끌기: 옮기기·다른 열로 넘기기
import { allSentences } from '../shared/model.js';
import { SENTENCE_TYPES, STATUS } from '../shared/text.js';
import { collapseButton } from './columns.js';
import { dropZone, startDrag } from './dnd.js';
import {
  addDraftSentence, attach, check, citedAnchors, deleteSentences, discardLastChange, findSentence, headingSentencesIn, inDocOrder, insertAnchors,
  insertProposals, moveSentences, on, selectDoc, setBlockKind, setTitle, splitBlockAt, splitHeadingSentences, state, updateSentenceText,
} from './state.js';
import { blockKey, decide, diffText, isNewParagraph, markPlaced, newParagraphHome, pendingSuggestions } from './suggest.js';
import { fill, flash, h } from './util.js';

let scroller, page, caret, selbar, titleInput, suggbar;
let editing = null; // { id, draft, textEl }

const sentNode = id => page.querySelector(`.sent[data-sid="${id}"]`);

export function initEditor(root) {
  titleInput = h('input.doc-title', { type: 'text', placeholder: '문서 제목', 'aria-label': '문서 제목', onchange: () => setTitle(titleInput.value.trim()) });
  caret = h('div.drop-caret', { hidden: true });
  page = h('article.ed-page');
  suggbar = h('div.sugg-bar', { hidden: true });
  scroller = h('div.ed-scroll', { tabIndex: 0 }, suggbar, page);
  selbar = h('div.selbar', { hidden: true });
  root.append(
    h('header.col-head',
      h('div.col-title', h('span.col-index', '1'), '편집기'),
      h('div.col-hint', '클릭 근거 보기 · 더블클릭 편집 · 끌어서 이동·전달'), // 조작 묶음 밖에 두어 남는 폭만큼 줄여 보인다 — 조작이 다음 줄로 내려가지 않게
      h('div.col-head-actions', collapseButton(root, '1열 편집기'))),
    h('div.ed-title', titleInput),
    scroller,
    selbar,
  );

  page.addEventListener('click', onClick);
  page.addEventListener('dblclick', event => {
    const node = event.target.closest('.sent');
    if (node && !editing) startEdit(node.dataset.sid, event);
  });
  page.addEventListener('dragstart', onDragStart);
  scroller.addEventListener('keydown', onKeyDown);
  scroller.addEventListener('click', event => {
    if (event.target === scroller) selectDoc(null);
  });

  dropZone(scroller, {
    accepts: () => !editing,
    onOver: event => showCaret(dropPosition(event)),
    onLeave: () => { caret.hidden = true; },
    onDrop: (event, payload) => {
      const position = dropPosition(event);
      if (!position || position.noop) return;
      const target = { blockId: position.blockId, index: position.index, gap: position.gap };
      const ids = payload.from === 'source' ? insertAnchors(payload.anchors, target)
        : payload.from === 'proposal' ? insertProposals(payload.proposals, target)
        : moveSentences(payload.sentences, target);
      if (payload.suggestionIds) markPlaced(payload.suggestionIds, ids); // 채팅의 수정안을 직접 끌어다 놓은 경우
      revealSentences(ids);
    },
  });
  suggbar.addEventListener('click', event => {
    const all = event.target.closest('[data-sugg-all]');
    if (all) revealSentences(decide(pendingSuggestions(), all.dataset.suggAll === 'ok'));
  });

  on('doc', render);
  on('suggestions', render);
  on('select', updateSelection);
}

// 다른 열에서 문장을 넣은 뒤 그 문장을 보여 준다
export function revealSentences(ids) {
  requestAnimationFrame(() => {
    ids.forEach(id => flash(sentNode(id)));
    sentNode(ids[0])?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

// ───────────────────────────── 그리기 ─────────────────────────────

function render() {
  if (editing) return;
  if (document.activeElement !== titleInput) titleInput.value = state.doc.title;
  const gap = n => h('div.gap', { dataset: { gap: n } }, h('button.gap-add', { type: 'button', title: '여기에 새 문단' }, '＋ 문단'));
  const pending = pendingSuggestions();
  const ghosts = key => ghostParagraphs(pending.filter(s => isNewParagraph(s) && newParagraphHome(s) === key));
  // 기준 위치가 사라진 추가 제안은 문서 끝에 보여 준다
  const known = new Set(['start', ...state.doc.blocks.map(b => b.id)]);
  const orphans = ghostParagraphs(pending.filter(s => isNewParagraph(s) && !known.has(newParagraphHome(s))));
  // 빈 문서: 어디서부터 쓸지 알려 준다
  const empty = !state.doc.blocks.length && !pending.length && h('div.ed-empty',
    h('div.empty-icon', { 'aria-hidden': 'true' }, '▤'),
    h('h2', '첫 문장부터, 차근차근'),
    h('p', '직접 쓰거나 에이전트와 초안을 시작하세요. 원문의 문장과 표를 끌어와 근거를 연결할 수도 있습니다.'),
    h('button.btn', { type: 'button', dataset: { firstParagraph: '1' } }, '＋ 첫 문단 쓰기'));
  page.replaceChildren(caret, ...(empty ? [empty] : []), gap(0), ...ghosts('start'), ...state.doc.blocks.flatMap((block, i) => [renderBlock(block, pending), ...ghosts(block.id), gap(i + 1)]), ...orphans);
  renderSuggbar(pending);
  updateSelection();
}

// ───────────────────────────── 에이전트 수정안 ─────────────────────────────

const OP_LABEL = { replace: '수정', insert: '추가', delete: '삭제' };

// 검토할 수정안이 있는 동안 편집기 위에 고정해 두는 막대
function renderSuggbar(pending) {
  suggbar.hidden = !pending.length;
  if (!pending.length) return;
  fill(suggbar,
    h('span.sugg-bar-text', h('strong', `에이전트 수정안 ${pending.length}건`), ' · 문장마다 ✓ 반영 / ✕ 거부, 문단 단위로도 처리할 수 있습니다'),
    h('button.btn.small', { type: 'button', dataset: { suggAll: 'ok' } }, '모두 반영'),
    h('button.btn.small.ghost', { type: 'button', dataset: { suggAll: 'no' } }, '모두 거부'));
}

function suggestionTitle(s) {
  return [`${s.model} 수정안 (${OP_LABEL[s.op]})`, s.reason, s.op !== 'delete' && `규칙 검사: ${STATUS[s.status].label}`, ...s.problems].filter(Boolean).join('\n');
}

const suggestionActions = s => h('span.sugg-actions',
  h('button.sugg-ok', { type: 'button', title: '이 수정안 반영', dataset: { suggOk: s.id } }, '✓'),
  h('button.sugg-no', { type: 'button', title: '이 수정안 거부', dataset: { suggNo: s.id } }, '✕'));

// 추가·수정 제안 문장 — 아직 보고서에 없는 글
function suggestionNode(s, parts) {
  const bad = s.status === 'mismatch' || s.status === 'missing';
  return h('span.sugg', { class: `sugg-${s.op}`, title: suggestionTitle(s), dataset: { sugg: s.id } },
    h('span.sugg-text', parts),
    bad && h('sup.cite.sugg-bad', STATUS[s.status].label),
    suggestionActions(s));
}

const blockSuggestionBar = (key, count) => h('div.blk-sugg',
  h('span', `이 문단 수정안 ${count}건`),
  h('button', { type: 'button', dataset: { suggBlock: key, accept: '1' } }, '✓ 문단 반영'),
  h('button', { type: 'button', dataset: { suggBlock: key } }, '✕ 문단 거부'));

// 새 문단으로 들어올 추가 제안 — 에이전트가 제안한 문단·제목 구조대로 나눠 보여 준다 (FR-WB-034)
function ghostParagraphs(list) {
  const groups = new Map();
  for (const s of list) groups.set(blockKey(s), [...(groups.get(blockKey(s)) || []), s]);
  return [...groups].map(([key, items]) => {
    const body = h(items[0].block === 'heading' ? 'h2.blk-body' : 'p.blk-body');
    items.forEach((s, i) => body.append(i ? ' ' : '', suggestionNode(s, [s.text])));
    return h('div.blk.blk-ghost', blockSuggestionBar(key, items.length), body);
  });
}

// ───────────────────────────── 문단 · 문장 ─────────────────────────────

function renderBlock(block, pending) {
  const heading = block.kind === 'heading';
  const body = h(heading ? 'h2.blk-body' : 'p.blk-body');
  const mine = pending.filter(s => !isNewParagraph(s) && blockKey(s) === block.id);
  block.sentences.forEach((s, i) => {
    const change = mine.find(x => x.sentenceId === s.id);
    body.append(i ? ' ' : '', renderSentence(s, heading, change));
    if (change?.op === 'replace') body.append(' ', suggestionNode(change, diffText(s.text, change.text).filter(d => d.kind !== 'del').map(d => (d.kind === 'ins' ? h('ins', d.text) : d.text))));
    for (const added of mine.filter(x => x.op === 'insert' && x.after === s.id)) body.append(' ', suggestionNode(added, [added.text]));
  });
  if (!heading) body.append(' ', h('button.add-sent', { type: 'button', title: '이 문단에 문장 추가' }, '＋'));
  const mixed = headingSentencesIn(block); // 한 문단으로 뭉친 글에 섞인 제목 줄 — 한 번에 제목 블록으로 나눈다 (FR-WB-026)
  return h(`div.blk.blk-${block.kind}`, { dataset: { bid: block.id } },
    mine.length > 1 && blockSuggestionBar(block.id, mine.length),
    mixed.length > 0 && h('div.blk-sugg.blk-split',
      h('span', `이 문단에 제목 줄 ${mixed.length}개가 섞여 있습니다`),
      h('button', { type: 'button', title: mixed.map(s => s.text).join('\n'), dataset: { splitHeadings: block.id } }, 'H 제목 블록으로 나누기')),
    h('button.blk-kind', { type: 'button', title: heading ? '제목 → 문단으로 바꾸기' : '문단 → 제목으로 바꾸기' }, heading ? 'H' : '¶'),
    body);
}

function renderSentence(s, heading, change) {
  const result = check(s);
  const status = heading ? 'na' : result.status;
  const node = h('span.sent', { class: `st-${status}` + (change ? ` has-sugg has-sugg-${change.op}` : ''), draggable: true, dataset: { sid: s.id } });
  if (!heading && (s.type === 'interpretation' || s.type === 'proposal')) node.append(h('span.sent-tag', { title: SENTENCE_TYPES[s.type].hint }, SENTENCE_TYPES[s.type].label));
  // 수정안이 걸린 문장은 수치 표시 대신 지워질 부분을 보여 준다
  const parts = change?.op === 'replace' ? diffText(s.text, change.text).filter(d => d.kind !== 'ins').map(d => (d.kind === 'del' ? h('del', d.text) : d.text))
    : change?.op === 'delete' ? [h('del', s.text)]
    : figureSpans(s.text, result.numbers, status);
  node.append(h('span.sent-text', parts));
  if (status !== 'na') {
    const count = result.evidence.length;
    node.append(h('sup.cite', { title: `${STATUS[status].label} — ${STATUS[status].hint}` }, status === 'missing' ? '근거 없음' : `⚓${count}`, status === 'mismatch' && ' 불일치', status === 'conflict' && ' 충돌', status === 'stale' && ' 재확인'));
  }
  if (change?.op === 'delete') node.append(h('span.sugg.sugg-delete', { title: suggestionTitle(change), dataset: { sugg: change.id } }, suggestionActions(change)));
  return node;
}

// 문장 안의 수치에 대조 결과를 표시한다
function figureSpans(text, numbers, status) {
  if (status === 'na') return [text];
  const parts = [];
  let at = 0;
  for (const num of numbers) {
    if (num.period) continue;
    parts.push(text.slice(at, num.start), h('span.fig', { class: num.problem ? 'fig-bad' : 'fig-ok', title: num.problem ? '근거와 일치하지 않는 수치' : '근거와 일치하는 수치' }, text.slice(num.start, num.end)));
    at = num.end;
  }
  parts.push(text.slice(at));
  return parts;
}

function updateSelection() {
  const selected = new Set(state.sel.doc);
  const cited = citedAnchors();
  const citing = new Set(state.sel.anchors.flatMap(a => cited.get(a) || []));
  for (const node of page.querySelectorAll('.sent')) {
    node.classList.toggle('is-selected', selected.has(node.dataset.sid));
    node.classList.toggle('is-primary', state.sel.doc.at(-1) === node.dataset.sid);
    node.classList.toggle('is-citing', citing.has(node.dataset.sid));
  }
  renderSelbar();
}

// 문단의 첫 문장이 아니고 제목이 아닐 때만 그 문장에서 문단을 나눌 수 있다 (FR-WB-025)
function canSplitAt(id) {
  const at = findSentence(id);
  return Boolean(at) && at.index > 0 && at.block.kind !== 'heading';
}

function renderSelbar() {
  const ids = state.sel.doc;
  selbar.hidden = !ids.length || Boolean(editing);
  if (selbar.hidden) return;
  fill(selbar,
    h('span.selbar-count', `문장 ${ids.length}개 선택`),
    h('button.btn.small', { type: 'button', onclick: () => attach(inDocOrder(ids).map(id => ({ kind: 'doc', id }))) }, '채팅에 첨부 →'),
    ids.length === 1 && h('button.btn.small.ghost', { type: 'button', onclick: () => startEdit(ids[0]) }, '편집'),
    ids.length === 1 && canSplitAt(ids[0]) && h('button.btn.small.ghost', { type: 'button', title: '이 문장부터 새 문단으로 나눕니다', onclick: () => splitBlockAt(ids[0]) }, '¶ 여기서 문단 나누기'),
    h('button.btn.small.ghost.danger', { type: 'button', onclick: () => deleteSentences(ids) }, '삭제'),
  );
}

// ───────────────────────────── 클릭 · 키보드 ─────────────────────────────

function onClick(event) {
  if (editing) return;
  const target = event.target;
  const pick = target.closest('[data-sugg-ok], [data-sugg-no], [data-sugg-block]');
  if (pick) {
    const pending = pendingSuggestions();
    const list = pick.dataset.suggBlock ? pending.filter(s => blockKey(s) === pick.dataset.suggBlock) : pending.filter(s => s.id === (pick.dataset.suggOk || pick.dataset.suggNo));
    return revealSentences(decide(list, Boolean(pick.dataset.suggOk || pick.dataset.accept)));
  }
  if (target.closest('.sugg')) return;
  if (target.closest('[data-first-paragraph]')) return openDraft({ gap: 0 });
  const blk = target.closest('.blk');
  if (target.closest('.add-sent')) return openDraft({ blockId: blk.dataset.bid, index: Infinity });
  if (target.closest('.gap-add')) return openDraft({ gap: Number(target.closest('.gap').dataset.gap) });
  if (target.closest('.blk-kind')) {
    const block = state.doc.blocks.find(b => b.id === blk.dataset.bid);
    return setBlockKind(block.id, block.kind === 'heading' ? 'paragraph' : 'heading');
  }
  const split = target.closest('[data-split-headings]');
  if (split) return splitHeadingSentences(split.dataset.splitHeadings);
  const node = target.closest('.sent');
  if (node) selectDoc(node.dataset.sid, event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'toggle' : 'single');
  else selectDoc(null);
}

function onKeyDown(event) {
  if (editing || event.target !== scroller) return;
  const order = allSentences(state.doc).map(s => s.id);
  const current = state.sel.doc.at(-1);
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
  if (step) {
    event.preventDefault();
    const next = order[current ? Math.max(0, Math.min(order.length - 1, order.indexOf(current) + step)) : 0];
    if (next) {
      selectDoc(next, event.shiftKey ? 'range' : 'single');
      sentNode(next)?.scrollIntoView({ block: 'nearest' });
    }
  } else if ((event.key === 'Enter' || event.key === 'F2') && current) {
    event.preventDefault();
    startEdit(current);
  } else if ((event.key === 'Delete' || event.key === 'Backspace') && state.sel.doc.length) {
    event.preventDefault();
    deleteSentences(state.sel.doc);
  } else if (event.key === 'Escape') {
    selectDoc(null);
  }
}

function onDragStart(event) {
  const node = event.target.closest?.('.sent');
  if (!node || editing) return event.preventDefault();
  const id = node.dataset.sid;
  const ids = state.sel.doc.includes(id) ? inDocOrder(state.sel.doc) : [id];
  startDrag(event, { from: 'doc', sentences: ids }, ids.map(i => findSentence(i).sentence.text).join(' '));
}

// ───────────────────────────── 문장 고치기 ─────────────────────────────

function openDraft(position) {
  const id = addDraftSentence(position);
  startEdit(id, null, true);
}

function startEdit(id, point, draft = false) {
  const node = sentNode(id);
  const at = findSentence(id);
  if (!node || !at) return;
  const textEl = node.querySelector('.sent-text');
  editing = { id, draft, textEl };
  node.classList.add('is-editing');
  node.draggable = false;
  textEl.textContent = at.sentence.text;
  textEl.contentEditable = 'plaintext-only';
  if (textEl.contentEditable !== 'plaintext-only') textEl.contentEditable = 'true';
  textEl.dataset.placeholder = '문장을 입력하세요 (Enter 확정 · Shift+Enter 줄 나누기 · Esc 취소)';
  textEl.focus();

  const range = point && caretRangeAt(point.clientX, point.clientY);
  const selection = getSelection();
  selection.removeAllRanges();
  if (range && textEl.contains(range.startContainer)) selection.addRange(range);
  else {
    selection.selectAllChildren(textEl);
    selection.collapseToEnd();
  }

  textEl.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return; // 한글 조합 중의 Enter 는 글자 확정이다
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      document.execCommand('insertLineBreak'); // 줄 나누기 — 확정할 때 줄마다 제목·문단으로 나뉜다 (FR-WB-026)
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const continueWriting = editing?.draft && textEl.innerText.trim();
      commitEdit();
      if (continueWriting) openDraft(null); // 새 문장은 Enter 로 이어 쓴다
      else scroller.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit();
    }
    event.stopPropagation();
  });
  textEl.addEventListener('paste', event => {
    event.preventDefault();
    // 줄 바꿈은 남긴다 — 붙여 넣은 글은 확정할 때 줄마다 제목·문단으로 나뉜다 (FR-WB-026)
    document.execCommand('insertText', false, event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' '));
  });
  textEl.addEventListener('blur', () => {
    if (editing?.textEl === textEl) commitEdit();
  });
  renderSelbar();
}

function commitEdit() {
  if (!editing) return;
  const { id, draft, textEl } = editing;
  editing = null;
  updateSentenceText(id, textEl.innerText, { draft }); // innerText 는 줄 바꿈(<br>)을 \n 으로 준다
  render();
}

function cancelEdit() {
  if (!editing) return;
  const { draft } = editing;
  editing = null;
  if (draft) discardLastChange();
  render();
  scroller.focus();
}

// ───────────────────────────── 놓을 위치 ─────────────────────────────

function caretRangeAt(x, y) {
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (!pos) return null;
    const range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
    return range;
  }
  return document.caretRangeFromPoint?.(x, y) ?? null;
}

// 포인터가 문장의 앞쪽 절반에 있으면 그 문장 앞, 뒤쪽 절반이면 뒤
function isBefore(node, x, y) {
  const textEl = node.querySelector('.sent-text');
  const range = caretRangeAt(x, y);
  if (range && textEl.contains(range.startContainer)) {
    const measure = document.createRange();
    measure.setStart(textEl, 0);
    measure.setEnd(range.startContainer, range.startOffset);
    return measure.toString().length < textEl.textContent.length / 2;
  }
  const first = node.getClientRects()[0];
  return Boolean(first) && y < first.bottom && x < first.left + first.width / 2;
}

function nearestSentence(blk, x, y) {
  let best = null;
  for (const node of blk.querySelectorAll('.sent')) {
    for (const rect of node.getClientRects()) {
      if (y < rect.top || y > rect.bottom) continue;
      const distance = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
      if (!best || distance < best.distance) best = { node, distance, before: x < rect.left };
    }
  }
  return best;
}

// { blockId, index } 또는 { gap } 에 표시용 rect 를 붙여 돌려준다
function dropPosition(event) {
  const { clientX: x, clientY: y } = event;
  const el = document.elementFromPoint(x, y);
  const gapEl = el?.closest('.gap');
  if (gapEl) return { gap: Number(gapEl.dataset.gap), line: gapEl.getBoundingClientRect() };

  const blk = el?.closest('.blk');
  if (!blk) {
    const last = state.doc.blocks.at(-1);
    const lastEl = [...page.querySelectorAll('.blk')].at(-1);
    if (last && last.kind !== 'heading' && lastEl) return endOfBlock(last, lastEl);
    return { gap: state.doc.blocks.length, line: [...page.querySelectorAll('.gap')].at(-1).getBoundingClientRect() };
  }
  const block = state.doc.blocks.find(b => b.id === blk.dataset.bid);
  if (block.kind === 'heading') return { gap: state.doc.blocks.indexOf(block) + 1, line: blk.nextElementSibling.getBoundingClientRect() };

  const direct = el.closest('.sent');
  const hit = direct ? { node: direct, before: isBefore(direct, x, y) } : nearestSentence(blk, x, y);
  if (!hit) return endOfBlock(block, blk);
  const index = block.sentences.findIndex(s => s.id === hit.node.dataset.sid);
  const rects = hit.node.getClientRects();
  const rect = hit.before ? rects[0] : rects[rects.length - 1];
  return { blockId: block.id, index: hit.before ? index : index + 1, bar: { x: hit.before ? rect.left - 2 : rect.right + 1, top: rect.top, height: rect.height } };
}

function endOfBlock(block, blk) {
  const lastSent = [...blk.querySelectorAll('.sent')].at(-1);
  const rect = lastSent ? [...lastSent.getClientRects()].at(-1) : blk.getBoundingClientRect();
  return { blockId: block.id, index: block.sentences.length, bar: { x: lastSent ? rect.right + 1 : rect.left, top: rect.top, height: lastSent ? rect.height : 24 } };
}

function showCaret(position) {
  if (!position) return;
  const origin = page.getBoundingClientRect();
  caret.hidden = false;
  caret.classList.toggle('is-line', Boolean(position.line));
  if (position.line) {
    Object.assign(caret.style, { left: `${position.line.left - origin.left}px`, top: `${position.line.top - origin.top + position.line.height / 2 - 1}px`, width: `${position.line.width}px`, height: '' });
  } else {
    Object.assign(caret.style, { left: `${position.bar.x - origin.left}px`, top: `${position.bar.top - origin.top}px`, height: `${position.bar.height}px`, width: '' });
  }
}
