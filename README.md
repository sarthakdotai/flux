# flux*

**Email for what's next.**

Traditional inboxes lag. Modern ones are heavy. Flux is neither.

**Lightweight. Smart. Beautiful.** A modern inbox for people with modern needs.

---

## Who it's for

- **You run more than one inbox.** Work, personal, the old account you still can't let go of. Flux brings them into one live list.
- **Your mail app makes you wait.** Clicking an email shouldn't come with a loading spinner.
- **Your codes and parcels get lost.** One-time passwords expire while you dig for them, and shipping updates are scattered across five courier emails. Flux pulls both out of the pile for you.

## Why Flux

- **Fast enough to feel instant.** Your inbox is held in memory, so it loads in a blink, and most emails open in about a fifth of a second. New mail shows up the moment it lands, with no refresh button.
- **Light by design.** The Mac app is about 15 MB. No browser engine bundled inside it, nothing running in the background that you didn't ask for.
- **Your OTPs are ready to use.** The code shows in the notification with a Copy button, and on a chip at the top of your inbox for ten minutes after it arrives.
- **Your parcels track themselves.** Flux reads the shipping emails couriers already send you and keeps each order on one line: shipped, out for delivery, delivered, or stuck. It even rescues them from your spam folder.
- **Focus without a black box.** Mail from people, OTPs, shipments and senders you choose go to **Focused**. Mark an account as noisy, and its newsletters and promotions wait in **Other**. Every decision comes from rules you can read and edit, not from a model guessing.
- **Notifications that respect you.** You hear about codes, deliveries, people and the senders you pick, and nothing else.
- **Private by default.** Flux runs on your own Mac, or on a server you own. There's no Flux cloud and no Flux account, and tracking pixels are blocked until you choose to load images.
- **Built for the keyboard.** `j`/`k` to move, `e` to archive, `#` to delete, `s` to star, `r` to reply, `/` to search. Select many with `x` or Shift-click and act on them all at once, with undo.

## The way forward

Email is more than fifty years old, and most inboxes still behave like it. Heavy apps bolted onto old ideas, built by companies that decide what you see.

Flux starts from the other end: the inbox should be fast, it should know an OTP from a newsletter, and it should belong to the people who use it. That's why it's open source and built in the open. Every bug report, idea and pull request makes it better for everyone who uses it next.

Together, we can fix the legacy inbox.

## What it does today

- **One live inbox** across your accounts, each marked with a small account badge.
- **Focused and Other**, plus Unread and Starred filters and Mark all read.
- **Smart chip** for active shipments and fresh OTPs.
- **Read and reply** with email HTML in a sandboxed frame and remote images blocked until you ask.
- **Bulk actions**: mark read or unread, star, archive, delete to Trash, Not spam. All with undo.
- **Search** that filters as you type, and searches 12 months of mail on Enter.
- **Native Mac app** with notifications, a Dock badge for unread Focused mail, and an optional open-at-login.

**Works with Gmail and Yahoo today.** More providers are next on the [roadmap](#roadmap).

## Quick start (Mac)

> **Using an AI assistant?** Point it at [`llms.txt`](llms.txt): a step-by-step install guide written for assistants to walk you through, one small step at a time.

You need an Apple Silicon Mac on macOS 13+, Xcode, [Node.js](https://nodejs.org) 20.11+ (`brew install node`), and an **app password** for each account (Google: 2-Step Verification → App passwords; Yahoo: Account security → Generate app password).

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

   For notifications, the build signs Flux with an **Apple Development** certificate: free with any Apple ID (Xcode → Settings → Accounts → add your Apple ID → Manage Certificates → + → Apple Development). Without one, Flux still runs, but macOS blocks its notifications.

3. **Open Flux** from Applications and click **Allow** when macOS asks about notifications.

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

## Roadmap

- More providers: iCloud, Fastmail, Zoho, and any IMAP account, then Outlook.
- Any number of accounts per provider.
- Attachments: download and preview.
- An iPhone app.

Have something that should be on this list? Read on.

## Contribute

Flux gets better with every person who uses it. There are three ways in, and none of them needs permission.

### Builders: write code

Fix a bug, build a feature, or improve what's there.

1. Fork the repo and create a branch.
2. Get it running with the [Quick start](#quick-start-mac), or `npm start` for the server and UI in a browser.
3. Keep the change small and focused, match the code around it, and say in the pull request how you tested it.

Not sure where to start? Pick anything from the [roadmap](#roadmap) or an open issue, and say in the issue that you're on it.

### Testers: break things

Use Flux every day and tell us when it trips. [Open an issue](https://github.com/sarthakdotai/flux/issues/new) with:

- what you did, step by step
- what you expected, and what happened instead
- a screenshot if it's visual
- your macOS version and the mail providers you use

A clear bug report is worth as much as a fix.

### Visionaries: shape what's next

Have an idea that would make Flux a joy for everyone? [Open an issue](https://github.com/sarthakdotai/flux/issues/new) and tell us:

- the problem you keep running into
- who else has it
- how it should feel when it's solved

The best features start as one person's frustration, described well.

Whichever way you join, please never post personal data: no real email contents, passwords or addresses in issues, and no `config.env`, `rules.json`, `.env` or `data/` in pull requests.

## License

Flux is free software under the [GNU General Public License v3.0 or later](LICENSE). You can use, study, change and share it; if you distribute a modified version, you share its source under the same license. Contributions are accepted under the same terms.

Copyright © 2026 Sarthak Menghwani.
