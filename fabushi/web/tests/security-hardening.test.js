import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relative) {
  return fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
}

const authUtils = read('auth-utils.js');
const auth = read('src/handlers/auth.js');
const providerVerifier = read('src/utils/provider-token-verifier.js');
const payment = read('src/handlers/payment.js');
const moderation = read('src/handlers/moderation.js');
const worker = read('worker-modular.js');
const requestGate = read('src/security/request-gate.js');
const wrangler = read('wrangler.toml');
const sms = read('src/handlers/sms.js');
const marketplaceWorker = read('../../third_party/mahayana/mahayana-rs/mahayana-platform-worker/src/worker_api.rs');
const marketplaceRoutes = (() => {
  try {
    return read('../../third_party/mahayana/mahayana-rs/mahayana-platform-worker/src/worker_api/marketplace.rs');
  } catch {
    return read('../../third_party/mahayana/mahayana-rs/mahayana-platform-worker/src/worker_api_parts/marketplace.inc.rs');
  }
})();

assert.match(authUtils, /resolveJwtSecret/);
assert.match(authUtils, /secret\.length < 32/);
assert.doesNotMatch(authUtils, /env\.JWT_SECRET\s*\|\|\s*['"]dev-secret['"]/);
assert.doesNotMatch(wrangler, /^JWT_SECRET\s*=/m);
assert.doesNotMatch(wrangler, /prod_secret_key|dev_secret_key/i);

assert.match(auth, /verifyAppleIdentityToken/);
assert.match(auth, /verifyFirebaseIdentityToken/);
assert.doesNotMatch(auth, /identityToken\.split\s*\(/);
assert.match(providerVerifier, /appleid\.apple\.com\/auth\/keys/);
assert.match(providerVerifier, /securetoken@system\.gserviceaccount\.com/);
assert.match(providerVerifier, /crypto\.subtle\.verify/);

assert.match(payment, /verifyAlipayNotification/);
assert.match(payment, /verifySign\(/);
assert.match(payment, /params\.app_id !== env\.ALIPAY_APP_ID/);
assert.match(payment, /payment_receipts/);
assert.match(payment, /order\.status === 'PAID'/);
assert.match(payment, /env\.DB\.batch\(statements\)/);

assert.match(worker, /enforceRequestSecurityGate/);
assert.match(requestGate, /'\/migrate-builtin-complete'/);
assert.match(moderation, /isAdmin\(user\.email, env\)/);
assert.match(moderation, /verifyToken/);

assert.doesNotMatch(sms, /Math\.random\s*\(/);
assert.doesNotMatch(sms, /console\.log\([^\n]*code/i);
assert.match(sms, /generateToken/);

assert.match(marketplaceWorker, /fn is_public_https_url\(value: &str\) -> bool/);
assert.match(marketplaceWorker, /url\.scheme\(\) != \"https\"/);
assert.match(marketplaceWorker, /domain\.ends_with\(\"\.workers\.dev\"\) \|\| domain\.ends_with\(\"\.pages\.dev\"\)/);
assert.match(marketplaceRoutes, /MAX_PACKAGE_BYTES: usize = 50 \* 1024 \* 1024/);

console.log('Worker security hardening regression gate passed.');
