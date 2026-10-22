// 보고서 화면·장 화면 2열 대화 보관 — 닫기 창(장·주제·제목 분류와 에이전트 제안)과 지난 대화 목록(장별·주제별 묶음) (FR-WB-101, ERR-WB-015).
// 보관은 서버가 에이전트의 답이 끝날 때마다 한다. book_chat.js·chat.js 가 이 모듈을 부르므로 그 둘을 import 하지 않는다 — 대화 열기는 넘겨받은 함수로 한다.
import { outlineNumbers } from '../shared/toc.js';
import { api } from './state.js';
import { fill, formatDate, h, toast } from './util.js';

const chatsUrl = (bookId, id = '', action = '') => `/api/books/${encodeURIComponent(bookId)}/chats${id ? `/${encodeURIComponent(id)}` : ''}${action ? `/${action}` : ''}`;

export const listChats = async bookId => (await api('GET', chatsUrl(bookId))).chats;
export const openChat = (bookId, id, screen = 'book') => api('POST', chatsUrl(bookId, id, 'open'), { screen }); // screen 'chapter': 장 에이전트로 이어 간다
const topicsOf = chats => [...new Set(chats.map(c => c.topic).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));

// 장 이름 — 목차 번호와 제목. 목차에 없는 장은 그렇게 밝힌다
function chapterNames(chapters) {
  const numbers = outlineNumbers(chapters.map(ch => ({ level: ch.level || 1 })));
  return new Map(chapters.map((ch, i) => [ch.id, `${numbers[i]} ${ch.title}`]));
}

// 지난 대화를 묶는다 — 분류 안 됨이 먼저이고, 장별은 목차 순서의 장 → 보고서 전체 → 목차에 없는 장, 주제별은 주제 이름 순 → 주제 없음. 묶음 안은 최근 문답 순 (FR-WB-101 (c))
export function groupChats(chats, chapters, by) {
  const recent = list => [...list].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const groups = [];
  const push = (key, label, list) => { if (list.length) groups.push({ key, label, chats: recent(list) }); };
  push('unclassified', '분류 안 됨', chats.filter(c => !c.classified));
  const done = chats.filter(c => c.classified);
  if (by === 'topic') {
    for (const topic of topicsOf(done)) push(`topic:${topic}`, topic, done.filter(c => c.topic === topic));
    push('no-topic', '주제 없음', done.filter(c => !c.topic));
  } else {
    const names = chapterNames(chapters);
    for (const ch of chapters) push(`chapter:${ch.id}`, names.get(ch.id), done.filter(c => c.chapterId === ch.id));
    push('book', '보고서 전체', done.filter(c => !c.chapterId));
    push('gone', '목차에 없는 장', done.filter(c => c.chapterId && !names.has(c.chapterId)));
  }
  return groups;
}

// ───────────────────────────── 닫기 창 ─────────────────────────────

