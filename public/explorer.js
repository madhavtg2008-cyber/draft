// ================= Zoit — Clients: the firm's file explorer =================
// One "Clients" button opens a full page, like a drive:
//   Clients › a client › folders (inside folders, as deep as you like) › drafts
// · the folder tree on the left; breadcrumbs, search, New and the view switch on top
// · click to select, double-click to open (a folder goes in; a draft opens its three sheets)
// · select something for Open · Rename · Move to · Delete (deleting is the Team Head's alone)
// · drag a draft or folder onto a folder (here or in the tree) to move it
// · keys: Enter opens · F2 renames · Delete deletes · Backspace goes up · Esc lets go

const exEl = $('#explorer');
const ICON_CLIENT = '<svg class="ex-ico" viewBox="0 0 48 40" aria-hidden="true"><path d="M3 7a3 3 0 0 1 3-3h12.5l4 4.5H42a3 3 0 0 1 3 3V34a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z" fill="#5b6b8c"/><path d="M3 14h42v20a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z" fill="#7d8fb3"/><circle cx="24" cy="22.5" r="4.2" fill="#eef1f7"/><path d="M15.5 33.5c1.2-4.6 4.7-6.8 8.5-6.8s7.3 2.2 8.5 6.8z" fill="#eef1f7"/></svg>';
const ex = {
  data: { clients: [], folders: [], drafts: [] },
  loc: JSON.parse(lsGet('lex_ex_loc') || '{"root":true}'), // { root } | { clientId (0 = no client), folderId }
  view: lsGet('lex_ex_view') || 'grid',
  sort: lsGet('lex_ex_sort') || 'name',
  sel: null,          // 'c:3' · 'f:12' · 'd:40'
  q: '',
  open: new Set(JSON.parse(lsGet('lex_ex_tree') || '[]')),
  editing: null,      // an item being renamed, or 'new-folder' / 'new-client'
  confirm: null,      // an item waiting for "Delete?"
  moving: null,       // an item being moved (the "Move to" panel)
};

