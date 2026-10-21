# 양식 파일(docx·hwpx) 작성 — 설계 (2026-10-21)

AIComp 의 「양식 파일 폼」을 SourceAnchor 에 옮긴다. 양식 파일을 올리면 표를 1열(글을 쓰는
자리)에 그대로 그리고, 셀마다 번호를 붙이고, 번호별 지침을 두고, 같은 에이전트가 번호로 셀을
채우며, 다 쓰면 올린 형식 그대로(docx→docx, hwpx→hwpx) 내려받는다.

이 문서는 설계다. 요구사항 정본은 `spec/spec_workbench.md` 에 ID 로 적고(아래 「사양서 반영」),
구현 지도는 `spec/INDEX.md` 에 행을 더한다. 외부 형식 사실은 `references/docx_hwpx_format.md`.

## 1. 의도와 이유

- 보고서 작성 흐름 안에서 **정해진 양식(신청서·조사서·회의록)** 을 채워야 할 때가 있다.
  AIComp 가 같은 일을 하지만 Python/FastAPI 별도 앱이라 원문·기준 문서·에이전트가 끊긴다.
- SourceAnchor 에 넣으면 보고서의 원문(S-번호)·기준 문서(G-번호)·에이전트(CLI 읽기 전용)를
  그대로 쓰면서, 작성 결과를 양식 파일로 돌려줄 수 있다.
- AIComp 의 필드 탐지 휴리스틱(라벨 짝짓기·병합 머리글 합성·cell|rows|sec 종류)은 가져오지
  않는다. **모든 셀에 번호를 붙여 번호로만 가리킨다** — 사용자가 정한 단순화이며, 탐지 오류
  (AIComp spec_docx양식도구 ① 2026-08 기록)를 원천 제거한다.

## 2. 목표 · 비목표 · 반목표

