// 시험용 가짜 Claude CLI — stream-json 으로 한 턴을 흉내 낸다 (lib/cli.js 가 CLAUDE_CLI 의 .mjs 를 node 로 띄운다).
// 대화 분류 지침이면 <toc> 의 첫 장과 정해진 주제·제목을 JSON 으로, 그 밖에는 앞선 문답을 받았는지와 받은 요청을 답하고 목차 수정안 블록을 하나 붙인다.
const args = process.argv.slice(2);
const system = args[args.indexOf('--system-prompt') + 1] || '';
let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;

const out = message => process.stdout.write(`${JSON.stringify(message)}\n`);
out({ type: 'system', subtype: 'init', session_id: `fake-${process.pid}` });

let text;
if (system.includes('You file away a conversation')) {
  const chapter = prompt.match(/<toc>\n(R-\d{3,})/)?.[1] ?? null;
  text = `분류입니다.\n${JSON.stringify({ chapter, topic: '용어 통일', title: '장 사이 용어 맞추기' })}`;
} else {
  const request = prompt.trim().split('\n').at(-1);
  const carried = prompt.includes('<earlier_conversation>') ? '앞선 문답을 받았습니다' : '앞선 문답이 없습니다';
  text = `${carried}. 요청: ${request}\n\n\`\`\`sourceanchor\n{"toc": []}\n\`\`\``;
}
out({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } });
out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
out({ type: 'result', subtype: 'success', is_error: false, result: text });
