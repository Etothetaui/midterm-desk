import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {VERSION,validateSnapshot} from './model.mjs';
import {validateAnalysis} from './analysis-ui.mjs';
const read=name=>readFile(new URL(name,import.meta.url),'utf8');
const data=JSON.parse(await read('data.json')),analysis=JSON.parse(await read('analysis.json'));
if(data.exercise===true||String(data.snapshotId).startsWith('exercise'))throw new Error('Synthetic exercises cannot be published as election data.');
for(const result of [validateSnapshot(data,{requireCompleteCatalog:true}),validateAnalysis(analysis,data)])if(!result.ok)throw new Error(result.errors.join('; '));
for(const name of ['index.html','README.md','CHANGELOG.md'])if(!(await read(name)).includes(VERSION))throw new Error(name+' must document '+VERSION);
// Every source push is a release change. Scheduled data publications have a
// separate snapshot identity and do not create unversioned source commits.
if(process.env.GITHUB_EVENT_NAME==='push'){
  let previous;
  try{previous=execFileSync('git',['show','HEAD^:model.mjs'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});}
  catch{
    // The existing Pages checkout is shallow; read its public parent only
    // when a source push needs the mandatory version-change comparison.
    execFileSync('git',['fetch','--deepen=1','--no-tags','origin','main'],{stdio:'inherit'});
    previous=execFileSync('git',['show','HEAD^:model.mjs'],{encoding:'utf8'});
  }
  if(previous.includes(`export const VERSION = '${VERSION}'`))throw new Error('A source push requires a new software version and changelog entry.');
}
console.log('Version, changelog, exact catalog and analytical release gates passed for '+VERSION);
