// 화면 전체가 공유하는 상태 · 보고서 변경(실행 취소 포함) · 서버 저장
import { allSentences, buildAnchorIndex, draftFromEvidence, evidenceFromAnchor, nextId } from '../shared/model.js';
import { headingText, splitSentences, verifySentence } from '../shared/text.js';
import { debounce, toast } from './util.js';

export const state = {
  sources: [],
  rejected: [], // 작성자가 채택을 거부한 자료 — 본문 없이 서지정보와 rejected { reason, at } 만 있다
  doc: { id: '', title: '', blocks: [] },
  evidence: {},
  anchors: new Map(), // 앵커 ID → { kind, source, block, sentence | cell … }
  sel: { doc: [], anchors: [] }, // 선택한 보고서 문장 ID · 원문 앵커 ID (마지막 항목이 기준)
  evidenceOpen: false,
  activeSourceId: null,
  docs: [], // 문서 목록 [{ id, title, updatedAt, sentences }]
  attachments: [], // 채팅에 첨부한 문장 [{ kind: 'doc' | 'anchor', id }]
  suggestions: [], // 에이전트 수정안 (suggest.js) — 저장하지 않는다
  saveState: 'saved',
};

const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, []);
  listeners.get(event).push(fn);
}
export function emit(event, detail) {
  for (const fn of listeners.get(event) || []) fn(detail);
}

// ───────────────────────────── 서버 ─────────────────────────────

export async function api(method, url, body) {
  const res = await fetch(url, { method, headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `요청 실패 (${res.status})`), { status: res.status }); // status: 409 처럼 사유별로 다르게 그릴 때 (note_cards.js)
  return data;
}

export function applyServerState(data) {
  save.cancel(); // 예약된 자동 저장이 방금 받은 서버 상태를 덮어쓰지 않게 한다
  state.sources = data.sources;
  state.rejected = data.rejected || [];
  state.doc = data.doc;
  state.evidence = data.evidence;
  state.docs = data.docs || [];
  state.custom = data.custom || []; // 이 보고서의 사용자 지정 문서 목록 — 0열 탭 (FR-WB-088)
  state.forms = data.forms || []; // 양식 요약 목록 — 작업공간 공통(모든 보고서에 같다), 0열 「장」 탭의 양식 묶음 (FR-WB-090)
  state.book = data.book || null; // 이 장이 속한 보고서와 그 목차 (FR-WB-073)
  state.instructions = data.instructions || ''; // 이 장의 지시문
  state.anchors = buildAnchorIndex(state.sources);
  state.sel = { doc: [], anchors: [] };
  state.attachments = [];
  state.suggestions = [];
  undoStack.length = redoStack.length = 0;
  emit('save');
  emit('docs');
  emit('sources');
  emit('doc');
  emit('select');
  emit('attachments');
}

// rejected 를 함께 넘기면 거부 목록도 바꾼다. 사라진 자료의 원문 위치는 선택·첨부에서도 뺀다.
export function setSources(sources, rejected = state.rejected) {
  state.sources = sources;
  state.rejected = rejected;
  state.anchors = buildAnchorIndex(sources);
  state.sel.anchors = state.sel.anchors.filter(id => state.anchors.has(id));
  const attached = state.attachments.filter(a => a.kind !== 'anchor' || state.anchors.has(a.id));
  const detached = attached.length !== state.attachments.length;
  state.attachments = attached;
  emit('sources');
  if (detached) emit('attachments');
}

function setSaveState(value) {
  state.saveState = value;
  emit('save');
}

const save = debounce(async () => {
  // 어떤 문장도 가리키지 않는 근거는 저장하지 않는다
  const used = new Set(allSentences(state.doc).flatMap(s => [...(s.evidence || []), ...Object.values(s.calc?.inputs || {}).map(i => i.ev)]));
  for (const id of Object.keys(state.evidence)) if (!used.has(id)) delete state.evidence[id];
  try {
    const saved = await api('PUT', '/api/report', { doc: state.doc, evidence: state.evidence });
    state.docs = saved.docs;
    emit('docs');
    setSaveState('saved');
  } catch (err) {
    setSaveState('error');
    toast(`저장하지 못했습니다: ${err.message}`, 'error');
  }
}, 600);

export const flushSave = () => (state.saveState === 'saved' ? Promise.resolve() : save.flush());

// ───────────────────────────── 변경 · 실행 취소 ─────────────────────────────

const undoStack = [];
const redoStack = [];
const snapshot = () => JSON.stringify({ doc: state.doc, evidence: state.evidence });

