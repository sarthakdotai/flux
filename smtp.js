import nodemailer from 'nodemailer';
import { credentials } from './accounts.js';

function transport(account) {
  const { user, pass } = credentials(account.service);
  return { user, transporter: nodemailer.createTransport({ ...account.smtp, secure: true, auth: { user, pass } }) };
}

// Logs in to SMTP without sending anything.
export async function verify(account) {
  const { transporter } = transport(account);
  try {
    await transporter.verify();
  } finally {
    transporter.close();
  }
}

// Sends a plain-text email from `account`. Reply threading via inReplyTo/references.
export async function sendMail(account, { to, cc, subject, text, inReplyTo, references }) {
  const { user, transporter } = transport(account);
  try {
    const info = await transporter.sendMail({ from: user, to, cc, subject, text, inReplyTo, references });
    return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
  } finally {
    transporter.close();
  }
}
