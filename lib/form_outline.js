// 서식 본문 문단을 헤딩·필드·빈 문단으로 가르고 개요 수준(1~3)을 매긴다 — 스타일·개요 수준 힌트가 있으면 글보다 앞선다.
// 헤딩에는 출처 by('style' 제목 스타일 이름 · 'outline' 문단 개요 수준 · 'text' 글 모양 규칙)를 남기고, 자르지 않은 깊이가 3 을 넘으면 depth 로 함께 준다 —
// 목차 후보 화면이 기본 선택(개요·스타일 헤딩 우선)과 「개요 4」 같은 배지에 쓴다 (FR-WB-090, FR-WB-093).

// 글로 판별하는 헤딩: 번호·표시로 시작하고, 짧고, 문장 종결로 끝나지 않는 줄 ("개요" 같은 명사 끝은 문장이 아니다)
const HEADING_START = /^(#{1,6}\s+|\d{1,3}(?:\.\d{1,3})*[.)]?\s+|[가-힣][.)]\s+|[IVXivx]+[.)]\s+|[□■◇◆▣]\s*)/;
const SENTENCE_END = /([.!?。]|습니다|니다|세요|어요|아요|여요|지요|죠|[가-힣]다)$/;
const STYLE_HEADING = /^(heading|제목|개요)\s*(\d)/i; // Word 의 Heading n·제목 n, 한글의 개요 n
const MARK_LEVEL = { '□': 1, '■': 2, '◇': 2, '◆': 3, '▣': 3 };
// 글머리 기호 → 필드 수준: ㅇ·○·●·•·◦·「o 」 1, -·–·— 2, ·⋅ㆍ∙ 3
const BULLET_LEVEL = [[/^(?:[ㅇ○●•◦]|o\s)/, 1], [/^[-–—]/, 2], [/^[·⋅ㆍ∙]/, 3]];
// OOXML outlineLvl 9 는 본문(개요 수준 아님)
const clamp = level => Math.min(level, 3);
// 헤딩 — level 은 1~3 으로 자르고, 자르기 전 깊이는 3 을 넘을 때만 depth 로
const heading = (by, depth) => ({ kind: 'heading', level: clamp(depth), by, ...(depth > 3 && { depth }) });

function textLevel(clean) {
  const num = clean.match(/^\d+(?:\.\d+)*/);
  if (num) return num[0].split('.').length;
  if (/^[가-힣]\./.test(clean)) return 2;
  if (/^[IVX]+\./.test(clean)) return 1;
  return MARK_LEVEL[clean[0]] ?? 1;
}

const bulletLevel = clean => BULLET_LEVEL.find(([re]) => re.test(clean))?.[1] ?? 1;

export function classify(text, { style, outlineLvl, ilvl } = {}) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return { kind: 'blank', level: 0 };
  // 문단의 개요 수준이 스타일 이름보다 앞선다 — 한글은 「개요 n」 스타일 문단에도 문단 모양의 개요 수준이 함께 있어, 출처를 하나(outline)로 모은다
  if (outlineLvl != null && outlineLvl < 9) return heading('outline', outlineLvl + 1);
  const styled = String(style ?? '').match(STYLE_HEADING);
  if (styled) return heading('style', Number(styled[2]) || 1);
  if (/^title$/i.test(style ?? '')) return heading('style', 1);
  if (HEADING_START.test(clean) && clean.length <= 40 && !SENTENCE_END.test(clean)) return heading('text', textLevel(clean));
  if (ilvl != null) return { kind: 'field', level: clamp(ilvl + 1) };
  return { kind: 'field', level: bulletLevel(clean) };
}
