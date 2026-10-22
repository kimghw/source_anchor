# HWP(한글 5.0 바이너리) 파일 형식 — 표 읽기·칸 기입에 필요한 구조 (2026-10-22)

OLE2 복합 문서(CFB) 안에 압축 레코드 스트림을 담는 형식이다. 실제 파일
(`SSCB_산업기술혁신사업 연구개발계획서_한국선급_rev3.hwp`, 10 MB, 한글이 저장한 5.1.0.1 문서)을
2026-10-22 에 바이트 수준으로 확인한 사실만 적는다. ZIP + XML 인 hwpx 와 docx 는
[docx_hwpx_format.md](docx_hwpx_format.md).

## OLE2 복합 문서(CFB) 컨테이너

- 헤더 512B: 서명 `D0 CF 11 E0 A1 B1 1A E1`, 주 버전 3(섹터 512B) 또는 4(섹터 4096B). 헤더 안의
  DIFAT 는 109 항목까지이고, FAT 섹터가 109개를 넘으면 나머지 DIFAT 는 별도 DIFAT 섹터 사슬에 둔다.
- 스트림은 4096B 이상이면 일반 섹터(FAT 사슬)에, 미만이면 루트 항목이 가리키는 mini stream 안의
  64B mini 섹터(mini FAT 사슬)에 놓인다. 루트 항목의 크기가 mini stream 의 크기다.
- 디렉터리 항목 128B: 이름(UTF-16LE, 끝 0 포함 바이트 길이 필드), 종류(1 저장소·2 스트림·5 루트),
  색(red/black), 왼쪽·오른쪽 형제·자식 항목 번호, CLSID, 상태 비트, 생성·수정 시각, 시작 섹터, 크기.
  형제는 이진 트리로 잇고 정렬 규칙은 이름 길이(짧은 것 먼저) → 대문자로 바꾼 이름 비교다.
- 이 파일의 값: 버전 3, 섹터 512B, 디렉터리 항목 28, FAT 섹터 160(> 109 이라 DIFAT 섹터 1),
  mini FAT 1 섹터, 루트(mini stream) 3,520B.
- 스트림(바이트): `FileHeader` 256, `DocInfo` 10,627, `BodyText/Section0` 7,635 · `Section1` 8,706 ·
  `Section2` 145,631, `PrvText` 2,046, `PrvImage` 63,758, `BinData/BIN0001.png` … 9개(최대 4.1 MB),
  `DocOptions/_LinkDoc` 524, `Scripts/DefaultJScript` 16 · `JScriptVersion` 13,
  `\x05HwpSummaryInformation` 461.
- 다시 쓸 때: 손대지 않은 스트림의 바이트, 저장소·스트림 이름, 디렉터리 항목 순서와 트리(left/right/child),
  CLSID·상태 비트·시각을 그대로 두고 섹터 배치만 다시 하면 한글이 연다. 섹터 크기는 원본대로
  (v3 512 / v4 4096), mini stream 컷오프 4096, mini 섹터 64B. 스트림 길이가 4096 경계를 넘나들면
  mini ↔ 일반 섹터로 자리를 옮겨야 한다.
- 독립 확인: python `olefile`(0.47)로 열어 스트림 목록·바이트를 비교할 수 있다.

## FileHeader 스트림(256B)

- 0~31 서명 `HWP Document File`(뒤는 0), 32~35 버전 DWORD — 바이트를 상위부터 MM.nn.PP.rr 로 읽는다
  (0x05010001 = 5.1.0.1), 36~39 속성 비트: bit0 압축, bit1 암호, bit2 배포용 문서.
- 압축 비트가 켜져 있으면 `DocInfo`·`BodyText/Section<n>` 은 **raw deflate**(zlib 헤더 없음 —
  `inflateRawSync`/`deflateRawSync`)다. `PrvText` 는 UTF-16LE 미리보기 글, `PrvImage` 는 미리보기 그림,
  `BinData/BIN####.<ext>` 는 삽입 그림, `DocOptions/_LinkDoc`·`Scripts/*`·`\x05HwpSummaryInformation`
  은 그 밖의 설정·요약 정보다.
- 암호(bit1)·배포용(bit2) 문서는 본문 스트림이 암호화되어 있어 레코드를 읽을 수 없다.

## 레코드

- 헤더 DWORD: tag = bits 0–9, level = bits 10–19, size = bits 20–31. size 가 0xFFF 면 다음 DWORD 가
  실제 크기(확장 헤더). 이 파일엔 확장 헤더 레코드가 없다. level 은 부모-자식 관계이고 레코드는 깊이
  우선 순서로 놓인다 — 어떤 레코드의 자식은 그 뒤에 이어지는 더 깊은 level 의 레코드들이다.
