// 기준 문서 형식별 변환 — Word(docx)·한글(hwpx·hwp)·텍스트·Markdown 을 Markdown·문장 ID·구조 계층으로 (FR-WB-085, DR-WB-006, ERR-WB-008)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { markdownDrafts, officeDocument, textDrafts } from '../lib/guide_formats.js';
import { writeZip } from '../lib/zip.js';
import { formatLabel } from '../public/shared/model.js';
import { cellXml, docxOf, docxTable, emptyZip, hwpxRows, secOf, tablePara } from './fixtures/form_docs.js';
import { hwpOf, hwpRows, tablePara as hwpTablePara } from './fixtures/hwp_docs.js';

async function freshStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sourceanchor-guide-formats-test-'));
  process.env.WORKSPACE = dir;
  return import(`../lib/store.js?workspace=${encodeURIComponent(dir)}`);
}
const b64 = data => Buffer.from(data).toString('base64');
const wp = (text, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const shape = drafts => drafts.map(d => [d.kind, d.level ?? null, d.text ?? d.items ?? d.table]);
const nodes = guide => guide.blocks.filter(b => b.depth).map(b => [b.sentences.map(s => s.text).join(' '), b.depth]);

// Word: 스타일 ID 「1」(이름 heading 1)·「Heading2」, 바탕 스타일에서 물려받는 개요 수준, 번호 문단, 병합 칸 표, 칸 하나짜리 표
const STYLES = `<w:styles>
<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:basedOn w:val="a"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
<w:style w:type="paragraph" w:styleId="Sub"><w:name w:val="Custom Sub"/><w:basedOn w:val="Outlined"/></w:style>
<w:style w:type="paragraph" w:styleId="Outlined"><w:name w:val="Outlined"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>
<w:style w:type="paragraph" w:default="1" w:styleId="a"/>
</w:styles>`;
const docxGuide = () => writeZip(docxOf([
  wp('제1장 총칙', '<w:pStyle w:val="1"/>'),
  wp('가. 목적', '<w:pStyle w:val="Heading2"/>'),
  wp('이 규정은 기준을 정한다. 둘째 문장이다.'),
  wp('첫 항목', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr>'),
  wp('둘째 항목', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr>'),
  wp('세부 절', '<w:pStyle w:val="Sub"/>'),
  wp(''),
  docxTable,
  '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>※ 참고 상자 글이다.</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
].join('')), { 'word/styles.xml': STYLES });

test('Word: 제목 스타일(이름·바탕 스타일의 개요 수준)은 그 수준의 제목, 번호 문단은 목록, 병합 칸은 펼치고 칸 하나짜리 표는 문단으로 옮긴다', () => {
  const { type, title, drafts, snapshot } = officeDocument(docxGuide(), 'docx', '규정.docx');
  assert.deepEqual([type, title, snapshot.ext], ['docx', '규정.docx', 'docx']);
  assert.deepEqual(shape(drafts), [
    ['heading', 1, '제1장 총칙'],
    ['heading', 2, '가. 목적'],
    ['paragraph', null, '이 규정은 기준을 정한다. 둘째 문장이다.'],
    ['list', null, ['첫 항목', '둘째 항목']],
    ['heading', 3, '세부 절'],
    ['table', null, { title: '', unit: '', columns: ['제목', '제목', '제목'], rows: [['A', '과제명', '값1 / 둘째'], ['A', '장소', 'x & y z'], ['', '', '']] }],
    ['paragraph', null, '※ 참고 상자 글이다.'],
  ]);
  assert.deepEqual(drafts.map(d => d.loc.para), [1, 2, 3, 4, 5, 6, 7]);
});

// 한글(hwpx): header.xml 의 문단 모양 머리(개요·번호)와 스타일 이름으로 가른다
const HEADER = `<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"><hh:refList>
<hh:paraProperties itemCnt="4">
<hh:paraPr id="0"><hh:align horizontal="JUSTIFY"/><hh:heading type="NONE" idRef="0" level="0"/></hh:paraPr>
<hh:paraPr id="1"><hh:heading type="OUTLINE" idRef="0" level="0"/></hh:paraPr>
<hh:paraPr id="2"><hh:heading type="OUTLINE" idRef="0" level="1"/></hh:paraPr>
<hh:paraPr id="3"><hh:heading type="NUMBER" idRef="1" level="0"/></hh:paraPr>
</hh:paraProperties>
<hh:styles itemCnt="2"><hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0"/><hh:style id="5" type="PARA" name="제목" engName="Title" paraPrIDRef="0"/></hh:styles>
</hh:refList></hh:head>`;
const hp = (text, paraPr = 0, style = 0) => `<hp:p paraPrIDRef="${paraPr}" styleIDRef="${style}"><hp:run charPrIDRef="0"><hp:t>${text}</hp:t></hp:run></hp:p>`;
const hwpxGuide = () => writeZip(emptyZip(), {
  mimetype: 'application/hwp+zip',
  'Contents/header.xml': HEADER,
  'Contents/section0.xml': secOf([hp('선박 규정', 0, 5), hp('총칙', 1), hp('목적', 2), hp('본문 문장이다.'), hp('번호 항목', 3), hp('둘째 번호', 3), tablePara(hwpxRows())].join('')),
  'Contents/section1.xml': secOf(hp('부록', 1)),
});

test('한글(hwpx): 개요 문단은 개요 수준의 제목, 제목 스타일은 1수준 제목, 번호 문단은 목록, 세로 병합 칸은 덮는 칸마다 되풀이한다 — 섹션 순서대로', () => {
  const { type, drafts } = officeDocument(hwpxGuide(), 'hwpx', '규정.hwpx');
  assert.equal(type, 'hwpx');
  assert.deepEqual(shape(drafts), [
    ['heading', 1, '선박 규정'],
    ['heading', 1, '총칙'],
    ['heading', 2, '목적'],
    ['paragraph', null, '본문 문장이다.'],
    ['list', null, ['번호 항목', '둘째 번호']],
    ['table', null, { title: '', unit: '', columns: ['제안자', '홍길동'], rows: [['기관', '한국선급 / 연구소'], ['기관', '']] }],
    ['heading', 1, '부록'],
  ]);
});

test('한글(hwp): 문단 모양의 개요·번호 머리로 제목·목록을 가르고 표를 옮긴다. 암호 문서·hwp 가 아닌 파일은 사유와 함께 거절한다', () => {
  const data = hwpOf({ sections: [[{ text: '개요 문단', paraShape: 2 }, { text: '하위 개요', paraShape: 3 }, '본문 문장이다.', { text: '번호 항목', paraShape: 4 }, hwpTablePara(hwpRows())]] });
  assert.deepEqual(shape(officeDocument(data, 'hwp', 'a.hwp').drafts), [
    ['heading', 1, '개요 문단'],
    ['heading', 2, '하위 개요'],
    ['paragraph', null, '본문 문장이다.'],
    ['list', null, ['번호 항목']],
    ['table', null, { title: '', unit: '', columns: ['제안자', '홍길동'], rows: [['기관', '한국선급 / 연구소'], ['기관', '']] }],
  ]);
  assert.throws(() => officeDocument(hwpOf({ encrypted: true, sections: [['글']] }), 'hwp', 'a.hwp'), /암호가 걸린 한글 문서/);
  assert.throws(() => officeDocument(Buffer.from('not hwp'), 'hwp', 'a.hwp'), /한글 문서\(hwp\)가 아닙니다/);
});

test('Markdown: 번호 목록의 번호는 글자로 남기고 굵게·기울임·인용 표시는 빼며(짝 없는 * 는 둔다), 번호로 시작하는 항목은 등록할 때 구조 마디가 된다', async () => {
  const md = '> RULES FOR **STEEL** SHIPS\n\n#### 101. General\n\n- **1.** **Application 【See Guidance】**\n  - **(1)** applicable to *a.c.* and *d.c.* installations.\n    - **(A)** Cooking\n- 번호 없는 항목\n1. 번호 목록 항목\n\n값은 2 * 3 이고 각주*는 그대로다.';
  assert.deepEqual(shape(markdownDrafts(md)), [
    ['paragraph', null, 'RULES FOR STEEL SHIPS'],
    ['heading', 3, '101. General'],
    ['list', null, ['1. Application 【See Guidance】', '(1) applicable to a.c. and d.c. installations.', '(A) Cooking', '번호 없는 항목', '1. 번호 목록 항목']],
    ['paragraph', null, '값은 2 * 3 이고 각주*는 그대로다.'],
  ]);
  const store = await freshStore();
  const { book } = await store.loadBookState();
  await store.addGuide({ bookId: book.id, kind: 'guideline', fileName: 'rules.md', data: b64(md) });
  const pasted = (await store.addGuide({ bookId: book.id, kind: 'guideline', markdown: md })).guide;
  for (const id of ['G-001', pasted.id]) {
    const guide = await store.getGuide(book.id, id);
    assert.deepEqual(nodes(guide), [['101. General', 1], ['1. Application 【See Guidance】', 2], ['(1) applicable to a.c. and d.c. installations.', 3], ['(A) Cooking', 4], ['1. 번호 목록 항목', 2]]);
    assert.ok(guide.blocks.every(b => b.sentences.every(s => !s.text.includes('**'))));
    assert.equal(guide.blocks.find(b => b.kind === 'list').sentences.map(s => s.text).join(), '번호 없는 항목');
  }
  assert.match((await store.readGuideFile(book.id, 'G-001', 'markdown')).data.toString('utf8'), /^\[G-001\.b3\.s1\] 1\. Application 【See Guidance】$/m);
});

test('텍스트: Markdown 표시로 읽지 않고, 빈 줄과 구조 마디 번호로 시작하는 줄에서 문단을 나눈다(번호 없는 줄은 앞 문단에 잇는다)', () => {
  const drafts = textDrafts('제1조(목적) 이 규정은 기준을 정한다.\r\n제2조(정의) 이 규정에서 쓰는 말의 뜻은 다음과 같다.\n1. "선박"이란 배를 말한다.\n2. "선급"이란 등급을 말한다.\n이어지는 줄은 앞 문단에 붙는다.\n\n# 표시가 아니다\n- 목록이 아니다\n| 표가 | 아니다 |');
  assert.deepEqual(shape(drafts), [
    ['paragraph', null, '제1조(목적) 이 규정은 기준을 정한다.'],
    ['paragraph', null, '제2조(정의) 이 규정에서 쓰는 말의 뜻은 다음과 같다.'],
    ['paragraph', null, '1. "선박"이란 배를 말한다.'],
    ['paragraph', null, '2. "선급"이란 등급을 말한다. 이어지는 줄은 앞 문단에 붙는다.'],
    ['paragraph', null, '# 표시가 아니다 - 목록이 아니다 | 표가 | 아니다 |'],
  ]);
});

test('등록: Word·한글·텍스트·Markdown 파일이 형식 표시·원본과 함께 등록되어 문장 ID·구조 계층을 갖고, 지원하지 않는 형식·손상된 파일은 사유와 함께 남기지 않는다', async () => {
  const store = await freshStore();
  const { book } = await store.loadBookState();
  const add = (fileName, data) => store.addGuide({ bookId: book.id, kind: 'guideline', fileName, data: b64(data) });
  const docx = (await add('규정.docx', docxGuide())).guide;
  const hwpx = (await add('규정.hwpx', hwpxGuide())).guide;
  const hwp = (await add('규정.hwp', hwpOf({ sections: [[{ text: '개요 문단', paraShape: 2 }, '본문 문장이다.']] }))).guide;
  const txt = (await add('규정.txt', '제1조(목적) 이 규정은 기준을 정한다.\n제2조(정의) 뜻은 다음과 같다.\n1. "선박"이란 배를 말한다.')).guide;
  const md = (await add('규정.md', '# PART 6\n\n## CHAPTER 1\n\n1.1 General 이 장은 적용한다.')).guide;
  assert.deepEqual([docx, hwpx, hwp, txt, md].map(g => [g.id, g.type, g.snapshot, formatLabel(g)]), [
    ['G-001', 'docx', 'originals/G-001.docx', 'Word'],
    ['G-002', 'hwpx', 'originals/G-002.hwpx', '한글'],
    ['G-003', 'hwp', 'originals/G-003.hwp', '한글'],
    ['G-004', 'text', 'originals/G-004.txt', '텍스트'],
    ['G-005', 'text', 'originals/G-005.md', 'Markdown'],
  ]);
  // 구조 계층 — Word 제목 수준·텍스트의 조와 그 아래 번호·Markdown 의 Part → Chapter → 1.1
  assert.deepEqual(nodes(await store.getGuide(book.id, 'G-001')), [['제1장 총칙', 1], ['가. 목적', 2], ['세부 절', 3]]);
  assert.deepEqual(nodes(await store.getGuide(book.id, 'G-002')), [['선박 규정', 1], ['총칙', 1], ['목적', 2], ['부록', 1]]);
  assert.deepEqual(nodes(await store.getGuide(book.id, 'G-004')), [['제1조(목적) 이 규정은 기준을 정한다.', 1], ['제2조(정의) 뜻은 다음과 같다.', 1], ['1. "선박"이란 배를 말한다.', 2]]);
  assert.deepEqual(nodes(await store.getGuide(book.id, 'G-005')), [['PART 6', 1], ['CHAPTER 1', 2], ['1.1 General 이 장은 적용한다.', 3]]);
  // Markdown 파일 — 문장마다 [ID], 머리말 다음 구조 목록, 표 블록 ID
  const file = (await store.readGuideFile(book.id, 'G-001', 'markdown')).data.toString('utf8');
  assert.match(file, /<!-- outline -->\n- \[G-001\.b1\] 제1장 총칙 · 문단 1\n {2}- \[G-001\.b2\] 가\. 목적/);
  assert.match(file, /\[G-001\.b3\.s2\] 둘째 문장이다\./);
  assert.match(file, /<!-- table G-001\.b6 -->\n\| 제목 \| 제목 \| 제목 \|/);
  assert.match((await store.readGuideFile(book.id, 'G-004', 'markdown')).data.toString('utf8'), /^\[G-004\.b3\.s1\] 1\. "선박"이란 배를 말한다\.$/m);
  // 내려받는 원본은 올린 파일 이름으로
  const original = await store.readGuideFile(book.id, 'G-001', 'original');
  assert.deepEqual([original.name, original.downloadName], ['G-001.docx', '규정.docx']);

  await assert.rejects(add('표.xlsx', 'PK'), /지원하지 않는 형식\(XLSX\)/);
  await assert.rejects(add('깨진.docx', 'not a zip'), err => err.status === 400 && /ZIP|Word/.test(err.message));
  await assert.rejects(add('가짜.hwpx', docxGuide()), err => err.status === 400 && /한글 문서\(hwpx\)가 아닙니다/.test(err.message));
  await assert.rejects(add('잠김.hwp', hwpOf({ encrypted: true, sections: [['글']] })), err => err.status === 400 && /암호가 걸린/.test(err.message));
  const dir = path.join(process.env.WORKSPACE, 'projects', book.id, 'guides');
  assert.deepEqual((await fs.readdir(path.join(dir, 'originals'))).sort(), ['G-001.docx', 'G-002.hwpx', 'G-003.hwp', 'G-004.txt', 'G-005.md']);
  assert.deepEqual((await store.loadBookState(book.id)).guides.map(g => g.id), ['G-001', 'G-002', 'G-003', 'G-004', 'G-005']);
});
