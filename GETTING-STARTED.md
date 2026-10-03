# Getting started with peek

You just installed `peek`. Here's what it does and how to get a live view of
your project up in about a minute.

## What it is

`peek` puts a live view of whatever you're building into a split pane in the
terminal you're already working in. You edit a file, save, and the pane
updates. You can click and scroll in it, and type into it.

It works for websites, games, phone apps, and plain files — a markdown
document or an HTML mockup with no dev server at all.

No browser window. No emulator. Nothing to alt-tab to.

## Before you start: one requirement

**1. A terminal that can split itself.** `peek` doesn't open a window — it asks
your terminal for a new pane. That means you need one of:

- **tmux** — works on macOS, Linux and Windows. If you're unsure, use this.
- **Zellij**, **Kitty**, **WezTerm**, or **Windows Terminal**

Already in one of those? You're set. If not, the simplest fix on any platform:

```bash
tmux
```

Then start Claude Code inside it. (If you're on tmux, also add
`set -g allow-passthrough on` to your `~/.tmux.conf` — tmux blocks graphics
sequences without it.)

No multiplexer at all? `peek` still works, it just runs in your current pane
instead of splitting — see `--here` below.

That's it. The browser engine takes care of itself: on first run `peek`
fetches a ~3 MB driver into its own folder (no browser download) and uses the
Chrome or Edge already on your machine, headless. You'll see a one-line status
in the pane while it does. You won't see a browser window.

## Your first run

From inside your project, in Claude Code:

```
/peek
```

That's it. `peek` will:

1. find your project root
2. work out which framework it is
3. start your dev server if it isn't already running
4. split your terminal and draw the view in the new pane

First run takes a few seconds, or up to a minute if it has to start your dev
server from cold.

## What you should see

A new pane beside your work, containing your app. At the top, the viewport
name. At the bottom, a status line like:

```
live   sixel · i type · click name to switch · o rotate · b render · q quit
```

`live` means it's updating. `sixel` is the renderer in use — more on that
below if things look wrong.

For a **phone** project you'll see an actual phone body drawn around the
screen. For a **website** or **game** you'll see just the viewport with a thin
border, because a browser viewport or a game canvas *is* the thing you're
building — a phone frame around it would misrepresent it.

## Opening it without Claude

You do not have to be in a Claude session. A one-word `peek` command works
from any shell once you copy a wrapper from the plugin's `bin/` folder onto
your PATH: `bin/peek.cmd` for PowerShell, `bin/peek` for Bash and the shells
inside tmux and Zellij. On Windows, dropping both into a folder that is already on your PATH covers
every shell at once. After that, `peek` in a project folder opens the pane
and `peek --quit` closes it. The README has the exact copy commands.

## In VS Code

The VS Code terminal cannot be split from the outside, so `/peek` there
prints instructions instead of a pane. Follow them: split the terminal by
hand (Ctrl+Shift+5, or Cmd+\ on a Mac) and run `peek --here` in the new
half. To see the real picture instead of text, enable the setting
`terminal.integrated.enableImages` and reload the window (Developer: Reload
Window). A new terminal alone is not enough.

## Driving it

The pane needs focus before it receives your keys. In most terminals that's
`alt`+arrow; in tmux it's your `prefix` then an arrow key. `alt`+`←` (or
prefix+`←`) gets you back to your work.

Once it's focused:

| key | does |
|---|---|
| **click / scroll** | goes straight through to the page |
| **`i`** | typing mode — your keystrokes go to the page. `esc` stops |
| **`space`** | pick a device — start typing to filter (`iph`, `sam`, `pixel`) |
| **`p`** | switch project: every folder you have peeked before, plus any dev server running. Pick a stopped one and peek starts it |
| `shift`+`?` | show every key |
| `[` `]` | previous / next device |
| `o` | rotate |
| `r` | reload |
| `e` | see the page's errors. A red count appears in the footer when something throws |
| `d` | flip dark / light mode |
| `+` `-` `0` | zoom in, out, reset |
| `c` | copy what you see to the clipboard |
| `.` | pause updating |
| `b` | change renderer (kitty, sixel, text, half-blocks) |
| `q` | quit and close the pane |

In the viewport picker, `↑`/`↓` move the selection and `enter` picks it.
`PageUp`/`PageDown` jump a screenful, `Home`/`End` go to the ends, `esc`
closes. Clicking works too.

Alt+arrow and ctrl+arrow are deliberately left alone so your terminal still
gets them — that's usually how you move between panes.

**Quit with `q`**, not by killing the process — that shuts the headless
browser down cleanly instead of leaving it running in the background.

### Typing into your app

Press `i`. Now text, arrows, Enter, Tab, Backspace, Home/End, PageUp/PageDown,
Delete and ctrl+letter all go to the page. Press `esc` to stop.

