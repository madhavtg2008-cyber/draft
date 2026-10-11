// ================= LexDraft — Word-style formatting, find & replace =================
// Loaded after app.js; shares its globals ($, $$, state, esc, editor, setDocState, lsGet, lsSet).

const ed = editor;
const changed = () => ed().dispatchEvent(new Event('input', { bubbles: true })); // → autosave
let savedRange = null;
document.addEventListener('selectionchange', () => {
  const sel = getSelection();
  if (sel.rangeCount && ed().contains(sel.anchorNode)) {
    savedRange = sel.getRangeAt(0).cloneRange();
    // a chosen format waits for the next typing even if you click elsewhere first;
    // selecting text instead (to format it directly) or pressing Esc drops it
    if (pending && !sel.isCollapsed) pending = null;
    syncToolbar();
  }
});

// ----- "type next" formatting, like Word: with nothing selected, choosing a font, size,
// bold, colour… applies to the next text typed at the cursor.
let pending = null;   // { font, size, color, bg, bold, italic, underline, strike, vert }
let pendingAt = null; // [node, offset] of the cursor the pending format belongs to
function caretStyle() {
  const n = getSelection().anchorNode;
  const el = n && (n.nodeType === 1 ? n : n.parentElement);
  return el && ed().contains(el) ? getComputedStyle(el) : null;
}
function typeNext(kind, value) {
  restoreSelection();
  const cs = caretStyle(), p = pending || {};
  const deco = cs?.textDecorationLine || '';
  const now = {
    bold: p.bold ?? (cs ? parseInt(cs.fontWeight, 10) >= 600 : false),
    italic: p.italic ?? cs?.fontStyle === 'italic',
    underline: p.underline ?? /underline/.test(deco),
    strike: p.strike ?? /line-through/.test(deco),
    vert: p.vert ?? null,
  };
  const patch = {
    bold: { bold: !now.bold }, italic: { italic: !now.italic }, underline: { underline: !now.underline },
    strike: { strike: !now.strike }, sup: { vert: now.vert === 'sup' ? null : 'sup' }, sub: { vert: now.vert === 'sub' ? null : 'sub' },
    clear: { bold: false, italic: false, underline: false, strike: false, vert: null, color: null, bg: null },
    font: { font: value }, size: { size: value }, color: { color: value }, bg: { bg: value },
  }[kind];
  pending = { ...p, ...patch };
  const s = getSelection();
  pendingAt = s.rangeCount ? [s.anchorNode, s.anchorOffset] : null;
  syncToolbar();
  setDocState('The next text you type will use this formatting');
}
// When typing with a pending format, wrap the typed text in a span carrying it;
// the cursor stays inside, so the rest of the word/sentence continues in that format.
ed().addEventListener('keydown', (e) => { if (e.key === 'Escape' && pending) { pending = null; syncToolbar(); setDocState('Formatting choice cleared'); } });
ed().addEventListener('beforeinput', (e) => {
  if (!pending || e.inputType !== 'insertText' || !e.data) return;
  const sel = getSelection();
  if (!sel.rangeCount) return;
  e.preventDefault();
  const r = sel.getRangeAt(0);
  r.deleteContents();
  const span = document.createElement('span');
  const st = span.style, p = pending;
  if (p.font) st.fontFamily = `'${p.font}'`;
  if (p.size) st.fontSize = `${p.size}pt`;
  if (p.color) st.color = p.color;
  if (p.bg) st.backgroundColor = p.bg;
  if (p.bold !== undefined) st.fontWeight = p.bold ? 'bold' : 'normal';
  if (p.italic !== undefined) st.fontStyle = p.italic ? 'italic' : 'normal';
  if (p.underline !== undefined || p.strike !== undefined) st.textDecoration = [p.underline && 'underline', p.strike && 'line-through'].filter(Boolean).join(' ') || 'none';
  let inner = span;
  if (p.vert) { inner = document.createElement(p.vert); span.appendChild(inner); }
  const text = document.createTextNode(e.data);
  inner.appendChild(text);
  r.insertNode(span);
  const c = document.createRange();
  c.setStart(text, text.length);
  c.collapse(true);
  sel.removeAllRanges();
  sel.addRange(c);
  pending = null;
  pendingAt = null;
  changed();
});
function restoreSelection() {
  ed().focus({ preventScroll: true });
  if (savedRange) { const s = getSelection(); s.removeAllRanges(); s.addRange(savedRange); }
}
function exec(cmd, value = null, css = false) {
  restoreSelection();
  document.execCommand('styleWithCSS', false, css);
  document.execCommand(cmd, false, value);
  syncToolbar();
}
const insertHtml = (html) => exec('insertHTML', html);

