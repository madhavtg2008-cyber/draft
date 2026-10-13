// ================= Zoit — the Team panel =================
// Everyone on the legal team can see who's on it. The Team Head adds lawyers by email,
// sets what each associate may do, and can remove people. Clients never see any of this.

const teamPanel = $('#teamPanel');
let teamList = [];

async function loadTeam() {
  if (state.me?.role !== 'team') return;
  try { teamList = (await api('GET', '/api/team')).team; } catch { teamList = []; }
  $('#teamCount').textContent = teamList.length || '';
  if (!teamPanel.classList.contains('hidden')) renderTeam();
}

function renderTeam() {
  const head = isHead();
  $('#tpAdd').classList.toggle('hidden', !head);
  const firm = state.me.firm;
  teamPanel.querySelector('.tp-kicker').textContent = firm ? `${firm.name} · ${teamList.length} of ${firm.seats} lawyers` : 'Your firm';
  const toggle = (u, key, label, hint) => `
    <label class="tp-perm" title="${hint}">
      <input type="checkbox" data-perm="${key}" data-uid="${u.id}" ${u[key] ? 'checked' : ''} ${head ? '' : 'disabled'} />
      <span class="tp-switch"></span>${label}
    </label>`;
  $('#tpList').innerHTML = teamList.map((u) => `
    <div class="tp-person">
      <div class="tp-top">
        <span class="avatar" style="--c:${u.color}">${initials(u.name)}</span>
        <div class="tp-who"><b>${esc(u.name)}${u.id === state.me.id ? ' <small>(you)</small>' : ''}</b><small>${esc(u.email)}</small></div>
        <span class="tp-role">${u.head ? 'Team Head' : u.active ? 'Associate' : 'Invited'}</span>
      </div>
      ${u.head ? '<p class="tp-note">Can do everything.</p>' : `
      <div class="tp-perms">
        ${toggle(u, 'perm_upload', 'Upload to the clean draft', 'Upload the team draft to the clean draft without asking the Team Head')}
        ${toggle(u, 'perm_confirm', 'Confirm changes', "Confirm or reject other people's edits; their own edits need no confirming")}
      </div>
      ${head ? `<button class="tp-remove" data-remove="${u.id}">Remove from team</button>` : ''}`}
    </div>`).join('') || '<p class="tp-note">No one yet.</p>';
}

function openTeam() {
  teamPanel.classList.remove('hidden');
  $('#teamBtn').classList.add('on');
  renderTeam();
  loadTeam();
  if (isHead()) $('#tpAdd').elements.name.focus();
}
function closeTeam() {
  teamPanel.classList.add('hidden');
  $('#teamBtn').classList.remove('on');
  $('#tpMsg').textContent = '';
}
$('#teamBtn').addEventListener('click', (e) => { e.stopPropagation(); teamPanel.classList.contains('hidden') ? openTeam() : closeTeam(); });
$('#tpClose').addEventListener('click', closeTeam);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !teamPanel.classList.contains('hidden')) { e.preventDefault(); closeTeam(); } });
document.addEventListener('mousedown', (e) => {
  if (!teamPanel.classList.contains('hidden') && !e.target.closest('#teamPanel') && !e.target.closest('#teamBtn')) closeTeam();
});

// add a lawyer by email
$('#tpAdd').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  try {
    await api('POST', '/api/team', { name: f.name.value, email: f.email.value });
    $('#tpMsg').textContent = `Added. ${f.name.value} gets an email (once email is set up) and sets a password with "Set up account" on the sign-in page.`;
    e.target.reset();
    loadTeam();
  } catch (err) { $('#tpMsg').textContent = err.message; }
});

// permissions (Team Head only)
$('#tpList').addEventListener('change', async (e) => {
  const box = e.target.closest('[data-perm]');
  if (!box) return;
  try {
    await api('PATCH', `/api/team/${box.dataset.uid}`, { [box.dataset.perm]: box.checked });
    const u = teamList.find((x) => x.id === Number(box.dataset.uid));
    if (u) u[box.dataset.perm] = box.checked ? 1 : 0;
    ledger(`${u?.name || 'Associate'} ${box.checked ? 'may now' : 'may no longer'} ${box.dataset.perm === 'perm_upload' ? 'upload to the clean draft' : 'confirm changes'}.`);
  } catch (err) { box.checked = !box.checked; ledger(err.message); }
});

// remove from team — asks first
$('#tpList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-remove]');
  if (!b) return;
  if (!b.classList.contains('armed')) {
    b.classList.add('armed');
    b.textContent = 'Click again to remove';
    setTimeout(() => { b.classList.remove('armed'); b.textContent = 'Remove from team'; }, 3500);
    return;
  }
  try {
    await api('DELETE', `/api/team/${b.dataset.remove}`);
    ledger('Removed from the team. They can no longer sign in.');
    loadTeam();
  } catch (err) { ledger(err.message); }
});

// keep the count fresh when the app opens
new MutationObserver(() => { if (!$('#app').classList.contains('hidden')) loadTeam(); })
  .observe($('#app'), { attributes: true, attributeFilter: ['class'] });
