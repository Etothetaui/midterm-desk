import {safeSourceUrl,formatNumber,calledControlSummary} from './model.mjs';

const n=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const add=(e,...children)=>{e.append(...children);return e;};
const link=(text,url)=>{const safe=safeSourceUrl(url);if(!safe)return n('span','fine',text+' (link unavailable)');const a=n('a','source-link',text+' ↗');a.href=safe;a.target='_blank';a.rel='noopener noreferrer';return a;};
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const date=x=>x?String(x).slice(0,10):'Not supplied';
export const formatChance=x=>!finite(x)?'Unavailable':x<.01?'<1%':x>.99?'>99%':`${Math.round(x*100)}%`;
const pct=formatChance;
const margin=(x,left='D')=>!finite(x)?'Unavailable':x===0?'Even':`${x>0?left:'R'} +${formatNumber(Math.abs(x))}`;
const raceName=r=>r.title||`${r.stateName||r.state} · ${r.office==='house'?(r.kind==='delegate'?'Delegate':r.district===0?'House at-large':'House '+r.district):r.office==='senate'?'Senate'+(r.kind==='special'?' special':''):'Governor'}`;

// Admission is independent of the vote-count catalog. A broken analytics feed
// must never replace either the last good analytics or validated reported votes.
export function validateAnalysis(a,catalog){
  const errors=[];const fail=s=>errors.push(s);
  if(!a||a.schemaVersion!==1||!a.races||Array.isArray(a.races)||!safeSourceUrl(a.source?.url)||!safeSourceUrl(a.source?.methodologyUrl))return {ok:false,errors:['Invalid analysis envelope/source.']};
  const ids=new Set(catalog.races.map(r=>r.id));
  const expected=catalog.races.filter(r=>r.seatVoting&&['house','senate','governor'].includes(r.office));
  for(const r of expected)if(!a.races[r.id]?.forecast)fail('Missing state forecast '+r.id);
  if(Object.keys(a.races).length>600)fail('Too many analytical races.');
  const day=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString().slice(0,10)===x;
  const validatePolls=(polls,label)=>{const pollIds=new Set();for(const p of polls){if(!p||typeof p.id!=='string'||!p.id.trim()||p.id.length>200||pollIds.has(p.id)||typeof p.pollster!=='string'||!p.pollster.trim()||p.pollster.length>500||!Array.isArray(p.figures)||!p.figures.length||p.figures.length>30||new Set(p.figures.map(v=>v?.name)).size!==p.figures.length||!safeSourceUrl(p.url)||!day(p.endDate)||(p.startDate!==null&&(!day(p.startDate)||p.startDate>p.endDate))||(p.sample!==null&&(!finite(p.sample)||p.sample<=0))||p.figures.some(v=>!v||typeof v.name!=='string'||!v.name.trim()||v.name.length>500||!finite(v.value)||v.value<0||v.value>100))fail('Invalid poll '+label);pollIds.add(p?.id);}};
  for(const[id,r]of Object.entries(a.races)){
    if(!ids.has(id)||!r||!Array.isArray(r.polls)||r.polls.length>2000){fail('Invalid analysis race '+id);continue;}
    if(r.unmatchedPolls!==undefined&&(!Array.isArray(r.unmatchedPolls)||r.unmatchedPolls.length>100)){fail('Invalid unmatched observations '+id);continue;}
    const f=r.forecast;
    if(f&&(!finite(f.chanceLeft)||f.chanceLeft<0||f.chanceLeft>1||!safeSourceUrl(f.url)||!finite(f.margin)||!finite(f.low80)||!finite(f.high80)||f.low80>f.high80||(!f.sourceRecord?.only_one_party&&(typeof f.leftCandidate!=='string'||typeof f.repCandidate!=='string'))))fail('Invalid forecast '+id);
    validatePolls([...r.polls,...(r.unmatchedPolls||[])],id);
  }
  if(a.national?.genericPolls!==undefined){if(!Array.isArray(a.national.genericPolls)||a.national.genericPolls.length>2000)fail('Invalid national generic polls');else validatePolls(a.national.genericPolls,'national generic ballot');}
  if(!Array.isArray(a.national?.history)||!a.national?.summary)fail('National control history/summary required.');
  for(const h of [...(a.national?.history||[]),a.national?.summary].filter(Boolean)){
    if(!day(h.date)||['houseDChance','senateDChance','senateRChance'].some(k=>!finite(h[k])||h[k]<0||h[k]>1)||h.senateDChance+h.senateRChance>1.011||!Number.isInteger(h.houseDSeats)||h.houseDSeats<0||h.houseDSeats>435||!Number.isInteger(h.senateDSeats)||h.senateDSeats<0||h.senateDSeats>100||h.houseLow80>h.houseDSeats||h.houseHigh80<h.houseDSeats||h.senateLow80>h.senateDSeats||h.senateHigh80<h.senateDSeats)fail('Invalid national control estimate.');
  }
  return {ok:!errors.length,errors};
}

