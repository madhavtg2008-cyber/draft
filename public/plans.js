// ================= Zoit — "client or law firm?" and the firm's plan =================

// ---------- the client / law firm choice (email sign-up, and after Google or Apple) ----------
function syncKind(form) {
  const kind = form.elements.kind.value; // client · firm (a new firm, or joining the firm that added this email)
  for (const k of ['client', 'firm']) form.querySelectorAll(`.for-${k}`).forEach((el) => el.classList.toggle('hidden', kind !== k));
  if (form.elements.firmName) form.elements.firmName.required = kind === 'firm';
}
['#registerForm', '#chooseForm'].forEach((sel) => {
  const form = $(sel);
  form.addEventListener('change', (e) => { if (e.target.name === 'kind') { syncKind(form); if (form.elements.kind.value === 'firm') form.elements.firmName.focus(); } });
  syncKind(form);
});

// someone new signed in with Google/Apple: ask who they are before creating the account
let chooseTicket = null;
const signInParts = ['.auth-switch', '#loginForm', '#registerForm', '.or', '.social', '.demo'];
function startChoose(r) {
  chooseTicket = r.ticket;
  $('#chooseName').textContent = r.name || r.email;
  signInParts.forEach((s) => $(s).classList.add('hidden'));
  $('#chooseForm').classList.remove('hidden');
  $('#authError').textContent = '';
  syncKind($('#chooseForm'));
}
function endChoose() {
  chooseTicket = null;
  $('#chooseForm').classList.add('hidden');
  ['.auth-switch', '#loginForm', '.or', '.social'].forEach((s) => $(s).classList.remove('hidden'));
  $$('.auth-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'login'));
  if (authConfig?.demo) $('.demo').classList.remove('hidden');
}
$('#chooseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  try {
    state.me = (await api('POST', '/api/auth/social-finish', { ticket: chooseTicket, kind: f.kind.value, firmName: f.firmName.value })).user;
    endChoose();
    clearTimeout(typeTimer);
    await showApp();
  } catch (err) { $('#authError').textContent = err.message; }
});
$('#chooseBack').addEventListener('click', endChoose);

// ---------- billing: the firm's plan and every lawyer's seat ----------
// Every lawyer, the Team Head included, has a paid seat. A Team Head whose own seat isn't paid sees
// this as a full screen ("Activate Zoit") until it is; associates get their invite once theirs is paid.
const planPanel = $('#planPanel');
let billing = null;
const rupees = (n) => `₹${Number(n).toLocaleString('en-IN')}`;

