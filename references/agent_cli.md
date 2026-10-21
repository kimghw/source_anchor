# 에이전트 CLI 헤드리스 호출 — Claude Code CLI · Codex CLI

외부 CLI 의 동작·제약을 모아 둔다. 2026-09-20, Windows 11 에서 `claude` 2.1.258 · `codex-cli` 0.153.4 로 확인.

## 공통

- 두 CLI 모두 사용자가 로그인해 둔 계정으로 동작한다(API 키 불필요). 호출마다 구독 한도를 쓴다.
- 프롬프트는 stdin 으로 넘긴다(UTF-8). 인자로 넘기면 Windows 명령줄 길이(약 32k)와 인용 문제에 걸린다.
- npm 이 만든 `*.cmd` 는 Node 에서 셸 없이 `spawn` 할 수 없다(EINVAL). 옆의 `node_modules/<패키지>/…js` 진입 스크립트를 `node` 로 띄운다. `claude` 는 네이티브 설치면 `claude.exe` 라 그대로 실행된다.
- Windows 에서 하위 프로세스까지 끝내려면 `taskkill /pid <pid> /T /F`.

## Claude Code CLI

- 헤드리스: `claude -p --model <id> --output-format stream-json --verbose --include-partial-messages`. `stream-json` 은 `--verbose` 가 있어야 한다.
- 도구 제한: `--tools "Read,Grep,Glob" --allowedTools "Read,Grep,Glob"`. 웹 검색·읽기는 내장 도구 `WebSearch`·`WebFetch` 를 두 목록에 모두 넣으면 `-p` 모드에서 승인 없이 호출된다 (확인). `tool_use` 입력은 `WebSearch` 가 `query`, `WebFetch` 가 `url`·`prompt`. `WebFetch` 의 결과는 작은 모델이 간추린 글이라 원문 그대로가 아니다 — 원문 보관용으로는 쓸 수 없다. `--setting-sources ""` 와 `--strict-mcp-config` 로 사용자·프로젝트 설정(훅, MCP)을 끌어오지 않게 한다.
- 시스템 프롬프트: `--system-prompt`(교체) / `--append-system-prompt`(덧붙임).
- 대화 이어 가기: `init` 이벤트의 `session_id` 를 받아 다음 턴에 `--resume <id>`. 세션은 작업 폴더(cwd) 기준으로 저장되므로 같은 cwd 에서 재개한다. `--no-session-persistence` 를 쓰면 재개할 수 없다.
- 세션 기록 파일: `~/.claude/projects/<cwd 를 `-` 로 바꾼 이름>/<session_id>.jsonl` (예: 보고서 에이전트 cwd `%TEMP%sourceanchor-agentook` → `C--Users-<user>-AppData-Local-Temp-sourceanchor-agent-book`). 줄마다 `type`(user·assistant·attachment·queue-operation·last-prompt …)과 `timestamp` 가 있고 `message.content` 에 text·thinking·tool_use·tool_result 가 든다. 에이전트가 실제로 무엇을 냈는지(답 끝의 블록 포함) 확인할 때 이 파일을 본다.
- 턴 중간에 프로세스를 죽이면(`taskkill /T /F`) 생성 중이던 assistant 메시지는 세션 파일에 남지 않는다 — 화면에 스트리밍된 글은 있어도 기록엔 없다. 그 세션을 `--resume` 하면 CLI 가 열린 tool_result 를 닫으려고 합성 문답 `Continue from where you left off.` → `No response requested.`(stop_reason `stop_sequence`) 을 끼워 넣은 뒤 새 프롬프트를 보낸다 (2026-09-23 확인).
- 이벤트(JSON 한 줄씩): `system/init`(session_id) → `stream_event`(Messages API 스트림 이벤트: `content_block_start`, `content_block_delta/text_delta` …) → `assistant`(완성된 메시지, `tool_use` 입력 포함) → `user`(tool_result) → `result`(`is_error`, `total_cost_usd`). `rate_limit_event` 가 끼어든다.
- 모델 ID: `claude-fable-5-1`, `claude-opus-5`.
- 컨텍스트 사용량: `assistant` 이벤트마다 `message.usage`(`input_tokens` · `cache_creation_input_tokens` · `cache_read_input_tokens` · `output_tokens`)가 있고, 넷을 더한 값이 그 호출 직후의 컨텍스트 크기다. `result` 의 `usage` 는 턴 합계다. 컨텍스트 창 크기는 `result.modelUsage["<모델 ID>"].contextWindow`(opus-5 는 1,000,000) — `modelUsage` 에는 CLI 가 곁들여 부르는 작은 모델(haiku)도 들어 있으므로 부른 모델 ID 로 골라 읽는다 (확인).
- MCP: `--mcp-config <파일>`(`{"mcpServers": {"이름": {"command", "args", "env"} | {"type": "http", "url"}}}`) + `--strict-mcp-config`. `-p` 모드에서는 허용 목록에 없는 도구가 거절되므로 `--allowedTools` 에 `mcp__<서버이름>` 을 넣어야 호출된다(서버 단위 허용). `--tools` 는 내장 도구만 제한하고 MCP 도구에는 영향이 없다 (확인).
- cwd 의 상위 폴더에 `CLAUDE.md` 가 있으면 읽힐 수 있으므로, 에이전트 작업 폴더는 저장소 밖에 둔다.
- 한 번 답하고 끝나는 호출은 `--no-session-persistence` 를 붙이면 세션 파일을 남기지 않는다(`-p` 와 함께 동작 확인).
- 서브에이전트: CLI 자체 기능으로는 `--agents <json>` + Task 도구가 있지만 Claude 계열 모델만 부를 수 있다. 다른 제공자의 모델까지 서브에이전트로 쓰려면 아래 "CLI 가 CLI 를 부르기"처럼 MCP 도구로 감싼다.

