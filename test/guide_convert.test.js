// 기준 문서 PDF 에이전트 변환 — 묶음 나누기, 출력 읽기·검사, 쪽 기준 ID·Markdown, 줄(문서 차례·동시 10개)·다시 하기·등록 때 글로 남기기·
// 사용 한도·멈추기·남은 묶음, 저장소 연동 (FR-WB-097, 098, DR-WB-006, ERR-WB-012). 실제 CLI 는 띄우지 않는다 — deps.runTurn 을 바꿔 끼운다
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { guidesText } from '../agent.js';
import { pdfPages } from '../lib/collect.js';
import * as convert from '../lib/guide_convert.js';
import { sourceMarkdown } from '../lib/source_md.js';

// 쪽마다 낱말이 다른 글 — 숫자를 빼고 보아도 줄 모양이 쪽마다 다르다(되풀이 줄로 지워지지 않게)
const HEAD = 'Rules for the Classification of Steel Ships';
const tag = p => String.fromCharCode(97 + (p % 26), 97 + (Math.floor(p / 26) % 26)) + 'x';
const pageText = p => `${HEAD}\nSection ${p} ${tag(p)} arrangements\n${p}.1.1 The ${tag(p)} requirements apply to item ${p}. In particular they apply to services ${p * 7}.\nJuly 2025\n`;
const pageMd = p => `<!-- p.${p} -->\n\n# Section ${p} ${tag(p)} arrangements\n\n${p}.1.1 The ${tag(p)} requirements apply to item ${p}.\nIn particular they apply to services ${p * 7}.\n`;
const goodMd = (from, to) => `${Array.from({ length: to - from + 1 }, (_, k) => pageMd(from + k)).join('\n')}\n<!-- end -->`;
const pagesOf = n => Array.from({ length: n }, (_, k) => pageText(k + 1));
const rangeOf = prompt => prompt.match(/pages "(\d+)(?:-(\d+))?"/).slice(1).map(Number).map((v, i, a) => (i === 1 && !v ? a[0] : v));

// 가짜 CLI — reply({ from, to, prompt, doc, call }) 가 { text } 또는 { error } 또는 { hang: true } 를 준다
function fakeCli(reply, log = { calls: [], active: 0, max: 0 }) {
  convert.deps.runTurn = (opts, onEvent) => {
    const [from, to] = rangeOf(opts.prompt);
    const call = { from, to, prompt: opts.prompt, tools: opts.tools, persist: opts.persist, model: opts.model, cwd: opts.cwd };
    log.calls.push(call);
    log.active++;
    log.max = Math.max(log.max, log.active);
    let abort = () => {};
    const done = (async () => {
      call.doc = await fs.readFile(path.join(opts.cwd, 'doc.pdf'), 'utf8');
      const out = await reply({ ...call, call: log.calls.length });
      if (out.hang) await new Promise(resolve => { abort = resolve; });
      else await new Promise(resolve => setTimeout(resolve, 5));
      log.active--;
      if (out.hang) return { aborted: true, failed: false };
      if (out.error) {
        onEvent({ t: 'error', message: out.error });
        return { failed: true, aborted: false };
      }
      onEvent({ t: 'text_start' });
      onEvent({ t: 'text', d: out.text });
      return { failed: false, aborted: false };
    })();
    return { done, abort: () => abort() };
  };
  return log;
}

function useDeps(pages) {
  Object.assign(convert.deps, { cliAvailable: () => true, convertModel: async () => 'claude-opus-5-5', disabled: () => '', limitWaits: [0, 0, 0], pdfPages: async data => (typeof pages === 'function' ? pages(data) : pages) });
}

// 보고서 폴더 하나와 PDF 기준 문서 하나 — 본문은 등록 때 판(V-001)
async function fixture(id = 'G-001', bytes = 'PDF-A') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sourceanchor-convert-test-'));
  await fs.mkdir(path.join(dir, 'guides', 'originals'), { recursive: true });
  await fs.writeFile(path.join(dir, 'guides', 'originals', `${id}.pdf`), bytes);
  const guide = { id, version: 'V-001', kind: 'guideline', type: 'pdf', title: '규칙', fileName: 'rules.pdf', snapshot: `originals/${id}.pdf`, collectedAt: 't', hash: 'h', blocks: [{ id: `${id}.b1`, kind: 'paragraph', loc: { page: 1 }, sentences: [{ id: `${id}.b1.s1`, text: '등록 때 본문' }] }] };
  return { dir, guide, key: `M-001/${id}` };
}
const ids = blocks => blocks.flatMap(b => [...b.sentences.map(s => s.id), ...(b.table?.rows.flatMap(r => r.cells.map(c => c.id)) ?? [])]);

