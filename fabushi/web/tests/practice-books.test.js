import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleAsrModelManifest,
  handleDeletePracticeBook,
  handleGetPracticeBooks,
  handleImportPracticeBookUrl,
  handleSavePracticeBook,
} from '../src/handlers/meditation.js';

function authHeader(username, userId = 101) {
  const payload = Buffer.from(JSON.stringify({ username, userId })).toString(
    'base64url',
  );
  return `Bearer header.${payload}.signature`;
}

function createR2Mock() {
  const objects = new Map();
  return {
    objects,
    bucket: {
      async put(key, value) {
        objects.set(key, value);
      },
      async get(key) {
        if (!objects.has(key)) return null;
        return {
          async text() {
            return objects.get(key);
          },
        };
      },
      async delete(key) {
        objects.delete(key);
      },
    },
  };
}

function createDbMock() {
  const practiceBooks = new Map();

  const inOwnerScope = (row, userId, username) =>
    row.user_id === userId || (row.user_id == null && row.username === username);

  const db = {
    prepare(sql) {
      const normalizedSql = sql.trim().replace(/\s+/g, ' ');
      return {
        bind(...params) {
          return {
            async first() {
              if (normalizedSql.startsWith('SELECT id FROM users WHERE username = ?')) {
                return { id: 101 };
              }

              if (normalizedSql.startsWith('SELECT COALESCE(MAX(sync_version), 0) + 1 as next_version FROM (')) {
                return { next_version: 1 };
              }

              if (normalizedSql.startsWith('SELECT id, remote_object_key FROM practice_books WHERE id = ? AND')) {
                const [id, userId, username] = params;
                const row = practiceBooks.get(id);
                return row && inOwnerScope(row, userId, username)
                  ? { id: row.id, remote_object_key: row.remote_object_key }
                  : null;
              }

              return null;
            },
            async all() {
              if (normalizedSql.startsWith('SELECT id, username, user_id, practice_title, title, source_type,')) {
                const [userId, username, practiceTitle] = params;
                const rows = Array.from(practiceBooks.values())
                  .filter((row) => inOwnerScope(row, userId, username))
                  .filter((row) => !practiceTitle || row.practice_title === practiceTitle)
                  .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
                return { results: rows };
              }

              return { results: [] };
            },
            async run() {
              if (normalizedSql.startsWith('UPDATE meditation_records') ||
                  normalizedSql.startsWith('UPDATE meditation_goals') ||
                  normalizedSql.startsWith('UPDATE meditation_settings')) {
                return {};
              }

              if (normalizedSql.startsWith('UPDATE practice_books SET is_active = 0,')) {
                const [updatedAt, userId, username, practiceTitle] = params;
                for (const row of practiceBooks.values()) {
                  if (inOwnerScope(row, userId, username) && row.practice_title === practiceTitle) {
                    row.is_active = 0;
                    row.updated_at = updatedAt;
                  }
                }
                return {};
              }

              if (normalizedSql.startsWith('INSERT INTO practice_books')) {
                const [
                  id,
                  username,
                  userId,
                  practiceTitle,
                  title,
                  sourceType,
                  sourceUrl,
                  sourceFileName,
                  contentHash,
                  normalizedText,
                  remoteObjectKey,
                  isActive,
                  createdAt,
                  updatedAt,
                  syncVersion,
                ] = params;
                practiceBooks.set(id, {
                  id,
                  username,
                  user_id: userId,
                  practice_title: practiceTitle,
                  title,
                  source_type: sourceType,
                  source_url: sourceUrl,
                  source_file_name: sourceFileName,
                  content_hash: contentHash,
                  normalized_text: normalizedText,
                  remote_object_key: remoteObjectKey,
                  is_active: isActive,
                  created_at: createdAt,
                  updated_at: updatedAt,
                  sync_version: syncVersion,
                });
                return {};
              }

              if (normalizedSql.startsWith('DELETE FROM practice_books WHERE id = ?')) {
                practiceBooks.delete(params[0]);
                return {};
              }

              return {};
            },
          };
        },
      };
    },
  };

  return { db, practiceBooks };
}

