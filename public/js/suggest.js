// 에이전트 수정안 — 에이전트는 보고서를 직접 고치지 않고 수정안(수정·추가·삭제)을 낸다.
// 사용자는 문장 하나씩, 문단 단위로, 또는 전체를 한꺼번에 반영하거나 거부한다. 반영은 실행 취소할 수 있다.
//
// 수정안 { id, batchId, op: replace|insert|delete, sentenceId, after, block, text, type, anchors, calc, reason,
//          status(규칙 검사), problems, before, decision: pending|accepted|rejected, resultId }
// 추가 수정안의 block: 'paragraph'(여기서 새 문단) · 'heading'(제목 하나짜리 블록) · null(앞 문장의 문단에 이어 쓴다) (FR-WB-034)
import { emit, findSentence, mutate, on, placeSentences, pruneEmptyBlocks, sentenceFromProposal, state } from './state.js';

export const pendingSuggestions = () => state.suggestions.filter(s => s.decision === 'pending');

export function addBatch({ id, model, items }) {
  for (const item of items) {
    // 같은 문장에 대한 앞선 수정안은 새 수정안이 대신한다
    if (item.sentenceId) for (const old of pendingSuggestions()) if (old.sentenceId === item.sentenceId) old.decision = 'rejected';
    state.suggestions.push({ ...item, batchId: id, model, decision: 'pending', resultId: null });
  }
  emit('suggestions');
}

// 같은 자리(after)에 들어갈 추가 수정안을 제안 순서대로 문단으로 나눈다.
// block 표시가 있는 문장과 제목 바로 다음 문장에서 새 문단이 시작된다 → { siblings, paras: 문장마다 문단 순번, me }
function paragraphsAround(s) {
  const siblings = state.suggestions.filter(x => x.batchId === s.batchId && x.op === 'insert' && x.after === s.after);
  let n = 0;
  const paras = siblings.map((x, i) => (i && (x.block || siblings[i - 1].block === 'heading') ? ++n : n));
  return { siblings, paras, me: siblings.indexOf(s) };
}

// 기존 문단에 이어 붙는 문장인가: 문장 뒤(after 가 문장 ID)에 넣는 첫 문단이고 새 문단 표시가 없을 때만
function joinsExisting(s, { siblings, paras, me }) {
  return paras[me] === 0 && !siblings[0].block && Boolean(findSentence(s.after));
}

// 수정안이 속한 문단: 기존 문단 ID, 또는 새 문단이면 "new:<묶음>:<after>:<문단 순번>"
export function blockKey(s) {
  if (s.op !== 'insert') return findSentence(s.sentenceId)?.block.id ?? null;
  if (s.after == null) return null; // 사용자가 직접 위치를 정하는 문장
  const around = paragraphsAround(s);
  return joinsExisting(s, around) ? findSentence(s.after).block.id : `new:${s.batchId}:${s.after}:${around.paras[around.me]}`;
}

export const isNewParagraph = s => s.op === 'insert' && s.after != null && !joinsExisting(s, paragraphsAround(s));

// 새 문단으로 들어올 수정안을 편집기의 어느 자리에 보여 줄지: 'start' 또는 그 뒤에 놓일 문단 ID (사라진 자리면 after 그대로)
export const newParagraphHome = s => (s.after === 'start' ? 'start' : findSentence(s.after)?.block.id ?? s.after);

