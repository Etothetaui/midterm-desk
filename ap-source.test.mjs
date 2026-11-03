import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AP_DID,emptyAPSource,validateAPSource,refreshAPSource,apRaceObservation,apControlSummary,mergeAPSources} from './ap-source.mjs';
import {updateAPFile} from './update_ap_source.mjs';

// These are explicitly synthetic assertions, never real AP call evidence.
const NOW=Date.parse('2026-11-03T23:30:00Z');
const catalog={races:[
  {id:'MI-S-regular',office:'senate',state:'MI',stateName:'Michigan',district:null,kind:'regular',electionDate:'2026-11-03',stage:'general',seatVoting:true,candidates:[{id:'mi-a',name:'Jane Doe',party:'D'},{id:'mi-b',name:'Robert Smith',party:'R'}]},
  {id:'NY-H-07',office:'house',state:'NY',stateName:'New York',district:7,kind:'regular',electionDate:'2026-11-03',stage:'general',seatVoting:true,candidates:[{id:'ny-a',name:'Alex Test',party:'I'}]},
  {id:'PA-G',office:'governor',state:'PA',stateName:'Pennsylvania',district:null,kind:'regular',electionDate:'2026-11-03',stage:'general',seatVoting:true,candidates:[{id:'pa-a',name:'Jordan Example',party:'R'}]},
  {id:'FL-S-special',office:'senate',state:'FL',stateName:'Florida',district:null,kind:'special',electionDate:'2026-11-03',stage:'general',seatVoting:true,candidates:[{id:'fl-a',name:'Leslie Sample',party:'R'}]},
  {id:'AK-H-00',office:'house',state:'AK',stateName:'Alaska',district:0,kind:'regular',electionDate:'2026-11-03',stage:'general',seatVoting:true,candidates:[{id:'ak-a',name:'Pat Example',party:'D'}]}
]};
const goodProfile={did:AP_DID,handle:'apnews.com',verification:{verifiedStatus:'valid',verifications:[{issuer:'did:plc:z72i7hdynmk6r22z27h6tvur',isValid:true}]}};
function post(text,{time='2026-11-03T23:10:00Z',number=0,...patch}={}){
  const key='3'+'a'.repeat(11)+String.fromCharCode(97+number);
  return {post:{uri:`at://${AP_DID}/app.bsky.feed.post/${key}`,cid:'bafyreia'+'a'.repeat(45)+String.fromCharCode(97+number),author:{did:AP_DID,handle:'apnews.com'},record:{$type:'app.bsky.feed.post',text,createdAt:time},...patch}};
}
function fake(feed=[],{profile=goodProfile,pages,error}={}){
  const calls=[];const queue=pages||[{feed}];
  const fetcher=async url=>{calls.push(url);if(error)throw new Error(error);return new Response(JSON.stringify(url.includes('getProfile')?profile:queue.shift()||{feed:[]}),{status:200});};
  return {fetcher,calls};
}
async function refresh(feed,previous=emptyAPSource(),options={}){
  const mock=fake(feed,options);return refreshAPSource(catalog,previous,{fetcher:mock.fetcher,now:previous.checkedAt?Date.parse(previous.checkedAt)+120000:NOW});
}
const win='Jane Doe wins U.S. Senate race in Michigan.';

