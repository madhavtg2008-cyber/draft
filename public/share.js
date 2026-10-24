// ================= Zoit — sharing, joining by link, Google/Apple sign-in, templates =================
// Loaded after app.js, editor.js and pages.js; shares their globals.

// ---------- joining a matter from a shared link: just a name, no password ----------
let joinToken = null;
async function showJoin(token) {
  joinToken = token;
  $('#auth').classList.add('hidden');
  $('#app').classList.add('hidden');
  $('#join').classList.remove('hidden');
  try {
    const info = await api('GET', `/api/join/${encodeURIComponent(token)}`);
    $('#joinBy').textContent = info.invitedBy ? `${info.invitedBy} has invited you to` : "You've been invited to";
    $('#joinTitle').textContent = info.matter.title;
    $('#joinSub').textContent = `${info.matter.matter_no}  ·  for ${info.email}`;
    $('#joinForm').elements.name.value = ''; // they must know their own name — nothing is pre-filled
    $('#joinForm').elements.name.focus();
  } catch (err) {
    $('#joinTitle').textContent = 'Link not valid';
    $('#joinForm').classList.add('hidden');
    $('#joinError').textContent = err.message;
  }
}
$('#joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { user, draftId } = await api('POST', `/api/join/${encodeURIComponent(joinToken)}`, { name: e.target.elements.name.value });
    state.me = user;
    lsSet('lex_last', draftId);
    history.replaceState(null, '', '/');
    $('#join').classList.add('hidden');
    await showApp();
    history.pushState(null, '', '#final'); // straight to the clean draft
    openDoc('final');
  } catch (err) { $('#joinError').textContent = err.message; }
});

// ---------- sign in with Google / Apple (switched on by the site's settings) ----------
let authConfig = null;
const loadScript = (src) => new Promise((resolve, reject) => {
  if ([...document.scripts].some((s) => s.src === src)) return resolve();
  const s = document.createElement('script');
  s.src = src; s.async = true; s.onload = resolve; s.onerror = reject;
  document.head.appendChild(s);
});
async function socialSignedIn(url, body) {
  try {
    const r = await api('POST', url, body);
    if (r.choose) return startChoose(r); // new here: client or law firm? (plans.js)
    state.me = r.user;
    clearTimeout(typeTimer);
    await showApp();
  } catch (err) { $('#authError').textContent = err.message; }
}
async function setupSocial() {
  if (authConfig) return;
  try { authConfig = await api('GET', '/api/auth/config'); } catch { authConfig = {}; }
  $('.demo').classList.toggle('hidden', !authConfig.demo); // demo buttons only when running locally
  $('#appleBtn').classList.toggle('hidden', !authConfig.apple); // Apple's button shows only once it's set up
  if (authConfig.google) {
    try {
      await loadScript('https://accounts.google.com/gsi/client');
      google.accounts.id.initialize({ client_id: authConfig.google, callback: (r) => socialSignedIn('/api/auth/google', { credential: r.credential }) });
      google.accounts.id.renderButton($('#googleSlot'), { theme: 'filled_black', size: 'large', width: 380, text: 'continue_with', shape: 'rectangular' });
      $('#googleBtn').classList.add('hidden'); // Google's own button replaces ours
    } catch { /* fall back to the plain button's message */ }
  }
  if (authConfig.apple) {
    try {
      await loadScript('https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js');
      AppleID.auth.init({ clientId: authConfig.apple.clientId, scope: 'name email', redirectURI: authConfig.apple.redirectURI || location.origin, usePopup: true });
    } catch { /* message below */ }
  }
}
$('#googleBtn').addEventListener('click', () => {
  $('#authError').textContent = authConfig?.google ? 'Google sign-in could not load — check your connection.'
    : 'Google sign-in isn’t switched on yet. The site owner needs to add a Google Client ID (GOOGLE_CLIENT_ID).';
});
$('#appleBtn').addEventListener('click', async () => {
  if (!authConfig?.apple || !window.AppleID) {
    $('#authError').textContent = 'Apple sign-in isn’t switched on yet. The site owner needs to add an Apple Services ID (APPLE_CLIENT_ID) on an https address.';
    return;
  }
  try {
    const r = await AppleID.auth.signIn();
    const n = r.user?.name;
    socialSignedIn('/api/auth/apple', { id_token: r.authorization.id_token, name: n ? `${n.firstName || ''} ${n.lastName || ''}`.trim() : '' });
  } catch { /* closed the Apple window */ }
});
// set the buttons up whenever the sign-in page is shown
new MutationObserver(() => { if (!$('#auth').classList.contains('hidden')) setupSocial(); })
  .observe($('#auth'), { attributes: true, attributeFilter: ['class'] });