// 같은 위치에 넣을 문장들이 제안된 문단에 제안 순서대로 놓이도록, 이미 반영한 앞뒤 문장을 기준으로 자리를 잡는다.
// 어떤 순서로 몇 개만 반영해도 같다 (FR-WB-034).
function insertPosition(s) {
  const around = paragraphsAround(s);
  const { siblings, paras, me } = around;
  const placedAt = x => (x.decision === 'accepted' && x.resultId ? findSentence(x.resultId) : null);
  const kind = s.block === 'heading' ? 'heading' : 'paragraph';
  const blockIndex = at => state.doc.blocks.indexOf(at.block);
  // 같은 문단에서 이미 반영한 문장이 있으면 그 옆
  for (let i = me - 1; i >= 0 && paras[i] === paras[me]; i--) {
    const at = placedAt(siblings[i]);
    if (at) return { blockId: at.block.id, index: at.index + 1 };
  }
  for (let i = me + 1; i < siblings.length && paras[i] === paras[me]; i++) {
    const at = placedAt(siblings[i]);
    if (at) return { blockId: at.block.id, index: at.index };
  }
  // 기존 문단에 이어 붙는 문장은 뒤 문단을 먼저 반영했더라도 그 문장(after) 뒤가 제자리다
  const sentence = findSentence(s.after);
  if (joinsExisting(s, around)) return { blockId: sentence.block.id, index: sentence.index + 1 };
  // 이 문단에서 처음 반영하는 문장: 앞서 반영한 문단 바로 뒤, 없으면 뒤에 반영한 문단 바로 앞에 새 문단
  for (let i = me - 1; i >= 0; i--) {
    const at = placedAt(siblings[i]);
    if (at) return { gap: blockIndex(at) + 1, kind };
  }
  for (let i = me + 1; i < siblings.length; i++) {
    const at = placedAt(siblings[i]);
    if (at) return { gap: blockIndex(at), kind };
  }
  // 이 자리에서 처음 반영하는 문장: after 가 가리키는 곳
  if (s.after === 'start') return { gap: 0, kind };
  if (sentence) return { gap: blockIndex(sentence) + 1, kind };
  const index = state.doc.blocks.findIndex(b => b.id === s.after);
  return index >= 0 ? { gap: index + 1, kind } : null;
}

function apply(s) {
  if (s.op === 'insert') {
    const sentence = sentenceFromProposal(s);
    placeSentences([sentence], insertPosition(s));
    s.resultId = sentence.id;
    return;
  }
  const at = findSentence(s.sentenceId);
  if (!at) return;
  if (s.op === 'delete') {
    at.block.sentences.splice(at.index, 1);
    pruneEmptyBlocks();
    state.sel.doc = state.sel.doc.filter(id => id !== s.sentenceId);
    return;
  }
  const next = sentenceFromProposal(s);
  at.sentence.text = next.text;
  at.sentence.type = next.type;
  at.sentence.evidence = next.evidence;
  if (next.calc) at.sentence.calc = next.calc;
  else delete at.sentence.calc;
  s.resultId = at.sentence.id;
  state.sel.doc = [at.sentence.id];
  state.evidenceOpen = true;
}

// 여러 수정안을 한 번에 처리한다 — 반영은 실행 취소 한 단계로 묶인다
export function decide(suggestions, accept) {
  const targets = suggestions.filter(s => s.decision === 'pending');
  if (!targets.length) return [];
  if (accept) {
    mutate(() => {
      // 삭제를 마지막에 해야 "그 문장 뒤에 추가"가 자리를 잃지 않는다
      for (const s of [...targets].sort((a, b) => (a.op === 'delete') - (b.op === 'delete'))) {
        apply(s);
        s.decision = 'accepted';
      }
    });
  } else {
    for (const s of targets) s.decision = 'rejected';
  }
  emit('suggestions');
  return targets.map(s => s.resultId).filter(Boolean);
}

// 끌어다 놓기 등으로 사용자가 직접 넣은 수정안을 반영됨으로 표시한다
export function markPlaced(ids, resultIds) {
  ids.forEach((id, i) => {
    const s = state.suggestions.find(x => x.id === id);
    if (s) Object.assign(s, { decision: 'accepted', resultId: resultIds[i] ?? null });
  });
  emit('suggestions');
}

// 대상 문장이 사라진 수정안은 더 검토할 수 없으므로 닫는다
on('doc', () => {
  let changed = false;
  for (const s of pendingSuggestions()) {
    if (s.op !== 'insert' && !findSentence(s.sentenceId)) {
      s.decision = 'rejected';
      changed = true;
    }
  }
  if (changed) emit('suggestions');
});

// ───────────────────────────── 바뀐 부분 표시 ─────────────────────────────

// 두 문장을 토막(숫자·낱말·공백) 단위로 비교한다 → [{ kind: same|del|ins, text }]
export function diffText(before, after) {
  const split = text => text.match(/\d[\d,.]*|[^\s\d]+|\s+/g) || [];
  const a = split(before);
  const b = split(after);
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = [];
  const push = (kind, text) => (out.at(-1)?.kind === kind ? (out.at(-1).text += text) : out.push({ kind, text }));
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) push('same', a[i++]), j++;
    else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) push('del', a[i++]); // 지운 글을 먼저, 넣은 글을 뒤에
    else push('ins', b[j++]);
  }
  return out;
}
