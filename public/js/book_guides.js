// 3열 기준 문서 묶음 — 작성요령·참고문헌·스킬 문서를 보고서에 등록·열람·수정·삭제한다. 목록은 종류별 세 탭으로 나뉜다 (FR-WB-085, ERR-WB-008).
// 스킬(FR-WB-105)은 에이전트가 작업할 때 읽고 따르는 작업 절차 — 줄과 열람 화면에 설명(SKILL.md 머리말의 description, ✎ 로 고친다)을 보인다.
// 등록은 묻는 창 없이 열린 탭의 종류로 곧바로 한다 — 파일은 base64 JSON 으로 한 요청에 하나씩 올리고(서버가 Markdown 으로 바꾼다) 파일마다 결과를 묶음 안에 보여 준다.
// 열람은 원문 열람 부품(readerPane)에 기준 문서의 주소를 끼워 쓴다 — 참조·메모는 없다.
// PDF 는 등록 뒤 서버가 에이전트로 다시 옮긴다(FR-WB-097) — 줄마다 변환 상태·멈추기·(다시) 변환을 두고, 변환 중에는 목록만 몇 초마다 다시 받는다.
// 줄을 끌어 다른 줄에 놓으면 그 문서 뒤에 합치고, 합친 문서 줄의 ⤺ 로 마지막 합치기부터 되돌린다(FR-WB-099).
// book.js 가 이 모듈을 부르므로 book.js 를 import 하지 않는다(순환 금지) — 화면 갱신은 handlers(open·changed)로 받는다.
import { GUIDE_KIND_DEFAULT, GUIDE_KINDS, guideKind } from '../shared/instructions.js';
import { formatLabel } from '../shared/model.js';
import { readerDoc } from './reader_doc.js';
import { readerPane } from './source_view.js';
import { api } from './state.js';
import { fill, flash, formatDate, h, toast } from './util.js';

const ACCEPT = '.pdf,.pptx,.html,.htm,.md,.markdown,.txt,.docx,.hwpx,.hwp';
const FILE_LIMIT = 5 * 1024 * 1024; // 서버(lib/guides.js GUIDE_FILE_LIMIT)와 같다 — 올리기 전에 먼저 거른다
const guideUrl = (bookId, id = '', file = '') => `/api/books/${encodeURIComponent(bookId)}/guides${id ? `/${encodeURIComponent(id)}` : ''}${file ? `/${file}` : ''}`;
const kindLabel = kind => GUIDE_KINDS[kind] ?? kind;
// 「…(으)로」 — 받침이 없거나 ㄹ 받침이면 「로」(스킬로), 그 밖에는 「으로」(작성요령으로)
const toKind = label => {
  const code = label.charCodeAt(label.length - 1) - 0xac00;
  return `${label}${code >= 0 && code < 11172 && code % 28 !== 0 && code % 28 !== 8 ? '으로' : '로'}`;
};
const EMPTY = { // 탭이 비었을 때의 안내 — how 는 등록 방법
  guideline: how => `보고서를 쓸 때 따를 규정·규칙·요령·요구사항 문서를 등록하세요. ${how} 에이전트가 문서에서 장별 작성 지침을 찾아 제안합니다.`,
  reference: how => `쓰면서 참고할 문헌을 등록하세요. ${how} 에이전트가 읽고 답하되 문장의 근거로 인용하지는 않습니다.`,
  skill: how => `에이전트가 작업할 때 따를 작업 절차(스킬)를 등록하세요 — SKILL.md 처럼 첫머리 머리말(--- name / description ---)이 있으면 name 이 제목, description 이 설명(언제 쓰는지)이 됩니다. ${how} 에이전트는 작업이 스킬의 설명에 맞거나 작성자가 스킬을 가리키면 읽고 그 절차를 따릅니다.`,
};
let activeKind = GUIDE_KIND_DEFAULT; // 열려 있는 탭 — 다시 그려도 유지되고, 새 문서는 이 종류로 등록된다. 등록·종류 수정 뒤에는 그 종류로 옮긴다
let pasting = null; // 묶음 안에 펼친 붙여 넣기 입력란 { bookId, text } — 다시 그려도 적은 글이 남는다
let uploads = null; // 파일마다의 등록 결과 { bookId, items: [{ name, ok, text }] } — 다시 그려도 남고, 모두 성공하면 지운다
let shownResults = null; // 지금 보이는 묶음의 결과 목록 { bookId, node } — 올리는 동안 줄마다 고쳐 그린다
let busy = false;
let watch = null; // 변환 상태를 다시 받을 묶음 { bookId, guides, draw, node } — 마지막으로 그린 묶음만 본다
let draggingGuide = null; // 끄는 중인 줄 { bookId, id } — dragover 중에는 dataTransfer 내용을 읽을 수 없어 따로 든다
let merging = false;
const GUIDE_MIME = 'application/x-sourceanchor-guide'; // 줄 끌기 — 파일 놓기(Files)·문장 끌기(dnd.js)와 형식으로 갈린다
const POLL_MS = 5000;
const CONVERTING = ['queued', 'running'];

