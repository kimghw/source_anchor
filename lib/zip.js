// ZIP 파일을 읽고, 항목을 바꿔 다시 쓴다 — pptx·hwpx 같은 Office 문서(OOXML)를 다루는 데 쓴다. 압축은 저장(0)과 deflate(8)만 다룬다.
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
      flags: data.readUInt16LE(at + 8),
      encrypted: Boolean(data.readUInt16LE(at + 8) & 1),
      method: data.readUInt16LE(at + 10),
      dosTime: data.readUInt32LE(at + 12), // 시각(하위 16비트)과 날짜(상위 16비트)
      crc: data.readUInt32LE(at + 16),
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

// replace 의 항목은 새 내용으로(mimetype 은 저장, 그 밖은 deflate), 나머지는 압축된 바이트를 그대로 옮긴다. 항목 순서는 원본 그대로, 새 이름은 뒤에 붙는다.
export function writeZip(data, replace) {
  return guard(() => {
    const entries = readDirectory(data);
    const parts = [], directory = [];
    let offset = 0;
    const put = (name, { method, flags, dosTime, crc, body, size }) => {
      const nameBytes = Buffer.from(name);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(LOCAL_HEADER, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(flags & ~0x8, 6); // 데이터 설명자(3번 비트)는 쓰지 않는다 — 크기를 머리말에 바로 적는다
      local.writeUInt16LE(method, 8);
      local.writeUInt32LE(dosTime, 10);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(size, 22);
      local.writeUInt16LE(nameBytes.length, 26);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(DIRECTORY_ENTRY, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      local.copy(central, 8, 6, 30); // 플래그 … 이름 길이: 두 머리말에서 같은 순서
      central.writeUInt32LE(offset, 42);
      parts.push(local, nameBytes, body);
      directory.push(central, nameBytes);
      offset += local.length + nameBytes.length + body.length;
    };
    const names = [...entries.keys(), ...Object.keys(replace).filter(n => !entries.has(n))];
    for (const name of names) {
      const old = entries.get(name);
      if (old?.encrypted) throw fail('암호가 걸린 파일입니다');
      if (Object.hasOwn(replace, name)) {
        const raw = Buffer.from(replace[name]);
        const method = name === 'mimetype' ? 0 : 8;
        put(name, { method, flags: 0x0800, dosTime: old?.dosTime ?? 0, crc: zlib.crc32(raw), body: method ? zlib.deflateRawSync(raw) : raw, size: raw.length });
      } else {
        if (data.readUInt32LE(old.offset) !== LOCAL_HEADER) throw fail('ZIP 항목이 손상되었습니다');
        const start = old.offset + 30 + data.readUInt16LE(old.offset + 26) + data.readUInt16LE(old.offset + 28);
        put(name, { ...old, body: data.subarray(start, start + old.compressedSize) });
      }
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_RECORD, 0);
    end.writeUInt16LE(names.length, 8);
    end.writeUInt16LE(names.length, 10);
    end.writeUInt32LE(directory.reduce((n, b) => n + b.length, 0), 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, ...directory, end]);
  });
}
