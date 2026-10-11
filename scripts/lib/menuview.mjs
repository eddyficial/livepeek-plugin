// The device picker as a picture. When the pane draws images (sixel or
// kitty), the picker is laid out in HTML, screenshotted by a private tab and
// painted over the page, so it can look like a real menu: a glass panel, a
// search field, and a small device of the right shape beside each name.
//
// Everything here is pure: tui.mjs owns the tab, the geometry and the
// painting. The layout follows the terminal grid exactly - the search field is
// HEAD_ROWS cells tall, every entry ROW_H cells, the key hints FOOT_ROWS - so
// a click on a cell maps back to an entry with plain arithmetic.

export const HEAD_ROWS = 3;
export const ROW_H = 2;
export const FOOT_ROWS = 1;

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** What a preset looks like as a thing on a desk. */
export function iconOf(d) {
  if (!d) return { kind: 'folder' };
  if (d.fit) return { kind: 'fit' };
  if (d.brand === 'Document') return { kind: 'doc' };
  if (d.brand === 'Game') return { kind: 'game', w: d.w, h: d.h };
  if (d.brand === 'Tablet') return { kind: 'tablet', w: d.w, h: d.h };
  if ((d.frame || 'phone') === 'phone') return { kind: 'phone', w: d.w, h: d.h };
  if (d.w >= 1000) return { kind: 'laptop', w: d.w, h: d.h };
  return d.w > 600 ? { kind: 'tablet', w: d.w, h: d.h } : { kind: 'phone', w: d.w, h: d.h };
}

/** A small device, drawn at its real aspect ratio inside an S x S box. */
function icon(ic, S) {
  const fitIn = (w, h, max) => {
    const k = Math.min(max / w, max / h);
    return [Math.max(4, Math.round(w * k)), Math.max(4, Math.round(h * k))];
  };
  switch (ic.kind) {
    case 'phone': {
      const [w, h] = fitIn(ic.w, ic.h, S);
      return `<i class="dv phone" style="width:${w}px;height:${h}px"><b></b></i>`;
    }
    case 'tablet': {
      const [w, h] = fitIn(ic.w, ic.h, S * .95);
      return `<i class="dv tablet" style="width:${w}px;height:${h}px"><b></b></i>`;
    }
    case 'laptop': {
      const [w, h] = fitIn(ic.w, ic.h, S * .9);
      return `<i class="dv laptop" style="width:${w}px;height:${h}px"><b></b></i>`;
    }
    case 'game': {
      const [w, h] = fitIn(ic.w, ic.h, S * .9);
      return `<i class="dv game" style="width:${w}px;height:${h}px"><b></b></i>`;
    }
    case 'doc': return `<i class="dv doc" style="width:${Math.round(S * .62)}px;height:${Math.round(S * .82)}px"><b></b></i>`;
    case 'fit': return `<i class="dv fit" style="width:${Math.round(S * .9)}px;height:${Math.round(S * .66)}px"><b></b></i>`;
    default: return `<i class="dv folder" style="width:${Math.round(S * .9)}px;height:${Math.round(S * .68)}px"></i>`;
  }
}

/**
 * Full HTML for one state of the picker.
 * @param {object} m  { cw, ch, bg:[r,g,b], title, filter, placeholder,
 *                      rows:[{name, sub, right, active, hover, icon}],
 *                      slots, first, total, empty }
 */
