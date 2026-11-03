import {apRaceObservation} from './ap-source.mjs';

const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;};
const when=value=>value?new Date(value).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}):'not checked';
const link=(label,url)=>{const a=node('a','source-link',label+' ↗');a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;};
export const AP_COVERAGE='Partial public-announcement coverage. Absence does not mean AP has not called a race. Announcement history may not reflect later changes in AP’s licensed feed. Projections are not certification.';

// Keep source status and all three cohorts visible together. These are observed
// public announcements, never an inferred nationwide AP control tally.
export function apOverview(catalog,source,{paused=false,pending=false}={}){
  const section=node('section','panel ap-monitor');section.setAttribute('aria-label','AP public announcements');
  const head=node('div','ap-monitor-heading');head.append(node('h3','','AP public announcements'),node('span','pill','Free · partial coverage'));section.append(head,node('p','fine',AP_COVERAGE));
  const grid=node('div','ap-monitor-counts');
  for(const[office,label]of[['house','House'],['senate','Senate'],['governor','Governors']]){
    const races=catalog.races.filter(r=>r.office===office&&r.kind!=='delegate'&&!['GU','MP','VI'].includes(r.state)&&r.stage!=='primary');
    const counts={D:0,R:0,I:0,other:0};let total=0;
    for(const r of races){const o=apRaceObservation(source,r.id);if(o?.status!=='called')continue;const c=r.candidates.find(c=>c.id===o.candidateId);if(!c)continue;total++;counts[Object.hasOwn(counts,c.party)?c.party:'other']++;}
    const card=node('div','ap-monitor-cohort');card.append(node('strong','',`${label}: ${total} observed`),node('span','fine',`D ${counts.D} · R ${counts.R} · I ${counts.I} · other ${counts.other}`));grid.append(card);
  }
  section.append(grid);
  const state=paused?`Display paused${pending?' · AP update waiting':''}`:source?.errorCode==='not-checked'?'Waiting for the first public-source check':source?.errorCode==='revision-ambiguous'?'Edited AP post needs review · earlier observations retained':source?.status==='ready'?'Public source checked':source?.status==='retained-error'?'Check failed · last supported announcements retained':source?.status==='error'?'Public source unavailable':'Waiting for the first public-source check';
  section.append(node('p',source?.status?.includes('error')?'fine ap-warning':'fine',`${state}. Checked ${when(source?.checkedAt)}. Latest matched announcement ${source?.asOf?when(source.asOf):'none recorded'}.`));
  if(source?.errorCode==='rate-limited'&&source.retryAfterAt)section.append(node('p','fine ap-warning',`The public source requested a pause until ${when(source.retryAfterAt)}; the monitor will retry afterward.`));
  if(source?.catchup?.truncated)section.append(node('p','fine ap-warning','The bounded recent-post scan did not reach the beginning of the election window; earlier announcements may be missing.'));
  section.append(node('p','fine','Checks run about once a minute while this page is open, with backoff after failures. Only unambiguous general-election winner statements matching the catalog are marked; other wording stays unclassified. AP may announce calls elsewhere first.'));
  if(!Object.keys(source?.observations||{}).length)section.append(node('p','fine','No genuine 2026 winner announcement has been admitted yet. Classification is tested with synthetic examples; live positive matching remains unverified.'));
  section.append(link('AP’s verified public account','https://bsky.app/profile/apnews.com'));
  return section;
}

export function apRaceBlock(race,source){
  const section=node('section','ap-race-source');section.dataset.apRace=race.id;
  const record=apRaceObservation(source,race.id);
  section.append(node('h4','','Associated Press · public announcements'));
  if(record){
    const c=race.candidates.find(c=>c.id===record.candidateId);
    section.append(node('strong',record.status==='called'?'ap-winner':'ap-warning',record.status==='called'?`AP winner announcement observed: ${c?.name||record.candidateName}`:'AP publicly withdrew this winner announcement'));
    section.append(node('p','fine',`AP announcement published ${when(record.publishedAt)} · observed ${when(record.observedAt)}. Publication time is not AP’s original call time, which is not supplied.`),link('Original AP announcement',record.sourceUrl));
    if(record.history?.length>1){const details=node('details');details.append(node('summary','','Announcement history'));for(const h of record.history){const p=node('p','fine',`${when(h.publishedAt)} · ${h.status} · `);if(h.sourceUrl)p.append(link('AP source',h.sourceUrl));details.append(p);}section.append(details);}
  }else section.append(node('p','fine','No matched public AP winner announcement recorded for this contest. This does not establish whether AP has called it elsewhere.'));
  section.append(node('p','fine',AP_COVERAGE));
  if(source?.status?.includes('error'))section.append(node('p','fine ap-warning',source.errorCode==='revision-ambiguous'?'An edited AP post needs review; the earlier observation is retained. Check the original source before treating it as current.':'The latest public-source check failed; earlier supported observations are retained.'));
  return section;
}
