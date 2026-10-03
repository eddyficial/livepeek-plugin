// What can this terminal actually do?
//
// The preview used to assume sixel and leave the user to press 'b' if the
// result was garbage. That is a fine default on the one machine this was
// written on and a bad one everywhere else, so capabilities are now probed.
//
// Everything here degrades to a usable default on silence: a terminal that
// answers nothing gets half-blocks, which works on anything with truecolor.

const ESC = '\x1b';

/**
 * Ask the terminal about itself, then wait a fixed window for replies.
 *
 * Four questions go out at once:
 *   ESC[14t      text area size in pixels (XTWINOPS)  -> cell size
 *   OSC 11       background colour                     -> phone body matte
 *   ESC[c        primary device attributes (DA1)       -> ";4" means sixel
 *   APC G a=q    kitty graphics query                  -> "OK" means kitty
 *
 * We always wait the full window rather than returning as soon as the first
 * two land - DA1 and the kitty query are the slowest to come back and are
 * exactly the ones we would otherwise miss.
 */
export function probeTerminal({ timeout = 400 } = {}) {
  return new Promise((resolve) => {
    let cols = process.stdout.columns || 80;
    let rows = process.stdout.rows || 24;
    const result = { cw: 10, ch: 20, bg: [12, 12, 12], sixel: false, kitty: false };

    if (!process.stdin.isTTY) return resolve(applyEnvHints(result));

    let buf = '';
    const onData = (chunk) => { buf += chunk.toString('latin1'); };

    process.stdin.on('data', onData);
    process.stdout.write(
      `${ESC}[14t` +
      `${ESC}[16t` +          // cell size in pixels, for terminals that skip 14t
      `${ESC}[999;999H${ESC}[6n` +   // park the cursor at the corner and ask where it is
      `${ESC}[?2;1S` +        // XTSMGRAPHICS: largest sixel image, in pixels
      `${ESC}]11;?${ESC}\\` +
      `${ESC}[c` +
      // 1x1 black pixel, transmit-only, just to see if we get an ack
      `${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${ESC}\\`
    );

    setTimeout(() => {
      process.stdin.off('data', onData);

      // The cursor-position reply (ESC [ rows ; cols R) is the one size answer
      // that is always about this pane. A pane Windows Terminal has just split
      // reports the parent window's rows through process.stdout and CSI 14t
      // for a moment, which sized the image for a taller pane and put the
      // footer below the visible area until the first resize.
      const cpr = buf.match(/\x1b\[(\d+);(\d+)R/);
      if (cpr) {
        const r = parseInt(cpr[1], 10), k = parseInt(cpr[2], 10);
        if (r > 2 && k > 2) { rows = r; cols = k; result.rows = r; result.cols = k; }
      }

      // Cell size matters: if it is guessed wrong the image is drawn at the
      // wrong scale, which on a high-DPI display shrinks the page to a sliver.
      // The exact cell reply (16t) beats dividing a window size by a row count.
      const size = buf.match(/\x1b\[4;(\d+);(\d+)t/);
      const cell = buf.match(/\x1b\[6;(\d+);(\d+)t/);
      const geo = buf.match(/\x1b\[\?2;0;(\d+);(\d+)S/);
      if (cell && parseInt(cell[2], 10) > 0 && parseInt(cell[1], 10) > 0) {
        result.cw = parseInt(cell[2], 10); result.ch = parseInt(cell[1], 10); result.cellFrom = '16t';
      } else if (size) {
        const px = parseInt(size[2], 10), py = parseInt(size[1], 10);
        if (px > 0 && py > 0) {
          result.cw = Math.max(1, Math.floor(px / cols));
          result.ch = Math.max(1, Math.floor(py / rows));
          result.cellFrom = '14t';
        }
      } else if (geo) {
        const px = parseInt(geo[1], 10), py = parseInt(geo[2], 10);
        if (px >= cols && py >= rows) {
          result.cw = Math.max(1, Math.floor(px / cols));
          result.ch = Math.max(1, Math.floor(py / rows));
          result.cellFrom = 'xtsmgraphics';
        }
      }

      // OSC 11 reply: rgb:RRRR/GGGG/BBBB (16 bits per channel)
      const bg = buf.match(/\x1b\]11;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i);
      if (bg) {
        result.bg = [1, 2, 3].map(i => {
          const hex = bg[i];
          return Math.round(parseInt(hex, 16) / (16 ** hex.length - 1) * 255);
        });
      }

      // DA1 reply: ESC [ ? 62 ; 4 ; 6 c  - attribute 4 is "sixel graphics"
      const da1 = buf.match(/\x1b\[\?([0-9;]+)c/);
      if (da1 && da1[1].split(';').includes('4')) result.sixel = true;

      // kitty answers its own query with ESC _ G i=31;OK ESC \
      if (/\x1b_Gi=31;OK/.test(buf)) result.kitty = true;

      resolve(applyEnvHints(result));
    }, timeout);
  });
}

/**
 * Terminals that do not answer the probes but are known quantities.
 *
 * Ghostty is the important one: it speaks the kitty protocol, has no sixel,
 * and under tmux the query reply can be eaten before it reaches us - so an
 * unprobed Ghostty would land on half-blocks for no good reason.
 */
function applyEnvHints(caps) {
  const term = process.env.TERM || '';
  const prog = (process.env.TERM_PROGRAM || '').toLowerCase();

  if (process.env.KITTY_WINDOW_ID || term === 'xterm-kitty') caps.kitty = true;
  if (process.env.GHOSTTY_RESOURCES_DIR || prog === 'ghostty') caps.kitty = true;
  if (process.env.WEZTERM_PANE) caps.sixel = true;
  if (prog === 'iterm.app' || prog === 'wezterm') caps.sixel = true;
  // VS Code's terminal inherits whatever environment VS Code was launched
  // from, so ZELLIJ or WT_SESSION may be set with no such terminal in sight.
  // In VS Code only the probe replies count (it answers both honestly).
  const inVsCode = prog === 'vscode';
  if (process.env.WT_SESSION && !inVsCode) caps.sixel = true;      // Windows Terminal >= 1.22
  if (term.includes('mlterm') || term.includes('foot')) caps.sixel = true;

  // Zellij on Windows passes the terminal's "I can do sixel" reply through
  // but draws neither sixel nor kitty graphics itself: the pane stays black
  // with a footer saying "live". Verified on Zellij 0.44 over Windows
  // Terminal. Half-blocks are the only thing that shows there.
  if (process.env.ZELLIJ !== undefined && process.platform === 'win32' && !inVsCode) {
    caps.sixel = false;
    caps.kitty = false;
    caps.note = 'zellij on windows shows no graphics: showing the page as text';
  }

  // VS Code's terminal draws sixel only with terminal.integrated.enableImages
  // on; its DA1 reply says so honestly, so the probe is right either way.
  // The note tells the user what to flip rather than leaving them in text.
  if (prog === 'vscode' && !caps.sixel && !caps.kitty) {
    caps.note = 'vs code: enable terminal.integrated.enableImages for pictures; showing text';
  }

  caps.tmux = !!process.env.TMUX;
  return caps;
}

/**
 * Best renderer for these capabilities, honouring an explicit --render.
 *
 * kitty is preferred over sixel where both exist: it takes raw RGB, so it
 * skips the 128-colour quantisation sixel needs.
 */
export function pickRenderer(caps, requested = 'auto') {
  if (requested === 'kitty' || requested === 'sixel' || requested === 'blocks') {
    return requested;
  }
  // tmux reliably passes sixel through on 3.4+; kitty graphics in tmux is
  // still a coin flip, so prefer sixel there when we have the choice.
  if (caps.tmux && caps.sixel) return 'sixel';
  if (caps.kitty) return 'kitty';
  if (caps.sixel) return 'sixel';
  // No graphics at all: text is readable, half-blocks are not. b cycles to
  // blocks for the rare page where the picture matters more than the words.
  return 'text';
}
