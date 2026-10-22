// ================= Zoit — pasting from Microsoft Word =================
// Word puts its layout partly on each paragraph and partly in its own style sheet (Normal, Heading 1…).
// This turns Word's clipboard into plain HTML that keeps every measurement: fonts and sizes, paragraph
// spacing, line spacing, indents and hanging indents, tabs, alignment, tables, page breaks — and reads
// Word's page size and margins so the pages break where Word breaks them.

const WORD_FONTS = { // Word's fonts, each with a free font of identical measurements for machines without it
  calibri: "Calibri, Carlito, sans-serif",
  cambria: "Cambria, Caladea, serif",
  'times new roman': "'Times New Roman', Tinos, serif",
  times: "'Times New Roman', Tinos, serif",
  arial: "Arial, Arimo, sans-serif",
  helvetica: "Arial, Arimo, sans-serif",
  'courier new': "'Courier New', Cousine, monospace",
  courier: "'Courier New', Cousine, monospace",
};
// Word's "single" line height for each font, as a multiple of the font size (the same table the .docx import uses)
const LINE_FACTOR = {
  calibri: 1.2207, 'calibri light': 1.2207, cambria: 1.1719, 'times new roman': 1.1499, times: 1.1499, arial: 1.1499, aptos: 1.2,
  georgia: 1.1362, garamond: 1.1235, 'book antiqua': 1.1704, verdana: 1.2153, tahoma: 1.2075, 'courier new': 1.1328, courier: 1.1328,
  'segoe ui': 1.3301, 'century gothic': 1.2256, 'palatino linotype': 1.1621, 'trebuchet ms': 1.1611, helvetica: 1.1499,
  simsun: 1.0, constantia: 1.2207, corbel: 1.2207, candara: 1.2207,
};
const firstFont = (v) => String(v || '').split(',')[0].replace(/['"]/g, '').trim().toLowerCase();
// the properties that decide how text looks and where lines and pages break
const LAYOUT = ['font-family', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'text-decoration-line', 'color', 'background-color',
  'text-align', 'text-indent', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right', 'letter-spacing', 'text-transform',
  'font-variant', 'vertical-align', 'width', 'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-collapse',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left'];
const isWordHtml = (html) => /urn:schemas-microsoft-com:office|class=["']?Mso|mso-/i.test(html);

// Word's style sheet: "p.MsoNormal", "h1", "span.Heading1Char"… → their declarations
function wordStyles(html) {
  const css = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || []).join('\n').replace(/<\/?style[^>]*>|<!--|-->/g, '');
  const rules = {}, page = {};
  for (const m of css.matchAll(/([^{}@]+)\{([^}]*)\}/g)) {
    const decl = Object.fromEntries(m[2].split(';').map((d) => d.split(':')).filter((d) => d.length >= 2)
      .map(([k, ...v]) => [k.trim().toLowerCase(), v.join(':').trim()]));
    for (const sel of m[1].split(',').map((x) => x.trim().toLowerCase())) if (sel) rules[sel] = { ...(rules[sel] || {}), ...decl };
  }
  for (const m of css.matchAll(/@page\s+[\w.]+\s*\{([^}]*)\}/gi)) { // the section's page size and margins
    for (const d of m[1].split(';')) {
      const [k, v] = d.split(':').map((x) => x && x.trim().toLowerCase());
      if (k === 'size') { const [w, h] = v.split(/\s+/).map(toPt); if (w && h) Object.assign(page, { w, h }); }
      if (['margin-top', 'margin-bottom', 'margin-left', 'margin-right'].includes(k)) page[k.slice(7)] = toPt(v);
    }
  }
  const tabInterval = toPt((html.match(/tab-interval:\s*([\d.]+pt)/i) || [])[1]) || 36;
  return { rules, page, tabInterval };
}
function toPt(v) {
  const m = String(v || '').match(/^(-?[\d.]+)(pt|in|cm|mm|px)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return { pt: n, in: n * 72, cm: n * 72 / 2.54, mm: n * 72 / 25.4, px: n * 0.75 }[m[2] || 'pt'];
}
const fmtPt = (n) => `${Math.round(n * 100) / 100}pt`;

function fromWord(html) {
  // Windows' clipboard can put a "Version:1.0 StartHTML:…" header in front of the HTML — drop it
  const start = html.search(/<html|<body|<!--StartFragment/i);
  if (start > 0) html = html.slice(start);
  const { rules, page, tabInterval } = wordStyles(html);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Word leaves the size out of its Normal style when it is its default, 10pt
  const normal = rules['p.msonormal'] || {};
  const baseSize = normal['font-size'] || '10pt';

  const styleOf = (el) => { // the element's class rule, then its own inline style on top
    const tag = el.tagName.toLowerCase();
    const cls = (el.getAttribute('class') || '').toLowerCase().split(/\s+/).filter(Boolean);
    let s = { ...(rules[tag] || {}) };
    for (const c of cls) s = { ...s, ...(rules[`.${c}`] || {}), ...(rules[`${tag}.${c}`] || {}) };
    for (const d of (el.getAttribute('style') || '').split(';')) {
      const i = d.indexOf(':');
      if (i > 0) s[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim();
    }
    return s;
  };
  const tidy = (prop, v) => {
    v = String(v).replace(/\s+/g, ' ').replace(/!important/g, '').trim();
    if (!v) return null;
    if (prop === 'font-family') {
      const first = v.split(',')[0].replace(/['"]/g, '').trim().toLowerCase();
      return WORD_FONTS[first] || `'${v.split(',')[0].replace(/['"]/g, '').trim()}', serif`;
    }
    if (prop === 'font-size' || prop.startsWith('margin') || prop.startsWith('padding') || prop === 'text-indent' || prop === 'width' || prop === 'letter-spacing') {
      // Word writes "0.0001pt" for zero, and lengths in pt/in/cm
      v = v.split(' ').map((x) => { const p = toPt(x); return p === null ? x : fmtPt(Math.abs(p) < 0.01 ? 0 : p); }).join(' ');
    }
    if (prop === 'background') prop = 'background-color';
    if (/windowtext/.test(v)) v = v.replace(/windowtext/g, '#000');
    return v;
  };

  const walk = (node) => {
    for (const el of [...node.children]) {
      const tag = el.tagName;
      // Word's page break: <br style="page-break-before:always"> → Zoit's page break
      if (tag === 'BR' && /page-break-before:\s*always|mso-break-type:\s*section-break/i.test(el.getAttribute('style') || '')) {
        const block = el.closest('p, h1, h2, h3, h4, h5, h6, div') || el;
        const brk = doc.createElement('div');
        brk.className = 'page-break';
        brk.setAttribute('style', 'page-break-after: always');
        if (block !== el && !block.textContent.trim()) block.replaceWith(brk); // an otherwise empty paragraph
        else el.replaceWith(brk);
        continue;
      }
      walk(el);
      if (['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'XML'].includes(tag) || /^(O|W|M|V):/.test(tag)) {
        if (/^O:P$/.test(tag)) el.replaceWith(...el.childNodes); else el.remove();
        continue;
      }
      const s = styleOf(el);
      // Word's tab: a span with mso-tab-count → a real tab that jumps to the next tab stop / hanging indent
      if (s['mso-tab-count']) {
        const tab = doc.createElement('span');
        tab.setAttribute('style', 'white-space: pre');
        tab.textContent = '\t'.repeat(parseInt(s['mso-tab-count'], 10) || 1);
        el.replaceWith(tab);
        continue;
      }
      // list markers Word draws itself ("1." then spaces) — keep the marker, turn the spacing into a tab
      if (s['mso-list'] === 'ignore') {
        const marker = el.textContent.replace(/ /g, ' ').trim();
        el.replaceWith(doc.createTextNode(marker), Object.assign(doc.createElement('span'), { textContent: '\t' }));
        continue;
      }
      const out = [];
      for (const p of LAYOUT) {
        let v = s[p] ?? (p === 'background-color' ? s.background : undefined);
        if (v == null || v === '') continue;
        v = tidy(p, v);
        if (v) out.push(`${p}: ${v}`);
      }
      const isBlock = /^(P|H[1-6]|LI|DIV|TD|TH)$/.test(tag);
      if (isBlock && tag !== 'DIV') {
        // every paragraph states its own size and font, so nothing falls back to the editor's defaults
        if (!out.some((d) => d.startsWith('font-size'))) out.push(`font-size: ${tidy('font-size', baseSize)}`);
        if (!out.some((d) => d.startsWith('font-family'))) out.push(`font-family: ${tidy('font-family', normal['font-family'] || 'Calibri')}`);
        if (!out.some((d) => d.startsWith('margin-top'))) out.push('margin-top: 0pt');
        if (!out.some((d) => d.startsWith('margin-bottom'))) out.push('margin-bottom: 0pt');
        // Word's line spacing is a multiple of the font's own line height, not of the font size:
        // "single" in Calibri is 1.22 × the size, in Times New Roman 1.15 ×. Use the font most of the text is in.
        let main = null, most = -1;
        for (const sp of el.querySelectorAll('span[style*="font-family"]')) {
          const n = sp.textContent.replace(/s/g, '').length;
          if (n > most) { most = n; main = sp; }
        }
        const fontOf = main ? (main.style.fontFamily || '') : (out.find((d) => d.startsWith('font-family')) || '').slice(12);
        const factor = LINE_FACTOR[firstFont(fontOf)] || 1.17;
        const lh = String(s['line-height'] || '').trim().toLowerCase(), rule = String(s['mso-line-height-rule'] || '').toLowerCase();
        if (/^[d.]+pt$/.test(lh) && rule !== 'at-least') out.push(`line-height: ${lh}`); // "exactly"
        else out.push(`line-height: ${Math.round((/%$/.test(lh) ? parseFloat(lh) / 100 : 1) * factor * 1000) / 1000}`);
        if (main) { // the paragraph's own size and font follow its text, so blank lines are as tall as in Word
          const i = out.findIndex((d) => d.startsWith('font-family')), j = out.findIndex((d) => d.startsWith('font-size'));
          if (main.style.fontFamily) out[i] = `font-family: ${main.style.fontFamily}`;
          if (main.style.fontSize) out[j] = `font-size: ${main.style.fontSize}`;
        }
        const align = el.getAttribute('align');
        if (align && !out.some((d) => d.startsWith('text-align'))) out.push(`text-align: ${align.toLowerCase()}`);
      }
      if (tag === 'TABLE') out.push('border-collapse: collapse');
      const keepAttrs = { A: ['href'], IMG: ['src', 'width', 'height', 'alt'], TD: ['colspan', 'rowspan', 'valign'], TH: ['colspan', 'rowspan', 'valign'] }[tag] || [];
      for (const a of [...el.attributes]) if (!keepAttrs.includes(a.name)) el.removeAttribute(a.name);
      if (out.length) el.setAttribute('style', out.join('; '));
      // a span that says nothing (only Word's own bookkeeping) disappears
      if (tag === 'SPAN' && !out.length) el.replaceWith(...el.childNodes);
      else if (tag === 'FONT') el.replaceWith(...el.childNodes);
    }
  };
  walk(doc.body);
  // Word marks the copied part with comments; empty paragraphs keep their height with a space
  let body = doc.body.innerHTML.replace(/<!--[\s\S]*?-->/g, '').replace(/<p([^>]*)>\s*<\/p>/g, '<p$1>&nbsp;</p>');
  body = body.replace(/(<(p|h[1-6]|li|td|th)\b[^>]*style="[^"]*)"/g, `$1; tab-size: ${fmtPt(tabInterval)}"`);
  const pageSetup = page.w && page.h ? {
    w: Math.round(page.w * 20), h: Math.round(page.h * 20),
    top: Math.round((page.top ?? 72) * 20), bottom: Math.round((page.bottom ?? 72) * 20),
    left: Math.round((page.left ?? 72) * 20), right: Math.round((page.right ?? 72) * 20),
  } : null;
  return { html: body, page: pageSetup };
}
