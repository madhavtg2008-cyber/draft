// Word (.docx) → HTML that keeps the document looking like it does in Word:
// fonts, sizes, colours, highlights, bold/italic/underline/strike, super/subscript, caps,
// paragraph alignment, spacing, line spacing, indents, numbered & bulleted lists,
// tables (merged cells, shading, borders), pictures, links, line and page breaks.
// The output is sanitised by the server afterwards like any other document.

const JSZip = require('jszip');
const { DOMParser } = require('@xmldom/xmldom');

const kids = (el) => (el ? Array.from(el.childNodes).filter((n) => n.nodeType === 1) : []);
const child = (el, name) => kids(el).find((k) => k.tagName === name);
const attr = (el, name) => (el && el.hasAttribute(name) ? el.getAttribute(name) : null);
const val = (el) => attr(el, 'w:val');
// toggles like <w:b/>, <w:b w:val="0"/>
const toggle = (el) => (el ? !['0', 'false', 'off', 'none'].includes(String(val(el) ?? 'true').toLowerCase()) : undefined);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pt = (n) => `${Math.round(n * 100) / 100}pt`;

const HIGHLIGHT = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000',
  darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
  darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff',
};
const LIST_TYPES = {
  decimal: 'decimal', lowerLetter: 'lower-alpha', upperLetter: 'upper-alpha', lowerRoman: 'lower-roman',
  upperRoman: 'upper-roman', decimalZero: 'decimal-leading-zero', bullet: null,
};
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

// ----- run & paragraph properties → plain objects
function readRPr(rPr) {
  if (!rPr) return {};
  const p = {};
  const b = toggle(child(rPr, 'w:b')); if (b !== undefined) p.bold = b;
  const i = toggle(child(rPr, 'w:i')); if (i !== undefined) p.italic = i;
  const u = child(rPr, 'w:u'); if (u) p.underline = val(u) !== 'none';
  const s = toggle(child(rPr, 'w:strike')) || toggle(child(rPr, 'w:dstrike')); if (s !== undefined) p.strike = s;
  const caps = toggle(child(rPr, 'w:caps')); if (caps !== undefined) p.caps = caps;
  const sc = toggle(child(rPr, 'w:smallCaps')); if (sc !== undefined) p.smallCaps = sc;
  const sz = val(child(rPr, 'w:sz')); if (sz) p.size = Number(sz) / 2;
  const color = val(child(rPr, 'w:color')); if (color && color !== 'auto') p.color = `#${color}`;
  const hl = val(child(rPr, 'w:highlight')); if (hl && HIGHLIGHT[hl]) p.bg = HIGHLIGHT[hl];
  const shd = attr(child(rPr, 'w:shd'), 'w:fill'); if (!p.bg && shd && shd !== 'auto') p.bg = `#${shd}`;
  const fonts = child(rPr, 'w:rFonts');
  // most real documents name their font through the theme ("minor" = body, "major" = headings);
  // when a theme font is given Word uses it in preference to the explicit name
  const themed = attr(fonts, 'w:asciiTheme') || attr(fonts, 'w:hAnsiTheme');
  const font = attr(fonts, 'w:ascii') || attr(fonts, 'w:hAnsi') || attr(fonts, 'w:cs');
  if (themed) p.font = /major/i.test(themed) ? '@major' : '@minor';
  else if (font) p.font = font;
  const spacing = val(child(rPr, 'w:spacing')); if (spacing) p.spacing = Number(spacing) / 20; // character spacing, pt
  const va = val(child(rPr, 'w:vertAlign')); if (va) p.vert = va;
  const vanish = toggle(child(rPr, 'w:vanish')); if (vanish) p.hidden = true;
  return p;
}
function readPPr(pPr) {
  if (!pPr) return {};
  const p = {};
  const jc = val(child(pPr, 'w:jc'));
  if (jc) p.align = { both: 'justify', distribute: 'justify', start: 'left', end: 'right', left: 'left', right: 'right', center: 'center' }[jc];
  const sp = child(pPr, 'w:spacing');
  if (sp) {
    if (attr(sp, 'w:before') !== null) p.before = Number(attr(sp, 'w:before')) / 20;
    if (attr(sp, 'w:after') !== null) p.after = Number(attr(sp, 'w:after')) / 20;
    const line = attr(sp, 'w:line');
    if (line !== null) {
      const rule = attr(sp, 'w:lineRule') || 'auto';
      p.line = rule === 'auto' ? { mult: Number(line) / 240 } : { pt: Number(line) / 20 };
    }
  }
  const ind = child(pPr, 'w:ind');
  if (ind) {
    const left = attr(ind, 'w:left') ?? attr(ind, 'w:start');
    const right = attr(ind, 'w:right') ?? attr(ind, 'w:end');
    if (left !== null) p.left = Number(left) / 20;
    if (right !== null) p.right = Number(right) / 20;
    if (attr(ind, 'w:firstLine') !== null) p.first = Number(attr(ind, 'w:firstLine')) / 20;
    if (attr(ind, 'w:hanging') !== null) p.first = -Number(attr(ind, 'w:hanging')) / 20;
  }
  const numPr = child(pPr, 'w:numPr');
  if (numPr) p.num = { id: val(child(numPr, 'w:numId')), lvl: Number(val(child(numPr, 'w:ilvl')) || 0) };
  if (toggle(child(pPr, 'w:pageBreakBefore'))) p.breakBefore = true;
  const shd = attr(child(pPr, 'w:shd'), 'w:fill'); if (shd && shd !== 'auto') p.bg = `#${shd}`;
  return p;
}

