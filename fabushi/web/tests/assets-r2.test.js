import test from 'node:test';
import assert from 'node:assert/strict';

import { handleR2Proxy } from '../src/handlers/assets.js';

function createR2Object(bytes) {
  return {
    size: bytes.length,
    httpEtag: '"test-etag"',
    body: new Blob([bytes]),
  };
}

function createEnv(bytes) {
  return {
    R2_BUCKET: {
      async head(key) {
        assert.equal(key, 'models/buddha_model.model');
        return createR2Object(bytes);
      },
      async get(key, options) {
        assert.equal(key, 'models/buddha_model.model');
        if (!options?.range) {
          return createR2Object(bytes);
        }

        const { offset, length } = options.range;
        return createR2Object(bytes.slice(offset, offset + length));
      },
    },
  };
}

test('R2 proxy returns 206 for satisfiable range requests', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const request = new Request(
    'https://api.example.com/r2?file=models%2Fbuddha_model.model',
    { headers: { Range: 'bytes=1-3' } },
  );

  const response = await handleR2Proxy(request, createEnv(bytes));

  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Length'), '3');
  assert.equal(response.headers.get('Content-Range'), 'bytes 1-3/5');
  assert.deepEqual(
    Array.from(new Uint8Array(await response.arrayBuffer())),
    [2, 3, 4],
  );
});

test('R2 proxy returns 416 when resume offset is already at object size', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const request = new Request(
    'https://api.example.com/r2?file=models%2Fbuddha_model.model',
    { headers: { Range: 'bytes=5-' } },
  );

  const response = await handleR2Proxy(request, createEnv(bytes));

  assert.equal(response.status, 416);
  assert.equal(response.headers.get('Content-Range'), 'bytes */5');
  assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
});
