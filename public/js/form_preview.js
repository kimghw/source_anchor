// 양식 미리보기 — 지금 값을 기입한 사본(서버 `/export` 응답)을 rhwp(public/vendor/rhwp — hwp·hwpx 를 쪽 단위 SVG 로 그리는 WebAssembly 렌더러)로 한글에서 보는 것처럼 그린다 (FR-WB-096).
// 읽기 전용이다 — 편집·번호 배지·지침은 1열 구조 보기(forms.js)에서 한다. 쪽은 보이는 것부터 그리고(IntersectionObserver), 값이 바뀌면(markStale) 다음에 보일 때 다시 받아 그린다.
// 렌더러는 처음 쓸 때 한 번만 내려받아 초기화한다. 화면 모듈을 import 하지 않는다.
import { fill, h } from './util.js';

export const previewable = format => format === 'hwp' || format === 'hwpx'; // docx 는 이 렌더러가 그리지 못한다 — 구조 보기만

const RHWP_JS = '../vendor/rhwp/rhwp.js';
const RHWP_WASM = new URL('../vendor/rhwp/rhwp_bg.wasm', import.meta.url);
const FONT_NOTE = '한컴 글꼴이 없는 PC 에서는 대체 글꼴로 그려져 줄 바꿈 자리가 한글과 조금 다를 수 있습니다';

let runtime = null; // Promise<{ HwpDocument }> — 실패하면 비워 다음에 다시 시도한다

function loadRuntime() {
  if (runtime) return runtime;
  runtime = (async () => {
    let ctx = null, lastFont = '';
    globalThis.measureTextWidth = (font, text) => { // 줄 바꿈·정렬 계산용 글자 폭 — WASM 초기화 전에 등록해야 한다
      ctx ??= document.createElement('canvas').getContext('2d');
      if (font !== lastFont) { ctx.font = font; lastFont = font; }
      return ctx.measureText(text).width;
    };
    const mod = await import(RHWP_JS);
    await mod.default({ module_or_path: RHWP_WASM });
    return mod;
  })();
  runtime.catch(() => { runtime = null; });
  return runtime;
}

// 기입한 사본 — 서버가 기입 + 재스캔 확인을 거쳐 내준다. 실패(409 등)의 사유는 JSON 의 error (FR-WB-092)
async function fetchFile(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `요청 실패 (${res.status})`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

// container 안에 상태 줄 + 쪽들. show(url) 은 같은 주소를 이미 그렸고 값이 바뀌지 않았으면 다시 받지 않는다. destroy() 는 문서를 놓아 준다(WASM 메모리)
export function formPreview(container) {
  let doc = null, url = null, stale = true, seq = 0, observer = null;
  const status = h('p.form-preview-status', { role: 'status' });
  const pages = h('div.form-preview-pages');
  fill(container, status, pages);

  const say = (text, error = false) => {
    status.textContent = text;
    status.classList.toggle('is-error', error);
  };
  const release = () => {
    observer?.disconnect();
    observer = null;
    try { doc?.free(); } catch { /* 이미 놓아 준 문서 */ }
    doc = null;
    pages.replaceChildren();
  };
  // 쪽 하나를 그려 넣고 SVG 의 크기를 자리 크기로 둔다 — 쪽마다 크기가 다를 수 있다(가로 쪽)
  const draw = (page, i) => {
    try {
      page.innerHTML = doc.renderPageSvg(i);
      const svg = page.firstElementChild;
      const w = Number(svg?.getAttribute('width')), hgt = Number(svg?.getAttribute('height'));
      if (w > 0 && hgt > 0) size(page, w, hgt);
      return [w, hgt];
    } catch (err) {
      page.replaceChildren(h('p.form-preview-fail', `${i + 1}쪽을 그리지 못했습니다 — ${err.message}`));
      return [0, 0];
    }
  };
  const size = (page, w, hgt) => {
    page.style.setProperty('--page-w', w);
    page.style.setProperty('--page-h', hgt);
  };

  async function show(next) {
    if (doc && !stale && next === url) return;
    url = next;
    stale = false;
    const my = ++seq;
    say('미리보기를 만드는 중 — 지금 값을 기입한 사본을 받아 그립니다…');
    try {
      const [{ HwpDocument }, bytes] = await Promise.all([loadRuntime(), fetchFile(next)]);
      if (my !== seq) return; // 그 사이 다른 양식을 열었거나 놓아 주었다
      release();
      doc = new HwpDocument(bytes);
      const n = doc.pageCount();
      const first = h('div.form-preview-page', { dataset: { page: 0 }, 'aria-label': '1쪽' });
      pages.append(first);
      const [w, hgt] = draw(first, 0); // 첫 쪽은 바로 — 그 크기를 아직 그리지 않은 쪽의 자리로 쓴다
      observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          draw(entry.target, Number(entry.target.dataset.page));
        }
      }, { root: container, rootMargin: '150% 0px' });
      for (let i = 1; i < n; i++) {
        const page = h('div.form-preview-page', { dataset: { page: i }, 'aria-label': `${i + 1}쪽` });
        if (w > 0 && hgt > 0) size(page, w, hgt);
        pages.append(page);
        observer.observe(page);
      }
      say(`${n}쪽 · 지금 값을 기입한 사본 · 읽기 전용 — ${FONT_NOTE}`);
    } catch (err) {
      if (my !== seq) return;
      stale = true; // 다음에 다시 시도한다
      say(`미리보기를 만들지 못했습니다 — ${err.message}`, true);
    }
  }

  return {
    show,
    markStale: () => { stale = true; },
    destroy: () => { seq++; release(); fill(container); },
  };
}
