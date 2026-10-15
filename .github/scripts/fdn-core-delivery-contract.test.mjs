import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const workflow=readFileSync('.github/workflows/official-mcp-platform-delivery.yml','utf8');
test('both databases have recovery bookmarks before either migration',()=>{
 const a=workflow.indexOf('d1 time-travel info ACCOUNT_DB'),p=workflow.indexOf('d1 time-travel info PLATFORM_DB');
 for(const mutation of ['d1 migrations apply ACCOUNT_DB','d1 migrations apply PLATFORM_DB']) { const i=workflow.indexOf(mutation);assert.ok(a>=0&&p>=0&&a<i&&p<i); }
});
test('platform migration is explicitly opted in and precedes Worker deployment',()=>{
 assert.match(workflow,/migrate_platform:[\s\S]*?type: boolean\s+default: false/);
 assert.match(workflow,/name: Apply reviewed canonical PLATFORM_DB migrations\s+if: inputs\.migrate_platform/);
 assert.ok(workflow.indexOf('d1 migrations list PLATFORM_DB')<workflow.indexOf('d1 migrations apply PLATFORM_DB'));
 assert.ok(workflow.indexOf('d1 migrations apply PLATFORM_DB')<workflow.indexOf('name: Deploy the verified platform artifact'));
});
test('source verification and production credential isolation remain mandatory',()=>{
 assert.ok(workflow.includes('Only current canonical Core main can deploy'));assert.ok(workflow.includes('Exact Core main broker verification has not passed'));
 assert.ok(workflow.includes('secrets.FABUSHI_FDN_CF_BOOTSTRAP_TOKEN'));assert.ok(!workflow.includes('CI_CLOUDFLARE_API_TOKEN'));
 assert.ok(workflow.includes('mcp-platform-recovery.json'));assert.ok(workflow.includes('mcp-account-recovery.json'));
});