## CLI 가 CLI 를 부르기 (MCP 도구 안에서 다른 CLI 실행)

- stdio MCP 서버의 도구 안에서 `claude -p` / `codex exec` 를 다시 띄워도 된다. Claude → (MCP) → Codex, Codex → (MCP) → Claude 두 방향 모두 로그인 계정 그대로 동작한다 (확인). 안쪽 CLI 에 MCP 설정을 넘기지 않으면 재귀하지 않는다.
- stdio MCP 는 줄마다 JSON-RPC 메시지 하나다. 서버가 다뤄야 하는 것은 `initialize`(클라이언트가 보낸 `protocolVersion` 을 그대로 돌려주면 두 CLI 모두 붙는다) · `notifications/initialized` · `ping` · `tools/list` · `tools/call` · `notifications/cancelled`(`params.requestId`). stdout 에 JSON-RPC 가 아닌 글을 쓰면 안 된다(로그는 stderr).
- MCP 서버 프로세스에 넘어가는 환경변수: Claude 는 부모 환경을 그대로 넘긴다. Codex 는 정해진 목록만 넘기고(Windows: `PATH` `PATHEXT` `COMSPEC` `SYSTEMROOT` `SYSTEMDRIVE` `USERNAME` `USERDOMAIN` `USERPROFILE` `HOMEDRIVE` `HOMEPATH` `PROGRAMFILES*` `PROGRAMDATA` `LOCALAPPDATA` `APPDATA` `TEMP` `TMP` … — 0.153.4 실행 파일의 문자열에서 확인) 그 밖의 값은 `mcp_servers.<이름>.env` 로 직접 줘야 한다.
- 도구 하나가 몇 분씩 걸릴 때: Codex 는 `-c mcp_servers.<이름>.tool_timeout_sec=<초>` 로 도구 호출 제한 시간을 늘린다(키는 0.153.4 실행 파일에 있음 — 기본값 60초는 문서 기억에 따른 값으로 미확인). `startup_timeout_sec` 은 서버 기동 제한 시간. Claude 는 `MCP_TOOL_TIMEOUT`(ms) 환경변수로 조절하며 기본값은 길다고 알려져 있다(수십 초짜리 호출만 확인 — 몇 분짜리 호출은 미확인).
- 도구 정의에 `annotations: { readOnlyHint: true }` 를 주면 Claude 가 같은 단계의 여러 호출을 동시에 돌릴 수 있다(문서 기억 — 미확인). 서버 쪽은 요청을 비동기로 받아 동시에 처리해야 한다.

## Codex CLI

