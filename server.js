// LexDraft — three-lane legal drafting server
// Lanes: "client" (client-editable), "final" (clean draft, team-controlled), "team" (privileged, team-only)
// Every edit is attributed to its author. Edits by anyone other than the Team Head stay pending
// until the Team Head confirms (or rejects) them.

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const HTMLtoDOCX = require('html-to-docx');
const sanitizeHtml = require('sanitize-html');
const { JSDOM } = require('jsdom');
const htmlToPdfmake = require('html-to-pdfmake');
const PdfPrinter = require('pdfmake');
const mammoth = require('mammoth');                  // .docx → HTML (fallback)
const { docxToHtml } = require('./lib/docx-import'); // .docx → HTML, keeping Word's formatting
const pdfParse = require('pdf-parse/lib/pdf-parse.js'); // PDF → text

const PORT = process.env.PORT || 3000;
const db = new DatabaseSync(path.join(__dirname, 'lexdraft.db'));
const LANES = ['client', 'final', 'team'];
const STATUSES = ['drafting', 'client_review', 'negotiation', 'approved', 'executed'];
// Distinct, legible-on-paper colours handed out to users in order
const PALETTE = ['#3b4fd8', '#0f8a7e', '#d0571b', '#a23ec9', '#c2283f', '#2f8f2f', '#b8860b', '#1f7fbf', '#8a5a2b', '#d63d8f'];