// ----- styles.xml: defaults + style inheritance (basedOn)
const withTheme = (p, theme) => (p.font && p.font[0] === '@' ? { ...p, font: p.font === '@major' ? theme.major : theme.minor } : p);
function readStyles(xml, theme) {
  const styles = {};
  let defR = {}, defP = {};
  if (!xml) return { styles, defR, defP };
  const root = xml.documentElement;
  const dd = child(root, 'w:docDefaults');
  if (dd) {
    defR = withTheme(readRPr(child(child(dd, 'w:rPrDefault'), 'w:rPr')), theme);
    defP = readPPr(child(child(dd, 'w:pPrDefault'), 'w:pPr'));
  }
  for (const s of kids(root).filter((k) => k.tagName === 'w:style')) {
    styles[attr(s, 'w:styleId')] = {
      type: attr(s, 'w:type'),
      name: (val(child(s, 'w:name')) || '').toLowerCase(),
      basedOn: val(child(s, 'w:basedOn')),
      r: withTheme(readRPr(child(s, 'w:rPr')), theme),
      p: readPPr(child(s, 'w:pPr')),
      tblBorders: !!child(child(s, 'w:tblPr'), 'w:tblBorders'),
    };
  }
  return { styles, defR, defP };
}
function resolveStyle(styles, id, seen = new Set()) {
  const s = styles[id];
  if (!s || seen.has(id)) return { r: {}, p: {}, name: '', tblBorders: false };
  seen.add(id);
  const base = s.basedOn ? resolveStyle(styles, s.basedOn, seen) : { r: {}, p: {}, name: '', tblBorders: false };
  return { r: { ...base.r, ...s.r }, p: { ...base.p, ...s.p }, name: s.name || base.name, tblBorders: s.tblBorders || base.tblBorders };
}

