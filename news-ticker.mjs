import {activeSourceCall,safeSourceUrl} from './model.mjs';
import {apRaceObservation} from './ap-source.mjs';

const serial=value=>JSON.stringify(value??null);
const number=value=>new Intl.NumberFormat('en-US').format(value);
const title=r=>r.title||`${r.stateName||r.state} ${r.office==='house'?`House ${r.district===0?'at-large':`district ${r.district}`}`:r.office==='senate'?'Senate':'governor'}${r.kind==='special'?' special election':''}`;
const total=rows=>(rows||[]).reduce((n,row)=>n+(Number.isSafeInteger(row.votes)&&row.votes>=0?row.votes:0),0);
const votes=rows=>serial((rows||[]).map(r=>[r.candidateId??r.sourceId,r.votes]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
const apIdentity=o=>o?[o.status,o.candidateId,o.postUri,o.cid]:null;
const callIdentity=c=>c?[c.candidateSourceId,c.name,c.party]:null;

// Only compare validated display state. Check timestamps alone are not new
// votes, and AP/civicAPI projections never inherit a numerical leader's name.
export function describeUpdates(previous,next){
  if(!previous||!next)return [];
  const events=[];
  const emit=(id,text,url=null,priority=3)=>events.push({id,text,url:safeSourceUrl(url),priority});
  const catalog=next.catalog,oldCatalog=previous.catalog;
  if(catalog&&oldCatalog&&catalog!==oldCatalog){
    const oldRaces=new Map(oldCatalog.races.map(r=>[r.id,r]));
    for(const r of catalog.races){
      const old=oldRaces.get(r.id);if(!old)continue;
      const key=`${catalog.snapshotId}:${r.id}`;
      const native=catalog.nationalResultRecords?.[r.id],prior=oldCatalog.nationalResultRecords?.[r.id];
      const call=activeSourceCall(native,r),oldCall=activeSourceCall(prior,old);
      if(serial(callIdentity(call))!==serial(callIdentity(oldCall))){
        if(call)emit('call:'+key,`civicAPI projects ${call.name} in ${title(r)} · publisher projection, not certification`,native.sourceUrl,0);
        else if(native?.sourceCallStatus==='retracted')emit('withdrawal:'+key,`civicAPI withdrew its projection in ${title(r)}`,native.sourceUrl,0);
        else if(oldCall)emit('call-review:'+key,`civicAPI call status needs review in ${title(r)} · see the source record`,native?.sourceUrl,1);
      }
      if(native?.reported===true&&(prior?.reported!==true||votes(native.candidates)!==votes(prior?.candidates)))
        emit('native-votes:'+key,`civicAPI returns · ${title(r)}: ${number(total(native.candidates))} reported votes · unofficial`,native.sourceUrl,2);
      if(r.results?.available===true&&(old.results?.available!==true||votes(r.results.votes)!==votes(old.results?.votes)))
        emit('official-votes:'+key,`Source-reported returns · ${title(r)}: ${number(total(r.results.votes))} votes · ${r.results.status==='certified'?'source marked certified':'unofficial'}`,r.results.sourceUrl,2);
      if(serial(r.candidates.map(c=>[c.id,c.name,c.party]))!==serial(old.candidates.map(c=>[c.id,c.name,c.party])))
        emit('catalog:'+key,`Candidate field revised · ${title(r)} · inspect the race sources`,r.verifiedCandidateSourceUrl,3);
    }
  }
  if(next.apSource!==previous.apSource){
    for(const r of catalog?.races||[]){
      const o=apRaceObservation(next.apSource,r.id),old=apRaceObservation(previous.apSource,r.id);
      if(!o||serial(apIdentity(o))===serial(apIdentity(old)))continue;
      emit(`ap:${r.id}:${o.postUri}:${o.cid}:${o.status}`,o.status==='called'?`AP public announcement · ${o.candidateName} named winner in ${title(r)} · partial announcement coverage`:`AP publicly withdrew its winner announcement in ${title(r)}`,o.sourceUrl,0);
    }
    const before=previous.apSource,after=next.apSource;
    if(before?.checkedAt&&after&&serial([before.status,before.errorCode])!==serial([after.status,after.errorCode])){
      const text=after.status==='ready'?'AP public-announcement connection recovered':after.errorCode==='revision-ambiguous'?'An edited AP post needs review · earlier observations retained':'AP public-announcement check unavailable · earlier observations retained';
      emit(`ap-health:${after.checkedAt}:${after.status}:${after.errorCode}`,text,'https://bsky.app/profile/apnews.com',1);
    }
  }
  if(next.analysis&&previous.analysis&&next.analysis!==previous.analysis){
    const a=next.analysis,b=previous.analysis;
    const changedForecasts=Object.entries(a.races||{}).filter(([id,r])=>serial(r.forecast)!==serial(b.races?.[id]?.forecast)).length;
    const changedPolls=Object.entries(a.races||{}).filter(([id,r])=>serial(r.polls)!==serial(b.races?.[id]?.polls)).length;
    const nationalChanged=serial(a.national)!==serial(b.national);
    if(changedForecasts||changedPolls||nationalChanged)
      emit(`analysis:${a.generatedAt}`,`${a.source?.name||'Polling source'} updated · ${changedForecasts} race estimates and ${changedPolls} race polling records changed${nationalChanged?' · national analysis revised':''} · estimates are not calls`,a.source?.url,3);
    else if(a.generatedAt!==b.generatedAt)
      emit(`analysis-refresh:${a.generatedAt}`,'Forecast dataset refreshed · no changed estimates or polls detected',a.source?.url,5);
  }
  if(!events.length&&catalog&&oldCatalog&&catalog.snapshotId!==oldCatalog.snapshotId)
    emit('snapshot:'+catalog.snapshotId,'Published snapshot updated · no changed vote totals or publisher calls detected',null,5);
  return events.sort((a,b)=>a.priority-b.priority);
}

// A finite run begins on an incoming update. The fixed-height bar never moves
// the desk; a persistent recent-update history retains the complete headlines.
export function mountNewsTicker(root){
  if(!root)return {update(){}}; // A stale cached header must not break the desk.
  const text=root.querySelector('.news-ticker-text'),window=root.querySelector('.news-ticker-window');
  const motion=root.querySelector('[data-ticker-motion]'),summary=root.querySelector('.news-ticker-summary');
  const list=root.querySelector('.news-ticker-history'),live=root.querySelector('.news-ticker-announcement');
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  let baseline=null,history=[],animation=null,stopped=reduced.matches,paused=false;
  function stop(){animation?.cancel();animation=null;}
  function run(){
    stop();
    if(stopped||paused||reduced.matches||!history.length)return;
    const width=window.clientWidth,distance=width+text.scrollWidth;
    const current=text.animate([{transform:`translateX(${width}px)`},{transform:`translateX(-${text.scrollWidth}px)`}],{duration:Math.max(12000,Math.min(120000,distance/55*1000)),iterations:1});
    animation=current;current.onfinish=()=>{if(animation===current)animation=null;};
  }
  function motionLabel(){motion.textContent=stopped?'Motion off':'Stop scrolling';motion.setAttribute('aria-pressed',String(stopped));}
  motion.addEventListener('click',()=>{stopped=!stopped;motionLabel();if(stopped)stop();else run();});
  reduced.addEventListener('change',()=>{if(reduced.matches){stopped=true;stop();motionLabel();}});
  motionLabel();
  return {update(next){
    const wasPaused=paused;paused=Boolean(next.paused);root.classList.toggle('ticker-paused',paused);
    if(paused){animation?.pause();root.querySelector('.news-ticker-label').textContent='UPDATES PAUSED';return;}
    root.querySelector('.news-ticker-label').textContent='LIVE UPDATES';
    if(!baseline){baseline=next;return;}
    const events=describeUpdates(baseline,next);baseline=next;
    if(!events.length){if(wasPaused)animation?.play();return;}
    const stamp=new Date().toISOString();
    history=[...events.slice(0,40).map(e=>({...e,seenAt:stamp})),...history].slice(0,40);
    const headlines=events.slice(0,8).map(e=>e.text);
    if(events.length>8)headlines.push(`${events.length-8} more changes · see Recent updates and race details`);
    text.textContent=headlines.join('   •   ');
    live.textContent=events.slice(0,2).map(e=>e.text).join('. ')+(events.length>2?` ${events.length-2} more updates.`:'');
    summary.textContent=`Recent updates (${history.length})`;
    list.replaceChildren(...history.map(e=>{const li=document.createElement('li'),time=document.createElement('time');time.dateTime=e.seenAt;time.textContent=new Date(e.seenAt).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});li.append(time,document.createTextNode(' · '));const label=document.createElement(e.url?'a':'span');label.textContent=e.text;if(e.url){label.href=e.url;label.target='_blank';label.rel='noopener noreferrer';label.dataset.focus='news-'+e.id;}li.append(label);return li;}));
    root.dataset.updateCount=String(history.length);run();
  }};
}
