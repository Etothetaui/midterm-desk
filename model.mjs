export const VERSION = 'v0.1.0-dev';
export const PARTY_ORDER = Object.freeze(['D', 'R', 'I', 'L', 'G', 'OTHER']);

const OFFICES = ['all', 'house', 'senate', 'governor'];
const HOUSE_SEATS = Object.freeze({AL:7,AK:1,AZ:9,AR:4,CA:52,CO:8,CT:5,DE:1,FL:28,GA:14,HI:2,ID:2,IL:17,IN:9,IA:4,KS:4,KY:6,LA:6,ME:2,MD:8,MA:9,MI:13,MN:8,MS:4,MO:8,MT:2,NE:3,NV:4,NH:2,NJ:12,NM:3,NY:26,NC:14,ND:1,OH:15,OK:5,OR:6,PA:17,RI:2,SC:7,SD:1,TN:9,TX:38,UT:4,VT:1,VA:11,WA:10,WV:2,WI:8,WY:1});
const EXPECTED = Object.freeze({houseRegular:435,houseDelegates:5,senate:35,governorStates:36,governorTerritories:3});
// Frozen 2026 current-ballot identity register, independent of an imported
// snapshot's counts. Changes require an evidenced register update, not a
// same-sized replacement supplied by that snapshot.
const SENATE_REGULAR_STATES = 'AL AK AR CO DE GA ID IL IA KS KY LA ME MA MI MN MS MT NE NH NJ NM NC OK OR RI SC SD TN TX VA WV WY'.split(' ');
const GOVERNOR_STATES = 'AL AK AZ AR CA CO CT FL GA HI ID IL IA KS ME MD MA MI MN NE NV NH NM NY OH OK OR PA RI SC SD TN TX VT WI WY'.split(' ');
const GOVERNOR_TERRITORIES = ['GU','MP','VI'];
const DELEGATE_JURISDICTIONS = ['AS','DC','GU','MP','VI'];
const EXPECTED_CONTESTS = new Map();
for (const [state, seats] of Object.entries(HOUSE_SEATS)) for (let i = 1; i <= seats; i++) {
  const district = seats === 1 ? 0 : i;
  EXPECTED_CONTESTS.set(`${state}-H-${String(district).padStart(2,'0')}`, {office:'house',state,kind:'regular',district,seatVoting:true});
}
for (const state of DELEGATE_JURISDICTIONS) EXPECTED_CONTESTS.set(`${state}-H-00`, {office:'house',state,kind:'delegate',district:0,seatVoting:false});
for (const state of SENATE_REGULAR_STATES) EXPECTED_CONTESTS.set(`${state}-S-regular`, {office:'senate',state,kind:'regular',district:null,seatVoting:true,senateClass:2});
for (const state of ['FL','OH']) EXPECTED_CONTESTS.set(`${state}-S-special`, {office:'senate',state,kind:'special',district:null,seatVoting:true,senateClass:3});
for (const state of [...GOVERNOR_STATES,...GOVERNOR_TERRITORIES]) EXPECTED_CONTESTS.set(`${state}-G`, {office:'governor',state,kind:'regular',district:null,seatVoting:!GOVERNOR_TERRITORIES.includes(state)});
const DEFAULT_FILTERS = Object.freeze({office:'all',state:'all',query:'',watchOnly:false,competitiveOnly:false});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
// Source-transcribed committee balances can be signed. Unknown stays null;
// vote counts, unlike finance amounts, must remain nonnegative integers.
const amount = value => value === null || (typeof value === 'number' && Number.isFinite(value));
const party = value => PARTY_ORDER.includes(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/u.test(value) && calendarDate(value.slice(0,10)) && Number.isFinite(Date.parse(value));
const stateExists = (snapshot, value) => value === 'all' || snapshot.races.some(race => race.state === value);
const houseKey = race => `${race.state}:H:${HOUSE_SEATS[race.state] === 1 ? 0 : race.district}`;

export function partyName(value) {
  const names = {D:'Democratic',R:'Republican',I:'Independent',L:'Libertarian',G:'Green',OTHER:'Other'};
  return Object.hasOwn(names,value) ? names[value] : 'Other';
}

// Structural URL safety only. Source authority comes from the verified catalog,
// not from a hostname suffix or successful parsing.
export function safeSourceUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0,10) === value;
}

function validateSourceList(value, label, fail, {required = false, limit = 1000} = {}) {
  if (!Array.isArray(value) || value.length > limit || (required && !value.length)) {
    fail(`${label} must be ${required ? 'a nonempty' : 'an'} array with at most ${limit} source records.`);
    return;
  }
  value.forEach((source,index) => {
    const at = `${label}[${index}]`;
    if (!object(source)) { fail(`${at} must be a non-null source object.`); return; }
    if (!text(source.title) || source.title.length > 1000 || !safeSourceUrl(source.url)) fail(`${at} needs a text title and safe HTTPS URL.`);
    if (source.id !== undefined && !identifier(source.id)) fail(`${at} has an invalid source ID.`);
    if (source.asOf != null && !timestamp(source.asOf)) fail(`${at} has an invalid source-as-of date.`);
    for (const field of ['kind','license','notice','description']) if (source[field] != null && (typeof source[field] !== 'string' || source[field].length > 10000)) fail(`${at}.${field} must be text or null.`);
  });
}

const percentage = value => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100);
const firstPresent = (record, keys) => keys.find(key => Object.hasOwn(record,key));

