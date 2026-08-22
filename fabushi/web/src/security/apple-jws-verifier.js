const APPLE_ROOT_URLS = [
  'https://www.apple.com/certificateauthority/AppleRootCA-G2.cer',
  'https://www.apple.com/certificateauthority/AppleRootCA-G3.cer',
  'https://www.apple.com/appleca/AppleIncRootCertificate.cer',
];

const APPLE_LEAF_OID = '1.2.840.113635.100.6.11.1';
const APPLE_INTERMEDIATE_OID = '1.2.840.113635.100.6.2.1';
const BASIC_CONSTRAINTS_OID = '2.5.29.19';
const EC_PUBLIC_KEY_OID = '1.2.840.10045.2.1';
const P256_OID = '1.2.840.10045.3.1.7';
const P384_OID = '1.3.132.0.34';
const RSA_PUBLIC_KEY_OID = '1.2.840.113549.1.1.1';
const MAX_CERT_BYTES = 16 * 1024;
const MAX_ROOT_CACHE_MS = 6 * 60 * 60 * 1000;

let rootCache = null;
let rootCacheExpiresAt = 0;

function bytesFromBase64(value) {
  const text = String(value || '').trim();
  if (!text || text.length > MAX_CERT_BYTES * 2) throw new Error('invalid certificate encoding');
  const binary = atob(text);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (!bytes.length || bytes.length > MAX_CERT_BYTES) throw new Error('certificate size is invalid');
  return bytes;
}

