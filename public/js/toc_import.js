// 목차 후보 대화상자 — 양식(docx·hwpx·hwp)에서 찾은 제목(헤딩)들을 장/챕터/헤딩(목차 수준 1·2·3) 후보로 보여 주고, 고른 것을 보고서 목차 끝의 빈 장으로 만든다 (FR-WB-093).
// 양식을 올린 직후·양식 화면 1열 머리줄 「⇪ 목차로 가져오기」·0열 양식 행의 「⇪」 가 연다(forms.js). 어느 화면 모듈도 import 하지 않는다 — 만든 결과(보고서 상태)는 onDone 으로 돌려준다.
// 후보 계산·기본 선택 규칙은 shared/toc.js headingCandidates, 수준 규칙은 normalizeLevels — 미리보기는 저장될 결과와 같은 규칙으로 번호를 매긴다.
import { headingCandidates, MAX_LEVEL, normalizeGroups, normalizeLevels, outlineNumbers } from '../shared/toc.js';
import { api } from './state.js';
import { debounce, fill, h, toast } from './util.js';

const LEVELS = [[1, '장'], [2, '챕터'], [3, '헤딩']];
const UNTITLED = '제목 없는 장'; // 빈 제목은 서버(store.importChapters)도 같은 이름으로 둔다
const IMPORT_LIMIT = 500; // 한 번에 만드는 장의 상한 — 서버와 같다
const BY_HINT = {
  outline: '문단의 개요 수준에서 찾은 제목',
  style: '제목 스타일에서 찾은 제목',
  text: '글 모양(번호·표시로 시작하는 짧은 줄)으로 찾은 제목',
  user: '작성자가 양식에서 제목으로 바꾼 것 (FR-WB-094)',
  rule: '구조 규칙이 제목으로 맞춘 것 (FR-WB-095)',
};
const BY_LABEL = { style: '스타일', text: '글', user: '작성자', rule: '규칙' };
const clampLevel = level => Math.max(1, Math.min(MAX_LEVEL, Math.trunc(Number(level)) || 1));
const byLabel = r => (r.by === 'outline' ? `개요 ${r.depth ?? r.level}` : BY_LABEL[r.by] ?? BY_LABEL.text);
// 「장으로」「챕터로」「헤딩으로」 — 받침(ㄹ 제외)이 있으면 으로, 없거나 ㄹ 이면 로
const toward = word => { const code = word.charCodeAt(word.length - 1) - 0xAC00; const final = code >= 0 && code < 11172 ? code % 28 : 0; return `${word}${final && final !== 8 ? '으로' : '로'}`; };