export function forecastRanking(analysis,id){const f=analysis?.races?.[id]?.forecast;return f&&finite(f.chanceLeft)?Math.abs(f.chanceLeft-.5):2;}
export function forecastLabel(analysis,id){const f=analysis?.races?.[id]?.forecast;return f?`${f.rating} · ${f.candidateMatch?'named matchup':'check matchup'}`:'No connected forecast';}

function table(headers,rows){const wrap=n('div','analysis-table-wrap'),t=n('table','analysis-table'),head=n('thead'),hr=n('tr');for(const h of headers){const th=n('th','',h);th.scope='col';hr.append(th);}head.append(hr);const body=n('tbody');for(const row of rows){const tr=n('tr');for(const item of row){const td=n('td');td.append(item instanceof Node?item:document.createTextNode(String(item??'—')));tr.append(td);}body.append(tr);}add(t,head,body);wrap.append(t);return wrap;}

function svgNode(tag,attrs,text){const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const[k,v]of Object.entries(attrs||{}))e.setAttribute(k,String(v));if(text!==undefined)e.textContent=text;return e;}
// Numeric chart geometry is built from admitted observations; source strings
// are always text nodes, including SVG labels and descriptions.
function lineChart(points,series,{min=0,max=100,label='Trend',dots=false}={}){
  if(!points.length)return n('p','fine','No observations meet the chart filters.');
  const svg=svgNode('svg',{viewBox:'0 0 620 235',role:'img','aria-label':label,class:'analysis-chart'});
  svg.append(svgNode('title',{},label));const left=48,right=598,top=18,bottom=190;
  const times=points.map(p=>Date.parse(p.date));const tmin=Math.min(...times),tmax=Math.max(...times);
  const x=p=>left+(tmax===tmin?.5:(Date.parse(p.date)-tmin)/(tmax-tmin))*(right-left);const y=v=>bottom-(v-min)/(max-min)*(bottom-top);
  for(let i=0;i<=4;i++){const v=min+(max-min)*i/4;svg.append(svgNode('line',{x1:left,x2:right,y1:y(v),y2:y(v),stroke:'#303c4e'}),svgNode('text',{x:left-8,y:y(v)+4,'text-anchor':'end',fill:'#a0acbb','font-size':11},String(Math.round(v))));}
  const colors={D:'#70a9ff',R:'#f58a7b',I:'#bc9de9',G:'#7ac5a2',OTHER:'#dce996'};
  for(const s of series){const valid=points.filter(p=>finite(p[s.key]));if(!valid.length)continue;const color=s.color||colors[s.party]||colors.OTHER;if(!dots)svg.append(svgNode('polyline',{points:valid.map(p=>`${x(p)},${y(p[s.key])}`).join(' '),fill:'none',stroke:color,'stroke-width':2.3,'stroke-dasharray':s.dashed?'6 4':'none'}));for(const p of valid){const dot=svgNode('circle',{cx:x(p),cy:y(p[s.key]),r:dots?3.5:2,fill:color});dot.append(svgNode('title',{},`${p.date} · ${s.label}: ${formatNumber(p[s.key])}${p.pollster?' · '+p.pollster:''}`));svg.append(dot);}}
  for(const t of [...new Set([tmin,(tmin+tmax)/2,tmax])])svg.append(svgNode('text',{x:left+(tmax===tmin?.5:(t-tmin)/(tmax-tmin))*(right-left),y:215,'text-anchor':'middle',fill:'#a0acbb','font-size':11},new Date(t).toISOString().slice(5,10)));
  const box=n('div');box.append(svg);const legend=n('div','analysis-legend');for(const s of series){const item=n('span','',`${s.dashed?'┄':'●'} ${s.label}`);item.style.color=s.color||colors[s.party]||colors.OTHER;legend.append(item);}box.append(legend);return box;
}

