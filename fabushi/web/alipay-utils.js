/**
 * Alipay Utilities for Cloudflare Workers using Web Crypto API.
 */

/**
 * Imports a PEM-formatted RSA private key (PKCS#8) for signing.
 */
async function importPrivateKey(pem) {
  const pemContents = String(pem || '')
    .replace(/-----(BEGIN|END) (RSA )?PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  if (!pemContents) throw new Error('Alipay private key is empty');
  const binaryDer = atob(pemContents);
  const bytes = Uint8Array.from(binaryDer, (char) => char.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    bytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/**
 * Imports a PEM-formatted RSA public key (SPKI) for verification.
 */
async function importPublicKey(pem) {
  const pemContents = String(pem || '')
    .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '');
  if (!pemContents) throw new Error('Alipay public key is empty');
  const binaryDer = atob(pemContents);
  const bytes = Uint8Array.from(binaryDer, (char) => char.charCodeAt(0));
  return crypto.subtle.importKey(
    'spki',
    bytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

/**
 * Creates the canonical Alipay pre-sign string. Values are intentionally not
 * URL encoded; encoding is applied only when serializing the final request.
 */
function getSignStr(params) {
  const sortedKeys = Object.keys(params).sort();
  const parts = [];
  for (const key of sortedKeys) {
    if (key === 'sign' || params[key] === undefined || params[key] === null || params[key] === '') continue;
    parts.push(`${key}=${String(params[key])}`);
  }
  return parts.join('&');
}

async function generateSign(params, privateKey) {
  const data = new TextEncoder().encode(getSignStr(params));
  const signatureBuffer = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    data,
  );
  const bytes = new Uint8Array(signatureBuffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function verifySign(params, sign, alipayPublicKey) {
  let signatureBytes;
  try {
    const binarySign = atob(String(sign || ''));
    signatureBytes = Uint8Array.from(binarySign, (char) => char.charCodeAt(0));
  } catch {
    return false;
  }
  const data = new TextEncoder().encode(getSignStr(params));
  return crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    alipayPublicKey,
    signatureBytes,
    data,
  );
}

export { importPrivateKey, importPublicKey, getSignStr, generateSign, verifySign };
