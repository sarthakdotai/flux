// Deterministic sorting of mail into Shipping / OTP / Important, shipment tracking and
// OTP extraction. Every decision is a rule from rules.json, never a guess.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { senderChoice } from './senders.js';

// Your own rules: FLUX_RULES (the Mac app points it at Application Support), else
// rules.json beside the code (git-ignored), else the generic example.
const RULES_FILE = [process.env.FLUX_RULES, ...['rules.json', 'rules.example.json'].map((f) => path.join(import.meta.dirname, f))]
  .filter(Boolean).find(existsSync);
const rules = JSON.parse(readFileSync(RULES_FILE, 'utf8'));
const shippingSubject = new RegExp(rules.shipping.subjectPattern, 'i');
const otpSubject = new RegExp(rules.otp.subjectPattern, 'i');

const domainOf = (address) => address.split('@')[1] ?? '';
const inDomains = (address, domains) => domains.some((d) => domainOf(address) === d || domainOf(address).endsWith(`.${d}`));

export function isOtp(msg) {
  return otpSubject.test(msg.subject);
}

// Shipping-sounding subject, or a courier sender whose subject carries a real status
// (so a Delhivery newsletter like "This is a heavy email" doesn't count).
export function isShipping(msg) {
  return shippingSubject.test(msg.subject)
    || (inDomains(msg.from.address, rules.shipping.senderDomains) && shipmentStatus(msg.subject) !== 'update');
}

// Named senders, whole domains (subdomains included), or a person on a free-mail
// domain (exact match, so no-reply@cc.yahoo.com isn't a person).
function isImportant(address) {
  return rules.important.senders.includes(address)
    || inDomains(address, rules.important.domains)
    || rules.important.personalDomains.includes(domainOf(address));
}

// category: 'otp' | 'shipping' | 'important' | null. Focused = has a category, or comes
// from an account that is always focused (Gmail). Yahoo noise lands in Other.
// Newsletter = mailing-list mail (msg.list: it has a List-Unsubscribe or List-ID header), or
// a sender in rules.newsletters for the few that have neither. Only mail with no category
// counts, so OTPs, shipping and important senders never get filed away.
// A sender you moved by hand beats all of this, except that OTPs and shipping stay tagged.
export function classify(msg) {
  const choice = senderChoice(msg.from.address);
  const ignored = rules.ignore.senders.includes(msg.from.address) || inDomains(msg.from.address, rules.ignore.domains);
  let category = null;
  if (!ignored) {
    if (isOtp(msg)) category = 'otp';
    else if (isShipping(msg)) category = 'shipping';
    else if (choice === 'focused' || (choice !== 'other' && isImportant(msg.from.address))) category = 'important';
  }
  const listed = msg.list || inDomains(msg.from.address, rules.newsletters?.domains ?? []);
  const newsletter = Boolean(listed) && category === null && !choice;
  const focused = choice ? choice === 'focused' : !newsletter && (category !== null || rules.focusedAccounts.includes(msg.account));
  return { ...msg, category, newsletter, focused };
}

// IMAP search criteria (any-of) for the server-side searches.
export const shippingCriteria = [
  ...rules.shipping.searchFrom.map((from) => ({ from })),
  ...rules.shipping.searchSubject.map((subject) => ({ subject })),
];
export const shippingSince = () => new Date(Date.now() - rules.shipping.lookbackDays * 86400000);

// Order matters: "out for delivery" before "delivered", problems before everything.
const STATUSES = [
  ['issue', /not picked|undelivered|delivery failed|failed delivery|returned|\brto\b/i],
  ['out', /out for delivery/i],
  ['delivered', /delivered/i],
  ['shipped', /shipped|dispatched|in transit|on (its|the) way|arriving|picked up|been picked/i],
  ['ordered', /\border\b.*\b(placed|confirmed)\b|received your order/i],
];

export function shipmentStatus(subject) {
  return STATUSES.find(([, pattern]) => pattern.test(subject))?.[0] ?? 'update';
}

function shipmentFields(msg) {
  const subject = msg.subject;
  const orderId = subject.match(/order\s*(?:no\.?|number)?\s*#?\s*([A-Z0-9][A-Z0-9-]{3,})/i)?.[1]
    ?? subject.match(/\b(?:WBN|AWB)\s*#?\s*([0-9]{6,})/i)?.[1] ?? '';
  // Shiprocket: "Jane Doe, your ACME order has been shipped."
  const shiprocket = subject.match(/^(.+?),\s*your\s+(.+?)\s+order\b/i);
  // Couriers like Velocity: "Your Order from Acme Store is being shipped via Velocity"
  const courier = subject.match(/\border from\s+(.+?)\s+(?:is|has|was)\b/i);
  const merchant = shiprocket?.[2] ?? courier?.[1] ?? (msg.from.name || domainOf(msg.from.address));
  const recipient = shiprocket?.[1] ?? '';
  return { orderId, merchant, recipient };
}

// Groups shipping mail into shipments; each shipment's status is its newest email's.
// Keeps undelivered shipments updated within activeDays (many carriers never send a
// "delivered" email), plus deliveries from the last keepDeliveredHours.
export function shipments(messages) {
  const groups = new Map();
  const sorted = messages.filter((m) => isShipping(m) && !inDomains(m.from.address, rules.ignore.domains))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  for (const msg of sorted) {
    const { orderId, merchant, recipient } = shipmentFields(msg);
    const key = `${merchant.toLowerCase()}|${orderId}`;
    groups.set(key, {
      merchant, orderId, recipient,
      status: shipmentStatus(msg.subject),
      date: msg.date, account: msg.account, folder: msg.folder, uid: msg.uid, subject: msg.subject,
    });
  }
  const deliveredAfter = Date.now() - rules.shipping.keepDeliveredHours * 3600000;
  const activeAfter = Date.now() - rules.shipping.activeDays * 86400000;
  return [...groups.values()]
    .filter((s) => new Date(s.date) >= (s.status === 'delivered' ? deliveredAfter : activeAfter))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

export function freshOtps(messages) {
  const after = Date.now() - rules.otp.freshMinutes * 60000;
  return messages.filter((m) => isOtp(m) && new Date(m.date) >= after)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

// Plain text of a parsed message: its text part, or its HTML with styles and tags
// stripped when there is none. Invisible padding characters (used by Uber etc.) removed.
export function messageText({ text, html }) {
  const raw = text || (html || '')
    .replace(/<(style|script|head)[^]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#\d+;/g, ' ');
  return raw.replace(/[­͏​-‍⁠﻿]/g, '').replace(/[ \t]+/g, ' ');
}

const OTP_PATTERNS = [
  // "OTP is 123456", "verification code:\n1234", "code to finish logging in. 98765"
  /(?:otp|code|password|passcode|pin)\b[^\d]{0,40}?\b(\d{4,8})\b/i,
  // "123456 is your OTP"
  /\b(\d{4,8})\b[^\n]{0,40}?\bis\s+(?:your|the)\b[^\n]{0,30}?(?:otp|code|password|passcode)/i,
  // "Booking.com - XTWYU5 is your verification code" (uppercase letters/digits only)
  /\b([A-Z0-9]{5,8})\b\s+is\s+your\b[^\n]{0,30}?(?:code|otp|password)/,
  // Notion: a mixed-case code alone on the first line, followed by "Never share this code"
  /^\s*([A-Za-z0-9]{6,8})\s*\n[^]{0,40}?\bcode\b/,
];

export function extractOtp(text) {
  for (const pattern of OTP_PATTERNS) {
    const code = text.match(pattern)?.[1];
    if (code) return code;
  }
  return null;
}
