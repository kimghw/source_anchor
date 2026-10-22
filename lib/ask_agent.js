// 선택 질문 창의 대화 — 2열 채팅에서 고른 답변·글을 맥락으로 질문·답변만 한다 (FR-WB-102).
// 띄운 화면(장·보고서·양식)의 자료는 그 화면의 대화와 같은 방식으로 agent.js askTurn 이 준다. 여기에는 지침과 고른 글 블록만 둔다.
export { cleanExcerpts } from '../public/shared/ask.js';

export const ASK_NOTE = `This conversation is a separate question window. In the main chat the user picked one or more earlier messages, or dragged over part of them, and opened this window to ask about exactly that. <picked_excerpts> holds what they picked (for a picked answer, also the user message it replied to). Treat the excerpts as the subject of every question here: explain them, check them against the material you were given, compare them, and answer follow-up questions about them. Nothing else from the main chat is carried over, and nothing said here goes back to the main chat. Only answer questions here. Never end a reply with a fenced sourceanchor block of any kind (changes, collect, toc, form, structure or guides): SourceAnchor ignores every block in this window. When the user wants the report, the table of contents, a form or the sources changed, tell them to ask for it in the main chat. Answer from the collected material first and cite ids exactly as the main chat does; you may use the web to answer a question, but say plainly which parts come from the web or from general knowledge, because those are not evidence.`;

// 고른 글 블록 — 모델마다 첫 메시지의 질문 앞에 붙인다
export function excerptsBlock(pieces) {
  const body = pieces.map((p, i) => [
    `--- excerpt ${i + 1}: ${p.kind === 'answer' ? 'a whole answer from the main chat' : 'a part of the main chat the user dragged over'}`,
    p.question && `the user message it answered:\n${p.question}`,
    `${p.kind === 'answer' ? 'the answer' : 'the excerpt'}:\n${p.text}`,
  ].filter(Boolean).join('\n')).join('\n\n');
  return `<picked_excerpts>\n${body}\n</picked_excerpts>`;
}
