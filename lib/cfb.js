// OLE2 복합 문서(CFB, Compound File Binary) 를 읽고, 스트림을 바꿔 다시 쓴다 — 한글 5.0 바이너리(hwp) 같은 OLE 컨테이너를 다루는 데 쓴다 (FR-WB-090·FR-WB-092).
// 섹터 n 은 파일의 (n+1)·섹터 크기 자리에 있고(머리글이 섹터 −1), v3 는 512B·v4 는 4096B 섹터. 4096B 미만 스트림은 루트 항목이 품은 mini stream(64B 섹터) 에 산다.
// 읽지 못하는 파일은 사유를 담은 Error(format: true)를 던진다.

const SIGNATURE = Buffer.from('d0cf11e0a1b11ae1', 'hex');
const HEADER_SIZE = 512;
const HEADER_DIFAT = 109; // 머리글에 든 DIFAT 항목 수 — FAT 섹터가 이보다 많으면 DIFAT 섹터로 잇는다
const ENTRY_SIZE = 128;
const MINI_SHIFT = 6, MINI_SIZE = 64, MINI_CUTOFF = 4096;
const END_OF_CHAIN = 0xFFFFFFFE, FREE = 0xFFFFFFFF, FAT_SECTOR = 0xFFFFFFFD, DIFAT_SECTOR = 0xFFFFFFFC;
const MAX_REGULAR = 0xFFFFFFFA; // 이보다 크면 섹터 번호가 아니라 표식이다
const NO_STREAM = 0xFFFFFFFF;
const TYPE = { unused: 0, storage: 1, stream: 2, root: 5 };
const MAX_STREAM_BYTES = 64 * 1024 * 1024; // 스트림 하나의 상한 — 크기 칸이 깨진 파일을 통째로 풀지 않는다

const fail = message => Object.assign(new Error(message), { format: true });
const corrupt = detail => fail(`OLE 복합 문서가 손상되었습니다 (${detail})`);
const ceilDiv = (n, d) => Math.ceil(n / d);

// 잘린 파일은 범위를 벗어난 읽기(RangeError)로 드러난다 — "읽지 못하는 파일"로 바꿔 던진다
const guard = fn => {
  try {
    return fn();
  } catch (err) {
    throw err.format ? err : corrupt(err.message);
  }
};

// ── 읽기 ──────────────────────────────────────────────────────────────────

function readHeader(data) {
  if (data.length < HEADER_SIZE || !data.subarray(0, 8).equals(SIGNATURE)) throw fail('OLE 복합 문서가 아닙니다 — 서명이 다릅니다');
  const version = data.readUInt16LE(26);
  const sectorShift = data.readUInt16LE(30);
  if (data.readUInt16LE(28) !== 0xFFFE || ![3, 4].includes(version) || sectorShift !== (version === 3 ? 9 : 12) || data.readUInt16LE(32) !== MINI_SHIFT) {
    throw fail('OLE 복합 문서가 아닙니다 — 머리글이 이상합니다');
  }
  return {
    version, sectorSize: 1 << sectorShift, clsid: data.subarray(8, 24),
    fatCount: data.readUInt32LE(44), dirStart: data.readUInt32LE(48), miniCutoff: data.readUInt32LE(56),
    miniFatStart: data.readUInt32LE(60), miniFatCount: data.readUInt32LE(64), difatStart: data.readUInt32LE(68), difatCount: data.readUInt32LE(72),
  };
}

// FAT 섹터 번호들: 머리글의 109개 → DIFAT 섹터들(마지막 항목이 다음 DIFAT 섹터)
function fatSectors(data, h, sector) {
  const out = [];
  for (let i = 0; i < HEADER_DIFAT && out.length < h.fatCount; i++) out.push(data.readUInt32LE(76 + i * 4));
  const perSector = h.sectorSize / 4 - 1;
  for (let at = h.difatStart, n = 0; at < MAX_REGULAR && out.length < h.fatCount; n++) {
    if (n >= h.difatCount) throw corrupt('DIFAT 사슬');
    const s = sector(at);
    for (let i = 0; i < perSector && out.length < h.fatCount; i++) out.push(s.readUInt32LE(i * 4));
    at = s.readUInt32LE(perSector * 4);
  }
  if (out.some(n => n >= MAX_REGULAR)) throw corrupt('FAT 자리');
  return out;
}

