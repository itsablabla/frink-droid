// Prints a new Frink web API key on stdout and its SHA-256 on stderr.
// Put the hash in FRINK_WEB_API_KEY_HASHES (comma separated for several keys); keep the key secret.
import { createHash, randomBytes } from 'node:crypto';

const key = `frk_${randomBytes(32).toString('base64url')}`;
process.stdout.write(`${key}\n`);
process.stderr.write(`${createHash('sha256').update(key).digest('hex')}\n`);