// ---------- data ----------
async function loadExplorer() {
  try { ex.data = await api('GET', '/api/explorer'); } catch (err) { ledger(err.message); }
  // a place that no longer exists: back to the nearest one that does
  if (ex.loc.folderId && !folderById(ex.loc.folderId)) ex.loc = { clientId: ex.loc.clientId };
  if (ex.loc.clientId && !ex.data.clients.some((c) => c.id === ex.loc.clientId)) ex.loc = { root: true };
  renderExplorer();
}
const folderById = (id) => ex.data.folders.find((f) => f.id === id);
const clientById = (id) => ex.data.clients.find((c) => c.id === id);
const cidOf = (x) => x.clientId || 0;
const hasNoClient = () => ex.data.drafts.some((d) => !d.clientId) || ex.data.folders.some((f) => !f.clientId);
// what's in a place
function itemsAt(loc) {
  if (loc.root) {
    const cl = ex.data.clients.map((c) => ({ kind: 'c', id: c.id, name: c.name, sub: c.title || '', updatedAt: c.created_at, ref: c }));
    if (hasNoClient()) cl.push({ kind: 'c', id: 0, name: 'No client', sub: 'Drafts not yet for a client', updatedAt: 0, ref: { id: 0 } });
    return cl;
  }
  const folders = ex.data.folders.filter((f) => cidOf(f) === loc.clientId && (f.parentId || null) === (loc.folderId || null))
    .map((f) => ({ kind: 'f', id: f.id, name: f.name, sub: countLabel(f.id), updatedAt: f.updatedAt, ref: f }));
  const drafts = ex.data.drafts.filter((d) => cidOf(d) === loc.clientId && ((d.folderId && folderById(d.folderId) ? d.folderId : null) === (loc.folderId || null)))
    .map((d) => ({ kind: 'd', id: d.id, name: d.title, sub: `${d.matterNo} · ${exStatusName(d.status)}`, updatedAt: d.updatedAt, ref: d }));
  return [...folders, ...drafts];
}
function countLabel(fid) {
  const f = ex.data.folders.filter((x) => x.parentId === fid).length, d = ex.data.drafts.filter((x) => x.folderId === fid).length;
  const parts = [f && `${f} folder${f > 1 ? 's' : ''}`, d && `${d} draft${d > 1 ? 's' : ''}`].filter(Boolean);
  return parts.join(' · ') || 'Empty';
}
const exStatusName = (s) => (STATUSES.find(([k]) => k === s) || [s, s])[1];
const sorted = (list) => {
  const by = ex.sort === 'modified' ? (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) : (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  // folders before drafts, as in a drive
  return [...list].sort((a, b) => (a.kind === 'd') - (b.kind === 'd') || by(a, b));
};
function pathOf(loc) {
  const out = [{ label: 'Clients', loc: { root: true } }];
  if (loc.root) return out;
  const c = loc.clientId ? clientById(loc.clientId) : null;
  out.push({ label: c ? c.name : 'No client', loc: { clientId: loc.clientId } });
  const chain = [];
  for (let f = loc.folderId ? folderById(loc.folderId) : null; f; f = f.parentId ? folderById(f.parentId) : null) chain.unshift(f);
  for (const f of chain) out.push({ label: f.name, loc: { clientId: loc.clientId, folderId: f.id } });
  return out;
}
const itemKey = (it) => `${it.kind}:${it.id}`;
const findItem = (key) => {
  if (!key) return null;
  const [kind, raw] = key.split(':'), id = Number(raw);
  if (kind === 'c') return id === 0 ? { kind, id: 0, name: 'No client', ref: { id: 0 } } : (clientById(id) && { kind, id, name: clientById(id).name, ref: clientById(id) });
  if (kind === 'f') return folderById(id) && { kind, id, name: folderById(id).name, ref: folderById(id) };
  const d = ex.data.drafts.find((x) => x.id === id);
  return d && { kind, id, name: d.title, ref: d };
};
// what this person may do with an item
const canChange = (it) => it && it.kind !== 'c' && (isHead() || !it.ref.headMade);
const canDelete = (it) => it && it.kind !== 'c' && isHead();

// ---------- showing and hiding ----------
function showExplorer(loc) {
  if (state.me?.role !== 'team') return;
  if (loc) setLoc(loc, false);
  exEl.classList.remove('hidden');
  $('#clientsBtn').classList.add('on');
  document.body.classList.add('ex-on');
  loadExplorer();
}
function hideExplorer() {
  exEl.classList.add('hidden');
  $('#clientsBtn').classList.remove('on');
  document.body.classList.remove('ex-on');
}
function setLoc(loc, render = true) {
  ex.loc = loc;
  ex.sel = null; ex.editing = null; ex.confirm = null; ex.q = '';
  $('#exSearch').value = '';
  lsSet('lex_ex_loc', JSON.stringify(loc));
  // the tree opens down to where you are
  if (!loc.root) {
    ex.open.add(`c:${loc.clientId}`);
    for (let f = loc.folderId ? folderById(loc.folderId) : null; f; f = f.parentId ? folderById(f.parentId) : null) ex.open.add(`f:${f.id}`);
    lsSet('lex_ex_tree', JSON.stringify([...ex.open]));
  }
  if (render) renderExplorer();
}
$('#clientsBtn').addEventListener('click', async () => {
  if (state.lane) await closeDoc(true);
  // from inside a draft, Clients opens where that draft lives
  const d = state.cur && ex.data.drafts.find((x) => x.id === (state.cur.draft.matterId ?? state.cur.draft.id));
  showExplorer(d && exEl.classList.contains('hidden') ? { clientId: cidOf(d), folderId: d.folderId && folderById(d.folderId) ? d.folderId : null } : undefined);
});

// ---------- drawing ----------
function renderExplorer() {
  if (exEl.classList.contains('hidden')) return;
  renderTree();
  const loc = ex.loc, path = pathOf(loc);
  $('#exCrumbs').innerHTML = path.map((p, i) => (i < path.length - 1
    ? `<button type="button" class="ex-crumb-btn" data-loc='${JSON.stringify(p.loc)}' data-drop-loc='${JSON.stringify(p.loc)}'>${esc(p.label)}</button><span class="ex-crumb-sep">›</span>`
    : `<b>${esc(p.label)}</b>`)).join('');
  $('#exUp').disabled = !!loc.root;
  // New: clients at the top; folders and drafts inside a client
  $('#exNewClient').classList.toggle('hidden', !loc.root);
  $('#exNewFolder').classList.toggle('hidden', !!loc.root);
  $('#exNewDraft').classList.toggle('hidden', !!loc.root);
  $('#exUpload').classList.toggle('hidden', !!loc.root);
  $$('[data-exview]').forEach((b) => b.classList.toggle('on', b.dataset.exview === ex.view));
  $('#exSort').value = ex.sort;

  const q = ex.q.trim().toLowerCase();
  let items, searching = !!q;
  if (searching) { // search everything, with where it lives
    items = [
      ...ex.data.clients.filter((c) => c.name.toLowerCase().includes(q)).map((c) => ({ kind: 'c', id: c.id, name: c.name, sub: 'Client', ref: c })),
      ...ex.data.folders.filter((f) => f.name.toLowerCase().includes(q)).map((f) => ({ kind: 'f', id: f.id, name: f.name, sub: pathOf({ clientId: cidOf(f), folderId: f.parentId }).slice(1).map((p) => p.label).join(' › '), updatedAt: f.updatedAt, ref: f })),
      ...ex.data.drafts.filter((d) => `${d.title} ${d.matterNo}`.toLowerCase().includes(q)).map((d) => ({ kind: 'd', id: d.id, name: d.title, sub: pathOf({ clientId: cidOf(d), folderId: d.folderId }).slice(1).map((p) => p.label).join(' › '), updatedAt: d.updatedAt, ref: d })),
    ];
  } else items = loc.root ? itemsAt(loc) : sorted(itemsAt(loc));

  const sel = findItem(ex.sel);
  // the bar for what's selected
  $('#exSelBar').classList.toggle('hidden', !sel || !!ex.confirm);
  if (sel) {
    $('#exSelName').textContent = sel.name;
    $('#exRename').classList.toggle('hidden', !canChange(sel));
    $('#exMove').classList.toggle('hidden', !canChange(sel));
    $('#exDelete').classList.toggle('hidden', !canDelete(sel));
  }
  // "Delete?" — what it takes with it
  const conf = findItem(ex.confirm);
  $('#exConfirm').classList.toggle('hidden', !conf);
  if (conf) {
    let what = '';
    if (conf.kind === 'f') {
      const tree = folderDescendants(conf.id), drafts = ex.data.drafts.filter((d) => tree.includes(d.folderId)).length;
      what = `the folder <b>${esc(conf.name)}</b>${tree.length > 1 || drafts ? ` and everything in it (${[tree.length - 1 && `${tree.length - 1} folder${tree.length > 2 ? 's' : ''}`, drafts && `${drafts} draft${drafts > 1 ? 's' : ''}`].filter(Boolean).join(', ')})` : ''}`;
    } else what = `the draft <b>${esc(conf.name)}</b> and all its documents`;
    $('#exConfirmText').innerHTML = `Delete ${what}? This can’t be undone.`;
  }

  const newRow = ex.editing === 'new-folder' ? { kind: 'f', id: 'new', name: '', sub: 'New folder', ref: {} } : null;
  const list = newRow ? [newRow, ...items] : items;
  const body = $('#exItems');
  body.className = `ex-items ${ex.view}`;
  body.innerHTML = (ex.editing === 'new-client' ? newClientForm() : '') + (list.length ? (ex.view === 'list' ? listHead() : '') + list.map((it) => itemHtml(it, searching)).join('')
    : `<div class="ex-empty-page">${loc.root ? '<b>No clients yet</b><span>Add your first client with “New client”.</span>' : '<b>This folder is empty</b><span>Make a folder or a draft here, or drop a Word or PDF file in.</span>'}</div>`);
  const input = $('.ex-rename', body);
  if (input) { input.focus(); input.select(); }
}
const folderDescendants = (id) => { const out = [id]; for (let i = 0; i < out.length; i++) for (const f of ex.data.folders) if (f.parentId === out[i]) out.push(f.id); return out; };
function listHead() {
  return '<div class="ex-row ex-head-row"><span>Name</span><span>Details</span><span>Modified</span></div>';
}
function itemHtml(it, searching) {
  const key = itemKey(it), on = ex.sel === key, renaming = ex.editing === key || it.id === 'new';
  const icon = it.kind === 'c' ? ICON_CLIENT : it.kind === 'f' ? ICON_FOLDER : ICON_DOC;
  const name = renaming ? `<input class="ex-rename" data-rename="${key}" value="${esc(it.name)}" maxlength="${it.kind === 'd' ? 200 : 80}" placeholder="${it.kind === 'f' ? 'Folder name' : 'Name'}" />` : `<span class="ex-iname">${esc(it.name)}</span>`;
  const drop = it.kind !== 'd' ? ` data-drop-loc='${JSON.stringify(it.kind === 'c' ? { clientId: it.id } : { clientId: cidOf(it.ref), folderId: it.id })}'` : '';
  const drag = canChange(it) && !renaming ? ' draggable="true"' : '';
  const when = it.updatedAt ? ago(it.updatedAt) : '';
  if (ex.view === 'list') {
    return `<div class="ex-row${on ? ' sel' : ''}" data-key="${key}"${drop}${drag} tabindex="-1">
      <span class="ex-cell-name">${icon}${name}</span><span class="ex-cell-sub">${esc(it.sub || '')}</span><span class="ex-cell-when">${when}</span></div>`;
  }
  return `<div class="ex-card${on ? ' sel' : ''} k-${it.kind}" data-key="${key}"${drop}${drag} tabindex="-1">
    <div class="ex-card-ico">${icon}</div>${name}<small>${esc(searching ? it.sub || '' : it.sub || '')}</small></div>`;
}
function newClientForm() {
  return `<form class="ex-newclient" id="exClientForm">
    <b>New client</b>
    <input name="name" required maxlength="80" placeholder="Client’s name" />
    <input name="company" maxlength="120" placeholder="Company (optional)" />
    <input name="email" type="email" maxlength="200" placeholder="Email (optional — needed to share drafts)" />
    <button type="submit" class="ex-primary">Add client</button><button type="button" class="ex-ghost" data-cancel-client>Cancel</button>
    <span class="ex-err" id="exClientErr"></span></form>`;
}
function renderTree() {
  const node = (label, icon, loc, key, kids, depth) => {
    const here = JSON.stringify(loc) === JSON.stringify(ex.loc.root ? { root: true } : ex.loc.folderId ? { clientId: ex.loc.clientId, folderId: ex.loc.folderId } : { clientId: ex.loc.clientId });
    const open = ex.open.has(key);
    return `<div class="ex-tnode">
      <div class="ex-trow${here ? ' here' : ''}" style="--d:${depth}" data-loc='${JSON.stringify(loc)}' data-drop-loc='${JSON.stringify(loc)}'>
        ${kids ? `<button type="button" class="ex-twist${open ? ' open' : ''}" data-twist="${key}" aria-label="${open ? 'Close' : 'Open'}">▸</button>` : '<span class="ex-twist-gap"></span>'}
        ${icon}<span>${esc(label)}</span></div>
      ${kids && open ? kids() : ''}</div>`;
  };
  const folderKids = (cid, parent, depth) => {
    const fs = ex.data.folders.filter((f) => cidOf(f) === cid && (f.parentId || null) === parent).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return fs.map((f) => {
      const has = ex.data.folders.some((x) => x.parentId === f.id);
      return node(f.name, ICON_FOLDER, { clientId: cid, folderId: f.id }, `f:${f.id}`, has ? () => folderKids(cid, f.id, depth + 1) : null, depth);
    }).join('');
  };
  const clients = [...ex.data.clients.map((c) => ({ id: c.id, name: c.name })), ...(hasNoClient() ? [{ id: 0, name: 'No client' }] : [])];
  $('#exTree').innerHTML = node('Clients', '<i class="ex-tico">⌂</i>', { root: true }, 'root', null, 0) + clients.map((c) => {
    const has = ex.data.folders.some((f) => cidOf(f) === c.id);
    return node(c.name, ICON_CLIENT, { clientId: c.id }, `c:${c.id}`, has ? () => folderKids(c.id, null, 2) : null, 1);
  }).join('');
}

// ---------- selecting, opening ----------
function openItem(it) {
  if (!it) return;
  if (it.kind === 'c') return setLoc({ clientId: it.id });
  if (it.kind === 'f') return setLoc({ clientId: cidOf(it.ref), folderId: it.id });
  hideExplorer();
  openMatter(it.id);
}
$('#exItems').addEventListener('click', (e) => {
  if (e.target.closest('.ex-rename, form')) return;
  const el = e.target.closest('[data-key]');
  ex.sel = el ? el.dataset.key : null;
  ex.confirm = null;
  renderExplorer();
});
$('#exItems').addEventListener('dblclick', (e) => {
  const el = e.target.closest('[data-key]');
  if (el && !e.target.closest('.ex-rename')) openItem(findItem(el.dataset.key));
});
// phones and tablets: one tap opens
$('#exItems').addEventListener('pointerup', (e) => {
  if (e.pointerType !== 'touch') return;
  const el = e.target.closest('[data-key]');
  if (el && !e.target.closest('.ex-rename, form')) openItem(findItem(el.dataset.key));
});
$('#exTree').addEventListener('click', (e) => {
  const tw = e.target.closest('[data-twist]');
  if (tw) {
    const k = tw.dataset.twist;
    ex.open.has(k) ? ex.open.delete(k) : ex.open.add(k);
    lsSet('lex_ex_tree', JSON.stringify([...ex.open]));
    return renderTree();
  }
  const row = e.target.closest('[data-loc]');
  if (row) setLoc(JSON.parse(row.dataset.loc));
});
$('#exCrumbs').addEventListener('click', (e) => { const b = e.target.closest('[data-loc]'); if (b) setLoc(JSON.parse(b.dataset.loc)); });
function exGoUp() {
  const path = pathOf(ex.loc);
  if (path.length > 1) setLoc(path[path.length - 2].loc);
}
$('#exUp').addEventListener('click', exGoUp);
$('#exSearch').addEventListener('input', (e) => { ex.q = e.target.value; ex.sel = null; renderExplorer(); });
$$('[data-exview]').forEach((b) => b.addEventListener('click', () => { ex.view = b.dataset.exview; lsSet('lex_ex_view', ex.view); renderExplorer(); }));
$('#exSort').addEventListener('change', (e) => { ex.sort = e.target.value; lsSet('lex_ex_sort', ex.sort); renderExplorer(); });

// ---------- the selection bar ----------
$('#exOpen').addEventListener('click', () => openItem(findItem(ex.sel)));
$('#exRename').addEventListener('click', () => { ex.editing = ex.sel; renderExplorer(); });
$('#exDelete').addEventListener('click', () => { ex.confirm = ex.sel; renderExplorer(); });
$('#exConfirmNo').addEventListener('click', () => { ex.confirm = null; renderExplorer(); });
$('#exConfirmYes').addEventListener('click', async () => {
  const it = findItem(ex.confirm);
  if (!it) return;
  try {
    await api('DELETE', it.kind === 'f' ? `/api/folders/${it.id}` : `/api/drafts/${it.id}`);
    confirmDone(`Deleted “${it.name}”`);
    if (it.kind === 'd' && (state.cur?.draft.matterId ?? state.cur?.draft.id) === it.id) state.cur = null;
  } catch (err) { ledger(err.message); }
  ex.confirm = null; ex.sel = null;
  loadExplorer();
});

// ---------- renaming (and naming a new folder) ----------
async function finishRename(input, keep) {
  const key = input.dataset.rename, name = input.value.trim();
  ex.editing = null;
  if (!keep || !name) return renderExplorer();
  try {
    if (key === 'f:new') await api('POST', '/api/folders', { name, clientId: ex.loc.clientId || null, parentId: ex.loc.folderId || null });
    else {
      const it = findItem(key);
      if (!it || name === it.name) return renderExplorer();
      if (it.kind === 'f') await api('PATCH', `/api/folders/${it.id}`, { name });
      else await api('PATCH', `/api/drafts/${it.id}`, { title: name });
    }
  } catch (err) { ledger(err.message); }
  loadExplorer();
}
$('#exItems').addEventListener('keydown', (e) => {
  const input = e.target.closest('.ex-rename');
  if (!input) return;
  if (e.key === 'Enter') { e.preventDefault(); finishRename(input, true); }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finishRename(input, false); }
});
$('#exItems').addEventListener('focusout', (e) => { const input = e.target.closest('.ex-rename'); if (input && ex.editing !== null) finishRename(input, true); });

