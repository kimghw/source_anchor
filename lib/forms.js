// 양식(docx·hwpx) — 올린 양식을 헤딩·필드·표로 구조화해 채우는 단위에 번호를 매기고, 값·지침을 검사해 보관하며, 원본 새 사본에 기입하고 다시 읽어 확인해 내준다 (FR-WB-090, FR-WB-092, DR-WB-008, ERR-WB-011).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fillDocx, scanDocx } from './docx_form.js';
import { classify } from './form_outline.js';
import { fillHwpx, scanHwpx } from './hwpx_form.js';
import { readZip } from './zip.js';

export const FILE_LIMIT = 5 * 1024 * 1024; // 올리는 양식 파일 하나의 크기 상한 (DR-WB-008)
export const CELL_LIMIT = 5000; // 채우는 단위(칸·필드) 수
export const VALUE_LIMIT = 20_000; // 단위당 값 글자 수
export const INSTRUCTION_LIMIT = 4000; // 번호당 지침 글자 수
export const TITLE_LIMIT = 200;
const NAME_LIMIT = 260;
const ENGINES = { docx: { scan: scanDocx, fill: fillDocx }, hwpx: { scan: scanHwpx, fill: fillHwpx } };

const fail = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const lf = text => text.replace(/\r\n?/g, '\n');
const clip = text => String(text ?? '').trim().slice(0, TITLE_LIMIT);
const short = text => { const s = String(text ?? ''); return s.length > 80 ? `${s.slice(0, 80)}…` : s; };

// ZIP 의 항목으로 형식을 가린다 — ZIP 이 아니거나 읽지 못하면 null
export function detectFormat(data) {
  try {
    const zip = readZip(data);
    if (zip.has('word/document.xml')) return 'docx';
    if (zip.has('Contents/section0.xml') || zip.read('mimetype')?.toString('latin1').trim() === 'application/hwp+zip') return 'hwpx';
    return null;
  } catch (err) {
    if (err.format) return null;
    throw err;
  }
}

// 형식별 항목(문서 순서) → nodes(헤딩·필드·표 자리)·tables, 그리고 nodes 순서로 번호 — 필드는 그 자리에서, 표는 행 → 칸 순으로 (FR-WB-090)
export function scanForm(data) {
  const format = detectFormat(data);
  if (!format) throw fail(400, 'docx·hwpx 양식만 올릴 수 있습니다');
  let items;
  try {
    ({ items } = ENGINES[format].scan(data));
  } catch (err) {
    throw err.format ? fail(400, err.message) : err;
  }
  const nodes = [], tables = [];
  for (const item of items) {
    if (item.kind === 'table') {
      const { kind, ...table } = item;
      tables[item.t] = table;
      nodes.push({ kind, t: item.t });
      continue;
    }
    const { kind, level } = classify(item.text, item.hints);
    const at = { section: item.section, p: item.p };
    if (kind === 'heading') nodes.push({ kind, level, text: item.text, ...at });
    if (kind === 'field') nodes.push({ kind, n: 0, level, text: item.text, ...at, ...(item.note && { note: item.note }), ...(item.locked && { locked: item.locked }) });
  }
  if (!tables.length) throw fail(400, '표가 없는 문서입니다 — 표가 하나 이상 있는 양식을 올려 주세요');
  // 끝 헤딩(다음 노드가 헤딩·표이거나 끝) 아래 빈 필드 하나 — 채우면 그 헤딩 바로 뒤에 문단이 생긴다
  const out = nodes.flatMap((node, i) => (node.kind === 'heading' && nodes[i + 1]?.kind !== 'field'
    ? [node, { kind: 'field', n: 0, level: Math.min(node.level + 1, 3), text: '', empty: true, section: node.section, p: node.p, after: true }]
    : [node]));
  let n = 0;
  for (const node of out) {
    if (node.kind === 'field') node.n = ++n;
    if (node.kind === 'table') for (const row of tables[node.t].rows) row.cells = row.cells.map(cell => ({ n: ++n, ...cell }));
  }
  if (!n) throw fail(400, '채울 칸이나 문단이 없는 문서입니다');
  if (n > CELL_LIMIT) throw fail(400, `채우는 칸·문단이 ${CELL_LIMIT.toLocaleString()}개를 넘습니다 (${n.toLocaleString()}개)`);
  return { format, nodes: out, tables };
}

// 번호 → 채우는 단위: 칸 { kind:'cell', t, r, c, cell } 또는 필드 { kind:'field', node }
export function unitIndex(form) {
  const index = new Map();
  for (const node of form.nodes) {
    if (node.kind === 'field') index.set(node.n, { kind: 'field', node });
    if (node.kind === 'table') for (const row of form.tables[node.t].rows) for (const cell of row.cells) index.set(cell.n, { kind: 'cell', t: node.t, r: cell.r, c: cell.c, cell });
  }
  return index;
}

