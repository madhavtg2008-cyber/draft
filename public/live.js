// ================= Zoit — live drafting =================
// While a matter is open, the page checks in every second: it says which sheet and paragraph you're on
// (and whether you're typing), and hears the same about everyone else, plus each sheet's change counter,
// the remarks and the matter. With that, a sheet shows:
//   · who is in it right now, in the bar at the top (a pulsing ring = typing);
//   · beside the paragraph each person is in, a marker in their colour with their name ("… is typing");
//   · everyone's edits as they're saved, with Review's markup (see changes.js) and change bars, as in Word.

const LIVE_MS = 1000; // with a sheet open; every 3 seconds on the matter's desk
const LIVE_BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre';
const live = { busy: false, typedAt: 0, people: [] };

// the document's paragraphs, innermost only (a table cell's paragraph, not the cell)
const liveBlocks = () => [...editor().querySelectorAll(LIVE_BLOCKS)].filter((el) => !el.querySelector(LIVE_BLOCKS));
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
  const draftId = state.cur.draft.id;
  try {
    const r = await api('POST', `/api/drafts/${draftId}/live`, { lane: state.lane, para: caretPara(), typing: Date.now() - live.typedAt < 3000 });
    if (state.cur?.draft.id !== draftId) return;
    live.people = r.people;
    state.cur.presence = [publicMe(), ...r.people];
    renderPresence(state.cur.presence);
    renderDocLive();
    await catchUp(r);
    placeMarks();
  } catch { /* offline for a moment: try again next tick */ }
  finally { live.busy = false; }
}
let liveCount = 0;
setInterval(() => { if (state.lane || ++liveCount % 3 === 0) liveTick(); }, LIVE_MS);
const publicMe = () => ({ id: state.me.id, name: state.me.name, color: state.me.color });

// someone else changed a sheet (or switched Track Changes), a remark or the matter: bring it in
const remarkPrint = () => { const c = state.cur.comments || []; return `${c.length}:${c.reduce((a, x) => Math.max(a, x.id), 0)}`; };
async function catchUp(r) {
  const sheets = Object.entries(r.revs).some(([l, x]) => state.cur.lanes[l] && (state.cur.lanes[l].rev !== x.v || !!state.cur.lanes[l].tracking !== !!x.t));
  const remarks = r.remarks !== remarkPrint();
  const matter = live.matter && live.matter !== r.matter;
  live.matter = r.matter;
  if ((sheets || remarks || matter) && !state.dirty) {
    await refresh();
    if (state.lane && typeof renderMargin === 'function') renderMargin();
  }
}

// the people in this sheet, at the top of the page
function renderDocLive() {
  const box = $('#docLive');
  if (!box) return;
  const here = live.people.filter((p) => state.lane && p.lane === state.lane);
  box.innerHTML = here.map((p) => `<span class="dl-person${p.typing ? ' typing' : ''}" style="--c:${p.color}" title="${esc(p.name)} — ${p.typing ? 'typing now' : 'in this sheet'}"><span class="avatar">${initials(p.name)}</span><span class="dl-name">${esc(p.name.split(' ')[0])}${p.typing ? ' <em>typing…</em>' : ''}</span></span>`).join('');
  box.classList.toggle('hidden', !here.length);
}

// beside the page: where each person is (and who's typing), and Word's change bars
function placeMarks() {
  const col = $('#paperCol');
  let layer = $('#liveLayer');
  if (!layer) { layer = document.createElement('div'); layer.id = 'liveLayer'; layer.className = 'live-layer'; col.appendChild(layer); }
  if (!state.lane || !state.cur) { layer.innerHTML = ''; return; }
  // the page may be zoomed: screen pixels ÷ zoom = the page's own pixels
  const blocks = liveBlocks(), base = col.getBoundingClientRect(), k = base.width / (col.offsetWidth || base.width) || 1;
  const box = (el) => { const r = el.getBoundingClientRect(); return { top: (r.top - base.top) / k, height: Math.max(r.height / k, 18), left: (r.left - base.left) / k, width: r.width / k }; };
  const mode = editor().dataset.markup;
  // a change bar beside every paragraph with a waiting change (red in Simple Markup; click it to see the changes)
  const bars = mode === 'none' || mode === 'original' ? '' : blocks.filter((el) => el.querySelector('.tc')).map((el) => {
    const q = box(el);
    return `<button type="button" class="lv-bar${mode === 'simple' ? ' simple' : ''}" data-bar style="top:${q.top}px;height:${q.height}px" title="${mode === 'simple' ? 'Show the changes here' : 'Changed'}"></button>`;
  }).join('');
  const people = live.people.filter((p) => p.lane === state.lane && p.para !== null).map((p) => {
    const el = blocks[p.para];
    if (!el) return '';
    const q = box(el), first = esc(p.name.split(' ')[0]);
    return (p.typing ? `<div class="lv-typing" style="--c:${p.color};top:${q.top - 3}px;height:${q.height + 6}px;left:${q.left - 8}px;width:${q.width + 16}px"></div>` : '')
      + `<div class="lv-here${p.typing ? ' typing' : ''}" style="--c:${p.color};top:${q.top}px;height:${q.height}px;left:${q.left - 16}px"><span class="lv-name">${p.typing ? `${first} is typing…` : first}</span></div>`;
  }).join('');
  layer.innerHTML = bars + people;
}
window.addEventListener('resize', () => placeMarks());
// in Simple Markup, a change bar opens the full markup (as in Word)
document.addEventListener('click', (e) => { if (e.target.closest('#liveLayer [data-bar]') && editor().dataset.markup === 'simple') setMarkup('all'); });