export function controlCards(a,catalog,onSelect){
  const root=document.createDocumentFragment();const summary=a?.national?.summary;
  const called=calledControlSummary(catalog);
  const calledGroup=n('section','called-control-group');calledGroup.setAttribute('aria-label','Last observed publisher calls');calledGroup.append(add(n('div','called-control-heading'),n('h3','','Last observed publisher calls'),n('p','fine','Reported publisher projections are separate from the forecast estimates above.')));
  for(const[office,title]of[['house','U.S. House'],['senate','U.S. Senate']]){const s=called[office],card=n('article','overview-card control-card');card.append(add(n('div','card-title'),n('h3','',title+' · publisher calls'),n('span','pill','Last observed calls')));card.append(add(n('div','metric-row'),n('strong','big-number',`${s.calledSeats} / ${s.currentTotal}`),n('span','metric-caption','current-election seats with a supported publisher call')));card.append(n('p','fine',`Called: D ${s.called.D} · R ${s.called.R} · I ${s.called.I} · other ${s.called.L+s.called.G+s.called.OTHER}. ${s.uncalledCurrent} current-election seats unallocated.`));if(office==='senate')card.append(n('p','fine',s.carryoverKnown?`65 seats not voting: ${s.carryover.D} D · ${s.carryover.R} R · ${s.carryover.I} I. Combined affiliation: ${s.seats.D} D · ${s.seats.R} R · ${s.seats.I} I; ${s.unallocated} of 100 unallocated. Independents remain separate; no caucus assumption.`:'The 65-seat nonvoting baseline is unavailable; no chamber affiliation total is inferred.'));if(s.stale)card.append(n('p','notice error',`${s.stale} call observations have a source refresh warning. Last supported calls remain counted; a network failure is not a retraction.`));if(s.excluded)card.append(n('p','fine',`${s.excluded} retained or unconfirmed call records are excluded from this tally.`));card.append(n('p','fine','civicAPI decision-desk winner flags are publisher projections, not certification. General-election voting seats only; no winner is inferred from vote leads or forecasts.'));calledGroup.append(card);}
  if(!summary){root.append(calledGroup);return root;}
  for(const [title,chance,seats,lo,hi,note]of[
    ['U.S. House',summary.houseDChance,summary.houseDSeats,summary.houseLow80,summary.houseHigh80,'218 seats for a majority · 435 voting seats'],
    ['U.S. Senate',summary.senateDChance,summary.senateDSeats,summary.senateLow80,summary.senateHigh80,'51 Democratic seats for control · Republicans need 50'],
    ['Governors',null,summary.governorsD,null,null,'Projected Democratic state governors after the election · of 50']]){
    const c=n('article','overview-card control-card');c.append(add(n('div','card-title'),n('h3','',title),n('span','pill','Publisher forecast')));
    c.append(add(n('div','metric-row'),n('strong','big-number',chance===null?String(seats??'—'):pct(chance)),n('span','metric-caption',chance===null?'projected D governors':'chance of Democratic control')));
    if(chance!==null){const track=n('div','track');const s=n('span','D');s.style.width=`${chance*100}%`;track.append(s);c.append(track);c.append(n('p','fine',`${seats??'—'} ${title==='U.S. Senate'?'D-aligned seats (includes caucusing independents)':'D seats'} · 80% range ${lo??'—'}–${hi??'—'}`));}
    c.append(n('p','fine',note));if(title==='U.S. Senate')c.append(n('p','fine',`Republican control ${pct(summary.senateRChance)}. Unaligned independents may hold the balance; they are not automatically Democrats.`));root.append(c);
  }
  root.append(calledGroup);return root;
}

