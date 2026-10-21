# 웹 자료 내려받기 — 사이트별 구조와 제약

서버가 URL 에서 자료를 직접 내려받을 때(브라우저 없이 HTTP GET) 알아 둘 외부 사이트의 동작. 2026-09-20 확인.

## 공통

- 국내 기관 페이지에는 EUC-KR 이 남아 있다. 글자 집합은 `Content-Type` 의 `charset` → 문서 앞부분의 `<meta charset>` 순으로 찾는다.
- 본문을 스크립트로 그리는 페이지(SPA)는 GET 응답에 본문이 없다. 껍데기 페이지가 `<iframe src>` 로 같은 사이트의 안쪽 문서를 품고 있으면 그 주소를 받으면 된다.
- 발행일은 `article:published_time`, `date`, `dc.date`, `citation_publication_date` meta 나 `<time datetime>` 에 있다. 기관 페이지에는 없는 경우가 많다.
- PDF 는 `pdftotext -enc UTF-8 <파일> -` 로 글을 꺼낸다. 페이지 사이는 폼 피드(`\f`)로 나뉜다. Windows 에는 Git for Windows 에 딸려 온다(`<Git>\mingw64\bin\pdftotext.exe` — Git Bash 밖에서는 PATH 에 없다). 표는 구조 없이 글로만 나온다. 그림으로 된 PDF 는 글이 나오지 않는다.
- `pdftotext` 는 이름만 같은 두 프로그램이 있다: Git for Windows 에 딸린 것은 **xpdf**(4.06), `winget install oschwartz10612.Poppler` 로 깔리는 것은 **poppler**(25.07). `pdftotext -v` 로 가린다. 한글 추출은 둘 다 된다.
  - 기본 모드에서 표는 둘 다 깨진다. xpdf 는 표를 열 방향으로 읽어 한 줄로 붙이고("2024년 상반기 3 1"), poppler 는 칸마다 따로 떨어진 줄로 낸다("5" / "반려" / "1" / "0"). 어느 쪽이든 값이 어느 행·열의 것인지 남지 않는다.
  - `-layout`: poppler 는 표의 한 행을 한 줄에 공백으로 벌려 낸다("승인   3   5"). xpdf 4.06 은 `-layout` 에서도 칸이 위아래 줄로 어긋난다. 다만 `-layout` 은 2단 본문을 좌우로 섞어 읽으므로 본문용으로는 기본 모드가 낫다.
  - `-bbox-layout`(poppler 에만 있다): 낱말마다 좌표(`<word xMin yMin xMax yMax>`)를 담은 XHTML 을 낸다. `<head>` 의 meta 에 PDF 속성(Author·Creator·CreationDate)도 들어 있다. `-f <쪽> -l <쪽>` 으로 쪽을 고른다.

## 국가법령정보센터 (law.go.kr)

- `https://www.law.go.kr/법령/<법령명>` 은 1KB 남짓한 껍데기다. `<iframe id="lawService" src="/LSW//lsInfoP.do?lsiSeq=…&efYd=…">` 하나만 들어 있다.
- `lsInfoP.do?lsiSeq=<일련번호>` 도 화면 틀뿐이고, 조문은 스크립트가 `lsInfoR.do` 에서 불러온다. 이 주소는 GET 으로 직접 받을 수 있다:
  `https://www.law.go.kr/LSW/lsInfoR.do?lsiSeq=<일련번호>&efYd=<시행일 YYYYMMDD>` — **`efYd` 가 없으면 454바이트짜리 빈 응답**이 온다. `efYd` 는 `lsInfoP.do` 주소의 쿼리에 있거나, 없으면 그 페이지의 스크립트에 `var efYd = '20250103';` 로 적혀 있다. `chrClsCd` 는 없어도 된다.
- 제정·개정이유(`lsInfoP.do?…&viewCls=lsRvsDocInfoR`)는 `https://www.law.go.kr/LSW/lsRvsDocInfoR.do?lsiSeq=<일련번호>` 에서 받는다(`efYd` 불필요).
- `lsInfoR.do` 응답은 `<html>` 없이 `<div>` 조각으로 시작하고 `<title>` 이 없다. 제목은 앞선 `lsInfoP.do` 의 `<title>`("법령 > 본문 > <법령명> | 국가법령정보센터")에서 얻는다.
- 조문의 호는 `1. …` 로 시작하는 문단이다. Markdown 목록으로 읽으면 번호를 잃는다.
- 같은 법령이라도 `lsiSeq` 가 연혁(개정 시점)마다 다르다. 검색 엔진에 잡힌 `lsiSeq` 는 옛 연혁일 수 있고, `법령/<법령명>` 주소가 현행을 가리킨다.
- 공식 Open API(`/DRF/lawService.do`)는 신청해 받은 `OC` 값이 있어야 한다.

## IMO (imo.org)

- `www.imo.org/en/MediaCentre/…aspx` 의 보도자료·FAQ 페이지는 GET 응답에 본문이 들어 있다.
- 결의·회람 문서는 `wwwcdn.imo.org/localresources/…pdf` 에 글이 들어 있는 PDF 로 있다.
