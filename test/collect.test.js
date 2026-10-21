// 문서별 원문 보관(DR-WB-002) · 예전 작업공간 옮기기 · HTML 변환 · 자료 내려받기(FR-WB-043, NFR-WB-002)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { collectSource, isPrivateAddress } from '../lib/collect.js';
import { htmlToMarkdown } from '../lib/html.js';
import { markdownToDrafts } from '../lib/ingest.js';
import { pptxToMarkdown } from '../lib/pptx.js';
import { buildSampleReport } from './fixtures/sample_report.js';
import { readZip } from '../lib/zip.js';

// store 는 WORKSPACE 를 불러올 때 읽으므로, 임시 폴더를 정한 뒤에 가져온다
async function freshStore(prepare) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sourceanchor-test-'));
  await prepare?.(dir);
  process.env.WORKSPACE = dir;
  const store = await import(`../lib/store.js?workspace=${encodeURIComponent(dir)}`);
  return { store, dir };
}

// 붙박이 자료를 문서 R-001 로 깔아 둔다 — 시스템은 예시 자료를 만들지 않으므로(FR-WB-064) 테스트가 직접 넣는다
async function installSampleProject(root) {
  const { sources, doc, evidence } = buildSampleReport();
  const project = path.join(root, 'projects', doc.id);
  await fs.mkdir(path.join(project, 'sources'), { recursive: true });
  for (const source of sources) await fs.writeFile(path.join(project, 'sources', `${source.id}.json`), JSON.stringify(source));
  await fs.writeFile(path.join(project, 'report.json'), JSON.stringify({ doc, evidence, updatedAt: '2026-09-20T00:00:00.000Z' }));
}

const PAGE = `<!doctype html><html><head><title>자율운항선박 안내 &amp; 기준</title>
<meta property="og:site_name" content="가상 해사청"><meta property="article:published_time" content="2025-03-14T09:00:00+09:00">
<style>p { color: red }</style><script>document.write('<p>스크립트가 쓴 글</p>')</script></head>
<body><header><nav><a href="/">홈</a><a href="/menu">메뉴</a></nav></header>
<main><h1>자율운항선박 안내</h1>
<p>자율운항선박은 자율화 등급을 1단계부터 4단계까지 나눈다.<br>2025년 시험운항 승인은 12건이었다.
<p style="display:none">숨긴 문단</p>
<p>1. “자율운항선박”이란 사람의 개입 없이 운항할 수 있는 선박을 말한다.</p>
<ul><li>원격 제어<li>완전 자율 <ul><li>선원 미승선</li></ul></ul>
<table><caption>표 1. 시험운항 승인 (단위: 건)</caption>
<thead><tr><th rowspan="2">구분</th><th colspan="2">2024년</th></tr><tr><th>상반기</th><th>하반기</th></tr></thead>
<tbody><tr><th>승인</th><td>3</td><td>5</td></tr><tr><th>반려 | 보류</th><td>1</td><td>0</td></tr></tbody></table>
<table><tr><td><table><tr><td>배치용 표 안의 글</td></tr></table></td></tr></table>
</main><footer>저작권 안내</footer></body></html>`;

