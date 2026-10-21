// 서식 본문 문단을 헤딩·필드·빈 문단으로 가르고 개요 수준(1~3)을 매긴다 — 스타일·개요 수준 힌트가 있으면 글보다 앞선다.
import { headingText } from '../public/shared/text.js';

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
  // headingText 는 "개요" 같이 요로 끝나는 짧은 번호 제목을 문장으로 보므로 끝의 요를 뗀 글로 묻는다
  const looksHeading = (headingText(clean.replace(/요$/, '')) || /^[□■◇◆▣]\s*\S/.test(clean)) && clean.length <= 40 && !/(?:[.。!?]|[다음함])$/.test(clean);
  if (looksHeading) return { kind: 'heading', level: clamp(textLevel(clean)) };
  if (ilvl != null) return { kind: 'field', level: clamp(ilvl + 1) };
  const bullet = /^[ㅇ○●•]/.test(clean) ? 1 : /^[-–—]/.test(clean) ? 2 : /^·/.test(clean) ? 3 : 1;
  return { kind: 'field', level: bullet };
}