const SOURCE_CALL_STATUSES = new Set(['called','uncalled','retracted','unknown','unreported','unknown-source-clock','retained-unknown','retained-unknown-source-clock','stage-conflict']);
const CALL_HISTORY_ACTIONS = new Set(['publisher-call-changed','publisher-winner-flag-observed','publisher-winner-flag-removed']);
function validSourceCall(call,record){
  return object(call)&&typeof call.candidateSourceId==='string'&&/^\d{1,20}$/.test(call.candidateSourceId)&&text(call.name)&&call.name.length<=500&&(call.party===null||typeof call.party==='string'&&call.party.length<=100)&&call.sourceName==='civicAPI decision desk'&&call.sourceUrl===record.sourceUrl&&call.calledAt===null&&call.certification===null&&timestamp(call.asOf)&&timestamp(call.firstObservedAt);
}
function provedSourceCall(record,race){
  if(!object(record)||!object(race)||record.sourceCallStatus!=='called'||record.reported!==true||record.stage!=='general'||record.catalogStage!=='general'||race.stage!=='general'||typeof race.electionDate!=='string'||race.electionDate.slice(0,10)!=='2026-11-03'||record.electionDate!=='2026-11-03'||!validSourceCall(record.sourceCall,record)||record.sourceCall.asOf!==record.asOf||record.asOf.slice(0,10)<'2026-11-03'||!Array.isArray(record.candidates)||!record.candidates.length)return false;
  const endpoints={house:'87524',senate:'87528',governor:'87535'};
  if(record.sourceId!==`civicapi-${race.office}`||record.sourceUrl!==`https://civicapi.org/api/v2/race/${endpoints[race.office]}`||!/^\d{1,20}$/.test(record.sourceContestId||'')||record.detailUrl!==`https://civicapi.org/api/v2/race/${record.sourceContestId}`)return false;
  const flagged=record.candidates.filter(c=>c?.sourceWinnerFlag===true),call=record.sourceCall;
  return flagged.length===1&&record.candidates.every(c=>typeof c?.sourceWinnerFlag==='boolean'&&count(c.votes))&&record.candidates.some(c=>c.votes>0)&&flagged[0].sourceId===call.candidateSourceId&&flagged[0].name===call.name&&flagged[0].party===call.party;
}

// Calls belong to their publisher's contest identity. They never inherit a
// forecast probability or a candidate mapping the source did not establish.
export function activeSourceCall(record,race){
  // A failed fetch does not retract an earlier supported publisher call.
  return provedSourceCall(record,race)?record.sourceCall:null;
}

export function calledControlSummary(catalog){
  const empty=()=>Object.fromEntries(PARTY_ORDER.map(p=>[p,0]));
  const result={house:{total:435,currentTotal:435,called:empty(),unallocated:435,excluded:0,stale:0},senate:{total:100,currentTotal:35,called:empty(),carryover:empty(),carryoverKnown:false,unallocated:100,excluded:0,stale:0}};
  const nativeParty={Democratic:'D',Republican:'R',Independent:'I',Libertarian:'L',Green:'G',D:'D',R:'R',I:'I',L:'L',G:'G'};
  const seen=new Set();
  for(const race of catalog?.races||[]){
    const expected=EXPECTED_CONTESTS.get(race.id),bucket=result[race.office];
    if(!bucket||!expected||!expected.seatVoting||race.seatVoting!==true||expected.office!==race.office||expected.state!==race.state||expected.kind!==race.kind||expected.district!==race.district||seen.has(race.id))continue;
    seen.add(race.id);const record=catalog.nationalResultRecords?.[race.id];
    const call=activeSourceCall(record,race);if(call){bucket.called[Object.hasOwn(nativeParty,call.party)?nativeParty[call.party]:'OTHER']++;if(String(record.fetchHealth?.status||'').startsWith('retained-'))bucket.stale++;}else if(record?.sourceCall)bucket.excluded++;
  }
  const carry=catalog?.senateCarryover;
  if(carry?.verified===true&&['D','R','I'].every(p=>count(carry[p]))&&carry.D+carry.R+carry.I===65&&Array.isArray(carry.sources)&&carry.sources.length&&carry.sources.every(s=>safeSourceUrl(s?.url))){Object.assign(result.senate.carryover,{D:carry.D,R:carry.R,I:carry.I});result.senate.carryoverKnown=true;}
  for(const value of Object.values(result)){value.calledSeats=Object.values(value.called).reduce((a,b)=>a+b,0);value.seats=Object.fromEntries(PARTY_ORDER.map(p=>[p,value.called[p]+(value.carryover?.[p]||0)]));value.unallocated=value.total-Object.values(value.seats).reduce((a,b)=>a+b,0);value.uncalledCurrent=value.currentTotal-value.calledSeats;}
  return result;
}