test('HTML 변환: 본문만 남기고 제목·문단·목록·표 구조를 옮기며 글자는 바꾸지 않는다', () => {
  const page = htmlToMarkdown(PAGE);
  assert.deepEqual([page.title, page.siteName, page.publishedAt], ['자율운항선박 안내 & 기준', '가상 해사청', '2025-03-14']);
  for (const gone of ['홈', '저작권 안내', '스크립트가 쓴 글', '숨긴 문단', 'color']) assert.ok(!page.markdown.includes(gone), gone);

  const drafts = markdownToDrafts(page.markdown);
  assert.deepEqual(drafts.map(d => d.kind), ['heading', 'paragraph', 'paragraph', 'list', 'table', 'paragraph']);
  assert.equal(drafts[1].text, '자율운항선박은 자율화 등급을 1단계부터 4단계까지 나눈다. 2025년 시험운항 승인은 12건이었다.');
  assert.equal(drafts[2].text, '1. “자율운항선박”이란 사람의 개입 없이 운항할 수 있는 선박을 말한다.'); // 호 번호는 본문 글자다 — 목록으로 읽어 떼어 내지 않는다
  assert.deepEqual(drafts[3].items, ['원격 제어', '완전 자율', '선원 미승선']);
  // 병합된 제목 줄은 열마다 이어 붙여, 값이 어느 기간의 것인지 잃지 않는다
  assert.deepEqual([drafts[4].table.title, drafts[4].table.unit], ['표 1. 시험운항 승인', '건']);
  assert.deepEqual(drafts[4].table.columns, ['구분', '2024년 상반기', '2024년 하반기']);
  assert.deepEqual(drafts[4].table.rows, [['승인', '3', '5'], ['반려 ｜ 보류', '1', '0']]);
  assert.equal(drafts[5].text, '배치용 표 안의 글');
});

test('내부 주소 판별: 이 컴퓨터·사설망·링크 로컬은 막고 공개 주소는 둔다', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.0.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1']) assert.equal(isPrivateAddress(address), true, address);
  for (const address of ['8.8.8.8', '172.32.0.1', '203.0.113.5', '2001:4860:4860::8888']) assert.equal(isPrivateAddress(address), false, address);
});

test('자료 내려받기: 내려받은 본문을 그대로 원문 값으로 만들고, 내부 주소·오류 응답·빈 본문은 사유와 함께 거부한다', async t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/moved') return res.writeHead(302, { Location: '/page' }).end();
    if (req.url === '/page') return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
    if (req.url === '/empty') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><body><div id="app"></div></body></html>');
    res.writeHead(404).end('not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const fields = await collectSource({ url: `${base}/moved`, reason: '원발행처 안내문' }, { allowPrivate: true });
  assert.equal(fields.url, `${base}/page`); // 리디렉션 끝의 주소를 원문 URL 로 남긴다
  assert.deepEqual([fields.type, fields.title, fields.publisher, fields.publishedAt, fields.adoptReason], ['web', '자율운항선박 안내 & 기준', '가상 해사청', '2025-03-14', '원발행처 안내문']);
  assert.ok(fields.markdown.includes('2025년 시험운항 승인은 12건이었다.'));
  assert.equal(fields.snapshot.data.toString('utf8'), PAGE); // 내려받은 원본을 함께 보관한다

  await assert.rejects(collectSource({ url: `${base}/page` }), /내부망 주소/); // 기본은 내부 주소 거부
  await assert.rejects(collectSource({ url: 'http://localhost:1/x' }), /내부망 주소/);
  await assert.rejects(collectSource({ url: 'file:///etc/passwd' }), /http·https/);
  await assert.rejects(collectSource({ url: `${base}/missing` }, { allowPrivate: true }), /404/);
  await assert.rejects(collectSource({ url: `${base}/empty` }, { allowPrivate: true }), /본문을 얻지 못했습니다/);
});

// ───────────────────────────── PPT · PDF 파일 ─────────────────────────────

// 시험용 ZIP 작성기 — 항목을 번갈아 deflate 와 저장 방식으로 넣는다
function zipOf(files) {
  const locals = [];
  const directory = [];
  let offset = 0;
  Object.entries(files).forEach(([name, content], i) => {
    const raw = Buffer.from(content);
    const method = i % 2 ? 0 : 8;
    const body = method ? zlib.deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(zlib.crc32?.(raw) ?? 0, 14); // 읽는 쪽은 CRC 를 확인하지 않는다
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    local.copy(entry, 8, 6, 30); // 플래그 … 확장 길이: 두 머리말에서 같은 순서다
    entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    directory.push(entry, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  });
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(Buffer.concat(directory).length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...directory, end]);
}

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const para = text => `<a:p><a:pPr lvl="0"/><a:r><a:rPr lang="ko-KR"/><a:t>${text}</a:t></a:r></a:p>`;
const shape = (paragraphs, placeholder = '') => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="도형"/><p:cNvSpPr/><p:nvPr>${placeholder && `<p:ph type="${placeholder}"/>`}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paragraphs.join('')}</p:txBody></p:sp>`;
const cell = (text, attrs = '') => `<a:tc${attrs}><a:txBody><a:bodyPr/>${para(text)}</a:txBody><a:tcPr/></a:tc>`;
const slide = shapes => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${shapes.join('')}</p:spTree></p:cSld></p:sld>`;

