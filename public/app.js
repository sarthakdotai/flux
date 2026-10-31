const LIMIT = 100;
const FOLDER_LIMIT = 100;
const REFRESH_MS = 60_000;
const OTP_FRESH_MS = 10 * 60_000;
const AVATAR_COLOURS = [
  ['var(--lime)', 'var(--onyx)'],
  ['var(--bubblegum)', 'var(--onyx)'],
  ['var(--tangerine)', 'var(--sand)'],
  ['var(--onyx)', 'var(--sand)'],
];
const STATUS_LABEL = { ordered: 'Ordered', shipped: 'Shipped', out: 'Out for delivery', delivered: 'Delivered', issue: 'Problem', update: 'Update' };
const ACCOUNT_LABEL = { gmail: 'Gmail', yahoo: 'Yahoo' };
const MAILBOX_TITLE = { inbox: 'Inbox', sent: 'Sent', drafts: 'Drafts', spam: 'Spam', archive: 'Archive', trash: 'Trash' };
const FOLDER_EMPTY = { sent: 'Nothing sent yet.', drafts: 'No drafts.', spam: 'No spam.', archive: 'Nothing archived.', trash: 'Trash is empty.' };
// The action that brings mail back to the inbox, named for where it's coming from.
const RESTORE_LABEL = { spam: 'Not spam', archive: 'Move to Inbox', trash: 'Move to Inbox' };

const $ = (id) => document.getElementById(id);
const list = $('list');
const banner = $('banner');
const refreshBtn = $('refresh');

const state = {
  messages: [], view: 'focused', account: 'all', smart: null, open: null, search: null, cursor: -1,
  selected: new Set(), anchor: null, filters: { unread: false, starred: false },
  mailbox: 'inbox', folders: {},
};
const keyOf = (m) => `${m.account}:${m.folder}:${m.uid}`;

// Builds an element; text always goes in via textContent, never as HTML,
// because sender names and subjects come from strangers.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function icon(name, size = 18) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
}