function validatePollList(value, label, fail) {
  if (!Array.isArray(value) || value.length > 1000) { fail(`${label} must be an array with at most 1000 poll records.`); return; }
  const ids = new Set();
  value.forEach((poll,index) => {
    const at = `${label}[${index}]`;
    if (!object(poll)) { fail(`${at} must be a non-null poll object.`); return; }
    if (!identifier(poll.id) || ids.has(poll.id)) fail(`${at} needs a unique valid poll ID.`);
    ids.add(poll.id);
    if (!text(poll.pollster ?? poll.name) || (poll.pollster ?? poll.name).length > 500) fail(`${at} needs a pollster/name.`);
    const startKey = firstPresent(poll,['startDate','start_date','fieldStart']);
    const endKey = firstPresent(poll,['endDate','end_date','fieldEnd']);
    const start = startKey === undefined ? undefined : poll[startKey];
    const end = endKey === undefined ? undefined : poll[endKey];
    if (!calendarDate(start) || !calendarDate(end) || start > end) fail(`${at} needs valid ordered calendar field dates.`);
    if (poll.publishedAt != null && !timestamp(poll.publishedAt)) fail(`${at}.publishedAt must be a date/timestamp or null.`);
    if (!text(poll.population) || poll.population.length > 500) fail(`${at} needs a text population.`);
    if (!safeSourceUrl(poll.sourceUrl ?? poll.url)) fail(`${at} needs a safe HTTPS source URL.`);
    for (const field of ['sourceUrl','url']) if (poll[field] != null && !safeSourceUrl(poll[field])) fail(`${at}.${field} is unsafe.`);
    const sampleKey = firstPresent(poll,['sampleSize','sample','sample_size']);
    const sample = poll[sampleKey];
    if (sampleKey && sample !== null && !(typeof sample === 'number' && Number.isFinite(sample) && sample > 0)) fail(`${at}.${sampleKey} must be a positive number or null.`);
    for (const field of ['sampleBasis','sample_basis','leanerConvention','denominator','summary','note']) if (poll[field] != null && (typeof poll[field] !== 'string' || poll[field].length > 10000)) fail(`${at}.${field} must be text or null.`);
    if (poll.notes != null && !(typeof poll.notes === 'string' || (Array.isArray(poll.notes) && poll.notes.length <= 100 && poll.notes.every(note => typeof note === 'string' && note.length <= 10000)))) fail(`${at}.notes must be text, a bounded text array or null.`);
    if (poll.historical !== undefined && typeof poll.historical !== 'boolean') fail(`${at}.historical must be boolean.`);
    const percentageFields = ['D','R','dem','rep','democratic','republican','other','undecided','skipped'];
    for (const field of percentageFields) if (Object.hasOwn(poll,field) && !percentage(poll[field])) fail(`${at}.${field} must be a finite percentage in 0–100 or null.`);
    if (poll.answers !== undefined) {
      if (!Array.isArray(poll.answers) || poll.answers.length > 100) fail(`${at}.answers must be a bounded array.`);
      else for (const answer of poll.answers) if (!object(answer) || !text(answer.choice) || !Object.hasOwn(answer,'pct') || !percentage(answer.pct)) fail(`${at}.answers needs text choices and typed percentages.`);
    }
    if (!percentageFields.some(field => Object.hasOwn(poll,field)) && !poll.answers?.length && !text(poll.summary)) fail(`${at} needs a reported response or sourced summary.`);
    if (poll.categories !== undefined && poll.categories !== null) {
      if (Array.isArray(poll.categories)) {
        if (poll.categories.length > 100 || poll.categories.some(category => !object(category) || !text(category.label) || !Object.hasOwn(category,'percentage') || !percentage(category.percentage))) fail(`${at}.categories needs bounded label/percentage records.`);
      } else if (object(poll.categories)) {
        const entries = Object.entries(poll.categories);
        if (entries.length > 100 || entries.some(([name,pct]) => !text(name) || !percentage(pct))) fail(`${at}.categories needs a bounded percentage map.`);
      } else fail(`${at}.categories must be a typed map/array or null.`);
    }
    if (poll.interval !== undefined && poll.interval !== null) {
      const interval = poll.interval;
      if (!object(interval) || !percentage(interval.value) || interval.value === null || !text(interval.type) || !text(interval.target)) fail(`${at}.interval needs finite width, text type and target.`);
      else for (const field of ['level','confidenceLevel']) if (interval[field] != null && !(typeof interval[field] === 'number' && Number.isFinite(interval[field]) && interval[field] > 0 && interval[field] <= 100)) fail(`${at}.interval.${field} must be a positive finite level or null.`);
    }
    if (poll.corrections !== undefined) {
      if (!Array.isArray(poll.corrections) || poll.corrections.length > 100) fail(`${at}.corrections must be a bounded array.`);
      else for (const correction of poll.corrections) {
        if (!object(correction) || !text(correction.field)) { fail(`${at}.corrections needs non-null field records.`); continue; }
        for (const field of ['rawValue','normalizedValue']) if (correction[field] !== null && !['string','boolean'].includes(typeof correction[field]) && !(typeof correction[field] === 'number' && Number.isFinite(correction[field]))) fail(`${at}.corrections.${field} must be a primitive source value or null.`);
        if (correction.reason != null && typeof correction.reason !== 'string') fail(`${at}.corrections.reason must be text or null.`);
        if (correction.sourceUrl != null && !safeSourceUrl(correction.sourceUrl)) fail(`${at}.corrections.sourceUrl is unsafe.`);
      }
    }
    // Published response categories may round to 99/101 or omit unknown values.
    // Validate each reported value without renormalizing or inventing residuals.
  });
}

