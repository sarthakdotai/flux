// Live mail store: one always-open IMAP connection per folder (inbox, plus Yahoo Bulk)
// keeps the newest messages in memory. IMAP IDLE tells us the moment mail arrives, so the
// inbox loads instantly and new mail can be announced. A full resync every few minutes
// catches deletions, flag changes made elsewhere, and silently dropped connections.
import { EventEmitter } from 'node:events';
import { ImapFlow } from 'imapflow';
import { ACCOUNTS, credentials } from './accounts.js';
import { classify } from './smart.js';

const KEEP = { INBOX: 200, spam: 1000 };
const RESYNC_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60_000;

const FIELDS = { uid: true, envelope: true, flags: true };

const keepFromSpam = (m) => m.category === 'shipping' || m.category === 'otp';

// Mailing-list mail. Needs the full header: Yahoo leaves List-Unsubscribe out when asked for
// just that field, and a full header takes 70 ms there, so each is read once and remembered.
const isListMail = (msg) => /^list-(unsubscribe|id):/im.test(msg.headers?.toString() ?? '');

function summary(account, folder, msg, list) {
  const sender = msg.envelope.from?.[0] ?? {};
  return classify({
    account: account.id,
    folder,
    uid: msg.uid,
    date: msg.envelope.date,
    from: { name: sender.name || '', address: (sender.address || '').toLowerCase() },
    subject: msg.envelope.subject || '(no subject)',
    seen: msg.flags.has('\\Seen'),
    flagged: msg.flags.has('\\Flagged'),
    list,
  });
}

class Source {
  constructor(store, account, folder) {
    Object.assign(this, { store, account, folder, messages: new Map(), lists: new Map(), maxUid: 0, error: null, backoff: 5000, ready: false });
    this.limit = folder === 'INBOX' ? KEEP.INBOX : KEEP.spam;
  }

  async start() {
    try {
      const { user, pass } = credentials(this.account.service);
      this.client = new ImapFlow({ ...this.account.imap, secure: true, auth: { user, pass }, logger: false });
      this.client.on('error', (err) => { this.error = err.message; });
      this.client.on('close', () => this.reconnect());
      this.client.on('exists', () => this.fetchNew().catch((err) => { this.error = err.message; }));
      this.client.on('flags', (event) => this.applyFlags(event));
      await this.client.connect();
      await this.client.mailboxOpen(this.folder, { readOnly: true });
      await this.resync();
      this.error = null;
      this.backoff = 5000;
      clearInterval(this.timer);
      this.timer = setInterval(() => this.resync().catch((err) => { this.error = err.message; }), RESYNC_MS);
    } catch (err) {
      this.error = err.responseText ?? err.message;
      this.reconnect();
    } finally {
      this.ready = true;
      this.store.checkReady();
    }
  }

  reconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    clearInterval(this.timer);
    setTimeout(() => {
      this.reconnecting = false;
      this.start();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  keep(msg) {
    return this.folder === 'INBOX' || keepFromSpam(msg);
  }

  // Reloads the newest `limit` messages. Anything above the previous maxUid is new mail.
  async resync() {
    const box = this.client.mailbox;
    const previousMax = this.maxUid;
    const next = new Map();
    if (box.exists > 0) {
      const from = Math.max(1, box.exists - this.limit + 1);
      for await (const msg of this.client.fetch(`${from}:*`, FIELDS)) {
        const m = summary(this.account, this.folder, msg, this.lists.get(msg.uid));
        if (!this.keep(m)) continue;
        next.set(m.uid, m);
        if (previousMax && msg.uid > previousMax) this.announce(m);
      }
      this.maxUid = Math.max(this.maxUid, box.uidNext - 1);
    }
    this.messages = next;
    this.findLists().catch((err) => { this.error = err.message; });
  }

  // Reads headers for mail not seen yet, in the background so the inbox never waits for it.
  async findLists() {
    const unknown = [...this.messages.keys()].filter((uid) => !this.lists.has(uid));
    if (this.folder !== 'INBOX' || this.findingLists || !unknown.length) return;
    this.findingLists = true;
    try {
      for await (const msg of this.client.fetch(unknown, { uid: true, headers: true }, { uid: true })) {
        const list = isListMail(msg);
        this.lists.set(msg.uid, list);
        const m = this.messages.get(msg.uid);
        if (m) this.messages.set(msg.uid, classify({ ...m, list }));
      }
    } finally {
      this.findingLists = false;
    }
  }

  // Each message is announced once, whether IDLE or a resync saw it first.
  announce(m) {
    this.announced ??= new Set();
    if (this.announced.has(m.uid)) return;
    this.announced.add(m.uid);
    this.store.emit('new', m);
  }

  async fetchNew() {
    if (!this.maxUid) return this.resync();
    for await (const msg of this.client.fetch(`${this.maxUid + 1}:*`, { ...FIELDS, headers: true }, { uid: true })) {
      if (msg.uid <= this.maxUid) continue; // "N:*" always returns the last message
      this.maxUid = msg.uid;
      const list = isListMail(msg);
      this.lists.set(msg.uid, list);
      const m = summary(this.account, this.folder, msg, list);
      if (!this.keep(m)) continue;
      this.messages.set(m.uid, m);
      this.announce(m);
    }
  }

  applyFlags({ uid, flags }) {
    const m = uid && this.messages.get(uid);
    if (!m) return;
    m.seen = flags.has('\\Seen');
    m.flagged = flags.has('\\Flagged');
  }
}

export class MailStore extends EventEmitter {
  constructor() {
    super();
    this.sources = [
      ...ACCOUNTS.map((a) => new Source(this, a, 'INBOX')),
      ...ACCOUNTS.filter((a) => a.spamFolder).map((a) => new Source(this, a, a.spamFolder)),
    ];
    this.ready = new Promise((resolve) => { this.resolveReady = resolve; });
  }

  start() {
    for (const source of this.sources) source.start();
    return this;
  }

  checkReady() {
    if (this.sources.every((s) => s.ready)) this.resolveReady();
  }

  messages() {
    return this.sources.flatMap((s) => [...s.messages.values()]);
  }

  errors() {
    return this.sources.filter((s) => s.error).map((s) => ({ account: s.account.id, folder: s.folder, error: s.error }));
  }

  source(accountId, folder) {
    return this.sources.find((s) => s.account.id === accountId && s.folder === folder);
  }

  setSeen(accountId, folder, uid, seen) {
    this.update(accountId, folder, [uid], { seen });
  }

  update(accountId, folder, uids, fields) {
    const source = this.source(accountId, folder);
    for (const uid of uids) {
      const m = source?.messages.get(uid);
      if (m) Object.assign(m, fields);
    }
  }

  // Re-sorts everything already loaded, after a sender was moved by hand.
  reclassify() {
    for (const source of this.sources) {
      for (const [uid, m] of source.messages) source.messages.set(uid, classify(m));
    }
  }

  // Removes messages and returns them (so an undo can put them back).
  remove(accountId, folder, uids) {
    const source = this.source(accountId, folder);
    return uids.map((uid) => {
      const m = source?.messages.get(uid);
      source?.messages.delete(uid);
      return m;
    });
  }

  // Puts a known message (e.g. one restored by undo) straight into a folder's list.
  insert(accountId, folder, msg) {
    const source = this.source(accountId, folder);
    if (!source) return;
    source.messages.set(msg.uid, { ...msg, folder });
    source.maxUid = Math.max(source.maxUid, msg.uid);
  }

  // Messages Flux itself moved back (undo) aren't "new mail": don't notify about them.
  suppress(accountId, folder, uids) {
    const source = this.source(accountId, folder);
    if (!source) return;
    source.announced ??= new Set();
    for (const uid of uids) source.announced.add(uid);
  }
}