function bytesFromBase64Url(value) {
  const text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  if (!text) throw new Error('empty base64url value');
  const binary = atob(text + '='.repeat((4 - text.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeJsonPart(value) {
  return JSON.parse(new TextDecoder().decode(bytesFromBase64Url(value)));
}

function readLength(bytes, offset) {
  if (offset >= bytes.length) throw new Error('truncated DER length');
  const first = bytes[offset];
  if ((first & 0x80) === 0) return { length: first, next: offset + 1 };
  const count = first & 0x7f;
  if (count === 0 || count > 4 || offset + 1 + count > bytes.length) throw new Error('invalid DER length');
  let length = 0;
  for (let i = 0; i < count; i += 1) length = (length * 256) + bytes[offset + 1 + i];
  return { length, next: offset + 1 + count };
}

function readNode(bytes, offset = 0) {
  if (offset >= bytes.length) throw new Error('truncated DER node');
  const start = offset;
  const tag = bytes[offset++];
  const lengthInfo = readLength(bytes, offset);
  const valueStart = lengthInfo.next;
  const valueEnd = valueStart + lengthInfo.length;
  if (valueEnd > bytes.length) throw new Error('truncated DER value');
  return { tag, start, valueStart, valueEnd, end: valueEnd };
}

function childNodes(bytes, node) {
  const result = [];
  let offset = node.valueStart;
  while (offset < node.valueEnd) {
    const child = readNode(bytes, offset);
    result.push(child);
    offset = child.end;
  }
  if (offset !== node.valueEnd) throw new Error('invalid DER child boundary');
  return result;
}

function rawNode(bytes, node) {
  return bytes.slice(node.start, node.end);
}

function valueBytes(bytes, node) {
  return bytes.slice(node.valueStart, node.valueEnd);
}

function bytesEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) difference |= left[i] ^ right[i];
  return difference === 0;
}

function oidFromNode(bytes, node) {
  if (node.tag !== 0x06) throw new Error('expected DER OID');
  const value = valueBytes(bytes, node);
  if (!value.length) throw new Error('empty DER OID');
  const first = value[0];
  const parts = [Math.floor(first / 40), first % 40];
  let current = 0;
  for (let i = 1; i < value.length; i += 1) {
    current = (current * 128) + (value[i] & 0x7f);
    if ((value[i] & 0x80) === 0) {
      parts.push(current);
      current = 0;
    }
  }
  if (current !== 0) throw new Error('unterminated DER OID');
  return parts.join('.');
}

function parseDerTime(bytes, node) {
  const text = new TextDecoder().decode(valueBytes(bytes, node));
  let year;
  let rest;
  if (node.tag === 0x17 && /^\d{12}Z$/.test(text)) {
    const short = Number(text.slice(0, 2));
    year = short >= 50 ? 1900 + short : 2000 + short;
    rest = text.slice(2);
  } else if (node.tag === 0x18 && /^\d{14}Z$/.test(text)) {
    year = Number(text.slice(0, 4));
    rest = text.slice(4);
  } else {
    throw new Error('unsupported certificate time encoding');
  }
  const month = Number(rest.slice(0, 2));
  const day = Number(rest.slice(2, 4));
  const hour = Number(rest.slice(4, 6));
  const minute = Number(rest.slice(6, 8));
  const second = Number(rest.slice(8, 10));
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(timestamp)) throw new Error('invalid certificate time');
  return timestamp;
}

function parseCertificate(bytes) {
  const outer = readNode(bytes, 0);
  if (outer.tag !== 0x30 || outer.end !== bytes.length) throw new Error('invalid X.509 certificate sequence');
  const outerChildren = childNodes(bytes, outer);
  if (outerChildren.length !== 3) throw new Error('invalid X.509 certificate structure');
  const [tbs, signatureAlgorithm, signatureValue] = outerChildren;
  if (tbs.tag !== 0x30 || signatureAlgorithm.tag !== 0x30 || signatureValue.tag !== 0x03) {
    throw new Error('invalid X.509 certificate fields');
  }
  const tbsChildren = childNodes(bytes, tbs);
  const base = tbsChildren[0]?.tag === 0xa0 ? 1 : 0;
  if (tbsChildren.length < base + 6) throw new Error('truncated X.509 TBSCertificate');
  const issuer = tbsChildren[base + 2];
  const validity = tbsChildren[base + 3];
  const subject = tbsChildren[base + 4];
  const spki = tbsChildren[base + 5];
  const validityChildren = childNodes(bytes, validity);
  if (validityChildren.length !== 2) throw new Error('invalid certificate validity');
  const signatureAlgorithmChildren = childNodes(bytes, signatureAlgorithm);
  const signatureBytes = valueBytes(bytes, signatureValue);
  if (!signatureBytes.length || signatureBytes[0] !== 0) throw new Error('unsupported certificate signature bit string');
  const extensionsWrapper = tbsChildren.find((node) => node.tag === 0xa3) || null;
  return {
    bytes,
    tbs: rawNode(bytes, tbs),
    signatureAlgorithmOid: oidFromNode(bytes, signatureAlgorithmChildren[0]),
    signature: signatureBytes.slice(1),
    issuer: rawNode(bytes, issuer),
    subject: rawNode(bytes, subject),
    spki: rawNode(bytes, spki),
    notBefore: parseDerTime(bytes, validityChildren[0]),
    notAfter: parseDerTime(bytes, validityChildren[1]),
    extensionsWrapper,
  };
}

function extensionNodes(cert) {
  if (!cert.extensionsWrapper) return [];
  const wrapperChildren = childNodes(cert.bytes, cert.extensionsWrapper);
  if (wrapperChildren.length !== 1 || wrapperChildren[0].tag !== 0x30) return [];
  return childNodes(cert.bytes, wrapperChildren[0]);
}

function findExtension(cert, oid) {
  for (const extension of extensionNodes(cert)) {
    if (extension.tag !== 0x30) continue;
    const fields = childNodes(cert.bytes, extension);
    if (fields[0]?.tag === 0x06 && oidFromNode(cert.bytes, fields[0]) === oid) return fields;
  }
  return null;
}

function hasExtension(cert, oid) {
  return Boolean(findExtension(cert, oid));
}

function isCertificateAuthority(cert) {
  const fields = findExtension(cert, BASIC_CONSTRAINTS_OID);
  if (!fields) return false;
  const value = fields.find((node) => node.tag === 0x04);
  if (!value || value.valueStart >= value.valueEnd) return false;
  const inner = readNode(cert.bytes, value.valueStart);
  if (inner.tag !== 0x30 || inner.end > value.valueEnd) return false;
  const constraints = childNodes(cert.bytes, inner);
  return constraints.some((node) => node.tag === 0x01 && valueBytes(cert.bytes, node)[0] !== 0);
}

function spkiAlgorithm(cert) {
  const spkiNode = readNode(cert.spki, 0);
  const spkiChildren = childNodes(cert.spki, spkiNode);
  const algorithm = spkiChildren[0];
  const fields = childNodes(cert.spki, algorithm);
  const oid = oidFromNode(cert.spki, fields[0]);
  const paramsOid = fields[1]?.tag === 0x06 ? oidFromNode(cert.spki, fields[1]) : null;
  return { oid, paramsOid };
}

async function importVerificationKey(cert) {
  const algorithm = spkiAlgorithm(cert);
  if (algorithm.oid === EC_PUBLIC_KEY_OID) {
    const namedCurve = algorithm.paramsOid === P256_OID ? 'P-256' : algorithm.paramsOid === P384_OID ? 'P-384' : null;
    if (!namedCurve) throw new Error('unsupported EC certificate curve');
    return {
      key: await crypto.subtle.importKey('spki', cert.spki, { name: 'ECDSA', namedCurve }, false, ['verify']),
      type: 'EC',
      namedCurve,
    };
  }
  if (algorithm.oid === RSA_PUBLIC_KEY_OID) {
    return {
      key: await crypto.subtle.importKey('spki', cert.spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']),
      type: 'RSA',
    };
  }
  throw new Error('unsupported certificate public-key algorithm');
}

function derIntegerToFixed(bytes, node, size) {
  if (node.tag !== 0x02) throw new Error('expected DER integer');
  let value = valueBytes(bytes, node);
  while (value.length > 1 && value[0] === 0) value = value.slice(1);
  if (value.length > size) throw new Error('ECDSA integer too large');
  const fixed = new Uint8Array(size);
  fixed.set(value, size - value.length);
  return fixed;
}

function derEcdsaToP1363(signature, size) {
  const sequence = readNode(signature, 0);
  if (sequence.tag !== 0x30 || sequence.end !== signature.length) throw new Error('invalid DER ECDSA signature');
  const fields = childNodes(signature, sequence);
  if (fields.length !== 2) throw new Error('invalid DER ECDSA signature fields');
  const r = derIntegerToFixed(signature, fields[0], size);
  const s = derIntegerToFixed(signature, fields[1], size);
  const raw = new Uint8Array(size * 2);
  raw.set(r, 0);
  raw.set(s, size);
  return raw;
}

async function verifyCertificateSignature(cert, issuer) {
  const imported = await importVerificationKey(issuer);
  let algorithm;
  let signature = cert.signature;
  switch (cert.signatureAlgorithmOid) {
    case '1.2.840.10045.4.3.2':
      if (imported.type !== 'EC') return false;
      algorithm = { name: 'ECDSA', hash: 'SHA-256' };
      signature = derEcdsaToP1363(signature, imported.namedCurve === 'P-384' ? 48 : 32);
      break;
    case '1.2.840.10045.4.3.3':
      if (imported.type !== 'EC') return false;
      algorithm = { name: 'ECDSA', hash: 'SHA-384' };
      signature = derEcdsaToP1363(signature, imported.namedCurve === 'P-384' ? 48 : 32);
      break;
    case '1.2.840.113549.1.1.11':
      if (imported.type !== 'RSA') return false;
      algorithm = { name: 'RSASSA-PKCS1-v1_5' };
      break;
    case '1.2.840.113549.1.1.12':
      if (imported.type !== 'RSA') return false;
      algorithm = { name: 'RSASSA-PKCS1-v1_5' };
      break;
    default:
      throw new Error('unsupported certificate signature algorithm');
  }
  return crypto.subtle.verify(algorithm, imported.key, signature, cert.tbs);
}

function assertCertificateDate(cert, timestamp) {
  if (timestamp < cert.notBefore || timestamp > cert.notAfter) throw new Error('certificate is outside its validity window');
}

async function loadAppleRoots(fetchImpl) {
  const now = Date.now();
  if (fetchImpl === fetch && rootCache && rootCacheExpiresAt > now) return rootCache;
  const promise = Promise.allSettled(APPLE_ROOT_URLS.map(async (url) => {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error' });
    if (!response.ok) throw new Error(`Apple root fetch failed: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_CERT_BYTES) throw new Error('Apple root certificate size is invalid');
    return bytes;
  })).then((results) => {
    const roots = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
    if (!roots.length) throw new Error('unable to load Apple trust roots');
    return roots;
  });
  if (fetchImpl === fetch) {
    rootCache = promise;
    rootCacheExpiresAt = now + MAX_ROOT_CACHE_MS;
  }
  return promise;
}

async function verifyChain(leaf, intermediate, trustedRootBytes, timestamp) {
  if (!bytesEqual(leaf.issuer, intermediate.subject)) throw new Error('Apple leaf issuer mismatch');
  if (!hasExtension(leaf, APPLE_LEAF_OID)) throw new Error('Apple leaf certificate purpose is invalid');
  if (!hasExtension(intermediate, APPLE_INTERMEDIATE_OID)) throw new Error('Apple intermediate certificate purpose is invalid');
  if (!isCertificateAuthority(intermediate)) throw new Error('Apple intermediate is not a CA');
  assertCertificateDate(leaf, timestamp);
  assertCertificateDate(intermediate, timestamp);
  if (!(await verifyCertificateSignature(leaf, intermediate))) throw new Error('Apple leaf certificate signature is invalid');

  for (const rootBytes of trustedRootBytes) {
    try {
      const root = parseCertificate(rootBytes);
      if (!bytesEqual(intermediate.issuer, root.subject)) continue;
      assertCertificateDate(root, timestamp);
      if (await verifyCertificateSignature(intermediate, root)) return leaf;
    } catch {
      // Try the next Apple trust root. A malformed/unrelated root cannot make the chain valid.
    }
  }
  throw new Error('Apple certificate chain does not terminate at a trusted Apple root');
}

export async function verifyAppleTransactionJws(value, options = {}) {
  const parts = String(value || '').split('.');
  if (parts.length !== 3) throw new Error('malformed Apple transaction JWS');
  const header = decodeJsonPart(parts[0]);
  const payload = decodeJsonPart(parts[1]);
  if (header.alg !== 'ES256' || !Array.isArray(header.x5c) || header.x5c.length !== 3) {
    throw new Error('invalid Apple transaction JWS envelope');
  }

  const now = Number(options.now ?? Date.now());
  if (!Number.isFinite(now)) throw new Error('invalid verification time');
  const signedDate = Number(payload.signedDate || 0);
  if (signedDate && (!Number.isFinite(signedDate) || signedDate > now + 5 * 60 * 1000)) {
    throw new Error('Apple signedDate is invalid');
  }

  const leaf = parseCertificate(bytesFromBase64(header.x5c[0]));
  const intermediate = parseCertificate(bytesFromBase64(header.x5c[1]));
  const trustedRoots = options.trustedRoots || await loadAppleRoots(options.fetchImpl || fetch);
  await verifyChain(leaf, intermediate, trustedRoots.map((root) => root instanceof Uint8Array ? root : new Uint8Array(root)), now);

  const imported = await importVerificationKey(leaf);
  if (imported.type !== 'EC' || imported.namedCurve !== 'P-256') throw new Error('Apple JWS leaf key must use P-256');
  const signature = bytesFromBase64Url(parts[2]);
  if (signature.length !== 64) throw new Error('Apple JWS signature length is invalid');
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    imported.key,
    signature,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new Error('Apple JWS signature is invalid');
  return payload;
}

export const appleJwsVerifierInternals = {
  APPLE_ROOT_URLS,
  APPLE_LEAF_OID,
  APPLE_INTERMEDIATE_OID,
  parseCertificate,
  verifyCertificateSignature,
};
