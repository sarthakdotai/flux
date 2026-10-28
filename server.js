import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ACCOUNTS, account } from './accounts.js';
import { fetchMessage, searchInbox, setSeen, setFlag, specialFolder, moveMessages } from './imap.js';
import { sendMail } from './smtp.js';
import { classify, isShipping, shipments, freshOtps, extractOtp, messageText, shippingCriteria, shippingSince } from './smart.js';
import { MailStore } from './store.js';
import { notification } from './notify.js';
import { publicKey, subscribe, pushAll } from './push.js';

const PORT = 3030;
const MAX_LIMIT = 200;
const SHIPPING_CACHE_MS = 10 * 60_000;
const SEARCH_DAYS = 365;
const PUBLIC_DIR = path.join(import.meta.dirname, 'public');
const TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};
const ALLOWED_HOSTS = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];

const store = new MailStore().start();
const listeners = new Set();

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const byDateDesc = (a, b) => new Date(b.date) - new Date(a.date);

function folderFor(accountId, folder = 'INBOX') {
  const a = account(accountId);
  if (folder !== 'INBOX' && folder !== a.spamFolder) throw new Error(`Unknown folder ${folder}`);
  return a;
}

/* ---------- New mail: live UI update + push notification ---------- */

store.on('new', async (msg) => {
  const note = await notification(msg).catch(() => null);
  for (const res of listeners) res.write(`data: ${JSON.stringify({ message: msg, note })}\n\n`);
  if (msg.category === 'shipping') shippingCache = null;
  if (note) await pushAll({ ...note, account: msg.account, folder: msg.folder, uid: msg.uid });
});

// GET /api/events -> server-sent events, one per new message.
function events(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(': connected\n\n');
  listeners.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => { clearInterval(ping); listeners.delete(res); });
}

/* ---------- Reading ---------- */

// GET /api/inbox?limit=100 -> newest messages from the live store, merged by date.
async function inbox(url, res) {
  const limit = Math.min(Number(url.searchParams.get('limit')) || 100, MAX_LIMIT);
  await store.ready;
  send(res, 200, {
    messages: store.messages().sort(byDateDesc).slice(0, limit),
    errors: store.errors(),
    accounts: ACCOUNTS.map((a) => a.id),
  });
}

// Recently fetched messages (contents never change for a UID), so opening one the app
// already warmed up on hover is instant.
const MESSAGE_CACHE_SIZE = 60;
const messageCache = new Map();

function cachedMessage(a, uid, folder) {
  const key = `${a.id}:${folder}:${uid}`;
  if (!messageCache.has(key)) {
    const loading = fetchMessage(a, uid, { folder, markSeen: false });
    loading.catch(() => messageCache.delete(key));
    messageCache.set(key, loading);
    while (messageCache.size > MESSAGE_CACHE_SIZE) messageCache.delete(messageCache.keys().next().value);
  }
  return messageCache.get(key);
}

// GET /api/message/:account/:uid?folder=Bulk -> the full message, marked read.
// With &prefetch=1 it only warms the cache (sent on hover) and leaves it unread.
async function message(accountId, uid, url, res) {
  const folder = url.searchParams.get('folder') ?? 'INBOX';
  const a = folderFor(accountId, folder);
  const msg = await cachedMessage(a, Number(uid), folder);
  if (!msg) return send(res, 404, { error: 'Message not found' });
  if (url.searchParams.get('prefetch')) return send(res, 200, { ok: true });
  store.setSeen(accountId, folder, Number(uid), true);
  setSeen(a, Number(uid), true, folder).catch(() => {});
  send(res, 200, msg);
}

// GET /api/search?q= -> sender or subject matches across both inboxes (last 12 months),
// plus anything in the live store the provider's search index hasn't caught up with yet.
async function search(url, res) {
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 2) return send(res, 400, { error: 'Search needs at least 2 characters' });
  const since = new Date(Date.now() - SEARCH_DAYS * 86400000);
  const results = await Promise.allSettled(ACCOUNTS.map((a) => searchInbox(a, [{ from: q }, { subject: q }], since, 'INBOX', MAX_LIMIT)));
  const found = new Map();
  const needle = q.toLowerCase();
  const local = store.messages().filter((m) => `${m.from.name} ${m.from.address} ${m.subject}`.toLowerCase().includes(needle));
  for (const m of [...results.flatMap((r) => (r.status === 'fulfilled' ? r.value.map(classify) : [])), ...local]) {
    found.set(`${m.account}:${m.folder}:${m.uid}`, m);
  }
  const errors = results.flatMap((r, i) => (r.status === 'rejected' ? [{ account: ACCOUNTS[i].id, error: r.reason.message }] : []));
  send(res, 200, { messages: [...found.values()].sort(byDateDesc).slice(0, MAX_LIMIT), errors });
}

