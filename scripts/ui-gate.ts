#!/usr/bin/env node
/**
 * Public gate for the control plane.
 *
 * SPEC §16.2 keeps the API on localhost and the UI has no user auth of its own, so
 * anything tunnelled to :7070 must be gated first. This process enforces HTTP basic
 * auth (credentials in ./secrets, never logged) and streams every request to the UI,
 * preserving Host and Origin so the §16.2 guards still see the tunnel hostname.
 *
 * The password lives in ./secrets/UI_TOKEN: the API server already ignores that name
 * when it lists run credentials, so the gate password can never be selected as a
 * secret for a run to type into a page.
 *
 * Cloudflare Access sits in front of the same origin. When it does, it adds a signed
 * `Cf-Access-Jwt-Assertion` to every forwarded request; a request carrying a valid one
 * skips basic auth (no second prompt), and everything else still has to present it. The
 * signature check keeps the shortcut from being a header a client can forge.
 *
 * Env: GATE_ACCESS_TEAM_DOMAIN (e.g. example.cloudflareaccess.com), GATE_ACCESS_AUD (the
 * application's AUD tag), GATE_ACCESS_JWKS_URL (override for tests).
 *
 * Exit codes: 0 stopped by signal, 2 misconfiguration.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Jwks, verifyAccessJwt } from './access-jwt.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function splitHostPort(value: string, fallbackPort: number): { host: string; port: number } {
  const at = value.lastIndexOf(':');
  if (at < 0) return { host: value, port: fallbackPort };
  return { host: value.slice(0, at), port: Number(value.slice(at + 1)) || fallbackPort };
}

const listen = splitHostPort(process.env.GATE_BIND ?? '127.0.0.1:7072', 7072);
const upstreamAddr = splitHostPort(process.env.GATE_UPSTREAM ?? '127.0.0.1:7070', 7070);
const secretsDir = process.env.SECRETS_DIR ?? path.join(ROOT, 'secrets');

const readSecret = (file: string): string => {
  try {
    return fs.readFileSync(path.join(secretsDir, file), 'utf8').trim();
  } catch {
    return '';
  }
};

/** Generates the tunnel password on first start: 24 random bytes, mode 0600. */
function password(): string {
  const existing = readSecret('UI_TOKEN');
  if (existing) return existing;
  const file = path.join(secretsDir, 'UI_TOKEN');
  const generated = crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(secretsDir, { recursive: true });
  fs.writeFileSync(file, `${generated}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`gate: generated ${file} (mode 0600) — share it out of band, never through the tunnel`);
  return generated;
}

const user = process.env.GATE_USER || 'admin';
const pass = process.env.GATE_PASSWORD || password();

const digest = (s: string): Buffer => crypto.createHash('sha256').update(s).digest();
const wantUser = digest(user);
const wantPass = digest(pass);

function authorized(header: string | undefined): boolean {
  if (!header?.toLowerCase().startsWith('basic ')) return false;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const at = decoded.indexOf(':');
  if (at < 0) return false;
  return crypto.timingSafeEqual(digest(decoded.slice(0, at)), wantUser) && crypto.timingSafeEqual(digest(decoded.slice(at + 1)), wantPass);
}

const accessTeam = (process.env.GATE_ACCESS_TEAM_DOMAIN ?? '').trim();
const accessAud = (process.env.GATE_ACCESS_AUD ?? '').trim();
const accessJwksUrl = process.env.GATE_ACCESS_JWKS_URL || (accessTeam ? `https://${accessTeam}/cdn-cgi/access/certs` : '');
const JWKS_TTL_MS = 60 * 60 * 1000;
let jwksCache: { at: number; jwks: Jwks } | null = null;
let jwksInFlight: Promise<Jwks | null> | null = null;

async function jwks(): Promise<Jwks | null> {
  if (jwksCache && Date.now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.jwks;
  if (jwksInFlight) return jwksInFlight;
  jwksInFlight = (async () => {
    try {
      const res = await fetch(accessJwksUrl, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`JWKS ${res.status}`);
      const body = (await res.json()) as Jwks;
      if (!Array.isArray(body?.keys)) throw new Error('JWKS has no keys');
      jwksCache = { at: Date.now(), jwks: body };
      return body;
    } catch (err) {
      console.log(`gate: could not load Access JWKS from ${accessJwksUrl}: ${err instanceof Error ? err.message : String(err)}`);
      return jwksCache?.jwks ?? null; // stale keys still beat locking the operator out
    } finally {
      jwksInFlight = null;
    }
  })();
  return jwksInFlight;
}

/** True when Cloudflare Access vouched for this request (valid, signed assertion). */
async function viaAccess(header: string | string[] | undefined): Promise<boolean> {
  if (!accessTeam || !accessAud || typeof header !== 'string' || header === '') return false;
  const keys = await jwks();
  if (!keys) return false;
  return verifyAccessJwt(header, keys, { teamDomain: accessTeam, aud: accessAud }) !== null;
}

const server = http.createServer((req, res) => {
  const deny = (): void => {
    res.writeHead(401, {
      'www-authenticate': 'Basic realm="flight recorder", charset="UTF-8"',
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end('authentication required\n');
  };

  const forward = (): void => {
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    headers['x-forwarded-proto'] = 'https';
    headers['x-forwarded-host'] = req.headers.host ?? '';
    headers['x-forwarded-for'] = req.socket.remoteAddress ?? '';

    const proxy = http.request({ host: upstreamAddr.host, port: upstreamAddr.port, method: req.method, path: req.url, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    proxy.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`upstream error: ${err.message}\n`);
      } else {
        res.destroy();
      }
    });
    req.on('aborted', () => proxy.destroy());
    res.on('close', () => proxy.destroy());
    req.pipe(proxy);
  };

  viaAccess(req.headers['cf-access-jwt-assertion'])
    .then((ok) => {
      if (ok || authorized(req.headers.authorization)) forward();
      else deny();
    })
    .catch(() => deny());
});

server.listen(listen.port, listen.host, () => {
  const access = accessTeam && accessAud ? `, access=${accessTeam} aud=${accessAud.slice(0, 8)}…` : '';
  console.log(
    `GATE_LISTENING http://${listen.host}:${listen.port} -> http://${upstreamAddr.host}:${upstreamAddr.port} (user=${user}${access})`,
  );
});

const stop = (signal: string): void => {
  console.log(`gate: ${signal} received — closing`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
