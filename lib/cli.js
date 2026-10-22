// 에이전트 CLI 실행기 — Claude Code CLI(claude)와 Codex CLI(codex)를 헤드리스로 띄워 한 턴씩 주고받는다.
// 두 CLI 모두 사용자가 로그인해 둔 계정으로 동작하므로 API 키가 필요 없고, 세션 ID 로 대화를 이어 간다.
// 작업 폴더는 읽기 전용으로만 쓰게 한다: Claude 는 Read·Grep·Glob 과 웹 검색·읽기(WebSearch·WebFetch)만, Codex 는 read-only 샌드박스 + 웹 검색.
// 웹 도구는 자료를 찾아 읽는 데만 쓴다 — 원문 등록은 에이전트가 고른 URL 을 서버가 직접 내려받아 한다 (lib/collect.js).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TURN_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS) || 10 * 60 * 1000;
const EFFORT = process.env.AGENT_EFFORT || ''; // 비우면 Claude 는 CLI 기본값, Codex 는 medium
export const SUBAGENT_SERVER = 'subagents'; // 서브에이전트를 도구로 내놓는 MCP 서버(lib/subagent_mcp.js)의 이름 — 사용자가 연결하는 MCP 서버는 이 이름을 쓸 수 없다

function findOnPath(names) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

// npm 이 만든 .cmd 는 셸 없이 실행할 수 없으므로, 그 옆의 node_modules 에서 실제 진입 스크립트를 찾아 node 로 띄운다
function resolveCli(kind) {
  const override = process.env[kind === 'claude' ? 'CLAUDE_CLI' : 'CODEX_CLI'];
  const found = override || findOnPath(process.platform === 'win32' ? [`${kind}.exe`, `${kind}.cmd`] : [kind]);
  if (!found) return null;
  if (!/\.cmd$/i.test(found)) return /\.(m?js)$/i.test(found) ? { command: process.execPath, prefix: [found] } : { command: found, prefix: [] };
  const script = path.join(path.dirname(found), 'node_modules', ...(kind === 'claude' ? ['@anthropic-ai', 'claude-code', 'cli.js'] : ['@openai', 'codex', 'bin', 'codex.js']));
  return fs.existsSync(script) ? { command: process.execPath, prefix: [script] } : null;
}

const resolved = new Map();
export function cliAvailable(kind) {
  if (!resolved.has(kind)) resolved.set(kind, resolveCli(kind));
  return Boolean(resolved.get(kind));
}

// 찾아 둔 CLI 의 실행 파일(또는 진입 스크립트) 경로 — 서브에이전트 MCP 서버에 CLAUDE_CLI · CODEX_CLI 로 넘겨 같은 CLI 를 쓰게 한다
export function cliEntry(kind) {
  if (!cliAvailable(kind)) return null;
  const { command, prefix } = resolved.get(kind);
  return prefix[0] ?? command;
}

// ───────────────────────────── 인자 ─────────────────────────────

const CLAUDE_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];

// connections: lib/agent_config.js 의 prepareConnections 결과 — 사용자가 연결한 MCP 서버
// persist: false 는 세션을 남기지 않는다 — 한 번 답하고 끝나는 서브에이전트용
// tools: 쓸 수 있는 내장 도구 — 기준 문서 변환(lib/guide_convert.js)은 Read 하나만 준다
function claudeArgs({ model, sessionId, systemPrompt, connections, persist = true, tools = CLAUDE_TOOLS }) {
  return [
    '-p', '--model', model,
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--tools', tools.join(','), '--allowedTools', [...tools, ...(connections?.claudeTools || [])].join(','),
    '--setting-sources', '', '--strict-mcp-config', // 사용자·프로젝트 설정(훅, MCP)은 끌어오지 않고, 연결 설정에 적힌 MCP 서버만 쓴다
    ...(connections?.claudeArgs || []),
    '--system-prompt', systemPrompt,
    ...(EFFORT ? ['--effort', EFFORT] : []),
    ...(sessionId ? ['--resume', sessionId] : []),
    ...(persist ? [] : ['--no-session-persistence']),
  ];
}

function codexArgs({ model, sessionId, connections }) {
  const config = ['-c', `model_reasoning_effort="${EFFORT || 'medium'}"`, '-c', 'notify=[]', '-c', 'sandbox_mode="read-only"', ...(connections?.codexArgs || [])];
  // --search(웹 검색 도구)는 exec 앞에 와야 한다
  return ['--search', 'exec', ...(sessionId ? ['resume', sessionId] : []), '--json', '--skip-git-repo-check', '-m', model, ...config, '-'];
}

// ───────────────────────────── 이벤트 해석 ─────────────────────────────
// 두 CLI 의 JSON 줄을 공통 이벤트로 바꾼다: session · text_start · text · tool · error · usage(컨텍스트 사용량 — runTurn 이 모아 결과로 돌려준다)