test('empty AP snapshot validates and conveys unchecked partial coverage',()=>{
  const s=emptyAPSource();assert.deepEqual(validateAPSource(s,catalog),{ok:true,errors:[]});assert.equal(s.coverage,'partial');assert.equal(s.status,'error');
});
for(const [label,text,raceId] of [
  ['senate',win,'MI-S-regular'],
  ['AP wire election to','Democrat Jane Doe wins election to the U.S. Senate in Michigan.','MI-S-regular'],
  ['party and state possessive',"BREAKING: Democrat Jane Doe wins Michigan's U.S. Senate race.",'MI-S-regular'],
  ['house',"Alex Test wins U.S. House race in New York's 7th Congressional District.",'NY-H-07'],
  ['house district implies office',"Alex Test wins New York's 7th Congressional District.",'NY-H-07'],
  ['governor','Jordan Example wins Pennsylvania governor race.','PA-G'],
  ['governor of','Jordan Example wins race for governor of Pennsylvania.','PA-G'],
  ['at large',"Pat Example wins Alaska's at-large U.S. House seat.",'AK-H-00'],
  ['special explicit','Leslie Sample wins Florida U.S. Senate special race.','FL-S-special'],
  ['own assertion with ordinary link',win+' https://apnews.com/example','MI-S-regular']
])test(`synthetic positive: ${label}`,async()=>{
  const s=await refresh([post(text)]);assert.equal(s.status,'ready');assert.equal(apRaceObservation(s,raceId)?.status,'called');assert.equal(validateAPSource(s,catalog).ok,true);assert.equal(JSON.stringify(s).includes('wins'),false);
});
for(const [label,text] of [
  ['surname alias','Doe wins U.S. Senate race in Michigan.'],
  ['wrong state','Jane Doe wins U.S. Senate race in Minnesota.'],
  ['forecast','Jane Doe likely wins U.S. Senate race in Michigan.'],
  ['conditional','If Jane Doe wins U.S. Senate race in Michigan.'],
  ['question','Jane Doe wins U.S. Senate race in Michigan?'],
  ['primary','Jane Doe wins U.S. Senate primary in Michigan.'],
  ['runoff','Jane Doe wins U.S. Senate runoff in Michigan.'],
  ['self declaration','Jane Doe declares she wins U.S. Senate race in Michigan.'],
  ['concession','Robert Smith concedes. Jane Doe wins U.S. Senate race in Michigan.'],
  ['quotation','“Jane Doe wins U.S. Senate race in Michigan.”'],
  ['historical recap','Jane Doe wins U.S. Senate race in Michigan in 2024.'],
  ['negation','Jane Doe wins U.S. Senate race in Michigan. AP has not called the race.'],
  ['unknown nominee','Jane Roe wins U.S. Senate race in Michigan.'],
  ['missing district','Alex Test wins U.S. House race in New York.'],
  ['wrong district',"Alex Test wins New York's 8th Congressional District."],
  ['special stage omitted','Leslie Sample wins Florida U.S. Senate race.'],
  ['state substring','Jane Doe wins U.S. Senate race in Michigan City.']
])test(`synthetic rejection: ${label}`,async()=>assert.deepEqual((await refresh([post(text)])).observations,{}));

