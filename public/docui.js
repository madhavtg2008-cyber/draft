// ================= Zoit — the document screen, laid out like Word =================
// · a menu (File, Edit, View, Insert, Format, Page Setup, Review, Tools): each shows its own row of tools
// · a ruler above the page, in centimetres, whose margin markers can be dragged
// · Page Setup: size, orientation and margins
// · a status bar: words, characters, page X of Y, Track Changes, zoom

const PX_PER_CM = 96 / 2.54;
const PAGE_SIZES = { a4: [11906, 16838], letter: [12240, 15840], legal: [12240, 20160], a5: [8391, 11906] };
const PAGE_MARGINS = {
  normal: { top: 1440, bottom: 1440, left: 1440, right: 1440 },
  narrow: { top: 720, bottom: 720, left: 720, right: 720 },
  moderate: { top: 1440, bottom: 1440, left: 1080, right: 1080 },
  wide: { top: 1440, bottom: 1440, left: 2880, right: 2880 },
  legal: { top: 1440, bottom: 1440, left: 2160, right: 1440 }, // a wider binding margin on the left
};

// ---------- the menu ----------
function showMenu(name) {
  lsSet('lex_menu', name);
  $('#toolbar').dataset.menu = name;
  $$('#menuBar [data-menu]').forEach((b) => b.classList.toggle('on', b.dataset.menu === name));
  if (name === 'review' && typeof applyReviewBar === 'function') applyReviewBar();
  if (name === 'layout') fillPageSetup();
  if (name === 'view') fillView();
}
$('#menuBar').addEventListener('mousedown', (e) => e.preventDefault()); // keep the cursor in the text
$('#menuBar').addEventListener('click', (e) => { const b = e.target.closest('[data-menu]'); if (b) showMenu(b.dataset.menu); });
$('#toolbar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
showMenu(lsGet('lex_menu') || 'format');

// ---------- Edit · Tools ----------
$$('#toolbar [data-cmd="cut"], #toolbar [data-cmd="copy"], #toolbar [data-cmd="selectAll"]').forEach((b) => b.addEventListener('click', () => {
  editor().focus();
  document.execCommand(b.dataset.cmd);
}));
$('[data-goto-find]').addEventListener('click', () => $('#tbFind').click());
$('#tlCount').addEventListener('click', () => {
  const text = editor().innerText, paras = liveBlocks().filter((el) => el.textContent.trim()).length;
  ledger(`${words(text).toLocaleString()} words · ${text.replace(/\s/g, '').length.toLocaleString()} characters (no spaces) · ${text.replace(/\n/g, '').length.toLocaleString()} with spaces · ${paras} paragraphs · ${$$('#sheets .sheet-pg').length || 1} pages`);
});
$('#tlSpell').addEventListener('click', () => {
  const on = lsGet('lex_spell') === '0';
  lsSet('lex_spell', on ? '1' : '0');
  applySpell();
});
function applySpell() {
  const on = lsGet('lex_spell') !== '0';
  editor().spellcheck = on;
  $('#tlSpell').classList.toggle('on', on);
}
applySpell();

// ---------- View ----------
function fillView() {
  $('#tbRuler').classList.toggle('on', lsGet('lex_ruler') !== '0');
  $('#tbComments').classList.toggle('on', lsGet('lex_margin_off') !== '1');
}
$('#tbRuler').addEventListener('click', () => { lsSet('lex_ruler', lsGet('lex_ruler') === '0' ? '1' : '0'); fillView(); drawRuler(); });
$('#tbComments').addEventListener('click', () => { foldMargin(lsGet('lex_margin_off') !== '1'); fillView(); });

// ---------- Page Setup ----------
const curPage = () => ({ ...(state.cur?.draft.page || DEFAULT_PAGE) });
function fillPageSetup() {
  const p = curPage(), portrait = p.h >= p.w;
  const [a, b] = portrait ? [p.w, p.h] : [p.h, p.w];
  const size = Object.keys(PAGE_SIZES).find((k) => Math.abs(PAGE_SIZES[k][0] - a) < 40 && Math.abs(PAGE_SIZES[k][1] - b) < 40);
  $('#psSize').value = size || 'custom';
  $('#psOrient').value = portrait ? 'portrait' : 'landscape';
  const m = Object.keys(PAGE_MARGINS).find((k) => ['top', 'bottom', 'left', 'right'].every((s) => Math.abs(PAGE_MARGINS[k][s] - p[s]) < 30));
  $('#psMargins').value = m || 'custom';
  const can = !!state.cur?.lanes[state.lane]?.editable && state.me.role === 'team';
  for (const id of ['psSize', 'psOrient', 'psMargins']) $(`#${id}`).disabled = !can;
}
async function savePage(page, note) {
  if (!state.cur) return;
  const prev = state.cur.draft.page;
  state.cur.draft.page = page; // show it straight away
  applyZoom(); layoutPages(); drawRuler();
  try {
    await api('PATCH', `/api/drafts/${state.cur.draft.id}`, { page });
    if (note) ledger(note);
  } catch (err) {
    state.cur.draft.page = prev; applyZoom(); layoutPages(); drawRuler();
    ledger(err.message);
  }
  fillPageSetup();
}
$('#psSize').addEventListener('change', (e) => {
  const p = curPage(), [w, h] = PAGE_SIZES[e.target.value], land = p.w > p.h;
  savePage({ ...p, w: land ? h : w, h: land ? w : h }, `Page size: ${e.target.selectedOptions[0].textContent}.`);
});
$('#psOrient').addEventListener('change', (e) => {
  const p = curPage(), land = e.target.value === 'landscape';
  if (land === p.w > p.h) return;
  // turning the page turns its margins with it
  savePage({ ...p, w: p.h, h: p.w, top: p.left, right: p.top, bottom: p.right, left: p.bottom }, `Orientation: ${e.target.value}.`);
});
$('#psMargins').addEventListener('change', (e) => savePage({ ...curPage(), ...PAGE_MARGINS[e.target.value] }, `Margins: ${e.target.selectedOptions[0].textContent}.`));

// ---------- the ruler ----------
// Drawn in the page's own pixels and scaled with the page, so it lines up at any zoom.
// The grey ends are the margins; drag a marker to move that margin.
const ruler = $('#ruler'), rulerBar = $('#rulerBar');
function drawRuler() {
  const show = !!state.lane && state.view === 'text' && lsGet('lex_ruler') !== '0' && !isPhone();
  rulerBar.classList.toggle('hidden', !show);
  if (!show) return;
  const g = pageGeom(), col = $('#paperCol').getBoundingClientRect(), bar = rulerBar.getBoundingClientRect();
  const k = col.width / g.w || 1;
  Object.assign(ruler.style, { left: `${col.left - bar.left}px`, width: `${g.w}px`, transform: `scale(${k})` });
  const cm = Math.floor(g.w / PX_PER_CM);
  let ticks = '';
  // numbers count from the left margin, as in Word
  for (let i = 0; i <= cm * 4; i++) {
    const x = i * PX_PER_CM / 4;
    if (x > g.w) break;
    const fromMargin = (x - g.ml) / PX_PER_CM;
    const whole = i % 4 === 0;
    ticks += whole && Math.abs(fromMargin) > 0.01 ? `<span class="rl-num" style="left:${x}px">${Math.round(Math.abs(fromMargin))}</span>` : `<i class="rl-tick${i % 2 === 0 ? ' half' : ''}" style="left:${x}px"></i>`;
  }
  const canDrag = !!state.cur?.lanes[state.lane]?.editable && state.me.role === 'team';
  ruler.innerHTML = `<div class="rl-margin" style="left:0;width:${g.ml}px"></div><div class="rl-margin" style="right:0;width:${g.mr}px"></div>${ticks}
    <span class="rl-handle${canDrag ? '' : ' fixed'}" data-side="left" style="left:${g.ml}px" title="Left margin: ${(g.ml / PX_PER_CM).toFixed(2)} cm"></span>
    <span class="rl-handle${canDrag ? '' : ' fixed'}" data-side="right" style="left:${g.w - g.mr}px" title="Right margin: ${(g.mr / PX_PER_CM).toFixed(2)} cm"></span>`;
}
ruler.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('.rl-handle:not(.fixed)');
  if (!handle) return;
  e.preventDefault();
  const side = handle.dataset.side, g = pageGeom(), k = $('#paperCol').getBoundingClientRect().width / g.w || 1;
  const startX = e.clientX, start = side === 'left' ? g.ml : g.mr;
  let val = start;
  try { handle.setPointerCapture(e.pointerId); } catch { /* keep dragging without capture */ }
  ruler.classList.add('dragging');
  const move = (ev) => {
    const d = (ev.clientX - startX) / k;
    // snap to quarter-centimetres; keep at least 2 cm of text between the margins
    val = Math.round(Math.min(Math.max(side === 'left' ? start + d : start - d, 0), g.w - (side === 'left' ? g.mr : g.ml) - 2 * PX_PER_CM) / (PX_PER_CM / 4)) * (PX_PER_CM / 4);
    handle.style.left = `${side === 'left' ? val : g.w - val}px`;
    handle.title = `${(val / PX_PER_CM).toFixed(2)} cm`;
    editor().style[side === 'left' ? 'paddingLeft' : 'paddingRight'] = `${val}px`; // the text follows as you drag
    $(`.rl-margin:nth-child(${side === 'left' ? 1 : 2})`, ruler).style.width = `${val}px`;
    ruler.dataset.tip = `${side === 'left' ? 'Left' : 'Right'} margin ${(val / PX_PER_CM).toFixed(2)} cm`;
  };
  const up = () => {
    handle.removeEventListener('pointermove', move);
    ruler.classList.remove('dragging');
    delete ruler.dataset.tip;
    if (Math.abs(val - start) < 1) return drawRuler();
    savePage({ ...curPage(), [side]: Math.round(val * TWIPS_PER_PX) }, `${side === 'left' ? 'Left' : 'Right'} margin: ${(val / PX_PER_CM).toFixed(2)} cm.`);
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up, { once: true });
});