// keep the cursor in the document when toolbar buttons are pressed
$('#toolbar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
// Text formatting (font, size, bold…) works on the selection, or on what you type next.
// Paragraph formatting (alignment, lists, spacing, styles) only ever touches what is selected —
// with nothing selected those buttons do nothing (bar a nudge and a hint).
const hasSelection = () => !!savedRange && !savedRange.collapsed && ed().contains(savedRange.commonAncestorContainer);
function needSelection() {
  if (hasSelection()) return true;
  setDocState('Select the text you want to format first');
  const tb = $('#toolbar');
  tb.classList.remove('nudge'); void tb.offsetWidth; tb.classList.add('nudge');
  syncToolbar();
  return false;
}
const BLOCKS = 'p,h1,h2,h3,h4,li,blockquote';
const ALIGN = { justifyLeft: 'left', justifyCenter: 'center', justifyRight: 'right', justifyFull: 'justify' };
const BLOCK_CMDS = ['insertUnorderedList', 'insertOrderedList', 'indent', 'outdent'];
$('#toolbar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cmd]');
  if (!b) return;
  const cmd = b.dataset.cmd;
  if (cmd === 'undo' || cmd === 'redo') return exec(cmd);
  const INLINE = { bold: 'bold', italic: 'italic', underline: 'underline', strikeThrough: 'strike', superscript: 'sup', subscript: 'sub', removeFormat: 'clear' };
  if (INLINE[cmd]) return hasSelection() ? exec(cmd) : typeNext(INLINE[cmd]);
  if (!needSelection()) return;
  if (ALIGN[cmd]) { isolate().forEach((blk) => (blk.style.textAlign = ALIGN[cmd])); changed(); return syncToolbar(); }
  if (BLOCK_CMDS.includes(cmd)) isolate();
  exec(cmd);
});

// The innermost paragraphs the selection touches.
function selectedBlocks(r) {
  const all = $$(BLOCKS, ed()).filter((blk) => r.intersectsNode(blk));
  return all.filter((blk) => !all.some((o) => o !== blk && blk.contains(o)));
}
// Paragraph-level formatting (alignment, lists, spacing, styles) on part of a paragraph:
// split the paragraph so the selected statement stands on its own, and return it.
function isolate() {
  restoreSelection();
  let r = savedRange;
  let blocks = selectedBlocks(r);
  if (!blocks.length) { // loose text: give it a paragraph first
    document.execCommand('formatBlock', false, '<p>');
    r = savedRange = getSelection().getRangeAt(0).cloneRange();
    blocks = selectedBlocks(r);
  }
  if (blocks.length !== 1) return blocks;
  const blk = blocks[0];
  const pre = document.createRange(); pre.setStart(blk, 0); pre.setEnd(r.startContainer, r.startOffset);
  const post = document.createRange(); post.setStart(r.endContainer, r.endOffset); post.setEnd(blk, blk.childNodes.length);
  const hasPre = !!pre.toString().trim(), hasPost = !!post.toString().trim();
  if (!hasPre && !hasPost) return [blk];
  const preFrag = hasPre ? pre.extractContents() : null;
  const postFrag = hasPost ? post.extractContents() : null;
  const wrap = (frag) => { const n = blk.cloneNode(false); n.append(frag); return n; };
  const mid = blk.cloneNode(false);
  mid.append(...blk.childNodes);
  blk.replaceWith(...[preFrag && wrap(preFrag), mid, postFrag && wrap(postFrag)].filter(Boolean));
  const sel = document.createRange();
  sel.selectNodeContents(mid);
  const s = getSelection(); s.removeAllRanges(); s.addRange(sel);
  savedRange = sel.cloneRange();
  return [mid];
}