export function menuHtml(m) {
  const { cw, ch } = m;
  const S = Math.round(ch * 1.45);
  const rows = m.rows.map(r => `
<div class="it${r.hover ? ' hov' : ''}${r.active ? ' act' : ''}">
  <span class="ic">${icon(r.icon, S)}</span>
  <span class="tx"><span class="nm">${esc(r.name)}</span>${r.sub ? `<span class="sb">${esc(r.sub)}</span>` : ''}</span>
  <span class="rt">${esc(r.right)}</span>
  <span class="ck">${r.active ? '&#10003;' : ''}</span>
</div>`).join('');
  const more = m.total > m.rows.length
    ? `<span class="pos">${m.first + 1}&ndash;${m.first + m.rows.length} of ${m.total}</span>` : '';
  const query = m.filter
    ? `<span class="q">${esc(m.filter)}</span><span class="caret"></span>`
    : `<span class="caret"></span><span class="ph">${esc(m.placeholder)}</span>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:100%;height:100%;overflow:hidden}
body{background:rgb(${m.bg.join(',')});font-family:'Segoe UI',system-ui,-apple-system,sans-serif;color:#e7eaf0;
  --ch:${ch}px;--cw:${cw}px;font-size:${Math.round(ch * .66)}px}
.panel{position:absolute;left:1px;top:1px;right:${Math.round(cw * .6)}px;bottom:${Math.round(ch * .35)}px;border-radius:${Math.round(ch * .6)}px;
  background:linear-gradient(180deg,#2b2f37 0%,#1d2026 ${Math.round(ch * HEAD_ROWS)}px,#17191e 100%);
  border:1px solid rgba(255,255,255,.12);overflow:hidden;
  box-shadow:0 ${Math.round(ch * .3)}px ${Math.round(ch * .7)}px rgba(0,0,0,.65),inset 0 1px 0 rgba(255,255,255,.14)}
.head{height:calc(var(--ch) * ${HEAD_ROWS});display:flex;align-items:center;padding:0 calc(var(--cw) * 1.1);
  border-bottom:1px solid rgba(0,0,0,.55);box-shadow:0 1px 0 rgba(255,255,255,.05)}
.field{flex:1;height:calc(var(--ch) * 1.75);display:flex;align-items:center;gap:calc(var(--cw) * .8);padding:0 calc(var(--cw) * 1);
  border-radius:calc(var(--ch) * .5);background:linear-gradient(180deg,#0f1115,#16191e);
  border:1px solid #3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.22),inset 0 1px 2px rgba(0,0,0,.7)}
.mag{width:calc(var(--ch) * .62);height:calc(var(--ch) * .62);border:2px solid #8fa3bf;border-radius:50%;position:relative;flex:none;margin-top:-2px}
.mag::after{content:'';position:absolute;width:2px;height:calc(var(--ch) * .32);background:#8fa3bf;right:-3px;bottom:calc(var(--ch) * -.27);transform:rotate(-45deg);border-radius:1px}
.ttl{flex:none;color:#7f8ba0;font-size:.82em;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.q{color:#fff}.ph{color:#6c7686}
.caret{width:2px;height:calc(var(--ch) * .8);background:#60a5fa;margin:0 1px}
.kb{margin-left:auto;font-size:.72em;color:#c9cfd9;padding:1px 6px 2px;border-radius:5px;flex:none;
  background:linear-gradient(180deg,#454b56,#2b2f37);border:1px solid #121418;box-shadow:0 2px 0 #0d0f12,inset 0 1px 0 rgba(255,255,255,.18)}
.list{padding:0 calc(var(--cw) * .6)}
.it{height:calc(var(--ch) * ${ROW_H});display:flex;align-items:center;gap:calc(var(--cw) * 1.1);padding:0 calc(var(--cw) * .8);border-radius:calc(var(--ch) * .45);position:relative}
.it + .it::before{content:'';position:absolute;top:0;left:calc(var(--cw) * 5);right:calc(var(--cw) * 1);height:1px;background:rgba(255,255,255,.05)}
.it.hov{background:linear-gradient(180deg,#4b8bff,#2563eb 60%,#1f55d4);
  box-shadow:0 2px 8px rgba(37,99,235,.45),inset 0 1px 0 rgba(255,255,255,.35),inset 0 -1px 0 rgba(0,0,0,.25)}
.it.hov::before,.it.hov + .it::before{display:none}
.ic{width:${S}px;height:${S}px;flex:none;display:grid;place-items:center}
.tx{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.15}
.nm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;color:#eef1f6}
.sb{font-size:.74em;color:#808a9a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rt{flex:none;font-size:.74em;color:#aeb7c4;font-variant-numeric:tabular-nums;padding:1px 7px;border-radius:99px;
  background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08)}
.ck{flex:none;width:1.1em;text-align:center;color:#60a5fa;font-weight:700}
.it.act .nm{color:#9ec5ff}
.it.hov .nm,.it.hov .ck{color:#fff}.it.hov .sb{color:#d6e4ff}
.it.hov .rt{color:#fff;background:rgba(255,255,255,.18);border-color:rgba(255,255,255,.25)}
.empty{height:calc(var(--ch) * ${ROW_H});display:flex;align-items:center;justify-content:center;color:#8a94a5}
.foot{position:absolute;left:0;right:0;bottom:0;height:var(--ch);display:flex;align-items:center;gap:calc(var(--cw) * 1.4);
  padding:0 calc(var(--cw) * 1.2);font-size:.7em;color:#7a8494;border-top:1px solid rgba(255,255,255,.06);background:rgba(0,0,0,.18)}
.foot .kb{margin:0 3px 0 0;font-size:1em;padding:0 5px}
.pos{margin-left:auto}
.dv{display:block;position:relative;flex:none}
.dv b{position:absolute;display:block;background:linear-gradient(135deg,#7aa7ff,#9b5cff 60%,#ff7aa8)}
.dv b::after{content:'';position:absolute;inset:0;background:linear-gradient(120deg,rgba(255,255,255,.45),rgba(255,255,255,0) 45%)}
.phone,.tablet{background:linear-gradient(145deg,#5a606b,#1b1d22 60%,#3a3e46);border-radius:22%/11%;box-shadow:0 2px 3px rgba(0,0,0,.6),inset 0 0 0 1px rgba(255,255,255,.18)}
.phone b{inset:9% 12%;border-radius:16%/8%}
.tablet{border-radius:12%/9%}.tablet b{inset:8% 9%;border-radius:6%}
.laptop{background:#1b1d22;border-radius:3px 3px 0 0;box-shadow:inset 0 0 0 1px rgba(255,255,255,.2);margin-bottom:3px}
.laptop b{inset:9% 7% 11%;border-radius:1px}
.laptop::after{content:'';position:absolute;left:-12%;right:-12%;bottom:-3px;height:3px;border-radius:0 0 3px 3px;background:linear-gradient(180deg,#d4d9e0,#7d838c)}
.game{background:#101114;border-radius:3px;box-shadow:0 2px 3px rgba(0,0,0,.6),inset 0 0 0 1px rgba(255,255,255,.18)}
.game b{inset:10%;border-radius:2px;background:linear-gradient(160deg,#25d0a0,#1b7bd9 55%,#7b3fe4)}
.doc{background:linear-gradient(180deg,#fbfcfe,#dfe4ec);border-radius:2px 6px 2px 2px;box-shadow:0 2px 3px rgba(0,0,0,.6)}
.doc b{inset:22% 18% auto;height:45%;background:repeating-linear-gradient(180deg,#9aa6b8 0 2px,transparent 2px 5px)}
.doc b::after{display:none}
.fit{border:2px dashed #7fb2ff;border-radius:4px}
.fit b{inset:3px;border-radius:2px;opacity:.85}
.folder{background:linear-gradient(180deg,#ffd572,#f0a92a);border-radius:2px 4px 4px 4px;box-shadow:0 2px 3px rgba(0,0,0,.6)}
.folder::before{content:'';position:absolute;left:0;top:-3px;width:45%;height:4px;border-radius:2px 2px 0 0;background:#f5bd46}
</style></head><body><div class="panel">
<div class="head"><div class="field"><span class="mag"></span><span class="ttl">${esc(m.title)}</span>${query}<span class="kb">esc</span></div></div>
<div class="list">${m.empty ? `<div class="empty">${esc(m.empty)}</div>` : rows}</div>
<div class="foot"><span><span class="kb">&uarr;</span><span class="kb">&darr;</span>move</span><span><span class="kb">enter</span>select</span>${more}</div>
</div></body></html>`;
}
