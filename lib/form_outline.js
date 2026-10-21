// 서식 본문 문단을 헤딩·필드·빈 문단으로 가르고 개요 수준(1~3)을 매긴다 — 스타일·개요 수준 힌트가 있으면 글보다 앞선다.

// 글로 판별하는 헤딩: 번호·표시로 시작하고, 짧고, 문장 종결로 끝나지 않는 줄 ("개요" 같은 명사 끝은 문장이 아니다)
const HEADING_START = /^(#{1,6}\s+|\d{1,3}(?:\.\d{1,3})*[.)]?\s+|[가-힣][.)]\s+|[IVXivx]+[.)]\s+|[□■◇◆▣]\s*)/;
const SENTENCE_END = /([.!?。]|습니다|니다|세요|어요|아요|여요|지요|죠|[가-힣]다)$/;
const STYLE_HEADING = /^(heading|제목)\s*(\d)/i;
const MARK_LEVEL = { '□': 1, '■': 2, '◇': 2, '◆': 3, '▣': 3 };
const clamp = level => Math.min(level, 3);

function textLevel(clean) {
  const num = clean.match(/^\d+(?:\.\d+)*/);
  if (num) return num[0].split('.').length;
  if (/^[가-힣]\./.test(clean)) return 2;
  if (/^[IVX]+\./.test(clean)) return 1;
  return MARK_LEVEL[clean[0]] ?? 1;
}

export function classify(text, { style, outlineLvl, ilvl } = {}) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return { kind: 'blank', level: 0 };
  const styled = String(style ?? '').match(STYLE_HEADING);
  if (styled) return { kind: 'heading', level: clamp(Number(styled[2]) || 1) };
  if (/^title$/i.test(style ?? '')) return { kind: 'heading', level: 1 };
  if (outlineLvl != null) return { kind: 'heading', level: clamp(outlineLvl + 1) };
  if (HEADING_START.test(clean) && clean.length <= 40 && !SENTENCE_END.test(clean)) return { kind: 'heading', level: clamp(textLevel(clean)) };
  if (ilvl != null) return { kind: 'field', level: clamp(ilvl + 1) };
  const bullet = /^[ㅇ○●•]/.test(clean) ? 1 : /^[-–—]/.test(clean) ? 2 : /^·/.test(clean) ? 3 : 1;
  return { kind: 'field', level: bullet };
}