// ----- font size (points, like Word)
const SIZES = [6, 7, 8, 9, 10, 10.5, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 48, 54, 60, 72, 96];
$('#tbSize').innerHTML = '<option value=""></option>' + SIZES.map((s) => `<option value="${s}">${s}</option>`).join('');
$('#tbSize').addEventListener('change', (e) => {
  const pt = e.target.value;
  if (!pt) return;
  if (!hasSelection()) return typeNext('size', Number(pt));
  exec('fontSize', 7, true); // mark the selection, then swap the marker for the real size
  $$('#editor span[style*="xxx-large"], #editor font[size="7"]').forEach((el) => {
    let span = el;
    if (el.tagName === 'FONT') { span = document.createElement('span'); span.append(...el.childNodes); el.replaceWith(span); }
    span.style.fontSize = `${pt}pt`;
  });
  changed();
});
// ----- fonts: Word's usual fonts plus a wide set of web fonts, each shown in its own face
const FONT_GROUPS = {
  'Serif': ['Times New Roman', 'Georgia', 'Garamond', 'EB Garamond', 'Cambria', 'Book Antiqua', 'Palatino Linotype', 'Bookman Old Style',
    'Century Schoolbook', 'Constantia', 'Baskerville Old Face', 'Libre Baskerville', 'Merriweather', 'Lora', 'Playfair Display',
    'Cormorant Garamond', 'Crimson Text', 'PT Serif', 'Noto Serif', 'Source Serif 4', 'Spectral', 'Tinos'],
  'Sans serif': ['Arial', 'Calibri', 'Aptos', 'Helvetica', 'Segoe UI', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Century Gothic',
    'Gill Sans MT', 'Franklin Gothic Medium', 'Candara', 'Corbel', 'Lucida Sans Unicode', 'Arial Narrow', 'Inter', 'Roboto',
    'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Raleway', 'Nunito', 'Work Sans', 'Source Sans 3', 'Noto Sans', 'Arimo', 'Carlito'],
  'Monospace': ['Courier New', 'Consolas', 'Lucida Console', 'Roboto Mono', 'Source Code Pro', 'IBM Plex Mono', 'Cousine'],
  'Display & script': ['Arial Black', 'Impact', 'Oswald', 'Bebas Neue', 'Comic Sans MS', 'Dancing Script', 'Great Vibes', 'Pacifico'],
};
$('#tbFont').innerHTML = Object.entries(FONT_GROUPS).map(([group, fonts]) => `<optgroup label="${group}">${
  fonts.map((f) => `<option value="${f}" style="font-family:'${f}'">${f}</option>`).join('')}</optgroup>`).join('');
$('#tbFont').addEventListener('change', (e) => {
  if (!hasSelection()) return typeNext('font', e.target.value);
  exec('fontName', e.target.value, true);
});
$('#tbStyle').addEventListener('change', (e) => { if (!needSelection()) return; isolate(); exec('formatBlock', `<${e.target.value}>`); });

// ----- line spacing on the selected text only
$('#tbSpacing').addEventListener('change', (e) => {
  const v = e.target.value;
  e.target.value = '';
  if (!v || !needSelection()) return;
  isolate().forEach((blk) => (blk.style.lineHeight = v));
  changed();
});