export function renderAnalysisHub(target,a,catalog,onSelect){
  target.replaceChildren();if(!a){target.append(n('p','notice error','Analysis data unavailable. Candidate catalogs and reported counts remain available.'));return;}
  const provenance=add(n('p','fine'),document.createTextNode(`${a.source.name} · forecast dataset ${a.source.asOf} · retrieved ${date(a.source.retrievedAt)}. Forecasts are estimates, not calls. `),link('Method and limitations',a.source.methodologyUrl));target.append(provenance);
  target.append(n('p','fine',a.source.dateNote));
  const grid=n('div','analysis-hub-grid');const closest=n('section','panel analysis-panel');closest.append(n('h3','','Races to watch'),n('p','fine','Closest modeled matchups. Choose one to compare its candidates, odds, polls and source evidence. A close race is not necessarily the chamber tipping point.'));
  for(const office of ['house','senate','governor']){const cohort=n('div','watch-cohort');cohort.append(n('h4','',office==='house'?'House':office==='senate'?'Senate':'Governors'));const races=catalog.races.filter(r=>r.office===office&&a.races[r.id]?.forecast).sort((x,y)=>forecastRanking(a,x.id)-forecastRanking(a,y.id)).slice(0,5);for(const r of races){const f=a.races[r.id].forecast;const b=n('button','watch-race');b.type='button';add(b,n('strong','',raceName(r)),n('span','',`${margin(f.margin,f.leftParty)} · ${f.rating}`));b.addEventListener('click',()=>onSelect(r.id));cohort.append(b);}closest.append(cohort);}
  grid.append(closest);const history=n('section','panel analysis-panel');history.append(n('h3','','How control chances moved'));
  const rows=a.national?.history||[];const archived=rows.filter(r=>!r.reconstructed).sort((x,y)=>x.date.localeCompare(y.date));
  history.append(n('p','fine','Published weekly snapshots since September 29. Both chambers stay visible. This is a pre-election model history; counted votes do not change these forecasts.'));
  history.append(lineChart(archived.map(p=>({...p,house:p.houseDChance*100,senate:p.senateDChance*100})),[{key:'house',label:'House · Democratic majority',party:'D'},{key:'senate',label:'Senate · Democratic control',party:'I',dashed:true}],{label:'Democratic chamber control probability over time, percent'}));
  const d=n('details');d.append(n('summary','','History table and reconstructed earlier estimates'));d.append(table(['Date','House D control','Senate D / R control','D seats H / S','History type'],[...rows].reverse().map(p=>[p.date,pct(p.houseDChance),`${pct(p.senateDChance)} / ${pct(p.senateRChance)}`,`${p.houseDSeats} / ${p.senateDSeats}`,p.reconstructed?'Reconstructed with today’s candidates/code':'Published snapshot'])));history.append(d,link('Original history and reconstruction limits','https://www.pollingforecast.com/us/history'));grid.append(history);target.append(grid);
  const methodology=n('details','analysis-method');methodology.append(n('summary','','How to read the forecasts and polling evidence'));
  methodology.append(n('p','','Polling Forecast combines pollster-adjusted, recency/sample/quality-weighted polls with fitted partisan lean and incumbency fundamentals. Its 5,000 simulations include shared national, regional, state and demographic error. A 70% chance means the modeled side still loses roughly 3 times in 10. This app displays its published output; the model has not been independently replicated here.'));
  methodology.append(n('p','','Most House districts have few or no polls. Their projections depend on fundamentals, including estimated 2024 presidential results on new district lines. Independents, ranked-choice and same-party races require special care: a party’s seat chance is not every candidate’s individual chance. Candidates without a source estimate are labeled unmodeled. Poll source grades A/B/C describe provenance, not poll accuracy: C is a Wikipedia compilation even when a release URL is supplied.'));
  methodology.append(link('Source, reuse terms and downloadable data',a.source.url),link('Forecast methodology',a.source.methodologyUrl));target.append(methodology);
}

