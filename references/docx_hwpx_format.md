# DOCX · HWPX 파일 형식 — 표 읽기·셀 기입에 필요한 구조 (2026-10-21)

둘 다 ZIP + XML 이다. 실제 파일(Word 가 만든 회의록 양식 docx, 한컴이 만든 기술수요조사서 hwpx,
그 밖에 이 형식을 다룬 문서들)에서 확인한 사실만 적는다.
한글 5.0 바이너리(`.hwp`, OLE 복합 문서 안의 압축 레코드)는 [hwp_format.md](hwp_format.md) 에 따로 적는다.

## 공통 — 다시 쓰기 원칙

- 표를 고칠 때 XML 전체를 DOM 으로 읽어 다시 직렬화하면 안 된다. 속성 순서·네임스페이스·
  자기 닫힘 표기가 바뀌어 Word·한글 호환이 깨진다. 바꿀 구간만 문자열로 잘라 바꾼다.
  태그·속성 이름의 대소문자를 바꾸거나 CDATA·처리 지시문을 버리는 파서의 결과도 쓰기에는 쓸 수 없다.
- 토큰 정규식은 `</?접두사:(tbl|tr|tc|p)(?=[\s/>])` 처럼 뒤를 확인해야 `tcPr`·`tblPr` 를
  셀·표로 잘못 잡지 않는다. 깊이를 세어 최상위 요소만 고른다 — 셀 안에 표가 또 있다.
- 텍스트 노드 이스케이프는 `& < >` 세 개면 된다(속성에 넣지 않는다).
- XML 1.0 은 TAB(U+0009)·LF(U+000A)·CR(U+000D)을 뺀 C0 제어 문자(U+0000–U+001F)와 비문자
  U+FFFE·U+FFFF 를 허용하지 않는다 — 이스케이프로도(`&#2;`) 안 된다. 이런 글자가 든 파일은
  Word 가 "읽을 수 없는 내용"으로 알리고 한글은 열지 않는다. PDF·Word 에서 복사한 글에
  U+0002·U+000B(세로 탭) 같은 글자가 섞여 오므로 써 넣기 전에 빼야 한다. 짝 없는 서로게이트
  (U+D800–U+DFFF 단독)는 UTF-8 로 인코딩되지 않아 U+FFFD 로 바뀐다.
- 문단 하나를 여러 문단으로 나눠 쓸 때 원래 문단의 서식(docx `w:pPr`, hwpx `<hp:p>` 여는 태그)을
  그대로 되풀이하면 그 안의 쪽·단 나눔도 문단마다 되풀이된다(아래 각 형식의 해당 항목).

## ZIP 컨테이너

- 로컬 헤더 30B(`PK\x03\x04`) + 이름 + extra + 본문, 중앙 디렉터리 항목 46B(`PK\x01\x02`),
  EOCD 22B(`PK\x05\x06`). 크기·CRC 는 중앙 디렉터리가 정본(로컬 헤더는 비어 있을 수 있다 —
  일반 목적 플래그 비트 3 데이터 디스크립터).
- Word docx: 모든 항목 deflate, 플래그 0, extra 없음, `[Content_Types].xml` 이 첫 항목.
- 한컴 hwpx: `mimetype` 이 **첫 항목이고 저장(STORED)**, 내용 `application/hwp+zip`(19B).
  `version.xml`·`Preview/PrvImage.png` 저장, 나머지 deflate, 플래그 4(비트 2만).
- 다시 쓸 때 항목 순서와 항목별 압축 방식을 지키고, 손대지 않은 항목은 압축된 바이트를 그대로
  복사하면 된다. Word·한글은 CRC 를 검사하므로 새로 쓰는 항목은
  CRC-32 를 채워야 한다(Node ≥ 22.2 의 `zlib.crc32`).
- `Preview/PrvText.txt`·`PrvImage.png`(hwpx 미리보기)는 본문을 고쳐도 다시 만들지 않아도
  열린다(확인됨). 오래된 미리보기만 남는다.

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
- 블록 수준에서 문단을 감쌀 수 있는 요소는 `w:sdt` 와 `w:customXml` 이다. 칸의 첫 문단만
  `<w:customXml>` 안에 있을 때 첫 문단~마지막 문단 구간을 바꾸면 닫는 태그만 사라져 깨진 XML 이 된다.
