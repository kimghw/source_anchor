# 한글 5.0 바이너리(hwp) 양식 + 문서 구조(목차 후보) 가져오기 — 설계 (2026-10-22)

`SSCB_산업기술혁신사업 연구개발계획서_한국선급_rev3.hwp`(10 MB, 한글 5.0 바이너리, OLE 복합 문서)를
양식으로 올려 (a) 헤딩을 읽어 보고서의 **장(0열 장 탐색기)** 으로 가져오고, (b) 표는 **양식(F-번호)** 에
넣고, (c) 어디까지 헤딩으로 볼지는 시스템이 판단해 기본으로 골라 두되, (d) **장/챕터/헤딩 후보를
작성자가 선택하고 수준을 옮길 수 있는** 화면을 둔다.

이 문서는 설계다. 요구사항 정본은 `spec/spec_workbench.md` 에 ID 로 적고(아래 「사양서 반영」),
구현 지도는 `spec/INDEX.md` 의 「양식 파일 작성」 행과 새 행 「문서 구조 가져오기 — 목차 후보」다.
양식 기능 자체의 설계는 [2026-10-21-form-fill-design.md](2026-10-21-form-fill-design.md),
외부 형식 사실은 `references/hwp_format.md`(hwp)·`references/docx_hwpx_format.md`(docx·hwpx).

## 1. 의도와 이유

- 연구개발계획서 같은 **정부 과제 양식은 hwp(바이너리)로 온다**. hwpx 로 바꿔 올리라고 하면 한글
  설치·변환 단계가 끼고, 변환이 서식을 바꾸기도 한다. hwp 를 그대로 받아 그대로 돌려주는 것이 맞다.
- 양식에는 보고서의 목차가 이미 들어 있다(「1. 연구개발 목표」「1-1. 최종 목표」 …). 작성자가 장을
  하나씩 손으로 만들 이유가 없다 — 양식의 헤딩을 읽어 **장 후보**로 주고, 고른 것만 빈 장으로 만든다.
- 어디까지를 장으로 볼지는 문서마다 다르다(개요 4 수준 「①」, 안내용 「□ …」 줄, 앞쪽 목차 페이지의
  「1. …」). 시스템은 **기본값을 정하되 작성자가 고치는** 화면을 둔다 — 자동 판단을 믿지도, 전부
  맡기지도 않는다.

## 2. 목표 · 비목표 · 반목표