function formatTime(iso) {
  const date = new Date(iso);
  const days = Math.floor((new Date(new Date().toDateString()) - new Date(date.toDateString())) / 86400000);
  if (days === 0) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

const fullTime = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

function initials(from) {
  const words = (from.name || from.address || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
  return ((words[0]?.[0] ?? '?') + (words[1]?.[0] ?? '')).toUpperCase();
}

function avatar(from) {
  let hash = 0;
  for (const ch of from.address || '') hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const [bg, fg] = AVATAR_COLOURS[Math.abs(hash) % AVATAR_COLOURS.length];
  const node = el('div', 'avatar', initials(from));
  node.style.background = bg;
  node.style.color = fg;
  return node;
}

// A short message at the bottom; with `action`, it carries a button (Undo) and stays longer.
// Which inbox an email came from: a lettered badge on the avatar's corner. Not a dot
// beside the sender, which reads as "unread" in every mail app.
// Mail Flux pulled out of a spam folder into the inbox (not mail listed in a folder view).
const isFromSpam = (msg) => msg.folder !== 'INBOX' && !msg.listed;

function accountBadge(account) {
  const badge = el('span', `acct ${account}`, account === 'gmail' ? 'G' : 'Y');
  badge.title = ACCOUNT_LABEL[account];
  badge.setAttribute('aria-label', ACCOUNT_LABEL[account]);
  return badge;
}

function toast(text, action) {
  const node = $('toast');
  node.replaceChildren(el('span', null, text));
  if (action) {
    const button = el('button', 'toast-action', action.label);
    button.addEventListener('click', () => { node.hidden = true; action.run(); });
    node.append(button);
  }
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, action ? 7000 : 2600);
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  return data;
}

/* ---------- Inbox ---------- */

function row(msg, index) {
  const selected = state.selected.has(keyOf(msg));
  const li = el('li', `row${msg.seen ? '' : ' unread'}${selected ? ' selected' : ''}`);
  li.dataset.key = keyOf(msg);
  li.style.animationDelay = `${Math.min(index, 12) * 20}ms`;
  // Resting on a row for a moment starts loading it, so the click opens it instantly.
  let hover;
  li.addEventListener('mouseenter', () => { hover = setTimeout(() => prefetch(msg), 120); });
  li.addEventListener('mouseleave', () => clearTimeout(hover));
  li.addEventListener('click', (event) => {
    if (event.target.closest('.check')) return toggleSelect(msg, event.shiftKey);
    if (event.target.closest('.star')) return runBulk(msg.flagged ? 'unstar' : 'star', [msg]);
    if (event.metaKey || event.ctrlKey || state.selected.size) return toggleSelect(msg, event.shiftKey);
    openMessage(msg.account, msg.uid, msg.folder);
  });

  const body = el('div', 'body');
  const top = el('div', 'top');
  // In Sent, a row is about who you wrote to.
  const person = msg.sentItem ? (msg.to[0] ?? { name: '', address: '' }) : msg.from;
  const recipient = person.name || person.address;
  top.append(el('span', 'sender', msg.sentItem ? (recipient ? `To ${recipient}` : 'No recipient') : recipient));
  if (msg.category === 'otp') top.append(el('span', 'tag otp', 'OTP'));
  if (msg.category === 'shipping') top.append(el('span', 'tag shipping', 'Shipping'));
  if (isFromSpam(msg)) top.append(el('span', 'tag spam', 'From spam'));
  top.title = `${msg.from.address} · ${ACCOUNT_LABEL[msg.account]}`;
  body.append(top, el('div', 'subject', msg.subject));

  const meta = el('div', 'meta');
  const star = el('button', `star${msg.flagged ? ' on' : ''}`, msg.flagged ? '★' : '☆');
  star.setAttribute('aria-label', msg.flagged ? 'Unstar' : 'Star');
  const metaRow = el('div', 'meta-row');
  metaRow.append(el('span', 'unread-dot'), star);
  meta.append(el('span', 'time', formatTime(msg.date)), metaRow);

  // Avatar doubles as the checkbox: it turns into one on hover or while selecting.
  const pick = el('div', 'pick');
  const check = el('button', 'check');
  check.setAttribute('role', 'checkbox');
  check.setAttribute('aria-checked', String(selected));
  check.setAttribute('aria-label', 'Select');
  pick.append(avatar(person), accountBadge(msg.account), check);

  li.append(pick, body, meta);
  return li;
}

// Asks the server to load a message into its cache without marking it read.
const warmed = new Set();
function prefetch(msg) {
  const key = keyOf(msg);
  if (!msg || warmed.has(key)) return;
  warmed.add(key);
  fetch(`/api/message/${msg.account}/${msg.uid}?folder=${encodeURIComponent(msg.folder)}&prefetch=1`)
    .catch(() => warmed.delete(key));
}

/* ---------- Selection and bulk actions ---------- */

function toggleSelect(msg, range) {
  const shown = visibleMessages();
  const keys = shown.map(keyOf);
  const key = keyOf(msg);
  if (range && state.anchor && keys.includes(state.anchor)) {
    const [from, to] = [keys.indexOf(state.anchor), keys.indexOf(key)].sort((a, b) => a - b);
    for (const k of keys.slice(from, to + 1)) state.selected.add(k);
  } else if (state.selected.has(key)) {
    state.selected.delete(key);
  } else {
    state.selected.add(key);
  }
  state.anchor = key;
  renderList();
}

function selectAll(on) {
  state.selected = new Set(on ? visibleMessages().map(keyOf) : []);
  renderList();
}

function selectedMessages() {
  const pool = state.search ? [...state.search.messages, ...currentPool()] : currentPool();
  const byKey = new Map(pool.map((m) => [keyOf(m), m]));
  return [...state.selected].map((k) => byKey.get(k)).filter(Boolean);
}

const LOCAL = {
  read: { seen: true }, unread: { seen: false }, star: { flagged: true }, unstar: { flagged: false },
};
const DONE = {
  read: 'Marked read', unread: 'Marked unread', star: 'Starred', unstar: 'Unstarred',
  archive: 'Archived', trash: 'Moved to Trash', inbox: 'Moved to Inbox',
};

// Applies an action to messages: updates the screen at once, then the server.
// Archive/Delete/Not spam take messages off the list and offer Undo.
async function runBulk(action, msgs) {
  if (!msgs.length) return;
  const keys = new Set(msgs.map(keyOf));
  const pools = [state.messages, ...Object.values(state.folders), state.search?.messages ?? []];
  if (LOCAL[action]) {
    for (const pool of pools) for (const m of pool) if (keys.has(keyOf(m))) Object.assign(m, LOCAL[action]);
  } else {
    state.messages = state.messages.filter((m) => !keys.has(keyOf(m)));
    for (const name of Object.keys(state.folders)) state.folders[name] = state.folders[name].filter((m) => !keys.has(keyOf(m)));
    if (state.search) state.search.messages = state.search.messages.filter((m) => !keys.has(keyOf(m)));
  }
  for (const k of keys) state.selected.delete(k);
  if (state.open && keys.has(keyOf(state.open))) {
    Object.assign(state.open, LOCAL[action] ?? {});
    if (!LOCAL[action]) closeMessage();
    else renderReaderActions();
  }
  renderList();

  try {
    const { undo } = await api('/api/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, items: msgs.map(({ account, folder, uid }) => ({ account, folder, uid })) }),
    });
    const count = msgs.length > 1 ? `${msgs.length} emails` : '';
    const text = [DONE[action], count].filter(Boolean).join(' · ');
    if (undo.length) toast(text, { label: 'Undo', run: () => undoMoves(undo) });
    else if (action !== 'star' && action !== 'unstar') toast(text);
  } catch (err) {
    toast(`Couldn’t ${DONE[action].toLowerCase()}: ${err.message}`);
    loadInbox();
  }
}