// ----- numbering.xml: numId → level → list type
function readNumbering(xml) {
  const map = {};
  if (!xml) return map;
  const root = xml.documentElement;
  const abstract = {};
  for (const a of kids(root).filter((k) => k.tagName === 'w:abstractNum')) {
    const lvls = {};
    for (const l of kids(a).filter((k) => k.tagName === 'w:lvl')) {
      const ind = child(child(l, 'w:pPr'), 'w:ind');
      const left = attr(ind, 'w:left') ?? attr(ind, 'w:start');
      lvls[Number(attr(l, 'w:ilvl'))] = { fmt: val(child(l, 'w:numFmt')) || 'decimal', start: Number(val(child(l, 'w:start')) || 1), left: left !== null ? Number(left) / 20 : null };
    }
    abstract[attr(a, 'w:abstractNumId')] = lvls;
  }
  for (const n of kids(root).filter((k) => k.tagName === 'w:num')) map[attr(n, 'w:numId')] = abstract[val(child(n, 'w:abstractNumId'))] || {};
  return map;
}

// CSS for the parts of `props` that differ from `base`
function runCss(props, base = {}) {
  const css = [];
  if (props.font && props.font !== base.font) css.push(`font-family: '${props.font.replace(/'/g, '')}'`);
  if (props.size && props.size !== base.size) css.push(`font-size: ${pt(props.size)}`);
  if (props.color && props.color !== base.color) css.push(`color: ${props.color}`);
  if (props.bg && props.bg !== base.bg) css.push(`background-color: ${props.bg}`);
  if (props.caps && !base.caps) css.push('text-transform: uppercase');
  if (props.smallCaps && !base.smallCaps) css.push('font-variant: small-caps');
  if (props.spacing && props.spacing !== base.spacing) css.push(`letter-spacing: ${pt(props.spacing)}`);
  return css;
}
// Word's "single" line = the font's own line height (ascent + descent + gap), per font
const LINE_FACTOR = {
  calibri: 1.2207, 'calibri light': 1.2207, cambria: 1.1719, 'times new roman': 1.1499, arial: 1.1499, aptos: 1.2,
  'aptos display': 1.2, georgia: 1.1362, garamond: 1.1235, 'book antiqua': 1.1704, verdana: 1.2153, tahoma: 1.2075,
  'courier new': 1.1328, 'segoe ui': 1.3301, 'century gothic': 1.2256, 'palatino linotype': 1.1621, 'trebuchet ms': 1.1611,
  'arial narrow': 1.1499, helvetica: 1.1499, constantia: 1.2207, corbel: 1.2207, candara: 1.2207,
};
const lineFactor = (font) => LINE_FACTOR[String(font || '').toLowerCase()] || 1.17;
function paraCss(p, baseRun, heading = false) {
  const css = [];
  if (p.align) css.push(`text-align: ${p.align}`);
  // spacing exactly as in Word (none means none, not the editor's default gap)
  css.push(`margin-top: ${pt(p.before || 0)}`, `margin-bottom: ${pt(p.after || 0)}`);
  if (heading) css.push(`font-weight: ${baseRun.bold ? 'bold' : 'normal'}`, `font-style: ${baseRun.italic ? 'italic' : 'normal'}`, 'letter-spacing: normal');
  css.push(`line-height: ${p.line?.pt ? pt(p.line.pt) : Math.round((p.line?.mult ?? 1) * lineFactor(baseRun.font) * 1000) / 1000}`);
  if (p.left) css.push(`margin-left: ${pt(Math.max(0, p.left))}`);
  if (p.right) css.push(`margin-right: ${pt(Math.max(0, p.right))}`);
  if (p.first) css.push(`text-indent: ${pt(p.first)}`);
  if (p.bg) css.push(`background-color: ${p.bg}`);
  css.push(...runCss(baseRun)); // the paragraph's own font/size/colour, inherited by its runs
  return css.join('; ');
}

