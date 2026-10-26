// ================= Zoit client =================
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const LANES = ['client', 'final', 'team'];
const LANE = {
  client: { num: 'I', name: 'Client Draft', lower: 'client draft' },
  final: { num: 'II', name: 'Clean Draft', lower: 'clean draft' },
  team: { num: 'III', name: 'Team Draft', lower: 'team draft' },
};
const STATUSES = [['drafting', 'Drafting'], ['client_review', 'Review'], ['negotiation', 'Negotiation'], ['approved', 'Approved'], ['executed', 'Executed']];
const statusLabel = (s) => (STATUSES.find(([k]) => k === s) || [, s])[1];
const AUTOSAVE_MS = 800;
const HOLD_MS = 800;

const state = {
  me: null, drafts: [], cur: null, es: null,
  lane: null,           // lane open full-screen, or null on the desk
  view: 'text',         // tab inside the full-screen document
  dirty: false, saveTimer: null, lastTyping: 0, typingTimer: null, refreshTimer: null,
};
const editor = () => $('#editor');

// ---------- utilities ----------
async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 402 && data.seatPending && typeof openPlans === 'function' && state.me?.head) openPlans(); // seat not paid yet (plans.js)
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status });
  return data;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (n) => (n || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
const words = (t) => (t.trim().match(/\S+/g) || []).length;
// sanitised HTML → readable text (for history comparisons)
function htmlToText(html) {
  const ta = document.createElement('textarea');
  ta.innerHTML = html.replace(/<\/(p|h\d|li|div|tr|blockquote)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
  return ta.value;
}
// caret position as a character offset, so live refreshes don't throw the cursor around
function caretOffset(el) {
  const sel = getSelection();
  if (!sel.rangeCount || !el.contains(sel.anchorNode)) return null;
  const r = sel.getRangeAt(0).cloneRange();
  r.selectNodeContents(el);
  r.setEnd(sel.anchorNode, sel.anchorOffset);
  return r.toString().length;
}
function setCaret(el, off) {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (off <= n.length) { const r = document.createRange(); r.setStart(n, off); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return; }
    off -= n.length;
  }
}
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const person = (id) => state.cur?.people.find((p) => p.id === id) || { id, name: 'Someone', color: '#777' };
const isHead = () => !!state.me?.head;
// what this person may do (the Team Head can do everything; associates as the Team Head allows)
const canConfirmMe = () => !!state.me?.canConfirm;
const canUploadMe = () => !!state.me?.canUpload;
// card ⇄ full-screen morph; an interrupted animation must never break navigation
function transition(fn) {
  if (!document.startViewTransition || document.hidden) { fn(); return null; }
  const t = document.startViewTransition(fn);
  t.ready.catch(() => {});
  t.finished.catch(() => {});
  const stop = setTimeout(() => t.skipTransition?.(), 1200); // an animation must never leave the screen frozen
  t.finished.finally(() => clearTimeout(stop)).catch(() => {});
  return t;
}

function ledger(text) {
  const el = $('#ledger');
  el.classList.add('swap');
  setTimeout(() => { el.textContent = text; el.classList.remove('swap'); }, 200);
  if (state.lane) setDocState(text); // the status line is hidden behind an open document, so say it there too
}

// plain word diff, used for history comparisons
function diffHtml(a, b) {
  const tok = (s) => s.match(/\s+|[\w'’-]+|[^\s\w]/g) || [];
  const A = tok(a), B = tok(b);
  let p = 0; while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0; while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  const a2 = A.slice(p, A.length - s), b2 = B.slice(p, B.length - s), n = a2.length, m = b2.length;
  let mid = '';
  if (n * m > 4e6) mid = `<del>${esc(a2.join(''))}</del><ins>${esc(b2.join(''))}</ins>`;
  else {
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a2[i] === b2[j]) { mid += esc(a2[i]); i++; j++; }
      else if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) mid += `<del>${esc(a2[i++])}</del>`;
      else mid += `<ins>${esc(b2[j++])}</ins>`;
    }
  }
  return esc(A.slice(0, p).join('')) + mid + esc(A.slice(A.length - s).join(''));
}

// ---------- boot & sign in ----------
window.addEventListener('load', async () => {
  if (location.pathname.startsWith('/join/')) return showJoin(location.pathname.slice(6)); // a shared link (share.js)
  try { state.me = (await api('GET', '/api/me')).user; await showApp(); }
  catch { showAuth(); }
});

const PHRASES = ['Draft with precision.', 'Negotiate in the open.', 'Deliberate in private.', 'Execute with certainty.'];
let typeTimer;
function typewriter() {
  const el = $('#typewriter');
  const ghost = $('.tw-ghost');
  if (ghost) ghost.textContent = PHRASES.reduce((a, b) => (b.length > a.length ? b : a));
  let pi = 0, ci = 0, del = false;
  clearTimeout(typeTimer);
  const step = () => {
    const w = PHRASES[pi];
    ci += del ? -1 : 1;
    el.textContent = w.slice(0, ci);
    let wait = del ? 30 : 70;
    if (!del && ci === w.length) { del = true; wait = 2200; }
    else if (del && ci === 0) { del = false; pi = (pi + 1) % PHRASES.length; wait = 350; }
    typeTimer = setTimeout(step, wait);
  };
  step();
}
function showAuth() {
  closeStream();
  document.body.className = '';
  $('#app').classList.add('hidden');
  $('#doc').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  $('#planPanel').classList.add('hidden');
  $('#viewOnly').classList.add('hidden');
  $('#authError').textContent = '';
  typewriter();
}
$$('.auth-tab').forEach((t) => t.addEventListener('click', () => {
  $$('.auth-tab').forEach((x) => x.classList.toggle('active', x === t));
  $('#loginForm').classList.toggle('hidden', t.dataset.tab !== 'login');
  $('#registerForm').classList.toggle('hidden', t.dataset.tab !== 'register');
  $('#authError').textContent = '';
}));
async function enter(url, form) {
  try { state.me = (await api('POST', url, Object.fromEntries(new FormData(form)))).user; clearTimeout(typeTimer); await showApp(); }
  catch (err) { $('#authError').textContent = err.message; }
}
$('#loginForm').addEventListener('submit', (e) => { e.preventDefault(); enter('/api/auth/login', e.target); });
$('#registerForm').addEventListener('submit', (e) => { e.preventDefault(); enter('/api/auth/register', e.target); });
$$('.demo button').forEach((b) => b.addEventListener('click', () => {
  const f = $('#loginForm');
  f.email.value = b.dataset.email; f.password.value = b.dataset.pw;
  f.requestSubmit();
}));