// ----- colour swatches
const TEXT_COLORS = ['#000000', '#3a3a3a', '#666666', '#999999', '#c9c9c9', '#ffffff', '#7a0000', '#c00000', '#e36c09', '#b8860b', '#2f8f2f', '#0f6b5c', '#1f4e79', '#3b4fd8', '#1f7fbf', '#7030a0', '#a23ec9', '#d63d8f'];
const HILITES = ['none', '#fff3a3', '#ffe08a', '#c6f6d5', '#bee3f8', '#fed7e2', '#e9d8fd', '#feebc8', '#e2e8f0', '#d9d9d9', '#000000', '#ffffff'];
const swatch = (c) => `<button data-sw="${c}" class="${c === 'none' ? 'none' : ''}" style="--sw:${c}" title="${c === 'none' ? 'No highlight' : c}"></button>`;
$('[data-panel="color"]').innerHTML = TEXT_COLORS.map(swatch).join('');
$('[data-panel="hilite"]').innerHTML = HILITES.map(swatch).join('');
$('#tbColorBar').style.setProperty('--sw', '#c00000');
$('#tbHiliteBar').style.setProperty('--sw', '#fff3a3');
$('[data-panel="color"]').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sw]'); if (!b) return;
  closeDropdowns();
  $('#tbColorBar').style.setProperty('--sw', b.dataset.sw);
  if (!hasSelection()) return typeNext('color', b.dataset.sw);
  exec('foreColor', b.dataset.sw, true);
});
$('[data-panel="hilite"]').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sw]'); if (!b) return;
  const c = b.dataset.sw === 'none' ? 'transparent' : b.dataset.sw;
  closeDropdowns();
  $('#tbHiliteBar').style.setProperty('--sw', c);
  if (!hasSelection()) return typeNext('bg', c);
  exec('hiliteColor', c, true);
});

// ----- small dropdown panels (colour, table, link, symbols)
function closeDropdowns() { $$('.toolbar .dd.open').forEach((d) => d.classList.remove('open')); }
$('#toolbar').addEventListener('click', (e) => {
  const t = e.target.closest('[data-dd]');
  if (!t) return;
  const dd = t.parentElement, open = dd.classList.contains('open');
  closeDropdowns();
  if (!open) { dd.classList.add('open'); $('input', dd)?.focus(); }
});
document.addEventListener('mousedown', (e) => { if (!e.target.closest('.toolbar .dd')) closeDropdowns(); });

// ----- link
$('#linkForm').addEventListener('submit', (e) => {
  e.preventDefault();
  let url = e.target.url.value.trim();
  if (!url) return;
  if (!/^(https?:|mailto:)/i.test(url)) url = `https://${url}`;
  if (savedRange && !savedRange.collapsed) exec('createLink', url);
  else insertHtml(`<a href="${esc(url)}">${esc(url)}</a>&nbsp;`);
  e.target.reset();
  closeDropdowns();
});

// ----- table grid picker
const grid = $('#gridPick');
grid.innerHTML = Array.from({ length: 64 }, (_, i) => `<span data-r="${Math.floor(i / 8) + 1}" data-c="${(i % 8) + 1}"></span>`).join('');
grid.addEventListener('mouseover', (e) => {
  const c = e.target.closest('span'); if (!c) return;
  const R = +c.dataset.r, C = +c.dataset.c;
  $$('span', grid).forEach((s) => s.classList.toggle('on', +s.dataset.r <= R && +s.dataset.c <= C));
  $('#gridLabel').textContent = `${R} × ${C} table`;
});
grid.addEventListener('mousedown', (e) => e.preventDefault());
grid.addEventListener('click', (e) => {
  const c = e.target.closest('span'); if (!c) return;
  const R = +c.dataset.r, C = +c.dataset.c;
  const cell = '<td style="border: 1px solid #000000">&nbsp;</td>';
  insertHtml(`<table style="border-collapse: collapse; width: 100%"><tbody>${`<tr>${cell.repeat(C)}</tr>`.repeat(R)}</tbody></table><p><br></p>`);
  closeDropdowns();
});

// ----- picture
$('#tbImage').addEventListener('click', () => $('#imgInput').click());
$('#imgInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) return setDocState('Pictures must be under 4 MB');
  const reader = new FileReader();
  reader.onload = () => insertHtml(`<img src="${reader.result}" alt="${esc(file.name)}" />`);
  reader.readAsDataURL(file);
});