- 태그 ID — DocInfo: DOCUMENT_PROPERTIES 0x10, PARA_SHAPE 0x19, STYLE 0x1A(그 밖에 NUMBERING·BULLET·
  CHAR_SHAPE). 본문: PARA_HEADER 0x42, PARA_TEXT 0x43, PARA_CHAR_SHAPE 0x44, PARA_LINE_SEG 0x45,
  PARA_RANGE_TAG 0x46, CTRL_HEADER 0x47, LIST_HEADER 0x48, TABLE 0x4D.

## DocInfo 스트림

- 이 파일: STYLE 198개(「바탕글」「본문」「개요 1~7」 … 「표내용」 …), PARA_SHAPE 327개(각 58B),
  NUMBERING 3, BULLET 1, BIN_DATA 9(BinData 그림마다 하나), CHAR_SHAPE 307, DOCUMENT_PROPERTIES 26B(@0 UINT16 구역 수 = 3).
- STYLE: WORD 길이 + WCHAR[] 한글 이름, WORD 길이 + WCHAR[] 영문 이름, BYTE 속성(bits 0–2 종류:
  0 문단), BYTE 다음 스타일 id, INT16 언어, UINT16 문단 모양 id, UINT16 글자 모양 id.
  PARA_HEADER 의 styleId 가 이 목록의 순번이다.
- PARA_SHAPE: UINT32 속성1 — bits 23–24 문단 머리 모양 종류(0 없음, 1 개요, 2 번호, 3 글머리표),
  bits 25–27 문단 수준(0 = 1수준). 개요 번호 형식(NUMBERING)이 모두 빈 문자열이면 번호(「1.」「1-1.」
  「(1)」「①」)는 글 안에 타자로 들어 있다 — 이 파일이 그렇다. 따라서 문단의 개요 수준은 글이 아니라
  PARA_SHAPE 의 머리 모양 종류·수준에서 읽어야 한다.

## 본문 스트림(BodyText/Section<n>)

- 이 파일의 Section2: 레코드 23,385, 최상위 문단 624(파일 전체 628 — Section0·1 각 2), 최상위 표 89, 중첩 표 9(level 3 'tbl '),
  최상위 표의 칸 3,953. Section0·1 은 표지·요약으로 표 1개씩. 섹션 수는 DOCUMENT_PROPERTIES 의 구역 수.
- PARA_HEADER(22B 또는 24B, 최상위 문단은 level 0): UINT32 nChars(**bit31 = 목록의 마지막 문단** —
  칸의 마지막 문단과 각 구역(섹션)의 마지막 최상위 문단에 켜져 있고(이 파일: Section0·1·2 마다 마지막 level 0 문단
  하나씩) 그 밖의 최상위 문단에선 꺼져 있다 — 구역의 마지막 문단 뒤에 문단을 끼우면 표시를 새 마지막 문단으로
  옮겨야 한다; 값은 **문단 끝 글자 0x0D 를 포함**),
  UINT32 ctrlMask, UINT16 paraShapeId, UINT8 styleId, UINT8 단 나누기 종류(@11), UINT16 글자 모양 수,
  UINT16 range tag 수, UINT16 줄 정렬 수, UINT32 instanceId, (5.0.3.2 이상) UINT16 변경 추적 병합
  플래그 → 24B.
- PARA_TEXT(level = 문단 + 1): nChars × 2 바이트 UTF-16LE. 제어 글자(코드 < 32) — 글자형 1 유닛 =
  0·10(줄 바꿈)·13(문단 끝)·24~31; 인라인·확장형 8 유닛(16B) = 코드 2B + 12B 정보 + 코드 2B.
  확장형(뒤에 CTRL_HEADER 레코드가 따른다) 1·2·3·11·12·14·15·16·17·18·21·22·23, 인라인형
  4·5·6·7·8·9(탭)·19·20. 확장형의 12B 정보 앞 4B 가 ctrl id(바이트 역순: 'tbl ' 은 ' lbt'). 코드 3 은
  필드 시작이다. **빈 문단은 nChars = 1(0x0D 뿐)이고 PARA_TEXT 레코드가 없다**(이 파일의 빈 문단
  2,261개 모두).
- PARA_CHAR_SHAPE: 8B × n = (UINT32 시작 위치, UINT32 글자 모양 id). PARA_LINE_SEG: 36B × 줄 수
  (UINT32 글자 시작, INT32 세로 위치, INT32 줄 높이, INT32 글자 높이, INT32 baseline, INT32 줄 간격,
  INT32 단 시작, INT32 세그먼트 폭, UINT32 태그) — 한글이 열 때 다시 배치하므로 새 문단은 글자 시작
  0 인 줄 하나만 있어도 된다.
- 문단 블록 = level L 의 PARA_HEADER 부터 다음 level ≤ L 레코드 앞까지(PARA_TEXT·CHAR_SHAPE·
  LINE_SEG·RANGE_TAG·CTRL_HEADER 와 그 아래가 모두 L + 1 이상).

## 표

