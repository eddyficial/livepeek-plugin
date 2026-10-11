/** Pane slots: each terminal pane gets its own livepeek pane (lib/session.mjs). */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SCRIPTS, HOME, lib, tmpdir, test, eq, assert } from './helpers.mjs';

const KEEP = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'LANG', 'LC_ALL'];

/** Run a script with only the terminal variables given, under the temp HOME. */
function run(script, args, extra = {}) {
  const env = { HOME, USERPROFILE: HOME, ...extra };
  for (const k of KEEP) if (process.env[k] !== undefined) env[k] = process.env[k];
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    cwd: tmpdir('slots'), env, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const session = await lib('session.mjs');
const PANES = path.join(HOME, '.livepeek', 'panes');

/** Fake a live pane in a slot: this test process's pid and a fresh heartbeat. */
function fakePane(slot, preset, root = null) {
  fs.mkdirSync(PANES, { recursive: true });
  fs.writeFileSync(path.join(PANES, slot + '.json'), JSON.stringify({ pid: process.pid, host: 'wt', target: 'http://x/', root, preset, errors: 2 }));
  fs.writeFileSync(path.join(PANES, slot + '.alive'), '');
}
const reset = () => fs.rmSync(PANES, { recursive: true, force: true });

await test('slot follows the innermost host, not a stale inherited variable', () => {
  const wt = session.slotFromEnv({ WT_SESSION: 'a' });
  eq(session.validSlot(wt) && wt !== 'default', true, 'wt slot');
  eq(session.slotFromEnv({ WT_SESSION: 'a' }), wt, 'stable');
  assert(session.slotFromEnv({ WT_SESSION: 'b' }) !== wt, 'another tab, another slot');
  assert(session.slotFromEnv({ TMUX: '1', TMUX_PANE: '%1', WT_SESSION: 'a' }) !== wt, 'tmux inside wt uses the tmux pane');
  eq(session.slotFromEnv({ TERM_PROGRAM: 'vscode', WT_SESSION: 'a' }), 'default', 'vscode ignores an inherited WT_SESSION');
  eq(session.slotFromEnv({}), 'default', 'no host');
  eq(session.validSlot('../../x'), false, 'path rejected');
});

await test('--status reads this terminal\'s pane, not another one', () => {
  reset();
  const mine = session.slotFromEnv({ LIVEPEEK_SLOT: 'mine' });
  fakePane(mine, 'pixel-9');
  fakePane(session.slotFromEnv({ LIVEPEEK_SLOT: 'other' }), 'desktop');
  const r = run('pane.mjs', ['--status'], { LIVEPEEK_SLOT: 'mine' });
  eq(r.status, 0, 'exit\n' + r.out);
  const s = JSON.parse(r.out);
  eq([s.slot, s.preset, s.errors], [mine, 'pixel-9', 2], 'own pane');
});

await test('--status falls back to the only pane, and refuses to guess between several', () => {
  reset();
  fakePane(session.slotFromEnv({ LIVEPEEK_SLOT: 'a' }), 'desktop');
  let r = run('pane.mjs', ['--status'], { LIVEPEEK_SLOT: 'nobody' });
  eq(r.status, 0, 'one pane\n' + r.out);
  eq(JSON.parse(r.out).preset, 'desktop', 'fallback');
  fakePane(session.slotFromEnv({ LIVEPEEK_SLOT: 'b' }), 'laptop');
  r = run('pane.mjs', ['--status'], { LIVEPEEK_SLOT: 'nobody' });
  eq(r.status, 1, 'several\n' + r.out);
  assert(r.out.includes('several livepeek panes'), r.out);
});

await test('control commands go to the pane showing this project, even one another terminal opened', () => {
  reset();
  const mine = session.slotFromEnv({ LIVEPEEK_SLOT: 'mine' });
  const other = session.slotFromEnv({ LIVEPEEK_SLOT: 'other' });
  fakePane(mine, 'fit', path.join(HOME, 'elsewhere'));
  // on Windows, in another spelling of the same folder
  const here = tmpdir('slots') + path.sep;
  fakePane(other, 'pixel-9', process.platform === 'win32' ? here.toUpperCase() : here);
  let r = run('pane.mjs', ['--status'], { LIVEPEEK_SLOT: 'mine' });
  eq(r.status, 0, 'exit\n' + r.out);
  eq([JSON.parse(r.out).slot, JSON.parse(r.out).preset], [other, 'pixel-9'], 'project pane');
  // this terminal's own pane still wins when it shows this project too
  fakePane(mine, 'fit', tmpdir('slots'));
  r = run('pane.mjs', ['--status'], { LIVEPEEK_SLOT: 'mine' });
  eq(JSON.parse(r.out).slot, mine, 'own pane on the same project');
  // and when no pane shows this project, it is the own pane as before
  fakePane(mine, 'fit', null);
  fakePane(other, 'pixel-9', path.join(HOME, 'elsewhere'));
  r = run('pane.mjs', ['--status'], { LIVEPEEK_SLOT: 'mine' });
  eq(JSON.parse(r.out).slot, mine, 'own pane otherwise');
  // --quit never closes another terminal's view in place of this one's
  fakePane(other, 'pixel-9', here);
  run('pane.mjs', ['--quit'], { LIVEPEEK_SLOT: 'mine' });
  const quit = (slot) => !!JSON.parse(fs.readFileSync(path.join(PANES, slot + '.json'), 'utf8')).quit;
  eq([quit(mine), quit(other)], [true, false], '--quit closes the own pane');
});

await test('--status does not fall back while this terminal\'s own pane is starting', () => {
  reset();
  fakePane(session.slotFromEnv({ LIVEPEEK_SLOT: 'a' }), 'desktop');
  fs.writeFileSync(path.join(PANES, session.slotFromEnv({ LIVEPEEK_SLOT: 'mine' }) + '.lock'), '1');
  const r = run('pane.mjs', ['--status'], { LIVEPEEK_SLOT: 'mine' });
  eq(r.status, 1, 'exit\n' + r.out);
  assert(r.out.includes('still starting'), r.out);
  reset();
});

await test('tui --slot rejects anything that is not a slot name', () => {
  const r = run('tui.mjs', ['--slot', '../../etc', '--list']);
  eq(r.status, 1, 'exit\n' + r.out);
  assert(r.out.includes('bad --slot'), r.out);
});

await test('--new gives the extra pane a slot of its own', () => {
  const dir = tmpdir('slots-new');
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>x</h1>');
  const slotOf = (args) => {
    // --dry-run only prints the pane command when there is a host to split;
    // CI runners have none, so pretend to be inside Windows Terminal
    // (nothing is launched, the command is only printed).
    const env = { ...process.env, HOME, USERPROFILE: HOME, LIVEPEEK_SLOT: 'mine', WT_SESSION: '00000000-0000-0000-0000-000000000001' };
    for (const k of ['TMUX', 'ZELLIJ', 'KITTY_WINDOW_ID', 'WEZTERM_PANE', 'TERM_PROGRAM']) delete env[k];
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'pane.mjs'), '--dry-run', ...args], {
      cwd: dir, encoding: 'utf8', env });
    return (r.stdout.match(/--slot (\S+)/) || [])[1];
  };
  const mine = session.slotFromEnv({ LIVEPEEK_SLOT: 'mine' });
  eq(slotOf([]), mine, 'normal launch uses the terminal slot');
  const extra = slotOf(['--new']);
  assert(session.validSlot(extra) && extra !== mine, 'extra slot: ' + extra);
});