const TABLE = `<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tblGrid><a:gridCol w="1"/><a:gridCol w="1"/><a:gridCol w="1"/></a:tblGrid>
<a:tr h="1">${cell('구분', ' rowSpan="2"')}${cell('2024년', ' gridSpan="2"')}${cell('', ' hMerge="1"')}</a:tr>
<a:tr h="1">${cell('', ' vMerge="1"')}${cell('상반기')}${cell('하반기')}</a:tr>
<a:tr h="1">${cell('승인')}${cell('3')}${cell('5')}</a:tr>
<a:tr h="1">${cell('반려 | 보류')}${cell('1')}${cell('0')}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;

// 발표 순서는 slide2 → slide3(글 없음) → slide1. 제목 도형은 일부러 뒤에 둔다.
const DECK = zipOf({
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  'docProps/core.xml': '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>PowerPoint 프레젠테이션</dc:title></cp:coreProperties>',
  'ppt/presentation.xml': `<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId4"/><p:sldId id="258" r:id="rId2"/></p:sldIdLst></p:presentation>`,
  'ppt/_rels/presentation.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="slide" Target="slides/slide2.xml"/><Relationship Id="rId4" Type="slide" Target="/ppt/slides/slide3.xml"/></Relationships>',
  'ppt/slides/slide1.xml': slide([
    shape([para('원격 제어 단계의 시험운항 승인이 늘었다'), para('완전 자율 단계는 아직 심사 중이다')], 'body'),
    shape([para('표 1. 시험운항 승인 (단위: 건)')]),
    TABLE,
    shape([para('시험운항 승인 현황')], 'title'),
    shape(['<a:p><a:fld type="slidenum"><a:t>3</a:t></a:fld></a:p>'], 'sldNum'),
  ]),
  'ppt/slides/slide2.xml': slide([
    shape([para('자율운항선박은 자율화 등급을 1단계부터 4단계까지 나눈다. 2025년 시험운항 승인은 12건이었다.'), para('1. “자율운항선박”이란 사람의 개입 없이 운항할 수 있는 선박을 말한다.')]),
    `<p:grpSp><p:nvGrpSpPr/><p:grpSpPr/>${shape(['<a:p><a:r><a:t>묶은 도형 안의 글 &amp; 기호</a:t></a:r><a:br/><a:r><a:t>둘째 줄</a:t></a:r></a:p>'])}</p:grpSp>`,
    shape([para('자율운항선박 정책 동향')], 'ctrTitle'),
  ]),
  'ppt/slides/slide3.xml': slide(['<p:pic><p:nvPicPr/><p:blipFill/><p:spPr/></p:pic>']),
});

test('ZIP 읽기: deflate·저장 항목을 꺼내고, 손상된 파일은 사유와 함께 거부한다', () => {
  const zip = readZip(zipOf({ 'a.txt': '가나다'.repeat(100), 'dir/b.txt': 'plain' }));
  assert.deepEqual(zip.names, ['a.txt', 'dir/b.txt']);
  assert.equal(zip.read('a.txt').toString('utf8'), '가나다'.repeat(100));
  assert.equal(zip.read('dir/b.txt').toString('utf8'), 'plain');
  assert.equal(zip.read('none'), null);
  assert.throws(() => readZip(DECK.subarray(0, DECK.length - 40)), { format: true });
  assert.throws(() => readZip(Buffer.from('PK\u0003\u0004 not a zip at all')), { format: true });
});

