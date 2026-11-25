import { collectGraphics, doctorVerdict } from '../scripts/doctor.mjs';
import { eq, test } from './helpers.mjs';

const sixel = { cw: 10, ch: 20, cellFrom: '16t', sixel: true, kitty: false };
const silent = { cw: 10, ch: 20, sixel: false, kitty: false };
const healthy = {
  nodeVersion: '24.14.1',
  browser: String.raw`C:\fixture\browser\chrome.exe`,
  driver: { version: '1.63.0', directory: String.raw`C:\fixture\deps\node_modules\playwright-core` },
  env: { WT_SESSION: 'fixture-wt' },
  graphics: sixel,
  npmVersion: '10.9.0',
  home: { directory: String.raw`C:\fixture\home\.livepeek`, error: null },
};

const transcripts = [
  [
    "FAIL node: v18.20.8 is too old (need 20 or newer)",
    "       fix: install a current Node.js (20 or newer) from the Node.js download page",
    "ok   browser: C:\\fixture\\browser\\chrome.exe",
    "ok   driver: playwright-core 1.63.0 (C:\\fixture\\deps\\node_modules\\playwright-core)",
    "ok   multiplexer: wt",
    "ok   graphics: sixel; 10x20px cells (from 16t); would use sixel",
    "ok   npm: v10.9.0",
    "ok   ~/.livepeek: writable (C:\\fixture\\home\\.livepeek)",
    "next: livepeek --doctor",
    "",
    "1 blocking problem: livepeek cannot run yet.",
  ],
  [
    "ok   node: v24.14.1",
    "ok   browser: C:\\fixture\\browser\\chrome.exe",
    "ok   driver: playwright-core 1.63.0 (C:\\fixture\\deps\\node_modules\\playwright-core)",
    "ok   multiplexer: wt",
    "ok   graphics: sixel; 10x20px cells (from 16t); would use sixel",
    "ok   npm: v10.9.0",
    "ok   ~/.livepeek: writable (C:\\fixture\\home\\.livepeek)",
    "next: livepeek",
    "",
    "all good: livepeek can run here.",
  ],
  [
    "ok   node: v24.14.1",
    "ok   browser: C:\\fixture\\browser\\chrome.exe",
    "ok   driver: playwright-core 1.63.0 (C:\\fixture\\deps\\node_modules\\playwright-core)",
    "warn multiplexer: none detected, so there is no pane to split",
    "       fix: start tmux first (works everywhere), or run livepeek with --here to use this pane",
    "ok   graphics: no kitty or sixel; 10x20px cells (guessed); would use text",
    "ok   npm: v10.9.0",
    "ok   ~/.livepeek: writable (C:\\fixture\\home\\.livepeek)",
    "next: livepeek --here",
    "",
    "livepeek can run, with 1 warning.",
  ],
  [
    "ok   node: v24.14.1",
    "ok   browser: C:\\fixture\\browser\\chrome.exe",
    "ok   driver: playwright-core 1.63.0 (C:\\fixture\\deps\\node_modules\\playwright-core)",
    "warn multiplexer: VS Code terminal: split it by hand and run `livepeek --here` in the new half",
    "       fix: or run tmux inside it; for pictures enable terminal.integrated.enableImages",
    "ok   graphics: no kitty or sixel; 10x20px cells (guessed); would use text",
    "ok   npm: v10.9.0",
    "ok   ~/.livepeek: writable (C:\\fixture\\home\\.livepeek)",
    "next: livepeek --here",
    "",
    "livepeek can run, with 1 warning.",
  ],
  [
    "ok   node: v24.14.1",
    "ok   browser: C:\\fixture\\browser\\chrome.exe",
    "FAIL driver: not installed. Run: npm add --global playwright-core@1.63.0",
    "ok   multiplexer: wt",
    "ok   graphics: sixel; 10x20px cells (from 16t); would use sixel",
    "ok   npm: v10.9.0",
    "ok   ~/.livepeek: writable (C:\\fixture\\home\\.livepeek)",
    "next: npm add --global playwright-core@1.63.0",
    "",
    "1 blocking problem: livepeek cannot run yet.",
  ],
  [
    "ok   node: v24.14.1",
    "ok   browser: C:\\fixture\\browser\\chrome.exe",
    "ok   driver: playwright-core 1.63.0 (C:\\fixture\\deps\\node_modules\\playwright-core)",
    "ok   multiplexer: wt",
    "warn graphics: not tested (stdin is not a terminal)",
    "       fix: rerun livepeek --doctor in an interactive terminal",
    "ok   npm: v10.9.0",
    "ok   ~/.livepeek: writable (C:\\fixture\\home\\.livepeek)",
    "next: livepeek --doctor",
    "",
    "1 warning: interactive graphics not tested.",
  ],
];

await test('doctor preserves the seven healthy checks and summary', () => {
  const verdict = doctorVerdict(healthy);
  eq(verdict.lines.filter(line => !line.startsWith('next:')), transcripts[1].filter(line => !line.startsWith('next:')));
  eq(verdict.exitCode, 0);
});

