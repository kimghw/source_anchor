// 열 배치 — 열 너비 손잡이, 열 접기·펴기(FR-WB-083), 열 비율 제안(FR-WB-084).
// 너비는 손잡이가 든 틀(.shell · 두 화면의 .workspace)의 CSS 변수 --w-<열> 로 두고 localStorage 'sa.widths' 에 남기며, 바꿀 때마다 모든 틀에 되돌린다.
// 접힘은 열 요소(id)마다 'sa.collapsed' 에 남긴다. 0열 탐색기는 두 화면이 같은 요소를 쓰므로 상태도 하나다.
import { h, toast } from './util.js';

const WIDTHS = 'sa.widths';
const COLLAPSED = 'sa.collapsed';
const GUTTER = 7; // .gutter 의 너비(px)
const LIMITS = { explorer: [200, 520], evidence: [260, 900], chat: [260, 900], sources: [260, 900] }; // 손잡이로 줄이고 늘릴 수 있는 한계
const load = key => { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } };
const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 남기지 못해도 화면은 그대로 쓴다 */ } };
let widths = load(WIDTHS);
let collapsed = load(COLLAPSED);
let columns = []; // 접을 수 있는 열 요소들

// 비율 제안 — 0열 / 1열 / 2열 / 3열, 합 100
export const RATIO_PRESETS = [
  { label: '균등', ratio: [25, 25, 25, 25] },
  { label: '편집기 넓게', ratio: [15, 55, 15, 15] },
  { label: '에이전트 넓게', ratio: [15, 40, 30, 15] },
  { label: '원문 넓게', ratio: [15, 40, 15, 30] },
];

// 저장한 너비·접힘을 되돌리고 손잡이를 붙인다. 접은 열은 머리줄(띠) 어디를 눌러도 펴지게 한다.
export function initColumns(cols) {
  columns = cols;
  applyWidths();
  initResizers();
  for (const root of columns) {
    root.classList.toggle('is-collapsed', Boolean(collapsed[root.id]));
    refreshButtons(root); // 초기화 때 이미 그려진 머리줄(편집기·채팅·원문)의 토글을 저장한 상태에 맞춘다
    root.addEventListener('click', event => {
      if (root.classList.contains('is-collapsed') && event.target.closest('.col-head')) setCollapsed(root, false);
    });
  }
  for (const host of new Set(columns.map(root => root.parentElement))) {
    relayout(host);
    // 작성 근거 열이 창으로 나가거나 닫히면(클래스·hidden 변화) 남는 폭을 가져갈 열을 다시 고른다 — 바뀐 값만 쓰므로 되풀이되지 않는다
    const observer = new MutationObserver(() => relayout(host));
    for (const col of host.querySelectorAll(':scope > .col')) observer.observe(col, { attributes: true, attributeFilter: ['class', 'hidden'] });
  }
}

// ───────────────────────────── 너비 ─────────────────────────────

const hosts = () => new Set([...document.querySelectorAll('.gutter')].map(g => g.parentElement));

function applyWidths() {
  for (const host of hosts()) for (const [name, width] of Object.entries(widths)) host.style.setProperty(`--w-${name}`, `${width}px`);
}

// 손잡이(.gutter)마다 이웃 열의 너비를 바꾼다 — 기본은 오른쪽 열, data-side="left" 면 왼쪽 열(0열 탐색기). 남는 폭은 편집기가 가져간다.
function initResizers() {
  for (const gutter of document.querySelectorAll('.gutter')) {
    gutter.addEventListener('pointerdown', event => {
      const name = gutter.dataset.resize;
      const left = gutter.dataset.side === 'left';
      const column = left ? gutter.previousElementSibling : gutter.nextElementSibling;
      const [min, max] = LIMITS[name] || [260, 900];
      const startX = event.clientX;
      const startWidth = column.getBoundingClientRect().width;
      gutter.setPointerCapture(event.pointerId);
      gutter.classList.add('is-active');
      const move = ev => {
        const delta = ev.clientX - startX;
        widths[name] = Math.round(Math.max(min, Math.min(max, startWidth + (left ? delta : -delta))));
        gutter.parentElement.style.setProperty(`--w-${name}`, `${widths[name]}px`);
      };
      const up = () => {
        gutter.classList.remove('is-active');
        gutter.removeEventListener('pointermove', move);
        save(WIDTHS, widths);
        applyWidths(); // 다른 화면의 틀에도 같은 너비
      };
      gutter.addEventListener('pointermove', move);
      gutter.addEventListener('pointerup', up, { once: true });
      gutter.addEventListener('pointercancel', up, { once: true });
    });
  }
}

// ───────────────────────────── 비율 제안 ─────────────────────────────

