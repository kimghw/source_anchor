// 구조 검사 — CLAUDE.md "파일 크기 상한": 소스 파일 1,200줄 초과 금지, 최상위 import 순환 0. public/vendor 는 제3자 코드라 제외한다
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAX_LINES = 1200;

function sourceFiles(dir = ROOT) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', 'workspace', '.git', 'test', 'vendor'].includes(entry.name)) return [];
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.(js|css|html)$/.test(entry.name) ? [file] : [];
  });
}

test(`소스 파일은 ${MAX_LINES}줄을 넘지 않는다`, () => {
  const over = sourceFiles()
    .map(file => [path.relative(ROOT, file), fs.readFileSync(file, 'utf8').split('\n').length])
    .filter(([, lines]) => lines > MAX_LINES);
  assert.deepEqual(over, []);
});

test('최상위 import 에 순환이 없다', () => {
  const graph = new Map();
  for (const file of sourceFiles().filter(f => f.endsWith('.js'))) {
    const imports = [...fs.readFileSync(file, 'utf8').matchAll(/^import\s[^'"]*['"](\.[^'"]+)['"]/gm)].map(m => path.resolve(path.dirname(file), m[1]));
    graph.set(file, imports);
  }
  const state = new Map(); // 1: 방문 중, 2: 끝
  const cycles = [];
  const visit = (file, trail) => {
    if (state.get(file) === 2) return;
    if (state.get(file) === 1) return cycles.push([...trail.slice(trail.indexOf(file)), file].map(f => path.relative(ROOT, f)).join(' → '));
    state.set(file, 1);
    for (const next of graph.get(file) || []) visit(next, [...trail, file]);
    state.set(file, 2);
  };
  for (const file of graph.keys()) visit(file, []);
  assert.deepEqual(cycles, []);
});