/* ---------- Smart chip ---------- */

let shippingCache = null;
const otpCodes = new Map();

// Shipments: inbox via server SEARCH (reaches 30 days back), spam from the live store
// (Yahoo's SEARCH finds nothing in Bulk). Cached; new shipping mail clears the cache.
async function activeShipments() {
  if (shippingCache && Date.now() - shippingCache.at < SHIPPING_CACHE_MS) return shippingCache;
  const since = shippingSince();
  const results = await Promise.allSettled(ACCOUNTS.map((a) => searchInbox(a, shippingCriteria, since)));
  const fromSpam = store.messages().filter((m) => m.folder !== 'INBOX' && isShipping(m) && new Date(m.date) >= since);
  const fromInbox = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const errors = results.flatMap((r, i) => (r.status === 'rejected' ? [{ account: ACCOUNTS[i].id, error: r.reason.message }] : []));
  shippingCache = { at: Date.now(), shipments: shipments([...fromInbox, ...fromSpam]), errors };
  return shippingCache;
}

// OTP: newest fresh one from the live store (instant; no search lag). Codes cached per message.
async function latestOtp() {
  const candidate = freshOtps(store.messages())[0];
  if (!candidate) return null;
  const key = `${candidate.account}:${candidate.folder}:${candidate.uid}`;
  if (!otpCodes.has(key)) {
    let code = extractOtp(candidate.subject);
    if (!code) {
      const full = await fetchMessage(account(candidate.account), candidate.uid, { markSeen: false, folder: candidate.folder }).catch(() => null);
      code = full && extractOtp(messageText(full));
    }
    otpCodes.set(key, code);
  }
  return { ...candidate, code: otpCodes.get(key) };
}

// GET /api/smart -> active shipments and the newest fresh OTP.
async function smart(res) {
  await store.ready;
  const [shipping, otp] = await Promise.all([activeShipments(), latestOtp()]);
  send(res, 200, { shipments: shipping.shipments, otp, errors: shipping.errors });
}

/* ---------- Writing ---------- */

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error('Request too large');
  }
  return JSON.parse(body);
}

// POST /api/send {account, to, cc, subject, text, inReplyTo, references}
async function sendRoute(req, res) {
  const { account: accountId, to, cc, subject, text, inReplyTo, references } = await readJson(req);
  if (!to?.trim() || !subject?.trim()) return send(res, 400, { error: 'To and subject are required' });
  const result = await sendMail(account(accountId), { to, cc, subject, text: text ?? '', inReplyTo, references });
  send(res, 200, result);
}

// POST /api/seen {account, folder, uid, seen}
async function seenRoute(req, res) {
  const { account: accountId, folder = 'INBOX', uid, seen } = await readJson(req);
  await setSeen(folderFor(accountId, folder), Number(uid), Boolean(seen), folder);
  store.setSeen(accountId, folder, Number(uid), Boolean(seen));
  send(res, 200, { ok: true });
}

// Messages Flux moved away recently, by their new location, so undo can restore them instantly.
const moved = new Map();

const FLAG_ACTIONS = {
  read: ['\\Seen', true, { seen: true }],
  unread: ['\\Seen', false, { seen: false }],
  star: ['\\Flagged', true, { flagged: true }],
  unstar: ['\\Flagged', false, { flagged: false }],
};
// Where each move goes. Delete moves to Trash (recoverable there), never erases.
const MOVE_ACTIONS = {
  archive: (a) => specialFolder(a, a.id === 'gmail' ? '\\All' : '\\Archive'),
  trash: (a) => specialFolder(a, '\\Trash'),
  inbox: async () => 'INBOX',
};

