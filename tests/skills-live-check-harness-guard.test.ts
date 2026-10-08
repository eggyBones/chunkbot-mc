// N1-H6: no inference/world. Real harness staging probes over discriminating
// replies; missing/invalid lease children stop before reading fixture secrets.
import assert from 'node:assert/strict';
import { describe,it } from 'node:test';
import { existsSync,readFileSync,readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PROJECT_ROOT } from '../src/app/fixture-layout.ts';
import { entityTest,parseSkillsForceload,proveChestStage,requireCleanCliExit,safePlacement,skillsSceneClearCommands,validFillReply } from '../scripts/skills-live-check.ts';
import type { CliProcess } from '../scripts/lib/cli-process.ts';

const script=join(PROJECT_ROOT,'scripts/skills-live-check.ts');
const source=readFileSync(script,'utf8');
describe('N1-H6 independent staging and truthful skills harness cleanup',()=>{
  it('west chest stage proves dirt as well as grass, refuses occupied cells and unknown/unsupported floor without mutation',async()=>{
    const run=async(floor:string,occupied=false,unknown=false)=>{
      const commands:string[]=[];
      const promise=proveChestStage(async(c)=>{
        commands.push(c);
        if (unknown) return 'Unrecognized or incomplete reply';
        if(c.endsWith(' air')) return occupied?'Test failed':'Test passed. Count: 1';
        return c.endsWith(' '+floor)?'Test passed. Count: 1':'Test failed';
      });
      return {promise,commands};
    };
    for(const floor of ['grass_block','dirt','stone','cobblestone','stone_bricks']) {
      const r=await run(floor); assert.equal(await r.promise,floor);
      assert.ok(r.commands.every(c=>c.startsWith('execute if block')));
      assert.ok(r.commands.every(c=>!c.includes('203 -60 205')),'placed furnace cell never cleared/probed as air');
    }
    for(const args of [['dirt',true,false],['water',false,false],['dirt',false,true]] as const) {
      const r=await run(args[0],args[1],args[2]); await assert.rejects(r.promise);
      assert.ok(r.commands.every(c=>!/^setblock|^fill|^tp/.test(c)));
    }
    assert.equal(safePlacement('place furnace (up face of grass_block -> 203,-60,205)'),true);
    assert.equal(safePlacement('place furnace (up face of grass_block -> 201,-60,207)'),false);
    assert.equal(safePlacement('unknown placement'),false);
    assert.equal(entityTest('Test passed. Count: 1'),true);
    assert.equal(entityTest('Test failed'),false);
    for(const s of ['Unknown entity','Test passed maybe','Test passed. Count: 0','']) assert.throws(()=>entityTest(s));
  });
  it('exact forceload parsing refuses incomplete evidence',()=>{
    assert.deepEqual([...parseSkillsForceload('The force loaded chunks are: [12, 12], [13, 14]')],['12,12','13,14']);
    assert.equal(parseSkillsForceload('No chunks are marked for force loading').size,0);
    assert.throws(()=>parseSkillsForceload('unknown query output'));
    assert.equal(validFillReply('Successfully filled 11165 block(s)'),true);
    assert.equal(validFillReply('No blocks were filled'),true);
    assert.equal(validFillReply('That position is not loaded'),false);
    assert.equal(validFillReply('Successfully filled maybe'),false);
    for(const c of skillsSceneClearCommands()) {
      assert.match(c,/x=196,y=-64,z=190,dx=28,dy=40,dz=34/);
      assert.match(c,/tag=chunkbot_(hidden|front|animal)|type=(item|experience_orb)/);
      assert.ok(!c.includes('tag=chunkbot_safety'));
    }
  });
  it('direct exit zero is mandatory; forced kill is a failure even if later exit looks clean',async()=>{
    const commands:string[]=[];
    const p=(code:number|null,signal:NodeJS.Signals|null)=>({send:(s:string)=>{commands.push(s);return 0;},exited:Promise.resolve({code,signal}),child:{kill:()=>{throw new Error('normal exit must not kill');}}}) as unknown as Pick<CliProcess,'send'|'exited'|'child'>;
    await requireCleanCliExit(p(0,null),async()=>undefined);
    await assert.rejects(requireCleanCliExit(p(1,null),async()=>undefined));
    await assert.rejects(requireCleanCliExit(p(null,'SIGTERM'),async()=>undefined));
    let resolve!:(r:{code:number;signal:null})=>void; let killed=0;
    const pending={send:()=>0,exited:new Promise<{code:number;signal:null}>(r=>resolve=r),child:{kill:()=>{killed++;resolve({code:0,signal:null});}}} as unknown as Pick<CliProcess,'send'|'exited'|'child'>;
    await assert.rejects(requireCleanCliExit(pending,async()=>undefined),/forced/); assert.equal(killed,1);
    assert.deepEqual(commands,['/quit','/quit','/quit']);
  });
  it('missing/invalid lease is rejected before report writes/secrets/join; source retains actual interface and server-proof adverse controls',()=>{
    const dir=join(PROJECT_ROOT,'var/live-check'); const files=()=>existsSync(dir)?readdirSync(dir).sort():[];
    const before=files();
    for(const args of [[],['--fixture-lease'],['--fixture-lease','../invalid']]) {
      const p=spawnSync(process.execPath,[script,...args],{encoding:'utf8',timeout:30_000});
      assert.equal(p.status,2,p.stderr); assert.match(p.stderr,/refusing to run: pass --fixture-lease/);
    }
    assert.deepEqual(files(),before);
    assert.ok(source.indexOf('mkdirSync(outDir')>source.indexOf('async function main()'));
    assert.ok(!source.includes('const password = rconPassword()'));
    const finalizer=source.slice(source.lastIndexOf('} finally {'));
    assert.ok(finalizer.indexOf("clearOnline('Chunkbot')")<finalizer.indexOf('requireCleanCliExit(chunkbot)'));
    assert.ok(finalizer.indexOf("clearOnline('FixtureOwner')")<finalizer.indexOf('owner!.quit()'));
    for(const s of ['commandsAfterRevoke','interfaceAfterSettle','usedBeforeRevoke','destination_occupied_by_entity','originalForceload','originalSettings','zero-players','cleanup.every((s) => s.ok)']) assert.ok(source.includes(s),s);
    assert.ok(!/rcon\(['"`]\s*(?:time|gamerule \w+ (?:true|false)|difficulty (?:peaceful|easy|normal|hard))/.test(source),'no settings or clock mutation');
  });
});
