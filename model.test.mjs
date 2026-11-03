import test from 'node:test';
import assert from 'node:assert/strict';
import {VERSION,PARTY_ORDER,createState,reducer,visibleRaces,selectedRace,selectedOutOfFilter,sanitizePreferences,scenarioTotals,summarizeCoverage,validateSnapshot,safeSourceUrl,formatNumber,marginLabel,partyName} from './model.mjs';

// Entirely synthetic fixtures: no value here is an actual election result.
const candidate = (id, name = 'José Example', party = 'D') => ({id,name,party,incumbent:false,receipts:null,cash:0,financeAsOf:null});
const race = (id, office = 'house', state = 'AL', extra = {}) => ({id,office,state,stateName:state === 'AL' ? 'Alabama' : state,district:1,kind:'regular',electionDate:'2026-11-03',stage:'general',nextElectionDate:null,seatVoting:true,candidates:[candidate(`${id}-D`),candidate(`${id}-R`,'Other Example','R')],incumbentParty:null,rating:null,priorMargin:null,results:{available:false,sourceUrl:'https://example.test/results',asOf:null,status:'unofficial',votes:[],call:null,certification:null},polls:[],sources:[{title:'Synthetic fixture source',url:'https://example.test/ballot',kind:'synthetic'}],metadataVerification:'synthetic fixture',stageNote:'Synthetic fixture',...extra});
function snapshot(races = [race('AL-H-1')], id = 'synthetic-1', extra = {}) {
  return {schemaVersion:1,version:VERSION,snapshotId:id,generatedAt:'2026-11-03T12:00:00Z',sourceAsOf:null,sources:[],nationalPolls:[],races,coverage:{houseRegular:races.filter(r=>r.office==='house'&&r.kind==='regular'&&r.seatVoting).length,houseDelegates:races.filter(r=>r.office==='house'&&r.kind==='delegate').length,senate:races.filter(r=>r.office==='senate').length,governorStates:races.filter(r=>r.office==='governor'&&!['GU','MP','VI'].includes(r.state)).length,governorTerritories:races.filter(r=>r.office==='governor'&&['GU','MP','VI'].includes(r.state)).length,missing:[],notes:['Synthetic test only'],detailReady:true},...extra};
}
const action = (state,type,fields={}) => reducer(state,{type,...fields});
const syntheticPoll = () => ({id:'synthetic-poll',pollster:'Synthetic survey',startDate:'2026-02-28',endDate:'2026-03-01',publishedAt:'2026-03-02',population:'LV',sampleSize:null,sampleBasis:null,dem:52,rep:42,other:null,undecided:5,interval:null,sourceUrl:'https://example.test/synthetic-poll',corrections:[]});

// Independent synthetic national fixture oracle. The geography is the 2026
// register; candidate names, finance and results are deliberately fictional.
// Do not import production data or the model's expected-set constants here.
function nationalFixture() {
  const apportionment = {AL:7,AK:1,AZ:9,AR:4,CA:52,CO:8,CT:5,DE:1,FL:28,GA:14,HI:2,ID:2,IL:17,IN:9,IA:4,KS:4,KY:6,LA:6,ME:2,MD:8,MA:9,MI:13,MN:8,MS:4,MO:8,MT:2,NE:3,NV:4,NH:2,NJ:12,NM:3,NY:26,NC:14,ND:1,OH:15,OK:5,OR:6,PA:17,RI:2,SC:7,SD:1,TN:9,TX:38,UT:4,VT:1,VA:11,WA:10,WV:2,WI:8,WY:1};
  const races = [];
  for (const [state,n] of Object.entries(apportionment)) for (let i=1;i<=n;i++) {
    const district = n===1 ? 0 : i;
    races.push(race(`${state}-H-${String(district).padStart(2,'0')}`,'house',state,{district}));
  }
  for (const state of ['AS','DC','GU','MP','VI']) races.push(race(`${state}-H-00`,'house',state,{district:0,kind:'delegate',seatVoting:false}));
  for (const state of ['AK','AL','AR','CO','DE','GA','IA','ID','IL','KS','KY','LA','MA','ME','MI','MN','MS','MT','NC','NE','NH','NJ','NM','OK','OR','RI','SC','SD','TN','TX','VA','WV','WY']) races.push(race(`${state}-S-regular`,'senate',state,{district:null,seatId:`${state}-S-class2`,senateClass:2}));
  for (const state of ['FL','OH']) races.push(race(`${state}-S-special`,'senate',state,{district:null,kind:'special',seatId:`${state}-S-class3`,senateClass:3}));
  for (const state of ['AK','AL','AR','AZ','CA','CO','CT','FL','GA','HI','IA','ID','IL','KS','MA','MD','ME','MI','MN','NE','NH','NM','NV','NY','OH','OK','OR','PA','RI','SC','SD','TN','TX','VT','WI','WY','GU','MP','VI']) races.push(race(`${state}-G`,'governor',state,{district:null,seatVoting:!['GU','MP','VI'].includes(state)}));
  const result = snapshot(races,'synthetic-national-514');
  result.coverage.detailReady = races.length;
  return result;
}

