// 양식 테스트 붙박이 자료 — docx·hwpx 를 XML 문자열로 만든다 (docx_form·hwpx_form·forms 테스트가 같이 쓴다)
import { writeZip } from '../../lib/zip.js';

export const emptyZip = () => { const b = Buffer.alloc(22); b.writeUInt32LE(0x06054b50, 0); return b; };

// ── docx

export const docxOf = bodyXml => writeZip(emptyZip(), { '[Content_Types].xml': '<Types/>', 'word/document.xml': `<w:document><w:body>${bodyXml}</w:body></w:document>` });

const grid = '<w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="3000"/><w:gridCol w:w="5000"/></w:tblGrid>';
export const docxTc = (inner, pr = '') => `<w:tc><w:tcPr>${pr}</w:tcPr>${inner}</w:tc>`;
export const docxP = text => `<w:p><w:pPr><w:jc w:val="center"/><w:rPr><w:sz w:val="20"/></w:rPr></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
// 4행 표(칸 9개): 행0 제목(gridSpan 3, 고정 높이), 행1 c0 세로 병합 시작, 행2 c0 이어짐, 행3 필드 있음·중첩 표(잠김)·문단 없는 칸
export const docxTable = `<w:tbl>${grid}
<w:tr><w:trPr><w:trHeight w:hRule="exact" w:val="620"/></w:trPr>${docxTc(docxP('제목'), '<w:gridSpan w:val="3"/>')}</w:tr>
<w:tr>${docxTc(docxP('A'), '<w:vMerge w:val="restart"/>')}${docxTc(docxP('과제명'))}${docxTc('<w:p><w:r><w:t>값1</w:t><w:br/><w:t>둘째</w:t></w:r></w:p><w:p/>')}</w:tr>
<w:tr>${docxTc('<w:p/>', '<w:vMerge/>')}${docxTc(docxP('장소'))}${docxTc('<w:p><w:r><w:t>x &amp; y</w:t></w:r><w:r><w:tab/><w:t>z</w:t></w:r></w:p>')}</w:tr>
<w:tr>${docxTc('<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r></w:p>')}${docxTc('<w:p/><w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>')}${docxTc('')}</w:tr>
</w:tbl>`;
export const docxHeading = '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>1. 제안 개요</w:t></w:r></w:p>';
export const docxSentence = '<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/></w:numPr></w:pPr><w:r><w:t>본문 문장이다.</w:t></w:r></w:p>';

// ── hwpx

export const hwpxOf = sections => writeZip(emptyZip(), {
  mimetype: 'application/hwp+zip',
  'version.xml': '<v/>',
  'Contents/header.xml': '<hh:head version="1.4"/>',
  ...Object.fromEntries(sections.map((xml, n) => [`Contents/section${n}.xml`, xml])),
});

// test_hwpxform.py cell_xml·multi_para_cell 이식 — paras: [[text, paraPrIDRef, charPrIDRef]] (id 200+k), 빈 글은 자기 닫힘 run
const LINESEG = pfx => `<${pfx}:linesegarray><${pfx}:lineseg textpos="0" vertpos="0" vertsize="1000"/></${pfx}:linesegarray>`;
const run = (pfx, ch, text) => (text ? `<${pfx}:run charPrIDRef="${ch}"><${pfx}:t>${text}</${pfx}:t></${pfx}:run>` : `<${pfx}:run charPrIDRef="${ch}"/>`);
export function cellXml({ r, c, text, colSpan = 1, rowSpan = 1, w = 8504, h = 282, pfx = 'hp', addrAfter = true, paras = null }) {
  const body = paras
    ? paras.map(([t, pr, ch], k) => `<${pfx}:p id="${200 + k}" paraPrIDRef="${pr}" styleIDRef="0">${run(pfx, ch, t)}${LINESEG(pfx)}</${pfx}:p>`).join('')
    : `<${pfx}:p id="${100 + 10 * r + c}" paraPrIDRef="7" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${run(pfx, 10 * r + c + 1, text)}${LINESEG(pfx)}</${pfx}:p>`;
  const sub = `<${pfx}:subList id="" textDirection="HORIZONTAL" vertAlign="CENTER">${body}</${pfx}:subList>`;
  const addr = `<${pfx}:cellAddr colAddr="${c}" rowAddr="${r}"/><${pfx}:cellSpan colSpan="${colSpan}" rowSpan="${rowSpan}"/><${pfx}:cellSz width="${w}" height="${h}"/>`;
  return `<${pfx}:tc name="" header="0" borderFillIDRef="3">${addrAfter ? sub + addr : addr + sub}</${pfx}:tc>`;
}
export const tablePara = (rows, pfx = 'hp') => `<${pfx}:p id="2" paraPrIDRef="0" styleIDRef="0"><${pfx}:run charPrIDRef="0"><${pfx}:tbl id="9" rowCnt="${rows.length}">${rows.map(row => `<${pfx}:tr>${row.join('')}</${pfx}:tr>`).join('')}</${pfx}:tbl></${pfx}:run></${pfx}:p>`;
export const secOf = (body, pfx = 'hp', secPfx = 'hs') => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><${secPfx}:sec xmlns:${secPfx}="http://www.hancom.co.kr/hwpml/2011/section" xmlns:${pfx}="http://www.hancom.co.kr/hwpml/2011/paragraph">${body}</${secPfx}:sec>`;
export const sectionXml = (rows, pfx = 'hp', secPfx = 'hs') => secOf(`<${pfx}:p id="1" paraPrIDRef="0" styleIDRef="0"><${pfx}:run charPrIDRef="0"><${pfx}:t>신상 조서</${pfx}:t></${pfx}:run></${pfx}:p>${tablePara(rows, pfx)}`, pfx, secPfx);
export const bodyPara = text => `<hp:p paraPrIDRef="3"><hp:run charPrIDRef="5"><hp:t>${text}</hp:t></hp:run></hp:p>`;

// 2열 표(칸 5개): 폭 3000/7000, 행0 높이 282, 행1 c0 rowSpan 2, 행1 c1 문단 둘(서식 다름), 행2 c1 빈 칸(자기 닫힘 run)
export const hwpxRows = (more = {}) => [
  [cellXml({ r: 0, c: 0, text: '제안자', w: 3000, ...more }), cellXml({ r: 0, c: 1, text: '홍길동', w: 7000, ...more })],
  [cellXml({ r: 1, c: 0, text: '기관', rowSpan: 2, w: 3000, h: 782, ...more }), cellXml({ r: 1, c: 1, w: 7000, h: 500, paras: [['한국선급', 7, 12], ['연구소', 8, 13]], ...more })],
  [cellXml({ r: 2, c: 1, text: '', w: 7000, ...more })],
];
