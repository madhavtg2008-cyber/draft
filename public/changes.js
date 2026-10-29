// ================= Zoit — Review (as in Word) =================
// The Review toolbar, laid out like Word's Review tab:
//   Tracking  · Track Changes (per sheet, for everyone) · All Markup / Simple Markup / No Markup / Original · Reviewing Pane
//   Changes   · Previous · Next · Accept · Accept All · Reject · Reject All
//   Comments  · New Comment · Delete · Previous · Next · Show Comments
// Accept and Reject act on the change the cursor is in (or the one picked with Previous / Next),
// then move on to the next change, as Word does.

const revPane = $('#revPane');
let curHunk = null;

const revInfo = () => state.cur?.lanes[state.lane];
// the waiting changes, in document order: who, what, when
function revisions() {
  const info = revInfo();
  if (!info) return [];
  const map = new Map();
  for (const s of info.segments) {
    if (s.h < 0 || s.k === 'eq') continue;
    const r = map.get(s.h) || { h: s.h, by: s.by, ins: '', del: '', at: 0 };
    const text = s.t.replace(/<[^>]*>/g, ' ');
    if (s.k === 'ins') r.ins += text; else r.del += text;
    r.at = Math.max(r.at, s.at || 0);
    map.set(s.h, r);
  }
  return [...map.values()].sort((a, b) => a.h - b.h);
}
const flat = (t) => t.replace(/\s+/g, ' ').trim();

// ---------- the toolbar ----------
function applyReviewBar() {
  if (!reviewOn()) { closePane(); return; }
  const info = revInfo();
  if (!info) return;
  const can = canConfirmMe(), n = revisions().length;
  $('#rvTrack').classList.toggle('on', !!info.tracking);
  $('#rvTrack').setAttribute('aria-checked', String(!!info.tracking));
  $('#rvTrack').disabled = !can || state.me.role !== 'team';
  $('#rvTrack').title = can ? 'Track Changes: when on, everyone’s edits are marked and wait to be accepted' : 'Your edits are always tracked for the Team Head to accept';
  $('#rvMarkup').value = markupMode();
  for (const id of ['rvAccept', 'rvAcceptAll', 'rvReject', 'rvRejectAll']) $(`#${id}`).disabled = !can || !n;
  for (const id of ['rvPrev', 'rvNext']) $(`#${id}`).disabled = !n;
  $('#rvCount').textContent = n ? `${n} change${n > 1 ? 's' : ''}` : 'No changes';
  $('#rvShowC').classList.toggle('on', lsGet('lex_margin_off') !== '1');
  $('#rvShowC').setAttribute('aria-pressed', String(lsGet('lex_margin_off') !== '1'));
  $('#sbTrack').textContent = `Track Changes: ${info.tracking ? 'On' : 'Off'}`;
  $('#sbTrack').classList.toggle('on', !!info.tracking);
  $('#sbTrack').disabled = $('#rvTrack').disabled;
  if (!revPane.classList.contains('hidden')) renderPane();
}

// Track Changes, for this sheet and everyone on it
$('#sbTrack').addEventListener('click', () => $('#rvTrack').click()); // the status bar switch, as in Word
$('#rvTrack').addEventListener('click', async () => {
  const info = revInfo();
  if (!info) return;
  try {
    const r = await api('POST', `/api/drafts/${state.cur.draft.id}/lanes/${state.lane}/tracking`, { on: !info.tracking });
    state.cur.lanes[state.lane] = r.lane;
    ledger(`Track Changes is ${r.lane.tracking ? 'on — every edit is marked and waits to be accepted' : 'off'}.`);
    applyReviewBar();
  } catch (err) { ledger(err.message); }
});

// All Markup · Simple Markup · No Markup · Original
function setMarkup(mode) {
  lsSet('lex_markup', mode);
  editor().dataset.markup = mode;
  const info = revInfo();
  if (info) editor().contentEditable = info.editable && mode !== 'original' ? 'true' : 'false';
  applyReviewBar();
  if (typeof placeMarks === 'function') placeMarks();
  layoutPagesSoon();
}
$('#rvMarkup').addEventListener('change', (e) => setMarkup(e.target.value));

// ---------- moving between changes ----------
function selectChange(h, scroll = true) {
  curHunk = h;
  $$('#editor .tc.sel').forEach((el) => el.classList.remove('sel'));
  const marks = $$(`#editor .tc[data-h="${h}"]`);
  marks.forEach((el) => el.classList.add('sel'));
  if (scroll && marks[0]) marks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  $$('.rp-item', revPane).forEach((el) => el.classList.toggle('on', Number(el.dataset.h) === h));
}
function hunkAtCursor() {
  const sel = getSelection();
  if (!sel.rangeCount) return null;
  const node = sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement;
  const mark = node?.closest?.('#editor .tc');
  return mark ? Number(mark.dataset.h) : null;
}
function reviewGo(dir) {
  const list = revisions();
  if (!list.length) return ledger('There are no changes on this sheet.');
  if (markupMode() !== 'all') setMarkup('all'); // changes are walked through with the markup showing
  const at = hunkAtCursor() ?? curHunk;
  let next;
  if (at === null) next = dir > 0 ? list[0] : list[list.length - 1];
  else next = dir > 0 ? list.find((r) => r.h > at) || list[0] : [...list].reverse().find((r) => r.h < at) || list[list.length - 1];
  selectChange(next.h);
}
$('#rvPrev').addEventListener('click', () => reviewGo(-1));
$('#rvNext').addEventListener('click', () => reviewGo(1));

