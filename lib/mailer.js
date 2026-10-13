// Outgoing email. Configure a real mail account with environment variables:
//   SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASS, SMTP_SECURE ("true" for port 465), MAIL_FROM
// e.g. Gmail: SMTP_HOST=smtp.gmail.com SMTP_USER=you@gmail.com SMTP_PASS=<an app password>.
// Without SMTP settings nothing is sent: each email is saved to ./outbox as an .eml file
// (open it with Outlook / Mail) and summarised in the server log, so the flow can be checked.

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const OUTBOX = process.env.OUTBOX_DIR || (process.env.VERCEL ? '/tmp/outbox' : path.join(__dirname, '..', 'outbox'));
const configured = !!process.env.SMTP_HOST;
const FROM = process.env.MAIL_FROM || (process.env.SMTP_USER ? `Tabellio <${process.env.SMTP_USER}>` : 'Tabellio <no-reply@tabellio.local>');

const transport = configured
  ? nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : Number(process.env.SMTP_PORT) === 465, // 465 = SSL (Gmail)
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  })
  : nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A plain black & white email with one button.
function layout({ heading, lines, button, url, footer }) {
  const text = `${heading}\n\n${lines.join('\n\n')}\n\n${button}: ${url}\n\n${footer || ''}`.trim();
  const html = `<!doctype html><html><body style="margin:0;background:#f3f1ec;font-family:Georgia,serif;color:#0c0c0c">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e2dfd8">
      <tr><td style="background:#0c0c0c;color:#f2f0eb;padding:18px 28px;font:600 12px Arial,sans-serif;letter-spacing:.4em">§ TABELLIO</td></tr>
      <tr><td style="padding:30px 28px 8px"><h1 style="margin:0 0 16px;font:500 26px Georgia,serif">${escHtml(heading)}</h1>
        ${lines.map((l) => `<p style="margin:0 0 14px;font:16px/1.6 Georgia,serif">${escHtml(l)}</p>`).join('')}</td></tr>
      <tr><td style="padding:8px 28px 30px"><a href="${escHtml(url)}" style="display:inline-block;background:#0c0c0c;color:#ffffff;text-decoration:none;padding:13px 22px;font:600 12px Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase">${escHtml(button)}</a></td></tr>
      ${footer ? `<tr><td style="padding:14px 28px;border-top:1px solid #e2dfd8;font:12px/1.5 Arial,sans-serif;color:#86847f">${escHtml(footer)}</td></tr>` : ''}
    </table></td></tr></table></body></html>`;
  return { text, html };
}

// On Vercel the server is frozen as soon as it has answered; waitUntil keeps it alive until the email is out.
let waitUntil = null;
try { if (process.env.VERCEL) ({ waitUntil } = require('@vercel/functions')); } catch { /* not on Vercel */ }
function sendMail(message) {
  const p = deliver(message);
  if (waitUntil) waitUntil(p);
  return p;
}

// Send (or, without SMTP, file in ./outbox). Never throws: email must not break the app.
async function deliver({ to, subject, ...content }) {
  if (!to || /\.invalid$/i.test(String(to))) return { ok: false }; // no address, or a sample person
  const { text, html } = layout(content);
  try {
    const info = await transport.sendMail({ from: FROM, to, subject, text, html });
    if (!configured) {
      fs.mkdirSync(OUTBOX, { recursive: true });
      const file = path.join(OUTBOX, `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(to).replace(/[^\w.@-]/g, '_')}.eml`);
      fs.writeFileSync(file, info.message);
      console.log(`[mail] not configured — saved "${subject}" to ${to} in outbox/${path.basename(file)}`);
    }
    return { ok: true, sent: configured };
  } catch (err) {
    console.error('[mail] failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendMail, mailConfigured: configured };