- 헤드리스: `codex exec --json --skip-git-repo-check --sandbox read-only -m <model> -` (`-` 는 stdin 프롬프트). 시스템 프롬프트 인자가 없어 지침은 첫 프롬프트에 넣는다(cwd 의 `AGENTS.md` 도 읽는다).
- 설정 덮어쓰기: `-c key=value`(값은 TOML). 예: `-c model_reasoning_effort="medium"`, `-c notify=[]`(사용자 설정의 턴 종료 알림 프로그램 끄기), `-c sandbox_mode="read-only"`.
- 대화 이어 가기: `thread.started` 이벤트의 `thread_id` 를 받아 `codex exec resume <thread_id> --json … -`. `resume` 에는 `-s/--sandbox` 가 없어 `-c sandbox_mode=…` 로 준다.
- 이벤트: `thread.started` → `turn.started` → `item.started/completed`(`agent_message` 는 완성된 글 단위, `command_execution` 은 명령·출력) → `turn.completed`(usage) 또는 `turn.failed`/`error`. 글자 단위 스트리밍은 없다.
- 컨텍스트 사용량: `turn.completed.usage`(`input_tokens` · `cached_input_tokens` · `output_tokens` …)는 **그 턴의 합계**다(이어 간 다음 턴에서 누적되지 않음 — 확인). 컨텍스트 창 크기와 마지막 호출의 토큰 수는 `--json` 출력에 없고, 세션 기록 `~/.codex/sessions/YYYY/MM/DD/rollout-<시각>-<thread id>.jsonl` 의 `payload.type == "token_count"` 줄에 `info.last_token_usage.total_tokens` · `info.model_context_window`(sol 은 258,400 = `models_cache.json` 의 `context_window` 272,000 × `effective_context_window_percent` 95%)로 남는다. `resume` 해도 같은 파일에 이어 쓴다 (확인). 같은 줄의 `rate_limits.primary.used_percent` 로 구독 한도 사용률도 알 수 있다.
- 모델 ID(`~/.codex/models_cache.json`): `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5` …. 추론 강도 `low`~`max`(일부 `ultra`). 사용자 기본값이 `ultra` 면 채팅 용도로는 매우 느리므로 호출할 때 낮춘다.
- **Windows 인코딩**: read-only 샌드박스에서 파일을 PowerShell `Get-Content` 로 읽는데, BOM 없는 UTF-8 한글이 깨져 보인다(콘솔 코드페이지로 해석). 파일에 UTF-8 BOM 을 붙이거나, 내용을 stdin 프롬프트에 직접 넣으면 깨지지 않는다.
- MCP: `-c mcp_servers.<이름>.command="…"`, `-c mcp_servers.<이름>.args=[…]`, `-c mcp_servers.<이름>.env={…}`, HTTP 는 `-c mcp_servers.<이름>.url="…"`. **`codex exec` 에서는 MCP 도구 호출이 승인 대기 없이 거절된다**("실행 승인이 허용되지 않은 환경"). `-c mcp_servers.<이름>.default_tools_approval_mode="approve"` 를 주면 호출된다 (확인). 이벤트는 `item.started/completed` 의 `mcp_tool_call`(server, tool, arguments, result) — `arguments` 는 `item.started` 에 이미 들어 있다 (확인. 객체인지 JSON 문자열인지는 가리지 않고 둘 다 받게 해 두었다).
- 웹 검색: `codex --search exec …` — **`--search` 는 최상위 옵션이라 `exec` 앞에 와야 한다**(`codex exec --search` 는 인자 오류). read-only 샌드박스에서도 동작한다(검색은 모델 제공자 쪽 도구라 샌드박스의 네트워크 차단과 무관). 이벤트는 `item.started`/`item.completed` 의 `web_search` 이고, 검색어(`item.query`)는 `item.completed` 에만 들어 있다(`item.started` 에는 `action: {type: "other"}` 뿐) (확인).
- 파일 수정 작업은 `--sandbox workspace-write -C <dir>`, 참고 이미지는 `-i <file>`, 마지막 답변 저장은 `-o <file>`.
- 계획 검토(협의)용 헤드리스 호출: `codex exec --skip-git-repo-check --sandbox read-only -C <저장소> -c 'model_reasoning_effort="high"' -c 'notify=[]' --color never -o <답 파일> - < <계획 파일>` — stdin(`-`)으로 긴 한국어 프롬프트를 넘기고 `-o` 로 마지막 답만 받는다. read-only 샌드박스에서도 저장소 파일을 읽어 사실을 확인한다(2026-09-26: 1만 자 계획 검토에 약 5분, 이벤트 로그 370KB — `--json` 없이도 stdout 에 진행 로그가 많아 파일로 돌린다). `-C` 에 `E:/dev/...` 슬래시 경로가 된다. 답의 형식(`## 판정` 같은 제목)을 프롬프트에 지정하면 그대로 지킨다.
