// Where the browser driver (playwright-core, or full playwright) may be.
//
// livepeek installs nothing itself, so the driver has to be found wherever the
// user put it: a global `npm install -g`, the project's own node_modules, or
// a copy next to these scripts. tui.mjs and doctor.mjs share this list so
// the two can never disagree about whether the driver is there.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

export const DRIVER_PACKAGES = ['playwright', 'playwright-core', 'patchright'];

/** Directories to resolve the driver from, most specific first. Each ends in a separator. */
export function driverRoots(scriptsDir) {
  const roots = [process.cwd(), scriptsDir];
  if (process.env.CLAUDE_PLUGIN_ROOT) roots.push(process.env.CLAUDE_PLUGIN_ROOT);
  // npm's global root as this environment describes it
  for (const g of [process.env.npm_config_prefix, process.env.NODE_PATH]) {
    if (g) roots.push(path.join(g, 'node_modules'));
  }
  // the places `npm install -g` puts packages by default
  const home = os.homedir();
  if (process.platform === 'win32') {
    if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  } else {
    roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules', '/opt/homebrew/lib/node_modules',
      path.join(home, '.npm-global', 'lib', 'node_modules'));
  }
  return roots.map(r => r + path.sep);
}

/** Resolve the driver's chromium launcher, or null. */
export function findDriver(scriptsDir) {
  const tryRoots = (roots) => {
    for (const root of roots) {
      for (const pkg of DRIVER_PACKAGES) {
        try {
          const mod = createRequire(root)(pkg);
          const chromium = mod?.chromium ?? mod?.default?.chromium;
          if (chromium) return { chromium, pkg, root };
        } catch { /* try the next root */ }
      }
    }
    return null;
  };
  return tryRoots(driverRoots(scriptsDir)) || tryRoots(npmGlobalRoot());
}

/** Where the driver's package.json is, for a report; null if not installed. */
export function locateDriver(scriptsDir) {
  const tryRoots = (roots) => {
    for (const root of roots) {
      for (const pkg of DRIVER_PACKAGES) {
        try { return createRequire(root).resolve(pkg + '/package.json'); } catch { /* next */ }
      }
    }
    return null;
  };
  return tryRoots(driverRoots(scriptsDir)) || tryRoots(npmGlobalRoot());
}

/** Ask npm where its global packages live, as a last resort. Nothing is installed. */
function npmGlobalRoot() {
  try {
    const r = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true, windowsHide: true, timeout: 8000 });
    const dir = (r.stdout || '').trim();
    return dir && fs.existsSync(dir) ? [dir + path.sep] : [];
  } catch { return []; }
}
