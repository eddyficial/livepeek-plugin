/**
 * Work out what this project is and how to look at it.
 *
 * The preview itself only ever needs a URL. Everything here exists so the
 * user does not have to supply one: given a project directory, figure out
 * which dev server it runs, on which port, and what viewport makes sense to
 * open on.
 *
 * Adding a framework is one entry in FRAMEWORKS. Order matters - the first
 * match wins, so narrow signals (expo) must come before broad ones (react).
 */

import fs from 'node:fs';
import path from 'node:path';

// Libraries that mean "this draws to a canvas", which changes the default
// viewport from a page breakpoint to an aspect ratio.
const GAME_LIBS = [
  'phaser', 'three', 'pixi.js', '@babylonjs/core', 'babylonjs',
  'excalibur', 'kaplay', 'kaboom', 'matter-js', 'p5', 'playcanvas',
];

// Config files that can set the dev server port, and the object holding it.
const VITE_CONFIGS = ['vite.config.ts', 'vite.config.mts', 'vite.config.js',
  'vite.config.mjs', 'vite.config.cts', 'vite.config.cjs'];
const ASTRO_CONFIGS = ['astro.config.mjs', 'astro.config.ts', 'astro.config.mts',
  'astro.config.js', 'astro.config.cjs'];
const NUXT_CONFIGS = ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs'];

const FRAMEWORKS = [
  // --- native / mobile, previewed through their web build ---------------
  { id: 'expo',      dep: 'expo',             port: 8081, script: 'start', preset: 'iphone-15-pro',
    needs: ['react-dom', 'react-native-web'],
    install: 'npx expo install react-dom react-native-web @expo/metro-runtime' },

  // --- meta-frameworks ---------------------------------------------------
  { id: 'next',      dep: 'next',             port: 3000, script: 'dev',   preset: 'desktop' },
  { id: 'nuxt',      dep: 'nuxt',             port: 3000, script: 'dev',   preset: 'desktop',
    config: { files: NUXT_CONFIGS, block: 'devServer' } },
  { id: 'sveltekit', dep: '@sveltejs/kit',    port: 5173, script: 'dev',   preset: 'desktop',
    config: { files: VITE_CONFIGS, block: 'server' } },
  { id: 'astro',     dep: 'astro',            port: 4321, script: 'dev',   preset: 'desktop',
    config: { files: ASTRO_CONFIGS, block: 'server' } },
  { id: 'remix',     dep: '@remix-run/dev',   port: 3000, script: 'dev',   preset: 'desktop' },
  { id: 'gatsby',    dep: 'gatsby',           port: 8000, script: 'develop', preset: 'desktop' },
  { id: 'docusaurus',dep: '@docusaurus/core', port: 3000, script: 'start', preset: 'desktop' },
  { id: 'angular',   dep: '@angular/core',    port: 4200, script: 'start', preset: 'desktop' },
  { id: 'cra',       dep: 'react-scripts',    port: 3000, script: 'start', preset: 'desktop' },

  // --- bare bundlers -----------------------------------------------------
  { id: 'vite',      dep: 'vite',             port: 5173, script: 'dev',   preset: 'desktop',
    config: { files: VITE_CONFIGS, block: 'server' } },
  { id: 'parcel',    dep: 'parcel',           port: 1234, script: 'start', preset: 'desktop' },
  { id: 'webpack',   dep: 'webpack-dev-server', port: 8080, script: 'start', preset: 'desktop' },
];

/**
 * A port named explicitly in the dev script beats the framework's default.
 *
 * Overriding the port in package.json is extremely common, and guessing the
 * framework default instead is worse than failing: another project may well
 * be sitting on that default, so you would quietly preview the wrong app.
 */
function portFromScript(cmd) {
  if (!cmd) return null;
  const m = cmd.match(/--port[= ]\s*(\d{2,5})/)
         || cmd.match(/\bPORT=(\d{2,5})/)
         || cmd.match(/\s-p\s+(\d{2,5})\b/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Blank out strings and comments, keeping everything else in place, so a
 * port in a proxy URL or a commented-out line is never mistaken for the real
 * setting.
 */
function codeOnly(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 1;
      out += ' ';
    } else if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      out += '""';
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * The port a dev server config file sets, e.g. `server: { port: 5280 }` in
 * vite.config.ts. Only keys directly inside that object count: Vite's
 * `server.hmr.port` is the websocket, not the page.
 *
 * Read as text rather than imported: importing a config runs the user's code
 * and, for TypeScript, needs a compiler. A port that is computed at runtime
 * (`port: Number(process.env.PORT) || 5280`) still yields its literal.
 */
export function portFromConfig(src, block) {
  const code = codeOnly(src);
  const re = new RegExp(`\\b${block}\\s*:\\s*\\{`, 'g');
  for (let m; (m = re.exec(code));) {
    let depth = 1, top = '';
    for (let i = m.index + m[0].length; i < code.length && depth > 0; i++) {
      const c = code[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (depth === 1) top += c;
    }
    const p = top.match(/\bport\s*:[^,\n]*?\b(\d{2,5})\b/);
    if (p) return parseInt(p[1], 10);
  }
  return null;
}

function portFromConfigFiles(dir, config) {
  if (!dir || !config) return null;
  for (const f of config.files) {
    let src;
    try { src = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    return portFromConfig(src, config.block);
  }
  return null;
}

/**
 * @param {object} pkg  parsed package.json
 * @param {string} [dir] project folder, for reading the framework's config file
 * @returns {{id, port, portFrom: 'script'|'config'|'default', script, preset, kind: string, needs?, install?, missing: string[]}|null}
 */
export function detectFramework(pkg, dir) {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  const hit = FRAMEWORKS.find(f => deps[f.dep]);
  if (!hit) return null;

  // A canvas library overrides the page-shaped default, but never for Expo -
  // a React Native game is still laid out as a phone screen.
  const isGame = hit.id !== 'expo' && GAME_LIBS.some(l => deps[l]);
  const preset = isGame ? 'game-720p' : hit.preset;

  // Only run a script that actually exists; fall back to whatever dev-ish
  // script the project does define.
  const scripts = pkg.scripts || {};
  const script = scripts[hit.script] ? hit.script
    : ['dev', 'start', 'serve', 'develop'].find(s => scripts[s]) || null;

  // A flag on the command line beats the config file, as it does when the
  // dev server itself starts.
  const fromScript = portFromScript(scripts[script]);
  const fromConfig = fromScript == null ? portFromConfigFiles(dir, hit.config) : null;
  /** @type {'script'|'config'|'default'} */
  const portFrom = fromScript != null ? 'script' : fromConfig != null ? 'config' : 'default';

  const fw = {
    ...hit,
    preset,
    script,
    port: fromScript ?? fromConfig ?? hit.port,
    portFrom,
    kind: isGame ? 'game' : hit.id === 'expo' ? 'mobile' : 'web',
    missing: (hit.needs || []).filter(d => !deps[d]),
  };
  delete fw.config;
  return fw;
}

/** Human summary for the footer and for error messages. */
export function describe(fw) {
  if (!fw) return 'unknown project';
  return `${fw.id} (${fw.kind})`;
}