- 앞 쪽 나눔은 `w:pPr` 안 `<w:pageBreakBefore/>`(`w:val="0"` 이면 끔 — 스타일의 쪽 나눔을 문단에서
  끌 때 쓴다). 각주·미주·메모의 참조 표시는 런 안의 `<w:footnoteReference w:id=…/>`·
  `<w:endnoteReference/>`·`<w:commentReference/>` 이고 본문은 `footnotes.xml`·`endnotes.xml`·
  `comments.xml` 에 있다 — 런을 새로 쓰면 참조 표시가 사라진다.

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
- 여러 줄 값을 문단 여러 개로 쓸 때 같은 `id` 속성이 반복돼도 한글이 연다(확인됨).
- 쪽·단 나눔은 문단 여는 태그의 속성 `pageBreak="1"`·`columnBreak="1"` 이다(없거나 `"0"` 이면 나누지 않는다).
- 문단 안 컨트롤은 `<hp:run><hp:ctrl>…</hp:ctrl></hp:run>` 로 온다. `ctrl` 의 자식이 `colPr`(단 설정)·`header`·`footer`·`footNote`·`endNote`·`pageNum`·`pageHiding`·`newNum` 이면 문서 설정이나 머리말·각주 내용이라 그 문단을 새로 쓰면 사라진다. `fieldBegin`/`fieldEnd` 는 필드의 시작·끝이고 종류는 `type` 속성이 정한다(누름틀은 `type="CLICK_HERE"`, 하이퍼링크·날짜 등도 같은 요소). `bookmark`·`indexMark`·`autoNum` 은 문서 구조를 바꾸지 않는 표시·자동 번호다. `hiddenComment` 는 숨은 설명 안에 `subList`/`p` 를 품는다.
- 섹션의 **첫 문단**은 보통 `<hp:run><hp:secPr …>…</hp:secPr><hp:ctrl><hp:colPr …/></hp:ctrl></hp:run>` 처럼 쪽 설정(`secPr`)과 단 설정(`colPr`)을 함께 품는다 — 본문 첫 줄처럼 보여도 문서 설정 문단이다.
- 열 그리드가 없으므로 열 폭은 `cellSz width` 로 구한다: 행마다 왼쪽 경계(0)에서 칸 폭을 더해 열 경계를 모으면 병합 칸 사이의 경계도 다른 행에서 풀린다. `colSpan` 1 칸만으로는 기술수요조사서.hwpx 의 11열 중 7열이 풀리지 않았다.

## 문단의 제목·번호 정보 (2026-10-22 표본 파일로 확인)

- DOCX: 문단의 `<w:pPr><w:pStyle w:val="…"/>` 는 스타일 **ID** 다(이름이 아니다). 이름은 `word/styles.xml`
  의 `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>…` — 내장 스타일 이름은
  소문자 영문(`heading 1`, `header`, `footer`)이고, ID 는 문서를 만든 Word 의 언어에 따라 다를 수 있다
  (영문 `Heading1`; 한국어 Word 는 `1`·`2` 같은 ID 가 흔하다 — 이 부분은 일반 지식, 표본 미확인).
  개요 수준은 문단 `w:pPr` 의 `<w:outlineLvl w:val="0"/>`(0 부터, 9 는 본문) 또는 **스타일의 `w:pPr`**
  에 있고, `<w:basedOn w:val="…"/>` 로 바탕 스타일에서 물려받는다. 자동 번호는 `<w:numPr><w:ilvl/><w:numId/>`
  이고 번호 글자는 `document.xml` 에 없다(`numbering.xml` 로 그려진다).
- HWPX: `Contents/header.xml` 의 `<hh:paraPr id="…">` 안 `<hh:heading type="NONE|OUTLINE|NUMBER|BULLET"
  idRef="…" level="0"/>` 가 문단 머리(개요·번호·글머리표)와 수준(0 부터)이다 — 표본에서는 `NONE`·`BULLET`
  만 보였고 `OUTLINE`·`NUMBER` 는 같은 자리의 규격 값이다. 스타일은 `<hh:style id="0" type="PARA" name="바탕글"
  engName="Normal" paraPrIDRef="5" charPrIDRef="16" …/>`(사용자 스타일 이름에 글머리 기호가 들어가기도 한다:
  `◦ 내용1`). 본문 문단은 여는 태그의 `paraPrIDRef`·`styleIDRef` 로 이것들을 가리키고, 개요·번호 글자는
  `hp:t` 에 없다.

## 표본 파일(테스트·수동 확인용, 읽기 전용)

- `E:/dev/AIComp/demo/samples/기술수요조사서.docx` — 표 1, 행 20, 칸 42, gridSpan 20, vMerge 0.
- `E:/dev/AIComp/demo/samples/기술수요조사서.hwpx` — 표 2, 행 19, 칸 43(모두 cellAddr),
  span>1 34개, 그리기 개체 0.
- `E:/dev/AIComp/data/docforms/1/src/회의록_양식.docx` — 표 1, 행 7(모두 hRule=exact), 칸 16,
  gridSpan 6, vMerge restart 1 + 이어짐 2.
- 큰 것: vendor 폴더의 HAZID 보고서 docx — 표 38, 칸 2,965, w:br 323, w:sdt 28, fldChar 894.
