import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {describeUpdates} from './news-ticker.mjs';
const data=JSON.parse(await readFile(new URL('./data.json',import.meta.url),'utf8'));
const state=(catalog=data,extra={})=>({catalog,analysis:null,apSource:catalog.apPublicSource,...extra});
const changed=()=>{const d=structuredClone(data);d.snapshotId='synthetic-ticker-update';return d;};
test('initial state and unchanged checks are silent',()=>{
  assert.deepEqual(describeUpdates(null,state()),[]);
  assert.deepEqual(describeUpdates(state(),state()),[]);
  const next=structuredClone(data);next.apPublicSource.checkedAt='2026-11-03T22:00:00Z';
  assert.deepEqual(describeUpdates(state(),state(next)),[]);
});
test('new publication without changed votes is explicitly labeled',()=>{
  const events=describeUpdates(state(),state(changed()));
  assert.equal(events.length,1);assert.match(events[0].text,/no changed vote totals or publisher calls/);
});
test('reported counts retain their source and do not manufacture a winner',()=>{
  const d=changed(),r=d.races.find(r=>r.id==='AZ-H-01');r.results={available:true,status:'unofficial',sourceUrl:'https://azsos.gov/',votes:r.candidates.map((c,i)=>({candidateId:c.id,votes:i===0?20:i===1?15:0}))};
  const events=describeUpdates(state(),state(d));assert.equal(events.length,1);assert.match(events[0].text,/Source-reported returns/);assert.match(events[0].text,/35/);assert.doesNotMatch(events[0].text,/winner|projects/);
  const correction=structuredClone(d);correction.snapshotId='synthetic-lower-correction';correction.races.find(row=>row.id===r.id).results.votes[0].votes=10;
  // A decreasing total is still an update; it is never described as new votes.
  const e=describeUpdates(state(d),state(correction));assert.ok(e.some(e=>e.text.includes('25')));
});
test('zero/pre-reporting native templates never become election results or calls',()=>{
  const d=changed();Object.values(d.nationalResultRecords)[0].sourceCallStatus='called';
  const events=describeUpdates(state(),state(d));assert.equal(events.length,1);assert.match(events[0].text,/no changed vote totals/);
});
test('native positive returns and candidate revisions stay separately attributed',()=>{
  const d=changed(),[id,n]=Object.entries(d.nationalResultRecords)[0];n.reported=true;n.candidates[0].votes=123;
  d.races.find(r=>r.id===id).candidates[0].name='Synthetic revised candidate';
  const events=describeUpdates(state(),state(d));assert.ok(events.some(e=>/civicAPI returns/.test(e.text)));assert.ok(events.some(e=>/Candidate field revised/.test(e.text)));assert.ok(events.every(e=>!e.text.includes('named winner')));
});
test('AP heartbeat changes are silent and real failure/recovery is a connection notice',()=>{
  const before=state(),after={...before,apSource:{...before.apSource,status:'error',checkedAt:'2026-11-03T22:00:00Z',errorCode:'fetch-failed'}};
  const events=describeUpdates(before,after);assert.equal(events.length,1);assert.match(events[0].text,/check unavailable/);assert.doesNotMatch(events[0].text,/uncalled|withdrew/);
  assert.match(describeUpdates(after,before)[0].text,/connection recovered/);
});
test('AP observations include original source and never duplicate a later publication',()=>{
  const r=data.races.find(r=>r.id==='MI-S-regular'),c=r.candidates[0],did='did:plc:a67zdrt4nl2tv2qojpngogbq',key='3maaaaaaaaaaa';
  const fact={raceId:r.id,candidateId:c.id,candidateName:c.name,party:c.party,state:r.state,office:r.office,district:r.district??null,status:'called',sourceUrl:`https://bsky.app/profile/${did}/post/${key}`,postUri:`at://${did}/app.bsky.feed.post/${key}`,cid:'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',publishedAt:'2026-11-03T23:00:00Z',observedAt:'2026-11-03T23:05:00Z'};
  const source={...data.apPublicSource,checkedAt:fact.observedAt,asOf:fact.publishedAt,observations:{[r.id]:{...fact,history:[fact]}}};
  const before=state(),after=state(data,{apSource:source});
  const events=describeUpdates(before,after);assert.equal(events.length,1);assert.match(events[0].text,/AP public announcement/);assert.match(events[0].text,/partial/);assert.equal(events[0].url,fact.sourceUrl);
  const publication=state(structuredClone(data),{apSource:structuredClone(source)});assert.deepEqual(describeUpdates(after,publication),[]);
  const withdrawal=structuredClone(after),o=withdrawal.apSource.observations[r.id];o.status='retracted';o.cid='bafyreicccccccccccccccccccccccccccccccccccccccccccccccccccc';o.observedAt='2026-11-03T23:06:00Z';withdrawal.apSource.checkedAt=o.observedAt;const{history,...retracted}=o;o.history.push(retracted);
  assert.match(describeUpdates(after,withdrawal)[0].text,/AP publicly withdrew/);
});
test('supported civicAPI projections and explicit withdrawals produce distinct headlines',()=>{
  const d=changed(),r=d.races.find(r=>r.id==='AZ-H-01'),n=d.nationalResultRecords[r.id];
  n.reported=true;n.stage='general';n.catalogStage='general';n.electionDate='2026-11-03';n.asOf='2026-11-03T23:00:00Z';n.sourceCallStatus='called';
  n.candidates.forEach((c,i)=>{c.votes=i?49:51;c.sourceWinnerFlag=i===0;});const winner=n.candidates[0];
  n.sourceCall={candidateSourceId:winner.sourceId,name:winner.name,party:winner.party,sourceName:'civicAPI decision desk',sourceUrl:n.sourceUrl,asOf:n.asOf,firstObservedAt:'2026-11-03T23:01:00Z',calledAt:null,certification:null};
  const events=describeUpdates(state(),state(d));assert.match(events[0].text,/civicAPI projects/);assert.match(events[0].text,/not certification/);
  const next=structuredClone(d);next.snapshotId='synthetic-withdrawal';next.nationalResultRecords[r.id].sourceCallStatus='retracted';next.nationalResultRecords[r.id].sourceCall=null;
  assert.match(describeUpdates(state(d),state(next))[0].text,/withdrew its projection/);
  next.nationalResultRecords[r.id].sourceCallStatus='retained-unknown';
  const unknown=describeUpdates(state(d),state(next));assert.match(unknown[0].text,/needs review/);assert.ok(unknown.every(e=>!e.text.includes('withdrew')));
});
test('poll/forecast refresh is distinguishable from a changed model estimate',()=>{
  const a={generatedAt:'2026-11-03T20:00:00Z',source:{name:'Polling Forecast',url:'https://www.pollingforecast.com/'},races:{r:{forecast:{chanceLeft:.5},polls:[]}},national:{summary:{seats:240}}};
  const before=state(data,{analysis:a}),fresh=state(data,{analysis:{...a,generatedAt:'2026-11-03T21:00:00Z'}});
  assert.match(describeUpdates(before,fresh)[0].text,/no changed estimates/);
  const b=structuredClone(fresh);b.analysis.races.r.forecast.chanceLeft=.6;
  assert.match(describeUpdates(fresh,b)[0].text,/1 race estimates/);assert.match(describeUpdates(fresh,b)[0].text,/estimates are not calls/);
});
