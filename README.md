# peek

A live viewing portal in your terminal.

Whatever you're building — a website, a game, a phone app, a document, a
mockup — `peek` renders it live in a split pane next to your work. Edit a
file, save, watch it change. Click, scroll and type go through to the page.

And Claude can look too: after it changes something, it snapshots the pane and
checks the result instead of asking you.

No browser window. No emulator. Nothing to alt-tab to.

![peek showing a landing page at desktop, laptop and phone sizes, then a markdown spec, then a live edit landing](docs/demo.gif)

```
/peek
```

That's the whole interface. It works out what your project is, starts the dev
server if it isn't running, detects your terminal, and splits it.

Run it again from a different project and the **same pane** switches to it —
website, game, phone app. One pane that follows what you're working on, not a
new one each time. Press `p` inside the pane to switch without leaving it.

**New here?** [GETTING-STARTED.md](GETTING-STARTED.md) walks through the first
run and the handful of things that can go wrong.

## Before you start

Three things need to be on the machine already. Everything else peek fetches itself.

- **Node.js** 18 or newer. If Claude Code runs, you have it.
- **Chrome or Edge.** Peek drives the browser you already have instead of downloading one. Windows ships with Edge, so Windows users are covered out of the box.
- **A terminal that can split and draw graphics:** Windows Terminal 1.22+ (the Windows 11 default), or tmux, Zellij, Kitty or WezTerm on macOS and Linux. The stock macOS Terminal.app does not qualify.

The first launch downloads a 3 MB browser driver with `npm`, so it needs a network connection once. If you point peek at a Vite, Next or Expo project, that project's own `npm install` must already have been run.

## Install

```
/plugin marketplace add eddyficial/peek
/plugin install peek@peek
```

Nothing to add to your project. On first run `peek` fetches its own browser
driver (`playwright-core`, ~3 MB, no browser download) into the plugin folder
and drives the Chrome or Edge already on your machine, headless. If a project
has full `playwright` with a downloaded Chromium, that is used instead.

## Open it from any shell

`/peek` inside Claude Code is one way in. The other is a plain `peek` command
in whatever shell you are in, no Claude session needed. Two tiny wrappers in
[`bin/`](bin/) find the newest installed copy of the plugin, so they never go
stale after an update:

- `bin/peek` for Bash, Zsh and the shell inside tmux or Zellij
- `bin/peek.cmd` for PowerShell and cmd on Windows

Copy whichever you need onto your PATH. On Windows the npm global folder is
already there for every shell:

```
copy bin\peek.cmd %APPDATA%\npm
copy bin\peek     %APPDATA%\npm```

On macOS and Linux, `/usr/local/bin` or `~/.local/bin`:

```
install -m 755 bin/peek ~/.local/bin/peek
```

Then, from any project folder:

```
peek              open the pane here, or switch the open one to this folder
peek --quit       close it
peek --file x.md  show one file
```

