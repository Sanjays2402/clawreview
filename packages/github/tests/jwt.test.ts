import { generateKeyPairSync, createVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { buildAppJwt } from '../src/jwt.js';

describe('buildAppJwt', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

  it('produces a verifiable RS256 JWT', () => {
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const pub = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const token = buildAppJwt({ appId: 12345, privateKey: pem });
    const [h, p, s] = token.split('.');
    expect(h && p && s).toBeTruthy();
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${h}.${p}`);
    verifier.end();
    const sig = Buffer.from(s!.replace(/-/g, '+').replace(/_/g, '/') + '==', 'base64');
    expect(verifier.verify(pub, sig)).toBe(true);
  });
});