test('initial schema distinguishes unavailable from true zero and snapshots are isolated', () => {
  const input = snapshot();
  assert.equal(validateSnapshot(input).ok,true);
  const state = createState(input);
  input.races[0].candidates[0].name = 'Mutated outside';
  assert.equal(selectedRace(state).candidates[0].name,'José Example');
  assert.equal(selectedRace(state).candidates[0].receipts,null);
  assert.equal(selectedRace(state).candidates[0].cash,0);
  const zero = snapshot([race('zero','house','AL',{results:{available:true,sourceUrl:'https://example.test/results',asOf:null,votes:[{candidateId:'zero-D',votes:0}],call:null,certification:null}})]);
  assert.equal(validateSnapshot(zero).ok,true);
  zero.races[0].results.votes[0].votes = null;
  assert.equal(validateSnapshot(zero).ok,false);
});

test('duplicate contest/candidate/House seat identity and bad count metadata are rejected', () => {
  for (const data of [snapshot([race('same'),race('same')]),snapshot([race('one'),race('two')]),snapshot([race('one','house','AL',{candidates:[candidate('same'),candidate('same')]})])]) assert.equal(validateSnapshot(data).ok,false);
  const data = snapshot(); data.coverage.houseRegular = 435;
  assert.equal(validateSnapshot(data).ok,false);
  assert.throws(()=>createState(data),/Invalid initial snapshot/);
});

test('invalid finance, negative returns and unsafe source URLs are rejected without trusting freshness', () => {
  const data = snapshot();
  data.races[0].candidates[0].receipts = NaN;
  assert.equal(validateSnapshot(data).ok,false);
  data.races[0].candidates[0].receipts = null;
  data.races[0].sources[0].url = 'javascript:alert(1)';
  assert.equal(validateSnapshot(data).ok,false);
  const negative = snapshot([race('bad','house','AL',{results:{available:true,sourceUrl:null,asOf:null,votes:[{candidateId:'bad-D',votes:-1}]}})]);
  assert.equal(validateSnapshot(negative).ok,false);
});

test('search handles Unicode, district aliases, tokens and empty query', () => {
  let state = createState(snapshot([race('AL-H-1'),race('AL-H-2','house','AL',{district:2})]));
  state = action(state,'SET_QUERY',{value:'jose al-01'});
  assert.deepEqual(visibleRaces(state).map(r=>r.id),['AL-H-1']);
  state = action(state,'SET_QUERY',{value:'[nothing]'});
  assert.equal(visibleRaces(state).length,0);
  state = action(state,'SET_QUERY',{value:'   '});
  assert.equal(visibleRaces(state).length,2);
});