// ---------- app shell ----------
async function showApp() {
  const me = state.me;
  document.body.className = `role-${me.role}${me.head ? ' is-head' : ''}`;
  document.documentElement.style.setProperty('--me', me.color);
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#meName').textContent = me.name;
  $('#meRole').textContent = me.role === 'team' ? (me.title || 'Counsel') : 'Client';
  $('#meAvatar').textContent = initials(me.name);
  $('#meAvatar').style.setProperty('--c', me.color);
  $('#matterTitle').contentEditable = me.role === 'team' ? 'plaintext-only' : 'false';
  // an associate whose seat isn't paid can look around; one with no firm yet waits to be added
  $('#viewOnly').classList.toggle('hidden', !(me.role === 'team' && !me.head && me.seat === 'pending'));
  $('#viewOnly').textContent = me.firm ? "View only — your Team Head hasn't paid for your seat yet. You can look around; editing opens once it's paid."
    : `You're not in a firm yet. Ask your Team Head to add ${me.email} in their Team panel — you'll see your firm's matters here once they do.`;
  if (me.role === 'team' && me.head && me.seat === 'pending') { showEmpty(); return openPlans(); } // seat not paid yet: Activate Zoit (plans.js)
  await loadDrafts();
  const pick = state.drafts.find((d) => d.id === Number(lsGet('lex_last'))) || state.drafts[0];
  if (pick) { await openMatter(pick.id); route(); } else showEmpty();
}
function showEmpty() {
  state.cur = null;
  closeStream();
  $('#workspace').classList.add('hidden');
  $('#emptyState').classList.remove('hidden');
  renderMatters();
}
$('#logoutBtn').addEventListener('click', async () => {
  await save();
  await api('POST', '/api/auth/logout');
  state.me = null; state.cur = null;
  history.replaceState(null, '', location.pathname);
  showAuth();
});

