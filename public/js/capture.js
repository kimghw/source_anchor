// 화면 캡처 — 화면 전체를 브라우저의 탭 캡처(getDisplayMedia)로 실제 화면 그대로 떠서 PNG 로 클립보드에 넣는다 (FR-WB-082).
// DOM 을 다시 그리는 방식이 아니라 실제 픽셀이라 iframe 안의 PDF·웹 스냅샷과 스크롤 위치가 보이는 그대로 담긴다. 브라우저가 공유 확인 창을 한 번 띄운다.
import { h, toast } from './util.js';

// 상단 머리줄의 화면 전체 캡처 — button 은 누른 버튼(진행 중 표시)
export async function capture(label, button = null) {
  if (!navigator.mediaDevices?.getDisplayMedia) return toast('이 브라우저는 화면 캡처를 지원하지 않습니다.', 'error');
  button?.classList.add('is-busy');
  document.body.classList.add('is-capturing'); // 캡처 버튼은 그림에 남지 않게 숨긴다
  try {
    const blob = await grab();
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

// 이 탭을 공유해 영상 한 장을 받아 화면 전체를 그림으로 만든다.
async function grab() {
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
    const canvas = h('canvas', { width: Math.round(window.innerWidth * scale), height: Math.round(window.innerHeight * scale) });
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
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
