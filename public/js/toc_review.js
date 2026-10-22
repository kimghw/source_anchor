// 목차 수정안 검토 의견 (FR-WB-103, ERR-WB-017) — 보고서 화면 2열 목차 수정안 카드의 반영·거부·추가의견 칸과 「수정안 검토 의견」 기록.
// 칸을 연 수정안(또는 묶음)은 review 에 고른 결정('accept' | 'reject' | 'comment')을 들고, 칸 요소는 대상마다 다시 써서 카드를 다시 그려도 쓰던 글과 초점을 잃지 않는다.
// 의견은 POST /api/books/<M>/review-notes 로 그 보고서의 작성요령 요청 문서에 한 줄씩 더한다 — 남기지 못해도 결정은 그대로 한다.
// book_chat.js 가 쓴다 — 화면 모듈을 import 하지 않는다
import { api } from './state.js';
import { h } from './util.js';

export const REVIEW_LIMIT = 1000; // lib/guide_notes.js 의 한도와 같다
const KINDS = {
  accept: { submit: '✓ 반영', label: '반영 의견', placeholder: '적으면 작성요령 「수정안 검토 의견」에 남아 에이전트가 참조합니다' },
  reject: { submit: '✕ 거부', label: '거부 사유', placeholder: '적으면 작성요령 「수정안 검토 의견」에 남아 같은 제안을 막습니다' },
  comment: { submit: '💬 의견 보내기', label: '추가의견', placeholder: '에이전트에게 보내 고친 수정안을 받습니다 — 작성요령에도 남습니다', required: true },
};
const panels = new WeakMap(); // 대상(수정안·묶음) → { kind, el, input, check, submit, cancel, blocked }
let focusOwner = null; // 초점을 가질 칸 하나 — 새로 연 칸이거나 마지막으로 초점을 받은 칸

// 열린 칸 — submit(comment) 는 결정을 하고 칸을 닫는다(대상의 review 를 지운다), cancel() 은 칸만 닫는다. blocked: 지금 낼 수 없으면 그 사유
export function reviewPanel(target, { submit, cancel, blocked = '', title = '' }) {
  const kind = KINDS[target.review];
  let entry = panels.get(target);
  if (!entry || entry.kind !== target.review) {
    const input = h('textarea.review-input', { rows: 2, placeholder: kind.placeholder, 'aria-label': kind.label });
    const error = h('div.review-error', { hidden: true });
    const send = h('button.btn.small', { type: 'button' }, kind.submit);
    const check = () => {
      const text = input.value.trim();
      const over = text.length > REVIEW_LIMIT;
      error.hidden = !over;
      error.textContent = over ? `의견은 ${REVIEW_LIMIT.toLocaleString()}자까지입니다 (${text.length.toLocaleString()}자)` : '';
      send.disabled = Boolean(entry.blocked) || over || (kind.required && !text);
      send.title = entry.blocked || '';
    };
    const go = () => {
      check();
      if (send.disabled) return;
      entry.submit(input.value.trim());
    };
    input.addEventListener('input', check);
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); entry.cancel(); }
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); go(); }
    });
    input.addEventListener('focus', () => { focusOwner = entry; });
    // 카드를 다시 그리며 떼었다 붙일 때도 blur 가 온다 — 다 그린 뒤에도 다른 곳에 초점이 있을 때만 놓는다
    input.addEventListener('blur', () => setTimeout(() => { if (focusOwner === entry && document.activeElement !== input) focusOwner = null; }));
    send.addEventListener('click', go);
    const close = h('button.btn.small.ghost', { type: 'button', onclick: () => entry.cancel() }, '취소');
    entry = { kind: target.review, input, check, el: h('div.review-panel', h('div.review-label', kind.label, !kind.required && h('span.muted', ' · 비워도 됩니다')), input, error, h('div.review-actions', send, close)) };
    panels.set(target, entry);
    focusOwner = entry;
  }
  Object.assign(entry, { submit, cancel, blocked });
  entry.el.title = title;
  entry.check();
  if (focusOwner === entry) queueMicrotask(() => entry.input.isConnected && entry.input.focus({ preventScroll: true }));
  return entry.el;
}

// 결정과 함께 남긴 의견 — 대상의 reviewed: { action, comment, saving?, noted?, noteError? }
export function reviewResult(target) {
  const r = target.reviewed;
  if (!r?.comment) return null;
  return h('div.review-result',
    h('div.review-comment', h('strong', `${KINDS[r.action].label}: `), r.comment),
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