test('all views retain selected identity with an explicit out-of-filter selector', () => {
  let state = createState(snapshot([race('house'),race('senate','senate','OH',{district:null,seatId:'OH-S-3'})]));
  state = action(state,'SET_OFFICE',{value:'senate'});
  assert.equal(selectedRace(state).id,'house');
  assert.equal(selectedOutOfFilter(state),true);
  assert.deepEqual(visibleRaces(state).map(r=>r.id),['senate']);
  state = action(state,'SELECT_RACE',{id:'senate'});
  assert.equal(selectedOutOfFilter(state),false);
  assert.strictEqual(action(state,'SELECT_RACE',{id:'absent'}),state);
  state = action(state,'RESET_FILTERS');
  assert.equal(selectedRace(state).id,'senate');
});

test('watchlist and competitive filtering never fabricate a rating', () => {
  let state = createState(snapshot([race('unrated'),race('rated','house','AL',{district:2,rating:{label:'Lean D',source:'Synthetic',url:'https://example.test/rating',asOf:'2026-11-01'}})]));
  state = action(state,'TOGGLE_COMPETITIVE');
  assert.deepEqual(visibleRaces(state).map(r=>r.id),['rated']);
  state = action(state,'TOGGLE_WATCH',{id:'rated'});
  state = action(state,'TOGGLE_WATCH_ONLY');
  assert.equal(visibleRaces(state).length,1);
  state = action(state,'TOGGLE_WATCH',{id:'rated'});
  assert.equal(visibleRaces(state).length,0);
  assert.deepEqual(action(state,'TOGGLE_WATCH',{id:'missing'}).watchlist,[]);
});

test('candidate correction updates all selectors while preferences remain outside source state', () => {
  let state = createState(snapshot(),{watchlist:['AL-H-1'],selectedId:'AL-H-1',filters:{state:'AL'}});
  state = action(state,'SET_SCENARIO',{id:'AL-H-1',party:'R'});
  const corrected = snapshot(undefined,'synthetic-correction');
  corrected.races[0].candidates[0].name = 'Corrected Name';
  state = action(state,'RECEIVE_SNAPSHOT',{snapshot:corrected});
  assert.equal(selectedRace(state).candidates[0].name,'Corrected Name');
  assert.equal(visibleRaces(state)[0].candidates[0].name,'Corrected Name');
  assert.deepEqual(state.watchlist,['AL-H-1']);
  assert.equal(state.scenario.assignments['AL-H-1'],'R');
  assert.equal(corrected.races[0].results.available,false);
});

test('two paused updates, invalid newer update, and resume retain latest validated snapshot', () => {
  let state = action(createState(snapshot()),'PAUSE');
  state = action(state,'RECEIVE_SNAPSHOT',{snapshot:snapshot(undefined,'synthetic-2')});
  state = action(state,'RECEIVE_SNAPSHOT',{snapshot:snapshot(undefined,'synthetic-3')});
  const invalid = snapshot(undefined,'synthetic-4'); invalid.races[0].candidates = [];
  state = action(state,'RECEIVE_SNAPSHOT',{snapshot:invalid});
  assert.equal(state.snapshot.snapshotId,'synthetic-1');
  assert.equal(state.pendingSnapshot.snapshotId,'synthetic-3');
  assert.equal(state.updatedAvailable,true);
  assert.equal(state.fetch.status,'error');
  state = action(state,'RESUME');
  assert.equal(state.snapshot.snapshotId,'synthetic-3');
  assert.equal(state.paused,false);
  assert.equal(state.pendingSnapshot,null);
  assert.equal(state.updatedAvailable,false);
  assert.equal(state.fetch.status,'error');
});

test('legitimate downward correction and unknown source time are accepted', () => {
  const initial = snapshot([race('count','house','AL',{results:{available:true,sourceUrl:'https://example.test',asOf:'2026-11-03T14:00:00Z',votes:[{candidateId:'count-D',votes:100}]}})]);
  let state = createState(initial);
  const corrected = structuredClone(initial); corrected.snapshotId = 'synthetic-downward'; corrected.races[0].results.votes[0].votes = 95;
  corrected.races[0].results.asOf = '2026-11-03T13:59:00Z';
  state = action(state,'RECEIVE_SNAPSHOT',{snapshot:corrected});
  assert.equal(selectedRace(state).results.votes[0].votes,95);
  assert.equal(state.snapshot.sourceAsOf,null);
});

