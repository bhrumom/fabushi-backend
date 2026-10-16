import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readlinkSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const source=readFileSync(new URL('./install-controller-stack.sh',import.meta.url),'utf8');
const sha='a'.repeat(40),next='b'.repeat(40),core='c'.repeat(40);
function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'fdn-install-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 for (const p of ['bin','etc','units','stage/bin','stage/official-device-mcp/bin','stage/fdn-network-coordinator/systemd']) mkdirSync(join(dir,p),{recursive:true});
 const script=source.replace('root=/opt/fabushi-fdn',`root=${dir}/root`).replace('state=/var/lib/fabushi-fdn',`state=${dir}/state`).replace('etc_root=/etc/fabushi',`etc_root=${dir}/etc`).replace('units=/etc/systemd/system',`units=${dir}/units`).replace('install -d -o fabushi-fdn -g fabushi-fdn','install -d');
 writeFileSync(join(dir,'installer'),script);
 writeFileSync(join(dir,'etc/fdn-network-enrollment.env'),'DOCKER_HOST=unix:///run/user/993/docker.sock\n');
 for (const [name,body] of Object.entries({
  getent:'exit 0',id:'echo 993',curl:'exit 0',
  systemctl:'echo "$*" >> "$CALLS"\nif [ "$1 $2" = "start fabushi-fdn-official-mcp-ingress.service" ] && [ -f "$FAIL" ]; then exit 1; fi\nexit 0',
 }))writeFileSync(join(dir,'bin',name),'#!/bin/sh\n'+body+'\n',{mode:0o755});
 writeFileSync(join(dir,'stage/bin/official-device-network-worker'),'#!/bin/sh\nexit 0\n',{mode:0o755});
 writeFileSync(join(dir,'stage/official-device-mcp/bin/fabushi-remote-mcp.js'),'// fixture');
 for(const n of ['enrollment.service','official-mcp-ingress.service','official-mcp-ingress.timer','network-worker.service','official-device-mcp.service'])writeFileSync(join(dir,'stage/fdn-network-coordinator/systemd/fabushi-fdn-'+n),'[Service]\n');
 const tar=spawnSync('tar',['-C',join(dir,'stage'),'-czf',join(dir,'bundle.tgz'),'.']);assert.equal(tar.status,0);
 const run=(revision=sha)=>spawnSync('bash',[join(dir,'installer'),join(dir,'bundle.tgz'),revision,core,'install'],{encoding:'utf8',env:{...process.env,PATH:join(dir,'bin')+':'+process.env.PATH,CALLS:join(dir,'calls'),FAIL:join(dir,'fail')}});
 return {dir,run};
}
test('first activation error stops all newly introduced processes',t=>{
 const {dir,run}=fixture(t);writeFileSync(join(dir,'fail'),'1');const r=run();
 assert.equal(r.status,64,r.stderr);assert.match(r.stderr,/health check failed/);
 assert.match(readFileSync(join(dir,'calls'),'utf8'),/stop fabushi-fdn-official-mcp-ingress.timer fabushi-fdn-official-device-mcp.service/);
 assert.equal(existsSync(join(dir,'root/previous')),false);
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
