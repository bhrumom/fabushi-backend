import test from 'node:test';
import assert from 'node:assert/strict';

import { route } from '../src/router.js';

test('router OPTIONS returns full CORS preflight headers', async () => {
  const response = await route(
    new Request('https://api.ombhrum.com/api/auth/login', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://flutter.ombhrum.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'accept,content-type',
      },
    }),
    {},
    null,
    {},
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.match(
    response.headers.get('Access-Control-Allow-Methods') ?? '',
    /\bPOST\b/,
  );
  assert.match(
    response.headers.get('Access-Control-Allow-Headers') ?? '',
    /\bContent-Type\b/i,
  );
});
