// Tabellio — three-lane legal drafting server
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
const { sendMail, mailConfigured } = require('./lib/mailer');
const { TEMPLATES, render: renderTemplate } = require('./lib/templates');
const { OAuth2Client } = require('google-auth-library');
const jose = require('jose');
const pdfParse = require('pdf-parse/lib/pdf-parse.js'); // PDF → text

const PORT = process.env.PORT || 3000;
// Serverless hosts (Vercel) only allow writing to /tmp — which is temporary there.
const DB_PATH = process.env.DB_PATH || (process.env.VERCEL ? '/tmp/lexdraft.db' : path.join(__dirname, 'lexdraft.db'));
// With TURSO_DATABASE_URL set, everything lives in a Turso cloud database (SQLite, kept permanently),
// so the site can run on hosts with no lasting disk, like Vercel. Otherwise it's a local SQLite file.
const CLOUD_DB = process.env.TURSO_DATABASE_URL || '';
function openCloudDb(url, authToken) {
  const raw = new (require('libsql'))(url, { authToken });
  const strip = (row) => { if (row) delete row._metadata; return row; };
  return {
    exec: (sql) => raw.exec(sql),
    prepare(sql) {
      const st = raw.prepare(sql);
      return { get: (...a) => strip(st.get(...a)), all: (...a) => st.all(...a).map(strip), run: (...a) => st.run(...a) };
    },
  };
}
const db = CLOUD_DB ? openCloudDb(CLOUD_DB, process.env.TURSO_AUTH_TOKEN) : new DatabaseSync(DB_PATH);
const LANES = ['client', 'final', 'team'];
const STATUSES = ['drafting', 'client_review', 'negotiation', 'approved', 'executed'];
// Distinct, legible-on-paper colours handed out to users in order
const PALETTE = ['#3b4fd8', '#0f8a7e', '#d0571b', '#a23ec9', '#c2283f', '#2f8f2f', '#b8860b', '#1f7fbf', '#8a5a2b', '#d63d8f'];