// 사슬 따라가기 — 표식(END_OF_CHAIN 등)에서 멈추고, 전체 섹터 수를 넘으면 고리다
function chainOf(start, next, total) {
  const out = [];
  for (let n = start; n < MAX_REGULAR; n = next(n)) {
    if (n >= total || out.length > total) throw corrupt('섹터 사슬');
    out.push(n);
  }
  return out;
}

function parse(data) {
  const h = readHeader(data);
  const { sectorSize } = h;
  const total = Math.max(0, ceilDiv(data.length, sectorSize) - 1);
  // FAT·DIFAT·mini FAT 섹터 수는 파일의 섹터 수를 넘을 수 없다 — 머리글의 큰 수를 믿고 FAT 을 모으면 2.5KB 파일로도 메모리가 바닥난다(잡을 수 없는 OOM)
  if (h.fatCount > total || h.difatCount > total || h.miniFatCount > total) throw corrupt('섹터 수');
  const sector = n => {
    if (n >= total) throw corrupt(`섹터 ${n}`);
    return data.subarray((n + 1) * sectorSize, (n + 2) * sectorSize);
  };
  const fat = Buffer.concat(fatSectors(data, h, sector).map(sector));
  const next = n => (n * 4 + 4 <= fat.length ? fat.readUInt32LE(n * 4) : END_OF_CHAIN);
  const chain = start => chainOf(start, next, total);
  const readChain = (start, size) => Buffer.concat(chain(start).map(sector)).subarray(0, size);

  const dirData = Buffer.concat(chain(h.dirStart).map(sector));
  const entries = [];
  for (let o = 0; o + ENTRY_SIZE <= dirData.length; o += ENTRY_SIZE) {
    const nameLength = Math.min(64, dirData.readUInt16LE(o + 64));
    entries.push({
      raw: dirData.subarray(o, o + ENTRY_SIZE),
      name: nameLength >= 2 ? dirData.toString('utf16le', o, o + nameLength - 2) : '',
      type: dirData[o + 66], left: dirData.readUInt32LE(o + 68), right: dirData.readUInt32LE(o + 72), child: dirData.readUInt32LE(o + 76),
      start: dirData.readUInt32LE(o + 116), size: dirData.readUInt32LE(o + 120), // v3 는 상위 4B 에 쓰레기가 들어 있을 수 있어 하위 32비트만 쓴다
    });
    if (h.version === 4 && dirData.readUInt32LE(o + 124)) throw fail('4GB 를 넘는 스트림은 읽지 못합니다');
  }
  if (!entries.length || entries[0].type !== TYPE.root) throw corrupt('루트 항목');

  // mini stream 은 루트 항목의 사슬에, mini FAT 은 머리글이 가리키는 사슬에 있다 — 둘 다 없을 수 있다
  const root = entries[0];
  const miniStream = root.size && root.start < MAX_REGULAR ? readChain(root.start, root.size) : Buffer.alloc(0);
  const miniFat = h.miniFatCount && h.miniFatStart < MAX_REGULAR ? Buffer.concat(chain(h.miniFatStart).map(sector)) : Buffer.alloc(0);
  const miniNext = n => (n * 4 + 4 <= miniFat.length ? miniFat.readUInt32LE(n * 4) : END_OF_CHAIN);
  const miniTotal = ceilDiv(miniStream.length, MINI_SIZE); // 루트 크기가 64 의 배수가 아니면 마지막 mini 섹터가 잘려 있다 — olefile·ole32 처럼 그 섹터도 읽는다
  const readMini = (start, size) => Buffer.concat(chainOf(start, miniNext, miniTotal).map(n => miniStream.subarray(n * MINI_SIZE, (n + 1) * MINI_SIZE))).subarray(0, size);

  const content = e => {
    if (e.size > MAX_STREAM_BYTES) throw fail(`안에 든 스트림이 너무 큽니다 (${e.name})`);
    if (!e.size) return Buffer.alloc(0);
    const out = e.size < h.miniCutoff ? readMini(e.start, e.size) : readChain(e.start, e.size);
    if (out.length !== e.size) throw corrupt(`스트림 ${e.name}`);
    return out;
  };

  // 트리 순회(left → self → child → right) 로 경로를 매긴다 — 안 쓰는 항목은 건너뛰고, 고리·범위 밖은 손상
  const streams = new Map();
  const seen = new Set();
  const walk = (i, prefix) => {
    if (i === NO_STREAM) return;
    if (i >= entries.length || seen.has(i)) throw corrupt('디렉터리 트리');
    seen.add(i);
    const e = entries[i];
    if (e.type === TYPE.unused) return;
    walk(e.left, prefix);
    if (e.type === TYPE.stream) streams.set(prefix + e.name, e);
    if (e.type === TYPE.storage) walk(e.child, `${prefix}${e.name}/`);
    walk(e.right, prefix);
  };
  walk(root.child, '');
  return { ...h, entries, streams, content };
}

