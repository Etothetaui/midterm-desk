import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {mergePublishedSnapshot,assertUnpublishedHistory} from './carry_forward.mjs';
const base=JSON.parse(await readFile(new URL('./data.json',import.meta.url),'utf8'));
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