test('PPT 변환: 발표 순서대로 슬라이드별 제목·목록·문단·표를 옮기고 쪽 번호는 뺀다', () => {
  const deck = pptxToMarkdown(DECK);
  assert.equal(deck.title, '자율운항선박 정책 동향'); // 문서 속성의 기본 제목이 아니라 첫 슬라이드 제목
  assert.equal(deck.slides.length, 3);
  assert.equal(deck.slides[1], ''); // 글이 없는 슬라이드도 번호를 차지한다

  const first = markdownToDrafts(deck.slides[0]);
  assert.deepEqual(first.map(d => d.kind), ['heading', 'paragraph', 'paragraph', 'paragraph']);
  assert.equal(first[1].text, '자율운항선박은 자율화 등급을 1단계부터 4단계까지 나눈다. 2025년 시험운항 승인은 12건이었다.');
  assert.equal(first[2].text, '1. “자율운항선박”이란 사람의 개입 없이 운항할 수 있는 선박을 말한다.'); // 번호는 본문 글자다
  assert.equal(first[3].text, '묶은 도형 안의 글 & 기호 둘째 줄');

  const last = markdownToDrafts(deck.slides[2]);
  assert.deepEqual(last.map(d => d.kind), ['heading', 'list', 'table']);
  assert.equal(last[0].text, '시험운항 승인 현황');
  assert.deepEqual(last[1].items, ['원격 제어 단계의 시험운항 승인이 늘었다', '완전 자율 단계는 아직 심사 중이다']);
  assert.deepEqual([last[2].table.title, last[2].table.unit], ['표 1. 시험운항 승인', '건']);
  assert.deepEqual(last[2].table.columns, ['구분', '2024년 상반기', '2024년 하반기']);
  assert.deepEqual(last[2].table.rows, [['승인', '3', '5'], ['반려 ｜ 보류', '1', '0']]);

  // 슬라이드 제목이 곧 표 제목이면 제목 블록은 남기고 표의 제목·단위로도 쓴다
  const titled = markdownToDrafts('# 표 2. 시험운항 승인 (단위: 건)\n\n| 구분 | 2024년 |\n| --- | --- |\n| 승인 | 8 |');
  assert.deepEqual(titled.map(d => d.kind), ['heading', 'table']);
  assert.deepEqual([titled[1].table.title, titled[1].table.unit], ['표 2. 시험운항 승인', '건']);
});

