import test from 'node:test';
import assert from 'node:assert/strict';

import { handleGetCbetaSendTexts } from '../src/handlers/cbeta.js';

const sampleHtml = `
  <html><head><title>般若波羅蜜多心經</title></head><body>
    <div id="body">
      <span class="lb">T08n0251_p0848c06</span>
      <p class="juan"><span class="t">般若波羅蜜多心經</span></p>
      <p><span class="lineInfo"></span><span class="t">觀自在菩薩行深般若波羅蜜多時</span></p>
      <p><span class="t">照見五蘊皆空，度一切苦厄。</span></p>
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
          title: '般若波羅蜜多心經',
          byline: '唐 玄奘譯',
          category: '般若部類',
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
    assert.equal(body.errors.length, 1);
    assert.equal(body.errors[0].attempts.length, 3);
    assert.equal(failAttempts, 3);

    const item = body.items[0];
    assert.equal(item.work, 'T0251');
    assert.match(item.fileName, /^T0251_1_/);
    assert.match(item.content, /觀自在菩薩/);
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
    assert.equal(body.errors.length, 1);
    assert.match(body.errors[0].message, /failed after 3 attempts/);
    assert.equal(body.errors[0].attempts[0].status, 502);
    assert.match(body.errors[0].attempts[0].body, /bad gateway/);
  } finally {
    restoreFetch();
  }
});