test('묶음 나누기: 연속한 20쪽씩, 마지막 묶음은 남은 쪽', () => {
  const parts = convert.planParts(114);
  assert.deepEqual(parts.map(p => [p.n, p.from, p.to]), [[1, 1, 20], [2, 21, 40], [3, 41, 60], [4, 61, 80], [5, 81, 100], [6, 101, 114]]);
  assert.equal(convert.planParts(20).length, 1);
  assert.deepEqual(convert.planParts(21).map(p => [p.from, p.to]), [[1, 20], [21, 21]]);
  assert.equal(convert.UNIT_PAGES, 20);
  assert.equal(convert.MAX_AGENTS, 10);
});

const SAMPLE = `Here is the transcription.

<!-- p.2 -->
# Section 1 General

## 1 Application

1.1.1 The requirements of this Chapter apply to electrical installations on ships.
In particular, they apply to the components of electrical installations for:

- primary essential services
- secondary essential services

Table 1 : Documents to be submitted

| No. | I/A (1) | Documents |
|---|---|---|
| 1 | A | General arrangement |
| 2 | A | Single line \\| diagram |

<!-- p.3 -->
Note 1: Later versions may be found acceptable.
<!-- end -->`;

test('모델 출력 읽기: 쪽 표시·제목·한 줄 한 문장 문단·목록·표(제목·이스케이프한 |)를 블록으로, ID 는 쪽 기준으로 붙이고 Markdown 에 [ID] 로 적는다', () => {
  const drafts = convert.parseConverted(SAMPLE.slice(SAMPLE.indexOf('<!--')), 2);
  assert.deepEqual(drafts.map(d => [d.kind, d.loc.page]), [['heading', 2], ['heading', 2], ['paragraph', 2], ['list', 2], ['table', 2], ['paragraph', 3]]);
  assert.deepEqual(drafts[2].sentences, ['1.1.1 The requirements of this Chapter apply to electrical installations on ships.', 'In particular, they apply to the components of electrical installations for:']);
  assert.deepEqual(drafts[3].items, ['primary essential services', 'secondary essential services']);
  assert.equal(drafts[4].table.title, 'Table 1 : Documents to be submitted');
  assert.deepEqual(drafts[4].table.rows, [['1', 'A', 'General arrangement'], ['2', 'A', 'Single line | diagram']]);

  const blocks = convert.pageBlocks('G-001', drafts);
  assert.deepEqual(ids(blocks), ['G-001.p2.b1.s1', 'G-001.p2.b2.s1', 'G-001.p2.b3.s1', 'G-001.p2.b3.s2', 'G-001.p2.b4.s1', 'G-001.p2.b4.s2', 'G-001.p2.b5.r1c1', 'G-001.p2.b5.r1c2', 'G-001.p2.b5.r2c1', 'G-001.p2.b5.r2c2', 'G-001.p3.b1.s1']);
  assert.equal(blocks[2].sentences[0].text, '1.1.1 The requirements of this Chapter apply to electrical installations on ships.'); // 다시 나누지 않는다

  const md = sourceMarkdown({ id: 'G-001', version: 'V-002', type: 'pdf', title: 't', collectedAt: 't', hash: 'h', blocks }, { ids: true });
  for (const line of ['<!-- p.2 -->', '# [G-001.p2.b1.s1] Section 1 General', '[G-001.p2.b3.s1] 1.1.1 The requirements of this Chapter apply to electrical installations on ships.', '[G-001.p2.b3.s2] In particular, they apply to the components of electrical installations for:', '- [G-001.p2.b4.s2] secondary essential services', '<!-- table G-001.p2.b5 -->', '| 2 | A | Single line ｜ diagram |', '<!-- p.3 -->', '[G-001.p3.b1.s1] Note 1: Later versions may be found acceptable.']) {
    assert.ok(md.split('\n').includes(line), line);
  }
});