// 글이 든 두 쪽짜리 PDF 를 손으로 만든다
function pdfOf(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  pages.forEach((lines, i) => {
    const stream = `BT /F1 12 Tf 14 TL 72 720 Td ${lines.map(line => `(${line}) Tj T*`).join(' ')} ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(at => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('파일 자료 내려받기: PPT 는 슬라이드, PDF 는 페이지를 위치로 남기고 원본을 보관하며, 읽지 못하는 형식은 사유와 함께 거부한다', async t => {
  const pdf = pdfOf([
    ['Autonomous ship trials are approved by the maritime authority.', 'Approvals in 2024 totalled 8 cases across both half years.', 'Remote control trials made up most of the approvals.'],
    ['Approvals in 2025 totalled 12 cases, an increase of 4 cases.', 'Fully autonomous operation remains under review.'],
  ]);
  const files = { '/deck': DECK, '/report': pdf, '/old.ppt': Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(600)]), '/archive.zip': zipOf({ 'readme.txt': 'x'.repeat(400) }), '/cut.pptx': DECK.subarray(0, DECK.length - 40) };
  const server = http.createServer((req, res) => (files[req.url] ? res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(files[req.url]) : res.writeHead(404).end()));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const collect = name => collectSource({ url: `${base}${name}` }, { allowPrivate: true });

  const deck = await collect('/deck');
  assert.deepEqual([deck.type, deck.title, deck.snapshot.ext], ['pptx', '자율운항선박 정책 동향', 'pptx']);
  assert.ok(deck.snapshot.data.equals(DECK));
  assert.deepEqual(deck.drafts.map(d => d.loc.slide), [1, 1, 1, 1, 3, 3, 3]); // 위치는 발표 순서의 슬라이드 번호
  assert.equal(deck.drafts.at(-1).kind, 'table');

  await assert.rejects(collect('/old.ppt'), /예전 Office 형식/);
  await assert.rejects(collect('/archive.zip'), /PowerPoint 문서\(pptx\)가 아닙니다/);
  await assert.rejects(collect('/cut.pptx'), /ZIP/);

  const report = await collect('/report').catch(err => err);
  if (report instanceof Error && /pdftotext 를 찾지 못했습니다/.test(report.message)) return t.diagnostic('pdftotext 가 없어 PDF 변환은 확인하지 않았다');
  assert.ok(!(report instanceof Error), report.message);
  assert.deepEqual([report.type, report.snapshot.ext], ['pdf', 'pdf']);
  assert.deepEqual([...new Set(report.drafts.map(d => d.loc.page))], [1, 2]);
  assert.ok(report.drafts.some(d => d.loc.page === 2 && d.text.includes('Approvals in 2025 totalled 12 cases')));
});

test('빈 작업공간은 장이 없는 빈 보고서 하나로 시작한다 — 예시 자료를 만들지 않는다 (AC-WB-011, AC-WB-017)', async () => {
  const { store } = await freshStore();
  const opened = await store.loadBookState();
  assert.deepEqual([opened.chapters, opened.sources], [[], []]);
  assert.equal(opened.books.length, 1);
  assert.equal((await store.lastPlace()).view, 'book');
  await assert.rejects(store.loadState(), { status: 409 }); // 장이 없으면 작성 화면을 열 수 없다
  assert.equal(typeof store.resetToSeed, 'undefined'); // 한 번에 지우는 조작은 제공하지 않는다
});

test('장마다 원문을 따로 보관한다: 새 장은 원문 없이 시작하고, 장을 지우면 그 장의 원문만 지워진다', async () => {
  const { store, dir } = await freshStore(installSampleProject);
  const first = await store.loadState();
  assert.equal(first.sources.length, 3); // 깔아 둔 장의 원문
  const bookId = first.book.id;
  const chapterPath = (...parts) => path.join(dir, 'projects', bookId, 'chapters', ...parts);

  const created = await store.createReport({ bookId, title: '자율운항선박 지침' });
  assert.deepEqual(created.sources, []);
  const added = await store.addSource({ docId: created.doc.id, title: '안내', type: 'web', url: 'https://example.org/a', markdown: '# 안내\n\n본문 문장이다.', snapshot: { ext: 'html', data: Buffer.from('<p>본문 문장이다.</p>') } });
  assert.equal(added.id, 'S-001'); // 원문 번호는 장 안에서 매긴다
  assert.equal((await store.loadState(created.doc.id)).sources.length, 1);
  assert.equal((await store.loadState(first.doc.id)).sources.length, 3); // 다른 장의 원문 목록은 그대로
  assert.equal(await fs.readFile(chapterPath(created.doc.id, added.snapshot), 'utf8'), '<p>본문 문장이다.</p>');
  // 보고서 화면에서는 두 장의 원문을 어느 장의 것인지와 함께 모아 본다 (FR-WB-075)
  const overview = await store.loadBookState(bookId);
  assert.equal(overview.sources.length, 4);
  assert.deepEqual([...new Set(overview.sources.map(s => s.chapterId))].sort(), [first.doc.id, created.doc.id].sort());
  await assert.rejects(store.addSource({ docId: 'R-999', markdown: '본문' }), { status: 404 });

  // 인용한 자료는 지우지 못한다
  await assert.rejects(store.deleteSource(first.doc.id, Object.values(first.evidence)[0].sourceId), { status: 409 });

  await store.deleteReport(created.doc.id);
  await assert.rejects(fs.access(chapterPath(created.doc.id)));
  assert.equal((await store.loadState(first.doc.id)).sources.length, 3);
  assert.deepEqual((await store.loadBookState(bookId)).chapters.map(c => c.id), [first.doc.id]); // 목차에서도 빠진다
});

test('원문마다 내려받은 원본과 Markdown 파일을 한 쌍으로 보관한다 (DR-PL-002)', async () => {
  const { store, dir } = await freshStore(installSampleProject);
  const first = await store.loadState();
  const chDir = id => path.join(dir, 'projects', first.book.id, 'chapters', id);
  const sourcesDir = id => path.join(chDir(id), 'sources');
  // Markdown 파일 없이 수집되어 있던 원문에도 만들어 둔다
  for (const source of first.sources) assert.ok((await fs.readFile(path.join(sourcesDir(first.doc.id), `${source.id}.md`), 'utf8')).includes(`id: "${source.id}"`));

  const { doc } = await store.createReport({ title: '보관 확인' });
  const drafts = [
    { kind: 'heading', level: 1, loc: { page: 1 }, text: '시험운항 승인 현황' },
    { kind: 'paragraph', loc: { page: 1 }, text: '1. 2025년 시험운항 승인은 12건이었다. 전년보다 4건 늘었다.' },
    { kind: 'table', loc: { page: 2 }, table: { title: '표 1. 시험운항 승인', unit: '건', columns: ['구분', '2024년', '2025년'], rows: [['승인', '8', '12'], ['반려 | 보류', '1', '0']] } },
  ];
  const added = await store.addSource({ docId: doc.id, title: '승인 현황 "연보"', type: 'pdf', publisher: '가상 해사청', url: 'https://example.org/report.pdf', drafts, snapshot: { ext: 'pdf', data: Buffer.from('%PDF-1.4 원본') } });
  const markdown = await fs.readFile(path.join(sourcesDir(doc.id), `${added.id}.md`), 'utf8');
  assert.ok(markdown.startsWith('---\nid: "S-001"\n'));
  for (const line of ['title: "승인 현황 \\"연보\\""', 'url: "https://example.org/report.pdf"', 'published: "미상"', 'original: "S-001.pdf"', '<!-- p.1 -->', '# 시험운항 승인 현황', '<!-- p.2 -->', '표 1. 시험운항 승인 (단위: 건)', '| 구분 | 2024년 | 2025년 |', '| 반려 ｜ 보류 | 1 | 0 |']) assert.ok(markdown.includes(line), line);
  // 문장과 수치는 원문 그대로다 — "1. …" 로 시작하는 본문도 목록으로 읽히지 않는다
  const body = markdownToDrafts(markdown.slice(markdown.indexOf('---', 3) + 3)).filter(d => !/^<!--/.test(d.text || ''));
  assert.deepEqual(body.map(d => d.kind), ['heading', 'paragraph', 'table']);
  assert.equal(body[1].text, drafts[1].text);
  assert.deepEqual(body[2].table.rows, [['승인', '8', '12'], ['반려 ｜ 보류', '1', '0']]);

  // 화면에서 여는 파일: 원본과 Markdown. 붙여 넣은 원문에는 원본이 없다
  assert.deepEqual([(await store.readSourceFile(doc.id, added.id, 'original')).name, (await store.readSourceFile(doc.id, added.id, 'markdown')).name], ['S-001.pdf', 'S-001.md']);
  const pasted = await store.addSource({ docId: doc.id, title: '붙여 넣은 글', markdown: '본문 문장이다.' });
  assert.ok((await store.readSourceFile(doc.id, pasted.id, 'markdown')).data.toString('utf8').includes('본문 문장이다.'));
  await assert.rejects(store.readSourceFile(doc.id, pasted.id, 'original'), { status: 404 });

  // 원문을 지우면 두 파일이 함께 없어진다
  await store.deleteSource(doc.id, added.id);
  await assert.rejects(fs.access(path.join(sourcesDir(doc.id), `${added.id}.md`)));
  await assert.rejects(fs.access(path.join(chDir(doc.id), 'snapshots', `${added.id}.pdf`)));
});

test('채택 거부: 이유와 함께 거부 목록으로 옮기고, 이유를 고치고, 되돌리고, 목록에서 지운다 (FR-WB-045~047, ERR-WB-004)', async () => {
  const { store, dir } = await freshStore(installSampleProject);
  const first = await store.loadState();
  const { doc } = await store.createReport({ title: '거부 확인' });
  const add = n => store.addSource({ docId: doc.id, title: `자료 ${n}`, type: 'web', url: `https://example.org/${n}`, markdown: `자료 ${n} 의 본문 문장이다.`, snapshot: { ext: 'html', data: Buffer.from(`<p>${n}</p>`) } });
  const [a, b] = [await add(1), await add(2)];

  await assert.rejects(store.rejectSource({ docId: doc.id, id: a.id, reason: '  ' }), { status: 400 }); // 이유 없이는 거부하지 않는다
  await assert.rejects(store.rejectSource({ docId: doc.id, id: 'S-999', reason: '없음' }), { status: 404 });
  await assert.rejects(store.rejectSource({ docId: first.doc.id, id: Object.values(first.evidence)[0].sourceId, reason: '인용 중' }), { status: 409 }); // 인용한 자료
  assert.deepEqual((await store.loadState(first.doc.id)).rejected, []);

  const { rejected } = await store.rejectSource({ docId: doc.id, id: a.id, reason: '2차 자료' });
  assert.deepEqual(rejected.map(s => [s.id, s.url, s.rejected.reason, 'blocks' in s]), [['S-001', 'https://example.org/1', '2차 자료', false]]);
  let state = await store.loadState(doc.id);
  assert.deepEqual([state.sources.map(s => s.id), state.rejected.map(s => s.id), state.docs.find(d => d.id === doc.id).sources], [['S-002'], ['S-001'], 1]);
  assert.deepEqual((await store.loadState(first.doc.id)).rejected, []); // 다른 문서의 거부 목록은 그대로
  for (const file of ['sources/S-001.md', 'snapshots/S-001.html']) await fs.access(path.join(dir, 'projects', first.book.id, 'chapters', doc.id, file)); // 되돌릴 수 있게 파일은 둔다
  assert.deepEqual([(await store.readSourceFile(doc.id, a.id, 'original')).name, (await store.readSourceFile(doc.id, a.id, 'markdown')).name], ['S-001.html', 'S-001.md']); // 거부 목록에서도 보관 파일을 연다

  // 이유를 고쳐도 거부 시각은 그대로다. 거부한 자료의 번호는 새 원문에 다시 쓰지 않는다
  const edited = await store.rejectSource({ docId: doc.id, id: a.id, reason: '원발행처 자료로 바꾼다' });
  assert.deepEqual([edited.rejected[0].rejected.reason, edited.rejected[0].rejected.at], ['원발행처 자료로 바꾼다', rejected[0].rejected.at]);
  assert.equal((await add(3)).id, 'S-003');

  // 다시 열어도 거부 목록이 남아 있다
  const reopened = await import(`../lib/store.js?reopen=${encodeURIComponent(dir)}`);
  assert.deepEqual((await reopened.loadState(doc.id)).rejected.map(s => [s.id, s.rejected.reason]), [['S-001', '원발행처 자료로 바꾼다']]);

  const restored = await store.restoreSource({ docId: doc.id, id: a.id });
  assert.deepEqual([restored.source.id, restored.source.blocks[0].sentences[0].id, restored.rejected], ['S-001', 'S-001.b1.s1', []]);
  assert.deepEqual((await store.loadState(doc.id)).sources.map(s => s.id), ['S-001', 'S-002', 'S-003']);

  await store.rejectSource({ docId: doc.id, id: b.id, reason: '주제와 맞지 않는다' });
  await store.deleteSource(doc.id, b.id); // 목록에서 지우면 보관한 파일도 없어진다
  state = await store.loadState(doc.id);
  assert.deepEqual([state.sources.map(s => s.id), state.rejected], [['S-001', 'S-003'], []]);
  for (const file of ['sources/S-002.json', 'sources/S-002.md', 'snapshots/S-002.html']) await assert.rejects(fs.access(path.join(dir, 'projects', first.book.id, 'chapters', doc.id, file)));
});

test('예전 작업공간(원문 공용)을 열면 원문은 인용한 문서로 가고, 인용하지 않은 문서는 원문 없이 시작한다', async () => {
  const { store, dir } = await freshStore(async root => {
    const legacy = path.join(root, 'projects', 'default');
    const { sources, doc, evidence } = buildSampleReport();
    await fs.mkdir(path.join(legacy, 'sources'), { recursive: true });
    await fs.mkdir(path.join(legacy, 'reports'), { recursive: true });
    for (const source of sources) await fs.writeFile(path.join(legacy, 'sources', `${source.id}.json`), JSON.stringify(source));
    await fs.writeFile(path.join(legacy, 'reports', 'R-001.json'), JSON.stringify({ doc, evidence, updatedAt: '2026-09-20T01:00:00.000Z' }));
    await fs.writeFile(path.join(legacy, 'reports', 'R-002.json'), JSON.stringify({ doc: { id: 'R-002', title: '새 주제', blocks: [] }, evidence: {}, updatedAt: '2026-09-20T02:00:00.000Z' }));
    await fs.writeFile(path.join(legacy, 'project.json'), JSON.stringify({ lastDocId: 'R-002' }));
  });
  const opened = await store.loadState();
  assert.equal(opened.doc.id, 'R-002'); // 마지막으로 연 문서
  assert.deepEqual(opened.sources, []);
  assert.equal((await store.loadState('R-001')).sources.length, 3);
  await assert.rejects(fs.access(path.join(dir, 'projects', 'default')));
});

test('목차의 수준(헤딩 단계): 저장·불러오기·상위 장 삭제 때 규칙 안으로 맞추고, 장 목록에 level 을 싣는다 (FR-WB-079)', async () => {
  const { store } = await freshStore(installSampleProject);
  const first = await store.loadState();
  const bookId = first.book.id;
  const b = (await store.createReport({ bookId, title: 'ㄴ' })).doc.id;
  const c = (await store.createReport({ bookId, title: 'ㄷ' })).doc.id;
  const d = (await store.createReport({ bookId, title: 'ㄹ' })).doc.id;
  const levels = state => state.chapters.map(ch => ch.level);
  assert.deepEqual(levels(await store.loadBookState(bookId)), [1, 1, 1, 1]); // 새 장은 수준 1
  // 첫 장은 1, 앞 장 + 1 을 넘지 않고, 최대 3 — 넘치는 값은 맞춘다(거절하지 않는다)
  const toc = (await store.loadBookState(bookId)).chapters.map(ch => ({ id: ch.id, title: ch.title, instructions: ch.instructions }));
  const saved = await store.saveToc({ bookId, chapters: [{ ...toc[0], level: 2 }, { ...toc[1], level: 3 }, { ...toc[2], level: 3 }, { ...toc[3], level: 9 }] });
  assert.deepEqual(levels(saved), [1, 2, 3, 3]);
  assert.deepEqual((await store.loadState(b)).docs.map(ch => ch.level), [1, 2, 3, 3]); // 작성 화면의 장 목록에도 실린다
  // level 을 보내지 않으면 저장된 수준을 유지한다(제목·지시문만 고칠 때)
  assert.deepEqual(levels(await store.saveToc({ bookId, chapters: toc.map(ch => ({ ...ch, title: ch.title + '!' })) })), [1, 2, 3, 3]);
  // 상위 장을 지우면 하위 장들이 규칙 안으로 올라온다: [ㄱ1, ㄴ2, ㄷ3, ㄹ3] 에서 ㄴ을 지우면 [ㄱ1, ㄷ2, ㄹ3]
  await store.deleteReport(b);
  assert.deepEqual(levels(await store.loadBookState(bookId)), [1, 2, 3]);
  assert.deepEqual((await store.loadBookState(bookId)).chapters.map(ch => ch.id), [first.doc.id, c, d]);
});
