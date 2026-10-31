import type { IncomingMessage } from 'node:http';
import path from 'node:path';

/** §16.2: Host must be the localhost publisher — blocks DNS rebinding. */
export function hostAllowed(host: string | undefined, allowed: string[]): boolean {
  if (!host) return false;
  return allowed.includes(host.trim().toLowerCase());
}

/** Origin's host:port must be one of the localhost publishers. */
export function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return false;
  try {
    return allowed.includes(new URL(origin).host.toLowerCase());
  } catch {
    return false;
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * §16.2 CSRF guard for mutating requests: Origin must be present and match (missing
 * Origin is rejected — see §16.4 criterion 28), and the Content-Type must be JSON or
 * multipart so a cross-site form or a text/plain fetch cannot reach the API.
 */
export function mutationGuard(
  method: string | undefined,
  headers: IncomingMessage['headers'],
  allowed: string[],
): 'ok' | 'bad-origin' | 'bad-content-type' {
  if (!MUTATING.has(method ?? '')) return 'ok';
  if (!originAllowed(headers.origin as string | undefined, allowed)) return 'bad-origin';
  const ct = String(headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (ct !== 'application/json' && ct !== 'multipart/form-data') return 'bad-content-type';
  return 'ok';
}

export const ARTIFACT_CSP = "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.vtt': 'text/vtt',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

export function contentTypeFor(file: string): string {
  const dot = file.lastIndexOf('.');
  return (dot >= 0 && MIME[file.slice(dot).toLowerCase()]) || 'application/octet-stream';
}

/**
 * Resolves `segments` under `root`, rejecting any segment that is empty, a dot
 * segment, or outside [A-Za-z0-9._ -]. Returns null on traversal attempts.
 */
export function resolveUnder(root: string, segments: string[]): string | null {
  const parts: string[] = [];
  for (const raw of segments) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (seg === '' || seg === '.' || seg === '..' || seg.includes('\0') || !/^[A-Za-z0-9._ -]+$/.test(seg)) return null;
    parts.push(seg);
  }
  const base = path.resolve(root);
  const abs = path.resolve(base, ...parts);
  if (abs !== base && !abs.startsWith(`${base}${path.sep}`)) return null;
  return abs;
}