// ---------- new ----------
$('#exNewFolder').addEventListener('click', () => { ex.editing = 'new-folder'; ex.sel = null; renderExplorer(); });
$('#exNewClient').addEventListener('click', () => { ex.editing = 'new-client'; renderExplorer(); $('#exClientForm input').focus(); });
$('#exItems').addEventListener('submit', async (e) => {
  if (e.target.id !== 'exClientForm') return;
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try {
    const { client } = await api('POST', '/api/clients', f);
    ex.editing = null;
    await loadExplorer();
    confirmDone(`Added ${client.name}`);
    setLoc({ clientId: client.id });
  } catch (err) { $('#exClientErr').textContent = err.message; }
});
$('#exItems').addEventListener('click', (e) => { if (e.target.closest('[data-cancel-client]')) { ex.editing = null; renderExplorer(); } });
// a new draft here: the New draft panel, with this client (and folder) already chosen
$('#exNewDraft').addEventListener('click', () => {
  state.nfPreset = { clientId: ex.loc.clientId || null, folderId: ex.loc.folderId || null };
  $('#newToggle').click();
});
// Word or PDF files become drafts here (pick them, or drop them onto the page)
$('#exUpload').addEventListener('click', () => $('#exFile').click());
$('#exFile').addEventListener('change', (e) => { uploadDrafts([...e.target.files]); e.target.value = ''; });
async function uploadDrafts(files) {
  files = files.filter((f) => /\.(docx|pdf)$/i.test(f.name));
  if (!files.length || ex.loc.root) return;
  for (const file of files) {
    try {
      ledger(`Reading ${file.name}…`);
      const { html, page } = await convertFile(file);
      await api('POST', '/api/drafts', { title: file.name.replace(/\.(docx|pdf)$/i, ''), clientId: ex.loc.clientId || null, folderId: ex.loc.folderId || null, contentHtml: html, sourceName: file.name, page });
    } catch (err) { ledger(`${file.name}: ${err.message}`); }
  }
  confirmDone(files.length > 1 ? `${files.length} files added` : `Added ${files[0].name}`);
  loadExplorer();
}