// ---------- schema ----------
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('client','team')),
    title TEXT,
    color TEXT,
    head INTEGER NOT NULL DEFAULT 0,
    pass_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    matter_no TEXT NOT NULL,
    client_id INTEGER REFERENCES users(id),
    counterparty TEXT,
    page_setup TEXT,          -- page size & margins in twips (from an imported Word file); A4 / 1in by default
    status TEXT NOT NULL DEFAULT 'drafting',
    created_by INTEGER REFERENCES users(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    lane TEXT NOT NULL,
    content TEXT NOT NULL,
    note TEXT,
    author_id INTEGER REFERENCES users(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_versions_lane ON versions(draft_id, lane, id);
  -- attributed token stream per lane: confirmed text + pending insertions/deletions with authors
  CREATE TABLE IF NOT EXISTS lane_state (
    draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    lane TEXT NOT NULL,
    tokens TEXT NOT NULL,
    rev INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (draft_id, lane)
  );
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    lane TEXT NOT NULL,
    body TEXT NOT NULL,
    quote TEXT,              -- the passage of the document the remark is pinned to
    author_id INTEGER REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  -- an associate's request for the team draft to be uploaded to the clean draft, awaiting the Team Head
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('promote-team')),
    content TEXT NOT NULL,
    requested_by INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'pending',
    decided_by INTEGER REFERENCES users(id),
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    lane TEXT,
    action TEXT NOT NULL,
    author_id INTEGER REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
`);

// ---------- helpers ----------
const now = () => Date.now();

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  return crypto.timingSafeEqual(crypto.scryptSync(pw, salt, 64), Buffer.from(hash, 'hex'));
}
const publicUser = (u) => u && ({ id: u.id, name: u.name, email: u.email, role: u.role, title: u.title, color: u.color, head: !!u.head });
const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

function nextColor() {
  const used = db.prepare('SELECT color, COUNT(*) AS n FROM users GROUP BY color').all();
  const count = Object.fromEntries(used.map((r) => [r.color, r.n]));
  return PALETTE.reduce((best, c) => ((count[c] || 0) < (count[best] || 0) ? c : best), PALETTE[0]);
}

// ---------- rich text: documents are sanitised HTML ----------
const CSS_LEN = /^\d+(\.\d+)?(pt|px|em|rem|%)$/;
const CSS_COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]+)$/i;
const SANITIZE = {
  allowedTags: ['p', 'br', 'div', 'span', 'strong', 'em', 'u', 's', 'sub', 'sup', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li',
    'blockquote', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'a', 'hr', 'img', 'font'],
  allowedAttributes: {
    '*': ['style'], a: ['href', 'target'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'],
    img: ['src', 'alt', 'width', 'height'], font: ['face', 'color', 'size'], div: ['class'], hr: ['class'],
  },
  allowedClasses: { div: ['page-break'], hr: ['page-break'] },
  allowedStyles: {
    '*': {
      'font-family': [/^[\w\s,'"-]+$/], 'font-size': [CSS_LEN, /^(xx?x?-)?(small|large)$|^medium$/],
      color: [CSS_COLOR], 'background-color': [CSS_COLOR], 'text-align': [/^(left|right|center|justify)$/],
      'line-height': [/^\d+(\.\d+)?$/, CSS_LEN], 'margin-left': [CSS_LEN], 'padding-left': [CSS_LEN],
      'margin-right': [CSS_LEN], 'margin-top': [CSS_LEN], 'margin-bottom': [CSS_LEN], 'text-indent': [/^-?\d+(\.\d+)?(pt|px|em)$/],
      'text-transform': [/^(uppercase|lowercase|capitalize|none)$/], 'font-variant': [/^(small-caps|normal)$/],
      'text-decoration': [/^[\w\s-]+$/], 'text-decoration-line': [/^[\w\s-]+$/], 'font-weight': [/^(bold|normal|\d{3})$/],
      'font-style': [/^(italic|normal)$/], 'page-break-after': [/^always$/], width: [CSS_LEN, /^auto$/],
      'vertical-align': [/^(sub|super|baseline|top|middle|bottom)$/], border: [/^[\w\s#.(),%-]+$/],
      'border-collapse': [/^collapse$/], 'list-style-type': [/^[\w-]+$/],
    },
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['data', 'https'] },
  transformTags: { b: 'strong', i: 'em', strike: 's', del: 's', ins: 'u' },
  exclusiveFilter: (f) => f.tag === 'img' && !/^(data:image\/(png|jpe?g|gif|webp);base64,|https:)/i.test(f.attribs.src || ''),
};
const clean = (html) => sanitizeHtml(String(html || ''), SANITIZE).trim();

// plain legal text → starter HTML (used for seeds and new matters)
function textToHtml(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let first = true;
  return text.split(/\r?\n/).filter((l) => l.trim()).map((l) => {
    if (first) { first = false; return `<h1 style="text-align: center">${esc(l.trim())}</h1>`; }
    if (/^\d+\.\s+[A-Z][A-Z\s,&-]+$/.test(l.trim())) return `<h3>${esc(l.trim())}</h3>`;
    return `<p style="text-align: justify">${esc(l)}</p>`;
  }).join('');
}

// ---------- page setup (twips: 1440 per inch) ----------
const DEFAULT_PAGE = { w: 11906, h: 16838, top: 1440, right: 1440, bottom: 1440, left: 1440 }; // A4, 1-inch margins
function cleanPage(p) {
  if (!p || typeof p !== 'object') return null;
  const out = {};
  for (const k of Object.keys(DEFAULT_PAGE)) {
    const v = Number(p[k]);
    out[k] = Number.isFinite(v) && v >= 0 && v <= 40000 ? Math.round(v) : DEFAULT_PAGE[k];
  }
  if (out.w < 2880 || out.h < 2880 || out.left + out.right >= out.w - 1440 || out.top + out.bottom >= out.h - 1440) return null;
  return out;
}
const pageOf = (draft) => { try { return cleanPage(JSON.parse(draft.page_setup)) || DEFAULT_PAGE; } catch { return DEFAULT_PAGE; } };

// ---------- attributed diff engine ----------
// A lane's state is a stream of tokens: { t: text, a?: authorId (pending insertion), d?: authorId (pending deletion) }.
// Tokens are HTML tags, entities, whitespace, words and punctuation.
// Confirmed document = tokens without `a`. Working document = tokens without `d`.
const tokenize = (s) => s.match(/<[^>]*>|&[#\w]+;|\s+|[\w'’-]+|[^\s\w<&]/g) || [];
const BLOCK = /^<\/?(p|h[1-6]|li|ul|ol|div|blockquote|table|thead|tbody|tr|td|th|hr|br)\b/i;

function diffOps(A, B) {
  const ops = [];
  let p = 0; while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0; while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  for (let k = 0; k < p; k++) ops.push(['=', k, k]);
  const n = A.length - p - s, m = B.length - p - s;
  if (n * m > 4e6) {
    for (let i = 0; i < n; i++) ops.push(['-', p + i]);
    for (let j = 0; j < m; j++) ops.push(['+', null, p + j]);
  } else {
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[p + i] === B[p + j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[p + i] === B[p + j]) { ops.push(['=', p + i, p + j]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(['-', p + i++]);
      else ops.push(['+', null, p + j++]);
    }
    while (i < n) ops.push(['-', p + i++]);
    while (j < m) ops.push(['+', null, p + j++]);
  }
  for (let k = 0; k < s; k++) ops.push(['=', A.length - s + k, B.length - s + k]);
  return cleanupOps(ops, A, B);
}

// Make changes read like a person made them: absorb small coincidental matches
// (a shared space, a bracket, a short word inside a rewrite) into the surrounding
// change, and put each block's deletions before its insertions.
function cleanupOps(ops, A, B) {
  const chars = (run, kind) => run.ops.filter((o) => o[0] === kind).reduce((n, o) => n + (kind === '+' ? B[o[2]] : A[o[1]]).length, 0);
  for (let pass = 0; pass < 500; pass++) {
    const runs = [];
    for (const op of ops) {
      const eq = op[0] === '=', last = runs[runs.length - 1];
      if (last && last.eq === eq) last.ops.push(op); else runs.push({ eq, ops: [op] });
    }
    let merged = false;
    for (let i = 1; i < runs.length - 1 && !merged; i++) {
      const r = runs[i];
      if (!r.eq) continue;
      const text = r.ops.map((o) => A[o[1]]).join('');
      const p = runs[i - 1], q = runs[i + 1];
      const small = text.length <= Math.max(chars(p, '-'), chars(p, '+')) && text.length <= Math.max(chars(q, '-'), chars(q, '+'));
      const filler = text.length <= 3 && !/\w/.test(text);
      if ((small || filler) && !text.includes('\n') && !r.ops.some((o) => BLOCK.test(A[o[1]]))) { // never merge across paragraphs
        r.eq = false;
        r.ops = [...r.ops.map((o) => ['-', o[1]]), ...r.ops.map((o) => ['+', null, o[2]])];
        merged = true;
      }
    }
    ops = [];
    let block = [];
    const flush = () => { ops.push(...block.filter((o) => o[0] === '-'), ...block.filter((o) => o[0] === '+')); block = []; };
    for (const r of runs) { if (r.eq) { flush(); ops.push(...r.ops); } else block.push(...r.ops); }
    flush();
    if (!merged) break;
  }
  return ops;
}

// Fold a new working text into the stream, attributing every change to `authorId`.
// The Team Head's edits are confirmed immediately.
function applyEdit(stream, text, authorId, isHead) {
  const live = [];
  stream.forEach((tok, i) => { if (!tok.d) live.push(i); });
  const A = live.map((i) => stream[i].t), B = tokenize(text);
  const out = [];
  let s = 0;
  const flushTo = (k) => { while (s < k) out.push(stream[s++]); };
  const flushDeleted = () => { while (s < stream.length && stream[s].d) out.push(stream[s++]); };
  for (const [op, a, b] of diffOps(A, B)) {
    if (op === '=') { flushTo(live[a]); out.push(stream[live[a]]); s = live[a] + 1; }
    else if (op === '-') {
      flushTo(live[a]);
      const tok = stream[live[a]];
      s = live[a] + 1;
      if (!tok.a && !isHead) out.push({ t: tok.t, d: authorId }); // confirmed text struck out, pending
      // a pending insertion that is deleted again simply disappears; the Head's deletions are final
    } else {
      flushDeleted();
      out.push(isHead ? { t: B[b] } : { t: B[b], a: authorId });
    }
  }
  flushTo(stream.length);
  return out;
}

// Group pending tokens into confirmable changes ("hunks"): one author's edits within one
// paragraph form a single change, so formatting (e.g. <strong>…</strong>) is confirmed as a whole.
function hunkIds(stream) {
  const ids = new Array(stream.length).fill(-1);
  let h = -1, by0 = null, open = false;
  for (let i = 0; i < stream.length; i++) {
    const tok = stream[i], by = tok.d || tok.a;
    if (!by) { if (open && (BLOCK.test(tok.t) || tok.t.includes('\n'))) open = false; continue; }
    if (!open || by !== by0) { h++; by0 = by; open = true; }
    ids[i] = h;
  }
  return { ids, count: h + 1 };
}

function segments(stream) {
  const { ids, count } = hunkIds(stream);
  const segs = [];
  stream.forEach((tok, i) => {
    const k = tok.d ? 'del' : tok.a ? 'ins' : 'eq';
    const by = tok.d || tok.a || null, h = ids[i];
    const last = segs[segs.length - 1];
    if (last && last.k === k && last.by === by && last.h === h) last.t += tok.t;
    else segs.push({ k, t: tok.t, by, h });
  });
  return { segs, pending: count };
}

function resolveHunks(stream, hunk, accept) {
  const { ids } = hunkIds(stream);
  const out = [];
  stream.forEach((tok, i) => {
    const hit = hunk === 'all' ? ids[i] >= 0 : ids[i] === hunk;
    if (!hit) return out.push(tok);
    if (tok.d) { if (!accept) out.push({ t: tok.t }); } // accept deletion → gone; reject → restored
    else if (tok.a) { if (accept) out.push({ t: tok.t }); } // accept insertion → confirmed; reject → dropped
  });
  return out;
}
const workingText = (stream) => stream.filter((t) => !t.d).map((t) => t.t).join('');

function getState(draftId, lane) {
  const row = db.prepare('SELECT tokens, rev FROM lane_state WHERE draft_id = ? AND lane = ?').get(draftId, lane);
  return row ? { stream: JSON.parse(row.tokens), rev: row.rev } : { stream: [], rev: 0 };
}
function putState(draftId, lane, stream) {
  db.prepare(`INSERT INTO lane_state (draft_id, lane, tokens, rev) VALUES (?,?,?,1)
              ON CONFLICT(draft_id, lane) DO UPDATE SET tokens = excluded.tokens, rev = rev + 1`).run(draftId, lane, JSON.stringify(stream));
}

// ---------- versions ----------
function latest(draftId, lane) {
  return db.prepare(`SELECT v.*, u.name AS author_name, u.color AS author_color FROM versions v LEFT JOIN users u ON u.id = v.author_id
                     WHERE v.draft_id = ? AND v.lane = ? ORDER BY v.id DESC LIMIT 1`).get(draftId, lane);
}
function logActivity(draftId, lane, action, authorId) {
  db.prepare('INSERT INTO activity (draft_id, lane, action, author_id, created_at) VALUES (?,?,?,?,?)').run(draftId, lane, action, authorId, now());
}

// Record a version row. Rapid autosaves by one author within 2 minutes coalesce into one version.
function recordVersion(draftId, lane, content, authorId, note, forceNew) {
  const last = latest(draftId, lane);
  const t = now();
  if (!forceNew && last && last.author_id === authorId && !last.note && t - last.updated_at < 120000)
    db.prepare('UPDATE versions SET content = ?, updated_at = ? WHERE id = ?').run(content, t, last.id);
  else
    db.prepare('INSERT INTO versions (draft_id, lane, content, note, author_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(draftId, lane, content, note || null, authorId, t, t);
  db.prepare('UPDATE drafts SET updated_at = ? WHERE id = ?').run(t, draftId);
  return latest(draftId, lane);
}

// Save new working text for a lane as `user`: attribute it, then version it.
function saveLane(draftId, lane, html, user, note, forceNew = false) {
  const content = clean(html);
  const { stream } = getState(draftId, lane);
  putState(draftId, lane, applyEdit(stream, content, user.id, !!user.head));
  return recordVersion(draftId, lane, content, user.id, note, forceNew);
}

function initLane(draftId, lane, html, user, note) {
  const content = clean(html);
  putState(draftId, lane, tokenize(content).map((t) => ({ t })));
  return recordVersion(draftId, lane, content, user.id, note, true);
}

// strip internal notes so privileged content never reaches the clean draft
// (a whole paragraph containing a team note is dropped; a bare note is cut out)
function stripTeamNotes(html) {
  return html
    .replace(/<p\b[^>]*>(?:(?!<\/p>)[\s\S])*?\[TEAM NOTE:[\s\S]*?<\/p>/g, '')
    .replace(/\[TEAM NOTE:[\s\S]*?\]/g, '');
}

// ---------- associate requests (approved or declined by the Team Head) ----------
// One open request per associate per kind: asking again refreshes it with the latest text.
function upsertRequest(draftId, kind, content, userId) {
  const open = db.prepare("SELECT id FROM requests WHERE draft_id = ? AND kind = ? AND requested_by = ? AND status = 'pending'").get(draftId, kind, userId);
  if (open) db.prepare('UPDATE requests SET content = ?, created_at = ? WHERE id = ?').run(content, now(), open.id);
  else db.prepare('INSERT INTO requests (draft_id, kind, content, requested_by, created_at) VALUES (?,?,?,?,?)').run(draftId, kind, content, userId, now());
}
const REQUEST_WORDS = { 'promote-team': 'upload the team draft to the clean draft' };

function canSeeDraft(user, draft) { return draft && (user.role === 'team' || draft.client_id === user.id); }
function canSeeLane(user, lane) { return lane !== 'team' || user.role === 'team'; }
function canEditLane(user, draft, lane) {
  // nobody types into the clean draft: it only ever changes when the Team Head uploads the team draft
  if (lane === 'final') return false;
  if (user.role === 'team') return true;
  return lane === 'client' && draft.client_id === user.id && !['approved', 'executed'].includes(draft.status);
}

function laneInfo(user, draft, lane) {
  const v = latest(draft.id, lane);
  const { stream, rev } = getState(draft.id, lane);
  const { segs, pending } = segments(stream);
  return v && {
    content: v.content, versionId: v.id, updatedAt: v.updated_at, author: v.author_name, authorColor: v.author_color,
    editable: canEditLane(user, draft, lane), rev, pending, segments: segs,
  };
}

// ---------- seed ----------
if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
  const addUser = db.prepare('INSERT INTO users (name, email, role, title, color, head, pass_hash, created_at) VALUES (?,?,?,?,?,?,?,?)');
  const mk = (...a) => getUser(addUser.run(...a).lastInsertRowid);
  const counsel = mk('Priya Raman', 'counsel@lexdraft.test', 'team', 'Team Head', PALETTE[0], 1, hashPassword('counsel123'), now());
  const associate = mk('Daniel Cho', 'associate@lexdraft.test', 'team', 'Associate', PALETTE[1], 0, hashPassword('associate123'), now());
  const client = mk('Aarav Mehta', 'client@lexdraft.test', 'client', 'Mehta Ventures Pvt. Ltd.', PALETTE[2], 0, hashPassword('client123'), now());

  const nda = `MUTUAL NON-DISCLOSURE AGREEMENT

This Mutual Non-Disclosure Agreement (the "Agreement") is entered into as of the Effective Date by and between Mehta Ventures Pvt. Ltd. ("Company") and Northwind Analytics LLC ("Counterparty").

1. DEFINITION OF CONFIDENTIAL INFORMATION
"Confidential Information" means any non-public information disclosed by either party, whether orally, in writing, or by inspection, that is designated as confidential or would reasonably be understood to be confidential.

2. OBLIGATIONS
The receiving party shall hold Confidential Information in strict confidence and shall not disclose it to any third party without prior written consent of the disclosing party.

3. TERM
This Agreement shall remain in effect for a period of two (2) years from the Effective Date.

4. GOVERNING LAW
This Agreement shall be governed by the laws of India, and the courts at Mumbai shall have exclusive jurisdiction.`;

  const t = now();
  const draftId = db.prepare('INSERT INTO drafts (title, matter_no, client_id, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run('Mutual NDA — Northwind Analytics', 'LD-2026-0142', client.id, 'negotiation', counsel.id, t, t).lastInsertRowid;
  db.prepare('UPDATE drafts SET counterparty = ? WHERE id = ?').run('Northwind Analytics LLC', draftId);
  const ndaHtml = clean(textToHtml(nda));
  for (const lane of LANES) initLane(draftId, lane, ndaHtml, counsel, 'Initial draft');

  // client proposes changes (pending)
  saveLane(draftId, 'client', ndaHtml.replace('two (2) years', 'three (3) years')
    .replace('of the disclosing party.', 'of the disclosing party, except to its employees and advisors who have a need to know.'), client);
  // associate drafts in the team lane (pending)
  saveLane(draftId, 'team', ndaHtml
    + '<h3>5. RETURN OF MATERIALS</h3><p style="text-align: justify">Upon written request, the receiving party shall promptly return or destroy all Confidential Information.</p>'
    + '<p><span style="background-color: #fff3a3"><strong>[TEAM NOTE:</strong> Client wants a 3-year term. Fallback position is 30 months. Do NOT share with the client.]</span></p>', associate);
  // associate asks for the team draft to go into the clean draft (awaits the Team Head)
  upsertRequest(draftId, 'promote-team', stripTeamNotes(latest(draftId, 'team').content), associate.id);

  const c = db.prepare('INSERT INTO comments (draft_id, lane, body, quote, author_id, created_at) VALUES (?,?,?,?,?,?)');
  c.run(draftId, 'client', 'We need a longer term — our product roadmap runs three years.', 'three (3) years', client.id, t - 3500000);
  c.run(draftId, 'client', 'Noted. We will reflect this in the clean draft after internal review.', null, counsel.id, t - 3000000);
  c.run(draftId, 'team', 'Should the "advisors" carve-out require their own written NDAs?', 'RETURN OF MATERIALS', associate.id, t - 1700000);
  logActivity(draftId, 'final', 'opened the matter', counsel.id);
  logActivity(draftId, 'client', 'proposed changes to the term and disclosure clauses', client.id);
  logActivity(draftId, 'team', 'added a Return of Materials clause', associate.id);

  const lease = `COMMERCIAL LEASE AGREEMENT

This Lease is made between Harbour Estates Ltd. ("Landlord") and Mehta Ventures Pvt. Ltd. ("Tenant").

1. PREMISES
Landlord leases to Tenant the office premises at Unit 1204, Harbour Tower, Mumbai.

2. RENT
Tenant shall pay monthly rent of INR 4,50,000, payable in advance on the first day of each month.

3. SECURITY DEPOSIT
Tenant shall deposit an amount equal to six (6) months' rent as security.`;
  const t2 = now() - 2 * 86400000;
  const leaseId = db.prepare('INSERT INTO drafts (title, matter_no, client_id, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run('Commercial Lease — Harbour Tower', 'LD-2026-0157', client.id, 'drafting', counsel.id, t2, t2).lastInsertRowid;
  for (const lane of LANES) initLane(leaseId, lane, textToHtml(lease), counsel, 'Initial draft');
  logActivity(leaseId, 'final', 'opened the matter', counsel.id);
}

// ---------- realtime (Server-Sent Events) ----------
const streams = new Set(); // { res, user, draftId }

function presenceFor(draftId) {
  const seen = new Map();
  for (const s of streams) if (s.draftId === draftId) seen.set(s.user.id, publicUser(s.user));
  return [...seen.values()];
}
function broadcast(draftId, type, payload = {}, { lane = null, excludeUserId = null } = {}) {
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
  for (const s of streams) {
    if (excludeUserId && s.user.id === excludeUserId) continue;
    if (!canSeeDraft(s.user, draft)) continue;
    if (lane && !canSeeLane(s.user, lane)) continue;
    s.res.write(`event: ${type}\ndata: ${JSON.stringify({ draftId, lane, ...payload })}\n\n`);
  }
}
const laneChanged = (draftId, lane, user, kind = 'edit') =>
  broadcast(draftId, 'lane', { by: user.name, byId: user.id, kind }, { lane });

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '15mb' })); // room for pasted images
app.use(express.static(path.join(__dirname, 'public')));

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((c) => {
    const i = c.indexOf('=');
    return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
  }));
}
function auth(req, res, next) {
  const token = parseCookies(req).lex_session;
  const row = token && db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token);
  if (!row) return res.status(401).json({ error: 'Not signed in' });
  req.user = row;
  next();
}
const teamOnly = (req, res, next) => (req.user.role === 'team' ? next() : res.status(403).json({ error: 'Legal team only' }));
const headOnly = (req, res, next) => (req.user.head ? next() : res.status(403).json({ error: 'Only the Team Head can confirm changes' }));
function loadDraft(req, res, next) {
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(Number(req.params.id));
  if (!canSeeDraft(req.user, draft)) return res.status(404).json({ error: 'Draft not found' });
  req.draft = draft;
  next();
}
function laneParam(req, res, next) {
  const { lane } = req.params;
  if (!LANES.includes(lane) || !canSeeLane(req.user, lane)) return res.status(404).json({ error: 'Unknown lane' });
  next();
}
function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)').run(token, userId, now());
  res.setHeader('Set-Cookie', `lex_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 14}`);
}

