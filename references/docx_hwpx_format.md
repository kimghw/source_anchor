# DOCX · HWPX 파일 형식 — 표 읽기·셀 기입에 필요한 구조 (2026-10-21)

둘 다 ZIP + XML 이다. 실제 파일(Word 가 만든 회의록 양식 docx, 한컴이 만든 기술수요조사서 hwpx,
AIComp 의 `hwpxform.py`·vendor `docx_form.py` 가 다룬 파일들)에서 확인한 사실만 적는다.
앱 안 소비자는 `lib/docx_form.js`·`lib/hwpx_form.js`·`lib/zip.js`(설계: docs/superpowers/specs/2026-10-21-form-fill-design.md).

## 공통 — 다시 쓰기 원칙

- 표를 고칠 때 XML 전체를 DOM 으로 읽어 다시 직렬화하면 안 된다. 속성 순서·네임스페이스·
  자기 닫힘 표기가 바뀌어 Word·한글 호환이 깨진다. 바꿀 구간만 문자열로 잘라 바꾼다.
  (`lib/html.js parseHtml` 은 태그·속성 이름을 소문자로 바꾸고 CDATA·PI 를 버린다 — 읽기 전용.)
- 토큰 정규식은 `</?접두사:(tbl|tr|tc|p)(?=[\s/>])` 처럼 뒤를 확인해야 `tcPr`·`tblPr` 를
  셀·표로 잘못 잡지 않는다. 깊이를 세어 최상위 요소만 고른다 — 셀 안에 표가 또 있다.
- 텍스트 노드 이스케이프는 `& < >` 세 개면 된다(속성에 넣지 않는다).

## ZIP 컨테이너

- 로컬 헤더 30B(`PK\x03\x04`) + 이름 + extra + 본문, 중앙 디렉터리 항목 46B(`PK\x01\x02`),
  EOCD 22B(`PK\x05\x06`). 크기·CRC 는 중앙 디렉터리가 정본(로컬 헤더는 비어 있을 수 있다 —
  일반 목적 플래그 비트 3 데이터 디스크립터).
- Word docx: 모든 항목 deflate, 플래그 0, extra 없음, `[Content_Types].xml` 이 첫 항목.
- 한컴 hwpx: `mimetype` 이 **첫 항목이고 저장(STORED)**, 내용 `application/hwp+zip`(19B).
  `version.xml`·`Preview/PrvImage.png` 저장, 나머지 deflate, 플래그 4(비트 2만).
- 다시 쓸 때 항목 순서와 항목별 압축 방식을 지키고, 손대지 않은 항목은 압축된 바이트를 그대로
  복사하면 된다. Word·한글은 CRC 를 검사한다(`lib/zip.js readZip` 은 검사하지 않는다) —
  `zlib.crc32`(Node ≥ 22.2)로 채운다.
- `Preview/PrvText.txt`·`PrvImage.png`(hwpx 미리보기)는 본문을 고쳐도 다시 만들지 않아도
  열린다(AIComp 가 그렇게 쓴다). 스테일 미리보기만 남는다.

## DOCX (`word/document.xml`)

- 표: `<w:tbl><w:tblPr>…</w:tblPr><w:tblGrid><w:gridCol w:w="1744"/>…</w:tblGrid><w:tr>…`
  열 폭은 `w:gridCol w:w`(dxa = 1/20 pt). `w:tblW`·`w:tcW` 의 `w:type` 은 `dxa`|`pct`|`auto`.
- 행: `<w:tr …><w:trPr><w:trHeight w:hRule="exact" w:val="620"/>…</w:trPr>` — 620 twips =
  31 pt. `hRule="exact"` 면 넘치는 글이 잘린다(Word 가 늘리지 않는다).
- 칸: `<w:tc><w:tcPr><w:tcW …/><w:gridSpan w:val="5"/><w:vMerge w:val="restart"/>…</w:tcPr>
  <w:p>…</w:p></w:tc>`. 가로 병합은 `w:gridSpan`(칸 하나가 여러 그리드 열). 세로 병합은
  시작 칸 `<w:vMerge w:val="restart"/>`, 이어지는 행의 칸은 **`<w:vMerge/>`(값 없음)** 이며
  빈 `w:tc` 로 실제 존재한다 — `w:tc` 순번을 세면 이어짐 칸도 한 자리를 차지한다.
  rowspan 은 colspan 을 누적한 그리드 열 g 가 같은 아래 행 이어짐 칸 수 + 1.