- CTRL_HEADER('tbl ', 46B, level = 문단 + 1): UINT32 id + 개체 공통 속성(attr, 세로·가로 오프셋, 폭,
  높이, z-order, 바깥 여백 4×INT16, instanceId, 쪽 나눔 방지, WORD 설명 길이 0).
- TABLE(34B, level = ctrl + 1): UINT32 attr, UINT16 rows, UINT16 cols, UINT16 셀 간격, INT16×4 안쪽
  여백, UINT16[rows] 행별 칸 수(@18), UINT16 테두리/배경 id, UINT16 영역 수(0). 행별 칸 수는 병합 뒤
  남은 칸 수다(첫 표 6행 8열: 5·2·5·2·2·2).
- 칸 LIST_HEADER(**47B**, level = ctrl + 1 — TABLE 과 같은 level): INT16 nParas @0, UINT16 (0) @2,
  UINT32 속성 @4(0x10020), UINT16 col @8, UINT16 row @10, UINT16 colspan @12, UINT16 rowspan @14,
  HWPUNIT 폭 @16, HWPUNIT 높이 @20, INT16×4 여백 @24, UINT16 테두리/배경 id @32, HWPUNIT (용도 미확인 —
  대부분 폭 @16 과 같지만 이 파일의 칸 수십 개는 폭보다 큰 값으로, 표마다 일정한 차가 난다) @34, 그 뒤 9B 0. 칸의 문단은 그 LIST_HEADER 뒤 level + 1 의 PARA_HEADER 들(nParas 개). 첫 표 첫 행의
  칸: (col 0, cs1, rs2) (1, 1, 2) (2, 2, 1) (4, 3, 2) (7, 1, 1).
- 칸 밖 LIST_HEADER 는 16B(level 1 — 메모 목록: MEMO_LIST(0x5D, 4B 메모 번호) 레코드 바로 뒤; 이 파일에는
  머리말·꼬리말·각주·미주 컨트롤이 없다)·30B(level 2 — 그리기 개체 글상자)도 있다. 표 칸만 47B.
- 중첩 표: 칸 문단 아래 level 3 의 'tbl ' CTRL_HEADER. 칸의 글을 모을 때 그 칸 문단 level 의 PARA_TEXT
  만 세면 중첩 표·그리기 개체 안의 글은 자식 레코드라 자연히 빠진다.
- HWPUNIT = 1/7200 inch(100 HWPUNIT = 1 pt). 칸 폭 예 12626 ≈ 1.75 in, 높이 2526 ≈ 25 pt.
- 칸의 문단 레코드를 바꿔 쓸 때 지킬 것: LIST_HEADER 의 nParas 를 새 문단 수로, 마지막 문단
  PARA_HEADER nChars 의 bit31 을 켠다(원래 켜져 있었다면 — 이 파일은 모든 칸에서 켜져 있다), 새
  PARA_HEADER 는 원본과 같은 크기(22/24)로, 빈 문단은 PARA_TEXT 없이 nChars 1, PARA_CHAR_SHAPE 는
  (0, 글자 모양 id) 하나, PARA_LINE_SEG 는 36B 하나. 섹션 스트림을 다시 압축하면 길이가 달라지므로 CFB
  섹터 배치를 다시 해야 하고, DocInfo·PrvText·BinData 등 다른 스트림은 손대지 않아도 된다.

## 컨트롤 id

- 4 글자를 바이트 역순으로 저장한다('tbl ' → ' lbt', 'secd' → 'dces').
- 이 파일 Section2 의 ctrl id(level): cold(단 정의)@1 1, secd(구역 정의)@1 1, pghd(쪽 감추기)@1 1,
  nwno(새 번호)@1 1, '%bmk'(책갈피 필드)@1 10, 'gso '(그리기 개체)@1 8, 'tbl '@1 89, 'tbl '@3 9,
  atno(자동 번호)@3 1, cold@3 15, 'gso '@3 1. Section0·1 에는 그 밖에 pgnp(쪽 번호)@1 2(Section0),
  pghd@3·nwno@3·'%bmk'@3·'%unk'@3·'tcps'@3 이 있다. 각 섹션의 첫 문단에는 secd + cold 가 있고, Section0 의
  첫 문단에만 pgnp 둘이 더 있다.
- 구역·단·머리말·꼬리말·각주·미주·쪽 번호·쪽 감추기·새 번호(secd·cold·head·foot·'fn  '·'en  '·
  pgnp·pghd·nwno)는 문단에 묶인 문서 설정이라 그 문단을 통째로 바꾸면 설정이 사라진다(hwpx 의
  secPr·colPr·header·footer·footNote·endNote·pageNum·pageHiding·newNum 과 대응). atno(자동 번호)·
  bokm(책갈피)·'%…'(필드)·'gso '(그리기 개체)는 문단 안 개체라 글만 바꾸면 그 개체가 사라진다.
