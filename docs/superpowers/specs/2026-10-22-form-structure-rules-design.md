# 양식 구조 조절(상하관계) + 구조 규칙 — 설계 (2026-10-22)

양식 화면의 세부 계층에서 **제목(헤딩)·필드의 상하관계를 작성자가 조절**하고(예: 같은 수준 1 로 추출된
#1051 「[공동연구개발기관2(한국선급)]」과 #1052 「o 선급규정·국제표준 간 규정 공백 분석 …」은 사실 #1051 이
#1052 를 포함한다), **작성자가 정한 규칙을 보관해** 같은 양식으로 다른 문서를 올릴 때 같은 제목 아래 같은
단위는 자동으로 맞추고, 그 밖의 경우는 **에이전트가 규칙을 프롬프트로 참고**해 수준을 제안하게 한다.

이 문서는 설계다. 요구사항 정본은 `spec/spec_workbench.md`(아래 「사양서 반영」), 구현 지도는 `spec/INDEX.md` 의
「양식 구조 조절 · 구조 규칙」 행. 양식 기능 자체는 [2026-10-21-form-fill-design.md](2026-10-21-form-fill-design.md),
hwp·목차 후보는 [2026-10-22-hwp-toc-import-design.md](2026-10-22-hwp-toc-import-design.md).

## 1. 의도와 이유

- 본문 문단의 분류(`classify`)는 글머리·개요·스타일 **힌트**로 수준을 매긴다. 「[이름표]」 줄과 그 아래 「o …」
  줄처럼 힌트가 같아 같은 수준이 되는 경우가 있고, 문서가 품은 의미(포함관계)는 작성자만 안다.
- 한 번 고친 상하관계는 **같은 양식의 다음 문서**에서도 같다(정부 과제 양식은 해마다 같은 틀로 온다). 작성자가
  매번 되풀이하지 않도록 조절을 규칙으로 남긴다.
- 글이 조금 다른 단위(「o 선급규정 …」 대신 「o 국제표준 …」)는 기계적으로 맞출 수 없다. 그건 **에이전트가
  규칙을 보고 유추**하되, 바꾸는 것은 늘 작성자다(에이전트는 제안만 — 프로젝트 불변식).

## 2. 목표 · 비목표 · 반목표

목표
- 1열의 제목·필드 줄마다 수준(1~6)과 종류(제목↔필드)를 조절하고, 자동 저장·다시 열어도 유지.
- 조절을 작업공간 수준의 구조 규칙으로 보관 → 올릴 때 자동 적용(같은 제목 아래 같은 글) → 에이전트에게 매 턴
  전달 → 구조 수정안 카드(반영·거부·모두 반영).
- 번호 체계·값·지침·내보내기·목차 후보 등 기존 양식 기능은 그대로.

비목표(이번에 안 함)
- 표 자리·표 칸의 구조 조절. 단위의 순서 바꾸기·단위 추가·삭제. 글 편집과 구조 조절의 결합(글을 고치면 규칙 열쇠가
  달라질 뿐이다).
- 규칙의 편집 화면(규칙은 조절로 만들고, 목록에서 지우기만 한다). 규칙의 보고서별·양식별 범위 지정.
- 수준이 바뀐 결과를 내보내기 파일의 서식(글머리·개요 번호)에 반영하는 것 — 수준은 화면·에이전트·목차 후보에만
  뜻이 있다.

반목표(이러면 실패)
- 조절로 다른 단위의 **번호가 밀리는 것** — 지침·값·에이전트 대화의 `#번호` 가 모두 어긋난다.
- 작성자가 보지 않은 채 에이전트가 구조를 바꾸는 것.
- 규칙이 글이 다른 단위에 기계적으로 적용되어 엉뚱한 수준이 되는 것.

## 3. 결정

- **D1 상하관계 = 노드의 수준(1~6, `FORM_LEVEL_MAX = 6`)과 종류(heading / field).** 스캔은 지금처럼 1~3 만
  매기고 작성자가 더 깊게 둘 수 있다. 1열의 제목·필드 줄마다 ⇤·⇥(수준)과 「제목으로」/「필드로」(종류) 조작.
  표 자리·표 칸은 대상이 아니다. 이유: 노드 모델에 이미 `kind`·`level` 이 있어 새 저장 구조가 필요 없고,
  「포함관계」는 결국 수준 차이로 표현된다. 수준 3 상한은 목차(장·챕터·헤딩)의 것이지 본문 필드의 것이 아니다.
- **D2 번호는 흔들지 않는다.** 필드 → 제목이 되면 그 번호는 빠지되 노드에 `n` 을 남겨 되돌리면 같은 번호를 쓴다.
  제목 → 필드는 남긴 `n` 이 있으면 그것, 없으면 (모든 칸·필드 번호의 최댓값 + 1). 값·지침이 있는 필드를 제목으로
  바꾸면 값·지침은 지운다(화면이 confirm). 헤딩 바로 뒤의 빈 필드(`empty: true`)는 제목으로 바꿀 수 없다(400).
  이유: 번호는 지침·값·에이전트 대화·내려받기 확인이 공유하는 계약이라 다시 매길 수 없다. 빈 필드는 「그 헤딩의
  본문 자리」라는 구조적 약속이지 글이 아니다.
- **D3 구조 규칙은 작업공간 수준 `<WORKSPACE>/form_rules.json` 하나다.** 규칙 = `{ id: 'SR-001', heading, text,
  kind, level, from: { kind, level }, fileName, bookId, formId, at }`, 열쇠는 (heading, text) — heading 은 그 노드
  바로 앞 제목의 글, text 는 그 노드의 글(둘 다 `\s+` → ' ', trim). 같은 열쇠의 조절은 덮어쓰고, 원래(스캔) 상태로
  되돌리면 지운다. 상한 500건. 이유: 같은 양식은 보고서를 넘어 되풀이되므로 보고서 안에 두면 쓸모가 없다. 열쇠에
  앞 제목을 넣는 것은 같은 글(「o 개요」 등)이 문서 여러 곳에 나와도 자리를 구별하기 위해서다.
- **D4 올릴 때 자동 적용.** 스캔 뒤·번호를 매기기 전에 (앞 제목, 글)이 규칙과 같은 노드를 규칙의 종류·수준으로
  둔다(노드에 `rule: 규칙 id`, `orig` 에 스캔 결과). 응답에 적용 건수(`rulesApplied`), 화면은 toast. 글이 다르면
  적용하지 않는다. 이유: 번호 전에 적용해야 제목이 된 단위가 번호를 받지 않고, 글이 같은 때만 기계적으로 믿을 수
  있다 — 그 밖은 에이전트 몫(D5).
- **D5 에이전트는 제안만.** 양식 대화의 매 턴에 `<form_rules>`(규칙을 영어 한 줄씩)를 주고, 답 블록에 `structure`
  키를 허용한다 — 바꿀 노드마다 `{ target: '#1052' | 'h27', level?, kind?, reason }`(제목은 번호가 없으므로
  `<form>` 에서 `h<nodes index>` 로 보여 준다). 제안은 2열 카드(반영·거부·모두 반영)로, 반영하면 1열이 바뀌고
  저장되며 규칙도 남는다(작성자가 반영한 것이므로). 1열 머리줄 「규칙으로 수준 정하기」가 정해진 요청문을 2열에
  보낸다. 무효 항목은 `retryOnce` 로 한 번 되돌린다. 이유: 값 제안(`form`)과 같은 길 — 작성자가 보고 반영하는 것이
  프로젝트 불변식이고, 카드·stale·되돌리기 장치를 그대로 쓴다.
- **D6 목차 후보에서 작성자·규칙이 만든 제목(`by: 'user' | 'rule'`)은 구조적인 것으로 본다(기본 선택).** 이유:
  작성자가 제목이라고 정한 것은 개요·스타일만큼 믿을 만하다.

## 4. 계약 요약

### `lib/form_rules.js` (새 파일)

```js
export const RULES_LIMIT = 500;
export const cleanKey = text => String(text ?? '').replace(/\s+/g, ' ').trim();
export function contextOf(nodes, i)                  // i 번 노드 바로 앞 heading 의 cleanKey(text), 없으면 ''
export async function loadRules(workspaceDir)        // form_rules.json → rules[] (없거나 깨졌으면 조용히 [])
export async function saveRules(workspaceDir, rules) // 임시 파일 → rename
export function upsertRule(rules, { heading, text, kind, level, from, fileName, bookId, formId }) // 새 배열, 같은 열쇠는 교체(id 유지), 500 초과 400
export function removeRule(rules, idOrKey)           // 'SR-001' 또는 { heading, text }
export function matchRule(rules, heading, text)      // cleanKey 비교 → rule | undefined
export function applyRules(nodes, rules)             // → { nodes, applied: [{ i, ruleId }] } — 번호 매기기 전에 부른다
export function rulesText(rules)                     // 에이전트용 영어 한 줄씩, 없으면 ''
```

### `lib/forms.js` · `lib/store.js` · `server.js`

- `FORM_LEVEL_MAX = 6`. `scanForm(data, rules = [])` 는 classify 뒤·빈 필드 끼우기 전에 `applyRules`; 헤딩 노드도
  `locked`·`note` 를 싣는다(필드로 바꿨을 때 잠금이 살아야 한다). `buildForm({ …, rules })` → `{ form, original,
  rulesApplied }`.
- `applyStructure(form, structure)` → `[{ i, before, after, reverted }]`. structure = `[{ i, level?, kind? }]`. 검사:
  i 범위, 노드 종류(표 자리 400), level 1~6, kind heading|field, 바뀌는 것이 없으면 무시. 종류 바꾸기는 D2. 첫 변경 전
  `{ kind, level }` 을 `orig` 로 두고 `user: true`; 결과가 `orig` 와 같아지면 `orig`·`user`·`rule` 을 떼고 `reverted`.
  `formSummary` 에 `structured`(orig 가 있는 노드 수).
- store: `load()` 가 `cache.formRules` 를 읽는다. `addForm` 은 규칙을 넘겨 `{ form, forms, rulesApplied }`. `saveForm`
  은 `applyStructure` → `applyFormPatch` → `rewriteForm` → 변경마다 `reverted` 면 `removeRule`, 아니면 `upsertRule`
  → `saveRules` → `{ form, forms, rules }`. `listFormRules()`(동기) · `formRules()` · `deleteFormRule(id)`(없으면 404).
  `formAgentState` 에 `rules`.
- server: `GET /api/form-rules` → `{ rules }`, `DELETE /api/form-rules/<id>` → `{ rules }`. `PUT forms/<F>` 는 본문의
  `structure` 를 그대로 넘긴다.

### 에이전트 — `lib/form_agent.js` · `agent.js`

- `formLines`: 제목 줄을 `h<i> ## text` 로, 필드 수준은 1~6 그대로 `[L4]`. `rulesBlock(rules)` → `<form_rules>…
  </form_rules>` 또는 ''(`buildFormPrompt` 가 `formBlock` 뒤에 넣는다). `FORM_INSTRUCTIONS` 에 `<form_rules>` 의 뜻,
  제목 id `h<i>`, 선택적 `structure` 키(작성자가 구조·수준·상하관계를 묻거나 규칙 적용을 요청할 때만; `form` 과
  같은 펜스 블록에 함께 올 수 있다).
- `reviewStructure(raw, form)` → `{ id, target, i, text, before, level, kind, reason, problems, invalid? }`. 무효: target
  형식, 없는 번호·없는 h index, 표 자리, `empty` 필드를 제목으로, `after` 필드의 종류 변경, level 범위, 변화 없음.
- `agent.js`: `parseBlock` 에 `structure`; `formTurn` 은 form 검사 뒤 `retryOnce`(key 'structure')를 한 번 더 하고
  유효 항목이 있으면 `emit({ t: 'structure', id, model, items })`. 장·보고서 대화의 structure 블록은 안내만.

### 화면 — `public/js/form_structure.js`(새, forms.js 의 위성) · `forms.js` · `form_chat.js` · `shared/toc.js`

- 1열 줄 조작 `.form-struct`(⇤·⇥·「제목으로」/「필드로」, hover·focus-within 에만 보인다). 수준 1 의 ⇤, 6 의 ⇥ 은
  disabled; `empty` 필드엔 종류 버튼 없음; 값·지침이 있는 필드 → 제목은 confirm. 수준만 바뀌면 `lvl-n` class, 종류가
  바뀌면 `formBody` 다시 그리기 + `setFormView`. `pendingStructure`(Map) → `queueSave`; `putForm` 은 보내는 순간 비우고
  실패하면 되돌려 넣으며, 응답의 `form.nodes` 는 그새 새 변경이 없을 때만 받는다.
- 머리줄 「구조 규칙 N」(대화상자: 앞 제목 · 글 · 「필드 L1 → 제목 L1」 · 양식 · 시각 · ✕) · 「규칙으로 수준
  정하기」(규칙 없으면 disabled → `sendFormMessage(정해진 요청문)`). 올린 뒤 `rulesApplied > 0` 이면 toast.
- `form_chat.js`: `structure` 이벤트 → `.structure-item` 카드(대상 배지 · 「수준 1 → 2」「필드 → 제목」 · 사유 ·
  반영/거부 · 모두 반영) → `go.applyStructure(i, { level, kind })`; stale = `go.nodeState(i)` 가 `before`·`text` 와 다름.
  `export function sendFormMessage(text)`; handlers 에 `applyStructure`·`nodeState`.
- `headingCandidates`: `HEADING_BY` 에 'user'·'rule'(구조적 — 기본 선택). `toc_import.js` 배지 「작성자」「규칙」.

## 5. 검증

- `test/form_rules.test.js`: upsert(덮어쓰기·id 유지·새 id)/remove(id·열쇠)/match(cleanKey)/apply(orig·rule·번호
  전)/rulesText/load·save 왕복(없는 파일·깨진 파일)/500 상한.
- `test/forms.test.js`: applyStructure — 수준·종류·번호 보존(필드→제목→필드 같은 번호, 새 필드 최댓값+1)·값·지침
  삭제·빈 필드 거절·표 거절·orig/reverted; scanForm+rules 적용·헤딩 locked 보존; formSummary.structured.
- `test/form_store.test.js`: saveForm structure → 규칙 파일·목록·삭제(404); addForm 이 규칙을 적용하고 rulesApplied;
  formAgentState.rules.
- `test/form_agent.test.js`: `h<i>` 제목 id, rulesBlock, reviewStructure 유효·무효; parseBlock structure.
- `test/toc.test.js`: by 'user'·'rule' 기본 선택. `test/arch.test.js`·`test/syntax.test.js`.
- 화면·실모델: 복사본 작업공간 + 헤드리스 Edge 수동 확인(AC-WB-039 의 흐름 — 조절·새로 고침 유지·규칙 목록·
  같은 파일 다시 올리기 toast·「규칙으로 수준 정하기」 카드·stale·규칙 삭제).

## 6. 사양서 반영

`spec/spec_workbench.md` ① 2026-10-22 둘째 행(확정). ②: 용어에 「구조 조절·구조 규칙·구조 수정안」, FR-WB-090(수준
1~6·출처 작성자·규칙·조작·자동 저장)·FR-WB-091(구조 규칙 입력·구조 수정안)·FR-WB-093(후보 출처·기본 선택)·
DR-WB-008(원래 종류·수준·기억하는 번호)·ERR-WB-011(구조 조절 거절·규칙 한도·구조 수정안 무효) 정정, **FR-WB-094**
(양식 구조 조절)·**FR-WB-095**(구조 규칙)·**DR-WB-009**(`form_rules.json`)·**AC-WB-039** 신설. `spec/INDEX.md`
「양식 파일 작성」「문서 구조 가져오기」「HTTP API」「에이전트 대화」 행 보강과 「양식 구조 조절 · 구조 규칙」 행 신설.

## 7. 빌더에게 맡기는 것

- 조작 버튼의 세부 문구·CSS 값, 규칙 대화상자의 정렬, toast 문구의 자리.
- `rulesText` 의 영어 문장 형식(규칙의 뜻 — 앞 제목·글·바뀐 뒤·바뀌기 전 — 이 다 들어가면 된다).
- 종류를 바꾼 뒤 잎 제목 아래 빈 필드를 다시 끼울지(지금 결정: 올릴 때만 끼운다 — 바꾸지 않는다).