// ----- matters rail
async function loadDrafts() { state.drafts = (await api('GET', '/api/drafts')).drafts; renderMatters(); }
// a matter's own date (YYYY-MM-DD) shown as e.g. "12 Nov 2026"
const fmtMatterDate = (md) => (md ? new Date(`${md}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
function renderMatters() {
  const team = state.me?.role === 'team'; // the legal team can delete matters; clients never see this
  $('#matterList').innerHTML = state.drafts.map((d) => state.confirmDel === d.id ? `
    <div class="matter confirm-del" data-id="${d.id}">
      <span>Delete <b>${esc(d.title)}</b> and everything in it?</span>
      <span class="cd-actions"><button data-del-yes="${d.id}">Delete</button><button data-del-no>Cancel</button></span>
    </div>` : `
    <div class="matter ${(state.cur?.draft.matterId ?? state.cur?.draft.id) === d.id ? 'on' : ''}" data-id="${d.id}" role="button" tabindex="0">
      <b>${esc(d.title)}</b><small>${esc(d.matter_no)} · ${esc(statusLabel(d.status))}${d.matter_date ? ` · ${fmtMatterDate(d.matter_date)}` : ''}</small>
      ${isHead() ? `<span class="m-trash" data-del="${d.id}" role="button" title="Delete this matter"><svg viewBox="0 0 16 16"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4"/></svg></span>` : ''}
    </div>`).join('') || '<p class="rail-label">None yet</p>';
}
async function deleteMatter(id) {
  const d = state.drafts.find((x) => x.id === id);
  try {
    const openId = state.cur?.draft.matterId ?? state.cur?.draft.id;
    if (state.lane && openId === id) await closeDoc(true);
    await api('DELETE', `/api/drafts/${id}`);
    state.confirmDel = null;
    if (lsGet('lex_last') === String(id)) lsSet('lex_last', '');
    const wasOpen = openId === id;
    if (wasOpen) state.cur = null;
    await loadDrafts();
    if (wasOpen) state.drafts[0] ? await openMatter(state.drafts[0].id) : showEmpty();
    confirmDone(`Deleted “${d?.title || 'matter'}”`);
  } catch (err) { state.confirmDel = null; renderMatters(); ledger(err.message); }
}
$('#matterList').addEventListener('click', (e) => {
  const trash = e.target.closest('[data-del]');
  if (trash) { state.confirmDel = Number(trash.dataset.del); return renderMatters(); } // ask first
  const yes = e.target.closest('[data-del-yes]');
  if (yes) return deleteMatter(Number(yes.dataset.delYes));
  if (e.target.closest('[data-del-no]')) { state.confirmDel = null; return renderMatters(); }
  const m = e.target.closest('.matter:not(.confirm-del)');
  if (m) openMatter(Number(m.dataset.id));
});
$('#matterList').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.confirmDel) { state.confirmDel = null; renderMatters(); }
  if (e.key === 'Enter' && e.target.matches('.matter[data-id]')) openMatter(Number(e.target.dataset.id));
});
// ----- new matter: pick a client or add a new one, optionally start from a Word/PDF file
const nf = $('#newForm');
let nfFile = null;
$('#newToggle').addEventListener('click', async () => {
  let clients = [];
  try { ({ clients } = await api('GET', '/api/clients')); } catch { /* still open the form */ }
  $('#clientSelect').innerHTML = '<option value="__new">＋ New client…</option><option value="">No client yet</option>'
    + clients.map((c) => `<option value="${c.id}">${esc(c.name)}${c.title ? ` · ${esc(c.title)}` : ''}${c.active ? '' : ' (invited)'}</option>`).join('');
  $('#clientSelect').value = clients.length ? String(clients[0].id) : ''; // a new firm starts with "No client yet"
  toggleNewClient();
  $('#newToggle').classList.add('hidden');
  nf.classList.remove('hidden');
  nf.elements.title.focus();
});
function toggleNewClient() {
  const isNew = $('#clientSelect').value === '__new';
  $('#newClientFields').classList.toggle('hidden', !isNew);
  nf.elements.ncName.required = isNew;
  nf.elements.ncEmail.required = isNew;
}
$('#clientSelect').addEventListener('change', toggleNewClient);
function setNfFile(file) {
  nfFile = file || null;
  $('#nfFileName').textContent = nfFile ? nfFile.name : 'Drop a Word or PDF file, or click — optional';
  $('#nfDrop').classList.toggle('has', !!nfFile);
}
$('#nfFile').addEventListener('change', (e) => setNfFile(e.target.files[0]));
['dragenter', 'dragover'].forEach((t) => $('#nfDrop').addEventListener(t, (e) => { e.preventDefault(); $('#nfDrop').classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => $('#nfDrop').addEventListener(t, () => $('#nfDrop').classList.remove('over')));
$('#nfDrop').addEventListener('drop', (e) => { e.preventDefault(); setNfFile(e.dataTransfer.files[0]); });
function closeNewForm() { nf.reset(); setNfFile(null); $('#nfError').textContent = ''; nf.classList.add('hidden'); $('#newToggle').classList.remove('hidden'); }
$('#newCancel').addEventListener('click', closeNewForm);
nf.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(nf));
  const submit = $('button[type="submit"]', nf);
  submit.disabled = true;
  $('#nfError').textContent = '';
  try {
    const body = { title: f.title, counterparty: f.counterparty, template: f.template, matterDate: f.matterDate };
    if (f.clientId === '__new' && (f.ncName || f.ncEmail)) body.newClient = { name: f.ncName, company: f.ncCompany, email: f.ncEmail };
    else if (f.clientId) body.clientId = Number(f.clientId);
    if (nfFile) {
      submit.textContent = 'Reading file…';
      const { html, page } = await convertFile(nfFile);
      Object.assign(body, { contentHtml: html, sourceName: nfFile.name, page });
    }
    const { draft } = await api('POST', '/api/drafts', body);
    closeNewForm();
    await loadDrafts();
    await openMatter(draft.id);
    ledger(`Matter ${draft.matter_no} opened${body.newClient ? ` for new client ${body.newClient.name}` : ''}.`);
  } catch (err) { $('#nfError').textContent = err.message; }
  finally { submit.disabled = false; submit.textContent = 'Open matter'; }
});

// ----- the matter (desk)
async function openMatter(id) {
  await save();
  let data;
  try { data = await api('GET', `/api/drafts/${id}`); }
  catch (err) { ledger(err.message); return showEmpty(); }
  const switching = state.cur?.draft.id !== id;
  state.cur = data;
  // associates can't rename a matter the Team Head made
  $('#matterTitle').contentEditable = state.me.role === 'team' && (isHead() || !data.draft.headMade) ? 'plaintext-only' : 'false';
  lsSet('lex_last', id);
  $('#emptyState').classList.add('hidden');
  const ws = $('#workspace');
  if (switching) {
    ws.classList.add('hidden'); void ws.offsetWidth; // replay entrance
    const a = data.activity[0];
    $('#ledger').textContent = a ? `${a.author} ${a.action} · ${ago(a.created_at)}` : '';
    if (state.lane) closeDoc(true);
    openStream(id);
  }
  ws.classList.remove('hidden');
  renderDesk();
  renderMatters();
}

// re-fetch quietly after something changed elsewhere
function refreshSoon() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(refresh, 200);
}
async function refresh() {
  if (!state.cur) return;
  try { state.me = (await api('GET', '/api/me')).user; } catch { /* signed out elsewhere */ }
  try { state.cur = await api('GET', `/api/drafts/${state.cur.draft.id}`); }
  catch { return; }
  renderDesk();
  if (state.lane) renderDoc({ fromServer: true });
}

function renderDesk() {
  const { draft, lanes } = state.cur;
  const title = $('#matterTitle');
  if (document.activeElement !== title) title.textContent = draft.title;
  $('#matterSub').textContent = `${draft.matter_no}  ·  ${draft.client ? `for ${draft.client.name}${draft.client.title ? `, ${draft.client.title}` : ''}` : 'no client assigned'}${draft.counterparty ? `  ·  other side: ${draft.counterparty}` : ''}`;
  // the matter's date: lawyers can set it, clients see it
  const md = $('#matterDate');
  if (document.activeElement !== md) md.value = draft.matter_date || '';
  md.disabled = state.me.role !== 'team';
  $('#matterDateText').textContent = draft.matter_date ? fmtMatterDate(draft.matter_date) : (state.me.role === 'team' ? 'Set a date' : '');
  $('.mdate').classList.toggle('empty', !draft.matter_date);
  $('.mdate').classList.toggle('hidden', !draft.matter_date && state.me.role !== 'team');
  const idx = STATUSES.findIndex(([k]) => k === draft.status);
  $('#stepper').innerHTML = STATUSES.map(([k, l], i) => `<li data-status="${k}" class="${i < idx ? 'done' : i === idx ? 'now' : ''}"><i></i>${l}</li>`).join('');
  renderPresence(state.cur.presence);
  if (typeof renderDocStrip === 'function') renderDocStrip(); // docs.js
  // cards carry nothing but a pending-changes marker
  for (const lane of LANES) {
    const badge = $(`.card[data-lane="${lane}"] .card-badge`);
    const info = lanes[lane];
    // associates' upload requests count as things awaiting the Head, on the team draft
    const reqs = lane === 'team' ? (state.cur.requests || []) : [];
    const n = (info?.pending || 0) + reqs.length;
    badge.classList.toggle('on', n > 0);
    if (n > 0) {
      const authors = [...new Set([...info.segments.filter((s) => s.by).map((s) => s.by), ...reqs.map((r) => r.requested_by)])];
      badge.innerHTML = authors.map((id) => `<span class="dot" style="--c:${person(id).color}"></span>`).join('') + `${n} ${canConfirmMe() ? 'to confirm' : 'pending'}`;
    }
  }
}

$('#matterTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
$('#matterTitle').addEventListener('blur', async (e) => {
  if (!state.cur || state.me.role !== 'team') return;
  const t = e.target.textContent.trim();
  if (!t || t === state.cur.draft.title) { e.target.textContent = state.cur.draft.title; return; }
  try { await api('PATCH', `/api/drafts/${state.cur.draft.id}`, { title: t }); state.cur.draft.title = t; await loadDrafts(); ledger('Matter renamed.'); }
  catch (err) { ledger(err.message); }
});
$('#stepper').addEventListener('click', async (e) => {
  const li = e.target.closest('li');
  if (!li || state.me.role !== 'team' || li.dataset.status === state.cur.draft.status) return;
  try { await api('PATCH', `/api/drafts/${state.cur.draft.id}`, { status: li.dataset.status }); }
  catch (err) { ledger(err.message); }
});
function renderPresence(users = []) {
  $('#presence').innerHTML = users.map((u) => `<div class="avatar" style="--c:${u.color}" title="${esc(u.name)}${u.id === state.me.id ? ' (you)' : ''}">${initials(u.name)}</div>`).join('');
}

// ---------- open a sheet full-screen (hash routing so Back works) ----------
$$('.card').forEach((card) => card.addEventListener('click', () => {
  const lane = card.dataset.lane;
  if (!state.cur?.lanes[lane]) return; // sealed for clients
  location.hash = lane;
}));
window.addEventListener('hashchange', route);
function route() {
  const lane = location.hash.slice(1);
  if (LANES.includes(lane) && state.cur?.lanes[lane]) { if (state.lane !== lane) openDoc(lane); }
  else if (state.lane) closeDoc();
}
async function openDoc(lane) {
  if (state.lane) { // already full-screen: just switch documents, no card animation
    await save();
    state.lane = lane;
    state.view = 'text';
    state.dirty = false;
    return renderDoc({ force: true });
  }
  const card = $(`.card[data-lane="${lane}"]`);
  card.style.viewTransitionName = 'sheet';
  transition(() => {
    card.style.viewTransitionName = '';
    $('#page').style.viewTransitionName = 'sheet';
    state.lane = lane;
    state.view = 'text';
    state.dirty = false;
    $('#doc').classList.remove('hidden');
    renderDoc({ force: true });
    if (editor().isContentEditable) editor().focus({ preventScroll: true });
  });
}
async function closeDoc(instant = false) {
  await save();
  const lane = state.lane;
  state.lane = null;
  const hide = () => {
    $('#doc').classList.add('hidden');
    $('#page').style.viewTransitionName = '';
    const card = lane && $(`.card[data-lane="${lane}"]`);
    if (card && !instant) card.style.viewTransitionName = 'sheet';
  };
  if (instant) hide(); else await transition(hide)?.finished.catch(() => {});
  $$('.card').forEach((c) => (c.style.viewTransitionName = ''));
  if (location.hash) history.replaceState(null, '', location.pathname);
}
$('#docBack').addEventListener('click', () => closeDoc());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.lane) closeDoc();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
});

function renderDoc({ force = false, fromServer = false } = {}) {
  const lane = state.lane;
  const info = state.cur.lanes[lane];
  if (!info) return closeDoc(true);
  const { draft } = state.cur;
  $('#docNum').textContent = LANE[lane].num;
  $('#docName').textContent = LANE[lane].name;
  // which document of the matter this is, when the matter has more than one
  const many = (state.cur.documents || []).length > 1;
  $('#docMatter').textContent = `${draft.title}${many ? ` · ${draft.folder ? `${draft.folder} / ` : ''}${draft.docName}` : ''} · ${draft.matter_no}`;
  const ed = editor(), scroller = $('#sheetScroll');
  if (force || !state.dirty) {
    const top = scroller.scrollTop, caret = caretOffset(ed);
    if (force || state.loaded !== info.content) {
      ed.innerHTML = info.content;
      state.loaded = info.content;
      if (fromServer) { const p = $('#page'); p.classList.remove('touched'); void p.offsetWidth; p.classList.add('touched'); }
      if (caret !== null) setCaret(ed, caret);
    }
    scroller.scrollTop = force ? 0 : top;
  }
  ed.contentEditable = info.editable ? 'true' : 'false';
  $('#tabChanges').textContent = info.pending || '';
  $('#tabChanges').classList.toggle('alert', info.pending > 0 && canConfirmMe());
  const clean = lane === 'final';
  $('#page').classList.toggle('no-margin', clean);
  $('#docTabs [data-view="changes"]').classList.toggle('hidden', clean);
  if (clean && state.view === 'changes') state.view = 'text';
  if (!state.dirty) idleState();
  renderActions();
  setView(state.view);
  applyZoom();
  layoutPages();
  renderMargin();
}

function setDocState(text) { $('#docState').textContent = text; }
function idleState() {
  const info = state.cur?.lanes[state.lane];
  if (!info) return;
  setDocState(info.editable
    ? `Autosaved ${info.updatedAt > Date.now() - 86400000 ? clock(info.updatedAt) : ago(info.updatedAt)} · ${words(editor().innerText).toLocaleString()} words`
    : `Read only · ${words(editor().innerText).toLocaleString()} words`);
}

function renderActions() {
  const lane = state.lane, info = state.cur.lanes[lane], team = state.me.role === 'team';
  const st = state.cur.draft.status;
  const hold = (act, label, sub = '') => `<button class="hold" data-act="${act}">${label}${sub ? ` <small>${sub}</small>` : ''}</button>`;
  let html = '';
  if (info.pending && state.view !== 'changes') {
    html += `<span class="note">${info.pending} change${info.pending > 1 ? 's' : ''} ${canConfirmMe() ? 'awaiting your confirmation' : `awaiting confirmation by ${esc(state.cur.head?.name || 'the Team Head')}`} — <button data-goto="changes">review</button></span>`;
  }
  // The clean draft is only ever uploaded from the team draft, by the Team Head.
  // That single control lives on the team draft; the clean draft itself stays bare.
  if (team && lane === 'team') {
    const headName = esc(state.cur.head?.name || 'the Team Head');
    const reqs = state.cur.requests || [];
    if (canUploadMe()) {
      const r = reqs[0];
      html += r
        ? `<span class="req"><i class="dot" style="--c:${r.requester_color}"></i><b>${esc(r.requester)}</b> asked you to upload · ${ago(r.created_at)}
            <button class="link" data-preview="${r.id}">preview</button><button class="link" data-decline="${r.id}">decline</button></span>
           <button class="hold" data-act="req-approve" data-req="${r.id}">Hold to upload to clean draft →</button>`
        : hold('promote-team', 'Hold to upload to clean draft →');
      html += hold('to-client', '← Hold to send to client draft');
    } else {
      const mine = reqs.find((r) => r.requested_by === state.me.id);
      html += mine
        ? `<span class="req">Waiting for ${headName} to upload · <button class="link" data-withdraw="${mine.id}">withdraw</button></span>`
        : hold('promote-team', `Ask ${headName} to upload →`);
    }
  }
  if (!team && lane === 'final' && !['approved', 'executed'].includes(st)) html += hold('approve', 'Hold to approve this draft');
  $('#docActions').innerHTML = html;
}
const REQUEST_WORDS = { 'promote-team': 'upload the team draft to the clean draft' };
$('#docActions').addEventListener('click', async (e) => {
  const g = e.target.closest('[data-goto]');
  if (g) return setView(g.dataset.goto);
  const p = e.target.closest('[data-preview]');
  if (p) { state.preview = Number(p.dataset.preview); return setView('changes'); }
  const d = e.target.closest('[data-decline], [data-withdraw]');
  if (!d) return;
  const decision = d.dataset.decline ? 'decline' : 'withdraw';
  try {
    await api('POST', `/api/drafts/${state.cur.draft.id}/requests/${d.dataset.decline || d.dataset.withdraw}`, { decision });
    ledger(decision === 'decline' ? 'Request declined.' : 'Request withdrawn.');
    await refresh();
  } catch (err) { ledger(err.message); }
});

// ----- tabs inside the document
$('#docTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (!b) return;
  if (b.dataset.view !== 'text') save();
  setView(b.dataset.view);
});
function setView(view) {
  state.view = view;
  $$('#docTabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  if (view !== 'changes') state.preview = null;
  $$('#page > .sheet-scroll, #page > .pane').forEach((p) => p.classList.toggle('on', p.classList.contains(`view-${view}`)));
  const on = $('#docTabs button.on'), ink = $('#docTabs .tab-ink');
  if (on) { ink.style.left = `${on.offsetLeft}px`; ink.style.width = `${on.offsetWidth}px`; }
  if (view === 'changes') renderChanges();
  if (view === 'history') renderHistory();
  if (view === 'text') requestAnimationFrame(layoutMargin);
  if (state.lane) renderActions(); // the "n pending — review" note hides on the Changes tab
  const canFormat = view === 'text' && !!state.cur?.lanes[state.lane]?.editable;
  $('#toolbar').classList.toggle('off', !canFormat);
  if (!canFormat) closeFind();
}
window.addEventListener('resize', () => state.lane && setView(state.view));

// ----- Changes: pending edits in each author's colour; the Team Head confirms them
function renderChanges() {
  const pane = $('.view-changes');
  const info = state.cur.lanes[state.lane];
  // previewing an associate's request: what the clean draft would become
  const r = state.preview && (state.cur.requests || []).find((x) => x.id === state.preview);
  if (r) {
    const before = htmlToText(state.cur.lanes.final.content);
    pane.innerHTML = `<div class="preview-head"><i class="dot" style="--c:${r.requester_color}"></i><span><b>${esc(r.requester)}</b> asks to ${REQUEST_WORDS[r.kind]}. Showing what the clean draft would become.</span>
      <button class="hold" data-act="req-approve" data-req="${r.id}">Hold to upload</button><button class="x" data-close-preview>close</button></div>
      <div class="preview-doc">${diffHtml(before, htmlToText(r.content))}</div>`;
    $('[data-close-preview]', pane).addEventListener('click', () => { state.preview = null; setView('text'); });
    return;
  }
  const head = state.cur.head;
  const authors = [...new Set(info.segments.filter((s) => s.by).map((s) => s.by))];
  const hunkEnds = new Map(), hunkHasText = new Set();
  info.segments.forEach((s, i) => {
    if (s.h < 0) return;
    hunkEnds.set(s.h, i);
    if (s.t.replace(/<[^>]*>/g, '').trim()) hunkHasText.add(s.h);
  });
  // Segments are sanitised HTML from the server. Inserted tags are part of the working
  // document and stay; deleted tags are dropped; text is wrapped in the author's colour.
  const body = info.segments.map((s, i) => {
    if (s.k === 'eq') return s.t;
    const p = person(s.by), tag = s.k === 'ins' ? 'ins' : 'del';
    let out = s.t.split(/(<[^>]*>)/).map((piece) => {
      if (!piece) return '';
      if (piece.startsWith('<')) return s.k === 'ins' ? piece : '';
      return `<${tag} data-h="${s.h}" style="--c:${p.color}" title="${esc(p.name)}">${piece}</${tag}>`;
    }).join('');
    if (hunkEnds.get(s.h) === i) {
      let mark = hunkHasText.has(s.h) ? '' : `<span class="fmt" data-h="${s.h}" style="--c:${p.color}" title="Formatting change by ${esc(p.name)}">Format</span>`;
      if (canConfirmMe()) mark += `<span class="ctl" data-h="${s.h}"><button data-a="accept" title="Confirm">✓</button><button data-a="reject" title="Reject">✕</button></span>`;
      out = out.replace(/((?:<[^>]*>)*)$/, `${mark}$1`); // keep the controls inside the paragraph
    }
    return out;
  }).join('');
  const summary = info.pending
    ? `<b>${info.pending}</b> change${info.pending > 1 ? 's' : ''} ${canConfirmMe() ? 'awaiting your confirmation' : `awaiting confirmation by ${esc(head?.name || 'the Team Head')}`}`
    : 'Everything on this sheet is confirmed.';
  pane.innerHTML = `
    <div class="changes-head">
      <span class="summary">${summary}</span>
      ${canConfirmMe() && info.pending ? '<button class="hold" data-act="accept-all">Hold to confirm all</button><button class="hold" data-act="reject-all">Hold to reject all</button>' : ''}
      ${authors.length ? `<div class="legend">${authors.map((id) => `<span><i class="dot" style="--c:${person(id).color}"></i>${esc(person(id).name)}</span>`).join('')}</div>` : ''}
    </div>
    <div class="doc-text rich">${body || '<span class="none">Empty.</span>'}</div>`;
}
// hover a change → highlight all of its parts
$('.view-changes').addEventListener('mouseover', (e) => {
  const el = e.target.closest('[data-h]');
  $$('.view-changes .hot').forEach((x) => x.classList.remove('hot'));
  if (el) $$(`.view-changes [data-h="${el.dataset.h}"]`).forEach((x) => x.classList.add('hot'));
});
$('.view-changes').addEventListener('click', async (e) => {
  const b = e.target.closest('.ctl button');
  if (!b) return;
  await resolveChange(Number(b.parentElement.dataset.h), b.dataset.a);
});
async function resolveChange(hunk, action) {
  const lane = state.lane, info = state.cur.lanes[lane];
  try {
    const r = await api('POST', `/api/drafts/${state.cur.draft.id}/lanes/${lane}/changes`, { action, hunk, rev: info.rev });
    state.cur.lanes[lane] = r.lane;
    ledger(`${action === 'accept' ? 'Confirmed' : 'Rejected'} ${hunk === 'all' ? 'all changes' : 'a change'} on the ${LANE[lane].lower}.`);
    if (r.carried) { // a confirmed client change also lands in the team and clean drafts
      const c = r.carried, into = ['team', 'final'].filter((l) => c[l].placed).map((l) => LANE[l].lower);
      const missed = ['team', 'final'].filter((l) => c[l].placed < c[l].total).map((l) => LANE[l].lower);
      confirmDone(into.length ? `Confirmed — also added to the ${into.join(' and ')}` : 'Confirmed');
      if (missed.length) ledger(`Some of it couldn't be placed in the ${missed.join(' and ')} — that passage reads differently there now. Add it by hand.`);
      await refresh();
    }
    renderDoc({ force: true });
    renderDesk();
  } catch (err) {
    ledger(err.message);
    if (err.status === 409) refresh();
  }
}