function forecastBlock(record,race,source){
  const f=record.forecast,box=n('section','detail-block analysis-forecast');box.append(n('h4','','Win chances & uncertainty'));
  if(!f){box.append(n('p','fine','No defensible published forecast is connected for this contest. No numerical odds have been invented.'));return box;}
  const only=f.sourceRecord?.only_one_party;
  if(only){box.append(n('p','fine',`${only} party ownership is the publisher's uncontested/same-party seat assessment. It is not a victory probability or a projected margin between individual candidates. Candidate polls, when available, appear below.`),link('Source party assessment',f.url));return box;}
  if(race.stage==='primary')box.append(n('p','notice error','Stage and field caution: Louisiana calls this an open primary. The publisher uses a general-election convention and models a principal pair, not all candidates or runoff qualification. These source odds do not estimate every primary candidate.'));
  if(!f.candidateMatch)box.append(n('p','notice error',`Matchup warning: this source models ${f.leftCandidate} versus ${f.repCandidate}. Its names differ from the catalog. Treat these as source-model output, not verified odds for a different candidate.`));
  const metric=add(n('div','forecast-metric'),n('strong','big-number',only?'Party estimate':pct(f.chanceLeft)),n('span','',only?`${only} seat ownership · individual candidates not estimated`:`${f.leftCandidate} (${f.leftParty}) · publisher win frequency`));box.append(metric);
  if(!only){const track=n('div','track');const fill=n('span',f.leftParty==='I'?'I':'D');fill.style.width=`${f.chanceLeft*100}%`;track.append(fill);box.append(track);}
  if(finite(f.chanceRightModeledPair))box.append(n('p','fine',`${f.repCandidate}: ${pct(f.chanceRightModeledPair)} in the source's two-candidate model (1 minus the modeled left-side frequency). This conditional model does not estimate every minor candidate.`));
  box.append(n('p','fine',`Modeled matchup: ${f.leftCandidate} (${f.leftParty}) / ${f.repCandidate} (R). ${f.rating}. The source models the principal opposition to Republicans; other candidates do not inherit the residual probability.`));
  box.append(table(['Measure','Source estimate'],[['Projected margin',margin(f.margin,f.leftParty)],['80% simulated margin range',`${margin(f.low80,f.leftParty)} to ${margin(f.high80,f.leftParty)}`],['Adjusted polling margin',margin(f.pollAverage,f.leftParty)],['Fundamentals margin',margin(f.fundamentalsMargin,f.leftParty)],['Poll share of model blend',finite(f.pollWeight)?`${Math.round(f.pollWeight*100)}%`:'Not supplied'],['Polls used by publisher',f.pollsUsed],['2024 presidential D–R margin',margin(f.presidential2024Margin)]]));
  box.append(n('p','fine',`Forecast as of ${date(f.asOf)}. The 80% range describes model uncertainty; outcomes outside it remain possible. The polling margin is adjusted/decided-vote output, not raw support or a probability. Raw polls below may differ in inclusion and date. Simulation frequencies of 0/1 display as <1%/>99%, avoiding a claim of certainty.`));
  box.append(link('Full race forecast & model',f.url),link('Methodology',source.methodologyUrl));return box;
}

