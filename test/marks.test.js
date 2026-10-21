// 참조·메모 표시 — 목록 만들기(lib/marks.js), 웹 스냅샷에 끼우기(lib/html_marks.js), PDF 주석 덧붙이기(lib/pdf_annot.js), 낱말 좌표로 자리 찾기(lib/pdf_marks.js)
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBlocks } from '../public/shared/model.js';
import { markHtml } from '../lib/html_marks.js';
import { sourceMarks } from '../lib/marks.js';
import { annotatePdf, pdfPages } from '../lib/pdf_annot.js';
import { locateText } from '../lib/pdf_marks.js';

// 원문 하나 — 문단 둘과 표 하나
function sampleSource() {
  const drafts = [
    { kind: 'paragraph', loc: { page: 1 }, text: 'Optical data transmission is highly efficient. It moves 9 GB on one battery cell.' },
    { kind: 'table', loc: { page: 2 }, table: { title: '표 1. 전송률', unit: 'Mbps', columns: ['구분', '2023', '2024'], rows: [['최대', '10', '12.5']] } },
    { kind: 'paragraph', loc: { page: 2 }, text: '둘째 문단이다.' },
  ];
  return { id: 'S-001', type: 'pdf', title: '샘플', snapshot: 'snapshots/S-001.pdf', blocks: buildBlocks('S-001', drafts), notes: [{ id: 'N-001', anchorId: 'S-001.b3.s1', text: '메모 하나', at: '2026-09-22T00:00:00.000Z' }] };
}

test('sourceMarks: 인용한 위치와 메모를 앵커마다 하나로 모아 원문 순서로 번호를 붙인다', () => {
  const source = sampleSource();
  const owner = {
    doc: { id: 'R-001', title: 't', blocks: [{ id: 'b1', kind: 'paragraph', sentences: [
      { id: 'T-0001', text: '전송률은 12.5Mbps 다.', evidence: ['E-0001'] },
      { id: 'T-0002', text: '광통신은 효율이 높다.', evidence: ['E-0002', 'E-0003'] },
    ] }] },
    evidence: {
      'E-0001': { id: 'E-0001', sourceId: 'S-001', anchorId: 'S-001.b2.r1c2' },
      'E-0002': { id: 'E-0002', sourceId: 'S-001', anchorId: 'S-001.b1.s1' },
      'E-0003': { id: 'E-0003', sourceId: 'S-999', anchorId: 'S-999.b1.s1' }, // 다른 원문 — 들어가지 않는다
    },
  };
  const marks = sourceMarks(owner, source);
  assert.deepEqual(marks.map(m => [m.n, m.anchorId, m.kind, m.page]), [[1, 'S-001.b1.s1', 'sentence', 1], [2, 'S-001.b2.r1c2', 'cell', 2], [3, 'S-001.b3.s1', 'sentence', 2]]);
  assert.equal(marks[0].cites[0].id, 'T-0002');
  assert.equal(marks[1].text, '12.5');
  assert.equal(marks[1].row, '최대');
  assert.equal(marks[1].column, '2024');
  assert.match(marks[1].loc, /p\.2 · 표 1\. 전송률 · 최대 × 2024/);
  assert.equal(marks[2].notes[0].text, '메모 하나');
  assert.equal(marks[2].cites.length, 0);
});

