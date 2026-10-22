// 열 배치 — 열 너비 손잡이, 열 접기·펴기(FR-WB-083), 열 비율 제안(FR-WB-084).
// 너비는 손잡이가 든 틀(.shell · 두 화면의 .workspace)의 CSS 변수 --w-<열> 로 두고 localStorage 'sa.widths' 에 남기며, 바꿀 때마다 모든 틀에 되돌린다.
// 접힘은 열 요소(id)마다 'sa.collapsed' 에 남긴다. 0열 탐색기는 두 화면이 같은 요소를 쓰므로 상태도 하나다.
import { h, toast } from './util.js';

const WIDTHS = 'sa.widths';
const COLLAPSED = 'sa.collapsed';
const LIMITS = { explorer: [200, 520], evidence: [260, 900], chat: [260, 900], sources: [260, 900] }; // 손잡이로 줄이고 늘릴 수 있는 한계
const load = key => { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } };
const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 남기지 못해도 화면은 그대로 쓴다 */ } };
let widths = load(WIDTHS);
let collapsed = load(COLLAPSED);
let columns = []; // 접을 수 있는 열 요소들

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

// 열린 열 구성에 맞춘 비율 제안 4가지 — 인자는 열린 열의 이름(0열·주 열이 접혔으면 비운다), 몫은 화면 왼쪽부터 [0열, 주 열, 곁 열…] 순서이고 합이 100 이다.
// 주 열은 남는 폭을 가지는 열(1열, 1열이 접혔으면 그 오른쪽의 첫 열린 열), 곁 열은 그 오른쪽의 열린 열이다.
export function ratioPresets(explorer, main, sides) {
  const [a, b] = sides;
  const rows = sides.length === 2 ? (explorer
    ? [['균등', 25, 25, 25, 25], [`${main} 넓게`, 15, 55, 15, 15], [`${a} 넓게`, 15, 40, 30, 15], [`${b} 넓게`, 15, 40, 15, 30]]
    : [['균등', 34, 33, 33], [`${main} 넓게`, 70, 15, 15], [`${a} 넓게`, 55, 30, 15], [`${b} 넓게`, 55, 15, 30]])
    : sides.length === 1 ? (explorer
      ? [['균등', 33, 34, 33], [`${main} 넓게`, 15, 65, 20], [`${main}·${a} 반반`, 15, 43, 42], [`${a} 넓게`, 15, 30, 55]]
      : [['균등', 50, 50], [`${main} 넓게`, 75, 25], [`${main} 조금 넓게`, 60, 40], [`${a} 넓게`, 35, 65]])
      : explorer && main ? [[`${explorer} 좁게`, 10, 90], [`${explorer} 보통`, 15, 85], [`${explorer} 넓게`, 20, 80], [`${explorer} 아주 넓게`, 25, 75]]
        : []; // 열린 열이 하나뿐이면 고를 비율이 없다
  return rows.map(([label, ...ratio]) => ({ label, ratio }));
}

// 지금 화면의 열 — 0열 탐색기와 보이는 작업 틀의 1·2·3열(작성 근거 열은 비율에 넣지 않는다). 주 열은 첫째로 열린 작업 열이다.
function screenColumns() {
  const host = document.querySelector('.shell > .workspace:not([hidden])');
  const all = [document.getElementById('explorer'), ...(host ? host.querySelectorAll(':scope > .col:not(.col-evidence)') : [])];
  const isOpen = col => !col.hidden && !col.classList.contains('is-collapsed');
  const main = all.slice(1).find(isOpen);
  const cols = all.map((el, index) => ({ el, index, name: columnName(el), open: isOpen(el), main: el === main }));
  return { all: cols, open: cols.filter(col => col.open) };
}

