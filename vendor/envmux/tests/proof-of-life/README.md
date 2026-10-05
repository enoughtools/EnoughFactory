# proof-of-life

A Vite app for checking a session works end to end. It is started by the
`proof` task in this repository's `.envmux.json`.

It binds the instance's own `127.0.0.1:5174` and nothing else, so:

- the `proof` route (`http://envmux-<session>.envmux:5174`) **fails**, which is
  expected. A route reaches the instance's address, not its loopback.
- `b` in the session opens a browser whose `localhost` is the instance, at
  `http://localhost:5174/`. See `docs/pages/browser.md`.

The page shows the machine that served it (the instance's hostname), whether
Vite's HMR WebSocket connected through the relay, and whether a Google font
loaded from the workstation. Edit `main.js` inside the session to see HMR
reload the page.