export function validateSnapshot(data, {requireCompleteCatalog = false} = {}) {
  const errors = [];
  const fail = message => { if (errors.length < 100) errors.push(message); };
  if (!object(data)) return {ok:false,errors:['Snapshot must be an object.']};
  if (data.schemaVersion !== 1) fail('Unsupported schemaVersion.');
  if (data.version !== VERSION) fail('Snapshot version does not match this app.');
  if (!text(data.snapshotId)) fail('snapshotId is required.');
  if (!timestamp(data.generatedAt)) fail('generatedAt must be a valid timestamp.');
  if (data.sourceAsOf !== null && !timestamp(data.sourceAsOf)) fail('sourceAsOf must be null or a timestamp.');
  validateSourceList(data.sources,'sources',fail);
  validatePollList(data.nationalPolls,'nationalPolls',fail);
  if (!object(data.coverage)) fail('coverage is required.');
  else {
    for (const key of Object.keys(EXPECTED)) if (!count(data.coverage[key])) fail(`coverage.${key} must be a nonnegative integer.`);
    if (!Array.isArray(data.coverage.missing) || !Array.isArray(data.coverage.notes)) fail('Coverage missing/notes must be arrays.');
    if (typeof data.coverage.detailReady !== 'boolean' && (!count(data.coverage.detailReady) || data.coverage.detailReady > (data.races?.length ?? 0))) fail('coverage.detailReady must be a ready-record count or boolean.');
  }
  if (!Array.isArray(data.races) || data.races.length > 2000) {
    fail('races must be an array with at most 2000 entries.');
    return {ok:false,errors};
  }
  const ids = new Set(), regularSeats = new Set();
  for (const race of data.races) {
    if (!object(race)) { fail('Race must be an object.'); continue; }
    const label = text(race.id) ? race.id : '(missing race ID)';
    if (!identifier(race.id) || ids.has(race.id)) fail(`Duplicate, invalid or missing race ID: ${label}.`);
    ids.add(race.id);
    if (!OFFICES.slice(1).includes(race.office)) fail(`${label}: invalid office.`);
    if (!/^[A-Z]{2}$/u.test(race.state || '') || !text(race.stateName)) fail(`${label}: jurisdiction identity is required.`);
    if (!['regular','special','delegate'].includes(race.kind)) fail(`${label}: invalid contest kind.`);
    if (typeof race.seatVoting !== 'boolean') fail(`${label}: seatVoting must be explicit.`);
    if (race.district !== null && !count(race.district)) fail(`${label}: invalid district.`);
    if (!text(race.stage) || !timestamp(race.electionDate)) fail(`${label}: stage and electionDate are required.`);
    if (race.nextElectionDate != null && !timestamp(race.nextElectionDate)) fail(`${label}: invalid nextElectionDate.`);
    if (race.office === 'house' && race.kind === 'regular' && race.seatVoting) {
      const key = houseKey(race);
      if (regularSeats.has(key)) fail(`${label}: duplicate regular House seat ${key}.`);
      regularSeats.add(key);
      const seats = HOUSE_SEATS[race.state];
      if (!seats || (seats > 1 && (!count(race.district) || race.district < 1 || race.district > seats))) fail(`${label}: district outside state apportionment.`);
    }
    const candidateIds = new Set();
    if (!Array.isArray(race.candidates) || !race.candidates.length || race.candidates.length > 100) fail(`${label}: 1–100 sourced candidates required.`);
    else for (const candidate of race.candidates) {
      if (!object(candidate)) { fail(`${label}: candidate must be an object.`); continue; }
      if (!identifier(candidate.id) || candidateIds.has(candidate.id)) fail(`${label}: duplicate/invalid/missing candidate ID.`);
      candidateIds.add(candidate.id);
      if (!text(candidate.name) || candidate.name.length > 500 || !party(candidate.party)) fail(`${label}: invalid candidate name/party.`);
      if (!amount(candidate.receipts) || !amount(candidate.cash)) fail(`${label}: finance must be null or a finite signed number.`);
    }
    if (race.incumbentParty !== null && !party(race.incumbentParty)) fail(`${label}: invalid incumbentParty.`);
    validateSourceList(race.sources,`${label}.sources`,fail,{required:true,limit:100});
    if (!text(race.metadataVerification) && !object(race.metadataVerification)) fail(`${label}: metadataVerification is required.`);
    if (race.rating !== null && (!object(race.rating) || !text(race.rating.label) || !text(race.rating.source) || !safeSourceUrl(race.rating.url) || !timestamp(race.rating.asOf))) fail(`${label}: rating needs label/source/URL/date.`);
    if (race.priorMargin !== null && (!object(race.priorMargin) || !Number.isFinite(race.priorMargin.value) || Math.abs(race.priorMargin.value) > 100 || !Number.isInteger(race.priorMargin.year) || !text(race.priorMargin.source) || !safeSourceUrl(race.priorMargin.url))) fail(`${label}: invalid priorMargin.`);
    validatePollList(race.polls,`${label}.polls`,fail);
    const results = race.results;
    if (!object(results) || typeof results.available !== 'boolean' || !Array.isArray(results.votes)) fail(`${label}: invalid results object.`);
    else {
      if (results.sourceUrl != null && !safeSourceUrl(results.sourceUrl)) fail(`${label}: unsafe results source URL.`);
      if (results.asOf !== null && !timestamp(results.asOf)) fail(`${label}: invalid result as-of.`);
      if (!results.available && results.votes.length) fail(`${label}: unavailable results must not contain invented counts.`);
      const choices = new Set();
      for (const entry of results.votes) {
        const id = entry?.candidateId ?? entry?.id;
        const votes = entry?.votes ?? entry?.count;
        if (!text(id) || !candidateIds.has(id) || choices.has(id) || !count(votes)) fail(`${label}: invalid/duplicate result choice or count.`);
        choices.add(id);
      }
    }
  }
  if (object(data.coverage)) {
    const actual = catalogCounts(data.races);
    for (const key of Object.keys(EXPECTED)) if (count(data.coverage[key]) && actual[key] !== data.coverage[key]) fail(`coverage.${key} differs from catalog count.`);
  }
  if(data.nationalResultRecords!==undefined){
    const records=data.nationalResultRecords;
    const nationalSources={house:'87524',senate:'87528',governor:'87535'};
    const sourceContests=new Set();
    if(!object(records)||Object.keys(records).length>600)fail('Native national result records must be a bounded map.');
    else for(const[id,record]of Object.entries(records)){
      if(!ids.has(id)||!object(record)||typeof record.reported!=='boolean'||!safeSourceUrl(record.sourceUrl)||!safeSourceUrl(record.detailUrl)||!Array.isArray(record.candidates)||record.candidates.length>100){fail('Invalid native result record '+id);continue;}
      const race=data.races.find(r=>r.id===id);
      if(record.sourceId!==`civicapi-${race.office}`||record.sourceUrl!==`https://civicapi.org/api/v2/race/${nationalSources[race.office]}`||record.stage!=='general'||record.catalogStage!==race.stage)fail('Invalid native source office or stage '+id);
      if(typeof record.sourceContestId!=='string'||!/^\d{1,20}$/.test(record.sourceContestId)||record.sourceRaceUrl!==`https://civicapi.org/api/v2/race/${record.sourceContestId}`||record.detailUrl!==record.sourceRaceUrl||sourceContests.has(record.sourceId+':'+record.sourceContestId))fail('Invalid or duplicate native source contest '+id);
      sourceContests.add(record.sourceId+':'+record.sourceContestId);
      if(!/^[a-f0-9]{64}$/.test(record.bodySha256||'')||!['stage-conflict','nominee-conflict','exact-candidate-match'].includes(record.matchStatus)||!record.candidates.length)fail('Invalid native result evidence '+id);
      if(record.asOf!==null&&!timestamp(record.asOf))fail('Invalid native source clock '+id);
      if(record.electionDate!=='2026-11-03')fail('Wrong native election date '+id);
      const choices=new Set();
      for(const c of record.candidates){if(!object(c)||typeof c.sourceId!=='string'||!/^\d{1,20}$/.test(c.sourceId)||choices.has(c.sourceId)||!text(c.name)||c.name.length>500||(c.party!==null&&(typeof c.party!=='string'||c.party.length>100))||!count(c.votes)||(c.sourceWinnerFlag!=null&&typeof c.sourceWinnerFlag!=='boolean'))fail('Invalid native result choice '+id);choices.add(c?.sourceId);}
      const total=record.candidates.reduce((sum,c)=>sum+(c?.votes||0),0);
      if(!Number.isSafeInteger(total)||record.reported!==record.candidates.some(c=>c?.votes>0))fail('Native reported state or aggregate count is invalid '+id);
      const status=record.sourceCallStatus??'unknown';
      if(!SOURCE_CALL_STATUSES.has(status))fail('Invalid native source call status '+id);
      if(record.sourceCall!=null&&!validSourceCall(record.sourceCall,record))fail('Invalid native source call provenance '+id);
      if(status==='called'&&!provedSourceCall(record,race))fail('Unproved contest-level source call '+id);
      if(record.candidates.filter(c=>c?.sourceWinnerFlag===true).length>1)fail('Multiple native winner flags '+id);
      if(record.checkedAt!=null&&!timestamp(record.checkedAt)||record.lastKnownSourceAsOf!=null&&!timestamp(record.lastKnownSourceAsOf))fail('Invalid native observation clock '+id);
      const history=record.sourceCallHistory??[];
      if(!Array.isArray(history)||history.length>1000)fail('Invalid native source call history '+id);
      else for(const h of history){
        if(!object(h)||!CALL_HISTORY_ACTIONS.has(h.action)||!timestamp(h.detectedAt)||!/^[a-f0-9]{64}$/.test(h.bodySha256||'')||(h.previousBodySha256!==null&&!/^[a-f0-9]{64}$/.test(h.previousBodySha256||''))||(h.previousCall!==null&&!validSourceCall(h.previousCall,record))||(h.newCall!==null&&!validSourceCall(h.newCall,record))||(h.sourceAsOf!=null&&!timestamp(h.sourceAsOf)))fail('Invalid native source call history event '+id);
        else if(h.action==='publisher-winner-flag-removed'&&(h.previousCall===null||h.newCall!==null)||h.action==='publisher-winner-flag-observed'&&(h.previousCall!==null||h.newCall===null)||h.action==='publisher-call-changed'&&(h.previousCall===null||h.newCall===null))fail('Inconsistent native source call history transition '+id);
      }
    }
  }
  if (data.senateCarryover?.verified === true) {
    const carry = data.senateCarryover;
    if (!['D','R','I'].every(key => count(carry[key])) || !Array.isArray(carry.sources) || !carry.sources.length) fail('Verified Senate carryover needs counts and evidence.');
    else if (carry.D + carry.R + carry.I + scenarioUniverse(data, 'senate').races.length !== 100) fail('Verified Senate baseline must reconcile to 100 seats.');
  }
  if (requireCompleteCatalog) {
    const identity = catalogIdentity(data.races);
    for (const id of identity.missing) fail(`Complete catalog missing canonical contest: ${id}.`);
    for (const id of identity.unexpected) fail(`Complete catalog unexpected canonical contest: ${id}.`);
    for (const id of identity.duplicates) fail(`Complete catalog duplicate canonical contest: ${id}.`);
    for (const mismatch of identity.mismatches) fail(`Complete catalog identity mismatch: ${mismatch}.`);
    if (data.coverage?.missing?.length) fail('Complete catalog declares unresolved missing coverage.');
    if (candidateConflicts(data).length) fail('Complete catalog has unresolved candidate conflicts.');
  }
  return {ok:errors.length === 0,errors};
}