// ----- Remarks: in the page's margin, each pinned beside the passage it's about
let pinQuote = null; // text selected in the document while writing a remark

// Locate a quoted passage in the document (whitespace-insensitive) as a DOM Range.
function findRange(quote) {
  if (!quote) return null;
  const nodes = [];
  let raw = '';
  const w = document.createTreeWalker(editor(), NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) { nodes.push([n, raw.length]); raw += n.data; }
  let norm = '';
  const map = [];
  for (let i = 0; i < raw.length; i++) {
    if (/\s/.test(raw[i])) { if (norm.endsWith(' ')) continue; norm += ' '; } else norm += raw[i];
    map.push(i);
  }
  const q = quote.replace(/\s+/g, ' ').trim().toLowerCase();
  const idx = norm.toLowerCase().indexOf(q);
  if (idx < 0 || !q) return null;
  const at = (off) => { for (let k = nodes.length - 1; k >= 0; k--) if (nodes[k][1] <= off) return [nodes[k][0], off - nodes[k][1]]; return null; };
  const s = at(map[idx]), e = at(map[idx + q.length - 1]);
  if (!s || !e) return null;
  const r = document.createRange();
  r.setStart(s[0], s[1]);
  r.setEnd(e[0], e[1] + 1);
  return r;
}

function renderMargin() {
  const lane = state.lane;
  if (!lane || !state.cur) return;
  const list = state.cur.comments.filter((c) => c.lane === lane);
  $('#mTitle').textContent = lane === 'team' ? 'Internal notes' : 'Remarks';
  $('#mCount').textContent = list.length || '';
  $('#mCompose').body.placeholder = lane === 'team' ? 'Note to the team…' : 'Add a remark…';
  $('#mList').innerHTML = list.map((c) => `
    <div class="m-card" data-id="${c.id}" style="--c:${c.author_color}">
      ${c.quote ? `<div class="q" title="${esc(c.quote)}">“${esc(c.quote)}”</div>` : ''}
      <div class="by"><b>${esc(c.author)}</b> · ${ago(c.created_at)}${c.author_id === state.me.id || isHead() ? `<button class="m-del" data-del="${c.id}" title="Delete this remark">Delete</button>` : ''}</div>
      <p>${esc(c.body)}</p>
    </div>`).join('') || `<div class="m-empty">${lane === 'team' ? 'No internal notes yet.' : 'No remarks yet.'}</div>`;
  layoutMargin();
}

