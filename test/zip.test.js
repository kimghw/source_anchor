// 빈 ZIP(EOCD 22B) → writeZip 으로 세 항목 만들기 → readZip 으로 읽기 → 한 항목 교체 → 나머지 바이트 동일·CRC 일치·mimetype 선두 저장
import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import { readZip, writeZip } from '../lib/zip.js';

const emptyZip = () => { const b = Buffer.alloc(22); b.writeUInt32LE(0x06054b50, 0); return b; };

test('writeZip: 만들기·교체·복사 보존', () => {
  const original = writeZip(emptyZip(), { mimetype: 'application/hwp+zip', 'Contents/section0.xml': '<a>old</a>', 'Contents/header.xml': '<h/>'.repeat(50) });
  const z1 = readZip(original);
  assert.deepEqual(z1.names, ['mimetype', 'Contents/section0.xml', 'Contents/header.xml']);
  assert.equal(original.readUInt16LE(8), 0); // 첫 항목(mimetype) 저장
  assert.equal(original.toString('utf8', 30, 38), 'mimetype');
  const out = writeZip(original, { 'Contents/section0.xml': '<a>NEW 값 &amp; 한글</a>' });
  const z2 = readZip(out);
  assert.deepEqual(z2.names, z1.names);
  assert.equal(z2.read('Contents/section0.xml').toString(), '<a>NEW 값 &amp; 한글</a>');
  assert.ok(z2.read('Contents/header.xml').equals(z1.read('Contents/header.xml')));
  assert.equal(z2.read('mimetype').toString(), 'application/hwp+zip');
  // 중앙 디렉터리의 CRC 가 실제 내용의 crc32 와 같다 (Word·한글은 CRC 를 검사한다)
  const dirAt = out.readUInt32LE(out.length - 22 + 16);
  const crcOfSecond = out.readUInt32LE(dirAt + 46 + 'mimetype'.length + 16);
  assert.equal(crcOfSecond, zlib.crc32(Buffer.from('<a>NEW 값 &amp; 한글</a>')));
});

test('writeZip: 암호화 항목은 거절', () => {
  const original = writeZip(emptyZip(), { 'a.txt': 'x' });
  const flagsAt = original.readUInt32LE(original.length - 22 + 16) + 8;
  original.writeUInt16LE(original.readUInt16LE(flagsAt) | 1, flagsAt);
  assert.throws(() => writeZip(original, { 'b.txt': 'y' }), /암호/);
});
