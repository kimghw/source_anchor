// 문법 검사 — 서버·lib·화면 스크립트가 파싱되지 않으면(예: 정규식 역슬래시 누락) 서버 전체가 죽는다. node --check 로 막는다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKIP = new Set(['node_modules', 'workspace', '.git', 'test']);
const jsIn = (dir, deep) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const file = path.join(dir, e.name);
  if (e.isDirectory()) return deep && !SKIP.has(e.name) ? jsIn(file, deep) : [];
  return e.name.endsWith('.js') ? [file] : [];
});
const files = [...jsIn(ROOT, false), ...jsIn(path.join(ROOT, 'lib'), true), ...jsIn(path.join(ROOT, 'public', 'js'), true), ...jsIn(path.join(ROOT, 'public', 'shared'), true)];

for (const file of files) {
  test(`문법: ${path.relative(ROOT, file)}`, () => {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
      assert.fail(`${path.relative(ROOT, file)} 문법 오류\n${err.stderr}`);
    }
  });
}
