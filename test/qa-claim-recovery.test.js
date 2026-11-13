import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { environmentForTestControlRoot } from "../scripts/test-environment.js";

const exec = promisify(execFile);
const source = process.cwd();

async function fixture(body) {
  const root = await mkdtemp(path.join(process.env.STUDIOOPS_TEST_ROOT, "qa-recovery-"));
  try {
    await mkdir(path.join(root, "data"), { recursive: true });
    const claim = {
      schemaVersion: "studioops.qa-integration-attempt-claim.v1",
      projectId: "project_1", claimId: "claim-original", fence: 7,
      status: "active", ownerPid: 41001, ownerHost: os.hostname().toLowerCase(),
      authorityDigest: `sha256:${"a".repeat(64)}`, acquiredAt: new Date().toISOString(),
      renewedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(),
    };
    await writeFile(path.join(root, "data", "mission-control.json"), JSON.stringify({
      meta: { qaIntegrationAttemptClaims: { project_1: claim }, qaIntegrationAttemptClaimHistory: [{ preserved: true }] },
      projects: [{ id: "project_1", key: "demo", name: "Demo" }],
      tasks: [], runs: [], reviews: [], comments: [], events: [], qaBundles: [], candidates: [],
    }));
    const script = `
      import assert from 'node:assert/strict';
      import {DatabaseSync} from 'node:sqlite';
      import {execFile} from 'node:child_process';
      import {promisify} from 'node:util';
      import {readState,readStateReadOnly} from ${JSON.stringify(source + "/src/store.js")};
      import {recoverAbandonedQaClaim,createQaClaimRecoveryTestProbe} from ${JSON.stringify(source + "/src/qa-claim-recovery.js")};
      await readState();
      const db=new DatabaseSync(${JSON.stringify(path.join(root, "data", "mission-control.sqlite3"))});
      const meta=()=>db.prepare('SELECT payload,version FROM state_meta WHERE singleton_id=1').get();
      const original=${JSON.stringify(claim)};
      const expected={projectId:original.projectId,claimId:original.claimId,fence:original.fence,ownerPid:original.ownerPid,ownerHost:original.ownerHost};
      const probe=run=>createQaClaimRecoveryTestProbe(run);
      const absent=probe(()=> 'absent');
      const change=fn=>{const row=meta(),m=JSON.parse(row.payload);fn(m);db.prepare('UPDATE state_meta SET payload=?,version=version+1 WHERE singleton_id=1').run(JSON.stringify(m));};
      ${body}
      db.close();
    `;
    await exec(process.execPath, ["--input-type=module", "-e", script], {
      cwd: root, env: await environmentForTestControlRoot(root), timeout: 30000, maxBuffer: 2 * 1024 * 1024,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("QA recovery preserves the full abandoned claim and repeated recovery is read-only", async () => {
  await fixture(`
    const before=meta();
    assert.equal((await recoverAbandonedQaClaim({...expected,testOwnerProbe:absent,dryRun:true})).status,'recoverable');
    assert.deepEqual(meta(),before);
    assert.equal((await recoverAbandonedQaClaim({...expected,testOwnerProbe:absent})).status,'recovered');
    const saved=await readStateReadOnly(),current=saved.meta.qaIntegrationAttemptClaims.project_1;
    assert.deepEqual(current,{...original,status:'terminal',outcome:'owner_process_absent',terminalAt:current.terminalAt});
    assert.deepEqual(saved.meta.qaIntegrationAttemptClaimHistory[0],{preserved:true});
    assert.deepEqual(saved.meta.qaIntegrationAttemptClaimHistory[1].originalClaim,original);
    assert.equal(saved.meta.qaIntegrationAttemptClaimHistory[1].status,'abandoned');
    assert.deepEqual(saved.runs,[]);assert.deepEqual(saved.tasks,[]);
    const completed=meta();
    assert.equal((await recoverAbandonedQaClaim(expected)).status,'already_recovered');
    assert.deepEqual(meta(),completed);
  `);
});

test("QA recovery refuses live, unknown, foreign, forged and mismatched owners without writes", async () => {
  await fixture(`
    const before=meta();
    for(const input of [
      {...expected,testOwnerProbe:probe(()=> 'alive')},
      {...expected,testOwnerProbe:probe(()=> {throw new Error('EPERM')})},
      {...expected,testOwnerProbe:{kind:'qa-claim-recovery-owner-probe',run:()=> 'absent'}},
      {...expected,ownerHost:'foreign-host',testOwnerProbe:absent},
      {...expected,claimId:'replacement',testOwnerProbe:absent},
      {...expected,fence:8,testOwnerProbe:absent},
      {...expected,ownerPid:0,testOwnerProbe:absent},
      {...expected,fence:true,testOwnerProbe:absent},
      {...expected,fence:[7],testOwnerProbe:absent},
      {...expected,ownerPid:{valueOf:()=>41001},testOwnerProbe:absent},
      {...expected,projectId:[expected.projectId],testOwnerProbe:absent},
      {...expected,qaOwnerHost:original.ownerHost,testOwnerProbe:absent},
      {...expected,qaProcessAlive:()=>false},
    ])await assert.rejects(()=>recoverAbandonedQaClaim(input));
    assert.deepEqual(meta(),before);
    for(const [key,value]of [['authorityDigest',[original.authorityDigest]],['authorityDigest',12],['expiresAt',[original.expiresAt]],['expiresAt',12345]]){
      change(m=>m.qaIntegrationAttemptClaims.project_1[key]=value);
      const malformed=meta();await assert.rejects(()=>recoverAbandonedQaClaim({...expected,testOwnerProbe:absent}),/exact requested identity/);
      assert.deepEqual(meta(),malformed);
      change(m=>m.qaIntegrationAttemptClaims.project_1[key]=original[key]);
    }
    change(m=>m.qaIntegrationAttemptClaims.project_1.ownerPid=process.pid);
    const live=meta();await assert.rejects(()=>recoverAbandonedQaClaim({...expected,ownerPid:process.pid}),/alive or its absence is uncertain/);
    assert.deepEqual(meta(),live);
  `);
});

test("QA recovery rechecks exact claim and liveness when optimistic persistence replays", async () => {
  await fixture(`
    let calls=0;
    const replaced=probe(()=>{if(++calls===2)change(m=>m.qaIntegrationAttemptClaims.project_1.claimId='replacement');return 'absent';});
    await assert.rejects(()=>recoverAbandonedQaClaim({...expected,testOwnerProbe:replaced}),/exact requested identity/);
    let state=await readStateReadOnly();assert.equal(state.meta.qaIntegrationAttemptClaims.project_1.status,'active');
    assert.deepEqual(state.meta.qaIntegrationAttemptClaimHistory,[{preserved:true}]);
    change(m=>m.qaIntegrationAttemptClaims.project_1.claimId=original.claimId);
    calls=0;
    const reused=probe(()=>{calls++;if(calls===2)change(m=>m.unrelated='changed');return calls>2?'alive':'absent';});
    await assert.rejects(()=>recoverAbandonedQaClaim({...expected,testOwnerProbe:reused}),/alive or its absence is uncertain/);
    state=await readStateReadOnly();assert.equal(state.meta.qaIntegrationAttemptClaims.project_1.status,'active');
    assert.deepEqual(state.meta.qaIntegrationAttemptClaimHistory,[{preserved:true}]);assert.ok(calls>=3);
    calls=0;
    const replay=probe(()=>{if(++calls===2)change(m=>m.unrelated='changed-again');return 'absent';});
    assert.equal((await recoverAbandonedQaClaim({...expected,testOwnerProbe:replay})).status,'recovered');
    state=await readStateReadOnly();assert.equal(state.meta.qaIntegrationAttemptClaimHistory.length,2);assert.ok(calls>=3);
  `);
});

test("QA recovery preserves claims and history when maintenance or persistence blocks commit", async () => {
  await fixture(`
    change(m=>m.selfUpdateLease={id:'other-maintenance',ownerPid:'999999',expiresAt:new Date(Date.now()+60000).toISOString()});
    let before=meta();await assert.rejects(()=>recoverAbandonedQaClaim({...expected,testOwnerProbe:absent}),/maintenance/);
    assert.deepEqual(meta(),before);
    change(m=>delete m.selfUpdateLease);
    let calls=0;
    const lateMaintenance=probe(()=>{if(++calls===2)change(m=>m.selfUpdateLease={id:'late-maintenance',ownerPid:'999999',expiresAt:new Date(Date.now()+60000).toISOString()});return 'absent';});
    await assert.rejects(()=>recoverAbandonedQaClaim({...expected,testOwnerProbe:lateMaintenance}),/maintenance/);
    const fenced=JSON.parse(meta().payload);assert.equal(fenced.qaIntegrationAttemptClaims.project_1.status,'active');
    assert.deepEqual(fenced.qaIntegrationAttemptClaimHistory,[{preserved:true}]);
    change(m=>delete m.selfUpdateLease);
    db.exec("CREATE TRIGGER reject_recovery BEFORE UPDATE ON state_meta BEGIN SELECT RAISE(ABORT, 'recovery persistence fixture'); END");
    before=meta();await assert.rejects(()=>recoverAbandonedQaClaim({...expected,testOwnerProbe:absent}),/recovery persistence fixture/);
    assert.deepEqual(meta(),before);
  `);
});

test("QA recovery CLI plans by default and applies one genuinely absent owner without starting work", async () => {
  await fixture(`
    const run=promisify(execFile);
    const deadPid=Number((await run(process.execPath,['-e','console.log(process.pid)'])).stdout.trim());
    change(m=>m.qaIntegrationAttemptClaims.project_1.ownerPid=deadPid);
    const args=[${JSON.stringify(source + "/src/mission-control-cli.js")},'qa-recover-claim','--project-id',expected.projectId,'--claim-id',expected.claimId,'--fence',String(expected.fence),'--owner-pid',String(deadPid),'--owner-host',expected.ownerHost];
    const before=meta();const planned=JSON.parse((await run(process.execPath,args,{env:process.env})).stdout);
    assert.equal(planned.status,'recoverable');assert.deepEqual(meta(),before);
    await assert.rejects(()=>run(process.execPath,[...args,'--apply','false'],{env:process.env}),/does not accept a value/);
    assert.deepEqual(meta(),before);
    const applied=JSON.parse((await run(process.execPath,[...args,'--apply'],{env:process.env})).stdout);
    assert.equal(applied.status,'recovered');
    const state=await readStateReadOnly();assert.equal(state.meta.qaIntegrationAttemptClaims.project_1.ownerPid,deadPid);
    assert.deepEqual(state.runs,[]);assert.deepEqual(state.tasks,[]);
  `);
});
