# PPT 파일(pptx) 구조 — 글과 표를 꺼낼 때 알아 둘 것

pptx 는 XML 파일을 ZIP 으로 묶은 것이다(Office Open XML, PresentationML). 2026-09-20, Microsoft 365 PowerPoint 가 저장한 파일로 확인.

## 파일 가리기

- pptx·docx·xlsx 는 모두 ZIP 이라 앞머리가 `PK\x03\x04` 다. 안에 `ppt/presentation.xml` 이 있으면 PowerPoint 문서다(`.ppsx` 슬라이드 쇼도 같은 구조).
- 예전 `.ppt`·`.doc`·`.xls` 는 OLE 복합 파일로 앞머리가 `D0 CF 11 E0 A1 B1 1A E1` 이다. **암호를 건 pptx 도 ZIP 이 아니라 OLE 로 저장된다.**
- 내려받기 주소가 `download.do?fileId=…` 꼴이고 `Content-Type` 이 `application/octet-stream` 인 경우가 많아, 확장자나 응답 머리말이 아니라 앞머리로 가려야 한다. 정식 MIME 은 `application/vnd.openxmlformats-officedocument.presentationml.presentation`.

## ZIP

- 항목의 크기·위치는 파일 끝의 중앙 디렉터리에서 읽는다. 항목 앞 머리말(local header)은 플래그 3번 비트가 켜져 있으면 크기가 0 으로 비어 있다.
- 끝 기록(EOCD, `PK\x05\x06`) 뒤에 주석이 최대 65,535 바이트 붙을 수 있어 끝에서부터 거꾸로 찾는다.
- PowerPoint 는 deflate(8)로, 일부 항목은 저장(0)으로 넣는다. 그림이 많으면 파일이 수십 MB 지만 슬라이드 XML 은 보통 수십~수백 KB 다.

## 슬라이드 순서

- 발표 순서는 파일 이름의 번호(`slide1.xml` …)가 **아니다**. 슬라이드를 옮기거나 지우면 어긋난다.
- `ppt/presentation.xml` 의 `<p:sldIdLst><p:sldId r:id="rId3"/>…` 순서가 발표 순서이고, `rId` 는 `ppt/_rels/presentation.xml.rels` 의 `<Relationship Id="rId3" Target="slides/slide2.xml"/>` 로 푼다. `Target` 은 `ppt/` 기준 상대 경로이거나 `/ppt/…` 절대 경로다.
- 숨긴 슬라이드(`<p:sld show="0">`)도 목록에 있고 PowerPoint 의 슬라이드 번호를 차지한다.

## 슬라이드 안의 글

- 도형은 `<p:cSld><p:spTree>` 아래에 놓인 순서(겹침 순서)로 들어 있다. 읽는 순서와 다를 수 있고, 제목 도형이 맨 앞이 아닐 수 있다.
- 글상자: `<p:sp>` → `<p:txBody>` → 문단 `<a:p>` → 조각 `<a:r><a:t>글</a:t></a:r>`. 한 문장이 서식 때문에 여러 조각으로 나뉘므로 문단 안의 `a:t` 를 그대로 이어 붙인다. 문단 안 줄 바꿈은 `<a:br/>`.
- 자리 표시자 종류는 `<p:nvSpPr><p:nvPr><p:ph type="…"/>`: `title`·`ctrTitle`(제목), `subTitle`, `body`, `sldNum`(쪽 번호), `dt`(날짜), `ftr`(바닥글), `hdr`. `type` 이 없으면 본문 자리다. 직접 넣은 글상자에는 `p:ph` 가 없다.
- 쪽 번호·날짜는 `<a:fld type="slidenum">`·`<a:fld type="datetime…">` 필드로 들어가고, 안의 `a:t` 는 저장할 때의 값이다.
- 글머리표 문단은 보통 `a:p` 하나가 항목 하나다. 글머리표 여부는 레이아웃·마스터에서 물려받는 경우가 많아 슬라이드 XML 만으로는 알 수 없다.
- 묶은 도형은 `<p:grpSp>` 안에 `p:sp` 가 다시 들어 있다(여러 겹 가능).
- `<mc:AlternateContent>` 는 같은 내용을 `<mc:Choice>`(새 기능)와 `<mc:Fallback>`(그림 등 대체물)으로 두 번 담는다. 둘 다 읽으면 글이 겹친다.

## 표

- `<p:graphicFrame>` → `<a:graphic><a:graphicData>` → `<a:tbl>` → 행 `<a:tr>` → 칸 `<a:tc>` → `<a:txBody>`.
- 병합해도 칸은 없어지지 않는다. 시작 칸에 `gridSpan="2"`(가로)·`rowSpan="2"`(세로)가 붙고, 가려진 칸은 `hMerge="1"`·`vMerge="1"` 이 붙은 빈 칸으로 남는다. 그래서 **모든 행의 `a:tc` 수가 열 수와 같다.**
- 제목 줄 여부는 `<a:tblPr firstRow="1">` 에 있지만 서식용 표시일 뿐이고, 제목이 두 줄인지는 적혀 있지 않다.

## 슬라이드 XML 에 없는 것

- 차트의 값: `ppt/charts/chartN.xml`(+ 묻어 둔 xlsx). SmartArt 의 글: `ppt/diagrams/dataN.xml`. 발표자 노트: `ppt/notesSlides/notesSlideN.xml`.
- 문서 속성은 `docProps/core.xml` 의 `dc:title`·`dc:creator`·`dcterms:created`. 제목은 PowerPoint 기본값("PowerPoint 프레젠테이션")이 그대로 남은 파일이 많고, 만든 날짜는 발행일이 아니다.
