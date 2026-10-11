// Print a page the way the text renderer would lay it out, for eyeballing.
// Usage: node test/tools/textpreview.mjs <url-or-file> [width]
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXTRACT, layoutText } from '../../scripts/lib/textview.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('../../scripts/node_modules/playwright-core');

const target = process.argv[2];
const width = Number(process.argv[3] || 60);
const url = /^https?:/.test(target) ? target : pathToFileURL(path.resolve(target)).href;
const exe = process.env.LIVEPEEK_BROWSER
  || process.env.PEEK_BROWSER
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const b = await chromium.launch({ executablePath: exe });
const p = await b.newPage();
await p.goto(url);
const ex = await p.evaluate(EXTRACT);
const lines = layoutText(ex.blocks, width);
console.log(`${ex.title}: ${lines.length} lines`);
for (const l of lines) {
  const plain = l.text.replace(/\x1b\[[0-9;]*m/g, '');
  const spans = l.spans.length ? '   <' + l.spans.map(s => s.role + '#' + s.id).join(',') + '>' : '';
  console.log('|' + plain + spans);
}
await b.close();
