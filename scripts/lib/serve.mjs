// A static server for things that have no dev server: a folder of HTML, a
// single page, a markdown document.
//
// Without this, peek only works on projects that ship their own server, which
// leaves out exactly the quick things people want to look at while editing -
// a mockup, a README, a one-file prototype. No dependencies, so the plugin
// stays a plain checkout.
//
// Live reload is a one-line poller injected into every HTML response: it asks
// /__peek/stamp for the newest mtime under the root and reloads when it
// changes. Crude, dependency-free, and exactly as fast as the screenshot loop.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
};

const RELOAD = `<script>(()=>{let s=null;setInterval(async()=>{try{const r=await fetch('/__peek/stamp',{cache:'no-store'});const t=await r.text();if(s!==null&&t!==s)location.reload();s=t}catch{}},500)})()</script>`;

// The page polls the stamp twice a second, and a served folder can be large -
// a document opened from the home folder serves the whole of it. So the walk
// is cached briefly and stops after a fixed number of entries rather than
// grinding through everything on every poll.
const STAMP_TTL = 400;
const STAMP_MAX = 5000;
let lastStamp = null, stampAt = 0, stampRoot = null;

/** Newest mtime under root, as a string. Skips node_modules and dot dirs. */
function stamp(root) {
  if (stampRoot === root && Date.now() - stampAt < STAMP_TTL) return lastStamp;
  let newest = 0;
  let seen = 0;
  const walk = (dir, depth) => {
    if (depth > 6 || seen > STAMP_MAX) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > STAMP_MAX) return;
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else {
        try { const m = fs.statSync(p).mtimeMs; if (m > newest) newest = m; } catch { /* vanished */ }
      }
    }
  };
  walk(root, 0);
  lastStamp = String(Math.floor(newest));
  stampAt = Date.now();
  stampRoot = root;
  return lastStamp;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Only let a markdown link or image point somewhere harmless: the web, mail,
 * an anchor, or a path inside the served folder. Anything else with a scheme -
 * javascript:, data:, vbscript: - becomes a dead '#' link, because a document
 * is rendered on a real origin and a click on it would run in that page.
 *
 * The URL arrives already escaped (inline() escapes first), so &amp; and
 * friends are just characters here and stay escaped in the attribute.
 */
