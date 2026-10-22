// 보고서 화면 대화 보관 — 답마다 보관·번호 불변·되살리지 않음, 분류(목차에 없는 장 거절), 다시 열기(수정안 블록 빼기)·이어 가기, 분류 제안 글과 해석, 장별·주제별 묶음 (FR-WB-101, DR-WB-010, ERR-WB-015)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as chats from '../lib/book_chats.js';
import { groupChats } from '../public/js/book_chat_history.js';

const SYSTEM_TMP = os.tmpdir(); // 에이전트 시험이 TEMP 를 지울 폴더로 돌리므로 처음 값을 쓴다
const tempDir = prefix => fs.mkdtemp(path.join(SYSTEM_TMP, prefix));
const exchange = (q, a, model = 'opus') => [{ role: 'user', text: q, at: '2026-10-22T01:00:00.000Z' }, { role: 'assistant', text: a, model, at: '2026-10-22T01:00:05.000Z' }];

test('답의 글에서 수정안 블록을 빼고, 수정안이 들어 있던 블록 수를 센다', () => {
  assert.deepEqual(chats.answerText('앞 글.\n\n```sourceanchor\n{"toc": [{"op": "rename"}]}\n```\n\n뒤 글.'), { text: '앞 글.\n\n뒤 글.', blocks: 1 });
  assert.deepEqual(chats.answerText('빈 블록.\n```sourceanchor\n{"toc": [], "guides": []}\n```'), { text: '빈 블록.', blocks: 0 });
  assert.deepEqual(chats.answerText('끝나지 않은 블록\n```sourceanchor\n{"toc"'), { text: '끝나지 않은 블록', blocks: 1 });
  assert.deepEqual(chats.answerText('블록 없음'), { text: '블록 없음', blocks: 0 });
});

test('제목을 비우면 첫 질문의 앞 40자, 요약에는 문답 수와 답한 모델만', () => {
  const chat = { id: 'CV-001', title: '', classified: false, chapterId: null, topic: '', messages: [...exchange('장 사이의 용어와 표기를 모두 찾아서 어느 장이 어떻게 썼는지 하나하나 알려 줘', '답'), ...exchange('표로', '답', 'fable')], createdAt: 'a', updatedAt: 'b' };
  const summary = chats.chatSummary(chat);
  assert.equal(summary.title, '장 사이의 용어와 표기를 모두 찾아서 어느 장이 어떻게 썼는지 하나하나…');
  assert.deepEqual([summary.exchanges, summary.models, summary.messages], [2, ['opus', 'fable'], undefined]);
  assert.equal(chats.titleOf({ ...chat, title: '정한 제목' }), '정한 제목');
  assert.equal(chats.titleOf({ ...chat, messages: [] }), '제목 없는 대화');
  const visible = chats.visibleMessages({ messages: exchange('질문', '답.\n```sourceanchor\n{"guides": [{"topic": "문체"}]}\n```') });
  assert.deepEqual(visible.map(m => [m.role, m.text, m.blocks, m.model]), [['user', '질문', undefined, undefined], ['assistant', '답.', 1, 'opus']]);
});

test('분류 제안 글: 목차·기존 주제·대화를 담고, 긴 대화는 첫 문답과 최근 문답만 넣는다', () => {
  const chapters = [{ id: 'R-001', title: '서론', level: 1 }, { id: 'R-002', title: '배경', level: 2 }];
  const prompt = chats.labelPrompt({ messages: exchange('용어를 맞춰 줘', '네.\n```sourceanchor\n{"toc": []}\n```') }, chapters, ['용어 통일']);
  assert.match(prompt, /<toc>\nR-001 \| 1 \| 서론\nR-002 \| 1\.1 \| 배경\n<\/toc>/);
  assert.match(prompt, /<existing_topics>\n용어 통일\n<\/existing_topics>/);
  assert.match(prompt, /user: 용어를 맞춰 줘\n\nassistant: 네\./);
  assert.doesNotMatch(prompt, /sourceanchor/);
  const long = Array.from({ length: 40 }, (_, i) => exchange(`질문 ${i} ${'가'.repeat(900)}`, `답 ${i}`)).flat();
  const cut = chats.labelPrompt({ messages: long }, [], []);
  assert.match(cut, /\(the report has no chapters\)/);
  assert.match(cut, /user: 질문 0 /);
  assert.match(cut, /user: 질문 39 /);
  assert.match(cut, /messages omitted/);
  assert.ok(cut.length < 33_000);
});

