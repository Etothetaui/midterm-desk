"""Normalize publisher forecasts/polls without constructing a forecasting model.

Seed: python update_analysis.py --source-dir ../../../work/source-data/rebuild
Refresh: python update_analysis.py --fetch --source-dir <raw-download-directory>
Failed fetch/validation never replaces the last-good analysis.json.
"""
from __future__ import annotations

import argparse
from collections import Counter
import copy
from datetime import date, datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import sys
import unicodedata
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

BASE = 'https://www.pollingforecast.com'
EXPECTED = {'house': 435, 'senate': 35, 'governors': 36}
PARTIES = {'DEM': 'D', 'REP': 'R', 'IND': 'I', 'OTH': 'OTHER', 'UND': 'UND', 'LIB': 'L', 'GRN': 'G'}
CATEGORIES = {'OTHER', 'UND', 'APPROVE', 'DISAPPROVE', 'SKIP', 'DONTKNOW', 'REFUSED'}

# Public original PDFs opened, rendered and visually checked on 2026-11-03.
# These are factual topline transcriptions, not a new aggregate or forecast.
# Tuple fields: race, compilation ID (None = absent), PDF state, page, figures.
ATLAS_TOPLINES = [
    ('AK-S-regular', None, 'alaska', 14, 'Mary Peltola (D) 50.1; Dan S. Sullivan (R) 44.6; Gerald Heikes (R) 2.5; Other (OTH) 2.2; Dan J. Sullivan (R) 0.6'),
    ('AK-H-00', 1001347, 'alaska', 16, 'Bill Hill (I) 46.6; Nick Begich (R) 46.5; Eric Hafner (D) 5.9; Other (OTH) 0.6; Jim McDermott (L) 0.3'),
    ('AK-G', 1001315, 'alaska', 17, 'Jonathan Kreiss-Tomkins (D) 51.5; Bernadette Wilson (R) 34.0; David Bronson (R) 9.4; Treg Taylor (R) 4.1; Other (OTH) 1.0'),
    ('IA-S-regular', 1001329, 'iowa', 14, 'Josh Turek (D) 50.5; Ashley Hinson (R) 46.4; Other (OTH) 2.7; Would not vote (SKIP) 0.3; Don\'t know (UND) 0.2'),
    ('IA-G', 1001316, 'iowa', 19, 'Rob Sand (D) 54.1; Zach Lahn (R) 44.0; Other (OTH) 1.9; Don\'t know (UND) 0.0'),
    ('KS-S-regular', 1001330, 'kansas', 14, 'Adam Hamilton (D) 51.9; Roger Marshall (R) 44.9; Other (OTH) 1.6; Would not vote (SKIP) 1.2; Don\'t know (UND) 0.5'),
    ('KS-G', 1001307, 'kansas', 19, 'Cindy Holscher (D) 49.9; Ty Masterson (R) 45.6; Would not vote (SKIP) 2.3; Other (OTH) 1.5; Don\'t know (UND) 0.6'),
    ('ME-S-regular', 1001333, 'maine', 14, 'Troy Jackson (D) 53.1; Susan Collins (R) 44.0; Would not vote (SKIP) 2.1; Don\'t know (UND) 0.8'),
    ('ME-G', 1001319, 'maine', 19, 'Hannah Pingree (D) 49.5; Bobby Charles (R) 42.1; Richard Bennett (I) 5.2; Don\'t know (UND) 2.1; Would not vote (SKIP) 0.9; Other (OTH) 0.1'),
    ('MI-S-regular', 1001337, 'michigan', 10, 'Abdul El-Sayed (D) 53.5; Mike Rogers (R) 46.4; Don\'t know (UND) 0.1; Other (OTH) 0.0'),
    ('MI-G', 1001322, 'michigan', 15, 'Jocelyn Benson (D) 53.2; John James (R) 45.2; Don\'t know (UND) 1.1; Other (OTH) 0.4; Would not vote (SKIP) 0.1'),
    ('MN-S-regular', 1001338, 'minnesota', 14, 'Peggy Flanagan (D) 48.1; Michele Tafoya (R) 45.7; Other (OTH) 2.5; Don\'t know (UND) 1.1; Would not vote (SKIP) 2.5'),
    ('NC-S-regular', 1001339, 'north_carolina', 14, 'Roy Cooper (D) 56.4; Michael Whatley (R) 41.5; Other (OTH) 1.3; Don\'t know (UND) 0.4; Would not vote (SKIP) 0.4'),
    ('NH-S-regular', 1001340, 'new_hampshire', 11, 'Chris Pappas (D) 52.3; John Sununu (R) 44.2; Would not vote (SKIP) 1.9; Don\'t know (UND) 1.6'),
    ('NH-G', 1001323, 'new_hampshire', 16, 'Kelly Ayotte (R) 49.7; Cinde Warmington (D) 43.8; Don\'t know (UND) 4.1; Other (OTH) 1.8; Would not vote (SKIP) 0.6'),
    ('OH-S-special', 1001342, 'ohio', 14, 'Sherrod Brown (D) 51.4; Jon Husted (R) 43.9; Other (OTH) 2.9; Would not vote (SKIP) 1.2; Don\'t know (UND) 0.6'),
    ('OH-G', 1001325, 'ohio', 19, 'Amy Acton (D) 51.8; Vivek Ramaswamy (R) 43.9; Don Kissick (L) 2.0; Other (OTH) 1.2; Would not vote (SKIP) 0.8; Don\'t know (UND) 0.4'),
    ('TX-S-regular', 1001250, 'texas', 14, 'James Talarico (D) 51.3; Ken Paxton (R) 45.4; Other (OTH) 1.5; Don\'t know (UND) 1.1; Would not vote (SKIP) 0.7'),
    ('TX-G', 1001239, 'texas', 19, 'Gina Hinojosa (D) 49.2; Greg Abbott (R) 47.6; Other (OTH) 1.3; Don\'t know (UND) 1.2; Would not vote (SKIP) 0.7'),
    ('US', None, 'national_poll', 15, 'The Democratic candidate (D) 55.5; The Republican candidate (R) 41.4; Don\'t know (UND) 2.3; Would not vote (SKIP) 0.8'),
]
ATLAS_RELEASES = {
    'alaska': (522, 4, '2026_midterms__alaska___atlas_pollstergraph_poll_103afadb492016f2.pdf', '1c572c4c74b54a593e7ab557c1ae987d235847167e1ee953aaaad2b29683c3d1'),
    'iowa': (1219, 3, '2026_midterms__iowa___atlas_pollstergraph_poll_115a969a5a5d4770.pdf', '54fb1e7e7be6e0fa401299326c3f84a82435bf21890bb540f9caf31c4922ed14'),
    'kansas': (2038, 2, '2026_midterms__kansas___atlas_pollstergraph_poll_1bc9b9829579665d.pdf', 'f2ec3b8a393e706c4014d7e4b1aa4c76257f114d7ed4d5ab15afe394abc416bc'),
    'maine': (967, 3, '2026_midterms__maine___atlas_pollstergraph_poll_06367ed11aab069d.pdf', 'bcf38cbc3f15a6b99f9d120c6ca21ed2300b190eaf6abe6db80820b661da3ada'),
    'michigan': (1316, 3, '2026_midterms__michigan___atlas_pollstergraph_poll_a513687e165fc30f.pdf', 'bc24388432302a7163fe91d92ab37a4bbba9bb5f9bec8f45787e82ad52aa78a0'),
    'minnesota': (2133, 2, '2026_midterms__minnesota___atlas_pollstergraph_poll_48c699d1876c5ca0.pdf', '77fcbbc49cc953839b7549e57b227c756f63b1a0bcaf9914929e42db50fb80d8'),
    'new_hampshire': (1057, 3, '2026_midterms__new_hampshire___atlas_pollstergraph_poll_8a777e8b3b81438d.pdf', '1a655a79ae60f383513eb6b49c3948ea6721b23a49e94f902bcda3e36a9fed0a'),
    'north_carolina': (1459, 3, '2026_midterms__north_carolina___atlas_pollstergraph_poll_e2d4022e2b251d27.pdf', '311c64dd998fb1d7cc59a509307b02c2d3c1a9c31ba3946a8bff1f4b98164464'),
    'ohio': (1801, 2, '2026_midterms__ohio___atlas_pollstergraph_poll_a53ea713086dbbe0.pdf', '2d23817ee435ea188c63b0b5fdc1f92f7ec9114cea9f23277dffe9cd19a6f84e'),
    'texas': (1678, 2, '2026_midterms__texas_110126_1_e8958087c4dc49a8.pdf', 'ec9cdabb60b97f3156824817ae7d883255f880a107c43a2855571d0b1f6dc700'),
    'national_poll': (3566, 2, '2026_midterms__national_poll_110126_1_87e74540c4d7f251.pdf', 'ee8beb932a2ed5f37c50736d58ef32e77260e6425131ea374263c2b5a529f358'),
}