function safeUrl(u) {
  u = u.trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^(#|\/|\.\/|\.\.\/)/.test(u)) return u;
  const colon = u.indexOf(':');
  // a colon with no slash before it starts a scheme; a colon later on is
  // just part of a relative path or a query string
  if (colon !== -1 && !u.slice(0, colon).includes('/')) return '#';
  if (/^[\w.-]/.test(u)) return u;
  return '#';
}

/**
 * Markdown to HTML - enough for documents: headings, paragraphs, lists,
 * code blocks, inline code, emphasis, links, images, blockquotes, rules,
 * and pipe tables. Not CommonMark-complete, and does not try to be.
 */
export function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => `<img alt="${alt}" src="${safeUrl(src)}">`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => `<a href="${safeUrl(href)}">${text}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  const BLOCK = /^(#|```|>|\s*[-*+]\s|\s*\d+[.)]\s|\|)/;

  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`); continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^>/.test(l)) {
      const buf = [];
      while (i < lines.length && /^>/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`); continue;
    }
    if (/^\s*[-*+]\s+/.test(l)) {
      const buf = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*[-*+]\s+/, ''));
      out.push('<ul>' + buf.map(x => `<li>${inline(x)}</li>`).join('') + '</ul>'); continue;
    }
    if (/^\s*\d+[.)]\s+/.test(l)) {
      const buf = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
      out.push('<ol>' + buf.map(x => `<li>${inline(x)}</li>`).join('') + '</ol>'); continue;
    }
    if (/^\|/.test(l) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
      const head = cells(l); i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push('<table><thead><tr>' + head.map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    if (l.trim() === '') { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() !== '' && !BLOCK.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) { buf.push(lines[i++]); }   // a block-looking line that matched nothing
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

const DOC_CSS = `<style>
:root{color-scheme:light}body{max-width:760px;margin:0 auto;padding:48px 32px;font:17px/1.65 Georgia,'Times New Roman',serif;color:#1a1a1a;background:#fff}
h1,h2,h3{font-family:system-ui,sans-serif;letter-spacing:-.01em;line-height:1.2}h1{font-size:34px;margin:.2em 0 .6em}h2{font-size:24px;margin:1.4em 0 .5em}h3{font-size:19px}
code{font:.9em ui-monospace,monospace;background:#f3f4f6;padding:.1em .35em;border-radius:4px}pre{background:#0f172a;color:#e5e7eb;padding:16px;border-radius:8px;overflow:auto}pre code{background:none;padding:0;color:inherit}
blockquote{border-left:4px solid #d1d5db;margin:0;padding:.2em 1em;color:#4b5563}table{border-collapse:collapse;width:100%}th,td{border:1px solid #e5e7eb;padding:8px 10px;text-align:left}th{background:#f9fafb;font-family:system-ui,sans-serif}
a{color:#2563eb}img{max-width:100%}hr{border:0;border-top:1px solid #e5e7eb;margin:2em 0}
</style>`;

function wrapDoc(title, body) {
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>${DOC_CSS}<body>${body}${RELOAD}</body>`;
}

/**
 * Serve `root`. If `file` is given, "/" serves that file (rendered when it is
 * markdown); otherwise "/" serves index.html, or a directory listing.
 * Resolves with the port actually bound.
 */
export function serveStatic({ root, file = null, port = 0 }) {
  root = path.resolve(root);
  const server = http.createServer((req, res) => {
    // Anything that throws in here - a file deleted between stat and read, a
    // folder that cannot be listed - answers 500 rather than crashing the
    // pane that hosts the server. The message stays out of the response.
    try { handle(req, res); }
    catch {
      if (!res.headersSent) res.writeHead(500);
      res.end('error');
    }
  });
  function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    // Browsers ask for this on every page. A 404 here shows up as a console
    // error, which would put a red badge on a page that has nothing wrong.
    if (url.pathname === '/favicon.ico' && !fs.existsSync(path.join(root, 'favicon.ico'))) {
      res.writeHead(204); return res.end();
    }
    if (url.pathname === '/__peek/stamp') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      return res.end(stamp(root));
    }
    let target;
    if (url.pathname === '/' && file) target = path.resolve(root, file);
    else {
      // a bad percent-escape throws; it must not take the whole pane down
      let rel;
      try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end('bad path'); }
      target = path.resolve(root, rel.replace(/^\/+/, '') || '.');
    }
    // Never escape the root. A plain prefix test is not enough: "/proj" is
    // a prefix of "/proj2", so the check is root itself or root + separator.
    if (target !== root && !target.startsWith(root + path.sep)) { res.writeHead(403); return res.end('forbidden'); }

    let st;
    try { st = fs.statSync(target); } catch { res.writeHead(404); return res.end('not found: ' + url.pathname); }
    if (st.isDirectory()) {
      const idx = path.join(target, 'index.html');
      if (fs.existsSync(idx)) target = idx;
      else {
        const items = fs.readdirSync(target).filter(n => !n.startsWith('.')).sort();
        const body = `<h1>${esc(path.basename(target) || '/')}</h1><ul>` +
          items.map(n => `<li><a href="${esc(path.posix.join(url.pathname, n))}">${esc(n)}</a></li>`).join('') + '</ul>';
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(wrapDoc(path.basename(target), body));
      }
    }
    const ext = path.extname(target).toLowerCase();
    res.setHeader('cache-control', 'no-store');
    if (ext === '.md' || ext === '.markdown') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(wrapDoc(path.basename(target), renderMarkdown(fs.readFileSync(target, 'utf8'))));
    }
    if (ext === '.html' || ext === '.htm') {
      let html = fs.readFileSync(target, 'utf8');
      html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, RELOAD + '</body>') : html + RELOAD;
      res.writeHead(200, { 'content-type': TYPES[ext] });
      return res.end(html);
    }
    res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream' });
    fs.createReadStream(target)
      .on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); })
      .pipe(res);
  }
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
