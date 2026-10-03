// Projects peek has shown before, so the `p` picker can switch to any of
// them - not only to dev servers that happen to be running right now.
//
// One JSON file, most recent first, capped so it never grows unbounded.
// Entries whose folder has since been deleted are dropped on read.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.homedir(), '.peek');
const FILE = path.join(DIR, 'projects.json');
const MAX = 20;

/**
 * @typedef {object} Project
 * @prop {string} dir       project folder (the key)
 * @prop {string} name      short label, usually the folder name
 * @prop {string} kind      'site' | 'document' | framework id such as 'vite'
 * @prop {string|null} file file served for a static folder, else null
 * @prop {string|null} url  dev server url for a framework project, else null
 * @prop {string|null} script npm script that starts the dev server
 * @prop {number|null} port port that script listens on
 * @prop {string} preset    viewport id it was last shown at
 * @prop {number} at        last shown, ms since epoch
 */

/** @returns {Project[]} most recent first, folders that still exist */
export function list() {
  let all = [];
  try { all = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
  if (!Array.isArray(all)) return [];
  return all.filter(p => p && p.dir && fs.existsSync(p.dir));
}

/** Record a project as just shown, moving it to the top. */
export function remember(project) {
  if (!project?.dir) return;
  const dir = path.resolve(project.dir);
  const rest = list().filter(p => path.resolve(p.dir) !== dir);
  const next = [{ ...project, dir, at: Date.now() }, ...rest].slice(0, MAX);
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(next, null, 1));
  } catch { /* remembering is a convenience, never worth failing a launch */ }
}
