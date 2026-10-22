# 브라우저 동작 — 끌어 놓기 · 문장 편집 · 문장 분리

브라우저(Chromium 계열 기준)의 동작·제약을 모아 둔다. 2026-09-20 Edge 헤드리스로 확인한 항목은 (확인)으로 표시.

## HTML5 끌어 놓기

- `dragover`·`dragenter` 중에는 `dataTransfer.getData()` 를 읽을 수 없다(형식 목록 `types` 만 보인다). 놓기 전에 내용에 따라 표시를 바꾸려면 끌기 시작 때 내용을 따로 들고 있어야 한다.
- `dragstart` 핸들러 안에서 DOM·레이아웃을 바꾸면 브라우저가 끌기를 취소할 수 있다. 화면 변경은 `setTimeout` 으로 한 박자 늦춘다.
- `setDragImage` 에 넘기는 요소는 문서에 붙어 있어야 한다(화면 밖 위치는 가능). 호출 뒤 다음 틱에 제거해도 된다.
- `dragenter`/`dragleave` 는 자식 요소를 드나들 때마다 발생한다. 영역 단위 강조는 진입 횟수를 세거나 `relatedTarget` 을 봐야 깜박이지 않는다.
- `draggable` 요소 안의 글은 마우스로 부분 선택할 수 없다.
- 합성 `DragEvent`(`new DragEvent(type, { dataTransfer: new DataTransfer(), clientX, clientY })`)로 핸들러 로직을 자동 확인할 수 있다 (확인). 실제 OS 끌기와 달리 `setDragImage` 는 아무 일도 하지 않는다.
- 헤드리스에서 `draggable` 요소의 **진짜 끌기**를 확인하려면 CDP `Input.setInterceptDrags({ enabled: true })` 뒤 `Input.dispatchMouseEvent` 로 누르고(mousePressed) 몇 번 옮기면(mouseMoved, `buttons: 1`) `Input.dragIntercepted` 이벤트로 끌기 자료(`dragstart` 에서 `setData` 한 사용자 형식 포함)가 온다. 그 자료로 `Input.dispatchDragEvent`(`dragEnter`·`dragOver`·`drop`, 좌표)를 보내면 페이지의 dragover·drop 핸들러가 실제처럼 돈다(2026-10-22 Edge 헤드리스로 확인). 끝나면 mouseReleased 와 `setInterceptDrags(false)`.

## 여러 줄에 걸친 inline 문장의 위치 계산

- 여러 줄에 걸친 inline 요소의 `getBoundingClientRect()` 는 전체를 감싼 사각형이라 앞뒤 판정에 쓸 수 없다. `getClientRects()` 의 줄별 사각형을 쓴다.
- 포인터 아래의 글자 위치는 `document.caretPositionFromPoint(x, y)`(표준) 또는 `caretRangeFromPoint`(구형 Chromium·WebKit)로 얻는다.
- 줄마다 배경·테두리를 따로 그리려면 `box-decoration-break: clone`(`-webkit-` 접두어 병기).
- `:last-of-type` 은 클래스가 아니라 태그 종류 기준이다. 같은 태그의 다른 형제가 뒤에 있으면 `.cls:last-of-type` 은 맞지 않는다 (확인).

## contenteditable

- `contenteditable="plaintext-only"` 는 서식 없는 입력만 받는다. 지원하지 않는 브라우저는 대입 후 값이 바뀌지 않으므로 그때 `"true"` 로 되돌리고 `paste` 를 직접 처리한다.
- 한글 등 IME 조합 중의 Enter 는 글자 확정이다. `event.isComposing` 또는 `keyCode === 229` 이면 단축키로 처리하지 않는다.
- 포커스된 요소를 DOM 에서 제거할 때 `blur` 가 발생하는지는 브라우저·버전에 따라 다르다. `blur` 핸들러는 자기 요소가 아직 편집 대상인지 확인해야 한다.
- `replaceChildren(...)` 에 `null`·`false` 를 넘기면 글자 "null"·"false" 로 들어간다 (확인). 조건부 자식은 걸러서 넘긴다.

## 문장 분리 — Intl.Segmenter

- `new Intl.Segmenter('ko', { granularity: 'sentence' })` 는 브라우저와 Node 에서 같은 결과를 낸다. "48.6%로" 같은 소수점에서는 끊지 않는다 (확인).
- "1." 같은 번호나 "p." 같은 약어 뒤에서는 끊긴다 (확인). 그런 조각은 다음 조각에 붙여야 한다.

## 숫자 정렬

- `font-variant-numeric: tabular-nums` 는 글꼴이 고정폭 숫자를 제공할 때만 효과가 있다. Segoe UI 는 제공한다. 글꼴 목록에서 숫자를 그릴 글꼴이 먼저 오게 한다.
- 소수점 정렬은 CSS 만으로는 안 된다(`text-align: "."` 미지원). 정수부를 오른쪽 정렬하고 소수부 칸의 폭을 열의 최대 소수 자릿수(`Nch` + 소수점 폭)로 맞춘다.

## 보관한 원본을 iframe 으로 넣기 (2026-09-22 Edge 헤드리스로 확인)

