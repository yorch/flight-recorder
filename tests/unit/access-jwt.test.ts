import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { type Jwks, verifyAccessJwt } from '../../scripts/access-jwt.ts';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; n: string; e: string };
const KID = 'test-key-1';
const jwks: Jwks = { keys: [{ ...jwk, kid: KID, alg: 'RS256' }] };
const TEAM = 'example.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const NOW = 1_700_000_000_000;

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function mint(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, key: crypto.KeyObject = privateKey): string {
  const h = b64url(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT', ...header }));
  const p = b64url(
    JSON.stringify({
      iss: `https://${TEAM}`,
      aud: [AUD],
      exp: Math.floor(NOW / 1000) + 600,
      iat: Math.floor(NOW / 1000),
      email: 'someone@example.test',
      ...claims,
    }),
  );
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key);
  return `${h}.${p}.${b64url(sig)}`;
}

const opts = { teamDomain: TEAM, aud: AUD, now: NOW };

describe('verifyAccessJwt', () => {
  it('accepts a properly signed assertion', () => {
    const claims = verifyAccessJwt(mint(), jwks, opts);
    assert.ok(claims);
    assert.equal(claims.email, 'someone@example.test');
  });

  it('accepts a string aud that matches', () => {
    assert.ok(verifyAccessJwt(mint({ aud: AUD }), jwks, opts));
  });

  it('rejects a tampered payload', () => {
    const [h, , s] = mint().split('.');
    const forged = b64url(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], exp: 9_999_999_999, email: 'admin@example.test' }));
    assert.equal(verifyAccessJwt(`${h}.${forged}.${s}`, jwks, opts), null);
  });

  it('rejects a token signed by another key', () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    assert.equal(verifyAccessJwt(mint({}, {}, other), jwks, opts), null);
  });

  it('rejects the wrong audience', () => {
    assert.equal(verifyAccessJwt(mint({ aud: ['b'.repeat(64)] }), jwks, opts), null);
  });

  it('rejects the wrong issuer', () => {
    assert.equal(verifyAccessJwt(mint({ iss: 'https://evil.cloudflareaccess.com' }), jwks, opts), null);
  });

  it('rejects an expired token', () => {
    assert.equal(verifyAccessJwt(mint({ exp: Math.floor(NOW / 1000) - 3600 }), jwks, opts), null);
  });

  it('rejects an unknown kid', () => {
    assert.equal(verifyAccessJwt(mint({}, { kid: 'other' }), jwks, opts), null);
  });

  it('rejects alg none and unsigned tokens', () => {
    const [h, p] = mint().split('.');
    assert.equal(verifyAccessJwt(`${h}.${p}.`, jwks, opts), null);
    const noneHeader = b64url(JSON.stringify({ alg: 'none', kid: KID }));
    assert.equal(verifyAccessJwt(`${noneHeader}.${p}.`, jwks, opts), null);
  });

  it('rejects garbage and truncated input', () => {
    for (const bad of ['', 'a.b', 'a.b.c', 'not-a-jwt', '....']) assert.equal(verifyAccessJwt(bad, jwks, opts), null);
  });

  it('rejects a key whose x5c entry is not a certificate', () => {
    assert.equal(verifyAccessJwt(mint(), { keys: [{ kty: 'RSA', kid: KID, x5c: ['bm90LWEtY2VydA=='] }] }, opts), null);
  });

  it('accepts a key with no x5c, using n/e', () => {
    assert.ok(verifyAccessJwt(mint(), { keys: [{ ...jwk, kid: KID }] }, opts));
  });

  it('ignores a key of the wrong type', () => {
    assert.equal(verifyAccessJwt(mint(), { keys: [{ kty: 'EC', kid: KID }] }, opts), null);
  });
});
