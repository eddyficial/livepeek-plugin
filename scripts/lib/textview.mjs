// Text renderer: the page as readable text instead of pixels.
//
// Some hosts cannot show an image at all (Zellij on Windows draws neither
// sixel nor kitty graphics), and half-blocks turn a page into coloured
// gravel. For reading, a text layout is far better than a blurred picture:
// headings, paragraphs, lists, links and buttons laid out in the pane, with
// scrolling and clicking still wired to the real page.
//
// Two halves: EXTRACT runs inside the browser and returns the page as a flat
// list of blocks; layoutText turns those blocks into terminal lines and
// remembers which columns belong to which clickable element.

const ESC = '\x1b';

/**
 * Runs in the page. Walks the visible DOM in document order and returns
 * blocks: { kind, parts: [{ text, id?, role? }] }. Clickable elements get a
 * data-peek-id so a click on their text can be sent back to the page.
 */
export const EXTRACT = `(() => {
  const BLOCK = new Set(['ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','DD','DETAILS','DIV','DL','DT','FIELDSET','FIGCAPTION','FIGURE','FOOTER','FORM','H1','H2','H3','H4','H5','H6','HEADER','HR','LI','MAIN','NAV','OL','P','PRE','SECTION','SUMMARY','TABLE','TR','UL','BR','TD','TH']);
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG','HEAD','META','LINK','TITLE','IFRAME','CANVAS','VIDEO','AUDIO']);
  const blocks = [];
  let cur = null;
  let nextId = 1;
  const open = (kind) => { if (cur && cur.parts.length) blocks.push(cur); cur = { kind, parts: [] }; };
  const add = (text, id, role) => {
    if (!cur) cur = { kind: 'p', parts: [] };
    const last = cur.parts[cur.parts.length - 1];
    if (last && last.id === id && last.role === role) { last.text += text; return; }
    cur.parts.push(id ? { text, id, role } : { text });
  };
  const idFor = (el) => {
    let id = el.getAttribute('data-peek-id');
    if (!id) { id = String(nextId++); el.setAttribute('data-peek-id', id); }
    else nextId = Math.max(nextId, Number(id) + 1);
    return id;
  };
  const kindOf = (el) => {
    const t = el.tagName;
    if (/^H[1-6]$/.test(t)) return t.toLowerCase();
    if (t === 'LI') return 'li';
    if (t === 'PRE') return 'pre';
    if (t === 'HR') return 'hr';
    if (t === 'BLOCKQUOTE') return 'quote';
    return 'p';
  };
  const walk = (node, ctx) => {
    if (node.nodeType === 3) {
      const text = node.nodeValue.replace(/\\s+/g, ctx.pre ? '$&' : ' ');
      if (text.trim() || (ctx.pre && text)) add(text, ctx.id, ctx.role);
      // a whitespace-only node between two inline elements is the space
      // between the words; dropping it glues 'here?' to the link after it
      else if (cur && cur.parts.length) add(' ');
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    const t = el.tagName;
    if (SKIP.has(t)) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || el.hidden) return;
    if (t === 'BR') { add('\\n', ctx.id, ctx.role); return; }
    if (t === 'HR') { open('hr'); add('—'); open('p'); return; }
    if (t === 'IMG') { add('[image' + (el.alt ? ': ' + el.alt : '') + ']'); return; }
    const isBlock = BLOCK.has(t) || /^(block|flex|grid|list-item|table|table-row|table-cell|flow-root)$/.test(cs.display);
    const clickable = t === 'A' && el.href || t === 'BUTTON' || t === 'SUMMARY' || t === 'LABEL'
      || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link' || el.onclick || el.hasAttribute('onclick')
      || cs.cursor === 'pointer' && !ctx.id;
    const sub = { ...ctx };
    if (clickable && !ctx.id) { sub.id = idFor(el); sub.role = t === 'A' || el.getAttribute('role') === 'link' ? 'link' : 'button'; }
    if (t === 'PRE') sub.pre = true;
    if (isBlock) open(kindOf(el));
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') {
      const id = idFor(el);
      const type = (el.type || '').toLowerCase();
      if (type === 'hidden') return;
      let label = '';
      if (type === 'checkbox' || type === 'radio') label = (el.checked ? '[x] ' : '[ ] ');
      else if (type === 'submit' || type === 'button' || type === 'reset') label = '[ ' + (el.value || type) + ' ]';
      else if (t === 'SELECT') label = '[' + (el.options[el.selectedIndex]?.text || '') + ' ▾]';
      else label = '[' + (el.value || el.placeholder || '').padEnd(12, '_') + ']';
      add(label, id, 'input');
      return;
    }
    for (const c of el.childNodes) walk(c, sub);
    if (isBlock) open('p');
  };
  walk(document.body, {});
  if (cur && cur.parts.length) blocks.push(cur);
  return { title: document.title, blocks, h: document.documentElement.scrollHeight };
})()`;