export const unitText = unit => (unit.cell ?? unit.node).text; // 원본 글 (빈 필드는 '')
const lockOf = unit => (unit.cell ?? unit.node).locked; // 잠긴 이유 — 칸(중첩 표 등)·필드(문서·구역 설정)

export const cleanTitle = (title, fileName) => clip(title) || clip(path.parse(String(fileName ?? '')).name) || '제목 없는 양식';

// 올린 파일을 양식 하나로 바꾼다 — 어느 검사에서든 실패하면 status 오류, 파일은 쓰지 않는다 (ERR-WB-011)
export async function buildForm({ id, title, fileName, data }) {
  const name = String(fileName ?? '').trim().slice(0, NAME_LIMIT);
  if (!Buffer.isBuffer(data)) throw fail(400, '파일 내용이 필요합니다');
  if (!data.length) throw fail(400, '빈 파일입니다');
  if (data.length > FILE_LIMIT) throw fail(413, `파일이 ${FILE_LIMIT / 1024 / 1024}MiB 를 넘습니다 (${(data.length / 1024 / 1024).toFixed(1)}MiB)`);
  const ext = name.match(/\.(docx|hwpx)$/i)?.[1].toLowerCase();
  if (!ext) throw fail(400, 'docx·hwpx 양식만 올릴 수 있습니다');
  if (detectFormat(data) !== ext) throw fail(400, '파일 내용이 확장자와 다릅니다');
  const { format, nodes, tables } = scanForm(data);
  const at = now();
  const form = {
    id, title: cleanTitle(title, name), fileName: name, format,
    hash: 'sha256:' + crypto.createHash('sha256').update(data).digest('hex'),
    original: `originals/${id}.${format}`, nodes, tables, values: {}, instructions: {}, createdAt: at, updatedAt: at,
  };
  return { form, original: data };
}

const entriesOf = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400, `${name} 은 객체여야 합니다`);
  return Object.entries(value);
};

// 화면이 보낸 변경을 검사해 반영한다 — values·instructions 는 통째 교체, 없는 번호·잠긴 단위·한도 초과는 자르지 않고 거절한다 (ERR-WB-011)
export function applyFormPatch(form, { title, values, instructions }) {
  if (title !== undefined) form.title = cleanTitle(title, form.fileName);
  const index = unitIndex(form);
  const unitOf = key => {
    const unit = /^[1-9]\d*$/.test(key) && index.get(Number(key));
    if (!unit) throw fail(400, `#${key} 은 이 양식에 없는 단위입니다`);
    return unit;
  };
  if (values !== undefined) {
    const next = {};
    for (const [key, value] of entriesOf(values, 'values')) {
      const unit = unitOf(key);
      if (lockOf(unit)) throw fail(400, `#${key} 은 잠긴 단위입니다(${lockOf(unit)})`);
      if (typeof value !== 'string') throw fail(400, `#${key}: 값은 문자열이어야 합니다`);
      const text = lf(value);
      if (text.length > VALUE_LIMIT) throw fail(400, `#${key}: 값은 ${VALUE_LIMIT.toLocaleString()}자까지입니다 (${text.length.toLocaleString()}자)`);
      if (text !== unitText(unit)) next[key] = text; // 원본 글과 같으면 바꾼 값이 아니다
    }
    form.values = next;
  }
  if (instructions !== undefined) {
    const next = {};
    for (const [key, value] of entriesOf(instructions, 'instructions')) {
      unitOf(key);
      if (typeof value !== 'string') throw fail(400, `#${key}: 지침은 문자열이어야 합니다`);
      if (value.length > INSTRUCTION_LIMIT) throw fail(400, `#${key}: 지침은 ${INSTRUCTION_LIMIT.toLocaleString()}자까지입니다 (${value.length.toLocaleString()}자)`);
      if (value.trim()) next[key] = lf(value);
    }
    form.instructions = next;
  }
  form.updatedAt = now();
  return form;
}

// 목록에 싣는 요약 — 구조(nodes·tables)는 뺀다
export const formSummary = f => ({ id: f.id, title: f.title, fileName: f.fileName, format: f.format, units: unitIndex(f).size, changed: Object.keys(f.values).length, updatedAt: f.updatedAt });

// ── 파일: workspace/projects/<보고서 ID>/forms/<F-번호>.json(구조·값·지침) + forms/originals/<F-번호>.<docx|hwpx>(올린 원본, 바꾸지 않는다)

const formsDir = dir => path.join(dir, 'forms');
const jsonFile = (dir, id) => path.join(formsDir(dir), `${id}.json`);
const originalFile = (dir, form) => path.join(formsDir(dir), form.original);

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

