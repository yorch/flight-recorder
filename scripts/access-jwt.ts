/**
 * Cloudflare Access JWT verification for the tunnel gate.
 *
 * Access puts a signed `Cf-Access-Jwt-Assertion` on every request it forwards. Checking
 * only for the header's presence would be spoofable from anywhere the origin is reachable,
 * so the gate verifies the RS256 signature against the team's JWKS and checks `iss`/`aud`/
 * `exp` before trusting it. Everything here is pure: the caller fetches and caches the JWKS.
 */
import crypto from 'node:crypto';

export interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  n?: string;
  e?: string;
  x5c?: string[];
}

export interface Jwks {
  keys: Jwk[];
}

export interface AccessClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  email?: string;
}

export interface VerifyOptions {
  /** Access team domain, e.g. `example.cloudflareaccess.com` (no scheme). */
  teamDomain: string;
  /** The application's AUD tag. */
  aud: string;
  now?: number; // ms since epoch; injectable for tests
  leewayS?: number;
}

const b64url = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function publicKeyOf(key: Jwk): crypto.KeyObject | null {
  try {
    if (key.x5c?.[0]) return new crypto.X509Certificate(Buffer.from(key.x5c[0], 'base64')).publicKey;
    if (key.n && key.e) return crypto.createPublicKey({ key: { kty: key.kty, n: key.n, e: key.e }, format: 'jwk' });
  } catch {
    /* malformed key */
  }
  return null;
}

/** Verifies an Access assertion. Returns the claims on success, null on any failure. */
export function verifyAccessJwt(token: string, jwks: Jwks, opts: VerifyOptions): AccessClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [rawHeader, rawPayload, rawSig] = parts;

  let header: { alg?: string; kid?: string };
  let claims: AccessClaims;
  try {
    header = JSON.parse(b64url(rawHeader).toString('utf8')) as { alg?: string; kid?: string };
    claims = JSON.parse(b64url(rawPayload).toString('utf8')) as AccessClaims;
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;

  const key = jwks.keys.find((k) => k.kid === header.kid && k.kty === 'RSA');
  const pub = key ? publicKeyOf(key) : null;
  if (!pub) return null;

  let signed = false;
  try {
    signed = crypto.verify('RSA-SHA256', Buffer.from(`${rawHeader}.${rawPayload}`), pub, b64url(rawSig));
  } catch {
    return null;
  }
  if (!signed) return null;

  const nowS = Math.floor((opts.now ?? Date.now()) / 1000);
  const leeway = opts.leewayS ?? 60;
  if (typeof claims.exp === 'number' && claims.exp + leeway < nowS) return null;
  if (typeof claims.nbf === 'number' && claims.nbf - leeway > nowS) return null;
  if (claims.iss !== `https://${opts.teamDomain}`) return null;
  const audOk = Array.isArray(claims.aud) ? claims.aud.includes(opts.aud) : claims.aud === opts.aud;
  return audOk ? claims : null;
}