async function undoMoves(undo) {
  try {
    for (const group of undo) {
      if (!group.uids.length) continue;
      await api('/api/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restore', to: group.to, items: group.uids.map((uid) => ({ account: group.account, folder: group.folder, uid })) }),
      });
    }
    toast('Undone');
    setTimeout(() => { // the live connection picks the messages back up
      loadInbox();
      if (state.mailbox !== 'inbox') loadFolder(state.mailbox);
    }, 1500);
  } catch (err) {
    toast(`Couldn’t undo: ${err.message}`);
  }
}

/* ---------- Move to Focused / Other: remembered per sender ---------- */

const focusLabel = (msgs) => (msgs.every((m) => m.focused) ? 'Move to Other' : 'Move to Focused');

async function saveSenders(senders) {
  const { undo } = await api('/api/senders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senders }),
  });
  await loadInbox();
  return undo;
}

// Applies to the sender, not just this email, so their next mail lands in the same place.
async function moveSenders(msgs) {
  if (!msgs.length) return;
  const focused = focusLabel(msgs) === 'Move to Focused';
  const addresses = [...new Set(msgs.map((m) => m.from.address.toLowerCase()))];
  for (const m of [...state.messages, ...(state.search?.messages ?? [])]) {
    if (addresses.includes(m.from.address)) Object.assign(m, { focused, newsletter: false });
  }
  state.selected.clear();
  if (state.open) {
    state.open.focused = focused;
    renderReaderActions();
  }
  renderList();
  try {
    const undo = await saveSenders(addresses.map((address) => ({ address, focus: focused ? 'focused' : 'other' })));
    const who = addresses.length === 1 ? msgs[0].from.name || addresses[0] : `${addresses.length} senders`;
    toast(`${who} will land in ${focused ? 'Focused' : 'Other'}`, {
      label: 'Undo',
      run: async () => {
        await saveSenders(undo);
        if (state.open) state.open.focused = !focused;
        renderReaderActions();
        toast('Undone');
      },
    });
  } catch (err) {
    toast(`Couldn’t move: ${err.message}`);
    loadInbox();
  }
}

function renderSelectionBars(shown) {
  const picked = shown.filter((m) => state.selected.has(keyOf(m))).length;
  const selecting = state.selected.size > 0;
  $('toolbar').hidden = selecting;
  $('bulkbar').hidden = !selecting;
  list.classList.toggle('selecting', selecting);
  const allState = picked === 0 ? 'false' : picked === shown.length ? 'true' : 'mixed';
  $('select-all').setAttribute('aria-checked', allState);
  $('bulk-all').setAttribute('aria-checked', allState);
  $('bulk-count').textContent = `${state.selected.size} selected`;
  const chosen = selectedMessages();
  const restore = RESTORE_LABEL[state.mailbox] ?? (chosen.some(isFromSpam) ? 'Not spam' : '');
  $('bulk-notspam').hidden = !restore;
  $('bulk-notspam').textContent = restore;
  $('bulk-focus').textContent = focusLabel(chosen);
  $('mark-all-read').disabled = !shown.some((m) => !m.seen);
}

// What the list shows right now: search results (both tabs), or the Focused/Other tab.
function visibleMessages() {
  const pool = state.search ? state.search.messages : currentPool();
  const inAccount = pool.filter((m) => state.account === 'all' || m.account === state.account)
    .filter((m) => (!state.filters.unread || !m.seen) && (!state.filters.starred || m.flagged));
  // Starred spans both tabs, like search: a starred email is wanted wherever it landed.
  if (state.search || state.filters.starred || state.mailbox !== 'inbox') return inAccount;
  return inAccount.filter((m) => viewOf(m) === state.view);
}

const viewOf = (m) => (m.newsletter ? 'newsletters' : m.focused ? 'focused' : 'other');

function renderTitle() {
  const name = MAILBOX_TITLE[state.mailbox];
  $('view-title').textContent = state.account === 'all' ? name : `${ACCOUNT_LABEL[state.account]} ${name}`;
  $('back').textContent = `← ${name}`;
}

function renderList() {
  const inAccount = state.messages.filter((m) => state.account === 'all' || m.account === state.account);
  const shown = visibleMessages();
  renderTitle();
  $('results-bar').hidden = !state.search;
  $('pills').hidden = Boolean(state.search || state.filters.starred);
  if (state.search) $('results-label').textContent = `${shown.length} result${shown.length === 1 ? '' : 's'} for “${state.search.query}”`;
  state.cursor = Math.min(state.cursor, shown.length - 1);
  list.replaceChildren(...shown.map(row));
  if (state.cursor >= 0) list.children[state.cursor]?.classList.add('cursor');
  // Rows rise in on first load only; later refreshes swap in place without flicker.
  if (shown.length && !list.classList.contains('settled')) setTimeout(() => list.classList.add('settled'), 1000);
  const emptyText = state.search ? 'No matches.'
    : FOLDER_EMPTY[state.mailbox] ? FOLDER_EMPTY[state.mailbox]
    : state.filters.starred ? 'No starred emails.'
      : state.filters.unread ? 'All caught up.'
        : state.view === 'focused' ? 'Nothing important. Enjoy the quiet.'
          : state.view === 'newsletters' ? 'No newsletters.' : 'Nothing here.';
  if (shown.length === 0) list.append(el('li', 'empty', emptyText));
  // Drop selections that are no longer on screen (moved, filtered out, refreshed away).
  const onScreen = new Set(shown.map(keyOf));
  for (const k of state.selected) if (!onScreen.has(k)) state.selected.delete(k);
  renderSelectionBars(shown);
  $('unread-count').textContent = state.messages.filter((m) => m.focused && !m.seen).length || '';
  $('other-count').textContent = inAccount.filter((m) => viewOf(m) === 'other').length || '';
  $('newsletter-count').textContent = inAccount.filter((m) => m.newsletter).length || '';
}