function catalogIdentity(races) {
  const seen = new Set(), unexpected = [], duplicates = [], mismatches = [];
  for (const race of races) {
    if (!object(race)) continue;
    if (seen.has(race.id)) duplicates.push(race.id);
    seen.add(race.id);
    const expected = EXPECTED_CONTESTS.get(race.id);
    if (!expected) { unexpected.push(String(race.id)); continue; }
    for (const [field, value] of Object.entries(expected)) if (race[field] !== value) mismatches.push(`${race.id}.${field}`);
  }
  const missing = [...EXPECTED_CONTESTS.keys()].filter(id => !seen.has(id));
  return {missing,unexpected,duplicates,mismatches,complete:!missing.length && !unexpected.length && !duplicates.length && !mismatches.length};
}

// Explicit unresolved conflicts remain a release gate. Absence of such records
// is not proof that an independent candidate audit has occurred.
function candidateConflicts(snapshot) {
  const unresolved = conflict => object(conflict) && !['resolved','closed'].includes(conflict.status);
  const conflicts = Array.isArray(snapshot.candidateConflicts) ? snapshot.candidateConflicts.filter(unresolved) : [];
  for (const race of snapshot.races || []) if (object(race) && Array.isArray(race.candidateConflicts)) {
    for (const conflict of race.candidateConflicts.filter(unresolved)) conflicts.push({...conflict,raceId:race.id});
  }
  return conflicts;
}