def safe_url(value):
    if not isinstance(value, str) or any(ord(c) < 32 for c in value):
        return False
    try:
        p = urlsplit(value)
        return p.scheme == 'https' and bool(p.hostname) and not any(c.isspace() for c in p.netloc) and p.username is None and p.password is None
    except ValueError:
        return False


def number(value, low=-100, high=100, nullable=False):
    return (nullable and value is None) or (type(value) in (int, float) and math.isfinite(value) and low <= value <= high)


def day(value):
    if not isinstance(value, str):
        raise ValueError('Date must be text')
    if len(value) == 10:
        return date.fromisoformat(value).isoformat()
    return datetime.fromisoformat(value).date().isoformat()


def norm(value):
    value = ''.join(c for c in unicodedata.normalize('NFKD', value).casefold() if not unicodedata.combining(c))
    words = re.findall(r'[a-z0-9]+', value)
    return ' '.join(w for w in words if len(w) > 1 and w not in {'jr', 'sr', 'ii', 'iii', 'iv'})


def name_matches(name, candidates):
    target = norm(name)
    return any(target == norm(alias) for c in candidates for alias in [c['name'], *c.get('aliases', [])] if isinstance(alias, str))


def primary_name_matches(name, candidates):
    # Keep middle initials for original-source reconciliation. Only explicit,
    # evidenced catalog aliases may resolve differing official/display names.
    def full(value):
        value = ''.join(c for c in unicodedata.normalize('NFKD', value).casefold() if not unicodedata.combining(c))
        return ' '.join(re.findall(r'[a-z0-9]+', value))
    return any(full(name) == full(alias) for candidate in candidates
               for alias in [candidate['name'], *candidate.get('aliases', [])] if isinstance(alias, str))


def catalog_identity(catalog):
    """Election/candidate identity only: result corrections must not invalidate it."""
    rows = {r['id']: {'candidateMetadata': r['candidates']} for r in catalog['races']
            if (r['office'] == 'house' and r['kind'] == 'regular' and r['seatVoting']) or
            r['office'] == 'senate' or (r['office'] == 'governor' and r['seatVoting'])}
    return analysis_identity(rows)


