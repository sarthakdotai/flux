// Decides which new mail is worth a notification and what it says.
import { account } from './accounts.js';
import { fetchMessage } from './imap.js';
import { extractOtp, messageText, shipmentStatus } from './smart.js';

const ACCOUNT_LABEL = { gmail: 'Gmail', yahoo: 'Yahoo' };
const STATUS_TEXT = {
  ordered: 'order confirmed', shipped: 'shipped', out: 'out for delivery',
  delivered: 'delivered', issue: 'delivery problem', update: 'shipping update',
};

// Only OTPs, shipping updates and important senders notify. A newsletter never does.
export async function notification(msg) {
  const sender = msg.from.name || msg.from.address;
  const where = `${ACCOUNT_LABEL[msg.account]}${msg.folder === 'INBOX' ? '' : ' spam'}`;
  if (msg.category === 'otp') {
    let code = extractOtp(msg.subject);
    if (!code) {
      const full = await fetchMessage(account(msg.account), msg.uid, { markSeen: false, folder: msg.folder }).catch(() => null);
      code = full && extractOtp(messageText(full));
    }
    return { kind: 'otp', code, title: code ? `OTP ${code}` : 'New OTP', body: `${sender} · ${where}` };
  }
  if (msg.category === 'shipping') {
    return { kind: 'shipping', title: `📦 ${STATUS_TEXT[shipmentStatus(msg.subject)]}`, body: `${msg.subject} · ${where}` };
  }
  if (msg.category === 'important') {
    return { kind: 'important', title: sender, body: `${msg.subject} · ${where}` };
  }
  return null;
}