- 칸 안에는 `w:p` 가 하나 이상 반드시 있다(빈 칸도 `<w:p/>` 또는 `<w:p><w:pPr/></w:p>`).
  Word 는 `w:p` 없는 `w:tc` 를 거부한다.
- 문단: `<w:p w14:paraId=… w:rsidR=…><w:pPr>…<w:rPr>…</w:rPr></w:pPr><w:r><w:rPr>…</w:rPr>
  <w:t xml:space="preserve"> 록</w:t></w:r></w:p>`. `w:pPr` 안의 `w:rPr` 는 **문단 표시**
  서식이고 글자 서식은 `w:r` 안 `w:rPr` 다. 첫 런에 `w:rPr` 가 없을 수 있어 "rPr 가 있는
  첫 런"을 찾고, 없으면 문단 표시 `w:rPr` 를 쓴다. `w:proofErr/`·`w:bookmarkStart/` 가 런
  사이에 끼어 있다(버려도 된다). 앞뒤 공백이 있는 글은 `xml:space="preserve"` 가 필요하다.
- 줄바꿈 `<w:br/>`, 탭 `<w:tab/>` 은 `w:r` 안에 온다. 숫자 문자 참조 `&#…;` 가 올 수 있다.
- 칸 안에 중첩 `w:tbl`, 블록 `w:sdt`(콘텐츠 컨트롤 — `<w:sdt><w:sdtContent><w:p>…`), `w:drawing`,
  필드 `w:fldChar` 가 올 수 있다. 첫 문단~마지막 문단 구간을 통째로 바꾸면 그 사이의 것이
  사라지고, 문단 + 블록 sdt 가 섞이면 깨진 XML 이 된다 → 이런 칸은 기입하지 않는다.
- 새 문단은 `w14:paraId`·`w:rsid*` 없이 `<w:p>` 로 써도 Word 가 연다(vendor 산출물로 확인).
- 구역(섹션) 설정 `<w:sectPr>` 는 그 구역의 **마지막 문단** `<w:pPr>` 안에 들어 있다(문서 맨 끝 구역만 `w:body` 의 마지막 자식). 이 문단의 `w:pPr` 를 버리면 쪽 설정·머리말 연결이 사라진다.
- 변경 추적이 켜진 문서에서는 `w:rPr` 안에 `<w:rPrChange>`, `w:pPr` 안에 `<w:pPrChange>` 가 오고, 그 안에 **이전 서식의 `w:rPr`/`w:pPr` 가 또 들어 있다** — 같은 이름 중첩이라 첫 닫는 태그에서 끊으면 서식 구간을 잘못 자른다(깊이를 센다).
- 상용 양식(AIP 신청서)은 인라인 `w:sdt` 가 런을 감싸기도 한다(블록이 아니라 칸 글 안).

## HWPX (`Contents/section<n>.xml`, `Contents/header.xml`)

- 섹션이 여럿이면 `section0.xml`, `section1.xml` … 번호순이 문서 순서. 본문 표는
  `<hp:p><hp:run><hp:tbl rowCnt= colCnt=>` 처럼 **문단의 런 안**에 있다.
- 접두사는 `hp:` 가 관례지만 고정이 아니다(`ns0:` 등). 문서에서 잡아 쓴다.
- 표: `tbl` → `tr` → `tc` → `subList` → `p` → `run` → `t`. 칸 자식 순서는
  `<hp:subList>…</hp:subList><hp:cellAddr colAddr rowAddr/><hp:cellSpan colSpan rowSpan/>
  <hp:cellSz width height/><hp:cellMargin …/>` — 실제 파일에서 `cellAddr` 가 `subList` **뒤**에
  온다(정본 순서 가정 금지).