// 머리줄에 보이는 열 이름(번호·개수·선택 상자를 뺀 글) — 0열은 탭마다 제목이 달라 '탐색기'로 부른다
function columnName(col) {
  if (col.id === 'explorer') return '탐색기';
  const title = col.querySelector(':scope > .col-head .col-title');
  const text = title && [...title.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
  return text ? text.textContent.trim() : col.getAttribute('aria-label');
}

// 상단 머리줄의 열 비율 대화상자 — 지금 열린 열에 맞춘 비율을 제안하고 직접 적은 비율도 받는다. 접힌 열은 접힌 채 둔다 (FR-WB-084)
export function openRatioDialog() {
  const { all, open } = screenColumns();
  const explorer = open.find(col => col.el.id === 'explorer');
  const main = open.find(col => col.main);
  const presets = ratioPresets(explorer?.name, main?.name, open.filter(col => col !== explorer && col !== main).map(col => col.name));
  const order = open.map(col => `${col.index}열`).join('/');
  const closed = all.filter(col => !col.open && !col.el.hidden);
  const choose = ratio => { applyRatio(ratio, open); dialog.close(); };
  const input = h('input', { type: 'text', placeholder: `예: ${presets[1]?.ratio.join('/') || ''}`, spellcheck: false, 'aria-label': '열 비율 직접 적기' });
  const dialog = h('dialog.dialog.ratio-dialog',
    h('h2', '열 비율'),
    h('p.muted', `지금 열린 열(${open.map(col => `${col.index} ${col.name}`).join(' / ')})의 가로 너비 비율입니다.`,
      presets.length ? ` 고르면 지금 화면 폭을 그 비율로 나눕니다 — 열의 최소 너비는 지키고 나머지 폭은 ${main.index}열(${main.name})에 돌아갑니다.` : '',
      closed.length ? ` 접힌 열(${closed.map(col => `${col.index} ${col.name}`).join(', ')})은 접힌 채 둡니다.` : ''),
    presets.length
      ? h('div.ratio-list', presets.map(p => h('button.ratio-row', { type: 'button', onclick: () => choose(p.ratio) },
        h('span.ratio-bar', p.ratio.map((r, i) => h('span', { class: `seg-${open[i].index}${open[i].main ? ' is-main' : ''}`, style: `flex: ${r}`, title: `${open[i].index}열 ${open[i].name}` }, String(r)))),
        h('span.ratio-label', p.label, h('span.muted', ` ${p.ratio.join(' / ')}`)))))
      : h('p.ratio-empty', '열린 열이 하나뿐이라 고를 비율이 없습니다. 접힌 열의 띠를 눌러 펴면 비율을 고를 수 있습니다.'),
    presets.length ? h('form.ratio-form', {
      onsubmit: event => {
        event.preventDefault();
        const ratio = parseRatio(input.value, open.length);
        if (!ratio) return toast(`비율은 열린 열의 순서(${order})대로 숫자 ${open.length}개를 적어 주세요 — 예: ${presets[1].ratio.join('/')}`, 'error');
        choose(ratio);
      },
    }, h('label.field', `직접 적기 (${order})`, input), h('button.btn.small', { type: 'submit' }, '적용')) : null,
    h('div.row-actions.end', h('button.btn.ghost', { type: 'button', onclick: () => dialog.close() }, '닫기')));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

// "15/50/15/20" · "15 50 15 20" · "15,50,15,20" — 양수 count 개. 합은 100 으로 맞춘다.
export function parseRatio(text, count = 4) {
  const nums = String(text).split(/[\/\s,:]+/).filter(Boolean).map(Number);
  if (nums.length !== count || nums.some(n => !Number.isFinite(n) || n <= 0)) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return nums.map(n => (n / sum) * 100);
}

// 열린 열이 나눠 가질 폭을 비율로 나눠 주 열이 아닌 열린 열(0·2·3열)의 너비를 정한다 — 주 열은 남는 폭이라 저절로 그 몫이 된다.
// 나눌 폭은 열린 열이 지금 차지한 폭의 합이다 — 손잡이·접힌 띠·열로 넣은 작성 근거·틀의 여백은 저절로 빠지고, 틀이 넘쳐 가로로 밀렸으면 넘친 만큼 뺀다.
// 접힌 열은 접힌 채 두고 너비도 그대로 둔다.
export function applyRatio(ratio, open = screenColumns().open) {
  const overflow = el => (el ? Math.max(0, el.scrollWidth - el.clientWidth) : 0);
  const total = open.reduce((sum, col) => sum + col.el.getBoundingClientRect().width, 0)
    - overflow(document.querySelector('.shell')) - overflow(document.querySelector('.shell > .workspace:not([hidden])'));
  const clamp = (name, share) => { const [min, max] = LIMITS[name]; return Math.round(Math.max(min, Math.min(max, (total * share) / 100))); };
  open.forEach((col, i) => {
    const name = col.el.id === 'explorer' ? 'explorer' : col.el.classList.contains('col-chat') ? 'chat' : col.el.classList.contains('col-sources') ? 'sources' : null;
    if (name && !col.main) widths[name] = clamp(name, ratio[i]);
  });
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
