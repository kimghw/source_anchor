# markdown-it — 브라우저 Markdown 렌더러

확인: 2026-10-22, markdown-it 14.1.0 (`https://cdn.jsdelivr.net/npm/markdown-it@14.1.0/dist/markdown-it.min.js`, MIT, 약 120KB 한 파일).

## 불러오기

- `dist/markdown-it.min.js` 는 UMD 한 파일이다. `exports`·`define` 이 없으면 `globalThis.markdownit` 에 팩토리를 둔다.
  그래서 ES 모듈에서 `import '…/markdown-it.min.js';` 로 부수 효과만 불러온 뒤 `globalThis.markdownit(options)` 로 쓸 수 있다
  — 브라우저 `<script type="module">` 안과 `"type": "module"` 패키지의 Node(`node --test`) 모두 같은 코드로 된다.
- 의존 모듈(entities·linkify-it·mdurl·punycode·uc.micro)은 이 파일 안에 들어 있다. 소스 배포본(`index.mjs`)은 그것들을 따로 import 하므로 한 파일로 두려면 dist 판을 쓴다.

## 안전 관련 동작

- `html: false`(기본값)면 원문 HTML(`<script>` 등)과 HTML 주석(`<!-- … -->`)도 `&lt;…&gt;` 글자로 나온다 — 따로 정화기(DOMPurify 등) 없이 `innerHTML` 에 넣어도 스크립트가 돌지 않는다.
- `javascript:` 등 위험한 주소의 링크는 `validateLink` 가 걸러 링크로 만들지 않는다(글자로 남는다).
- 그림 `![](url)` 은 외부 자원을 불러오므로 끄려면 `.disable('image')`.
- `breaks: true` 면 문단 안 줄바꿈이 `<br>` 이 된다(기본은 공백).
- GFM 파이프 표는 기본 규칙에 들어 있다. 중첩 목록은 부모 표시 너비(`- ` 면 2칸)만큼 들여 쓰면 된다.

## 확장(플러그인 없이 규칙 추가)

- 블록 규칙: `md.block.ruler.before('paragraph', name, (state, startLine, endLine, silent) => …, { alt: ['paragraph'] })`.
  한 줄의 글은 `state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line])`, 4칸 이상 들여 쓴 줄(코드 블록)은 `state.sCount[line] - state.blkIndent >= 4` 로 거른다.
  `state.push(type, tag, nesting)` 로 토큰을 넣고 `state.line` 을 다음 줄로 옮긴 뒤 `true`. `alt: ['paragraph']` 를 주면 문단 바로 다음 줄에서도 문단을 끊고 이 규칙이 잡는다.
- 인라인 규칙: `md.inline.ruler.before('link', name, (state, silent) => …)` — `state.src` · `state.pos` 를 보고 맞으면 `state.push(…)`, `state.pos` 를 옮긴다(`[` 로 시작하는 글을 링크보다 먼저 잡을 때 `before('link')`).
- 렌더러: `md.renderer.rules[토큰 type] = (tokens, idx, options, env, self) => html`. 표 칸 `td_open` 에서 다음 토큰(`tokens[idx + 1]`, inline)의 `content` 를 보면 칸 글을 알 수 있다. `self.renderToken(tokens, idx, options)` 가 기본 출력. 글은 `md.utils.escapeHtml` 로 이스케이프.