// → { names, has(path), read(path) → Buffer | null } — 경로는 저장소 이름을 '/' 로 잇는다 ('BodyText/Section0')
export function readCfb(data) {
  const cfb = guard(() => parse(data));
  return {
    names: [...cfb.streams.keys()],
    has: path => cfb.streams.has(path),
    read: path => (cfb.streams.has(path) ? guard(() => cfb.content(cfb.streams.get(path))) : null),
  };
}

// ── 쓰기 ──────────────────────────────────────────────────────────────────

// 디렉터리 항목(raw 128B 유지) 과 스트림 내용으로 파일 전체를 다시 배치한다. 항목 순서·트리·이름·CLSID·상태·시각은 raw 그대로, start·size 만 다시 쓴다.
// 섹터 순서: FAT → DIFAT → 디렉터리 → mini FAT → mini stream → 큰 스트림(항목 순서). FAT 크기는 FAT·DIFAT 섹터까지 세어 수렴할 때까지 다시 센다.
function build({ version, sectorSize, clsid }, entries, contentOf) {
  const perFat = sectorSize / 4, perDifat = perFat - 1;
  const dir = Buffer.concat(entries.map(e => Buffer.from(e.raw)));
  const place = new Map(); // 항목 index → { start, size }
  const minis = [], bigs = [];
  for (const [i, e] of entries.entries()) {
    if (e.type !== TYPE.stream) continue;
    const body = contentOf(e, i);
    place.set(i, { start: END_OF_CHAIN, size: body.length });
    if (body.length) (body.length < MINI_CUTOFF ? minis : bigs).push({ i, body });
  }

  // mini stream·mini FAT
  const miniParts = [];
  const miniFatEntries = [];
  for (const m of minis) {
    const count = ceilDiv(m.body.length, MINI_SIZE);
    place.get(m.i).start = miniFatEntries.length;
    for (let k = 1; k < count; k++) miniFatEntries.push(miniFatEntries.length + 1);
    miniFatEntries.push(END_OF_CHAIN);
    miniParts.push(m.body, Buffer.alloc(count * MINI_SIZE - m.body.length));
  }
  const miniStream = Buffer.concat(miniParts);
  const miniFatSectors = ceilDiv(miniFatEntries.length, perFat);
  const miniFat = Buffer.alloc(miniFatSectors * sectorSize, 0xFF);
  miniFatEntries.forEach((v, k) => miniFat.writeUInt32LE(v, k * 4));
  place.set(0, { start: END_OF_CHAIN, size: miniStream.length });

  // 일반 섹터 덩어리 — 디렉터리는 섹터 단위로 "안 쓰는 항목"으로 채운다
  const dirSectors = ceilDiv(dir.length, sectorSize) || 1;
  const dirPadded = Buffer.alloc(dirSectors * sectorSize);
  dir.copy(dirPadded);
  for (let o = dir.length; o < dirPadded.length; o += ENTRY_SIZE) dirPadded.fill(0xFF, o + 68, o + 80);
  const chunks = [{ key: 'dir', body: dirPadded }];
  if (miniFatSectors) chunks.push({ key: 'miniFat', body: miniFat });
  if (miniStream.length) chunks.push({ key: 0, body: miniStream });
  for (const b of bigs) chunks.push({ key: b.i, body: b.body });
  const dataSectors = chunks.reduce((n, c) => n + ceilDiv(c.body.length, sectorSize), 0);
  let fatCount = 0, difatCount = 0;
  for (;;) {
    const needFat = ceilDiv(dataSectors + fatCount + difatCount, perFat);
    const needDifat = needFat > HEADER_DIFAT ? ceilDiv(needFat - HEADER_DIFAT, perDifat) : 0;
    if (needFat === fatCount && needDifat === difatCount) break;
    fatCount = needFat; difatCount = needDifat;
  }

  // FAT: FAT 섹터·DIFAT 섹터 표식 → 덩어리마다 사슬 → 나머지 FREE
  const fat = Buffer.alloc(fatCount * sectorSize, 0xFF);
  const setFat = (n, v) => fat.writeUInt32LE(v, n * 4);
  for (let n = 0; n < fatCount; n++) setFat(n, FAT_SECTOR);
  for (let n = 0; n < difatCount; n++) setFat(fatCount + n, DIFAT_SECTOR);
  const starts = new Map();
  let at = fatCount + difatCount;
  for (const c of chunks) {
    const count = ceilDiv(c.body.length, sectorSize);
    starts.set(c.key, at);
    for (let k = 0; k < count; k++) setFat(at + k, k + 1 < count ? at + k + 1 : END_OF_CHAIN);
    at += count;
  }
  for (const [i, p] of place) if (starts.has(i)) p.start = starts.get(i);

  // DIFAT 섹터: 110번째 FAT 섹터부터 perDifat 개씩, 마지막 항목은 다음 DIFAT 섹터(끝은 END_OF_CHAIN)
  const difat = Buffer.alloc(difatCount * sectorSize, 0xFF);
  for (let d = 0; d < difatCount; d++) {
    for (let k = 0; k < perDifat; k++) {
      const n = HEADER_DIFAT + d * perDifat + k;
      if (n < fatCount) difat.writeUInt32LE(n, d * sectorSize + k * 4);
    }
    difat.writeUInt32LE(d + 1 < difatCount ? fatCount + d + 1 : END_OF_CHAIN, (d + 1) * sectorSize - 4);
  }

  // 디렉터리 항목의 start·size (size 는 64비트 자리지만 상위 4B 는 0)
  for (const [i, p] of place) {
    dirPadded.writeUInt32LE(p.start, i * ENTRY_SIZE + 116);
    dirPadded.writeUInt32LE(p.size, i * ENTRY_SIZE + 120);
    dirPadded.writeUInt32LE(0, i * ENTRY_SIZE + 124);
  }

  const header = Buffer.alloc(sectorSize, 0xFF); // 머리글 DIFAT 의 빈 자리는 FREE
  header.fill(0, 0, 76);
  SIGNATURE.copy(header, 0);
  clsid.copy(header, 8);
  header.writeUInt16LE(0x3E, 24);
  header.writeUInt16LE(version, 26);
  header.writeUInt16LE(0xFFFE, 28);
  header.writeUInt16LE(version === 3 ? 9 : 12, 30);
  header.writeUInt16LE(MINI_SHIFT, 32);
  header.writeUInt32LE(version === 4 ? dirSectors : 0, 40);
  header.writeUInt32LE(fatCount, 44);
  header.writeUInt32LE(starts.get('dir'), 48);
  header.writeUInt32LE(MINI_CUTOFF, 56);
  header.writeUInt32LE(miniFatSectors ? starts.get('miniFat') : END_OF_CHAIN, 60);
  header.writeUInt32LE(miniFatSectors, 64);
  header.writeUInt32LE(difatCount ? fatCount : END_OF_CHAIN, 68);
  header.writeUInt32LE(difatCount, 72);
  for (let n = 0; n < Math.min(fatCount, HEADER_DIFAT); n++) header.writeUInt32LE(n, 76 + n * 4);
  header.fill(0, HEADER_SIZE); // v4 는 머리글 뒤 나머지가 0

  // 덩어리마다 섹터 경계에 맞춰 놓는다 — 마지막 섹터도 꽉 채운다
  const file = Buffer.alloc((1 + fatCount + difatCount + dataSectors) * sectorSize);
  let o = 0;
  for (const p of [header, fat, difat, ...chunks.map(c => c.body)]) o += ceilDiv(p.copy(file, o), sectorSize) * sectorSize;
  return file;
}