// ---------- schema ----------
if (!CLOUD_DB) db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
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
    matter_date TEXT,         -- a date the lawyer sets for the matter (hearing, deadline, signing…), YYYY-MM-DD
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
  -- who may see a matter (besides the Team Head and the lawyer who opened it), by email
  CREATE TABLE IF NOT EXISTS matter_access (
    draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    added_by INTEGER REFERENCES users(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (draft_id, email)
  );
  -- private links that let one person into one matter without a password (only a hash is stored)
  CREATE TABLE IF NOT EXISTS share_links (
    token_hash TEXT PRIMARY KEY,
    draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
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

try { db.exec('ALTER TABLE drafts ADD COLUMN matter_date TEXT'); } catch { /* already there */ }
// newer columns, added to existing databases
for (const sql of [
  'ALTER TABLE share_links ADD COLUMN name TEXT',                          // the client name the link expects
  'ALTER TABLE share_links ADD COLUMN attempts INTEGER DEFAULT 0',         // wrong-name tries
  'ALTER TABLE users ADD COLUMN perm_upload INTEGER NOT NULL DEFAULT 0',   // associate may upload to the clean draft
  'ALTER TABLE users ADD COLUMN perm_confirm INTEGER NOT NULL DEFAULT 0',  // associate may confirm/reject changes
  'ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0',      // removed from the team
  'ALTER TABLE users ADD COLUMN firm_id INTEGER',                          // the law firm a lawyer belongs to (clients: none)
  'ALTER TABLE drafts ADD COLUMN firm_id INTEGER',                         // the firm that owns the matter
]) { try { db.exec(sql); } catch { /* already there */ } }
// Each law firm is its own private workspace with its own Team Head, team, matters and plan.
db.exec(`CREATE TABLE IF NOT EXISTS firms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at INTEGER NOT NULL
)`);

// ---------- plans (freemium) ----------
// seats = lawyers in the firm, Team Head included. Prices are per month.
const PLANS = {
  free: { id: 'free', name: 'Free', price: 0, seats: 2, matters: 5 },
  team: { id: 'team', name: 'Team', price: 250, seats: 5, matters: null },
  firm: { id: 'firm', name: 'Firm', price: 450, seats: 10, matters: null },
};
const CURRENCY = process.env.PLAN_CURRENCY || '₹';
const getFirm = (id) => (id ? db.prepare('SELECT * FROM firms WHERE id = ?').get(id) : null);
const planOf = (firm) => PLANS[firm?.plan] || PLANS.free;
const seatsUsed = (firmId) => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'team' AND disabled = 0 AND firm_id = ?").get(firmId).n;
const mattersUsed = (firmId) => db.prepare('SELECT COUNT(*) AS n FROM drafts WHERE firm_id = ?').get(firmId).n;
function createFirm(name) {
  return db.prepare('INSERT INTO firms (name, plan, created_at) VALUES (?,?,?)').run(String(name || 'My firm').trim().slice(0, 80) || 'My firm', 'free', Date.now()).lastInsertRowid;
}
// what a person may do: the Team Head can do everything; associates as the Team Head allows
const canUploadClean = (u) => !!u?.head || (u?.role === 'team' && !!u.perm_upload);
const canConfirm = (u) => !!u?.head || (u?.role === 'team' && !!u.perm_confirm);

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
const publicUser = (u) => u && ({ id: u.id, name: u.name, email: u.email, role: u.role, title: u.title, color: u.color, head: !!u.head,
  canUpload: canUploadClean(u), canConfirm: canConfirm(u) });
// the signed-in person's own view of their firm and plan
function firmInfo(u) {
  if (u?.role !== 'team' || !u.firm_id) return null;
  const f = getFirm(u.firm_id), p = planOf(f);
  return { id: f.id, name: f.name, plan: p.id, seats: p.seats, seatsUsed: seatsUsed(f.id), matters: p.matters, mattersUsed: mattersUsed(f.id) };
}
const meUser = (u) => u && { ...publicUser(u), firm: firmInfo(u) };
// a new law firm: its own workspace on the Free plan, with this person as Team Head
function createHead(name, email, passHash, firmName) {
  const fid = createFirm(firmName || `${String(name).trim()}'s firm`);
  return db.prepare('INSERT INTO users (name, email, role, title, color, head, pass_hash, firm_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(String(name).trim().slice(0, 80), email, 'team', 'Team Head', PALETTE[0], 1, passHash, fid, Date.now()).lastInsertRowid;
}
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
      'letter-spacing': [/^(normal|-?\d+(\.\d+)?(pt|px|em))$/],
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
  putState(draftId, lane, applyEdit(stream, content, user.id, canConfirm(user))); // confirmers' edits need no confirming
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

// Every matter is private. It is visible only to: the Team Head, the lawyer who opened it,
// its client, and the email addresses it has been shared with. Checked on every request.
function hasAccess(user, draftId) {
  return !!db.prepare('SELECT 1 FROM matter_access WHERE draft_id = ? AND email = ?').get(draftId, String(user.email).toLowerCase());
}
function canSeeDraft(user, draft) {
  if (!draft || !user) return false;
  // a lawyer never sees another firm's matters, even if someone shares one with them
  if (user.role === 'team' && draft.firm_id !== user.firm_id) return false;
  return !!user.head || draft.created_by === user.id || draft.client_id === user.id || hasAccess(user, draft.id);
}
function grantAccess(draftId, email, byId) {
  db.prepare('INSERT OR IGNORE INTO matter_access (draft_id, email, added_by, created_at) VALUES (?,?,?,?)').run(draftId, String(email).toLowerCase().trim(), byId ?? null, now());
}
function canSeeLane(user, lane) { return lane !== 'team' || user.role === 'team'; }
function canEditLane(user, draft, lane) {
  // nobody types into the clean draft: it only ever changes when the Team Head uploads the team draft
  if (lane === 'final') return false;
  if (user.role === 'team') return true;
  return lane === 'client' && canSeeDraft(user, draft) && !['approved', 'executed'].includes(draft.status);
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
// Demo accounts & sample matters exist only for local testing. On a live server (NODE_ENV=production,
// or DEMO=false) none are created: the Team Head comes from the HEAD_EMAIL / HEAD_PASSWORD / HEAD_NAME settings.
const LIVE = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
// On Vercel without a cloud database, data lives in /tmp and resets, so it runs as a demo with sample accounts.
const DEMO = process.env.DEMO ? process.env.DEMO === 'true' : ((!!process.env.VERCEL && !CLOUD_DB) || !LIVE);
if (!DEMO && db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
  const email = String(process.env.HEAD_EMAIL || '').toLowerCase().trim();
  const pw = String(process.env.HEAD_PASSWORD || '');
  if (email && pw.length >= 8) {
    db.prepare('INSERT INTO users (name, email, role, title, color, head, pass_hash, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(process.env.HEAD_NAME || 'Team Head', email, 'team', 'Team Head', PALETTE[0], 1, hashPassword(pw), now());
    console.log(`Created the Team Head account for ${email}`);
  } else {
    console.warn('No accounts yet: set HEAD_EMAIL and HEAD_PASSWORD (8+ characters) to create the Team Head.');
  }
}
if (DEMO && db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
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
  grantAccess(draftId, associate.email, counsel.id);
  grantAccess(draftId, client.email, counsel.id);

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
// Lawyers and matters from before firms existed (or from the seed above) become one firm.
if (db.prepare("SELECT 1 FROM users WHERE role = 'team' AND firm_id IS NULL").get()) {
  const fid = createFirm(process.env.FIRM_NAME || (DEMO ? 'Raman & Associates' : 'My firm'));
  db.prepare("UPDATE users SET firm_id = ? WHERE role = 'team' AND firm_id IS NULL").run(fid);
  db.prepare('UPDATE drafts SET firm_id = ? WHERE firm_id IS NULL').run(fid);
  if (DEMO) db.prepare("UPDATE firms SET plan = 'team' WHERE id = ?").run(fid); // the demo firm shows a paid plan
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
app.set('trust proxy', 1); // Render/other hosts sit behind a proxy: use the real https address
app.use(express.json({ limit: '15mb' })); // room for pasted images
app.use(express.static(path.join(__dirname, 'public')));

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((c) => {
    const i = c.indexOf('=');
    return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
  }));
}
// Sessions. With SESSION_SECRET set (do this on any serverless host), the cookie itself is signed,
// so every server instance can verify it. Without it, sessions live in the database.
const SESSION_SECRET = process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16 ? process.env.SESSION_SECRET
  : process.env.VERCEL ? 'tabellio-vercel-demo-only-secret' : null; // Vercel demo: cookies must survive across instances
const SESSION_DAYS = 14;
const sign = (data) => crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
function userFromToken(token) {
  if (!token) return null;
  if (SESSION_SECRET && token.startsWith('s.')) {
    const [, uid, exp, sig] = token.split('.');
    const expected = sign(`${uid}.${exp}`);
    if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    if (Number(exp) < Date.now()) return null;
    const u = getUser(Number(uid));
    return u && !u.disabled ? u : null;
  }
  return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.disabled = 0').get(token) || null;
}
function auth(req, res, next) {
  const row = userFromToken(parseCookies(req).lex_session);
  if (!row) return res.status(401).json({ error: 'Not signed in' });
  req.user = row;
  next();
}
const teamOnly = (req, res, next) => (req.user.role === 'team' ? next() : res.status(403).json({ error: 'Legal team only' }));
const headOnly = (req, res, next) => (req.user.head ? next() : res.status(403).json({ error: 'Only the Team Head can do this' }));
const confirmerOnly = (req, res, next) => (canConfirm(req.user) ? next() : res.status(403).json({ error: 'Only the Team Head (or an associate they allow) can confirm changes' }));
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
const SECURE = process.env.VERCEL || process.env.RENDER || process.env.NODE_ENV === 'production' ? '; Secure' : '';
function startSession(res, userId) {
  let token;
  if (SESSION_SECRET) {
    const exp = Date.now() + SESSION_DAYS * 86400000;
    token = `s.${userId}.${exp}.${sign(`${userId}.${exp}`)}`;
  } else {
    token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)').run(token, userId, now());
  }
  res.setHeader('Set-Cookie', `lex_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * SESSION_DAYS}${SECURE}`);
}

// --- auth
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase().trim());
  if (user?.disabled) return res.status(401).json({ error: 'This account has been removed from the firm' });
  if (user?.pass_hash?.startsWith('!')) return res.status(401).json({ error: 'This account signs in with Google — use the Google button' });
  if (user && !user.pass_hash) return res.status(401).json({ error: 'Your lawyer has set up this account — choose your password under "Set up account" to activate it' });
  if (!user || !verifyPassword(String(password || ''), user.pass_hash)) return res.status(401).json({ error: 'Invalid email or password' });
  startSession(res, user.id);
  res.json({ user: meUser(user) });
});
app.post('/api/auth/register', (req, res) => {
  const { name, email, password, company } = req.body || {};
  if (!name || !email || !password || password.length < 6) return res.status(400).json({ error: 'Name, email and a 6+ character password are required' });
  const em = String(email).toLowerCase().trim();
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(em);
  if (existing && !existing.pass_hash) { // invited by the firm (client or lawyer): claim it
    // a client the firm added with a new matter: claim the account by setting a password
    db.prepare('UPDATE users SET pass_hash = ?, title = COALESCE(title, ?) WHERE id = ?').run(hashPassword(password), company || null, existing.id);
    startSession(res, existing.id);
    return res.json({ user: meUser(getUser(existing.id)) });
  }
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });
  // Self-registration: a client, or a new law firm (its founder becomes the Team Head, on the Free plan).
  // Associates are added by their Team Head.
  const id = req.body?.kind === 'firm'
    ? createHead(name, em, hashPassword(password), req.body?.firmName)
    : db.prepare('INSERT INTO users (name, email, role, title, color, pass_hash, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(String(name).trim(), em, 'client', company || null, nextColor(), hashPassword(password), now()).lastInsertRowid;
  startSession(res, id);
  res.json({ user: meUser(getUser(id)) });
});
app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req).lex_session;
  if (token && !token.startsWith('s.')) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', `lex_session=; HttpOnly; Path=/; Max-Age=0${SECURE}`);
  res.json({ ok: true });
});
app.get('/api/me', auth, (req, res) => res.json({ user: meUser(req.user) }));
app.get('/api/clients', auth, teamOnly, (req, res) => {
  // only this firm's clients: people on its matters, or shared into them
  res.json({ clients: db.prepare(`SELECT id, name, email, title, color, pass_hash != '' AS active FROM users u WHERE role = 'client' AND (
      id IN (SELECT client_id FROM drafts WHERE firm_id = ?)
      OR email IN (SELECT a.email FROM matter_access a JOIN drafts d ON d.id = a.draft_id WHERE d.firm_id = ?)) ORDER BY name`).all(req.user.firm_id, req.user.firm_id) });
});