// --- auth
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase().trim());
  if (user && !user.pass_hash) return res.status(401).json({ error: 'Your lawyer has set up this account — choose a password under "New client" to activate it' });
  if (!user || !verifyPassword(String(password || ''), user.pass_hash)) return res.status(401).json({ error: 'Invalid email or password' });
  startSession(res, user.id);
  res.json({ user: publicUser(user) });
});
app.post('/api/auth/register', (req, res) => {
  const { name, email, password, company } = req.body || {};
  if (!name || !email || !password || password.length < 6) return res.status(400).json({ error: 'Name, email and a 6+ character password are required' });
  const em = String(email).toLowerCase().trim();
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(em);
  if (existing && existing.role === 'client' && !existing.pass_hash) {
    // a client the firm added with a new matter: claim the account by setting a password
    db.prepare('UPDATE users SET pass_hash = ?, title = COALESCE(title, ?) WHERE id = ?').run(hashPassword(password), company || null, existing.id);
    startSession(res, existing.id);
    return res.json({ user: publicUser(getUser(existing.id)) });
  }
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });
  // Self-registration creates client accounts; the legal team is provisioned by the firm.
  const id = db.prepare('INSERT INTO users (name, email, role, title, color, pass_hash, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(String(name).trim(), em, 'client', company || null, nextColor(), hashPassword(password), now()).lastInsertRowid;
  startSession(res, id);
  res.json({ user: publicUser(getUser(id)) });
});
app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req).lex_session;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', 'lex_session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));
app.get('/api/clients', auth, teamOnly, (req, res) => {
  res.json({ clients: db.prepare("SELECT id, name, email, title, color, pass_hash != '' AS active FROM users WHERE role = 'client' ORDER BY name").all() });
});

