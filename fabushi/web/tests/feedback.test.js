import test from 'node:test';
import assert from 'node:assert/strict';

import { handleSubmitFeedback } from '../src/handlers/feedback.js';

test('handleSubmitFeedback rejects missing title', async () => {
  const request = new Request('https://flutter.ombhrum.com/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: 'details' }),
  });

  const response = await handleSubmitFeedback(request, {
    GITHUB_FEEDBACK_TOKEN: 'token',
  }, {
    getUser: async () => null,
  });

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.success, false);
  assert.match(payload.error, /标题/);
});

test('handleSubmitFeedback rejects when GitHub feedback token is not configured', async () => {
  const request = new Request('https://flutter.ombhrum.com/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: '按钮点了没反应',
      description: '设置页反馈按钮没有响应。',
    }),
  });

  const response = await handleSubmitFeedback(request, {}, {
    getUser: async () => null,
  });

  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.success, false);
});

test('handleSubmitFeedback creates a GitHub issue for valid feedback', async () => {
  const calls = [];
  const originalFetch = global.fetch;

  global.fetch = async (url, init = {}) => {
    calls.push({ url, init });

    if (String(url).endsWith('/labels')) {
      return new Response(JSON.stringify({ name: 'user-feedback' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (String(url).endsWith('/issues')) {
      return new Response(JSON.stringify({
        number: 123,
        html_url: 'https://github.com/bhrumom/fabushi/issues/123',
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    const request = new Request('https://flutter.ombhrum.com/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '收藏后提示不明显',
        description: '建议收藏成功后给一个更明确的提示。',
        contact: 'user@example.com',
        page: 'settings',
        platform: 'android',
        appVersion: '1.0.0+16',
      }),
    });

    const response = await handleSubmitFeedback(request, {
      GITHUB_FEEDBACK_TOKEN: 'token',
      GITHUB_FEEDBACK_REPO_OWNER: 'bhrumom',
      GITHUB_FEEDBACK_REPO_NAME: 'fabushi',
    }, {
      getUser: async () => null,
    });

    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.equal(payload.success, true);
    assert.equal(payload.issueNumber, 123);
    assert.equal(calls.length, 2);

    const issueRequestBody = JSON.parse(calls[1].init.body);
    assert.match(issueRequestBody.title, /^\[反馈\]/);
    assert.match(issueRequestBody.body, /收藏成功/);
  } finally {
    global.fetch = originalFetch;
  }
});