// 서브에이전트에게 과제를 맡길 때: 누구에게 무엇을 맡겼는지 보여 준다 (FR-WB-055)
const subagentEvent = (name, input) => ({ t: 'tool', name: `서브에이전트 ${name}`, summary: String(input?.task ?? '').replace(/\s+/g, ' ').slice(0, 160) });

function claudeEvents(msg, out, model) {
  if (msg.type === 'system' && msg.subtype === 'init') {
    out({ t: 'session', id: msg.session_id });
    // 연결한 MCP 서버가 뜨지 않았으면 알린다 — 대화는 그 서버 없이 이어진다
    for (const server of msg.mcp_servers || []) if (server.status && server.status !== 'connected') out({ t: 'notice', text: `MCP 서버 "${server.name}" 에 연결하지 못했습니다 (${server.status}). 이 서버 없이 이어 갑니다.` });
  }
  else if (msg.type === 'stream_event') {
    const ev = msg.event;
    if (ev.type === 'content_block_start' && ev.content_block.type === 'text') out({ t: 'text_start' });
    else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') out({ t: 'text', d: ev.delta.text });
  } else if (msg.type === 'assistant') {
    // 이 호출에 들어간 입력(캐시 포함) + 나온 출력 = 다음 호출이 이어받을 컨텍스트. 마지막 메시지의 값이 현재 사용량이다 (FR-WB-058)
    const u = msg.message.usage;
    if (u && !msg.parent_tool_use_id) out({ t: 'usage', used: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0) });
    for (const block of msg.message.content || []) {
      if (block.type === 'tool_use' && block.name.startsWith(`mcp__${SUBAGENT_SERVER}__`)) out(subagentEvent(block.name.split('__').slice(2).join('__'), block.input));
      else if (block.type === 'tool_use' && block.name.startsWith('mcp__')) out({ t: 'tool', name: `MCP ${block.name.split('__')[1]}`, summary: block.name.split('__').slice(2).join('__') });
      else if (block.type === 'tool_use' && block.name.startsWith('Web')) out({ t: 'tool', name: block.name, summary: String(block.input?.query ?? block.input?.url ?? '').slice(0, 160) });
      else if (block.type === 'tool_use') out({ t: 'tool', name: block.name, summary: String(block.input?.pattern ?? block.input?.file_path ?? '').split(/[\\/]/).slice(-2).join('/') });
    }
  } else if (msg.type === 'result') {
    // modelUsage 에는 CLI 가 곁들여 쓰는 작은 모델도 들어 있다 — 부른 모델의 창 크기만 읽는다
    const window = msg.modelUsage?.[model]?.contextWindow;
    if (window) out({ t: 'usage', window });
    if (msg.is_error) out({ t: 'error', message: String(msg.result || msg.subtype || 'Claude CLI 가 오류로 끝났습니다.') });
  }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function codexEvents(msg, out) {
  if (msg.type === 'thread.started') out({ t: 'session', id: msg.thread_id });
  else if (msg.type === 'item.completed' && msg.item.type === 'agent_message') {
    out({ t: 'text_start' });
    out({ t: 'text', d: msg.item.text });
  } else if (msg.type === 'item.started' && msg.item.type === 'mcp_tool_call' && msg.item.server === SUBAGENT_SERVER) {
    out(subagentEvent(msg.item.tool, typeof msg.item.arguments === 'string' ? safeJson(msg.item.arguments) : msg.item.arguments));
  } else if (msg.type === 'item.started' && msg.item.type === 'mcp_tool_call') {
    out({ t: 'tool', name: `MCP ${msg.item.server ?? ''}`, summary: String(msg.item.tool ?? '') });
  } else if (msg.type === 'item.completed' && msg.item.type === 'web_search') {
    // 검색어는 끝난 뒤(item.completed)에야 채워진다
    out({ t: 'tool', name: 'WebSearch', summary: String(msg.item.query ?? msg.item.action?.query ?? msg.item.action?.url ?? '').slice(0, 160) });
  } else if (msg.type === 'item.started' && msg.item.type === 'command_execution') {
    // "powershell.exe -Command \"…\"" 껍데기를 걷어 내고 실제 명령만 보여 준다
    const command = String(msg.item.command).replace(/^.*?-Command\s+/i, '').replace(/^["']|["']$/g, '');
    out({ t: 'tool', name: '명령 실행', summary: command.slice(0, 120) });
  } else if (msg.type === 'turn.completed' && msg.usage) {
    // 턴 안의 모든 호출을 더한 값이라 도구를 여러 번 쓴 턴에서는 실제 컨텍스트보다 크다 — 세션 기록을 읽지 못할 때만 어림값으로 쓴다
    out({ t: 'usage', used: (msg.usage.input_tokens || 0) + (msg.usage.output_tokens || 0), approx: true });
  } else if (msg.type === 'error' || msg.type === 'turn.failed') {
    out({ t: 'error', message: String(msg.message || msg.error?.message || 'Codex CLI 가 오류로 끝났습니다.') });
  }
}

// Codex 는 JSON 출력에 컨텍스트 크기를 주지 않는다. 세션 기록(~/.codex/sessions/연/월/일/rollout-…-<thread id>.jsonl)의
// 마지막 token_count 에 마지막 호출의 토큰 수와 컨텍스트 창 크기가 있다. 기록을 찾지 못하면 null.
const rollouts = new Map(); // thread id → 기록 파일
async function codexContext(threadId) {
  if (!threadId) return null;
  try {
    if (!rollouts.has(threadId)) {
      const base = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
      const pad = n => String(n).padStart(2, '0');
      for (const day of [0, 1].map(back => new Date(Date.now() - back * 86_400_000))) { // 세션은 서버가 떠 있는 동안만 이어지므로 오늘·어제만 본다
        const dir = path.join(base, String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
        const name = (await fs.promises.readdir(dir).catch(() => [])).find(f => f.endsWith(`${threadId}.jsonl`));
        if (name) { rollouts.set(threadId, path.join(dir, name)); break; }
      }
    }
    const file = rollouts.get(threadId);
    if (!file) return null;
    const handle = await fs.promises.open(file, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, 256 * 1024);
      const { buffer } = await handle.read(Buffer.alloc(length), 0, length, size - length);
      for (const line of buffer.toString('utf8').split(/\r?\n/).reverse()) {
        if (!line.includes('"token_count"')) continue;
        const info = safeJson(line)?.payload?.info;
        if (info?.last_token_usage) return { used: info.last_token_usage.total_tokens, window: info.model_context_window || null };
      }
    } finally {
      await handle.close();
    }
  } catch { /* 기록 형식이 바뀌었거나 읽지 못하면 어림값을 쓴다 */ }
  return null;
}

// ───────────────────────────── 실행 ─────────────────────────────

// 한 턴을 실행한다. onEvent 로 공통 이벤트를 흘려보내고, 끝나면 { sessionId, aborted, failed, usage } 를 돌려준다.
// usage 는 { used, window, approx } — 이 세션의 현재 컨텍스트 사용량(토큰). 얻지 못하면 null.
// 돌려받은 handle.abort() 로 중간에 멈출 수 있다.
// 서브에이전트가 연결된 턴은 그 실행 시간까지 기다려야 하므로 제한 시간을 두 배로 잡는다. timeoutMs 를 주면 그 값을 쓴다.
export function runTurn({ kind, model, sessionId, systemPrompt, prompt, cwd, connections, persist, timeoutMs, tools }, onEvent) {
  if (!cliAvailable(kind)) throw new Error(`${kind} CLI 를 찾지 못했습니다. 설치·로그인한 뒤 서버를 다시 시작하세요.`);
  const { command, prefix } = resolved.get(kind);
  const args = [...prefix, ...(kind === 'claude' ? claudeArgs({ model, sessionId, systemPrompt, connections, persist, tools }) : codexArgs({ model, sessionId, connections }))];
  const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const parse = kind === 'claude' ? claudeEvents : codexEvents;

  let aborted = false;
  let failed = false;
  let stderr = '';
  let buffer = '';
  let session = sessionId || null;
  let usage = null;
  const out = event => {
    if (event.t === 'session') session = event.id;
    else if (event.t === 'usage') usage = { ...usage, ...event };
    else {
      if (event.t === 'error') failed = true;
      onEvent(event);
    }
  };

  const abort = () => {
    if (aborted || child.exitCode != null) return;
    aborted = true;
    // CLI 가 띄운 하위 프로세스까지 함께 끝낸다
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGTERM');
  };
  const limit = timeoutMs || TURN_TIMEOUT_MS * (connections?.subagents ? 2 : 1);
  const timer = setTimeout(() => {
    onEvent({ t: 'error', message: `응답이 ${Math.round(limit / 60000)}분을 넘어 중단했습니다.` });
    failed = true;
    abort();
  }, limit);

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim().startsWith('{')) continue;
      try {
        parse(JSON.parse(line), out, model);
      } catch { /* JSON 이 아닌 진행 표시 줄은 건너뛴다 */ }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
  child.stdin.on('error', () => {}); // CLI 가 먼저 끝나면 EPIPE 가 난다 — 종료 코드로 처리한다
  child.stdin.end(prompt, 'utf8');

  const done = new Promise((resolve, reject) => {
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', async code => {
      clearTimeout(timer);
      if (kind === 'codex' && usage) usage = (await codexContext(session)) || usage;
      if (code !== 0 && !aborted && !failed) onEvent({ t: 'error', message: `${kind} CLI 가 종료 코드 ${code} 로 끝났습니다. ${stderr.trim().split('\n').slice(-3).join(' ')}`.trim() });
      resolve({ sessionId: session, aborted, failed: failed || (code !== 0 && !aborted), usage: usage?.used ? { used: usage.used, window: usage.window || null, approx: Boolean(usage.approx) } : null });
    });
  });
  return { done, abort };
}
