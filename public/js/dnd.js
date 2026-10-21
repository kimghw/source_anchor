// 문장 넘기기 — 원문 문장·표 셀, 보고서 문장, 에이전트 제안을 끌어서 다른 열에 놓는다.
// payload: { from: 'source', anchors: [id] } | { from: 'doc', sentences: [id] } | { from: 'proposal', proposals: [...] }
import { h } from './util.js';

const MIME = 'application/x-sourceanchor';
let current = null; // dragover 중에는 dataTransfer 내용을 읽을 수 없어 따로 들고 있는다

export const dragging = () => current;

export function payloadCount(payload) {
  return (payload.anchors || payload.sentences || payload.proposals || []).length;
}

export function startDrag(event, payload, text) {
  current = payload;
  event.dataTransfer.effectAllowed = 'copyMove';
  event.dataTransfer.setData(MIME, JSON.stringify(payload));
  event.dataTransfer.setData('text/plain', text);
  const count = payloadCount(payload);
  const ghost = h('div.drag-ghost', h('span.drag-ghost-text', text), count > 1 && h('span.drag-ghost-count', String(count)));
  document.body.append(ghost);
  event.dataTransfer.setDragImage(ghost, 12, 12);
  // dragstart 안에서 화면을 바꾸면 브라우저가 끌기를 취소할 수 있어 한 박자 늦춘다
  setTimeout(() => {
    ghost.remove();
    if (current === payload) document.body.classList.add('is-dragging', `drag-from-${payload.from}`);
  });
}

window.addEventListener('dragend', endDrag);
window.addEventListener('drop', endDrag);
function endDrag() {
  current = null;
  document.body.classList.remove('is-dragging', 'drag-from-source', 'drag-from-doc', 'drag-from-proposal');
}

// accepts(payload) 가 참인 끌기만 받는다. onOver 는 놓을 위치 표시용, onDrop 에서 실제로 넘긴다.
export function dropZone(node, { accepts, onOver, onLeave, onDrop }) {
  let depth = 0;
  const leave = () => {
    depth = 0;
    node.classList.remove('is-drop-target');
    onLeave?.();
  };
  node.addEventListener('dragenter', event => {
    if (!current || !accepts(current)) return;
    event.preventDefault();
    depth++;
    node.classList.add('is-drop-target');
  });
  node.addEventListener('dragover', event => {
    if (!current || !accepts(current)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = current.from === 'doc' ? 'move' : 'copy';
    onOver?.(event, current);
  });
  node.addEventListener('dragleave', () => {
    if (current && --depth <= 0) leave();
  });
  node.addEventListener('drop', event => {
    if (!current || !accepts(current)) return;
    event.preventDefault();
    const payload = current;
    leave();
    onDrop(event, payload);
  });
  window.addEventListener('dragend', leave);
}
