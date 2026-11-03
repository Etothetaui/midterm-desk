// Public AP social announcements are partial coverage, independent of vote feeds.
export const AP_DID = 'did:plc:a67zdrt4nl2tv2qojpngogbq';
const BLUESKY_DID = 'did:plc:z72i7hdynmk6r22z27h6tvur';
const HOST = 'https://public.api.bsky.app/xrpc/';
const FIRST_CALL = Date.parse('2026-11-03T23:00:00Z');
const MAX_EVENTS = 600;
const FACT_KEYS=['raceId','candidateId','candidateName','party','state','office','district','status','sourceUrl','postUri','cid','publishedAt','observedAt'];
const PARTIES = ['D','R','I','L','G','OTHER'];
const own = (x,k) => Object.hasOwn(x,k);
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x) && [Object.prototype,null].includes(Object.getPrototypeOf(x));
const iso = x => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString().slice(0,10) === x.slice(0,10);
const id = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(x) && !['constructor','prototype','__proto__'].includes(x);
const clone = x => structuredClone(x);
const normal = x => String(x).normalize('NFKD').replace(/\p{M}/gu,'').replace(/[’‘]/g,"'").replace(/\./g,'').replace(/\s+/g,' ').trim().toLowerCase();
const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const cleanKeys = (x,keys) => plain(x) && Object.keys(x).every(k => keys.includes(k));

export function emptyAPSource(){
  return {schemaVersion:1,sourceId:'ap-public-announcements',sourceName:'AP public announcements',coverage:'partial',status:'error',checkedAt:null,asOf:null,identity:{did:AP_DID,handle:'apnews.com',verified:false},observations:{},catchup:{pages:0,posts:0,truncated:false},errorCode:'not-checked',retryAfterAt:null};
}

function catalogRaces(catalog){
  return Array.isArray(catalog?.races) ? catalog.races : [];
}
function allowedRace(race){
  return plain(race) && id(race.id) && ['house','senate','governor'].includes(race.office) && race.electionDate === '2026-11-03' && race.stage === 'general' && typeof race.state === 'string' && /^[A-Z]{2}$/.test(race.state) && typeof race.stateName === 'string' && race.stateName.length < 100 && Array.isArray(race.candidates);
}
function validFact(f,raceId,checkedAt,race){
  if(!cleanKeys(f,FACT_KEYS)) return false;
  if(f.raceId !== raceId || !id(f.raceId) || !id(f.candidateId) || typeof f.candidateName !== 'string' || !f.candidateName.trim() || f.candidateName.length > 250 || !PARTIES.includes(f.party) || !['called','retracted'].includes(f.status)) return false;
  if(!['house','senate','governor'].includes(f.office) || !/^[A-Z]{2}$/.test(f.state) || !(f.district === null || Number.isInteger(f.district) && f.district >= 0 && f.district <= 99)) return false;
  const prefix = `at://${AP_DID}/app.bsky.feed.post/`;
  if(typeof f.postUri !== 'string' || !f.postUri.startsWith(prefix)) return false;
  const key = f.postUri.slice(prefix.length);
  if(!/^[a-z2-7]{13}$/.test(key) || f.sourceUrl !== `https://bsky.app/profile/${AP_DID}/post/${key}` || typeof f.cid !== 'string' || !/^b[a-z2-7]{20,120}$/.test(f.cid)) return false;
  if(!iso(f.publishedAt) || Date.parse(f.publishedAt) < FIRST_CALL || !iso(checkedAt) || Date.parse(f.publishedAt) > Date.parse(checkedAt)) return false;
  if(!iso(f.observedAt) || Date.parse(f.observedAt)<Date.parse(f.publishedAt) || Date.parse(f.observedAt)>Date.parse(checkedAt)) return false;
  if(race){
    if(!allowedRace(race) || race.state !== f.state || race.office !== f.office || (race.district ?? null) !== f.district) return false;
    const candidates = race.candidates.filter(c => plain(c) && c.id === f.candidateId && c.name === f.candidateName && c.party === f.party);
    if(candidates.length !== 1) return false;
  }
  return true;
}

