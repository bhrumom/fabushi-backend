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
 assert.match(workflow,/name: Apply reviewed canonical PLATFORM_DB migrations\s+if: \$\{\{ !inputs\.inventory_only && inputs\.migrate_platform \}\}/);
 assert.ok(workflow.indexOf('d1 migrations list PLATFORM_DB')<workflow.indexOf('d1 migrations apply PLATFORM_DB'));
 assert.ok(workflow.indexOf('d1 migrations apply PLATFORM_DB')<workflow.indexOf('name: Deploy the verified platform artifact'));
});
test('inventory mode excludes all production mutations and does not report deployment success',()=>{
 assert.match(workflow,/inventory_only:[\s\S]*?type: boolean\s+default: false/);
 const steps=workflow.split(/\n      - /).slice(1);
 const mutations=steps.filter(step=>/d1 migrations apply|wrangler@4\.110\.0 deploy/.test(step));
 assert.equal(mutations.length,3);
 for(const step of mutations) assert.match(step,/if: \$\{\{ !inputs\.inventory_only(?: && inputs\.migrate_platform)? \}\}/);
 for(const name of ['Compile verified Worker source','Verify real public routing and credential boundary','Record exact deployment provenance']) {
   const step=steps.find(s=>s.startsWith('name: '+name+'\n'));assert.ok(step);assert.match(step,/if: \$\{\{ !inputs\.inventory_only \}\}/);
 }
 assert.match(workflow,/name: Record read-only inventory provenance\s+if: inputs\.inventory_only/);
 assert.ok(workflow.includes('deployment:"not-performed",migrations:"not-applied"'));
 assert.ok(workflow.includes('d1 migrations list ACCOUNT_DB --remote'));
 assert.equal((workflow.match(/SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;/g)||[]).length,2);
 for(const file of ['mcp-account-pending.txt','mcp-platform-pending.txt','mcp-account-schema.json','mcp-platform-schema.json','native-cloud-inventory.json']) assert.ok(workflow.includes(file));
});
test('source verification and production credential isolation remain mandatory',()=>{
 assert.ok(workflow.includes('Only current canonical Core main can deploy'));assert.ok(workflow.includes('Exact Core main broker verification has not passed'));
 assert.ok(workflow.includes('secrets.FABUSHI_FDN_CF_BOOTSTRAP_TOKEN'));assert.ok(!workflow.includes('CI_CLOUDFLARE_API_TOKEN'));
 assert.ok(workflow.includes('mcp-platform-recovery.json'));assert.ok(workflow.includes('mcp-account-recovery.json'));
});
