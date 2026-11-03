import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateAnalysis,forecastRanking,formatChance} from './analysis-ui.mjs';
const a=JSON.parse(await readFile(new URL('./analysis.json',import.meta.url),'utf8'));
const catalog=JSON.parse(await readFile(new URL('./data.json',import.meta.url),'utf8'));
test('actual full analytical bundle supplies every voting state contest',()=>{assert.equal(validateAnalysis(a,catalog).ok,true);assert.equal(Object.keys(a.races).length,506);assert.equal(a.races['MI-S-regular'].forecast.leftCandidate,'Abdul El-Sayed');assert.ok(a.races['MI-S-regular'].polls.length>3);});
const mutations=[
  ['missing state forecast',x=>delete x.races['MI-S-regular']],
  ['unknown contest',x=>x.races['XX-G']=x.races['MI-G']],
  ['unsafe forecast URL',x=>x.races['MI-G'].forecast.url='javascript:alert(1)'],
  ['invalid probability',x=>x.races['MI-G'].forecast.chanceLeft=1.1],
  ['reversed forecast range',x=>x.races['MI-G'].forecast.low80=1000],
  ['unsafe poll source',x=>x.races['MI-S-regular'].polls[0].url='data:text/html,x'],
  ['negative sample',x=>x.races['MI-S-regular'].polls[0].sample=-1],
  ['noncalendar poll date',x=>x.races['MI-S-regular'].polls[0].endDate='2026-02-30'],
  ['duplicate survey record',x=>x.races['MI-S-regular'].polls.push(x.races['MI-S-regular'].polls[0])],
  ['impossible control probabilities',x=>{x.national.summary.senateDChance=1;x.national.summary.senateRChance=1;}],
  ['impossible chamber seats',x=>x.national.summary.houseDSeats=500],
];
for(const[label,mutate]of mutations)test('rejects '+label,()=>{const x=structuredClone(a);mutate(x);assert.equal(validateAnalysis(x,catalog).ok,false);});
test('same-party party ownership stays distinct from individual odds',()=>{const f=a.races['CA-H-11'].forecast;assert.equal(f.sourceRecord.only_one_party,'D');assert.equal(f.repCandidate,null);assert.ok(catalog.races.find(r=>r.id==='CA-H-11').candidates.length>1);});
test('unmodeled supplementary contests never receive a fake neutral forecast',()=>{assert.equal(a.races['GU-G'],undefined);assert.equal(forecastRanking(a,'GU-G'),2);});
test('tiny and near-certain model probabilities cannot round into certainty',()=>{assert.equal(formatChance(.001),'<1%');assert.equal(formatChance(.995),'>99%');assert.equal(formatChance(.874),'87%');assert.equal(formatChance(.01),'1%');assert.equal(formatChance(.99),'99%');});

test('national generic polls receive the same source, bounds, date, sample and duplicate checks as race polls',()=>{
  const poll=structuredClone(a.races['MI-S-regular'].polls[0]);
  const good=structuredClone(a);good.national.genericPolls=[poll];assert.equal(validateAnalysis(good,catalog).ok,true);
  for(const [label,mutate] of [
    ['unsafe source',p=>p.url='javascript:alert(1)'],['impossible share',p=>p.figures[0].value=101],
    ['negative sample',p=>p.sample=-1],['noncalendar date',p=>p.endDate='2026-02-30'],
    ['reversed field dates',p=>p.startDate='2027-01-01'],['oversized figures',p=>p.figures=Array(31).fill(p.figures[0])],
    ['invalid figure',p=>p.figures=[null]],
  ]){const bad=structuredClone(good);mutate(bad.national.genericPolls[0]);assert.equal(validateAnalysis(bad,catalog).ok,false,label);}
  for(const rows of [[poll,poll],Array(2001).fill(poll),{},null]){const bad=structuredClone(a);bad.national.genericPolls=rows;assert.equal(validateAnalysis(bad,catalog).ok,false);}
});

test('poll evidence needs real identifiers, named organizations and unambiguous nonempty responses',()=>{
 for(const mutate of [p=>delete p.id,p=>p.id={},p=>p.pollster='  ',p=>p.figures=[],p=>p.figures=[{name:'D',value:40},{name:'D',value:60}],p=>p.figures[0].name='']){
  const bad=structuredClone(a);mutate(bad.national.genericPolls[0]);assert.equal(validateAnalysis(bad,catalog).ok,false);
 }
});
