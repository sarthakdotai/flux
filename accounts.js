import { execFileSync } from 'node:child_process';

// Every provider Flux knows. Only the ones with credentials set up are used (see ACCOUNTS).
const PROVIDERS = [
  {
    id: 'gmail', service: 'flux-gmail',
    imap: { host: 'imap.gmail.com', port: 993 },
    smtp: { host: 'smtp.gmail.com', port: 465 },
  },
  {
    id: 'yahoo', service: 'flux-yahoo',
    // Yahoo's spam folder: scanned for shipping and OTP mail only.
    spamFolder: 'Bulk',
    imap: { host: 'imap.mail.yahoo.com', port: 993 },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465 },
  },
];

// Set up = an env pair (FLUX_GMAIL_USER/PASS) or a Keychain item (flux-gmail). Checking the
// Keychain item without -w doesn't read the password, so it never triggers a prompt.
function isSetUp(service) {
  const prefix = service.toUpperCase().replace(/-/g, '_');
  if (process.env[`${prefix}_USER`] && process.env[`${prefix}_PASS`]) return true;
  try {
    execFileSync('security', ['find-generic-password', '-s', service], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// The accounts this install uses: just Gmail, just Yahoo, or both.
export const ACCOUNTS = PROVIDERS.filter((a) => isSetUp(a.service));
if (ACCOUNTS.length === 0) {
  console.error('No mail accounts set up. Add a Keychain item (flux-gmail / flux-yahoo) or FLUX_*_USER/PASS; see README.');
}

export function account(id) {
  const found = ACCOUNTS.find((a) => a.id === id);
  if (!found) throw new Error(`Unknown account ${id}`);
  return found;
}

// Address and app password come from environment variables when set (the Oracle server:
// FLUX_GMAIL_USER / FLUX_GMAIL_PASS, from a root-only env file), otherwise from the macOS
// login keychain. Never from files in the project.
export function credentials(service) {
  const prefix = service.toUpperCase().replace(/-/g, '_');
  const envUser = process.env[`${prefix}_USER`];
  const envPass = process.env[`${prefix}_PASS`];
  if (envUser && envPass) return { user: envUser, pass: envPass };

  const meta = execFileSync('security', ['find-generic-password', '-s', service], { encoding: 'utf8' });
  const user = meta.match(/"acct"<blob>="([^"]+)"/)?.[1];
  const pass = execFileSync('security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8' }).trim();
  if (!user || !pass) throw new Error(`Keychain item ${service} is missing an account or password`);
  return { user, pass };
}
