import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {VERSION,validateSnapshot,summarizeCoverage} from './model.mjs';
import {validateAnalysis} from './analysis-ui.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const arg=name=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];};
const output=path.resolve(arg('--out')||path.join(process.cwd(),'work/site'));
const dataPath=path.resolve(arg('--data')||path.join(root,'data.json'));
// The publication entry point verifies every adapter and view contract, even
// when invoked by the established Pages workflow. No test fixtures are packed.
if(process.env.GITHUB_ACTIONS==='true'){
  execFileSync(process.execPath,['--test','model.test.mjs','carry_forward.test.mjs','analysis.test.mjs','big-board.test.mjs','ap-source.test.mjs','news-ticker.test.mjs'],{cwd:root,stdio:'inherit'});
  execFileSync('python',['-m','unittest','discover','-s','.','-p','test_update*.py'],{cwd:root,stdio:'inherit'});
  execFileSync(process.execPath,['verify_release.mjs'],{cwd:root,stdio:'inherit'});
}
const bytes=await readFile(dataPath);
const data=JSON.parse(bytes.toString('utf8'));
if(data.exercise===true||String(data.snapshotId).startsWith('exercise'))throw new Error('Synthetic exercises cannot be published as election data.');
const validation=validateSnapshot(data,{requireCompleteCatalog:true});
if(!validation.ok)throw new Error('Release rejected: '+validation.errors.join('; '));
const coverage=summarizeCoverage(data);
if(!coverage.structuralCatalogComplete)throw new Error('Release requires the complete exact contest set and sourced inventories.');
const hash=value=>createHash('sha256').update(value).digest('hex');
const analysis=JSON.parse(await readFile(path.join(root,'analysis.json'),'utf8'));
const analysisCheck=validateAnalysis(analysis,data);
if(!analysisCheck.ok)throw new Error('Analysis release rejected: '+analysisCheck.errors.join('; '));
const files=['index.html','styles.css','big-board.css','app.mjs','model.mjs','analysis-ui.mjs','big-board.mjs','ap-source.mjs','ap-ui.mjs','news-ticker.mjs','analysis.json','analysis-health.json','us-map.json','counties.json','US-ATLAS-LICENSE.txt','HISTORICAL-DATA-LICENSE.txt','README.md','DATA-SOURCES.md','METHODOLOGY.md','CHANGELOG.md'];
await mkdir(output,{recursive:true});
const hashes={};
for(const name of files){const body=await readFile(path.join(root,name));hashes[name]=hash(body);await writeFile(path.join(output,name),body);}
hashes['data.json']=hash(bytes);await writeFile(path.join(output,'data.json'),bytes);
await writeFile(path.join(output,'.nojekyll'),'');
let sourceCommit=null;
try{sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{}
if(process.env.GITHUB_ACTIONS==='true'){
  if(!sourceCommit||!/^[a-f0-9]{40}$/u.test(sourceCommit))throw new Error('Cannot identify checked-out commit.');
  const repository=process.env.GITHUB_REPOSITORY;
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository||''))throw new Error('Invalid repository identity.');
  const headers={Accept:'application/vnd.github+json'};
  if(process.env.GITHUB_TOKEN)headers.Authorization='Bearer '+process.env.GITHUB_TOKEN;
  const response=await fetch(`https://api.github.com/repos/${repository}/commits/main`,{headers,signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error('Cannot verify current main commit.');
  if((await response.json()).sha!==sourceCommit)throw new Error('Candidate superseded by a newer main commit; retain current deployment.');
}
const contentId=hash(JSON.stringify(hashes));
const manifest={version:VERSION,contentId,sourceCommit,eventCommit:process.env.GITHUB_SHA||null,snapshotId:data.snapshotId,dataSha256:hashes['data.json'],builtAt:new Date().toISOString(),files:hashes,coverage:{contests:data.races.length,candidateInventories:coverage.candidateInventoryCount,candidates:coverage.candidateCount,structuralCatalogComplete:coverage.structuralCatalogComplete,candidateAuditComplete:coverage.candidateAuditComplete},workflowRun:process.env.GITHUB_RUN_ID?`https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`:null};
await writeFile(path.join(output,'version.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({output,version:VERSION,contentId,snapshotId:data.snapshotId,sourceCommit,contests:data.races.length}));
