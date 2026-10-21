// 1열 지시문 편집 — 여섯 절(문체 및 예시·헤딩 순서·제약조건·규정 및 규칙·작성요령·작성 요구사항)을 절마다 따로 고치고, 저장은 문자열 하나로 한다 (FR-WB-073).
// 절에 속하지 않는 글은 "그 밖의 글"로 보존해 보여 준다. 고치지 않으면 저장하지 않는다(열고 닫기만 해도 바뀌지 않게).
// 한도를 넘거나 저장에 실패하면 화면을 되돌리지 않는다 — 적은 글을 남긴 채 알린다.
import { formatInstructions, INSTRUCTIONS_LIMIT, instructionsProblem, parseInstructions, SECTIONS } from '../shared/instructions.js';
import { h, toast } from './util.js';

const rowsFor = value => Math.min(14, Math.max(2, String(value).split('\n').length));

// chapter: { id, title, instructions } · save(text): 서버에 저장하는 Promise — 실패하면 던진다 · sections: 보일 절(보고서 공통은 헤딩 순서를 뺀 REPORT_SECTIONS) · report: 공통 지시문 검사
export function instructionsEditor(chapter, { save, sections = SECTIONS, report = false }) {
  const fields = new Map(); // 절 key → textarea ('preamble' 은 절에 속하지 않는 글)
  const parsed = parseInstructions(chapter.instructions);
  const saved = (chapter.instructions || '').trim();
  const counter = h('span.toc-count');
  const compose = () => formatInstructions({
    preamble: fields.has('preamble') ? fields.get('preamble').value : parsed.preamble,
    sections: { ...parsed.sections, ...Object.fromEntries(sections.map(s => [s.key, fields.get(s.key).value])) }, // 보이지 않는 절도 보존한다
  });
  const updateCount = () => {
    const n = compose().length;
    counter.textContent = `${n.toLocaleString()} / ${INSTRUCTIONS_LIMIT.toLocaleString()}`;
    counter.classList.toggle('is-over', n > INSTRUCTIONS_LIMIT);
  };
  const commit = async () => {
    const text = compose();
    const problem = instructionsProblem(text, { report });
    root.classList.toggle('is-over', !!problem);
    if (problem) return toast(`${problem} — 저장하지 않았습니다. 줄여 주세요.`, 'error');
    if (text === saved) return; // 바뀐 게 없으면 저장하지 않는다 — 열고 닫기만 한 지시문은 그대로다
    try {
      await save(text);
    } catch (err) {
      root.classList.add('is-over');
      toast(err.message, 'error'); // 적은 글은 화면에 그대로 남는다
    }
  };
  const area = (key, value, label, hint) => {
    const t = h('textarea', { rows: rowsFor(value), value, placeholder: hint, 'aria-label': `${chapter.title} — ${label}`, oninput: () => { t.rows = rowsFor(t.value); updateCount(); }, onchange: commit });
    fields.set(key, t);
    return t;
  };
  const root = h('div.toc-sections',
    parsed.preamble && h('label.toc-section.is-preamble',
      h('span.toc-section-title', '그 밖의 글', h('span.toc-section-tag.is-keep', '절 밖의 글 — 그대로 보존')),
      area('preamble', parsed.preamble, '그 밖의 글', '')),
    sections.map(s => h('label.toc-section', { class: s.extracted ? 'is-extracted' : '' },
      h('span.toc-section-title', s.title, s.extracted && h('span.toc-section-tag', '기준 문서에서 추출')),
      area(s.key, parsed.sections[s.key], s.title, s.hint))),
    h('div.toc-section-foot', counter));
  updateCount();
  return root;
}
