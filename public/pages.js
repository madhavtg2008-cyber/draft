// ================= Zoit — real pages, zoom, confirmations =================
// Loaded after app.js and editor.js; shares their globals.
//
// The document is laid out on sheets of the matter's own page size and margins (taken from
// an imported Word file, A4 / 1-inch otherwise). Where a page's bottom margin falls inside a
// paragraph, an invisible spacer is slipped in at the start of the line that doesn't fit, so
// that line begins at the top of the next page — the way Word breaks pages. Spacers exist only
// on screen: they are stripped from everything that is saved (see docHtml()).

const TWIPS_PER_PX = 15; // 1440 twips per inch ÷ 96 CSS px per inch
const PAGE_GAP = 26;     // dark gap between sheets, in px
const DEFAULT_PAGE = { w: 11906, h: 16838, top: 1440, right: 1440, bottom: 1440, left: 1440 }; // A4, 1-inch margins

function pageGeom() {
  const p = state.cur?.draft.page || DEFAULT_PAGE;
  return { w: p.w / TWIPS_PER_PX, h: p.h / TWIPS_PER_PX, mt: p.top / TWIPS_PER_PX, mr: p.right / TWIPS_PER_PX, mb: p.bottom / TWIPS_PER_PX, ml: p.left / TWIPS_PER_PX };
}

// The document exactly as it is saved: without the on-screen page spacers.
function docHtml() {
  const ed = editor();
  if (!ed.querySelector('.pg-gap, .tc')) return ed.innerHTML;
  const copy = ed.cloneNode(true);
  copy.querySelectorAll('.pg-gap').forEach((g) => g.remove());
  // review markup: struck-out text isn't part of the document, and added text is just text
  copy.querySelectorAll('del.tc').forEach((d) => d.remove());
  copy.querySelectorAll('ins.tc').forEach((i) => i.replaceWith(...i.childNodes));
  return copy.innerHTML;
}

// Paragraph-like pieces of the document, in reading order (list items count individually).
function flowUnits(root) {
  const out = [];
  const walk = (el) => {
    for (const c of el.children) {
      if (c.classList.contains('pg-gap')) continue;
      if (c.tagName === 'UL' || c.tagName === 'OL') walk(c);
      else if (c.tagName === 'LI') { out.push(c); [...c.children].filter((k) => k.tagName === 'UL' || k.tagName === 'OL').forEach(walk); }
      else out.push(c);
    }
  };
  walk(root);
  return out;
}
const isTextUnit = (u) => /^(P|H[1-6]|LI|BLOCKQUOTE)$/.test(u.tagName);
// text nodes belonging to a unit itself (not to a nested list)
function ownTextNodes(u) {
  const nodes = [];
  const w = document.createTreeWalker(u, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const list = n.parentElement.closest('ul,ol');
      return list && u.contains(list) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; // skip nested lists
    },
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) if (n.data.length) nodes.push(n);
  return nodes;
}
function makeGap(height, block = false) {
  const g = document.createElement(block ? 'div' : 'span');
  g.className = 'pg-gap';
  g.contentEditable = 'false';
  g.style.display = 'block';
  g.style.height = `${Math.max(0, height)}px`;
  return g;
}

