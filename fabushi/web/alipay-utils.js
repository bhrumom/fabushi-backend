/**
 * Alipay Utilities for Cloudflare Workers using Web Crypto API.
 */

/**
 * Imports a PEM-formatted RSA private key (PKCS#8) for signing.
 * The private key secret in Cloudflare MUST be in PKCS#8 format.
 * To convert a PKCS#1 key (`-----BEGIN RSA PRIVATE KEY-----`):
 * openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in pkcs1.pem -out pkcs8.pem
 *
 * @param {string} pem - The PEM-formatted private key string.
 * @returns {Promise<CryptoKey>} - The imported private key as a CryptoKey.
 */
async function importPrivateKey(pem) {
  // More robustly strip PEM headers and whitespace
  const pemContents = pem
    .replace(/-----(BEGIN|END) (RSA )?PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
    
  const binaryDer = atob(pemContents);
  const buffer = new ArrayBuffer(binaryDer.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binaryDer.length; i++) {
    bytes[i] = binaryDer.charCodeAt(i);
  }

  return crypto.subtle.importKey(
    "pkcs8",
    buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["sign"]
  );
}

/**
 * Imports a PEM-formatted RSA public key (SPKI) for verification.
 * @param {string} pem - The PEM-formatted public key string.
 * @returns {Promise<CryptoKey>} - The imported public key as a CryptoKey.
 */
async function importPublicKey(pem) {
  // More robustly strip PEM headers and whitespace
  const pemContents = pem
    .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '');
  const binaryDer = atob(pemContents);
  const buffer = new ArrayBuffer(binaryDer.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binaryDer.length; i++) {
    bytes[i] = binaryDer.charCodeAt(i);
  }
  return crypto.subtle.importKey(
    "spki",
    buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["verify"]
  );
}


/**
 * Creates the pre-sign string from request parameters.
 * @param {Object} params - The parameters to be signed.
 * @returns {string} - The string to be signed.
 */
function getSignStr(params) {
  const sortedKeys = Object.keys(params).sort();
  let signStr = '';
  for (const key of sortedKeys) {
    // Per Alipay documentation, 'sign' field must be excluded.
    // Also exclude empty values.
    if (key === 'sign' || params[key] === undefined || params[key] === null || params[key] === '') {
      continue;
    }
    if (signStr.length > 0) {
      signStr += '&';
    }
    // 支付宝签名要求：参数值不进行URL编码，直接使用原始值
    let value = String(params[key]);
    signStr += `${key}=${value}`;
  }
  console.log('签名字符串:', signStr);
  return signStr;
}

/**
 * Generates an RSA-SHA256 signature for Alipay.
 * @param {Object} params - The request parameters.
 * @param {CryptoKey} privateKey - The imported private key.
 * @returns {Promise<string>} - The Base64-encoded signature.
 */
async function generateSign(params, privateKey) {
  const signStr = getSignStr(params);
  const encoder = new TextEncoder();
  const data = encoder.encode(signStr);
  const signatureBuffer = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    data
  );
  const binary = String.fromCharCode.apply(null, new Uint8Array(signatureBuffer));
  return btoa(binary);
}

/**
 * Verifies the signature of an Alipay asynchronous notification.
 * @param {Object} params - The notification parameters from Alipay. The `sign` and `sign_type` properties must be removed before calling.
 * @param {string} sign - The signature from the notification.
 * @param {CryptoKey} alipayPublicKey - The imported Alipay public key.
 * @returns {Promise<boolean>} - True if the signature is valid, false otherwise.
 */
async function verifySign(params, sign, alipayPublicKey) {
  const signStr = getSignStr(params);
  const encoder = new TextEncoder();
  const data = encoder.encode(signStr);
  
  const binarySign = atob(sign);
  const signatureBuffer = new Uint8Array(binarySign.length);
  for (let i = 0; i < binarySign.length; i++) {
    signatureBuffer[i] = binarySign.charCodeAt(i);
  }

  return crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    alipayPublicKey,
    signatureBuffer,
    data
  );
}

export { importPrivateKey, importPublicKey, getSignStr, generateSign, verifySign };