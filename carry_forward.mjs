import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {VERSION,validateSnapshot} from './model.mjs';

export function mergePublishedSnapshot(current,previous){
  // This release changes presentation, not the schema-1 result contract.
  // Admit the explicitly supported predecessor while validating all its fields;
  // never discard already-published votes just because the software upgraded.
  if(previous?.schemaVersion===1&&['v0.0.0-dev','v0.1.0-dev','v0.1.1-dev','v0.1.2-dev'].includes(previous.version)&&VERSION==='v0.1.3-dev')previous={...previous,version:VERSION};
  for(const [label,value]of [['current',current],['previous',previous]]){const result=validateSnapshot(value,{requireCompleteCatalog:true});if(!result.ok)throw new Error(`${label} snapshot rejected: ${result.errors.join('; ')}`);}
  const output=structuredClone(current);
  const byId=new Map(previous.races.map(r=>[r.id,r]));
  let retained=0;
  for(const race of output.races){const prior=byId.get(race.id);if(!prior?.results?.available)continue;const ids=new Set(race.candidates.map(c=>c.id));if(prior.results.votes.some(v=>!ids.has(v.candidateId)))throw new Error(`Catalog change conflicts with previously reported choices in ${race.id}; review required.`);race.results=structuredClone(prior.results);retained++;}
  if(previous.resultHealth&&typeof previous.resultHealth==='object')output.resultHealth=structuredClone(previous.resultHealth);
  // Native publisher tables are independent of canonical candidate joins.
  // Carry them too, otherwise a failed next fetch could reset visible counts
  // to the repository's pre-reporting seed while canonical counts survive.
  if(previous.nationalResultRecords)output.nationalResultRecords=structuredClone(previous.nationalResultRecords);
  // AP observations retain their own provenance and withdrawal history.
  if(previous.apPublicSource)output.apPublicSource=structuredClone(previous.apPublicSource);
  const result=validateSnapshot(output,{requireCompleteCatalog:true});if(!result.ok)throw new Error('Merged snapshot rejected: '+result.errors.join('; '));
  return {snapshot:output,retained};
}

export function assertUnpublishedHistory(histories){
  if(!Array.isArray(histories))throw new Error('Invalid deployment history.');
  const unpublished=new Set(['pending','waiting','queued','in_progress','failure','error']);
  for(const statuses of histories){
    if(!Array.isArray(statuses))throw new Error('Invalid deployment statuses.');
    for(const status of statuses)if(!status||!unpublished.has(status.state))throw new Error('Prior successful, inactive or unknown deployment exists; missing published data requires review.');
  }
}

async function main(){
  const root=path.dirname(fileURLToPath(import.meta.url));
  const arg=name=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];};
  const destination=arg('--output');if(!destination)throw new Error('--output is required.');
  const current=JSON.parse(await readFile(arg('--input')||path.join(root,'data.json'),'utf8'));
  const repository=process.env.GITHUB_REPOSITORY||'Etothetaui/midterm-desk';
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository))throw new Error('Invalid repository.');
  const [owner,repo]=repository.split('/');
  const url=`https://${owner.toLowerCase()}.github.io/${repo}/data.json`;
  const response=await fetch(url+'?carry='+Date.now(),{signal:AbortSignal.timeout(20000),cache:'no-store'});
  let result;
  if(response.status===404){
    const headers={Accept:'application/vnd.github+json'};
    if(process.env.GITHUB_TOKEN)headers.Authorization='Bearer '+process.env.GITHUB_TOKEN;
    const history=await fetch(`https://api.github.com/repos/${repository}/deployments?environment=github-pages&per_page=100`,{headers,signal:AbortSignal.timeout(20000)});
    if(!history.ok)throw new Error('Cannot establish whether this is the first deployment; retain existing site.');
    const entries=await history.json();
    if(!Array.isArray(entries)||history.headers.get('link')?.includes('rel="next"'))throw new Error('Cannot establish complete unpublished history; review required.');
    const statuses=[];
    for(const entry of entries){
      if(!Number.isSafeInteger(entry.id)||entry.id<=0)throw new Error('Invalid deployment identity.');
      const checked=await fetch(`https://api.github.com/repos/${repository}/deployments/${entry.id}/statuses?per_page=100`,{headers,signal:AbortSignal.timeout(20000)});
      if(!checked.ok||checked.headers.get('link')?.includes('rel="next"'))throw new Error('Cannot establish complete deployment statuses; retain current site.');
      statuses.push(await checked.json());
    }
    assertUnpublishedHistory(statuses);
    const check=validateSnapshot(current,{requireCompleteCatalog:true});if(!check.ok)throw new Error(check.errors.join('; '));
    result={snapshot:current,retained:0};
    console.log('No previously published deployment in complete status history; using validated source catalog.');
  }else{
    if(!response.ok)throw new Error(`Cannot read last published snapshot (HTTP ${response.status}); retain existing site.`);
    const text=await response.text();if(Buffer.byteLength(text)>15_000_000)throw new Error('Published snapshot exceeds bounded input size.');
    result=mergePublishedSnapshot(current,JSON.parse(text));
  }
  await writeFile(destination,JSON.stringify(result.snapshot,null,2)+'\n');
  console.log(JSON.stringify({retainedRaces:result.retained,output:destination,snapshotId:result.snapshot.snapshotId}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
