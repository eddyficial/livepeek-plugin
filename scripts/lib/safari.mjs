/**
 * Safari around an iPhone preset (--safari): the toolbar, its ••• menu, the
 * share sheet, "Add to Home Screen", the Home Screen the icon lands on, and
 * the site opened from there as a web app.
 *
 * A Chromium page has no Safari of its own, and the flow people most need to
 * see on an iPhone - putting a web app on the Home Screen - happens entirely
 * in Safari's chrome. So the chrome is drawn here: an HTML page rendered in a
 * tab of its own with a transparent background and laid over the real page.
 * It follows iOS 26 Safari's compact layout: a faithful sketch, not Apple's
 * pixels.
 *
 * Everything here is pure: the viewer owns the tabs and the page, this file
 * owns the state machine, the geometry and the markup.
 */

/** An iPad: Safari's bar runs along the top there, with Share at its right. */
export const safariOnTop = (device) => device.os === 'iPadOS';

/** Height of Safari's bar, in logical px: below the page on an iPhone, above it on an iPad. */
export function safariBar(device) {
  if (safariOnTop(device)) return 56;
  return device.chin ? 56 : 78;
}

export function initialSafari() {
  return { mode: 'safari', sheet: null, webApp: true, apps: [], info: null, returnUrl: null };
}

/**
 * One tap on the chrome. Returns the next state and what the viewer has to do
 * to the real page: `{ open, standalone }`, `{ leaveApp }`, `{ back }`,
 * `{ reload }` or `{ info }` (gather the page's name and icon first).
 */
export function safariStep(state, action) {
  const s = { ...state };
  if (action === 'more') return { state: { ...s, sheet: s.sheet === 'menu' ? null : 'menu' } };
  if (action === 'share') return { state: { ...s, sheet: 'share' }, effect: { info: true } };
  if (action === 'view-more') return { state: { ...s, sheet: 'share-more' } };
  if (action === 'add-to-home') return { state: { ...s, sheet: 'add', webApp: true } };
  if (action === 'dismiss' || action === 'inert') return { state: { ...s, sheet: null } };
  if (action === 'toggle-webapp') return { state: { ...s, webApp: !s.webApp } };
  if (action === 'back') return { state: { ...s, sheet: null }, effect: { back: true } };
  if (action === 'reload') return { state: { ...s, sheet: null }, effect: { reload: true } };
  if (action === 'add') {
    const i = s.info || {};
    const app = { name: i.name || i.host || 'Web App', icon: i.icon || null, url: s.webApp ? (i.start || i.url) : i.url, webApp: s.webApp };
    return { state: { ...s, sheet: null, mode: 'home', apps: [...s.apps, app] } };
  }
  if (action === 'home') {
    return { state: { ...s, sheet: null, mode: 'home' }, effect: s.mode === 'app' ? { leaveApp: true } : null };
  }
  if (action === 'safari') {
    return { state: { ...s, sheet: null, mode: 'safari' }, effect: { leaveApp: true } };
  }
  const open = /^open:(\d+)$/.exec(action || '');
  if (open) {
    const app = s.apps[Number(open[1])];
    if (!app) return { state: s };
    // a bookmark (Open as Web App turned off) opens in Safari, not on its own
    return { state: { ...s, sheet: null, mode: app.webApp ? 'app' : 'safari' }, effect: { open: app.url, standalone: app.webApp } };
  }
  return { state: s };
}

/**
 * Makes the page believe it was opened from the Home Screen: Safari sets
 * navigator.standalone and matches (display-mode: standalone) there.
 */
export const STANDALONE_SCRIPT = `(() => {
  Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true });
  const real = window.matchMedia.bind(window);
  window.matchMedia = (q) => {
    const m = /\\(\\s*display-mode\\s*:\\s*([a-z-]+)\\s*\\)/i.exec(String(q));
    return m ? real(m[1].toLowerCase() === 'standalone' ? 'all' : 'not all') : real(q);
  };
})();`;

/**
 * Runs in the page: what Safari shows about it, and what Add to Home Screen
 * would put on the Home Screen (name, icon, the address it opens at).
 */