test('rejects pre-close, old, and future publication times',async()=>{
  const s=await refresh([post(win,{time:'2026-11-03T22:59:59Z'}),post(win,{time:'2026-11-02T23:10:00Z',number:1}),post(win,{time:'2026-11-03T23:31:00Z',number:2})]);assert.deepEqual(s.observations,{});
});
test('accepts exactly the first poll-close instant',async()=>assert.equal((await refresh([post(win,{time:'2026-11-03T23:00:00Z'})])).observations['MI-S-regular'].status,'called'));
test('wrong DID, reply, repost, and quote never assert AP calls',async()=>{
  const impostor=post(win);impostor.post.author.did='did:plc:impostor';
  const reply=post(win);reply.post.record.reply={parent:{uri:'x'}};
  const repost=post(win);repost.reason={$type:'app.bsky.feed.defs#reasonRepost'};
  const quote=post(win);quote.post.record.embed={$type:'app.bsky.embed.record',record:{}};
  assert.deepEqual((await refresh([impostor,reply,repost,quote])).observations,{});
});
test('external-card title alone cannot call a race',async()=>{
  const p=post('Follow our election coverage.');p.post.embed={$type:'app.bsky.embed.external#view',external:{title:win}};assert.deepEqual((await refresh([p])).observations,{});
});
test('unverified, wrong handle, or incorrect issuer profiles fail closed',async()=>{
  for(const profile of [{...goodProfile,did:'did:plc:impostor'},{...goodProfile,handle:'impostor.com'},{...goodProfile,verification:{verifiedStatus:'valid',verifications:[{issuer:'did:plc:impostor',isValid:true}]}},{...goodProfile,verification:{verifiedStatus:'invalid'}}]){
    const s=await refresh([post(win)],emptyAPSource(),{profile});assert.equal(s.status,'error');assert.equal(s.errorCode,'identity-unverified');assert.deepEqual(s.observations,{});
  }
});
test('explicit matching AP withdrawal retains prior call as history',async()=>{
  const old=await refresh([post(win)]);
  const s=await refresh([post('AP withdraws its call that Jane Doe wins U.S. Senate race in Michigan.',{number:1,time:'2026-11-03T23:20:00Z'})],old);
  const o=apRaceObservation(s,'MI-S-regular');assert.equal(o.status,'retracted');assert.deepEqual(o.history.map(e=>e.status),['called','retracted']);assert.equal(apControlSummary(catalog,s).senate.calledTotal,0);
});
test('unmatched withdrawal cannot create a call or retract another candidate',async()=>{
  const retract=post('AP retracts its call that Robert Smith wins U.S. Senate race in Michigan.',{number:1,time:'2026-11-03T23:20:00Z'});
  assert.deepEqual((await refresh([retract])).observations,{});
  const old=await refresh([post(win)]);assert.equal((await refresh([retract],old)).observations['MI-S-regular'].candidateId,'mi-a');
});
test('absent/deleted announcements never rescind supported calls',async()=>{
  const old=await refresh([post(win)]);const s=await refresh([],old);assert.deepEqual(s.observations,old.observations);assert.equal(s.status,'ready');
});
test('transient and identity failures preserve last-good calls visibly',async()=>{
  const old=await refresh([post(win)]);
  for(const options of [{error:'network'},{profile:{did:'wrong'}}]){const s=await refresh([],old,options);assert.equal(s.status,'retained-error');assert.deepEqual(s.observations,old.observations);assert.equal(validateAPSource(s,catalog).ok,true);}
});
test('repeated posts are idempotent and stale snapshots cannot reset newer state',async()=>{
  const old=await refresh([post(win)]),again=await refresh([post(win),post(win)],old);assert.equal(again.observations['MI-S-regular'].history.length,1);
  assert.deepEqual(mergeAPSources(catalog,again,emptyAPSource()).observations,again.observations);
});
test('newer explicit withdrawal survives a slower browser/server merge',async()=>{
  const old=await refresh([post(win)]),withdrawn=await refresh([post('AP retracts its call that Jane Doe wins U.S. Senate race in Michigan.',{number:1,time:'2026-11-03T23:20:00Z'})],old);
  for(const pair of [[old,withdrawn],[withdrawn,old]]){const merged=mergeAPSources(catalog,...pair);assert.equal(merged.observations['MI-S-regular'].status,'retracted');assert.equal(merged.observations['MI-S-regular'].history.length,2);}
});
test('same URI/new CID explicit withdrawal is a revision even with unchanged publication time',async()=>{
  const old=await refresh([post(win)]),revision=post('AP withdraws its call that Jane Doe wins U.S. Senate race in Michigan.');revision.post.cid='bafyreia'+'b'.repeat(46);
  const s=await refresh([revision],old),observation=s.observations['MI-S-regular'];assert.equal(observation.status,'retracted');assert.equal(observation.history.length,2);assert.equal(observation.history[0].publishedAt,observation.history[1].publishedAt);assert.equal(s.status,'ready');
  for(const pair of [[old,s],[s,old]])assert.equal(mergeAPSources(catalog,...pair).observations['MI-S-regular'].status,'retracted');
});
test('ambiguous same-post edition cannot revive a withdrawn announcement',async()=>{
  const old=await refresh([post(win)]),revision=post('AP withdraws its call that Jane Doe wins U.S. Senate race in Michigan.');revision.post.cid='bafyreia'+'b'.repeat(46);
  const withdrawn=await refresh([revision],old),ambiguous=post(win);ambiguous.post.cid='bafyreia'+'c'.repeat(46);
  const s=await refresh([ambiguous],withdrawn);assert.equal(s.observations['MI-S-regular'].status,'retracted');assert.equal(s.status,'retained-error');assert.equal(s.errorCode,'revision-ambiguous');
});
test('known AP post edited to unclassified text retains history with revision uncertainty',async()=>{
  const old=await refresh([post(win)]),revision=post('AP is reviewing an earlier election report.');revision.post.cid='bafyreia'+'b'.repeat(46);
  const source=await refresh([revision],old);assert.deepEqual(source.observations,old.observations);assert.equal(source.status,'retained-error');assert.equal(source.errorCode,'revision-ambiguous');assert.equal(source.observations['MI-S-regular'].history.length,1);assert.equal(validateAPSource(source,catalog).ok,true);
});
test('success and failure cooldowns avoid repeated manual/timer network bursts',async()=>{
  const good=await refresh([]),mock=fake([post(win)]);
  assert.deepEqual(await refreshAPSource(catalog,good,{fetcher:mock.fetcher,now:NOW+59000}),good);assert.equal(mock.calls.length,0);
  const bad=await refresh([],emptyAPSource(),{error:'network'}),badMock=fake([]);
  assert.deepEqual(await refreshAPSource(catalog,bad,{fetcher:badMock.fetcher,now:NOW+119000}),bad);assert.equal(badMock.calls.length,0);
  assert.equal(mergeAPSources(catalog,null,null).status,'error');
});
test('HTTP429 retains bounded Retry-After seconds/date and prevents premature retry',async()=>{
  for(const [header,delay] of [['600',600000],[new Date(NOW+900000).toUTCString(),900000],['999999999999',86400000],['bad',120000]]){
    let calls=0;const fetcher=async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':header}});};
    const s=await refreshAPSource(catalog,emptyAPSource(),{fetcher,now:NOW});assert.equal(s.status,'error');assert.equal(s.errorCode,'rate-limited');assert.equal(Date.parse(s.retryAfterAt),NOW+delay);assert.equal(validateAPSource(s,catalog).ok,true);
    const retained=await refreshAPSource(catalog,s,{fetcher,now:NOW+delay-1});assert.deepEqual(retained,s);assert.equal(calls,1);
  }
});
test('HTTP429 keeps existing zero-vote-independent AP call and preserves retry metadata',async()=>{
  const old=await refresh([post(win)]); // No vote field or numerical lead required.
  const s=await refreshAPSource(catalog,old,{fetcher:async()=>new Response('',{status:429,headers:{'Retry-After':'600'}}),now:NOW+120000});assert.equal(s.status,'retained-error');assert.equal(s.errorCode,'rate-limited');assert.deepEqual(s.observations,old.observations);assert.equal(s.retryAfterAt,'2026-11-03T23:42:00.000Z');
});
test('newer browser call is not wiped by a later zero-call published snapshot',async()=>{
  const browser=await refresh([post(win)]),published=await refreshAPSource(catalog,emptyAPSource(),{fetcher:fake([]).fetcher,now:NOW+60000});assert.equal(mergeAPSources(catalog,browser,published).observations['MI-S-regular'].status,'called');
});
test('older feed does not overwrite a newer candidate observation',async()=>{
  const old=await refresh([post(win)]),newer=await refresh([post('Robert Smith wins U.S. Senate race in Michigan.',{number:1,time:'2026-11-03T23:20:00Z'})],old);
  assert.equal((await refresh([post(win)],newer)).observations['MI-S-regular'].candidateId,'mi-b');
});
test('duplicate or primary catalog identities cannot generate a call',async()=>{
  for(const races of [[{...catalog.races[0],stage:'primary'}],[catalog.races[0],{...catalog.races[0],id:'MI-S-other'}]]){
    const s=await refreshAPSource({races},emptyAPSource(),{fetcher:fake([post(win)]).fetcher,now:NOW});assert.deepEqual(s.observations,{});
  }
});
test('unsafe source URL, CID, identity, unknown keys, and prototype injection rejected',async()=>{
  const good=await refresh([post(win)]);
  for(const change of [s=>s.observations['MI-S-regular'].sourceUrl='javascript:alert(1)',s=>s.observations['MI-S-regular'].cid='bad',s=>s.observations['MI-S-regular'].candidateId='unknown',s=>s.observations['MI-S-regular'].text=win,s=>s.identity.did='wrong',s=>s.observations=Object.create({inherited:good.observations['MI-S-regular']})]){
    const s=structuredClone(good);change(s);assert.equal(validateAPSource(s,catalog).ok,false);
  }
  const poisoned=JSON.parse(JSON.stringify(good));poisoned.observations.__proto__={};assert.equal(validateAPSource(poisoned,catalog).ok,false);
  assert.equal(apRaceObservation(good,'__proto__'),null);
});
test('tampered prior snapshot is rejected before network access',async()=>{
  const prior=emptyAPSource();prior.observations={bad:{}};const mock=fake([]);await assert.rejects(refreshAPSource(catalog,prior,{fetcher:mock.fetcher,now:NOW}),/rejected/);assert.equal(mock.calls.length,0);
});
test('three-page catchup limit is explicit and fetch URLs stay on public host',async()=>{
  const mock=fake([],{pages:[{feed:[post('Unrelated news.')],cursor:'next-a'},{feed:[post('More news.')],cursor:'next-b'},{feed:[post('Still news.')],cursor:'next-c'}]});
  const s=await refreshAPSource(catalog,emptyAPSource(),{fetcher:mock.fetcher,now:NOW});assert.equal(s.catchup.pages,3);assert.equal(s.catchup.truncated,true);assert.ok(mock.calls.every(url=>url.startsWith('https://public.api.bsky.app/xrpc/')));
});
test('old pages stop catchup, malformed pages and repeated cursors fail safely',async()=>{
  const oldMock=fake([],{pages:[{feed:[post('Old news.',{time:'2026-11-03T21:00:00Z'})],cursor:'older'}]});
  const s=await refreshAPSource(catalog,emptyAPSource(),{fetcher:oldMock.fetcher,now:NOW});assert.equal(s.catchup.pages,1);assert.equal(s.catchup.truncated,false);
  for(const pages of [[{feed:{}}],[{feed:[],cursor:'same'},{feed:[],cursor:'same'}]]){const bad=await refreshAPSource(catalog,emptyAPSource(),{fetcher:fake([],{pages}).fetcher,now:NOW});assert.equal(bad.status,'error');}
});
test('party counts include supported voting seats only and fail closed on invalid source',async()=>{
  const source=await refresh([post(win),post('Jordan Example wins Pennsylvania governor race.',{number:1})]);
  const summary=apControlSummary(catalog,source);assert.equal(summary.senate.called.D,1);assert.equal(summary.senate.unallocated,1);assert.equal(summary.governor.called.R,1);
  const invalid=structuredClone(source);invalid.observations['MI-S-regular'].party='R';assert.equal(apControlSummary(catalog,invalid).senate.calledTotal,0);
});
test('real saved AP public feed produces zero premature calls (offline evidence check)',async t=>{
  let real;try{real=JSON.parse(await readFile(new URL('../../../work/ap-bluesky-public-feed.json',import.meta.url),'utf8'));}catch{t.skip('Local research capture unavailable.');return;}
  const data=JSON.parse(await readFile(new URL('./data.json',import.meta.url),'utf8'));
  const s=await refreshAPSource(data,emptyAPSource(),{fetcher:fake([],{pages:[real]}).fetcher,now:Date.parse('2026-11-03T22:00:00Z')});assert.equal(s.status,'ready');assert.deepEqual(s.observations,{});assert.equal(s.catchup.posts,real.feed.length);
});
test('CLI file update changes only apPublicSource and validates the delivered JSON',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'ap-source-test-'));
  try{
    const input=join(folder,'input.json'),output=join(folder,'output.json'),original={...catalog,sourcePayload:{votes:[0,12],status:'preserve',nullable:null},version:'v0.1.1-dev'};
    await writeFile(input,JSON.stringify(original));await updateAPFile(input,output,{fetcher:fake([post(win)]).fetcher,now:NOW});
    const delivered=JSON.parse(await readFile(output,'utf8')),{apPublicSource,...other}=delivered;assert.deepEqual(other,original);assert.equal(validateAPSource(apPublicSource,delivered).ok,true);assert.equal(apPublicSource.observations['MI-S-regular'].status,'called');
  }finally{await rm(folder,{recursive:true,force:true});}
});
