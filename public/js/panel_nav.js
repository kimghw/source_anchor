// 좁은 화면의 패널 바로가기 — 저장한 너비는 유지하고 공용 .shell만 이동한다.
export function initPanelNav() {
  const nav = document.getElementById('panel-nav');
  const shell = document.querySelector('.shell');
  if (!nav || !shell) return;
  const compact = window.matchMedia('(max-width: 1000px)');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const buttons = [...nav.querySelectorAll('button[data-panel]')];
  const workspaces = [...shell.querySelectorAll('.workspace')];
  const selectors = { main: '.col-editor, .col-chapters', chat: '.col-chat', sources: '.col-sources' };
  let workspace = null;
  let selected = 'main';
  let frame = 0;

  const activeWorkspace = () => workspaces.find(node => !node.hidden);
  const panel = key => key === 'explorer' ? document.getElementById('explorer') : workspace?.querySelector(selectors[key]);
  const markSelected = key => {
    selected = key;
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.panel === key));
  };

  function reveal(smooth = false) {
    if (!compact.matches) return;
    const target = panel(selected);
    if (!target) return;
    if (target.classList.contains('is-collapsed')) target.querySelector('.collapse-btn')?.click();
    const inset = parseFloat(getComputedStyle(shell).paddingLeft) || 0;
    const left = shell.scrollLeft + target.getBoundingClientRect().left - shell.getBoundingClientRect().left - shell.clientLeft - inset;
    shell.scrollTo({ left: Math.max(0, left), behavior: smooth && !reducedMotion.matches ? 'smooth' : 'instant' });
  }

  function refresh() {
    frame = 0;
    const next = activeWorkspace();
    if (next !== workspace) {
      workspace = next;
      selected = 'main';
    }
    for (const button of buttons) button.disabled = !panel(button.dataset.panel);
    markSelected(selected);
    if (compact.matches) reveal();
    else shell.scrollTo({ left: 0, behavior: 'instant' });
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(refresh);
  }

  nav.addEventListener('click', event => {
    const button = event.target.closest('button[data-panel]');
    if (!button || button.disabled || !compact.matches) return;
    markSelected(button.dataset.panel);
    reveal(true);
  });
  const observer = new MutationObserver(schedule);
  for (const node of workspaces) observer.observe(node, { attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('resize', schedule);
  compact.addEventListener('change', schedule);
  schedule();
}
