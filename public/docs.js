// ================= Zoit — documents inside a matter, in folders =================
// A matter can hold several documents (the main draft, a side letter, a board resolution…), grouped
// into folders. Each document has its own client, clean and team sheets; sharing and the matter's
// details stay with the matter. The legal team adds, renames, moves and deletes documents.

const docStrip = $('#docStrip'), docEdit = $('#docEdit');
let docEditing = null; // 'new' | 'folder' | a document id | null
let newDocFolder = ''; // a document made while a folder is open goes into that folder
let openFolder = null; // the folder being looked into, like double-clicking a folder on a computer
let openFolderMatter = null;

// a manila folder and a page with a folded corner, like on any computer
const ICON_FOLDER = '<svg class="ex-ico" viewBox="0 0 48 40" aria-hidden="true"><path d="M3 7a3 3 0 0 1 3-3h12.5l4 4.5H42a3 3 0 0 1 3 3V34a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z" fill="#d9952b"/><path d="M3 14h42v20a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z" fill="#f4bf4f"/><path d="M3 14h42v3H3z" fill="#f8d27a"/></svg>';
const ICON_DOC = '<svg class="ex-ico" viewBox="0 0 38 46" aria-hidden="true"><path d="M4 2.5h21L34 11.5V43.5H4z" fill="#fdfcf9" stroke="#bdb8ad" stroke-width="1.4"/><path d="M25 2.5v9h9" fill="#e8e4da" stroke="#bdb8ad" stroke-width="1.4"/><path d="M9.5 18h19M9.5 23.5h19M9.5 29h19M9.5 34.5h12" stroke="#3b5ba5" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_UP = '<svg class="ex-ico" viewBox="0 0 48 40" aria-hidden="true"><path d="M3 7a3 3 0 0 1 3-3h12.5l4 4.5H42a3 3 0 0 1 3 3V34a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="3 3"/><path d="M24 30V17m-6 6 6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function renderDocStrip() {
  const docs = state.cur?.documents || [];
  const team = state.me?.role === 'team';
  // clients only see it when there is more than one document to choose from
  const show = team || docs.length > 1;
  docStrip.classList.toggle('hidden', !show);
  if (!show) { closeDocEdit(); return; }
  const cur = state.cur.draft.id, matter = state.cur.draft.matterId ?? cur;
  const folders = state.cur.folders || [...new Set(docs.filter((d) => d.folder).map((d) => d.folder))];
  // a new matter starts at the top; opening a document inside a folder keeps that folder open
  if (openFolderMatter !== matter) { openFolderMatter = matter; openFolder = state.cur.draft.folder || null; }
  if (openFolder && !folders.includes(openFolder)) openFolder = null;

  const docTile = (d) => `
    <button type="button" class="ex-tile ex-doc${d.id === cur ? ' on' : ''}" data-doc="${d.id}" title="${esc(d.name)}">
      ${ICON_DOC}<span class="ex-name">${esc(d.name)}</span>
      ${team && d.id === cur ? `<span class="ex-more" data-edit-doc="${d.id}" title="Rename, move or delete">⋯</span>` : ''}
    </button>`;
  const folderTile = (f) => {
    const n = docs.filter((d) => d.folder === f).length;
    return `
    <button type="button" class="ex-tile ex-folder${docs.some((d) => d.folder === f && d.id === cur) ? ' holds' : ''}" data-folder="${esc(f)}" title="Open ${esc(f)}">
      ${ICON_FOLDER}<span class="ex-name">${esc(f)}</span><small>${n ? `${n} document${n > 1 ? 's' : ''}` : 'Empty'}</small>
      ${team && !n ? `<span class="ex-more" data-rm-folder="${esc(f)}" title="Remove this empty folder">×</span>` : ''}
    </button>`;
  };
  const inside = openFolder ? docs.filter((d) => d.folder === openFolder) : docs.filter((d) => !d.folder);
  const tiles = openFolder
    ? `<button type="button" class="ex-tile ex-up" data-up title="Back to all documents">${ICON_UP}<span class="ex-name">Back</span></button>${inside.map(docTile).join('')}`
    : `${inside.map(docTile).join('')}${folders.map(folderTile).join('')}`;
  docStrip.innerHTML = `
    <div class="ex-head">
      <div class="ex-path">
        <button type="button" class="ex-crumb${openFolder ? '' : ' here'}" data-up>Documents</button>
        ${openFolder ? `<span class="ex-sep">›</span><span class="ex-crumb here">${ICON_FOLDER}${esc(openFolder)}</span>` : ''}
      </div>
      ${team ? `<div class="ex-actions">
        <button type="button" class="ex-act" data-new-doc>${ICON_DOC}New document</button>
        ${openFolder ? '' : `<button type="button" class="ex-act" data-new-folder>${ICON_FOLDER}New folder</button>`}
      </div>` : ''}
    </div>
    <div class="ex-tiles">${tiles || '<p class="ex-empty">This folder is empty — add a document to it.</p>'}</div>`;
  $('#folderList').innerHTML = folders.map((f) => `<option value="${esc(f)}">`).join('');
}