test('출력 검사: 잘림·범위 밖·거꾸로 된 쪽 표시·낱말 대조 미달은 실패, 머리말 줄은 대조에서 빠진다', () => {
  const reference = convert.referencePages(pagesOf(30));
  assert.ok(!reference[4].includes(HEAD) && !reference[4].includes('July'), '모든 쪽의 머리말·꼬리말은 뺀다');
  assert.ok(reference[4].includes(`The ${tag(5)} requirements`));
  const ref = (from, to) => reference.slice(from - 1, to).join('\n');
  // pdftotext 가 한 쪽의 줄을 하나로 합쳐 내도 그 안의 머리말·꼬리말은 빠진다 — 쪽 번호뿐인 줄로 숫자를 지우지는 않는다
  const merged = convert.referencePages([`${HEAD}\nSection 1 Bax\nText one is here.\nJuly 2025\n7`, `${HEAD}\nSection 2 Cax\nText two.\nJuly 2025\n8`, `${HEAD} Section 3 Dax Text three has 42 items. July 2025 9`]);
  assert.equal(merged[2].replace(/\s+/g, ' ').trim(), 'Section 3 Dax Text three has 42 items. 9');
  assert.deepEqual(merged.slice(0, 2), ['Section 1 Bax\nText one is here.', 'Section 2 Cax\nText two.']);

  const ok = convert.checkOutput(`Sure.\n${goodMd(1, 20)}`, 1, 20, ref(1, 20));
  assert.equal(ok.ok, true);
  assert.ok(ok.markdown.startsWith('<!-- p.1 -->') && ok.recall >= 0.99 && ok.precision >= 0.9, JSON.stringify([ok.recall, ok.precision]));

  const cut = convert.checkOutput(goodMd(1, 20).replace('<!-- end -->', ''), 1, 20, ref(1, 20));
  assert.deepEqual([cut.ok, cut.truncated], [false, true]);
  assert.match(convert.checkOutput(goodMd(1, 20).replace('<!-- p.7 -->', '<!-- p.25 -->'), 1, 20, ref(1, 20)).reason, /p\.25/);
  assert.match(convert.checkOutput(goodMd(1, 20).replace('<!-- p.7 -->', '<!-- p.3 -->'), 1, 20, ref(1, 20)).reason, /순서/);
  const missing = convert.checkOutput(`${pageMd(1)}\n<!-- end -->`, 1, 20, ref(1, 20)); // 1쪽만 옮겼다
  assert.equal(missing.ok, false);
  assert.ok(missing.recall < 0.9);
  assert.match(missing.hint, /missing from your output/);
  const invented = convert.checkOutput(goodMd(1, 20).replace('<!-- end -->', `${'Invented paragraph about something else entirely here. '.repeat(30)}\n<!-- end -->`), 1, 20, ref(1, 20));
  assert.equal(invented.ok, false);
  assert.ok(invented.precision < 0.9);
});

