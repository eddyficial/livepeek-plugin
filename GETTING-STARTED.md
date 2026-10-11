# Getting started with livepeek

You just installed livepeek. Here's what it does and how to get a live view of
your project up in about a minute.

## What it is

livepeek puts a live view of whatever you're building into a split pane in the
terminal you're already working in. You edit a file, save, and the pane
updates. You can click and scroll in it, and type into it.

It works for websites, games, phone apps, and plain files: a markdown
document or an HTML mockup with no dev server at all.

No browser window. No emulator. Nothing to alt-tab to.

## Before you start

livepeek needs Node.js 18 or newer, Chrome or Edge, and one browser-driver
package:

```bash
npm add --global playwright-core@1.63.0
```

For the full experience, use a terminal that can split itself. livepeek asks
the terminal for a new pane. Supported hosts are:

- **tmux**: works on macOS, Linux and Windows. If you're unsure, use this.
- **Zellij**, **Kitty**, **WezTerm**, or **Windows Terminal**

Already in one of those? You're set. If not, the simplest fix on any platform:

```bash
tmux
```

Then start Claude Code inside it. (If you're on tmux, also add
`set -g allow-passthrough on` to your `~/.tmux.conf`; tmux blocks graphics
sequences without it.)

No multiplexer at all? livepeek still works. `--here` runs it in your current
pane, and a terminal that cannot draw images gets the page as text.

`playwright-core` is the driver livepeek uses to steer the Chrome or Edge
already on your machine, headless. livepeek downloads nothing itself. You
won't see a browser window.

## Your first run

From inside your project, in Claude Code:

```
/livepeek:livepeek
```