// 목록 묶음 — 머리줄(수·열린 탭의 종류로 넣는 "＋ <종류>"·붙여 넣기), 종류 탭(작성요령·참고문헌·스킬 — 탭마다 수), 붙여 넣기 입력란, 등록 결과,
// 고른 종류의 문서마다 한 줄(제목·형식·고치기·삭제). 제목을 누르면 3열에서 연다.
// dropHint: false — 이 열에 파일을 놓아도 기준 문서로 올라가지 않는 화면(양식 화면)은 끌어 놓기 안내를 뺀다
export function guidesGroup(bookId, guides, { open, changed, dropHint = true }) {
  const picker = h('input', { type: 'file', multiple: true, accept: ACCEPT, hidden: true, onchange: () => {
    const list = [...picker.files];
    picker.value = ''; // 같은 파일을 다시 골라도 change 가 오게 한다
    if (list.length) register(bookId, list.map(fileEntry), changed);
  } });
  const actions = h('span.guide-actions');
  const results = h('ul.guide-results');
  const body = h('div.guide-body');
  const draw = () => {
    const label = kindLabel(activeKind);
    const shown = guides.filter(g => guideKind(g.kind) === activeKind); // 서버가 모르는 값을 남겼어도 어느 탭에는 보인다
    const how = `${dropHint ? '파일을 고르거나 이 열에 끌어다 놓으면' : '파일을 고르면'} 이 탭에 바로 등록됩니다.`;
    const pasteOpen = pasting?.bookId === bookId;
    fill(actions,
      h('button.btn.small', { type: 'button', title: `${toKind(label)} 등록할 파일을 고릅니다 — PDF·PPT(pptx)·HTML·Markdown·텍스트·Word(docx)·한글(hwpx·hwp), 파일 하나 5MiB 까지. 여러 개를 골라도 되고, 묻지 않고 바로 등록해 Markdown 으로 바꾸고 문장 ID·구조를 붙여 둡니다`, onclick: () => picker.click() }, `＋ ${label}`),
      h('button.btn.small.ghost', { type: 'button', 'aria-pressed': String(pasteOpen), title: `${toKind(label)} 등록할 본문을 이 묶음 안에 붙여 넣습니다`, onclick: () => {
        pasting = pasteOpen ? null : { bookId, text: '' };
        draw();
        body.querySelector('.guide-paste textarea')?.focus();
      } }, '붙여 넣기'));
    fill(body,
      h('nav.guide-tabs', { 'aria-label': '기준 문서 종류' }, Object.entries(GUIDE_KINDS).map(([key, label]) =>
        h('button.src-tab', { type: 'button', class: key === activeKind ? 'is-on' : null, 'aria-pressed': String(key === activeKind), onclick: () => { activeKind = key; draw(); } },
          label, h('span.count', String(guides.filter(g => guideKind(g.kind) === key).length))))),
      pasteOpen && pasteForm(bookId, label, changed, draw),
      results,
      shown.length
        ? shown.map(g => guideRow(bookId, g, { open, changed }))
        : h('p.muted.guide-empty', EMPTY[activeKind](how)));
  };
  shownResults = { bookId, node: results };
  draw();
  drawResults();
  const node = h('section.book-source-group.guide-group',
    h('h3.book-source-chapter', '기준 문서', h('span.count', String(guides.length)), actions),
    picker,
    body);
  watch = { bookId, guides, draw, node };
  return node;
}