export function validateAPSource(source,catalog){
  const errors=[];
  const fail = message => { if(errors.length < 20) errors.push(message); };
  if(!cleanKeys(source,['schemaVersion','sourceId','sourceName','coverage','status','checkedAt','asOf','identity','observations','catchup','errorCode','retryAfterAt'])) return {ok:false,errors:['Invalid AP source envelope.']};
  if(source.schemaVersion !== 1 || source.sourceId !== 'ap-public-announcements' || source.sourceName !== 'AP public announcements' || source.coverage !== 'partial' || !['ready','retained-error','error'].includes(source.status)) fail('Invalid AP source identity/status.');
  if(!(source.checkedAt === null || iso(source.checkedAt)) || !(source.asOf === null || iso(source.asOf)) || source.asOf !== null && (source.checkedAt === null || Date.parse(source.asOf) > Date.parse(source.checkedAt))) fail('Invalid AP source timestamps.');
  if(!cleanKeys(source.identity,['did','handle','verified']) || source.identity.did !== AP_DID || source.identity.handle !== 'apnews.com' || typeof source.identity.verified !== 'boolean') fail('Invalid AP profile identity.');
  if(source.status === 'ready' && (!source.identity?.verified || !iso(source.checkedAt) || source.errorCode !== null)) fail('Ready AP source needs a verified profile and check time.');
  if(source.status !== 'ready' && (typeof source.errorCode !== 'string' || !/^[a-z0-9-]{1,80}$/.test(source.errorCode))) fail('Invalid AP error code.');
  if(source.retryAfterAt != null && (!iso(source.retryAfterAt) || !iso(source.checkedAt) || Date.parse(source.retryAfterAt)<Date.parse(source.checkedAt) || Date.parse(source.retryAfterAt)>Date.parse(source.checkedAt)+86400000 || source.errorCode!=='rate-limited')) fail('Invalid AP retry-after time.');
  if(!cleanKeys(source.catchup,['pages','posts','truncated']) || !Number.isInteger(source.catchup.pages) || source.catchup.pages < 0 || source.catchup.pages > 3 || !Number.isInteger(source.catchup.posts) || source.catchup.posts < 0 || source.catchup.posts > 300 || typeof source.catchup.truncated !== 'boolean') fail('Invalid AP catchup state.');
  if(!plain(source.observations) || Object.keys(source.observations).length > MAX_EVENTS) return {ok:false,errors:[...errors,'AP observations must be a bounded map.']};
  const races = new Map();
  for(const race of catalogRaces(catalog)) if(allowedRace(race)) { if(races.has(race.id)) fail('Duplicate AP catalog race.'); races.set(race.id,race); }
  let events=0,latest=null;
  for(const [raceId,observation] of Object.entries(source.observations)){
    const race=races.get(raceId);
    if(!race || !cleanKeys(observation,[...FACT_KEYS,'history']) || !Array.isArray(observation.history) || !observation.history.length || observation.history.length > MAX_EVENTS){ fail('Invalid AP observation identity/history.'); continue; }
    const {history,...fact}=observation;
    if(!validFact(fact,raceId,source.checkedAt,race)) fail('Invalid AP observation fact.');
    events+=history.length;
    let previousTime=-Infinity,lastEvent=null;
    const seen=new Set();
    for(const event of history){
      if(!validFact(event,raceId,source.checkedAt,race) || Date.parse(event.publishedAt) < previousTime || seen.has(`${event.postUri}:${event.cid}`)) fail('Invalid AP observation history event.');
      if(event?.status==='retracted' && (!lastEvent || lastEvent.status!=='called' || lastEvent.candidateId!==event.candidateId)) fail('AP withdrawal needs its preceding supported call.');
      if(lastEvent && event?.postUri===lastEvent.postUri && (Date.parse(event.observedAt)<=Date.parse(lastEvent.observedAt) || lastEvent.status==='retracted' && event.status==='called')) fail('Ambiguous AP same-post revision.');
      previousTime=Date.parse(event?.publishedAt); seen.add(`${event?.postUri}:${event?.cid}`);
      lastEvent=event;
    }
    if(Object.keys(fact).some(key=>fact[key]!==history.at(-1)?.[key])) fail('AP latest observation must match its last history event.');
    if(!latest || Date.parse(fact.publishedAt) > Date.parse(latest)) latest=fact.publishedAt;
  }
  if(events > MAX_EVENTS) fail('AP event budget exceeded.');
  if(source.asOf !== latest) fail('AP source as-of must match its latest observed announcement.');
  if(events && !source.identity?.verified || source.status === 'retained-error' && !events || source.status === 'error' && events) fail('Invalid AP retained/verified state.');
  return {ok:errors.length===0,errors};
}

