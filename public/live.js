// ================= Zoit — live drafting =================
// While a matter is open, the page checks in every couple of seconds: it says which sheet and paragraph
// you're on (and whether you're typing), and hears the same about everyone else, plus the latest version
// of each sheet. With that, a sheet shows:
//   · who is in it right now, in the bar at the top (a pulsing ring = typing);
//   · a coloured marker with their name beside the paragraph each person is working on;
//   · the paragraphs someone else just changed, tinted in their colour with "Edited by …", fading after a while;
//   · a short list of the latest edits ("Live edits") above the remarks — click one to jump to it.

const LIVE_MS = 1000; // with a sheet open; every 3 seconds on the matter's desk
const LIVE_BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre';
const live = { busy: false, typedAt: 0, lane: null, seen: {}, texts: null, marks: [], feed: [] };

// the document's paragraphs, innermost only (a table cell's paragraph, not the cell)
const liveBlocks = () => [...editor().querySelectorAll(LIVE_BLOCKS)].filter((el) => !el.querySelector(LIVE_BLOCKS));
const blockText = (el) => el.textContent.replace(/\s+/g, ' ').trim();
function caretPara() {
  const sel = getSelection();
  if (!state.lane || !sel.rangeCount || !editor().contains(sel.anchorNode)) return null;
  const node = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
  const el = node.closest(LIVE_BLOCKS);
  const i = el ? liveBlocks().indexOf(el) : -1;
  return i >= 0 ? i : null;
}
editor().addEventListener('input', () => { live.typedAt = Date.now(); });
document.addEventListener('selectionchange', () => { if (state.lane) placeMarks(); });

async function liveTick() {
  if (live.busy || !state.cur || document.hidden || !state.me) return;
  live.busy = true;
  const draftId = state.cur.draft.id, lane = state.lane;
  try {
    const r = await api('POST', `/api/drafts/${draftId}/live`, { lane, para: caretPara(), typing: Date.now() - live.typedAt < 3000 });
    if (state.cur?.draft.id !== draftId) return;
    live.people = r.people;
    state.cur.presence = [publicMe(), ...r.people];
    renderPresence(state.cur.presence);
    renderDocLive();
    await catchUp(r, lane);
    placeMarks();
  } catch { /* offline for a moment: try again next tick */ }
  finally { live.busy = false; }
}
let liveCount = 0;
setInterval(() => { if (state.lane || ++liveCount % 3 === 0) liveTick(); }, LIVE_MS);
const publicMe = () => ({ id: state.me.id, name: state.me.name, color: state.me.color });

// someone else changed a sheet, a remark or the matter: bring it in, and show what changed and who did it
const remarkPrint = () => { const c = state.cur.comments || []; return `${c.length}:${c.reduce((a, x) => Math.max(a, x.id), 0)}`; };
async function catchUp(r, lane) {
  const { revs } = r;
  const sheets = Object.entries(revs).some(([l, x]) => state.cur.lanes[l] && state.cur.lanes[l].rev !== x.v);
  const remarks = r.remarks !== remarkPrint();
  const matter = live.matter && live.matter !== r.matter;
  live.matter = r.matter;
  if (lane !== live.lane) { live.lane = lane; live.texts = null; live.marks = []; live.feed = []; renderFeed(); }
  if ((sheets || remarks || matter) && !state.dirty) {
    await refresh();
    if (state.lane && typeof renderMargin === 'function') renderMargin();
  }
  if (!lane || !revs[lane]) return;
  const now = revs[lane];
  const texts = liveBlocks().map(blockText);
  if (live.texts && live.seen[lane] !== now.v && now.by !== state.me.id && !state.dirty) {
    const who = person(now.by);
    for (const i of changedParas(live.texts, texts)) {
      live.marks = live.marks.filter((m) => m.para !== i);
      live.marks.push({ para: i, name: who.name, color: who.color, at: Date.now() });
      live.feed.unshift({ para: i, name: who.name, color: who.color, at: Date.now(), text: texts[i] || '(removed a passage)' });
    }
    live.feed = live.feed.slice(0, 8);
    renderFeed();
  }
  if (!state.dirty) { live.texts = texts; live.seen[lane] = now.v; }
}
// which paragraphs differ: match from the top and from the bottom, the rest in between changed
function changedParas(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length - 1, eb = b.length - 1;
  while (ea >= s && eb >= s && a[ea] === b[eb]) { ea--; eb--; }
  const out = [];
  for (let i = s; i <= eb; i++) out.push(i);
  if (!out.length && ea >= s) out.push(Math.min(s, b.length - 1)); // only removals: mark where they were
  return out.filter((i) => i >= 0).slice(0, 12);
}