// 변환 대기·진행 중인 문서가 보이는 동안 목록(요약)만 다시 받아 이 묶음만 다시 그린다 — 1열 지시문 입력 등 다른 열은 건드리지 않는다 (FR-WB-097).
// 받은 요약으로 화면의 목록 배열을 고쳐 쓰므로 보고서 상태(view.guides)도 함께 맞는다
setInterval(async () => {
  const w = watch;
  if (!w?.node.isConnected || !w.guides.some(g => CONVERTING.includes(g.convert?.state)) || document.hidden) return;
  try {
    const { guides } = await api('GET', guideUrl(w.bookId));
    if (watch !== w || JSON.stringify(guides) === JSON.stringify(w.guides)) return;
    w.guides.splice(0, w.guides.length, ...guides);
    w.draw();
  } catch { /* 다음 차례에 다시 받는다 */ }
}, POLL_MS);

// 3열 위에 컴퓨터의 파일을 끌어다 놓으면 그 파일들을 열린 탭의 종류로 곧바로 등록한다 (FR-WB-085).
// 화면 안의 문장 끌기(dnd.js)는 Files 형식이 없어 받지 않는다. 파일을 열 밖에 놓으면 브라우저가 그 파일로 이동하므로 창 전체에서 막되, 파일 입력란에 놓는 것은 그대로 둔다
export function acceptGuideDrops(node, { bookId, changed }) {
  const files = event => event.dataTransfer?.types?.includes('Files') && !event.target.matches?.('input[type=file]');
  window.addEventListener('dragover', event => { if (files(event)) event.preventDefault(); });
  window.addEventListener('drop', event => { if (files(event)) event.preventDefault(); });
  let depth = 0;
  const leave = () => { depth = 0; node.classList.remove('is-drop-target'); };
  node.addEventListener('dragenter', event => { if (files(event) && bookId()) { depth++; node.classList.add('is-drop-target'); } });
  node.addEventListener('dragover', event => { if (files(event) && bookId()) event.dataTransfer.dropEffect = 'copy'; });
  node.addEventListener('dragleave', event => { if (files(event) && --depth <= 0) leave(); });
  window.addEventListener('dragend', leave);
  node.addEventListener('drop', event => {
    const dropped = event.dataTransfer.files;
    const id = bookId();
    leave();
    if (files(event) && dropped.length && id) register(id, [...dropped].map(fileEntry), changed);
  });
}

