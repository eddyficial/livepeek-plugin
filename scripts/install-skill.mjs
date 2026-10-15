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
 *
 * OpenCode loads a skill only when the model asks for it, so the default and
 * --project installs also add a /livepeek command for it, in
 * ~/.config/opencode/commands (or ./.opencode/commands with --project).
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

/** Where OpenCode's /livepeek command goes; null with --to, a folder of the person's choosing. */
export function commandDir(argv, cwd = process.cwd(), home = os.homedir()) {
  if (argv.includes('--to')) return null;
  if (argv.includes('--project')) return path.join(cwd, '.opencode', 'commands');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode', 'commands');
}

/** OpenCode's /livepeek command: open the pane with any arguments, then follow the skill. */
export const COMMAND = [
  '---',
  'description: Open the livepeek preview pane for this project',
  '---',
  'Open livepeek for this project. Load the `livepeek` skill and follow it. In short: run ' +
  '`livepeek $ARGUMENTS` from the project folder with your shell tool; it opens a live preview ' +
  'in a split pane next to this terminal. Report what it printed. Afterwards, use ' +
  '`livepeek --status`, `livepeek --eval "<js>"` and `livepeek --snapshot .livepeek/snapshot.png` ' +
  '(then read that image) to check your work.',
  '',
].join('\n');

/** Write the /livepeek command under dir; returns the file written. */
export function installCommand(dir) {
  const file = path.join(dir, 'livepeek.md');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, COMMAND);
  return file;
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
    const argv = process.argv.slice(2);
    const file = install(skillsDir(argv));
    const dir = commandDir(argv);
    console.log(`livepeek skill installed: ${file}\n` +
      (dir ? `OpenCode /livepeek command: ${installCommand(dir)}\n` : '') +
      'OpenCode, Codex and Gemini CLI read this folder; start a new session to pick it up.\n' +
      'For another agent, use --to <its skills folder>, or point its instructions file (AGENTS.md) at this one.');
  } catch (e) {
    console.error(`could not install the skill: ${e.message}`);
    process.exit(1);
  }
}