let laying = false;
// Phones get a reading mode: the text flows to the screen's width at a normal size instead of a shrunken
// A4 page. The exact page layout (and Word / PDF export) is unchanged; it's only how it shows on a phone.
const isPhone = () => window.innerWidth < 760;
function layoutPages() {
  if (!state.lane || state.view !== 'text' || !state.cur || laying) return;
  laying = true;
  try {
    const ed = editor(), g = pageGeom(), pitch = g.h + PAGE_GAP;
    ed.querySelectorAll('.pg-gap').forEach((s) => s.remove());
    if (isPhone()) {
      Object.assign(ed.style, { width: '100%', padding: '24px 18px 64px', minHeight: '60vh' });
      $('#paperCol').style.width = '100%';
      $('#sheets').innerHTML = '<div class="sheet-pg phone" style="top:0;height:100%"></div>';
      state.pages = 1;
      return;
    }
    Object.assign(ed.style, { width: `${g.w}px`, padding: `${g.mt}px ${g.mr}px ${g.mb}px ${g.ml}px`, minHeight: `${g.h}px` });
    $('#paperCol').style.width = `${g.w}px`;

    const base = () => ed.getBoundingClientRect();
    const scale = () => base().width / g.w || 1; // zoom factor
    const yOf = (rect) => (rect.top - base().top) / scale();
    const bottomOf = (rect) => (rect.bottom - base().top) / scale();
    const charRect = (node, i) => { const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 1); const rs = r.getClientRects(); return rs[rs.length - 1] || r.getBoundingClientRect(); };

    // The lines of a text unit (top/bottom of each), from the browser's own line boxes.
    function linesOf(u) {
      const rects = [];
      for (const n of ownTextNodes(u)) { const r = document.createRange(); r.selectNodeContents(n); rects.push(...r.getClientRects()); }
      const lines = [];
      for (const r of rects.filter((x) => x.height > 0).sort((a, b) => a.top - b.top)) {
        const t = yOf(r), b = bottomOf(r), last = lines[lines.length - 1];
        if (last && t < last.bottom - 2) last.bottom = Math.max(last.bottom, b); else lines.push({ top: t, bottom: b });
      }
      return lines;
    }
    // Where to break a paragraph that runs past `limit`, following Word's widow/orphan control:
    // at least two lines stay behind and at least two move on — otherwise the whole paragraph moves.
    function lineCut(u, limit) {
      const lines = linesOf(u);
      let k = lines.findIndex((l) => l.bottom > limit + 0.5);
      if (k < 0) return null;
      const widowControl = u.tagName !== 'H1' && u.tagName !== 'H2' && u.tagName !== 'H3' && u.tagName !== 'H4';
      if (widowControl && lines.length - k < 2) k -= 1;    // don't strand a single last line on the next page
      if (k < (widowControl ? 2 : 1)) return 'whole';      // don't leave a single first line behind
      const nodes = ownTextNodes(u);
      const idx = [];
      nodes.forEach((n) => { for (let i = 0; i < n.data.length; i++) if (n.data[i] !== '\n') idx.push([n, i]); });
      const lineTop = lines[k].top;
      let lo = 0, hi = idx.length - 1;
      while (lo < hi) { // first character on line k
        const mid = (lo + hi) >> 1;
        if (yOf(charRect(...idx[mid])) >= lineTop - 2) hi = mid; else lo = mid + 1;
      }
      return idx[lo] ? { node: idx[lo][0], offset: idx[lo][1], top: yOf(charRect(...idx[lo])) } : 'whole';
    }
    // put a spacer so that `target` content starts at `y`, then fine-tune once
    function gapBefore(insert, measure, y) {
      const gap = insert();
      const now = measure();
      if (now !== null) gap.style.height = `${Math.max(0, parseFloat(gap.style.height) + (y - now))}px`;
    }

    const units = flowUnits(ed);
    let page = 0, guard = 0;
    for (let i = 0; i < units.length && guard++ < 4000; i++) {
      const u = units[i];
      const rect = u.getBoundingClientRect();
      const top = yOf(rect), bottom = bottomOf(rect);
      while (top >= (page + 1) * pitch) page++;
      const limit = page * pitch + g.h - g.mb;      // bottom of this page's text area
      const nextTop = (page + 1) * pitch + g.mt;    // top of the next page's text area

      if (u.classList.contains('page-break')) {      // a page break: what follows starts on a new page
        const gap = makeGap(nextTop - top, true);
        u.appendChild(gap);
        page++;
        continue;
      }
      const atPageTop = top <= page * pitch + g.mt + 2;
      const moveWhole = () => gapBefore(() => {
        const gap = makeGap(nextTop - top, u.tagName !== 'LI');
        if (u.tagName === 'LI') u.insertBefore(gap, u.firstChild); else u.parentNode.insertBefore(gap, u);
        return gap;
      }, () => yOf(u.tagName === 'LI' ? (ownTextNodes(u)[0] ? charRect(ownTextNodes(u)[0], 0) : u.getBoundingClientRect()) : u.getBoundingClientRect()), nextTop);

      if (bottom <= limit + 0.5) {
        // Word keeps a heading on the same page as the paragraph that follows it
        const nx = units[i + 1];
        if (/^H[1-6]$/.test(u.tagName) && nx && !nx.classList.contains('page-break') && !atPageTop) {
          const first = ownTextNodes(nx)[0];
          const nb = first ? bottomOf(charRect(first, 0)) : bottomOf(nx.getBoundingClientRect());
          if (nb > limit + 0.5) { moveWhole(); page++; i--; continue; }
        }
        continue;
      }

      if (isTextUnit(u) && top < limit) {
        const cut = lineCut(u, limit);
        if (cut && cut !== 'whole' && cut.top > top + 2) { // split the paragraph between lines, like Word
          gapBefore(() => {
            const gap = makeGap(nextTop - cut.top);
            const after = cut.offset > 0 ? cut.node.splitText(cut.offset) : cut.node;
            after.parentNode.insertBefore(gap, after);
            gapBefore.last = after;
            return gap;
          }, () => (gapBefore.last && gapBefore.last.length ? yOf(charRect(gapBefore.last, 0)) : null), nextTop);
          page++;
          i--; // the rest of this paragraph may run onto yet another page
          continue;
        }
      }
      // otherwise move the whole piece to the next page (if it fits on one)
      if (!atPageTop) {
        moveWhole();
        page++;
        i--;
        continue;
      }
      page++; // taller than a page: let it run on
    }

    const last = units[units.length - 1];
    const end = last ? bottomOf(last.getBoundingClientRect()) : 0;
    const pages = Math.max(1, Math.floor(Math.max(0, end - 1) / pitch) + 1);
    ed.style.minHeight = `${pages * pitch - PAGE_GAP}px`;
    $('#sheets').innerHTML = Array.from({ length: pages }, (_, p) =>
      `<div class="sheet-pg" style="top:${p * pitch}px;height:${g.h}px"><span class="pg-num" style="top:${g.h - g.mb / 2 - 7}px">Page ${p + 1} of ${pages}</span></div>`).join('');
    state.pages = pages;
  } finally { laying = false; }
  layoutMargin();
}
let pageTimer;
const layoutPagesSoon = () => { clearTimeout(pageTimer); pageTimer = setTimeout(layoutPages, 350); };
editor().addEventListener('input', layoutPagesSoon);
document.fonts?.ready.then(() => layoutPages());
editor().addEventListener('load', layoutPagesSoon, true); // pictures change heights as they load