// 줄 — 누르면 열고, 끌어서 같은 목록의 다른 줄에 놓으면 그 문서 뒤에 합친다 (FR-WB-099). 자기 줄·파일 끌기·문장 끌기는 받지 않는다
function guideRow(bookId, g, { open, changed }) {
  const status = convertStatus(g);
  const last = g.merges?.at(-1);
  const mergeable = () => draggingGuide?.bookId === bookId && draggingGuide.id !== g.id && !g.note; // 요청 문서 위에는 합치지 않는다 (ERR-WB-013)
  const over = event => {
    if (!mergeable()) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    row.classList.add('is-merge-target');
  };
  const row = h('div.book-source.guide-row', {
    draggable: true,
    ondragstart: event => {
      draggingGuide = { bookId, id: g.id };
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(GUIDE_MIME, g.id);
      row.classList.add('is-dragging');
    },
    ondragend: () => {
      draggingGuide = null;
      row.classList.remove('is-dragging');
      document.querySelectorAll('.guide-row.is-merge-target').forEach(node => node.classList.remove('is-merge-target'));
    },
    ondragenter: over,
    ondragover: over,
    ondragleave: event => { if (!row.contains(event.relatedTarget)) row.classList.remove('is-merge-target'); },
    ondrop: event => {
      row.classList.remove('is-merge-target');
      if (!mergeable()) return;
      event.preventDefault();
      const from = draggingGuide.id;
      draggingGuide = null;
      merge(bookId, g, from, changed);
    },
  },
    h('button.book-source-head', { type: 'button', title: `${g.id} · ${g.title}${g.fileName ? `\n${g.fileName}` : ''}${g.description ? `\n설명: ${g.description}` : ''}\n누르면 3열에서 이 문서를 봅니다 · 끌어서 다른 문서 줄에 놓으면 그 문서 뒤에 합칩니다`, onclick: () => open(g) },
      h('span.book-source-title', g.title),
      h('span.type-badge', { class: `type-${g.type}` }, formatLabel(g)),
      h('span.book-source-id', g.id),
      g.description && h('span.guide-desc', g.description),
      status && h('span.guide-convert', { class: `is-${g.convert.state}`, title: status.title }, status.label),
      last && h('span.guide-merged', { title: `합친 문서: ${g.id} + ${g.merges.map(m => `${m.id} ${m.title}`).join(' + ')}` }, `합침 ${g.docs}`)),
    convertButton(bookId, g),
    last && h('button.icon-btn', { type: 'button', title: `합치기 되돌리기 — 마지막으로 붙인 ${last.id} 「${last.title}」을(를) 다시 따로 둡니다`, 'aria-label': `${g.id} 합치기 되돌리기`, onclick: () => unmerge(bookId, g, changed) }, '⤺'),
    h('button.icon-btn', { type: 'button', title: '종류·제목·설명 고치기', 'aria-label': `${g.id} 종류·제목·설명 고치기`, onclick: () => openEditDialog(bookId, g, changed) }, '✎'),
    h('button.icon-btn', { type: 'button', title: '기준 문서 삭제', 'aria-label': `${g.id} 삭제`, onclick: () => remove(bookId, g, changed) }, '✕'));
  return row;
}

// ───────────────────────────── 합치기 · 되돌리기 (FR-WB-099, ERR-WB-013) ─────────────────────────────

// 끌어 온 문서(from)를 놓은 문서 뒤에 잇는다 — 되돌릴 수 있으므로 묻지 않는다
async function merge(bookId, target, from, changed) {
  if (merging) return;
  merging = true;
  try {
    await api('POST', guideUrl(bookId, target.id, 'merge'), { from });
    toast(`${from} 을(를) ${target.id} 뒤에 합쳤습니다 — 줄의 ⤺ 로 되돌릴 수 있습니다.`);
  } catch (err) {
    return toast(err.message, 'error');
  } finally {
    merging = false;
  }
  await changed();
}

// 마지막 합치기를 푼다 — 두 문서가 합치기 직전 그대로 다시 나타난다
async function unmerge(bookId, g, changed) {
  if (merging) return;
  merging = true;
  const last = g.merges.at(-1);
  try {
    await api('POST', guideUrl(bookId, g.id, 'unmerge'));
    toast(`${last.id} 「${last.title}」을(를) 다시 따로 두었습니다.`);
  } catch (err) {
    return toast(err.message, 'error');
  } finally {
    merging = false;
  }
  await changed();
}

// ───────────────────────────── PDF 에이전트 변환 (FR-WB-097) ─────────────────────────────

const when = iso => (iso ? formatDate(iso) : '');

// 줄의 변환 표시 — { label, title } (변환한 적 없는 문서는 없음)
function convertStatus(g) {
  const c = g.convert;
  if (!c) return null;
  const model = c.model ? `모델 ${c.model}` : '';
  if (c.state === 'queued') return { label: '변환 대기', title: '앞 문서의 변환이 끝나면 에이전트가 20쪽씩 옮깁니다. 그동안은 등록 때 본문을 씁니다' };
  if (c.state === 'running') return { label: `에이전트 변환 중 ${c.done}/${c.total}`, title: `${model} · 20쪽 묶음 ${c.total}개를 에이전트가 최대 10개씩 동시에 옮기는 중 — 끝나면 본문과 문장 ID 가 바뀝니다` };
  if (c.state === 'done') return { label: '에이전트 변환', title: [model, `묶음 ${c.total}개`, when(c.finishedAt)].filter(Boolean).join(' · ') };
  if (c.state === 'partial') return { label: '일부 자동 변환', title: `등록 때 글로 남은 쪽: ${c.fallback.join(', ') || '-'}\n${[model, when(c.finishedAt)].filter(Boolean).join(' · ')}` };
  if (c.state === 'stopped') return { label: '멈춤', title: c.reason || '변환을 멈췄습니다' };
  return { label: '건너뜀', title: c.reason || '변환하지 않았습니다' }; // skipped
}