function catalogCounts(races) {
  const valid = races.filter(object);
  return {
    houseRegular:valid.filter(r => r.office === 'house' && r.kind === 'regular' && r.seatVoting === true).length,
    houseDelegates:valid.filter(r => r.office === 'house' && r.kind === 'delegate').length,
    senate:valid.filter(r => r.office === 'senate').length,
    governorStates:valid.filter(r => r.office === 'governor' && HOUSE_SEATS[r.state]).length,
    governorTerritories:valid.filter(r => r.office === 'governor' && !HOUSE_SEATS[r.state]).length,
  };
}

// Optional accepted audit evidence is supplied by the coordinator's completed
// independent official-ballot audit log, never by snapshot claims/counters.
// This pure function checks evidence coverage; it cannot perform that audit.
export function summarizeCoverage(snapshot, {acceptedCandidateAudits = []} = {}) {
  const races = Array.isArray(snapshot.races) ? snapshot.races.filter(object) : [];
  const counts = catalogCounts(snapshot.races || []);
  const missing = Array.isArray(snapshot.coverage?.missing) ? [...snapshot.coverage.missing] : [];
  const notes = Array.isArray(snapshot.coverage?.notes) ? [...snapshot.coverage.notes] : [];
  const identity = catalogIdentity(races);
  const candidateInventoryCount = races.filter(race => Array.isArray(race.candidates) && race.candidates.length > 0 && race.candidates.every(candidate => object(candidate) && identifier(candidate.id) && text(candidate.name) && party(candidate.party))).length;
  const candidateCount = races.reduce((sum,race) => sum + (Array.isArray(race.candidates) ? race.candidates.length : 0),0);
  const computedDetailCount = races.filter(race => Array.isArray(race.candidates) && race.candidates.length > 0 && race.candidates.every(candidate => object(candidate) && identifier(candidate.id) && text(candidate.name) && party(candidate.party)) && text(race.stage) && timestamp(race.electionDate) && Array.isArray(race.sources) && race.sources.some(source => text(source?.title) && safeSourceUrl(source?.url)) && (text(race.metadataVerification) || object(race.metadataVerification))).length;
  const declaredDetailReadyCount = count(snapshot.coverage?.detailReady) ? snapshot.coverage.detailReady : (snapshot.coverage?.detailReady === true ? races.length : 0);
  const detailReadyCount = Math.min(declaredDetailReadyCount,computedDetailCount);
  const detailReady = races.length > 0 && detailReadyCount === races.length;
  const auditedIds = new Set();
  for (const audit of Array.isArray(acceptedCandidateAudits) ? acceptedCandidateAudits : []) {
    const race = races.find(item => item.id === audit?.raceId);
    if (!race || audit.status !== 'verified' || audit.independent !== true || audit.official !== true || audit.completeInventory !== true || !safeSourceUrl(audit.sourceUrl) || !text(audit.evidenceRef) || !text(audit.reviewer) || !timestamp(audit.reviewedAt) || !Array.isArray(audit.candidateIds)) continue;
    const actual = new Set(race.candidates.map(candidate => candidate.id)), checked = new Set(audit.candidateIds);
    if (actual.size === checked.size && [...actual].every(id => checked.has(id))) auditedIds.add(race.id);
  }
  const unresolvedCandidateConflicts = candidateConflicts(snapshot);
  const structuralCatalogComplete = identity.complete && !missing.length;
  const independentlyAuditedRaceCount = auditedIds.size;
  const candidateAuditComplete = structuralCatalogComplete && !unresolvedCandidateConflicts.length && independentlyAuditedRaceCount === races.length;
  return {
    counts,expected:{...EXPECTED},detailReady,detailReadyCount,declaredDetailReadyCount,candidateInventoryCount,candidateCount,missing,notes,
    structuralCatalogComplete,candidateAuditComplete,independentlyAuditedRaceCount,
    unresolvedCandidateConflicts,catalogIdentity:identity,
    // Backward-compatible STRUCTURAL alias only, never an audit/readiness claim.
    complete:structuralCatalogComplete,
    total:races.length,
    resultsAvailable:races.filter(r => r.results?.available === true).length,
    pollsAvailable:races.filter(r => r.polls?.length > 0).length,
  };
}

