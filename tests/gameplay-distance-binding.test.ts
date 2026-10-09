// P-LOC-R1: actual production catalog/resolvers, PredicateEngine, executor,
// actuator lease and TaskRuntime. Only the physical bot/decision are simulated.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { SkillRuntime } from '../src/app/skill-runtime.ts';
import { PROJECT_ROOT } from '../src/app/fixture-layout.ts';
import { loadConfigFile } from '../src/config/load.ts';
import { sequentialIds, systemClock, type AdmittedTask, type DecisionPort, type TaskSpec } from '../src/contracts/index.ts';
import type { GameSession } from '../src/game/connection.ts';
import { offlinePlayerUuid } from '../src/game/identity.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { ackSequenced, evidenceFor, fakeClient, fakeMineflayerBot, vec3 } from './skill-fakes.ts';

function composition(move: boolean, noProgressMs = 1_100) {
  const client = fakeClient((name,data)=>{
    if(name==='window_click'&&data['stateId']===-1) setImmediate(()=>client.emit('window_items',{windowId:0,stateId:3,items:Array.from({length:46},()=>({itemCount:0}))}));
    ackSequenced(client,name,data);
  });
  const fake = fakeMineflayerBot(client, { dimension: 'overworld' });
  fake.fill(-20,-1,-20,20,-1,20,'grass_block');
  const uuid = offlinePlayerUuid('FixtureOwner');
  fake.bot.players['FixtureOwner'] = { uuid };
  const owner = fake.addEntity({ id:50,type:'player',name:'player',username:'FixtureOwner',uuid,height:1.8,at:{x:3.8,y:0,z:0.5} });
  const goals: unknown[] = [];
  const pathfinder = { goal:null as unknown, setMovements:(_m:unknown)=>undefined, isMoving:()=>false, setGoal(g:unknown) {
    this.goal=g;
    if (!g) return;
    goals.push(g);
    if (move) fake.bot.entity.position = vec3(1.8,0,0.5); // distance 2: inside the actual radius
  } };
  Object.assign(fake.bot, { pathfinder, clearControlStates:()=>undefined, stopDigging:()=>undefined });
  const session = { bot:fake.bot,connectionEpoch:1,evidence:evidenceFor(client) } as unknown as GameSession;
  let decisions = 0;
  const decision: DecisionPort = { readiness:()=>({ready:true,detail:'scripted only'}), choose:async(req)=> {
    decisions++;
    const id=req.candidates[0]!.id; // actual first offered option; no forced capability
    return { requestId:req.requestId,candidateId:id,confidence:1,probabilities:{[id]:1},requestedModel:'typesafe/jev-1.13',model:'typesafe/jev-1.13',provider:'TypeSafe',usage:{inputTokens:1,outputTokens:1,costUsd:0},latencyMs:0,attempts:1 };
  } };
  const config=loadConfigFile(join(PROJECT_ROOT,'config/examples/fixture-inference-free.json')).config;
  config.limits.noProgressMs=noProgressMs;
  const runtime=new SkillRuntime({config,session:()=>session,connectionEpoch:()=>1,goalEpoch:()=>1,diagnosticCurrent:()=>false,admission:()=>({serverOnlineMode:false}),store:new MemoryRunStore(),clock:systemClock,ids:sequentialIds(),decision,features:{locator:true}});
  runtime.onGoalAdmitted({goalId:'goal-0001',epoch:1,admittedAtMs:Date.now(),instruction:'arbitrary owner instruction'});
  const abort=new AbortController();
  const spec:TaskSpec={objective:'Rejoin a visible target.',decisionInstruction:'Use an offered option.',allowedCapabilities:['follow_entity','move_near','seek_owner'],targetSelectors:[{kind:'owner'}],parameters:{durationMs:1_000},completion:{predicate:'near_target',target:{kind:'owner'},within:3}};
  const task=(mode:AdmittedTask['mode']='complete'):AdmittedTask=>({goalId:'goal-0001',goalEpoch:1,taskId:'task-0001',mode,spec,signal:abort.signal,isCurrent:()=>!abort.signal.aborted});
  return {runtime,session,fake,owner,goals,abort,spec,task,decisions:()=>decisions};
}