// 줄의 변환 단추 — 대기·진행 중이면 멈추기, 그 밖에는 (다시) 변환. 일부 자동 변환·멈춤은 남은 묶음만 다시 한다
function convertButton(bookId, g) {
  if (g.type !== 'pdf' || !g.snapshot || g.merges) return null; // 합친 문서는 되돌린 뒤 문서마다 변환한다 (FR-WB-099)
  const state = g.convert?.state;
  if (CONVERTING.includes(state)) return h('button.icon-btn', { type: 'button', title: '변환 멈추기 — 본문은 지금 그대로 둡니다', 'aria-label': `${g.id} 변환 멈추기`, onclick: () => requestConvert(bookId, g, 'stop') }, '■');
  const rest = state === 'partial' || state === 'stopped';
  const label = rest ? '남은 쪽 변환 — 검사를 통과한 묶음은 두고 나머지만 에이전트가 다시 옮깁니다' : state ? '다시 변환 — 에이전트가 처음부터 다시 옮깁니다' : '변환 — 에이전트가 20쪽씩 Markdown 으로 옮기고 문장마다 ID 를 붙입니다';
  return h('button.icon-btn', { type: 'button', title: label, 'aria-label': `${g.id} ${label.split(' — ')[0]}`, onclick: () => requestConvert(bookId, g, rest ? 'rest' : 'start') }, '↻');
}

