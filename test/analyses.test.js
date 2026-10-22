// 데이터 분석 — 결과 폴더 맞추기(lib/analyses.js), 보관(lib/store.js), 분석 에이전트(agent.js)와 서브에이전트의 한도·쓰기 (FR-WB-088, 106, DR-WB-007, ERR-WB-010, NFR-WB-003)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as analyses from '../lib/analyses.js';

const SYSTEM_TMP = os.tmpdir(); // 에이전트 시험이 TEMP 를 지울 폴더로 돌리므로 처음 값을 쓴다
const FAKE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake_claude_cli.mjs');
const tempDir = prefix => fs.mkdtemp(path.join(SYSTEM_TMP, prefix));
const put = async (root, rel, text) => {
  const file = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
};

test('결과 경로: 결과 폴더 안의 상대 경로와 정해진 확장자만', () => {
  for (const ok of ['a.json', 'G-003/part-01.json', '통합/전체.yaml', 'notes.md', 'table.csv', 'x.YML']) assert.equal(analyses.resultPathProblem(ok), null, ok);
  for (const bad of ['', '../a.json', 'a/../../b.json', '/a.json', 'a//b.json', 'a.py', 'run.ps1', 'a:b.json', 'dir./a.json', 'x'.repeat(301) + '.json']) assert.ok(analyses.resultPathProblem(bad), bad);
});

