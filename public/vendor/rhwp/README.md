# rhwp — 한글(hwp·hwpx) 문서를 쪽 단위 SVG 로 그리는 WebAssembly 렌더러 (제3자 코드)

- 출처: https://github.com/edwardkim/rhwp · npm `@rhwp/core` **0.8.7**(2026-10-06 공개) · MIT(LICENSE 참조)
- 파일: `rhwp.js`(wasm-bindgen ESM 글루) · `rhwp_bg.wasm`. 두 파일은 npm 패키지의 것을 그대로 두며
  이 저장소에서 고치지 않는다. 소스 크기 상한·구조 검사(`test/arch.test.js`)에서 `public/vendor` 는 제외한다.
- 쓰는 곳: `public/js/form_preview.js` — 양식 화면의 「미리보기」(FR-WB-096). WASM 초기화 전에
  `globalThis.measureTextWidth` 를 등록해야 하고, 서버는 `.wasm` 을 `application/wasm` 으로 보낸다.
- 갱신: `npm pack @rhwp/core@<버전>` 으로 받은 tgz 에서 `rhwp.js`·`rhwp_bg.wasm`·`LICENSE` 를 이 폴더에
  덮어쓰고 이 파일의 버전을 고친다(0.x 라 API 가 바뀔 수 있다 — `new HwpDocument(bytes)`·`pageCount()`·
  `renderPageSvg(i)`·`free()` 만 쓴다). 동작 사실은 `references/hwp_render_rhwp.md`.
