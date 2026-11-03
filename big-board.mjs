// Original, dependency-free election analysis tools. Historical geography is not a 2026 district map.
const STATES = Object.fromEntries('01 AL|02 AK|04 AZ|05 AR|06 CA|08 CO|09 CT|10 DE|11 DC|12 FL|13 GA|15 HI|16 ID|17 IL|18 IN|19 IA|20 KS|21 KY|22 LA|23 ME|24 MD|25 MA|26 MI|27 MN|28 MS|29 MO|30 MT|31 NE|32 NV|33 NH|34 NJ|35 NM|36 NY|37 NC|38 ND|39 OH|40 OK|41 OR|42 PA|44 RI|45 SC|46 SD|47 TN|48 TX|49 UT|50 VT|51 VA|53 WA|54 WV|55 WI|56 WY|60 AS|66 GU|69 MP|72 PR|78 VI'.split('|').map(s=>s.split(' ')));
const finite = x => typeof x==='number' && Number.isFinite(x);
const count = x => (typeof x==='string' && /^\d+$/.test(x.trim())) || (Number.isSafeInteger(x) && x>=0);
const integer = x => count(x) ? BigInt(String(x).trim()) : null;
const fmt = x => x===null || x===undefined ? 'Unavailable' : typeof x==='string'&&/^\d+$/.test(x)?BigInt(x).toLocaleString('en-US'):Number(x).toLocaleString('en-US');
const signed = x => !finite(x) ? 'Unavailable' : x===0 ? 'Even' : `${x>0?'D':'R'} +${Math.abs(x).toFixed(1)}`;
const el = (tag,cls,text) => { const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e; };
const svgEl = (tag,attrs={},text) => {const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,String(v));if(text!==undefined)e.textContent=text;return e;};
const append = (e,...children) => { e.append(...children);return e; };
const button = (text,fn,cls='') => {const e=el('button',cls,text);e.type='button';e.addEventListener('click',fn);return e;};
function sourceLink(label,url){try{const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password)throw Error();const a=el('a','bb-source',label);a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';return a;}catch{return el('span','bb-muted',label+' — URL unavailable');}}

/** Exact integer threshold for A to finish strictly ahead of B; not a forecast or a runoff/RCV solver. */
export function solveOutstanding({a,b,remaining,otherRemaining}) {
  const values=[a,b,remaining,otherRemaining].map(integer);
  if(values.some(x=>x===null))return {status:'unknown',message:'Enter non-negative whole vote counts in all four fields. Blank means unknown.'};
  const[A,B,R,O]=values;
  if(O>R)return {status:'invalid',message:'Other-candidate remaining votes cannot exceed all remaining votes.'};
  const pair=R-O, deficit=B+pair-A;
  let need=deficit<0n?0n:deficit/2n+1n;
  if(pair===0n)return {status:'no-remaining',needed:need.toString(),pairRemaining:'0',message:A>B?'A already leads B; no assumed A/B ballots remain.':A===B?'A and B would remain tied.':'A cannot pass B with no assumed A/B ballots remaining.'};
  if(need>pair)return {status:'infeasible',needed:need.toString(),pairRemaining:pair.toString(),message:'A cannot pass B even by winning every assumed remaining A/B ballot.'};
  // Integer division rounds up to the hundredth of a percentage point; exact fraction is also returned.
  const hundredths=(need*10000n+pair-1n)/pair;
  return {status:'feasible',needed:need.toString(),pairRemaining:pair.toString(),share:`${hundredths/100n}.${String(hundredths%100n).padStart(2,'0')}%`,message:need===0n?'A would remain ahead of B even with no additional A votes under these assumptions.':'Minimum remaining A/B votes A needs to finish at least one vote ahead of B.'};
}

/** Decode TopoJSON deltas, transforms, reversed arcs, holes and multipolygons. */
export function decodeTopology(topology,objectName) {
  if(topology?.type!=='Topology'||!Array.isArray(topology.arcs))throw Error('Unsupported map topology');
  const tr=topology.transform;
  const arcs=topology.arcs.map(arc=>{let x=0,y=0;return arc.map(p=>{if(tr){x+=p[0];y+=p[1];return [x*tr.scale[0]+tr.translate[0],y*tr.scale[1]+tr.translate[1]];}return [...p];});});
  const ring=ids=>{const points=[];for(const id of ids){const raw=arcs[id<0?~id:id];if(!raw)throw Error('Missing topology arc');const p=id<0?[...raw].reverse():raw;points.push(...(points.length?p.slice(1):p));}return points;};
  const object=topology.objects?.[objectName];if(!object)throw Error('Missing topology layer');
  const geometries=object.type==='GeometryCollection'?object.geometries:[object];
  return geometries.map(g=>({id:String(g.id).padStart(objectName==='counties'?5:2,'0'),properties:g.properties||{},polygons:g.type==='Polygon'?[g.arcs.map(ring)]:g.type==='MultiPolygon'?g.arcs.map(p=>p.map(ring)):[]}));
}
export function geometryPath(feature){return feature.polygons.map(p=>p.map(r=>r.map((v,i)=>`${i?'L':'M'}${v[0].toFixed(2)},${v[1].toFixed(2)}`).join('')+'Z').join('')).join('');}
export function countyMargin(result){return result&&finite(result.D)&&finite(result.R)&&finite(result.total)&&result.D>=0&&result.R>=0&&result.total>0&&result.D+result.R<=result.total?(result.D-result.R)/result.total*100:null;}
export function countySwing(row){if(!row||row.geometryMatched===false||row.scope&&row.scope!=='county or county equivalent')return null;const a=countyMargin(row.pres2024),b=countyMargin(row.pres2020);return a!==null&&b!==null?a-b:null;}
export function historicalMapValue(row,mode){if(!row||row.geometryMatched===false)return null;return mode==='swing'?countySwing(row):countyMargin(row.pres2024);}
function bounds(features){let x=Infinity,y=Infinity,right=-Infinity,bottom=-Infinity;for(const f of features)for(const polygon of f.polygons)for(const ring of polygon)for(const p of ring){x=Math.min(x,p[0]);y=Math.min(y,p[1]);right=Math.max(right,p[0]);bottom=Math.max(bottom,p[1]);}return x===Infinity?[-65,0,1035,630]:[x-12,y-12,right-x+24,bottom-y+24];}
function table(headers,rows){const wrap=el('div','bb-table-scroll'),t=el('table','bb-table'),head=el('thead'),tr=el('tr');for(const h of headers){const th=el('th','',h);th.scope='col';tr.append(th);}head.append(tr);const body=el('tbody');for(const row of rows){const r=el('tr');for(const value of row){const td=el('td');td.append(value instanceof Node?value:document.createTextNode(String(value??'Unavailable')));r.append(td);}body.append(r);}append(t,head,body);wrap.append(t);return wrap;}
function labelSelect(text,entries,value,onChange){const l=el('label','bb-field'),s=el('select');s.setAttribute('aria-label',text);for(const[v,t]of entries){const o=el('option','',t);o.value=v;s.append(o);}s.value=value;s.addEventListener('change',()=>onChange(s.value));append(l,el('span','',text),s);return {label:l,select:s};}
function color(value,scale=30){if(!finite(value))return '#465366';const strength=Math.min(1,Math.abs(value)/scale);const neutral=[104,112,130],target=value>=0?[48,133,255]:[244,80,95];return `rgb(${neutral.map((v,i)=>Math.round(v+(target[i]-v)*strength)).join(',')})`;}
function strictVotes(race){if(race?.results?.available!==true)return [];const ids=new Map((race.candidates||[]).map(c=>[c.id,c]));const seen=new Set();const rows=[];for(const v of race.results.votes||[]){const id=v.candidateId??v.id,raw=v.votes??v.count;if(!ids.has(id)||seen.has(id)||!count(raw))return [];seen.add(id);rows.push({...ids.get(id),votes:raw});}return rows;}
const raceName=r=>`${r.state} ${r.office==='house'?(r.kind==='delegate'?'Delegate':`House ${r.district===0?'at large':r.district}`):r.office}${r.kind==='special'?' · special':''}`;

export function normalizeCountyDetail(data,race,record){
  const fail=()=>{throw Error('County response failed contest, candidate, or count validation.');};
  const type={house:'House of Representatives',senate:'US Senate',governor:'Governor'}[race?.office];
  if(!type||record?.sourceId!==`civicapi-${race.office}`||!/^\d{1,20}$/.test(String(record.sourceContestId))||record.detailUrl!==`https://civicapi.org/api/v2/race/${record.sourceContestId}`)fail();
  if(!data||data.test_data!==false||data.country!=='US'||data.province!==race.state||data.election_type!==type||!['General',...(race.office==='governor'?['Statewide']:[])].includes(data.election_scope)||typeof data.election_date!=='string'||!/^2026-11-03T\d{2}:\d{2}/.test(data.election_date)||!Number.isFinite(Date.parse(data.election_date))||typeof data.last_updated!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(data.last_updated)||!Number.isFinite(Date.parse(data.last_updated)))fail();
  if(race.office==='house'?data.district!==`${race.state}-${race.district===0?'AL':String(race.district).padStart(2,'0')}`:data.district!==null)fail();
  if(!data.region_results||Array.isArray(data.region_results)||typeof data.region_results!=='object'||Object.keys(data.region_results).length>5000)fail();
  // The endpoint's jurisdiction alone is insufficient: keep county rows bound
  // to the publisher's admitted candidate field, without joining catalog IDs.
  const nativeKey=c=>String(c.name).trim().toLowerCase()+'|'+c.party;
  if(!Array.isArray(record.candidates)||!record.candidates.length||record.candidates.length>100)fail();
  if(!Array.isArray(data.candidates)||!data.candidates.length||data.candidates.length>100)fail();
  const topIds=new Map(),nativeRoster=new Set();
  for(const c of data.candidates){if(!c||!/^\d{1,20}$/.test(String(c.candidate_id))||typeof c.name!=='string'||!c.name.trim()||c.name.length>500||!(c.party===null||typeof c.party==='string'&&c.party.length<=100)||topIds.has(String(c.candidate_id)))fail();topIds.set(String(c.candidate_id),c);nativeRoster.add(nativeKey(c));}
  for(const c of record.candidates){const current=topIds.get(c.sourceId);if(!current||nativeKey(current)!==nativeKey(c))fail();}
  const regions=[],seen=new Set();
  for(const row of Object.values(data.region_results)){
    if(!row||row.test_data===true||typeof row.fips!=='string'||!/^\d{5}$/.test(row.fips)||STATES[row.fips.slice(0,2)]!==race.state||seen.has(row.fips)||typeof row.name!=='string'||!row.name.length||row.name.length>500||row.type!=='County'||!Array.isArray(row.candidates)||!row.candidates.length||row.candidates.length>100)fail();seen.add(row.fips);
    const candidates=[],identities=new Set();let total=0;
    for(const c of row.candidates){if(!c||c.test_data===true||typeof c.name!=='string'||!c.name.trim()||c.name.length>500||!(c.party===null||typeof c.party==='string'&&c.party.length<=100)||!Number.isSafeInteger(c.votes)||c.votes<0)fail();const key=nativeKey(c);if(!nativeRoster.has(key)||identities.has(key))fail();identities.add(key);total+=c.votes;candidates.push({name:c.name,party:c.party,votes:c.votes});}if(!Number.isSafeInteger(total))fail();
    regions.push({fips:row.fips,name:row.name,candidates,reported:total>0});
  }
  return {asOf:new Date(data.last_updated).toISOString(),sourceUrl:record.detailUrl,geographicScope:race.office==='house'?'county portion within the selected congressional district':'county within this statewide contest',sourceScope:data.election_scope,additionalSourceChoices:data.candidates.filter(c=>!record.candidates.some(old=>old.sourceId===String(c.candidate_id))).map(c=>({sourceId:String(c.candidate_id),name:c.name,party:c.party})),regions};
}

export function admitCountyRefresh(previous,next){
  if(!previous)return true;
  if(Date.parse(next.asOf)<Date.parse(previous.asOf))return false;
  const signature=x=>JSON.stringify(x.regions.map(r=>[r.fips,r.candidates.map(c=>[c.name,c.party,c.votes])]).sort((a,b)=>a[0].localeCompare(b[0])));
  if(next.asOf===previous.asOf&&signature(next)!==signature(previous))return false;
  const incoming=new Map(next.regions.map(r=>[r.fips,r]));
  for(const row of previous.regions){const updated=incoming.get(row.fips);if(!updated)return false;for(const c of row.candidates){const v=updated.candidates.find(v=>v.name===c.name&&v.party===c.party);if(!v||v.votes<c.votes)return false;}}
  return true;
}

export async function mountBigBoard(container,{catalog,analysis,onSelectRace=()=>{}}) {
  const state={office:'senate',state:'ALL',mode:'model',county:null,historyRow:null,race:null,search:'',page:0,pen:false,zoom:1};
  const root=el('section','bb-root');root.setAttribute('aria-label','Big Board election analysis tools');container.replaceChildren(root);
  const header=el('div','bb-heading');append(header,append(el('div'),el('p','bb-eyebrow','ELECTION NIGHT WORKBENCH'),el('h2','','The Big Board'),el('p','bb-muted','Explore the map. Compare the vote. Test what is still possible.')));
  const fullscreen=button('⛶ Full screen',async()=>{try{if(document.fullscreenElement===root)await document.exitFullscreen();else await root.requestFullscreen();}catch{status.textContent='Full screen is unavailable in this browser; the board still works in this page.';}});const fullscreenChange=()=>{fullscreen.textContent=document.fullscreenElement===root?'⛶ Exit full screen':'⛶ Full screen';};document.addEventListener('fullscreenchange',fullscreenChange);header.append(fullscreen);root.append(header);
  const toolbar=el('div','bb-toolbar'),status=el('p','bb-status');status.setAttribute('aria-live','polite');
  const stateNames=new Map(catalog.races.map(r=>[r.state,r.stateName||r.state]));
  const office=labelSelect('Office',[['senate','U.S. Senate'],['house','U.S. House'],['governor','Governor']],state.office,v=>{state.office=v;state.race=null;render();});
  const stateSelect=labelSelect('Geography',[['ALL','United States'],...Array.from(stateNames).sort((a,b)=>a[1].localeCompare(b[1]))],state.state,v=>chooseState(v));
  const modes=[['model','2026 modeled favorites'],['2024','2024 president · actual'],['swing','2020 → 2024 swing'],['reported','2026 reported county votes']];
  const mode=labelSelect('Map layer',modes,state.mode,v=>{state.mode=v;state.county=null;state.historyRow=null;render();});append(toolbar,office.label,stateSelect.label,mode.label);root.append(toolbar);
  const grid=el('div','bb-main'),mapPanel=el('div','bb-map-panel'),mapTools=el('div','bb-map-tools'),mapTitle=el('h3'),mapCaption=el('p','bb-muted');
  const svg=svgEl('svg',{class:'bb-map',viewBox:'-65 0 1035 630',role:'group','aria-label':'Interactive United States map. Use state and county selectors for an accessible alternative.',tabindex:0});
  const viewport=svgEl('g'),mapLayer=svgEl('g'),borders=svgEl('g',{'pointer-events':'none'}),ink=svgEl('g',{'aria-label':'User annotations','pointer-events':'none'});append(viewport,mapLayer,borders,ink);svg.append(viewport);
  let geo={states:[],counties:[]},countyData={rows:[]},geoError='',countyError='',baseView=[-65,0,1035,630],view=[...baseView],mapKey='',drawing=null,drag=null;
  const countyCache=new Map(),countyLoading=new Set(),countyErrors=new Map();
  const setView=()=>svg.setAttribute('viewBox',view.join(' '));
  const zoom=factor=>{const nw=view[2]*factor,nh=view[3]*factor;if(nw<10||nw>baseView[2]*5)return;view=[view[0]+(view[2]-nw)/2,view[1]+(view[3]-nh)/2,nw,nh];setView();};
  const penButton=button('✎ Annotate',()=>{state.pen=!state.pen;penButton.setAttribute('aria-pressed',String(state.pen));svg.classList.toggle('bb-drawing',state.pen);});penButton.setAttribute('aria-pressed','false');
  append(mapTools,button('＋ Zoom in',()=>zoom(.75)),button('− Zoom out',()=>zoom(1.33)),button('Reset map',()=>{view=[...baseView];setView();}),penButton,button('Clear annotations',()=>ink.replaceChildren()));
  const legend=el('div','bb-legend');append(mapPanel,mapTitle,mapTools,svg,legend,mapCaption);const detail=el('aside','bb-detail');append(grid,mapPanel,detail);root.append(grid,status);
  const lower=el('div','bb-lower'),comparison=el('section','bb-card'),calculator=el('section','bb-card'),evidence=el('section','bb-card');append(lower,comparison,calculator,evidence);root.append(lower);
  const foot=el('div','bb-foot');root.append(foot);
  const point=event=>{const p=svg.createSVGPoint();p.x=event.clientX;p.y=event.clientY;return p.matrixTransform(svg.getScreenCTM().inverse());};
  svg.addEventListener('wheel',e=>{if(!e.ctrlKey)return;e.preventDefault();zoom(e.deltaY>0?1.15:.87);},{passive:false});
  let suppressClick=false;
  svg.addEventListener('pointerdown',e=>{if(e.button!==0)return;const p=point(e);suppressClick=false;if(state.pen){e.preventDefault();drawing={points:[p],path:svgEl('polyline',{points:`${p.x},${p.y}`,fill:'none',stroke:'#ffe260','stroke-width':view[2]/300,'stroke-linecap':'round','stroke-linejoin':'round'})};ink.append(drawing.path);svg.setPointerCapture(e.pointerId);}else{drag={x:e.clientX,y:e.clientY,view:[...view],moved:false};}});
  svg.addEventListener('pointermove',e=>{if(drawing){const p=point(e);drawing.points.push(p);drawing.path.setAttribute('points',drawing.points.map(v=>`${v.x},${v.y}`).join(' '));}else if(drag){if(!drag.moved&&Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<6)return;drag.moved=true;suppressClick=true;svg.setPointerCapture(e.pointerId);const rect=svg.getBoundingClientRect();const scale=Math.max(drag.view[2]/rect.width,drag.view[3]/rect.height);view=[drag.view[0]-(e.clientX-drag.x)*scale,drag.view[1]-(e.clientY-drag.y)*scale,...drag.view.slice(2)];setView();}});
  svg.addEventListener('click',e=>{if(suppressClick){e.stopPropagation();suppressClick=false;}},true);
  const end=()=>{drawing=null;drag=null;};svg.addEventListener('pointerup',end);svg.addEventListener('pointercancel',end);
  svg.addEventListener('keydown',e=>{const d={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];if(d){e.preventDefault();view[0]+=d[0]*view[2]*.1;view[1]+=d[1]*view[3]*.1;setView();}else if(e.key==='+'||e.key==='='){e.preventDefault();zoom(.75);}else if(e.key==='-'){e.preventDefault();zoom(1.33);}else if(e.key==='0'){view=[...baseView];setView();}});
  function races(){return catalog.races.filter(r=>r.office===state.office&&(state.state==='ALL'||r.state===state.state));}
  function currentRace(){const rs=races();return rs.find(r=>r.id===state.race)||rs[0]||null;}
  function chooseState(value){state.state=value;stateSelect.select.value=value;state.county=null;state.historyRow=null;state.race=null;state.page=0;render();}
  function selectCounty(fips){state.county=fips;state.historyRow=null;renderDetail();renderComparison();paintSelection();}
  function stateSummary(abbr){const rs=catalog.races.filter(r=>r.state===abbr&&r.office===state.office&&r.seatVoting!==false);let D=0,R=0,I=0,unknown=0;for(const r of rs){const f=analysis?.races?.[r.id]?.forecast;if(!f||!finite(f.chanceLeft)){unknown++;continue;}if(f.chanceLeft===.5){unknown++;continue;}const party=f.chanceLeft>.5?f.leftParty:'R';if(party==='D')D++;else if(party==='R')R++;else I++;}return{rs,D,R,I,unknown,value:D===R?0:(D-R)/Math.max(1,D+R)*30};}
  function liveCounties(){const r=currentRace();const cached=countyCache.get(r?.id);return cached?.regions||(Array.isArray(r?.results?.counties)&&r.results.available===true?r.results.counties:[]);}
  function liveMargin(row){
    const r=currentRace();if(!row||!r)return null;
    let D=0,R=0,total=0,hasD=false,hasR=false;
    function admit(party,votes){
      if(!Number.isSafeInteger(votes)||votes<0||party===null||party===undefined)return false;
      total+=votes;
      if(['D','Democratic','Democrat','Democratic-Farmer-Labor'].includes(party)){D+=votes;hasD=true;}
      if(['R','Republican'].includes(party)){R+=votes;hasR=true;}
      return true;
    }
    if(row.candidates){if(!row.reported)return null;for(const v of row.candidates)if(!admit(v.party,v.votes))return null;}
    else{const candidates=new Map((r.candidates||[]).map(c=>[c.id,c]));const seen=new Set();for(const v of row.votes||[]){const id=v.candidateId??v.id;const c=candidates.get(id);if(!c||seen.has(id)||!admit(c.party,v.votes??v.count))return null;seen.add(id);}}
    // A D/R margin requires both parties in the field. Independent-vs-R or
    // same-party contests must not become a fictional Democratic/GOP tie.
    return total>0&&hasD&&hasR?(D-R)/total*100:null;
  }
  async function loadCountyReturns(){const race=currentRace(),record=catalog.nationalResultRecords?.[race?.id];if(!race||!record||countyLoading.has(race.id))return;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);countyLoading.add(race.id);countyErrors.delete(race.id);renderDetail();try{
      if(!/^https:\/\/civicapi\.org\/api\/v2\/race\/\d{1,20}$/.test(record.detailUrl||''))throw Error('No verified publisher county endpoint for this contest.');
      const response=await fetch(record.detailUrl,{cache:'no-cache',signal:controller.signal,redirect:'error'});if(!response.ok)throw Error(`Publisher returned HTTP ${response.status}`);const body=await response.text();if(body.length>6000000)throw Error('County response exceeds the supported size.');const next=normalizeCountyDetail(JSON.parse(body),race,record);if(!admitCountyRefresh(countyCache.get(race.id),next))throw Error('Refresh changed or reduced an earlier observation; prior data retained for review.');countyCache.set(race.id,next);
    }catch(e){countyErrors.set(race.id,e.name==='AbortError'?'County request timed out; retry is available.':e.message);}finally{clearTimeout(timer);countyLoading.delete(race.id);if(currentRace()?.id===race.id){renderDetail();renderMap();renderComparison();}}
  }
  function selectedHistorical(){return state.historyRow||countyData.rows.find(r=>r.geometryMatched!==false&&String(r.fips).padStart(5,'0')===state.county);}
  function mapValue(feature){const abbr=STATES[feature.id.slice(0,2)];if(state.mode==='model')return stateSummary(abbr).value;const row=countyData.rows.find(r=>String(r.fips).padStart(5,'0')===feature.id);if(state.mode==='2024'||state.mode==='swing')return historicalMapValue(row,state.mode);return liveMargin(liveCounties().find(r=>String(r.fips).padStart(5,'0')===feature.id));}
  function paintSelection(){for(const p of mapLayer.children)p.classList.toggle('bb-selected',p.dataset.fips===state.county);}
  function renderMap(){
    const features=(state.mode==='model'?geo.states:geo.counties).filter(f=>state.state==='ALL'||STATES[f.id.slice(0,2)]===state.state);
    const key=state.mode+'|'+state.state;
    if(key!==mapKey){mapKey=key;baseView=bounds(features);view=[...baseView];setView();ink.replaceChildren();}
    mapTitle.textContent=`${state.state==='ALL'?'United States':stateNames.get(state.state)||state.state} · ${modes.find(m=>m[0]===state.mode)[1]}`;
    mapLayer.replaceChildren();borders.replaceChildren();
    for(const feature of features){const value=mapValue(feature),abbr=STATES[feature.id.slice(0,2)],summary=state.mode==='model'?stateSummary(abbr):null;const text=summary?`${feature.properties.name}: ${summary.D} D / ${summary.R} R / ${summary.I} other modeled favorites; ${summary.unknown} without a favorite. Select state.`:`${feature.properties.name}, ${abbr}: ${state.mode==='swing'?(value===null?'swing unavailable':`${Math.abs(value).toFixed(1)} points toward ${value>=0?'D':'R'}`):signed(value)}. Select county.`;
      const p=svgEl('path',{d:geometryPath(feature),fill:summary&&!summary.rs.length?'#465366':color(value,state.mode==='swing'?15:30),class:'bb-geography',tabindex:0,role:'button','aria-label':text,'fill-rule':'evenodd'});p.dataset.fips=feature.id;p.append(svgEl('title',{},text));const action=()=>{if(state.pen)return;if(state.mode==='model')chooseState(abbr);else selectCounty(feature.id);};p.addEventListener('click',action);p.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();action();}});mapLayer.append(p);}
    if(state.mode!=='model')for(const f of geo.states.filter(f=>state.state==='ALL'||STATES[f.id]===state.state))borders.append(svgEl('path',{d:geometryPath(f),fill:'none',stroke:'#dce8fc','stroke-width':.7,'vector-effect':'non-scaling-stroke'}));
    legend.replaceChildren();for(const[cls,text]of[['bb-blue',state.mode==='swing'?'Toward Democrats':'Democratic'],['bb-neutral','Even / mixed'],['bb-red',state.mode==='swing'?'Toward Republicans':'Republican'],['bb-missing','Unavailable']])legend.append(append(el('span'),el('i',cls),document.createTextNode(text)));
    const live=liveCounties(),cached=countyCache.get(currentRace()?.id);mapCaption.textContent=`${state.mode==='model'?'State shading summarizes the selected office’s modeled favorites, not election results or county forecasts. ':state.mode==='reported'?`Reported county D–R margin for ${currentRace()?raceName(currentRace()):'the selected race'}; ${live.filter(r=>r.reported||r.votes?.some(v=>(v.votes??v.count)>0)).length} counties with positive reported counts out of ${live.length} supplied. ${cached?`Source as of ${cached.asOf}. Geography: ${cached.geographicScope}. `:''}`:'Historical presidential D–R margin uses all reported votes; swing is 2024 margin minus 2020 margin. '}2017 Census county/state geography; boundaries may differ from election-year counties. Not 2026 House districts. Gray means missing data, including unreported publisher templates. Drag the background or Shift-drag to pan; use buttons, Ctrl+wheel, or arrow/+/-/0 keys. Yellow marks are user annotations.`;
    paintSelection();
  }
  function renderDetail(){
    detail.replaceChildren(el('p','bb-eyebrow',state.historyRow?.geometryMatched===false?'HISTORICAL REPORTING UNIT':state.county?'COUNTY SPOTLIGHT':'RACE SPOTLIGHT'));
    const selected=selectedHistorical();if(state.county||state.historyRow){const shape=geo.counties.find(r=>r.id===state.county);detail.append(el('h3','',selected?`${selected.name}, ${selected.state}`:shape?`${shape.properties.name}, ${STATES[shape.id.slice(0,2)]}`:`County ${state.county}`));const m24=countyMargin(selected?.pres2024),m20=countyMargin(selected?.pres2020),swing=countySwing(selected);detail.append(table(['Measure','Value'],[['2024 president',signed(m24)],['2020 president',signed(m20)],['2020 → 2024 swing',swing!==null?`${Math.abs(swing).toFixed(1)} pp toward ${swing>=0?'D':'R'}`:'Unavailable'],['2024 total votes',selected?.pres2024?.total??'Unavailable']]));if(selected?.geometryMatched===false)detail.append(el('p','bb-caution',`${selected.scope||'Unmatched reporting unit'}. Table only; no map join or cross-year swing is inferred.`));detail.append(el('p','bb-muted','Presidential results are historical context; they are not a prediction of the selected 2026 race.'));}
    const rs=races();if(!rs.length){detail.append(el('h3','','No election for this office'),el('p','bb-muted','Select another office or state.'));return;}
    let race=currentRace();state.race=race.id;
    const selector=labelSelect('2026 race',rs.map(r=>[r.id,raceName(r)]),race.id,v=>{state.race=v;renderDetail();renderCalculator(true);renderEvidence();renderComparison();if(state.mode==='reported')renderMap();});detail.append(selector.label);
    const f=analysis?.races?.[race.id]?.forecast,reported=strictVotes(race);detail.append(el('h3','',raceName(race)));
    if(f){const only=f.sourceRecord?.only_one_party;detail.append(append(el('div','bb-big-metric'),el('strong','',only?`${only} party ownership`:`${f.rating||'Modeled'}${finite(f.margin)?` · ${signed(f.margin)}`:''}`),el('span','bb-muted',only?'Same-party or uncontested seat; individual candidate odds/margins are unmodeled.':`Modeled margin · ${f.leftParty||'left'} vs R · ${f.asOf||'date unavailable'}`)));detail.append(sourceLink('Forecast source',f.url));if(!f.candidateMatch)detail.append(el('p','bb-caution','The modeled candidate matchup needs checking against the ballot.'));}
    else detail.append(el('p','bb-muted','No connected forecast for this race.'));
    if(reported.length){detail.append(table(['Reported candidate','Votes'],reported.map(v=>[`${v.name} (${v.party})`,fmt(v.votes)])),el('p','bb-muted',`Actual reported counts · ${race.results.status||'status not supplied'} · ${race.results.asOf||'as of unavailable'}`),sourceLink('Result source',race.results.sourceUrl));}else detail.append(el('p','bb-caution','2026 matched candidate vote counts unavailable. Unknown is not zero.'));
    if(race.stage==='primary')detail.append(el('p','bb-caution','Open-primary field and publisher general-stage convention differ. The principal-pair forecast does not estimate every candidate or runoff qualification.'));
    const native=catalog.nationalResultRecords?.[race.id],cached=countyCache.get(race.id);
    if(native){if(native.reported&&Array.isArray(native.candidates))detail.append(table(['Publisher candidate · native identity','Votes'],native.candidates.map(c=>[`${c.name} (${c.party||'party unavailable'})`,fmt(c.votes)])),el('p','bb-muted',`Publisher-native counts, separate from ballot candidate matching. ${native.asOf||'As of unavailable'}.`));else detail.append(el('p','bb-muted',`Publisher contest is unreported; its zero-count template is not a report of zero turnout. ${native.asOf||''}`));if(native.detailUrl){const load=button(countyLoading.has(race.id)?'Loading county returns…':cached?'Refresh county returns':'Load county returns',loadCountyReturns);load.disabled=countyLoading.has(race.id);detail.append(load);}}
    if(countyErrors.has(race.id))detail.append(el('p','bb-caution',countyErrors.get(race.id)));
    if(cached){detail.append(sourceLink(`County source · ${cached.asOf}`,cached.sourceUrl),el('p','bb-muted',`${cached.geographicScope}. Unofficial publisher aggregation. Native candidate names are retained without inventing catalog-ID matches. Reporting percentage is not used to estimate outstanding votes.`));const nativeCounty=cached.regions.find(r=>r.fips===state.county);const countySelect=labelSelect('Reported-feed county',[['','Select a county'],...cached.regions.map(r=>[r.fips,r.name+(r.reported?'':' · unreported')])],nativeCounty?.fips||'',v=>{if(v)selectCounty(v);});detail.append(countySelect.label);if(nativeCounty){detail.append(el('h4','',nativeCounty.name),nativeCounty.reported?table(['Native candidate','Votes'],nativeCounty.candidates.map(c=>[`${c.name} (${c.party||'unknown'})`,fmt(c.votes)])):el('p','bb-muted','This county has no positive reported counts; template zeroes are not displayed as returns.'));}}
    detail.append(button('Open complete race details →',()=>onSelectRace(race.id),'bb-primary'));
    if(state.state!=='ALL')detail.append(button('← All states',()=>chooseState('ALL')));
  }
  function renderComparison(){
    comparison.replaceChildren(el('p','bb-eyebrow','PAST / CURRENT COMPARISON'),el('h3','','County vote explorer'));
    const search=el('input');search.type='search';search.placeholder='Find a county';search.value=state.search;search.setAttribute('aria-label','Search county names');search.dataset.focus='county-search';search.addEventListener('input',()=>{state.search=search.value;state.page=0;renderRows();});comparison.append(search);
    const target=el('div');comparison.append(target);
    function renderRows(){let rows=countyData.rows.filter(r=>(state.state==='ALL'||r.state===state.state)&&String(r.name).toLowerCase().includes(state.search.toLowerCase()));rows.sort((a,b)=>(b.pres2024?.total??-1)-(a.pres2024?.total??-1));const pages=Math.max(1,Math.ceil(rows.length/40));state.page=Math.min(state.page,pages-1);const live=new Map(liveCounties().map(r=>[String(r.fips).padStart(5,'0'),r]));const shown=rows.slice(state.page*40,(state.page+1)*40);target.replaceChildren(table(['County','2020 D–R','2024 D–R','Swing','2024 votes','2026 D–R'],shown.map(r=>{const m20=countyMargin(r.pres2020),m24=countyMargin(r.pres2024),s=countySwing(r);const fips=String(r.fips).padStart(5,'0');return[button(`${r.name}, ${r.state}`,()=>{state.county=r.geometryMatched===false?null:fips;state.historyRow=r;if(state.state==='ALL'){state.state=r.state;stateSelect.select.value=r.state;state.page=0;}render();},'bb-link-button'),signed(m20),signed(m24),s===null?'Unavailable':`${s>=0?'+':''}${s.toFixed(1)} pp D`,fmt(r.pres2024?.total),signed(liveMargin(live.get(fips)))];})));
      const nav=el('div','bb-pagination');const prev=button('← Previous',()=>{state.page--;renderRows();}),next=button('Next →',()=>{state.page++;renderRows();});prev.disabled=state.page===0;next.disabled=state.page>=pages-1;append(nav,prev,el('span','',`${rows.length?state.page*40+1:0}–${Math.min((state.page+1)*40,rows.length)} of ${fmt(rows.length)}`),next);target.append(nav);if(!rows.length)target.append(el('p','bb-muted',countyError||'No matching county historical records.'));target.append(el('p','bb-muted','Swing is the change in D–R margin in percentage points. Different contests and county boundaries limit comparisons. 2026 column uses the selected race only.'));}
    renderRows();
  }
  let calculatorRace=null;
  function renderCalculator(force=false){const race=currentRace();if(!force&&calculatorRace===race?.id)return;calculatorRace=race?.id;calculator.replaceChildren(el('p','bb-eyebrow','OUTSTANDING VOTE MATH'),el('h3','','What does A need to pass B?'));
    const votes=strictVotes(race),candidateRows=race?.candidates||[];let ca=votes[0]?.id||candidateRows.find(c=>c.party==='D')?.id||candidateRows[0]?.id,cb=votes.find(v=>v.id!==ca&&v.party==='R')?.id||candidateRows.find(c=>c.id!==ca&&c.party==='R'&&c.incumbent)?.id||candidateRows.find(c=>c.id!==ca&&c.party==='R')?.id||votes.find(v=>v.id!==ca)?.id||candidateRows.find(c=>c.id!==ca)?.id;
    const fields={},form=el('div','bb-calc-grid');
    const addInput=(key,text,value)=>{const label=el('label','bb-field'),input=el('input');input.type='text';input.inputMode='numeric';input.autocomplete='off';input.value=value===null||value===undefined?'':String(value);input.placeholder='Unknown';input.setAttribute('aria-label',text);input.addEventListener('input',compute);append(label,el('span','',text),input);fields[key]=input;form.append(label);};
    const cv=id=>votes.find(v=>v.id===id)?.votes??null;
    const aSelect=labelSelect('Candidate A',candidateRows.map(c=>[c.id,`${c.name} (${c.party})`]),ca||'',v=>{ca=v;fields.a.value=cv(ca)??'';compute();});const bSelect=labelSelect('Candidate B',candidateRows.map(c=>[c.id,`${c.name} (${c.party})`]),cb||'',v=>{cb=v;fields.b.value=cv(cb)??'';compute();});append(form,aSelect.label,bSelect.label);
    addInput('a','A current votes',cv(ca));addInput('b','B current votes',cv(cb));
    const known=Number.isSafeInteger(race?.results?.remainingVotes)&&race.results.remainingVotes>=0?race.results.remainingVotes:null;
    addInput('remaining',known===null?'All remaining votes · your assumption':'All remaining votes · source supplied',known);addInput('otherRemaining','Remaining votes for others · your assumption',null);
    const result=el('div','bb-calc-result');result.setAttribute('aria-live','polite');append(calculator,form,result,el('p','bb-muted','This scenario compares A with B only. Enter 0 for others only if you explicitly assume every remaining ballot goes to A or B. Counts you edit become your assumptions. It does not resolve ties, ranked-choice rounds, recounts, runoffs, or third-candidate wins.'));
    calculator.append(el('p','bb-muted',votes.length?`Current counts seeded from matched reported race results · ${race.results.asOf||'as of unavailable'}. ${known===null?'No source estimate of remaining ballots; supply your own assumption.':'Remaining-ballot source estimate is editable.'}`:'Current counts and remaining ballots are unknown. Enter a scenario explicitly; no turnout estimate is invented.'));
    function compute(){const data=Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,v.value]));let r=solveOutstanding(data);if(!ca||!cb||ca===cb)r={status:'invalid',message:'Select two different candidates.'};result.replaceChildren();if(r.status==='feasible'){result.append(el('strong','bb-calc-share',r.share),el('div','',`${fmt(r.needed)} of ${fmt(r.pairRemaining)} remaining A/B ballots`),el('p','',r.message),el('p','bb-muted',`Exact threshold: ${r.needed} / ${r.pairRemaining}; displayed percent rounded up to 0.01 point.`));}else result.append(el('strong','',r.status==='unknown'?'Awaiting known inputs':r.status==='infeasible'?'Not possible under this scenario':r.status==='no-remaining'?'No A/B ballots left':'Check the scenario'),el('p','',r.message));}
    compute();
  }
  function renderEvidence(){const r=currentRace();evidence.replaceChildren(el('p','bb-eyebrow','VOTER & BALLOT EVIDENCE'),el('h3','','Vote method / exit polls'));
    // Only explicitly labeled, sourced observations can occupy these panels.
    for(const[key,title]of[['voteMethods','Vote by method'],['exitPolls','Exit polls']]){const item=r?.results?.[key];evidence.append(el('h4','',title));let validUrl=false;try{const u=new URL(item?.sourceUrl);validUrl=u.protocol==='https:'&&!u.username&&!u.password;}catch{}const knownTime=typeof item?.asOf==='string'&&Number.isFinite(Date.parse(item.asOf)),checked=typeof item?.checkedAt==='string'&&Number.isFinite(Date.parse(item.checkedAt));const headers=item?.headers||['Group','Value'];const valid=item&&validUrl&&(knownTime||item.asOf==null&&checked)&&Array.isArray(headers)&&headers.length>=2&&headers.length<=30&&headers.every(v=>typeof v==='string'&&v.length<=500)&&Array.isArray(item.rows)&&item.rows.length>0&&item.rows.length<=500&&item.rows.every(row=>Array.isArray(row)&&row.length===headers.length&&row.every(v=>v===null||typeof v==='string'&&v.length<=1000||typeof v==='number'&&Number.isFinite(v)&&v>=0));if(valid){evidence.append(table(headers,item.rows.map(row=>row.map(v=>String(v??'Unavailable')))),sourceLink(`${title} source · ${knownTime?item.asOf:`Source time unknown; checked ${item.checkedAt}`}`,item.sourceUrl));}else evidence.append(el('p','bb-muted',`No sourced ${title.toLowerCase()} observation is connected for this race. No demographic or ballot-method values are inferred from county totals.`));}
    evidence.append(el('p','bb-muted','The AP/SSRS Voter Poll measures voters’ demographics, motivations and reported choices; it is a survey, not counted ballots. Public findings are expected from 5 p.m. Eastern, with candidate breakdowns gated by state poll closing. The data API requires a licensed key; no free reusable cross-tab feed is connected.'),sourceLink('Public AP election coverage','https://apnews.com/hub/elections'),sourceLink('NBC election coverage','https://www.nbcnews.com/politics/2026-elections'),sourceLink('Voter Poll timing and access','https://developer.ap.org/ap-elections-api/docs/Voter_Poll.htm'));
    evidence.append(el('p','bb-muted','Independent map and arithmetic tools with attributed public sources. Not affiliated with NBC; proprietary NBC feeds are not included.'));
  }
  function renderFooter(){foot.replaceChildren(el('p','bb-muted',`Catalog as of ${catalog.sourceAsOf||catalog.generatedAt||'unavailable'} · analysis as of ${analysis?.generatedAt||'unavailable'}. Forecasts are estimates; historical and reported counts are labeled separately.`));const s=countyData.source;if(s){foot.append(el('p','bb-muted',`County results: ${typeof s==='string'?s:s.title||s.name||'Source supplied'} · ${s.asOf||countyData.generatedAt||'as of not supplied'}`));if(s.url)foot.append(sourceLink('Historical county result source',s.url));for(const note of Array.isArray(s.notes)?s.notes:s.notes?[s.notes]:[])foot.append(el('p','bb-muted',String(note)));}const mapped=new Set(geo.counties.map(r=>r.id));const unmatched=countyData.rows.filter(r=>r.geometryMatched===false||!mapped.has(String(r.fips).padStart(5,'0')));foot.append(sourceLink('Geometry: U.S. Census 2017 via us-atlas', 'https://github.com/topojson/us-atlas'),el('p','bb-muted',`${fmt(unmatched.length)} historical records have no matching 2017 county shape and remain available in the table only. Geographic omissions or changed identifiers stay unavailable; no neighboring county is silently substituted.`));}
  function render(){renderDetail();renderMap();renderComparison();renderCalculator();renderEvidence();renderFooter();status.textContent=geoError||`${geo.states.length} state geometries · ${geo.counties.length} county geometries · ${fmt(countyData.rows.length)} historical county records. ${countyError}`;}
  render();
  const loaded=await Promise.allSettled([fetch('./us-map.json',{cache:'no-cache'}).then(r=>{if(!r.ok)throw Error(`Map file: HTTP ${r.status}`);return r.json();}),fetch('./counties.json',{cache:'no-cache'}).then(r=>{if(!r.ok)throw Error(`County file: HTTP ${r.status}`);return r.json();})]);
  if(loaded[0].status==='fulfilled'){try{geo={states:decodeTopology(loaded[0].value,'states'),counties:decodeTopology(loaded[0].value,'counties')};mapKey='';}catch(e){geoError=`Map unavailable: ${e.message}`;}}else geoError=`Map unavailable: ${loaded[0].reason.message}`;
  if(loaded[1].status==='fulfilled'&&Array.isArray(loaded[1].value.rows))countyData=loaded[1].value;else countyError='Historical county data unavailable; no sample values are substituted.';
  render();
  return {update(next){const active=document.activeElement;const focused=active&&root.contains(active)?{tag:active.tagName,label:active.getAttribute('aria-label'),fips:active.dataset.fips,key:active.dataset.focus,value:active.value,start:active.selectionStart,end:active.selectionEnd}:null;const scrolls=[...root.querySelectorAll('.bb-table-scroll')].map(e=>[e.scrollLeft,e.scrollTop]);if(next.catalog)catalog=next.catalog;if(next.analysis)analysis=next.analysis;render();[...root.querySelectorAll('.bb-table-scroll')].forEach((e,i)=>{if(scrolls[i]){e.scrollLeft=scrolls[i][0];e.scrollTop=scrolls[i][1];}});if(focused&&!root.contains(active)){const match=[...root.querySelectorAll('input,select,button,path')].find(e=>focused.key?e.dataset.focus===focused.key:focused.fips?e.dataset.fips===focused.fips:focused.label&&e.tagName===focused.tag&&e.getAttribute('aria-label')===focused.label);if(match){match.focus({preventScroll:true});if(match.setSelectionRange&&focused.start!==null)try{match.setSelectionRange(focused.start,focused.end);}catch{}}}},destroy(){document.removeEventListener('fullscreenchange',fullscreenChange);root.remove();}};
}