export function raceAnalysis(a,race,{showForecast=true}={}){
  const fragment=document.createDocumentFragment();const record=a?.races?.[race.id];if(!record){fragment.append(forecastBlock({forecast:null},race,a?.source));return fragment;}
  if(showForecast)fragment.append(forecastBlock(record,race,a.source));
  const box=n('section','detail-block');box.append(n('h4','','Polling over time'));
  const unmatchedIds=new Set((record.unmatchedPolls||[]).map(p=>p.id));const polls=[...(record.polls||[]),...(record.unmatchedPolls||[])].sort((a,b)=>b.endDate.localeCompare(a.endDate));if(!polls.length){box.append(n('p','fine','No compatible general-election poll is connected. The forecast above may rely on fundamentals; lack of polling is not evidence of a tie.'));fragment.append(box);return fragment;}
  const controls=n('div','analysis-controls');const windowLabel=n('label','','Field window '),period=n('select');for(const[v,t]of[['30','Last 30 days'],['90','Last 90 days'],['all','All available']]){const o=n('option','',t);o.value=v;period.append(o);}windowLabel.append(period);const popLabel=n('label','','Population '),population=n('select');for(const[v,t]of[['all','All populations'],['LV','Likely voters'],['RV','Registered voters'],['A','Adults']]){const o=n('option','',t);o.value=v;population.append(o);}popLabel.append(population);period.dataset.focus='poll-'+race.id+'-window';population.dataset.focus='poll-'+race.id+'-population';period.setAttribute('aria-label','Race poll field window');population.setAttribute('aria-label','Race poll population');controls.append(windowLabel,popLabel);const scaleLabel=n('label','','Chart scale '),scale=n('select');for(const[v,t]of[['focus','Fit all candidate values'],['full','Full 0–100%']]){const o=n('option','',t);o.value=v;scale.append(o);}scale.dataset.focus='poll-'+race.id+'-scale';scale.setAttribute('aria-label','Race poll chart scale');scaleLabel.append(scale);controls.append(scaleLabel);box.append(controls);const firmLabel=n('label','','Pollster '),firm=n('select');firm.append(add(n('option','','All pollsters'),document.createTextNode('')));firm.firstChild.value='all';for(const name of [...new Set(polls.map(p=>p.pollster))].sort()){const o=n('option','',name);o.value=name;firm.append(o);}firm.dataset.focus='poll-'+race.id+'-pollster';firm.setAttribute('aria-label','Race pollster');firmLabel.append(firm);controls.append(firmLabel);const content=n('div');box.append(content);
  function paint(){const latest=Math.max(...polls.map(p=>Date.parse(p.endDate)));const chosen=polls.filter(p=>(period.value==='all'||latest-Date.parse(p.endDate)<=Number(period.value)*86400000)&&(population.value==='all'||p.population===population.value)&&(firm.value==='all'||p.pollster===firm.value));content.replaceChildren();content.append(n('p','fine',`${chosen.length} of ${polls.length} relevant general-election observations · window ends at newest poll, ${new Date(latest).toISOString().slice(0,10)}. Points are raw published shares; no line or invented uncertainty band connects differing surveys.`));
    const names=race.id==='US-generic'?['Democratic candidate','Republican candidate']:[...new Set(chosen.flatMap(p=>p.figures.filter(v=>!['UND','OTHER','OTH'].includes(v.party)).map(v=>v.name)))].slice(0,6);
    const series=names.map((name,i)=>({key:'s'+i,label:name,party:race.id==='US-generic'?(i===0?'D':'R'):chosen.flatMap(p=>p.figures).find(v=>v.name===name)?.party}));const points=chosen.map(p=>{const point={date:p.endDate,pollster:p.pollster};for(const[i,name]of names.entries())point['s'+i]=p.figures.find(v=>race.id==='US-generic'?v.party===(i===0?'D':'R'):v.name===name)?.value;return point;}).sort((x,y)=>x.date.localeCompare(y.date));const values=points.flatMap(p=>series.map(s=>p[s.key])).filter(finite);const min=scale.value==='full'?0:Math.max(0,Math.floor((Math.min(...values)-3)/5)*5);const max=scale.value==='full'?100:Math.min(100,Math.ceil((Math.max(...values)+3)/5)*5);content.append(lineChart(points,series,{min,max,label:`Raw candidate poll support over time in ${race.title||race.id}, percent; axis ${min} to ${max}`,dots:true}));
    content.append(table(['Poll / field dates','Sample / method','Published responses'],chosen.map(p=>{const first=add(n('div'),link(p.pollster,p.url),n('small','',`${p.startDate||'Start not supplied'} – ${p.endDate}`),n('small','',p.question||''));if(unmatchedIds.has(p.id))first.append(n('p','notice error','Source candidate field differs from catalog; shown under original names. Do not combine with another matchup.'));const middle=add(n('div'),n('strong','',`${p.population||'Unknown population'} · ${p.sample?'n '+p.sample:'sample not supplied'}`),n('small','',p.sponsor?`Sponsor: ${p.sponsor}${p.partisan?' · '+p.partisan+' partisan':''}`:p.partisan?'Partisan: '+p.partisan:'Sponsor not supplied'),n('small','',p.confirmation?'Original release checked':'Publisher-compiled · provenance '+p.sourceGrade));const details=n('details');details.append(n('summary','','Provenance, corrections & reuse'),n('p','fine',p.license));if(p.denominator)middle.append(n('small','',p.denominator));if(p.interval)middle.append(n('small','',`Margin of error: +/-${p.interval.value} points${p.interval.confidenceLevel?' at '+p.interval.confidenceLevel+'% confidence':''} · ${p.interval.target||'target not supplied'}`));if(p.confirmation?.note)details.append(n('p','fine',p.confirmation.note));for(const c of p.corrections||[])details.append(n('p','fine',c.reason));details.append(n('p','fine',`Question: ${p.question||'not supplied'}. ${p.denominator||''}. Response rounding is preserved; totals may differ from 100.`));middle.append(details);const values=n('div');for(const v of p.figures)values.append(n('div',`poll-share ${v.party}`,`${v.name}: ${formatNumber(v.value)}%`));return[first,middle,values];})));
    if(!chosen.length)content.append(n('p','fine','No polls meet these filters.'));
  }
  period.addEventListener('change',paint);population.addEventListener('change',paint);scale.addEventListener('change',paint);firm.addEventListener('change',paint);paint();fragment.append(box);return fragment;
}

