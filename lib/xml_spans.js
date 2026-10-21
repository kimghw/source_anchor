// OOXML/HWPX 원문 문자열의 최상위 요소 구간을 깊이를 세어 찾는 공유 커널 — DOM 으로 왕복하지 않고 구간 절개만 한다 (docx·hwpx 표 스캐너·채우기가 쓴다).
// 최상위 = 같은 이름의 중첩 깊이 0 이고 범위 안에서 열린 중첩 표(tbl) 안이 아님. 이름이 tbl 이면 가장 바깥 표만.

export const escapeXml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
export const unescapeXml = text => String(text).replace(/&(?:#x([0-9a-f]+)|#(\d+)|(lt|gt|quot|apos|amp));/gi,
  (_, hex, dec, name) => name ? ENTITIES[name.toLowerCase()] : String.fromCodePoint(hex ? parseInt(hex, 16) : Number(dec)));

// range: { lo, hi } 또는 { start, end }(innerSpan·span 결과를 그대로 넘긴다). prefix: 접두사 정규식 원본.
export function elementSpans(xml, name, { lo, hi, start: s, end: e, prefix = '[A-Za-z][-\\w.]*' } = {}) {
  const from = lo ?? s ?? 0;
  const to = hi ?? e ?? xml.length;
  const token = new RegExp(`<(/?)(${prefix}):(tbl|tr|tc|p|subList)(?=[\\s/>])`, 'g');
  token.lastIndex = from;
  const spans = [];
  let tblDepth = 0; // 열린 중첩 표 수 (name === 'tbl' 이면 wdepth 와 같다)
  let wdepth = 0; // name 요소 자신의 중첩 깊이
  let open = null;
  for (let m; (m = token.exec(xml)) && m.index < to;) {
    const closing = m[1] === '/';
    const gt = xml.indexOf('>', m.index);
    if (gt < 0) break;
    const tagEnd = gt + 1;
    token.lastIndex = tagEnd;
    const selfClosed = !closing && xml[gt - 1] === '/';
    const isTbl = m[3] === 'tbl';
    const isName = m[3] === name;
    if (closing) {
      if (isTbl) tblDepth--;
      if (isName && --wdepth === 0 && open) { spans.push({ start: open.start, end: tagEnd, selfClosed: false, prefix: open.prefix }); open = null; }
    } else if (selfClosed) {
      if (isName && tblDepth === 0 && wdepth === 0) spans.push({ start: m.index, end: tagEnd, selfClosed: true, prefix: m[2] });
    } else {
      if (isName && tblDepth === 0 && wdepth === 0) open = { start: m.index, prefix: m[2] };
      if (isTbl) tblDepth++;
      if (isName) wdepth++;
    }
  }
  return spans;
}

// 여는 태그의 > 다음부터 닫는 </ 앞까지. 자기 닫힘이면 null.
export function innerSpan(xml, { start, end, selfClosed }) {
  if (selfClosed) return null;
  return { start: xml.indexOf('>', start) + 1, end: xml.lastIndexOf('</', end) };
}

// pos 가 어느 구간 안에도 없으면 true
export const outside = (pos, spans) => !spans.some(s => pos >= s.start && pos < s.end);
