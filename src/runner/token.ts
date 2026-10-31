import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** §16.1: constant-time bearer-token comparison (sha-256 pre-hash makes lengths equal). */
export function tokenMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  const h = (s: string) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(h(provided), h(expected));
}

/**
 * Reads <secretsDir>/RUNNER_TOKEN. When the file is absent or empty, generates 32 hex
 * bytes and writes it mode 0600. `generated` tells the caller to inform the operator;
 * the token itself must never be logged.
 */
export function loadOrCreateToken(secretsDir: string): { token: string; generated: boolean } {
  const file = path.join(secretsDir, 'RUNNER_TOKEN');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return { token: existing, generated: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(secretsDir, { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return { token, generated: true };
}