// ---------- the status bar ----------
function updateStatus() {
  const bar = $('#statusBar');
  bar.classList.toggle('hidden', !state.lane);
  if (!state.lane) return;
  const text = editor().innerText || '';
  $('#sbWords').textContent = `Words: ${words(text).toLocaleString()}`;
  $('#sbChars').textContent = `Characters: ${text.replace(/\n/g, '').length.toLocaleString()}`;
  const pages = $$('#sheets .sheet-pg');
  $('#sbPages').textContent = Math.max(1, pages.length);
  // the page whose sheet is in the middle of the view
  const mid = $('#sheetScroll').getBoundingClientRect().top + $('#sheetScroll').clientHeight / 2;
  const at = pages.findIndex((p) => { const r = p.getBoundingClientRect(); return r.top <= mid && r.bottom >= mid; });
  $('#sbPage').textContent = at >= 0 ? at + 1 : 1;
  $('#sbZoom').textContent = `${Math.round((Number($('#paperCol').style.zoom) || 1) * 100)}%`;
}

// keep the ruler and status bar in step with the page
let uiTimer;
const uiSoon = () => { clearTimeout(uiTimer); uiTimer = setTimeout(() => { drawRuler(); updateStatus(); }, 60); };
new ResizeObserver(uiSoon).observe($('#paperCol'));
$('#sheetScroll').addEventListener('scroll', () => { updateStatus(); drawRuler(); }, { passive: true });
editor().addEventListener('input', uiSoon);
window.addEventListener('resize', uiSoon);
setInterval(() => { if (state.lane) uiSoon(); }, 1500);
