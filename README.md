# flux*

**Email for what's next.** A personal mail client that puts Gmail and Yahoo in one inbox, keeps the noise out of the way, and tells you only about mail that matters.

Built for a real inbox: a Gmail account that's mostly signal and a Yahoo account that's mostly spam, with shipping updates and one-time passwords buried in it.

## Features

- **One inbox for Gmail and Yahoo**, live: new mail appears as it arrives (IMAP IDLE), with a G/Y badge on each sender.
- **Focused / Other.** Deterministic rules (`rules.json`) decide what's important: people, named senders, OTPs and shipping updates. Everything else from noisy accounts goes to Other.
- **Smart chip.** Incoming shipments grouped by order (Shipped → Out for delivery → Delivered, plus problems), and fresh OTPs with the code ready to copy. It also finds shipping and OTP mail that landed in Yahoo's spam folder.
- **Notifications** only for OTPs, shipping updates and important senders: native macOS notifications from the Mac app, or web push in a browser.
- **Read and reply** with the email's HTML in a sandboxed frame, remote images (trackers) blocked until you ask.
- **Bulk actions**: select, select all, mark read/unread, star, archive, delete (to Trash) and Not spam, with undo. Unread and Starred filters, Mark all read.
- **Search** that filters as you type, and searches 12 months of both accounts on Enter.
- **Keyboard first**: `j`/`k` move, `x` select, `e` archive, `#` delete, `s` star, `r` reply, `c` compose, `/` search.

## Quick start (Mac)

You need macOS 13+, [Node.js](https://nodejs.org) 20.11+ (`brew install node`), and an **app password** for each account (Google: 2-Step Verification → App passwords; Yahoo: Account security → Generate app password).

1. **Save your app passwords** in the login keychain (you'll be prompted, so they never land in shell history):

   ```bash
   security add-generic-password -a "you@gmail.com" -s "flux-gmail" -w
   security add-generic-password -a "you@yahoo.com" -s "flux-yahoo" -w
   ```

2. **Build and install the app:**

   ```bash
   npm ci
   mac/build.sh
   ```

3. **Open Flux** from Applications and allow notifications.

That's it: the server runs on your Mac, inside the app. Your settings and data live in `~/Library/Application Support/Flux` (**Server → Open Data Folder**). To choose your own important senders, copy `rules.example.json` there as `rules.json` and edit it.

Prefer a browser? Run `npm start` and open http://localhost:3030.

## Run it on your own server (optional)

The Mac app only notifies you while your Mac is awake. If you want Flux running around the clock, put the server on any Linux machine and point the app at it.

1. On the server: install Node 20.11+ to `/opt/node`, copy this repo to `/opt/flux`, run `npm ci --omit=dev`, create `/opt/flux/.env` (chmod 600) with `FLUX_GMAIL_USER`, `FLUX_GMAIL_PASS`, `FLUX_YAHOO_USER`, `FLUX_YAHOO_PASS`, and install `deploy/flux.service`.
2. In the Mac app: **Server → Remote Server…**, enter `user@host` and your SSH key. The app opens and maintains an SSH tunnel to the server. **Server → This Mac** switches back.

For a smoother loop, copy `config.example.env` to `config.env` and fill it in: `deploy.sh` then ships code to the server, `flux-open.sh` opens it in a browser, and `mac/build.sh` makes that server the app's default.

## How it works

```
 Flux.app                                   Flux server (Node, 127.0.0.1:3030 only)
 ┌──────────────────────────────┐          ┌──────────────────────────────────┐
 │ window: the web UI           │  local   │ server.js   HTTP API + UI         │
 │ starts the bundled server ───┼─────────▶│ store.js    IMAP IDLE, in memory  │──▶ Gmail / Yahoo (IMAP)
 │   or an SSH tunnel to yours  │  or SSH  │ imap.js     pooled connections    │──▶ Gmail / Yahoo (SMTP)
 │ /api/events → macOS notify   │          │ smart.js    rules, shipments, OTP │
 └──────────────────────────────┘          └──────────────────────────────────┘
```

- `store.js` keeps one always-open connection per folder (Gmail inbox, Yahoo inbox, Yahoo spam), so the inbox loads from memory.
- `imap.js` keeps one pooled connection per account for opening mail and actions; reading uses `BODY.PEEK`, so nothing is marked read by accident.
- The server listens on loopback only and has no login, by design. It checks `Host` and `Origin` on every request, so other websites can't read or send mail through it. Never expose port 3030 to the internet.

## Contributing

Issues and pull requests are welcome. Keep changes small and focused, match the surrounding code, and describe how you tested them. Please don't commit personal data: `config.env`, `rules.json`, `.env` and `data/` are git-ignored for a reason.

## License

Flux is free software under the [GNU General Public License v3.0 or later](LICENSE). You can use, study, change and share it; if you distribute a modified version, you share its source under the same license. Contributions are accepted under the same terms.

Copyright © 2026 Sarthak Menghwani.
