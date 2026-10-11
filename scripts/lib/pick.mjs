/**
 * Point mode: the user points at something in the pane and livepeek records
 * what it is, so "make this bigger" has a "this" Claude can find.
 *
 * pickProbe runs inside the page (page.evaluate serialises it, so it must be
 * self-contained). It works out what the pointer means - the button, not the
 * icon inside it - outlines it while hovering, and on a pick describes it:
 * its text, a CSS selector that finds it, and the component that rendered it
 * when a React or Vue dev build says so.
 */
export function pickProbe({ pt, mode }) {
  const ID = '__livepeek_pick';
  let box = document.getElementById(ID);
  if (mode === 'clear' || !pt) { box?.remove(); return null; }

  let el = document.elementFromPoint(pt.x, pt.y);
  if (el && el.id === ID) el = null;
  if (el) {
    // an icon or a span inside a control means the control
    el = el.closest('button,a,input,select,textarea,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch]')
      || (el.closest('svg') ? el.closest('svg').parentElement : el);
  }
  if (!el || el === document.documentElement || el === document.body) { box?.remove(); return null; }

  const esc = (s) => CSS.escape(s);
  const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } };
  // Build-tool class names (css-1x2y3z, _abc12, sc-...) change on every build
  // and say nothing to a reader; leave them out of the selector.
  const stable = (c) => !/^(css|sc|jsx|svelte|astro|emotion)-|^_|[0-9a-f]{5,}/i.test(c);
  const shortName = (n) => {
    const cls = [...n.classList].filter(stable).slice(0, 2);
    return n.tagName.toLowerCase() + (cls.length ? '.' + cls.map(esc).join('.') : '');
  };

  if (mode === 'hover') {
    if (!box) {
      box = document.createElement('div');
      box.id = ID;
      box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;'
        + 'border:2px solid #ff3d81;background:rgba(255,61,129,.12);border-radius:3px;transition:none';
      const tag = document.createElement('span');
      tag.style.cssText = 'position:absolute;left:-2px;padding:1px 5px;border-radius:3px;white-space:nowrap;'
        + 'background:#ff3d81;color:#fff;font:600 11px/16px ui-monospace,Consolas,monospace';
      box.appendChild(tag);
      document.documentElement.appendChild(box);
    }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    const tag = /** @type {HTMLElement} */ (box.firstChild);
    tag.textContent = shortName(el);
    // the label sits above the outline, or inside it at the top of the page
    tag.style.top = r.top >= 18 ? '-20px' : '0';
    return shortName(el);
  }

  // mode === 'pick'
  box?.remove();
  const selectorFor = (node) => {
    if (node.id && unique('#' + esc(node.id))) return '#' + esc(node.id);
    const parts = [];
    for (let n = node; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n !== node && n.id && unique('#' + esc(n.id))) { parts.unshift('#' + esc(n.id)); break; }
      let part = shortName(n);
      const same = n.parentElement ? [...n.parentElement.children].filter(c => c.tagName === n.tagName) : [];
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(n) + 1})`;
      parts.unshift(part);
      if (unique(parts.join(' > '))) break;
      if (parts.length >= 6) break;
    }
    return parts.join(' > ');
  };
  // React keeps the fiber on the DOM node; walking up it reaches the nearest
  // function component. Vue 3 dev builds keep the component instance.
  const componentOf = (node) => {
    for (let n = node; n; n = n.parentElement) {
      const key = Object.keys(n).find(k => k.startsWith('__reactFiber$'));
      if (key) {
        for (let f = n[key]; f; f = f.return) {
          const t = f.type;
          const name = typeof t === 'function' ? (t.displayName || t.name)
            : t && typeof t === 'object' ? (t.displayName || t.render?.displayName || t.render?.name || t.type?.name) : null;
          if (name) return name;
        }
        return null;
      }
      const v = n.__vueParentComponent;
      if (v) return v.type?.__name || v.type?.name || null;
    }
    return null;
  };
  const r = el.getBoundingClientRect();
  const htmlEl = /** @type {HTMLElement} */ (el);
  const inputEl = /** @type {HTMLInputElement} */ (el);
  const text = (htmlEl.innerText || inputEl.value || el.getAttribute('aria-label') || el.getAttribute('alt')
    || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ');
  return {
    tag: el.tagName.toLowerCase(),
    text: text.slice(0, 120),
    selector: selectorFor(el),
    component: componentOf(el),
    role: el.getAttribute('role'),
    box: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    html: el.outerHTML.replace(/\s+/g, ' ').slice(0, 300),
  };
}

/**
 * One line naming a pick, for the clipboard: pasted into Claude it says what
 * "this" is. Plain ASCII, as not every clipboard and console keeps the rest.
 */
export function pickReference(p) {
  const bits = [`<${p.tag}>`];
  if (p.text) bits.push(JSON.stringify(p.text.length > 60 ? p.text.slice(0, 57) + '...' : p.text));
  bits.push(p.selector);
  if (p.component) bits.push(`in <${p.component}>`);
  if (p.url) bits.push(`on ${p.url}`);
  return `[livepeek pick] ${bits.join(' | ')}`;
}
