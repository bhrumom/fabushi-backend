const TEST_ACCOUNT_ID = 'user:test_account';
const TEST_ACCOUNT_USERNAME = 'TestAccount';

function bearerToken(request) {
  const authorization = request.headers.get('Authorization');
  return authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

export async function isTestAccountRequest(request, env) {
  const configured = String(env.TEST_ACCOUNT_TOKEN || '').trim();
  const supplied = bearerToken(request);
  if (configured.length < 32 || !supplied) return false;

  const [expectedDigest, suppliedDigest] = await Promise.all([
    digest(configured),
    digest(supplied),
  ]);
  let difference = expectedDigest.length ^ suppliedDigest.length;
  for (let index = 0; index < expectedDigest.length; index += 1) {
    difference |= expectedDigest[index] ^ suppliedDigest[index];
  }
  return difference === 0;
}

export function testAccountUser() {
  return {
    id: TEST_ACCOUNT_ID,
    userId: TEST_ACCOUNT_ID,
    userNo: TEST_ACCOUNT_ID,
    username: TEST_ACCOUNT_USERNAME,
    email: '',
    nickname: TEST_ACCOUNT_USERNAME,
    avatar: null,
    hasPassword: false,
    emailVerified: true,
    isTestAccount: true,
    membership: {
      type: 'lifetime',
      active: true,
      expiresAt: null,
    },
  };
}