// ---------- moving: drag onto a folder, or "Move to" ----------
async function moveItem(key, loc) {
  const it = findItem(key);
  if (!it || !canChange(it) || loc.root) return;
  try {
    if (it.kind === 'f') {
      if (loc.folderId && folderDescendants(it.id).includes(loc.folderId)) return ledger('A folder can’t go inside itself.');
      await api('PATCH', `/api/folders/${it.id}`, { parentId: loc.folderId || null, clientId: loc.clientId || null });
    } else await api('PATCH', `/api/drafts/${it.id}`, { folderId: loc.folderId || null, moveClientId: loc.clientId || null });
    confirmDone(`Moved “${it.name}” to ${pathOf(loc).slice(1).map((p) => p.label).join(' › ')}`);
  } catch (err) { ledger(err.message); }
  ex.moving = null;
  $('#exMovePanel').classList.add('hidden');
  loadExplorer();
}
exEl.addEventListener('dragstart', (e) => {
  const el = e.target.closest('[data-key][draggable="true"]');
  if (!el) return;
  e.dataTransfer.setData('text/zoit-item', el.dataset.key);
  e.dataTransfer.effectAllowed = 'move';
  el.classList.add('dragging');
});
exEl.addEventListener('dragend', () => $$('.dragging, .drop-over', exEl).forEach((x) => x.classList.remove('dragging', 'drop-over')));
exEl.addEventListener('dragover', (e) => {
  const files = [...(e.dataTransfer.types || [])].includes('Files');
  const t = e.target.closest('[data-drop-loc]');
  if (t || (files && !ex.loc.root)) { e.preventDefault(); e.dataTransfer.dropEffect = files ? 'copy' : 'move'; }
  $$('.drop-over', exEl).forEach((x) => x !== t && x.classList.remove('drop-over'));
  if (t) t.classList.add('drop-over');
});
exEl.addEventListener('drop', (e) => {
  e.preventDefault();
  $$('.drop-over', exEl).forEach((x) => x.classList.remove('drop-over'));
  if (e.dataTransfer.files?.length) return uploadDrafts([...e.dataTransfer.files]);
  const key = e.dataTransfer.getData('text/zoit-item'), t = e.target.closest('[data-drop-loc]');
  if (key && t) moveItem(key, JSON.parse(t.dataset.dropLoc));
});
$('#exMove').addEventListener('click', () => {
  ex.moving = ex.sel;
  const it = findItem(ex.sel);
  // every place it could go: each client's space and its folders
  const dests = [];
  const add = (cid, parent, depth) => {
    for (const f of ex.data.folders.filter((x) => cidOf(x) === cid && (x.parentId || null) === parent).sort((a, b) => a.name.localeCompare(b.name))) {
      if (it.kind === 'f' && folderDescendants(it.id).includes(f.id)) continue;
      dests.push({ label: f.name, depth, loc: { clientId: cid, folderId: f.id } });
      add(cid, f.id, depth + 1);
    }
  };
  for (const c of [...ex.data.clients, ...(hasNoClient() ? [{ id: 0, name: 'No client' }] : [])]) { dests.push({ label: c.name, depth: 0, client: true, loc: { clientId: c.id } }); add(c.id, null, 1); }
  $('#exMoveName').textContent = it.name;
  $('#exMoveList').innerHTML = dests.map((d) => `<button type="button" class="ex-mv${d.client ? ' cl' : ''}" style="--d:${d.depth}" data-move-to='${JSON.stringify(d.loc)}'>${d.client ? ICON_CLIENT : ICON_FOLDER}<span>${esc(d.label)}</span></button>`).join('');
  $('#exMovePanel').classList.remove('hidden');
});
$('#exMoveList').addEventListener('click', (e) => { const b = e.target.closest('[data-move-to]'); if (b) moveItem(ex.moving, JSON.parse(b.dataset.moveTo)); });
$('#exMoveClose').addEventListener('click', () => { ex.moving = null; $('#exMovePanel').classList.add('hidden'); });

