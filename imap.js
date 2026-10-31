import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { credentials } from './accounts.js';

// One open connection per account, reused for every read and action: logging in to
// Gmail/Yahoo costs 2–3 s and selecting a folder ~1 s, far more than the work itself.
// Commands on a connection run one at a time (a queue); a dropped connection is replaced
// on the next call. Folders are opened read-write: imapflow fetches with BODY.PEEK, so
// reading never marks mail as read by itself.
// Slow background work (the shipping search takes ~7 s on Yahoo) runs on a second
// connection, the 'background' lane, so it never makes opening a mail wait.
const pool = new Map();
// Idle connections die quietly (overnight, network changes) and the next command then
// hangs until the socket times out. A NOOP heartbeat keeps them alive or finds out early,
// and a command that takes too long drops its connection so the next call starts fresh.
const HEARTBEAT_MS = 90_000;
const HEARTBEAT_TIMEOUT_MS = 8000;
const COMMAND_TIMEOUT_MS = 25_000;

function drop(entry) {
  if (pool.get(entry.key) === entry) pool.delete(entry.key);
  clearInterval(entry.heartbeat);
  entry.client.close();
}

function connection(account, lane) {
  const key = `${account.id}:${lane}`;
  const entry = pool.get(key);
  if (entry && entry.client.usable !== false) return entry;
  if (entry) drop(entry);
  const { user, pass } = credentials(account.service);
  const client = new ImapFlow({ ...account.imap, secure: true, auth: { user, pass }, logger: false });
  client.on('error', () => {}); // surfaced through the failing command; the next call reconnects
  const fresh = { key, client, ready: client.connect(), queue: Promise.resolve() };
  fresh.ready.catch(() => drop(fresh));
  fresh.heartbeat = setInterval(() => withClient(account, (c) => c.noop(), { lane, timeout: HEARTBEAT_TIMEOUT_MS }).catch(() => {}), HEARTBEAT_MS);
  pool.set(key, fresh);
  return fresh;
}

// Runs fn(client) on the account's connection, queued behind earlier commands in its lane.
// The time limit starts at the command's turn: waiting in line isn't a stalled connection.
function withClient(account, fn, { timeout = COMMAND_TIMEOUT_MS, lane = 'main' } = {}) {
  const entry = connection(account, lane);
  const run = entry.queue.then(() => {
    let timer;
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => {
        drop(entry);
        reject(new Error(`${account.id} didn't answer in ${timeout / 1000} s`));
      }, timeout);
    });
    return Promise.race([entry.ready.then(() => fn(entry.client)), limit]).finally(() => clearTimeout(timer));
  });
  entry.queue = run.catch(() => {});
  run.catch(() => { if (entry.client.usable === false) drop(entry); });
  return run;
}

// Runs fn(client, mailbox) with `folder` selected (re-selected only when it changes).
function withFolder(account, folder, fn, options) {
  return withClient(account, async (client) => {
    if (client.mailbox?.path !== folder) await client.mailboxOpen(folder);
    return fn(client, client.mailbox);
  }, options);
}

function summary(account, folder, msg) {
  const sender = msg.envelope.from?.[0] ?? {};
  return {
    account: account.id,
    folder,
    uid: msg.uid,
    date: msg.envelope.date,
    from: { name: sender.name || '', address: (sender.address || '').toLowerCase() },
    to: (msg.envelope.to ?? []).map((t) => ({ name: t.name || '', address: (t.address || '').toLowerCase() })),
    subject: msg.envelope.subject || '(no subject)',
    seen: msg.flags.has('\\Seen'),
    flagged: msg.flags.has('\\Flagged'),
  };
}

// Newest `limit` messages in a folder for one account, as plain summaries.
export function fetchInbox(account, limit, folder = 'INBOX') {
  return withFolder(account, folder, async (client, box) => {
    if (box.exists === 0) return [];
    const from = Math.max(1, box.exists - limit + 1);
    const messages = [];
    for await (const msg of client.fetch(`${from}:*`, { uid: true, envelope: true, flags: true })) {
      messages.push(summary(account, folder, msg));
    }
    return messages;
  });
}