목표
- hwp 양식을 올리면 docx·hwpx 양식과 **같은 구조**(헤딩·필드·표, 번호 #1…)가 되고, 값을 넣어
  hwp 그대로 내려받는다. 손대지 않은 레코드·스트림은 바이트 그대로.
- 양식의 헤딩을 장 후보로 보여 주고, 기본 선택·수준·제목을 작성자가 고쳐 빈 장으로 만든다.
- 목차 모델(`public/shared/toc.js`, 수준 1~3)·양식 모델(`lib/forms.js` items·nodes)·서버 규약을
  그대로 쓴다. 새 저장 구조 없음.

비목표(이번에 안 함)
- hwp 의 본문 서식 편집·새 표 삽입·그림·수식·각주 기입. 칸과 본문 필드의 **글**만 바꾼다.
- 암호·배포용 hwp 열기(거절한다). HWP 3.x·구버전 형식.
- 양식 본문을 장 본문으로 옮기기 — 가져온 장은 **빈 장**이다. 표·필드는 양식에 남는다.
- 가져온 장과 양식 단위의 연결(장을 열면 양식의 그 부분이 보이는 것). 중복 가져오기 검사.
- 개요 번호 형식(NUMBERING)으로 번호를 다시 만드는 것 — 이 문서는 번호가 글에 타자로 들어 있다.

반목표(이러면 실패)
- DocInfo·BinData·PrvText 등 손대지 않은 스트림의 바이트 변화, 디렉터리 항목 순서·트리 변화.
- 칸의 문단 수(`nParas`)와 마지막 문단 표시(bit31)가 어긋난 파일 — 한글이 열지 못하거나 표가 깨진다.
- 작성자가 보지 못한 채 장이 생기는 것 — 만들기 전에는 목차가 바뀌지 않는다.
- 시스템의 기본 선택이 틀렸을 때 고칠 길이 없는 것.

## 3. 제약(기존 코드가 정한 것)

- Node ≥ 22.2, npm 의존성 0, ESM, `node --test`. OLE2(CFB) 읽기·쓰기와 raw deflate 를 직접 한다
  (`zlib.inflateRawSync`/`deflateRawSync`).
- 소스 파일 1,200줄 초과 금지(900 권고), 최상위 import 순환 0, 화면 모듈끼리 import 금지(진입점은
  `app.js` 가 값으로 넘긴다). 형식 오류는 엔진이 `{ format: true }` 로 던지고 `scanForm` 이 400 으로.
- 양식 올리기는 base64 JSON — 20 MiB 파일이면 본문 ≈ 27 MiB. 본문 한도를 그 경로만 올린다.
- 세 엔진(docx·hwpx·hwp)은 같은 items 계약을 낸다. 본문 문단 분류는 `lib/form_outline.js classify`
  한 곳(엔진은 힌트만 넘긴다).

## 4. 결정

- **D1 hwp 는 양식의 세 번째 형식(`format: 'hwp'`)이다.** 올리면 기존 양식과 같은 구조(nodes·tables·
  번호)가 되고, 내려받기도 hwp → hwp. 읽기·쓰기는 OLE 컨테이너 안 섹션 스트림(압축 레코드) 수준의
  「구간 수술」 — 손대지 않은 레코드·스트림은 바이트 그대로.
  이유: 변환 단계 없이 받은 그대로 돌려주는 것이 양식 기능의 약속(FR-WB-092)이고, 구조·화면·에이전트·
  저장은 형식과 무관하게 이미 있다. 새로 필요한 것은 엔진 하나와 컨테이너 코덱뿐이다.
- **D2 장/챕터/헤딩 = 목차 수준 1/2/3.** 기존 목차 모델 그대로. 가져온 장은 본문 없이(빈 장) 목차
  끝에 이어 붙는다. 이유: 사용자의 「장·챕터·헤딩」은 탐색기가 이미 가진 수준 1~3 과 일치한다. 새
  계층을 만들면 FR-WB-079 의 이동 규칙·번호·에이전트 목차 전달을 모두 다시 해야 한다. 끝에 붙이는 것은
  기존 장을 건드리지 않는 가장 단순한 결정이며, 자리는 탐색기의 순서 조작으로 옮긴다.
- **D3 헤딩 노드에 출처 `by` 를 남긴다** — `'outline'`(문단 개요 수준·docx outlineLvl), `'style'`
  (제목 스타일 이름), `'text'`(글 모양 규칙). 기본 선택(시스템의 판단): 문서에 outline/style 헤딩이
  하나라도 있으면 그것만(깊이 ≤ 3) 고르고 text 헤딩은 후보로만 둔다; 없으면 text 헤딩을 모두 고른다.
  이 문서에서는 개요 1~3(「1.」「1-1.」「(1)」)이 장/챕터/헤딩이 되고, 개요 4(「①」)와 글 규칙 헤딩
  (「□ …」, 앞쪽 목차 페이지의 「1. …」)은 후보로만 보인다. 이유: 문서가 스스로 개요라고 표시한
  것이 글 모양 추측보다 믿을 만하다. 개요 표시가 하나도 없는 문서에서만 글 규칙을 믿는다. 깊이 4 이상은
  수준 3 으로 자르되 고르지 않는다 — 목차가 너무 잘게 쪼개지는 것을 막고, 필요하면 작성자가 고른다.
- **D4 후보 제목 = 공백 정리 + 뒤의 「※ …」 작성 안내를 뗀 것**(화면에서 고칠 수 있다). 원문 글은
  툴팁. 이유: 양식 헤딩에는 「※ 3쪽 이내」 같은 작성 안내가 붙어 있어 장 제목으로 쓸 수 없다. 떼서
  비면 떼기 전 것을 둔다.
- **D5 파일 한도 5 MiB → 20 MiB**(이 문서가 10 MB — 그림 9개가 대부분). 단위 5,000 은 그대로
  (이 문서 ≈ 4,300). 서버 올리기 본문 한도는 양식 경로만 28 MiB. 이유: 한도는 실제 문서를 받기 위한
  것이고, 단위 수 한도는 화면·에이전트 프롬프트 크기를 지키는 것이라 따로 둔다.
- **D6 가져오기 대화상자는 세 곳에서 연다** — (1) 양식을 올린 직후 자동으로(후보가 있을 때),
  (2) 양식 화면 1열 머리줄 「⇪ 목차로 가져오기」, (3) 0열 양식 행의 「⇪」. 이유: 올린 직후가 가장
  자연스럽지만 닫은 뒤 다시 열 길이 있어야 하고, 0열에서 양식을 보는 작성자는 양식 화면을 열지 않고도
  가져올 수 있어야 한다.

## 5. 계약 요약

### `lib/cfb.js` — OLE2 복합 문서 읽기·쓰기

```js
export function readCfb(data)            // Buffer → { names, has(path), read(path) → Buffer|null }
export function writeCfb(data, replace)  // (원본, { 'BodyText/Section2': Buffer, … }) → Buffer
export function createCfb(streams)       // { 'FileHeader': Buffer, … } → Buffer (붙박이·새 파일)
```
경로는 `'BodyText/Section0'`. `writeCfb` 는 바꾸지 않은 스트림·이름·디렉터리 순서와 트리·CLSID·시각을
그대로 두고 섹터 배치만 다시 한다(v3/v4 섹터 크기 보존, mini 컷오프 4096, mini 섹터 64B). 서명이
아니면 `{ format: true }`. 없는 경로를 바꾸려 하면 throw.

### `lib/hwp_file.js` — 컨테이너·레코드·글자 코덱

```js
export function openHwp(data)   // → { header: { version, compressed, encrypted, distribution }, docInfo, sections: [{ name, n, records }], cfb }
export function parseRecords(buf) / encodeRecord(tag, level, data)
export function decodeText(buf) // PARA_TEXT → { text, ctrls }  (탭 → '\t', 줄 바꿈 → '\n', 문단 끝·그 밖 제어는 뺀다)
export function encodeText(text) // → UTF-16LE, 탭은 인라인 탭 제어(8 유닛), 끝에 0x000D
export function docStyles(docInfo) / docParaShapes(docInfo) // STYLE 이름, PARA_SHAPE { headType, level }
```

### `lib/hwp_form.js` — `scanHwp` · `fillHwp` (hwpx 엔진과 같은 items·fills 계약)

- `scanHwp(data) → { format: 'hwp', items }`. 문단 `{ kind:'paragraph', section, p, text, hints:
  { style, outlineLvl, ilvl }, locked?, note? }` — `section` 은 스트림 번호, `p` 는 그 섹션의 최상위
  문단 순번(표를 품은 문단도 센다). 표를 품은 문단은 표 자리(표마다 table 항목). `hints.style` =
  STYLE 이름, `outlineLvl` = 개요 문단의 수준, `ilvl` = 번호·글머리표 문단의 수준.
  잠김 '문서 설정' = secd·cold·head·foot·fn·en·pgnp·pghd·nwno 컨트롤. note = '그리기 개체 있음' ·
  '필드 있음'. 표 `{ kind:'table', t, section, cols, rows: [{ height, fixedHeight: false, cells:
  [{ r, c, colspan, rowspan, text, locked?, note? }] }] }` — 칸 좌표는 LIST_HEADER, 중첩 표는 잠김.
- 암호·배포용은 `{ format: true }`: '암호가 걸린 한글 문서는 올릴 수 없습니다' / '배포용 한글 문서는
  올릴 수 없습니다'. FileHeader 가 없으면 '한글 문서(hwp)가 아닙니다 — FileHeader 가 없습니다'.
- `fillHwp(data, fills) → Buffer`. 칸: LIST_HEADER 뒤 문단 레코드를 새 문단들로 통째 바꾸고 `nParas`
  와 마지막 문단 bit31 을 맞춘다. 필드: 최상위 문단 블록을 바꾸고, `after` 면 바로 뒤에 넣는다. 표를
  품은 문단·설정 컨트롤 문단은 throw, 같은 자리 두 번 throw. 새 문단은 값의 줄마다 하나 — PARA_HEADER
  (원본 크기, nChars = 유닛 수 + 1, 단 나누기 바이트는 첫 줄만), PARA_TEXT(빈 줄은 쓰지 않는다),
  PARA_CHAR_SHAPE(원 문단 첫 글자 모양), PARA_LINE_SEG(원 문단 첫 줄 복사, 시작 0). 섹션만 다시
  raw deflate → `writeCfb`.

### `lib/forms.js` · `lib/form_outline.js` · `public/shared/toc.js`

- `ENGINES.hwp`, `detectFormat`(OLE 서명 + FileHeader), 확장자 `.hwp`, `FILE_LIMIT` 20 MiB, 메시지
  「docx·hwpx·hwp」. `scanForm` 은 헤딩 노드에 `by`(와 3 을 넘는 `depth`)를 싣는다.
- `classify(text, hints) → { kind, level, by?, depth? }` — 판별 순서: `outlineLvl`(0~8) → `outline`(depth
  = +1), 스타일 정규식 `^(heading|제목|개요)\s*(\d)` → `style`, 글 규칙 → `text`. 개요 수준이 스타일 이름보다
  앞선다 — 한글의 「개요 n」 문단은 둘 다 있어 출처가 `outline` 하나로 모인다. `level` 은 1~3 으로 자르고
  `depth` 는 3 을 넘을 때만 붙인다. 글머리 수준: 1 `ㅇ○●•◦`·`o `, 2 `-–—`, 3 `·⋅ㆍ∙`.
- `headingCandidates(nodes) → [{ i, text, title, level, depth, by, selected }]` — 헤딩 노드만 문서
  순서로, 제목 정리(D4)와 기본 선택(D3). 순수 함수, 브라우저·서버 공용.
- `normalizeGroups(list, prev = 0) → list` — 앞 장 수준 `prev` 기준으로 규칙을 넘는 장이 오면 그 장과
  뒤따르는 같은 깊이 이상의 형제·하위를 같은 만큼 함께 올린다(`normalizeLevels` 는 첫 장만 올려 「(3)」이
  「(2)」의 하위가 되지만 여기서는 형제로 남는다); 결과는 `normalizeLevels` 를 거쳐도 바뀌지 않는다.
  대화상자의 미리보기와 만들기가 같은 값을 쓴다.

### 서버

- `lib/store.js` `importChapters({ bookId, chapters: [{ title, level }] })` — 1~500건(아니면 400),
  제목 trim·200자·비면 '제목 없는 장', level 정수 1~3 아니면 1. `makeChapter` 로 빈 장을 목차 끝에
  순서대로 붙이고 `normalizeLevels` → `writeBook` → `loadBookState`.
- `server.js` `POST /api/book/chapters/import` → 201. 양식 올리기 경로의 본문 한도 `FORM_BODY_LIMIT`
  28 MiB.

### 화면

- `public/js/toc_import.js` `openTocImport({ bookId, form, chapters, onDone })` — `<dialog class="dialog
  toc-import">`: 머리(「목차 후보 — {제목}」 + 찾은 N·고른 M·표 K·기존 장 E 안내), 도구줄(「모두
  고르기」「개요·스타일만」「모두 해제」 · 고른 후보의 「⇤ 상위로」「⇥ 하위로」「장으로」「챕터로」
  「헤딩으로」), 후보 줄(체크 · 수준 segmented 장 1·챕터 2·헤딩 3 · 제목 input · 출처 배지 `개요 n`/
  `스타일`/`글` · 원문 툴팁), 미리보기(고른 후보를 `normalizeGroups`(기존 목차의 마지막 장 수준 기준 —
  상위 제목이 빠진 형제 묶음은 그 하위까지 같은 만큼 함께 올린다)로 맞춘 뒤 기존 목차 뒤에 이어
  `normalizeLevels` → `outlineNumbers`, 기존 장은 흐리게, 규칙으로 바뀐 수준은 「→ 2」), 바닥(「취소」
  「장 M개 만들기」). 만들기 → 그렇게 맞춘 수준으로 POST → `onDone(data)` → toast. 실패 → toast, 대화상자
  유지(만드는 동안은 Esc·취소도 닫지 않는다; 이미 열려 있으면 또 열지 않는다). 화면 모듈을 import 하지 않는다.
- `public/js/forms.js` — `.hwp` 허용, 20 MiB, 올린 직후 후보가 있으면 자동으로 열기, 1열 머리줄
  「⇪ 목차로 가져오기」, `importToc(bookId, formId)`(0열용). 결과 반영: 양식 화면이면 자기 상태 갱신,
  아니면 `explorer.js` `applyBookData`.
- `public/js/explorer.js` — `applyToc` → `export applyBookData`, 양식 행 「⇪」(`go.importToc`),
  accept `.docx,.hwpx,.hwp`. `app.js` 가 `importToc` 를 넘긴다. `style.css` `.toc-import`.

## 6. 검증

- CFB: `createCfb → readCfb` 왕복(mini·일반 스트림, 중첩 저장소, 109개 넘는 FAT 섹터를 만드는 큰
  스트림으로 DIFAT 경로), `writeCfb` 뒤 다른 스트림 바이트·이름·순서 동일, mini ↔ 일반 경계 넘나들기,
  없는 경로 throw, 서명 아님 `{ format: true }`. python `olefile` 이 있으면 결과를 열어 스트림 목록·
  바이트 비교(없으면 skip).
- hwp 엔진: 붙박이(`test/fixtures/hwp_docs.js` — FileHeader·DocInfo·Section 을 레코드로 조립)로 스캔
  (문단 글·힌트·잠김·주의, 표 좌표·병합·폭·높이·중첩 잠김·섹션 둘·표 순번)과 기입(칸 한 줄·여러 줄·
  빈 값·`nParas`·bit31, 필드·after·잠긴 문단 throw·같은 자리 throw), 기입 뒤 재스캔 일치·다른 스트림
  동일. 실제 파일은 저장소 루트에 있을 때만: scanForm 통과, 단위 ≤ 5,000, outline 헤딩 ≥ 30, 칸 둘 +
  필드 하나 기입 → `exportForm` 재스캔 확인 통과 → BinData·DocInfo 바이트 동일 → olefile 로 열림.
- 분류·후보·서버: `classify` 의 `by`·`depth`·개요·글머리, `headingCandidates` 규칙·제목 정리,
  `importChapters` 끝에 이어 붙기·normalize·한도·거절.
- 화면: 복사본 작업공간 + 헤드리스 Edge 수동 확인(8105 서버는 건드리지 않는다) — 올린 직후 대화상자,
  기본 선택, 수준 이동·제목 수정 → 만들기 → 0열 목차, 양식의 표는 그대로. 내려받은 hwp 는 한글에서
  연다(수동).
- 구조: `test/arch.test.js`(줄 수·순환), `test/syntax.test.js`.

## 7. 사양서 반영

`spec/spec_workbench.md` ① 2026-10-22 행(확정). ②: FR-WB-090(docx·hwpx·hwp, 헤딩의 출처)·
FR-WB-092(hwp→hwp, 구조 확인)·DR-WB-008(20MB, 구조에 출처)·ERR-WB-011(암호·배포용 hwp·한도, 가져오기
실패) 정정, **FR-WB-093**(문서 구조 가져오기: 여는 곳·후보·기본 선택 규칙·수준 이동·제목 수정·
미리보기·만들기) 신설, **AC-WB-038** 신설. 용어에 「목차 후보」. `spec/INDEX.md` 「양식 파일 작성」
행 보강과 「문서 구조 가져오기 — 목차 후보」 행 신설. `references/hwp_format.md` 신설.

## 8. 빌더에게 맡기는 것

- 대화상자의 세부 문구·CSS 값, segmented 의 키보드 조작, 미리보기의 접기 여부.
- CFB 쓰기에서 FAT/DIFAT 섹터 수를 정하는 반복 계산의 구체 방법(결과가 올바르면 된다).
- 붙박이 hwp 의 DocInfo 최소 구성(STYLE·PARA_SHAPE 만으로 충분한지, DOCUMENT_PROPERTIES 가 필요한지).