// the people in this sheet, at the top of the page
function renderDocLive() {
  const box = $('#docLive');
  if (!box) return;
  const here = (live.people || []).filter((p) => state.lane && p.lane === state.lane);
  box.innerHTML = here.map((p) => `<span class="dl-person${p.typing ? ' typing' : ''}" style="--c:${p.color}" title="${esc(p.name)} — ${p.typing ? 'typing now' : 'in this sheet'}"><span class="avatar">${initials(p.name)}</span><span class="dl-name">${esc(p.name.split(' ')[0])}${p.typing ? ' <em>typing…</em>' : ''}</span></span>`).join('');
  box.classList.toggle('hidden', !here.length);
}

// coloured markers beside paragraphs: where people are, and what was just edited
const MARK_FOR = 15000;
function placeMarks() {
  const col = $('#paperCol');
  let layer = $('#liveLayer');
  if (!layer) { layer = document.createElement('div'); layer.id = 'liveLayer'; layer.className = 'live-layer'; col.appendChild(layer); }
  if (!state.lane || !state.cur) { layer.innerHTML = ''; return; }
  // the page may be zoomed (Fit width, 75%…): screen pixels ÷ zoom = the page's own pixels
  const blocks = liveBlocks(), base = col.getBoundingClientRect(), k = base.width / (col.offsetWidth || base.width) || 1;
  const at = (i) => {
    const el = blocks[i]; if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: (r.top - base.top) / k, height: Math.max(r.height / k, 18), left: (r.left - base.left) / k, width: r.width / k };
  };
  const t = Date.now();
  live.marks = live.marks.filter((m) => t - m.at < MARK_FOR);
  const edits = live.marks.map((m) => {
    const p = at(m.para);
    return p ? `<div class="lv-edit" style="--c:${m.color};top:${p.top - 3}px;height:${p.height + 6}px;left:${p.left - 8}px;width:${p.width + 16}px;opacity:${Math.max(0.15, 1 - (t - m.at) / MARK_FOR)}"><span class="lv-tag">Edited by ${esc(m.name)}</span></div>` : '';
  }).join('');
  const people = (live.people || []).filter((p) => p.lane === state.lane && p.para !== null).map((p) => {
    const q = at(p.para);
    if (!q) return '';
    const first = esc(p.name.split(' ')[0]);
    return (p.typing ? `<div class="lv-typing" style="--c:${p.color};top:${q.top - 3}px;height:${q.height + 6}px;left:${q.left - 8}px;width:${q.width + 16}px"></div>` : '')
      + `<div class="lv-here${p.typing ? ' typing' : ''}" style="--c:${p.color};top:${q.top}px;height:${q.height}px;left:${q.left - 16}px"><span class="lv-name">${p.typing ? `${first} is typing…` : first}</span></div>`;
  }).join('');
  layer.innerHTML = edits + people;
}
window.addEventListener('resize', () => placeMarks());

// "Live edits": the latest changes by others in this sheet
function renderFeed() {
  const box = $('#liveFeed');
  if (!box) return;
  box.classList.toggle('hidden', !live.feed.length);
  box.innerHTML = `<div class="lf-head">Live edits</div>${live.feed.map((f, n) => `
    <button type="button" class="lf-item" data-para="${f.para}" style="--c:${f.color}"><b>${esc(f.name)}</b> <span>${ago(f.at)}</span><q>${esc(f.text.slice(0, 90))}${f.text.length > 90 ? '…' : ''}</q></button>`).join('')}`;
}
setInterval(() => { if (live.feed.length) renderFeed(); }, 15000);
document.addEventListener('click', (e) => {
  const item = e.target.closest('#liveFeed [data-para]');
  if (!item) return;
  liveBlocks()[Number(item.dataset.para)]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