test('removed races prune preferences and deterministically replace missing selection', () => {
  const first = race('first'), second = race('second','house','AL',{district:2});
  let state = createState(snapshot([first,second]),{watchlist:['first','second'],selectedId:'first',scenario:{assignments:{first:'D',second:'R'}}});
  state = action(state,'RECEIVE_SNAPSHOT',{snapshot:snapshot([second],'synthetic-removal')});
  assert.equal(state.selectedId,'second');
  assert.deepEqual(state.watchlist,['second']);
  assert.deepEqual(state.scenario.assignments,{second:'R'});
});

test('preferences reject corrupt/oversized values, unknown IDs and prototype properties', () => {
  const data = snapshot();
  for (const raw of ['{broken',null,Array(3),'x'.repeat(100001)]) assert.deepEqual(sanitizePreferences(raw,data).watchlist,[]);
  const preferences = sanitizePreferences('{"__proto__":{"polluted":true},"watchlist":["AL-H-1","AL-H-1","missing"],"filters":{"office":"president","state":"XX","watchOnly":"yes"},"scenario":{"assignments":{"missing":"D","AL-H-1":"INVALID"}}}',data);
  assert.deepEqual(preferences.watchlist,['AL-H-1']);
  assert.equal(preferences.filters.office,'all');
  assert.equal(preferences.filters.state,'all');
  assert.equal(preferences.filters.watchOnly,false);
  assert.deepEqual(preferences.scenario.assignments,{});
  assert.equal({}.polluted,undefined);
});

test('safe source URLs permit ordinary verified-source hosts but reject executable and credential URLs', () => {
  for (const url of ['https://www.sos.alabama.gov/ballot.pdf','https://www.nga.org/governors/elections/','https://example.com/poll?a=1']) assert.ok(safeSourceUrl(url));
  for (const url of ['javascript:alert(1)','data:text/html,x','http://example.com','https://user:pass@example.com','//example.com','not a url','https://example.com/\nattack']) assert.equal(safeSourceUrl(url),null);
});

test('House scenario ignores delegates and same-seat specials and conserves admitted seats', () => {
  const races = [race('regular'),race('special','house','AL',{kind:'special'}),race('delegate','house','GU',{kind:'delegate',seatVoting:false,district:null})];
  let state = createState(snapshot(races));
  state = action(state,'SET_SCENARIO',{id:'regular',party:'D'});
  state = action(state,'SET_SCENARIO',{id:'special',party:'R'});
  state = action(state,'SET_SCENARIO',{id:'delegate',party:'R'});
  const totals = scenarioTotals(state,'house');
  assert.equal(totals.total,1); assert.equal(totals.D,1); assert.equal(totals.R,0);
  assert.equal(totals.D+totals.R+totals.I+totals.OTHER+totals.unassigned,totals.total);
  assert.equal(totals.majority,null);
  assert.equal(totals.baselineKnown,false);
  assert.equal(selectedRace(state).results.available,false);
});