// ---------- accept / reject ----------
async function decide(action, all = false) {
  if (!canConfirmMe()) return;
  if (all) { await resolveChange('all', action); curHunk = null; applyReviewBar(); return; }
  const h = hunkAtCursor() ?? curHunk;
  if (h === null || !revisions().some((r) => r.h === h)) return ledger('Click into a change first, or use Next to go to one.');
  await resolveChange(h, action);
  // then on to the next change, as Word does (numbers close up once a change is settled)
  const list = revisions();
  curHunk = null;
  if (list.length) selectChange((list.find((r) => r.h >= h) || list[0]).h);
  applyReviewBar();
}
$('#rvAccept').addEventListener('click', () => decide('accept'));
$('#rvAcceptAll').addEventListener('click', () => decide('accept', true));
$('#rvReject').addEventListener('click', () => decide('reject'));
$('#rvRejectAll').addEventListener('click', () => decide('reject', true));

// clicking into a change picks it
editor().addEventListener('click', (e) => { const m = e.target.closest('.tc'); if (m) selectChange(Number(m.dataset.h), false); });

// ---------- comments ----------
let curComment = null;
const commentCards = () => $$('#mList .m-card').sort((a, b) => a.offsetTop - b.offsetTop);
function pickComment(card) {
  if (!card) return;
  curComment = Number(card.dataset.id);
  card.click(); // shows its passage, as clicking the card does
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
$('#rvNewC').addEventListener('click', () => {
  if (lsGet('lex_margin_off') === '1') foldMargin(false);
  const sel = getSelection(), text = sel.rangeCount && editor().contains(sel.anchorNode) ? sel.toString().trim() : '';
  if (text) { const top = sel.getRangeAt(0).getBoundingClientRect().top - $('#margin').getBoundingClientRect().top; openCompose(top, text.slice(0, 300)); compose.body.focus(); }
  else $('#mGeneral').click();
});
$('#rvDelC').addEventListener('click', () => {
  const card = curComment && $(`#mList .m-card[data-id="${curComment}"]`);
  if (!card) return ledger('Pick a comment first (click it, or use the comment arrows).');
  const del = $('.m-del', card);
  if (!del) return ledger('Only its author or the Team Head can delete that comment.');
  del.click();
  curComment = null;
});
$('#rvPrevC').addEventListener('click', () => { const c = commentCards(); const i = c.findIndex((x) => Number(x.dataset.id) === curComment); pickComment(c[i > 0 ? i - 1 : c.length - 1]); });
$('#rvNextC').addEventListener('click', () => { const c = commentCards(); const i = c.findIndex((x) => Number(x.dataset.id) === curComment); pickComment(c[(i + 1) % c.length]); });
$('#rvShowC').addEventListener('click', () => { foldMargin(lsGet('lex_margin_off') !== '1'); applyReviewBar(); });
document.addEventListener('click', (e) => { const card = e.target.closest('#mList .m-card'); if (card) curComment = Number(card.dataset.id); });

// ---------- the Reviewing Pane: every revision, in order ----------
function renderPane() {
  const list = revisions();
  const ins = list.filter((r) => flat(r.ins)).length, del = list.filter((r) => flat(r.del)).length;
  $('#rpSummary').textContent = list.length ? `${list.length} revision${list.length > 1 ? 's' : ''} · ${ins} insertion${ins === 1 ? '' : 's'}, ${del} deletion${del === 1 ? '' : 's'}` : 'No revisions';
  $('#rpList').innerHTML = list.map((r) => {
    const p = person(r.by), i = flat(r.ins), d = flat(r.del);
    const what = i && d ? `<span>Deleted</span> <del>${esc(d.slice(0, 160))}</del><br><span>Inserted</span> <ins>${esc(i.slice(0, 160))}</ins>`
      : i ? `<span>Inserted</span> <ins>${esc(i.slice(0, 200))}</ins>` : d ? `<span>Deleted</span> <del>${esc(d.slice(0, 200))}</del>` : '<span>Formatted</span>';
    return `<button type="button" class="rp-item${r.h === curHunk ? ' on' : ''}" data-h="${r.h}" style="--c:${p.color}">
      <b>${esc(p.name)}</b>${r.at ? `<small>${whenShort(r.at)}</small>` : ''}<p>${what}</p></button>`;
  }).join('') || '<p class="rp-empty">No revisions on this sheet.</p>';
}
function openPane() { revPane.classList.remove('hidden'); $('#rvPane').classList.add('on'); renderPane(); }
function closePane() { revPane.classList.add('hidden'); $('#rvPane').classList.remove('on'); }
$('#rvPane').addEventListener('click', () => (revPane.classList.contains('hidden') ? openPane() : closePane()));
$('#rpClose').addEventListener('click', closePane);
$('#rpList').addEventListener('click', (e) => {
  const item = e.target.closest('[data-h]');
  if (!item) return;
  if (markupMode() !== 'all') setMarkup('all');
  selectChange(Number(item.dataset.h));
});

// keep the toolbar (counts, switches, the pane) current as changes come and go
let revSeen = '';
setInterval(() => {
  const info = revInfo();
  const key = `${state.lane}|${info?.rev}|${info?.tracking}|${info?.pending}|${markupMode()}|${lsGet('lex_margin_off')}`;
  if (key === revSeen) return;
  revSeen = key;
  applyReviewBar();
  if (curHunk !== null) selectChange(curHunk, false);
}, 500);
