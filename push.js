// Web push: system notifications that arrive even when no Flux tab is open. The browser
// subscribes once; the server keeps the subscription and its own VAPID keys in data/.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

// FLUX_DATA_DIR lets the Mac app keep this outside its (read-only) bundle.
const DATA_DIR = process.env.FLUX_DATA_DIR || path.join(import.meta.dirname, 'data');
const KEYS_FILE = path.join(DATA_DIR, 'vapid.json');
const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json');

mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });

let keys = readJson(KEYS_FILE, null);
if (!keys) {
  keys = webpush.generateVAPIDKeys();
  writeJson(KEYS_FILE, keys);
}
webpush.setVapidDetails('mailto:flux@localhost', keys.publicKey, keys.privateKey);

let subscriptions = readJson(SUBS_FILE, []);

export const publicKey = keys.publicKey;

export function subscribe(subscription) {
  if (!subscription?.endpoint?.startsWith('https://')) throw new Error('Invalid push subscription');
  subscriptions = [...subscriptions.filter((s) => s.endpoint !== subscription.endpoint), subscription];
  writeJson(SUBS_FILE, subscriptions);
}

// Sends to every subscribed browser; drops subscriptions the push service says are gone.
export async function pushAll(note) {
  const payload = JSON.stringify(note);
  const gone = [];
  await Promise.all(subscriptions.map((s) => webpush.sendNotification(s, payload, { TTL: 600 }).catch((err) => {
    if (err.statusCode === 404 || err.statusCode === 410) gone.push(s.endpoint);
    else console.error(`push failed: ${err.statusCode ?? err.message}`);
  })));
  if (gone.length) {
    subscriptions = subscriptions.filter((s) => !gone.includes(s.endpoint));
    writeJson(SUBS_FILE, subscriptions);
  }
}
