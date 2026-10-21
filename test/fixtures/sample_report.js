// 테스트 붙박이 자료 — 규칙 검사와 수집 흐름을 확인하기 위한 가상 보고서다. 기관·수치·URL 모두 실제가 아니다.
import crypto from 'node:crypto';
import { buildAnchorIndex, buildBlocks, evidenceFromAnchor } from '../../public/shared/model.js';

const h = (loc, level, text) => ({ kind: 'heading', level, loc, text });
const p = (loc, text, key) => ({ kind: 'paragraph', loc, text, key });
const ul = (loc, items, key) => ({ kind: 'list', loc, items, key });
const table = (loc, key, t) => ({ kind: 'table', loc, key, table: t });

function source(meta, drafts) {
  const blocks = buildBlocks(meta.id, drafts);
  const hash = 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(blocks)).digest('hex');
  return { version: 'V-001', collectedAt: '2026-09-18T09:30:00+09:00', sample: true, ...meta, hash, blocks };
}

function sources() {
  return [
    source({
      id: 'S-001', type: 'pdf',
      title: '2025년 한빛시 청년 고용 동향 보고서',
      publisher: '한빛시 통계연구원 (가상 기관)', publishedAt: '2026-02-27',
      url: 'https://example.org/hanbit/youth-employment-2025.pdf',
      method: '일반 HTTP 수집',
      adoptReason: '청년 고용률·실업률·취업자 수의 연도별 원자료 표가 있는 원발행처 보고서',
    }, [
      h({ page: 1 }, 1, '2025년 한빛시 청년 고용 동향 보고서'),
      p({ page: 3 }, '본 보고서는 한빛시에 거주하는 15~29세 청년의 고용 현황을 연간 단위로 정리한다. 조사 기준 시점은 매년 12월이며, 모든 비율은 연간 평균값이다.', 'scope'),
      h({ page: 12 }, 2, '3. 주요 고용 지표'),
      p({ page: 12 }, '2025년 청년 고용률은 전년보다 상승했고 실업률은 하락했다. 경제활동참가율은 2년 연속 50%를 웃돌았다.', 'summary'),
      table({ page: 12 }, 'rates', {
        title: '표 2. 청년(15~29세) 고용 지표', unit: '%', denominator: '15~29세 인구 (실업률은 경제활동인구)',
        columns: ['구분', '2023년', '2024년', '2025년'],
        rows: [
          ['고용률', '45.9', '47.2', '48.6'],
          ['실업률', '7.8', '7.1', '6.4'],
          ['경제활동참가율', '49.8', '50.8', '51.9'],
        ],
        notes: ['주: 고용률 = 취업자 ÷ 15~29세 인구 × 100, 실업률 = 실업자 ÷ 경제활동인구 × 100.'],
      }),
      h({ page: 13 }, 2, '4. 취업자 규모'),
      table({ page: 13 }, 'workers', {
        title: '표 3. 청년 취업자 및 인구', unit: '명',
        columns: ['구분', '2023년', '2024년', '2025년'],
        rows: [
          ['청년 취업자', '118,240', '121,530', '126,910'],
          ['청년 실업자', '10,003', '9,288', '8,677'],
          ['15~29세 인구', '257,603', '257,479', '261,132'],
        ],
        notes: ['주: 각 연도 12월 기준 주민등록 인구와 연간 평균 취업자 수.'],
      }),
      p({ page: 14 }, '산업별로는 정보통신업과 전문·과학기술 서비스업에서 청년 취업자가 가장 많이 늘었다. 제조업 청년 취업자는 2년 연속 감소했다.', 'industry'),
    ]),
    source({
      id: 'S-002', type: 'web',
      title: '한빛시, 2025년 청년 일자리 지원사업 성과 발표',
      publisher: '한빛시청 보도자료 (가상 기관)', publishedAt: '2026-01-15',
      url: 'https://example.org/hanbit/press/2026-0115',
      method: '백그라운드 CDP 수집 (렌더링 후 DOM 스냅샷)',
      adoptReason: '지원사업 참여자·취업 연계 실적의 1차 발표 자료',
    }, [
      h({ para: 1 }, 1, '한빛시, 2025년 청년 일자리 지원사업 성과 발표'),
      p({ para: 2 }, '한빛시는 15일 2025년 청년 일자리 지원사업의 운영 결과를 발표했다.', 'lead'),
      p({ para: 3 }, '지난해 지원사업에는 모두 4,312명이 참여했다. 이 가운데 1,968명이 사업 종료 후 6개월 안에 취업으로 연계되었다. 참여자 만족도 조사의 평균 점수는 5점 만점에 4.2점이었다.', 'result'),
      p({ para: 4 }, '시는 올해 청년정책 예산을 86.0억 원으로 편성했다고 밝혔다. 세부 배분은 청년정책 추진계획에서 공개한다.', 'budget'),
      p({ para: 5 }, '시 관계자는 "참여자의 절반 가까이가 일자리를 찾았다"며 "올해는 직무 교육 과정을 늘리겠다"고 말했다.', 'quote'),
    ]),
    source({
      id: 'S-003', type: 'pptx',
      title: '청년정책 추진계획 2026 (발표자료)',
      publisher: '한빛시 청년정책과 (가상 기관)', publishedAt: '2026-03-10',
      url: 'https://example.org/hanbit/youth-plan-2026.pptx',
      method: '일반 HTTP 수집',
      adoptReason: '2026년 청년정책 예산의 분야별 배분표가 있는 원자료',
    }, [
      h({ slide: 1 }, 1, '청년정책 추진계획 2026'),
      h({ slide: 3 }, 2, '추진 방향'),
      ul({ slide: 3 }, ['일자리 분야에 예산을 가장 많이 배정한다.', '직무 교육 과정을 12개에서 18개로 늘린다.', '2026년 청년 고용률 목표는 50.0%이다.'], 'direction'),
      h({ slide: 5 }, 2, '분야별 예산'),
      table({ slide: 5 }, 'budget', {
        title: '분야별 예산 배분', unit: '억 원',
        columns: ['분야', '2025년 예산', '2026년 예산'],
        rows: [
          ['일자리', '36.0', '41.5'],
          ['주거', '27.5', '28.0'],
          ['교육·문화', '14.5', '16.5'],
          ['합계', '78.0', '86.0'],
        ],
        notes: ['발표자 노트: 2026년 증액분 8.0억 원 가운데 5.5억 원이 일자리 분야다.'],
      }),
    ]),
  ];
}

