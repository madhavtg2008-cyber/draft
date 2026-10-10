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

## Deploying

LexDraft is a long-running Node server. It keeps its data in a SQLite file and pushes live updates over a connection it holds open (Server-Sent Events). So it needs a host that runs a persistent Node process with a persistent disk, such as **Render**, **Railway**, **Fly.io** or any VPS:

- Build command: `npm install`
- Start command: `npm start`
- Mount a persistent disk on the project folder, so that `lexdraft.db` survives restarts.

**Vercel won't run it as-is.** Vercel runs code as short-lived serverless functions, and their disk is temporary. Data would be lost between requests and live updates would drop. To use Vercel, the database would first need to move to a hosted one (such as Postgres or Turso), and live updates to polling or a hosted realtime service.

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
