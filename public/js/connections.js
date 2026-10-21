// 에이전트 연결 설정 대화 상자 — MCP 서버·스킬·서브에이전트를 연결하고 anchor.md(에이전트 지침)를 고친다. 설정은 서버가 Claude·Codex 두 CLI 에 똑같이 넘긴다.
import { api } from './state.js';
import { fill, h, toast } from './util.js';

let config = { mcpServers: {}, skills: [], subagents: [], models: [], anchor: '', limits: {}, discovered: [] };
let onChange = () => {};

// 상단 머리줄의 연결 입구 — 어떤 문서를 열어도 보이고, 연결한 개수를 함께 표시한다 (FR-WB-053).
export function initConnections(root) {
  const count = h('span.count');
  const button = h('button.btn.ghost.conn-entry', { type: 'button', title: '에이전트가 쓸 MCP 서버·스킬·서브에이전트를 연결하고 anchor.md 를 고칩니다', onclick: openDialog }, '에이전트 연결', count);
  onChange = () => {
    const n = Object.keys(config.mcpServers).length + config.skills.length + config.subagents.length;
    count.textContent = n ? String(n) : '';
    count.hidden = !n;
  };
  onChange();
  root.append(button);
  api('GET', '/api/agent/config').then(data => { config = data; onChange(); }).catch(() => {});
}