test('결과 폴더 맞추기: 바뀐 파일만 저장하고, 에이전트가 지운 것은 지우고, 작성자가 지운 것은 되살리지 않고, 허용하지 않는 파일은 한 번만 알린다', async () => {
  const dir = await tempDir('sourceanchor-analyses-sync-');
  const bookDir = path.join(dir, 'book');
  const view = path.join(dir, 'view', 'results');
  const stored = rel => fs.readFile(path.join(analyses.resultsDir(bookDir, 'A-001'), ...rel.split('/')), 'utf8');

  let known = await analyses.seedResults(bookDir, 'A-001', view); // 아직 결과가 없다
  assert.equal(known.size, 0);
  await put(view, 'a.json', '{"a":1}');
  await put(view, 'G-003/part-01.json', '{"p":1}');
  await put(view, 'helper.py', 'print(1)');
  let outcome = await analyses.syncResults(bookDir, 'A-001', view, known);
  assert.deepEqual(outcome.saved, ['a.json', 'G-003/part-01.json']);
  assert.deepEqual(outcome.skipped.map(f => f.path), ['helper.py']);
  assert.equal(await stored('G-003/part-01.json'), '{"p":1}');
  known = outcome.known;

  outcome = await analyses.syncResults(bookDir, 'A-001', view, known); // 그대로면 아무것도 하지 않고, 남기지 않은 파일도 다시 알리지 않는다
  assert.deepEqual([outcome.saved, outcome.removed, outcome.skipped], [[], [], []]);
  known = outcome.known;

  await analyses.deleteResult(bookDir, 'A-001', 'a.json'); // 작성자가 1열에서 지웠다
  await fs.rm(path.join(view, 'G-003', 'part-01.json')); // 에이전트가 지웠다
  await put(view, 'merged.json', '{not json');
  outcome = await analyses.syncResults(bookDir, 'A-001', view, known);
  assert.deepEqual(outcome.saved, ['merged.json']);
  assert.deepEqual(outcome.removed, ['G-003/part-01.json']);
  await assert.rejects(stored('a.json'), '작업 폴더에서 바뀌지 않았으면 되살리지 않는다');
  known = outcome.known;

  const list = await analyses.listResults(bookDir, 'A-001');
  assert.deepEqual(list.map(r => [r.path, r.ext, r.invalid ?? false]), [['merged.json', 'json', true]]);
  await assert.rejects(fs.access(path.join(analyses.resultsDir(bookDir, 'A-001'), 'G-003')), '비게 된 하위 폴더도 지운다');

  await new Promise(resolve => setTimeout(resolve, 20));
  await put(view, 'a.json', '{"a":2}'); // 에이전트가 다시 쓰면 돌아온다
  outcome = await analyses.syncResults(bookDir, 'A-001', view, known);
  assert.deepEqual(outcome.saved, ['a.json']);
  assert.equal(await stored('a.json'), '{"a":2}');

  const seeded = path.join(dir, 'view2', 'results'); // 다음 응답의 작업 폴더에는 지금 결과가 들어 있다
  known = await analyses.seedResults(bookDir, 'A-001', seeded);
  assert.deepEqual([...known.keys()].sort(), ['a.json', 'merged.json']);
  await assert.rejects(analyses.readResult(bookDir, 'A-001', '../analysis.json'), /쓸 수 없는 경로/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('보관: 보고서마다 A-번호(지운 번호는 다시 쓰지 않음)·제목·문답, 보고서 상태에 목록, 보고서를 지우면 함께 지운다', async () => {
  const dir = await tempDir('sourceanchor-analyses-store-');
  process.env.WORKSPACE = dir;
  const store = await import(`../lib/store.js?analyses=${Date.now()}`);
  const { book } = await store.loadBookState();
  const first = await store.createAnalysis({ bookId: book.id, title: '' });
  assert.equal(first.analysis.id, 'A-001');
  assert.equal(first.analysis.title, '제목 없는 분석');
  await store.renameAnalysis({ bookId: book.id, id: 'A-001', title: '  부록 1   적용범위 식별 ' });
  assert.equal(await store.saveAnalysisMessages({ bookId: book.id, id: 'A-001', messages: [{ role: 'user', text: '질문' }, { role: 'assistant', text: '답', model: 'opus' }] }), true);
  const opened = await store.getAnalysis(book.id, 'A-001');
  assert.equal(opened.analysis.title, '부록 1 적용범위 식별');
  assert.equal(opened.analysis.messages.length, 2);
  assert.equal(opened.folder, path.join(dir, 'projects', book.id, 'analyses', 'A-001', 'results'));
  assert.deepEqual((await store.loadBookState(book.id)).analyses.map(a => [a.id, a.title, a.results]), [['A-001', '부록 1 적용범위 식별', 0]]);

  const cleared = await store.clearAnalysisMessages(book.id, 'A-001');
  assert.equal(cleared.analysis.messages.length, 0);
  await store.deleteAnalysis(book.id, 'A-001');
  assert.equal((await store.createAnalysis({ bookId: book.id, title: '둘째' })).analysis.id, 'A-002');
  assert.equal(await store.saveAnalysisMessages({ bookId: book.id, id: 'A-001', messages: [] }), false, '지운 분석에는 보관하지 않는다');
  await assert.rejects(store.getAnalysis(book.id, 'A-001'), /찾지 못했습니다/);

  const other = await store.createBook({ title: '다른 보고서' });
  assert.deepEqual(other.analyses, [], '다른 보고서에는 보이지 않는다');
  await store.deleteBook(book.id);
  await assert.rejects(fs.access(path.join(dir, 'projects', book.id)));
  await fs.rm(dir, { recursive: true, force: true });
});

test('에이전트: 분석 대화는 results/ 에만 쓰는 도구로 돌고, 응답마다 결과를 거두고(results 이벤트·알림), 문답을 보관해 대화를 잃어도 이어 간다', async () => {
  const dir = await tempDir('sourceanchor-analyses-agent-');
  process.env.WORKSPACE = path.join(dir, 'ws');
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = path.join(dir, 'tmp'); // 에이전트 작업 폴더를 실제 서버와 나눈다
  await fs.mkdir(process.env.TEMP, { recursive: true });
  process.env.CLAUDE_CLI = FAKE_CLI;
  delete process.env.AGENT;
  const store = await import(`../lib/store.js?analysis-agent=${Date.now()}`);
  const { createAgent } = await import(`../agent.js?analysis-agent=${Date.now()}`);
  const agent = createAgent({ bookAgentState: store.bookAgentState, bookGuides: store.fullGuides, saveBookChat: store.saveBookChat, getBookChat: store.getBookChat, bookChatContext: store.bookChatContext,
    analysisAgentState: store.analysisAgentState, seedAnalysisResults: store.seedAnalysisResults, syncAnalysisResults: store.syncAnalysisResults, saveAnalysisMessages: store.saveAnalysisMessages });
  const { book } = await store.loadBookState();
  const { analysis } = await store.createAnalysis({ bookId: book.id, title: '적용범위' });
  const ask = async body => {
    const events = [];
    await agent.send({ model: 'opus', bookId: book.id, analysisId: analysis.id, ...body }, ev => events.push(ev));
    return { events, text: events.filter(e => e.t === 'text').map(e => e.d).join(''), start: events.find(e => e.t === 'start'), notices: events.filter(e => e.t === 'notice').map(e => e.text), results: events.filter(e => e.t === 'results') };
  };

  const first = await ask({ text: 'write G-003/part-01.json' });
  assert.match(first.text, /앞선 문답이 없습니다\. 결과 0개를 보았습니다/, JSON.stringify(first.events));
  assert.match(first.text, /tools=Read,Grep,Glob,WebSearch,WebFetch,Write,Edit /);
  assert.match(first.text, /allowed=[^ ]*Edit\(\.\/results\/\*\*\)/);
  assert.doesNotMatch(first.text, /allowed=[^ ]*(Write|Edit)(,|$)/, 'Write·Edit 를 경로 없이 허용하지 않는다');
  assert.deepEqual(first.results.map(e => e.saved), [['G-003/part-01.json']]);
  assert.ok(first.notices.includes('결과 파일 1개를 저장했습니다.'), first.notices.join(' / '));
  assert.ok(await fs.stat(path.join(process.env.TEMP, 'sourceanchor-agent', 'analysis', first.start.conversationId)).then(() => true), '분석의 작업 폴더');
  assert.deepEqual((await store.getAnalysis(book.id, analysis.id)).results.map(r => r.path), ['G-003/part-01.json']);
  assert.equal((await store.getAnalysis(book.id, analysis.id)).analysis.messages.length, 2);

  const second = await ask({ conversationId: first.start.conversationId, text: 'write helper.py' }); // 허용하지 않는 파일
  assert.match(second.text, /결과 1개를 보았습니다/);
  assert.ok(second.notices.some(n => n.startsWith('결과 파일로 남기지 않았습니다: helper.py')), second.notices.join(' / '));
  assert.deepEqual(second.results, []);

  const lost = await ask({ conversationId: 'no-such-conversation', text: 'delete G-003/part-01.json' }); // 서버가 대화를 잃었다 — 보관한 문답으로 이어 간다
  assert.match(lost.text, /앞선 문답을 받았습니다/);
  assert.deepEqual(lost.results.map(e => e.removed), [['G-003/part-01.json']]);
  assert.ok(lost.notices.includes('1개를 지웠습니다.'));
  assert.deepEqual((await store.getAnalysis(book.id, analysis.id)).results, []);
  assert.equal((await store.getAnalysis(book.id, analysis.id)).analysis.messages.length, 6);
  assert.equal(agent.analysisRunning(book.id, analysis.id), false);

  const book2 = await ask({ text: '보고서 화면', analysisId: null }); // 다른 화면의 대화는 쓰기 도구가 없다
  assert.doesNotMatch(book2.text, /tools=/);
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('서브에이전트 서버: 설정 파일의 한도(응답당 과제 수)를 지키고, 쓰기를 허용하면 results/ 경로 규칙만 넘긴다', async () => {
  const dir = await tempDir('sourceanchor-analyses-sub-');
  const config = path.join(dir, 'subagents.json');
  await fs.writeFile(config, JSON.stringify({ cwd: dir, anchor: '', cli: { claude: FAKE_CLI }, subagents: [{ name: 'opus', label: 'Opus', cli: 'claude', model: 'claude-opus-5-5', instructions: '' }], limits: { calls: 1, parallel: 1, timeoutMs: 60_000 }, write: true }));
  const server = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'subagent_mcp.js')], { env: { ...process.env, SOURCEANCHOR_SUBAGENTS: config }, stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = new Map();
  readline.createInterface({ input: server.stdout }).on('line', line => { const msg = JSON.parse(line); replies.get(msg.id)?.(msg); });
  const call = (id, method, params) => new Promise(resolve => { replies.set(id, resolve); server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });

  await call(1, 'initialize', { protocolVersion: '2025-06-18' });
  const { result: { tools } } = await call(2, 'tools/list', {});
  assert.match(tools[0].description, /write result files only under results\//);
  const done = await call(3, 'tools/call', { name: 'opus', arguments: { task: '적용범위 조항을 뽑아라' } });
  assert.match(done.result.content[0].text, /subagent tools=Read,Grep,Glob,WebSearch,WebFetch,Write,Edit allowed=Read,Grep,Glob,WebSearch,WebFetch,Edit\(\.\/results\/\*\*\)$/);
  const over = await call(4, 'tools/call', { name: 'opus', arguments: { task: '하나 더' } });
  assert.equal(over.result.isError, true);
  assert.match(over.result.content[0].text, /limited to 1 per reply/);
  server.stdin.end();
  await new Promise(resolve => server.on('exit', resolve));
  await fs.rm(dir, { recursive: true, force: true });
});