if (!$('#auth').classList.contains('hidden')) setupSocial();

// ---------- templates (new matters, and new documents in the team draft) ----------
async function loadTemplates() {
  if (state.templates || state.me?.role !== 'team') return;
  try { state.templates = (await api('GET', '/api/templates')).templates; } catch { state.templates = []; }
  const opts = state.templates.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  $('#nfTemplate').innerHTML = opts;
  $('#docTemplate').innerHTML = opts;
}
$('#newToggle').addEventListener('click', loadTemplates);
new MutationObserver(() => { if (!$('#app').classList.contains('hidden')) loadTemplates(); })
  .observe($('#app'), { attributes: true, attributeFilter: ['class'] });
// ---------- share matter: who can see it, and private links for clients ----------
const sharePanel = $('#sharePanel');
async function renderShareList() {
  const { people, always } = await api('GET', `/api/drafts/${state.cur.draft.id}/access`);
  $('#shareList').innerHTML = [
    ...always.map((u) => `<div class="sp-person"><span class="who-name">${esc(u.name)} <small>${esc(u.email)}</small></span><span class="tag">${u.head ? 'Team Head' : 'Opened it'}</span></div>`),
    ...people.map((p) => `<div class="sp-person"><span class="who-name">${esc(p.name || p.email)} <small>${p.name ? esc(p.email) : ''}</small></span>
      <span class="tag">${p.role === 'team' ? 'Team' : p.active ? 'Client' : 'Client · invited'}</span>
      ${p.role === 'team' ? '' : `<button class="cp" data-cp="${esc(p.email)}" title="Copy a private link for them">Copy link</button>`}
      <button class="rm" data-rm="${esc(p.email)}" title="Stop sharing">Remove</button></div>`),
  ].join('') || '<p class="sp-note">Nobody yet.</p>';
}
$('#shareBtn').addEventListener('click', async (e) => {
  e.stopPropagation();
  const open = sharePanel.classList.toggle('hidden') === false;
  $('#shareBtn').classList.toggle('on', open);
  if (open) {
    $('#shareResult').classList.add('hidden');
    $('#shareForm').reset();
    $('#shareForm').elements.email.focus();
    renderShareList().catch((err) => { $('#shareList').innerHTML = `<p class="sp-note">${esc(err.message)}</p>`; });
  }
});
document.addEventListener('mousedown', (e) => {
  if (!sharePanel.classList.contains('hidden') && !e.target.closest('.share')) { sharePanel.classList.add('hidden'); $('#shareBtn').classList.remove('on'); }
});
$('#shareForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements, box = $('#shareResult');
  try {
    const r = await api('POST', `/api/drafts/${state.cur.draft.id}/share`, { email: f.email.value, name: f.name.value });
    box.classList.remove('hidden');
    if (r.team) box.innerHTML = `<b>${esc(f.email.value)}</b> is on the legal team — they'll see this matter when they sign in.`;
    else {
      box.innerHTML = `${r.emailed ? `Emailed a private link to <b>${esc(f.email.value)}</b>.`
        : `Email isn't set up yet, so nothing was sent (a copy is in the <b>outbox</b> folder). Copy the link and send it to <b>${esc(f.email.value)}</b> yourself.`}
        <div class="row"><input readonly value="${esc(r.link)}" /><button type="button" data-copy>Copy</button></div>`;
    }
    confirmDone(r.team ? 'Shared with your colleague' : 'Matter shared');
    e.target.reset();
    renderShareList();
  } catch (err) {
    box.classList.remove('hidden');
    box.textContent = err.message;
  }
});
$('#shareResult').addEventListener('click', async (e) => {
  if (!e.target.closest('[data-copy]')) return;
  const input = $('#shareResult input');
  try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); }
  e.target.textContent = 'Copied';
  setTimeout(() => { e.target.textContent = 'Copy'; }, 1500);
});
$('#shareList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-rm]');
  if (!b) return;
  if (!b.classList.contains('armed')) { // click twice to confirm
    b.classList.add('armed'); b.textContent = 'Confirm';
    setTimeout(() => { b.classList.remove('armed'); b.textContent = 'Remove'; }, 3000);
    return;
  }
  try {
    await api('DELETE', `/api/drafts/${state.cur.draft.id}/access/${encodeURIComponent(b.dataset.rm)}`);
    renderShareList();
    ledger(`Stopped sharing with ${b.dataset.rm}.`);
  } catch (err) { ledger(err.message); }
});

// ---------- New document: a new matter that opens straight onto a fresh document ----------
const docForm = $('#docForm');
function closeDocForm() { docForm.reset(); $('#docError').textContent = ''; docForm.classList.add('hidden'); $('#docToggle').classList.remove('hidden'); }
$('#docToggle').addEventListener('click', async () => {
  await loadTemplates();
  if (typeof closeNewForm === 'function' && !$('#newForm').classList.contains('hidden')) closeNewForm(); // one form at a time
  $('#docToggle').classList.add('hidden');
  docForm.classList.remove('hidden');
  $('#docTemplate').value = 'blank';
  // with a matter open, the document goes into that matter; otherwise it starts a new matter
  const inMatter = !!state.cur;
  $('#docFormLabel').textContent = inMatter ? `New document in “${state.cur.draft.title}”` : 'New document';
  $('#docFolder').classList.toggle('hidden', !inMatter);
  docForm.elements.title.focus();
});
$('#docCancel').addEventListener('click', closeDocForm);
docForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = docForm.elements;
  try {
    let openId;
    if (state.cur) { // a further document inside the open matter
      const r = await api('POST', `/api/drafts/${state.cur.draft.id}/documents`, { name: f.title.value, folder: f.folder.value, template: f.template.value });
      openId = r.document.id;
    } else {
      openId = (await api('POST', '/api/drafts', { title: f.title.value, template: f.template.value })).draft.id;
    }
    closeDocForm();
    await loadDrafts();
    await openMatter(openId);
    history.pushState(null, '', '#team'); // write it in the team draft (the clean draft is uploaded from there)
    await openDoc('team');
    confirmDone('New document created');
    setTimeout(() => { const ed = editor(); ed.focus(); const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); }, 300);
  } catch (err) { $('#docError').textContent = err.message; }
});
$('#newToggle').addEventListener('click', () => { if (!docForm.classList.contains('hidden')) closeDocForm(); });

// Esc leaves the New matter / New document forms
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#newForm').classList.contains('hidden')) { e.preventDefault(); closeNewForm(); }
  if (!docForm.classList.contains('hidden')) { e.preventDefault(); closeDocForm(); }
  if (!$('#profileMenu').classList.contains('hidden')) closeProfile();
});

// ---------- profile menu: who you are, theme, sign out ----------
const THEMES = ['black', 'white', 'navy', 'oxblood', 'emerald'];
function applyTheme(name) {
  const t = THEMES.includes(name) ? name : 'black';
  document.documentElement.dataset.theme = t;
  lsSet('lex_theme', t);
  $$('.theme-opt').forEach((b) => b.classList.toggle('on', b.dataset.theme === t));
  const on = $(`.theme-opt[data-theme="${t}"]`);
  $('#pmThemeName').textContent = on ? $('span', on).textContent : '';
  $('.pm-dot').style.cssText = on ? on.getAttribute('style') : '';
}
applyTheme(lsGet('lex_theme') || 'black');
function closeProfile() { $('#profileMenu').classList.add('hidden'); $('#profileBtn').classList.remove('on'); showProfilePage('main'); }
// the menu has two pages: the main one, and the theme picker behind "Theme ›"
function showProfilePage(page) {
  $('#pmMain').classList.toggle('hidden', page !== 'main');
  $('#pmThemes').classList.toggle('hidden', page !== 'themes');
}
$('#pmTheme').addEventListener('click', () => showProfilePage('themes'));
$('#pmBack').addEventListener('click', () => showProfilePage('main'));
function fillProfile() {
  const me = state.me;
  if (!me) return;
  $('#profileBtn').textContent = initials(me.name);
  $('#profileBtn').style.setProperty('--c', me.color);
  $('#pmName').textContent = me.name;
  $('#pmSub').textContent = `${me.email} · ${me.role === 'team' ? (me.title || 'Legal team') : 'Client'}`;
  $('#pmAdmin').classList.toggle('hidden', !me.owner); // only the site owner
  if (me.firm) {
    $('#pmFirm').textContent = me.firm.name;
    $('#pmPlanName').textContent = `${me.firm.planName} · ₹${me.firm.total.toLocaleString('en-IN')}/${me.firm.cycle} ›`;
  }
}
new MutationObserver(fillProfile).observe($('#app'), { attributes: true, attributeFilter: ['class'] });
$('#profileBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  fillProfile();
  const open = $('#profileMenu').classList.toggle('hidden') === false;
  $('#profileBtn').classList.toggle('on', open);
});
document.addEventListener('mousedown', (e) => { if (!e.target.closest('.profile') && !e.target.closest('.tour-card')) closeProfile(); });
$$('.theme-opt').forEach((b) => b.addEventListener('click', () => applyTheme(b.dataset.theme)));
$('#pmOut').addEventListener('click', () => { closeProfile(); $('#logoutBtn').click(); });

// ---------- Copy link: share without emailing, and copy the private link ----------
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const t = Object.assign(document.createElement('textarea'), { value: text });
    document.body.appendChild(t); t.select();
    const ok = document.execCommand('copy'); t.remove();
    return ok;
  }
}
async function copyLinkFor(email, name) {
  const r = await api('POST', `/api/drafts/${state.cur.draft.id}/share`, { email, name, notify: false });
  if (r.team) return { team: true };
  return { link: r.link, copied: await copyText(r.link) };
}
$('#shareCopy').addEventListener('click', async () => {
  const f = $('#shareForm').elements, box = $('#shareResult');
  if (!f.email.value.trim()) { f.email.focus(); return f.email.reportValidity(); }
  if (!f.email.checkValidity()) return f.email.reportValidity();
  try {
    const email = f.email.value.trim();
    const r = await copyLinkFor(email, f.name.value);
    box.classList.remove('hidden');
    box.innerHTML = r.team ? `<b>${esc(email)}</b> is on the legal team — they'll see this matter when they sign in.`
      : `${r.copied ? 'Link copied' : 'Link ready'} — paste it to <b>${esc(email)}</b> (WhatsApp, email, anywhere). No email was sent.
        <div class="row"><input readonly value="${esc(r.link)}" /><button type="button" data-copy>Copy</button></div>`;
    confirmDone(r.team ? 'Shared with your colleague' : 'Link copied');
    $('#shareForm').reset();
    renderShareList();
  } catch (err) { box.classList.remove('hidden'); box.textContent = err.message; }
});
$('#shareList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-cp]');
  if (!b) return;
  try {
    const r = await copyLinkFor(b.dataset.cp);
    b.textContent = r.copied ? 'Copied' : 'Ready';
    if (!r.copied) { const box = $('#shareResult'); box.classList.remove('hidden'); box.innerHTML = `Link for <b>${esc(b.dataset.cp)}</b>:<div class="row"><input readonly value="${esc(r.link)}" /><button type="button" data-copy>Copy</button></div>`; }
    setTimeout(() => { b.textContent = 'Copy link'; }, 1600);
  } catch (err) { ledger(err.message); }
});

