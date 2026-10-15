---
name: livepeek
description: Open a live view of whatever the user is building - a website, a game, a phone app, a document, a mockup - in a split terminal pane, and look at it yourself after making changes. Use when the user says "/livepeek:livepeek", "livepeek", "show me", "open the preview", "let me see it", "start the emulator", "view the site", "preview this file", or asks to watch what they are building while they edit. Also use after editing UI, game or document files to verify the change visually, and for "the preview is blank / looks wrong".
metadata:
  version: "0.7.10"
---

# livepeek: a live viewing portal in the terminal

Opens a live view of the current project in a split pane in the user's
existing terminal. No browser window, no emulator, nothing to alt-tab to.

The pane is interactive: click and scroll go through to the page.

Works for anything a dev server can serve (websites, games on a canvas, phone
apps through their web build) and for things with no server at all: a folder
with an `index.html`, a single `.html` mockup, or a markdown document. Those
are served by livepeek itself, with live reload.

Nothing needs installing in the user's project. livepeek drives the Chrome or
Edge already on the machine through `playwright-core`, which the user installs
once (`npm add --global playwright-core@1.63.0`). livepeek downloads nothing itself.

## Launching it

Run this in a shell (in Claude Code, the Bash tool: it puts the plugin's
top-level `bin/` on that tool's PATH while the plugin is enabled). Installed
with npm or from a clone, `livepeek` is on the user's PATH in any agent:

```bash
livepeek
```

In Claude Code, do not assume the command is on the PowerShell tool's PATH.
If `livepeek` is not found, run this instead, with the same arguments:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pane.mjs"
```

That path is filled in when this skill loads in Claude Code, or when
`livepeek --install-skill` copies it for another agent. It is not a shell
environment variable. If it still reads `${CLAUDE_PLUGIN_ROOT}` literally,
ask the user where livepeek is installed. In every command below, use the
`node` form in place of `livepeek` if the wrapper is unavailable.

Self-contained: it finds the project root, works out which framework it is,
starts the dev server if the port is dead, detects the terminal, and splits
it. The command returns as soon as the pane exists; the view keeps running
after your turn ends. **Do not** run it with a timeout expecting it to finish,
and do not run it in the background.

Options, added when the user asks:

| option | effect |
|---|---|
| `--preset desktop` | viewport to open on (`--list` on `tui.mjs` shows ids) |
| `--file spec.md` | show one file: `.md` rendered as a document, `.html` as a page |
| `--url http://...` | point at a server directly, skipping all detection |
| `--port 3000` | dev server is on a non-default port |
| `--size 0.4` | wider pane (fraction of the window) |
| `--interval 200` | refresh faster (default 600 ms, more CPU) |
| `--render sixel` | force `kitty`, `sixel` or `blocks` |
| `--horizontal` | split below instead of beside |
| `--no-serve` | don't start a server, one is already running |
| `--here` | run in the current pane instead of splitting |
| `--new` | force an extra pane instead of reusing the open one; control commands keep reaching this terminal's own pane while that is open |
| `--quit` | close the open pane cleanly |
| `--snapshot out.png` | write what the open pane is showing to a PNG |
| `--eval '<js>'` | run a snippet in the shown page, print the JSON result |
| `--picked` | the element the user last pointed at in the pane, as JSON |
| `--compare a,b` | two panes side by side, one per preset (`desktop,iphone-15-pro`). `--quit` and `--snapshot` reach the first while it is open; the user presses `q` in the second |
| `--status` | one line of JSON about this terminal's pane: `target`, `preset`, `errors`, `host`, `pid` |
| `--doctor` | diagnose: Node, browser, driver, multiplexer, graphics. Run this first when the pane will not open or renders garbage |
| `--dry-run` | print what it would do and exit |

## Look at what you changed

The pane exists so the user sees their work live. It also exists so **you**
can. After you edit a screen, a level, a page or a document, do not ask the
user whether it looks right - check:

```bash
livepeek --snapshot .livepeek/snapshot.png
```

then open the PNG with your image or file reading tool. The path is relative to the project and
livepeek creates the `.livepeek` folder if it is missing; `/tmp` does not exist on
Windows, so do not reach for it. It is the page at full resolution (the
same thing the pane is painting), so text is legible. Wait a couple of seconds
after saving a file first; the dev server or the built-in reloader needs a
moment to pick the change up.

When pixels are not enough, ask the page directly:

```bash
livepeek --eval 'document.querySelector("h1").textContent'
livepeek --eval '[innerWidth, innerHeight]'
```

Both need a pane to be open. If the user said "change X" and X is visible in
the pane, the loop is: edit, wait ~2s, snapshot, look, report what you see.

## When the user says "this"

The user can point at things in the pane: `x`, then a click, picks an
element instead of clicking it. When they say "make this bigger", "fix that
button" or "what's this?" without naming it, read what they picked:

```bash
livepeek --picked
```

It prints the element's tag, visible text, a CSS selector that finds it, the
React or Vue component that rendered it (dev builds only), its box on screen,
the page URL and a snippet of its HTML. Search the project for the component
name or the text to find the source. The pick also lands on the user's
clipboard as one line starting `[livepeek pick]`; if they paste that into
the chat, it is the same element.

## One pane per terminal, reused

**If this terminal already opened a pane, this retargets it instead of
splitting again** and prints `reusing the open pane`. That is correct and
expected; launching from a website project and then from a phone project
leaves one pane that switches between them. Do not treat it as a failure, and
do not reach for `--new` unless the user actually asks for two views side by
side.

The pane belongs to the terminal pane it was launched from, so another agent
session in another tab gets its own livepeek pane and never takes over yours.
In hosts with no pane id (the VS Code terminal, a plain console) sessions share
one unless `LIVEPEEK_SLOT` differs.
`--snapshot`, `--eval` and `--quit` talk to this terminal's pane, or to the
only pane open if this terminal has none (a `--here` view in a split the user
made by hand). With several open and none of them yours, they say so.

The pane is also switchable from the inside with `p`, which lists every
project livepeek has shown before plus any dev server currently running.

**Never kill the pane process to stop it.** A non-zero exit makes Windows
Terminal keep the dead pane on screen. Use `--quit`, or tell the user to press
`q` in the pane.

## What it detects, and the viewport it picks

| project | port | opens on |
|---|---|---|
| a folder with `index.html`, a `.html` file, or a `.md` file (no package.json needed) | built-in | `fit`: the pane's own size |
| Expo (React Native through its web build) | 8081 | `iphone-15-pro`, with a phone body drawn around it |
| Next, Nuxt, SvelteKit, Astro, Remix, Gatsby, Docusaurus, Angular, CRA | varies | `fit`, no bezel |
| Vite, Parcel, webpack-dev-server | varies | `fit` |
| any of the above **plus** a canvas library (Phaser, three, Pixi, Babylon, Excalibur, Kaplay, p5, PlayCanvas) | varies | `game-720p` (16:9), no bezel |

The port comes from, in order: a `--port` flag in the dev script (or a
script it runs, such as `npm:dev:web`), `server.port` (Nuxt:
`devServer.port`) in a Vite, SvelteKit, Astro or Nuxt config file, the port
the project was last shown on, then the framework default. A Vite server on
that port that belongs to another project is recognised and skipped; when the
pane starts the dev server it follows the `Local:` address the server prints,
so a Vite that moved to the next free port is still found.

Phone presets get a phone body with bezel and camera cutout. Web, game and
document presets are drawn bare: a browser viewport or a game canvas *is* the thing
being built, so a phone frame around it would misrepresent it.

If the user wants a different shape, `--preset` accepts phones, tablets, web
sizes (`fit`, `desktop`, `desktop-wide`, `laptop`, `laptop-small`,
`tablet-web`, `mobile-web`), document pages (`document`, `document-wide`) and
game aspect ratios (`game-720p`, `game-1080p`, `game-4-3`, `game-square`,
`game-portrait`).

## Exit codes mean specific things

Check the exit code before reporting success.

**An empty folder is fine.** With no dev server dependency and no `index.html`,
`.html` or `.md` in the directory, livepeek opens a built-in welcome page that
tells the user to start building. The pane watches that folder and switches to
an `index.html`, `.html` or `.md` the moment one appears, with no relaunch. If the user
meant a specific file or server, give it `--file` or `--url`; do not guess a port.

**"The browser driver is not installed"** (shown inside the pane, or by
`livepeek --doctor`): livepeek downloads nothing itself. Tell the user to run
`npm add --global playwright-core@1.63.0` once (or add the same package to the project's
dev dependencies), then launch again. Ask before running it for them; it is
an install on their machine.

A pane that fails to start shows the reason and waits for a keypress before
closing, so the user can read it. Ask them what it said.

**`2`: missing framework dependencies.** Expo needs `react-dom` and
`react-native-web` for the web build, or the dev server returns a blank page.
The script prints the exact install command. Offer to run it, and ask first:
it modifies their `package.json`.

**`3` in the VS Code terminal** (the message names VS Code). Nothing can
split that terminal from outside, so tell the user to split it by hand
(Ctrl+Shift+5, or Cmd+\ on a Mac) and run `livepeek --here` (or the full
`node .../pane.mjs --here` the message prints) in the new half. Do not run
`--here` yourself: it would take over the terminal you are working in. If
the pane then shows text rather than a picture, the VS Code setting
`terminal.integrated.enableImages` is off; suggest enabling it.

**`3`: no terminal multiplexer.** There is no pane to split. Supported hosts
are tmux, Zellij, Kitty, WezTerm and Windows Terminal. Tell the user either to
start `tmux` (works everywhere) or to use `--here`, which runs in the current
pane. Do not suggest opening a browser window; staying in the terminal is the
entire point of this plugin.

## Errors on the page

`livepeek --status` prints one line of JSON about this terminal's pane,
including `errors`: the number of uncaught exceptions and `console.error`
calls on the current page since it loaded. After you change something, read
it along with the snapshot:

```bash
livepeek --status
```

A non-zero count means your change broke something even if the page still
paints. The user sees the same number as a red badge in the footer and can
press `e` to read the messages.

## If the view looks wrong

The renderer is probed at startup; in a wide enough pane the footer names it.

- **Coloured mush or garbage characters**: the probe guessed wrong. Tell the
  user to press `b` to cycle kitty graphics → sixel → text → half-blocks.
- **Blocky but legible**: half-block mode draws a coarse picture. Press `b` to
  choose another renderer. Kitty, Ghostty, WezTerm, Windows Terminal 1.22+
  and xterm can draw sharper pictures.
- **Blank page**: the server is up but serving nothing useful. For Expo it's
  usually the missing web deps above. Check the URL directly first.
- **The pane shows the page as text, footer says `text`**: this is the automatic
  fallback when the host draws no graphics (Zellij on Windows does this), so
  livepeek renders the DOM as readable text: headings, paragraphs, links,
  buttons, inputs. Clicks and
  scrolling still work; `--snapshot` still writes the real pixels. This is
  expected there. For a sharp picture, run livepeek from a Windows Terminal pane
  instead of inside Zellij.
- **Nothing renders under tmux**: tmux needs `set -g allow-passthrough on`
  for graphics sequences to reach the terminal.
- **Tiny or cropped**: the pane is too narrow for the viewport. Suggest
  `--size 0.5`, or a smaller preset.

## Keys, for when the user asks

Focus the pane first (`alt`+arrow in most terminals, `prefix`+arrow in tmux).

| key | does |
|---|---|
| click / scroll | goes through to the page |
| `i` | typing mode: keystrokes go to the page; `esc` stops |
| `space` | device picker: typing filters the list (`iph`, `sam`, `pixel`, `desk`) |
| `p` | switch project: folders livepeek has shown before (kept in `~/.livepeek/projects.json`), plus any dev server currently running; picking a stopped framework project starts its dev server |
| `shift`+`?` | help overlay listing every key |
| `[` `]` | previous / next device |
| `o` | rotate |
| `r` | reload |
| `e` | list page errors; the footer shows a red `N errors` badge whenever the page has thrown or logged `console.error` |
| `d` | toggle dark / light by emulating `prefers-color-scheme` |
| `+` `-` `0` | zoom in / out / reset (CSS zoom, viewport unchanged) |
| `c` | copy the current frame to the system clipboard |
| `w` | open the page in the system browser for a full-size look; clicking the underlined address in the header does the same |
| `g` | go to a page: type a path (`/settings`) or an address (`localhost:3000`), enter goes |
| `x` | point mode: hover outlines elements, a click picks one for you (`--picked`) and copies a reference; `esc` stops |
| `m` | QR code that opens the page on a phone on the same Wi-Fi. If the dev server only listens on localhost it says how to fix that; for livepeek's own server, `s` shares it on the network until the pane quits |
| `.` | pause refreshing |
| `b` | cycle renderer: kitty, sixel, text, half-blocks |
| `q` | quit and close the pane |

Inside the preset picker: `↑`/`↓` move, `PageUp`/`PageDown` jump, `Home`/`End`
go to the ends, `enter` selects, `esc` closes. The mouse works too: the wheel
scrolls the list, hovering highlights, clicking picks.

Keys with alt or ctrl held are ignored by the viewer so they reach the
terminal; alt+arrow is how most terminals move between panes.

Tell users to quit with `q` rather than killing the process; that shuts the
headless browser down cleanly instead of orphaning it.

**Typing mode is modal and worth explaining when it comes up.** Press `i` and
text, arrows, Enter, Tab, Backspace, Home/End/PageUp/PageDown, Delete and
ctrl+letter all go to the page. While it is on, `q` types a `q` rather than
quitting; `esc` leaves typing mode and `ctrl+c` quits from either mode. The
footer shows a badge so the state is never ambiguous.

To fill in a form the user must **click the field first** so it has focus, then
press `i`. A click focuses exactly as it would in a browser. If a user reports
"typing does nothing", an unfocused page is the first thing to check.

## Limits worth stating plainly

It drives a real browser, so it shows whatever a browser shows, and only
that.

- **Phone apps** render their *web* build. Native-only modules are absent:
  `react-native-maps`, `expo-camera`, native Stripe, background location,
  push notifications. Those render empty or throw. Suggest a device or
  emulator for those screens.
- **Games** render fine on canvas and WebGL, but the frame rate you see is
  the screenshot interval (default 600 ms), not the game's. It is for seeing
  layout and state, not for judging animation smoothness. `--interval 200`
  gets closer at the cost of CPU.
- **Held keys** are approximated. A terminal reports keystrokes, never "still
  held", so when focus is not a text field each key is held down for 90 ms -
  long enough for several animation frames to sample it, which is what makes
  WASD move at all. In a text field it types normally instead. There is still
  no continuous held state, so charge-up or analogue-feeling input will be
  approximate; say so rather than letting it look broken.