Two things to know:

- While typing, **`q` types a `q`** instead of quitting. The status line turns
  into an orange badge to remind you. `ctrl+c` always quits, whatever mode
  you're in.
- **Click a text field before typing into it.** The click focuses it, exactly
  like in a browser. If typing seems to do nothing, this is almost always why.

## If something looks wrong

Start with `peek --doctor`. It checks Node, the browser, the driver, your
terminal and its graphics support, and tells you which renderer you will get
and why.


**The view is coloured mush, or garbage characters.** `peek` guessed your
terminal's graphics support wrong. Press `b` to cycle through the three
renderers until it looks right.

**It's blocky and coarse, but readable.** That's the half-block fallback,
meaning your terminal reported no graphics support. It works, it's just not
pretty. Kitty, Ghostty, WezTerm, Windows Terminal 1.22+ and xterm all render
properly.

**Nothing renders at all and you're in tmux.** Add this to `~/.tmux.conf` and
restart tmux:

```
set -g allow-passthrough on
```

**"No terminal multiplexer detected."** There's no pane to split. Either start
`tmux` and run Claude Code inside it, or run it in your current pane:

```
/peek --here
```

**"Could not fetch playwright-core automatically."** The one-time driver
download failed, usually no network. Install it by hand in your project and
`peek` will find it:

```bash
npm i -D playwright-core
```

**You see a "peek is ready" welcome page.** The folder has no framework it
recognises and no `index.html`, `.html` or `.md` yet. Start building, or name
the thing you mean:

```
/peek --file docs/spec.md
/peek --url http://localhost:3000
```

**The page is blank.** Your dev server is up but serving nothing useful. Open
the URL in a normal browser to confirm. For Expo projects it's usually missing
web-build dependencies — `peek` will tell you and offer to install them.

**It's tiny or cut off.** The pane is too narrow for the viewport. Try a wider
pane or a smaller viewport:

```
/peek --size 0.5
/peek --preset laptop
```

## What it recognises automatically

| you're building | from | opens on |
|---|---|---|
| a website | Next, Nuxt, SvelteKit, Astro, Remix, Gatsby, Docusaurus, Angular, CRA, Vite, Parcel, webpack | 1440×900 desktop |
| a game | any of those **plus** Phaser, three, Pixi, Babylon, Excalibur, Kaplay, p5, PlayCanvas | 16:9 720p |
| a phone app | Expo, React Native | iPhone 15 Pro, with a phone body |
| a document or mockup | `index.html`, any `.html`, any `.md` — no package.json needed | desktop, or a 900×1200 page for markdown |
| anything else | — | pass `--url` or `--file` |

33 viewports ship with it — 21 real devices, 6 web breakpoints, 5 game aspect
ratios, 2 document pages. Press `space` in the pane to see them all, and type
to filter the list.

## Options

```
/peek --preset laptop            a different viewport
/peek --url http://localhost:1234     skip detection, point at a server
/peek --port 3000                non-default dev server port
/peek --size 0.4                 wider pane
/peek --horizontal               split below instead of beside
/peek --no-serve                 your server is already running
/peek --file docs/spec.md        show one file (markdown or html)
/peek --here                     run in this pane, don't split
/peek --new                      force a second pane instead of reusing
/peek --quit                     close the open pane cleanly
/peek --dry-run                  show what it would do, then stop
```

## When peek is the wrong tool

It drives a real browser, so it shows what a browser shows — and nothing else.

- **Phone apps** render their *web* build. Native-only modules aren't there:
  `react-native-maps`, `expo-camera`, native Stripe, background location, push
  notifications. Those screens render empty or throw. Use a real device or an
  emulator for them.
- **Games** render on canvas and WebGL fine, but what you see refreshes every
  600 ms — that's the screenshot interval, not your frame rate. It's for
  watching layout and state, not judging animation. `--interval 200` gets
  closer, at the cost of CPU.
- **Held keys** are approximated. Outside a text field each press is held for
  90 ms so games can see it — WASD moves properly — but there's no continuous
  held state, so charge-up mechanics will feel approximate.
- **Pixel-exact design review** — half-block mode especially is approximate.
  Use a real browser for final visual QA.

## Letting Claude check its own work

Tell Claude "change the header to orange" and it can edit the file, then run
`/peek --snapshot` and look at the result before telling you it's done. The
plugin's skill already instructs it to. If you want to see what it saw, the
PNG it wrote is the page at full size.

## Still stuck?

Ask Claude in your session — the plugin ships a skill, so Claude knows how it
works, what the error codes mean, and how to fix the common problems. "the
peek pane looks wrong" is a perfectly good prompt.
