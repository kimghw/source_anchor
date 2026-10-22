# HWP·HWPX 화면 렌더링 — rhwp(@rhwp/core) 사용법·실측 (2026-10-22)

한글 문서를 브라우저에서 한글 뷰어처럼 그리는 외부 라이브러리의 사실만 적는다. 파일 형식 자체는
[hwp_format.md](hwp_format.md)·[docx_hwpx_format.md](docx_hwpx_format.md).

## rhwp — edwardkim/rhwp (MIT, Rust → WebAssembly)

- HWP 5.0 바이너리·HWPX·HML 을 파싱해 **페이지 레이아웃까지 계산**하고 쪽마다 SVG 를 낸다. npm
  `@rhwp/core` 0.8.7(2026-10-06 공개), 저장소 약 4천 스타·14k 커밋. 패키지 내용물은 `rhwp.js`
  (454KB, wasm-bindgen ESM 글루) + `rhwp_bg.wasm`(11.8MB) + `.d.ts`. 번들러 없이
  `const { default: init, HwpDocument } = await import('./rhwp.js'); await init({ module_or_path:
  './rhwp_bg.wasm' })` 로 동작한다(정적 파일 서버 + Edge 로 확인).
- **init 전에 반드시** `globalThis.measureTextWidth = (font, text) => ctx.measureText(text).width`
  (Canvas 2D)를 등록해야 한다 — 줄바꿈·정렬 계산을 WASM 이 이 콜백으로 한다.
- API: `new HwpDocument(Uint8Array)` → `pageCount()`, `renderPageSvg(i)` → SVG 문자열(A4 가
  793.7 × 1122.5px, 96dpi 기준 px 좌표). SVG 에는 칸·문단을 가리키는 속성이 없다(clipPath id
  `cell-clip-N` 뿐) — 칸 좌표·속성은 `getCellInfo(section, para, control, cell)` ·
  `getPageLayerTreeWithProfile(page, profile)` 같은 별도 API 로 받는다. 편집 API 와
  `exportHwp()`·`exportHwpx()` 도 있으나 0.x 라 시그니처가 바뀔 수 있다.
- 글꼴: SVG 의 `font-family` 가 원본 글꼴 이름 뒤에 폴백 체인(함초롬 → 맑은 고딕 → Noto Sans KR →
  Pretendard …)을 단다. 원본 글꼴이 없는 PC 에서는 폴백 글꼴로 그려져 줄바꿈 자리가 한글과 조금
  달라진다(한컴 글꼴이 없는 이 PC 는 맑은 고딕으로 나왔다).
- 실측 — 연구개발계획서 hwp(10MB, 67쪽, 그림 9개)를 헤드리스 Edge 에서: wasm init 85ms, 파싱 +
  전체 레이아웃 0.5초, 쪽당 SVG 3~100ms, SVG 크기 쪽당 28KB~1.7MB(그림은 `data:image/png` 로
  내장). 표의 병합·테두리·음영·글머리·그림·쪽 번호가 한글이 만든 PDF 와 거의 같게 나왔다. 차이:
  일정표 한 쪽에서 표 머리 행의 글이 비고, 고정 높이 칸의 긴 안내 글이 잘렸다. 우리 엔진이 칸·필드에
  값을 기입한 hwp 도 그대로 열려 값이 제자리에 그려졌다.

## 다른 후보

- hahnlee/hwp.js(Apache-2.0): hwp 5 만, HTML 로 그림. 마지막 커밋 2024-04, npm `hwp.js` 0.0.3(2020).
- LibreOffice + H2Orestart 확장(GPL-3): hwp·hwpx 를 LibreOffice 가 열어 `soffice --headless
  --convert-to pdf:writer_pdf_Export <파일>` 로 PDF 를 만든다. LibreOffice 와 JRE 설치가 필요하고
  변환에 초 단위가 걸린다.