const S = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  head: `${ESC}[1;38;5;117m`,       // headings: bold light blue
  link: `${ESC}[4;38;5;80m`,         // links: underlined cyan
  button: `${ESC}[48;5;238m${ESC}[38;5;255m`,
  input: `${ESC}[38;5;222m`,
  quote: `${ESC}[2;3m`,
};

/**
 * Lay blocks out as terminal lines of at most `width` cells.
 * @returns {{ text: string, spans: {c0:number,c1:number,id:string,role:string}[] }[]}
 */
export function layoutText(blocks, width) {
  const lines = [];
  const push = (text, spans = []) => lines.push({ text, spans });
  const blank = () => { if (lines.length && lines[lines.length - 1].text !== '') push(''); };

  for (const b of blocks) {
    const isHead = /^h[1-6]$/.test(b.kind);
    const indent = b.kind === 'li' ? '  • ' : b.kind === 'quote' ? '  │ ' : '';
    const style = isHead ? S.head : b.kind === 'quote' ? S.quote : '';
    if (b.kind === 'hr') { blank(); push(`${S.dim}${'─'.repeat(Math.max(1, width - 2))}${S.reset}`); blank(); continue; }
    if (isHead) blank();

    // Flatten parts into words that remember their span, then wrap.
    const words = [];
    for (const p of b.parts) {
      const chunks = b.kind === 'pre' ? p.text.split('\n') : p.text.split(/\n/);
      chunks.forEach((chunk, ci) => {
        if (ci > 0) words.push({ br: true });
        const ws = b.kind === 'pre' ? [chunk] : chunk.split(/(\s+)/).filter(w => w.length);
        for (const w of ws) words.push({ w, id: p.id, role: p.role });
      });
    }

    let line = indent, plain = indent, spans = [], col = indent.length, lead = true;
    const flush = () => {
      if (plain.trim().length || spans.length) push(line + S.reset, spans);
      line = ' '.repeat(indent.length); plain = line; spans = []; col = indent.length; lead = true;
    };
    for (const t of words) {
      if (t.br) { flush(); continue; }
      let w = t.w;
      if (/^\s+$/.test(w)) { w = ' '; if (lead || b.kind !== 'pre' && col + 1 > width) continue; }
      if (col + w.length > width && !lead) flush();
      if (w.length > width - indent.length) w = w.slice(0, width - indent.length - 1) + '…';
      const c0 = col;
      const sty = t.role === 'link' ? S.link : t.role === 'button' ? S.button : t.role === 'input' ? S.input : style;
      line += sty ? `${sty}${w}${S.reset}${style}` : w;
      plain += w; col += w.length; lead = false;
      if (t.id) {
        const last = spans[spans.length - 1];
        if (last && last.id === t.id && last.c1 === c0) last.c1 = col;
        else spans.push({ c0, c1: col, id: t.id, role: t.role });
      }
    }
    flush();
    // A blank line after real paragraphs and headings. Short blocks (a
    // number in a list, a key badge, a flex item) stay packed together,
    // or every third line is empty and the page is all gaps.
    const len = b.parts.reduce((n, p) => n + p.text.length, 0);
    if (isHead || len > 48) blank();
  }
  while (lines.length && lines[lines.length - 1].text === '') lines.pop();
  return lines;
}