// --- drafts
app.get('/api/drafts', auth, (req, res) => {
  const base = 'SELECT d.*, c.name AS client_name FROM drafts d LEFT JOIN users c ON c.id = d.client_id';
  const rows = req.user.role === 'team'
    ? db.prepare(`${base} ORDER BY d.updated_at DESC`).all()
    : db.prepare(`${base} WHERE d.client_id = ? ORDER BY d.updated_at DESC`).all(req.user.id);
  res.json({ drafts: rows });
});

// Open a new matter. The client can be an existing one, or a brand-new client added right here:
// they get an invited account and choose their own password the first time they sign up with that email.
app.post('/api/drafts', auth, teamOnly, (req, res) => {
  const { title, clientId, newClient, counterparty, contentHtml, sourceName, page } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Matter title is required' });
  let cid = clientId ? Number(clientId) : null;
  if (cid && !db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'client'").get(cid)) return res.status(400).json({ error: 'Unknown client' });
  if (newClient?.name?.trim()) {
    const email = String(newClient.email || '').toLowerCase().trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'A valid email is needed for the new client' });
    const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (existing && existing.role !== 'client') return res.status(409).json({ error: 'That email belongs to a member of the firm' });
    cid = existing ? existing.id : db.prepare('INSERT INTO users (name, email, role, title, color, pass_hash, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(String(newClient.name).trim(), email, 'client', String(newClient.company || '').trim() || null, nextColor(), '', now()).lastInsertRowid;
  }
  const t = now();
  const count = db.prepare('SELECT COUNT(*) AS n FROM drafts').get().n;
  const matterNo = `LD-${new Date().getFullYear()}-${String(140 + count + 1).padStart(4, '0')}`;
  const setup = cleanPage(page);
  const id = db.prepare('INSERT INTO drafts (title, matter_no, client_id, counterparty, page_setup, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(String(title).trim(), matterNo, cid, String(counterparty || '').trim() || null, setup ? JSON.stringify(setup) : null, 'drafting', req.user.id, t, t).lastInsertRowid;
  const imported = contentHtml && clean(contentHtml).replace(/<[^>]+>/g, '').trim() ? clean(contentHtml) : null;
  const body = imported || textToHtml(`${String(title).toUpperCase()}\n1. PARTIES\nThis Agreement is made between …\n2. RECITALS\nWhereas …\n3. TERMS\n…`);
  const note = imported ? `Imported ${String(sourceName || 'document').slice(0, 100)}` : 'Initial draft';
  for (const lane of LANES) initLane(id, lane, body, req.user, note);
  logActivity(id, 'final', 'opened the matter', req.user.id);
  res.json({ draft: db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) });
});