function jsonRequest(url, body, method = 'POST') {
  return new Request(url, {
    method,
    headers: {
      Authorization: authHeader('bhrum108'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

test('practice book save, list, and delete are scoped to the authenticated owner', async () => {
  const { db, practiceBooks } = createDbMock();
  const r2 = createR2Mock();
  const env = { R2_BUCKET: r2.bucket };

  const saveResponse = await handleSavePracticeBook(
    jsonRequest('https://api.example.com/api/meditation/practice-books', {
      id: 'book-1',
      practiceTitle: '心经',
      title: '般若波罗蜜多心经',
      sourceType: 'file',
      sourceFileName: 'heart.txt',
      plainText: '观自在菩萨，行深般若波罗蜜多时。',
    }),
    env,
    db,
  );

  assert.equal(saveResponse.status, 200);
  assert.equal((await saveResponse.json()).data.book.syncStatus, 'synced');
  assert.equal(practiceBooks.get('book-1')?.username, 'bhrum108');
  assert.equal(r2.objects.has('practice-books/u-101/book-1.json'), true);

  const listResponse = await handleGetPracticeBooks(
    new Request('https://api.example.com/api/meditation/practice-books?practiceTitle=%E5%BF%83%E7%BB%8F', {
      headers: { Authorization: authHeader('bhrum108') },
    }),
    env,
    db,
  );
  const listPayload = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.equal(listPayload.data.books.length, 1);
  assert.equal(listPayload.data.books[0].plainText, '观自在菩萨，行深般若波罗蜜多时。');

  const deleteResponse = await handleDeletePracticeBook(
    new Request('https://api.example.com/api/meditation/practice-books?id=book-1', {
      method: 'DELETE',
      headers: { Authorization: authHeader('bhrum108') },
    }),
    env,
    db,
  );
  assert.equal(deleteResponse.status, 200);
  assert.equal(practiceBooks.has('book-1'), false);
  assert.equal(r2.objects.has('practice-books/u-101/book-1.json'), false);
});

test('wechat article import extracts visible article content into R2', async () => {
  const { db } = createDbMock();
  const r2 = createR2Mock();
  const env = { R2_BUCKET: r2.bucket };
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(`
      <html>
        <head><meta property="og:title" content="每日功课"/></head>
        <body>
          <div id="js_content">
            <p>南无本师释迦牟尼佛。</p>
            <p>愿以此功德，庄严佛净土，上报四重恩，下济三途苦。</p>
            <p>若有见闻者，悉发菩提心，尽此一报身，同生极乐国。</p>
          </div>
        </body>
      </html>
    `, { status: 200, headers: { 'Content-Type': 'text/html' } });

  try {
    const response = await handleImportPracticeBookUrl(
      jsonRequest('https://api.example.com/api/meditation/practice-books/import-url', {
        url: 'https://mp.weixin.qq.com/s/example',
        practiceTitle: '每日功课',
      }),
      env,
      db,
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.data.book.title, '每日功课');
    assert.equal(payload.data.book.sourceType, 'url');
    assert.match(payload.data.book.plainText, /愿以此功德/);
    assert.equal(r2.objects.size, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('asr manifest exposes R2-backed paraformer model files', async () => {
  const response = await handleAsrModelManifest(
    new Request('https://api.example.com/api/meditation/asr-model-manifest'),
    {
      ASR_PARA_FORMER_ENCODER_SHA256: 'encoder-sha',
      ASR_PARA_FORMER_DECODER_SHA256: 'decoder-sha',
      ASR_PARA_FORMER_TOKENS_SHA256: 'tokens-sha',
    },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.id, 'streaming-paraformer-zh-en');
  assert.equal(payload.offline, true);
  assert.equal(payload.files.length, 3);
  assert.match(payload.files[0].url, /\/r2\?file=asr-models%2Fstreaming-paraformer-zh-en%2Fencoder\.int8\.onnx/);
  assert.equal(payload.files[0].sha256, 'encoder-sha');
});