export function compareRaces(target,a,catalog,ids,remove){
  target.replaceChildren();if(!ids.length){target.append(n('p','fine','Open a race and choose Compare. Keep up to four races together here to compare probabilities, margins, evidence and fresh polling.'));return;}
  const selected=ids.map(id=>catalog.races.find(r=>r.id===id)).filter(Boolean);const headers=['Measure',...selected.map(raceName)];const rows=[];
  rows.push(['Modeled candidate',...selected.map(r=>{const f=a?.races[r.id]?.forecast;return f?.sourceRecord?.only_one_party?'Party ownership only':f?.leftCandidate||'No connected forecast';})]);
  if(selected.some(r=>r.office==='governor'&&r.candidates?.some(c=>c.runningMate)))rows.push(['Governor / lieutenant-governor ticket',...selected.map(r=>{if(r.office!=='governor')return 'Not a governor contest';const tickets=(r.candidates||[]).filter(c=>typeof c.runningMate==='string'&&c.runningMate.trim());if(!tickets.length)return 'Running-mate data not connected';const cell=n('div');for(const c of tickets)cell.append(n('div','',`${c.name} / ${c.runningMate} (${c.party})`));return cell;})]);
  rows.push(['Win frequency',...selected.map(r=>{const f=a?.races[r.id]?.forecast;return f?.sourceRecord?.only_one_party?'Individual odds unmodeled':f?pct(f.chanceLeft):'Unmodeled';})]);
  rows.push(['Projected margin',...selected.map(r=>{const f=a?.races[r.id]?.forecast;return f?.sourceRecord?.only_one_party?'Not a candidate margin':margin(f?.margin,f?.leftParty);})]);
  rows.push(['80% margin range',...selected.map(r=>{const f=a?.races[r.id]?.forecast;return f&&!f.sourceRecord?.only_one_party?`${margin(f.low80,f.leftParty)} to ${margin(f.high80,f.leftParty)}`:'Unavailable';})]);
  rows.push(['Latest admitted poll',...selected.map(r=>{const p=a?.races[r.id]?.polls?.[0];return p?`${p.pollster} · ${p.endDate} · ${p.figures.map(v=>`${v.name} ${v.value}%`).join('; ')}`:'No compatible poll';})]);
  rows.push(['Matchup',...selected.map(r=>r.stage==='primary'?'Open-primary field / source stage require review':a?.races[r.id]?.forecast?.candidateMatch?'Source names reconciled with catalog':'Review source matchup')]);
  rows.push(['',...selected.map(r=>{const b=n('button','text-button','Remove '+(r.title||r.id));b.type='button';b.addEventListener('click',()=>remove(r.id));return b;})]);target.append(table(headers,rows));
}