// Turn a dropped Word (.docx) or PDF file into editable, sanitised HTML.
function pdfTextToHtml(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim());
  const longest = Math.max(40, ...lines.map((l) => l.length));
  const out = [];
  let buf = [];
  const flush = () => { if (buf.length) out.push(`<p style="text-align: justify">${esc(buf.join(' ').replace(/\s+/g, ' '))}</p>`); buf = []; };
  for (const l of lines) {
    if (!l) { flush(); continue; }
    if (l.length < 90 && /[A-Z]{3}/.test(l) && l === l.toUpperCase()) { flush(); out.push(`<h3>${esc(l)}</h3>`); continue; }
    buf.push(l);
    if (/[.:;!?)"”]$/.test(l) && l.length < longest * 0.8) flush(); // a short line ending a sentence ends the paragraph
  }
  flush();
  return out.join('').replace(/^<h3>(.*?)<\/h3>/, '<h1 style="text-align: center">$1</h1>');
}
app.post('/api/convert', auth, express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
  const name = decodeURIComponent(req.get('x-filename') || 'document');
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'The file was empty' });
  const isPdf = buf.subarray(0, 4).toString() === '%PDF';
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  try {
    let html, page = null;
    if (isPdf) html = pdfTextToHtml((await pdfParse(buf)).text);
    else if (isZip) {
      try { ({ html, page } = await docxToHtml(buf)); } // faithful: fonts, sizes, spacing, lists, tables, page breaks, page size
      catch (err) { console.warn('docx import fell back to mammoth:', err.message); html = (await mammoth.convertToHtml({ buffer: buf })).value; }
    }
    else if (/\.txt$/i.test(name)) html = textToHtml(buf.toString('utf8'));
    else return res.status(415).json({ error: 'Only Word (.docx) and PDF files can be imported. Save older .doc files as .docx first.' });
    html = clean(html);
    if (!html.replace(/<[^>]+>/g, '').trim()) return res.status(422).json({ error: 'No readable text in that file (a scanned PDF needs OCR first)' });
    res.json({ html, name, page: cleanPage(page) });
  } catch (err) {
    console.error('import failed', err.message);
    res.status(422).json({ error: 'That file could not be read' });
  }
});