test('Senate scenario deduplicates same-seat terms, and never fabricates unverified carryover', () => {
  const races = [race('regular','senate','OH',{district:null,seatId:'OH-S-3'}),race('special','senate','OH',{district:null,kind:'special',seatId:'OH-S-3'})];
  let state = createState(snapshot(races));
  state = action(state,'SET_SCENARIO',{id:'regular',party:'R'});
  state = action(state,'SET_SCENARIO',{id:'special',party:'D'});
  const partial = scenarioTotals(state,'senate');
  assert.equal(partial.total,1); assert.equal(partial.R,1); assert.equal(partial.D,0);
  assert.equal(partial.majority,null); assert.equal(partial.baselineKnown,false);
  const verified = snapshot(races,'synthetic-carry',{senateCarryover:{D:49,R:49,I:1,verified:true,sources:[{url:'https://example.test/baseline'}]}});
  assert.equal(validateSnapshot(verified).ok,true);
  state = action(state,'RECEIVE_SNAPSHOT',{snapshot:verified});
  const full = scenarioTotals(state,'senate');
  assert.equal(full.total,100); assert.equal(full.majority,51); assert.equal(full.baselineKnown,true);
  assert.equal(full.D+full.R+full.I+full.OTHER+full.unassigned,100);
});

test('governor scenarios keep territories separate, group other parties and reset cleanly', () => {
  let state = createState(snapshot([race('state','governor','AL',{district:null}),race('territory','governor','GU',{district:null})]));
  state = action(state,'SET_SCENARIO',{id:'state',party:'L'});
  state = action(state,'SET_SCENARIO',{id:'territory',party:'D'});
  let totals = scenarioTotals(state,'governor');
  assert.equal(totals.total,1); assert.equal(totals.OTHER,1); assert.equal(totals.byParty.L,1);
  assert.equal(totals.territories.total,1); assert.equal(totals.territories.D,1);
  assert.equal(totals.majority,null);
  state = action(state,'RESET_SCENARIO'); totals = scenarioTotals(state,'governor');
  assert.equal(totals.unassigned,1); assert.equal(totals.territories.unassigned,1);
});

test('coverage separates complete catalog readiness from returns and fixture counts', () => {
  const summary = summarizeCoverage(snapshot());
  assert.equal(summary.counts.houseRegular,1);
  assert.equal(summary.complete,false);
  assert.equal(summary.resultsAvailable,0);
  assert.equal(summary.pollsAvailable,0);
  assert.equal(summary.expected.houseRegular,435);
});

test('formatting preserves unknown versus zero and stable party labels', () => {
  assert.equal(formatNumber(null),'—'); assert.equal(formatNumber(undefined),'—'); assert.equal(formatNumber(NaN),'—');
  assert.equal(formatNumber(0),'0'); assert.equal(formatNumber(1234),'1,234');
  assert.equal(marginLabel(null),'Unavailable'); assert.equal(marginLabel(0),'Even');
  assert.equal(marginLabel(-2.25),'R +2.3'); assert.equal(marginLabel(3),'D +3');
  assert.equal(partyName('D'),'Democratic'); assert.equal(partyName('unknown'),'Other');
  assert.equal(partyName('constructor'),'Other');
  assert.deepEqual(PARTY_ORDER,['D','R','I','L','G','OTHER']);
});

test('ready-record counts and signed source finance remain distinct from nonnegative vote counts', () => {
  const data = snapshot();
  data.coverage.detailReady = 1;
  data.races[0].candidates[0].cash = -123.45;
  data.races[0].candidates[0].receipts = -20;
  assert.equal(validateSnapshot(data).ok,true);
  assert.equal(createState(data).snapshot.races[0].candidates[0].cash,-123.45);
  assert.equal(summarizeCoverage(data).detailReadyCount,1);
  data.coverage.detailReady = 2;
  assert.equal(validateSnapshot(data).ok,false);
  const prototypeId = snapshot([race('__proto__')]);
  assert.equal(validateSnapshot(prototypeId).ok,false);
});

test('strict production admission accepts exact synthetic national register but default allows partial fixtures', () => {
  const complete = nationalFixture();
  assert.equal(complete.races.length,514);
  assert.deepEqual(validateSnapshot(complete,{requireCompleteCatalog:true}),{ok:true,errors:[]});
  const summary = summarizeCoverage(complete);
  assert.equal(summary.structuralCatalogComplete,true);
  assert.equal(summary.complete,summary.structuralCatalogComplete);
  assert.equal(summary.candidateInventoryCount,514);
  assert.equal(summary.detailReadyCount,514);
  assert.equal(summary.candidateCount,1028);
  assert.equal(validateSnapshot(snapshot()).ok,true);
  assert.equal(validateSnapshot(snapshot(),{requireCompleteCatalog:true}).ok,false);
});