export function nativeResultsBlock(record){
  const section=n('section','detail-block');section.append(n('h4','','National publisher returns'));
  if(!record.reported)section.append(n('p','fine','Connected source has not reported votes for this contest. Its zero-filled template is not counted turnout.'));
  else{const total=record.candidates.reduce((sum,c)=>sum+c.votes,0);section.append(table(['Publisher candidate / party','Reported votes','Share of reported votes'],record.candidates.map(c=>[`${c.name} (${c.party})`,formatNumber(c.votes),total?`${(c.votes/total*100).toFixed(1)}%`:'Unavailable'])));section.append(n('p','fine',`${formatNumber(total)} reported candidate votes. Percentages describe only this count; remaining votes are unknown.`));}
  const call=record.sourceCall,status=record.sourceCallStatus||'unknown';
  if(status==='called'&&call)section.append(n('p','notice',`${call.sourceName} projects ${call.name} (${call.party||'party not supplied'}). Source record ${call.asOf}; first observed ${call.firstObservedAt}. Publisher call time is not supplied. This is a projection, not certification.`));
  else if(status==='retracted')section.append(n('p','notice error','Publisher winner flag was removed. The earlier projection is retracted and does not allocate a seat.'));
  else if(status.startsWith('retained-')&&call)section.append(n('p','notice error',`Earlier projection retained for audit: ${call.name} (${call.party||'party not supplied'}), source record ${call.asOf}. Latest call state is ${status}; excluded from the supported-call tally.`));
  else section.append(n('p','fine',`Publisher call status: ${status}. No supported active projection is inferred.`));
  if(record.fetchHealth)section.append(n('p','notice error',`Source refresh warning: ${record.fetchHealth.status||'unknown'} · ${record.fetchHealth.reason||'prior source observation retained'} · checked ${record.fetchHealth.checkedAt||'not supplied'}.`));
  if(record.sourceCallHistory?.length){const history=n('details');history.append(n('summary','','Publisher call / retraction history'),table(['Observed','Change','Previous projection','New projection'],record.sourceCallHistory.map(h=>[h.detectedAt,h.action,h.previousCall?`${h.previousCall.name} (${h.previousCall.party||'unknown'})`:'None',h.newCall?`${h.newCall.name} (${h.newCall.party||'unknown'})`:'None'])));section.append(history);}
  section.append(n('p','fine',`civicAPI · source record ${record.asOf||'clock not supplied'} · checked ${record.checkedAt||'not supplied'}. ${record.matchStatus==='exact-candidate-match'?'Candidate inventory exactly matched the catalog.':'Candidate or stage reconciliation requires review. Source-native names stay separate from the catalog.'}`),link('Original publisher contest',record.detailUrl));return section;
}

export function nationalPolling(a){
  if(!a)return n('p','fine','Broader national polling is unavailable.');
  const race={id:'US-generic',title:'National generic ballot'};
  return raceAnalysis({...a,races:{'US-generic':{polls:a.national.genericPolls||[],unmatchedPolls:[]}}},race,{showForecast:false});
}
