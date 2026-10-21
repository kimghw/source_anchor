# PDF 파일 구조 — 주석을 덧붙일 때 알아 둘 것

보관한 PDF 원본에 형광 주석을 덧붙이는 `lib/pdf_annot.js` 가 기대는 외부 규격(ISO 32000)과 보기 프로그램의 동작. 2026-09-22 확인.

## 파일 구조

- 파일은 `N G obj … endobj` 객체들과, 객체 번호 → 파일 오프셋 표(xref), 트레일러(`/Root` 카탈로그 참조·`/Info`·`/ID`)로 되어 있다. 맨 끝의 `startxref` 가 마지막 xref 절의 오프셋을 가리킨다.
- **증분 갱신**: 원본 바이트 뒤에 바뀐 객체·새 객체·새 xref 절·새 트레일러(`/Prev` = 앞 xref 절 오프셋)를 이어 붙이면 앞 내용은 그대로 둔 채 고쳐진다. 같은 번호의 객체는 뒤에 있는 것이 이긴다.
- **xref 두 방식**: 예전 방식은 `xref` 키워드 + 20바이트 고정 줄(`오프셋 10자리 세대 5자리 n`) + `trailer <<…>>`. PDF 1.5 부터는 xref 스트림(`/Type /XRef`, `/W [1 4 2]` 등 필드 폭, `/Index [시작 개수 …]`, 트레일러 항목을 스트림 사전에)이다. 2026-09-22 작업공간의 PDF 는 7건 중 6건이 xref 스트림 + 선형화(Linearized)였다.
- **PDFium(Chrome·Edge PDF 보기)은 두 방식이 섞인 `/Prev` 사슬을 읽지 못한다** — 마지막 절이 `xref` 표면 앞 절도 표로, 스트림이면 스트림으로 따라간다. 증분 갱신은 원본과 같은 방식으로 써야 한다. poppler 는 어느 쪽이든 읽는다.
- **객체 스트림(`/Type /ObjStm`)**: 사전 객체 여러 개를 하나의 압축 스트림(`/N` 개수, `/First` 첫 객체 오프셋, 앞부분에 "번호 오프셋" 쌍) 안에 넣는다. 페이지 객체도 흔히 여기 있다. 갱신할 때는 그 객체를 평문 `N 0 obj` 로 다시 내면 된다(안에 있던 객체의 세대는 0).
- 스트림 `/Length` 는 간접 참조(`12 0 R`)일 수 있다. `/Filter /FlateDecode` 는 zlib inflate, `/DecodeParms /Predictor 10~15` 는 PNG 예측 필터(xref 스트림에 흔하다).
- 선형화 파일은 `startxref` 가 파일 앞머리의 첫 페이지 xref 를 가리키고 그 트레일러의 `/Prev` 가 뒤쪽 주 xref 를 가리킨다. `/Root` 는 첫 트레일러에 있다. 증분 갱신을 붙이면 선형화 힌트는 무효가 되지만 보기 프로그램은 무시한다.

## 페이지 좌표

- 페이지 좌표는 왼쪽 아래가 원점이고 위로 +y, 단위 pt. 표시 영역은 `/CropBox`(없으면 `/MediaBox`)이며 `/Pages` 부모에게서 물려받을 수 있다(`/Rotate` 도).
- poppler `pdftotext -bbox-layout` 의 낱말 좌표(`<word xMin yMin xMax yMax>`)는 **페이지 왼쪽 위가 원점이고 아래로 +y** 다. `<page width height>` 는 표시 영역 크기. PDF 좌표로는 `y = box.y2 - yMin`, `x = box.x1 + xMin` 으로 뒤집는다(작업공간 PDF 는 모두 상자가 0,0 에서 시작, 회전 0 — 회전한 페이지는 확인하지 못했다).
- 낱말 글자는 NFKC 로 맞춘다(합자 ﬁ 등). 줄 끝 하이픈으로 나뉜 낱말은 두 낱말로 나온다.

## 주석 (Annotations)

- 페이지 사전의 `/Annots [ref …]` 에 주석 객체를 더한다. 형광은 `/Subtype /Highlight`, 자리는 `/QuadPoints [x1 y1 x2 y2 x3 y3 x4 y4 …]`(사각형마다 왼쪽 위·오른쪽 위·왼쪽 아래·오른쪽 아래 — PDFium 은 [0]=왼쪽, [1]=위, [2]=오른쪽, [5]=아래로 읽는다), `/Rect` 는 전체를 감싸는 사각형, `/C [r g b]` 색, `/F 4` 인쇄 포함.
- 외형 스트림(`/AP`)이 없어도 **PDFium 이 Highlight·Underline·Square·Popup 등의 외형을 스스로 만들어 그린다**(확인 — Edge 헤드리스에서 노란 형광이 자리 그대로 보였다). `/Contents` 가 있으면 작은 메모 아이콘도 그려 준다.
- `/Contents`·`/T` 같은 글은 `<FEFF…>` UTF-16BE 16진 문자열로 쓰면 한글이 들어간다. Chrome·Edge 의 내장 보기는 주석 내용을 팝업으로 보여 주지 않는다 — 메모 내용은 앱 화면 쪽 목록으로 보여 준다. Acrobat 등은 보여 준다.
- `/Popup` 주석은 PDFium 이 Helvetica 로 글을 그려 한글이 나오지 않는다(임베드 글꼴이 필요) — 쓰지 않았다.

## 확인 방법

- poppler `pdfinfo <파일>` 의 stderr 가 비어 있으면 xref·트레일러가 정상이다(깨졌으면 "Couldn't read xref" 류 경고를 낸다).
- 브라우저: PDF 를 `application/pdf` 로 서빙하고 `#page=N&zoom=90` 으로 열어 스크린샷.
