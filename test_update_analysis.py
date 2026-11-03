"""Bounded normalization checks. Synthetic polls below are fictional test data."""
import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import update_analysis as update

APP = Path(__file__).parent


def synthetic_poll(**changes):
    row = {'poll_id': 90000001, 'race': 'MI', 'kind': 'Senate', 'stage': 'vote',
           'pollster': 'Fictional test pollster', 'pollster_code': 'TEST', 'sponsor': None,
           'partisan': None, 'fieldwork_start': '2026-10-01', 'fieldwork_end': '2026-10-03',
           'population': 'LV', 'sample': None, 'question': 'Synthetic general-election question',
           'figures': 'Abdul El-Sayed (D) 48; Mike Rogers (R) 46; Other (OTH) 1; Undecided (UND) 5',
           'margin': 2, 'adjusted_margin': 2.1, 'source_url': 'https://example.test/fictional',
           'source_grade': 'A', 'licence': 'Synthetic fixture only'}
    row.update(changes)
    return row


class ResponseLabelsTests(unittest.TestCase):
    def test_blank_explicit_other_category_stays_other_and_preserves_source(self):
        result = update.parse_figures('Alex (D) 50; Blair (R) 43;  (OTH) 7')
        self.assertEqual(result[-1]['name'], 'Other (source OTH category)')
        self.assertEqual(result[-1]['value'], 7)
        self.assertFalse(result[-1]['originalName'].strip())
    def test_unnamed_candidate_and_conflicting_duplicate_response_reject(self):
        for raw in ['Alex (D) 40; Alex (D) 60', '  (D) 50; Blair (R) 50']:
            with self.assertRaises(ValueError): update.parse_figures(raw)

class AnalysisTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Reuse the actual admitted forecast register, not a second hardcoded copy
        # of all expected contest IDs. Poll observations in unit cases are synthetic.
        cls.catalog = json.loads((APP / 'data.json').read_text(encoding='utf-8-sig'))
        admitted = json.loads((APP / 'analysis.json').read_text(encoding='utf-8'))
        cls.admitted = admitted
        cls.bundles = {}
        for dataset, kind in [('house', 'House'), ('senate', 'Senate'), ('governors', 'Governor')]:
            rows = [r['forecast']['sourceRecord'] for r in admitted['races'].values() if r['forecast']['sourceRecord']['kind'] == kind]
            cls.bundles[dataset] = {'dataset': dataset, 'rows': rows, 'count': len(rows), 'asOf': '2026-11-02', 'licence': 'CC BY 4.0', 'attribution': 'Polling Forecast'}
        cls.bundles['polls'] = {'dataset': 'polls', 'rows': [synthetic_poll()], 'count': 1, 'asOf': '2026-11-02', 'licence': 'Synthetic fixture only'}

    def build(self, bundles=None):
        return update.build_analysis(bundles or copy.deepcopy(self.bundles), self.catalog, retrieved_at='2026-11-03T19:00:00Z', include_atlas=False)

    def test_checked_national_corrections_supersede_compilation_without_duplicate(self):
        national = {'genericPolls': [copy.deepcopy(next(p for p in self.admitted['national']['genericPolls'] if p['pollster'] == 'Pew Research Center' and p['endDate'] == '2026-10-04'))]}
        national['genericPolls'][0].update(startDate='2026-09-30', partisan='R')
        update.integrate_checked_national(national, self.catalog)
        pew = [p for p in national['genericPolls'] if p['pollster'] == 'Pew Research Center' and p['endDate'] == '2026-10-04']
        self.assertEqual(len(pew), 1)
        self.assertEqual(pew[0]['startDate'], '2026-09-28')
        self.assertIsNone(pew[0]['partisan'])
        self.assertEqual(pew[0]['compilationSource']['startDate'], '2026-09-30')
        self.assertEqual(pew[0]['figures'][-2]['value'], 5)

    def test_rounding_unknowns_and_distinct_categories_survive(self):
        figures = update.parse_figures('One (D) 50; Two (R) 48; Other (OTH) 1; Undecided (UND) 2; No response (SKIP) 1')
        self.assertEqual(sum(f['value'] for f in figures), 102)
        poll = update.normalized_poll(synthetic_poll(fieldwork_start=None, sample=1000.5))
        self.assertIsNone(poll['startDate'])
        self.assertEqual(poll['sample'], 1000.5)
        self.assertEqual(poll['license'], 'Synthetic fixture only')

    def test_invalid_numeric_fields_and_executable_urls_fail(self):
        for raw in ['One (D) NaN', 'One (D) 101', 'One (D) -1', 'One (D) .']:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                update.parse_figures(raw)
        for value in [0, -1, float('inf'), '1000']:
            with self.subTest(sample=value), self.assertRaises(ValueError):
                update.normalized_poll(synthetic_poll(sample=value))
        with self.assertRaises(ValueError):
            update.normalized_poll(synthetic_poll(source_url='javascript:alert(1)'))
        for value in ['https://@example.test', 'https://bad host.test']:
            self.assertFalse(update.safe_url(value))
        with self.assertRaises(ValueError):
            update.day('2026-10-01garbage')

    def test_canonical_ids_preserve_special_and_at_large(self):
        self.assertEqual(update.catalog_id({'kind': 'House', 'key': 'AK-00'}), 'AK-H-00')
        self.assertEqual(update.catalog_id({'kind': 'Senate', 'key': 'OH-S'}), 'OH-S-special')
        self.assertEqual(update.catalog_id({'kind': 'Senate', 'key': 'MI'}), 'MI-S-regular')
        self.assertEqual(update.catalog_id({'kind': 'Governor', 'key': 'G-MI'}), 'MI-G')

    def test_full_register_and_source_probability_are_preserved(self):
        bundles = copy.deepcopy(self.bundles)
        source = next(r for r in bundles['senate']['rows'] if r['key'] == 'MI')
        # Explicit synthetic sentinels keep this contract test independent of
        # a real publisher probability changing on a later scheduled refresh.
        source.update(chance_left=.321, polls_used=123)
        result = self.build(bundles)
        self.assertEqual(len(result['races']), 506)
        mi = result['races']['MI-S-regular']
        self.assertEqual(mi['forecast']['chanceLeft'], .321)
        self.assertEqual(mi['forecast']['pollsUsed'], 123)
        self.assertEqual(len(mi['polls']), 1)
        self.assertNotIn('chanceR', mi['forecast'])
        self.assertAlmostEqual(mi['forecast']['chanceRightModeledPair'], .679)
        self.assertEqual(len(result['coverage']['supplementaryForecastUnavailable']), 8)

    def test_equal_count_wrong_governor_and_duplicate_forecast_fail(self):
        for change in ['wrong-state', 'duplicate']:
            bundles = copy.deepcopy(self.bundles)
            rows = bundles['governors']['rows']
            if change == 'wrong-state':
                target = next(r for r in rows if r['key'] == 'G-AL')
                target.update(key='G-DE', state='DE')
            else:
                rows[0] = copy.deepcopy(rows[1])
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.build(bundles)

    def test_primary_and_wrong_general_candidate_never_contaminate_current_polling(self):
        bundles = copy.deepcopy(self.bundles)
        bundles['polls']['rows'] += [synthetic_poll(poll_id=90000002, stage='primary_D'),
            synthetic_poll(poll_id=90000003, figures='Haley Stevens (D) 52; Mike Rogers (R) 42')]
        bundles['polls']['count'] = 3
        result = self.build(bundles)
        self.assertEqual([p['id'] for p in result['races']['MI-S-regular']['polls']], ['90000001'])
        self.assertEqual(result['coverage']['excludedPollReasons'], {'not-general-election': 1, 'candidate-field-mismatch': 1})

    def test_null_rows_and_incoherent_as_of_fail_entire_candidate(self):
        for poisoned in ['null-source-row', 'different-date']:
            bundles = copy.deepcopy(self.bundles)
            if poisoned == 'null-source-row':
                bundles['polls']['rows'] = [None]
            else:
                bundles['polls']['asOf'] = '2026-11-03'
            with self.subTest(poisoned=poisoned), self.assertRaises(ValueError):
                self.build(bundles)

    def test_source_row_bad_link_or_reversed_date_is_quarantined_not_silently_repaired(self):
        bundles = copy.deepcopy(self.bundles)
        bundles['polls']['rows'] += [synthetic_poll(poll_id=90000002, source_url='source-id-only'),
            synthetic_poll(poll_id=90000003, fieldwork_start='2026-10-04')]
        bundles['polls']['count'] = 3
        result = self.build(bundles)
        self.assertEqual(result['coverage']['racePollsAdmitted'], 1)
        self.assertEqual(result['coverage']['excludedPollReasons'], {'unusable-source-url': 1, 'unusable-field-period': 1})

    def test_concord_original_correction_keeps_transcribed_evidence(self):
        poll = update.normalized_poll(synthetic_poll(poll_id=1001336, source_url='https://concordpublicopinionpartners.org/blog/michigan-ge-2026', fieldwork_start='2026-10-31', fieldwork_end='2026-11-01', figures='Abdul El-Sayed (D) 51; Mike Rogers (R) 41; Other (OTH) 3; Undecided (UND) 5'))
        update.correct_michigan(poll)
        self.assertEqual(poll['startDate'], '2026-10-30')
        self.assertEqual([f['value'] for f in poll['figures']], [51, 41, 4, 4])
        self.assertIn('Other (OTH) 3', poll['rawFigures'])
        self.assertEqual(poll['corrections'][0]['original']['startDate'], '2026-10-31')
        self.assertEqual(poll['sourceGrade'], 'A')  # Never overwrite incoming provenance grade.

    def test_national_history_preserves_published_noncomplements_and_reconstruction(self):
        capture = {'url': 'https://example.test/history', 'tables': [[['header'],
            ['3 Nov', '90%', '242 (218-276)', '83%', '15%', '53 (50-56)', '29', 'D+9.5', 'live'],
            ['22 Sep', '80%', '237 (210-282)', '61%', '30%', '51 (47-55)', '26', 'D+9.9', 'reconstructed']]]}
        rows = update.normalize_history(capture)
        self.assertTrue(rows[0]['reconstructed'])
        self.assertFalse(rows[1]['reconstructed'])
        self.assertEqual(rows[1]['senateDChance'], .83)
        self.assertEqual(rows[1]['senateRChance'], .15)
        self.assertEqual(rows[1]['houseLow80'], 218)

    def test_failed_refresh_preserves_last_good_file_byte_for_byte(self):
        scratch = APP / 'work' / 'test-temp'
        scratch.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as directory:
            self.assertTrue(Path(directory).resolve().is_relative_to(scratch.resolve()))
            output = Path(directory) / 'analysis.json'
            payload = json.dumps(self.admitted).encode('utf-8')
            output.write_bytes(payload)
            with patch.object(update, 'urlopen', side_effect=OSError('synthetic fetch failure')), contextlib.redirect_stderr(io.StringIO()):
                code = update.main(['--source-dir', directory, '--fetch', '--output', str(output)])
            self.assertEqual(code, 1)
            self.assertEqual(output.read_bytes(), payload)

    def test_identity_ignores_returns_and_version_but_catches_candidate_corrections(self):
        changed = copy.deepcopy(self.catalog)
        original = update.catalog_identity(changed)
        changed.update(version='synthetic-next-version', generatedAt='2027-01-01T00:00:00Z', snapshotId='synthetic-results-correction')
        changed['races'][0]['results']['votes'] = [{'candidateId': 'synthetic', 'votes': 50}]
        self.assertEqual(update.catalog_identity(changed), original)
        changed['races'][0]['candidates'][0]['name'] += ' changed'
        self.assertNotEqual(update.catalog_identity(changed), original)

    def test_missing_capture_retains_original_dated_history_not_new_retrieval(self):
        result = self.build()
        self.assertTrue(update.retain_national(result, self.admitted, self.catalog))
        self.assertEqual(len(result['national']['history']), 44)
        self.assertEqual(result['national']['summary'], self.admitted['national']['summary'])
        self.assertEqual(result['source']['nationalHistory']['retrievedAt'], self.admitted['source']['nationalHistory']['retrievedAt'])
        self.assertEqual(result['source']['nationalHistory']['status'], 'retained')
        changed = copy.deepcopy(self.catalog)
        changed['races'][0]['candidates'][0]['name'] += ' changed'
        self.assertFalse(update.retain_national(self.build(), self.admitted, changed))

    def test_allow_stale_reports_failure_without_mutating_last_good(self):
        scratch = APP / 'work' / 'test-temp'
        scratch.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as directory:
            self.assertTrue(Path(directory).resolve().is_relative_to(scratch.resolve()))
            output = Path(directory) / 'analysis.json'
            catalog = Path(directory) / 'catalog.json'
            payload = json.dumps(self.admitted).encode('utf-8')
            output.write_bytes(payload)
            catalog.write_text(json.dumps(self.catalog), encoding='utf-8')
            stream = io.StringIO()
            with patch.object(update, 'urlopen', side_effect=OSError('synthetic fetch failure')), contextlib.redirect_stdout(stream):
                code = update.main(['--source-dir', directory, '--fetch', '--allow-stale', '--catalog', str(catalog), '--output', str(output)])
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(stream.getvalue())['updateHealth']['status'], 'retained')
            self.assertEqual(output.read_bytes(), payload)
            changed = copy.deepcopy(self.catalog)
            changed['races'][0]['candidates'][0]['name'] += ' changed'
            catalog.write_text(json.dumps(changed), encoding='utf-8')
            with patch.object(update, 'urlopen', side_effect=OSError('synthetic fetch failure')), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(update.main(['--source-dir', directory, '--fetch', '--allow-stale', '--catalog', str(catalog), '--output', str(output)]), 1)

    def test_fresh_checkout_fetch_without_work_capture_preserves_all_history(self):
        scratch = APP / 'work' / 'test-temp'
        scratch.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as directory:
            self.assertTrue(Path(directory).resolve().is_relative_to(scratch.resolve()))
            output = Path(directory) / 'analysis.json'
            catalog = Path(directory) / 'catalog.json'
            output.write_text(json.dumps(self.admitted), encoding='utf-8')
            changed_returns = copy.deepcopy(self.catalog)
            changed_returns['generatedAt'] = '2026-11-04T00:00:00Z'
            changed_returns['races'][0]['results']['votes'] = [{'candidateId': 'synthetic', 'votes': 50}]
            catalog.write_text(json.dumps(changed_returns), encoding='utf-8')
            responses = [io.BytesIO(json.dumps(self.bundles[k]).encode('utf-8')) for k in ['house', 'senate', 'governors', 'polls']]
            with patch.object(update, 'urlopen', side_effect=responses), contextlib.redirect_stdout(io.StringIO()):
                code = update.main(['--source-dir', directory, '--fetch', '--catalog', str(catalog), '--output', str(output)])
            self.assertEqual(code, 0)
            new = json.loads(output.read_text(encoding='utf-8'))
            self.assertEqual(new['national']['history'], self.admitted['national']['history'])
            self.assertEqual(new['national']['summary'], self.admitted['national']['summary'])
            self.assertEqual(new['updateHealth']['nationalHistoryStatus'], 'retained')
            self.assertEqual(new['source']['nationalHistory']['retrievedAt'], self.admitted['source']['nationalHistory']['retrievedAt'])

    def test_original_atlas_precision_replaces_compilation_without_duplicate_observations(self):
        result = update.build_analysis(copy.deepcopy(self.bundles), self.catalog, retrieved_at='2026-11-03T19:00:00Z')
        mi = next(p for p in result['races']['MI-S-regular']['polls'] if p['pollsterCode'] == 'ATLASINTEL')
        self.assertEqual([f['value'] for f in mi['figures']], [53.5, 46.4, .1, 0])
        self.assertEqual(mi['sample'], 1316)
        self.assertEqual(mi['confirmation']['page'], 10)
        self.assertEqual(len(mi['confirmation']['pdfSha256']), 64)
        self.assertEqual(result['races']['MI-S-regular']['forecast']['pollAverage'], next(r for r in self.bundles['senate']['rows'] if r['key'] == 'MI')['poll_average'])
        atlas = [p for race in result['races'].values() for key in ['polls', 'unmatchedPolls'] for p in race.get(key, []) if p['pollsterCode'] == 'ATLASINTEL']
        self.assertEqual(len(atlas), 19)
        self.assertEqual(len({p['id'] for p in atlas}), 19)

    def test_atlas_whole_alaska_fields_and_denominators_stay_distinct_from_rcv_final(self):
        result = update.build_analysis(copy.deepcopy(self.bundles), self.catalog, retrieved_at='2026-11-03T19:00:00Z')
        senate = result['races']['AK-S-regular']['unmatchedPolls'][0]
        self.assertEqual([(f['name'], f['value']) for f in senate['figures'] if 'Sullivan' in f['name']], [('Dan S. Sullivan', 44.6), ('Dan J. Sullivan', .6)])
        self.assertIn('not a simulated RCV final round', senate['round'])
        self.assertIn('subgroup N not supplied', senate['denominator'])
        house = result['races']['AK-H-00']['unmatchedPolls'][0]
        self.assertEqual(house['figures'][0], {'name': 'Bill Hill', 'party': 'I', 'sourceParty': 'I', 'value': 46.6})
        self.assertEqual(house['sample'], 522)
        self.assertEqual(len(house['figures']), 5)
        governor = result['races']['AK-G']['unmatchedPolls'][0]
        self.assertIn('not a simulated RCV final round', governor['round'])

    def test_original_atlas_national_generic_is_free_original_likely_voter_topline(self):
        result = update.build_analysis(copy.deepcopy(self.bundles), self.catalog, retrieved_at='2026-11-03T19:00:00Z')
        poll = next(p for p in result['national']['genericPolls'] if p['pollsterCode'] == 'ATLASINTEL')
        self.assertEqual([f['value'] for f in poll['figures']], [55.5, 41.4, 2.3, .8])
        self.assertEqual((poll['sample'], poll['population']), (3566, 'LV'))
        self.assertEqual(poll['confirmation']['page'], 15)
        self.assertEqual(poll['interval']['confidenceLevel'], 95)

    def test_maine_original_field_uses_evidenced_alias_and_preserves_middle_initial_distinctions(self):
        candidates = [{'name': 'Rick Bennett', 'aliases': ['Richard Bennett']}, {'name': 'Dan S. Sullivan'}]
        self.assertTrue(update.primary_name_matches('Richard Bennett', candidates))
        self.assertFalse(update.primary_name_matches('Dan J. Sullivan', candidates))
        self.assertFalse(update.primary_name_matches('Dan Sullivan', candidates))
        result = update.build_analysis(copy.deepcopy(self.bundles), self.catalog, retrieved_at='2026-11-03T19:00:00Z')
        poll = next(p for p in result['races']['ME-G']['polls'] if p['pollsterCode'] == 'ATLASINTEL')
        self.assertTrue(poll['candidateFieldMatch'])
        self.assertEqual(next(f['value'] for f in poll['figures'] if f['name'] == 'Richard Bennett'), 5.2)


if __name__ == '__main__':
    unittest.main()