describe('P-LOC-R1 exact distance through production finite/persistent composition',()=>{
  it('first-option follow at 3.3 away dispatches movement and completes ONLY inside the exact predicate',async()=>{
    const h=composition(true);
    const bound=await h.runtime.predicates.bind(h.spec.completion,h.abort.signal);
    assert.equal((await h.runtime.predicates.evaluate(bound,h.abort.signal)).status,'unsatisfied');
    const r=await h.runtime.tasks.run(h.task());
    assert.equal(r.status,'completed'); assert.equal(r.reason,'completion_verified');
    assert.equal(h.decisions(),1); assert.equal(r.actions,1);
    assert.ok(h.goals.length>0,'the former 3.3 dead band must write a path goal');
    assert.equal((await h.runtime.predicates.evaluate(bound,h.abort.signal)).status,'satisfied');
    assert.equal(h.runtime.leases.current,undefined);
  });
  it('predicate radius supplies defaults; wider explicit parameters refuse without mutation and unrelated predicates do not constrain the owner',()=>{
    const h=composition(false);
    h.spec.completion={predicate:'near_target',target:{kind:'owner'},within:1.5};
    let set=h.runtime.candidates.generate(h.spec,h.runtime.perception.take(1)!);
    for(const c of set.candidates.filter(c=>c.capability==='follow_entity'||c.capability==='move_near')) assert.equal(c.parameters['within'],1.5);
    assert.ok(set.candidates.some(c=>c.capability==='follow_entity'));
    h.spec.parameters={within:4,durationMs:1_000};
    set=h.runtime.candidates.generate(h.spec,h.runtime.perception.take(1)!);
    assert.equal(set.candidates.filter(c=>c.capability==='follow_entity'||c.capability==='move_near').length,0);
    assert.ok(set.unavailable.some(u=>u.reason==='distance_parameter_conflict'));
    assert.equal(h.spec.parameters['within'],4,'binding parameter retained');
    h.spec.parameters={durationMs:1_000};
    h.spec.completion={predicate:'near_target',target:{kind:'owner_destination',dimension:'overworld',at:{x:10,y:0,z:10},ownerText:'10 0 10'},within:1};
    set=h.runtime.candidates.generate(h.spec,h.runtime.perception.take(1)!);
    assert.equal(set.candidates.find(c=>c.capability==='follow_entity')?.parameters['within'],3);
  });
  for(const mode of ['complete','maintain'] as const) it(`${mode}: elapsed follow windows at a fixed unmet distance cannot reset no-progress`,async()=>{
    const h=composition(false);
    const started=Date.now();
    const r=await h.runtime.tasks.run(h.task(mode));
    assert.equal(r.status,'blocked'); assert.equal(r.reason,'no_progress');
    assert.equal(h.decisions(),1,'local windows do not refill decision authority');
    assert.ok(r.actions<=2); assert.ok(Date.now()-started<8_000);
    assert.ok(h.goals.length>0); assert.equal(h.runtime.leases.current,undefined);
  });
  it('healthy persistent follow continues locally with one decision and stop releases the same actuator',async()=>{
    const h=composition(true,700);
    const timer=setTimeout(()=>h.abort.abort(new Error('owner_stop')),2_700);
    try {
      const r=await h.runtime.tasks.run(h.task('maintain'));
      assert.equal(r.status,'cancelled'); assert.equal(h.decisions(),1);
      assert.ok(r.localContinuations>=1); assert.notEqual(r.reason,'no_progress');
      assert.equal(h.runtime.leases.current,undefined);
      assert.equal((h.fake.bot as unknown as {pathfinder:{goal:unknown}}).pathfinder.goal,null);
    } finally {clearTimeout(timer);}
  });
});