// 상단 머리줄의 열 비율 대화상자 — 미리 정한 비율을 제안하고 직접 적은 비율도 받는다 (FR-WB-084)
export function openRatioDialog() {
  const input = h('input', { type: 'text', placeholder: '예: 15/50/15/20', spellcheck: false, 'aria-label': '열 비율 직접 적기' });
  const dialog = h('dialog.dialog.ratio-dialog',
    h('h2', '열 비율'),
    h('p.muted', '0열 장 탐색기 / 1열 / 2열 에이전트 / 3열 원문의 가로 너비 비율입니다. 고르면 지금 화면 폭을 그 비율로 나눕니다 — 열의 최소 너비는 지키고 나머지는 1열이 가지며, 접힌 열은 펴집니다.'),
    h('div.ratio-list', RATIO_PRESETS.map(p => h('button.ratio-row', { type: 'button', onclick: () => { applyRatio(p.ratio); dialog.close(); } },
      h('span.ratio-bar', p.ratio.map((r, i) => h('span', { class: `seg-${i}`, style: `flex: ${r}` }, String(r)))),
      h('span.ratio-label', p.label, h('span.muted', ` ${p.ratio.join(' / ')}`))))),
    h('form.ratio-form', {
      onsubmit: event => {
        event.preventDefault();
        const ratio = parseRatio(input.value);
        if (!ratio) return toast('비율은 0열/1열/2열/3열 순서로 숫자 4개를 적어 주세요 — 예: 15/50/15/20', 'error');
        applyRatio(ratio);
        dialog.close();
      },
    }, h('label.field', '직접 적기 (0열/1열/2열/3열)', input), h('button.btn.small', { type: 'submit' }, '적용')),
    h('div.row-actions.end', h('button.btn.ghost', { type: 'button', onclick: () => dialog.close() }, '닫기')));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

// "15/50/15/20" · "15 50 15 20" · "15,50,15,20" — 양수 4개. 합은 100 으로 맞춘다.
export function parseRatio(text) {
  const nums = String(text).split(/[\/\s,:]+/).filter(Boolean).map(Number);
  if (nums.length !== 4 || nums.some(n => !Number.isFinite(n) || n <= 0)) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return nums.map(n => (n / sum) * 100);
}

// 화면 폭을 비율로 나눠 0·2·3열의 너비를 정한다 — 1열은 남는 폭이라 저절로 그 몫이 된다. 접힌 열은 편다.
export function applyRatio(ratio) {
  for (const root of columns) if (root.classList.contains('is-collapsed')) setCollapsed(root, false);
  const shell = document.querySelector('.shell');
  const evidence = document.getElementById('col-evidence');
  const docked = evidence && !evidence.hidden && !evidence.classList.contains('is-floating') ? evidence.getBoundingClientRect().width + GUTTER : 0;
  const total = shell.clientWidth - GUTTER * 3 - docked;
  const clamp = (name, share) => { const [min, max] = LIMITS[name]; return Math.round(Math.max(min, Math.min(max, (total * share) / 100))); };
  widths = { ...widths, explorer: clamp('explorer', ratio[0]), chat: clamp('chat', ratio[2]), sources: clamp('sources', ratio[3]) };
  save(WIDTHS, widths);
  applyWidths();
}

// ───────────────────────────── 접기·펴기 ─────────────────────────────

// 열 머리줄에 두는 토글 — 머리줄을 다시 그리는 열(탐색기·보고서 화면)도 있어 상태는 열 요소의 클래스에서 읽는다
export function collapseButton(root, label) {
  const on = root.classList.contains('is-collapsed');
  return h('button.icon-btn.collapse-btn', {
    type: 'button', title: on ? `${label} 펴기` : `${label} 접기 — 번호와 이름만 보이는 띠로 접습니다`, 'aria-label': on ? `${label} 펴기` : `${label} 접기`, 'aria-expanded': String(!on),
    onclick: event => { event.stopPropagation(); setCollapsed(root, !on); },
  }, on ? '»' : '«');
}

function setCollapsed(root, value) {
  root.classList.toggle('is-collapsed', value);
  collapsed[root.id] = value;
  save(COLLAPSED, collapsed);
  refreshButtons(root);
  relayout(root.parentElement);
}

// 머리줄에 이미 있는 토글을 지금 상태의 것으로 바꾼다 (이름표는 aria-label 에서 되찾는다)
function refreshButtons(root) {
  for (const button of root.querySelectorAll(':scope > .col-head .collapse-btn')) button.replaceWith(collapseButton(root, button.getAttribute('aria-label').replace(/ (접기|펴기)$/, '')));
}

// 접은 열의 손잡이는 숨기고, 남는 폭을 가져가던 열(편집기·목차)이 접혔으면 그 오른쪽의 펴 있는 열이 대신 가져간다
function relayout(host) {
  const cols = [...host.querySelectorAll(':scope > .col')];
  for (const gutter of host.querySelectorAll(':scope > .gutter')) {
    const column = gutter.dataset.side === 'left' ? gutter.previousElementSibling : gutter.nextElementSibling;
    if (!column || !(column.id in collapsed)) continue; // 접은 적 없는 열(작성 근거)의 손잡이는 그 열이 스스로 다룬다
    const hide = column.classList.contains('is-collapsed');
    if (gutter.hidden !== hide) gutter.hidden = hide;
  }
  const main = cols.find(col => col.classList.contains('col-editor') || col.classList.contains('col-chapters'));
  const fill = main?.classList.contains('is-collapsed')
    ? cols.slice(cols.indexOf(main) + 1).find(col => !col.hidden && !col.classList.contains('is-collapsed') && !col.classList.contains('is-floating'))
    : null;
  for (const col of cols) if (col.classList.contains('is-fill') !== (col === fill)) col.classList.toggle('is-fill', col === fill);
}