async function save(next, extra = {}) {
  try {
    // anchor 는 anchor.md 를 저장할 때만 보낸다 — 다른 항목을 고칠 때 파일을 직접 고친 내용을 덮어쓰지 않게
    config = await api('PUT', '/api/agent/config', { mcpServers: next.mcpServers, skills: next.skills.map(s => s.path ?? s), subagents: next.subagents, ...(extra.anchor !== undefined ? { anchor: extra.anchor } : {}) });
    onChange();
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

function openDialog() {
  const body = h('div.conn-body');
  const dialog = h('dialog.dialog.conn-dialog',
    h('h2', '에이전트 연결'),
    h('p.muted', '여기서 연결한 MCP 서버·스킬·서브에이전트와 anchor.md 는 Claude(Fable·Opus)와 Codex(Codex Astra·Sol) 어느 모델을 골라도 똑같이 쓸 수 있습니다. 다음 메시지부터 적용됩니다.'),
    body,
    h('div.row-actions.end', h('button.btn', { type: 'button', onclick: () => dialog.close() }, '닫기')));
  const render = () => fill(body, mcpSection(render), skillSection(render), subagentSection(render), anchorSection(render));
  render();
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

// ───────────────────────────── MCP 서버 ─────────────────────────────

function mcpSection(render) {
  const name = h('input', { type: 'text', placeholder: '이름 (영문·숫자·-·_)', required: true, pattern: '[A-Za-z0-9_-]{1,40}' });
  const target = h('input', { type: 'text', placeholder: '실행 명령 (예: npx -y @modelcontextprotocol/server-filesystem E:/data)  또는  https://… URL', required: true });
  const env = h('input', { type: 'text', placeholder: '환경변수 (선택) KEY=값 KEY2=값' });
  const form = h('form.conn-form', {
    onsubmit: async event => {
      event.preventDefault();
      const value = target.value.trim();
      const server = /^https?:\/\//.test(value) ? { url: value } : (() => {
        const [command, ...args] = splitCommand(value);
        return { command, args, env: Object.fromEntries(splitCommand(env.value).map(pair => pair.split(/=(.*)/s).slice(0, 2))) };
      })();
      if (await save({ ...config, mcpServers: { ...config.mcpServers, [name.value.trim()]: server } })) render();
    },
  }, h('div.field-row', h('label.field.conn-name', '이름', name), h('label.field', '명령 또는 URL', target)), h('div.field-row', h('label.field', '환경변수', env), h('button.btn.small.conn-add', { type: 'submit' }, '＋ MCP 서버 연결')));

  const rows = Object.entries(config.mcpServers).map(([key, s]) => h('div.conn-row',
    h('span.type-badge.type-web', s.url ? 'HTTP' : 'STDIO'),
    h('div.conn-main', h('strong', key), h('code.conn-detail', s.url || [s.command, ...s.args].join(' '))),
    h('button.btn.small.ghost.danger', { type: 'button', onclick: async () => {
      const { [key]: removed, ...rest } = config.mcpServers;
      if (await save({ ...config, mcpServers: rest })) render();
    } }, '해제')));

  return h('section.conn-section',
    h('h3', 'MCP 서버', h('span.count', String(rows.length))),
    rows.length ? rows : h('p.muted', '연결한 MCP 서버가 없습니다.'),
    form,
    h('p.muted', 'MCP 서버는 이 PC 에서 실행되는 프로그램입니다. 신뢰하는 서버만 연결하세요. 에이전트는 MCP 도구를 쓰더라도 보고서는 수정안으로만 바꿉니다.'));
}

// 따옴표로 묶은 인자를 하나로 취급해 나눈다: npx -y "C:/my path/server.js"
function splitCommand(text) {
  return [...String(text).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
}

// ───────────────────────────── 스킬 ─────────────────────────────

function skillSection(render) {
  const connected = new Set(config.skills.map(s => s.path));
  const dir = h('input', { type: 'text', placeholder: 'SKILL.md 가 들어 있는 폴더 경로', required: true });
  const form = h('form.conn-form', {
    onsubmit: async event => {
      event.preventDefault();
      if (await save({ ...config, skills: [...config.skills, dir.value.trim()] })) render();
    },
  }, h('div.field-row', h('label.field', '폴더로 연결', dir), h('button.btn.small.conn-add', { type: 'submit' }, '＋ 스킬 연결')));

  const row = (s, on) => h('label.conn-row.conn-skill',
    h('input', { type: 'checkbox', checked: on, onchange: async event => {
      const skills = event.target.checked ? [...config.skills, s.path] : config.skills.filter(x => x.path !== s.path);
      if (!(await save({ ...config, skills }))) event.target.checked = !event.target.checked;
      render();
    } }),
    h('div.conn-main', h('strong', s.name, s.missing && h('span.is-bad', ' (폴더를 찾지 못함)')), h('span.conn-detail', s.description || s.path)));

  const others = config.discovered.filter(s => !connected.has(s.path));
  return h('section.conn-section',
    h('h3', '스킬', h('span.count', String(config.skills.length))),
    config.skills.map(s => row(s, true)),
    others.length > 0 && h('p.conn-sub', '이 PC 에서 찾은 스킬 (~/.claude/skills · ~/.codex/skills)'),
    others.map(s => row(s, false)),
    form,
    h('p.muted', '스킬은 에이전트가 따를 지침 묶음(SKILL.md)입니다. 에이전트는 읽기 전용으로 실행되므로 스크립트 실행이나 파일 쓰기가 필요한 단계는 수행하지 않습니다.'));
}

// ───────────────────────────── 서브에이전트 ─────────────────────────────

// 채팅에서 응답하는 에이전트가 과제를 나눠 맡길 보조 에이전트 (FR-WB-054). 같은 이름으로 다시 등록하면 고쳐진다.
function subagentSection(render) {
  const existing = value => config.subagents.find(s => s.name.toLowerCase() === value.trim().toLowerCase());
  const submit = h('button.btn.small.conn-add', { type: 'submit' }, '＋ 서브에이전트 등록');
  const name = h('input', { type: 'text', placeholder: '이름 (영문·숫자·-·_)', required: true, pattern: '[A-Za-z0-9_-]{1,40}', oninput: () => { submit.textContent = existing(name.value) ? '고친 내용 저장' : '＋ 서브에이전트 등록'; } });
  const model = h('select', config.models.map(m => h('option', { value: m.key }, m.available ? m.label : `${m.label} (CLI 없음)`)));
  const role = h('textarea', { rows: 3, placeholder: '역할 지침 (선택) — 예: 법령·고시 원문만 찾는다. 찾은 자료마다 URL·발행기관·발행일을 적는다.' });
  const form = h('form.conn-form', {
    onsubmit: async event => {
      event.preventDefault();
      const item = { name: existing(name.value)?.name ?? name.value.trim(), model: model.value, instructions: role.value.trim() };
      if (await save({ ...config, subagents: [...config.subagents.filter(s => s.name !== item.name), item] })) render();
    },
  }, h('div.field-row', h('label.field.conn-name', '이름', name), h('label.field.conn-name', '모델', model)), h('div.field-row', h('label.field', '역할 지침', role), submit));

  const label = key => config.models.find(m => m.key === key)?.label ?? key;
  const rows = config.subagents.map(s => h('div.conn-row',
    h('span.type-badge.type-web', label(s.model)),
    h('div.conn-main', h('strong', s.name), h('span.conn-detail', { title: s.instructions }, s.instructions || '역할 지침 없음 — 에이전트가 맡기는 과제만 따릅니다')),
    h('button.btn.small.ghost', { type: 'button', onclick: () => {
      name.value = s.name;
      model.value = s.model;
      role.value = s.instructions;
      name.dispatchEvent(new Event('input'));
      role.focus();
    } }, '고치기'),
    h('button.btn.small.ghost.danger', { type: 'button', onclick: async () => {
      if (await save({ ...config, subagents: config.subagents.filter(x => x.name !== s.name) })) render();
    } }, '해제')));

  return h('section.conn-section',
    h('h3', '서브에이전트', h('span.count', String(rows.length))),
    rows.length ? rows : h('p.muted', '등록한 서브에이전트가 없습니다.'),
    form,
    h('p.muted', `서브에이전트는 채팅에서 응답하는 에이전트가 조사 과제를 나눠 맡기는 보조 에이전트입니다(${config.limits.subagents ?? 8}개까지). 고른 모델의 CLI 로 읽기 전용(원문 읽기·웹 검색)으로 실행되어 문서를 바꾸지 못하고, 알려 준 내용은 원문으로 수집된 뒤에야 근거가 됩니다. 채팅에서 "fable 과 codex 에게 나눠 조사시켜 줘"처럼 이름으로 시킬 수 있습니다. 서브에이전트를 부를 때마다 그 모델의 사용량이 듭니다.`));
}

// ───────────────────────────── anchor.md ─────────────────────────────

// 작업공간의 anchor.md — 에이전트가 대화를 시작할 때 먼저 받는 작성자의 지침 (FR-WB-057)
function anchorSection(render) {
  const text = h('textarea', { rows: 8, value: config.anchor, placeholder: ['예)', '- 통계는 통계청·한국은행 등 1차 출처만 채택한다.', '- 문장은 "~이다" 체로 쓴다.', '- 수치에는 기준 시점을 함께 적는다.'].join('\n') });
  const form = h('form.conn-form', {
    onsubmit: async event => {
      event.preventDefault();
      if (await save(config, { anchor: text.value })) {
        toast('anchor.md 를 저장했습니다. 다음 메시지부터 적용됩니다.');
        render();
      }
    },
  }, h('label.field', 'workspace/anchor.md', text), h('div.row-actions.end', h('button.btn.small', { type: 'submit' }, 'anchor.md 저장')));

  return h('section.conn-section',
    h('h3', 'anchor.md — 에이전트 지침'),
    form,
    h('p.muted', `에이전트(서브에이전트 포함)가 대화를 시작할 때 가장 먼저 받는 지침입니다. 늘 지키게 할 작성 규칙·출처 기준·용어를 적어 두세요. 파일을 직접 고쳐도 되고, 대화 도중 바뀌면 다음 메시지에 다시 전달됩니다. 에이전트에게는 앞에서 ${(config.limits.anchor ?? 20000).toLocaleString()}자까지 전달됩니다.`));
}
