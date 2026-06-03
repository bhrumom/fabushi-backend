import test from 'node:test';
import assert from 'node:assert/strict';

import { handleGetCbetaSendTexts } from '../src/handlers/cbeta.js';

const SELF_HOSTED_API = 'https://144.24.17.21.sslip.io';

const sampleHtml = `
  <html><head><title>Heart Sutra</title></head><body>
    <div id="body">
      <span class="lb">T08n0251_p0848c06</span>
      <p class="juan"><span class="t">Heart Sutra</span></p>
      <p><span class="lineInfo">line</span><span class="t">Avalokitesvara deeply practiced prajna.</span></p>
      <p><span class="t">He saw the five aggregates are empty.</span></p>
    </div>
    <div id="back"><div class="footnote">footnote</div></div>
    <div id="cbeta-copyright"><p>copyright</p></div>
  </body></html>
`;

function installFetchMock(handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test('CBETA send texts returns real stripped scripture content and detailed partial errors', async () => {
  let failAttempts = 0;
  const restoreFetch = installFetchMock(async url => {
    const parsed = new URL(url);
    const work = parsed.searchParams.get('work');
    if (work === 'T0251') {
      return new Response(JSON.stringify({
        results: [sampleHtml],
        work_info: {
          work: 'T0251',
          title: 'Heart Sutra',
          byline: 'Xuanzang',
          category: 'Prajna',
        },
      }), { status: 200 });
    }

    failAttempts++;
    return new Response('upstream unavailable', {
      status: 503,
      statusText: 'Service Unavailable',
    });
  });

  try {
    const response = await handleGetCbetaSendTexts(
      new Request('https://api.ombhrum.com/api/cbeta/send-texts?works=T0251,T9999&limit=2'),
    );
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.count, 1);
    assert.equal(body.primaryApi, SELF_HOSTED_API);
    assert.equal(body.fallbackApi, null);
    assert.equal(body.errors.length, 1);
    assert.equal(body.errors[0].attempts.length, 3);
    assert.equal(failAttempts, 3);

    const item = body.items[0];
    assert.equal(item.work, 'T0251');
    assert.equal(item.sourceApi, SELF_HOSTED_API);
    assert.match(item.fileName, /^T0251_1_/);
    assert.match(item.content, /Avalokitesvara deeply practiced prajna/);
    assert.doesNotMatch(item.content, /T08n0251/);
    assert.doesNotMatch(item.content, /copyright/);
  } finally {
    restoreFetch();
  }
});

test('CBETA send texts reports full upstream errors when no scripture can be fetched', async () => {
  const restoreFetch = installFetchMock(async url => {
    return new Response(JSON.stringify({ message: 'bad gateway', url }), {
      status: 502,
      statusText: 'Bad Gateway',
    });
  });

  try {
    const response = await handleGetCbetaSendTexts(
      new Request('https://api.ombhrum.com/api/cbeta/send-texts?works=T0251&limit=1'),
    );
    assert.equal(response.status, 502);

    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.count, 0);
    assert.equal(body.fallbackApi, null);
    assert.equal(body.errors.length, 1);
    assert.match(body.errors[0].message, /failed after 3 attempts/);
    assert.equal(body.errors[0].attempts.length, 3);
    assert.equal(body.errors[0].attempts[0].status, 502);
    assert.match(body.errors[0].attempts[0].body, /bad gateway/);
  } finally {
    restoreFetch();
  }
});

test('CBETA send texts never falls back to official API when self-hosted returns empty content', async () => {
  const attemptedHosts = [];
  const restoreFetch = installFetchMock(async url => {
    const parsed = new URL(url);
    attemptedHosts.push(parsed.host);
    return new Response(JSON.stringify({ num_found: 0, results: [] }), { status: 200 });
  });

  try {
    const response = await handleGetCbetaSendTexts(
      new Request('https://api.ombhrum.com/api/cbeta/send-texts?works=T0251&limit=1'),
    );
    assert.equal(response.status, 502);

    const body = await response.json();
    assert.equal(body.count, 0);
    assert.equal(body.fallbackApi, null);
    assert.equal(body.errors.length, 1);
    assert.deepEqual(attemptedHosts, [
      '144.24.17.21.sslip.io',
      '144.24.17.21.sslip.io',
      '144.24.17.21.sslip.io',
    ]);
  } finally {
    restoreFetch();
  }
});
