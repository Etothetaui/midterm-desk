import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {emptyAPSource,refreshAPSource,validateAPSource} from './ap-source.mjs';

export async function updateAPFile(input,output,options={}){
  const catalog=JSON.parse(await readFile(input,'utf8'));
  const source=await refreshAPSource(catalog,catalog.apPublicSource??emptyAPSource(),options);
  const validation=validateAPSource(source,catalog);
  if(!validation.ok) throw new Error(validation.errors.join('; '));
  const updated={...catalog,apPublicSource:source};
  await writeFile(output,JSON.stringify(updated,null,2)+'\n','utf8');
  console.log(`AP public announcements: ${source.status}, ${Object.keys(source.observations).length} observed races; partial coverage${source.catchup.truncated?'; catchup truncated':''}.`);
  return updated;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [input,output]=process.argv.slice(2);
  if(!input||!output||process.argv.length!==4) throw new Error('Usage: node update_ap_source.mjs INPUT.json OUTPUT.json');
  await updateAPFile(input,output);
}