- 응답 헤더의 `Content-Security-Policy: sandbox; default-src 'none'` 은 iframe 안 문서에도 그대로 적용된다 — 스크립트가 돌지 않고 외부 자원(CSS·이미지·광고)도 받지 않는다. 스타일시트가 막혀 웹 스냅샷은 꾸밈 없는 HTML 로 보인다(글·구조·링크는 그대로).
- iframe 에 `sandbox` 속성을 값 없이 붙이면 스크립트·폼·팝업이 모두 막히고 출처가 opaque 가 된다. 그러나 **PDF 는 이 상태로 열리지 않는다** — Chromium 의 PDF 보기는 스크립트가 허용된 프레임에서만 돈다. PDF 는 `sandbox` 없이 넣고 서버 헤더에 맡긴다.
- `--headless=new` 의 Edge 도 iframe 안에서 PDF 보기(썸네일·확대·인쇄 도구 포함)를 그린다(확인). 옛 헤드리스는 PDF 를 내려받기로 처리했다.
- 새 프로필로 Edge 를 띄우면 `/json` 의 첫 page 타깃이 `edge://sync-confirmation-dialog/` 이고 `about:blank` 는 그 뒤에 있다. 첫 실행 프로필에서는 브라우저 자체가 광고 스크립트(GPT 경고)·외부 배너 요청(403) 콘솔 로그를 내어 앱의 로그와 섞인다(확인) — 같은 프로필로 두 번째 띄우면 나오지 않는다. 앱의 로그만 보려면 프로필을 한 번 만들어 둔 뒤 다시 띄운다.

## contenteditable=plaintext-only 에서 줄 바꿈 넣기 (2026-09-22 Edge 153 헤드리스로 확인)

- Shift+Enter 로 줄을 나눌 때 `document.execCommand('insertLineBreak')` 가 plaintext-only 에서도 동작한다(`insertText(false, '\n')`·`insertParagraph` 도 같은 결과). 들어간 줄 바꿈은 `textContent` 로 읽으면 사라질 수 있으므로 `innerText` 로 읽는다 — `<br>` 든 텍스트 `\n` 이든 `\n` 으로 돌려준다.
- 줄 바꿈이 화면에 보이려면 편집 중인 요소에 `white-space: pre-wrap` 이 있어야 한다. 요소 끝의 `\n` 은 innerText 에 그대로 남는다(trim 필요).
- `execCommand('insertText', false, 'a\nb')` 는 붙여 넣기에서 줄 바꿈을 그대로 넣는다 — 붙여 넣기 전처리에서 `\s+` 로 공백을 뭉치면 줄 바꿈까지 없어지므로 `[^\S\n]+` 로 뭉친다.
- CDP 로 키를 흉내 낼 때 `Input.dispatchKeyEvent` 의 `code` 는 문자열(`'Enter'`)이어야 한다. 숫자를 주면 오류 응답만 오고 이벤트는 조용히 발생하지 않는다(응답의 `error` 를 확인할 것). Shift 는 `modifiers: 8`.
- (2026-09-22 확인) iframe 안 PDF 보기는 `src` 의 조각(`#page=N`)만 바뀌면 옮겨 가지 않는다. 같은 iframe 을 `about:blank` 로 비웠다가 다시 넣어도(헤드리스 Edge 에서) 그려지지 않았고, **iframe 요소를 새로 만들어 갈아 끼우면** 그 쪽(형광 포함)이 열린다. 웹 스냅샷(sandbox iframe)은 조각(`#id`)만 바꿔도 같은 문서 안에서 그 자리로 간다.
- (2026-09-22 확인) 헤드리스 Edge 의 CDP `Page.captureScreenshot` 은 iframe 의 조각 탐색 직후 그 iframe 을 DOM 에서 떼어 내면 응답이 오지 않고 멈출 수 있다 — 자동 확인 스크립트는 CDP 명령마다 제한 시간을 두고, 스크린샷은 iframe 을 갈아 끼우기 전에 찍는다.

## 컴퓨터의 파일 끌어다 놓기 (2026-10-21 Edge 헤드리스로 확인)

- 바깥(탐색기)에서 온 끌기는 `dataTransfer.types` 에 `'Files'` 가 있다 — 화면 안 끌기(`setData` 로 만든 것)와는 이걸로 가른다. `dragover` 중에도 `types` 와 `files.length` 는 읽을 수 있고 파일 이름·내용은 `drop` 에서만 읽힌다.
- 파일을 받으려면 `dragover` 에서 `preventDefault()` 해야 `drop` 이 발생한다. 아무 데서도 받지 않으면 브라우저가 그 파일로 페이지를 옮겨(PDF 는 뷰어로) 앱이 닫힌다 — `window` 의 `dragover`·`drop` 에서 `Files` 일 때 `preventDefault()` 로 막는다. 단 `<input type=file>` 위에 놓는 것은 막으면 입력란이 파일을 받지 못하므로 대상이 그 입력란이면 빼 둔다(모달 dialog 안이라도 이벤트는 window 까지 올라온다).
- `input.files = dataTransfer.files` 로 끌어다 놓은 FileList 를 파일 입력란에 그대로 넣을 수 있다(Chromium·Firefox). `accept` 는 이때 검사되지 않는다.
- CDP 확인: 페이지 안에서 `new DataTransfer()` 에 `items.add(new File([...], 'a.md'))` 하고 `new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true })` 를 `dispatchEvent` 하면 실제 놓기와 같은 경로를 탄다(`types` 에 `Files` 가 들어가고 `files` 도 찬다). `dispatchEvent` 의 반환값이 false 면 `preventDefault` 된 것이다.
