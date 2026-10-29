// ================= Zoit — who changed what =================
// A list of every change waiting on this sheet, grouped by the person who made it: what they added,
// removed or rewrote, a link to see it in place, and Accept / Reject for whoever may confirm changes.
// (The Team Head's own edits are confirmed as they're made, so they don't wait here.)

const whoPanel = $('#whoPanel');
let whoRev = null;

function whoChanges() {
  const info = state.cur?.lanes[state.lane];
  if (!info) return [];
  const byHunk = new Map(), segs = info.segments;
  const plain = (t) => t.replace(/<[^>]*>/g, ' ');
  const PARA = /<\/?(?:p|h[1-6]|li|div|td|th|br|blockquote)\b[^>]*>/i; // context stays inside the paragraph
  segs.forEach((s, i) => {
    if (s.h < 0 || s.k === 'eq') return;
    let c = byHunk.get(s.h);
    if (!c) { // the words just before the change, so it reads in context
      const prev = segs.slice(0, i).reverse().find((x) => x.k === 'eq');
      c = { h: s.h, by: s.by, added: '', removed: '', before: prev ? plain(prev.t.split(PARA).pop()).replace(/\s+/g, ' ').slice(-40) : '', after: '' };
      byHunk.set(s.h, c);
    }
    if (s.k === 'ins') c.added += plain(s.t); else c.removed += plain(s.t);
    const next = segs[i + 1];
    if (next && next.k === 'eq') c.after = plain(next.t.split(PARA)[0]).replace(/\s+/g, ' ').slice(0, 30);
  });
  return [...byHunk.values()];
}
const squeeze = (t, n = 140) => { t = t.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
function describe(c) {
  const a = squeeze(c.added), r = squeeze(c.removed);
  if (!a && !r) return '<span class="who-what">Changed the formatting</span>';
  const what = a && r ? 'Changed' : a ? 'Added' : 'Removed';
  const before = c.before.replace(/^\S*\s/, ''), after = c.after.replace(/\s\S*$/, ''); // whole words only
  return `<span class="who-what">${what}</span>${before ? '…' : ''}${esc(before)}${r ? `<del>${esc(r)}</del>` : ''}${a ? `<ins>${esc(a)}</ins>` : ''}${esc(after)}${after ? '…' : ''}`;
}

function renderWho() {
  const info = state.cur?.lanes[state.lane];
  const list = whoChanges();
  $('#whoCount').textContent = list.length || '';
  $('#whoBtn').classList.toggle('hidden', !state.lane || state.lane === 'final');
  $('#reviewBtn').classList.toggle('hidden', !state.lane || state.lane === 'final');
  $('#reviewBtn').classList.toggle('on', !!reviewOn());
  if (whoPanel.classList.contains('hidden') || !info) return;
  whoRev = info.rev;
  const can = canConfirmMe(), head = state.cur.head;
  const people = [...new Set(list.map((c) => c.by))];
  $('#whoList').innerHTML = list.length ? people.map((id) => {
    const p = person(id), mine = list.filter((c) => c.by === id);
    return `<section class="who-person" style="--c:${p.color}">
      <header><span class="avatar" style="--c:${p.color}">${initials(p.name)}</span><b>${esc(p.name)}${id === state.me.id ? ' <small>(you)</small>' : ''}</b><em>${mine.length} change${mine.length > 1 ? 's' : ''}</em></header>
      ${mine.map((c) => `<div class="who-item" data-h="${c.h}">
        <p>${describe(c)}</p>
        <div class="who-acts">
          <button type="button" class="who-show" data-show="${c.h}">Show in text</button>
          ${can ? `<button type="button" class="who-yes" data-who="accept" data-h="${c.h}">✓ Accept</button><button type="button" class="who-no" data-who="reject" data-h="${c.h}">✕ Reject</button>` : ''}
        </div>
      </div>`).join('')}
    </section>`;
  }).join('') : '<p class="who-empty">No changes waiting — everything on this sheet is confirmed.</p>';
  $('#whoNote').textContent = list.length && !can ? `${head?.name || 'The Team Head'} accepts or rejects these.` : '';
  $('#whoAll').classList.toggle('hidden', !(can && list.length > 1));
}

function openWho() { whoPanel.classList.remove('hidden'); $('#whoBtn').classList.add('on'); renderWho(); }
function closeWho() { whoPanel.classList.add('hidden'); $('#whoBtn').classList.remove('on'); }
$('#whoBtn').addEventListener('click', () => (whoPanel.classList.contains('hidden') ? openWho() : closeWho()));
$('#whoClose').addEventListener('click', closeWho);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !whoPanel.classList.contains('hidden')) { e.stopPropagation(); closeWho(); } }, true);

whoPanel.addEventListener('click', async (e) => {
  const show = e.target.closest('[data-show]');
  if (show) { // jump to the change: in the document itself with Review on, otherwise in the Changes view
    if (reviewOn() && state.view === 'text') {
      const marks = $$(`#editor .tc[data-h="${show.dataset.show}"]`);
      if (marks.length) {
        marks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        marks.forEach((el) => { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); });
        return;
      }
    }
    setView('changes');
    const at = $(`.view-changes [data-h="${show.dataset.show}"]`);
    if (at) { at.scrollIntoView({ behavior: 'smooth', block: 'center' }); $$(`.view-changes [data-h="${show.dataset.show}"]`).forEach((el) => { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }); }
    return;
  }
  const act = e.target.closest('[data-who]');
  if (act) {
    act.disabled = true;
    await resolveChange(Number(act.dataset.h), act.dataset.who);
    renderWho();
    return;
  }
  const all = e.target.closest('[data-who-all]');
  if (all) { all.disabled = true; await resolveChange('all', all.dataset.whoAll); all.disabled = false; renderWho(); }
});

// keep the list and its count current as changes come and go
setInterval(() => {
  if (!state.lane || !state.cur) { closeWho(); $('#whoBtn').classList.add('hidden'); return; }
  const info = state.cur.lanes[state.lane];
  if (!info) return;
  if (info.rev !== whoRev || $('#whoCount').textContent !== String(whoChanges().length || '')) renderWho();
}, 700);

// Review on / off: on, the document keeps every waiting change marked (it stays on until turned off)
$('#reviewBtn').addEventListener('click', () => {
  lsSet('lex_review', reviewOn() ? '0' : '1');
  $('#reviewBtn').classList.toggle('on', !!reviewOn());
  if (state.lane) { state.shown = null; renderDoc(); }
  ledger(reviewOn() ? 'Review is on — every change stays marked in its author’s colour.' : 'Review is off — showing the clean text.');
});
// click a marked change: open it in the list, where it can be accepted or rejected
editor().addEventListener('click', (e) => {
  const mark = e.target.closest('.tc');
  if (!mark) return;
  if (whoPanel.classList.contains('hidden')) openWho();
  const item = $(`.who-item[data-h="${mark.dataset.h}"]`, whoPanel);
  if (item) { item.scrollIntoView({ behavior: 'smooth', block: 'center' }); item.classList.remove('flash'); void item.offsetWidth; item.classList.add('flash'); }
});