test('줄: 230쪽은 묶음 12개를 에이전트 최대 10개가 동시에 Read 하나로 옮기고, 끝나면 쪽 기준 ID 본문·판·묶음 Markdown 으로 한 번에 바꾼다', async () => {
  useDeps(pagesOf(230));
  const log = fakeCli(({ from, to }) => ({ text: goodMd(from, to) }));
  const { dir, guide, key } = await fixture();
  await convert.enqueue({ key, dir, guide, mode: 'all' });
  assert.equal(guide.convert.state, 'queued');
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'guides', 'G-001.json'), 'utf8')).convert.state, 'queued');
  await convert.whenIdle();

  assert.equal(log.calls.length, 12);
  assert.equal(log.max, 10);
  assert.ok(log.calls.every(c => c.tools.join() === 'Read' && c.persist === false && c.model === 'claude-opus-5-5'));
  assert.deepEqual(log.calls.map(c => `${c.from}-${c.to}`).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)), ['1-20', '21-40', '41-60', '61-80', '81-100', '101-120', '121-140', '141-160', '161-180', '181-200', '201-220', '221-230']);
  const c = guide.convert;
  assert.deepEqual([c.state, c.model, c.pages, c.parts.length, c.parts.every(p => p.state === 'done' && p.recall >= 0.9)], ['done', 'claude-opus-5-5', 230, 12, true]);
  assert.equal(guide.version, 'V-002');
  const all = ids(guide.blocks);
  assert.equal(new Set(all).size, all.length, 'ID 는 고유하다');
  assert.ok(all.every(id => /^G-001\.p\d+\.b\d+\.s\d+$/.test(id)));
  assert.deepEqual([guide.blocks[0].id, guide.blocks.at(-1).loc.page], ['G-001.p1.b1', 230]);
  const parts = (await fs.readdir(path.join(dir, 'guides', 'parts', 'G-001'))).sort();
  assert.equal(parts.filter(f => /^part-\d\d\.md$/.test(f)).length, 12);
  assert.equal(parts.filter(f => f.endsWith('.raw.md')).length, 12);
  const part2 = await fs.readFile(path.join(dir, 'guides', 'parts', 'G-001', 'part-02.md'), 'utf8');
  assert.ok(part2.includes(`# [G-001.p21.b1.s1] Section 21 ${tag(21)} arrangements`) && !part2.includes('<!-- p.20 -->') && !part2.includes('<!-- p.41 -->'));
  const md = await fs.readFile(path.join(dir, 'guides', 'G-001.md'), 'utf8');
  assert.ok(md.includes('version: "V-002"') && md.includes(`[G-001.p230.b2.s2] In particular they apply to services ${230 * 7}.`));
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'guides', 'G-001.json'), 'utf8')).version, 'V-002');
});

test('줄: 문서는 넘긴 순서대로 하나씩 — 앞 문서의 묶음이 모두 끝난 뒤에 다음 문서를 시작한다', async () => {
  useDeps(data => pagesOf(String(data) === 'PDF-A' ? 45 : 25));
  const log = fakeCli(({ from, to }) => ({ text: goodMd(from, to) }));
  const a = await fixture('G-001', 'PDF-A');
  const b = await fixture('G-002', 'PDF-B');
  await convert.enqueue(a);
  await convert.enqueue(b);
  await assert.rejects(convert.enqueue(b), err => err.status === 409);
  await convert.whenIdle();
  assert.deepEqual(log.calls.map(c => c.doc), ['PDF-A', 'PDF-A', 'PDF-A', 'PDF-B', 'PDF-B']);
  assert.deepEqual([a.guide.convert.state, b.guide.convert.state], ['done', 'done']);
});

test('다시 하기: 실행 실패는 한 번 더, 잘린 묶음은 반씩, 낱말 대조 미달은 사유를 붙여 한 번 더 — 그래도 실패한 묶음의 쪽은 등록 때 글(일부 자동 변환)', async () => {
  useDeps(pagesOf(60));
  const tries = {};
  const log = fakeCli(({ from, to }) => {
    const key = `${from}-${to}`;
    tries[key] = (tries[key] || 0) + 1;
    if (key === '1-20') return { text: goodMd(1, 20).replace('<!-- end -->', '') }; // 잘림 → 1–10 · 11–20
    if (key === '21-40') return { text: goodMd(21, 40).replace(/requirements/g, 'lorem ipsum dolor sit amet consectetur') }; // 낱말이 덜 맞는다
    if (key === '41-60' && tries[key] === 1) return { error: 'claude CLI 가 종료 코드 1 로 끝났습니다.' };
    return { text: goodMd(from, to) };
  });
  const { dir, guide, key } = await fixture();
  await convert.enqueue({ key, dir, guide });
  await convert.whenIdle();
  assert.deepEqual(tries, { '1-20': 1, '1-10': 1, '11-20': 1, '21-40': 2, '41-60': 2 });
  const retry = log.calls.filter(c => c.from === 21).at(-1);
  assert.match(retry.prompt, /did not match the text layer/);
  const [p1, p2, p3] = guide.convert.parts;
  assert.deepEqual([p1.state, p2.state, p3.state, p3.attempts], ['done', 'fallback', 'done', 2]);
  assert.match(p2.error, /낱말이 덜 맞습니다/);
  assert.equal(guide.convert.state, 'partial');
  // 21–40 쪽은 등록 때 글(pdftotext) — 머리말 줄까지 그대로, ID 는 쪽 기준
  const p21 = guide.blocks.filter(b => b.loc.page === 21);
  assert.equal(p21[0].id, 'G-001.p21.b1');
  assert.ok(p21.some(b => b.sentences.some(s => s.text.includes(HEAD))));
  assert.ok(guide.blocks.find(b => b.loc.page === 11).sentences[0].text.startsWith('Section 11'), '반으로 나눈 묶음도 쓴다');
  assert.deepEqual(guide.convert.parts.map(p => p.state), ['done', 'fallback', 'done']);
});

