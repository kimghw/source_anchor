// 화면 조립 — 열 초기화, 상단 검증 요약, 열 배치(너비·접기·비율은 columns.js), 실행 취소, Markdown 내보내기
import { allSentences } from '../shared/model.js';
import { problemText, SENTENCE_TYPES, STATUS } from '../shared/text.js';
import { enableAsk } from './ask.js';
import { applyBookState, initBook, openBook, showBookScreen } from './book.js';
import { bookAsk } from './book_chat.js';
import { initBranch } from './branch.js';
import { pickCapture } from './capture.js';
import { initChat, mainChat, onLogClick } from './chat.js';
import { initColumns, openRatioDialog } from './columns.js';
import { initConnections } from './connections.js';
import { initCustomDocs, newCustomDoc, openCustomDoc } from './custom_docs.js';
import { initDocuments, openChapter, openInitialDocument } from './documents.js';
import { initEditor, revealSentences } from './editor.js';
import { initEvidence } from './evidence.js';
import { initExplorer } from './explorer.js';
import { formAsk } from './form_chat.js';
import { flushFormSave, importToc, initForms, openForm, uploadForm } from './forms.js';
import { initPanelNav } from './panel_nav.js';
import { initSources } from './sources.js';
import { api, canRedo, canUndo, check, flushSave, on, redo, selectDoc, state, undo } from './state.js';
import { h, toast } from './util.js';

const $ = id => document.getElementById(id);

initEditor($('col-editor'));
initEvidence($('col-evidence'));
initChat($('col-chat'));
initBranch();
initSources($('col-sources'));
initDocuments($('doc-controls'));
// 장을 여는 진입점은 값으로 넘겨 순환 import 를 만들지 않는다 — 보고서 화면(에이전트 답의 문장 링크)과 0열 장 탐색기가 쓴다 (FR-WB-061, 074, 076, 079)
const reveal = id => { selectDoc(id); revealSentences([id]); };
initBook({ openChapter, reveal });
initExplorer($('explorer'), { openChapter, openBook: id => openBook(id), bookChanged: applyBookState, reveal, openCustom: openCustomDoc, newCustom: newCustomDoc, openForm, uploadForm, flushForm: flushFormSave, importToc }); // importToc — 0열 양식 행의 「⇪」가 목차 후보 대화상자를 연다 (FR-WB-093)
initCustomDocs({ openBook: id => openBook(id) }); // 사용자 지정 문서 화면 — 0열 탭에서 연다 (FR-WB-088)
initForms({ openBook: id => openBook(id), openChapter, reveal }); // 양식 화면 — 0열 「장」 탭의 양식 묶음에서 연다 (FR-WB-090). openChapter·reveal 은 2열 에이전트 답의 장·문장 링크가 쓴다 (FR-WB-091)
// 2열 채팅마다 답변을 골라(끌어 골라) 그 부분만 따로 묻는 선택 질문 창 — 채팅 모듈은 ask.js 를 import 하지 않고 부품만 내준다 (FR-WB-102)
enableAsk($('col-chat'), { scope: () => (state.doc?.id ? { docId: state.doc.id } : null), models: mainChat, click: onLogClick, flush: flushSave });
enableAsk($('book-chat'), bookAsk);
enableAsk($('form-chat'), formAsk);
initConnections($('topbar-connections'));
initColumns(['explorer', 'col-editor', 'col-chat', 'col-sources', 'book-chapters', 'book-chat', 'book-sources', 'custom-editor', 'custom-side', 'custom-sources', 'form-editor', 'form-chat', 'form-sources'].map($)); // 열 너비·접기·비율 — 머리줄이 그려진 뒤 저장한 상태를 되돌린다 (FR-WB-083, 084)
initPanelNav();

on('doc', renderSummary);
on('doc', updateHistoryButtons);
on('save', () => {
  const el = $('save-state');
  el.textContent = { saved: '저장됨', dirty: '저장 중…', error: '저장 실패' }[state.saveState];
  el.className = `save-state is-${state.saveState}`;
});

$('btn-undo').addEventListener('click', undo);
$('btn-redo').addEventListener('click', redo);
$('btn-export').addEventListener('click', exportMarkdown);
$('btn-capture').addEventListener('click', event => pickCapture(event.currentTarget)); // 틀·화면 전체 캡처 — 두 화면에서 늘 보인다 (FR-WB-082)
$('btn-ratio').addEventListener('click', openRatioDialog); // 열 비율 제안 — 두 화면에서 늘 보인다 (FR-WB-084)

window.addEventListener('keydown', event => {
  if (!(event.ctrlKey || event.metaKey) || event.target.closest('input, textarea, select, [contenteditable]')) return;
  const key = event.key.toLowerCase();
  if (key === 'z' && !event.shiftKey) { event.preventDefault(); undo(); }
  else if (key === 'y' || (key === 'z' && event.shiftKey)) { event.preventDefault(); redo(); }
});

