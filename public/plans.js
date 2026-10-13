// ================= Zoit — "client or law firm?" and the firm's plan =================

// ---------- the client / law firm choice (email sign-up, and after Google or Apple) ----------
function syncKind(form) {
  const firm = form.elements.kind.value === 'firm';
  form.querySelectorAll('.for-firm').forEach((el) => el.classList.toggle('hidden', !firm));
  form.querySelectorAll('.for-client').forEach((el) => el.classList.toggle('hidden', firm));
  if (form.elements.firmName) form.elements.firmName.required = firm;
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

// ---------- the plan panel ----------
const planPanel = $('#planPanel');
let planInfo = null;
const money = (p) => `${planInfo.currency}${p.price}${p.price ? '<small> / month</small>' : ''}`;

function renderPlans() {
  const firm = state.me?.firm;
  if (!firm || !planInfo) return;
  const head = isHead();
  $('#plFirm').textContent = firm.name;
  $('#plUsage').innerHTML = `
    <div><b>${firm.seatsUsed}</b> of ${firm.seats} lawyers</div>
    <div><b>${firm.mattersUsed}</b>${firm.matters ? ` of ${firm.matters}` : ''} matters</div>`;
  const current = planInfo.plans.find((p) => p.id === firm.plan);
  $('#plList').innerHTML = planInfo.plans.map((p) => {
    const on = p.id === firm.plan;
    const verb = p.price > current.price ? 'Upgrade to' : 'Switch to';
    return `<div class="pl-card${on ? ' on' : ''}">
      <div class="pl-top"><span class="pl-name">${p.name}</span>${on ? '<span class="pl-tag">Current plan</span>' : ''}</div>
      <div class="pl-price">${money(p)}</div>
      <ul class="pl-points">
        <li>Up to ${p.seats} lawyers</li>
        <li>${p.matters ? `${p.matters} matters` : 'Unlimited matters'}</li>
        <li>Client, clean and team drafts</li>
        ${p.price ? '<li>Word &amp; PDF export, share links</li>' : ''}
      </ul>
      ${!on && head ? `<button class="pl-go" data-plan="${p.id}">${verb} ${p.name}</button>` : ''}
    </div>`;
  }).join('');
  $('#plMsg').textContent = head ? (planInfo.demo ? 'Demo: plan changes apply at once, nothing is charged.' : '') : 'Only the Team Head can change the plan.';
}
async function openPlans() {
  closeProfile();
  if (typeof closeTeam === 'function') closeTeam();
  planPanel.classList.remove('hidden');
  try {
    planInfo = planInfo || await api('GET', '/api/plans');
    state.me = (await api('GET', '/api/me')).user;
  } catch { /* show what we have */ }
  renderPlans();
}
function closePlans() { planPanel.classList.add('hidden'); $('#plMsg').textContent = ''; }
$('#pmPlan').addEventListener('click', openPlans);
$('#plClose').addEventListener('click', closePlans);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !planPanel.classList.contains('hidden')) { e.preventDefault(); closePlans(); } });
document.addEventListener('mousedown', (e) => {
  if (!planPanel.classList.contains('hidden') && !e.target.closest('#planPanel') && !e.target.closest('#pmPlan')) closePlans();
});
$('#plList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-plan]');
  if (!b) return;
  b.disabled = true;
  try {
    const r = await api('POST', '/api/firm/plan', { plan: b.dataset.plan });
    if (r.payUrl) { window.open(r.payUrl, '_blank', 'noopener'); $('#plMsg').textContent = 'Finish the payment in the new tab — your plan switches over once it is confirmed.'; b.disabled = false; return; }
    state.me = r.user;
    renderPlans();
    fillProfile();
    confirmDone(`You're on the ${planInfo.plans.find((p) => p.id === r.user.firm.plan).name} plan`);
  } catch (err) { $('#plMsg').textContent = err.message; b.disabled = false; }
});
