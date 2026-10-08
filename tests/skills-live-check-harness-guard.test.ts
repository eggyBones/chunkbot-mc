// N1-H6: no inference/world. Real harness staging probes over discriminating
// replies; missing/invalid lease children stop before reading fixture secrets.
import assert from 'node:assert/strict';
import { describe,it } from 'node:test';
import { existsSync,readFileSync,readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PROJECT_ROOT } from '../src/app/fixture-layout.ts';
import { assertSkillsSceneReply,entityTest,parseSkillsForceload,proveChestStage,proveFurnaceStage,requireCleanCliExit,safePlacement,skillsSceneClearCommands,skillsSceneSelector,validFillReply } from '../scripts/skills-live-check.ts';
import type { CliProcess } from '../scripts/lib/cli-process.ts';

const script=join(PROJECT_ROOT,'scripts/skills-live-check.ts');
const source=readFileSync(script,'utf8');
describe('N1-H6 independent staging and truthful skills harness cleanup',()=>{
  it('furnace staging proves the actual workstation, a free supported sight lane and no player/nonplayer occupant without changing blocks',async()=>{
    const furnace={x:201,y:-60,z:205};
    const run=(opts:{eastOccupied?:boolean;allOccupied?:boolean;floor?:string;entityOccupied?:boolean;unknown?:boolean;missingFurnace?:boolean}={})=>{
      const commands:string[]=[];
      const promise=proveFurnaceStage(async c=>{
        commands.push(c);
        if(opts.unknown) return "Option 'type' isn't applicable here";
        if(c.startsWith('execute unless entity')) return opts.entityOccupied?'Test failed':'Test passed. Count: 1';
        const m=/^execute if block (-?\d+) (-?\d+) (-?\d+) (\w+)$/.exec(c)!;
        const x=Number(m[1]),y=Number(m[2]),z=Number(m[3]),material=m[4];
        let actual='air';
        if(y===-61) actual=opts.floor??'dirt';
        if(x===201&&y===-60&&z===205&&!opts.missingFurnace) actual='furnace';
        if(y>=-60&&y<=-59&&opts.allOccupied&&!(x===201&&z===205)) actual='crafting_table';
        if(opts.eastOccupied&&x>201&&y===-60) actual='crafting_table';
        return material===actual?'Test passed. Count: 1':'Test failed';
      },furnace);
      return {commands,promise};
    };
    for(const floor of ['grass_block','dirt','stone','cobblestone','stone_bricks']) {
      const r=run({floor}); assert.deepEqual(await r.promise,{at:{x:203.5,y:-60,z:205.5},floors:[floor,floor]});
      assert.ok(r.commands.every(c=>c.startsWith('execute ')));
      assert.ok(r.commands.some(c=>c.includes('@a[name=!Chunkbot,')));
      assert.ok(r.commands.some(c=>c.includes('@e[type=!player,')));
    }
    const occupied=run({eastOccupied:true}); assert.deepEqual((await occupied.promise).at,{x:199.5,y:-60,z:205.5});
    for(const opts of [{allOccupied:true},{floor:'water'},{entityOccupied:true},{unknown:true},{missingFurnace:true}]) {
      const r=run(opts); await assert.rejects(r.promise);
      assert.ok(r.commands.every(c=>!/^setblock|^fill|^tp|^kill/.test(c)));
    }
    await assert.rejects(proveFurnaceStage(async()=>{throw new Error('must not query');},{x:195,y:-60,z:205}),/original standard scene/);
    for(const id of ['PL1','PL2']) assert.ok(source.includes(`stageVisibleFurnace(ev, '${id}', furnaceAt)`));
    assert.ok(source.includes('assert(rawDistance <= 1'));
    assert.ok(source.includes('visible?.inReach === true'));
    assert.ok(!source.includes('1.25 arrival tolerance'));
  });
  it('setup/cleanup categories use one applicable type with exact original bounds, tags cannot match players, and unknown categories/replies fail closed',()=>{
    const box='x=196,y=-64,z=190,dx=28,dy=40,dz=34';
    const expected=[...['hidden','front','animal'].map(tag=>`kill @e[type=!player,tag=chunkbot_${tag},${box}]`),`kill @e[type=item,${box}]`,`kill @e[type=experience_orb,${box}]`];
    assert.deepEqual(skillsSceneClearCommands(),expected);
    for(const c of skillsSceneClearCommands()) {
      const args=c.slice(c.indexOf('[')+1,-1).split(',');
      const types=args.filter(a=>a.startsWith('type='));
      assert.equal(types.length,1,'no inverse type followed by positive type');
      if(types[0]==='type=!player') assert.equal(args.filter(a=>a.startsWith('tag=')).length,1);
      else assert.ok(['type=item','type=experience_orb'].includes(types[0]!),'no foreign category');
    }
    for(const c of ['player','zombie','chunkbot_safety','item,type=!player','']) assert.throws(()=>skillsSceneSelector(c as never),/unknown/);
    for(const reply of ["Option 'type' isn't applicable here",'Test passed. Count: 0','Unknown entity','Test passed. Count: unknown']) assert.throws(()=>entityTest(reply));
    for(const c of [...skillsSceneClearCommands(),'fill 196 -60 190 224 -50 224 air','setblock 208 -60 202 oak_log',`execute unless entity ${skillsSceneSelector('item')}`]) {
      for(const reply of ["Option 'type' isn't applicable here",'unknown reply','', 'Test passed maybe']) assert.throws(()=>assertSkillsSceneReply(c,reply));
    }
    assert.doesNotThrow(()=>assertSkillsSceneReply(skillsSceneClearCommands()[0]!,'Killed 2 entities'));
    assert.doesNotThrow(()=>assertSkillsSceneReply(skillsSceneClearCommands()[3]!,'No entity was found'));
    assert.doesNotThrow(()=>assertSkillsSceneReply('setblock 208 -60 202 oak_log','Changed the block at 208, -60, 202'));
    assert.throws(()=>assertSkillsSceneReply('setblock 208 -60 202 oak_log','Changed the block at 203, -60, 205'));
    assert.equal((source.match(/for \(const c of skillsSceneClearCommands\(\)\)/g)??[]).length,3,'initial setup and both cleanup passes share the tested builder');
    assert.ok(source.includes('for (const s of SKILLS_SCENE_SELECTORS) assert(entityTest'));
  });
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