app.get('/api/drafts/:id', auth, loadDraft, (req, res) => {
  const d = req.draft;
  const lanes = {};
  for (const lane of LANES) if (canSeeLane(req.user, lane)) lanes[lane] = laneInfo(req.user, d, lane);
  const visible = req.user.role === 'team' ? LANES : ['client', 'final'];
  const ph = visible.map(() => '?').join(',');
  const comments = db.prepare(`SELECT c.id, c.lane, c.body, c.quote, c.created_at, c.author_id, u.name AS author, u.role AS author_role, u.color AS author_color
                               FROM comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.draft_id = ? AND c.lane IN (${ph}) ORDER BY c.id`).all(d.id, ...visible);
  const activity = db.prepare(`SELECT a.lane, a.action, a.created_at, u.name AS author FROM activity a LEFT JOIN users u ON u.id = a.author_id
                               WHERE a.draft_id = ? AND (a.lane IS NULL OR a.lane IN (${ph})) ORDER BY a.id DESC LIMIT 40`).all(d.id, ...visible);
  // people this viewer may know about: the firm's team plus this matter's client
  const people = db.prepare("SELECT * FROM users WHERE role = 'team' OR id = ?").all(d.client_id ?? -1).map(publicUser);
  const head = people.find((p) => p.head) || null;
  // open associate requests are internal to the firm
  const requests = req.user.role !== 'team' ? [] : db.prepare(`SELECT r.id, r.kind, r.content, r.created_at, r.requested_by, u.name AS requester, u.color AS requester_color
    FROM requests r JOIN users u ON u.id = r.requested_by WHERE r.draft_id = ? AND r.status = 'pending' ORDER BY r.id`).all(d.id);
  res.json({ draft: { ...d, page: pageOf(d), client: d.client_id ? publicUser(getUser(d.client_id)) : null }, lanes, comments, activity, people, head, requests, presence: presenceFor(d.id) });
});