// ----- horizontal line, page break, symbols
$('#toolbar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-insert]'); if (!b) return;
  if (b.dataset.insert === 'rule') exec('insertHorizontalRule');
  if (b.dataset.insert === 'break') insertHtml('<div class="page-break" style="page-break-after: always"></div><p><br></p>');
});
const SYMBOLS = ['§', '¶', '©', '®', '™', '—', '–', '…', '“', '”', '‘', '’', '•', '°', '±', '×', '÷', '½', '¼', '¾', '€', '£', '₹', '$', '†', '‡', '✓', '→', '≤', '≥'];
$('[data-panel="symbol"]').innerHTML = SYMBOLS.map((s) => `<button data-sym="${s}">${s}</button>`).join('');
$('[data-panel="symbol"]').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sym]'); if (b) exec('insertText', b.dataset.sym);
});

// ----- print (zoom lives in the document bar; see app.js)
$('#tbPrint').addEventListener('click', () => window.print());

// ----- Tab indents like Word
ed().addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || !ed().isContentEditable) return;
  e.preventDefault();
  const inList = getSelection().anchorNode?.parentElement?.closest('li');
  if (inList) exec(e.shiftKey ? 'outdent' : 'indent');
  else if (!e.shiftKey) exec('insertText', '  ');
});

// ----- paste from Word or the web: keep the formatting, drop the junk (the server sanitises again)
ed().addEventListener('paste', (e) => {
  const html = e.clipboardData?.getData('text/html');
  if (!html || !ed().isContentEditable) return;
  e.preventDefault();
  insertHtml(cleanPaste(html));
});
function cleanPaste(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const KEEP = new Set(['P', 'BR', 'DIV', 'SPAN', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'STRIKE', 'SUB', 'SUP', 'H1', 'H2', 'H3', 'H4', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'A', 'HR', 'IMG']);
  const DROP = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'XML', 'OBJECT', 'IFRAME']);
  const STYLES = ['font-weight', 'font-style', 'text-decoration', 'text-align', 'color', 'background-color', 'font-size', 'font-family', 'vertical-align'];
  const walk = (node) => {
    for (const el of [...node.children]) {
      walk(el);
      if (DROP.has(el.tagName)) { el.remove(); continue; }
      if (!KEEP.has(el.tagName)) { el.replaceWith(...el.childNodes); continue; }
      const keep = STYLES.map((p) => [p, el.style.getPropertyValue(p)]).filter(([, v]) => v);
      for (const a of [...el.attributes]) {
        const ok = (a.name === 'href' && el.tagName === 'A') || (a.name === 'src' && el.tagName === 'IMG') || ['colspan', 'rowspan'].includes(a.name);
        if (!ok) el.removeAttribute(a.name);
      }
      keep.forEach(([p, v]) => el.style.setProperty(p, v));
    }
  };
  walk(doc.body);
  return doc.body.innerHTML.replace(/<!--[\s\S]*?-->/g, '');
}

