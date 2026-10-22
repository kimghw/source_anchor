// 목차 수정안 검토 의견 (FR-WB-103, ERR-WB-017) — 보고서 화면 2열 목차 수정안 카드의 의견 칸·결정 단추와 「수정안 검토 의견」 기록.
// 의견 칸은 결정 단추 위에 늘 있고, 단추를 누르면 곧바로 결정한다 — 칸에 글이 있으면 그 글이 의견이 되고, 비어 있으면 의견 없이 결정만 한다.
// 칸 요소는 대상(수정안·묶음)마다 다시 써서 카드를 다시 그려도 쓰던 글과 초점을 잃지 않는다.
// 의견은 POST /api/books/<M>/review-notes 로 그 보고서의 작성요령 요청 문서에 한 줄씩 더한다 — 남기지 못해도 결정은 그대로 한다.
// book_chat.js 가 쓴다 — 화면 모듈을 import 하지 않는다
import { api } from './state.js';
import { fill, h } from './util.js';

export const REVIEW_LIMIT = 1000; // lib/guide_notes.js 의 한도와 같다
const LABELS = { accept: '반영 의견', reject: '거부 사유', comment: '추가의견' };
const boxes = new WeakMap(); // 대상(수정안·묶음) → { el, input, error, buttons, actions, check }
let focusOwner = null; // 다시 그린 뒤 초점을 되찾을 칸 하나 — 마지막으로 초점을 받은 칸

// 의견 칸 + 결정 단추 — actions: [{ text, primary?, title?, blocked?(지금 누를 수 없는 사유), needsText?(글이 있어야 누른다), run(comment) }].
// 단추는 누르는 즉시 run(칸의 글 — 비었으면 '') 을 부른다. 1,000자를 넘으면 모든 단추를 막고 사유를 보인다 (ERR-WB-017)
export function reviewBox(target, { label, placeholder, title = '', actions }) {
  let entry = boxes.get(target);
  if (!entry) {
    const input = h('textarea.review-input', { rows: 1, placeholder, 'aria-label': label });
    const error = h('div.review-error', { hidden: true });
    const buttons = h('div.review-actions');
    entry = { el: h('div.review-panel', input, error, buttons), input, error, buttons, actions: [] };
    entry.check = () => {
      const text = input.value.trim();
      const over = text.length > REVIEW_LIMIT;
      error.hidden = !over;
      error.textContent = over ? `의견은 ${REVIEW_LIMIT.toLocaleString()}자까지입니다 (${text.length.toLocaleString()}자)` : '';
      for (const a of entry.actions) {
        a.node.disabled = Boolean(a.blocked) || over || (a.needsText && !text);
        a.node.title = a.blocked || (a.needsText && !text ? '의견 칸에 적어야 보낼 수 있습니다' : a.title || '');
      }
    };
    input.addEventListener('input', entry.check);
    input.addEventListener('focus', () => { focusOwner = entry; });
    // 카드를 다시 그리며 떼었다 붙일 때도 blur 가 온다 — 다 그린 뒤에도 다른 곳에 초점이 있을 때만 놓는다
    input.addEventListener('blur', () => setTimeout(() => { if (focusOwner === entry && document.activeElement !== input) focusOwner = null; }));
    boxes.set(target, entry);
  }
  Object.assign(entry.input, { placeholder, title });
  entry.actions = actions.map(a => {
    const node = h(`button.btn.small${a.primary ? '' : '.ghost'}`, { type: 'button' }, a.text);
    node.addEventListener('click', () => {
      entry.check();
      if (!node.disabled) a.run(entry.input.value.trim());
    });
    return { ...a, node };
  });
  fill(entry.buttons, entry.actions.map(a => a.node));
  entry.check();
  if (focusOwner === entry) queueMicrotask(() => entry.input.isConnected && entry.input.focus({ preventScroll: true }));
  return entry.el;
}

// 결정과 함께 남긴 의견 — 대상의 reviewed: { action, comment, saving?, noted?, noteError? }
export function reviewResult(target) {
  const r = target.reviewed;
  if (!r?.comment) return null;
  return h('div.review-result',
    h('div.review-comment', h('strong', `${LABELS[r.action]}: `), r.comment),
    h('div.review-status', { class: r.noteError ? 'is-error' : '' },
      r.saving ? '작성요령에 남기는 중…' : r.noteError ? `작성요령에 남기지 못했습니다 — ${r.noteError}` : `작성요령 ${r.noted} 「수정안 검토 의견」에 남겼습니다`));
}

// 의견을 남긴다 → { noted: 문서 ID } 또는 { noteError }
export async function recordReview(bookId, action, what, comment) {
  try {
    const res = await api('POST', `/api/books/${encodeURIComponent(bookId)}/review-notes`, { action, what, comment });
    return { noted: res.guide.id, noteError: null };
  } catch (err) {
    return { noted: null, noteError: err.message };
  }
}

// 「수정안 검토 의견」의 한 줄에 적을 수정안 — 종류와 대상 (opLabel: 종류 이름)
export function reviewWhat(item, opLabel) {
  const chapter = `「${item.chapterTitle || item.chapterId}」(${item.chapterId})`;
  if (item.op === 'add') return `${opLabel} 「${item.title}」`;
  if (item.op === 'rename') return `${opLabel} ${chapter} → 「${item.title}」`;
  if (item.op === 'report_instructions') return opLabel;
  return `${opLabel} ${chapter}`;
}

// 「모두 반영」·「모두 거부」의 한 줄 — 묶음에서 그렇게 결정된 수정안 수와 종류별 수
export function reviewWhatAll(items, labelOf) {
  const counts = new Map();
  for (const item of items) counts.set(labelOf(item), (counts.get(labelOf(item)) || 0) + 1);
  return `목차 수정안 ${items.length}건 모두(${[...counts].map(([label, n]) => `${label} ${n}`).join('·')})`;
}
