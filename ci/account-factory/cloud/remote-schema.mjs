import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { requireIsolation } from '../factory-core.mjs';

export const remoteMigrations = [
  '0006_remote_computer.sql','0014_remote_computer_client_tokens.sql',
  '0015_remote_computer_inventory.sql','0016_remote_computer_session_provider.sql',
  '0017_remote_computer_transport_contract.sql','0024_remote_computer_transport_audit.sql',
  '0025_remote_computer_audit_grants.sql','0027_remote_computer_mobile_session_reconcile.sql',
  '0028_remote_computer_operation_journal.sql','0029_remote_computer_exact_tool_grants.sql',
  '0030_remote_computer_service_clients.sql','0031_remote_computer_network_bindings.sql',
  '0032_remote_computer_target_service_grants.sql','0033_remote_computer_network_enrollment_grants.sql',
  '0034_remote_computer_network_ingress_bindings.sql',
];

export async function prepareRemoteSchema({resources,query,schemaRoot}) {
  requireIsolation(resources);
  const db=resources.platformDbId;
  const tables=await query(db,"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'");
  if(!tables.some(x=>x.name==='ci_fixture_remote_migrations')) {
    if(tables.length)throw Error('nonempty_unowned_platform_database');
    await query(db,"CREATE TABLE ci_fixture_remote_migrations(name TEXT PRIMARY KEY,digest TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('applying','applied')))");
  }
  const previous=await query(db,'SELECT name,digest,state FROM ci_fixture_remote_migrations');
  if(previous.some(x=>!remoteMigrations.includes(x.name)||x.state!=='applied'))throw Error('platform_schema_requires_recovery');
  const applied=[];
  for(const name of remoteMigrations) {
    const sql=readFileSync(join(schemaRoot,name),'utf8');
    const digest=createHash('sha256').update(sql).digest('hex');
    const old=previous.find(x=>x.name===name);
    if(old) {if(old.digest!==digest)throw Error('platform_schema_digest_mismatch');}
    else {
      // Record intent first. Any unknown outcome remains applying and blocks a
      // later run, rather than replaying ALTER or resetting a dedicated DB.
      await query(db,"INSERT INTO ci_fixture_remote_migrations VALUES(?,?,'applying')",[name,digest]);
      await query(db,sql);
      await query(db,"UPDATE ci_fixture_remote_migrations SET state='applied' WHERE name=? AND digest=? AND state='applying'",[name,digest]);
    }
    applied.push({name,digest});
  }
  return {count:applied.length,migrations:applied};
}