test('markHtml: 문장을 글 조각마다 따로 감싸 태그를 가로지르지 않고, <br>·엔티티를 넘어 찾으며, 참조 목록을 스크립트 없이 끼운다', () => {
  const html = '<html><head><title>Optical data transmission</title></head><body><p>Optical <b>data</b> transmission is&nbsp;highly efficient. It moves 9 GB<br>on one battery cell.</p><table><tr><th>최대</th><td>10</td><td>12.5</td></tr></table><script>var x = "Optical data transmission is highly efficient."</script></body></html>';
  const marks = [
    { n: 1, anchorId: 'a1', kind: 'sentence', text: 'Optical data transmission is highly efficient.', loc: '문단 1', cites: [{ id: 'T-0002', text: '광통신' }], notes: [] },
    { n: 2, anchorId: 'a2', kind: 'sentence', text: 'It moves 9 GB on one battery cell.', loc: '문단 1', cites: [], notes: [{ id: 'N-001', text: '메모' }] },
    { n: 3, anchorId: 'a3', kind: 'cell', text: '12.5', row: '최대', loc: '표', cites: [{ id: 'T-0001', text: '전송률' }], notes: [] },
    { n: 4, anchorId: 'a4', kind: 'sentence', text: '원본에 없는 문장이다.', loc: '문단 9', cites: [{ id: 'T-0009', text: 'x' }], notes: [] },
  ];
  const { html: out, found } = markHtml(html, marks);
  assert.deepEqual(found, [1, 2, 3]);
  // 첫 문장은 <b> 앞·안·뒤 세 조각으로 감싼다 — 열고 닫는 수가 같고 <b> 는 그대로다
  const first = out.slice(out.indexOf('id="sa-m-1"') - 40, out.indexOf('<sup class="sa-tag"'));
  assert.equal((first.match(/<mark /g) || []).length, 3);
  assert.equal((first.match(/<\/mark>/g) || []).length, 3);
  // 조각 사이의 공백은 표시 밖에 남는다
  assert.match(out, /<mark class="sa-m sa-cite" id="sa-m-1"[^>]*>Optical<\/mark> <b><mark[^>]*>data<\/mark><\/b> <mark[^>]*>transmission is&nbsp;highly efficient\.<\/mark><sup class="sa-tag"[^>]*>1<\/sup>/);
  assert.match(out, /<mark class="sa-m sa-note" id="sa-m-2"[^>]*>It moves 9 GB<\/mark><br><mark[^>]*>on one battery cell\.<\/mark>/);
  assert.match(out, /<td><mark class="sa-m sa-cite" id="sa-m-3"[^>]*>12\.5<\/mark>/);
  assert.ok(out.includes('<script>var x = "Optical data transmission is highly efficient."</script>'), '스크립트 안은 건드리지 않는다');
  assert.ok(out.includes('<details id="sa-panel" open>'));
  assert.match(out, /참조 3 · 메모 1 · 자리 못 찾음 1/);
  assert.match(out, /class="sa-miss"/);
  assert.equal((out.match(/<script/g) || []).length, 1, '스크립트를 더 넣지 않는다');
  assert.ok(out.startsWith('<html><head><title>Optical data transmission</title></head><body><style'), '머리말은 그대로, 목록은 body 첫머리에');
});

// 페이지 하나짜리 PDF 를 손으로 만든다 — xref 표 또는 xref 스트림
function tinyPdf({ stream = false } = {}) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /CropBox [10 10 190 90] /Annots [] >>',
  ];
  let out = '%PDF-1.5\n';
  const offsets = [];
  objs.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const startxref = out.length;
  if (!stream) {
    out += `xref\n0 4\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 4 /Root 1 0 R /ID [<AA> <BB>] >>\nstartxref\n${startxref}\n%%EOF\n`;
  } else {
    const rows = [[0, 0, 65535], ...offsets.map(o => [1, o, 0]), [1, startxref, 0]];
    const data = Buffer.alloc(rows.length * 7);
    rows.forEach(([t, o, g], k) => { data[k * 7] = t; data.writeUInt32BE(o, k * 7 + 1); data.writeUInt16BE(g, k * 7 + 5); });
    out += `4 0 obj\n<< /Type /XRef /Size 5 /W [1 4 2] /Root 1 0 R /Length ${data.length} >>\nstream\n${data.toString('latin1')}\nendstream\nendobj\nstartxref\n${startxref}\n%%EOF\n`;
  }
  return Buffer.from(out, 'latin1');
}

