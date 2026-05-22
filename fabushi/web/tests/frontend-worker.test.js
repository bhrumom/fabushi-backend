import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../frontend-worker.js';

const ASSETS = {
  async fetch() {
    return new Response('asset', { status: 200 });
  },
};

test('frontend rejects API traffic instead of proxying it', async () => {
  const response = await worker.fetch(
    new Request('https://flutter.ombhrum.com/api/auth/login'),
    { ASSETS },
  );
  const payload = await response.json();

  assert.equal(response.status, 404);
  assert.equal(payload.error, 'Frontend worker only');
});

test('frontend does not expose bundled worker source assets', async () => {
  for (const path of ['/wrangler.toml', '/src/router.js', '/tests/frontend-worker.test.js']) {
    const response = await worker.fetch(
      new Request(`https://flutter.ombhrum.com${path}`),
      { ASSETS },
    );

    assert.equal(response.status, 404);
  }
});