// ---------- keys ----------
document.addEventListener('keydown', (e) => {
  if (exEl.classList.contains('hidden') || e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  const it = findItem(ex.sel);
  if (e.key === 'Enter' && it) { e.preventDefault(); openItem(it); }
  else if (e.key === 'F2' && canChange(it)) { e.preventDefault(); ex.editing = ex.sel; renderExplorer(); }
  else if ((e.key === 'Delete') && canDelete(it)) { e.preventDefault(); ex.confirm = ex.sel; renderExplorer(); }
  else if (e.key === 'Backspace') { e.preventDefault(); exGoUp(); }
  else if (e.key === 'Escape') { ex.sel = null; ex.confirm = null; $('#exMovePanel').classList.add('hidden'); renderExplorer(); }
});

// ---------- fitting in with the rest of Zoit ----------
// the legal team lands in Clients; opening a draft leaves it; drafts show where they live
const _showApp = showApp;
showApp = async function () {
  await _showApp();
  if (state.me?.role === 'team' && !state.lane) showExplorer();
};
const _openMatter = openMatter;
openMatter = async function (id) {
  hideExplorer();
  await _openMatter(id);
  // a draft the explorer hasn't heard of yet (just made, or made by someone else): fetch, then show where it lives
  const mid = state.cur?.draft.matterId ?? state.cur?.draft.id;
  if (state.me?.role === 'team' && mid && !ex.data.drafts.some((x) => x.id === mid)) { try { ex.data = await api('GET', '/api/explorer'); } catch { /* breadcrumbs can wait */ } }
  renderCrumbs();
};
function renderCrumbs() {
  const box = $('#matterCrumbs');
  if (!box || state.me?.role !== 'team' || !state.cur) return;
  const d = ex.data.drafts.find((x) => x.id === (state.cur.draft.matterId ?? state.cur.draft.id));
  const loc = d ? (d.folderId && folderById(d.folderId) ? { clientId: cidOf(d), folderId: d.folderId } : { clientId: cidOf(d) }) : { root: true };
  box.innerHTML = pathOf(loc).map((p) => `<button type="button" data-crumb='${JSON.stringify(p.loc)}'>${esc(p.label)}</button>`).join('<span>›</span>');
}
$('#matterCrumbs').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-crumb]');
  if (b) showExplorer(JSON.parse(b.dataset.crumb));
});
// keep it current while open (others may be adding things too)
setInterval(() => { if (!exEl.classList.contains('hidden') && !ex.editing && !document.hidden) loadExplorer(); }, 8000);
// when the explorer's data arrives after a draft opened, fill in its breadcrumbs
setInterval(() => { if (state.cur && exEl.classList.contains('hidden') && !$('#matterCrumbs').textContent && ex.data.drafts.length) renderCrumbs(); }, 1500);