test('equal-count governor and Senate replacements cannot impersonate the required contest set', () => {
  for (const [original,replacement,newState,expectedMissing] of [['AL-G','DE-G','DE','AL-G'],['NC-S-regular','CA-S-regular','CA','NC-S-regular']]) {
    const data = nationalFixture();
    const target = data.races.find(r=>r.id===original);
    target.id = replacement; target.state = newState; target.stateName = `Synthetic ${newState}`;
    if (target.office==='senate') target.seatId = `${newState}-S-class2`;
    assert.equal(validateSnapshot(data).ok,true,'Permissive validation checks shape, not complete geography.');
    const strict = validateSnapshot(data,{requireCompleteCatalog:true});
    assert.equal(strict.ok,false);
    assert.ok(strict.errors.some(error=>error.includes(expectedMissing)));
    const summary = summarizeCoverage(data);
    assert.equal(summary.structuralCatalogComplete,false);
    assert.ok(summary.catalogIdentity.missing.includes(expectedMissing));
    assert.ok(summary.catalogIdentity.unexpected.includes(replacement));
  }
});

test('same-count territory and delegate substitutions are caught separately from state denominators', () => {
  for (const [original,replacement,newState] of [['GU-G','AS-G','AS'],['AS-H-00','PR-H-00','PR']]) {
    const data = nationalFixture(), target = data.races.find(r=>r.id===original);
    target.id = replacement; target.state = newState; target.stateName = `Synthetic ${newState}`;
    assert.equal(validateSnapshot(data).ok,true);
    assert.equal(validateSnapshot(data,{requireCompleteCatalog:true}).ok,false);
    assert.equal(summarizeCoverage(data).structuralCatalogComplete,false);
  }
});

test('canonical ID cannot conceal a mismatched Senate class or House district', () => {
  for (const [id,field,value] of [['FL-S-special','senateClass',2],['AL-H-01','district',2]]) {
    const data = nationalFixture(); data.races.find(r=>r.id===id)[field] = value;
    assert.equal(validateSnapshot(data,{requireCompleteCatalog:true}).ok,false);
    assert.equal(summarizeCoverage(data).structuralCatalogComplete,false);
    assert.ok(summarizeCoverage(data).catalogIdentity.mismatches.includes(`${id}.${field}`));
  }
});

test('complete admitted snapshot cannot lose a valid race during refresh or paused queueing', () => {
  let state = createState(nationalFixture());
  const incomplete = nationalFixture(); incomplete.snapshotId = 'synthetic-removed';
  incomplete.races = incomplete.races.filter(r=>r.id!=='AL-G');
  incomplete.coverage.governorStates = 35; incomplete.coverage.detailReady = 513;
  assert.equal(validateSnapshot(incomplete).ok,true);
  state = action(state,'RECEIVE_SNAPSHOT',{snapshot:incomplete});
  assert.equal(state.snapshot.snapshotId,'synthetic-national-514');
  assert.equal(state.fetch.status,'error');
  state = action(state,'PAUSE');
  const good = nationalFixture(); good.snapshotId = 'synthetic-valid-correction'; good.races.find(r=>r.id==='AL-G').candidates[0].name = 'Corrected synthetic name';
  state = action(state,'RECEIVE_SNAPSHOT',{snapshot:good});
  state = action(state,'RECEIVE_SNAPSHOT',{snapshot:incomplete});
  assert.equal(state.pendingSnapshot.snapshotId,'synthetic-valid-correction');
  state = action(state,'RESUME');
  assert.equal(state.snapshot.snapshotId,'synthetic-valid-correction');
  assert.equal(summarizeCoverage(state.snapshot).structuralCatalogComplete,true);
});