// 주소가 가리키는 화면을 연다. 주소에 아무것도 없으면 마지막으로 보던 화면으로 간다 (FR-WB-074, ERR-WB-005).
try {
  const params = new URLSearchParams(location.search);
  if (params.get('form')) await openForm(params.get('report') || undefined, params.get('form'));
  else if (params.get('custom')) await openCustomDoc(params.get('report') || undefined, params.get('custom'));
  else if (params.get('report')) await openBook(params.get('report'));
  else if (params.get('doc')) await openInitialDocument();
  else {
    const place = await api('GET', '/api/place');
    if (place.gone) toast('마지막으로 보던 자리가 없어져 남은 자리를 열었습니다.');
    if (place.view === 'book' || !place.docId) await openBook(place.bookId || undefined);
    else await openInitialDocument();
  }
} catch (err) {
  toast(`작업공간을 불러오지 못했습니다: ${err.message}`, 'error');
  await openBook().catch(() => {}); // 마지막으로 보던 자리가 없어졌으면 보고서 화면으로 물러선다
}

// ───────────────────────────── 상단 검증 요약 ─────────────────────────────

function updateHistoryButtons() {
  $('btn-undo').disabled = !canUndo();
  $('btn-redo').disabled = !canRedo();
}

// 상태별 문장 수. 누르면 그 상태의 다음 문장으로 이동한다.
function renderSummary() {
  const sentences = state.doc.blocks.filter(b => b.kind !== 'heading').flatMap(b => b.sentences);
  const byStatus = new Map();
  for (const s of sentences) {
    const status = check(s).status;
    if (!byStatus.has(status)) byStatus.set(status, []);
    byStatus.get(status).push(s.id);
  }
  $('summary').replaceChildren(
    h('span.summary-total', `문장 ${sentences.length}`),
    ...['reviewed', 'ok', 'stale', 'mismatch', 'conflict', 'missing'].filter(status => byStatus.has(status)).map(status => {
      const ids = byStatus.get(status);
      return h('button.summary-item', { type: 'button', class: `st-${status}`, title: `${STATUS[status].hint}\n누르면 다음 문장으로 이동합니다.`, onclick: () => {
        const next = ids[(ids.indexOf(state.sel.doc.at(-1)) + 1) % ids.length];
        selectDoc(next);
        revealSentences([next]);
      } }, h('span.dot'), `${STATUS[status].label} ${ids.length}`);
    }));
}

// ───────────────────────────── Markdown 내보내기 ─────────────────────────────

function exportMarkdown() {
  const lines = [`# ${state.doc.title}`, ''];
  const usedEvidence = new Set();
  const problems = [];
  for (const block of state.doc.blocks) {
    const text = block.sentences.map(s => {
      const result = check(s);
      if (block.kind !== 'heading' && ['missing', 'mismatch', 'conflict', 'stale'].includes(result.status)) {
        problems.push(`- ${s.id} [${STATUS[result.status].label}] ${s.text}${result.numbers.filter(n => n.problem).map(n => `\n  - ${n.raw}${n.unit}: ${problemText(n)}`).join('')}`);
      }
      s.evidence.forEach(id => usedEvidence.add(id));
      const mark = s.type === 'interpretation' || s.type === 'proposal' ? `(${SENTENCE_TYPES[s.type].label}) ` : '';
      return mark + s.text + s.evidence.map(id => ` [근거 ${id}]`).join('');
    }).join(' ');
    lines.push(block.kind === 'heading' ? `## ${text}` : text, '');
  }

  lines.push('---', '', '## 근거', '');
  for (const id of [...usedEvidence].sort()) {
    const ev = state.evidence[id];
    if (!ev) continue;
    const f = ev.figure;
    lines.push(`- **${id}** — 자료 ${ev.sourceId} ${ev.version} · ${ev.loc}`, `  - 원문: “${ev.quote}”`);
    if (f) lines.push(`  - 값 ${f.display}${f.unit} · 기간 ${f.period} · 대상 ${f.subject}${f.denominator ? ` · 분모 ${f.denominator}` : ''}`);
  }

  lines.push('', '## 출처', '');
  for (const s of state.sources.filter(src => [...usedEvidence].some(id => state.evidence[id]?.sourceId === src.id))) {
    lines.push(`- **${s.id}** ${s.title} — ${s.publisher || '발행처 미상'}, ${s.publishedAt || '발행일 미상'}. ${s.url || ''} (수집 ${s.collectedAt}, ${s.hash.slice(0, 19)}…)`);
  }

  const calcs = allSentences(state.doc).filter(s => s.calc);
  if (calcs.length) {
    lines.push('', '## 계산', '');
    for (const s of calcs) {
      const calc = check(s).calc;
      lines.push(`- ${s.id}: \`${s.calc.expr}\` = ${calc.ok ? calc.display + calc.unit : '계산 실패'} (${calc.inputs.map(i => `${i.name} = ${i.raw}${i.unit} [${i.evId}]`).join(', ')})`);
    }
  }

  lines.push('', '## 검증 결과', '', problems.length ? '규칙 검사에서 확인이 필요한 문장:' : '규칙 검사(인용 존재·수치 일치)에서 걸린 문장이 없습니다. 문장이 근거의 의미를 벗어나지 않는지는 원문 대조로 확인해야 합니다.', ...problems);

  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const link = h('a', { href: URL.createObjectURL(blob), download: `${state.doc.title.replace(/[\\/:*?"<>|]/g, '_') || 'report'}.md` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