function renderSkeleton() {
  list.replaceChildren(...Array.from({ length: 8 }, () => {
    const li = el('li', 'row skeleton');
    const body = el('div', 'body');
    body.append(el('div', 'bar'), el('div', 'bar'));
    body.firstChild.style.width = '30%';
    body.lastChild.style.width = '60%';
    li.append(el('div', 'avatar'), body, el('div'));
    return li;
  }));
}

function showErrors(errors) {
  banner.hidden = errors.length === 0;
  banner.textContent = errors.map((e) => `Couldn’t load ${ACCOUNT_LABEL[e.account] ?? e.account}${e.folder === 'INBOX' ? '' : ' spam'}: ${e.error}`).join(' · ');
  document.querySelectorAll('[data-status]').forEach((node) => {
    node.textContent = errors.some((e) => e.account === node.dataset.status && e.folder === 'INBOX') ? 'offline' : '';
  });
}

async function loadInbox() {
  if (state.messages.length === 0) renderSkeleton();
  try {
    const data = await api(`/api/inbox?limit=${LIMIT}`);
    state.messages = data.messages;
    // Only show the accounts this install has set up (just Gmail, just Yahoo, or both).
    document.querySelectorAll('.nav-item[data-account]').forEach((item) => {
      item.hidden = item.dataset.account === 'all' ? data.accounts.length < 2 : !data.accounts.includes(item.dataset.account);
    });
    showErrors(data.errors);
    renderList();
  } catch (err) {
    banner.hidden = false;
    banner.textContent = `Couldn’t reach the Flux server. Is it running? (${err.message})`;
    if (state.messages.length === 0) list.replaceChildren();
  }
}

/* ---------- Smart chip: fresh OTP first, otherwise incoming shipments ---------- */

function renderSmart() {
  const smart = state.smart;
  const chip = $('chip');
  const otp = smart?.otp && Date.now() - new Date(smart.otp.date) < OTP_FRESH_MS ? smart.otp : null;
  const active = smart?.shipments ?? [];
  const incoming = active.filter((s) => s.status !== 'delivered');
  $('smart').hidden = !otp && active.length === 0;
  chip.className = `chip${otp ? ' otp' : ''}`;

  if (otp) {
    const sender = otp.from.name || otp.from.address;
    const text = el('span', 'chip-text');
    if (otp.code) text.append(el('span', 'code', otp.code), ` · ${sender}`);
    else text.append(el('strong', null, 'New OTP'), ` · ${sender} · open to view`);
    chip.replaceChildren(icon('i-key'), text);
    if (otp.code) chip.append(el('span', 'copy', 'Copy'));
    chip.setAttribute('aria-expanded', 'false');
    $('shipments').hidden = true;
    return;
  }
  if (active.length === 0) return;
  const lead = incoming[0] ?? active[0];
  const text = el('span', 'chip-text');
  const headline = incoming.length ? `${incoming.length} incoming` : `${active.length} delivered today`;
  text.append(el('strong', null, headline), ` · ${lead.merchant} ${STATUS_LABEL[lead.status].toLowerCase()}`);
  chip.replaceChildren(icon('i-box'), text);
  renderShipments(active);
}

function renderShipments(active) {
  $('shipments').replaceChildren(...active.map((s) => {
    const li = el('li', 'shipment');
    li.append(el('span', 'merchant', s.merchant));
    li.append(el('span', `badge ${s.status}`, STATUS_LABEL[s.status]));
    const details = [s.recipient && `for ${s.recipient}`, s.orderId && `#${s.orderId}`, formatTime(s.date), s.folder !== 'INBOX' && 'found in spam']
      .filter(Boolean).join(' · ');
    li.append(el('span', 'sub', details));
    li.addEventListener('click', () => openMessage(s.account, s.uid, s.folder));
    return li;
  }));
}

