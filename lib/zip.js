// ZIP 파일에서 항목을 꺼낸다 — pptx 같은 Office 문서(OOXML)를 읽는 데 쓴다. 압축은 저장(0)과 deflate(8)만 다룬다.
// 읽지 못하는 파일은 사유를 담은 Error(format: true)를 던진다.
import zlib from 'node:zlib';

const MAX_ENTRY_BYTES = 30 * 1024 * 1024; // 항목 하나를 푼 크기의 상한 — 작게 압축해 둔 거대한 파일을 풀지 않는다
const END_RECORD = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

const fail = message => Object.assign(new Error(message), { format: true });

// 항목의 크기와 위치는 파일 끝의 목록(중앙 디렉터리)에서 읽는다 — 항목 앞의 머리말에는 크기가 비어 있을 수 있다
function readDirectory(data) {
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--) {
    if (data.readUInt32LE(i) === END_RECORD) { end = i; break; }
  }
  if (end < 0) throw fail('ZIP 구조를 찾지 못했습니다');
  const count = data.readUInt16LE(end + 10);
  let at = data.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) throw fail('4GB 를 넘는 ZIP(ZIP64)은 읽지 못합니다');
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (data.readUInt32LE(at) !== DIRECTORY_ENTRY) throw fail('ZIP 목록이 손상되었습니다');
    const nameLength = data.readUInt16LE(at + 28);
    entries.set(data.toString('utf8', at + 46, at + 46 + nameLength), {
      encrypted: Boolean(data.readUInt16LE(at + 8) & 1),
      method: data.readUInt16LE(at + 10),
      compressedSize: data.readUInt32LE(at + 20),
      size: data.readUInt32LE(at + 24),
      offset: data.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
  }
  return entries;
}

function readEntry(data, name, entry) {
  if (entry.encrypted) throw fail('암호가 걸린 파일입니다');
  if (entry.size > MAX_ENTRY_BYTES) throw fail(`안에 든 파일이 너무 큽니다 (${name})`);
  if (data.readUInt32LE(entry.offset) !== LOCAL_HEADER) throw fail('ZIP 항목이 손상되었습니다');
  const start = entry.offset + 30 + data.readUInt16LE(entry.offset + 26) + data.readUInt16LE(entry.offset + 28);
  const raw = data.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method !== 8) throw fail(`지원하지 않는 압축 방식입니다 (${entry.method})`);
  return zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
}

// 잘린 파일은 범위를 벗어난 읽기(RangeError)로, 깨진 압축은 zlib 오류로 드러난다 — 모두 "읽지 못하는 파일"이다
const guard = fn => {
  try {
    return fn();
  } catch (err) {
    throw err.format ? err : fail('ZIP 파일이 손상되었습니다');
  }
};

// → { names, has(name), read(name) → Buffer | null }
export function readZip(data) {
  const entries = guard(() => readDirectory(data));
  return {
    names: [...entries.keys()],
    has: name => entries.has(name),
    read: name => (entries.has(name) ? guard(() => readEntry(data, name, entries.get(name))) : null),
  };
}
