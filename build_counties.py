"""Normalize designated public historical downloads; never infer missing votes."""
import argparse
import csv
import hashlib
import json
from pathlib import Path


def build(source_dir, geometry):
    mapped = {str(g['id']).zfill(5) for g in geometry['objects']['counties']['geometries']}
    rows = {}
    hashes = {}
    catalog=json.loads((Path(__file__).parent/'data.json').read_text(encoding='utf-8'))
    states={r['stateName']:r['state'] for r in catalog['races']}
    for year in (2020, 2024):
        path = source_dir / f'{year}_county_tonmcg.csv'
        body = path.read_bytes()
        hashes[str(year)] = hashlib.sha256(body).hexdigest()
        records=list(csv.DictReader(body.decode('utf-8-sig').splitlines()))
        data={'count':len(records),'rows':[{'fips':r['county_fips'],'state':states[r['state_name']],'county':r['county_name'],'year':year,'office':'President','dem_votes':int(r['votes_dem']),'rep_votes':int(r['votes_gop']),'total_votes':int(r['total_votes']),'source':f'Tony McGovern public {year} compilation; see original source notes','licence':'MIT, Tony McGovern 2025; underlying election facts attributed to original publishers'} for r in records]}
        dc=[r for r in data['rows'] if r['state']=='DC']
        if len(dc)>1:
            if {r['fips'] for r in dc}!={f'1100{i}' for i in range(1,9)}:
                raise ValueError('DC wards are not a complete disjoint 1-8 set')
            # Source 2024 uses ward IDs; 11001 otherwise means all of DC in
            # county geometry. Sum the eight complete wards before that join.
            combined={**dc[0],'county':'District of Columbia','source':f'Tony McGovern {year}; sum of all eight source DC wards'}
            for k in ('dem_votes','rep_votes','total_votes'):
                combined[k]=sum(r[k] for r in dc)
            data['rows']=[r for r in data['rows'] if r['state']!='DC']+[combined]
            data['count']=len(data['rows'])
        seen = set()
        if data['count'] != len(data['rows']):
            raise ValueError('Publisher county count disagrees with rows')
        for record in data['rows']:
            fips = record['fips']
            if fips in seen or len(fips) != 5 or not fips.isdigit() or record['year'] != year or record['office'] != 'President':
                raise ValueError('Duplicate or wrong historical identity')
            seen.add(fips)
            values = [record[k] for k in ('dem_votes', 'rep_votes', 'total_votes')]
            if any(type(x) is not int or x < 0 for x in values) or values[0] + values[1] > values[2]:
                raise ValueError('Impossible historical vote count')
            # A statewide Alaska total must not be painted onto a borough.
            scope = 'state legislative district, not a county' if record['state']=='AK' else 'county or county equivalent'
            row = rows.setdefault(fips, {'fips': fips, 'state': record['state'], 'name': record['county'], 'scope': scope, 'geometryMatched': fips in mapped and record['state']!='AK'})
            if row['state'] != record['state']:
                raise ValueError('Conflicting FIPS/state identity')
            row[f'pres{year}'] = dict(zip(('D', 'R', 'total'), values))
            row[f'pres{year}']['source'] = record['source']
            row[f'pres{year}']['license'] = record['licence']
    matched = sum(r['geometryMatched'] for r in rows.values())
    return {'schemaVersion': 1, 'source': {'name': 'Tony McGovern historical election-results compilation', 'url': 'https://github.com/tonmcg/US_County_Level_Election_Results_08-24', 'asOf': '2025-01-17', 'license': 'MIT, Copyright 2025 Tony McGovern; original underlying publishers cited in repository README', 'inputSha256': hashes, 'notes': ['Historical presidential elections only; never 2026 midterm returns. Publisher compilation, not an independent official certification.', '2017 Census geometry is not a current congressional map. Unmatched areas retain missing fill.', 'Alaska export reports state legislative districts, not counties/boroughs. Their IDs are deliberately not joined to borough geometry; district boundaries across years may differ.', 'Connecticut reporting units changed between years; only identical mapped units with both years support a swing comparison.', 'DC2024 is the sum of all eight published ward records before joining to district-wide county geometry.']}, 'coverage': {'rows': len(rows), 'mappedHistoricalAreas': matched, 'geometryAreas': len(mapped), 'unmappedSourceAreas': [r['fips'] for r in rows.values() if not r['geometryMatched']]}, 'rows': sorted(rows.values(), key=lambda r: r['fips'])}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-dir', type=Path, required=True)
    parser.add_argument('--geometry', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = build(args.source_dir, json.loads(args.geometry.read_text(encoding='utf-8')))
    args.output.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':'))+'\n', encoding='utf-8')
    print(json.dumps(result['coverage']))
