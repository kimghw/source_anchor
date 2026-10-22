// 실제 hwp(저장소 루트의 연구개발계획서, 없으면 건너뛴다) — 스캔 수·힌트·잠김, scanForm 통과(단위 ≤ 5,000)·헤딩 출처 분포, 칸 둘·필드 하나 기입 → exportForm 재스캔 확인·다른 스트림 바이트 동일·olefile 로 열림
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readCfb } from '../lib/cfb.js';
import { CELL_LIMIT, applyFormPatch, buildForm, exportForm, scanForm, unitIndex } from '../lib/forms.js';
import { TAG, openHwp } from '../lib/hwp_file.js';
import { scanHwp } from '../lib/hwp_form.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REAL = path.join(ROOT, 'SSCB_산업기술혁신사업 연구개발계획서_한국선급_rev3.hwp');
const run = fs.existsSync(REAL) ? test : test.skip;
const hasOlefile = (() => {
  try { execFileSync('python', ['-I', '-c', 'import olefile'], { stdio: 'pipe' }); return true; } catch { return false; }
})();
// olefile(독립 구현)로 연 스트림 목록·크기
const olefileList = buf => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-'));
  const file = path.join(dir, 'a.hwp');
  try {
    fs.writeFileSync(file, buf);
    const py = 'import olefile,sys,json\nole=olefile.OleFileIO(sys.argv[1])\nprint(json.dumps(sorted(["/".join(p), ole.get_size("/".join(p))] for p in ole.listdir(streams=True,storages=False))))';
    return JSON.parse(execFileSync('python', ['-I', '-c', py, file], { maxBuffer: 1 << 26 }).toString());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
const cellsOf = tables => tables.flatMap(t => t.rows.flatMap(row => row.cells));
const count = (list, key) => Object.fromEntries([...Map.groupBy(list, key)].map(([k, v]) => [k, v.length]));

run('실제 hwp: 섹션 3·최상위 문단·표 91(본문 89)·칸 3,953, 개요 문단 힌트, 섹션 첫 문단 잠김', () => {
  const data = fs.readFileSync(REAL);
  const { header, sections } = openHwp(data);
  assert.deepEqual(header, { version: '5.1.0.1', compressed: true, encrypted: false, distribution: false });
  assert.deepEqual(sections.map(s => [s.n, s.records.filter(r => r.tag === TAG.PARA_HEADER && r.level === 0).length]), [[0, 2], [1, 2], [2, 624]]);
  const { format, items } = scanHwp(data);
  assert.equal(format, 'hwp');
  const tables = items.filter(i => i.kind === 'table');
  assert.deepEqual(count(tables, t => t.section), { 0: 1, 1: 1, 2: 89 });
  assert.deepEqual(tables.map(t => t.t), tables.map((_, i) => i));
  assert.equal(cellsOf(tables.filter(t => t.section === 2)).length, 3953);
  assert.ok(tables.every(t => t.cols && Math.abs(t.cols.reduce((a, b) => a + b, 0) - 100) <= 0.05 * t.cols.length + 0.01), '모든 표의 열 폭이 100% 로 모인다(열마다 0.1 반올림)');
  assert.deepEqual(count(cellsOf(tables).filter(c => c.locked), c => c.locked), { '문서 설정': 18, '중첩 표': 8 });
  const paras = items.filter(i => i.kind === 'paragraph');
  assert.equal(paras.filter(p => p.section === 2).length, 624 - 89 + 2); // 표를 품은 문단 89 는 표 자리(둘을 품은 문단 둘)
  // 섹션 첫 문단: 0·1 은 표를 품어 표 자리, 2 는 구역·단 설정으로 잠긴다
  assert.deepEqual(items.find(i => i.section === 2), { kind: 'paragraph', section: 2, p: 0, text: '목  차', hints: { style: '바탕글', outlineLvl: null, ilvl: null }, locked: '문서 설정' });
  assert.deepEqual(items.filter(i => i.section !== 2).map(i => [i.kind, i.section, i.p ?? i.t]), [['table', 0, 0], ['paragraph', 0, 1], ['table', 1, 1], ['paragraph', 1, 1]]);
  const outline = paras.filter(p => p.hints.outlineLvl != null);
  assert.equal(outline.length, 55);
  assert.deepEqual(outline.slice(0, 3).map(p => [p.text, p.hints]), [
    ['1. 연구개발과제의 필요성', { style: '개요 1', outlineLvl: 0, ilvl: null }],
    [' 1-1. 개발 대상 기술·제품의 개요', { style: '개요 2', outlineLvl: 1, ilvl: null }],
    [' 1-2. 연구개발과제의 배경 및 필요성', { style: '+1-1', outlineLvl: 1, ilvl: null }],
  ]);
  assert.deepEqual(count(paras.filter(p => p.note), p => p.note), { '필드 있음': 10, '그리기 개체 있음': 8 });
});

run('실제 hwp: scanForm 통과 — 단위 ≤ 5,000, 헤딩 출처 분포(개요 헤딩 ≥ 30, 수준 1~3, 깊이 4 는 depth)', () => {
  const data = fs.readFileSync(REAL);
  const { format, nodes, tables } = scanForm(data);
  assert.equal(format, 'hwp');
  assert.equal(tables.length, 91);
  const units = cellsOf(tables).length + nodes.filter(n => n.kind === 'field').length;
  assert.ok(units <= CELL_LIMIT && units > 4000, `단위 ${units}`);
  const heads = nodes.filter(n => n.kind === 'heading');
  const by = count(heads, h => h.by);
  assert.ok(by.outline >= 50 && !by.style && by.text >= 10, JSON.stringify(by)); // 「개요 n」 스타일 문단도 문단 모양의 개요 수준으로 잡혀 출처가 outline 하나로 모인다
  assert.ok(heads.every(h => [1, 2, 3].includes(h.level) && (h.depth === undefined || h.depth >= 4)));
  const first = heads.find(h => h.text === '1. 연구개발과제의 필요성' && h.by !== 'text');
  assert.deepEqual([first.level, first.by, first.section], [1, 'outline', 2]);
  assert.deepEqual(heads.filter(h => h.by === 'outline').slice(0, 3).map(h => [h.text, h.level]), [['1. 연구개발과제의 필요성', 1], [' 1-1. 개발 대상 기술·제품의 개요', 2], [' 1-2. 연구개발과제의 배경 및 필요성', 2]]);
  assert.deepEqual(heads.find(h => h.text.startsWith('  (1) 최종목표')).level, 3);
  assert.ok(heads.some(h => h.by === 'outline' && h.depth === 4 && /^\s*[①②]/.test(h.text)));
  assert.ok(heads.some(h => h.by === 'text' && h.text === '1. 연구개발과제의 필요성' && h.p < first.p), '앞쪽 목차 페이지의 「1. …」 은 글 규칙 헤딩');
  assert.deepEqual(nodes.filter(n => n.kind === 'field' && n.locked).map(n => [n.section, n.p, n.locked]), [[2, 0, '문서 설정'], [2, 34, '문서 설정']]);
});

run('실제 hwp: 칸 둘(여러 줄·빈 값)과 필드 하나 → exportForm 재스캔 확인 통과, 손대지 않은 스트림 바이트 동일, olefile 로 열림', async () => {
  const data = fs.readFileSync(REAL);
  const { form, original } = await buildForm({ id: 'F-001', fileName: path.basename(REAL), data });
  assert.equal(form.format, 'hwp');
  assert.equal(form.original, 'originals/F-001.hwp');
  const index = unitIndex(form);
  const cells = [...index.values()].filter(u => u.kind === 'cell' && !u.cell.locked);
  const blank = cells.find(u => u.t === 0 && u.r === 15 && u.cell.text === ''); // 표지의 연구책임자 성명(빈 칸)
  const named = cells.find(u => u.t === 0 && u.r === 36 && u.cell.text === '김거화'); // 공동연구개발기관 책임자 → 빈 값
  const field = [...index.values()].find(u => u.kind === 'field' && !u.node.locked && !u.node.after && u.node.text.trim());
  assert.ok(blank && named && field);
  applyFormPatch(form, { values: { [blank.cell.n]: '홍길동\n\n둘째 줄\t탭', [named.cell.n]: '', [field.node.n]: '바뀐 본문 문단' } });
  assert.equal(Object.keys(form.values).length, 3);
  const out = exportForm(form, original);
  assert.deepEqual([out.name, out.downloadName], ['F-001.hwp', path.basename(REAL)]);
  const a = readCfb(original), b = readCfb(out.data);
  assert.deepEqual(b.names, a.names);
  const touched = new Set(['BodyText/Section0', `BodyText/Section${field.node.section}`]);
  for (const name of a.names) if (!touched.has(name)) assert.ok(a.read(name).equals(b.read(name)), name);
  for (const name of touched) assert.ok(!a.read(name).equals(b.read(name)), name);
  const rescan = scanHwp(out.data);
  const at = (items, t, r, c) => cellsOf(items.filter(i => i.kind === 'table' && i.t === t)).find(x => x.r === r && x.c === c);
  assert.equal(at(rescan.items, 0, blank.r, blank.c).text, '홍길동\n\n둘째 줄\t탭');
  assert.equal(at(rescan.items, 0, named.r, named.c).text, '');
  assert.equal(rescan.items.find(i => i.kind === 'paragraph' && i.section === field.node.section && i.p === field.node.p).text, '바뀐 본문 문단');
  assert.equal(openHwp(out.data).sections.length, 3);
  form.values = {};
  assert.ok(exportForm(form, original).data.equals(original));
  if (hasOlefile) {
    assert.deepEqual(olefileList(out.data).map(([n]) => n), olefileList(original).map(([n]) => n));
    assert.deepEqual(olefileList(out.data), b.names.map(n => [n, b.read(n).length]).sort());
  }
});
