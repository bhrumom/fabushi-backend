import assert from 'node:assert/strict';
import { createPrivateKey, sign, webcrypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyAppleTransactionJws } from '../src/security/apple-jws-verifier.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

function openssl(cwd, ...args) {
  execFileSync('openssl', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
}

function buildChain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-apple-jws-'));
  openssl(dir, 'ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'root.key');
  openssl(dir, 'req', '-x509', '-new', '-key', 'root.key', '-sha256', '-days', '3650', '-subj', '/CN=Fabushi Test Apple Root', '-out', 'root.pem');
  openssl(dir, 'x509', '-in', 'root.pem', '-outform', 'DER', '-out', 'root.der');

  openssl(dir, 'ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'intermediate.key');
  openssl(dir, 'req', '-new', '-key', 'intermediate.key', '-subj', '/CN=Fabushi Test Apple Intermediate', '-out', 'intermediate.csr');
  fs.writeFileSync(path.join(dir, 'intermediate.ext'), [
    'basicConstraints=critical,CA:TRUE',
    'keyUsage=critical,digitalSignature,keyCertSign,cRLSign',
    'subjectKeyIdentifier=hash',
    'authorityKeyIdentifier=keyid,issuer',
    '1.2.840.113635.100.6.2.1=DER:05:00',
    '',
  ].join('\n'));
  openssl(dir, 'x509', '-req', '-in', 'intermediate.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-days', '3650', '-sha256', '-extfile', 'intermediate.ext', '-out', 'intermediate.pem');
  openssl(dir, 'x509', '-in', 'intermediate.pem', '-outform', 'DER', '-out', 'intermediate.der');

  openssl(dir, 'ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'leaf.key');
  openssl(dir, 'req', '-new', '-key', 'leaf.key', '-subj', '/CN=Fabushi Test App Store Leaf', '-out', 'leaf.csr');
  fs.writeFileSync(path.join(dir, 'leaf.ext'), [
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature',
    'subjectKeyIdentifier=hash',
    'authorityKeyIdentifier=keyid,issuer',
    '1.2.840.113635.100.6.11.1=DER:05:00',
    '',
  ].join('\n'));
  openssl(dir, 'x509', '-req', '-in', 'leaf.csr', '-CA', 'intermediate.pem', '-CAkey', 'intermediate.key', '-CAcreateserial', '-days', '3650', '-sha256', '-extfile', 'leaf.ext', '-out', 'leaf.pem');
  openssl(dir, 'x509', '-in', 'leaf.pem', '-outform', 'DER', '-out', 'leaf.der');

  return {
    dir,
    root: fs.readFileSync(path.join(dir, 'root.der')),
    intermediate: fs.readFileSync(path.join(dir, 'intermediate.der')),
    leaf: fs.readFileSync(path.join(dir, 'leaf.der')),
    leafKey: fs.readFileSync(path.join(dir, 'leaf.key'), 'utf8'),
  };
}

function createJws(chain, payload) {
  const header = Buffer.from(JSON.stringify({
    alg: 'ES256',
    x5c: [chain.leaf, chain.intermediate, chain.root].map((cert) => Buffer.from(cert).toString('base64')),
  })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const input = `${header}.${body}`;
  const signature = sign('sha256', Buffer.from(input), {
    key: createPrivateKey(chain.leafKey),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${input}.${signature}`;
}

test('Apple JWS verifier validates the Apple-purpose certificate chain and ES256 signature', async (t) => {
  const chain = buildChain();
  t.after(() => fs.rmSync(chain.dir, { recursive: true, force: true }));
  const now = Date.now();
  const payload = {
    transactionId: '2000000000002001',
    productId: 'monthly',
    bundleId: 'com.ombhrum.fabushi',
    environment: 'Production',
    signedDate: now,
  };
  const jws = createJws(chain, payload);
  const verified = await verifyAppleTransactionJws(jws, { trustedRoots: [chain.root], now });
  assert.equal(verified.transactionId, payload.transactionId);
  assert.equal(verified.environment, 'Production');

  const [header, , signature] = jws.split('.');
  const tamperedBody = Buffer.from(JSON.stringify({ ...payload, productId: 'annual' })).toString('base64url');
  await assert.rejects(
    verifyAppleTransactionJws(`${header}.${tamperedBody}.${signature}`, { trustedRoots: [chain.root], now }),
    /signature is invalid/,
  );
});

test('Apple JWS verifier rejects a certificate chain outside the configured trust roots', async (t) => {
  const trusted = buildChain();
  const attacker = buildChain();
  t.after(() => {
    fs.rmSync(trusted.dir, { recursive: true, force: true });
    fs.rmSync(attacker.dir, { recursive: true, force: true });
  });
  const now = Date.now();
  const jws = createJws(attacker, {
    transactionId: '2000000000002002',
    productId: 'monthly',
    bundleId: 'com.ombhrum.fabushi',
    environment: 'Production',
    signedDate: now,
  });
  await assert.rejects(
    verifyAppleTransactionJws(jws, { trustedRoots: [trusted.root], now }),
    /trusted Apple root/,
  );
});