function normalized(value) {
  return String(value ?? '').normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
}

export function visibleRaces(state) {
  const tokens = normalized(state.filters.query).split(/\s+/u).filter(Boolean);
  const watched = new Set(state.watchlist);
  return state.snapshot.races.filter(race => {
    if (state.filters.office !== 'all' && race.office !== state.filters.office) return false;
    if (state.filters.state !== 'all' && race.state !== state.filters.state) return false;
    if (state.filters.watchOnly && !watched.has(race.id)) return false;
    if (state.filters.competitiveOnly && !/toss[\s-]*up|lean|tilt|competitive/iu.test(race.rating?.label || '')) return false;
    const aliases = race.district == null || race.district === 0 ? `${race.state} at large ${race.state} AL` : `${race.state}-${race.district} ${race.state}-${String(race.district).padStart(2,'0')}`;
    const haystack = normalized([race.id,race.office,race.state,race.stateName,race.district,aliases,race.kind,...race.candidates.map(c => c.name)].join(' '));
    return tokens.every(token => haystack.includes(token));
  });
}

export function selectedRace(state) {
  return state.snapshot.races.find(race => race.id === state.selectedId) || null;
}

export function selectedOutOfFilter(state) {
  return selectedRace(state) !== null && !visibleRaces(state).some(race => race.id === state.selectedId);
}

export function sanitizePreferences(raw, snapshot) {
  let value = raw;
  if (typeof value === 'string') {
    if (value.length > 100000) value = {};
    else { try { value = JSON.parse(value); } catch { value = {}; } }
  }
  if (!object(value)) value = {};
  const ids = new Set(snapshot.races.map(r => r.id));
  const filters = object(value.filters) ? value.filters : {};
  const assignments = {};
  if (object(value.scenario?.assignments)) for (const [id, choice] of Object.entries(value.scenario.assignments)) {
    if (ids.has(id) && party(choice) && scenarioEligible(snapshot.races.find(r => r.id === id))) assignments[id] = choice;
  }
  return {
    filters:{
      office:OFFICES.includes(filters.office) ? filters.office : 'all',
      state:stateExists(snapshot, filters.state) ? filters.state : 'all',
      query:typeof filters.query === 'string' ? filters.query.slice(0,200) : '',
      watchOnly:filters.watchOnly === true,competitiveOnly:filters.competitiveOnly === true,
    },
    selectedId:ids.has(value.selectedId) ? value.selectedId : (snapshot.races[0]?.id ?? null),
    watchlist:Array.isArray(value.watchlist) ? [...new Set(value.watchlist.filter(id => typeof id === 'string' && ids.has(id)))] : [],
    scenario:{assignments},
  };
}

function freezeSnapshot(snapshot) {
  const cloned = typeof structuredClone === 'function' ? structuredClone(snapshot) : JSON.parse(JSON.stringify(snapshot));
  function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) freeze(child);
    }
    return value;
  }
  return freeze(cloned);
}

export function createState(snapshot, prefs = {}) {
  const validation = validateSnapshot(snapshot);
  if (!validation.ok) throw new Error(`Invalid initial snapshot: ${validation.errors.join(' ')}`);
  const admitted = freezeSnapshot(snapshot);
  return {snapshot:admitted,pendingSnapshot:null,paused:false,...sanitizePreferences(prefs,admitted),fetch:{status:'ready',message:''},updatedAvailable:false};
}

function adopt(state, snapshot) {
  return {...state,snapshot,...sanitizePreferences(state,snapshot),pendingSnapshot:null,updatedAvailable:false};
}