function officeTargets(race){
  const state=esc(normal(race.stateName)), us='(?:u ?s|united states)', possessive=`${state}'s`;
  if(race.office === 'senate') return [`${state}(?:'s)? ${us} senate(?: (?:race|seat|election))?`,`${us} senate(?: (?:race|seat|election))? (?:in|from) ${state}`,`(?:a |the )?seat in (?:the )?${us} senate (?:in|from) ${state}`];
  if(race.office === 'governor') return [`${state}(?:'s)? (?:governor(?:'s)?(?: (?:race|seat|election))?|gubernatorial (?:race|election))`,`(?:the )?(?:race for )?governor (?:of|in) ${state}`];
  if(!Number.isInteger(race.district)) return [];
  if(race.district === 0) return [`${possessive} at-large ${us} house(?: (?:race|seat))?`,`${us} house(?: (?:race|seat))? in ${state}`];
  const n=race.district, suffix=n%100>=11&&n%100<=13?'th':({1:'st',2:'nd',3:'rd'}[n%10]||'th');
  const district=`${n}${suffix}`;
  return [`${possessive} ${district} congressional district(?: (?:race|seat))?`,`${us} house(?: (?:race|seat))? in ${possessive} ${district}(?: congressional)? district`];
}

function parseAnnouncement(item,catalog,now){
  const p=item?.post,r=p?.record;
  if(!plain(item) || own(item,'reason') || !plain(p) || p.author?.did !== AP_DID || !plain(r) || r.$type !== 'app.bsky.feed.post' || r.reply || typeof r.text !== 'string' || r.text.length > 2000 || !iso(r.createdAt) || Date.parse(r.createdAt) < FIRST_CALL || Date.parse(r.createdAt)>now) return null;
  // Never interpret quoted posts or their descriptions as AP's own assertion.
  if([r.embed?.$type,p.embed?.$type].some(t => typeof t === 'string' && /record/.test(t))) return null;
  let text=normal(r.text);
  // Only a single assertion with an optional source URL; extra prose is ambiguous.
  text=text.replace(/\s+https:\/\/[^\s]+\s*$/,'').replace(/[.!]\s*$/,'');
  let status='called';
  const withdrawal=/^(?:ap|the associated press) (?:withdraws|retracts) (?:its |the )?call (?:that )?(.+)$/;
  if(withdrawal.test(text)){ status='retracted'; text=text.match(withdrawal)[1]; }
  text=text.replace(/^breaking:\s*/,'').replace(/^(?:democrat|republican|independent|libertarian|green)\s+/,'');
  if(/[?"“”]|\b(?:primary|nomination|runoff|would|could|may|might|expected|projected|likely|predicts?|claims?|declares?|concedes?|yesterday|last year|202[0-5]|recount|correction)\b/.test(text)) return null;
  const matches=[];
  for(const race of catalogRaces(catalog)){
    if(!allowedRace(race) || (race.kind === 'special' && !/\bspecial\b/.test(text)) || (race.kind !== 'special' && /\bspecial\b/.test(text))) continue;
    const targets=officeTargets(race).map(t => race.kind === 'special'?t.replace('(?: (?:race|seat|election))?', '(?: special)?(?: (?:race|seat|election))?'):t);
    for(const c of race.candidates){
      if(!plain(c) || !id(c.id) || typeof c.name !== 'string' || !PARTIES.includes(c.party)) continue;
      const name=esc(normal(c.name));
      if(new RegExp(`^${name} (?:wins|has won|is elected to) (?:(?:election|reelection|re-election) (?:to|as) )?(?:the )?(?:${targets.join('|')})$`,'u').test(text)) matches.push({race,c});
    }
  }
  if(matches.length !== 1) return null;
  const {race,c}=matches[0], key=typeof p.uri === 'string'?p.uri.split('/').at(-1):'';
  const fact={raceId:race.id,candidateId:c.id,candidateName:c.name,party:c.party,state:race.state,office:race.office,district:race.district??null,status,sourceUrl:`https://bsky.app/profile/${AP_DID}/post/${key}`,postUri:p.uri,cid:p.cid,publishedAt:r.createdAt,observedAt:new Date(now).toISOString()};
  return validFact(fact,race.id,new Date(now).toISOString(),race)?fact:null;
}

async function jsonRequest(fetcher,path,now){
  const response=await fetcher(HOST+path,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(15000),cache:'no-store'});
  if(response?.status===429){
    const value=response.headers?.get?.('Retry-After');
    const delay=typeof value==='string'&&/^\d+$/.test(value)?Number(value)*1000:Date.parse(value)-now;
    const error=new Error('rate-limited');error.retryAfterAt=new Date(now+Math.min(86400000,Math.max(120000,Number.isFinite(delay)?delay:120000))).toISOString();throw error;
  }
  if(!response?.ok) throw new Error('fetch-failed');
  const text=await response.text();
  if(text.length > 3000000) throw new Error('response-too-large');
  let data; try{data=JSON.parse(text);}catch{throw new Error('invalid-response');}
  if(!plain(data) || data.error) throw new Error('invalid-response');
  return data;
}

export async function refreshAPSource(catalog,previous,{fetcher=fetch,now=Date.now()}={}){
  const base=previous == null?emptyAPSource():previous;
  if(!validateAPSource(base,catalog).ok) throw new Error('Previous AP snapshot rejected.');
  if(!Number.isFinite(now)) throw new Error('Invalid AP check time.');
  if(base.retryAfterAt && now<Date.parse(base.retryAfterAt) || base.checkedAt && now-Date.parse(base.checkedAt)<(base.status==='ready'?60000:120000)) return clone(base);
  // An older server/browser response must never replace a newer local observation.
  const checkedAt=new Date(Math.max(now,base.checkedAt?Date.parse(base.checkedAt):0)).toISOString();
  let source=clone(base);
  try{
    const profile=await jsonRequest(fetcher,'app.bsky.actor.getProfile?actor='+encodeURIComponent(AP_DID),now);
    if(profile.did !== AP_DID || profile.handle !== 'apnews.com' || profile.verification?.verifiedStatus !== 'valid' || !profile.verification.verifications?.some(v => v.issuer === BLUESKY_DID && v.isValid === true)) throw new Error('identity-unverified');
    const posts=[],cursors=new Set(); let cursor=null,truncated=false,pages=0;
    for(;pages<3;){
      const suffix=cursor?'&cursor='+encodeURIComponent(cursor):'';
      const page=await jsonRequest(fetcher,'app.bsky.feed.getAuthorFeed?actor='+encodeURIComponent(AP_DID)+'&filter=posts_with_replies&limit=100'+suffix,now);
      if(!Array.isArray(page.feed) || page.feed.length>100 || page.cursor != null && (typeof page.cursor !== 'string' || page.cursor.length>500)) throw new Error('invalid-feed');
      pages++; posts.push(...page.feed);
      const times=page.feed.filter(i=>!i?.reason&&i?.post?.author?.did===AP_DID).map(i=>Date.parse(i?.post?.record?.createdAt)).filter(Number.isFinite);
      if(!page.cursor || times.length && Math.max(...times)<FIRST_CALL) break;
      if(cursors.has(page.cursor)) throw new Error('repeated-cursor');
      cursors.add(page.cursor);cursor=page.cursor;
      if(pages===3) truncated=true;
    }
    source={...source,status:'ready',checkedAt,identity:{did:AP_DID,handle:'apnews.com',verified:true},catchup:{pages,posts:posts.length,truncated},errorCode:null,retryAfterAt:null};
    const facts=[];
    const knownPosts=new Map();
    for(const observation of Object.values(source.observations)) for(const event of observation.history){
      const known=knownPosts.get(event.postUri)||{event,cids:new Set()};known.cids.add(event.cid);known.event=event;knownPosts.set(event.postUri,known);
    }
    for(const item of posts){
      const fact=parseAnnouncement(item,catalog,now);
      if(fact){facts.push(fact);continue;}
      // A changed AP-owned record may replace the original winning assertion
      // with prose we cannot classify. That invalidates fresh verification of
      // the old assertion without proving that AP withdrew the race call.
      const p=item?.post,r=p?.record,known=knownPosts.get(p?.uri);
      if(!known || !plain(p) || p.author?.did!==AP_DID || !plain(r) || r.$type!=='app.bsky.feed.post' || known.cids.has(p.cid) || !iso(r.createdAt) || Date.parse(r.createdAt)>now) continue;
      const revised={...known.event,cid:p.cid,publishedAt:r.createdAt,observedAt:checkedAt};
      if(validFact(revised,known.event.raceId,checkedAt)){
        source.status='retained-error';source.errorCode='revision-ambiguous';
      }
    }
    facts.sort((a,b)=>Date.parse(a.publishedAt)-Date.parse(b.publishedAt)||a.postUri.localeCompare(b.postUri));
    let events=Object.values(source.observations).reduce((n,o)=>n+o.history.length,0);
    for(const fact of facts){
      const old=own(source.observations,fact.raceId)?source.observations[fact.raceId]:null;
      if(old?.history.some(e=>e.postUri===fact.postUri&&e.cid===fact.cid)) continue;
      if(old && Date.parse(fact.publishedAt)<Date.parse(old.publishedAt)) continue;
      if(old && fact.publishedAt===old.publishedAt){
        if(fact.postUri!==old.postUri || fact.observedAt<=old.observedAt || fact.candidateId!==old.candidateId || old.status==='retracted' && fact.status==='called'){
          source.status='retained-error';source.errorCode='revision-ambiguous';continue;
        }
      }
      // Withdrawals require an earlier supported call of this very candidate.
      if(fact.status==='retracted' && (!old || old.status!=='called' || old.candidateId!==fact.candidateId)) continue;
      if(events>=MAX_EVENTS){source.catchup.truncated=true;continue;}
      source.observations[fact.raceId]={...fact,history:[...(old?.history||[]),clone(fact)]};events++;
    }
    source.asOf=Object.values(source.observations).reduce((latest,o)=>!latest||Date.parse(o.publishedAt)>Date.parse(latest)?o.publishedAt:latest,null);
    if(!validateAPSource(source,catalog).ok) throw new Error('invalid-snapshot');
    return source;
  }catch(error){
    source=clone(base);source.checkedAt=checkedAt;source.status=Object.keys(source.observations).length?'retained-error':'error';
    source.errorCode=['fetch-failed','response-too-large','invalid-response','identity-unverified','invalid-feed','repeated-cursor','invalid-snapshot','rate-limited'].includes(error?.message)?error.message:'fetch-failed';
    source.retryAfterAt=source.errorCode==='rate-limited'?error.retryAfterAt:null;
    if(!validateAPSource(source,catalog).ok) throw new Error('Retained AP snapshot rejected.');
    return source;
  }
}

export function apRaceObservation(source,raceId){
  if(!plain(source) || !plain(source.observations) || !id(raceId) || !own(source.observations,raceId)) return null;
  const o=source.observations[raceId];if(!plain(o) || !Array.isArray(o.history)) return null;
  const {history,...fact}=o;
  return validFact(fact,raceId,source.checkedAt)?clone(o):null;
}

// Keep browser-only observations when a slower published snapshot arrives.
export function mergeAPSources(catalog,current,incoming){
  current??=emptyAPSource();incoming??=emptyAPSource();
  for(const source of [current,incoming]) if(!validateAPSource(source,catalog).ok) throw new Error('AP merge snapshot rejected.');
  const newer=Date.parse(incoming.checkedAt||0)>Date.parse(current.checkedAt||0)?incoming:current;
  const result=clone(newer);result.observations={};
  const raceIds=new Set([...Object.keys(current.observations),...Object.keys(incoming.observations)]);
  for(const raceId of raceIds){
    const a=current.observations[raceId],b=incoming.observations[raceId];
    if(!a||!b){result.observations[raceId]=clone(a||b);continue;}
    const events=new Map();
    for(const event of [...a.history,...b.history]){
      const key=`${event.postUri}:${event.cid}`,prior=events.get(key);
      if(prior && FACT_KEYS.filter(k=>k!=='observedAt').some(k=>prior[k]!==event[k])) throw new Error('Conflicting AP revision facts.');
      if(!prior || Date.parse(event.observedAt)<Date.parse(prior.observedAt))events.set(key,clone(event));
    }
    const history=[...events.values()].sort((x,y)=>Date.parse(x.publishedAt)-Date.parse(y.publishedAt)||Date.parse(x.observedAt)-Date.parse(y.observedAt));
    // Simultaneous conflicting observations have no defensible total order.
    if(history.some((event,i)=>i&&event.publishedAt===history[i-1].publishedAt&&(event.candidateId!==history[i-1].candidateId || event.observedAt===history[i-1].observedAt && event.status!==history[i-1].status))) throw new Error('Conflicting simultaneous AP observations.');
    result.observations[raceId]={...history.at(-1),history};
  }
  result.checkedAt=[current.checkedAt,incoming.checkedAt].filter(Boolean).sort((a,b)=>Date.parse(b)-Date.parse(a))[0]||null;
  result.asOf=Object.values(result.observations).reduce((latest,o)=>!latest||Date.parse(o.publishedAt)>Date.parse(latest)?o.publishedAt:latest,null);
  if(result.asOf){result.identity.verified=true;if(result.status==='error')result.status='retained-error';}
  const validation=validateAPSource(result,catalog);if(!validation.ok) throw new Error('Merged AP snapshot rejected: '+validation.errors.join('; '));
  return result;
}

export function apControlSummary(catalog,source){
  const summary=Object.fromEntries(['house','senate','governor'].map(office=>[office,{called:Object.fromEntries(PARTIES.map(p=>[p,0])),calledTotal:0,currentTotal:0,unallocated:0}]));
  const valid=validateAPSource(source,catalog).ok;
  for(const race of catalogRaces(catalog)){
    if(!allowedRace(race) || race.seatVoting!==true || race.kind==='delegate') continue;
    const bucket=summary[race.office];bucket.currentTotal++;
    const observation=valid?apRaceObservation(source,race.id):null;
    if(observation?.status==='called'){bucket.called[observation.party]++;bucket.calledTotal++;}
  }
  for(const bucket of Object.values(summary)) bucket.unallocated=bucket.currentTotal-bucket.calledTotal;
  return summary;
}