export async function loadForms(dir) {
  const files = (await fs.readdir(formsDir(dir)).catch(() => [])).filter(f => /^F-\d{3,}\.json$/.test(f)).sort();
  const forms = [];
  for (const f of files) forms.push(JSON.parse(await fs.readFile(path.join(formsDir(dir), f), 'utf8')));
  return forms;
}

// 원본 → json 순으로 쓴다 — 하나라도 실패하면 쓴 것을 지워 일부만 남지 않게 한다 (ERR-WB-011)
export async function writeForm(dir, form, original) {
  try {
    await fs.mkdir(path.dirname(originalFile(dir, form)), { recursive: true });
    await fs.writeFile(originalFile(dir, form), original);
    await writeJson(jsonFile(dir, form.id), form);
  } catch (err) {
    await removeFormFiles(dir, form);
    throw err;
  }
}

export const rewriteForm = (dir, form) => writeJson(jsonFile(dir, form.id), form);

export async function removeFormFiles(dir, form) {
  await fs.rm(jsonFile(dir, form.id), { force: true });
  await fs.rm(originalFile(dir, form), { force: true });
}

export const readOriginal = (dir, form) => fs.readFile(originalFile(dir, form)).catch(() => { throw fail(404, '보관한 원본 파일을 찾지 못했습니다'); });

// ── 내보내기

const incomplete = (where, want, got) => fail(409, `기입 결과가 완전하지 않습니다 — ${where}: 기대 "${short(want)}" 실제 "${short(got)}"`);
const coord = cell => cell && `T${cell.t} r${cell.r} c${cell.c}`;
const cellsOf = tables => tables.flatMap(tbl => tbl.rows.flatMap(row => row.cells.map(cell => ({ ...cell, t: tbl.t }))));

// 재스캔 확인: (a) 표 칸 좌표 열이 같고 값을 준 칸의 글이 값과 같다 (b) 본문 글 있는 문단의 글 열이 기대와 같다 —
// 기대 = 저장한 nodes 의 헤딩·필드 글에서 값을 준 필드를 값의 줄들로(빈 필드는 헤딩 바로 뒤 자리). 공백뿐인 글은 classify 처럼 양쪽에서 뺀다.
function verify(form, values, items) {
  const want = cellsOf(form.tables), got = cellsOf(items.filter(i => i.kind === 'table'));
  for (let i = 0; i < Math.max(want.length, got.length); i++) {
    const [a, b] = [want[i], got[i]];
    if (coord(a) !== coord(b)) throw incomplete(a ? `#${a.n}` : `표 칸 ${i + 1}번째`, coord(a), coord(b));
    if (values.has(a.n) && b.text !== values.get(a.n)) throw incomplete(`#${a.n}`, values.get(a.n), b.text);
  }
  const expected = form.nodes.flatMap(node => {
    if (node.kind === 'heading') return [{ text: node.text }];
    if (node.kind !== 'field') return [];
    return (values.has(node.n) ? values.get(node.n).split('\n') : [node.text]).map(text => ({ text, n: node.n }));
  }).filter(x => x.text.trim());
  const actual = items.filter(i => i.kind === 'paragraph' && i.text.trim()).map(i => i.text);
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
    const x = expected[i];
    if (x?.text !== actual[i]) throw incomplete(x?.n ? `#${x.n}` : `본문 ${i + 1}번째 문단`, x?.text, actual[i]);
  }
}

// 값을 원본 새 사본에 기입하고 다시 읽어 확인한다 — 다르면 파일을 내주지 않고 어느 단위인지 알린다. 값이 없으면 원본 그대로 (FR-WB-092)
export function exportForm(form, original) {
  const result = data => ({ data, name: `${form.id}.${form.format}`, downloadName: form.fileName });
  const index = unitIndex(form);
  const values = new Map();
  const fills = Object.entries(form.values).map(([key, value]) => {
    const unit = index.get(Number(key));
    if (!unit) throw fail(409, `#${key} 은 이 양식에 없는 단위입니다`);
    if (lockOf(unit)) throw fail(409, `#${key} 은 잠긴 단위입니다(${lockOf(unit)})`); // 엔진은 잠긴 칸을 거절하지 않는다 — 채우면 중첩 표가 사라진다
    const text = lf(String(value));
    values.set(Number(key), text);
    const { node } = unit;
    return { unit: unit.kind === 'cell' ? { kind: 'cell', t: unit.t, r: unit.r, c: unit.c } : { kind: 'field', section: node.section, p: node.p, ...(node.after && { after: true }) }, text };
  });
  if (!fills.length) return result(original);
  const { fill, scan } = ENGINES[form.format];
  const data = fill(original, fills);
  verify(form, values, scan(data).items);
  return result(data);
}