function restore(json) {
  const data = JSON.parse(json);
  state.doc = data.doc;
  state.evidence = data.evidence;
  const ids = new Set(allSentences(state.doc).map(s => s.id));
  state.sel.doc = state.sel.doc.filter(id => ids.has(id));
  changed();
}

function changed() {
  setSaveState('dirty');
  emit('doc');
  emit('select');
  save();
}

// 보고서를 바꾸는 모든 동작은 mutate 를 거친다 — 변경 전 상태를 실행 취소 스택에 남긴다
// merge: 바로 앞 변경과 한 단계로 묶는다 (빈 초안 문장을 만든 뒤 내용을 채우는 경우)
export function mutate(fn, { merge = false } = {}) {
  if (!merge) undoStack.push(snapshot());
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  const result = fn();
  changed();
  return result;
}

export function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
}

export function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
}

// 빈 초안 문장을 취소할 때: 마지막 변경을 다시 실행 목록에 남기지 않고 되돌린다
export function discardLastChange() {
  if (undoStack.length) restore(undoStack.pop());
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

// ───────────────────────────── 조회 ─────────────────────────────

export function findSentence(id) {
  for (const block of state.doc.blocks) {
    const index = block.sentences.findIndex(s => s.id === id);
    if (index >= 0) return { block, index, sentence: block.sentences[index] };
  }
  return null;
}

export const check = sentence => verifySentence(sentence, state.evidence);
export const primarySentence = () => findSentence(state.sel.doc.at(-1))?.sentence ?? null;

// 보고서가 인용한 앵커 → 그 앵커를 인용한 문장 ID 목록
export function citedAnchors() {
  const map = new Map();
  for (const s of allSentences(state.doc)) {
    for (const evId of s.evidence || []) {
      const anchorId = state.evidence[evId]?.anchorId;
      if (!anchorId) continue;
      if (!map.has(anchorId)) map.set(anchorId, []);
      map.get(anchorId).push(s.id);
    }
  }
  return map;
}

// 문서 순서로 정렬한 문장 ID
export function inDocOrder(ids) {
  const order = allSentences(state.doc).map(s => s.id);
  return [...new Set(ids)].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

export function inSourceOrder(ids) {
  const order = [...state.anchors.keys()];
  return [...new Set(ids)].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

// ───────────────────────────── 선택 ─────────────────────────────

// mode: 'single' | 'toggle'(Ctrl) | 'range'(Shift)
function pick(current, id, mode, order) {
  if (mode === 'toggle') return current.includes(id) ? current.filter(x => x !== id) : [...current, id];
  if (mode === 'range' && current.length) {
    const a = order.indexOf(current.at(-1));
    const b = order.indexOf(id);
    if (a >= 0 && b >= 0) {
      const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
      return [...current.filter(x => !range.includes(x)), ...(a < b ? range : range.reverse())];
    }
  }
  return [id];
}

export function selectDoc(id, mode = 'single') {
  state.sel.doc = id ? pick(state.sel.doc, id, mode, allSentences(state.doc).map(s => s.id)) : [];
  if (state.sel.doc.length) state.evidenceOpen = true;
  emit('select');
}

export function selectAnchor(id, mode = 'single') {
  state.sel.anchors = id ? pick(state.sel.anchors, id, mode, [...state.anchors.keys()]) : [];
  emit('select');
}

export function setEvidenceOpen(open) {
  state.evidenceOpen = open;
  emit('select');
}

// ───────────────────────────── 보고서 변경 ─────────────────────────────

function newSentenceId(extra = []) {
  return nextId('T', [...allSentences(state.doc).map(s => s.id), ...extra]);
}

// 같은 앵커를 가리키는 근거가 있으면 다시 쓰고, 없으면 새 E-번호를 매긴다
export function ensureEvidence(anchorId) {
  const existing = Object.values(state.evidence).find(ev => ev.anchorId === anchorId);
  if (existing) return existing.id;
  const record = evidenceFromAnchor(state.anchors, anchorId);
  if (!record) return null;
  const id = nextId('E', Object.keys(state.evidence));
  state.evidence[id] = { id, ...record };
  return id;
}

// position: { blockId, index } | { gap: n, kind? }(n 번째 블록 앞에 새 문단 — kind 가 'heading' 이면 제목) | null(선택한 문장 뒤, 없으면 문서 끝)
function resolvePosition(position) {
  if (position?.blockId) {
    const block = state.doc.blocks.find(b => b.id === position.blockId);
    if (block && block.kind !== 'heading') return { block, index: Math.min(position.index, block.sentences.length) };
    position = { gap: state.doc.blocks.indexOf(block) + 1 };
  }
  if (position?.gap == null) {
    const at = findSentence(state.sel.doc.at(-1));
    if (at && at.block.kind !== 'heading') return { block: at.block, index: at.index + 1 };
    const last = state.doc.blocks.at(-1);
    if (!at && last && last.kind !== 'heading') return { block: last, index: last.sentences.length };
    position = { gap: at ? state.doc.blocks.indexOf(at.block) + 1 : state.doc.blocks.length };
  }
  const block = { id: nextId('P', state.doc.blocks.map(b => b.id), 2), kind: position.kind === 'heading' ? 'heading' : 'paragraph', sentences: [] };
  state.doc.blocks.splice(position.gap, 0, block);
  return { block, index: 0 };
}

export function pruneEmptyBlocks(keep) {
  state.doc.blocks = state.doc.blocks.filter(b => b.sentences.length || b === keep);
}

// mutate 안에서 부른다: 문장들을 위치에 넣고 선택한다
export function placeSentences(sentences, position) {
  const { block, index } = resolvePosition(position);
  block.sentences.splice(index, 0, ...sentences);
  pruneEmptyBlocks(block);
  state.sel.doc = sentences.map(s => s.id);
  state.evidenceOpen = true;
  return sentences.map(s => s.id);
}

// 원문 문장·표 셀을 보고서 문장으로 넣는다 — 근거가 연결된 상태로 들어간다
export function insertAnchors(anchorIds, position) {
  return mutate(() => {
    const made = [];
    for (const anchorId of anchorIds) {
      const evId = ensureEvidence(anchorId);
      if (!evId) continue;
      const id = newSentenceId(made.map(s => s.id));
      made.push({ id, text: draftFromEvidence(state.evidence[evId]), type: 'fact', evidence: [evId] });
    }
    return placeSentences(made, position);
  });
}

// 제안 { text, type, anchors, calc } 을 보고서 문장으로 바꾼다 — 앵커 ID 로 적힌 근거·계산 입력에 E-번호를 매긴다 (mutate 안에서 부른다)
export function sentenceFromProposal(p, takenIds = []) {
  const evByAnchor = new Map(p.anchors.map(a => [a, ensureEvidence(a)]));
  const sentence = { id: newSentenceId(takenIds), text: p.text, type: p.type, evidence: [...evByAnchor.values()].filter(Boolean) };
  if (p.calc) {
    sentence.calc = { ...p.calc, inputs: Object.fromEntries(Object.entries(p.calc.inputs).map(([name, ref]) => [name, { ev: evByAnchor.get(ref.ev), n: ref.n || 0 }])) };
  }
  return sentence;
}

// 에이전트가 제안한 문장 [{ text, type, anchors, calc }] 을 넣는다
export function insertProposals(proposals, position) {
  return mutate(() => {
    const made = [];
    for (const p of proposals) made.push(sentenceFromProposal(p, made.map(s => s.id)));
    return placeSentences(made, position);
  });
}

export function moveSentences(ids, position) {
  return mutate(() => {
    // 옮길 문장을 빼기 전에, 같은 문단 안에서 앞쪽에 있던 문장 수만큼 삽입 위치를 당긴다
    let index = position?.index;
    if (position?.blockId) {
      const target = state.doc.blocks.find(b => b.id === position.blockId);
      index -= target.sentences.slice(0, position.index).filter(s => ids.includes(s.id)).length;
    }
    const moving = inDocOrder(ids).map(id => findSentence(id)?.sentence).filter(Boolean);
    for (const block of state.doc.blocks) block.sentences = block.sentences.filter(s => !ids.includes(s.id));
    return placeSentences(moving, position?.blockId ? { ...position, index } : position);
  });
}

export function deleteSentences(ids) {
  mutate(() => {
    for (const block of state.doc.blocks) block.sentences = block.sentences.filter(s => !ids.includes(s.id));
    pruneEmptyBlocks();
    state.sel.doc = [];
  });
}

const cleanLines = text => String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/\s+/g, ' ').trim());

// 여러 줄의 글을 블록 조각으로 나눈다: 제목 형태의 줄 → 제목, 빈 줄 → 문단 경계, 그 밖의 줄 → 이어지는 문단 (FR-WB-026).
// 번호 없는 짧은 줄은 바로 아래에 본문 줄이 이어질 때만 제목으로 본다 — 짧은 줄이 연달아 있으면 한 문단의 문장들이다.
export function linesToSegments(text) {
  const lines = cleanLines(text);
  const segments = []; // { kind: 'heading', text } | { kind: 'paragraph', sentences: [글…] }
  let open = null; // 이어 쓰는 문단
  lines.forEach((line, i) => {
    if (!line) { open = null; return; }
    const next = lines.slice(i + 1).find(Boolean);
    const heading = headingText(line) ?? (next && !headingText(next, { bare: true }) ? headingText(line, { bare: true }) : null);
    if (heading) { segments.push({ kind: 'heading', text: heading }); open = null; return; }
    if (!open) segments.push(open = { kind: 'paragraph', sentences: [] });
    open.sentences.push(...splitSentences(line));
  });
  return segments.filter(seg => seg.kind === 'heading' || seg.sentences.length);
}

// 문장을 고치면 여러 문장으로 나뉠 수 있다. 첫 조각이 원래 문장의 ID·근거를 이어받는다.
// 여러 줄이거나 제목 형태("1. 추진 배경", "## 개요")의 글은 줄마다 제목·문단 블록으로 나눠 넣는다 (FR-WB-026).
export function updateSentenceText(id, text, { draft = false } = {}) {
  const at = findSentence(id);
  if (!at) return;
  const heading = at.block.kind === 'heading';
  let segments = linesToSegments(text);
  if (heading && segments.length) {
    // 제목을 고칠 때 첫 줄은 그대로 제목이고, 더 적은 줄은 그 아래 새 블록이 된다(빈 줄은 문단 경계로 남는다)
    const lines = cleanLines(text);
    const firstAt = lines.findIndex(Boolean);
    segments = [{ kind: 'heading', text: lines[firstAt] }, ...linesToSegments(lines.slice(firstAt + 1).join('\n'))];
  }
  if (!segments.length) return draft ? discardLastChange() : deleteSentences([id]);
  if (segments.length > 1 || (segments[0].kind === 'heading') !== heading) return mutate(() => placeSegments(at, segments), { merge: draft });
  const pieces = heading ? [segments[0].text] : segments[0].sentences;
  if (pieces.length === 1 && pieces[0] === at.sentence.text) return;
  mutate(() => {
    at.sentence.text = pieces[0];
    const extra = [];
    for (const piece of pieces.slice(1)) extra.push({ id: newSentenceId(extra.map(s => s.id)), text: piece, type: 'fact', evidence: [] });
    at.block.sentences.splice(at.index + 1, 0, ...extra);
    state.sel.doc = [extra.at(-1)?.id ?? id];
  }, { merge: draft });
}

// mutate 안에서 부른다: 고친 문장의 자리에 조각들을 블록으로 넣는다. 첫 조각의 첫 문장이 원래 문장의 ID·근거를 이어받고,
// 원래 문단의 앞 문장들은 첫 문단 조각에, 뒤 문장들은 마지막 조각(제목이면 그 아래 새 문단)에 남는다.
function placeSegments(at, segments) {
  const { block, index } = at;
  const blocks = state.doc.blocks;
  const before = block.sentences.slice(0, index);
  const after = block.sentences.slice(index + 1);
  const takenBlocks = blocks.map(b => b.id);
  const newBlock = kind => {
    const blockId = nextId('P', takenBlocks, 2);
    takenBlocks.push(blockId);
    return { id: blockId, kind, sentences: [] };
  };
  const takenSentences = [];
  let last = at.sentence;
  let reused = false;
  const sentence = text => {
    if (reused) {
      last = { id: newSentenceId(takenSentences), text, type: 'fact', evidence: [] };
      takenSentences.push(last.id);
      return last;
    }
    reused = true;
    at.sentence.text = text;
    return at.sentence;
  };
  const made = segments.map((seg, k) => {
    const reuse = k === 0 && block.kind === seg.kind;
    const target = reuse ? block : newBlock(seg.kind);
    target.sentences = seg.kind === 'heading' ? [sentence(seg.text)] : [...(reuse ? before : []), ...seg.sentences.map(sentence)];
    return target;
  });
  if (made[0] !== block && before.length) made.unshift(Object.assign(block, { sentences: before }));
  if (after.length) {
    if (made.at(-1).kind === 'paragraph') made.at(-1).sentences.push(...after);
    else made.push(Object.assign(newBlock('paragraph'), { sentences: after }));
  }
  blocks.splice(blocks.indexOf(block), 1, ...made);
  state.sel.doc = [last.id];
  return last.id;
}

// 문단 안에 섞여 있는 제목 형태의 문장("1. 추진 배경") — 이미 한 문단으로 뭉친 글을 정리할 때 쓴다 (FR-WB-026)
export const headingSentencesIn = block => (block.kind === 'heading' ? [] : block.sentences.filter(s => headingText(s.text)));

// 그 문장들을 제목 블록으로 나눈다: 제목 하나마다 블록 하나, 그 사이의 문장들은 문단으로. 순서·근거 연결은 그대로, 실행 취소 한 단계.
export function splitHeadingSentences(blockId) {
  const block = state.doc.blocks.find(b => b.id === blockId);
  if (!block || !headingSentencesIn(block).length) return 0;
  return mutate(() => {
    const taken = state.doc.blocks.map(b => b.id);
    const newBlock = kind => {
      const id = nextId('P', taken, 2);
      taken.push(id);
      return { id, kind, sentences: [] };
    };
    const made = [];
    let open = null;
    let count = 0;
    for (const s of block.sentences) {
      const heading = headingText(s.text);
      if (heading) {
        s.text = heading;
        made.push(Object.assign(newBlock('heading'), { sentences: [s] }));
        open = null;
        count++;
      } else {
        if (!open) made.push(open = newBlock('paragraph'));
        open.sentences.push(s);
      }
    }
    if (made[0].kind === 'paragraph') made[0] = Object.assign(block, { sentences: made[0].sentences }); // 첫 조각이 문단이면 원래 블록을 지킨다
    state.doc.blocks.splice(state.doc.blocks.indexOf(block), 1, ...made);
    return count;
  });
}

// 빈 초안 문장을 만들고 ID 를 돌려준다 — 편집기가 곧바로 입력 상태로 연다
export function addDraftSentence(position) {
  return mutate(() => {
    const { block, index } = resolvePosition(position);
    const sentence = { id: newSentenceId(), text: '', type: 'fact', evidence: [] };
    block.sentences.splice(index, 0, sentence);
    state.sel.doc = [sentence.id];
    return sentence.id;
  });
}

export function setSentenceType(id, type) {
  mutate(() => { findSentence(id).sentence.type = type; });
}

export function setReviewed(id, reviewed) {
  mutate(() => {
    const { sentence } = findSentence(id);
    if (reviewed) sentence.reviewedText = sentence.text;
    else delete sentence.reviewedText;
  });
}

export function linkAnchors(sentenceId, anchorIds) {
  const at = findSentence(sentenceId);
  if (!at) return;
  mutate(() => {
    for (const anchorId of anchorIds) {
      const evId = ensureEvidence(anchorId);
      if (evId && !at.sentence.evidence.includes(evId)) at.sentence.evidence.push(evId);
    }
  });
}

export function unlinkEvidence(sentenceId, evId) {
  mutate(() => {
    const { sentence } = findSentence(sentenceId);
    sentence.evidence = sentence.evidence.filter(id => id !== evId);
    if (sentence.calc && Object.values(sentence.calc.inputs).some(i => i.ev === evId)) delete sentence.calc;
  });
}

export function setCalc(sentenceId, calc) {
  mutate(() => {
    const { sentence } = findSentence(sentenceId);
    if (calc) sentence.calc = calc;
    else delete sentence.calc;
  });
}

export function setBlockKind(blockId, kind) {
  mutate(() => {
    const block = state.doc.blocks.find(b => b.id === blockId);
    block.kind = kind;
    if (kind === 'heading' && block.sentences.length > 1) {
      // 제목은 한 문장만 담는다 — 나머지는 바로 아래 새 문단으로 내린다
      const rest = block.sentences.splice(1);
      state.doc.blocks.splice(state.doc.blocks.indexOf(block) + 1, 0, { id: nextId('P', state.doc.blocks.map(b => b.id), 2), kind: 'paragraph', sentences: rest });
    }
  });
}

// 고른 문장부터 새 문단으로 나눈다 — 문장 순서와 근거 연결은 그대로다 (FR-WB-025)
export function splitBlockAt(sentenceId) {
  const at = findSentence(sentenceId);
  if (!at || at.index === 0 || at.block.kind === 'heading') return;
  mutate(() => {
    const rest = at.block.sentences.splice(at.index);
    state.doc.blocks.splice(state.doc.blocks.indexOf(at.block) + 1, 0, { id: nextId('P', state.doc.blocks.map(b => b.id), 2), kind: 'paragraph', sentences: rest });
  });
}

export function setTitle(title) {
  if (title === state.doc.title) return;
  mutate(() => { state.doc.title = title; });
}

// ───────────────────────────── 채팅 첨부 ─────────────────────────────

export function attach(items) {
  for (const item of items) {
    if (!state.attachments.some(a => a.kind === item.kind && a.id === item.id)) state.attachments.push(item);
  }
  emit('attachments');
}

export function detach(item) {
  state.attachments = item ? state.attachments.filter(a => a !== item) : [];
  emit('attachments');
}