// Summaries of messages matching any of `criteria` (imapflow search objects) since `since`.
// The server does the searching, so this reaches past the newest-N window.
// `max` keeps only the newest matches, so a broad search doesn't fetch thousands of envelopes.
export function searchInbox(account, criteria, since, folder = 'INBOX', max = Infinity, options) {
  return withFolder(account, folder, async (client) => {
    // Yahoo's OR both misses and over-matches, so each criterion is its own search and the
    // UIDs are merged. Yahoo also matches whole words only: callers re-check results.
    const found = new Set();
    for (const criterion of criteria) {
      for (const uid of (await client.search({ ...criterion, since }, { uid: true })) || []) found.add(uid);
    }
    const uids = [...found].sort((a, b) => a - b).slice(-max);
    if (!uids.length) return [];
    const messages = [];
    for await (const msg of client.fetch(uids, { uid: true, envelope: true, flags: true }, { uid: true })) {
      messages.push(summary(account, folder, msg));
    }
    return messages;
  }, options);
}

export function setSeen(account, uid, seen, folder = 'INBOX') {
  return setFlag(account, folder, [uid], '\\Seen', seen);
}

// Adds or removes one flag (\Seen, \Flagged) on many messages in one folder.
export function setFlag(account, folder, uids, flag, on) {
  return withFolder(account, folder, (client) => (on
    ? client.messageFlagsAdd(uids, [flag], { uid: true })
    : client.messageFlagsRemove(uids, [flag], { uid: true })));
}

// Archive and Trash differ per provider (Gmail: [Gmail]/All Mail and [Gmail]/Trash; Yahoo:
// Archive and Trash), so they're found by their IMAP special-use flag once and cached.
const specialFolders = new Map();
export async function specialFolder(account, use) {
  const key = `${account.id}:${use}`;
  if (!specialFolders.has(key)) {
    for (const box of await withClient(account, (client) => client.list())) {
      if (box.specialUse) specialFolders.set(`${account.id}:${box.specialUse}`, box.path);
    }
  }
  const path = specialFolders.get(key);
  if (!path) throw new Error(`${account.id} has no ${use} folder`);
  return path;
}

// Moves messages to another folder. Returns their new UIDs there (for undo), in input order.
export function moveMessages(account, folder, uids, destination) {
  return withFolder(account, folder, async (client) => {
    const result = await client.messageMove(uids, destination, { uid: true });
    return uids.map((uid) => result?.uidMap?.get(uid) ?? null);
  });
}

// One full message, parsed. Downloading holds the account's connection; parsing doesn't.
// markSeen flags it as read in the background, so opening never waits for that.
export async function fetchMessage(account, uid, { markSeen = true, folder = 'INBOX' } = {}) {
  // Short timeout and one retry: a stale connection is replaced instead of making you wait.
  const download = () => withFolder(account, folder, async (client) => (await client.fetchOne(uid, { source: true }, { uid: true }))?.source, { timeout: 8000 });
  const source = await download().catch(download);
  if (!source) return null;
  if (markSeen) setFlag(account, folder, [uid], '\\Seen', true).catch(() => {});
  const parsed = await simpleParser(source, { skipImageLinks: true });
  return {
    account: account.id,
    folder,
    uid,
    messageId: parsed.messageId || '',
    references: [parsed.references ?? []].flat(),
    date: parsed.date,
    from: parsed.from?.value?.[0] ?? { name: '', address: '' },
    to: parsed.to ? [parsed.to].flat().flatMap((t) => t.value) : [],
    cc: parsed.cc ? [parsed.cc].flat().flatMap((t) => t.value) : [],
    subject: parsed.subject || '(no subject)',
    html: parsed.html || '',
    text: parsed.text || '',
    attachments: parsed.attachments
      .filter((a) => a.contentDisposition !== 'inline')
      .map((a) => ({ filename: a.filename || 'attachment', size: a.size, contentType: a.contentType })),
  };
}