test('사용 한도: 1·2·4분(시험에서는 0) 기다렸다 다시, 그래도 막히면 멈추고 본문은 그대로', async () => {
  useDeps(pagesOf(10));
  const log = fakeCli(() => ({ error: 'Claude AI usage limit reached|1761100000' }));
  const { dir, guide, key } = await fixture();
  await convert.enqueue({ key, dir, guide });
  await convert.whenIdle();
  assert.equal(log.calls.length, 4);
  assert.equal(guide.convert.state, 'stopped');
  assert.match(guide.convert.reason, /사용 한도/);
  assert.deepEqual([guide.version, guide.blocks[0].sentences[0].text], ['V-001', '등록 때 본문']);
});

test('멈추기와 남은 묶음: 멈추면 본문은 그대로이고, 남은 묶음만 다시 하면 통과한 묶음은 보관한 출력을 쓴다', async () => {
  useDeps(pagesOf(45));
  fakeCli(({ from, to }) => (from === 41 ? { hang: true } : { text: goodMd(from, to) }));
  const { dir, guide, key } = await fixture();
  await convert.enqueue({ key, dir, guide });
  while (guide.convert.parts?.filter(p => p.state === 'done').length !== 2) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(await convert.stop(key), true);
  await convert.whenIdle();
  assert.equal(guide.convert.state, 'stopped');
  assert.deepEqual(guide.convert.parts.map(p => p.state), ['done', 'done', 'queued']);
  assert.equal(guide.version, 'V-001');
  assert.equal(await convert.stop(key), false); // 대기·진행 중인 것이 없다

  const log = fakeCli(({ from, to }) => ({ text: goodMd(from, to) }));
  await convert.enqueue({ key, dir, guide, mode: 'rest' });
  await convert.whenIdle();
  assert.deepEqual(log.calls.map(c => `${c.from}-${c.to}`), ['41-45']);
  assert.deepEqual([guide.convert.state, guide.version, guide.blocks.at(-1).loc.page], ['done', 'V-002', 45]);
});

test('건너뛰기: 에이전트가 꺼졌거나 CLI 가 없으면 사유와 함께 건너뛰고 본문은 그대로', async () => {
  useDeps(pagesOf(5));
  const log = fakeCli(({ from, to }) => ({ text: goodMd(from, to) }));
  convert.deps.cliAvailable = () => false;
  const { dir, guide, key } = await fixture();
  await convert.enqueue({ key, dir, guide });
  await convert.whenIdle();
  assert.deepEqual([guide.convert.state, log.calls.length, guide.version], ['skipped', 0, 'V-001']);
  assert.match(guide.convert.reason, /Claude CLI/);
});

// 글이 든 PDF 를 손으로 만든다 (test/collect.test.js 와 같은 방식)
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