Every option in [Options](#options) works the same way.

## What it understands

| you're building | detected from | opens on |
|---|---|---|
| a website | Next, Nuxt, SvelteKit, Astro, Remix, Gatsby, Docusaurus, Angular, CRA, Vite, Parcel, webpack | `desktop` — 1440×900, no bezel |
| a game | any of the above **plus** Phaser, three, Pixi, Babylon, Excalibur, Kaplay, p5 or PlayCanvas | `game-720p` — 16:9, no bezel |
| a phone app | Expo, React Native | `iphone-15-pro`, with a phone body |
| a document or mockup | a folder with `index.html`, any `.html`, or a `.md` file — no package.json needed | `desktop`, or `document` (900×1200) for markdown |
| something else | — | pass `--url http://localhost:1234` or `--file path` |

Phones get a drawn phone body, bezel and camera cutout. Web, game and document
viewports are drawn bare, because a browser viewport or a game canvas *is* the
thing you're building — a phone frame around it would be a lie.

Markdown is rendered as a page with live reload, served by `peek` itself —
no dependency, no dev server. Plain HTML gets the same reloader injected.

33 presets ship with it: 21 real devices, 6 web breakpoints, 5 game aspect
ratios, 2 document pages. `node scripts/tui.mjs --list` prints the ids, and adding one is a
single line in `scripts/presets.js`.

## How it looks

Real pixels, not ASCII art. The renderer is probed at startup, never assumed:

| renderer | terminals | notes |
|---|---|---|
| kitty graphics | Kitty, Ghostty, WezTerm | 24-bit colour, zlib-compressed frames |
| sixel | Windows Terminal 1.22+, xterm, foot, mlterm | 128-colour quantised |
| half-blocks | anything with truecolor | always works, coarse |

The footer names the active renderer. Press `b` to cycle if the probe got it
wrong.

## Terminals

The pane is created by whichever multiplexer is hosting you:

| host | detected via |
|---|---|
| tmux | `$TMUX` |
| Zellij | `$ZELLIJ` |
| Kitty | `$KITTY_LISTEN_ON` |
| WezTerm | `$WEZTERM_PANE` |
| Windows Terminal | `$WT_SESSION` |

tmux works on macOS, Linux and Windows, so it's the universal fallback — start
`tmux` and you have a pane anywhere. With no multiplexer at all, `--here` runs
the view in your current pane instead.

Under tmux, graphics need passthrough enabled:

```
set -g allow-passthrough on
```

**Zellij on Windows** shows no sixel or kitty graphics, so peek falls back to half-block text there and says so in the footer. For a sharp picture on Windows, run peek from a Windows Terminal pane directly; Zellij on macOS and Linux is unaffected.

One pane follows you between terminals too. If you open peek in Windows
Terminal, then move into Zellij and run it again, the old pane is closed and a
fresh one opens where you are now.

## Keys

Focus the pane first — `alt`+arrow in most terminals, `prefix`+arrow in tmux.

| key | does |
|---|---|
| click / scroll | goes through to the page |
| `i` | **typing mode** — send keystrokes to the page |
| `space` | **pick a device** — start typing to filter: `iph`, `sam`, `pixel`, `desk` |
| `p` | **switch project** — every folder you have peeked before, plus any dev server running |
| `shift`+`?` | help overlay with every key |
| `[` `]` | previous / next device |
| `o` | rotate |
| `r` | reload |
| `e` | **page errors** — the footer shows a red count when the page throws; `e` lists them |
| `d` | dark / light — flips `prefers-color-scheme` so you see both themes |
| `+` `-` `0` | zoom in / out / reset |
| `c` | copy the frame to the clipboard as an image |
| `.` | pause refreshing |
| `b` | cycle renderer |
| `q` | quit and close the pane |

In the preset picker: `↑`/`↓` move, `PageUp`/`PageDown` jump, `Home`/`End` go
to the ends, `enter` selects, `esc` closes.

Anything with alt or ctrl held is left alone, so your terminal's own bindings
still work — alt+arrow moves between panes rather than reaching the viewer.

Quit with `q` rather than killing it — that shuts the headless browser down
cleanly instead of orphaning it.

### Typing

Press `i` and every keystroke goes to the page instead of the viewer — text,
arrows, Enter, Tab, Backspace, Home/End/PageUp/PageDown, Delete, and
ctrl+letter combinations. `esc` stops.

Which necessarily means `q` no longer quits while you're typing: it types a
`q`. The footer turns into a badge saying so, and `ctrl+c` always quits
regardless of mode.

To fill in a form, click the field first — the click focuses it, the same way
it would in a browser — then press `i` and type.

**Games get different treatment, automatically.** A terminal reports
keystrokes, never "still held" — so a game sampling input once per frame would
miss almost every press. When the focus isn't a text field, each key is held
down for 90 ms instead, long enough for several frames to see it. WASD moves
properly.

In a text field it types normally, so forms stay responsive. You don't choose
between the two; it checks what has focus.

There's still no true held state: holding `W` gives you your terminal's
key-repeat rather than continuous movement. Charge-up mechanics and
analogue-feeling input will be approximate.

## Options

```
/peek --preset laptop          a different viewport
/peek --url http://host:1234   skip detection, point at a server
/peek --port 3000              non-default dev server port
/peek --size 0.4               wider pane
/peek --horizontal             split below instead of beside
/peek --no-serve               a server is already running
/peek --file docs/spec.md      show one file (markdown or html)
/peek --snapshot out.png       write what the pane shows to a PNG
/peek --eval 'innerWidth'      run a snippet in the shown page
/peek --here                   run in this pane, don't split
/peek --new                    force a second pane instead of reusing
/peek --quit                   close the open pane cleanly
/peek --compare desktop,iphone-15-pro   two panes side by side, one per preset (q closes each)
/peek --doctor                 check Node, browser, driver, terminal and graphics, say what will work
/peek --dry-run                print what it would do and stop
```

## Claude can see it

`--snapshot` writes the page the pane is showing to a PNG at full resolution,
and `--eval` runs a snippet in it and prints the result. The bundled skill
tells Claude to use both after it edits something you can see: change, wait a
beat, snapshot, look, then report what's actually on screen. You stop being
the one who has to say "no, it's still wrong".

## Limits

It drives a real browser, so it shows what a browser shows — and only that.

- **Phone apps** render their *web* build. Native-only modules are absent:
  `react-native-maps`, `expo-camera`, native Stripe, background location, push
  notifications. Use a device or emulator for those screens.
- **Games** render on canvas and WebGL, but the frame rate you see is the
  screenshot interval (600 ms by default), not the game's. It's for watching
  layout and state, not judging animation. `--interval 200` gets closer, at
  the cost of CPU.
- **Held keys** are approximated: each press is held 90 ms when focus isn't a
  text field, so WASD works, but there's no continuous held state. See Typing.

## When something is wrong

`peek --doctor` (or `/peek --doctor`) checks everything peek needs and says which renderer your terminal will get. Run it first if the pane looks like coloured noise or never opens.

The pane also tells you when the page is unwell: a red `2 errors` in the footer means the page threw or logged `console.error` (press `e` to read them), and `page not responding` means the browser stopped answering, which usually means a tight loop in your code.

## Status line

`~/.peek/session.json` is plain JSON that any status line or prompt can read: `target` (what is shown), `preset`, `errors` (count on the current page) and `pid`. A one-liner for a shell prompt:

```
node -e "try{const s=require(require('os').homedir()+'/.peek/session.json');process.stdout.write('peek '+s.preset+(s.errors?' !'+s.errors:''))}catch{}"
```

## Tests

`node test/run.mjs` runs the unit, launcher and browser tests. It needs no terminal multiplexer; the browser tests use whatever Chrome or Edge it finds and skip if there is none. The same suite runs on Windows and Linux in GitHub Actions on every push.

## What peek runs and fetches

Everything peek does, so you can check it before installing:

- **Starts a headless Chrome or Edge** that is already installed on your machine, and screenshots it. No browser is downloaded.
- **Downloads one package, once.** On first launch it runs `npm install playwright-core@1.63.0` into the plugin's own folder (about 3 MB, pinned to that exact version). Nothing is installed into your project.
- **Serves your files on localhost.** For a plain folder, `.html` or `.md` file it starts a small web server on a random local port. It does not listen on other network interfaces.
- **Starts your dev server, only if you ask.** Opening a Vite, Next, Expo or similar project runs that project's own `npm run` script, and picking a stopped project in the `p` list does the same.
- **Writes a little local state** to `~/.peek/`: which pane is open, and the folders you have previewed (`projects.json`). Delete the folder to clear it.
- **Sends nothing anywhere.** No telemetry, no analytics, no account. The only outbound request peek makes itself is the one-time npm download above. The pages you preview make whatever requests they normally would.
- **Has no hooks and no MCP server.** It adds one skill and one optional `peek` shell command.
- **Clipboard, only when you press `c`.** Copying a frame uses PowerShell on Windows, `osascript` on macOS, and `wl-copy` or `xclip` on Linux. Nothing is read from the clipboard.

## How it works

A headless Chromium is driven at the preset's CSS viewport, screenshotted on a
loop, composited and painted into the pane as graphics escape sequences.
Terminal mouse reporting is mapped back through the same transform, so a click
in the pane lands at the right page coordinate.

```
scripts/
  pane.mjs        detect terminal + framework, start the server, split
  targets.mjs     framework -> port, dev script, default preset
  tui.mjs         the viewer itself
  presets.js      viewports: devices, web breakpoints, game ratios
  lib/caps.mjs    terminal capability probe, renderer choice
  lib/png.mjs     PNG decoder (zlib + scanline unfilter)
  lib/sixel.mjs   sixel encoder, plus the half-block fallback
  lib/kitty.mjs   kitty graphics encoder, tmux passthrough
  lib/phone.mjs   phone body geometry and compositing
  lib/bare.mjs    frameless compositing, for web, games and documents
  lib/serve.mjs   built-in static server, markdown renderer, live reload
  lib/pngenc.mjs  PNG encoder for snapshots
  lib/session.mjs one shared pane: reuse, retarget, snapshot, eval
```

## Licence

MIT
