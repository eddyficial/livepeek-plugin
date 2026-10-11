# Privacy

livepeek runs entirely on your machine. It has no server, no account, no
analytics and no telemetry. It collects nothing and sends nothing to its
author or to anyone else.

## What it touches

- **Your project.** It reads your project folder to work out what you are
  building, and may start that project's own dev server (`npm run ...`).
- **A headless Chrome or Edge.** It opens the page you are building in the
  browser already installed on your machine. That page loads whatever it
  normally loads: if your app calls an API, fetches fonts or loads scripts
  from the internet, the headless browser does the same, exactly as a normal
  browser tab would. livepeek adds no requests of its own.
- **Local ports.** It checks whether a dev server is listening on
  `127.0.0.1` / `::1`, and its built-in file server only listens locally.
- **`~/.livepeek/`.** A small state folder: one session file per open pane, the
  list of project folders you have viewed (for the `p` switcher), and whether
  the first-run intro still needs showing. Delete the folder to clear it.
- **Snapshots.** `--snapshot` writes a PNG to the path you give it. `c` copies the current frame to your
  clipboard, through a temporary file.

## Claude

When Claude uses livepeek to check its work, it reads snapshots and page
details you could see in the pane yourself. That happens inside your Claude
Code session, under Claude Code's own terms and privacy policy; livepeek
sends nothing anywhere itself.

## Contact

Questions or concerns: open an issue at
https://github.com/eddyficial/livepeek-plugin/issues