- 좌표: `cellAddr` 가 정본. 병합하면 칸이 사라지므로 colAddr 가 0,1,2,4,7,8,10 처럼 **희소**하다.
  `cellSpan colSpan/rowSpan` 이 병합 크기. 열 그리드 정의는 없고 `cellSz width`(hwpunit =
  1/7200 inch; pt 는 /100 으로 근사)와 `<hp:tbl><hp:sz width>` 뿐이다.
- 문단: `<hp:p id="…" paraPrIDRef="33" styleIDRef="0" …><hp:run charPrIDRef="32"><hp:t>글</hp:t>
  </hp:run><hp:linesegarray>…</hp:linesegarray></hp:p>`. `paraPrIDRef`·`charPrIDRef` 가
  `header.xml` 의 서식을 가리킨다 — 문단을 바꿀 때 원래 `<hp:p …>` 여는 태그와 첫 런의 속성을
  그대로 쓰면 서식이 남는다. `linesegarray`(줄 배치 캐시)는 내지 않아도 한글이 다시 계산한다.
- 빈 칸은 `<hp:run charPrIDRef="33"/>` 처럼 **자기 닫힘 런**이고 `hp:t` 가 없다. 속성을 재사용할
  때 끝의 `/` 를 떼야 한다. `<hp:t/>` 도 빈 것으로 본다.
- `hp:t` 안에 `<hp:tab/>`·`<hp:lineBreak/>`·`<hp:markpenBegin/>` 같은 태그가 끼어 든다.
- 그리기 개체(`hp:pic`·`hp:rect`·`hp:container`) 안에도 `subList`/`p` 가 중첩되고, 칸 안에 표가
  또 올 수 있다(중첩 표). 같은 이름 중첩 깊이를 세어 최상위 것만 고른다.
- 여러 줄 값을 문단 여러 개로 쓸 때 같은 `id` 속성이 반복돼도 한글이 연다(AIComp 가 그렇게
  쓰고 검증했다).
- 문단 안 컨트롤은 `<hp:run><hp:ctrl>…</hp:ctrl></hp:run>` 로 온다. `ctrl` 의 자식이 `colPr`(단 설정)·`header`·`footer`·`footNote`·`endNote`·`pageNum`·`pageHiding`·`newNum` 이면 문서 설정이나 머리말·각주 내용이라 그 문단을 새로 쓰면 사라진다. `fieldBegin`/`fieldEnd` 는 누름틀(클릭해 입력하는 필드), `bookmark`·`indexMark`·`hiddenComment`·`autoNum` 은 문서 구조를 바꾸지 않는 표시·자동 번호다.
- 섹션의 **첫 문단**은 보통 `<hp:run><hp:secPr …>…</hp:secPr><hp:ctrl><hp:colPr …/></hp:ctrl></hp:run>` 처럼 쪽 설정(`secPr`)과 단 설정(`colPr`)을 함께 품는다 — 본문 첫 줄처럼 보여도 문서 설정 문단이다.
- 열 그리드가 없으므로 열 폭은 `cellSz width` 로 구한다: 행마다 왼쪽 경계(0)에서 칸 폭을 더해 열 경계를 모으면 병합 칸 사이의 경계도 다른 행에서 풀린다. `colSpan` 1 칸만으로는 기술수요조사서.hwpx 의 11열 중 7열이 풀리지 않았다.
- 참고: AIComp `references/HWPX_포맷.md`(같은 사실의 원 기록, 2026-09-02).

## 표본 파일(테스트·수동 확인용, 읽기 전용)

- `E:/dev/AIComp/demo/samples/기술수요조사서.docx` — 표 1, 행 20, 칸 42, gridSpan 20, vMerge 0.
- `E:/dev/AIComp/demo/samples/기술수요조사서.hwpx` — 표 2, 행 19, 칸 43(모두 cellAddr),
  span>1 34개, 그리기 개체 0.
- `E:/dev/AIComp/data/docforms/1/src/회의록_양식.docx` — 표 1, 행 7(모두 hRule=exact), 칸 16,
  gridSpan 6, vMerge restart 1 + 이어짐 2.
- 큰 것: vendor 폴더의 HAZID 보고서 docx — 표 38, 칸 2,965, w:br 323, w:sdt 28, fldChar 894.