// Place each card level with its passage; unpinned remarks stack from the top; nothing overlaps.
function layoutMargin() {
  if (!state.lane || state.view !== 'text' || !state.cur) return;
  const list = $('#mList');
  if (getComputedStyle($('#sheetScroll')).flexDirection === 'column') { list.style.height = ''; return; } // phone: plain stack
  const base = list.getBoundingClientRect().top;
  const found = [];
  const items = $$('.m-card', list).map((card, order) => {
    const c = state.cur.comments.find((x) => x.id === Number(card.dataset.id));
    const r = c?.quote ? findRange(c.quote) : null;
    $('.q', card)?.classList.toggle('lost', !!c?.quote && !r); // passage was edited away
    if (r) found.push(r);
    card._range = r;
    return { card, order, want: r ? r.getBoundingClientRect().top - base : 0 };
  });
  items.sort((a, b) => a.want - b.want || a.order - b.order);
  let y = 0;
  for (const it of items) {
    const top = Math.max(it.want, y);
    it.card.style.top = `${top}px`;
    y = top + it.card.offsetHeight + 10;
  }
  list.style.height = `${y}px`;
  if (window.CSS?.highlights && window.Highlight) CSS.highlights.set('remarks', new Highlight(...found));
}
let marginTimer;
const relayoutSoon = () => { clearTimeout(marginTimer); marginTimer = setTimeout(layoutMargin, 250); };
editor().addEventListener('input', relayoutSoon);
window.addEventListener('resize', relayoutSoon);
document.fonts?.ready.then(relayoutSoon);               // web fonts change line heights
editor().addEventListener('load', relayoutSoon, true);  // so do pictures as they arrive