test('inventory/detail completeness never implies independent official candidate audits', () => {
  const data = nationalFixture();
  data.coverage.candidateAuditComplete = true;
  data.coverage.independentlyAuditedRaceCount = 514;
  for (const item of data.races) item.metadataVerification = 'Official audited complete';
  let summary = summarizeCoverage(data);
  assert.equal(summary.structuralCatalogComplete,true);
  assert.equal(summary.detailReady,true);
  assert.equal(summary.independentlyAuditedRaceCount,0);
  assert.equal(summary.candidateAuditComplete,false);
  const one = data.races[0];
  const accepted = {raceId:one.id,candidateIds:one.candidates.map(c=>c.id),status:'verified',independent:true,official:true,completeInventory:true,sourceUrl:'https://example.test/official-fixture',evidenceRef:'synthetic-review-log:case-1',reviewer:'Synthetic independent reviewer',reviewedAt:'2026-11-03T15:00:00Z'};
  summary = summarizeCoverage(data,{acceptedCandidateAudits:[accepted,accepted]});
  assert.equal(summary.independentlyAuditedRaceCount,1);
  assert.equal(summary.candidateAuditComplete,false);
  one.candidates.push(candidate('new-synthetic-candidate'));
  assert.equal(summarizeCoverage(data,{acceptedCandidateAudits:[accepted]}).independentlyAuditedRaceCount,0,'Candidate correction invalidates old inventory audit coverage.');
});

test('known candidate conflicts block strict release without changing structural identity', () => {
  const data = nationalFixture();
  data.races.find(r=>r.id==='AL-G').candidateConflicts = [{status:'unresolved',field:'candidates',evidenceRef:'synthetic-disagreement'}];
  assert.equal(summarizeCoverage(data).structuralCatalogComplete,true);
  assert.equal(summarizeCoverage(data).unresolvedCandidateConflicts.length,1);
  assert.equal(summarizeCoverage(data).candidateAuditComplete,false);
  assert.equal(validateSnapshot(data,{requireCompleteCatalog:true}).ok,false);
  data.races.find(r=>r.id==='AL-G').candidateConflicts[0].status = 'resolved';
  assert.equal(validateSnapshot(data,{requireCompleteCatalog:true}).ok,true);
});

test('global sources and nested polls reject null, empty, mistyped and out-of-bounds records', () => {
  const mutations = [
    ['null source',d=>{d.sources=[null];}],
    ['empty source',d=>{d.sources=[{}];}],
    ['empty source title',d=>{d.sources=[{title:'',url:'https://example.test'}];}],
    ['unsafe global source',d=>{d.sources=[{title:'Synthetic',url:'javascript:alert(1)'}];}],
    ['too many sources',d=>{d.sources=Array(1001).fill({title:'Synthetic',url:'https://example.test'});}],
    ['null national poll',d=>{d.nationalPolls=[null];}],
    ['empty national poll',d=>{d.nationalPolls=[{}];}],
    ['invalid calendar date',d=>{d.nationalPolls[0].startDate='2026-02-30';}],
    ['reverse field period',d=>{d.nationalPolls[0].startDate='2026-03-02';}],
    ['unnamed field date cannot impersonate missing dates',d=>{delete d.nationalPolls[0].startDate;delete d.nationalPolls[0].endDate;d.nationalPolls[0].undefined='2026-03-01';}],
    ['nonfinite percentage',d=>{d.nationalPolls[0].dem=Infinity;}],
    ['numeric string percentage',d=>{d.nationalPolls[0].rep='42';}],
    ['out-of-range percentage',d=>{d.nationalPolls[0].other=101;}],
    ['zero sample',d=>{d.nationalPolls[0].sampleSize=0;}],
    ['mistyped basis',d=>{d.nationalPolls[0].sampleBasis={weighted:true};}],
    ['empty interval',d=>{d.nationalPolls[0].interval={};}],
    ['mistyped category',d=>{d.nationalPolls[0].categories=[{label:'Other',percentage:'5'}];}],
    ['null answer',d=>{d.nationalPolls[0].answers=[null];}],
    ['null correction',d=>{d.nationalPolls[0].corrections=[null];}],
    ['unsafe poll URL',d=>{d.nationalPolls[0].sourceUrl='data:text/html,bad';}],
    ['null race poll',d=>{d.races[0].polls=[null];}],
    ['empty race poll',d=>{d.races[0].polls=[{}];}],
    ['mistyped race polls',d=>{d.races[0].polls={};}],
    ['too many polls',d=>{d.nationalPolls=Array(1001).fill(syntheticPoll());}],
  ];
  for (const [label,mutate] of mutations) {
    const data=snapshot(); data.nationalPolls=[syntheticPoll()]; mutate(data);
    assert.equal(validateSnapshot(data).ok,false,label);
  }
});