for (const stream of [false, true]) {
  test(`annotatePdf: ${stream ? 'xref 스트림' : 'xref 표'} 원본 뒤에 형광 주석과 같은 방식의 xref 를 증분으로 덧붙인다`, () => {
    const pdf = tinyPdf({ stream });
    const before = pdfPages(pdf);
    assert.equal(before.pages.length, 1);
    assert.deepEqual(before.pages[0].box, [10, 10, 190, 90]);
    assert.equal(before.trailer.classic, !stream);
    const out = annotatePdf(pdf, [{ page: 1, quads: page => [[page.box[0] + 5, page.box[3] - 20, page.box[0] + 60, page.box[3] - 8]], contents: '인용 T-0001: 한글 메모', title: '[1]' }], { now: new Date('2026-09-22T00:00:00Z') });
    assert.ok(out.subarray(0, pdf.length).equals(pdf), '원본 바이트는 그대로다');
    const text = out.toString('latin1');
    assert.match(text, /\/Subtype \/Highlight/);
    assert.match(text, /\/QuadPoints \[15 82 70 82 15 70 70 70\]/);
    assert.match(text, /\/Contents <FEFF/);
    assert.match(text, new RegExp(`/Prev ${pdf.toString('latin1').match(/startxref\n(\d+)/)[1]}`));
    assert.match(text, stream ? /\/Type \/XRef/ : /\ntrailer\n<< \/Size/);
    if (!stream) assert.match(text, /\/ID \[<AA> <BB>\]/);
    const after = pdfPages(out);
    const annots = after.resolve(after.pages[0].dict.get('Annots'));
    assert.equal(annots.length, 1);
    const annot = after.resolve(annots[0]).dict;
    assert.equal(annot.get('Subtype').name, 'Highlight');
    assert.deepEqual(annot.get('Rect'), [15, 70, 70, 82]);
    // 새 startxref 가 우리가 쓴 xref 절을 가리킨다
    const last = Number(text.match(/startxref\n(\d+)\n%%EOF\n$/)[1]);
    assert.ok(stream ? /^\d+ 0 obj/.test(text.slice(last)) : text.startsWith('xref', last));
    assert.equal(annotatePdf(pdf, [{ page: 1, quads: [] }]), pdf, '표시할 곳이 없으면 원본 그대로');
  });
}

test('locateText: 낱말 좌표에서 문장을 찾아 줄마다 사각형을 만들고, 표 셀은 행 제목 뒤에서 찾는다', () => {
  const page = { number: 1, width: 200, height: 100, words: [
    { text: 'Optical', x1: 10, y1: 10, x2: 40, y2: 20, line: 1 }, { text: 'data', x1: 42, y1: 10, x2: 60, y2: 20, line: 1 },
    { text: 'transmission', x1: 10, y1: 22, x2: 70, y2: 32, line: 2 }, { text: 'is', x1: 72, y1: 22, x2: 80, y2: 32, line: 2 }, { text: 'eﬃcient.', x1: 82, y1: 22, x2: 110, y2: 32, line: 2 },
    { text: '12.5', x1: 10, y1: 40, x2: 30, y2: 50, line: 3 }, { text: '최대', x1: 10, y1: 60, x2: 30, y2: 70, line: 4 }, { text: '12.5', x1: 40, y1: 60, x2: 60, y2: 70, line: 4 },
  ] };
  assert.deepEqual(locateText(page, 'Optical data transmission is efficient.'), [{ x1: 10, y1: 10, x2: 60, y2: 20 }, { x1: 10, y1: 22, x2: 110, y2: 32 }]);
  assert.deepEqual(locateText(page, '12.5', { after: '최대' }), [{ x1: 40, y1: 60, x2: 60, y2: 70 }]);
  assert.deepEqual(locateText(page, '12.5'), [{ x1: 10, y1: 40, x2: 30, y2: 50 }]);
  assert.equal(locateText(page, '없는 문장'), null);
});
