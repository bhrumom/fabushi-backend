import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractMiniAppHtml,
  isBotFatherGenerationMessages,
} from '../src/miniapp_generation.js';

test('accepts a complete static HTML app without a script tag', () => {
  const html = '<!doctype html><html><body><button>开始</button></body></html>';
  assert.equal(extractMiniAppHtml(html), html);
});

test('extracts HTML from a Markdown fence', () => {
  const result = extractMiniAppHtml(
    '```html\n<html><body><h1>念佛计数器</h1></body></html>\n```',
  );
  assert.equal(
    result,
    '<!doctype html>\n<html><body><h1>念佛计数器</h1></body></html>',
  );
});

test('removes explanation surrounding a complete HTML document', () => {
  const result = extractMiniAppHtml(
    '已完成：\n<html><body><main>应用</main></body></html>\n请查收。',
  );
  assert.equal(
    result,
    '<!doctype html>\n<html><body><main>应用</main></body></html>',
  );
});

test('rejects fragments that are not a complete HTML document', () => {
  assert.equal(extractMiniAppHtml('<div>只有片段</div>'), '');
  assert.equal(extractMiniAppHtml('<html><main>缺少 body 和闭合标签</main>'), '');
});

test('recognizes only the legacy Bot Father generation system prompt', () => {
  assert.equal(
    isBotFatherGenerationMessages([
      { role: 'system', content: '你是 Fabushi 机器人之父。请输出 HTML。' },
      { role: 'user', content: '创建计数器' },
    ]),
    true,
  );
  assert.equal(
    isBotFatherGenerationMessages([
      { role: 'system', content: '你是大乘 AI 助手。' },
      { role: 'user', content: '普通聊天' },
    ]),
    false,
  );
});