test('저장소 연동: PDF 를 등록하면 곧바로 쓰이고 변환 대기에 서며, 끝나면 판·쪽 기준 ID·Markdown 이 바뀌고, 다시 시작하면 이어 하며, 지우면 묶음 파일도 지운다', async t => {
  const pdf = pdfOf([['Section 1 General', '1.1.1 The requirements apply to electrical installations on ships.'], ['Section 2 Design', '2.1.1 Cables are to be protected against damage.']]);
  if (!(await pdfPages(pdf).then(() => true, () => false))) return t.diagnostic('pdftotext 가 없어 저장소 연동은 확인하지 않았다');
  useDeps(null);
  convert.deps.pdfPages = pdfPages;
  const log = fakeCli(() => ({ text: '<!-- p.1 -->\n\n# Section 1 General\n\n1.1.1 The requirements apply to electrical installations on ships.\n\n<!-- p.2 -->\n\n# Section 2 Design\n\n2.1.1 Cables are to be protected against damage.\n\n<!-- end -->' }));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sourceanchor-convert-store-'));
  process.env.WORKSPACE = dir;
  const store = await import(`../lib/store.js?workspace=${encodeURIComponent(dir)}`);
  const { book } = await store.loadBookState();
  const added = await store.addGuide({ bookId: book.id, kind: 'guideline', fileName: 'rules.pdf', data: pdf.toString('base64') });
  assert.deepEqual([added.guide.version, added.guide.convert.state], ['V-001', 'queued']);
  assert.ok((await store.getGuide(book.id, 'G-001')).blocks[0].id.startsWith('G-001.b')); // 변환 전에도 열람·에이전트 사용
  assert.match(guidesText(await store.fullGuides(book.id)), /G-001 .*\(being re-transcribed from the PDF/);
  const text = await store.addGuide({ bookId: book.id, kind: 'reference', markdown: '# 참고\n\n본문이다.' });
  assert.equal(text.guide.convert, undefined); // PDF 가 아니면 변환하지 않는다
  await convert.whenIdle();

  assert.equal(log.calls.length, 1);
  const guide = await store.getGuide(book.id, 'G-001');
  assert.deepEqual([guide.version, guide.convert.state, guide.blocks.map(b => b.id)], ['V-002', 'done', ['G-001.p1.b1', 'G-001.p1.b2', 'G-001.p2.b1', 'G-001.p2.b2']]);
  assert.deepEqual((await store.guideList(book.id))[0].convert, { state: 'done', model: 'claude-opus-5-5', reason: '', finishedAt: guide.convert.finishedAt, total: 1, done: 1, fallback: [] });
  const md = (await store.readGuideFile(book.id, 'G-001', 'markdown')).data.toString('utf8');
  assert.ok(md.includes('[G-001.p1.b2.s1] 1.1.1 The requirements apply to electrical installations on ships.'));
  assert.ok((await store.readGuideFile(book.id, 'G-002', 'markdown')).data.toString('utf8').includes('[G-002.b2.s1] 본문이다.'), '붙여 넣은 문서의 Markdown 에도 ID');
  assert.doesNotMatch(guidesText(await store.fullGuides(book.id)), /being re-transcribed/);
  await assert.rejects(store.convertGuide({ bookId: book.id, id: 'G-001', action: 'stop' }), err => err.status === 409);
  await assert.rejects(store.convertGuide({ bookId: book.id, id: 'G-002', action: 'start' }), err => err.status === 400);
  await assert.rejects(store.convertGuide({ bookId: book.id, id: 'G-001', action: 'bogus' }), err => err.status === 400);

  // 진행 중에 서버가 꺼진 것처럼 남겨 두고 다시 불러오면 이어 한다 — 통과한 묶음은 보관한 출력을 쓴다
  const file = path.join(dir, 'projects', book.id, 'guides', 'G-001.json');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...saved, convert: { ...saved.convert, state: 'running' } }));
  const again = await import(`../lib/store.js?reload=${Date.now()}`);
  await again.loadBookState(book.id);
  await convert.whenIdle();
  assert.equal(log.calls.length, 1);
  assert.deepEqual([(await again.getGuide(book.id, 'G-001')).convert.state, (await again.getGuide(book.id, 'G-001')).version], ['done', 'V-003']);

  // 다시 변환은 처음부터 — 지우면 묶음 파일까지 지운다
  await again.convertGuide({ bookId: book.id, id: 'G-001', action: 'start' });
  await convert.whenIdle();
  assert.equal(log.calls.length, 2);
  const parts = path.join(dir, 'projects', book.id, 'guides', 'parts', 'G-001');
  assert.deepEqual((await fs.readdir(parts)).sort(), ['part-01.md', 'part-01.raw.md']);
  await again.deleteGuide(book.id, 'G-001');
  await assert.rejects(fs.access(parts));
});