// hovering a remark lights up its passage; clicking scrolls to it
$('#mList').addEventListener('mouseover', (e) => {
  const card = e.target.closest('.m-card');
  if (card?._range && window.CSS?.highlights) CSS.highlights.set('remark-on', new Highlight(card._range));
});
$('#mList').addEventListener('mouseout', (e) => { if (!e.relatedTarget?.closest?.('.m-card') && window.CSS?.highlights) CSS.highlights.delete('remark-on'); });
$('#mList').addEventListener('click', (e) => {
  if (e.target.closest('.m-del')) return; // handled below
  const card = e.target.closest('.m-card');
  if (!card?._range) return;
  const sc = $('#sheetScroll');
  const y = card._range.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 140;
  sc.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  $$('.m-card.on').forEach((x) => x.classList.remove('on'));
  card.classList.add('on');
});

// The remark box stays out of the way: it appears beside a selection (or via "+ Remark")
// and disappears again when the selection goes away, the remark is posted, or Esc.
const compose = $('#mCompose');
function openCompose(top, quote) {
  pinQuote = quote;
  $('#mQuote').classList.toggle('hidden', !quote);
  $('#mQuote').textContent = quote ? `“${quote}”` : '';
  compose.style.top = `${Math.max(46, top)}px`;
  compose.classList.remove('hidden');
}
function closeCompose() {
  compose.classList.add('hidden');
  compose.body.value = '';
  pinQuote = null;
}
document.addEventListener('selectionchange', () => {
  const sel = getSelection();
  if (!sel.rangeCount || !state.lane || state.view !== 'text') return;
  if (!editor().contains(sel.anchorNode)) return; // focus moved into the remark box: keep it open
  const text = sel.toString().replace(/\s+/g, ' ').trim();
  if (text) {
    const top = sel.getRangeAt(0).getBoundingClientRect().top - $('#margin').getBoundingClientRect().top;
    openCompose(top, text.slice(0, 300));
  } else if (!compose.body.value.trim()) closeCompose();
});
$('#mGeneral').addEventListener('click', () => {
  const top = $('#sheetScroll').getBoundingClientRect().top + 50 - $('#margin').getBoundingClientRect().top;
  openCompose(top, null);
  compose.body.focus();
});
$('#mCancel').addEventListener('click', closeCompose);
compose.body.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); compose.requestSubmit(); }
  if (e.key === 'Escape') { e.stopPropagation(); closeCompose(); }
});
compose.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = compose.body.value.trim();
  if (!body || !state.lane) return;
  try {
    const { comment } = await api('POST', `/api/drafts/${state.cur.draft.id}/comments`, { lane: state.lane, body, quote: pinQuote });
    closeCompose();
    addComment(comment);
  } catch (err) { ledger(err.message); }
});
function addComment(c) {
  if (state.cur.comments.some((x) => x.id === c.id)) return;
  state.cur.comments.push(c);
  if (state.lane === c.lane) renderMargin();
}

// ----- History
async function renderHistory() {
  const pane = $('.view-history');
  const lane = state.lane;
  const { versions } = await api('GET', `/api/drafts/${state.cur.draft.id}/history/${lane}`);
  if (state.lane !== lane) return;
  const current = htmlToText(docHtml());
  const canRestore = state.cur.lanes[lane]?.editable || (lane === 'final' && canUploadMe());
  pane.innerHTML = versions.map((v, i) => `
    <div class="version">
      <button type="button"><i class="dot" style="--c:${v.author_color || '#777'}"></i><span class="v-main"><span class="v-note">${esc(v.note || 'Edit')}${i === 0 ? ' · current' : ''}</span><span class="v-by">${esc(v.author || '—')} · ${words(v.content)} words</span></span><span class="v-when">${ago(v.updated_at)}</span></button>
      <div class="v-diff">${i === 0 ? esc(htmlToText(v.content)) : diffHtml(htmlToText(v.content), current)}</div>
      ${i > 0 && canRestore ? `<button class="hold inline" data-act="restore" data-version="${v.id}">Hold to restore</button>` : ''}
    </div>`).join('') || '<p class="none">No history.</p>';
}
$('.view-history').addEventListener('click', (e) => {
  const head = e.target.closest('.version > button');
  if (head) head.parentElement.classList.toggle('open');
});

// ---------- editing & autosave ----------
editor().addEventListener('input', () => {
  const lane = state.lane;
  if (!state.cur?.lanes[lane]?.editable) return;
  state.dirty = true;
  setDocState('Editing…');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(save, AUTOSAVE_MS);
  const t = Date.now();
  if (t - state.lastTyping > 2000) {
    state.lastTyping = t;
    api('POST', `/api/drafts/${state.cur.draft.id}/typing`, { lane }).catch(() => {});
  }
});
editor().addEventListener('blur', () => save());