// Backspace / Delete across a page boundary should edit the text, not the invisible spacer.
editor().addEventListener('keydown', (e) => {
  if (e.key !== 'Backspace' && e.key !== 'Delete') return;
  const sel = getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  const { startContainer: n, startOffset: o } = sel.getRangeAt(0);
  const prev = e.key === 'Backspace' ? (o === 0 ? n.previousSibling : n.childNodes?.[o - 1]) : (n.nodeType === 3 && o === n.length ? n.nextSibling : n.childNodes?.[o]);
  if (prev?.classList?.contains('pg-gap')) prev.remove(); // the keypress then edits the real text
});

// ---------- zoom: whole page, fit width, or a fixed percentage ----------
function applyZoom() {
  if (isPhone()) { $('#paperCol').style.zoom = '1'; return; } // phones read at normal size
  const mode = lsGet('lex_zoom_mode') || 'width';
  $('#tbZoom').value = mode;
  const g = pageGeom(), sc = $('#sheetScroll');
  const narrow = window.innerWidth < 900;
  const marginW = narrow || $('#page').classList.contains('no-margin') || $('#page').classList.contains('margin-off') ? 0 : 340;
  const availW = sc.clientWidth - 56 - marginW, availH = sc.clientHeight - 48;
  // "Fit width" stops short of the edges, so the page sits centred with room either side
  let z = mode === 'page' ? availH / g.h : mode === 'width' ? Math.min(marginW ? 1.2 : 1.45, (availW * 0.94) / g.w) : Number(mode) || 1;
  if (narrow) z = Math.min(z, (sc.clientWidth - 24) / g.w);
  $('#paperCol').style.zoom = String(Math.max(0.3, Math.round(z * 100) / 100));
}
$('#tbZoom').addEventListener('change', (e) => {
  lsSet('lex_zoom_mode', e.target.value);
  applyZoom();
  layoutPages();
});
window.addEventListener('resize', () => { if (state.lane) { applyZoom(); layoutPagesSoon(); } });