// POST /api/bulk {action, items: [{account, folder, uid}], to?}
// Flag actions: read, unread, star, unstar. Moves: archive, trash, inbox (Not spam).
// restore: puts moved messages back (undo); items are where they went, `to` where they came from.
// Moves return `undo`: the new location of each moved message.
async function bulkRoute(req, res) {
  const { action, items, to } = await readJson(req);
  if (!Array.isArray(items) || items.length === 0 || items.length > 500) return send(res, 400, { error: 'Pick 1–500 messages' });
  const groups = new Map();
  for (const { account: id, folder = 'INBOX', uid } of items) {
    const key = `${id}\n${folder}`;
    if (!groups.has(key)) groups.set(key, { id, folder, uids: [] });
    groups.get(key).uids.push(Number(uid));
  }
  const undo = [];
  for (const { id, folder, uids } of groups.values()) {
    if (FLAG_ACTIONS[action]) {
      const [flag, on, fields] = FLAG_ACTIONS[action];
      await setFlag(folderFor(id, folder), folder, uids, flag, on);
      store.update(id, folder, uids, fields);
    } else if (MOVE_ACTIONS[action]) {
      const a = folderFor(id, folder);
      const destination = await MOVE_ACTIONS[action](a);
      if (destination === folder) continue;
      const newUids = await moveMessages(a, folder, uids, destination);
      store.remove(id, folder, uids).forEach((m, i) => {
        if (m && newUids[i]) moved.set(`${id}:${destination}:${newUids[i]}`, m);
      });
      while (moved.size > 2000) moved.delete(moved.keys().next().value);
      undo.push({ account: id, folder: destination, uids: newUids.filter(Boolean), to: folder });
    } else if (action === 'restore') {
      const a = account(id);
      const allowed = [await specialFolder(a, a.id === 'gmail' ? '\\All' : '\\Archive'), await specialFolder(a, '\\Trash'), 'INBOX'];
      if (!allowed.includes(folder)) throw new Error(`Can't restore from ${folder}`);
      folderFor(id, to); // only back to INBOX or the spam folder
      const back = await moveMessages(a, folder, uids, to);
      store.suppress(id, to, back.filter(Boolean));
      // Put restored mail straight back in the list: Gmail can take ~30 s to tell the live
      // connection about it.
      uids.forEach((uid, i) => {
        const m = moved.get(`${id}:${folder}:${uid}`);
        if (m && back[i]) store.insert(id, to, { ...m, uid: back[i] });
        moved.delete(`${id}:${folder}:${uid}`);
      });
    } else {
      return send(res, 400, { error: `Unknown action ${action}` });
    }
  }
  if (action === 'archive' || action === 'trash' || action === 'inbox') shippingCache = null;
  send(res, 200, { ok: true, undo });
}

// POST /api/push/subscribe {subscription}
async function subscribeRoute(req, res) {
  subscribe((await readJson(req)).subscription);
  send(res, 200, { ok: true });
}

/* ---------- Static files ---------- */

// Files from public/ only; anything resolving outside it is a 404.
async function staticFile(url, res) {
  const file = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  const type = TYPES[path.extname(file)];
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !type) return send(res, 404, { error: 'Not found' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

const POST_ROUTES = { '/api/send': sendRoute, '/api/seen': seenRoute, '/api/bulk': bulkRoute, '/api/push/subscribe': subscribeRoute };

const server = http.createServer(async (req, res) => {
  // Only this machine's own Flux page may talk to the server: blocks other websites from
  // sending mail or reading it through the browser (CSRF, DNS rebinding).
  if (!ALLOWED_HOSTS.includes(req.headers.host)) return send(res, 403, { error: 'Forbidden host' });
  const origin = req.headers.origin;
  if (origin && !ALLOWED_HOSTS.some((h) => origin === `http://${h}`)) return send(res, 403, { error: 'Forbidden origin' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET') {
      if (url.pathname === '/api/inbox') return await inbox(url, res);
      if (url.pathname === '/api/smart') return await smart(res);
      if (url.pathname === '/api/search') return await search(url, res);
      if (url.pathname === '/api/events') return events(req, res);
      if (url.pathname === '/api/push/key') return send(res, 200, { publicKey });
      const msgMatch = url.pathname.match(/^\/api\/message\/(\w+)\/(\d+)$/);
      if (msgMatch) return await message(msgMatch[1], msgMatch[2], url, res);
      return await staticFile(url, res);
    }
    if (req.method === 'POST' && POST_ROUTES[url.pathname]) {
      if (!origin || req.headers['content-type'] !== 'application/json') return send(res, 403, { error: 'Forbidden' });
      return await POST_ROUTES[url.pathname](req, res);
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    send(res, 500, { error: err.responseText ?? err.message });
  }
});

// Bound to loopback only: reachable from this machine (or an SSH tunnel), not the network.
server.listen(PORT, '127.0.0.1', () => console.log(`Flux server on http://127.0.0.1:${PORT}`));