// mode 'close': 보관하고 닫기 · 보관하지 않고 닫기 · 취소 / 'edit'(목록의 분류 고치기): 저장 · 취소.
// 분류한 적 없는 대화면 고른 모델의 제안을 받아 작성자가 아직 건드리지 않은 칸만 채운다(기다리지 않고 저장해도 된다).
// chapterId: 장 화면에서 닫는 대화의 장 — 분류한 적 없으면 장 칸을 처음부터 그 장으로 두고 제안은 주제·제목만 채운다.
// → 'kept' | 'discarded' | 'gone'(그사이 지워졌다) | null(취소)
export function classifyDialog({ bookId, chat, chats, chapters, model, modelLabel, mode = 'close', chapterId = null }) {
  return new Promise(resolve => {
    let result = null;
    const touched = new Set();
    const touch = key => () => touched.add(key);
    const names = chapterNames(chapters);
    const chapterSelect = h('select', { onchange: touch('chapter') }, h('option', { value: '' }, '보고서 전체'),
      chapters.map(ch => h('option', { value: ch.id }, `${' '.repeat((ch.level || 1) - 1)}${names.get(ch.id)}`)));
    const listId = `chat-topics-${chat.id}`;
    const topicInput = h('input', { type: 'text', maxLength: 40, list: listId, placeholder: '예: 용어 통일', autocomplete: 'off', oninput: touch('topic') });
    const titleInput = h('input', { type: 'text', maxLength: 100, placeholder: chat.title, oninput: touch('title') });
    const status = h('p.chat-label-status');
    const abort = new AbortController();
    const close = value => { result = value; dialog.close(); };

    async function save(event) {
      event?.preventDefault();
      try {
        await api('PUT', chatsUrl(bookId, chat.id), { chapterId: chapterSelect.value || null, topic: topicInput.value, title: titleInput.value });
        close('kept');
      } catch (err) {
        toast(err.message, 'error');
        if (err.status === 404) close('gone');
      }
    }
    async function discard() {
      try {
        await api('DELETE', chatsUrl(bookId, chat.id));
      } catch (err) {
        if (err.status !== 404) return toast(err.message, 'error');
      }
      close('discarded');
    }

    const dialog = h('dialog.dialog.chat-label',
      h('h2', mode === 'close' ? '대화 닫기' : '대화 분류'),
      h('p.muted', mode === 'close' ? '장이나 주제로 분류해 보관하면 「지난 대화」에서 찾아 다시 열고 이어 갈 수 있습니다.' : '「지난 대화」에서 이 대화가 묶일 장과 주제를 고칩니다.'),
      h('p.chat-label-meta', `문답 ${chat.exchanges}개 · 마지막 ${formatDate(chat.updatedAt)}`),
      h('form', { onsubmit: save },
        h('label.field', '장', chapterSelect),
        h('label.field', '주제', topicInput),
        h('label.field', '제목', titleInput),
        h('datalist', { id: listId }, topicsOf(chats).map(topic => h('option', { value: topic }))),
        status,
        h('div.row-actions',
          mode === 'close' && h('button.btn.ghost.chat-label-discard', { type: 'button', title: '이 대화를 보관에서 지우고 새 대화를 시작합니다', onclick: discard }, '보관하지 않고 닫기'),
          h('button.btn.ghost', { type: 'button', onclick: () => close(null) }, '취소'),
          h('button.btn', { type: 'submit' }, mode === 'close' ? '보관하고 닫기' : '저장'))));
    dialog.addEventListener('close', () => {
      abort.abort(); // 제안을 기다리던 모델 호출도 멈춘다
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();

    if (chat.classified) {
      chapterSelect.value = names.has(chat.chapterId) ? chat.chapterId : '';
      topicInput.value = chat.topic;
      titleInput.value = chat.title;
      status.textContent = names.has(chat.chapterId) || !chat.chapterId ? '저장된 분류입니다. 고쳐서 보관할 수 있습니다.' : '분류했던 장이 목차에 없어 「보고서 전체」로 두었습니다.';
      return;
    }
    if (names.has(chapterId)) {
      chapterSelect.value = chapterId;
      touched.add('chapter');
    }
    status.textContent = `에이전트(${modelLabel})가 ${touched.has('chapter') ? '주제·제목' : '장·주제·제목'}을 제안하는 중입니다… 기다리지 않고 고르거나 저장해도 됩니다.`;
    status.classList.add('is-busy');
    suggest(bookId, chat.id, model, abort.signal).then(data => {
      status.classList.remove('is-busy');
      if (!data.suggestion) {
        status.textContent = `제안을 받지 못했습니다 — ${data.reason} 직접 고르세요.`;
        return status.classList.add('is-error');
      }
      const s = data.suggestion;
      if (!touched.has('chapter')) chapterSelect.value = s.chapterId || '';
      if (!touched.has('topic') && s.topic) topicInput.value = s.topic;
      if (!touched.has('title') && s.title) titleInput.value = s.title;
      status.textContent = `${data.model} 의 제안을 채웠습니다. 고쳐서 저장할 수 있습니다.`;
    }).catch(err => {
      if (err.name === 'AbortError') return;
      status.classList.remove('is-busy');
      status.classList.add('is-error');
      status.textContent = `제안을 받지 못했습니다 — ${err.message} 직접 고르세요.`;
    });
  });
}

// 제안은 창을 닫으면 멈춰야 하므로 api() 대신 signal 을 넘긴다
async function suggest(bookId, id, model, signal) {
  const res = await fetch(chatsUrl(bookId, id, 'suggest'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }), signal });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

// ───────────────────────────── 지난 대화 목록 ─────────────────────────────

// 2열 안에서 대화 기록 자리에 펼치는 목록. ctx() → { bookId, chatId(지금 대화), chapters, model, modelLabel }, open(id) 는 그 대화를 2열에 다시 연다
export function chatHistory({ ctx, open }) {
  let by = 'chapter';
  try { by = localStorage.getItem('sa.chatGroup') === 'topic' ? 'topic' : 'chapter'; } catch { /* 장별로 시작한다 */ }
  let chats = [];
  const body = h('div.chat-history-body');
  const tabs = h('div.segmented', { role: 'group', 'aria-label': '묶는 기준' },
    [['chapter', '장별'], ['topic', '주제별']].map(([key, label]) => h('button', { type: 'button', dataset: { by: key }, onclick: () => setBy(key) }, label)));
  const count = h('span.chat-history-count');
  const el = h('div.chat-history', { hidden: true }, h('div.chat-history-head', h('strong', '지난 대화'), count, tabs), body);
  el.addEventListener('click', onClick);

  function setBy(key) {
    by = key;
    try { localStorage.setItem('sa.chatGroup', key); } catch { /* 이번 화면에만 적용된다 */ }
    render();
  }

  async function refresh() {
    const { bookId } = ctx();
    if (!bookId) return;
    try {
      chats = await listChats(bookId);
    } catch (err) {
      chats = [];
      toast(err.message, 'error');
    }
    render();
  }

  function render() {
    const { chatId, chapters } = ctx();
    for (const tab of tabs.children) tab.classList.toggle('is-on', tab.dataset.by === by);
    count.textContent = chats.length ? `${chats.length}건` : '';
    if (!chats.length) return fill(body, h('p.chat-history-empty', '보관된 대화가 없습니다. 에이전트가 답을 마치면 대화가 보관되고, 「새 대화」로 닫을 때 장·주제로 분류합니다.'));
    const names = chapterNames(chapters);
    fill(body, groupChats(chats, chapters, by).map(group => h('section.chat-group',
      h('h3.chat-group-title', group.label, h('span.muted', ` ${group.chats.length}`)),
      group.chats.map(chat => {
        const current = chat.id === chatId;
        const tag = by === 'topic' ? (chat.classified ? (chat.chapterId ? names.get(chat.chapterId) || '목차에 없는 장' : '보고서 전체') : '')
          : chat.topic;
        return h('div.chat-item', { class: current ? 'is-current' : '', dataset: { chat: chat.id } },
          h('button.chat-item-open', { type: 'button', disabled: current, dataset: { open: '1' }, title: current ? '지금 2열에 열린 대화입니다' : '이 대화를 2열에 다시 열어 이어 갑니다' }, chat.title),
          h('div.chat-item-meta',
            current && h('span.kind-badge', '지금 대화'),
            tag && h('span.chat-item-tag', tag),
            h('span', `문답 ${chat.exchanges}`),
            h('span', formatDate(chat.updatedAt))),
          h('div.chat-item-actions',
            h('button.btn.small.ghost', { type: 'button', dataset: { label: '1' } }, '분류'),
            !current && h('button.btn.small.ghost', { type: 'button', dataset: { remove: '1' } }, '삭제')));
      }))));
  }

  async function onClick(event) {
    const item = event.target.closest('[data-chat]');
    const chat = chats.find(c => c.id === item?.dataset.chat);
    if (!chat) return;
    const { bookId, chapters, model, modelLabel } = ctx();
    if (event.target.closest('[data-open]')) return open(chat.id);
    if (event.target.closest('[data-label]')) {
      if (await classifyDialog({ bookId, chat, chats, chapters, model, modelLabel, mode: 'edit' })) await refresh();
      return;
    }
    if (event.target.closest('[data-remove]')) {
      if (!confirm(`지난 대화 「${chat.title}」를 지울까요? 되돌릴 수 없습니다.`)) return;
      try {
        chats = (await api('DELETE', chatsUrl(bookId, chat.id))).chats;
        render();
      } catch (err) {
        toast(err.message, 'error');
        await refresh();
      }
    }
  }

  return {
    el,
    isOpen: () => !el.hidden,
    refresh,
    redraw: render, // 목차가 바뀌었을 때 — 장 이름과 묶음만 다시 맞춘다
    async show(visible) {
      el.hidden = !visible;
      if (!visible) return;
      render(); // 지금 대화 표시는 곧바로 맞추고, 문답 수 등은 새로 받아 다시 그린다
      await refresh();
    },
  };
}