test('분류 제안 해석: 목차에 없는 장은 보고서 전체, 글은 한도로 자르고, 형식이 틀리면 던진다', () => {
  const chapters = [{ id: 'R-002', title: '배경', level: 1 }];
  assert.deepEqual(chats.parseLabel('제안:\n{"chapter": "R-002", "topic": " 용어  통일 ", "title": "장 사이 용어"}', chapters), { chapterId: 'R-002', topic: '용어 통일', title: '장 사이 용어' });
  assert.equal(chats.parseLabel('{"chapter": "R-009", "topic": "t", "title": "x"}', chapters).chapterId, null);
  assert.equal(chats.parseLabel(JSON.stringify({ chapter: null, topic: "가".repeat(50) }), chapters).topic.length, chats.TOPIC_LIMIT);
  assert.throws(() => chats.parseLabel('분류할 수 없습니다', chapters), /형식이 맞지 않습니다/);
  assert.throws(() => chats.parseLabel('[1, 2]', chapters), /형식이 맞지 않습니다/);
});

test('파일: 만들기·답마다 문답 바꾸기·분류·지우기, 지운 대화는 되살리지 않고, 저장과 분류가 겹쳐도 서로 덮지 않는다', async () => {
  const dir = await tempDir('sourceanchor-chats-test-');
  const created = await chats.createChat(dir, 'CV-001', exchange('첫 질문', '첫 답'));
  assert.deepEqual([created.classified, created.chapterId, created.topic, created.messages.length], [false, null, '', 2]);
  const both = [...exchange('첫 질문', '첫 답'), ...exchange('둘째', '둘째 답')];
  await Promise.all([chats.saveMessages(dir, 'CV-001', both), chats.classifyChat(dir, 'CV-001', { chapterId: 'R-002', topic: ' 용어 ', title: '' })]);
  const read = await chats.readChat(dir, 'CV-001');
  assert.deepEqual([read.messages.length, read.classified, read.chapterId, read.topic, read.title], [4, true, 'R-002', '용어', '']);
  await chats.createChat(dir, 'CV-002', exchange('다른 질문', '답'));
  assert.deepEqual((await chats.listChats(dir)).map(c => c.id).sort(), ['CV-001', 'CV-002']);
  await fs.writeFile(path.join(dir, 'chats', 'CV-003.json.x.tmp'), '{'); // 쓰는 중인 임시 파일은 목록에 없다
  assert.equal((await chats.listChats(dir)).length, 2);
  await chats.removeChat(dir, 'CV-002');
  assert.equal(await chats.saveMessages(dir, 'CV-002', both), null);
  await assert.rejects(chats.readChat(dir, 'CV-002'), /찾지 못했습니다/);
  await assert.rejects(chats.removeChat(dir, 'CV-002'), /찾지 못했습니다/);
  await assert.rejects(chats.readChat(dir, '../main'), /찾지 못했습니다/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('보관(store): 번호는 지운 뒤에도 다시 쓰지 않고, 목차에 없는 장으로는 분류하지 않으며, 보고서를 지우면 함께 지워진다', async () => {
  const dir = await tempDir('sourceanchor-chats-store-');
  process.env.WORKSPACE = dir;
  const store = await import(`../lib/store.js?workspace=${encodeURIComponent(dir)}`);
  const { book } = await store.loadBookState();
  const state = await store.insertChapter({ bookId: book.id, title: '배경', level: 1, after: 'end' });
  const chapterId = state.chapters[0].id;
  const a = await store.saveBookChat({ bookId: book.id, messages: exchange('질문', '답') });
  const b = await store.saveBookChat({ bookId: book.id, messages: exchange('다른', '답') });
  assert.deepEqual([a.id, b.id], ['CV-001', 'CV-002']);
  assert.equal((await store.saveBookChat({ bookId: book.id, id: 'CV-001', messages: [...exchange('질문', '답'), ...exchange('또', '답')] })).messages.length, 4);
  await store.deleteBookChat(book.id, 'CV-002');
  assert.equal((await store.saveBookChat({ bookId: book.id, messages: exchange('셋', '답') })).id, 'CV-003');
  await assert.rejects(store.classifyBookChat({ bookId: book.id, id: 'CV-001', chapterId: 'R-999', topic: '용어' }), err => err.status === 400 && /목차에 없는 장/.test(err.message));
  const classified = await store.classifyBookChat({ bookId: book.id, id: 'CV-001', chapterId, topic: '용어 통일', title: '' });
  assert.deepEqual([classified.classified, classified.chapterId, classified.topic, classified.title, classified.exchanges], [true, chapterId, '용어 통일', '질문', 2]);
  const context = await store.bookChatContext(book.id, 'CV-003');
  assert.deepEqual([context.chat.id, context.chapters.map(ch => ch.id), context.topics], ['CV-003', [chapterId], ['용어 통일']]);
  assert.deepEqual((await store.bookChatList(book.id)).map(c => c.id).sort(), ['CV-001', 'CV-003']);
  const again = await import(`../lib/store.js?reload=${Date.now()}`);
  assert.equal((await again.saveBookChat({ bookId: book.id, messages: exchange('넷', '답') })).id, 'CV-004'); // 다시 불러와도 번호는 이어진다
  await again.deleteBook(book.id);
  await assert.rejects(fs.access(path.join(dir, 'projects', book.id, 'chats')));
  await fs.rm(dir, { recursive: true, force: true });
});

test('지난 대화 묶음: 분류 안 됨이 먼저, 장별은 목차 순서 → 보고서 전체 → 목차에 없는 장, 주제별은 이름 순 → 주제 없음, 묶음 안은 최근 순', () => {
  const chapters = [{ id: 'R-001', title: '서론', level: 1 }, { id: 'R-002', title: '배경', level: 2 }];
  const list = [
    { id: 'CV-001', classified: true, chapterId: 'R-002', topic: '용어', updatedAt: '2026-10-22T01:00:00Z' },
    { id: 'CV-002', classified: true, chapterId: 'R-002', topic: '구성', updatedAt: '2026-10-22T03:00:00Z' },
    { id: 'CV-003', classified: true, chapterId: null, topic: '', updatedAt: '2026-10-22T02:00:00Z' },
    { id: 'CV-004', classified: true, chapterId: 'R-009', topic: '용어', updatedAt: '2026-10-22T04:00:00Z' },
    { id: 'CV-005', classified: false, chapterId: null, topic: '', updatedAt: '2026-10-22T05:00:00Z' },
  ];
  const view = groups => groups.map(g => `${g.label}: ${g.chats.map(c => c.id).join(',')}`);
  assert.deepEqual(view(groupChats(list, chapters, 'chapter')), ['분류 안 됨: CV-005', '1.1 배경: CV-002,CV-001', '보고서 전체: CV-003', '목차에 없는 장: CV-004']);
  assert.deepEqual(view(groupChats(list, chapters, 'topic')), ['분류 안 됨: CV-005', '구성: CV-002', '용어: CV-004,CV-001', '주제 없음: CV-003']);
  assert.deepEqual(groupChats([], chapters, 'chapter'), []);
});

test('에이전트: 보고서 화면 답마다 보관하고(chat 이벤트), 다시 열면 블록을 뺀 문답을 보이며, 서버가 대화를 잃어도 보관 번호로 이어 가고, 분류를 제안한다', async () => {
  const dir = await tempDir('sourceanchor-chats-agent-');
  process.env.WORKSPACE = path.join(dir, 'ws');
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = path.join(dir, 'tmp'); // 에이전트 작업 폴더를 실제 서버와 나눈다
  await fs.mkdir(process.env.TEMP, { recursive: true });
  process.env.CLAUDE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake_claude_cli.mjs');
  delete process.env.AGENT;
  const store = await import(`../lib/store.js?agent=${Date.now()}`);
  const { createAgent } = await import(`../agent.js?agent=${Date.now()}`);
  const agent = createAgent({ bookAgentState: store.bookAgentState, bookGuides: store.fullGuides, saveBookChat: store.saveBookChat, getBookChat: store.getBookChat, bookChatContext: store.bookChatContext });
  const { book } = await store.loadBookState();
  const { chapters } = await store.insertChapter({ bookId: book.id, title: '용어', level: 1, after: 'end' });
  const ask = async body => {
    const events = [];
    await agent.send({ model: 'opus', bookId: book.id, ...body }, ev => events.push(ev));
    return { events, text: events.filter(e => e.t === 'text').map(e => e.d).join(''), start: events.find(e => e.t === 'start'), chat: events.find(e => e.t === 'chat') };
  };

  const first = await ask({ text: '용어를 맞춰 줘' });
  assert.equal(first.chat?.chatId, 'CV-001', JSON.stringify(first.events));
  assert.match(first.text, /앞선 문답이 없습니다/);
  const second = await ask({ conversationId: first.start.conversationId, chatId: 'CV-001', text: '표로 보여 줘' });
  assert.equal(second.chat.chatId, 'CV-001');
  assert.equal((await store.getBookChat(book.id, 'CV-001')).messages.length, 4);

  const opened = await agent.openBookChat({ bookId: book.id, chatId: 'CV-001' });
  assert.deepEqual(opened.chat.messages.map(m => [m.role, m.blocks ?? null]), [['user', null], ['assistant', 0], ['user', null], ['assistant', 0]]); // 가짜 CLI 의 블록은 비어 있다
  assert.ok(opened.chat.messages.every(m => !m.text.includes('sourceanchor')));
  const resumed = await ask({ conversationId: opened.conversationId, chatId: 'CV-001', text: '이어서' });
  assert.match(resumed.text, /앞선 문답을 받았습니다/);
  const lost = await ask({ conversationId: 'no-such-conversation', chatId: 'CV-001', text: '서버를 다시 띄운 뒤' }); // 서버가 대화를 잃었어도 보관 번호로 이어 간다
  assert.match(lost.text, /앞선 문답을 받았습니다/);
  assert.equal(lost.chat.chatId, 'CV-001');
  assert.equal((await store.getBookChat(book.id, 'CV-001')).messages.length, 8);

  const label = await agent.suggestChatLabel({ bookId: book.id, chatId: 'CV-001', model: 'opus' });
  assert.deepEqual(label.suggestion, { chapterId: chapters[0].id, topic: '용어 통일', title: '장 사이 용어 맞추기' });
  await assert.rejects(agent.openBookChat({ bookId: book.id, chatId: 'CV-077' }), /찾지 못했습니다/);
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('에이전트: 장 화면 대화도 그 장의 보고서에 보관하고, 장 에이전트로 다시 열어 이어 가며, 분기 질문은 보관하지 않는다', async () => {
  const dir = await tempDir('sourceanchor-chats-chapter-');
  process.env.WORKSPACE = path.join(dir, 'ws');
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = path.join(dir, 'tmp'); // 에이전트 작업 폴더를 실제 서버와 나눈다
  await fs.mkdir(process.env.TEMP, { recursive: true });
  process.env.CLAUDE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake_claude_cli.mjs');
  delete process.env.AGENT;
  const store = await import(`../lib/store.js?chapter=${Date.now()}`);
  const { createAgent } = await import(`../agent.js?chapter=${Date.now()}`);
  const agent = createAgent({ loadState: store.loadState, addSource: store.addSource, bookAgentState: store.bookAgentState, bookGuides: store.fullGuides, saveBookChat: store.saveBookChat, getBookChat: store.getBookChat, bookChatContext: store.bookChatContext });
  const { book } = await store.loadBookState();
  const { chapters } = await store.insertChapter({ bookId: book.id, title: '용어', level: 1, after: 'end' });
  const docId = chapters.at(-1).id;
  const ask = async body => {
    const events = [];
    await agent.send({ model: 'opus', docId, ...body }, ev => events.push(ev));
    return { events, text: events.filter(e => e.t === 'text').map(e => e.d).join(''), start: events.find(e => e.t === 'start'), chat: events.find(e => e.t === 'chat') };
  };
  const ranAs = async (kind, conversationId) => fs.stat(path.join(process.env.TEMP, 'sourceanchor-agent', kind, conversationId)).then(() => true, () => false);

  const first = await ask({ text: '근거를 찾아 줘' });
  assert.equal(first.chat?.chatId, 'CV-001', JSON.stringify(first.events));
  const saved = await store.getBookChat(book.id, 'CV-001');
  assert.deepEqual(saved.messages.map(m => [m.role, m.model ?? null, Boolean(m.at)]), [['user', null, true], ['assistant', 'opus', true]]);
  assert.equal(saved.classified, false);

  const branch = await ask({ branch: true, branchOf: first.start.conversationId, text: '갈라져 묻기' });
  assert.equal(branch.chat, undefined, '분기 질문은 보관하지 않는다');
  assert.equal((await store.bookChatList(book.id)).length, 1);

  const opened = await agent.openBookChat({ bookId: book.id, chatId: 'CV-001', screen: 'chapter' });
  const resumed = await ask({ conversationId: opened.conversationId, chatId: 'CV-001', chatBook: book.id, text: '이어서' });
  assert.match(resumed.text, /앞선 문답을 받았습니다/);
  assert.equal(resumed.chat.chatId, 'CV-001');
  assert.ok(await ranAs('default', opened.conversationId), '장 에이전트로 이어 간다');
  assert.ok(!(await ranAs('book', opened.conversationId)));
  const lost = await ask({ conversationId: 'no-such-conversation', chatId: 'CV-001', chatBook: book.id, text: '서버를 다시 띄운 뒤' }); // 서버가 대화를 잃었어도 보관 번호로 장 대화를 되살린다
  assert.match(lost.text, /앞선 문답을 받았습니다/);
  assert.ok(await ranAs('default', lost.start.conversationId));
  assert.equal((await store.getBookChat(book.id, 'CV-001')).messages.length, 6);
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