for (const version of ['18.20.8', '19.9.0']) {
  await test(`doctor rejects unsupported Node ${version}`, () => {
    const { lines, exitCode } = doctorVerdict({ ...healthy, nodeVersion: version });
    eq(lines[0], `FAIL node: v${version} is too old (need 20 or newer)`, 'Node prerequisite');
    eq(exitCode, 1);
  });
}

await test('doctor accepts Node 20.0.0', () => {
  const { lines, exitCode } = doctorVerdict({ ...healthy, nodeVersion: '20.0.0' });
  eq(lines[0], 'ok   node: v20.0.0');
  eq(exitCode, 0);
});

await test('doctor warns about the absent splitter and allows current-pane use', () => {
  const { lines, exitCode } = doctorVerdict({ ...healthy, env: {}, graphics: silent });
  eq(lines.find(line => line.includes('multiplexer:')), 'warn multiplexer: none detected, so there is no pane to split', 'missing splitter');
  eq(exitCode, 0);
});

await test('doctor warns that redirected-input graphics were not tested', () => {
  const { lines, exitCode } = doctorVerdict({ ...healthy, graphics: null });
  eq(lines.find(line => line.includes('graphics:')), 'warn graphics: not tested (stdin is not a terminal)', 'redirected graphics');
  eq(exitCode, 0);
});

/** @type {Array<[name: string, facts: Parameters<typeof doctorVerdict>[0], exitCode: number]>} */
const fixtures = [
  ['Node 18', { ...healthy, nodeVersion: '18.20.8' }, 1],
  ['Windows Terminal split', healthy, 0],
  ['current pane', { ...healthy, env: {}, graphics: silent }, 0],
  ['VS Code manual split', { ...healthy, env: { ...healthy.env, TERM_PROGRAM: 'vscode' }, graphics: silent }, 0],
  ['missing driver', { ...healthy, driver: null }, 1],
  ['redirected input', { ...healthy, graphics: null }, 0],
];

for (const [index, [name, facts, exitCode]] of fixtures.entries()) {
  await test(`doctor matches the ${name} transcript`, () => {
    eq(doctorVerdict(facts), { lines: transcripts[index], exitCode });
  });
}

/** @type {Array<[name: string, overrides: Partial<Parameters<typeof doctorVerdict>[0]>, exitCode: number, next: string, summary: string, npmLine?: string]>} */
const precedence = [
  ['old Node over current-pane launch', { nodeVersion: '18.20.8', env: {}, graphics: silent }, 1,
    'livepeek --doctor', '1 blocking problem, 1 warning: livepeek cannot run yet.'],
  ['old Node over driver installation', { nodeVersion: '18.20.8', driver: null, graphics: null }, 1,
    'livepeek --doctor', '2 blocking problems, 1 warning: livepeek cannot run yet.'],
  ['missing driver over current-pane launch', { driver: null, env: {}, graphics: silent }, 1,
    'npm add --global playwright-core@1.63.0', '1 blocking problem, 1 warning: livepeek cannot run yet.'],
  ['missing driver over interactive recheck', { driver: null, graphics: null }, 1,
    'npm add --global playwright-core@1.63.0', '1 blocking problem, 1 warning: livepeek cannot run yet.'],
  ['interactive recheck over current-pane launch', { env: {}, graphics: null }, 0,
    'livepeek --doctor', '2 warnings: interactive graphics not tested.'],
  ['missing npm and driver require repair', { npmVersion: '', driver: null }, 1,
    'livepeek --doctor', '2 blocking problems: livepeek cannot run yet.', 'FAIL npm: not found on PATH'],
  ['missing npm with a driver is a warning', { npmVersion: '' }, 0,
    'livepeek --doctor', 'livepeek can run, with 1 warning.', 'warn npm: not found on PATH'],
  ['unwritable home over a launch suggestion', { home: { ...healthy.home, error: 'EPERM' } }, 1,
    'livepeek --doctor', '1 blocking problem: livepeek cannot run yet.'],
];

for (const [name, facts, exitCode, next, summary, npmLine] of precedence) {
  await test(`doctor selects the next action for ${name}`, () => {
    const verdict = doctorVerdict({ ...healthy, ...facts });
    eq(verdict.exitCode, exitCode);
    eq(verdict.lines.slice(-3), [`next: ${next}`, '', summary]);
    if (npmLine) eq(verdict.lines.find(line => line.includes('npm:')), npmLine);
  });
}

for (const isTTY of [false, undefined, true]) {
  await test(`doctor graphics probe call count with stdin.isTTY=${isTTY}`, async () => {
    let calls = 0;
    const graphics = await collectGraphics(isTTY, async () => {
      calls++;
      return sixel;
    });
    eq(calls, isTTY ? 1 : 0);
    const index = isTTY ? 1 : 5;
    eq(doctorVerdict({ ...healthy, graphics }), { lines: transcripts[index], exitCode: 0 });
  });
}

await test('doctor starts with fresh counts after a failure', () => {
  eq(doctorVerdict({ ...healthy, driver: null, graphics: null }).exitCode, 1);
  eq(doctorVerdict(healthy), { lines: transcripts[1], exitCode: 0 });
});