async function loadBilling() {
  try { billing = await api('GET', '/api/billing'); state.me = (await api('GET', '/api/me')).user; } catch { /* keep what we have */ }
}
function renderPlans() {
  if (!billing) return;
  const head = isHead(), f = billing.firm, gate = state.me?.seat === 'pending';
  planPanel.classList.toggle('gate', gate);
  $('#plFirm').textContent = f.name;
  $('#plTitle').textContent = gate ? 'Activate Zoit' : 'Billing';
  const plan = billing.plans.find((p) => p.id === f.plan);
  $('#plUsage').innerHTML = gate
    ? `<p class="pl-intro">Every lawyer at ${esc(f.name)} has their own seat. Choose a plan and pay for your seat to start using Zoit — then add your associates.</p>`
    : `<div><b>${f.activeSeats}</b> paid seat${f.activeSeats === 1 ? '' : 's'}</div>${f.pendingSeats ? `<div><b>${f.pendingSeats}</b> waiting for payment</div>` : ''}<div><b>${rupees(f.total)}</b> per ${plan.cycle}</div>`;
  // the four plans: Standard / Pro, monthly or yearly — each per lawyer
  const card = (p) => `<button class="pl-opt${p.id === f.plan ? ' on' : ''}" data-plan="${p.id}" ${head ? '' : 'disabled'}>
      <span class="pl-opt-name">${p.name} <small>${p.cycle === 'year' ? 'yearly' : 'monthly'}</small></span>
      <span class="pl-opt-price">${rupees(p.price)}<small> / lawyer / ${p.cycle}</small></span>
      ${p.cycle === 'year' ? `<span class="pl-save">${rupees(p.price / 12 | 0)} a month</span>` : ''}
    </button>`;
  const pro = billing.plans.find((p) => p.perks);
  const seats = billing.seats.map((x) => `<div class="pl-seat">
      <div><b>${esc(x.name)}${x.id === state.me.id ? ' <small>(you)</small>' : ''}</b><small>${x.head ? 'Team Head' : 'Associate'} · ${esc(x.email)}</small></div>
      ${x.status === 'active'
        ? `<span class="pl-state on">Active${x.until ? ` · until ${new Date(x.until).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}</span>`
        : head ? `<button class="pl-pay" data-pay="${x.id}">Pay ${rupees(plan.price)}${x.head ? '' : ' &amp; send invite'}</button>` : '<span class="pl-state">Waiting for payment</span>'}
    </div>`).join('');
  $('#plList').innerHTML = `
    <div class="pl-label">Plan <small>per lawyer</small></div>
    <div class="pl-opts">${billing.plans.map(card).join('')}</div>
    ${pro?.perks ? `<p class="pl-perks">Pro adds: ${pro.perks.join(' · ')}</p>` : ''}
    <div class="pl-label">${gate ? 'Your seat' : 'Seats'}</div>
    <div class="pl-seats">${gate ? seats.split('<div class="pl-seat">').filter((x) => x.includes('(you)')).map((x) => '<div class="pl-seat">' + x).join('') : seats}</div>
    ${gate ? '<button class="pl-out" id="plSignOut" type="button">Sign out</button>' : ''}`;
  $('#plMsg').textContent = head ? '' : 'Only the Team Head manages billing.';
}
async function openPlans() {
  closeProfile();
  if (typeof closeTeam === 'function') closeTeam();
  planPanel.classList.remove('hidden');
  await loadBilling();
  renderPlans();
}
function closePlans() {
  if (state.me?.seat === 'pending') return; // can't skip activation
  planPanel.classList.add('hidden'); $('#plMsg').textContent = '';
}
$('#pmPlan').addEventListener('click', openPlans);
$('#plClose').addEventListener('click', closePlans);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !planPanel.classList.contains('hidden')) { e.preventDefault(); closePlans(); } });
document.addEventListener('mousedown', (e) => {
  if (!planPanel.classList.contains('hidden') && !e.target.closest('#planPanel') && !e.target.closest('#pmPlan') && !e.target.closest('#tpList')) closePlans();
});
$('#plList').addEventListener('click', async (e) => {
  if (e.target.closest('#plSignOut')) return $('#logoutBtn').click();
  const opt = e.target.closest('[data-plan]');
  if (opt && !opt.classList.contains('on')) {
    try { await api('POST', '/api/billing/plan', { plan: opt.dataset.plan }); await loadBilling(); renderPlans(); fillProfile(); }
    catch (err) { $('#plMsg').textContent = err.message; }
    return;
  }
  const pay = e.target.closest('[data-pay]');
  if (pay) await payForSeats([Number(pay.dataset.pay)], pay);
});
// pay for one or more seats (also used from the Team panel)
async function payForSeats(ids, btn) {
  const wasGate = planPanel.classList.contains('gate');
  if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = 'Paying…'; }
  try {
    const r = await api('POST', '/api/billing/pay', { ids });
    state.me = r.user;
    await loadBilling();
    renderPlans();
    fillProfile();
    if (typeof loadTeam === 'function') loadTeam();
    confirmDone('Seat activated');
    if (wasGate && state.me.seat === 'active') location.reload(); // seat paid: into the app
  } catch (err) {
    $('#plMsg').textContent = err.message;
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label; }
  }
}