목표
- docx·hwpx 양식을 올리면 표를 원본 배치(병합·폭·높이 근사)대로 1열에 그린다.
- 셀마다 문서 순서의 번호(#1…)를 붙인다. 번호는 화면·에이전트·지침·수정안 카드가 공유한다.
- 번호별 지침(프롬프트)을 화면에서 적고 고친다.
- 2열의 같은 에이전트가 `<form>` 을 받아 번호로 값을 제안하고, 작성자가 반영·거부한다.
- 값이 든 채로 원본 형식 그대로 내려받는다. 손대지 않은 부분은 바이트 그대로다.
- 기존 서버·저장소·화면 규약(사용자 지정 문서 C-번호 선례)에 맞춘다.

비목표(이번에 안 함)
- 반복 행 추가(rows), 중첩 표 안 셀 기입, 본문에 필드를 새로 끼워 넣기(빈 헤딩 아래 빈 필드 하나는 제외).
- 라벨 자동 인식·키 이름 생성, 지침 자동 생성(LLM 보강), 지침 YAML 가져오기·내보내기.
- 글머리·번호 패턴으로 서식 빌려오기(AIComp FR-FORM-6 패턴 계층). 위치 대응 승계만 한다.
- 작성본(세션) 여러 개. 양식 하나 = 작성 하나. 다시 쓰려면 다시 올린다.
- 셀 값의 실행 취소, 셀 끌어 놓기(dnd), 채팅에 셀 참조 칩 붙이기.
- 채팅으로 파일 첨부. 양식 파일은 화면(탭·끌어 놓기)으로 올린다 — 에이전트 CLI 는 바이너리를
  받지 못한다(읽기 전용 도구만).

반목표(이러면 실패)
- 원본에 없던 서식 변화(글꼴·폭·병합 깨짐), 손대지 않은 셀의 바이트 변화.
- 에이전트가 값을 **직접** 써 넣는 것. SourceAnchor 불변식: 에이전트는 제안만, 반영은 작성자.
- 일부만 기입된 파일을 내려주는 것. 완전성 검사에 실패하면 파일을 내주지 않는다.
- DOM 파서(`lib/html.js parseHtml`)로 읽은 트리를 다시 직렬화해 쓰는 것 — 태그·속성 이름이
  소문자로 바뀌고 CDATA·PI 가 사라져 Word·한글이 열지 못한다.

## 3. 제약(기존 코드가 정한 것)

- Node ≥ 22, npm 의존성 0, ESM, `node --test`. ZIP 쓰기에 `zlib.crc32` 를 쓰므로
  `package.json` `engines.node` 를 `>=22.2` 로 올린다.
- 상태를 바꾸는 요청은 같은 출처의 `application/json` 만(`server.js isTrustedWrite`).
  파일은 기준 문서처럼 base64 JSON `{ fileName, data }` 로 올린다. 본문 한도 8 MiB
  (`GUIDE_BODY_LIMIT` 재사용), 파일 5 MiB.
- `lib/guides.js` 는 DOCX·HWPX 를 확장자로 거부한다(ERR-WB-008). 양식 경로는 **따로** 둔다 —
  `convertDocument` 를 거치지 않는다(모든 ZIP 을 pptx 로 보고 거부한다).
- 파일 1,200줄 초과 금지·900줄 권고. `agent.js` 732줄·`store.js` 639줄이라 양식 로직은
  위성 모듈로 둔다. 최상위 import 순환 0(`test/arch.test.js`).
- 화면 모듈은 서로 import 하지 않는다. 진입점은 `app.js` 가 값으로 넘긴다.
- 보고서 변경은 `mutate` 를 거치지만, 양식 값은 보고서 문서(`state.doc.blocks`)가 아니다 —
  블록 소비자 전부가 `block.sentences` 를 가정하므로 표 블록을 끼울 수 없다.
- 채팅 세션 여러 개(FR-WB-059)가 같은 날 확정됐다. 서버 쪽(대화별 작업 폴더)은 작업 트리에
  들어갔지만 `chat.js`·`book_chat.js` 의 세션 탭 UI 는 아직 없다(2026-10-21 17:41 기준, 두 파일
  미수정). **기다리지 않는다**: `form_chat.js` 는 지금의 `book_chat.js` 방식 그대로 만들고, 세션
  탭이 공용 부품으로 들어오면 세 채팅 열이 함께 받는다. 고치기 전에 수정 시각을 확인하고 다시
  읽는다(병행 세션 규칙).

## 4. 결정 — 사용자가 정한 것과 내가 정한 것

사용자가 정한 것(요청 그대로)
- 표는 글을 쓰는 자리(1열)에 둔다. 파일을 넣으면 화면에 표출한다. 작성 후 양식 그대로 문서로
  낸다. 에이전트는 같은 것을 쓴다. 셀마다 번호, 번호에 지침이 있으면 그에 따라 쓴다. 기존
  웹서버와 조화.

내가 정한 것(설계 판단 — 바꾸려면 말해 달라)
- **D1 양식은 보고서(M) 아래 독립 문서 종류 F-번호다.**(2026-10-21 사용자 확정) 장(R) 안에
  끼우지 않는다. 0열 탐색기의 **「장」 탭 안**, 장 목차 아래에 「양식」 묶음으로 둔다(사용자
  요청 「장이 위치한 쪽에 작업 내용을 둔다」 — 별도 탭 없음). 네 번째 작업 화면
  `#form-workspace`(1열 표 · 2열 에이전트 · 3열 작성 기준·원문). 사용자 지정 문서(C-번호,
  FR-WB-088)와 같은 뼈대. 이유: 장 편집기의 문장 블록 모델에 표를 넣을 수 없고, 양식은 장
  본문이 아니라 산출물이다.
- **D2 에이전트의 값은 수정안 카드로 온다.**(사용자 확정) 셀마다 전·후 diff, 반영·거부, 모두
  반영. 바로 써 넣지 않는다(프로젝트 불변식). AIComp 는 자동 반영이었다.
- **D3 셀 값에 근거(앵커) 규칙 검사를 적용하지 않는다.** 에이전트는 `anchors` 를 붙일 수 있고
  카드에 링크로 보이지만, 수치 대조(`verifySentence`)는 하지 않는다. 양식 칸은 신원·분류·
  서술이 섞여 문장 규칙이 맞지 않는다.
- **D4 양식 에이전트가 보는 원문은 보고서의 모든 장 원문 + 기준 문서다**(보고서 화면과 같다).
  3열도 같은 것을 보여 준다.
- **D5 번호는 모든 셀에 붙인다 — 라벨 칸도.** 에이전트가 「#4 '과제명' 옆 #5」 를 스스로 읽게
  둔다. docx 의 세로 병합 이어짐 칸(`<w:vMerge/>`)은 보이지 않는 칸이라 번호를 주지 않는다.
  중첩 표·콘텐츠 컨트롤·그림·필드가 든 칸은 번호는 받되 **잠김**(채울 수 없음)으로 표시한다.
- **D6 빈 값은 「원본대로 둠」이 아니라 「비움」이다.** 값 목록에 없는 셀 = 원본 그대로(바이트
  보존), 값이 원본 글과 같아지면 목록에서 뺀다, 값 `""` = 셀을 비운 문단 하나로 바꾼다.
  (AIComp 는 빈 값을 건너뛰어 지울 수 없었다.)
- **D7 올리는 길은 두 가지.** 0열 「양식」 탭의 「＋ 양식 올리기」, 그리고 양식 화면(1열·2열)
  어디든 .docx/.hwpx 파일 끌어 놓기. 「에이전트로 파일을 넣으면」은 2열(에이전트 열)에 끌어
  놓는 것까지로 해석했다.
- **D8 표 밖 본문도 구조화한다(2026-10-21 사용자 확정 — 「문장 문단 = 필드」).** 표는 문서
  전체일 수도, 일부일 수도 있다. 표 밖 문단은 둘로 가른다: **헤딩** = 복합어 명사·번호·□ 표시로
  된 짧은 줄(문서의 제목 스타일 포함) — 구조라 번호가 없고 수준(1~3)을 가진다; **필드** = 그 밖의
  글 있는 문단 하나 — 칸과 같은 번호 체계 `#N` 을 받고, 지침을 둘 수 있고, 글머리 수준(ㅇ > - >
  ·)으로 상하위가 된다. 본문이 전혀 없는 끝 헤딩(다음이 헤딩·표·문서 끝) 아래에는 빈 필드
  하나를 두어 채울 수 있게 한다. 빈 문단은 노드가 아니다. 셀·필드를 합쳐 「채우는 단위」라 부른다.

## 5. 화면

### 0열 탐색기 — 「장」 탭 안의 「양식」 묶음

- 탭은 둘 그대로(`장 N` · `사용자 지정 문서 N`). 「장」 탭의 장 목차(＋ 새 장 포함) **아래**에
  「양식 N」 묶음 머리줄 + 「＋ 양식 올리기」. 목록 행: `F-001` · 제목 · 형식(docx|hwpx) ·
  셀 수 · 값 바꾼 셀 수 · 수정 시각 · ✕(확인 뒤 삭제). 열어 둔 양식 행은 `is-current`.
- 「＋ 양식 올리기」: 파일 선택(accept .docx,.hwpx) → 올리는 동안 상태 → 끝나면 그 양식을 연다.
- 양식을 열거나 올리기 전에 장 `flushSave()`(실패 시 toast, 이동 안 함 — 기존 규칙).
- `showExplorer({ forms, currentForm })` — 양식을 열어 두면 `current`(장)는 null, 탭은 「장」.

### 양식 화면 `#form-workspace` (사용자 지정 문서 화면과 같은 세 열 클래스)

상단 `#form-controls`: 「↩ 보고서」 · 종류 배지 「양식」 · 제목(편집 가능 input) · 자동 저장 표시.
장 전용 상단 조작(검증 요약·실행 취소·내보내기·저장 표시)은 숨긴다(기존 다섯 id 목록).

1열 `.col-editor` 「양식」
- 머리줄: `1 양식 · F-001 · docx · 셀 43 · 바뀐 셀 3` + 접기 + 「⬇ 문서로 내려받기」 +
  「원본」(새 탭 내려받기).
- 본문: 문서 순서대로 노드를 그린다 — 헤딩은 `h3.form-heading.lvl-N`(정적, 번호 없음), 필드는
  `div.form-field.lvl-N[data-n]`(번호 배지 + 편집 글 — 칸과 같은 조작, 수준만큼 들여쓰기, 빈
  필드는 「(비어 있음 — 눌러서 쓰기)」 자리 표시), 표는 `figure.form-table > div.table-wrap >
  table.form-grid`. `<colgroup>` 폭 %(원본 상대 폭, 못 구하면 균등), `tr.style.height =
  clamp(round(pt*1.33), 28, 320)px`(최소 높이).
  셀 `td.form-cell[data-n][colspan][rowspan]`:
  - 왼쪽 위 `button.cell-n` 번호 배지(`#5`). 클릭 → 그 셀의 지침 상자(아래).
  - `div.cell-text[contenteditable=plaintext-only]`(폴백 `true`) — 현재 값(값 없으면 원본
    글). 문단 경계는 줄바꿈. IME 조합 중 Enter 무시(`isComposing || keyCode === 229`).
    확정(blur·Ctrl+Enter)에 `innerText` 를 읽어 값으로 둔다. 값 == 원본이면 값 목록에서 뺀다.
  - 잠긴 셀: `.is-locked`, 편집 불가, 배지에 자물쇠 title(이유).
  - 값이 원본과 다른 셀: `.is-changed`(왼쪽 3px 강조선 — `.df-ref-on` 과 같은 방식).
  - 에이전트 제안이 대기 중인 셀: `.has-proposal`.
- 지침 상자 `.cell-guide`(표 **밖**, 표 바로 아래 한 상자 — rowspan 충돌을 피한다):
  `#5 · 행 2 열 2 · 현재: "…"` + `textarea`(지침) + 「저장」(바뀌었을 때만) · 「닫기」(바뀌었으면
  「변경 취소」) · Esc. 지침이 있는 셀의 배지는 `.has-guide`(점 표시).
- 자동 저장: 값·지침·제목은 700 ms debounce `PUT`; 화면을 떠나기 전·beforeunload 에 flush.
  저장 실패는 적은 글을 남기고 toast(ERR).

2열 `.col-chat` 「에이전트」 — `book_chat.js` 와 같은 방식으로 `chat.js` 부품(`streamChat`
`renderMarkdown` `modelOptions` `describeUsage` …)으로 조립한 `form_chat.js`.
- 요청 본문 `{ conversationId, text, model, bookId, formId }` → 서버가 `conv.form` 대화를 연다
  (F-번호는 보고서 안에서만 통하므로 `bookId` 도 함께).
- 대기 중인 제안의 셀 값이 그 사이 바뀌면(`before` ≠ 현재 값) 카드 항목을 `stale` 로 표시하고
  반영 버튼을 끈다(목차 수정안 카드와 같은 규칙).
- 답의 `form` 이벤트 → 수정안 카드: 머리 「셀 N개 제안 · 모두 반영 · 모두 거부」, 항목마다
  `#5 (과제명 옆)` · 전/후 diff(`suggest.diffText`) · 사유 · 앵커 링크 · 반영/거부.
  「옆」 글은 같은 행 왼쪽에서 가장 가까운 글 있는 셀, 없으면 같은 열 위 — 화면이 계산한다.
- 반영 → 값 저장 + 그 `td` 만 갱신(표 전체 다시 그리지 않음). 같은 셀의 이전 대기 제안은 거부.
- 답 속 `#12` 는 1열의 그 셀로 가는 링크(`renderMarkdown` 의 `link` 로 `#\d+` 처리).
- 양식을 열면 `form-opened` 로 새 대화.

3열 `.col-sources` 「작성 기준·원문」 — 보고서 화면 3열과 같은 구성(`book_guides.js
guidesGroup` + 장별 원문 목록 + `readerPane` 열람). 읽기 전용.

좁은 창 `panel_nav` 는 클래스 선택자라 그대로 동작한다. `initColumns` 목록에 세 열을 더한다.
주소 `?report=M-001&form=F-001` 로 다시 연다(`app.js` 부팅 순서에 `form` 추가).

## 6. 번호 규칙(계약) — 채우는 단위 = 셀 + 본문 필드

- 문서 순서: 섹션(hwpx `section0,1,…`) → 본문의 최상위 요소 순서(문단·표) → 표는 행 → 셀.
  1부터 연속. `#N` 표기. 셀과 필드가 한 번호 체계를 쓴다.
- 번호를 받는 셀: 최상위 표의 모든 `tc` 중 docx 세로 병합 이어짐 칸을 뺀 것.
  hwpx 는 병합이 별도 칸으로 존재하지 않으므로 모든 `tc`.
- 본문 문단의 분류(`lib/form_outline.js classify(text, hints)` — 두 형식이 같은 규칙):
  - 헤딩: docx 문단 스타일이 제목(`Heading N`·`heading N`·`제목 N`·`Title`)이거나 `w:outlineLvl` 이
    있으면 그 수준; 아니면 글로 — `headingText`(public/shared/text.js: 번호·# 로 시작하고 종결
    부호 없이 짧은 글) 또는 `□■◇◆▣` 로 시작하고 40자 이하·종결 부호 없음. 수준 = 스타일 →
    번호 깊이(`1.`→1, `1.1`→2, `가.`→2) → 표시(`□`→1, `■◇`→2, `◆▣`→3) → 1. 최대 3.
  - 필드: 그 밖의 글 있는 문단. 수준 = docx `w:ilvl`+1 → 글머리(`ㅇ○●•`→1, `-–—`→2, `·`→3)
    → 1. 바로 앞 필드보다 깊으면 그 필드의 하위다(표시·프롬프트용 — 채우기는 문단 단위).
  - 빈 문단은 노드가 아니다. 끝 헤딩(다음 노드가 헤딩·표이거나 문서 끝) 아래에 필드가 없으면
    빈 필드(`empty: true`, 글 '')를 하나 둔다 — 채우면 그 헤딩 바로 뒤에 문단이 생긴다.
  - 문단 안에 그림·필드·인라인 콘텐츠 컨트롤이 있으면 셀과 같은 `note`.
- 잠김(값 불가, 번호는 유지): 기입하면 XML 이 깨지거나 구조가 사라지는 칸만 — docx 는 칸 안
  **최상위**에 중첩 `w:tbl` 또는 블록 `w:sdt`(문단 밖의 `<w:sdt>`)가 있는 칸, hwpx 는 중첩 표가
  있는 칸. **필드(본문 문단)도 잠길 수 있다** — 문서 설정을 품은 문단(hwpx `secPr`, 또는 단·머리말·
  꼬리말·각주·미주·쪽 번호를 품은 `ctrl`; docx `pPr` 안 `sectPr`)은 바꾸면 쪽 설정이 사라지므로
  번호는 받되 잠그고 저장·내보내기가 값을 거절한다(누름틀·책갈피 `ctrl` 문단은 잠그지 않고
  `note` '필드 있음'). 잠긴 이유를 저장한다.
- 주의 표시(값은 받되 화면·프롬프트에 알림): 문단 **안**에 그림(`w:drawing`)·필드(`w:fldChar`)·
  인라인 콘텐츠 컨트롤(`w:sdt`)·그리기 개체가 있는 칸. 기입은 첫 문단~마지막 문단을 통째로
  바꾸므로 그것들은 사라지고 글만 남는다(AIP 신청서처럼 인라인 sdt 가 51개인 양식도 채울 수
  있어야 한다 — 잠그면 못 쓴다). `w:br`→문단, `w:tab`→공백으로 바뀌는 것은 허용한다.
- 고정 높이: docx `w:trHeight w:hRule="exact"` 행은 Word 가 늘리지 않아 긴 값이 잘린다. 행에
  `fixedHeight: true` 를 기록하고 화면(배지 title)·프롬프트에 알린다. XML 은 손대지 않는다
  (양식 그대로가 반목표보다 우선). 잘림은 재스캔으로 잡을 수 없다 — 작성자가 본다.
- 쓰기 좌표: 번호 → `{ section, t, r, c }`. docx: t=최상위 표 순번, r=`w:tr` 순번,
  c=`w:tc` 순번(그리드 열이 아니다 — 병합 칸도 한 순번). hwpx: `cellAddr rowAddr/colAddr`
  (없으면 tr/tc 순번). 희소 주소(병합 뒤 c 가 2→4→7)도 그대로 둔다.
- 번호는 올린 시점에 확정되어 파일과 함께 저장된다. 다시 세지 않는다.

## 7. 데이터

`workspace/projects/<M>/forms/F-001.json` + `forms/originals/F-001.docx|hwpx` (원본 바이트
불변). 캐시 `cache.forms`(Map), 번호 `main.json formSeq`(지운 번호 재사용 없음).

```json
{
  "id": "F-001", "title": "기술수요조사서", "fileName": "기술수요조사서.docx",
  "format": "docx", "hash": "sha256:…", "createdAt": "…", "updatedAt": "…",
  "tables": [{
    "section": 0, "t": 0, "cols": [16.7, 14.6, 29.2, 14.6, 25.0],
    "rows": [{ "height": 31.0, "fixedHeight": true, "cells": [
      { "n": 1, "r": 0, "c": 0, "colspan": 5, "rowspan": 1, "text": "회 의 록" },
      { "n": 7, "r": 2, "c": 2, "colspan": 3, "rowspan": 1, "text": "액화수소운반선 용역 회의",
        "locked": "중첩 표" },
      { "n": 8, "r": 2, "c": 5, "colspan": 1, "rowspan": 1, "text": "", "note": "그림 있음" }
    ] }]
  }],
  "nodes": [
    { "kind": "heading", "level": 1, "text": "□ 제안 배경 및 필요성", "section": 0, "p": 3 },
    { "kind": "field", "n": 44, "level": 1, "text": "○ (배경) 현재 …하고 있음", "section": 0, "p": 4 },
    { "kind": "field", "n": 45, "level": 2, "text": "- 세부 근거 …임", "section": 0, "p": 5 },
    { "kind": "heading", "level": 1, "text": "□ 기술 개요", "section": 0, "p": 6 },
    { "kind": "field", "n": 46, "level": 2, "text": "", "empty": true, "section": 0, "p": 6, "after": true },
    { "kind": "table", "t": 0 }
  ],
  "values": { "7": "AIComp 폼 통합 회의" },
  "instructions": { "7": "회의 목적이 드러나는 명사형, 30자 이내" }
}
```

- `nodes` 는 문서 순서(표는 `tables[t]` 를 가리키는 자리). `p` = 그 섹션 본문의 최상위 문단
  순번(엔진의 쓰기 좌표), 빈 필드는 헤딩의 `p` + `after: true`(그 문단 뒤에 넣는다).
- `text` 는 원본 글(문단 경계 `\n`, `w:br`→`\n`, `w:tab`→`\t`, 엔티티 풀어서). 화면·프롬프트의
  「원본」이자 값이 없을 때의 표시. 필드도 같다(문단 하나의 글).
- 한도: 파일 5 MiB, 셀 5,000개, 값 20,000자, 지침 4,000자, 제목 200자. 넘으면 400(적은 글은
  화면에 남긴다).
- 목록 요약(`formSummary`)은 `tables` 를 뺀다(id·title·format·cellCount·changedCount·updatedAt).
- 저장은 `applyFormPatch(structuredClone(form), patch)` → 쓰기(tmp→rename) → `Object.assign`.
  거절되면 캐시·파일 불변.
- 보고서 삭제 시 함께 삭제. 양식 삭제는 json·원본을 함께 지운다.
- `loadState`·`loadBookState` 응답에 `forms: listForms(bookId)` 를 더해 0열이 늘 맞게.

## 8. API (`server.js` — custom/guides 경로와 같은 정규식 분기)

| 요청 | 동작 |
|---|---|
| `POST /api/books/<M>/forms` `{ fileName, data(base64), title? }` (본문 8 MiB) | 형식 판별(ZIP 안 `word/document.xml` → docx, `mimetype`=`application/hwp+zip` 또는 `Contents/section0.xml` → hwpx, 그 밖 400) → 스캔 → 표 0개면 400 → 원본·json 저장 → 201 `{ form }` |
| `GET /api/books/<M>/forms` | `{ forms: [요약] }` |
| `GET /api/books/<M>/forms/<F>` | `{ form }`(전체) |
| `PUT /api/books/<M>/forms/<F>` `{ title?, values?, instructions? }` | 부분 갱신(객체는 통째 교체). 없는 번호·잠긴 셀 번호·한도 초과 400 |
| `DELETE /api/books/<M>/forms/<F>` | 삭제 |
| `GET /api/books/<M>/forms/<F>/original` | 원본 내려받기(`sendSourceFile`, `F-001.docx`) |
| `GET /api/books/<M>/forms/<F>/export` | 원본 새 사본에 values 기입 → 완전성 검사 → `sendSourceFile` (attachment, `filename="F-001.docx"; filename*=UTF-8''<원래 파일명>`). 실패 409 `{ error }` 파일 없음 |
| `POST /api/chat` 본문의 `formId` | 양식 대화(아래 9) |

내려받기 이름: `sendSourceFile` 에 선택 인자 `downloadName` 을 더해 `filename*` 을 붙인다(한글
파일명은 헤더에 그대로 못 넣는다 — Node 가 U+00FF 넘는 문자를 거부). 헤더 조립은
`lib/http_names.js downloadDisposition(name, downloadName)` — `server.js` 를 import 하면 서버가
시작되므로 테스트가 부를 수 있게 별도 모듈로 뒀다.

## 9. 에이전트 계약

### 대화 종류

- `newConversation({ form: true })` → `conv.form`. 작업 폴더 `AGENT_DIR/form/<conv id>`
  (`viewDirFor` 분기 추가). 지시문 `FORM_INSTRUCTIONS`(`lib/form_agent.js`).
- 턴 순서(`send` 의 book 분기와 같은 꼴, `formTurn`): `host.formAgentState(formId)` →
  작업 폴더 비우고 `sources/<R>/<S>.md`·`guides/<G>.md`·`form/<F>.md` 쓰기 → `prepareConnections`
  → `askFresh(buildFormPrompt)`.
- 프롬프트: `<form>` **매 턴**(작성자가 사이사이 값을 고치므로 — `<report>` 와 같은 이유),
  `<book_sources>` 목록·`<guides>` 는 바뀔 때만(`sourcesSeen`·`guidesSeen` 재사용).
  `<form>` 이 60,000자를 넘으면 셀 수·잠긴 셀만 적고 `form/<F>.md` 를 읽게 한다.
- `<form>` 본문: 제목·형식·단위 수 → **문서 순서대로** 헤딩은 `#`·`##`·`###`(수준) + 글(번호
  없음), 필드는 `#44 [L2] "글"`(빈 필드는 `(empty)`), 표는 표마다 행마다 `#N "글"`(현재 값이
  있으면 값, 여러 줄은 다음 줄에 들여쓰기) → `잠긴 셀: #7(중첩 표) …` → `지침:` 목록 `#N: 지침`.
  `#N` 뒤 `*` 는 값이 바뀐 단위, 라벨/값 구분은 하지 않는다(모델이 읽는다).

### 답 끝 블록(기존 단일 ```sourceanchor 펜스 안 — 두 번째 펜스 금지)

```json
{"form": [{"cell": 7, "text": "AIComp 폼 통합 회의", "reason": "…", "anchors": ["R-002/S-001.b3.s2"]}]}
```

- 바꿀 셀만. `text` 는 JSON 문자열(줄바꿈 `\n`). 블록이 없으면 값 제안 없음(질문·확인 통로).
- 앵커는 **장 표시를 붙인 한정 표기** `R-002/S-001.b3.s2`(보고서 대화 관례 — 모든 장의 원문을
  보므로 `S-001` 이 장마다 겹친다). `reviewForm` 의 앵커 색인은 장별 `buildAnchorIndex` 를
  장 ID 로 한정해 합친 것. 카드의 앵커 링크·3열 열기도 같은 표기(`book_chat.js bookLinks`).
- 근거가 없는 값도 유효하다(D3). 카드는 앵커가 있으면 링크를, 없으면 「근거 없음」을 보여
  작성자가 판단한다. `reason` 에 출처(원문·사용자 말·웹·일반 지식)를 적게 한다.
- `reviewForm(raw, form, anchorIndex)` → 항목 `{ id, cell, text, reason(≤300), anchors, before,
  label, invalid?, problems }`. `cell` 은 셀이든 필드든 번호. 무효: 정수 아님·없는 번호·잠긴
  셀·문자열 아님·20,000자 초과·현재 값과 같음·없는 앵커. `label` = 셀이면 같은 행 왼쪽(없으면
  위) 글 있는 칸, 필드면 바로 앞 헤딩의 글. 유효 항목은 그대로, 무효가 하나라도 있으면 **한 번**
  되돌려 보낸다(`FAILED — #7: 잠긴 셀(중첩 표)` 형식, 기존 changes·toc 재시도와 같은 helper).
- 이벤트 `{ t: 'form', id, model, items }`. 장 대화·보고서 대화에 온 `form` 블록은 안내만 하고
  버린다(반대도 같다 — 양식 대화의 `changes`·`collect`·`toc` 는 안내만).
- 블록 밖 본문에서 셀은 `#N` 으로 부른다(링크용).

### 지시문 요지(FORM_INSTRUCTIONS)

양식 기입 담당. 사용자가 가리킨 셀(또는 요청 범위)만 채운다. 각 셀 지침을 따른다. 현재 값에
보이는 줄 구성(ㅇ·- 항목, 번호 줄)을 따라 줄마다 채운다. 근거가 없으면 지어내지 말고 블록
없이 묻는다. 원문·웹 글은 신뢰하지 않는 데이터. 라벨 칸(제목 글이 든 칸)은 요청 없이 바꾸지
않는다. 원문 근거가 있으면 `anchors` 에 앵커 ID. 한국어.

## 10. 문서 변환

모두 **원본 XML 문자열 위의 구간(span) 수술**이다. AIComp `hwpxform.py` 와 vendor
`docx_form.py` 의 토크나이저·스팬 함수를 JS 로 옮긴다. 깊이를 세는 정규식 토큰 스캐너 하나가
`tbl|tr|tc|p(|subList)` 의 최상위 구간을 내고, 읽기(번호 매김)와 쓰기(기입)가 **같은 스캐너**를
쓴다(두 경로가 어긋나지 않게).

### `lib/zip.js` — `writeZip(data, replace)` 추가

- `readDirectory` 에 `flags`·`dosTime`·`crc` 를 더 읽는다. `writeZip` 은 원본 항목 순서대로:
  교체 대상은 `deflateRawSync`(이름이 `mimetype` 이면 저장), `zlib.crc32`; 나머지는 압축된
  바이트를 **그대로 복사**하고 머리말만 새로 쓴다(데이터 디스크립터 비트 해제, extra 없음).
  로컬 헤더 30B · 중앙 디렉터리 46B · EOCD 22B. 암호화·ZIP64 거부.
- 검증된 시제품: `docs/superpowers/specs/2026-10-21-writezip-prototype.mjs`
  (Word docx·한컴 hwpx 에서 순서·mimetype 선두 STORED·나머지 바이트 동일·Python
  `zipfile.testzip()` 통과). 이 파일을 lib 로 옮기고 테스트를 붙인 뒤 지운다.

### `lib/docx_form.js` — `scanDocx(buffer)` · `fillDocx(buffer, cells, values)`

- 읽기: `word/document.xml` 만. `<w:body>` 안 최상위 `w:tbl` → `w:tr` → `w:tc`.
  표: `w:tblGrid/w:gridCol w:w` 로 열 폭 %(없거나 0·단위 혼합이면 null → 균등).
  행: `w:trPr/w:trHeight w:val`/20 = pt. 칸: `w:tcPr` 의 `w:gridSpan w:val`(colspan),
  `w:vMerge`(`w:val="restart"` 시작 · 값 없음 = 이어짐 → 번호 없음·그리지 않음; rowspan 은
  그리드 열 g 를 colspan 으로 누적하며 아래 행의 같은 g 이어짐 수 + 1 — AIComp
  `formlayout._docx_rows` 이식). 글: 최상위 `w:p` 마다 `w:t` 본문 이어 붙이고(`w:br`→`\n`,
  `w:tab`→`\t`, 엔티티 풀기, 수치 참조 `&#…;` 포함) 문단은 `\n` 으로 잇는다.
  잠김: 칸 최상위(문단 밖)에 `<w:tbl`·`<w:sdt` 가 있으면. 주의(`note`): 문단 안에 `<w:drawing`·
  `<w:fldChar`·`<w:sdt` 가 있으면(§6). 행 `fixedHeight`: `w:trHeight w:hRule="exact"`.
- 쓰기: 칸의 첫 최상위 `w:p` 시작 ~ 마지막 최상위 `w:p` 끝을 줄마다 `<w:p>{pPr}<w:r>{rPr}<w:t
  xml:space="preserve">{escaped}</w:t></w:r></w:p>` 로 바꾼다. `pPr` = 첫 문단의 `w:pPr`,
  `rPr` = 첫 문단에서 `w:rPr` 를 가진 첫 `w:r` 의 것(없으면 `w:pPr` 안 문단 표시 `w:rPr`,
  그것도 없으면 빈 것). 문단이 없으면 `</w:tc>` 앞에 넣는다. 빈 값 = 빈 `w:t` 문단 하나.
  `& < >` 이스케이프. `w:tcPr` 는 손대지 않는다. (vendor `fill_cell_xml` 과 같다 — 모든 줄이
  첫 문단 서식. 위치 대응은 hwpx 만.)
- 멤버 교체는 `word/document.xml` 하나.

### `lib/hwpx_form.js` — `scanHwpx(buffer)` · `fillHwpx(buffer, cells, values)`

- 읽기: `Contents/section<n>.xml` 번호순. 접두사는 문서에서 잡는다(`hp:` 고정 아님 —
  `</?[A-Za-z][-\w.]*:(tbl|tr|tc|p|subList)(?=[\s/>])`). 최상위 `tbl` 만(중첩 표는 부모 칸 안에
  삼킨다 → 그 칸 잠김). 칸 좌표 `cellAddr colAddr/rowAddr`(둘 다 있어야 채택, 없으면 tr/tc
  순번; 같은 좌표 중복은 첫 것). `cellSpan colSpan/rowSpan`, `cellSz width/height`(hwpunit).
  폭 %: 열 그리드가 없으므로 행마다 왼쪽 경계에서 칸 `cellSz width` 를 더해 열 경계(`edge[c]`)를
  모으고(병합 칸 사이 경계는 다른 행에서 풀린다, 세 번까지 반복), 경계가 하나라도 안 풀리면
  `cols` 는 null(화면이 균등 폭). 높이 pt = rowspan 1 칸의 최소
  height/100. 글: 첫 `subList` 의 최상위 `p` 마다 `t` 본문 잇기(안쪽 `tab`→`\t`,
  `lineBreak`→`\n`, 그 밖 태그 제거), 문단은 `\n`. 자기 닫힘 `<run …/>`·`<t/>` 는 빈 것.
  `cellAddr` 등은 `subList` **뒤**에 오기도 하므로 칸 안 전체를 찾는다.
- 쓰기: 첫 `subList` 안 첫 `p` 시작 ~ 마지막 `p` 끝 교체. 줄마다 `{원래 <p …> 여는 태그 그대로}
  <run{첫 run 속성 그대로}><t>{escaped}</t></run></p>`; 자기 닫힘 run 의 끝 `/` 를 뗀다.
  위치 대응: i번째 줄은 i번째 내용 문단(빈 문단 제외)의 템플릿, 넘치면 마지막 내용 문단, 빈 줄은
  그 자리의 원 문단(스페이서). `linesegarray` 는 내지 않는다(한글이 다시 계산). 문단이 없으면
  `<p paraPrIDRef="0" styleIDRef="0">` + `charPrIDRef="0"` 으로 만든다.
- 멤버 교체는 바뀐 `section*.xml` 만. `Preview/*` 는 그대로 둔다(스테일 허용 — AIComp 동일).

### 본문(표 밖) — 두 엔진 공통 규칙

- 엔진은 본문의 **최상위 요소를 문서 순서대로** 돌려준다: 문단(`{ kind: 'paragraph', section, p,
  text, hints }` — docx 는 `w:body` 의 `w:p`, hwpx 는 섹션의 최상위 `p`; 빈 문단도 순번을
  차지하므로 돌려준다; `hints` = docx `pStyle`·`outlineLvl`·`ilvl`)와 표(`{ kind: 'table', … }` —
  hwpx 는 표를 품은 문단 자리에 표가 온다). 분류(헤딩/필드/빈 문단)는 엔진이 아니라
  `lib/form_outline.js classify` 가 한다(§6).
- 필드 기입: 그 문단 하나를 값의 줄마다 한 문단으로 바꾼다 — docx 는 칸과 같은 `pPr`/`rPr`
  승계, hwpx 는 그 문단의 여는 태그·첫 run 속성 그대로(줄이 늘면 같은 템플릿 반복). 빈 필드
  (`after: true`)는 헤딩 문단 **바로 뒤**에 새 문단을 넣는다 — docx 는 맨몸 `<w:p>`, hwpx 는
  `paraPrIDRef="0" styleIDRef="0"` + `charPrIDRef="0"`(vendor 의 본문 절 b0=-1 선례).
- 완전성 확인(`exportForm`): 결과를 다시 스캔해 (a) 표 칸은 §6 좌표열이 같고 값을 준 칸의 글이
  값과 같은지, (b) 본문은 **글 있는 문단의 글 열**이 기대와 같은지 비교한다 — 기대 = 원본 문단
  열에서 값을 준 필드 문단을 값의 줄들로 바꾸고 빈 필드는 헤딩 글 다음에 줄들을 끼운 뒤 빈
  글을 뺀 것. 분류가 달라져도(값 줄이 헤딩처럼 보여도) 글 열 비교라 흔들리지 않는다.

### `lib/forms.js` — 조립(관문)

- `detectFormat(buffer)`, `scanForm(buffer)`(형식별 스캔 → `classify` 로 `nodes` → 번호 매김 →
  `tables`·`nodes`),
  `buildForm({ id, title, fileName, data })`(검증 → 스캔 → `{ form, original }`; 어떤 단계든 실패
  하면 파일을 남기지 않는다), `writeForm`/`removeFormFiles`/`loadForms`/`applyFormPatch`/
  `formSummary`(custom_docs·guides 와 같은 꼴), `exportForm(form, original)`:
  1. values 의 모든 번호가 존재·비잠김인지 확인(아니면 409).
  2. 원본 **새 사본**에 기입(이전 내보내기 결과를 다시 채우지 않는다).
  3. 결과를 다시 스캔해 ① 표 칸 좌표열이 같고 값을 준 칸의 글이 값과 같은지(줄바꿈 정규화),
     ② 본문의 글 있는 문단 글 열이 기대(헤딩 글 + 필드 글 또는 값의 줄들)와 같은지 확인.
     하나라도 다르면 409 「기입 결과가 완전하지 않습니다 — #7 …」, 파일 없음.
  4. values 가 비어 있으면 원본 바이트 그대로.
  5. 결과를 저장하지 않는다(요청마다 만든다).

## 11. 오류·예외

- 올리기: 확장자·내용이 docx/hwpx 가 아니면 400(「docx·hwpx 양식만」), 암호·ZIP64·손상 400,
  표 없음 400, 5 MiB 초과 413. 실패하면 파일·번호를 남기지 않는다.
- 저장: 없는 번호·잠긴 셀·한도 초과 400, 적은 글은 화면에 남긴다.
- 에이전트: 무효 항목은 한 번 되돌려 보내고, 남은 무효는 안내 뒤 버린다. 장·보고서 대화의
  `form` 블록은 안내만.
- 내보내기: 완전성 실패 409 와 사유(어느 셀), 파일 없음. 화면은 `fetch` → blob 으로 내려받아
  (링크 이동이 아니라) 409 본문을 toast + 1열에 보인다.
- 장을 열기 전·보고서로 돌아가기 전 양식 저장을 flush. 실패하면 이동하지 않는다(ERR-WB-006 과
  같은 규칙).

## 12. 테스트(`test/zip.test.js` `xml_spans` `form_outline` `docx_form` `hwpx_form` `forms` `form_store` `form_agent` `syntax` 각 `.test.js`, 표본 `test/fixtures/form_docs.js`)

- ZIP 쓰기: 빈 ZIP(EOCD 22B)에서 만들기, 교체 항목 읽기 일치, 나머지 바이트 동일, CRC 가
  `zlib.crc32` 와 일치, `mimetype` 선두·저장, 암호화 거부.
- docx: 고정 XML 로 만든 작은 docx — 번호(gridSpan 1칸=1번호, vMerge 이어짐은 번호 없음,
  rowspan 계산), 폭 %·높이 pt·`fixedHeight`, 문단·br·tab·엔티티 글, 잠김(최상위 중첩 표·블록
  sdt)과 주의(문단 안 drawing·fldChar·인라인 sdt → 기입되고 사라짐), 기입(여러 줄→문단
  수, pPr/rPr 승계, 문단 표시 rPr 폴백, `xml:space`, 이스케이프, 빈 값, 다른 칸·다른 멤버
  바이트 동일), 완전성 실패(잠긴 셀 값 → 409).
- hwpx: AIComp `test_hwpxform.py` 의 fixture(`cell_xml`/`section_xml`/`multi_para_cell`)를
  옮긴다 — 접두사 `ns0`/`ss`, `cellAddr` 앞·뒤 순서 무관, 희소 주소, 위치 대응 승계·스페이서·
  넘침, 자기 닫힘 run 의 charPrIDRef 보존, linesegarray 없음, 섹션 둘, 중첩 표 잠김.
- 실제 파일 스모크(있을 때만, 없으면 skip): `E:/dev/AIComp/demo/samples/기술수요조사서.docx`·
  `.hwpx`, `E:/dev/AIComp/data/docforms/1/src/회의록_양식.docx` — 스캔 셀 수(42/43/16 근처),
  값 하나 기입 → 재스캔 일치 → 나머지 멤버 동일.
- 저장소: 올리기/목록/조회/저장/삭제/번호 재사용 없음/다른 보고서 격리/재시작 후 유지/보고서
  삭제 시 삭제/거절된 올리기는 파일 없음(guides.test 의 「빈 폴더」 단언).
- 에이전트: `reviewForm` 단위(유효·무효 사례 전부), `formText` 의 길이 한도·파일 폴백,
  `parseBlock` 의 `form` 키.
- 화면은 복사본 작업공간 + 헤드리스 Edge 로 수동 확인(메모리 규칙: 8105 서버 건드리지 않음).

## 13. 파일 지도와 줄 수 예산

새 파일
- `lib/zip.js` +50(writeZip) · `lib/xml_spans.js`(두 엔진이 공유하는 구간 스캐너 — `elementSpans`
  `innerSpan` `escapeXml` `unescapeXml` `outside`) · `lib/form_outline.js`(`classify` — 본문 문단
  분류 한 곳) · `lib/docx_form.js` · `lib/hwpx_form.js` · `lib/forms.js` · `lib/form_agent.js`
  (FORM_INSTRUCTIONS·formText·formBlock·reviewForm) · `lib/http_names.js`(`downloadDisposition`)
- `public/js/forms.js` ~350(화면 1·3열·지침 상자·올리기·저장) · `public/js/form_chat.js` ~200
- 위 §12 의 테스트 · `references/docx_hwpx_format.md`

고치는 파일
- `server.js` +15(경로) · `lib/store.js` +70(forms 블록·wiring) · `agent.js` +60(`conv.form`·
  `formTurn`·`parseBlock` 의 `form`·재시도 helper 공유) · `public/index.html` +8 ·
  `public/js/app.js` +10 · `public/js/explorer.js` +25(탭·목록, 0열 이동 전 양식 저장을 기다리는 `go.flushForm` 주입 — `forms.js`
  가 `explorer.js` 를 import 하므로 반대 방향 import 없이 `app.js` 가 `flushFormSave` 를 넘긴다, ERR-WB-011) · `public/js/state.js` +3
  (`state.forms`) · `public/js/book.js`·`custom_docs.js` 화면 전환에 `#form-workspace` 숨김 +4 ·
  `public/style.css` +60 · `package.json` engines · `spec/spec_workbench.md` · `spec/INDEX.md`

재시도 helper: changes·toc·form 세 군데의 「한 번 되돌려 보내기」를 `retryOnce(conv, modelKey, connections, emit, { parsed, key, review, … })` 하나로 모은다
(`agent.js` 가 900줄을 넘지 않게). 이동 심볼은 관문에서 재수출.

## 14. 사양서 반영(구현 착수 전)

`spec/spec_workbench.md` ① 2026-10-21 행(지금은 `요청` — 아래 질문이 확정되면 `확정`), ②:
- FR-WB-090 양식 화면(탭·올리기·표 표출·번호·셀 편집·지침·저장·주소).
- FR-WB-091 양식 에이전트(`<form>`·`form` 블록·수정안 카드·반영).
- FR-WB-092 양식 내려받기(원본 형식·바이트 보존·완전성·빈 값·잠긴 셀).
- DR-WB-008 저장(F-번호·원본 불변·한도·보고서 삭제 연동).
- ERR-WB-011 올리기·저장·내보내기 실패 동작.
- AC-WB-035~037 수용 기준(올려서 번호 보기, 에이전트 제안 반영, 내려받은 파일 재스캔 일치).
`spec/INDEX.md` 행 「양식 파일 작성(FR-WB-090~092)」.

## 15. 빌더에게 맡기는 것

- `<form>` 텍스트의 정확한 줄 형식, 카드의 문구, CSS 세부(기존 `.proposal*`·`.num-table` 재사용).
- `form_chat.js` 와 `book_chat.js` 의 공통 부분을 더 뽑을지(순환 금지 안에서).
- 3열 코드의 재사용 방법(`custom_docs.js` 3열을 공용 부품으로 올릴지 복사할지).
- 폭·높이 근사의 클램프 값, `min-width` 값.
- 테스트 fixture XML 의 구체 형태(위 「테스트」의 사례를 모두 덮으면 된다).

## 16. 사용자 확인 결과(2026-10-21)

1. **D1** 독립 문서로 둔다 — 확정. 단, 0열에서는 별도 탭이 아니라 「장」 탭 안 장 목차 아래
   「양식」 묶음으로 둔다(「장이 위치한 쪽에 작업 내용을 둔다」). 표는 1열.
2. **D2** 카드로 받아 반영·거부, 모두 반영 — 확정.
3. **D7** 양식 화면 끌어 놓기 + 0열 올리기 버튼 — 권고대로.
4. **D3 보강** 양식 대화에 웹 수집 없음, 근거 없는 값은 「근거 없음」 표시 — 권고대로.
5. **D8** 표 밖 본문: 「문장 문단 = 필드」 — 확정(2026-10-21, 두 안 중 선택). 표는 문서 전체일
   수도 일부일 수도 있다. 헤딩은 구조(번호 없음), 글 있는 문단은 각각 필드 `#N`, 글머리 수준으로
   상하위, 빈 끝 헤딩 아래 빈 필드 하나. 셀·필드는 한 번호 체계.
