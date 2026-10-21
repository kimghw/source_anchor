// DOM 헬퍼와 숫자 정렬 렌더링

// h('div.card.is-open', { title: '…', onclick }, ...children) — 문자열 자식은 텍스트 노드가 된다
export function h(spec, attrs, ...children) {
  const [tag, ...classes] = spec.split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');
  if (attrs != null && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'class') node.className += ' ' + value;
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat(Infinity).filter(c => c != null && c !== false));
  return node;
}

// replaceChildren 과 같지만 null·false 자식은 건너뛴다 (조건부 자식을 그대로 넘길 수 있다)
export function fill(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter(c => c != null && c !== false));
  return node;
}

export function debounce(fn, ms) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    return fn(...args);
  };
  return wrapped;
}

export function toast(message, kind = 'info') {
  const node = h('div.toast', { class: `toast-${kind}` }, message);
  document.getElementById('toasts').append(node);
  setTimeout(() => node.classList.add('is-leaving'), 3200);
  setTimeout(() => node.remove(), 3600);
}

export function formatDate(iso) {
  if (!iso) return '미상';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = n => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return iso.length > 10 ? `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
}

export function flash(node, className = 'is-flash') {
  if (!node) return;
  node.classList.remove(className);
  void node.offsetWidth; // 애니메이션을 다시 시작한다
  node.classList.add(className);
  node.addEventListener('animationend', () => node.classList.remove(className), { once: true });
}

// ───────────────────────────── 떠 있는 창 ─────────────────────────────
// 작성 화면 위에 떠 있는 창(position: fixed — 분기 질문 · 작성 근거)을 머리줄을 끌어 옮긴다.

// 머리줄은 늘 화면 안에 남긴다 — 다시 잡아 옮길 수 있게
export function placeWindow(win, left, top) {
  win.style.left = `${Math.max(0, Math.min(window.innerWidth - win.offsetWidth, left))}px`;
  win.style.top = `${Math.max(0, Math.min(window.innerHeight - 48, top))}px`;
}

// 머리줄의 pointerdown 에서 부른다. 머리줄 안의 버튼·선택 상자는 그대로 눌린다
export function moveWindow(win, event) {
  if (event.button !== 0 || event.target.closest('button, select')) return;
  const head = event.currentTarget;
  const dx = event.clientX - win.offsetLeft;
  const dy = event.clientY - win.offsetTop;
  event.preventDefault(); // 끄는 동안 글자가 선택되지 않게
  head.setPointerCapture(event.pointerId);
  const move = ev => placeWindow(win, ev.clientX - dx, ev.clientY - dy);
  const up = () => head.removeEventListener('pointermove', move);
  head.addEventListener('pointermove', move);
  head.addEventListener('pointerup', up, { once: true });
  head.addEventListener('pointercancel', up, { once: true });
}

// ───────────────────────────── 숫자 정렬 ─────────────────────────────
// 숫자는 오른쪽 정렬 + 고정폭 숫자(tabular-nums)로 두고, 소수부 칸의 폭을 열 단위로 맞춰 소수점 위치를 일치시킨다.

const NUMERIC = /^[-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;

export function isNumeric(text) {
  return NUMERIC.test(String(text ?? '').trim());
}

// 같은 열에 놓일 값들의 소수 자릿수 최댓값
export function fractionWidth(texts) {
  return Math.max(0, ...texts.filter(isNumeric).map(t => (String(t).trim().split('.')[1] || '').length));
}

export function alignedNumber(text, fracDigits = 0) {
  const raw = String(text ?? '').trim();
  if (!isNumeric(raw)) return h('span.num.num-text', raw);
  const [int, frac] = raw.replace(/^-/, '−').split('.');
  return h('span.num',
    h('span.num-int', int),
    fracDigits > 0 && h('span.num-frac', { style: `width:calc(${fracDigits}ch + 0.3em)` }, frac != null ? '.' + frac : ''));
}
