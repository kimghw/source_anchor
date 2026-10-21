// 3열 기준 문서 묶음 — 규정·규칙·작성요령·작성 요구사항 문서를 보고서에 등록·열람·수정·삭제한다 (FR-WB-085, ERR-WB-008).
// 파일은 base64 JSON 으로 한 요청에 하나씩 올리고 파일마다 결과를 보여 준다. 열람은 원문 열람 부품(readerPane)에 기준 문서의 주소를 끼워 쓴다 — 참조·메모는 없다.
// book.js 가 이 모듈을 부르므로 book.js 를 import 하지 않는다(순환 금지) — 화면 갱신은 handlers(open·changed)로 받는다.
import { GUIDE_KINDS } from '../shared/instructions.js';
import { SOURCE_TYPES } from '../shared/model.js';
import { readerDoc } from './reader_doc.js';
import { readerPane } from './source_view.js';
import { api } from './state.js';
import { fill, formatDate, h, toast } from './util.js';

const ACCEPT = '.pdf,.pptx,.html,.htm,.md,.markdown,.txt';
const FILE_LIMIT = 5 * 1024 * 1024; // 서버(lib/guides.js GUIDE_FILE_LIMIT)와 같다 — 올리기 전에 먼저 거른다
const guideUrl = (bookId, id = '', file = '') => `/api/books/${encodeURIComponent(bookId)}/guides${id ? `/${encodeURIComponent(id)}` : ''}${file ? `/${file}` : ''}`;
const kindLabel = kind => GUIDE_KINDS[kind] ?? kind;

// 목록 묶음 — 머리줄(수·추가 버튼)과 문서마다 한 줄(종류·제목·형식·고치기·삭제). 제목을 누르면 3열에서 연다.
// dropHint: false — 이 열에 파일을 놓아도 기준 문서로 올라가지 않는 화면(양식 화면)은 끌어 놓기 안내를 뺀다
export function guidesGroup(bookId, guides, { open, changed, dropHint = true }) {
  return h('section.book-source-group.guide-group',
    h('h3.book-source-chapter', '기준 문서', h('span.count', String(guides.length)),
      h('button.btn.small', { type: 'button', title: '규정·규칙·작성요령·작성 요구사항 문서를 파일(PDF·pptx·html·md·txt)로 올리거나 본문을 붙여 넣어 등록합니다', onclick: () => openAddDialog(bookId, changed) }, '＋ 기준 문서')),
    guides.length
      ? guides.map(g => guideRow(bookId, g, { open, changed }))
      : h('p.muted.guide-empty', `규정이나 작성요령을 등록하세요.${dropHint ? ' 파일을 이 열에 끌어다 놓아도 됩니다.' : ''} 에이전트가 문서에서 장별 작성 지침을 찾아 제안합니다.`));
}

// 3열 위에 컴퓨터의 파일을 끌어다 놓으면 그 파일들이 골라진 등록 대화상자를 연다 — 종류·제목은 대화상자에서 정한다 (FR-WB-085).
// 화면 안의 문장 끌기(dnd.js)는 Files 형식이 없어 받지 않는다. 파일을 열 밖에 놓으면 브라우저가 그 파일로 이동하므로 창 전체에서 막되, 대화상자의 파일 입력란에 놓는 것은 그대로 둔다
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
    if (files(event) && dropped.length && id) openAddDialog(id, changed, dropped);
  });
}

function guideRow(bookId, g, { open, changed }) {
  return h('div.book-source.guide-row',
    h('button.book-source-head', { type: 'button', title: `${g.id} · ${g.title}${g.fileName ? `\n${g.fileName}` : ''}\n누르면 3열에서 이 문서를 봅니다`, onclick: () => open(g) },
      h('span.kind-badge', { class: `kind-${g.kind}` }, kindLabel(g.kind)),
      h('span.book-source-title', g.title),
      h('span.type-badge', { class: `type-${g.type}` }, SOURCE_TYPES[g.type] ?? g.type),
      h('span.book-source-id', g.id)),
    h('button.icon-btn', { type: 'button', title: '종류·제목 고치기', 'aria-label': `${g.id} 종류·제목 고치기`, onclick: () => openEditDialog(bookId, g, changed) }, '✎'),
    h('button.icon-btn', { type: 'button', title: '기준 문서 삭제', 'aria-label': `${g.id} 삭제`, onclick: () => remove(bookId, g, changed) }, '✕'));
}

// 3열 열람 화면 — 목록으로 돌아가기 + 본문·원본·Markdown 보기. 본문(블록)은 목록에 없어 따로 받는다
export function guideReader(bookId, summary, { back }) {
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
      rows: [['종류', kindLabel(guide.kind)], ['파일', guide.fileName || '붙여 넣은 본문'], ['등록', `${formatDate(guide.collectedAt)}${guide.method ? ` · ${guide.method}` : ''}`]],
      body: () => readerDoc(guide),
    });
    loading.replaceWith(pane.pane);
  }).catch(err => fill(loading, err.message));
  return root;
}