// ----- reflect the current selection in the toolbar
const STATELESS = ['undo', 'redo', 'removeFormat', 'indent', 'outdent'];
function syncToolbar() {
  if ($('#toolbar').classList.contains('off')) return;
  for (const b of $$('#toolbar button[data-cmd]')) {
    if (STATELESS.includes(b.dataset.cmd) || ALIGN[b.dataset.cmd]) continue;
    try { b.classList.toggle('on', document.queryCommandState(b.dataset.cmd)); } catch {}
  }
  const node = getSelection().anchorNode;
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  if (!el || !ed().contains(el)) return;
  const para = el.closest(BLOCKS);
  const align = para ? getComputedStyle(para).textAlign.replace('start', 'left') : 'left';
  for (const [cmd, a] of Object.entries(ALIGN)) $(`#toolbar [data-cmd="${cmd}"]`).classList.toggle('on', a === align);
  const block = el.closest('h1,h2,h3,h4,blockquote');
  $('#tbStyle').value = block ? block.tagName.toLowerCase() : 'p';
  const cs = getComputedStyle(el);
  const pt = pending?.size ?? Math.round(parseFloat(cs.fontSize) * 0.75 * 2) / 2;
  showOption($('#tbSize'), String(pt));
  showOption($('#tbFont'), pending?.font ?? cs.fontFamily.split(',')[0].replace(/["']/g, '').trim());
  if (pending) { // show what the next typing will look like
    const on = { bold: pending.bold, italic: pending.italic, underline: pending.underline, strikeThrough: pending.strike, superscript: pending.vert === 'sup', subscript: pending.vert === 'sub' };
    for (const [cmd, v] of Object.entries(on)) if (v !== undefined) $(`#toolbar [data-cmd="${cmd}"]`).classList.toggle('on', !!v);
  }
}
// select a value in a dropdown, adding it if the document uses one that isn't listed
function showOption(select, value) {
  if (!value) return;
  if (![...select.options].some((o) => o.value === value)) {
    const o = new Option(value, value);
    o.dataset.extra = '1';
    select.querySelectorAll('option[data-extra]').forEach((x) => x.remove());
    select.prepend(o);
  }
  select.value = value;
}

// ================= Find & replace (inline bar, no dialog) =================
let findHits = [], findIdx = -1;
const findForm = $('#findBar');
function openFind() {
  if ($('#toolbar').classList.contains('off')) return;
  findForm.classList.remove('hidden');
  const sel = getSelection().toString();
  if (sel && sel.length < 80) findForm.find.value = sel;
  findForm.find.focus();
  findForm.find.select();
  countHits();
}
function closeFind() { findForm.classList.add('hidden'); findHits = []; findIdx = -1; $('#findCount').textContent = ''; }
function collectHits(q) {
  const hits = [];
  if (!q) return hits;
  const needle = q.toLowerCase();
  const w = document.createTreeWalker(ed(), NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const hay = n.data.toLowerCase();
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) hits.push({ node: n, start: i, end: i + q.length });
  }
  return hits;
}
function countHits() {
  findHits = collectHits(findForm.find.value);
  $('#findCount').textContent = findForm.find.value ? `${findHits.length} found` : '';
}
function selectHit(h) {
  const r = document.createRange();
  r.setStart(h.node, h.start);
  r.setEnd(h.node, h.end);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  savedRange = r.cloneRange();
  h.node.parentElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
findForm.find.addEventListener('input', () => { findIdx = -1; countHits(); });
findForm.addEventListener('submit', (e) => {
  e.preventDefault();
  countHits();
  if (!findHits.length) return;
  findIdx = (findIdx + 1) % findHits.length;
  selectHit(findHits[findIdx]);
  $('#findCount').textContent = `${findIdx + 1} of ${findHits.length}`;
});
findForm.addEventListener('click', (e) => {
  const b = e.target.closest('[data-f]'); if (!b) return;
  const q = findForm.find.value, rep = findForm.replace.value;
  if (b.dataset.f === 'close') return closeFind();
  if (!q) return;
  if (b.dataset.f === 'replace') {
    const sel = getSelection();
    if (sel.toString().toLowerCase() === q.toLowerCase() && ed().contains(sel.anchorNode)) document.execCommand('insertText', false, rep);
    findIdx -= 1;
    findForm.requestSubmit();
  } else if (b.dataset.f === 'all') {
    const hits = collectHits(q).reverse();
    for (const h of hits) h.node.data = h.node.data.slice(0, h.start) + rep + h.node.data.slice(h.end);
    $('#findCount').textContent = `Replaced ${hits.length}`;
    if (hits.length) changed();
  }
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && state.lane && state.view === 'text') { e.preventDefault(); openFind(); }
  if (e.key === 'Escape' && !findForm.classList.contains('hidden')) { e.stopImmediatePropagation(); closeFind(); }
}, true);
$('#tbFind').addEventListener('click', openFind);
