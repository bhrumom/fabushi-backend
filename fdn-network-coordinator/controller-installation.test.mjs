import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readlinkSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const source=readFileSync(new URL('./install-controller-stack.sh',import.meta.url),'utf8');
const guardSource=readFileSync(new URL('./install-official-device-mcp-egress-guard.sh',import.meta.url),'utf8');
const sha='a'.repeat(40),next='b'.repeat(40),core='c'.repeat(40);
function fixture(t,{workerReadyTimeoutSeconds=95}={}) {
 const dir=mkdtempSync(join(tmpdir(),'fdn-install-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 for (const p of ['bin','etc','units','stage/bin','stage/official-device-mcp/bin','stage/fdn-network-coordinator/systemd']) mkdirSync(join(dir,p),{recursive:true});
 const script=source.replace('root=/opt/fabushi-fdn',\`root=\${dir}/root\`).replace('state=/var/lib/fabushi-fdn',\`state=\${dir}/state\`).replace('etc_root=/etc/fabushi',\`etc_root=\${dir}/etc\`).replace('units=/etc/systemd/system',\`units=\${dir}/units\`).replace('install -d -o fabushi-fdn -g fabushi-fdn','install -d').replace('deadline=$((SECONDS+95))',\`deadline=$((SECONDS+\${workerReadyTimeoutSeconds}))\`);
 writeFileSync(join(dir,'installer'),script);
 writeFileSync(join(dir,'etc/fdn-network-enrollment.env'),'DOCKER_HOST=unix:///run/user/993/docker.sock\n');
 for (const [name,body] of Object.entries({
  getent:'exit 0',id:'echo 993',
  curl:'echo probe >> "$CURL_CALLS"\nif [ -f "$CURL_FAIL_MODE" ]; then\n mode=$(cat "$CURL_FAIL_MODE")\n case "$mode" in\n  worker-not-ready) printf "%s\n" "fixture-secret endpoint=https://private.invalid state=/var/lib/fabushi-fdn/private" >&2; exit 22 ;;\n  http-health-fail) count=$(wc -l < "$CURL_CALLS"); if [ "$count" -ge 2 ]; then printf "%s\n" "fixture-secret endpoint=https://private.invalid state=/var/lib/fabushi-fdn/private" >&2; exit 22; fi ;;\n esac\nfi\nexit 0',
  systemctl:'echo "$*" >> "$CALLS"\nif [ "$1 $2" = "start fabushi-fdn-official-mcp-ingress.service" ] && [ -f "$FAIL" ]; then printf "%s\n" "fixture-secret endpoint=https://private.invalid state=/var/lib/fabushi-fdn/private" >&2; exit 1; fi\nexit 0',
 }))writeFileSync(join(dir,'bin',name),'#!/bin/sh\n'+body+'\n',{mode:0o755});
 writeFileSync(join(dir,'stage/bin/official-device-network-worker'),'#!/bin/sh\nexit 0\n',{mode:0o755});
 writeFileSync(join(dir,'stage/official-device-mcp/bin/fabushi-remote-mcp.js'),'// fixture');
 writeFileSync(join(dir,'stage/fdn-network-coordinator/install-official-device-mcp-egress-guard.sh'),guardSource,{mode:0o755});
 for(const n of ['enrollment.service','official-mcp-ingress.service','official-mcp-ingress.timer','network-worker.service','official-device-mcp.service'])writeFileSync(join(dir,'stage/fdn-network-coordinator/systemd/fabushi-fdn-'+n),'[Service]\n');
 const tar=spawnSync('tar',['-C',join(dir,'stage'),'-czf',join(dir,'bundle.tgz'),'.']);assert.equal(tar.status,0);
 const run=(revision=sha)=>spawnSync('bash',[join(dir,'installer'),join(dir,'bundle.tgz'),revision,core,'install'],{encoding:'utf8',env:{...process.env,PATH:join(dir,'bin')+':'+process.env.PATH,CALLS:join(dir,'calls'),FAIL:join(dir,'fail'),CURL_CALLS:join(dir,'curl-calls'),CURL_FAIL_MODE:join(dir,'curl-fail-mode')}});
 return {dir,run};
}
test('first activation error stops all newly introduced processes',t=>{
 const {dir,run}=fixture(t);writeFileSync(join(dir,'fail'),'1');const r=run();
 assert.equal(r.status,64,r.stderr);assert.match(r.stderr,/health check failed at stage=service activation/);assert.match(r.stderr,/health check failed; previous release restored when available/);assert.doesNotMatch(r.stderr,/fixture-secret|https?:\/\/|\/var\/lib\/fabushi-fdn\/private/);
 assert.match(readFileSync(join(dir,'calls'),'utf8'),/stop fabushi-fdn-official-mcp-ingress.timer fabushi-fdn-official-device-mcp.service/);
 assert.equal(existsSync(join(dir,'root/previous')),false);
});
test('worker readiness timeout reports a safe stage without raw probe errors',t=>{
 const {dir,run}=fixture(t,{workerReadyTimeoutSeconds:1});writeFileSync(join(dir,'curl-fail-mode'),'worker-not-ready');
 const r=run();assert.equal(r.status,64,r.stderr);assert.match(r.stderr,/health check failed at stage=worker readiness/);
 assert.doesNotMatch(r.stderr,/fixture-secret|https?:\/\/|\/var\/lib\/fabushi-fdn\/private/);
 const calls=readFileSync(join(dir,'calls'),'utf8');assert.doesNotMatch(calls,/restart fabushi-fdn-enrollment.service/);
 assert.match(calls,/stop fabushi-fdn-official-mcp-ingress.timer/);
});

test('HTTP health check failure reports a safe stage without raw probe errors',t=>{
 const {dir,run}=fixture(t);writeFileSync(join(dir,'curl-fail-mode'),'http-health-fail');
 const r=run();assert.equal(r.status,64,r.stderr);assert.match(r.stderr,/health check failed at stage=HTTP health check/);
 assert.doesNotMatch(r.stderr,/fixture-secret|https?:\/\/|\/var\/lib\/fabushi-fdn\/private/);
});

test('same source reinstall retains live immutable release and socket exception is exact',t=>{
 const {dir,run}=fixture(t);assert.equal(run().status,0);writeFileSync(join(dir,'root/releases',sha,'retained'),'state');
 const r=run();assert.equal(r.status,0,r.stderr);assert.equal(readFileSync(join(dir,'root/releases',sha,'retained'),'utf8'),'state');
 assert.equal(existsSync(join(dir,'root/previous')),false);
 assert.equal(readFileSync(join(dir,'units/fabushi-fdn-enrollment.service.d/rootless-socket.conf'),'utf8'),'[Service]\nBindReadOnlyPaths=/run/user/993/docker.sock\n');
});
test('failed later release restores prior symlink and units and stops failed recovery',t=>{
 const {dir,run}=fixture(t);assert.equal(run().status,0);writeFileSync(join(dir,'fail'),'1');
 const r=run(next);assert.equal(r.status,64,r.stderr);assert.equal(readlinkSync(join(dir,'root/current')),join(dir,'root/releases',sha));
 const calls=readFileSync(join(dir,'calls'),'utf8');assert.ok((calls.match(/stop fabushi-fdn-official-mcp-ingress.timer/g)||[]).length>=2);
});

test('foreign daemon UID is rejected before worker activation and new services stop',t=>{
 const {dir,run}=fixture(t);writeFileSync(join(dir,'etc/fdn-network-enrollment.env'),'DOCKER_HOST=unix:///run/user/994/docker.sock\n');
 const r=run();assert.equal(r.status,64,r.stderr);
 const calls=readFileSync(join(dir,'calls'),'utf8');assert.doesNotMatch(calls,/restart fabushi-fdn-network-worker.service/);assert.match(calls,/stop fabushi-fdn-official-mcp-ingress.timer/);
});

test('official MCP egress guard installs a cgroup-scoped allowlist and reject-counter owner',t=>{
 const dir=mkdtempSync(join(tmpdir(),'fdn-mcp-egress-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const bin=join(dir,'bin');mkdirSync(bin,{recursive:true});
 const calls=join(dir,'calls');
 const netfilter='#!/bin/sh\necho "$(basename "$0") $*" >> "$CALLS"\ncase " $* " in *" -D OUTPUT "*) exit 1;; esac\nexit 0\n';
 for(const name of ['iptables','ip6tables'])writeFileSync(join(bin,name),netfilter,{mode:0o755});
 writeFileSync(join(bin,'getent'),'#!/bin/sh\ncase "$1" in ahostsv4) echo "203.0.113.10 STREAM api.ombhrum.com";; ahostsv6) echo "2001:db8::10 STREAM api.ombhrum.com";; esac\n',{mode:0o755});
 const guard=join(dir,'guard');writeFileSync(guard,guardSource,{mode:0o755});
 const r=spawnSync('bash',[guard,'install'],{encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH,CALLS:calls}});
 assert.equal(r.status,0,r.stderr);
 const log=readFileSync(calls,'utf8');
 assert.match(log,/iptables .* -A FABUSHI_FDN_MCP_EGRESS -p tcp -d 203\.0\.113\.10 --dport 443 -j ACCEPT/);
 assert.match(log,/iptables .* -A FABUSHI_FDN_MCP_EGRESS -m comment --comment fdn-g15-official-device-mcp-egress -j REJECT/);
 assert.match(log,/iptables .* -I OUTPUT 1 -m cgroup --path system\.slice\/fabushi-fdn-official-device-mcp\.service -j FABUSHI_FDN_MCP_EGRESS/);
 if(existsSync('/proc/net/if_inet6') && readFileSync('/proc/net/if_inet6','utf8').trim()){
  assert.match(log,/ip6tables .* -A FABUSHI_FDN_MCP_EGRESS -p tcp -d 2001:db8::10 --dport 443 -j ACCEPT/);
  assert.match(log,/ip6tables .* -A FABUSHI_FDN_MCP_EGRESS -m comment --comment fdn-g15-official-device-mcp-egress -j REJECT/);
 }
});
