// 작성요령 저장 카드 — 에이전트가 대화에서 정리한 작성자 요청을 주제별 작성요령 문서로 저장하자는 수정안 (FR-WB-100, ERR-WB-014).
// 장·보고서·양식 화면의 채팅(chat.js·book_chat.js·form_chat.js)이 'guides' 이벤트를 받으면 말풍선에 붙인다. 카드는 항목마다 결정을 스스로 들고 다시 그린다
// (채팅 기록의 위임 클릭 data-decide 를 쓰지 않는다 — 세 채팅의 카드 묶음과 섞이지 않게).
// 저장하기 전에는 아무 문서도 바뀌지 않는다. 저장은 POST /api/books/<M>/guide-notes — 수정안을 낸 뒤 그 문서가 달라졌거나 지워졌으면 서버가 409 로 막는다
import { api } from './state.js';
import { diffText } from './suggest.js';
import { fill, h, toast } from './util.js';

const DECISION = { rejected: '거부됨', stale: '수정안을 낸 뒤 이 작성요령 문서가 달라졌거나 지워져 저장하지 않았습니다 — 다시 요청하세요' };
const DIFF_LIMIT = 3000; // diffText 는 글자 수의 곱만큼 일한다 — 넘으면 전후 전문으로 보인다
const diffNodes = (before, after) => diffText(before, after).map(d => (d.kind === 'same' ? d.text : h(d.kind, d.text)));

// ev: { id, bookId, model, items: [{ id, topic, guideId, text, before, reason }] } · saved(result): 저장한 뒤 그 화면의 기준 문서 목록을 다시 받는다
export function noteCard(ev, { saved = () => {} } = {}) {
  const items = ev.items.map(item => ({ ...item, decision: 'pending', busy: false }));
  const card = h('div.proposal.note-card');
  const decide = async (item, accept) => {
    if (item.decision !== 'pending' || item.busy) return;
    if (!accept) {
      item.decision = 'rejected';
      return draw();
    }
    item.busy = true;
    draw();
    try {
      const res = await api('POST', `/api/books/${encodeURIComponent(ev.bookId)}/guide-notes`, { topic: item.topic, guideId: item.guideId, text: item.text, before: item.before });
      Object.assign(item, { decision: 'accepted', savedId: res.guide.id });
      toast(`작성요령 「${item.topic}」(${res.guide.id})에 저장했습니다.`);
      await saved(res);
    } catch (err) {
      if (err.status === 409) item.decision = 'stale';
      else toast(err.message, 'error');
    }
    item.busy = false;
    draw();
  };
  const decideAll = async accept => { for (const item of items) if (item.decision === 'pending') await decide(item, accept); };
  const draw = () => {
    const pending = items.filter(item => item.decision === 'pending');
    fill(card,
      h('div.proposal-head',
        h('span', h('span.kind-chip.is-guide', { title: '보고서를 쓰는 방식(문체·용어·표기·단위·인용)에 관한 수정안 — 저장하면 모든 에이전트가 따릅니다' }, '작성요령'), `${ev.model} 작성요령 저장 ${items.length}건`, pending.length < items.length && h('span.muted', ` · 남은 검토 ${pending.length}건`)),
        pending.length > 1 && h('span.proposal-head-actions',
          h('button.btn.small', { type: 'button', onclick: () => decideAll(true) }, '모두 저장'),
          h('button.btn.small.ghost', { type: 'button', onclick: () => decideAll(false) }, '모두 거부'))),
      items.map(item => itemNode(item, decide)),
      pending.length > 0 && h('div.proposal-foot', '저장하기 전에는 작성요령이 바뀌지 않습니다. 저장한 요청 문서는 3열 작성요령 탭에서 열람·고치기·삭제할 수 있습니다.'));
  };
  draw();
  return card;
}

// 항목 — 주제·새 문서/고칠 문서·저장될 글(고칠 문서는 전후 차이)·사유·저장/거부
function itemNode(item, decide) {
  const body = !item.before ? h('div.toc-instr', item.text)
    : item.before.length + item.text.length <= DIFF_LIMIT ? h('div.toc-instr', diffNodes(item.before, item.text))
    : [h('div.toc-instr', h('del', item.before)), h('div.toc-instr', h('ins', item.text))];
  return h('div.proposal-item.toc-item', { class: `is-${item.decision}` },
    h('div.change-head', h('span.op-badge.note-badge', '작성요령 저장')),
    h('div.toc-target', item.guideId ? `${item.guideId} 「${item.topic}」 고침` : `새 작성요령 「${item.topic}」`),
    body,
    item.reason && h('div.change-reason', item.reason),
    item.decision === 'pending'
      ? h('div.change-actions',
        h('button.btn.small', { type: 'button', disabled: item.busy, onclick: () => decide(item, true) }, item.busy ? '저장하는 중…' : '✓ 저장'),
        h('button.btn.small.ghost', { type: 'button', disabled: item.busy, onclick: () => decide(item, false) }, '✕ 거부'))
      : h('div.change-decision', { class: item.decision === 'stale' ? 'is-stale' : '' }, item.decision === 'accepted' ? `작성요령에 저장했습니다 (${item.savedId})` : DECISION[item.decision]));
}
