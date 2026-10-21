// 에이전트 모델 선택지 — 키는 화면·API·연결 설정(서브에이전트)에서 쓰는 이름, model 은 CLI 에 넘기는 모델 ID
export const MODELS = {
  fable: { label: 'Fable', cli: 'claude', model: process.env.AGENT_MODEL_FABLE || 'claude-fable-5-1' },
  opus: { label: 'Opus', cli: 'claude', model: process.env.AGENT_MODEL_OPUS || 'claude-opus-5' },
  'codex-astra': { label: 'Codex Astra', cli: 'codex', model: process.env.AGENT_MODEL_ASTRA || 'gpt-6-astra' },
  sol: { label: 'Sol', cli: 'codex', model: process.env.AGENT_MODEL_SOL || 'gpt-5.6-sol' },
};
