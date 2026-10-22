// 시험용 가짜 Claude CLI — stream-json 으로 한 턴을 흉내 낸다 (lib/cli.js 가 CLAUDE_CLI 의 .mjs 를 node 로 띄운다).
// 대화 분류 지침이면 <toc> 의 첫 장과 정해진 주제·제목을 JSON 으로, 그 밖에는 앞선 문답을 받았는지와 받은 요청을 답하고 목차 수정안 블록을 하나 붙인다.
// 데이터 분석 지침이면 요청의 마지막 줄 「write <경로> | delete <경로>」대로 작업 폴더의 results/ 에 파일을 쓰거나 지우고, 받은 도구 인자를 답에 적는다.
// 서브에이전트 지침이면 받은 도구 인자만 답한다.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = name => (args.includes(name) ? args[args.indexOf(name) + 1] : '');
const system = arg('--system-prompt');
let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;

const out = message => process.stdout.write(`${JSON.stringify(message)}\n`);
out({ type: 'system', subtype: 'init', session_id: `fake-${process.pid}` });

let text;
const carried = () => (prompt.includes('<earlier_conversation>') ? '앞선 문답을 받았습니다' : '앞선 문답이 없습니다');
if (system.includes('You file away a conversation')) {
  const chapter = prompt.match(/<toc>\n(R-\d{3,})/)?.[1] ?? null;
  text = `분류입니다.\n${JSON.stringify({ chapter, topic: '용어 통일', title: '장 사이 용어 맞추기' })}`;
} else if (system.includes('data analysis assistant')) {
  const request = prompt.trim().split('\n').at(-1);
  const [verb, rel, pace] = request.split(/\s+/);
  if (pace === 'slow') await new Promise(resolve => setTimeout(resolve, 4000)); // 화면 시험 — 답하는 동안 다른 화면으로 옮겨 본다
  const file = rel ? path.join(process.cwd(), 'results', ...rel.split('/')) : null;
  if (verb === 'write') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ request }));
  } else if (verb === 'delete') fs.rmSync(file, { force: true });
  const listed = prompt.match(/result files in results\/ \((\d+)\)/)?.[1] ?? '?';
  const guide = prompt.match(/^- (G-\d{3,}) \[/m)?.[1];
  text = `${carried()}. 결과 ${listed}개를 보았습니다. tools=${arg('--tools')} allowed=${arg('--allowedTools')}${guide ? ` 근거 ${guide}.b1.s1` : ''}${verb === 'write' ? ` 파일 results/${rel}` : ''}`;
} else if (system.includes('a research subagent')) {
  text = `subagent tools=${arg('--tools')} allowed=${arg('--allowedTools')}`;
} else {
  const request = prompt.trim().split('\n').at(-1);
  text = `${carried()}. 요청: ${request}\n\n\`\`\`sourceanchor\n{"toc": []}\n\`\`\``;
}
out({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } });
out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
out({ type: 'result', subtype: 'success', is_error: false, result: text });
