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
 * OpenCode and Gemini CLI load a skill only when the model asks for it, so the
 * default and --project installs also add a /livepeek command for each:
 * ~/.config/opencode/commands/livepeek.md and ~/.gemini/commands/livepeek.toml
 * (or .opencode/commands and .gemini/commands in the project with --project).
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

/** What the /livepeek command asks the agent to do; `args` is the agent's placeholder for what follows it. */
function instruction(args) {
  return 'Open livepeek for this project. Load the `livepeek` skill and follow it. In short: run ' +
    `\`livepeek ${args}\` from the project folder with your shell tool; it opens a live preview ` +
    'in a split pane next to this terminal. Report what it printed. Afterwards, use ' +
    '`livepeek --status`, `livepeek --eval "<js>"` and `livepeek --snapshot .livepeek/snapshot.png` ' +
    '(then read that image) to check your work.';
}

const DESCRIPTION = 'Open the livepeek preview pane for this project';

/** OpenCode's /livepeek command, a markdown file with frontmatter. */
export const OPENCODE_COMMAND = ['---', `description: ${DESCRIPTION}`, '---', instruction('$ARGUMENTS'), ''].join('\n');

/** Gemini CLI's /livepeek command, a TOML file; ''' strings keep the backticks and quotes literal. */
export const GEMINI_COMMAND = `description = "${DESCRIPTION}"\nprompt = '''\n${instruction('{{args}}')}\n'''\n`;

/** The /livepeek command files to write: none with --to, a folder of the person's choosing. */
export function commandFiles(argv, cwd = process.cwd(), home = os.homedir()) {
  if (argv.includes('--to')) return [];
  if (argv.includes('--project')) {
    return [
      { agent: 'OpenCode', file: path.join(cwd, '.opencode', 'commands', 'livepeek.md'), text: OPENCODE_COMMAND },
      { agent: 'Gemini CLI', file: path.join(cwd, '.gemini', 'commands', 'livepeek.toml'), text: GEMINI_COMMAND },
    ];
  }
  const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [
    { agent: 'OpenCode', file: path.join(config, 'opencode', 'commands', 'livepeek.md'), text: OPENCODE_COMMAND },
    { agent: 'Gemini CLI', file: path.join(home, '.gemini', 'commands', 'livepeek.toml'), text: GEMINI_COMMAND },
  ];
}

/** Write one command file; returns its path. */
export function installCommand({ file, text }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
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
    const commands = commandFiles(argv).map((c) => `${c.agent} /livepeek command: ${installCommand(c)}\n`).join('');
    console.log(`livepeek skill installed: ${file}\n` + commands +
      'Codex, OpenCode and Gemini CLI read this folder; start a new session to pick it up.\n' +
      'For another agent, use --to <its skills folder>, or point its instructions file (AGENTS.md) at this one.');
  } catch (e) {
    console.error(`could not install the skill: ${e.message}`);
    process.exit(1);
  }
}
