// lib/cfb.js — OLE 복합 문서(CFB) 읽기·쓰기 (FR-WB-090·FR-WB-092): createCfb → readCfb 왕복(mini·일반·중첩·빈·DIFAT), writeCfb 교체 보존, 오류, 실제 hwp·olefile 교차 확인
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCfb, readCfb, writeCfb } from '../lib/cfb.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REAL = path.join(ROOT, 'SSCB_산업기술혁신사업 연구개발계획서_한국선급_rev3.hwp');
const END = 0xFFFFFFFE;
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const digest = cfb => cfb.names.map(n => [n, cfb.read(n).length, sha(cfb.read(n))]).sort();
const hasOlefile = (() => {
  try { execFileSync('python', ['-I', '-c', 'import olefile'], { stdio: 'pipe' }); return true; } catch { return false; }
})();
// olefile 로 연 스트림 목록([경로, 크기, sha256] 정렬) — 독립 구현과 비교한다
const olefileDigest = buf => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-'));
  const file = path.join(dir, 'a.bin');
  try {
    fs.writeFileSync(file, buf);
    const py = 'import olefile,sys,hashlib,json\nole=olefile.OleFileIO(sys.argv[1])\nres=[]\nfor p in ole.listdir(streams=True,storages=False):\n n="/".join(p); d=ole.openstream(n).read(); res.append([n,len(d),hashlib.sha256(d).hexdigest()])\nprint(json.dumps(sorted(res)))';
    return JSON.parse(execFileSync('python', ['-I', '-c', py, file], { maxBuffer: 1 << 26 }).toString());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
// 디렉터리 항목들의 start·size 를 뺀 앞 116B(이름·종류·색·left/right/child·CLSID·상태·시각) — 머리글 DIFAT → FAT → 디렉터리 사슬을 따로 따라가 lib 와 독립적으로 읽는다
const entryHeads = buf => {
  const size = 1 << buf.readUInt16LE(30), fatCount = buf.readUInt32LE(44);
  const sector = n => buf.subarray((n + 1) * size, (n + 2) * size);
  const fatIds = [];
  for (let i = 0; i < 109 && fatIds.length < fatCount; i++) fatIds.push(buf.readUInt32LE(76 + i * 4));
  for (let d = buf.readUInt32LE(68); d !== END && fatIds.length < fatCount; d = sector(d).readUInt32LE(size - 4)) {
    for (let i = 0; i < size / 4 - 1 && fatIds.length < fatCount; i++) fatIds.push(sector(d).readUInt32LE(i * 4));
  }
  const fat = Buffer.concat(fatIds.map(sector));
  const parts = [];
  for (let n = buf.readUInt32LE(48); n < 0xFFFFFFFA; n = fat.readUInt32LE(n * 4)) parts.push(sector(n));
  const dir = Buffer.concat(parts);
  return Array.from({ length: dir.length / 128 }, (_, i) => dir.subarray(i * 128, i * 128 + 116).toString('hex'));
};

const big = crypto.randomBytes(7.5 * 1024 * 1024 | 0); // FAT 섹터 > 109 → DIFAT 섹터가 생긴다 (109 × 128 × 512B ≈ 7.1MB)
const fixture = {
  FileHeader: Buffer.alloc(256, 1), DocInfo: Buffer.alloc(4096, 3), 'BodyText/Section0': Buffer.alloc(5000, 2), 'BodyText/Section1': Buffer.from('tiny'),
  'BinData/BIN0001.png': big, 'A/B/C/deep': Buffer.alloc(4095, 4), Empty: Buffer.alloc(0), '\x05HwpSummaryInformation': Buffer.alloc(461, 5),
};

test('createCfb → readCfb: mini·일반·중첩·빈 스트림 왕복, 형제 정렬 순서, DIFAT 섹터', () => {
  const buf = createCfb(fixture);
  assert.equal(buf.length % 512, 0);
  assert.equal(buf.readUInt16LE(26), 3);
  assert.equal(buf.readUInt32LE(56), 4096);
  assert.ok(buf.readUInt32LE(44) > 109, 'FAT 섹터가 109개를 넘는다');
  assert.equal(buf.readUInt32LE(72), 1, 'DIFAT 섹터 1개');
  assert.notEqual(buf.readUInt32LE(68), END);
  const cfb = readCfb(buf);
  // 저장소마다 형제를 CFB 규칙(길이 → 대문자)으로 정렬: A(1) Empty(5) BinData·DocInfo(7) BodyText(8) FileHeader(10) \x05Hwp…(23)
  assert.deepEqual(cfb.names, ['A/B/C/deep', 'Empty', 'BinData/BIN0001.png', 'DocInfo', 'BodyText/Section0', 'BodyText/Section1', 'FileHeader', '\x05HwpSummaryInformation']);
  for (const [name, body] of Object.entries(fixture)) assert.ok(cfb.read(name).equals(body), name);
  assert.equal(cfb.has('BodyText'), false);
  assert.equal(cfb.read('없음'), null);
  // 루트 항목: 종류 5, CLSID 0, 시각 0, mini stream 은 64B 단위로 채운 크기
  const [root] = entryHeads(buf);
  assert.equal(root.slice(66 * 2, 67 * 2), '05');
  assert.equal(root.slice(80 * 2, 116 * 2), '0'.repeat(72));
  const rootSize = buf.readUInt32LE((buf.readUInt32LE(48) + 1) * 512 + 120);
  assert.equal(rootSize, 64 * (4 + 1 + 64 + 8)); // 4096B 미만만 mini: FileHeader 256 · Section1 4 · deep 4095 · HwpSummary 461 (DocInfo 4096·Section0 5000 은 일반)
});

test('createCfb: 형제 정렬은 길이 먼저, 같으면 대문자 비교 — 대소문자가 달라도 같은 이름은 거절', () => {
  const cfb = readCfb(createCfb({ b: Buffer.from('1'), A: Buffer.from('2'), aa: Buffer.from('3'), B2: Buffer.from('4'), 'S/x': Buffer.from('5'), 'S/Y/z': Buffer.from('6') }));
  assert.deepEqual(cfb.names, ['A', 'b', 'S/x', 'S/Y/z', 'aa', 'B2']);
  assert.throws(() => createCfb({ 'S/x': Buffer.from('1'), S: Buffer.from('2') }), /겹칩니다/);
  assert.throws(() => createCfb({ '': Buffer.from('1') }), /이름/);
});

test('createCfb: v4(4096B 섹터) 도 왕복한다', () => {
  const buf = createCfb(fixture, { version: 4 });
  assert.equal(buf.length % 4096, 0);
  assert.equal(buf.readUInt16LE(26), 4);
  assert.equal(buf.readUInt16LE(30), 12);
  assert.ok(buf.readUInt32LE(40) > 0, 'v4 는 디렉터리 섹터 수를 적는다');
  assert.equal(buf.readUInt32LE(72), 0, 'v4 는 FAT 2개면 DIFAT 섹터가 없다');
  const cfb = readCfb(buf);
  assert.deepEqual(cfb.names, readCfb(createCfb(fixture)).names);
  for (const [name, body] of Object.entries(fixture)) assert.ok(cfb.read(name).equals(body), name);
});

test('writeCfb: 바꾼 스트림만 바뀌고 나머지 바이트·이름 순서·디렉터리 항목은 그대로 — mini ↔ 일반 경계를 넘나든다', () => {
  const original = createCfb(fixture);
  const before = readCfb(original);
  const replace = {
    'BodyText/Section1': Buffer.alloc(9000, 9), // mini → 일반
    'BodyText/Section0': Buffer.from('small now'), // mini → mini(크기 다름)
    DocInfo: Buffer.from('shrunk'), // 일반 → mini
    Empty: Buffer.from('x'), // 빈 → mini
    'BinData/BIN0001.png': Buffer.alloc(0), // 일반(DIFAT) → 빈
  };
  const out = writeCfb(original, replace);
  assert.equal(out.length % 512, 0);
  assert.equal(out.readUInt32LE(72), 0, '큰 스트림이 없어져 DIFAT 섹터도 없다');
  const after = readCfb(out);
  assert.deepEqual(after.names, before.names);
  for (const [name, body] of Object.entries(replace)) assert.ok(after.read(name).equals(body), name);
  for (const name of before.names) if (!(name in replace)) assert.ok(after.read(name).equals(before.read(name)), name);
  assert.deepEqual(entryHeads(out), entryHeads(original)); // 이름·종류·left/right/child·CLSID 는 raw 그대로
  assert.equal(entryHeads(out).length, 16); // 루트 + 저장소 5(BodyText·BinData·A·B·C) + 스트림 8 = 14, 섹터 채움 2
  // 다시 키우기 (mini → 일반, 빈 → 일반(DIFAT))
  const back = readCfb(writeCfb(out, { 'BinData/BIN0001.png': big, DocInfo: fixture.DocInfo }));
  assert.ok(back.read('BinData/BIN0001.png').equals(big));
  assert.ok(back.read('DocInfo').equals(fixture.DocInfo));
  assert.ok(back.read('BodyText/Section1').equals(replace['BodyText/Section1']));
  assert.deepEqual(back.names, before.names);
});

test('writeCfb: 없는 경로는 throw, 빈 교체는 같은 내용', () => {
  const original = createCfb({ a: Buffer.from('1'), 'S/b': Buffer.from('2') });
  assert.throws(() => writeCfb(original, { 'S/c': Buffer.from('3') }), /없는 스트림입니다: S\/c/);
  assert.throws(() => writeCfb(original, { S: Buffer.from('3') }), /없는 스트림/);
  const same = readCfb(writeCfb(original, {}));
  assert.deepEqual(same.names, ['a', 'S/b']);
  assert.equal(same.read('S/b').toString(), '2');
});

test('readCfb: 서명 아님·머리글 이상·잘린 파일은 format 오류', () => {
  for (const bad of [Buffer.alloc(0), Buffer.from('PK\x03\x04'), Buffer.alloc(600), Buffer.from('HWP Document File'.padEnd(600))]) {
    assert.throws(() => readCfb(bad), err => err.format === true && /OLE 복합 문서가 아닙니다/.test(err.message));
  }
  const good = createCfb({ a: Buffer.from('1') });
  const badOrder = Buffer.from(good);
  badOrder.writeUInt16LE(0xFEFF, 28);
  assert.throws(() => readCfb(badOrder), err => err.format === true && /머리글/.test(err.message));
  const truncated = createCfb(fixture).subarray(0, 4000);
  assert.throws(() => readCfb(truncated).read('BinData/BIN0001.png'), err => err.format === true && /손상/.test(err.message));
  assert.throws(() => writeCfb(truncated, {}), err => err.format === true);
});

(fs.existsSync(REAL) ? test : test.skip)('실제 hwp: 읽기 → writeCfb(빈 교체) → 재읽기에서 모든 스트림 바이트·이름 순서 동일, 교체는 다른 스트림을 건드리지 않는다', () => {
  const data = fs.readFileSync(REAL);
  assert.equal(data.readUInt16LE(26), 3);
  const a = readCfb(data);
  assert.equal(a.names.length, 20);
  assert.equal(a.read('FileHeader').length, 256);
  assert.equal(a.read('FileHeader').toString('latin1', 0, 17), 'HWP Document File');
  assert.equal(a.read('BodyText/Section2').length, 145631);
  assert.equal(a.read('\x05HwpSummaryInformation').length, 461);
  assert.ok(a.names.filter(n => n.startsWith('BinData/')).length === 9);
  const out = writeCfb(data, {});
  assert.equal(out.length % 512, 0);
  assert.equal(out.readUInt32LE(72), 1, 'FAT 섹터 > 109 → DIFAT 1');
  const b = readCfb(out);
  assert.deepEqual(b.names, a.names);
  for (const name of a.names) assert.ok(a.read(name).equals(b.read(name)), name);
  assert.deepEqual(entryHeads(out), entryHeads(data)); // 항목 순서·이름·종류·left/right/child·CLSID·상태·시각 raw 그대로
  assert.equal(entryHeads(data).length, 28); // 디렉터리 항목 28 = 루트 + 저장소 4 + 스트림 20 + 안 쓰는 항목 3
  assert.equal(entryHeads(data).filter(h => h.slice(132, 134) !== '00').length, 25);
  const section = Buffer.concat([a.read('BodyText/Section2'), Buffer.alloc(1000, 7)]);
  const c = readCfb(writeCfb(data, { 'BodyText/Section2': section, PrvText: Buffer.from('hello') }));
  assert.deepEqual(c.names, a.names);
  assert.ok(c.read('BodyText/Section2').equals(section));
  assert.equal(c.read('PrvText').toString(), 'hello');
  for (const name of a.names) if (name !== 'BodyText/Section2' && name !== 'PrvText') assert.ok(a.read(name).equals(c.read(name)), name);
});

(hasOlefile ? test : test.skip)('olefile(독립 구현) 로 연 스트림 목록·바이트가 우리 읽기와 같다 — 만든 파일·교체한 파일·실제 hwp 를 다시 쓴 파일', () => {
  const created = createCfb(fixture);
  assert.deepEqual(olefileDigest(created), digest(readCfb(created)));
  const replaced = writeCfb(created, { 'BodyText/Section1': Buffer.alloc(9000, 9), DocInfo: Buffer.from('shrunk'), Empty: Buffer.from('x') });
  assert.deepEqual(olefileDigest(replaced), digest(readCfb(replaced)));
  const v4 = createCfb({ a: Buffer.from('1'), 'S/b': Buffer.alloc(5000, 2) }, { version: 4 });
  assert.deepEqual(olefileDigest(v4), digest(readCfb(v4)));
  if (fs.existsSync(REAL)) {
    const data = fs.readFileSync(REAL);
    const rewritten = writeCfb(data, { PrvText: Buffer.from('hello') });
    assert.deepEqual(olefileDigest(rewritten), digest(readCfb(rewritten)));
    assert.deepEqual(olefileDigest(rewritten).filter(([n]) => n !== 'PrvText'), olefileDigest(data).filter(([n]) => n !== 'PrvText'));
  }
});

// 검토에서 확인한 사례들 — 머리글의 큰 섹터 수(메모리 고갈), 64 의 배수가 아닌 mini stream, 트리가 닿지 않는 항목
const dirOffset = buf => (buf.readUInt32LE(48) + 1) * (1 << buf.readUInt16LE(30));

test('readCfb: FAT·DIFAT·mini FAT 섹터 수가 파일의 섹터 수를 넘으면 형식 오류 — 2.5KB 파일의 큰 수를 믿고 FAT 을 모으지 않는다', () => {
  for (const [at, name] of [[44, 'FAT'], [72, 'DIFAT'], [64, 'mini FAT']]) {
    const buf = createCfb({ a: Buffer.alloc(10, 1) });
    buf.writeUInt32LE(100_000_000, at);
    assert.throws(() => readCfb(buf), err => err.format && /섹터 수/.test(err.message), name);
  }
});

test('readCfb: 루트 크기가 64 의 배수가 아니어도 마지막 mini 섹터의 스트림을 읽는다 (olefile·ole32 와 같다)', () => {
  const buf = createCfb({ a: Buffer.alloc(448, 7), b: Buffer.alloc(44, 9) });
  const root = dirOffset(buf);
  assert.equal(buf.readUInt32LE(root + 120), 512);
  buf.writeUInt32LE(492, root + 120); // 448 + 44 — 마지막 mini 섹터가 잘려 있다
  const cfb = readCfb(buf);
  assert.deepEqual([cfb.read('a').length, cfb.read('b').length, cfb.read('b')[0]], [448, 44, 9]);
  assert.deepEqual(readCfb(writeCfb(buf, {})).names, ['a', 'b']);
});

test('writeCfb: 트리가 닿지 않는 스트림 항목은 낡은 사슬을 읽지 않고 비운다 — readCfb 가 여는 파일은 writeCfb 도 쓴다', () => {
  const buf = createCfb({ a: Buffer.alloc(10, 1), b: Buffer.alloc(20, 2) });
  const orphan = dirOffset(buf) + 128 * 3; // 쓰지 않는 네 번째 항목
  buf[orphan + 66] = 2;
  buf.writeUInt32LE(5000, orphan + 116);
  buf.writeUInt32LE(100, orphan + 120);
  assert.deepEqual(readCfb(buf).names, ['a', 'b']);
  const out = writeCfb(buf, { a: Buffer.alloc(3000, 4) });
  const cfb = readCfb(out);
  assert.deepEqual([cfb.names, cfb.read('a').length, cfb.read('b')[0]], [['a', 'b'], 3000, 2]);
  assert.deepEqual([out.readUInt32LE(dirOffset(out) + 128 * 3 + 116), out.readUInt32LE(dirOffset(out) + 128 * 3 + 120)], [END, 0]);
});