// --- drafts
app.get('/api/drafts', auth, (req, res) => {
  const base = 'SELECT d.*, c.name AS client_name FROM drafts d LEFT JOIN users c ON c.id = d.client_id';
  const own = 'd.created_by = ? OR d.client_id = ? OR EXISTS (SELECT 1 FROM matter_access a WHERE a.draft_id = d.id AND a.email = ?)';
  const me = [req.user.id, req.user.id, String(req.user.email).toLowerCase()];
  const rows = req.user.head
    ? db.prepare(`${base} WHERE d.firm_id = ? ORDER BY d.updated_at DESC`).all(req.user.firm_id)
    : req.user.role === 'team'
      ? db.prepare(`${base} WHERE d.firm_id = ? AND (${own}) ORDER BY d.updated_at DESC`).all(req.user.firm_id, ...me)
      : db.prepare(`${base} WHERE ${own} ORDER BY d.updated_at DESC`).all(...me);
  res.json({ drafts: rows });
});

// Open a new matter. The client can be an existing one, or a brand-new client added right here:
// they get an invited account and choose their own password the first time they sign up with that email.
app.post('/api/drafts', auth, teamOnly, (req, res) => {
  const { title, clientId, newClient, counterparty, contentHtml, sourceName, page, matterDate } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Matter title is required' });
  const plan = planOf(getFirm(req.user.firm_id));
  if (plan.matters && mattersUsed(req.user.firm_id) >= plan.matters) {
    return res.status(402).json({ error: `The ${plan.name} plan includes ${plan.matters} matters. Upgrade your plan to open more.`, upgrade: true });
  }
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
  const count = mattersUsed(req.user.firm_id);
  const matterNo = `LD-${new Date().getFullYear()}-${String(140 + count + 1).padStart(4, '0')}`;
  const setup = cleanPage(page);
  const md = /^\d{4}-\d{2}-\d{2}$/.test(String(matterDate || '')) ? matterDate : null;
  const id = db.prepare('INSERT INTO drafts (title, matter_no, client_id, counterparty, page_setup, matter_date, status, created_by, firm_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(String(title).trim(), matterNo, cid, String(counterparty || '').trim() || null, setup ? JSON.stringify(setup) : null, md, 'drafting', req.user.id, req.user.firm_id, t, t).lastInsertRowid;
  const imported = contentHtml && clean(contentHtml).replace(/<[^>]+>/g, '').trim() ? clean(contentHtml) : null;
  const cl = cid ? getUser(cid) : null;
  const tpl = TEMPLATES.some((x) => x.id === req.body?.template) ? req.body.template : 'blank';
  const body = imported || templateHtml(tpl, { title, client: cl?.name, company: cl?.title, counterparty, lawyer: req.user.name });
  if (cl) grantAccess(id, cl.email, req.user.id);
  const note = imported ? `Imported ${String(sourceName || 'document').slice(0, 100)}` : `New ${TEMPLATES.find((x) => x.id === tpl).name.toLowerCase()}`;
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
  const people = db.prepare("SELECT * FROM users WHERE (role = 'team' AND firm_id = ?) OR id = ?").all(d.firm_id ?? -1, d.client_id ?? -1).map(publicUser);
  const head = people.find((p) => p.head) || null;
  // open associate requests are internal to the firm
  const requests = req.user.role !== 'team' ? [] : db.prepare(`SELECT r.id, r.kind, r.content, r.created_at, r.requested_by, u.name AS requester, u.color AS requester_color
    FROM requests r JOIN users u ON u.id = r.requested_by WHERE r.draft_id = ? AND r.status = 'pending' ORDER BY r.id`).all(d.id);
  res.json({ draft: { ...d, page: pageOf(d), client: d.client_id ? publicUser(getUser(d.client_id)) : null }, lanes, comments, activity, people, head, requests, presence: presenceFor(d.id) });
});

app.patch('/api/drafts/:id', auth, loadDraft, (req, res) => {
  const { status, title } = req.body || {};
  const d = req.draft;
  if ('matterDate' in (req.body || {}) && req.user.role === 'team') {
    const md = String(req.body.matterDate || '');
    if (md && !/^\d{4}-\d{2}-\d{2}$/.test(md)) return res.status(400).json({ error: 'Invalid date' });
    db.prepare('UPDATE drafts SET matter_date = ?, updated_at = ? WHERE id = ?').run(md || null, now(), d.id);
    logActivity(d.id, null, md ? `set the matter date to ${md}` : 'cleared the matter date', req.user.id);
  }
  if (status) {
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
    if (req.user.role !== 'team' && !(status === 'approved' && !['approved', 'executed'].includes(d.status)))
      return res.status(403).json({ error: 'Not permitted' });
    db.prepare('UPDATE drafts SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), d.id);
    logActivity(d.id, null, `set the status to ${status.replace('_', ' ')}`, req.user.id);
  }
  if (req.user.role === 'team') {
    if (title !== undefined) {
      const t = String(title).trim().slice(0, 200);
      if (!t) return res.status(400).json({ error: 'The matter needs a name' });
      if (t !== d.title) { db.prepare('UPDATE drafts SET title = ? WHERE id = ?').run(t, d.id); logActivity(d.id, null, `renamed the matter to "${t}"`, req.user.id); }
    }
    if ('counterparty' in (req.body || {})) {
      db.prepare('UPDATE drafts SET counterparty = ? WHERE id = ?').run(String(req.body.counterparty || '').trim().slice(0, 200) || null, d.id);
    }
    if ('clientId' in (req.body || {})) {
      const cid = req.body.clientId ? Number(req.body.clientId) : null;
      const cl = cid ? db.prepare("SELECT * FROM users WHERE id = ? AND role = 'client'").get(cid) : null;
      if (cid && !cl) return res.status(400).json({ error: 'Unknown client' });
      db.prepare('UPDATE drafts SET client_id = ? WHERE id = ?').run(cl ? cl.id : null, d.id);
      if (cl) grantAccess(d.id, cl.email, req.user.id); // the new client can see the matter
      logActivity(d.id, null, cl ? `set the client to ${cl.name}` : 'removed the client', req.user.id);
    }
    db.prepare('UPDATE drafts SET updated_at = ? WHERE id = ?').run(now(), d.id);
  }
  broadcast(d.id, 'draft', { by: req.user.name });
  res.json({ ok: true });
});

// Deleting a matter removes everything in it: only the legal team (Team Head and associates) who can see it — never clients.
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
app.post('/api/drafts/:id/lanes/:lane/changes', auth, confirmerOnly, loadDraft, laneParam, (req, res) => {
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
// everyone outside the firm who may see the matter
function matterClients(draftId) {
  const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
  const emails = new Set(db.prepare('SELECT email FROM matter_access WHERE draft_id = ?').all(draftId).map((r) => r.email));
  if (d?.client_id) emails.add(getUser(d.client_id)?.email);
  return [...emails].filter(Boolean).map((e) => db.prepare('SELECT * FROM users WHERE email = ?').get(e) || { email: e, role: 'client' })
    .filter((u) => u.role !== 'team');
}
function notifyCleanDraft(draftId, head, origin) {
  const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
  for (const c of matterClients(draftId)) {
    const link = makeShareLink(draftId, c.email, head.id, origin);
    sendMail({
      to: c.email,
      subject: `Clean draft updated — ${d.title}`,
      heading: 'Your clean draft has been updated',
      lines: [`Dear ${c.name || 'client'},`, `${head.name} has updated the clean draft of "${d.title}" (${d.matter_no}).`, 'Use the button below to read it. The link is personal to you.'],
      button: 'Open the clean draft', url: link,
      footer: 'Sent by Tabellio. If you were not expecting this email, you can ignore it.',
    });
  }
}
function uploadToClean(draftId, content, head, note, origin) {
  saveLane(draftId, 'final', content, head, note, true);
  // any open "please upload" requests are now answered
  db.prepare("UPDATE requests SET status = 'approved', decided_by = ?, decided_at = ? WHERE draft_id = ? AND status = 'pending'").run(head.id, now(), draftId);
  logActivity(draftId, 'final', 'uploaded the team draft to the clean draft', head.id);
  notifyCleanDraft(draftId, head, origin);
  laneChanged(draftId, 'final', head, 'promote');
}

// The clean draft is always uploaded from the team draft: directly by the Team Head,
// as a request (approved later by the Head) for anyone else on the team.
app.post('/api/drafts/:id/promote', auth, teamOnly, loadDraft, (req, res) => {
  const content = stripTeamNotes(latest(req.draft.id, 'team').content);
  if (!canUploadClean(req.user)) {
    upsertRequest(req.draft.id, 'promote-team', content, req.user.id);
    logActivity(req.draft.id, 'team', `asked to ${REQUEST_WORDS['promote-team']}`, req.user.id);
    broadcast(req.draft.id, 'draft', { by: req.user.name, kind: 'request' });
    return res.status(202).json({ requested: true });
  }
  uploadToClean(req.draft.id, content, req.user, 'Uploaded from the team draft', originOf(req));
  res.json({ ok: true });
});

// Send the team draft to the client draft (team-only remarks stripped), so the client sees the
// firm's edited version. Same right as uploading to the clean draft: the Head, or associates allowed to.
app.post('/api/drafts/:id/to-client', auth, teamOnly, loadDraft, (req, res) => {
  if (!canUploadClean(req.user)) return res.status(403).json({ error: 'Only the Team Head (or someone they allow) can send the team draft to the client' });
  const content = stripTeamNotes(latest(req.draft.id, 'team').content);
  saveLane(req.draft.id, 'client', content, req.user, 'Sent from the team draft', true);
  logActivity(req.draft.id, 'client', 'sent the team draft to the client draft', req.user.id);
  laneChanged(req.draft.id, 'client', req.user, 'promote');
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
    if (!canUploadClean(req.user)) return res.status(403).json({ error: 'Only the Team Head (or an associate they allow) can approve uploads' });
    if (!['approve', 'decline'].includes(decision)) return res.status(400).json({ error: 'decision must be approve, decline or withdraw' });
  }
  const status = { approve: 'approved', decline: 'declined', withdraw: 'withdrawn' }[decision];
  db.prepare('UPDATE requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?').run(status, req.user.id, now(), r.id);
  if (decision === 'approve') uploadToClean(req.draft.id, r.content, req.user, `Uploaded at ${requester.name}'s request`, originOf(req));
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
  if (!canEditLane(req.user, req.draft, lane) && !(lane === 'final' && canUploadClean(req.user))) return res.status(403).json({ error: 'Not permitted' });
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
      title: `${d.title} — ${LANE_TITLES[lane]}`, creator: 'Tabellio', font: 'Garamond', fontSize: 24,
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
      info: { title: `${d.title} — ${LANE_TITLES[lane]}`, author: 'Tabellio', creator: 'Tabellio' },
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

// ---------- templates: new documents made inside Tabellio ----------
function templateHtml(id, ctx) {
  const html = clean(textToHtml(renderTemplate(id, ctx)));
  return id === 'blank' ? `${html}<p><br /></p>` : html;
}
function draftContext(d, user) {
  const cl = d.client_id ? getUser(d.client_id) : null;
  return { title: d.title, client: cl?.name, company: cl?.title, counterparty: d.counterparty, lawyer: user.name };
}
app.get('/api/templates', auth, teamOnly, (req, res) => res.json({ templates: TEMPLATES }));
// start the team draft afresh from a template (the old text stays in History)
app.post('/api/drafts/:id/lanes/:lane/new-document', auth, teamOnly, loadDraft, laneParam, (req, res) => {
  const { lane } = req.params;
  if (lane !== 'team') return res.status(400).json({ error: 'New documents are started in the team draft' });
  const tpl = TEMPLATES.find((x) => x.id === req.body?.template) || TEMPLATES[0];
  saveLane(req.draft.id, lane, templateHtml(tpl.id, draftContext(req.draft, req.user)), req.user, `New document: ${tpl.name}`, true);
  logActivity(req.draft.id, lane, `started a new document (${tpl.name.toLowerCase()})`, req.user.id);
  laneChanged(req.draft.id, lane, req.user);
  res.json({ lane: laneInfo(req.user, req.draft, lane) });
});

// ---------- sharing: private links into one matter ----------
const LINK_DAYS = 30;
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const originOf = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
// `name` = the client's full name as the lawyer gave it; the link only opens for someone who types it
function makeShareLink(draftId, email, byId, origin, name) {
  const token = crypto.randomBytes(24).toString('base64url');
  const expected = name || userByEmail(email)?.name || null;
  db.prepare('INSERT INTO share_links (token_hash, draft_id, email, name, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?)')
    .run(hashToken(token), draftId, String(email).toLowerCase(), expected, byId ?? null, now(), now() + LINK_DAYS * 86400000);
  return `${origin || process.env.PUBLIC_URL || `http://localhost:${PORT}`}/join/${token}`;
}
const linkRow = (token) => db.prepare('SELECT * FROM share_links WHERE token_hash = ? AND expires_at > ?').get(hashToken(token), now());
const userByEmail = (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase().trim());
function ensureClient(email, name) {
  const em = String(email).toLowerCase().trim();
  const existing = userByEmail(em);
  if (existing) return existing;
  const id = db.prepare('INSERT INTO users (name, email, role, color, pass_hash, created_at) VALUES (?,?,?,?,?,?)')
    .run(String(name || em.split('@')[0]).trim().slice(0, 80), em, 'client', nextColor(), '', now()).lastInsertRowid;
  return getUser(id);
}

// who can see this matter
app.get('/api/drafts/:id/access', auth, teamOnly, loadDraft, (req, res) => {
  const d = req.draft;
  const rows = db.prepare('SELECT email, created_at FROM matter_access WHERE draft_id = ? ORDER BY created_at').all(d.id);
  const people = rows.map((r) => {
    const u = userByEmail(r.email);
    return { email: r.email, name: u?.name || null, role: u?.role || 'client', active: !!u?.pass_hash, removable: true };
  });
  const head = db.prepare('SELECT * FROM users WHERE head = 1 AND firm_id = ?').get(d.firm_id ?? -1);
  const creator = d.created_by ? getUser(d.created_by) : null;
  res.json({ people, always: [head, creator].filter(Boolean).filter((u, i, a) => a.findIndex((x) => x.id === u.id) === i).map(publicUser) });
});

// share with someone by email: they get access and a personal link (emailed to them)
app.post('/api/drafts/:id/share', auth, teamOnly, loadDraft, async (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim();
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  const d = req.draft;
  const known = userByEmail(email);
  // a client's link only opens for the person who types this name — so the lawyer must give it
  const expected = name || (known?.role === 'client' ? known.name : '');
  if (known?.role !== 'team' && !expected) return res.status(400).json({ error: "Enter the client's full name — they'll need to type it to get in" });
  const user = ensureClient(email, expected);
  grantAccess(d.id, email, req.user.id);
  if (!d.client_id && user.role === 'client') db.prepare('UPDATE drafts SET client_id = ? WHERE id = ?').run(user.id, d.id);
  logActivity(d.id, null, `shared the matter with ${email}`, req.user.id);
  if (user.role === 'team') return res.json({ team: true, emailed: false }); // colleagues simply sign in
  const link = makeShareLink(d.id, email, req.user.id, originOf(req), expected);
  if (req.body?.notify === false) { // "Copy link": share without sending an email
    broadcast(d.id, 'draft', { by: req.user.name, kind: 'share' });
    return res.json({ link, emailed: false, copied: true });
  }
  const mail = await sendMail({
    to: email,
    subject: `${req.user.name} shared "${d.title}" with you`,
    heading: 'A matter has been shared with you',
    lines: [`${name ? `Dear ${name},` : 'Hello,'}`, `${req.user.name} has shared the matter "${d.title}" (${d.matter_no}) with you on Tabellio.`,
      'Open it with the button below — no password needed. You will be asked for your name.'],
    button: 'Open the matter', url: link,
    footer: `This link is personal to you and works for ${LINK_DAYS} days. Please don't forward it.`,
  });
  broadcast(d.id, 'draft', { by: req.user.name, kind: 'share' });
  res.json({ link, emailed: mail.ok && mailConfigured, outbox: mail.ok && !mailConfigured });
});

// stop sharing with someone
app.delete('/api/drafts/:id/access/:email', auth, teamOnly, loadDraft, (req, res) => {
  const email = String(req.params.email).toLowerCase();
  db.prepare('DELETE FROM matter_access WHERE draft_id = ? AND email = ?').run(req.draft.id, email);
  db.prepare('DELETE FROM share_links WHERE draft_id = ? AND email = ?').run(req.draft.id, email);
  const u = userByEmail(email);
  if (u && req.draft.client_id === u.id) db.prepare('UPDATE drafts SET client_id = NULL WHERE id = ?').run(req.draft.id);
  logActivity(req.draft.id, null, `stopped sharing the matter with ${email}`, req.user.id);
  res.json({ ok: true });
});

// opening a share link: show what it is, then let the person in after they give their name
app.get('/api/join/:token', (req, res) => {
  const row = linkRow(req.params.token);
  if (!row) return res.status(404).json({ error: 'This link has expired or is no longer valid. Ask your lawyer for a new one.' });
  const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(row.draft_id);
  const by = row.created_by ? getUser(row.created_by) : null;
  // (the expected name is never sent to the browser — the person has to know it)
  res.json({ matter: { title: d.title, matter_no: d.matter_no }, email: row.email, invitedBy: by?.name || null });
});
// "Aarav  Mehta", "aarav mehta", "Aarav Mehta." all count as the same name
const sameName = (a, b) => {
  const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return norm(a) !== '' && norm(a) === norm(b);
};
const MAX_NAME_TRIES = 5;
app.post('/api/join/:token', (req, res) => {
  const row = linkRow(req.params.token);
  if (!row) return res.status(404).json({ error: 'This link has expired or is no longer valid. Ask your lawyer for a new one.' });
  if ((row.attempts || 0) >= MAX_NAME_TRIES) return res.status(429).json({ error: 'Too many attempts with this link. Ask your lawyer for a new one.' });
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Please enter your name' });
  // only the person the lawyer named may come in
  const expected = row.name || userByEmail(row.email)?.name;
  if (expected && !sameName(name, expected)) {
    db.prepare('UPDATE share_links SET attempts = COALESCE(attempts, 0) + 1 WHERE token_hash = ?').run(row.token_hash);
    const left = MAX_NAME_TRIES - (row.attempts || 0) - 1;
    return res.status(403).json({ error: left > 0
      ? `That name doesn't match this invitation. Type your full name as your lawyer has it (${left} ${left === 1 ? 'try' : 'tries'} left).`
      : 'That name doesn\'t match this invitation, and the link is now locked. Ask your lawyer for a new one.' });
  }
  const user = ensureClient(row.email, expected || name);
  grantAccess(row.draft_id, row.email, row.created_by);
  startSession(res, user.id);
  res.json({ user: meUser(user), draftId: row.draft_id });
});

// ---------- the legal team: the Team Head invites lawyers ----------
app.get('/api/team', auth, teamOnly, (req, res) => {
  res.json({ team: db.prepare("SELECT id, name, email, title, color, head, perm_upload, perm_confirm, pass_hash != '' AS active FROM users WHERE role = 'team' AND disabled = 0 AND firm_id = ? ORDER BY head DESC, name").all(req.user.firm_id) });
});
// the Team Head sets what an associate may do
app.patch('/api/team/:uid', auth, headOnly, (req, res) => {
  const u = getUser(Number(req.params.uid));
  if (!u || u.role !== 'team' || u.disabled || u.firm_id !== req.user.firm_id) return res.status(404).json({ error: 'Team member not found' });
  if (u.head) return res.status(400).json({ error: 'The Team Head can already do everything' });
  const b = req.body || {};
  if ('perm_upload' in b) db.prepare('UPDATE users SET perm_upload = ? WHERE id = ?').run(b.perm_upload ? 1 : 0, u.id);
  if ('perm_confirm' in b) db.prepare('UPDATE users SET perm_confirm = ? WHERE id = ?').run(b.perm_confirm ? 1 : 0, u.id);
  res.json({ ok: true });
});
// the Team Head removes someone from the team: they can no longer sign in (their past work stays in the history)
app.delete('/api/team/:uid', auth, headOnly, (req, res) => {
  const u = getUser(Number(req.params.uid));
  if (!u || u.role !== 'team' || u.disabled || u.firm_id !== req.user.firm_id) return res.status(404).json({ error: 'Team member not found' });
  if (u.head || u.id === req.user.id) return res.status(400).json({ error: "The Team Head can't be removed" });
  db.prepare('UPDATE users SET disabled = 1, perm_upload = 0, perm_confirm = 0 WHERE id = ?').run(u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  db.prepare('DELETE FROM matter_access WHERE email = ?').run(u.email);
  res.json({ ok: true });
});
app.post('/api/team', auth, headOnly, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  const email = String(req.body?.email || '').toLowerCase().trim();
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter their name and a valid email' });
  const existing = userByEmail(email);
  if (existing?.role === 'team' && !existing.disabled) return res.status(409).json({ error: existing.firm_id === req.user.firm_id ? 'They are already on the team' : 'That person already belongs to another firm on Tabellio' });
  if (existing && existing.role !== 'team') return res.status(409).json({ error: 'That email belongs to a client account' });
  const plan = planOf(getFirm(req.user.firm_id));
  if (seatsUsed(req.user.firm_id) >= plan.seats) {
    return res.status(402).json({ error: `The ${plan.name} plan is for up to ${plan.seats} lawyers. Upgrade your plan to add more.`, upgrade: true });
  }
  if (existing) { // someone removed earlier: bring them back into this firm
    db.prepare('UPDATE users SET name = ?, disabled = 0, head = 0, firm_id = ? WHERE id = ?').run(name, req.user.firm_id, existing.id);
  } else {
    db.prepare('INSERT INTO users (name, email, role, title, color, pass_hash, firm_id, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(name, email, 'team', String(req.body?.title || 'Associate').slice(0, 60), nextColor(), '', req.user.firm_id, now());
  }
  sendMail({
    to: email, subject: 'You have been added to Tabellio',
    heading: 'Welcome to the team', lines: [`Dear ${name},`, `${req.user.name} has added you to the firm's Tabellio workspace.`, 'Open the site, choose "Set up account", and use this email address to choose your password.'],
    button: 'Set up my account', url: originOf(req),
  });
  res.json({ ok: true });
});

// ---------- sign in with Google / Apple ----------
// Set GOOGLE_CLIENT_ID (Google Cloud → APIs & Services → Credentials → OAuth client ID, type "Web").
// Set APPLE_CLIENT_ID (a Services ID) and APPLE_REDIRECT_URI (Apple Developer → Sign in with Apple; needs an https domain).
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || null;
const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID || null;
const APPLE_REDIRECT_URI = process.env.APPLE_REDIRECT_URI || null;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const appleKeys = jose.createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
app.get('/api/auth/config', (req, res) => res.json({
  demo: DEMO,
  google: GOOGLE_CLIENT_ID, apple: APPLE_CLIENT_ID ? { clientId: APPLE_CLIENT_ID, redirectURI: APPLE_REDIRECT_URI } : null,
}));
// A verified email from Google/Apple signs that person in. Someone new is first asked whether they are
// a client or a law firm: they get a short-lived signed ticket that carries the verified email to that step.
const SOCIAL = '!social'; // pass_hash for accounts that sign in only with Google/Apple
const TICKET_KEY = SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const ticketSig = (data) => crypto.createHmac('sha256', TICKET_KEY).update(`ticket:${data}`).digest('base64url');
function makeTicket(email, name) {
  const data = Buffer.from(JSON.stringify({ email: String(email).toLowerCase().trim(), name, exp: Date.now() + 15 * 60000 })).toString('base64url');
  return `${data}.${ticketSig(data)}`;
}
function readTicket(ticket) {
  const [data, sig] = String(ticket || '').split('.');
  if (!data || !sig || sig.length !== ticketSig(data).length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(ticketSig(data)))) return null;
  try { const t = JSON.parse(Buffer.from(data, 'base64url').toString()); return t.exp > Date.now() ? t : null; } catch { return null; }
}
function signInVerified(res, email, name) {
  const user = userByEmail(email);
  if (user?.disabled) return res.status(401).json({ error: 'This account has been removed from the firm' });
  if (!user) return res.json({ choose: true, ticket: makeTicket(email, name), name, email: String(email).toLowerCase() });
  startSession(res, user.id);
  res.json({ user: meUser(user) });
}
app.post('/api/auth/social-finish', (req, res) => {
  const t = readTicket(req.body?.ticket);
  if (!t) return res.status(401).json({ error: 'That sign-in took too long — please sign in again' });
  let user = userByEmail(t.email);
  if (!user) {
    const name = String(req.body?.name || t.name || t.email.split('@')[0]).trim().slice(0, 80);
    if (req.body?.kind === 'firm') {
      const firmName = String(req.body?.firmName || '').trim();
      if (!firmName) return res.status(400).json({ error: "Enter your firm's name" });
      user = getUser(createHead(name, t.email, SOCIAL, firmName));
    } else {
      user = ensureClient(t.email, name);
      if (!user.pass_hash) db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(SOCIAL, user.id);
    }
  }
  startSession(res, user.id);
  res.json({ user: meUser(user) });
});

// ---------- plans: the Team Head moves the firm between Free, Team and Firm ----------
// Online payment: set PAY_LINK_TEAM / PAY_LINK_FIRM to a Stripe or Razorpay payment link. The site owner
// (OWNER_EMAIL) confirms a paid plan with POST /api/admin/firms/:id/plan. In the demo, upgrades apply at once.
const PAY_LINKS = { team: process.env.PAY_LINK_TEAM || null, firm: process.env.PAY_LINK_FIRM || null };
app.get('/api/plans', (req, res) => res.json({ plans: Object.values(PLANS), currency: CURRENCY, demo: DEMO }));
app.post('/api/firm/plan', auth, headOnly, (req, res) => {
  const target = PLANS[req.body?.plan];
  if (!target) return res.status(400).json({ error: 'Unknown plan' });
  const firm = getFirm(req.user.firm_id), current = planOf(firm);
  if (target.id === current.id) return res.json({ user: meUser(req.user) });
  if (seatsUsed(firm.id) > target.seats) return res.status(400).json({ error: `Your firm has ${seatsUsed(firm.id)} lawyers; the ${target.name} plan is for up to ${target.seats}. Remove someone first.` });
  if (target.matters && mattersUsed(firm.id) > target.matters) return res.status(400).json({ error: `Your firm has ${mattersUsed(firm.id)} matters; the ${target.name} plan includes ${target.matters}.` });
  if (target.price > current.price && !DEMO) {
    if (PAY_LINKS[target.id]) return res.json({ payUrl: PAY_LINKS[target.id] });
    return res.status(501).json({ error: 'Online payment isn’t switched on yet — contact Tabellio to upgrade.' });
  }
  db.prepare('UPDATE firms SET plan = ? WHERE id = ?').run(target.id, firm.id); // downgrades (and demo upgrades) apply at once
  res.json({ user: meUser(req.user) });
});
app.patch('/api/firm', auth, headOnly, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: "Enter the firm's name" });
  db.prepare('UPDATE firms SET name = ? WHERE id = ?').run(name, req.user.firm_id);
  res.json({ user: meUser(req.user) });
});
app.post('/api/admin/firms/:id/plan', auth, (req, res) => {
  const owner = String(process.env.OWNER_EMAIL || '').toLowerCase().trim();
  if (!owner || req.user.email !== owner) return res.status(404).json({ error: 'Not found' });
  if (!PLANS[req.body?.plan] || !getFirm(Number(req.params.id))) return res.status(400).json({ error: 'Unknown firm or plan' });
  db.prepare('UPDATE firms SET plan = ? WHERE id = ?').run(req.body.plan, Number(req.params.id));
  res.json({ ok: true });
});
app.post('/api/auth/google', async (req, res) => {
  if (!googleClient) return res.status(501).json({ error: 'Google sign-in has not been set up for this site yet' });
  try {
    const p = (await googleClient.verifyIdToken({ idToken: String(req.body?.credential || ''), audience: GOOGLE_CLIENT_ID })).getPayload();
    if (!p?.email || !p.email_verified) return res.status(401).json({ error: 'Google did not confirm this email address' });
    signInVerified(res, p.email, p.name);
  } catch { res.status(401).json({ error: 'Google sign-in failed — please try again' }); }
});
app.post('/api/auth/apple', async (req, res) => {
  if (!APPLE_CLIENT_ID) return res.status(501).json({ error: 'Apple sign-in has not been set up for this site yet' });
  try {
    const { payload } = await jose.jwtVerify(String(req.body?.id_token || ''), appleKeys, { issuer: 'https://appleid.apple.com', audience: APPLE_CLIENT_ID });
    if (!payload.email) return res.status(401).json({ error: 'Apple did not share an email address' });
    signInVerified(res, payload.email, String(req.body?.name || '').trim() || payload.email.split('@')[0]);
  } catch { res.status(401).json({ error: 'Apple sign-in failed — please try again' }); }
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
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'legal', 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'legal', 'terms.html')));
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, 'public', 'legal', 'pricing.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Run as a normal server locally (`npm start`); on Vercel the app is imported by api/index.js instead.
if (require.main === module) app.listen(PORT, () => console.log(`Tabellio running at http://localhost:${PORT}`));
module.exports = app;