// ---------- the remarks fold away to the side, and come back with one click ----------
function applyMarginFold() {
  const off = lsGet('lex_margin_off') === '1';
  $('#page').classList.toggle('margin-off', off);
  const n = (state.cur?.comments || []).filter((c) => c.lane === state.lane).length;
  $('#mShowLabel').textContent = state.lane === 'team' ? 'Notes' : 'Remarks';
  $('#mShowCount').textContent = n || '';
}
function foldMargin(off) {
  lsSet('lex_margin_off', off ? '1' : '0');
  applyMarginFold();
  if (state.lane) { applyZoom(); layoutPagesSoon(); if (!off && typeof layoutMargin === 'function') layoutMargin(); }
}
$('#mHide').addEventListener('click', () => foldMargin(true));
$('#mShow').addEventListener('click', () => foldMargin(false));

// ---------- the formatting toolbar folds away to give the page more room ----------
function applyFormatBar() {
  const open = lsGet('lex_fmt_open') === '1';
  $('#toolbar').classList.toggle('collapsed', !open);
  $('#fmtToggle').classList.toggle('on', open);
  if (!open) closeFind();
}
$('#fmtToggle').addEventListener('mousedown', (e) => e.preventDefault()); // keep the text selection
$('#fmtToggle').addEventListener('click', () => {
  lsSet('lex_fmt_open', lsGet('lex_fmt_open') === '1' ? '0' : '1');
  applyFormatBar();
  if (state.lane) { applyZoom(); layoutPagesSoon(); }
});
applyFormatBar();

// ---------- confirmation: a short message and a soft two-note chime ----------
let audioCtx;
function chime() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    [[880, 0], [1318.5, 0.12]].forEach(([freq, delay]) => {
      const o = audioCtx.createOscillator(), v = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      v.gain.setValueAtTime(0.0001, t + delay);
      v.gain.exponentialRampToValueAtTime(0.2, t + delay + 0.02);
      v.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.45);
      o.connect(v).connect(audioCtx.destination);
      o.start(t + delay);
      o.stop(t + delay + 0.5);
    });
  } catch { /* no audio available: the message alone will do */ }
}
let confirmTimer;
// The chime is only for uploads to the clean draft; every other confirmation is silent.
function confirmDone(text, { sound = false } = {}) {
  const el = $('#confirm');
  $('#confirmText').textContent = text;
  el.classList.remove('show'); void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(confirmTimer);
  confirmTimer = setTimeout(() => el.classList.remove('show'), 2600);
  if (sound) chime();
}

// ---------- delete a remark (author or Team Head): click Delete, then confirm ----------
$('#mList').addEventListener('click', async (e) => {
  const b = e.target.closest('.m-del');
  if (!b) return;
  e.stopPropagation();
  if (!b.classList.contains('armed')) {
    b.classList.add('armed');
    b.textContent = 'Confirm delete';
    setTimeout(() => { b.classList.remove('armed'); b.textContent = 'Delete'; }, 3000);
    return;
  }
  try {
    await api('DELETE', `/api/drafts/${state.cur.draft.id}/comments/${b.dataset.del}`);
    state.cur.comments = state.cur.comments.filter((c) => c.id !== Number(b.dataset.del));
    renderMargin();
    setDocState('Remark deleted');
  } catch (err) { setDocState(err.message); }
});