// Esc closes the Share matter panel
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !sharePanel.classList.contains('hidden')) {
    e.preventDefault();
    sharePanel.classList.add('hidden');
    $('#shareBtn').classList.remove('on');
    $('#shareBtn').focus();
  }
});

// ---------- Edit details: name, other side, client, date, stage — and delete (with confirmation) ----------
const editPanel = $('#editPanel');
function closeEdit() {
  editPanel.classList.add('hidden');
  $('#editBtn').classList.remove('on');
  $('#epConfirm').classList.add('hidden');
  $('#epDelete').classList.remove('hidden');
  $('#epError').textContent = '';
}
async function openEdit() {
  const d = state.cur.draft, f = editPanel.elements;
  f.title.value = d.title;
  f.counterparty.value = d.counterparty || '';
  f.matterDate.value = d.matter_date || '';
  f.status.value = d.status;
  try {
    const { clients } = await api('GET', '/api/clients');
    $('#epClient').innerHTML = '<option value="">No client</option>'
      + clients.map((c) => `<option value="${c.id}">${esc(c.name)}${c.title ? ` · ${esc(c.title)}` : ''}</option>`).join('');
  } catch { $('#epClient').innerHTML = '<option value="">No client</option>'; }
  f.clientId.value = d.client_id ? String(d.client_id) : '';
  // only the Team Head or the lawyer who opened the matter may delete it
  $('.ep-danger').classList.remove('hidden'); // the legal team may delete (clients never see this panel)
  editPanel.classList.remove('hidden');
  $('#editBtn').classList.add('on');
  f.title.focus();
  f.title.select();
}
$('#editBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (editPanel.classList.contains('hidden')) openEdit(); else closeEdit();
});
$('#epCancel').addEventListener('click', closeEdit);
document.addEventListener('mousedown', (e) => { if (!editPanel.classList.contains('hidden') && !e.target.closest('.edit-wrap')) closeEdit(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !editPanel.classList.contains('hidden')) { e.preventDefault(); closeEdit(); } });
editPanel.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = editPanel.elements, d = state.cur.draft;
  const body = { title: f.title.value, counterparty: f.counterparty.value, matterDate: f.matterDate.value, clientId: f.clientId.value ? Number(f.clientId.value) : null };
  if (f.status.value !== d.status) body.status = f.status.value;
  try {
    await api('PATCH', `/api/drafts/${d.id}`, body);
    closeEdit();
    await loadDrafts();
    await refresh();
    confirmDone('Matter details saved');
  } catch (err) { $('#epError').textContent = err.message; }
});
// delete: first ask, then do it
$('#epDelete').addEventListener('click', () => {
  $('#epConfirmName').textContent = `“${state.cur.draft.title}”`;
  $('#epDelete').classList.add('hidden');
  $('#epConfirm').classList.remove('hidden');
});
$('#epNo').addEventListener('click', () => { $('#epConfirm').classList.add('hidden'); $('#epDelete').classList.remove('hidden'); });
$('#epYes').addEventListener('click', async () => {
  const d = state.cur.draft;
  try {
    await api('DELETE', `/api/drafts/${d.id}`);
    closeEdit();
    if (lsGet('lex_last') === String(d.id)) lsSet('lex_last', '');
    state.cur = null;
    await loadDrafts();
    state.drafts[0] ? await openMatter(state.drafts[0].id) : showEmpty();
    confirmDone(`Deleted “${d.title}”`);
  } catch (err) { $('#epError').textContent = err.message; }
});