async function requestConvert(bookId, g, action) {
  if (action !== 'stop' && !confirm(`“${g.title}”을(를) 에이전트로 ${action === 'rest' ? '남은 쪽만 ' : ''}변환할까요? 끝나면 본문과 문장 ID 가 바뀝니다(이미 반영한 지시문의 위치 표기는 그대로입니다).`)) return;
  try {
    const res = await api('POST', guideUrl(bookId, g.id, 'convert'), { action });
    if (watch?.bookId === bookId) {
      watch.guides.splice(0, watch.guides.length, ...res.guides);
      watch.draw();
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

// 3열 열람 화면 — 목록으로 돌아가기 + 본문·원본·Markdown 보기. 본문(블록)은 목록에 없어 따로 받는다
// reveal: 본문을 받은 뒤 본문 보기로 돌려 비출 문장·셀 ID — 데이터 분석 화면 2열 답의 기준 문서 위치 링크 (FR-WB-088)
export function guideReader(bookId, summary, { back, reveal = null }) {
  const loading = h('p.muted.reader-loading', '문서를 읽는 중…');
  const root = h('div.book-reader.guide-reader',
    h('nav.src-tabs',
      h('button.src-tab.back', { type: 'button', onclick: back }, '← 목록'),
      h('span.book-reader-pos', `${kindLabel(summary.kind)} · ${summary.id}`)),
    loading);
  api('GET', guideUrl(bookId, summary.id)).then(guide => {
    const pane = readerPane(guide, {
      key: 'guide',
      marks: false, // 기준 문서에는 참조·메모가 없다 (FR-WB-085)
      files: kind => guideUrl(bookId, guide.id, kind),
      rows: [['종류', kindLabel(guide.kind)], ...(guide.description ? [['설명', guide.description]] : []), ['파일', guide.fileName || (guide.note ? '없음 — 에이전트가 대화에서 정리한 작성자 요청' : '붙여 넣은 본문')], ['등록', `${formatDate(guide.collectedAt)}${guide.method ? ` · ${guide.method}` : ''}`], ...convertRow(guide),
        ...(guide.merges?.length ? [['합친 문서', `${guide.id}(원본) 뒤에 ${guide.merges.map(m => `${m.id} ${m.title}`).join(' · ')}`]] : [])],
      body: () => readerDoc(guide),
    });
    loading.replaceWith(pane.pane);
    if (!reveal) return;
    pane.setMode('body');
    const node = pane.pane.querySelector(`[data-aid="${CSS.escape(reveal)}"]`) || pane.pane.querySelector(`[data-aid^="${CSS.escape(`${reveal}.`)}"]`); // 블록 ID 면 그 첫 문장
    if (!node) return toast(`이 문서에 없는 위치입니다: ${reveal}`, 'error');
    node.scrollIntoView({ block: 'center' });
    flash(node, 'is-anchor-flash');
  }).catch(err => fill(loading, err.message));
  return root;
}

// 열람 화면의 변환 정보 — 상태 · 모델 · 묶음 수 · 끝난 시각 · 판 (FR-WB-097)
function convertRow(guide) {
  const c = guide.convert;
  if (!c) return [];
  const parts = c.parts || [];
  const done = parts.filter(p => p.state === 'done').length;
  const status = convertStatus({ convert: { ...c, done: parts.filter(p => p.state === 'done' || p.state === 'fallback').length, total: parts.length, fallback: parts.filter(p => p.state === 'fallback').map(p => `${p.from}–${p.to}`) } });
  return [['변환', [status.label, c.model, parts.length ? `묶음 ${done}/${parts.length}` : '', when(c.finishedAt), guide.version].filter(Boolean).join(' · ')]];
}

// ───────────────────────────── 등록 · 고치기 · 삭제 ─────────────────────────────

const readBase64 = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
  reader.onerror = () => reject(new Error('파일을 읽지 못했습니다'));
  reader.readAsDataURL(file);
});

const kindSelect = value => h('select', Object.entries(GUIDE_KINDS).map(([key, label]) => h('option', { value: key, selected: key === guideKind(value) }, label)));
const field = (label, input) => h('label.field', label, input);
const FRONT = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/; // SKILL.md 머리말 — 제목·설명은 서버가 머리말에서 읽는다 (FR-WB-105)
const firstLine = text => text.replace(FRONT, '').split('\n').map(line => line.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';

// 등록할 것 하나 — name 은 결과 줄의 이름, body 는 요청 본문(종류 제외), done 은 등록에 성공했을 때 부른다
const fileEntry = file => ({
  name: file.name,
  body: async () => {
    if (file.size > FILE_LIMIT) throw new Error(`파일이 5MiB 를 넘습니다 (${(file.size / 1024 / 1024).toFixed(1)}MiB)`);
    return { title: '', fileName: file.name, data: await readBase64(file) }; // 제목은 서버가 파일 속 제목, 없으면 파일 이름으로 정한다
  },
});

// 고른 파일·놓은 파일·붙여 넣은 본문을 열려 있는 탭의 종류로 곧바로 등록한다 — 묻는 창은 없고, 서버가 Markdown 으로 바꿔 보관한다.
// 한 요청에 하나씩 올려 줄마다 진행·결과를 묶음에 보인다. 모두 성공하면 결과를 지우고, 실패가 있으면 사유를 남겨 둔다 (FR-WB-085, ERR-WB-008)
async function register(bookId, entries, changed) {
  if (busy) return toast('앞서 넣은 문서를 등록하는 중입니다. 끝난 뒤 다시 넣어 주세요.', 'error');
  busy = true;
  const kind = activeKind;
  const items = entries.map(entry => ({ name: entry.name, ok: null, text: '… 기다리는 중' }));
  uploads = { bookId, items };
  let ok = 0;
  for (const [i, entry] of entries.entries()) {
    items[i].text = '… 올리는 중';
    drawResults();
    try {
      const res = await api('POST', guideUrl(bookId), { kind, ...await entry.body() });
      Object.assign(items[i], { ok: true, text: `✓ ${res.guide.id} ${toKind(kindLabel(kind))} 등록` });
      entry.done?.();
      ok++;
    } catch (err) {
      Object.assign(items[i], { ok: false, text: `✕ ${err.message}` });
    }
  }
  busy = false;
  if (ok === entries.length) uploads = null; // 새 문서가 목록에 보이므로 결과 줄은 지운다
  drawResults();
  if (ok < entries.length) toast(`${kindLabel(kind)} ${ok}건 등록, ${entries.length - ok}건 실패 — 사유는 기준 문서 묶음에 남겨 두었습니다.`, 'error');
  else toast(`${kindLabel(kind)} ${ok}건을 등록했습니다.`);
  if (!ok) return;
  activeKind = kind; // 올리는 사이 탭을 옮겼어도 등록한 종류의 탭을 열어 새 문서가 보이게 한다
  await changed();
}

function drawResults() {
  if (!shownResults) return;
  const items = uploads?.bookId === shownResults.bookId ? uploads.items : [];
  fill(shownResults.node,
    items.map(item => h('li', h('span.guide-result-name', item.name), h(item.ok === null ? 'span.muted' : item.ok ? 'span.ok' : 'span.bad', ` ${item.text}`))),
    items.length > 0 && !busy && h('li.guide-results-close', h('button.btn.ghost.small', { type: 'button', onclick: () => { uploads = null; drawResults(); } }, '결과 닫기')));
}

// 묶음 안의 붙여 넣기 입력란 — 첫 줄(앞의 # 은 뺀다)이 제목이 된다
function pasteForm(bookId, label, changed, draw) {
  const text = h('textarea', { rows: 6, placeholder: `${toKind(label)} 등록할 본문을 붙여 넣으세요 (Markdown — 첫 줄이 제목이 됩니다${activeKind === 'skill' ? '. SKILL.md 의 --- name / description --- 머리말이 있으면 name 이 제목, description 이 설명이 됩니다' : ''})`, oninput: () => { if (pasting) pasting.text = text.value; } });
  text.value = pasting.text;
  return h('form.guide-paste', {
    onsubmit: event => {
      event.preventDefault();
      const markdown = text.value;
      if (!markdown.trim()) return toast('본문을 붙여 넣어 주세요.', 'error');
      register(bookId, [{ name: '붙여 넣은 본문', body: async () => ({ title: firstLine(markdown), markdown }), done: () => { pasting = null; } }], changed);
    },
  },
    h('div.field', text),
    h('div.row-actions.end',
      h('button.btn.ghost.small', { type: 'button', onclick: () => { pasting = null; draw(); } }, '취소'),
      h('button.btn.small', { type: 'submit' }, '등록')));
}

function openEditDialog(bookId, g, changed) {
  const kind = kindSelect(g.kind);
  const title = h('input', { type: 'text', value: g.title, required: true });
  const description = h('textarea', { rows: 3, maxLength: 1000, placeholder: '스킬이면 언제 쓰는지 — 에이전트가 이 설명을 보고 스킬을 고릅니다 (비우면 설명 없음)' });
  description.value = g.description || '';
  const dialog = h('dialog.dialog',
    h('form', {
      method: 'dialog',
      onsubmit: async event => {
        event.preventDefault();
        try {
          await api('PUT', guideUrl(bookId, g.id), { kind: kind.value, title: title.value, description: description.value });
          dialog.close();
          activeKind = guideKind(kind.value); // 종류를 옮겼으면 그 탭에서 보이게 한다
          await changed();
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    },
      h('h2', `기준 문서 ${g.id}`),
      h('div.field-row', field('종류', kind), field('제목', title)),
      field('설명', description),
      g.fileName && h('p.muted', `파일: ${g.fileName}`),
      h('div.row-actions.end',
        h('button.btn.ghost', { type: 'button', onclick: () => dialog.close() }, '취소'),
        h('button.btn', { type: 'submit' }, '저장'))));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

// 보관 파일까지 지운다. 이미 반영된 장의 지시문은 그대로다 (FR-WB-085)
async function remove(bookId, g, changed) {
  if (!confirm(`“${g.title}” 기준 문서를 삭제할까요? 올린 원본과 Markdown 파일도 지워지며 되돌릴 수 없습니다. 이미 반영된 장의 지시문은 바뀌지 않습니다.`)) return;
  try {
    await api('DELETE', guideUrl(bookId, g.id));
    await changed();
  } catch (err) {
    toast(err.message, 'error');
  }
}
