// 화면 캡처 — 고른 범위(틀 하나·여러 틀·화면 전체)를 브라우저의 탭 캡처(getDisplayMedia)로 실제 화면 그대로 떠서 PNG 로 클립보드에 넣는다 (FR-WB-082).
// DOM 을 다시 그리는 방식이 아니라 실제 픽셀이라 iframe 안의 PDF·웹 스냅샷과 스크롤 위치가 보이는 그대로 담긴다. 브라우저가 공유 확인 창을 한 번 띄운다.
import { h, toast } from './util.js';

const FRAMES = '.col-explorer, .workspace:not([hidden]) > .col, .branch-window, .src-popup'; // 틀 — 0열 탐색기, 화면의 각 열, 떠 있는 창

// 카메라 버튼 — 화면 위에 고르기 막을 씌운다. 틀 하나를 누르면 그 틀, 끌어서 여러 틀에 걸치면 걸친 틀을 모두 담는 직사각형, "화면 전체"(Enter)는 화면 전체. Esc·틀 밖 누름은 취소.
export function pickCapture(button = null) {
  if (document.querySelector('.capture-pick')) return;
  const frames = [...document.querySelectorAll(FRAMES)].filter(el => !el.hidden && el.getBoundingClientRect().width > 0);
  const box = h('div.capture-pick-box', { hidden: true });
  const pick = h('div.capture-pick', { tabIndex: -1 },
    h('div.capture-pick-hint', '틀을 누르거나 끌어서 고르세요',
      h('button.btn.ghost.small', { type: 'button', dataset: { act: 'all' } }, '화면 전체'),
      h('button.btn.ghost.small', { type: 'button', dataset: { act: 'cancel' } }, '취소')),
    box);
  let start = null;
  let chosen = [];
  const finish = (rect, label) => { pick.remove(); if (rect) capture(label, button, rect); };
  const show = list => {
    chosen = list;
    box.hidden = !list.length;
    if (!list.length) return;
    const r = union(list);
    Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
  };
  const at = (x, y) => [document.elementsFromPoint(x, y).map(el => frames.find(f => f.contains(el))).find(Boolean)].filter(Boolean); // 겹치면 맨 위 틀(떠 있는 창)
  const across = (x, y) => frames.filter(f => {
    const r = f.getBoundingClientRect();
    return r.right > Math.min(start.x, x) && r.left < Math.max(start.x, x) && r.bottom > Math.min(start.y, y) && r.top < Math.max(start.y, y);
  });
  pick.addEventListener('pointermove', e => show(start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4 ? across(e.clientX, e.clientY) : at(e.clientX, e.clientY)));
  pick.addEventListener('pointerdown', e => {
    if (e.target.closest('.capture-pick-hint')) return;
    start = { x: e.clientX, y: e.clientY };
    pick.setPointerCapture(e.pointerId);
    show(at(e.clientX, e.clientY));
  });
  pick.addEventListener('pointerup', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act && e.target.closest('.capture-pick-hint')) return;
    start = null;
    if (act === 'all') return finish(fullRect(), '화면 전체');
    if (act === 'cancel' || !chosen.length) return finish(null);
    finish(union(chosen), chosen.map(f => f.getAttribute('aria-label') || '틀').join('·'));
  });
  pick.addEventListener('keydown', e => {
    if (e.key === 'Escape') finish(null);
    else if (e.key === 'Enter') finish(fullRect(), '화면 전체');
  });
  document.body.append(pick);
  pick.focus();
}

const fullRect = () => ({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });

// 틀들을 모두 담는 직사각형 — 화면 밖으로 나간 부분은 자른다
function union(list) {
  const rects = list.map(f => f.getBoundingClientRect());
  const x = Math.max(0, Math.min(...rects.map(r => r.left)));
  const y = Math.max(0, Math.min(...rects.map(r => r.top)));
  const right = Math.min(window.innerWidth, Math.max(...rects.map(r => r.right)));
  const bottom = Math.min(window.innerHeight, Math.max(...rects.map(r => r.bottom)));
  return { x, y, width: right - x, height: bottom - y };
}

// rect(CSS 픽셀, 화면 기준) 영역을 캡처한다 — 없으면 화면 전체. button 은 누른 버튼(진행 중 표시)
export async function capture(label, button = null, rect = null) {
  if (!navigator.mediaDevices?.getDisplayMedia) return toast('이 브라우저는 화면 캡처를 지원하지 않습니다.', 'error');
  button?.classList.add('is-busy');
  document.body.classList.add('is-capturing'); // 캡처 버튼은 그림에 남지 않게 숨긴다
  try {
    const blob = await grab(rect || fullRect());
    const name = `SourceAnchor ${label} ${stamp()}.png`;
    if (await toClipboard(blob)) toast(`${label} 캡처를 클립보드에 복사했습니다.`);
    else {
      download(blob, name);
      toast(`클립보드에 넣지 못해 파일로 내려받습니다: ${name}`);
    }
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'AbortError') return toast('캡처를 취소했습니다.'); // 공유 확인을 취소했다 — 아무것도 바꾸지 않는다
    toast(`캡처하지 못했습니다: ${err.message}`, 'error');
  } finally {
    document.body.classList.remove('is-capturing');
    button?.classList.remove('is-busy');
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 이 탭을 공유해 영상 한 장을 받아 rect 영역만 잘라 그림으로 만든다.
async function grab(rect) {
  // 크기를 주지 않으면 브라우저가 영상을 줄여 보낼 수 있다 — 화면의 실제 픽셀 크기를 요청한다
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'browser', width: { ideal: Math.round(window.innerWidth * devicePixelRatio) }, height: { ideal: Math.round(window.innerHeight * devicePixelRatio) } }, audio: false,
    preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude', // 확인 창에 지금 이 탭만 보이게 (Chromium)
  });
  const video = h('video', { muted: true, playsInline: true });
  try {
    video.srcObject = stream;
    await video.play();
    // 공유가 시작되면 브라우저가 "이 탭을 공유 중" 띠를 넣어 화면이 살짝 줄어들 수 있다 — 영상과 화면의 크기 비율이 가로·세로 같아지고 잠시 그대로일 때까지 기다린다
    let scale = 0;
    let stable = 0;
    for (let i = 0; i < 40 && stable < 3; i++) {
      await sleep(50);
      const sx = video.videoWidth / window.innerWidth;
      const sy = video.videoHeight / window.innerHeight;
      stable = video.videoWidth > 0 && Math.abs(sx - sy) < 0.01 && Math.abs(sx - scale) < 0.001 ? stable + 1 : 0;
      scale = sx;
    }
    if (!scale) throw new Error('화면 영상을 받지 못했습니다');
    const canvas = h('canvas', { width: Math.round(rect.width * scale), height: Math.round(rect.height * scale) });
    canvas.getContext('2d').drawImage(video, Math.round(rect.x * scale), Math.round(rect.y * scale), canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('그림을 만들지 못했습니다'))), 'image/png'));
  } finally {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  }
}

async function toClipboard(blob) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch {
    return false; // 창에 초점이 없거나 막혀 있다 — 파일로 대신한다
  }
}

function download(blob, name) {
  const link = h('a', { href: URL.createObjectURL(blob), download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function stamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