def analysis_identity(races):
    if not isinstance(races, dict) or len(races) != 506:
        raise ValueError('Expected 506 identity records')
    identity = [{'raceId': rid, 'candidates': sorted(
        [{key: c[key] for key in ['id', 'name', 'party']} for c in item['candidateMetadata']], key=lambda c: c['id'])}
        for rid, item in sorted(races.items())]
    return hashlib.sha256(json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()


def usable_previous(previous, catalog):
    try:
        if previous.get('schemaVersion') != 1 or not safe_url(previous['source']['url']) or analysis_identity(previous['races']) != catalog_identity(catalog):
            return False
        day(previous['source']['asOf'])
        return all(isinstance(r['forecast'], dict) and number(r['forecast']['chanceLeft'], 0, 1) and isinstance(r['polls'], list) and
                   all(isinstance(p, dict) and isinstance(p.get('figures'), list) and safe_url(p.get('url')) for p in r['polls'])
                   for r in previous['races'].values())
    except (KeyError, TypeError, ValueError):
        return False


def retain_national(result, previous, catalog):
    """Reuse dated evidence, never convert its retrieval date into today's date."""
    if not usable_previous(previous, catalog):
        return False
    national = previous.get('national', {})
    history = national.get('history')
    evidence = previous.get('source', {}).get('nationalHistory')
    if not isinstance(history, list) or not history or not isinstance(evidence, dict) or not safe_url(evidence.get('url')):
        return False
    try:
        for row in history:
            day(row['date'])
            if type(row['reconstructed']) is not bool or not all(number(row[k], 0, 1) for k in ['houseDChance', 'senateDChance', 'senateRChance']):
                return False
        if national.get('summary') != history[-1]:
            return False
        current = result['national'].get('history', [])
        if current and current[-1]['date'] >= history[-1]['date']:
            return False
    except (KeyError, TypeError, ValueError):
        return False
    for key in ['history', 'summary', 'chamberProbabilities']:
        result['national'][key] = copy.deepcopy(national.get(key))
    result['source']['nationalHistory'] = copy.deepcopy(evidence)
    result['source']['nationalHistory']['retainedAt'] = datetime.now(timezone.utc).isoformat()
    result['source']['nationalHistory']['status'] = 'retained'
    result['source']['nationalHistory']['retentionNote'] = 'No newer rendered table supplied. Original dates retained; this history was not refreshed.'
    original_hash = previous.get('source', {}).get('inputSha256', {}).get('nationalHistory')
    if original_hash:
        result['source']['inputSha256']['nationalHistory'] = original_hash
    return True


def catalog_id(row):
    key = row['key']
    if row['kind'] == 'House' and re.fullmatch(r'[A-Z]{2}-\d{2}', key):
        return key[:2] + '-H-' + key[3:]
    if row['kind'] == 'Senate' and re.fullmatch(r'[A-Z]{2}(?:-S)?', key):
        return key[:2] + '-S-' + ('special' if key.endswith('-S') else 'regular')
    if row['kind'] == 'Governor' and re.fullmatch(r'G-[A-Z]{2}', key):
        return key[2:] + '-G'
    raise ValueError('Unrecognized publisher contest key: ' + str(key))


def parse_figures(raw):
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError('Missing poll figures')
    figures = []
    for token in raw.split(';'):
        match = re.fullmatch(r'\s*(.+?)\s+\(([^()]+)\)\s+([\d.]+)\s*', token)
        if not match:
            raise ValueError('Unparseable figure: ' + token)
        name, party, value = match.groups()
        value = float(value)
        if not number(value, 0, 100):
            raise ValueError('Invalid poll percentage')
        # A blank label with an explicit OTH category is not a missing candidate.
        # Preserve source text and label the category without inventing a name.
        original_name = name
        name = name.strip()
        if not name:
            name = {'OTH': 'Other (source OTH category)', 'OTHER': 'Other (source OTHER category)', 'UND': 'Undecided (source UND category)'}.get(party)
            if name is None:
                raise ValueError('Unnamed candidate response')
        if any(item['name'] == name for item in figures):
            raise ValueError('Duplicate poll response name')
        figure = {'name': name, 'party': PARTIES.get(party, party), 'sourceParty': party, 'value': value}
        if not original_name.strip():
            figure['originalName'] = original_name
            figure['labelNote'] = 'Display label derives only from explicit source category; raw figures retained.'
        figures.append(figure)
    return figures


def envelope(data, dataset):
    if not isinstance(data, dict) or data.get('dataset') != dataset or not isinstance(data.get('rows'), list):
        raise ValueError(dataset + ': malformed envelope')
    if type(data.get('count')) is not int or data['count'] != len(data['rows']):
        raise ValueError(dataset + ': declared count differs')
    if dataset in EXPECTED and data['count'] != EXPECTED[dataset]:
        raise ValueError(dataset + ': incomplete national forecast')
    if len(data['rows']) > 50000 or not isinstance(data.get('licence'), str):
        raise ValueError(dataset + ': bounds/license missing')
    day(data.get('asOf'))
    if not all(isinstance(row, dict) for row in data['rows']):
        raise ValueError(dataset + ': null/non-object row')


def normalized_poll(row):
    poll_id = row.get('poll_id')
    valid_id = type(poll_id) is int or (isinstance(poll_id, str) and re.fullmatch(r'atlas-[A-Za-z0-9-]+', poll_id))
    if not valid_id or not isinstance(row.get('pollster'), str) or not row['pollster'].strip():
        raise ValueError('Invalid poll identity')
    start = day(row['fieldwork_start']) if row.get('fieldwork_start') is not None else None
    end = day(row.get('fieldwork_end'))
    if (start is not None and start > end) or not safe_url(row.get('source_url')):
        raise ValueError('Invalid field period/source URL')
    sample = row.get('sample')
    if sample is not None and not number(sample, 0.000001, 100000000):
        raise ValueError('Invalid sample')
    if not isinstance(row.get('population'), str) or not isinstance(row.get('licence'), str):
        raise ValueError('Missing population/license')
    if row.get('source_grade') not in {'A', 'B', 'C', None}:
        raise ValueError('Invalid source grade')
    for key in ['margin', 'adjusted_margin']:
        if not number(row.get(key), -200, 200, nullable=True):
            raise ValueError('Invalid publisher-derived margin')
    for key in ['sponsor', 'partisan', 'question']:
        if row.get(key) is not None and not isinstance(row[key], str):
            raise ValueError('Invalid poll ' + key)
    figures = parse_figures(row.get('figures'))
    return {'id': str(row['poll_id']), 'pollster': row['pollster'], 'pollsterCode': row.get('pollster_code'),
            'startDate': start, 'endDate': end, 'population': row['population'], 'sample': sample,
            'figures': figures, 'rawFigures': row['figures'], 'sponsor': row.get('sponsor'),
            'partisan': row.get('partisan'), 'sourceGrade': row.get('source_grade'), 'url': row['source_url'],
            'license': row['licence'], 'question': row.get('question'), 'stage': row.get('stage'),
            'publishedMargin': row.get('margin'), 'publisherAdjustedMargin': row.get('adjusted_margin'),
            'marginDefinition': 'Publisher decided-vote margin, not raw candidate-percentage subtraction; retained unchanged if original categories are corrected',
            'denominator': 'As published; no renormalization', 'confirmation': None, 'corrections': []}


def correct_michigan(poll):
    # Exact rows checked against opened original releases on 2026-11-03.
    if poll['id'] == '1001336' and poll['url'] == 'https://concordpublicopinionpartners.org/blog/michigan-ge-2026':
        original = {'startDate': poll['startDate'], 'figures': [dict(f) for f in poll['figures']], 'sponsor': poll['sponsor']}
        poll['startDate'] = '2026-10-30'
        poll['sponsor'] = 'Education Reform Now Advocacy'
        for figure in poll['figures']:
            if figure['party'] in {'OTHER', 'UND'}:
                figure['value'] = 4.0
        poll['corrections'] = [{'reason': 'Original publisher release reports Oct 30-Nov 1, 4% other and 4% undecided; aggregator transcribes Oct 31, 3%, 5%.', 'original': original, 'url': poll['url']}]
        poll['confirmation'] = {'type': 'original-release-opened', 'checkedAt': '2026-11-03', 'url': poll['url']}
    elif poll['id'] == '1001334' and poll['url'] == 'https://johnzogbystrategies.com/el-sayed-leads-rogers-51-49-new-john-zogby-strategies-eve-of-election-day-poll/':
        poll['confirmation'] = {'type': 'original-release-opened', 'checkedAt': '2026-11-03', 'url': poll['url'], 'note': '51/49; n=1001 likely voters/already voted; online; publisher reports +/-3.2 percentage points.'}
    elif poll['id'] == '1001264' and poll['url'] == 'https://researchco.ca/2026/11/01/midterms-2026-one/':
        poll['confirmation'] = {'type': 'original-tables-opened', 'checkedAt': '2026-11-03', 'url': 'https://researchco.ca/wp-content/uploads/2026/11/Tables_MidTerms_USA_01Nov2026.pdf', 'note': 'Page 1: all LV n450 48/46/1/5; decided n426 51/48/1 is a separate denominator, not an additional poll.'}


def normalize_history(capture):
    if not isinstance(capture, dict) or not safe_url(capture.get('url')) or not isinstance(capture.get('tables'), list):
        raise ValueError('Invalid national history capture')
    history = []
    def pct(value):
        result = float(value.removesuffix('%')) / 100
        if not number(result, 0, 1):
            raise ValueError('Invalid history probability')
        return result
    def seats(value):
        match = re.fullmatch(r'(\d+) \((\d+)-(\d+)\)', value)
        if not match:
            raise ValueError('Invalid history seat interval')
        mid, low, high = map(int, match.groups())
        if not low <= mid <= high:
            raise ValueError('Unordered history seat interval')
        return {'median': mid, 'low80': low, 'high80': high}
    seen = set()
    for row in capture['tables'][0][1:]:
        if len(row) != 9 or row[8] not in {'live', 'reconstructed'}:
            raise ValueError('Malformed history row')
        stamp = datetime.strptime(row[0] + ' 2026', '%d %b %Y').date().isoformat()
        if stamp in seen:
            raise ValueError('Duplicate history date')
        seen.add(stamp)
        margin = re.fullmatch(r'([DR])\+([\d.]+)', row[7])
        if not margin:
            raise ValueError('Invalid generic-ballot history margin')
        h, s = seats(row[2]), seats(row[5])
        history.append({'date': stamp, 'houseDChance': pct(row[1]), 'houseDSeats': h['median'], 'houseLow80': h['low80'], 'houseHigh80': h['high80'],
                        'senateDChance': pct(row[3]), 'senateRChance': pct(row[4]), 'senateDSeats': s['median'], 'senateLow80': s['low80'], 'senateHigh80': s['high80'],
                        'governorsD': int(row[6]), 'genericMargin': float(margin[2]) * (1 if margin[1] == 'D' else -1),
                        'reconstructed': row[8] == 'reconstructed', 'status': row[8], 'url': capture['url']})
    if not history:
        raise ValueError('Empty history capture')
    history.sort(key=lambda r: r['date'])
    return history


def integrate_atlas(races, national, catalog_races, raw_rows, excluded):
    """Replace the same survey's compilation with original factual precision.

    Never treat valid-vote and all-response tables as independent polls. A
    source-verified field that differs from the catalog stays visible separately.
    """
    originals = {str(row['poll_id']): row for row in raw_rows if row.get('pollster_code') == 'ATLASINTEL'}
    primary_ids = {str(item[1]) for item in ATLAS_TOPLINES if item[1] is not None}
    for race in races.values():
        race['polls'] = [p for p in race['polls'] if p['id'] not in primary_ids]
        race['unmatchedPolls'] = []
    excluded[:] = [item for item in excluded if str(item.get('id')) not in primary_ids]
    matched, unmatched, added = 0, 0, 0
    for rid, compiled_id, state, page, figures in ATLAS_TOPLINES:
        sample, moe, filename, digest = ATLAS_RELEASES[state]
        url = 'https://cdn1.atlasintel.org/' + filename
        raw = {'poll_id': compiled_id if compiled_id is not None else 'atlas-20261101-' + rid,
               'pollster': 'AtlasIntel', 'pollster_code': 'ATLASINTEL', 'fieldwork_start': '2026-10-28',
               'fieldwork_end': '2026-11-01', 'population': 'LV', 'sample': sample, 'figures': figures,
               'source_url': url, 'source_grade': 'A', 'licence': 'Public factual topline transcription with citation; AtlasIntel copyright retained; no open-content license located',
               'stage': 'vote', 'question': 'Generic congressional ballot' if rid == 'US' else 'General-election candidate ballot test',
               'sponsor': 'PollsterGraph' if state not in {'texas', 'national_poll'} else None,
               'partisan': None, 'margin': None, 'adjusted_margin': None}
        poll = normalized_poll(raw)
        poll['rawFigures'] = figures
        poll['sourceGradeBasis'] = 'Direct original PDF visually inspected; provenance grade, not a pollster accuracy grade'
        poll['method'] = 'Atlas Random Digital Recruitment (RDR)'
        poll['interval'] = {'value': moe, 'type': 'publisher-reported margin of error', 'target': 'Overall survey target population', 'confidenceLevel': 95}
        poll['denominator'] = 'Valid votes as labeled in the original PDF; exact valid-vote subgroup N not supplied' if state == 'alaska' else 'All reported response categories in original topline; no renormalization'
        poll['sampleBasis'] = 'Nominal overall likely-voter survey sample; not an inferred valid-vote subgroup count'
        poll['round'] = 'First-choice ballot test; not a simulated RCV final round' if state == 'alaska' or (state == 'maine' and '-S-' in rid) else 'General-election ballot test'
        poll['confirmation'] = {'type': 'original-pdf-visually-checked', 'checkedAt': '2026-11-03', 'url': url, 'page': page, 'samplePage': 5, 'pdfSha256': digest}
        old = originals.get(str(compiled_id))
        if old is not None:
            poll['compilationSource'] = copy.deepcopy(old)
            poll['corrections'] = [{'reason': 'Original PDF precision, full named field and response-category distinctions supersede the compilation; source transcription retained.',
                                    'url': url, 'page': page, 'originalFigures': old['figures'], 'originalSourceGrade': old.get('source_grade'), 'originalLicense': old.get('licence')}]
        else:
            added += 1
        if rid == 'US':
            national['genericPolls'] = [p for p in national['genericPolls'] if not (p['pollsterCode'] == 'ATLASINTEL' and p['endDate'] == '2026-11-01')]
            national['genericPolls'].append(poll)
            continue
        names = [f['name'] for f in poll['figures'] if f['party'] not in CATEGORIES]
        missing = [name for name in names if not primary_name_matches(name, catalog_races[rid]['candidates'])]
        # The Alaska plot explicitly contains two distinct Sullivans. Dropping
        # middle initials during a name match must never merge their observations.
        identity_review = rid == 'AK-S-regular'
        poll['candidateFieldMatch'] = not missing and not identity_review
        poll['unmatchedCandidates'] = missing
        if identity_review:
            poll['candidateFieldWarning'] = 'Source names Dan S. Sullivan and Dan J. Sullivan separately. Candidate-ID/initial reconciliation required; no observations merged.'
        elif missing:
            poll['candidateFieldWarning'] = 'Original source supplies names absent or different in the catalog: ' + ', '.join(missing)
        if poll['candidateFieldMatch']:
            races[rid]['polls'].append(poll); matched += 1
        else:
            races[rid]['unmatchedPolls'].append(poll); unmatched += 1
    return {'originalPublicSurveys': 11, 'raceObservations': 19, 'matchedRaceObservations': matched,
            'unmatchedRaceObservationsVisible': unmatched, 'nationalGenericObservations': 1,
            'rawCompilationRowsSuperseded': len(primary_ids.intersection(originals)), 'observationsAbsentFromCompilation': added,
            'verifiedAt': '2026-11-03', 'fieldStart': '2026-10-28', 'fieldEnd': '2026-11-01',
            'note': 'Multiple offices in one state share the same respondents. No primary or valid-vote alternative is counted as an independent extra survey.'}


def integrate_checked_national(national, catalog):
    # Exact released question records checked earlier in this campaign outrank
    # their compilation transcription. Preserve both evidence layers.
    from urllib.parse import urlsplit
    def url_key(url):
        parts = urlsplit(url)
        return parts.netloc.lower().removeprefix('www.') + parts.path.rstrip('/')
    for checked in catalog.get('nationalPolls', []):
        matches = [p for p in national['genericPolls'] if p['endDate'] == checked['endDate'] and (url_key(p['url']) == url_key(checked['sourceUrl']) or checked['id'] == 'emerson-20261026' and p['id'] == '1001135' and p.get('pollsterCode') == 'EMERSON' and p['startDate'] == '2026-10-24')]
        old = matches[0] if len(matches) == 1 else None
        if len(matches) > 1:
            continue
        figures = [{'name': name, 'party': party, 'sourceParty': party, 'value': checked[key]} for key, name, party in [('dem', 'Democratic candidate', 'D'), ('rep', 'Republican candidate', 'R'), ('other', 'Other', 'OTHER'), ('undecided', 'Undecided', 'UND')] if checked.get(key) is not None]
        result = dict(old or {})
        result.update(id=(old or {}).get('id', checked['id']), pollsterCode=(old or {}).get('pollsterCode'), pollster=checked['pollster'], startDate=checked['startDate'], endDate=checked['endDate'], population=checked['population'], sample=checked['sampleSize'], figures=figures, url=checked['sourceUrl'], sourceGrade=(old or {}).get('sourceGrade', 'A'), license=(old or {}).get('license', 'Original public factual toplines; source rights retained'), question='Original checked generic-ballot question', denominator=checked.get('sampleBasis', '') + '; ' + checked.get('denominator', ''), interval=checked.get('interval'), sponsor=(old or {}).get('sponsor'), partisan=None, confirmation={'note': 'Previously checked original national reference observation; original source facts supersede compilation transcription. Sample basis and response categories retained.'}, corrections=checked.get('corrections', []))
        if old:
            result['compilationSource'] = {'id': old['id'], 'url': old['url'], 'startDate': old['startDate'], 'figures': old['figures'], 'sample': old['sample'], 'partisan': old.get('partisan'), 'license': old['license']}
            national['genericPolls'].remove(old)
        national['genericPolls'].append(result)


def build_analysis(bundles, catalog, *, retrieved_at, input_hashes=None, include_atlas=True):
    for dataset in (*EXPECTED, 'polls'):
        envelope(bundles[dataset], dataset)
    dates = {bundles[k]['asOf'] for k in bundles}
    if len(dates) != 1:
        raise ValueError('Publisher dataset as-of dates disagree; retain last-good until reconciled')
    catalog_races = {r['id']: r for r in catalog['races']}
    expected_ids = {r['id'] for r in catalog['races'] if (r['office'] == 'house' and r['kind'] == 'regular' and r['seatVoting']) or r['office'] == 'senate' or (r['office'] == 'governor' and r['seatVoting'])}
    if len(expected_ids) != 506:
        raise ValueError('Catalog does not define the expected 506 state voting contests')
    races, publisher_keys, warnings = {}, {}, []
    for dataset in EXPECTED:
        for row in bundles[dataset]['rows']:
            if row.get('kind') != {'house': 'House', 'senate': 'Senate', 'governors': 'Governor'}[dataset]:
                raise ValueError('Forecast kind differs from dataset')
            rid = catalog_id(row)
            if rid not in expected_ids or rid in races or row.get('state') != catalog_races[rid]['state']:
                raise ValueError('Missing/unexpected/duplicate forecast identity: ' + rid)
            for key in ['best_bet_margin', 'range80_low', 'range80_high', 'fundamentals_margin']:
                if not number(row.get(key), -200, 200):
                    raise ValueError(rid + ': invalid forecast ' + key)
            if not number(row.get('chance_left'), 0, 1) or not number(row.get('poll_weight'), 0, 1) or not number(row.get('poll_average'), -200, 200, nullable=True):
                raise ValueError(rid + ': invalid forecast probability/weight/average')
            if row['range80_low'] > row['best_bet_margin'] or row['range80_high'] < row['best_bet_margin']:
                raise ValueError(rid + ': unordered forecast interval')
            if type(row.get('polls_used')) is not int or row['polls_used'] < 0 or not safe_url(BASE + row.get('page', '')) or not isinstance(row.get('licence'), str):
                raise ValueError(rid + ': missing forecast provenance')
            candidates = catalog_races[rid]['candidates']
            unmatched = [name for name in [row.get('left_candidate'), row.get('rep_candidate')] if name and not name_matches(name, candidates)]
            if unmatched:
                warnings.append({'raceId': rid, 'type': 'publisher-candidate-mismatch', 'names': unmatched})
            forecast = {'leftCandidate': row.get('left_candidate'), 'leftParty': row.get('left_party'), 'repCandidate': row.get('rep_candidate'),
                        'chanceLeft': row['chance_left'], 'margin': row['best_bet_margin'], 'low80': row['range80_low'], 'high80': row['range80_high'],
                        'pollAverage': row['poll_average'], 'pollAverageDefinition': 'Publisher adjusted decided-vote margin; not raw vote shares',
                        'pollWeight': row['poll_weight'], 'pollsUsed': row['polls_used'], 'rating': row.get('rating'),
                        'fundamentalsMargin': row['fundamentals_margin'], 'presidential2024Margin': row.get('pres2024_margin'),
                        'url': BASE + row['page'], 'asOf': row.get('as_of'), 'license': row['licence'],
                        'candidateMatch': not unmatched, 'unmatchedCandidates': unmatched,
                        'chanceRightModeledPair': (1 - row['chance_left']) if row.get('left_party') == 'D' and row.get('left_candidate') and row.get('rep_candidate') and 'only_one_party' in row and row['only_one_party'] is None else None,
                        'chanceRightDefinition': 'Arithmetic complement within publisher D-vs-R margin model only; conditional on that modeled pair, not a separately supplied all-candidate probability. Independent-left and single-party fields are excluded.',
                        'probabilityScope': 'Publisher left-side frequency; D-vs-R conditional complement labeled separately. Other candidates receive no invented zero probabilities.',
                        'sourceRecord': row}
            races[rid] = {'forecast': forecast, 'polls': [], 'history': [], 'historyStatus': 'No publisher race-history series supplied; use dated poll observations',
                          'candidateMetadata': [{'id': c['id'], 'name': c['name'], 'party': c['party']} for c in candidates]}
            publisher_keys[row['key']] = rid
    if set(races) != expected_ids:
        raise ValueError('Forecast set differs from catalog set')
    excluded, seen_polls, national = [], set(), {'genericPolls': [], 'approvalPolls': [], 'history': [], 'chamberProbabilities': None}
    for raw in bundles['polls']['rows']:
        if raw.get('stage') != ('approval' if raw.get('kind') == 'Approval' else 'vote'):
            excluded.append({'id': raw.get('poll_id'), 'reason': 'not-general-election'}); continue
        if not safe_url(raw.get('source_url')):
            excluded.append({'id': raw.get('poll_id'), 'reason': 'unusable-source-url', 'sourceUrl': raw.get('source_url')}); continue
        try:
            end = day(raw.get('fieldwork_end'))
            start = day(raw['fieldwork_start']) if raw.get('fieldwork_start') is not None else None
            if start is not None and start > end:
                raise ValueError('reversed field period')
        except ValueError:
            excluded.append({'id': raw.get('poll_id'), 'reason': 'unusable-field-period', 'start': raw.get('fieldwork_start'), 'end': raw.get('fieldwork_end')}); continue
        try:
            poll = normalized_poll(raw)
        except (TypeError, ValueError) as error:
            raise ValueError('Malformed publisher poll ' + str(raw.get('poll_id')) + ': ' + str(error)) from error
        identity = (raw.get('race'), raw.get('kind'), poll['id'])
        if identity in seen_polls:
            raise ValueError('Duplicate poll observation: ' + str(identity))
        seen_polls.add(identity)
        if raw.get('kind') in {'Generic', 'Approval'} and raw.get('race') == 'US':
            national['genericPolls' if raw['kind'] == 'Generic' else 'approvalPolls'].append(poll); continue
        rid = publisher_keys.get(raw.get('race'))
        if rid is None:
            excluded.append({'id': poll['id'], 'reason': 'race-outside-current-state-forecast'}); continue
        expected_kind = {'house': 'House', 'senate': 'Senate', 'governor': 'Governor'}[catalog_races[rid]['office']]
        names = [f['name'] for f in poll['figures'] if f['party'] not in CATEGORIES and norm(f['name']) not in {'other', 'others', 'undecided', 'someone else', 'another candidate'}]
        if raw.get('kind') != expected_kind or not names or any(not name_matches(n, catalog_races[rid]['candidates']) for n in names):
            excluded.append({'id': poll['id'], 'raceId': rid, 'reason': 'candidate-field-mismatch', 'names': names}); continue
        if rid == 'MI-S-regular':
            correct_michigan(poll)
        races[rid]['polls'].append(poll)
    atlas = integrate_atlas(races, national, catalog_races, bundles['polls']['rows'], excluded) if include_atlas else None
    integrate_checked_national(national, catalog)
    for race in races.values():
        race['polls'].sort(key=lambda p: (p['endDate'], p['startDate'] or '', p['id']), reverse=True)
    for key in ['genericPolls', 'approvalPolls']:
        national[key].sort(key=lambda p: (p['endDate'], p['id']), reverse=True)
    counts = Counter(catalog_races[rid]['office'] for rid, r in races.items() if r['polls'])
    return {'schemaVersion': 1, 'generatedAt': datetime.now(timezone.utc).isoformat(),
            'source': {'name': 'Polling Forecast', 'url': BASE + '/us/data', 'methodologyUrl': BASE + '/us/method',
                       'license': 'CC BY 4.0 for publisher forecasts; poll-row licenses retained separately', 'asOf': next(iter(dates)),
                       'catalogSnapshotId': catalog.get('snapshotId'),
                       'catalogIdentitySha256': catalog_identity(catalog),
                       'atlasPrimaryVerification': atlas,
                       'retrievedAt': retrieved_at, 'attribution': {k: bundles[k].get('attribution') for k in bundles}, 'inputSha256': input_hashes or {},
                       'dateNote': 'Dataset asOf is publisher metadata, not retrieval time or every poll field date; site page may show a newer run.',
                       'notes': ['Poll source grades are publisher grades, not our independent verification. CC BY-SA rows retain their row license and source link.',
                                 'Publisher forecast candidate mismatches require review before attaching a probability to a catalog candidate.',
                                 'Raw matching polls are not the same set as publisher pollsUsed or its adjusted pollAverage; no own aggregate/model is created.',
                                 'Original Michigan Concord release corrects transcribed categories, start date and sponsor; publisher forecast is left unchanged.',
                                 'AtlasIntel original public PDFs were separately visually checked; full decimal figures and named fields replace compilation rows, with original grade/license retained in compilationSource. Unmatched whole fields remain visible separately.',
                                 'National generic feed retains earlier original-checked reference corrections over matching compilation transcriptions; full original compilation fields stay in compilationSource.']},
            'coverage': {'stateForecastRaces': len(races), 'house': 435, 'senate': 35, 'governorStates': 36,
                         'pollRowsSupplied': len(bundles['polls']['rows']), 'racePollsAdmitted': sum(len(r['polls']) for r in races.values()),
                         'racesWithPolls': sum(bool(r['polls']) for r in races.values()), 'racesWithPollsByOffice': dict(counts),
                         'forecastCandidateMismatches': len(warnings), 'supplementaryForecastUnavailable': [r['id'] for r in catalog['races'] if r['id'] not in expected_ids],
                         'atlas': atlas,
                         'excludedPollReasons': dict(Counter(e['reason'] for e in excluded)),
                         'notes': ['All 506 state contests retain publisher forecast output; candidate mismatches are flagged, never silently renamed.',
                                   'Polling absence is not zero support. Published rounding is preserved. No candidate/chamber probabilities are invented.',
                                   'Only vote-stage polls whose named field matches current catalog candidates enter race polling lists.']},
            'races': races, 'national': national, 'warnings': warnings, 'excludedPolls': excluded}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir', type=Path, required=True)
    parser.add_argument('--catalog', type=Path, default=Path(__file__).with_name('data.json'))
    parser.add_argument('--output', type=Path, default=Path(__file__).with_name('analysis.json'))
    parser.add_argument('--fetch', action='store_true')
    parser.add_argument('--allow-stale', action='store_true', help='On refresh failure, exit 0 only with usable same-candidate last-good analysis; emit updateHealth JSON for the workflow to publish.')
    args = parser.parse_args(argv)
    previous, catalog = None, None
    try:
        catalog_payload = args.catalog.read_bytes()
        catalog = json.loads(catalog_payload.decode('utf-8-sig'))
        if args.output.exists():
            previous = json.loads(args.output.read_text(encoding='utf-8-sig'))
        bundles, payloads, hashes = {}, {}, {}
        for dataset in (*EXPECTED, 'polls'):
            path = args.source_dir / ('pollingforecast-' + dataset + '.json')
            if args.fetch:
                req = Request(BASE + '/us/data/' + dataset + '.json', headers={'User-Agent': 'ElectionTracker/0.1.0 (public dataset refresh)', 'Accept': 'application/json'})
                with urlopen(req, timeout=20) as response:
                    payload = response.read(20000001)
                if len(payload) > 20000000:
                    raise ValueError('Dataset exceeds bounded download')
            else:
                payload = path.read_bytes()
            payloads[dataset] = payload
            hashes[dataset] = hashlib.sha256(payload).hexdigest()
            bundles[dataset] = json.loads(payload.decode('utf-8-sig'))
        retrieved_at = datetime.now(timezone.utc).isoformat() if args.fetch else max(datetime.fromtimestamp((args.source_dir / ('pollingforecast-' + k + '.json')).stat().st_mtime, timezone.utc).isoformat() for k in bundles)
        hashes['catalog'] = hashlib.sha256(catalog_payload).hexdigest()
        result = build_analysis(bundles, catalog, retrieved_at=retrieved_at, input_hashes=hashes)
        history_path = args.source_dir / 'pollingforecast-national-history-dom.json'
        if history_path.exists():
            capture = json.loads(history_path.read_text(encoding='utf-8-sig'))
            result['national']['history'] = normalize_history(capture)
            result['national']['summary'] = result['national']['history'][-1]
            latest = result['national']['summary']
            result['national']['chamberProbabilities'] = {'asOf': latest['date'], 'url': capture['url'],
                'house': {'D': latest['houseDChance'], 'R': None},
                'senate': {'D': latest['senateDChance'], 'R': latest['senateRChance']},
                'note': 'Published rounded control probabilities; no missing complement is invented. Senate D/R values do not sum to 100%; retain source definitions.'}
            result['source']['nationalHistory'] = {'url': capture['url'], 'retrievedAt': capture['retrievedAt'], 'method': capture.get('method'),
                'note': 'Rendered table observations only, not hidden chart data; weekly displayed rows. Pre-29-Sep is reconstructed, later rows recorded live. National latest date differs from race-file asOf.'}
            result['source']['inputSha256']['nationalHistory'] = hashlib.sha256(history_path.read_bytes()).hexdigest()
        retained_history = retain_national(result, previous, catalog) if previous else False
        result['updateHealth'] = {'status': 'ready', 'checkedAt': datetime.now(timezone.utc).isoformat(), 'mode': 'fetch' if args.fetch else 'seed',
            'nationalHistoryStatus': 'retained' if retained_history else ('supplied' if result['national']['history'] else 'unavailable'),
            'message': 'Dated national history retained without a newer table.' if retained_history else 'Publisher bundle normalized; evidence dates remain separate from this check.'}
        encoded = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + '\n'
        # Commit only after all inputs and the complete normalized candidate pass.
        if args.fetch:
            args.source_dir.mkdir(parents=True, exist_ok=True)
            for dataset, payload in payloads.items():
                (args.source_dir / ('pollingforecast-' + dataset + '.json')).write_bytes(payload)
        temporary = args.output.with_suffix('.json.tmp')
        temporary.write_text(encoded, encoding='utf-8')
        temporary.replace(args.output)
        print(json.dumps({'ok': True, 'coverage': result['coverage'], 'asOf': result['source']['asOf'], 'updateHealth': result['updateHealth']}))
        return 0
    except Exception as error:
        retained = previous is not None and catalog is not None and usable_previous(previous, catalog)
        health = {'status': 'retained' if retained else 'error', 'checkedAt': datetime.now(timezone.utc).isoformat(), 'error': str(error),
                  'message': 'Refresh failed; last-good artifact was not changed.' if retained else 'Refresh failed; no usable same-candidate last-good artifact.'}
        # The workflow publishes this health separately. Do not rewrite the data
        # artifact merely to make a failed attempt look like a new data edition.
        allowed = args.allow_stale and retained
        print(json.dumps({'ok': False, 'retainedLastGood': retained, 'error': str(error), 'updateHealth': health}), file=sys.stdout if allowed else sys.stderr)
        return 0 if allowed else 1


if __name__ == '__main__':
    sys.exit(main())