test('poll admission preserves rounding, unknown categories, positive weighted bases and interval meaning', () => {
  const data=snapshot();
  data.sources=[{title:'Synthetic global evidence',url:'https://example.test/source',asOf:null}];
  const poll=syntheticPoll();
  poll.sampleSize=1572.5; poll.sampleBasis='Synthetic weighted N';
  poll.interval={value:3,type:'credibility interval',target:'Synthetic overall LV estimates',level:null};
  poll.categories=[{label:'Not measured',percentage:null},{label:'Undecided',percentage:5}];
  data.nationalPolls=[poll];
  data.races[0].polls=[{...structuredClone(poll),id:'synthetic-race-poll',url:poll.sourceUrl}];
  assert.deepEqual(validateSnapshot(data),{ok:true,errors:[]});
  const state=createState(data), admitted=state.snapshot.nationalPolls[0];
  assert.equal(admitted.dem+admitted.rep+admitted.undecided,99);
  assert.equal(admitted.other,null);
  assert.equal(admitted.sampleSize,1572.5);
  assert.equal(admitted.interval.type,'credibility interval');
  assert.equal(admitted.categories[0].percentage,null);
  assert.equal(state.snapshot.races[0].polls[0].id,'synthetic-race-poll');
  const unknown=snapshot(); unknown.nationalPolls=[syntheticPoll()];
  assert.equal(validateSnapshot(unknown).ok,true);
  assert.equal(createState(unknown).snapshot.nationalPolls[0].sampleSize,null);
});

test('fresh poison payloads retain last good display and latest validated pending data', () => {
  const baseline=nationalFixture();
  let state=createState(baseline);
  const poisoners=[d=>{d.sources=[null];},d=>{d.nationalPolls=[null];},d=>{d.races[0].polls=[null];},d=>{d.sources=[{title:'Synthetic source',url:''}];}];
  for (let i=0;i<poisoners.length;i++) {
    const poisoned=nationalFixture(); poisoned.snapshotId=`synthetic-poison-${i}`; poisoned.generatedAt='2026-11-03T18:00:00Z'; poisoners[i](poisoned);
    state=action(state,'RECEIVE_SNAPSHOT',{snapshot:poisoned});
    assert.equal(state.snapshot.snapshotId,baseline.snapshotId);
    assert.equal(state.fetch.status,'error');
  }
  state=action(state,'PAUSE');
  const good=nationalFixture(); good.snapshotId='synthetic-valid-after-error';
  state=action(state,'RECEIVE_SNAPSHOT',{snapshot:good});
  const poison=nationalFixture(); poison.snapshotId='synthetic-poison-paused'; poison.nationalPolls=[null];
  state=action(state,'RECEIVE_SNAPSHOT',{snapshot:poison});
  assert.equal(state.snapshot.snapshotId,baseline.snapshotId);
  assert.equal(state.pendingSnapshot.snapshotId,good.snapshotId);
  state=action(state,'RESUME');
  assert.equal(state.snapshot.snapshotId,good.snapshotId);
  assert.equal(state.fetch.status,'error');
  assert.equal(state.pendingSnapshot,null);
});