app.patch('/api/drafts/:id', auth, loadDraft, (req, res) => {
  const { status, title } = req.body || {};
  const d = req.draft;
  if (status) {
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
    if (req.user.role !== 'team' && !(status === 'approved' && ['client_review', 'negotiation'].includes(d.status)))
      return res.status(403).json({ error: 'Not permitted' });
    db.prepare('UPDATE drafts SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), d.id);
    logActivity(d.id, null, `set the status to ${status.replace('_', ' ')}`, req.user.id);
  }
  if (title && req.user.role === 'team') db.prepare('UPDATE drafts SET title = ? WHERE id = ?').run(String(title).trim(), d.id);
  broadcast(d.id, 'draft', { by: req.user.name });
  res.json({ ok: true });
});

app.delete('/api/drafts/:id', auth, teamOnly, loadDraft, (req, res) => {
  broadcast(req.draft.id, 'deleted', { by: req.user.name });
  db.prepare('DELETE FROM drafts WHERE id = ?').run(req.draft.id);
  res.json({ ok: true });
});

// --- lanes
app.put('/api/drafts/:id/lanes/:lane', auth, loadDraft, laneParam, (req, res) => {
  const { lane } = req.params;
  if (!canEditLane(req.user, req.draft, lane)) return res.status(403).json({ error: 'You cannot edit this draft' });
  const content = clean(req.body?.content ?? '');
  const prev = latest(req.draft.id, lane);
  // a note marks a deliberate step (e.g. "Imported Lease.docx") as its own version
  const note = req.body?.note ? String(req.body.note).slice(0, 140) : null;
  const setup = cleanPage(req.body?.page); // an imported Word file brings its own page size & margins
  if (setup) { db.prepare('UPDATE drafts SET page_setup = ? WHERE id = ?').run(JSON.stringify(setup), req.draft.id); broadcast(req.draft.id, 'draft', { by: req.user.name, kind: 'page' }); }
  if (!(prev && prev.content === content)) {
    saveLane(req.draft.id, lane, content, req.user, note, !!note);
    if (note) logActivity(req.draft.id, lane, note.charAt(0).toLowerCase() + note.slice(1), req.user.id);
    else if (!prev || prev.author_id !== req.user.id || now() - prev.updated_at > 120000) logActivity(req.draft.id, lane, `edited the ${lane} draft`, req.user.id);
    laneChanged(req.draft.id, lane, req.user);
  }
  res.json({ lane: laneInfo(req.user, req.draft, lane) });
});

// Team Head confirms or rejects pending changes: one hunk, or all of them
app.post('/api/drafts/:id/lanes/:lane/changes', auth, headOnly, loadDraft, laneParam, (req, res) => {
  const { lane } = req.params;
  const { action, hunk, rev } = req.body || {};
  if (!['accept', 'reject'].includes(action)) return res.status(400).json({ error: 'action must be accept or reject' });
  const { stream, rev: cur } = getState(req.draft.id, lane);
  if (rev !== undefined && rev !== cur) return res.status(409).json({ error: 'The draft changed — refreshed, please try again' });
  const target = hunk === 'all' ? 'all' : Number(hunk);
  const { ids } = hunkIds(stream);
  const authors = [...new Set(stream.filter((_, i) => (target === 'all' ? ids[i] >= 0 : ids[i] === target)).map((t) => t.a || t.d))];
  if (!authors.length) return res.status(404).json({ error: 'No such change' });
  const next = resolveHunks(stream, target, action === 'accept');
  putState(req.draft.id, lane, next);
  const names = authors.map((id) => getUser(id)?.name).filter(Boolean).join(', ');
  const what = target === 'all' ? 'all changes' : 'a change';
  if (action === 'reject') recordVersion(req.draft.id, lane, workingText(next), req.user.id, `Rejected ${what} by ${names}`, true);
  else db.prepare('UPDATE drafts SET updated_at = ? WHERE id = ?').run(now(), req.draft.id);
  logActivity(req.draft.id, lane, `${action === 'accept' ? 'confirmed' : 'rejected'} ${what} by ${names}`, req.user.id);
  laneChanged(req.draft.id, lane, req.user, action);
  res.json({ lane: laneInfo(req.user, req.draft, lane) });
});

// Upload the team draft to the clean draft. Only ever runs as the Team Head.
function uploadToClean(draftId, content, head, note) {
  saveLane(draftId, 'final', content, head, note, true);
  // any open "please upload" requests are now answered
  db.prepare("UPDATE requests SET status = 'approved', decided_by = ?, decided_at = ? WHERE draft_id = ? AND status = 'pending'").run(head.id, now(), draftId);
  logActivity(draftId, 'final', 'uploaded the team draft to the clean draft', head.id);
  laneChanged(draftId, 'final', head, 'promote');
}

// The clean draft is always uploaded from the team draft: directly by the Team Head,
// as a request (approved later by the Head) for anyone else on the team.
app.post('/api/drafts/:id/promote', auth, teamOnly, loadDraft, (req, res) => {
  const content = stripTeamNotes(latest(req.draft.id, 'team').content);
  if (!req.user.head) {
    upsertRequest(req.draft.id, 'promote-team', content, req.user.id);
    logActivity(req.draft.id, 'team', `asked to ${REQUEST_WORDS['promote-team']}`, req.user.id);
    broadcast(req.draft.id, 'draft', { by: req.user.name, kind: 'request' });
    return res.status(202).json({ requested: true });
  }
  uploadToClean(req.draft.id, content, req.user, 'Uploaded from the team draft');
  res.json({ ok: true });
});

// Team Head approves or declines an associate's request; the requester (or Head) may withdraw it
app.post('/api/drafts/:id/requests/:rid', auth, teamOnly, loadDraft, (req, res) => {
  const r = db.prepare("SELECT * FROM requests WHERE id = ? AND draft_id = ? AND status = 'pending'").get(Number(req.params.rid), req.draft.id);
  if (!r) return res.status(404).json({ error: 'That request is no longer open' });
  const decision = req.body?.decision;
  const requester = getUser(r.requested_by);
  if (decision === 'withdraw') {
    if (r.requested_by !== req.user.id && !req.user.head) return res.status(403).json({ error: 'Not your request' });
  } else {
    if (!req.user.head) return res.status(403).json({ error: 'Only the Team Head can approve requests' });
    if (!['approve', 'decline'].includes(decision)) return res.status(400).json({ error: 'decision must be approve, decline or withdraw' });
  }
  const status = { approve: 'approved', decline: 'declined', withdraw: 'withdrawn' }[decision];
  db.prepare('UPDATE requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?').run(status, req.user.id, now(), r.id);
  if (decision === 'approve') uploadToClean(req.draft.id, r.content, req.user, `Uploaded at ${requester.name}'s request`);
  logActivity(req.draft.id, 'team', decision === 'withdraw' ? `withdrew a request to ${REQUEST_WORDS[r.kind]}`
    : `${status} ${requester.name}'s request to ${REQUEST_WORDS[r.kind]}`, req.user.id);
  broadcast(req.draft.id, 'draft', { by: req.user.name, kind: status });
  res.json({ ok: true, status });
});

app.get('/api/drafts/:id/history/:lane', auth, loadDraft, laneParam, (req, res) => {
  const rows = db.prepare(`SELECT v.id, v.content, v.note, v.created_at, v.updated_at, u.name AS author, u.color AS author_color FROM versions v
                           LEFT JOIN users u ON u.id = v.author_id WHERE v.draft_id = ? AND v.lane = ? ORDER BY v.id DESC LIMIT 50`).all(req.draft.id, req.params.lane);
  res.json({ versions: rows });
});

app.post('/api/drafts/:id/history/:lane/:versionId/restore', auth, loadDraft, laneParam, (req, res) => {
  const { lane } = req.params;
  if (!canEditLane(req.user, req.draft, lane) && !(lane === 'final' && req.user.head)) return res.status(403).json({ error: 'Not permitted' });
  const old = db.prepare('SELECT * FROM versions WHERE id = ? AND draft_id = ? AND lane = ?').get(Number(req.params.versionId), req.draft.id, lane);
  if (!old) return res.status(404).json({ error: 'Version not found' });
  saveLane(req.draft.id, lane, old.content, req.user, `Restored version #${old.id}`, true);
  logActivity(req.draft.id, lane, `restored an earlier ${lane} version`, req.user.id);
  laneChanged(req.draft.id, lane, req.user, 'restore');
  res.json({ lane: laneInfo(req.user, req.draft, lane) });
});

// --- comments
app.post('/api/drafts/:id/comments', auth, loadDraft, (req, res) => {
  const { lane, body } = req.body || {};
  if (!LANES.includes(lane) || !canSeeLane(req.user, lane)) return res.status(400).json({ error: 'Unknown lane' });
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Comment is empty' });
  const quote = req.body?.quote ? String(req.body.quote).replace(/\s+/g, ' ').trim().slice(0, 300) || null : null;
  const t = now();
  const id = db.prepare('INSERT INTO comments (draft_id, lane, body, quote, author_id, created_at) VALUES (?,?,?,?,?,?)')
    .run(req.draft.id, lane, String(body).trim(), quote, req.user.id, t).lastInsertRowid;
  const comment = { id, lane, body: String(body).trim(), quote, created_at: t, author_id: req.user.id, author: req.user.name, author_role: req.user.role, author_color: req.user.color };
  broadcast(req.draft.id, 'comment', { comment }, { lane });
  res.json({ comment });
});

// Delete a remark: its author can, and so can the Team Head
app.delete('/api/drafts/:id/comments/:cid', auth, loadDraft, (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ? AND draft_id = ?').get(Number(req.params.cid), req.draft.id);
  if (!c || !canSeeLane(req.user, c.lane)) return res.status(404).json({ error: 'Remark not found' });
  if (c.author_id !== req.user.id && !req.user.head) return res.status(403).json({ error: 'Only the author or the Team Head can delete this remark' });
  db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
  broadcast(req.draft.id, 'comment-deleted', { id: c.id, by: req.user.name }, { lane: c.lane });
  res.json({ ok: true });
});

// --- live typing indicator
app.post('/api/drafts/:id/typing', auth, loadDraft, (req, res) => {
  const lane = req.body?.lane;
  if (LANES.includes(lane) && canSeeLane(req.user, lane))
    broadcast(req.draft.id, 'typing', { user: req.user.name, color: req.user.color }, { lane, excludeUserId: req.user.id });
  res.json({ ok: true });
});

// --- Word export: the formatted working document as .docx
const LANE_TITLES = { client: 'Client Draft', final: 'Clean Draft', team: 'Team Draft — Privileged & Confidential' };
app.get('/api/drafts/:id/lanes/:lane/docx', auth, loadDraft, laneParam, async (req, res) => {
  const { lane } = req.params;
  const d = req.draft;
  const html = latest(d.id, lane)?.content || '<p></p>';
  const header = `<p style="text-align: right; font-size: 8pt; color: #555555">${d.matter_no}  ·  ${LANE_TITLES[lane].toUpperCase()}</p>`;
  const footer = `<p style="text-align: center; font-size: 8pt; color: #555555">Exported ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</p>`;
  try {
    const buf = await HTMLtoDOCX(`<!DOCTYPE html><html><body>${html}</body></html>`, header, {
      title: `${d.title} — ${LANE_TITLES[lane]}`, creator: 'LexDraft', font: 'Garamond', fontSize: 24,
      header: true, footer: true, pageNumber: true,
      orientation: pageOf(d).w > pageOf(d).h ? 'landscape' : 'portrait',
      pageSize: { width: pageOf(d).w, height: pageOf(d).h },
      margins: { top: pageOf(d).top, right: pageOf(d).right, bottom: pageOf(d).bottom, left: pageOf(d).left, header: 720, footer: 720 },
      table: { row: { cantSplit: true } },
    }, footer);
    const name = `${d.matter_no} ${d.title} - ${LANE_TITLES[lane].split(' —')[0]}.docx`.replace(/[\\/:*?"<>|]/g, '-');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '-')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('Word export failed', err);
    res.status(500).json({ error: 'Word export failed' });
  }
});

// --- PDF export: the formatted working document, typeset in EB Garamond (real, selectable text)
const GARAMOND = path.join(__dirname, 'node_modules', '@fontsource', 'eb-garamond', 'files', 'eb-garamond-latin-');
// Free fonts with the same character widths as Word's usual fonts, so PDF lines and pages break as in Word.
const fontFiles = (pkg) => {
  const f = path.join(__dirname, 'node_modules', '@fontsource', pkg, 'files', `${pkg}-latin-`);
  return { normal: `${f}400-normal.woff`, bold: `${f}700-normal.woff`, italics: `${f}400-italic.woff`, bolditalics: `${f}700-italic.woff` };
};
const pdfPrinter = new PdfPrinter({
  Garamond: { normal: `${GARAMOND}400-normal.woff`, bold: `${GARAMOND}700-normal.woff`, italics: `${GARAMOND}400-italic.woff`, bolditalics: `${GARAMOND}700-italic.woff` },
  Tinos: fontFiles('tinos'),     // = Times New Roman
  Arimo: fontFiles('arimo'),     // = Arial / Helvetica
  Carlito: fontFiles('carlito'), // = Calibri
  Cousine: fontFiles('cousine'), // = Courier New
});
function pdfFont(name) {
  const n = String(name).toLowerCase().replace(/['"\s]/g, '');
  if (/garamond/.test(n)) return 'Garamond';
  if (/calibri|carlito|aptos|candara|corbel/.test(n)) return 'Carlito';
  if (/courier|consolas|mono|cousine/.test(n)) return 'Cousine';
  if (/arial|helvetica|verdana|tahoma|segoe|inter|roboto|sans|arimo|gill|trebuchet/.test(n)) return 'Arimo';
  if (/times|georgia|cambria|antiqua|palatino|serif|tinos|bookman|century/.test(n)) return 'Tinos';
  return 'Garamond';
}
function mapFonts(node) {
  if (Array.isArray(node)) return node.forEach(mapFonts);
  if (!node || typeof node !== 'object') return;
  if (node.font) node.font = pdfFont(node.font);
  for (const k of ['stack', 'text', 'ul', 'ol', 'columns']) if (node[k]) mapFonts(node[k]);
  if (node.table?.body) node.table.body.forEach(mapFonts);
}
const pdfWindow = new JSDOM('').window;
function fitImages(node, width, height) { // keep pictures inside the page's text area (points)
  if (Array.isArray(node)) return node.forEach((n) => fitImages(n, width, height));
  if (!node || typeof node !== 'object') return;
  if (node.image && !node.fit) { delete node.width; delete node.height; node.fit = [width, height]; }
  for (const k of ['stack', 'text', 'ul', 'ol', 'columns']) if (node[k]) fitImages(node[k], width, height);
  if (node.table?.body) node.table.body.forEach((row) => fitImages(row, width, height));
}
app.get('/api/drafts/:id/lanes/:lane/pdf', auth, loadDraft, laneParam, (req, res) => {
  const { lane } = req.params;
  const d = req.draft;
  const pg = pageOf(d); // page size & margins, in twips
  try {
    const html = (latest(d.id, lane)?.content || '<p></p>')
      .replace(/<div class="page-break"[^>]*><\/div>/g, '<div class="pdf-pagebreak-before"></div>');
    const content = htmlToPdfmake(html, {
      window: pdfWindow, tableAutoSize: true,
      defaultStyles: {
        h1: { fontSize: 20, bold: true, marginBottom: 14 }, h2: { fontSize: 16, bold: true, marginTop: 10, marginBottom: 6 },
        h3: { fontSize: 13, bold: true, marginTop: 10, marginBottom: 4 }, h4: { fontSize: 12, bold: true, italics: true, marginTop: 8 },
        p: { margin: [0, 0, 0, 8] }, blockquote: { italics: true, margin: [18, 4, 0, 8], color: '#444444' },
      },
    });
    fitImages(content, (pg.w - pg.left - pg.right) / 20, (pg.h - pg.top - pg.bottom) / 20);
    mapFonts(content);
    const doc = pdfPrinter.createPdfKitDocument({
      info: { title: `${d.title} — ${LANE_TITLES[lane]}`, author: 'LexDraft', creator: 'LexDraft' },
      pageSize: { width: pg.w / 20, height: pg.h / 20 }, pageMargins: [pg.left / 20, pg.top / 20, pg.right / 20, pg.bottom / 20],
      defaultStyle: { font: 'Garamond', fontSize: 12, lineHeight: 1.25 },
      header: () => ({ text: `${d.matter_no}  ·  ${LANE_TITLES[lane].toUpperCase()}`, alignment: 'right', fontSize: 8, color: '#555555', margin: [pg.left / 20, Math.min(34, pg.top / 40), pg.right / 20, 0] }),
      footer: (page, pages) => ({ text: `Page ${page} of ${pages}`, alignment: 'center', fontSize: 9, color: '#555555', margin: [pg.left / 20, Math.min(26, pg.bottom / 40), pg.right / 20, 0] }),
      content,
    });
    const name = `${d.matter_no} ${d.title} - ${LANE_TITLES[lane].split(' —')[0]}.pdf`.replace(/[\\/:*?"<>|]/g, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '-')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    console.error('PDF export failed', err);
    res.status(500).json({ error: 'PDF export failed' });
  }
});

// --- SSE stream, scoped to one open draft for presence
app.get('/api/events', auth, (req, res) => {
  const draftId = Number(req.query.draft) || null;
  if (draftId && !canSeeDraft(req.user, db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId))) return res.status(404).end();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  const stream = { res, user: req.user, draftId };
  streams.add(stream);
  if (draftId) broadcast(draftId, 'presence', { users: presenceFor(draftId) });
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    streams.delete(stream);
    if (draftId) broadcast(draftId, 'presence', { users: presenceFor(draftId) });
  });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`LexDraft running at http://localhost:${PORT}`));