// 후보가 하나도 없으면 안내만 하고 열지 않는다(false). chapters 는 보고서의 지금 목차 — 고른 후보는 그 뒤에 이어진다
export function openTocImport({ bookId, form, chapters = [], onDone }) {
  const rows = headingCandidates(form.nodes).map(c => ({ ...c, level: clampLevel(c.level), title: c.title ?? '' }));
  if (!rows.length) {
    toast('이 양식에서 장 후보로 삼을 제목(헤딩)을 찾지 못했습니다.', 'error');
    return false;
  }
  if (document.querySelector('dialog.toc-import')) return false; // 이미 열려 있으면(응답 전에 두 번 누름) 또 열지 않는다
  const selected = () => rows.filter(r => r.selected);
  const tables = Array.isArray(form.tables) ? form.tables.length : 0;
  const existing = Array.isArray(chapters) ? chapters : [];
  let busy = false;

  // ── 후보 줄: 체크박스 · 수준 · 제목 · 출처 배지 (원문 글은 툴팁)
  function candidateRow(r) {
    const check = h('input', { type: 'checkbox', checked: r.selected, 'aria-label': `고르기: ${r.title || UNTITLED}`, onchange: () => { r.selected = check.checked; paintRow(r); refresh(); } });
    const seg = h('div.segmented', { role: 'group', 'aria-label': `${r.title || UNTITLED} 의 수준` },
      LEVELS.map(([level, label]) => h('button', { type: 'button', title: `${label} (수준 ${level})`, onclick: () => { r.level = level; paintRow(r); refresh(); } }, label)));
    const title = h('input.toc-cand-title', { type: 'text', value: r.title, placeholder: UNTITLED, title: r.text, 'aria-label': '제목', oninput: () => { r.title = title.value; check.setAttribute('aria-label', `고르기: ${r.title || UNTITLED}`); previewSoon(); } });
    const badge = h('span.kind-badge', { class: `by-${r.by}`, title: `${BY_HINT[r.by] ?? BY_HINT.text}${r.depth > MAX_LEVEL ? ` — 깊이 ${r.depth} (목차는 ${MAX_LEVEL}수준까지)` : ''}` }, byLabel(r));
    const node = h('div.toc-cand', { title: r.text, dataset: { i: r.i } }, check, seg, title, badge);
    Object.assign(r, { node, check, seg });
    paintRow(r);
    return node;
  }

  function paintRow(r) {
    r.node.className = `toc-cand lvl-${r.level} ${r.selected ? 'is-on' : 'is-off'}`;
    r.check.checked = r.selected;
    [...r.seg.children].forEach((button, k) => {
      const on = LEVELS[k][0] === r.level;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', String(on));
    });
  }

  // ── 도구줄: 고르기 셋 · 고른 후보의 수준 옮기기 다섯
  const tool = (label, title, fn) => h('button.btn.small.ghost', { type: 'button', title, onclick: () => { fn(); rows.forEach(paintRow); refresh(); } }, label);
  const structured = rows.some(r => r.by !== 'text');
  const pickTools = [
    tool('모두 고르기', '찾은 제목을 모두 장 후보로 고릅니다', () => rows.forEach(r => { r.selected = true; })),
    tool('개요·스타일만', structured ? `문단 개요 수준·제목 스타일에서 찾은 제목과 작성자·구조 규칙이 제목으로 둔 것만(깊이 ${MAX_LEVEL}까지) 고르고, 글 모양으로 찾은 제목은 해제합니다` : '이 문서에는 개요 수준·제목 스타일로 찾았거나 작성자·규칙이 정한 제목이 없습니다', () => rows.forEach(r => { r.selected = r.by !== 'text' && r.depth <= MAX_LEVEL; })),
    tool('모두 해제', '모두 해제합니다 — 고른 것이 없으면 장을 만들지 않습니다', () => rows.forEach(r => { r.selected = false; })),
  ];
  pickTools[1].disabled = !structured;
  const levelTools = [
    tool('⇤ 상위로', '고른 후보의 수준을 한 단계 올립니다 (헤딩 → 챕터 → 장)', () => selected().forEach(r => { r.level = Math.max(1, r.level - 1); })),
    tool('⇥ 하위로', '고른 후보의 수준을 한 단계 내립니다 (장 → 챕터 → 헤딩)', () => selected().forEach(r => { r.level = Math.min(MAX_LEVEL, r.level + 1); })),
    ...LEVELS.map(([level, label]) => tool(toward(label), `고른 후보를 모두 ${toward(label)} 둡니다 (수준 ${level})`, () => selected().forEach(r => { r.level = level; }))),
  ];

  // 고른 후보를 기존 목차 뒤에 이을 때의 수준 — 상위 제목이 빠진 형제 묶음은 함께 올린다(normalizeGroups). 미리보기와 만들기가 같은 값을 쓴다
  const settled = () => normalizeGroups(selected().map(r => ({ title: r.title.trim() || UNTITLED, level: r.level, wanted: r.level })), existing.at(-1)?.level ?? 0);

  // ── 미리보기: 기존 목차(흐리게) 뒤에 고른 후보를 이어 규칙 안으로 맞춘 결과 — 규칙에 맞춰 바뀐 수준은 「→ 2」로
  const previewList = h('div.toc-preview-rows');
  const previewPane = h('section.toc-import-preview', { 'aria-label': '미리보기' }, h('h3', '미리보기'), previewList);
  function preview() {
    const merged = normalizeLevels([
      ...existing.map(ch => ({ title: ch.title || UNTITLED, level: ch.level, existing: true })),
      ...settled(),
    ]);
    const numbers = outlineNumbers(merged);
    const keep = previewPane.scrollTop;
    fill(previewList, merged.length
      ? merged.map((item, k) => h('div.tree-row.toc-preview-row', { class: `lvl-${item.level} ${item.existing ? 'is-existing' : 'is-new'}`, title: item.existing ? '기존 장' : null },
        h('span.tree-no', numbers[k]),
        h('span.toc-preview-title', item.title),
        item.wanted != null && item.wanted !== item.level && h('span.toc-preview-shift', { title: `규칙에 맞춰 수준 ${item.wanted} 이 ${item.level} 로 바뀝니다 — 첫 장은 장(1)이고, 각 장은 바로 앞 장의 수준 + 1 을 넘지 않습니다` }, `→ ${item.level}`)))
      : h('p.muted', '고른 후보가 없습니다.'));
    previewPane.scrollTop = keep;
  }
  const previewSoon = debounce(preview, 120);

  // ── 바닥: 취소 · 장 M개 만들기
  const create = h('button.btn', { type: 'button', onclick: submit }, '장 0개 만들기');
  function refresh() {
    const count = selected().length;
    for (const button of levelTools) button.disabled = !count;
    create.textContent = `장 ${count}개 만들기`;
    create.disabled = busy || !count || count > IMPORT_LIMIT;
    create.title = count > IMPORT_LIMIT ? `한 번에 ${IMPORT_LIMIT}개까지 만들 수 있습니다 — 고른 후보를 줄여 주세요` : count ? `고른 ${count}개를 빈 장으로 기존 장 ${existing.length}개 뒤에 만듭니다` : '후보를 하나 이상 고르세요';
    preview();
  }

  // 만들기 → 서버가 목차 끝에 빈 장으로 붙여 보고서 상태를 돌려준다 → 닫고 onDone. 실패하면 알리고 대화상자는 그대로 둔다
  async function submit() {
    const picked = selected();
    if (busy || !picked.length || picked.length > IMPORT_LIMIT) return;
    busy = true;
    create.disabled = true;
    cancel.disabled = true;
    try {
      const data = await api('POST', '/api/book/chapters/import', { bookId, chapters: settled().map(({ title, level }) => ({ title, level })) });
      dialog.close();
      await onDone?.(data);
      toast(`장 ${picked.length}개를 만들었습니다`);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      busy = false;
      cancel.disabled = false;
      if (dialog.isConnected) refresh();
    }
  }

  // 만드는 동안은 닫지 않는다 — 닫히면 실패해도 고른 것을 다시 쓸 수 없고, 취소한 줄 알았는데 장이 생긴다 (Esc 는 cancel 이벤트)
  const cancel = h('button.btn.ghost', { type: 'button', onclick: () => { if (!busy) dialog.close(); } }, '취소');
  const picked = selected().length;
  const dialog = h('dialog.dialog.toc-import', { 'aria-labelledby': 'toc-import-title' },
    h('h2', { id: 'toc-import-title' }, `목차 후보 — ${form.title || form.fileName || form.id}`),
    h('p.muted', `문서에서 찾은 제목 ${rows.length}개 중 ${picked}개를 골라 두었습니다. 고른 것만 장이 되고, 표 ${tables}개는 양식 ${form.id} 에 있습니다. 기존 장 ${existing.length}개 뒤에 이어집니다.`),
    h('div.toc-import-tools', { role: 'toolbar', 'aria-label': '후보 고르기·수준 옮기기' },
      pickTools,
      h('span.toc-tools-label', '고른 후보:'),
      levelTools),
    h('div.toc-import-body',
      h('section.toc-import-list', { 'aria-label': '제목 후보 — 문서 순서' }, rows.map(candidateRow)),
      previewPane),
    h('div.row-actions.end', cancel, create));
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => dialog.remove()); // Esc(cancel)·취소·만들기 — 모두 close 를 거쳐 지운다
  document.body.append(dialog);
  dialog.showModal();
  refresh();
  const first = previewList.querySelector('.is-new'); // 기존 장이 많으면 새 장이 보이는 자리로 — 보인 뒤에 재야 offsetTop 이 있다
  if (first) previewPane.scrollTop = Math.max(0, first.offsetTop - 40);
  return true;
}
