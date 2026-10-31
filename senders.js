// Senders you moved by hand: "Move to Focused" / "Move to Other" sticks to the sender, so
// their future mail lands in the same place. Kept in data/, beside the push keys.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.FLUX_DATA_DIR || path.join(import.meta.dirname, 'data');
const FILE = path.join(DATA_DIR, 'senders.json');

mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const choices = new Map(Object.entries(existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {}));

export const senderChoice = (address) => choices.get(address);

// senders: [{address, focus}], focus 'focused', 'other' or null (forget). Returns the
// previous choices, in the same shape, so an undo can put them back.
export function rememberSenders(senders) {
  const previous = senders.map(({ address }) => ({ address, focus: choices.get(address) ?? null }));
  for (const { address, focus } of senders) {
    if (focus) choices.set(address, focus);
    else choices.delete(address);
  }
  writeFileSync(FILE, JSON.stringify(Object.fromEntries(choices), null, 2), { mode: 0o600 });
  return previous;
}