// replace = { 'BodyText/Section2': Buffer, … } — 바꾸지 않은 스트림의 바이트·이름·항목 순서·트리는 그대로, 섹터 배치만 다시 한다. 없는 경로는 throw.
export function writeCfb(data, replace) {
  const cfb = guard(() => parse(data));
  for (const path of Object.keys(replace)) if (!cfb.streams.has(path)) throw new Error(`없는 스트림입니다: ${path}`);
  const byEntry = new Map([...cfb.streams].map(([path, e]) => [e, path]));
  return build(cfb, cfb.entries, e => {
    const path = byEntry.get(e);
    if (path === undefined) return Buffer.alloc(0); // 트리가 닿지 않는 스트림 항목 — 어느 판독기도 보지 않으므로 낡은 사슬을 읽지 않고 비운다
    return path in replace ? Buffer.from(replace[path]) : guard(() => cfb.content(e));
  });
}

// 형제 정렬 — CFB 규칙: UTF-16 길이 먼저, 같으면 대문자로 바꾼 코드 유닛 비교
function compareNames(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  const ua = a.toUpperCase(), ub = b.toUpperCase();
  for (let i = 0; i < ua.length; i++) if (ua.charCodeAt(i) !== ub.charCodeAt(i)) return ua.charCodeAt(i) - ub.charCodeAt(i);
  return 0;
}

