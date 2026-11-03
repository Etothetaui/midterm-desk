import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {mergePublishedSnapshot,assertUnpublishedHistory} from './carry_forward.mjs';
const base=JSON.parse(await readFile(new URL('./data.json',import.meta.url),'utf8'));
test('AP announcement history survives publication independently of every vote source',()=>{
  const previous=structuredClone(base),race=previous.races.find(r=>r.id==='MI-S-regular'),candidate=race.candidates[0];
  const did='did:plc:a67zdrt4nl2tv2qojpngogbq',key='3maaaaaaaaaaa';
  const fact={raceId:race.id,candidateId:candidate.id,candidateName:candidate.name,party:candidate.party,state:race.state,office:race.office,district:race.district??null,status:'called',sourceUrl:`https://bsky.app/profile/${did}/post/${key}`,postUri:`at://${did}/app.bsky.feed.post/${key}`,cid:'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',publishedAt:'2026-11-03T23:00:00Z',observedAt:'2026-11-03T23:05:00Z'};
  previous.apPublicSource={schemaVersion:1,sourceId:'ap-public-announcements',sourceName:'AP public announcements',coverage:'partial',status:'ready',checkedAt:fact.observedAt,asOf:fact.publishedAt,identity:{did,handle:'apnews.com',verified:true},observations:{[race.id]:{...fact,history:[fact]}},catchup:{pages:1,posts:1,truncated:false},errorCode:null,retryAfterAt:null};
  const {snapshot}=mergePublishedSnapshot(base,previous);
  assert.deepEqual(snapshot.apPublicSource,previous.apPublicSource);
  assert.deepEqual(snapshot.races,base.races);
  assert.deepEqual(snapshot.nationalResultRecords,base.nationalResultRecords);
});
test('supported prior release retains reported votes during software upgrade',()=>{
  const prior=structuredClone(base);prior.version='v0.0.0-dev';const r=prior.races[0];r.results={available:true,sourceUrl:'https://example.test/official',asOf:null,status:'unofficial',votes:r.candidates.map(c=>({candidateId:c.id,votes:10})),call:null,certification:null};
  const merged=mergePublishedSnapshot(base,prior);assert.equal(merged.retained,1);assert.deepEqual(merged.snapshot.races[0].results,r.results);assert.equal(prior.version,'v0.0.0-dev');
});
test('first-run pending and failed deployments do not impersonate a published site',()=>{
  assert.doesNotThrow(()=>assertUnpublishedHistory([[{state:'in_progress'},{state:'queued'},{state:'waiting'}],[{state:'failure'}],[]]));
});
test('any earlier success or inactive state prevents missing-site reset even after a later failure',()=>{
  for(const state of ['success','inactive','unknown',null])assert.throws(()=>assertUnpublishedHistory([[{state:'failure'},{state}]]));
  assert.throws(()=>assertUnpublishedHistory([null]));
});
// Synthetic counts are confined to cloned fixtures and never written to app data.
test('retains valid published counts and correction history without replacing corrected metadata',()=>{
  const previous=structuredClone(base),current=structuredClone(base);
  const p=previous.races.find(r=>r.id==='AZ-H-01');
  p.results={available:true,sourceId:'az-official',sourceUrl:'https://azsos.gov/press',asOf:'2026-11-04T04:00:00Z',status:'unofficial',votes:p.candidates.map((c,i)=>({candidateId:c.id,votes:10+i})),call:null,certification:null,correctionHistory:[{reason:'Synthetic historical correction'}]};
  previous.resultHealth={'az-official':{status:'validated-partial',sourceAsOf:p.results.asOf}};
  const c=current.races.find(r=>r.id===p.id);c.candidates[0].name='Corrected source identity';
  const result=mergePublishedSnapshot(current,previous);
  assert.equal(result.retained,1);assert.equal(result.snapshot.races.find(r=>r.id===p.id).candidates[0].name,'Corrected source identity');assert.deepEqual(result.snapshot.races.find(r=>r.id===p.id).results,p.results);assert.equal(current.races.find(r=>r.id===p.id).results.available,false);
});
test('does not silently discard previous counts when a candidate disappears',()=>{
  const previous=structuredClone(base),current=structuredClone(base);
  const p=previous.races.find(r=>r.id==='AZ-H-01');p.results={available:true,sourceUrl:'https://azsos.gov/press',asOf:null,status:'unofficial',votes:p.candidates.map((c,i)=>({candidateId:c.id,votes:10+i})),call:null,certification:null};
  current.races.find(r=>r.id===p.id).candidates.pop();
  assert.throws(()=>mergePublishedSnapshot(current,previous),/conflicts with previously reported choices/);
});
test('rejects malformed or substituted published catalog before merging',()=>{
  const previous=structuredClone(base);const r=previous.races.find(r=>r.id==='AL-G');r.id='DE-G';r.state='DE';r.stateName='Delaware';
  assert.throws(()=>mergePublishedSnapshot(base,previous),/snapshot rejected/);
});
test('native publisher counts survive a new pre-reporting seed independently of canonical joins',()=>{const previous=structuredClone(base);const id=Object.keys(previous.nationalResultRecords)[0];previous.nationalResultRecords[id].candidates[0].votes=123;previous.nationalResultRecords[id].reported=true;const result=mergePublishedSnapshot(base,previous);assert.equal(result.snapshot.nationalResultRecords[id].candidates[0].votes,123);assert.equal(base.nationalResultRecords[id].reported,false);});
