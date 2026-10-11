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

// Libraries that mean "this draws to a canvas", which changes the default
// viewport from a page breakpoint to an aspect ratio.
const GAME_LIBS = [
  'phaser', 'three', 'pixi.js', '@babylonjs/core', 'babylonjs',
  'excalibur', 'kaplay', 'kaboom', 'matter-js', 'p5', 'playcanvas',
];

const FRAMEWORKS = [
  // --- native / mobile, previewed through their web build ---------------
  { id: 'expo',      dep: 'expo',             port: 8081, script: 'start', preset: 'iphone-15-pro',
    needs: ['react-dom', 'react-native-web'],
    install: 'npx expo install react-dom react-native-web @expo/metro-runtime' },

  // --- meta-frameworks ---------------------------------------------------
  { id: 'next',      dep: 'next',             port: 3000, script: 'dev',   preset: 'desktop' },
  { id: 'nuxt',      dep: 'nuxt',             port: 3000, script: 'dev',   preset: 'desktop' },
  { id: 'sveltekit', dep: '@sveltejs/kit',    port: 5173, script: 'dev',   preset: 'desktop' },
  { id: 'astro',     dep: 'astro',            port: 4321, script: 'dev',   preset: 'desktop' },
  { id: 'remix',     dep: '@remix-run/dev',   port: 3000, script: 'dev',   preset: 'desktop' },
  { id: 'gatsby',    dep: 'gatsby',           port: 8000, script: 'develop', preset: 'desktop' },
  { id: 'docusaurus',dep: '@docusaurus/core', port: 3000, script: 'start', preset: 'desktop' },
  { id: 'angular',   dep: '@angular/core',    port: 4200, script: 'start', preset: 'desktop' },
  { id: 'cra',       dep: 'react-scripts',    port: 3000, script: 'start', preset: 'desktop' },

  // --- bare bundlers -----------------------------------------------------
  { id: 'vite',      dep: 'vite',             port: 5173, script: 'dev',   preset: 'desktop' },
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
 * @param {object} pkg  parsed package.json
 * @returns {{id, port, script, preset, kind: string, needs?, install?, missing: string[]}|null}
 */
export function detectFramework(pkg) {
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

  return {
    ...hit,
    preset,
    script,
    port: portFromScript(scripts[script]) ?? hit.port,
    kind: isGame ? 'game' : hit.id === 'expo' ? 'mobile' : 'web',
    missing: (hit.needs || []).filter(d => !deps[d]),
  };
}

/** Human summary for the footer and for error messages. */
export function describe(fw) {
  if (!fw) return 'unknown project';
  return `${fw.id} (${fw.kind})`;
}
