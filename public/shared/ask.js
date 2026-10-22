// 선택 질문 창에 담는 고른 글(조각) — 브라우저(창을 열기 전)와 서버(대화를 만들기 전)가 같은 검사를 쓴다 (FR-WB-102, ERR-WB-016)
// 조각: { kind: 'answer'(고른 답변 전체) | 'excerpt'(끌어 고른 글), question(그 답을 끌어낸 작성자 메시지 — 없으면 ''), text }

export const ASK_PIECES_MAX = 20;
export const ASK_CHARS_MAX = 100_000;
const QUESTION_MAX = 2000; // 작성자 메시지는 맥락 표시라 이만큼만 담는다 — 글자 수 한도에는 넣지 않는다

// 조각을 다듬고 검사한다 → 글이 있는 조각만. 비었거나 한도를 넘으면 사유를 담아 던진다
export function cleanExcerpts(raw) {
  const pieces = (Array.isArray(raw) ? raw : []).map(p => ({
    kind: p?.kind === 'answer' ? 'answer' : 'excerpt',
    question: typeof p?.question === 'string' ? p.question.trim().slice(0, QUESTION_MAX) : '',
    text: typeof p?.text === 'string' ? p.text.trim() : '',
  })).filter(p => p.text);
  if (!pieces.length) throw new Error('고른 글이 비어 있습니다 — 글이 있는 답변을 고르거나 채팅의 글을 끌어 고르세요.');
  if (pieces.length > ASK_PIECES_MAX) throw new Error(`한 번에 ${ASK_PIECES_MAX}개까지 고를 수 있습니다 (지금 ${pieces.length}개).`);
  const total = pieces.reduce((n, p) => n + p.text.length, 0);
  if (total > ASK_CHARS_MAX) throw new Error(`고른 글이 합쳐 ${ASK_CHARS_MAX.toLocaleString()}자를 넘습니다 (지금 ${total.toLocaleString()}자). 덜 골라 주세요.`);
  return pieces;
}