export async function pageInfoProbe() {
  const abs = (u, base) => { try { return new URL(u, base || location.href).href; } catch { return null; } };
  const info = { title: document.title, url: location.href, host: location.host.replace(/^www\./, ''), name: null, icon: null, start: null };
  let manifest = null;
  const link = document.querySelector('link[rel="manifest"]');
  const mHref = link && abs(link.getAttribute('href'));
  if (mHref) { try { manifest = await (await fetch(mHref)).json(); } catch { /* no manifest */ } }
  const metaTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute('content');
  info.name = metaTitle || manifest?.short_name || manifest?.name || document.title || info.host;
  if (manifest?.start_url) info.start = abs(manifest.start_url, mHref);
  const touch = document.querySelector('link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]');
  let iconHref = touch && abs(touch.getAttribute('href'));
  if (!iconHref && manifest?.icons?.length) {
    const best = [...manifest.icons].sort((a, b) => parseInt(b.sizes) - parseInt(a.sizes))[0];
    iconHref = abs(best.src, mHref);
  }
  if (!iconHref) { const fav = document.querySelector('link[rel~="icon"]'); iconHref = fav && abs(fav.getAttribute('href')); }
  if (iconHref) {
    try {
      const blob = await (await fetch(iconHref)).blob();
      info.icon = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => res(null); r.readAsDataURL(blob); });
    } catch { /* drawn as a letter instead */ }
  }
  return info;
}

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Simple line icons in the SF Symbols manner, 24px boxes.
const ICON = {
  back: '<path d="M15 4 7 12l8 8" />',
  forward: '<path d="m9 4 8 8-8 8" />',
  sidebar: '<rect x="3" y="4.5" width="18" height="15" rx="3" /><path d="M9 4.5v15" />',
  dots: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  reload: '<path d="M19 12a7 7 0 1 1-2.1-5" /><path d="M19 4v4h-4" />',
  share: '<path d="M12 15V3M8 6.5 12 3l4 3.5M8.5 10H6v11h12V10h-2.5" />',
  book: '<path d="M4 5c3-1.5 5.5-1.5 8 .5 2.5-2 5-2 8-.5v14c-3-1.5-5.5-1.5-8 .5-2.5-2-5-2-8-.5z" /><path d="M12 5.5v14" />',
  star: '<path d="m12 3.5 2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" />',
  glasses: '<circle cx="7" cy="14" r="3.5" /><circle cx="17" cy="14" r="3.5" /><path d="M10.5 14h3M3.5 13 5 7M20.5 13 19 7" />',
  find: '<circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5" />',
  desktop: '<rect x="3" y="4" width="18" height="12" rx="2" /><path d="M9 20h6M12 16v4" />',
  plus: '<path d="M12 5v14M5 12h14" />',
  tabs: '<rect x="4" y="7" width="13" height="13" rx="2.5" /><path d="M8 4h9.5A2.5 2.5 0 0 1 20 6.5V16" />',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" />',
  note: '<rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 9h8M8 13h8M8 17h5" />',
  addHome: '<rect x="4" y="4" width="16" height="16" rx="3.5" /><path d="M12 8.5v7M8.5 12h7" />',
  markup: '<path d="M4 20c4-1 6-3 8-6l5-8 2 1.5-5 8c-2 3-4 4.5-8 4.5z" />',
  print: '<path d="M7 9V4h10v5M7 17H4v-7h16v7h-3" /><rect x="7" y="14" width="10" height="6" />',
  x: '<path d="M7 7l10 10M17 7 7 17" />',
};
const svg = (name, size = 22, extra = '') => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ${extra}>${ICON[name]}</svg>`;

const SAFARI_ICON = `<svg viewBox="0 0 60 60" width="100%" height="100%"><defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1fd1f9"/><stop offset="1" stop-color="#1a6dff"/></linearGradient></defs>
<rect width="60" height="60" rx="13.5" fill="#fff"/><circle cx="30" cy="30" r="24" fill="url(#sg)"/>
<g stroke="#fff" stroke-width="1" opacity=".8">${Array.from({ length: 24 }, (_, i) => { const a = i * Math.PI / 12; return `<line x1="${30 + Math.cos(a) * 20}" y1="${30 + Math.sin(a) * 20}" x2="${30 + Math.cos(a) * 23}" y2="${30 + Math.sin(a) * 23}"/>`; }).join('')}</g>
<path d="M30 30 44 16 33 33z" fill="#ff3b30"/><path d="M30 30 16 44 27 27z" fill="#fff"/></svg>`;

/** A Home Screen icon: the site's own picture, or its first letter. */
function appIcon(app, size) {
  if (app.icon) return `<img src="${esc(app.icon)}" style="width:${size}px;height:${size}px;border-radius:${size * 0.225}px;object-fit:cover;display:block">`;
  return `<div style="width:${size}px;height:${size}px;border-radius:${size * 0.225}px;background:#d0d4dc;color:#3a3f48;display:grid;place-items:center;font:600 ${size * 0.45}px var(--font)">${esc((app.name || '?')[0].toUpperCase())}</div>`;
}

/**
 * The chrome for one state, as a page `w` x `h` logical px with a transparent
 * background wherever the real page shows through. Every tappable thing
 * carries data-hit (the action) and data-label (what --tap can name it by).
 */
export function safariHtml(state, { w, h, bar, dark, chin, ipad = false }) {
  const info = state.info || {};
  const hit = (action, label) => `data-hit="${action}" data-label="${esc(label)}"`;
  const glass = dark ? 'rgba(44,44,46,.97)' : 'rgba(252,252,253,.97)';  // nearly solid: the page behind can't be blurred from here
  const ink = dark ? '#f5f5f7' : '#111';
  const sub = dark ? 'rgba(235,235,245,.6)' : 'rgba(60,60,67,.6)';
  const sheetBg = dark ? '#1c1c1e' : '#f2f2f7';
  const cardBg = dark ? '#2c2c2e' : '#fff';
  const line = dark ? 'rgba(84,84,88,.6)' : 'rgba(60,60,67,.18)';
  const blue = dark ? '#0a84ff' : '#007aff';
  const parts = [];

  if (state.mode === 'home') {
    const cols = ipad ? 6 : 4, size = ipad ? 72 : 62, cell = (w - (ipad ? 80 : 28)) / cols;
    const apps = state.apps.map((a, i) => {
      const x = (ipad ? 40 : 14) + (i % cols) * cell, y = (ipad ? 40 : 24) + Math.floor(i / cols) * (size + 42);
      return `<div class="app" ${hit(`open:${i}`, a.name)} style="left:${x}px;top:${y}px;width:${cell}px">${appIcon(a, size)}<span>${esc(a.name)}</span></div>`;
    }).join('');
    const dock = ipad ? `left:50%;right:auto;transform:translateX(-50%);width:${size + 36}px;padding-left:18px` : '';
    parts.push(`<div class="wall"></div>${apps}
      <div class="dock" style="bottom:${chin ? 8 : 22}px;${dock}"><div class="app dockapp" ${hit('safari', 'Safari')}><div style="width:${size}px;height:${size}px">${SAFARI_ICON}</div></div></div>`);
  } else if (state.mode === 'safari' && ipad) {
    // the bar along the top, Share at its right; the share list is a pop-up under it
    const y = 4, bh = bar - 8;
    parts.push(`
      <div class="tbar" style="height:${bar}px"></div>
      <div class="tb" ${hit('inert', 'Sidebar')} style="left:12px;top:${y}px;height:${bh}px">${svg('sidebar')}</div>
      <div class="tb" ${hit('back', 'Back')} style="left:60px;top:${y}px;height:${bh}px">${svg('back')}</div>
      <div class="tb dim" ${hit('inert', 'Forward')} style="left:104px;top:${y}px;height:${bh}px">${svg('forward')}</div>
      <div class="btn pill" ${hit('inert', 'Address')} style="left:${Math.round(w * 0.27)}px;right:${Math.round(w * 0.27)}px;top:${y + 2}px;height:${bh - 4}px;box-shadow:none"><span class="host">${esc(info.host || state.host || '')}</span><span class="rl" ${hit('reload', 'Reload')}>${svg('reload', 18)}</span></div>
      <div class="tb" ${hit('share', 'Share')} style="right:104px;top:${y}px;height:${bh}px">${svg('share')}</div>
      <div class="tb" ${hit('inert', 'New Tab')} style="right:58px;top:${y}px;height:${bh}px">${svg('plus')}</div>
      <div class="tb" ${hit('inert', 'Tabs')} style="right:12px;top:${y}px;height:${bh}px">${svg('tabs')}</div>`);

    if (state.sheet === 'share' || state.sheet === 'share-more') {
      const more = state.sheet === 'share-more';
      const people = [['AirDrop', '#1c9bf0'], ['Messages', '#34c759'], ['Mail', '#2f7cf6'], ['Notes', '#ffcc00'], ['Reminders', '#ff9f0a']];
      const actions = more
        ? [['Copy', 'copy'], ['Add to Reading List', 'glasses'], ['Add Bookmark', 'book'], ['Add to Favorites', 'star'], ['Add to Quick Note', 'note'], ['Find on Page', 'find'], ['Add to Home Screen', 'addHome'], ['Markup', 'markup'], ['Print', 'print']]
        : [['Copy', 'copy'], ['Add to Reading List', 'glasses'], ['Add Bookmark', 'book'], ['Add to Favorites', 'star']];
      const icon = info.icon ? `<img src="${esc(info.icon)}" style="width:44px;height:44px;border-radius:10px;object-fit:cover">` : appIcon({ name: info.host }, 44);
      parts.unshift(`<div class="backdrop" ${hit('dismiss', 'Close')}></div>`);
      parts.push(`<div class="pop" style="top:${bar + 4}px;right:72px">
        <div class="shead">${icon}<div class="st"><b>${esc(info.title || info.host)}</b><span>${esc(info.host)} <i style="color:${blue};font-style:normal">Options ›</i></span></div></div>
        <div class="people">${people.map(([n, c]) => `<div class="pp" ${hit('inert', n)}><div class="pc" style="background:${c}">${svg('share', 22, 'style="color:#fff"')}</div><span>${n}</span></div>`).join('')}</div>
        <div class="card">${actions.map(([l, ic]) => `<div class="ai" ${hit(l === 'Add to Home Screen' ? 'add-to-home' : 'inert', l)}><span>${l}</span>${svg(ic, 21)}</div>`).join('')}
          ${more ? '' : `<div class="ai vm" ${hit('view-more', 'View More')}><span style="color:${blue}">View More</span></div>`}</div>
      </div>`);
    }

    if (state.sheet === 'add') {
      parts.unshift(`<div class="backdrop dim"></div>`);
      parts.push(`<div class="sheet add form" style="top:${Math.round(h * 0.14)}px;left:${Math.round((w - 540) / 2)}px;width:540px">
        <div class="nav"><span class="nb" ${hit('dismiss', 'Cancel')}>Cancel</span><b>Add to Home Screen</b><span class="nb strong" ${hit('add', 'Add')}>Add</span></div>
        <div class="card addcard"><div class="row">${appIcon({ name: info.name, icon: info.icon }, 60)}<div class="fields"><div class="name">${esc(info.name)}</div><div class="url">${esc(state.webApp ? (info.start || info.url) : info.url)}</div></div></div></div>
        <div class="card"><div class="ai" ${hit('toggle-webapp', 'Open as Web App')}><span>Open as Web App</span><div class="tog ${state.webApp ? 'on' : ''}"><div></div></div></div></div>
        <p class="cap">An icon will be added to your Home Screen so you can quickly access this website.</p>
      </div>`);
    }
  } else if (state.mode === 'safari') {
    const capY = h - bar + (chin ? 4 : 8);
    parts.push(`
      <div class="btn round" ${hit('back', 'Back')} style="left:14px;top:${capY}px">${svg('back')}</div>
      <div class="btn pill" ${hit('inert', 'Address')} style="left:72px;right:72px;top:${capY}px"><span class="host">${esc(info.host || state.host || '')}</span><span class="rl" ${hit('reload', 'Reload')}>${svg('reload', 18)}</span></div>
      <div class="btn round" ${hit('more', 'More')} style="right:14px;top:${capY}px">${svg('dots')}</div>`);

    if (state.sheet === 'menu') {
      const items = [['share', 'Share', 'share'], ['inert', 'Add to Bookmarks', 'book'], ['inert', 'Add to Favorites', 'star'], ['inert', 'Add to Reading List', 'glasses'],
        ['inert', 'Find on Page', 'find'], ['inert', 'Request Desktop Website', 'desktop'], ['inert', 'New Tab', 'plus'], ['inert', 'New Private Tab', 'tabs']];
      parts.unshift(`<div class="backdrop" ${hit('dismiss', 'Close')}></div>`);
      parts.push(`<div class="menu" style="right:14px;bottom:${bar + 4}px">${items.map(([a, l, ic]) => `<div class="mi" ${hit(a, l)}><span>${l}</span>${svg(ic, 20)}</div>`).join('')}</div>`);
    }

    if (state.sheet === 'share' || state.sheet === 'share-more') {
      const more = state.sheet === 'share-more';
      const people = [['AirDrop', '#1c9bf0'], ['Messages', '#34c759'], ['Mail', '#2f7cf6'], ['Notes', '#ffcc00'], ['Reminders', '#ff9f0a']];
      const actions = more
        ? [['Copy', 'copy'], ['Add to Reading List', 'glasses'], ['Add Bookmark', 'book'], ['Add to Favorites', 'star'], ['Add to Quick Note', 'note'], ['Find on Page', 'find'], ['Add to Home Screen', 'addHome'], ['Markup', 'markup'], ['Print', 'print']]
        : [['Copy', 'copy'], ['Add to Reading List', 'glasses'], ['Add Bookmark', 'book'], ['Add to Favorites', 'star']];
      const icon = info.icon ? `<img src="${esc(info.icon)}" style="width:44px;height:44px;border-radius:10px;object-fit:cover">` : appIcon({ name: info.host }, 44);
      parts.unshift(`<div class="backdrop dim" ${hit('dismiss', 'Close')}></div>`);
      parts.push(`<div class="sheet" style="top:${Math.round(h * (more ? 0.2 : 0.38))}px">
        <div class="grab"></div>
        <div class="shead">${icon}<div class="st"><b>${esc(info.title || info.host)}</b><span>${esc(info.host)} <i style="color:${blue};font-style:normal">Options ›</i></span></div>
          <div class="xbtn" ${hit('dismiss', 'Close')}>${svg('x', 16)}</div></div>
        <div class="people">${people.map(([n, c]) => `<div class="pp" ${hit('inert', n)}><div class="pc" style="background:${c}">${svg('share', 22, 'style="color:#fff"')}</div><span>${n}</span></div>`).join('')}</div>
        <div class="card">${actions.map(([l, ic]) => `<div class="ai" ${hit(l === 'Add to Home Screen' ? 'add-to-home' : 'inert', l)}><span>${l}</span>${svg(ic, 21)}</div>`).join('')}
          ${more ? '' : `<div class="ai vm" ${hit('view-more', 'View More')}><span style="color:${blue}">View More</span></div>`}</div>
      </div>`);
    }

    if (state.sheet === 'add') {
      parts.unshift(`<div class="backdrop dim"></div>`);
      parts.push(`<div class="sheet add" style="top:12px">
        <div class="nav"><span class="nb" ${hit('dismiss', 'Cancel')}>Cancel</span><b>Add to Home Screen</b><span class="nb strong" ${hit('add', 'Add')}>Add</span></div>
        <div class="card addcard"><div class="row">${appIcon({ name: info.name, icon: info.icon }, 60)}<div class="fields"><div class="name">${esc(info.name)}</div><div class="url">${esc(state.webApp ? (info.start || info.url) : info.url)}</div></div></div></div>
        <div class="card"><div class="ai" ${hit('toggle-webapp', 'Open as Web App')}><span>Open as Web App</span><div class="tog ${state.webApp ? 'on' : ''}"><div></div></div></div></div>
        <p class="cap">An icon will be added to your Home Screen so you can quickly access this website.</p>
      </div>`);
    }
  }

  // swiping up from the bottom edge goes Home, from Safari or a web app
  if (state.mode !== 'home') parts.push(`<div ${hit('home', 'Home')} style="position:absolute;left:30%;right:30%;bottom:0;height:${chin ? 0 : 14}px"></div>`);

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  :root { --font: -apple-system, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; }
  html, body { margin: 0; width: ${w}px; height: ${h}px; background: transparent; overflow: hidden; font-family: var(--font); color: ${ink}; -webkit-font-smoothing: antialiased; }
  * { box-sizing: border-box; }
  [data-hit] { cursor: pointer; }
  .backdrop { position: absolute; inset: 0; }
  .backdrop.dim { background: rgba(0,0,0,.32); }
  .btn { position: absolute; height: 48px; background: ${glass}; border: .5px solid ${dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.08)'}; box-shadow: 0 6px 20px rgba(0,0,0,.18); display: flex; align-items: center; justify-content: center; color: ${ink}; backdrop-filter: blur(20px); }
  .round { width: 48px; border-radius: 24px; }
  .tbar { position: absolute; left: 0; right: 0; top: 0; background: ${glass}; border-bottom: .5px solid ${line}; }
  .tb { position: absolute; width: 40px; display: flex; align-items: center; justify-content: center; color: ${blue}; }
  .tb.dim { opacity: .35; }
  .pop { position: absolute; width: 400px; background: ${sheetBg}; border-radius: 22px; padding: 14px 14px 0; box-shadow: 0 12px 48px rgba(0,0,0,.35); }
  .sheet.form { right: auto; bottom: auto; border-radius: 16px; padding-bottom: 16px; }
  .pill { border-radius: 24px; padding: 0 14px 0 18px; font-size: 16px; }
  .host { flex: 1; text-align: center; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rl { display: flex; color: ${ink}; }
  .menu { position: absolute; width: 258px; background: ${glass}; border-radius: 26px; padding: 6px 0; box-shadow: 0 10px 40px rgba(0,0,0,.3); backdrop-filter: blur(30px); }
  .mi { display: flex; justify-content: space-between; align-items: center; padding: 11px 20px; font-size: 16.5px; }
  .sheet { position: absolute; left: 0; right: 0; bottom: 0; background: ${sheetBg}; border-radius: 34px 34px 0 0; padding: 8px 16px 0; box-shadow: 0 -4px 30px rgba(0,0,0,.25); }
  .grab { width: 36px; height: 5px; border-radius: 3px; background: ${line}; margin: 0 auto 10px; }
  .shead { display: flex; align-items: center; gap: 12px; padding: 4px 2px 14px; border-bottom: .5px solid ${line}; }
  .st { flex: 1; min-width: 0; display: flex; flex-direction: column; font-size: 15px; } .st b { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .st span { color: ${sub}; font-size: 13.5px; }
  .xbtn { width: 30px; height: 30px; border-radius: 15px; background: ${dark ? '#3a3a3c' : '#e3e3e8'}; display: grid; place-items: center; color: ${sub}; }
  .people { display: flex; gap: 6px; padding: 14px 0; justify-content: space-between; }
  .pp { width: 66px; display: flex; flex-direction: column; align-items: center; gap: 6px; font-size: 11.5px; }
  .pc { width: 58px; height: 58px; border-radius: 29px; display: grid; place-items: center; }
  .card { background: ${cardBg}; border-radius: 14px; margin-bottom: 14px; overflow: hidden; }
  .ai { display: flex; justify-content: space-between; align-items: center; padding: 13px 16px; font-size: 16.5px; border-bottom: .5px solid ${line}; }
  .ai:last-child { border-bottom: 0; }
  .vm { justify-content: center; }
  .add { border-radius: 14px 14px 0 0; background: ${sheetBg}; }
  .nav { display: flex; justify-content: space-between; align-items: center; padding: 10px 2px 18px; font-size: 17px; }
  .nb { color: ${blue}; } .nb.strong { font-weight: 600; }
  .addcard .row { display: flex; gap: 14px; padding: 14px; align-items: center; }
  .fields { flex: 1; min-width: 0; } .name { font-size: 17px; padding-bottom: 8px; border-bottom: .5px solid ${line}; margin-bottom: 8px; }
  .url { color: ${sub}; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tog { width: 51px; height: 31px; border-radius: 16px; background: ${dark ? '#39393d' : '#e9e9ea'}; position: relative; }
  .tog div { position: absolute; top: 2px; left: 2px; width: 27px; height: 27px; border-radius: 14px; background: #fff; box-shadow: 0 2px 4px rgba(0,0,0,.2); }
  .tog.on { background: #34c759; } .tog.on div { left: 22px; }
  .cap { color: ${sub}; font-size: 13px; margin: -6px 16px 0; line-height: 1.35; }
  .wall { position: absolute; inset: 0; background: radial-gradient(120% 80% at 20% 10%, #6a8dff 0%, #3a3fb8 45%, #1b1446 100%); }
  .app { position: absolute; display: flex; flex-direction: column; align-items: center; gap: 6px; color: #fff; font-size: 12px; text-shadow: 0 1px 2px rgba(0,0,0,.35); }
  .app span { max-width: 84px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dock { position: absolute; left: 12px; right: 12px; height: 92px; border-radius: 34px; background: rgba(255,255,255,.22); backdrop-filter: blur(20px); display: flex; align-items: center; padding-left: 18px; }
  .dockapp { position: static; }
  </style></head><body>${parts.join('')}</body></html>`;
}
