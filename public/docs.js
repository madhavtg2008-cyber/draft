// ================= Zoit — documents inside a matter, in folders =================
// A matter can hold several documents (the main draft, a side letter, a board resolution…), grouped
// into folders. Each document has its own client, clean and team sheets; sharing and the matter's
// details stay with the matter. The legal team adds, renames, moves and deletes documents.

const docStrip = $('#docStrip'), docEdit = $('#docEdit');
let docEditing = null; // 'new' | a document id | null

const folderIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.5v8h13v-7H7.5L6 4H1.5z"/></svg>';

function renderDocStrip() {
  const docs = state.cur?.documents || [];
  const team = state.me?.role === 'team';
  // clients only see the row when there is more than one document to choose from
  const show = team || docs.length > 1;
  docStrip.classList.toggle('hidden', !show);
  if (!show) { closeDocEdit(); return; }
  const cur = state.cur.draft.id;
  const chip = (d) => `<button type="button" class="ds-doc${d.id === cur ? ' on' : ''}" data-doc="${d.id}" title="${esc(d.name)}">${esc(d.name)}${
    team && d.id === cur ? `<span class="ds-more" data-edit-doc="${d.id}" title="Rename, move or delete">⋯</span>` : ''}</button>`;
  const loose = docs.filter((d) => !d.folder);
  const folders = [...new Set(docs.filter((d) => d.folder).map((d) => d.folder))];
  docStrip.innerHTML = `
    <span class="ds-label">Documents</span>
    <div class="ds-row">
      ${loose.map(chip).join('')}
      ${folders.map((f) => `<span class="ds-folder">${folderIcon}<b>${esc(f)}</b>${docs.filter((d) => d.folder === f).map(chip).join('')}</span>`).join('')}
      ${team ? '<button type="button" class="ds-new" data-new-doc>+ New document</button>' : ''}
    </div>`;
  $('#folderList').innerHTML = folders.map((f) => `<option value="${esc(f)}">`).join('');
}

docStrip.addEventListener('click', async (e) => {
  const more = e.target.closest('[data-edit-doc]');
  if (more) { e.stopPropagation(); return openDocEdit(Number(more.dataset.editDoc)); }
  if (e.target.closest('[data-new-doc]')) return openDocEdit('new');
  const b = e.target.closest('[data-doc]');
  if (!b || Number(b.dataset.doc) === state.cur.draft.id) return;
  closeDocEdit();
  await openMatter(Number(b.dataset.doc)); // each document opens onto its own three sheets
});

// the small inline form under the row: a new document, or rename / move / delete one
function openDocEdit(which) {
  docEditing = which;
  const d = which === 'new' ? null : (state.cur.documents || []).find((x) => x.id === which);
  const tpl = (state.templates || []).map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  docEdit.innerHTML = `
    <input name="name" required maxlength="120" placeholder="Document name, e.g. Side letter" value="${esc(d?.name || '')}" />
    <input name="folder" maxlength="80" list="folderList" placeholder="Folder (optional)" value="${esc(d?.folder || '')}" />
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
  const body = { name: f.name.value.trim(), folder: f.folder.value.trim() };
  try {
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