export function reducer(state, action) {
  switch (action?.type) {
    case 'SET_QUERY': return {...state,filters:{...state.filters,query:typeof action.value === 'string' ? action.value.slice(0,200) : ''}};
    case 'SET_OFFICE': return OFFICES.includes(action.value) ? {...state,filters:{...state.filters,office:action.value}} : state;
    case 'SET_STATE': return stateExists(state.snapshot,action.value) ? {...state,filters:{...state.filters,state:action.value}} : state;
    case 'TOGGLE_WATCH': {
      if (!state.snapshot.races.some(r => r.id === action.id)) return state;
      return {...state,watchlist:state.watchlist.includes(action.id) ? state.watchlist.filter(id => id !== action.id) : [...state.watchlist,action.id]};
    }
    case 'TOGGLE_WATCH_ONLY': return {...state,filters:{...state.filters,watchOnly:!state.filters.watchOnly}};
    case 'TOGGLE_COMPETITIVE': return {...state,filters:{...state.filters,competitiveOnly:!state.filters.competitiveOnly}};
    case 'SELECT_RACE': return state.snapshot.races.some(r => r.id === action.id) ? {...state,selectedId:action.id} : state;
    case 'RESET_FILTERS': return {...state,filters:{...DEFAULT_FILTERS}};
    case 'PAUSE': return {...state,paused:true};
    case 'RESUME': return {...(state.pendingSnapshot ? adopt(state,state.pendingSnapshot) : state),paused:false,pendingSnapshot:null,updatedAvailable:false};
    case 'FETCH_START': return {...state,fetch:{status:'updating',message:'Checking for updates…'}};
    case 'FETCH_ERROR': return {...state,fetch:{status:'error',message:typeof action.message === 'string' ? action.message.slice(0,500) : 'Update unavailable.'}};
    case 'RECEIVE_SNAPSHOT': {
      const validation = validateSnapshot(action.snapshot,{requireCompleteCatalog:catalogIdentity(state.snapshot.races).complete});
      if (!validation.ok) return {...state,fetch:{status:'error',message:`Update rejected: ${validation.errors.join(' ')}`}};
      const snapshot = freezeSnapshot(action.snapshot);
      const fetch = {status:'ready',message:state.paused ? 'Validated update waiting while paused.' : ''};
      if (state.paused) return {...state,pendingSnapshot:snapshot,updatedAvailable:snapshot.snapshotId !== state.snapshot.snapshotId,fetch};
      return {...adopt(state,snapshot),fetch};
    }
    case 'SET_SCENARIO': {
      const race = state.snapshot.races.find(r => r.id === action.id);
      if (!race || !scenarioEligible(race)) return state;
      const assignments = {...state.scenario.assignments};
      if (action.party === null || action.party === '' || action.party === 'unassigned') delete assignments[action.id];
      else if (party(action.party)) assignments[action.id] = action.party;
      else return state;
      return {...state,scenario:{assignments}};
    }
    case 'RESET_SCENARIO': return {...state,scenario:{assignments:{}}};
    default: return state;
  }
}

function scenarioEligible(race) {
  return race.office !== 'house' || (race.kind === 'regular' && race.seatVoting === true);
}

function scenarioUniverse(snapshot, office) {
  const input = snapshot.races.filter(r => r.office === office && scenarioEligible(r));
  if (office === 'house') return {races:input,ambiguous:false};
  const groups = new Map();
  let ambiguous = false;
  for (const race of input) {
    const key = race.seatId || (office === 'governor' ? race.state : (race.senateClass ? `${race.state}:S:${race.senateClass}` : race.id));
    const previous = groups.get(key);
    if (!previous || (previous.kind !== 'regular' && race.kind === 'regular')) groups.set(key,race);
    else if (previous.kind === race.kind) ambiguous = true;
  }
  if (office === 'senate') {
    for (const race of input) if (!race.seatId && !race.senateClass && input.filter(r => r.state === race.state).length > 1) ambiguous = true;
  }
  return {races:[...groups.values()],ambiguous};
}

function allocated(races, assignments) {
  const byParty = Object.fromEntries(PARTY_ORDER.map(p => [p,0]));
  let unassigned = 0;
  for (const race of races) {
    const choice = assignments[race.id];
    if (party(choice)) byParty[choice]++;
    else unassigned++;
  }
  return {byParty,unassigned};
}

function grouped(byParty) {
  const counts = {D:byParty.D,R:byParty.R,I:byParty.I,OTHER:byParty.L + byParty.G + byParty.OTHER};
  return {...counts,counts,byParty};
}

export function scenarioTotals(state, office) {
  const universe = scenarioUniverse(state.snapshot,office);
  let races = universe.races;
  const territories = office === 'governor' ? races.filter(r => !HOUSE_SEATS[r.state]) : [];
  if (office === 'governor') races = races.filter(r => HOUSE_SEATS[r.state]);
  const allocation = allocated(races,state.scenario.assignments);
  let total = races.length, majority = null;
  let baselineKnown = !universe.ambiguous;
  let note = 'Hypothetical allocations only; unassigned seats are not party totals.';
  if (office === 'house') {
    baselineKnown = baselineKnown && races.length === 435;
    majority = baselineKnown ? 218 : null;
    note = 'Voting regular House seats only; delegates and specials do not add seats.';
  } else if (office === 'senate') {
    const carry = state.snapshot.senateCarryover;
    const verified = carry?.verified === true && ['D','R','I'].every(p => count(carry[p])) && carry.D + carry.R + carry.I + races.length === 100;
    baselineKnown = baselineKnown && verified;
    if (verified) {
      for (const p of ['D','R','I']) allocation.byParty[p] += carry[p];
      total = 100;
      majority = baselineKnown ? 51 : null;
      note = 'Verified carryover plus hypothetical contested-seat allocations; caucus/control rules remain separate.';
    } else note = `${races.length} contested seats only. Carryover baseline unverified; full-Senate control unavailable.`;
  } else if (office === 'governor') {
    note = 'State governorship allocations; territories shown separately. No legislative majority/control threshold.';
  } else { baselineKnown = false; note = 'Choose a supported office.'; }
  if (universe.ambiguous) note += ' Ambiguous seat/term identity: no control inference is available.';
  const result = {...grouped(allocation.byParty),unassigned:allocation.unassigned,total,majority,baselineKnown,note};
  if (office === 'governor') {
    const territorial = allocated(territories,state.scenario.assignments);
    result.territories = {...grouped(territorial.byParty),unassigned:territorial.unassigned,total:territories.length,majority:null,baselineKnown:!universe.ambiguous,note:'Territorial governorships; excluded from state denominator.'};
  }
  return result;
}

export function formatNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('en-US',{maximumFractionDigits:1}).format(value) : '—';
}

export function marginLabel(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Unavailable';
  if (value === 0) return 'Even';
  return `${value > 0 ? 'D' : 'R'} +${formatNumber(Math.abs(value))}`;
}
