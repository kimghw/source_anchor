// 붙여 넣은 Markdown·텍스트를 블록 초안으로 바꾼다. 문장을 요약하거나 수치를 고치지 않는다.
// 위치는 문단 순번(para)으로 남긴다. PDF 페이지·PPT 슬라이드 번호는 파일을 쪽 단위로 넘기는 쪽(lib/collect.js)이 붙인다.

const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const UNIT_HINT = /\(?\s*단위\s*[:：]\s*([^)]+?)\s*\)?\s*$/;

const MARKER = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|\|)/;
const LITERAL = /^\s*\\(?=[-*+#|\d])/;

function cells(line) {
  return line.match(TABLE_ROW)[1].split('|').map(c => c.trim());
}

// 내려받은 본문의 줄이 "1. …" "- …" 처럼 시작해도 그 글자는 본문이다(법령의 호 번호 등). 앞에 역슬래시를 붙여 두면
// markdownToDrafts 가 목록·제목 표시로 읽지 않고 글자를 그대로 둔다.
export function literalLines(text) {
  return String(text).split('\n').map(line => (MARKER.test(line) ? line.replace(/^(\s*)/, '$1\\') : line)).join('\n');
}

export function markdownToDrafts(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const drafts = [];
  let para = 0;
  let buffer = [];
  let pendingCaption = '';
  let captionIsHeading = false;
  const isCaption = text => /^(표|Table)\s*\d*/i.test(text) || UNIT_HINT.test(text);

  const flush = () => {
    if (!buffer.length) return;
    const text = buffer.join(' ').trim();
    buffer = [];
    if (!text) return;
    // 표 바로 위의 "표 2. … (단위: %)" 줄은 표 제목으로 쓴다
    if (isCaption(text)) [pendingCaption, captionIsHeading] = [text, false];
    drafts.push({ kind: 'paragraph', loc: { para: ++para }, text });
  };

  for (let i = 0; i < lines.length; i++) {
    const literal = LITERAL.test(lines[i]); // 역슬래시로 시작하는 줄은 표시가 아니라 본문 글자다
    const line = literal ? lines[i].replace(LITERAL, '') : lines[i];
    const heading = !literal && line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      const text = heading[2].trim();
      drafts.push({ kind: 'heading', level: Math.min(heading[1].length, 3), loc: { para: ++para }, text });
      // 슬라이드처럼 제목이 곧 표 제목인 자료가 있다 — 제목 블록은 남기고 표의 제목·단위로도 쓴다
      [pendingCaption, captionIsHeading] = isCaption(text) ? [text, true] : ['', false];
    } else if (!literal && TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] ?? '')) {
      flush();
      const columns = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(cells(lines[i++]));
      i--;
      let title = '';
      let unit = '';
      if (pendingCaption) {
        if (!captionIsHeading) {
          drafts.pop();
          para--;
        }
        unit = pendingCaption.match(UNIT_HINT)?.[1] ?? '';
        title = pendingCaption.replace(UNIT_HINT, '').trim();
        pendingCaption = '';
      }
      drafts.push({ kind: 'table', loc: { para: ++para }, table: { title, unit, columns, rows: rows.map(r => columns.map((_, c) => r[c] ?? '')) } });
    } else if (!literal && /^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      pendingCaption = '';
      const item = line.replace(/^\s*([-*+]|\d+[.)])\s+/, '').trim();
      const last = drafts.at(-1);
      if (last?.kind === 'list' && last.open) last.items.push(item);
      else drafts.push({ kind: 'list', loc: { para: ++para }, items: [item], open: true });
      continue;
    } else if (!line.trim()) {
      flush();
    } else {
      if (!buffer.length) pendingCaption = '';
      buffer.push(line.trim());
    }
    const last = drafts.at(-1);
    if (last?.kind === 'list') last.open = false;
  }
  flush();
  return drafts.map(({ open, ...d }) => d);
}
