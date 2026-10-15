#!/usr/bin/env node
/**
 * Copy livepeek's skill into a folder coding agents read skills from, so an
 * agent other than Claude Code knows how to open the pane and check its work.
 *
 *   node install-skill.mjs              ~/.agents/skills/livepeek/SKILL.md
 *   node install-skill.mjs --project    ./.agents/skills/livepeek/SKILL.md
 *   node install-skill.mjs --to <dir>   <dir>/livepeek/SKILL.md
 *
 * `.agents/skills` is the shared Agent Skills location: OpenCode, Codex and
 * Gemini CLI all read it. The skill's `${CLAUDE_PLUGIN_ROOT}` placeholder,
 * which Claude Code fills in itself, is replaced with this install's folder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE = path.join(ROOT, 'skills', 'livepeek', 'SKILL.md');

/** The skills folder to install into, from the command line. */
export function skillsDir(argv, cwd = process.cwd(), home = os.homedir()) {
  const i = argv.indexOf('--to');
  if (i !== -1 && argv[i + 1]) return path.resolve(cwd, argv[i + 1]);
  if (argv.includes('--project')) return path.join(cwd, '.agents', 'skills');
  return path.join(home, '.agents', 'skills');
}

/** The skill text with the install root filled in, forward slashes so it pastes into any shell. */
export function render(text, root = ROOT) {
  return text.split('${CLAUDE_PLUGIN_ROOT}').join(root.split(path.sep).join('/'));
}

/** Write the skill under dir; returns the file written. */
export function install(dir) {
  const file = path.join(dir, 'livepeek', 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, render(fs.readFileSync(SOURCE, 'utf8')));
  return file;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const file = install(skillsDir(process.argv.slice(2)));
    console.log(`livepeek skill installed: ${file}\n` +
      'OpenCode, Codex and Gemini CLI read this folder; start a new session to pick it up.\n' +
      'For another agent, use --to <its skills folder>, or point its instructions file (AGENTS.md) at this one.');
  } catch (e) {
    console.error(`could not install the skill: ${e.message}`);
    process.exit(1);
  }
}