// 샘플 보고서 — 규칙 검사가 잡아내는 사례(수치 불일치·근거 없음)를 일부러 하나씩 넣었다.
export function buildSampleReport() {
  const srcs = sources();
  const index = buildAnchorIndex(srcs);
  const byKey = new Map(srcs.flatMap(s => s.blocks.filter(b => b.key).map(b => [b.key, b])));
  const cell = (key, row, col) => {
    const t = byKey.get(key).table;
    return t.rows.find(r => r.header === row).cells[t.columns.indexOf(col) - 1].id;
  };
  const sent = (key, n) => byKey.get(key).sentences[n - 1].id;

  const evidence = {};
  const evidenceByAnchor = new Map();
  const ev = anchorId => {
    if (!evidenceByAnchor.has(anchorId)) {
      const id = `E-${String(evidenceByAnchor.size + 1).padStart(4, '0')}`;
      evidence[id] = { id, ...evidenceFromAnchor(index, anchorId) };
      evidenceByAnchor.set(anchorId, id);
    }
    return evidenceByAnchor.get(anchorId);
  };

  let seq = 0;
  const S = (text, type, anchors = [], extra = {}) => ({ id: `T-${String(++seq).padStart(4, '0')}`, text, type, evidence: anchors.map(ev), ...extra });
  const calc = (expr, unit, round, inputs) => ({ calc: { expr, unit, round, inputs: Object.fromEntries(Object.entries(inputs).map(([k, a]) => [k, { ev: ev(a), n: 0 }])) } });

  const rate25 = cell('rates', '고용률', '2025년');
  const rate23 = cell('rates', '고용률', '2023년');
  const unemp23 = cell('rates', '실업률', '2023년');
  const unemp25 = cell('rates', '실업률', '2025년');
  const workers25 = cell('workers', '청년 취업자', '2025년');
  const workers23 = cell('workers', '청년 취업자', '2023년');
  const joined = sent('result', 1);
  const placed = sent('result', 2);

  const blocks = [
    { id: 'P-01', kind: 'heading', sentences: [S('한빛시 청년 고용 동향 요약', 'connective')] },
    { id: 'P-02', kind: 'paragraph', sentences: [
      S('이 문서는 한빛시 청년 고용과 관련해 수집한 자료 3건을 근거로 작성한 요약이다.', 'connective'),
      S('2025년 한빛시 청년(15~29세) 고용률은 48.6%로 집계되었다.', 'fact', [rate25], { reviewedText: '2025년 한빛시 청년(15~29세) 고용률은 48.6%로 집계되었다.' }),
      S('이는 2023년의 45.9%보다 2.7%p 높은 수준이다.', 'fact', [rate23, rate25], calc('b - a', '%p', 1, { a: rate23, b: rate25 })),
      S('같은 기간 청년 실업률은 7.8%에서 6.9%로 낮아졌다.', 'fact', [unemp23, unemp25]),
    ] },
    { id: 'P-03', kind: 'paragraph', sentences: [
      S('청년 취업자 수는 2025년 126,910명으로 2023년보다 8,670명 늘었다.', 'fact', [workers25, workers23], calc('a - b', '명', 0, { a: workers25, b: workers23 })),
      S('시의 청년 일자리 지원사업에는 4,312명이 참여했고, 이 가운데 1,968명이 취업으로 연계되었다.', 'fact', [joined, placed]),
      S('참여자 대비 취업 연계 비율은 약 45.6%로, 지원사업이 고용 지표 개선에 기여했을 가능성이 있다.', 'interpretation', [joined, placed], calc('b / a * 100', '%', 1, { a: joined, b: placed })),
      S('청년 창업 기업 수도 전년보다 크게 늘었다.', 'fact'),
    ] },
    { id: 'P-04', kind: 'paragraph', sentences: [
      S('시는 2026년 청년정책 예산 86.0억 원 가운데 41.5억 원을 일자리 분야에 배정했다.', 'fact', [cell('budget', '합계', '2026년 예산'), cell('budget', '일자리', '2026년 예산')]),
      S('후속 조사에서는 산업별·연령별 세부 지표를 추가로 확인할 필요가 있다.', 'proposal'),
    ] },
  ];

  return { sources: srcs, doc: { id: 'R-001', title: '한빛시 청년 고용 동향 요약 (샘플)', blocks }, evidence };
}