async function save() {
  clearTimeout(state.saveTimer);
  if (!state.dirty || !state.cur || !state.lane) return;
  const draftId = state.cur.draft.id, lane = state.lane;
  const content = docHtml();
  setDocState('Saving…');
  try {
    const r = await api('PUT', `/api/drafts/${draftId}/lanes/${lane}`, { content });
    if (state.cur?.draft.id !== draftId) return;
    state.cur.lanes[lane] = r.lane;
    state.loaded = r.lane.content;
    if (state.lane === lane && docHtml() === content) { state.dirty = false; idleState(); }
    renderDesk();
    if (state.lane === lane) {
      $('#tabChanges').textContent = r.lane.pending || '';
      renderActions();
      if (state.view === 'changes') renderChanges();
    }
  } catch (err) {
    setDocState(`Not saved — ${err.message}. Retrying…`);
    state.saveTimer = setTimeout(save, 3000);
  }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
window.addEventListener('beforeunload', () => {
  if (state.dirty && state.cur && state.lane)
    fetch(`/api/drafts/${state.cur.draft.id}/lanes/${state.lane}`, { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: docHtml() }) });
});

// ---------- Save as Word ----------
// Save as Word / Save as PDF — saves first, so the file always matches the screen
// On phones the file goes to the phone's own share sheet (Save to Files, WhatsApp, email…), which is
// the dependable way to hand over a file there; on computers it downloads as usual.
$$('[data-export]').forEach((btn) => btn.addEventListener('click', async () => {
  if (btn.classList.contains('busy')) return;
  const format = btn.dataset.export, kind = format === 'pdf' ? 'PDF' : 'Word';
  const label = btn.lastChild.textContent;
  btn.classList.add('busy');
  btn.lastChild.textContent = 'Preparing…';
  try {
    await save();
    const res = await fetch(`/api/drafts/${state.cur.draft.id}/lanes/${state.lane}/${format}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `The ${kind} file couldn't be made — please try again`);
    const blob = await res.blob();
    const name = decodeURIComponent((res.headers.get('Content-Disposition') || '').match(/filename\*=UTF-8''([^;]+)/)?.[1] || `draft.${format}`);
    const file = new File([blob], name, { type: blob.type });
    if (matchMedia('(hover: none)').matches && navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); confirmDone(`${kind} file ready`); return; }
      catch (e) { if (e.name === 'AbortError') return; } // closed the share sheet; otherwise fall back to a download
    }
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    confirmDone(`Downloaded ${kind} file`);
    setDocState(`Saved ${name}`);
  } catch (err) {
    ledger(err.message);
    confirmDone(err.message.length < 60 ? err.message : `Couldn't make the ${kind} file`);
  } finally {
    btn.classList.remove('busy');
    btn.lastChild.textContent = label;
  }
}));

// ---------- hold-to-confirm ----------
document.addEventListener('contextmenu', (e) => { if (e.target.closest('.hold')) e.preventDefault(); });
document.addEventListener('pointerdown', (e) => {
  const btn = e.target.closest('.hold');
  if (!btn || btn.disabled) return;
  btn.classList.add('holding');
  const timer = setTimeout(() => { cancel(); runAction(btn); }, HOLD_MS);
  const cancel = () => {
    clearTimeout(timer);
    btn.classList.remove('holding');
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.removeEventListener(ev, cancel));
  };
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, cancel));
});
async function runAction(btn) {
  const id = state.cur.draft.id, lane = state.lane, act = btn.dataset.act;
  try {
    await save();
    if (act === 'accept-all' || act === 'reject-all') return resolveChange('all', act === 'accept-all' ? 'accept' : 'reject');
    const headName = state.cur.head?.name || 'the Team Head';
    if (act === 'promote-team') {
      const r = await api('POST', `/api/drafts/${id}/promote`);
      const msg = r.requested ? `Request sent — ${headName} will upload it` : 'Uploaded to the clean draft';
      ledger(r.requested ? `Asked ${headName} to upload the team draft to the clean draft.` : 'The team draft was uploaded to the clean draft.');
      confirmDone(msg, { sound: !r.requested });
    } else if (act === 'to-client') {
      await api('POST', `/api/drafts/${id}/to-client`);
      ledger('The team draft was sent to the client draft.');
      confirmDone('Sent to the client draft', { sound: true });
    } else if (act === 'newdoc') {
      await api('POST', `/api/drafts/${id}/lanes/team/new-document`, { template: btn.dataset.template });
      state.newDoc = null;
      confirmDone('New document started');
      await refresh();
      if (state.lane) renderDoc({ force: true });
      return;
    } else if (act === 'req-approve') {
      await api('POST', `/api/drafts/${id}/requests/${btn.dataset.req}`, { decision: 'approve' });
      state.preview = null;
      state.view = 'text';
      ledger('The team draft was uploaded to the clean draft.');
      confirmDone('Uploaded to the clean draft', { sound: true });
    } else if (act === 'approve') {
      await api('PATCH', `/api/drafts/${id}`, { status: 'approved' });
      ledger('You approved the clean draft.');
    } else if (act === 'restore') {
      await api('POST', `/api/drafts/${id}/history/${lane}/${btn.dataset.version}/restore`);
      state.view = 'text';
      ledger(`An earlier version of the ${LANE[lane].lower} was restored.`);
    }
    await refresh();
    if (state.lane) renderDoc({ force: act === 'restore' });
  } catch (err) { ledger(err.message); }
}

// ---------- realtime ----------
function closeStream() { if (state.es) { state.es.close(); state.es = null; } }
function openStream(draftId) {
  closeStream();
  const es = new EventSource(`/api/events?draft=${draftId}`);
  state.es = es;
  es.onopen = () => $('.live').classList.remove('off');
  es.onerror = () => $('.live').classList.add('off');
  const on = (type, fn) => es.addEventListener(type, (e) => {
    const d = JSON.parse(e.data);
    if (state.cur?.draft.id === d.draftId) fn(d);
  });
  on('lane', (d) => {
    if (d.byId === state.me.id) return;
    const verb = { accept: 'confirmed changes on', reject: 'rejected changes on', promote: 'updated', publish: 'sent the clean draft to', restore: 'restored', edit: 'edited' }[d.kind] || 'edited';
    ledger(`${d.by} ${verb} the ${LANE[d.lane].lower} · ${clock(Date.now())}`);
    clearTimeout(state.typingTimer);
    if (state.lane === d.lane) $('#page').style.setProperty('--c', person(d.byId).color);
    refreshSoon();
  });
  on('comment-deleted', (d) => {
    state.cur.comments = state.cur.comments.filter((c) => c.id !== d.id);
    if (state.lane === d.lane) renderMargin();
  });
  on('comment', (d) => {
    addComment(d.comment);
    if (d.comment.author_id !== state.me.id) ledger(`${d.comment.author} left a remark on the ${LANE[d.lane].lower}.`);
  });
  on('typing', (d) => {
    if (state.lane !== d.lane || state.dirty) return;
    setDocState(`${d.user} is drafting…`);
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(idleState, 3500);
  });
  on('presence', (d) => { state.cur.presence = d.users; renderPresence(d.users); });
  on('draft', (d) => {
    if (d.by !== state.me.name) {
      const msg = { request: canUploadMe() ? `${d.by} sent a request for your approval.` : `${d.by} sent a request to the Team Head.`,
        approved: `${d.by} approved a request.`, declined: `${d.by} declined a request.`, withdrawn: `${d.by} withdrew a request.` }[d.kind];
      ledger(msg || `${d.by} updated the matter.`);
    }
    refreshSoon();
    loadDrafts();
  });
  on('deleted', async (d) => {
    if (state.lane) await closeDoc(true);
    if (d.doc && state.cur?.draft.matterId) { // just this document went: back to the matter's main draft
      await openMatter(state.cur.draft.matterId);
      return ledger(`${d.by} deleted that document.`);
    }
    await loadDrafts();
    state.drafts[0] ? openMatter(state.drafts[0].id) : showEmpty();
    ledger(`${d.by} closed that matter.`);
  });
}