async function docxToHtml(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const read = async (name) => {
    const f = zip.file(name);
    return f ? new DOMParser().parseFromString(await f.async('string'), 'application/xml') : null;
  };
  const doc = await read('word/document.xml');
  if (!doc) throw new Error('Not a Word document');
  const themeXml = await read('word/theme/theme1.xml');
  const themeFace = (tag, fallback) => {
    const el = themeXml?.getElementsByTagName(tag)[0];
    const latin = el && kids(el).find((k) => k.tagName === 'a:latin');
    return attr(latin, 'typeface') || fallback;
  };
  const theme = { minor: themeFace('a:minorFont', 'Calibri'), major: themeFace('a:majorFont', 'Calibri Light') };
  const { styles, defR, defP } = readStyles(await read('word/styles.xml'), theme);
  if (!defR.size) defR.size = 10;               // Word's own defaults when a file specifies none
  if (!defR.font) defR.font = 'Times New Roman';
  const numbering = readNumbering(await read('word/numbering.xml'));
  const rels = {};
  const relXml = await read('word/_rels/document.xml.rels');
  if (relXml) for (const r of kids(relXml.documentElement)) rels[attr(r, 'Id')] = { target: attr(r, 'Target'), mode: attr(r, 'TargetMode') };

  const imageCache = {};
  async function image(rid, cx, cy) {
    const rel = rels[rid];
    if (!rel) return '';
    const path = rel.target.startsWith('/') ? rel.target.slice(1) : `word/${rel.target.replace(/^\.\//, '')}`;
    const ext = path.split('.').pop().toLowerCase();
    if (!MIME[ext] || !zip.file(path)) return '';
    imageCache[path] ??= `data:${MIME[ext]};base64,${await zip.file(path).async('base64')}`;
    const w = cx ? Math.round(cx / 9525) : null, h = cy ? Math.round(cy / 9525) : null; // EMU → px
    return `<img src="${imageCache[path]}" alt=""${w ? ` width="${w}"` : ''}${h ? ` height="${h}"` : ''} />`;
  }

  // ----- inline content of a paragraph
  async function runsHtml(parent, base, out) {
    for (const el of kids(parent)) {
      switch (el.tagName) {
        case 'w:r': await runHtml(el, base, out); break;
        case 'w:hyperlink': {
          const rel = rels[attr(el, 'r:id')];
          const href = rel?.mode === 'External' ? rel.target : null;
          const inner = [];
          await runsHtml(el, base, inner);
          out.push(href ? `<a href="${esc(href)}">${inner.join('')}</a>` : inner.join(''));
          break;
        }
        case 'w:ins': case 'w:smartTag': case 'w:customXml': case 'w:fldSimple': case 'w:bdo': case 'w:dir':
          await runsHtml(el, base, out); break;
        case 'w:sdt': await runsHtml(child(el, 'w:sdtContent'), base, out); break;
        default: break; // w:del, bookmarks, proofing marks, comments … are not content
      }
    }
  }
  async function runHtml(r, base, out) {
    const rPr = child(r, 'w:rPr');
    const cs = rPr && child(rPr, 'w:rStyle') ? resolveStyle(styles, val(child(rPr, 'w:rStyle'))).r : {};
    const props = { ...base, ...cs, ...withTheme(readRPr(rPr), theme) };
    if (props.hidden) return;
    let text = '';
    for (const el of kids(r)) {
      if (el.tagName === 'w:t') text += esc(el.textContent).replace(/ {2,}/g, (m) => ' ' + '&nbsp;'.repeat(m.length - 1));
      else if (el.tagName === 'w:tab' || el.tagName === 'w:ptab') text += '&emsp;';
      else if (el.tagName === 'w:noBreakHyphen') text += '-';
      else if (el.tagName === 'w:br' || el.tagName === 'w:cr') text += attr(el, 'w:type') === 'page' ? '\u0000PAGEBREAK\u0000' : '<br />';
      else if (el.tagName === 'w:drawing') {
        const blip = el.getElementsByTagName('a:blip')[0];
        const ext = el.getElementsByTagName('wp:extent')[0];
        if (blip) text += await image(attr(blip, 'r:embed'), Number(attr(ext, 'cx')), Number(attr(ext, 'cy')));
      } else if (el.tagName === 'w:pict') {
        const data = el.getElementsByTagName('v:imagedata')[0];
        if (data) text += await image(attr(data, 'r:id'));
      }
    }
    if (!text) return;
    if (props.bold && !base.bold) text = `<strong>${text}</strong>`;
    if (props.italic && !base.italic) text = `<em>${text}</em>`;
    if (props.underline && !base.underline) text = `<u>${text}</u>`;
    if (props.strike) text = `<s>${text}</s>`;
    if (props.vert === 'superscript') text = `<sup>${text}</sup>`;
    if (props.vert === 'subscript') text = `<sub>${text}</sub>`;
    const css = runCss(props, base);
    out.push(css.length ? `<span style="${css.join('; ')}">${text}</span>` : text);
  }

  // ----- block content (body, table cells)
  async function blocksHtml(parent) {
    const out = [];
    const lists = []; // open lists: { lvl, numId, tag, liOpen }
    const closeLists = (toLvl = -1) => {
      while (lists.length && lists[lists.length - 1].lvl > toLvl) {
        const l = lists.pop();
        if (l.liOpen) out.push('</li>');
        out.push(`</${l.tag}>`);
      }
    };
    for (const el of kids(parent)) {
      if (el.tagName === 'w:sdt') { closeLists(); out.push(await blocksHtml(child(el, 'w:sdtContent'))); continue; }
      if (el.tagName === 'w:tbl') { closeLists(); out.push(await tableHtml(el)); continue; }
      if (el.tagName !== 'w:p') continue;

      const pPr = child(el, 'w:pPr');
      const styleId = val(child(pPr, 'w:pStyle'));
      const st = styleId ? resolveStyle(styles, styleId) : resolveStyle(styles, Object.keys(styles).find((k) => styles[k].type === 'paragraph' && styles[k].name === 'normal'));
      const p = { ...defP, ...st.p, ...readPPr(pPr) };
      // the paragraph's style sets its base font; runs only add what differs
      // (the paragraph-mark's own rPr is deliberately ignored, as Word does for text)
      const paraRun = { ...defR, ...st.r };
      const inner = [];
      await runsHtml(el, paraRun, inner);
      const html = inner.join('');

      const name = st.name;
      const tag = name === 'title' ? 'h1' : /^heading 1$/.test(name) ? 'h2' : /^heading 2$/.test(name) ? 'h3' : /^heading [3-9]$/.test(name) ? 'h4' : 'p';
      const css = paraCss(p, paraRun, tag !== 'p');
      const pieces = html.split('\u0000PAGEBREAK\u0000');
      const wrap = (h, t = tag) => `<${t}${css ? ` style="${css}"` : ''}>${h || '<br />'}</${t}>`;
      const BREAK = '<div class="page-break" style="page-break-after: always"></div>';

      if (p.breakBefore) { closeLists(); out.push(BREAK); }
      const fmt = p.num && p.num.id !== '0' && numbering[p.num.id] ? numbering[p.num.id][p.num.lvl] || { fmt: 'decimal' } : null;
      if (fmt) {
        const listTag = fmt.fmt === 'bullet' ? 'ul' : 'ol';
        const lvl = p.num.lvl;
        closeLists(lvl);
        let top = lists[lists.length - 1];
        if (top && top.lvl === lvl && (top.numId !== p.num.id || top.tag !== listTag)) { closeLists(lvl - 1); top = lists[lists.length - 1]; }
        if (!top || top.lvl < lvl) {
          const type = LIST_TYPES[fmt.fmt];
          const parentLeft = lvl > 0 && numbering[p.num.id][lvl - 1]?.left != null ? numbering[p.num.id][lvl - 1].left : 0;
          const pad = fmt.left != null ? Math.max(0, fmt.left - parentLeft) : null;
          const lcss = [type && type !== 'decimal' ? `list-style-type: ${type}` : '', 'margin-top: 0pt', 'margin-bottom: 0pt', pad != null ? `padding-left: ${pt(pad)}` : ''].filter(Boolean).join('; ');
          out.push(`<${listTag}${lcss ? ` style="${lcss}"` : ''}>`);
          lists.push({ lvl, numId: p.num.id, tag: listTag, liOpen: false });
          top = lists[lists.length - 1];
        }
        if (top.liOpen) out.push('</li>');
        const liCss = paraCss({ ...p, left: undefined, first: undefined }, paraRun);
        out.push(`<li${liCss ? ` style="${liCss}"` : ''}>${pieces.join('<br />') || '<br />'}`);
        top.liOpen = true;
        continue;
      }
      closeLists();
      pieces.forEach((h, i) => { if (i) out.push(BREAK); if (h || pieces.length === 1) out.push(wrap(h)); });
      if (child(pPr, 'w:sectPr')) out.push(BREAK); // section break → new page
    }
    closeLists();
    return out.join('');
  }

  async function tableHtml(tbl) {
    const tblPr = child(tbl, 'w:tblPr');
    const tStyle = val(child(tblPr, 'w:tblStyle'));
    const bordersEl = child(tblPr, 'w:tblBorders');
    const hasBorders = bordersEl
      ? kids(bordersEl).some((b) => !['nil', 'none'].includes(val(b)))
      : !!(tStyle && resolveStyle(styles, tStyle).tblBorders) || /grid/i.test(tStyle || '');
    const border = hasBorders ? 'border: 1px solid #000000; ' : '';
    const rows = kids(tbl).filter((k) => k.tagName === 'w:tr');
    const grid = []; // grid[row][col] = cell
    const html = [];
    for (let ri = 0; ri < rows.length; ri++) {
      grid[ri] = [];
      let col = 0;
      const cells = [];
      for (const tc of kids(rows[ri]).filter((k) => k.tagName === 'w:tc')) {
        const tcPr = child(tc, 'w:tcPr');
        const span = Number(val(child(tcPr, 'w:gridSpan')) || 1);
        const vm = child(tcPr, 'w:vMerge');
        const merge = vm ? (val(vm) || 'continue') : null;
        if (merge === 'continue' && ri > 0 && grid[ri - 1][col]) {
          const above = grid[ri - 1][col];
          above.rowspan += 1;
          for (let k = 0; k < span; k++) grid[ri][col + k] = above;
        } else {
          const shd = attr(child(tcPr, 'w:shd'), 'w:fill');
          const w = child(tcPr, 'w:tcW');
          const width = w && attr(w, 'w:type') === 'dxa' ? Number(attr(w, 'w:w')) / 20 : null;
          const cell = { rowspan: 1, span, shd: shd && shd !== 'auto' ? `#${shd}` : null, width, body: await blocksHtml(tc) };
          cells.push(cell);
          for (let k = 0; k < span; k++) grid[ri][col + k] = cell;
        }
        col += span;
      }
      html.push(cells);
    }
    const body = html.map((cells) => `<tr>${cells.map((c) => {
      const css = `${border}vertical-align: top${c.shd ? `; background-color: ${c.shd}` : ''}${c.width ? `; width: ${pt(c.width)}` : ''}`;
      return `<td${c.span > 1 ? ` colspan="${c.span}"` : ''}${c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : ''} style="${css}">${c.body || '<br />'}</td>`;
    }).join('')}</tr>`).join('');
    return `<table style="border-collapse: collapse; width: 100%"><tbody>${body}</tbody></table>`;
  }

  const body = child(doc.documentElement, 'w:body');
  // page size and margins (in twips, Word's own unit) from the document's last section
  const sect = child(body, 'w:sectPr');
  const pgSz = child(sect, 'w:pgSz'), pgMar = child(sect, 'w:pgMar');
  const n = (el, a) => (attr(el, a) !== null ? Math.abs(Number(attr(el, a))) : null);
  const page = pgSz ? {
    w: n(pgSz, 'w:w'), h: n(pgSz, 'w:h'),
    top: n(pgMar, 'w:top'), right: n(pgMar, 'w:right'), bottom: n(pgMar, 'w:bottom'), left: n(pgMar, 'w:left'),
  } : null;
  return { html: await blocksHtml(body), page };
}

module.exports = { docxToHtml };