That's it. livepeek will:

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
live  space device  ·  shift+? help  ·  q quit
```

`live` means it's updating; `shift`+`?` lists every key. In a wider pane the
footer also names the renderer in use; more on that below if things look wrong.

The first few times (when the pane draws a picture rather than text), a welcome card points at the device name in the top
left. Click it, or press `space`, to open the device picker; any other click
or plain key dismisses it. It stops appearing once you have used the picker, or after
three launches.

For a **phone** project you'll see an actual phone body drawn around the
screen. For a **website** or **game** you'll see just the viewport with a thin
border, because a browser viewport or a game canvas *is* the thing you're
building: a phone frame around it would misrepresent it.

## Opening it without Claude

You do not have to be in a Claude session. Copy a wrapper from the installed
plugin cache into a folder on your PATH. With the default Claude configuration,
version 0.7.2 is under:

```
~/.claude/plugins/cache/livepeek/livepeek/0.7.2/bin/
```

On Windows, copy `livepeek.cmd`. On macOS or Linux, copy `livepeek` and make it
executable. If `CLAUDE_CONFIG_DIR` is set, use that directory instead of
`~/.claude`. The wrapper finds the newest installed plugin itself, so a copy
from any installed version keeps working after updates. The README has exact
commands. After that, `livepeek` opens the pane and `livepeek --quit` closes it.

## In VS Code

The VS Code terminal cannot be split from the outside, so `/livepeek:livepeek` there
prints instructions instead of a pane. Follow them: split the terminal by
hand (Ctrl+Shift+5, or Cmd+\ on a Mac) and run `livepeek --here` in the new
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
| **`i`** | typing mode: your keystrokes go to the page. `esc` stops |
| **`space`** | pick a device: start typing to filter (`iph`, `sam`, `pixel`) |
| **`p`** | switch project: every folder you have previewed before, plus any dev server running. Pick a stopped one and livepeek starts it |
| `shift`+`?` | show every key |
| `[` `]` | previous / next device |
| `o` | rotate |
| `r` | reload |
| `e` | see the page's errors. A red count appears in the footer when something throws |
| `d` | flip dark / light mode |
| `+` `-` `0` | zoom in, out, reset |
| `c` | copy what you see to the clipboard |
| `w` | open the page in your browser (or click the address at the top) |
| `g` | go straight to a page, like `/settings` |
| `x` | point at something, then tell Claude "change this" |
| `m` | show a QR code to open the page on your phone |
| `.` | pause updating |
| `b` | change renderer (kitty, sixel, text, half-blocks) |
| `q` | quit and close the pane |

In the viewport picker, `↑`/`↓` move the selection and `enter` picks it.
`PageUp`/`PageDown` jump a screenful, `Home`/`End` go to the ends, `esc`
closes. The mouse works too: scroll the list with the wheel, click to pick.
Type to filter by name or maker: `sam`, `pixel`, `apple`, `desk`.

Alt+arrow and ctrl+arrow are deliberately left alone so your terminal still
gets them; that's usually how you move between panes.

**Quit with `q`**, not by killing the process; that shuts the headless
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

Start with `livepeek --doctor`. It checks Node, the browser, the driver, your
terminal and its graphics support, and tells you which renderer you will get
and why.


**The view is coloured mush, or garbage characters.** livepeek guessed your
terminal's graphics support wrong. Press `b` to cycle through kitty, sixel,
text and half-blocks until it looks right.

**The pane shows the page as text.** That is the automatic fallback when the
terminal reports no graphics support. The page stays readable and interactive.

**It's blocky and coarse, but readable.** Half-block mode draws a coarse
picture. Press `b` to choose another renderer. Kitty, Ghostty, WezTerm,
Windows Terminal 1.22+ and xterm can draw sharper pictures.

**Nothing renders at all and you're in tmux.** Add this to `~/.tmux.conf` and
restart tmux:

```
set -g allow-passthrough on
```

**"No terminal multiplexer detected."** There's no pane to split. Either start
`tmux` and run Claude Code inside it, or run it in your current pane:

```
/livepeek:livepeek --here
```

**"The browser driver is not installed."** livepeek downloads nothing itself;
the driver is one npm package you install once. Either globally:

```bash
npm add --global playwright-core@1.63.0
```

or in the project (`npm add --save-dev playwright-core@1.63.0`). `livepeek --doctor` confirms
it is found.

**You see a "livepeek is ready" welcome page.** The folder has no framework it
recognises and no `index.html`, `.html` or `.md` yet. Start building, or name
the thing you mean:

```
/livepeek:livepeek --file docs/spec.md
/livepeek:livepeek --url http://localhost:3000
```

**The page is blank.** Your dev server is up but serving nothing useful. Open
the URL in a normal browser to confirm. For Expo projects it's usually missing
web-build dependencies; livepeek will tell you and offer to install them.

**It's tiny or cut off.** The pane is too narrow for the viewport. Try a wider
pane or a smaller viewport:

```
/livepeek:livepeek --size 0.5
/livepeek:livepeek --preset laptop
```

## What it recognises automatically

| you're building | from | opens on |
|---|---|---|
| a website | Next, Nuxt, SvelteKit, Astro, Remix, Gatsby, Docusaurus, Angular, CRA, Vite, Parcel, webpack | `fit`: the pane's own size |
| a game | any of those **plus** Phaser, three, Pixi, Babylon, Excalibur, Kaplay, p5, PlayCanvas | 16:9 720p |
| a phone app | Expo (React Native through its web build) | iPhone 15 Pro, with a phone body |
| a document or mockup | `index.html`, any `.html`, any `.md` (no package.json needed) | `fit` |
| anything else | nothing detected | give it `--url` or `--file` |

`fit` uses the pane's own pixel size, so text is not scaled down. A fixed size
such as `desktop` (1440×900) or `document` (900×1200) is one `--preset` away.

34 viewports ship with it: 20 real devices, 7 web sizes including `fit`, 5 game
aspect ratios and 2 document pages. Press `space` in the pane to see them all,
and type to filter the list.

## Options

```
/livepeek:livepeek --preset laptop            a different viewport
/livepeek:livepeek --url http://localhost:1234     skip detection, point at a server
/livepeek:livepeek --port 3000                non-default dev server port
/livepeek:livepeek --size 0.4                 wider pane
/livepeek:livepeek --interval 200             refresh faster (default 600 ms, more CPU)
/livepeek:livepeek --render sixel             force kitty, sixel or blocks
/livepeek:livepeek --horizontal               split below instead of beside
/livepeek:livepeek --no-serve                 your server is already running
/livepeek:livepeek --file docs/spec.md        show one file (markdown or html)
/livepeek:livepeek --snapshot out.png         write what the pane shows to a PNG
/livepeek:livepeek --eval 'innerWidth'        run a snippet in the shown page
/livepeek:livepeek --here                     run in this pane, don't split
/livepeek:livepeek --new                      force a second pane instead of reusing
/livepeek:livepeek --quit                     close the open pane cleanly
/livepeek:livepeek --compare desktop,iphone-15-pro   two panes, one per preset
/livepeek:livepeek --doctor                   check the installation and terminal
/livepeek:livepeek --dry-run                  show what it would do, then stop
```

## When livepeek is the wrong tool

It drives a real browser, so it shows what a browser shows, and nothing else.

- **Phone apps** render their *web* build. Native-only modules aren't there:
  `react-native-maps`, `expo-camera`, native Stripe, background location, push
  notifications. Those screens render empty or throw. Use a real device or an
  emulator for them.
- **Games** render on canvas and WebGL fine, but what you see refreshes every
  600 ms; that's the screenshot interval, not your frame rate. It's for
  watching layout and state, not judging animation. `--interval 200` gets
  closer, at the cost of CPU.
- **Held keys** are approximated. Outside a text field each press is held for
  90 ms so games can see it, WASD moves properly, but there's no continuous
  held state, so charge-up mechanics will feel approximate.
- **Pixel-exact design review**: half-block mode especially is approximate.
  Use a real browser for final visual QA.

## Letting Claude check its own work

Tell Claude "change the header to orange" and it can edit the file, then run
`/livepeek:livepeek --snapshot` and look at the result before telling you it's done. The
plugin's skill already instructs it to. If you want to see what it saw, the
PNG it wrote is the page at full size.

## Still stuck?

Ask Claude in your session: the plugin ships a skill, so Claude knows how it
works, what the error codes mean, and how to fix the common problems. "the
livepeek pane looks wrong" is a perfectly good prompt.