// ───────────────────────────── 등록 · 고치기 · 삭제 ─────────────────────────────

const readBase64 = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
  reader.onerror = () => reject(new Error('파일을 읽지 못했습니다'));
  reader.readAsDataURL(file);
});

const kindSelect = (value = 'regulation') => h('select', Object.entries(GUIDE_KINDS).map(([key, label]) => h('option', { value: key, selected: key === value }, label)));
const field = (label, input) => h('label.field', label, input);

// 파일 여러 개를 골라도 한 요청에 하나씩 올리고 파일마다 성공·실패를 남긴다. 모두 성공하면 닫고, 실패가 있으면 결과를 보여 둔다 (FR-WB-085, ERR-WB-008)
function openAddDialog(bookId, changed, dropped) {
  const kind = kindSelect();
  const title = h('input', { type: 'text', placeholder: '비우면 파일 이름(또는 첫 제목)을 씁니다' });
  const files = h('input', { type: 'file', multiple: true, accept: ACCEPT });
  if (dropped) files.files = dropped; // 끌어다 놓은 파일 — 형식은 서버가 가려 사유를 돌려준다 (ERR-WB-008)
  const markdown = h('textarea', { rows: 6, placeholder: '파일 대신 본문을 붙여 넣어도 됩니다 (Markdown)' });
  const results = h('ul.guide-results');
  const submit = h('button.btn', { type: 'submit' }, '등록');
  let busy = false;
  const dialog = h('dialog.dialog.guide-dialog',
    h('form', {
      method: 'dialog',
      onsubmit: async event => {
        event.preventDefault();
        if (busy) return;
        const list = [...files.files];
        if (!list.length && !markdown.value.trim()) return toast('파일을 고르거나 본문을 붙여 넣어 주세요.', 'error');
        busy = true;
        submit.disabled = true;
        results.replaceChildren();
        let ok = 0;
        const line = (name, node) => h('li', h('span.guide-result-name', name), node);
        if (list.length) {
          for (const file of list) {
            const li = line(file.name, h('span.muted', ' … 올리는 중'));
            results.append(li);
            try {
              if (file.size > FILE_LIMIT) throw new Error(`파일이 5MiB 를 넘습니다 (${(file.size / 1024 / 1024).toFixed(1)}MiB)`);
              const res = await api('POST', guideUrl(bookId), { kind: kind.value, title: list.length === 1 ? title.value : '', fileName: file.name, data: await readBase64(file) });
              li.replaceWith(line(file.name, h('span.ok', ` ✓ ${res.guide.id} 등록`)));
              ok++;
            } catch (err) {
              li.replaceWith(line(file.name, h('span.bad', ` ✕ ${err.message}`)));
            }
          }
        } else {
          try {
            const res = await api('POST', guideUrl(bookId), { kind: kind.value, title: title.value, markdown: markdown.value });
            results.append(line('붙여 넣은 본문', h('span.ok', ` ✓ ${res.guide.id} 등록`)));
            ok++;
          } catch (err) {
            results.append(line('붙여 넣은 본문', h('span.bad', ` ✕ ${err.message}`)));
          }
        }
        busy = false;
        submit.disabled = false;
        if (ok) await changed();
        if (ok === (list.length || 1)) dialog.close();
      },
    },
      h('h2', '기준 문서 등록'),
      h('p.muted', '규정·규칙·작성요령·작성 요구사항이 담긴 문서입니다. 장의 원문(사실의 근거)이 아니라 지시문을 채우는 데 쓰입니다. PDF·PPT(pptx)·HTML·Markdown·텍스트, 파일 하나 5MiB 까지 — DOCX 는 PDF 로 바꿔 올려 주세요.'),
      h('div.field-row', field('종류', kind), field('제목', title)),
      field('파일 (여러 개 가능)', files),
      field('또는 본문 붙여 넣기', markdown),
      results,
      h('div.row-actions.end',
        h('button.btn.ghost', { type: 'button', onclick: () => dialog.close() }, '닫기'),
        submit)));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

function openEditDialog(bookId, g, changed) {
  const kind = kindSelect(g.kind);
  const title = h('input', { type: 'text', value: g.title, required: true });
  const dialog = h('dialog.dialog',
    h('form', {
      method: 'dialog',
      onsubmit: async event => {
        event.preventDefault();
        try {
          await api('PUT', guideUrl(bookId, g.id), { kind: kind.value, title: title.value });
          dialog.close();
          await changed();
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    },
      h('h2', `기준 문서 ${g.id}`),
      h('div.field-row', field('종류', kind), field('제목', title)),
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
