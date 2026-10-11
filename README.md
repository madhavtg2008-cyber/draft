# LexDraft

A drafting workspace for law firms. Every matter has three sheets:

| | Sheet | Who can see and edit it |
|---|---|---|
| I | **Client Draft** | The client proposes changes here. The legal team can see it. |
| II | **Clean Draft** | The finished instrument. Read-only for everyone; it changes only when the **Team Head uploads the team draft** into it. |
| III | **Team Draft** | Privileged. The legal team only; sealed from clients. |

## Features

- **Track changes with confirmation.** Every user has their own colour. Edits by anyone other than the Team Head stay pending until the Team Head confirms or rejects them, change by change or all at once.
- **Upload requests.** Associates can't change the clean draft. They ask the Team Head, who previews the request and then uploads or declines it.
- **Word-style editor.** Fonts, sizes, colours, highlight, alignment, lists, indents, line spacing, tables, pictures, links, page breaks, find & replace, zoom and print. Formatting applies only to selected text.
- **Real pages.** Documents are laid out on pages of their own size and margins, with "Page X of Y" on every page.
- **Import Word and PDF files.** Drag a `.docx` or PDF onto a sheet. Word files keep their formatting, page size and page breaks.
- **Export.** Save any sheet as a Word file or a PDF, with page numbers.
- **Remarks.** Remarks sit in the page margin, pinned to the passage they're about. Their author or the Team Head can delete them.
- **Live updates.** Edits, remarks, who's online and "is drafting…" indicators all update live.
- **New matters.** Open a matter for an existing client, or add a new client. A new client gets an invited account and sets their own password.

## Run it locally

You'll need **Node.js 22.5 or newer**, for its built-in SQLite.

```bash
npm install
npm start
```

Then open http://localhost:3000. You can change the port by setting the `PORT` environment variable.

The database (`lexdraft.db`) is created and filled with demo data on first start. To reset it, delete the file.

### Demo accounts

| Role | Email | Password |
|---|---|---|
| Team Head | counsel@lexdraft.test | counsel123 |
| Associate | associate@lexdraft.test | associate123 |
| Client | client@lexdraft.test | client123 |

## Going live (Render + your own domain)

LexDraft runs as one Node server with its data on a disk, so host it somewhere that keeps a disk:
**Render** works out of the box using `render.yaml`.

1. On render.com, choose **New → Blueprint** and pick this GitHub repo.
2. Fill in the private settings it asks for:
   - `HEAD_NAME`, `HEAD_EMAIL`, `HEAD_PASSWORD`: your Team Head login. The account is created on first start.
   - `PUBLIC_URL`: your address, e.g. `https://www.yourfirm.com`.
   - `SMTP_*` (optional): leave these empty until you set up email.
3. Choose the **Starter** plan with the **1 GB disk** (about $7–8 a month). The Free plan has no disk and would lose data.
4. Under **Settings → Custom Domains**, add your domain, then add the DNS records Render shows at your domain registrar (e.g. GoDaddy → DNS). HTTPS is set up automatically.

On a live server there are **no demo accounts**. The Team Head adds lawyers from the profile menu (**Add a lawyer**). Lawyers and invited clients choose their password with **Set up account** on the sign-in page.

To run it locally with the demo accounts:

```bash
npm start
```

## Project layout

```
server.js            API, permissions, change tracking, Word/PDF import & export
lib/docx-import.js   Word (.docx) → HTML, keeping formatting and page setup
public/index.html    the single-page app
public/app.js        matters, sheets, changes, remarks, live updates
public/editor.js     Word-style formatting toolbar, find & replace
public/pages.js      page layout, zoom, confirmations
public/styles.css    black & white chambers theme
```