setInterval(() => { if (state.lane && !state.dirty) idleState(); }, 30000);

// ---------- drag & drop a Word or PDF file onto a sheet to load it there ----------
async function convertFile(file) {
  if (file.size > 25 * 1024 * 1024) throw new Error('Files must be under 25 MB');
  const res = await fetch('/api/convert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'That file could not be imported');
  return data;
}
// why a sheet can't take a file (null = it can)
function dropBlocked(lane) {
  const info = state.cur?.lanes[lane];
  if (!info) return 'This draft is sealed';
  if (lane === 'final') return 'The clean draft only comes from the team draft';
  if (!info.editable) return "You can't edit this draft";
  return null;
}
async function importInto(lane, file) {
  const blocked = dropBlocked(lane);
  if (blocked) return ledger(`${blocked}.`);
  const card = $(`.card[data-lane="${lane}"]`);
  card.classList.add('busy');
  ledger(`Reading ${file.name}…`);
  try {
    await save();
    const { html, page } = await convertFile(file);
    const r = await api('PUT', `/api/drafts/${state.cur.draft.id}/lanes/${lane}`, { content: html, note: `Imported ${file.name}`, page });
    if (page) state.cur.draft.page = page; // Word's page size & margins
    state.cur.lanes[lane] = r.lane;
    renderDesk();
    ledger(`${file.name} loaded into the ${LANE[lane].lower}${canConfirmMe() ? '' : ` — awaiting ${state.cur.head?.name || 'the Team Head'}'s confirmation`}. Edit away.`);
    if (state.lane === lane) { state.dirty = false; renderDoc({ force: true }); }
    else { history.pushState(null, '', `#${lane}`); openDoc(lane); } // straight into the document to edit it
  } catch (err) { ledger(err.message); }
  finally { card.classList.remove('busy'); }
}
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
// a stray drop anywhere else must never navigate away from the app
['dragover', 'drop'].forEach((t) => window.addEventListener(t, (e) => { if (hasFiles(e)) e.preventDefault(); }));

$$('.card').forEach((card) => {
  const lane = card.dataset.lane;
  const label = $('.card-drop', card);
  const clear = () => card.classList.remove('drop-over', 'drop-no');
  card.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const blocked = dropBlocked(lane);
    label.textContent = blocked || 'Drop to load here';
    card.classList.add(blocked ? 'drop-no' : 'drop-over');
  });
  card.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = dropBlocked(lane) ? 'none' : 'copy'; } });
  card.addEventListener('dragleave', (e) => { if (!card.contains(e.relatedTarget)) clear(); });
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    clear();
    const file = e.dataTransfer.files[0];
    if (file) importInto(lane, file);
  });
});

// …or onto the open document itself
const page = $('#page');
page.addEventListener('dragenter', (e) => { if (hasFiles(e) && state.lane && !dropBlocked(state.lane)) { e.preventDefault(); page.classList.add('drop-over'); } });
page.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = state.lane && !dropBlocked(state.lane) ? 'copy' : 'none'; } });
page.addEventListener('dragleave', (e) => { if (!page.contains(e.relatedTarget)) page.classList.remove('drop-over'); });
page.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  page.classList.remove('drop-over');
  const file = e.dataTransfer.files[0];
  if (file && state.lane) importInto(state.lane, file);
});

// ---------- the matter's date (set by the legal team from the header) ----------
$('#matterDate').addEventListener('change', async (e) => {
  if (!state.cur || state.me.role !== 'team') return;
  try {
    await api('PATCH', `/api/drafts/${state.cur.draft.id}`, { matterDate: e.target.value });
    state.cur.draft.matter_date = e.target.value || null;
    const d = state.drafts.find((x) => x.id === (state.cur.draft.matterId ?? state.cur.draft.id));
    if (d) d.matter_date = state.cur.draft.matter_date;
    renderDesk();
    renderMatters();
    ledger(e.target.value ? `Matter date set to ${fmtMatterDate(e.target.value)}.` : 'Matter date cleared.');
  } catch (err) { ledger(err.message); }
});
// clicking anywhere on the date opens the date picker
$('.mdate').addEventListener('click', (e) => {
  const input = $('#matterDate');
  if (input.disabled || e.target === input) return;
  try { input.showPicker(); } catch { input.focus(); }
});

// Esc backs out of the "Delete this matter?" question, wherever the focus is
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.confirmDel) { e.preventDefault(); state.confirmDel = null; renderMatters(); }
});

// count this visit for the owner dashboard (anonymous; see /api/hit)
fetch('/api/hit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: location.pathname }) }).catch(() => {});

// ---------- phones: the sidebar folds into a top bar with a Matters menu ----------
const rail = $('.rail');
function setRailOpen(open) {
  rail.classList.toggle('open', open);
  $('#railMenu').setAttribute('aria-expanded', String(open));
  $('#railMenu i').textContent = open ? '✕' : '☰';
}
$('#railMenu').addEventListener('click', () => setRailOpen(!rail.classList.contains('open')));
// picking a matter (or opening one) closes the menu again
$('#matterList').addEventListener('click', (e) => { if (e.target.closest('.matter:not(.confirm-del)') && !e.target.closest('[data-del]')) setRailOpen(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && rail.classList.contains('open') && window.innerWidth < 760) setRailOpen(false); });

// a Word paste into an empty document brings Word's page size and margins (see wordpaste.js)
async function applyPastedPage(page) {
  if (!state.cur || !state.lane) return;
  const lane = state.lane;
  clearTimeout(state.saveTimer);
  try {
    const r = await api('PUT', `/api/drafts/${state.cur.draft.id}/lanes/${lane}`, { content: docHtml(), note: 'Pasted from Word', page });
    state.cur.draft.page = page;
    state.cur.lanes[lane] = r.lane;
    state.dirty = false;
    applyZoom();
    layoutPages();
    ledger('Pasted from Word — with Word’s page size and margins.');
  } catch (err) { ledger(err.message); }
}