docStrip.addEventListener('click', async (e) => {
  const more = e.target.closest('[data-edit-doc]');
  if (more) { e.stopPropagation(); return openDocEdit(Number(more.dataset.editDoc)); }
  const rm = e.target.closest('[data-rm-folder]');
  if (rm) {
    e.stopPropagation();
    try { await api('DELETE', `/api/drafts/${state.cur.draft.id}/folders/${encodeURIComponent(rm.dataset.rmFolder)}`); await refresh(); }
    catch (x) { ledger(x.message); }
    return;
  }
  if (e.target.closest('[data-new-doc]')) { newDocFolder = openFolder || ''; return openDocEdit('new'); }
  if (e.target.closest('[data-new-folder]')) return openDocEdit('folder');
  if (e.target.closest('[data-up]')) { openFolder = null; closeDocEdit(); return renderDocStrip(); }
  const folder = e.target.closest('[data-folder]');
  if (folder) { openFolder = folder.dataset.folder; closeDocEdit(); return renderDocStrip(); } // open it
  const b = e.target.closest('[data-doc]');
  if (!b || Number(b.dataset.doc) === state.cur.draft.id) return;
  closeDocEdit();
  await openMatter(Number(b.dataset.doc)); // each document opens onto its own three sheets
});

// the small inline form under the row: a new document, or rename / move / delete one
function openDocEdit(which) {
  docEditing = which;
  if (which === 'folder') {
    docEdit.innerHTML = `
      <input name="name" required maxlength="80" placeholder="Folder name, e.g. Annexures" />
      <button class="btn-primary sm" type="submit">Make folder</button>
      <button type="button" class="link" data-cancel-doc>Cancel</button>
      <span class="de-error"></span>`;
    docEdit.classList.remove('hidden');
    return docEdit.elements.name.focus();
  }
  const d = which === 'new' ? null : (state.cur.documents || []).find((x) => x.id === which);
  const tpl = (state.templates || []).map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  docEdit.innerHTML = `
    <input name="name" required maxlength="120" placeholder="Document name, e.g. Side letter" value="${esc(d?.name || '')}" />
    <input name="folder" maxlength="80" list="folderList" placeholder="Folder (optional)" value="${esc(d ? (d.folder || '') : newDocFolder)}" />
    ${which === 'new' && tpl ? `<select name="template">${tpl}</select>` : ''}
    <button class="btn-primary sm" type="submit">${which === 'new' ? 'Add document' : 'Save'}</button>
    ${d && !d.main ? '<button type="button" class="de-del" data-del-doc>Delete</button>' : ''}
    <button type="button" class="link" data-cancel-doc>Cancel</button>
    <span class="de-error"></span>`;
  docEdit.classList.remove('hidden');
  docEdit.elements.name.focus();
  docEdit.elements.name.select();
}
function closeDocEdit() { docEditing = null; docEdit.classList.add('hidden'); docEdit.innerHTML = ''; }

docEdit.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = docEdit.elements, err = $('.de-error', docEdit);
  const body = { name: f.name.value.trim(), folder: (f.folder?.value || '').trim() };
  try {
    if (docEditing === 'folder') {
      await api('POST', `/api/drafts/${state.cur.draft.id}/folders`, { name: body.name });
      closeDocEdit();
      openFolder = body.name; // open the new folder straight away
      await refresh();
      confirmDone(`Folder “${body.name}” made`);
      return;
    }
    if (docEditing === 'new') {
      const r = await api('POST', `/api/drafts/${state.cur.draft.id}/documents`, { ...body, template: f.template?.value || 'blank' });
      closeDocEdit();
      await openMatter(r.document.id);
      confirmDone(`Added “${body.name}”`);
    } else {
      await api('PATCH', `/api/drafts/${docEditing}`, { docName: body.name, folder: body.folder });
      closeDocEdit();
      await refresh();
      ledger('Document updated.');
    }
  } catch (x) { err.textContent = x.message; }
});

docEdit.addEventListener('click', async (e) => {
  if (e.target.closest('[data-cancel-doc]')) return closeDocEdit();
  const del = e.target.closest('[data-del-doc]');
  if (!del) return;
  if (!del.classList.contains('armed')) { // ask first
    del.classList.add('armed');
    del.textContent = 'Click again to delete';
    setTimeout(() => { if (del.isConnected) { del.classList.remove('armed'); del.textContent = 'Delete'; } }, 3500);
    return;
  }
  const id = docEditing, name = (state.cur.documents || []).find((x) => x.id === id)?.name;
  try {
    await api('DELETE', `/api/drafts/${id}`);
    closeDocEdit();
    await openMatter(state.cur.draft.matterId); // back to the matter's main draft
    confirmDone(`Deleted “${name || 'document'}”`);
  } catch (x) { $('.de-error', docEdit).textContent = x.message; }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && docEditing) { e.preventDefault(); closeDocEdit(); } });
