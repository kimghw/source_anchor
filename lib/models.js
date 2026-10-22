// 에이전트 모델 선택지 — 키는 화면·API·연결 설정(서브에이전트)에서 쓰는 이름, model 은 CLI 에 넘기는 모델 ID
export const MODELS = {
  fable: { label: 'Fable', cli: 'claude', model: process.env.AGENT_MODEL_FABLE || 'claude-fable-5-1' },
  opus: { label: 'Opus', cli: 'claude', model: process.env.AGENT_MODEL_OPUS || 'claude-opus-5-5' },
  'codex-astra': { label: 'Codex Astra', cli: 'codex', model: process.env.AGENT_MODEL_ASTRA || 'gpt-6-astra' },
  sol: { label: 'Sol', cli: 'codex', model: process.env.AGENT_MODEL_SOL || 'gpt-5.6-sol' },
};

// 기준 문서 PDF 변환 모델 선택지 (FR-WB-097, 098) — Read 도구로 PDF 쪽을 읽어야 하므로 Claude 모델만. 기본은 최신 Opus
export const CONVERT_MODELS = {
  'claude-opus-5-5': 'Opus 5.5',
  'claude-fable-5-1': 'Fable 5.1',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-haiku-5-5': 'Haiku 5.5',
};
export const CONVERT_MODEL_DEFAULT = 'claude-opus-5-5';