$('chip').addEventListener('click', async () => {
  const otp = $('chip').classList.contains('otp') ? state.smart.otp : null;
  if (otp) {
    if (!otp.code) return openMessage(otp.account, otp.uid, otp.folder);
    await navigator.clipboard.writeText(otp.code);
    return toast('Code copied');
  }
  const panel = $('shipments');
  panel.hidden = !panel.hidden;
  $('chip').setAttribute('aria-expanded', String(!panel.hidden));
});

async function loadSmart() {
  try {
    state.smart = await api('/api/smart');
  } catch {
    state.smart = null;
  }
  renderSmart();
}

async function refresh() {
  refreshBtn.classList.add('spinning');
  refreshBtn.disabled = true;
  await Promise.all([loadInbox(), loadSmart(), state.mailbox === 'inbox' ? null : loadFolder(state.mailbox)]);
  refreshBtn.classList.remove('spinning');
  refreshBtn.disabled = false;
}

/* ---------- Reader ---------- */

// Email HTML goes into a sandboxed iframe: no scripts run, links open in a new tab, and a
// CSP blocks remote content (tracking pixels) until "Show images" is clicked.
function emailFrame(html, allowImages) {
  const frame = el('iframe', 'r-frame');
  frame.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  const imgSrc = allowImages ? 'data: cid: https: http:' : 'data: cid:';
  frame.srcdoc = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; font-src data:">
<base target="_blank">
<style>body{margin:0;padding:20px;font-family:-apple-system,Helvetica,Arial,sans-serif;color:#0B0B0B;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>${html}`;
  frame.addEventListener('load', () => {
    const fit = () => { frame.style.height = `${frame.contentDocument.documentElement.scrollHeight + 4}px`; };
    fit();
    setTimeout(fit, 300);
  });
  return frame;
}

const hasRemoteContent = (html) => /<img[^>]+src=["']?https?:|url\(\s*["']?https?:/i.test(html);
const formatSize = (bytes) => (bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const addressList = (people) => people.map((p) => p.name ? `${p.name} <${p.address}>` : p.address).join(', ');

function renderMessage(msg, allowImages = false) {
  const reader = $('reader');
  const from = el('div', 'r-from');
  const who = el('div', 'who');
  who.append(el('div', 'name', msg.from.name || msg.from.address), el('div', 'addr', msg.from.address));
  from.append(avatar(msg.from), who, el('span', 'time', fullTime(msg.date)));

  const via = `via ${ACCOUNT_LABEL[msg.account]}${isFromSpam(msg) ? ' (found in spam)' : ''}`;
  const to = el('div', 'r-to', `To ${addressList(msg.to)}${msg.cc.length ? ` · Cc ${addressList(msg.cc)}` : ''} · ${via}`);
  const parts = [el('h2', 'r-subject', msg.subject), from, to];

  if (msg.html) {
    if (!allowImages && hasRemoteContent(msg.html)) {
      const note = el('div', 'r-images', 'Images are hidden to stop tracking.');
      const show = el('button', null, 'Show images');
      show.addEventListener('click', () => renderMessage(msg, true));
      note.append(show);
      parts.push(note);
    }
    parts.push(emailFrame(msg.html, allowImages));
  } else {
    parts.push(el('div', 'r-text', msg.text || '(empty message)'));
  }
  parts.at(-1).classList.add('r-body-in');

  if (msg.attachments.length) {
    const files = el('ul', 'r-files');
    for (const a of msg.attachments) {
      const li = el('li', null, a.filename);
      li.append(el('span', 'size', formatSize(a.size)));
      files.append(li);
    }
    parts.push(files);
  }
  reader.replaceChildren(...parts);
}

// The header (subject, sender, date) is already in the list, so it shows the instant you
// click; only the body waits for the server, as a quiet placeholder that fades into the email.
function renderReaderShell(summary) {
  const lines = el('div', 'r-loading');
  for (const width of ['92%', '84%', '96%', '60%']) {
    const bar = el('div', 'bar');
    bar.style.width = width;
    lines.append(bar);
  }
  if (!summary) return $('reader').replaceChildren(lines);
  const person = summary.sentItem ? (summary.to[0] ?? summary.from) : summary.from;
  const from = el('div', 'r-from');
  const who = el('div', 'who');
  who.append(el('div', 'name', person.name || person.address), el('div', 'addr', person.address));
  from.append(avatar(person), who, el('span', 'time', fullTime(summary.date)));
  $('reader').replaceChildren(el('h2', 'r-subject', summary.subject), from, el('div', 'r-to', `via ${ACCOUNT_LABEL[summary.account]}`), lines);
}

async function openMessage(account, uid, folder = 'INBOX') {
  const summary = [...state.messages, ...Object.values(state.folders).flat(), ...(state.search?.messages ?? [])]
    .find((m) => m.account === account && m.folder === folder && m.uid === uid);
  $('list-view').hidden = true;
  $('reader-view').hidden = false;
  renderReaderShell(summary);
  renderReaderActions();
  window.scrollTo(0, 0);
  try {
    const msg = await api(`/api/message/${account}/${uid}?folder=${encodeURIComponent(folder)}`);
    // The full message doesn't carry these; take them from the list entry.
    Object.assign(msg, {
      sentItem: Boolean(summary?.sentItem),
      listed: Boolean(summary?.listed),
      flagged: Boolean(summary?.flagged),
      focused: Boolean(summary?.focused),
    });
    state.open = msg;
    renderMessage(msg);
    renderReaderActions();
    for (const pool of [state.messages, ...Object.values(state.folders), state.search?.messages ?? []]) {
      const listed = pool.find((m) => m.account === account && m.folder === folder && m.uid === uid);
      if (listed) listed.seen = true;
    }
  } catch (err) {
    $('reader').replaceChildren(el('div', 'banner', `Couldn’t open this email: ${err.message}`));
  }
}

function closeMessage() {
  state.open = null;
  $('reader-view').hidden = true;
  $('list-view').hidden = false;
  renderList();
}

/* ---------- Compose and reply ---------- */

const form = $('compose-form');

function openCompose(prefill = {}) {
  form.reset();
  form.dataset.inReplyTo = prefill.inReplyTo ?? '';
  form.dataset.references = JSON.stringify(prefill.references ?? []);
  for (const [name, value] of Object.entries(prefill)) {
    if (form.elements[name]) form.elements[name].value = value;
  }
  $('send-status').textContent = '';
  $('compose').hidden = false;
  (prefill.to ? form.elements.text : form.elements.to).focus();
  if (prefill.to) {
    form.elements.text.setSelectionRange(0, 0);
    form.elements.text.scrollTop = 0;
  }
}

function closeCompose() {
  $('compose').hidden = true;
}

function replyTo(msg) {
  const quoted = (msg.text || '').trim().split('\n').map((line) => `> ${line}`).join('\n');
  openCompose({
    account: msg.account,
    to: msg.sentItem ? msg.to.map((t) => t.address).join(', ') : msg.from.address,
    subject: /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`,
    text: `\n\nOn ${fullTime(msg.date)}, ${msg.from.name || msg.from.address} wrote:\n${quoted}`,
    inReplyTo: msg.messageId,
    references: [...msg.references, msg.messageId].filter(Boolean),
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = $('send-status');
  const button = form.querySelector('.send');
  const data = Object.fromEntries(new FormData(form));
  button.disabled = true;
  status.className = 'send-status';
  status.textContent = 'Sending…';
  try {
    await api('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        inReplyTo: form.dataset.inReplyTo || undefined,
        references: JSON.parse(form.dataset.references || '[]'),
      }),
    });
    closeCompose();
    toast(`Sent from ${ACCOUNT_LABEL[data.account]}`);
    delete state.folders.sent;
    if (state.mailbox === 'sent') setTimeout(() => loadFolder('sent'), 2500);
  } catch (err) {
    status.className = 'send-status error';
    status.textContent = `Not sent: ${err.message}`;
  } finally {
    button.disabled = false;
  }
});

/* ---------- Wiring ---------- */

$('pills').addEventListener('click', (event) => {
  const pill = event.target.closest('.pill');
  if (!pill) return;
  state.view = pill.dataset.view;
  document.querySelectorAll('.pill').forEach((p) => p.classList.toggle('active', p === pill));
  renderList();
});

$('account-nav').addEventListener('click', (event) => {
  const item = event.target.closest('.nav-item');
  if (!item) return;
  // Folders and accounts are separate choices: Yahoo + Spam is Yahoo's spam.
  const group = item.dataset.mailbox ? '[data-mailbox]' : '[data-account]';
  document.querySelectorAll(`.nav-item${group}`).forEach((n) => n.classList.toggle('active', n === item));
  if (item.dataset.mailbox) return switchMailbox(item.dataset.mailbox);
  state.account = item.dataset.account;
  if (state.open) closeMessage();
  else renderList();
});

/* ---------- Mailboxes: Inbox (live) and the folders (fetched when opened) ---------- */

function currentPool() {
  return state.mailbox === 'inbox' ? state.messages : state.folders[state.mailbox] ?? [];
}

function switchMailbox(name) {
  state.mailbox = name;
  state.search = null;
  searchInput.value = '';
  state.selected.clear();
  state.cursor = -1;
  document.body.classList.toggle('folder-view', name !== 'inbox');
  for (const box of Object.keys(MAILBOX_TITLE)) document.body.classList.toggle(`mailbox-${box}`, box === name);
  if (state.open) {
    state.open = null;
    $('reader-view').hidden = true;
    $('list-view').hidden = false;
  }
  if (name === 'inbox') return renderList();
  if (state.folders[name]) renderList();
  else {
    renderTitle();
    renderSkeleton();
  }
  loadFolder(name);
}

// Folders aren't kept live: each is fetched when you open it, showing the last copy meanwhile.
async function loadFolder(name) {
  const title = MAILBOX_TITLE[name];
  try {
    const data = await api(`/api/folder/${name}?limit=${FOLDER_LIMIT}`);
    const sentItem = name === 'sent' || name === 'drafts';
    state.folders[name] = data.messages.map((m) => ({ ...m, listed: true, sentItem }));
    if (data.errors.length) toast(`Couldn’t load ${title} for ${data.errors.map((e) => ACCOUNT_LABEL[e.account]).join(', ')}`);
  } catch (err) {
    state.folders[name] ??= [];
    toast(`Couldn’t load ${title}: ${err.message}`);
  }
  if (state.mailbox === name && !state.open) renderList();
}

/* ---------- Search: instant filter while typing, full search on Enter ---------- */

const searchInput = $('search');

searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return clearSearch();
  const matches = currentPool().filter((m) => `${m.from.name} ${m.from.address} ${m.subject}`.toLowerCase().includes(q));
  state.search = { query: searchInput.value.trim(), messages: matches };
  state.cursor = -1;
  if (state.open) closeMessage();
  else renderList();
});

$('search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const q = searchInput.value.trim();
  if (q.length < 2 || state.mailbox !== 'inbox') return; // folders filter as you type
  $('results-label').textContent = `Searching all mail for “${q}”…`;
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
    if (searchInput.value.trim() !== q) return; // typed on meanwhile
    state.search = { query: q, messages: data.messages };
    renderList();
  } catch (err) {
    toast(`Search failed: ${err.message}`);
  }
});

function clearSearch() {
  searchInput.value = '';
  state.search = null;
  state.cursor = -1;
  renderList();
}
$('clear-search').addEventListener('click', clearSearch);

/* ---------- Mark unread ---------- */

async function markUnread() {
  const msg = state.open;
  if (!msg) return;
  closeMessage();
  await runBulk('unread', [msg]);
}
$('mark-unread').addEventListener('click', markUnread);

/* ---------- Reader actions, toolbar and bulk bar ---------- */

function renderReaderActions() {
  const msg = state.open;
  const starred = Boolean(msg?.flagged);
  $('r-star').textContent = starred ? '★ Starred' : '☆ Star';
  $('r-star').classList.toggle('on', starred);
  const restore = msg && (RESTORE_LABEL[state.mailbox] ?? (isFromSpam(msg) ? 'Not spam' : ''));
  $('r-restore').hidden = !restore;
  $('r-restore').textContent = restore || '';
  $('r-focus').hidden = msg?.folder !== 'INBOX';
  if (msg) $('r-focus').textContent = focusLabel([msg]);
}

$('r-star').addEventListener('click', () => state.open && runBulk(state.open.flagged ? 'unstar' : 'star', [state.open]));
$('r-archive').addEventListener('click', () => state.open && runBulk('archive', [state.open]));
$('r-trash').addEventListener('click', () => state.open && runBulk('trash', [state.open]));
$('r-restore').addEventListener('click', () => state.open && runBulk('inbox', [state.open]));
$('r-focus').addEventListener('click', () => state.open && moveSenders([state.open]));
$('bulk-focus').addEventListener('click', () => moveSenders(selectedMessages()));

$('select-all').addEventListener('click', () => selectAll(true));
$('bulk-all').addEventListener('click', () => selectAll($('bulk-all').getAttribute('aria-checked') !== 'true'));
$('bulk-clear').addEventListener('click', () => selectAll(false));
document.querySelector('.bulk-actions').addEventListener('click', (event) => {
  const button = event.target.closest('[data-bulk]');
  if (button) runBulk(button.dataset.bulk, selectedMessages());
});

$('mark-all-read').addEventListener('click', () => {
  const unread = visibleMessages().filter((m) => !m.seen);
  runBulk('read', unread);
});

$('filters').addEventListener('click', (event) => {
  const button = event.target.closest('.filter');
  if (!button) return;
  const name = button.dataset.filter;
  state.filters[name] = !state.filters[name];
  button.setAttribute('aria-pressed', String(state.filters[name]));
  state.selected.clear();
  renderList();
});

// What a keyboard action applies to: the selection, else the open email, else the cursor row.
function actionTargets() {
  if (state.selected.size) return selectedMessages();
  if (state.open) return [state.open];
  const row = list.querySelectorAll('.row')[state.cursor];
  return row ? visibleMessages().filter((m) => keyOf(m) === row.dataset.key) : [];
}

/* ---------- Keyboard ---------- */

function moveCursor(step) {
  const rows = list.querySelectorAll('.row:not(.skeleton)');
  if (!rows.length) return;
  rows[state.cursor]?.classList.remove('cursor');
  state.cursor = Math.max(0, Math.min(rows.length - 1, state.cursor + step));
  rows[state.cursor].classList.add('cursor');
  rows[state.cursor].scrollIntoView({ block: 'nearest' });
  prefetch(visibleMessages().find((m) => keyOf(m) === rows[state.cursor].dataset.key));
}

document.addEventListener('keydown', (event) => {
  const typing = event.target instanceof Element && event.target.closest('input, textarea, select');
  if (event.key === 'Escape') {
    if (!$('compose').hidden) return closeCompose();
    if (state.open) return closeMessage();
    if (state.selected.size) return selectAll(false);
    if (state.search) return clearSearch();
    return searchInput.blur();
  }
  if (typing || event.metaKey || event.ctrlKey || event.altKey || !$('compose').hidden) return;
  const reading = Boolean(state.open);
  const actions = {
    '/': () => searchInput.focus(),
    c: () => openCompose(),
    j: () => !reading && moveCursor(1),
    k: () => !reading && moveCursor(-1),
    Enter: () => !reading && state.cursor >= 0 && list.querySelectorAll('.row')[state.cursor]?.click(),
    o: () => !reading && state.cursor >= 0 && list.querySelectorAll('.row')[state.cursor]?.click(),
    r: () => reading && replyTo(state.open),
    u: () => reading && closeMessage(),
    U: () => (reading ? markUnread() : runBulk('unread', actionTargets())),
    I: () => runBulk('read', actionTargets()),
    x: () => {
      const key = !reading && list.querySelectorAll('.row')[state.cursor]?.dataset.key;
      const target = key && visibleMessages().find((m) => keyOf(m) === key);
      if (target) toggleSelect(target, false);
    },
    A: () => !reading && selectAll(true),
    e: () => state.mailbox === 'inbox' && runBulk('archive', actionTargets()),
    '#': () => state.mailbox !== 'trash' && runBulk('trash', actionTargets()),
    s: () => {
      const targets = actionTargets();
      runBulk(targets.every((m) => m.flagged) ? 'unstar' : 'star', targets);
    },
  };
  if (actions[event.key]) {
    event.preventDefault();
    actions[event.key]();
  }
});

/* ---------- Live updates: new mail arrives over server-sent events ---------- */

function startLiveUpdates() {
  const source = new EventSource('/api/events');
  source.onmessage = (event) => {
    const { message } = JSON.parse(event.data);
    if (state.messages.some((m) => keyOf(m) === keyOf(message))) return;
    state.messages = [message, ...state.messages].sort((a, b) => new Date(b.date) - new Date(a.date));
    if (!state.search && state.mailbox === 'inbox') renderList();
    if (message.category === 'shipping' || message.category === 'otp') loadSmart();
  };
}

/* ---------- Notifications: web push, so they arrive even with Flux closed ---------- */

const bell = $('bell');

function base64ToBytes(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function pushReady() {
  const registration = await navigator.serviceWorker.getRegistration();
  return Boolean(registration && Notification.permission === 'granted' && await registration.pushManager.getSubscription());
}

function showBell(on) {
  bell.classList.toggle('on', on);
  bell.title = on ? 'Notifications are on' : 'Turn on notifications';
  bell.setAttribute('aria-label', bell.title);
}

async function enableNotifications() {
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return toast('Notifications are blocked in this browser');
    const registration = await navigator.serviceWorker.ready;
    const { publicKey } = await api('/api/push/key');
    const subscription = (await registration.pushManager.getSubscription())
      ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(publicKey) });
    await api('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription }),
    });
    showBell(true);
    toast('Notifications on: OTPs, shipping and important mail');
  } catch (err) {
    toast(`Couldn’t turn on notifications: ${err.message}`);
  }
}

bell.addEventListener('click', () => (bell.classList.contains('on') ? toast('Notifications are on') : enableNotifications()));

async function setupPush() {
  // Inside the Flux Mac app, notifications are native; the browser-push bell isn't needed.
  if (window.FLUX_NATIVE || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    bell.hidden = true;
    return;
  }
  await navigator.serviceWorker.register('/sw.js');
  showBell(await pushReady());
}

// A notification click opens /#open=<account>/<folder>/<uid>.
function openFromHash() {
  const match = location.hash.match(/^#open=(\w+)\/([^/]+)\/(\d+)$/);
  if (!match) return;
  history.replaceState(null, '', '/');
  openMessage(match[1], Number(match[3]), decodeURIComponent(match[2]));
}
window.addEventListener('hashchange', openFromHash);

/* ---------- Start ---------- */

$('back').addEventListener('click', closeMessage);
$('reply').addEventListener('click', () => state.open && replyTo(state.open));
$('compose-btn').addEventListener('click', () => openCompose());
$('compose-close').addEventListener('click', closeCompose);
$('compose').addEventListener('click', (event) => { if (event.target.id === 'compose') closeCompose(); });
refreshBtn.addEventListener('click', refresh);

// New mail arrives live; this slower refresh catches read/unread changes made elsewhere.
setInterval(() => { if (!document.hidden && !refreshBtn.disabled) refresh(); }, REFRESH_MS);
// Re-check OTP freshness so an expired code leaves the chip.
setInterval(renderSmart, 30_000);
refresh();
startLiveUpdates();
// Warm Sent in the background so opening it is instant.
setTimeout(() => { if (!state.folders.sent) loadFolder('sent'); }, 4000);
setupPush().catch(() => { bell.hidden = true; });
openFromHash();