function entryOf(name, type) {
  const raw = Buffer.alloc(ENTRY_SIZE);
  const utf16 = Buffer.from(name, 'utf16le');
  if (!utf16.length || utf16.length > 62) throw new Error(`저장소·스트림 이름이 비었거나 31자를 넘습니다: ${name}`);
  utf16.copy(raw);
  raw.writeUInt16LE(utf16.length + 2, 64);
  raw[66] = type;
  raw[67] = 1; // 검정 — 모두 검정인 트리도 올바른 트리다
  raw.fill(0xFF, 68, 80);
  raw.writeUInt32LE(type === TYPE.stream ? END_OF_CHAIN : 0, 116);
  return { raw, name, type, left: NO_STREAM, right: NO_STREAM, child: NO_STREAM };
}

// streams = { 'FileHeader': Buffer, 'BodyText/Section0': Buffer, … } → 새 파일. 경로 접두사마다 저장소를 만들고, 형제는 정렬해 균형 이진 트리로 잇는다. 루트 CLSID 0, 시각 0.
export function createCfb(streams, { version = 3 } = {}) {
  if (![3, 4].includes(version)) throw new Error(`CFB 버전은 3 또는 4 입니다: ${version}`);
  const tree = { kids: new Map() }; // 이름 → { kids } | { body }
  for (const [path, body] of Object.entries(streams)) {
    const names = path.split('/');
    let node = tree;
    for (const name of names.slice(0, -1)) {
      if (!node.kids.has(name)) node.kids.set(name, { kids: new Map() });
      node = node.kids.get(name);
      if (!node.kids) throw new Error(`스트림과 저장소 이름이 겹칩니다: ${name}`);
    }
    const leaf = names.at(-1);
    if (node.kids.has(leaf)) throw new Error(`경로가 겹칩니다: ${path}`);
    node.kids.set(leaf, { body: Buffer.from(body) });
  }
  const entries = [entryOf('Root Entry', TYPE.root)];
  const bodies = new Map();
  const link = (sorted, lo, hi) => { // 정렬된 형제 [lo, hi) 의 가운데가 부분 트리의 뿌리
    if (lo >= hi) return NO_STREAM;
    const mid = (lo + hi) >> 1;
    entries[sorted[mid]].left = link(sorted, lo, mid);
    entries[sorted[mid]].right = link(sorted, mid + 1, hi);
    return sorted[mid];
  };
  const fill = (node, index) => {
    const names = [...node.kids.keys()].sort(compareNames);
    const ids = names.map(name => {
      const kid = node.kids.get(name);
      entries.push(entryOf(name, kid.kids ? TYPE.storage : TYPE.stream));
      if (!kid.kids) bodies.set(entries.length - 1, kid.body);
      return entries.length - 1;
    });
    entries[index].child = link(ids, 0, ids.length);
    ids.forEach((id, k) => { if (node.kids.get(names[k]).kids) fill(node.kids.get(names[k]), id); });
  };
  fill(tree, 0);
  for (const e of entries) {
    e.raw.writeUInt32LE(e.left, 68);
    e.raw.writeUInt32LE(e.right, 72);
    e.raw.writeUInt32LE(e.child, 76);
  }
  return build({ version, sectorSize: version === 3 ? 512 : 4096, clsid: Buffer.alloc(16) }, entries, (e, i) => bodies.get(i));
}
