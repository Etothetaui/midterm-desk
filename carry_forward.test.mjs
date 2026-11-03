import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {mergePublishedSnapshot,assertUnpublishedHistory} from './carry_forward.mjs';
const base=JSON.parse(await readFile(new URL('./data.json',import.meta.url),'utf8'));
test('first-run pending and failed deployments do not impersonate a published site',()=>{
  assert.doesNotThrow(()=>assertUnpublishedHistory([[{state:'in_progress'},{state:'queued'}],[{state:'failure'}],[]]));
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
