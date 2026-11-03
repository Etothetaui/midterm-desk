"""Coordinated publication tests; all loaders/runners are synthetic."""

import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import update_pipeline as pipeline
import update_results as shared
import test_update_results as fixtures
import test_update_vote_methods as method_fixtures
import test_update_national_results as national_fixtures


def catalog():
    result = fixtures.catalog()
    nc = fixtures.catalog("NC")["races"][0]
    nc["id"] = "nc-fixture"
    result["races"].append(nc)
    return result


def fake_loader(calls):
    def load(source_id, previous):
        calls.append(source_id)
        if source_id == "az-official": return json.dumps(method_fixtures.az_body()).encode(), {}
        if source_id == "nc-official": return fixtures.nc_zip(), {}
        if source_id == "deepsyte-results": raise OSError("synthetic unavailable diagnostic")
        office = source_id.removeprefix("civicapi-")
        data = national_fixtures.payload(office, {"house":"az-01", "senate":"nc", "governor":"al"}[office], count=0)
        return json.dumps(data).encode(), {}
    return load


class PipelineTests(unittest.TestCase):
    def test_ap_stage_cannot_change_any_existing_source_and_process_failure_retains_observations(self):
        original = catalog()
        original['apPublicSource'] = {'observations': {'synthetic': {'status': 'called'}}, 'checkedAt': None,
                                     'errorCode': 'rate-limited', 'retryAfterAt': '2026-11-04T06:00:00Z'}
        def substituted(args, **kwargs):
            value = json.loads(Path(args[-2]).read_text(encoding='utf-8'))
            value['races'] = []
            Path(args[-1]).write_text(json.dumps(value), encoding='utf-8')
            return SimpleNamespace(returncode=0)
        for runner in [substituted, lambda *a, **k: (_ for _ in ()).throw(OSError('synthetic offline'))]:
            result = pipeline.refresh_ap(original, runner=runner)
            self.assertEqual(result['races'], original['races'])
            self.assertEqual(result['apPublicSource']['observations'], original['apPublicSource']['observations'])
            self.assertEqual(result['apPublicSource']['status'], 'retained-error')
            self.assertIsNone(result['apPublicSource']['retryAfterAt'])
            self.assertNotIn('status', original['apPublicSource'])

    def test_ap_stage_runs_after_count_validation_and_before_analysis(self):
        seen = []
        def ap_stage(value):
            self.assertIn('nationalResultRecords', value)
            seen.append('ap')
            return {**value, 'apPublicSource': {'synthetic': True}}
        result = pipeline.run_pipeline(catalog(), fake_loader([]), ap_refresher=ap_stage,
                                       analysis_refresher=lambda value: seen.append(('analysis', value['apPublicSource'])))
        self.assertEqual(seen, ['ap', ('analysis', {'synthetic': True})])
        self.assertEqual(result['apPublicSource'], {'synthetic': True})

    def test_real_stage_order_one_fetch_each_and_diagnostic_failure_does_not_abort(self):
        calls, analytics = [], []
        original = catalog()
        output = pipeline.run_pipeline(original, fake_loader(calls), checked_at="2026-11-04T05:08:00Z",
                                       analysis_refresher=lambda result: analytics.append(result["snapshotId"]))
        self.assertEqual(calls, ["az-official", "nc-official", "deepsyte-results", "civicapi-house", "civicapi-senate", "civicapi-governor"])
        self.assertEqual(analytics, [output["snapshotId"]])
        self.assertEqual(output["races"][0]["results"]["voteMethods"]["rows"][0][-1], 20)
        self.assertEqual(output["races"][1]["results"]["voteMethods"]["rows"][0][-1], 20)
        self.assertIn("synthetic unavailable", output["resultHealth"]["deepsyte-results"]["error"])
        self.assertFalse(output["nationalResultRecords"]["fixture-race"]["reported"])
        self.assertFalse(original["races"][0]["results"]["available"])

    def test_all_source_failures_retain_prior_counts_methods_and_native_records(self):
        current = pipeline.run_pipeline(catalog(), fake_loader([]))
        previous = copy.deepcopy(current)
        output = pipeline.run_pipeline(current, lambda *_: (_ for _ in ()).throw(OSError("synthetic offline")))
        self.assertEqual(output["races"], current["races"])
        self.assertEqual(output["nationalResultRecords"]["fixture-race"]["candidates"], current["nationalResultRecords"]["fixture-race"]["candidates"])
        self.assertEqual(output["resultHealth"]["az-official"]["status"], "retained-error")
        self.assertEqual(current, previous)

    def test_reviews_forwarded_to_all_result_stages_and_analytics_runs_last(self):
        seen = []
        reviews = [{"synthetic": "operator review"}]
        def official(value, loader, checked, supplied, sources):
            seen.append(("official", supplied, checked)); return value
        def diagnostic(value, sources, loader, checked, supplied):
            seen.append(("diagnostic", supplied, checked)); return value
        def national(value, loader, checked, supplied):
            seen.append(("national", supplied, checked)); return value
        with patch.object(pipeline, "update_vote_methods", official), patch.object(pipeline.shared, "update", diagnostic), patch.object(pipeline, "update_national", national):
            pipeline.run_pipeline(catalog(), reviewed_revisions=reviews, checked_at="2026-11-04T05:08:00Z", analysis_refresher=lambda _: seen.append(("analysis", reviews, "2026-11-04T05:08:00Z")))
        self.assertEqual([row[0] for row in seen], ["official", "diagnostic", "national", "analysis"])
        self.assertTrue(all(row[1] is reviews for row in seen))
        calls=[]
        pipeline.run_pipeline(catalog(), fake_loader(calls), include_diagnostic=False)
        self.assertNotIn("deepsyte-results", calls)

    def test_probe_analysis_and_health_are_isolated_and_failure_retains_seed_bytes(self):
        scratch = Path(__file__).resolve().parent / "work" / "test-temp"
        scratch.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as directory:
            root=Path(directory); original=b'{"synthetic-seed":true}\n'
            (root/"analysis.json").write_bytes(original)
            (root/"data.json").write_text(json.dumps(catalog()),encoding="utf-8")
            def runner(args, **kwargs):
                staged = json.loads(Path(args[args.index("--catalog")+1]).read_text(encoding="utf-8"))
                self.assertIn("nationalResultRecords",staged)
                return SimpleNamespace(returncode=1, stdout="", stderr=json.dumps({"updateHealth":{"status":"retained","checkedAt":"2026-11-04T05:00:00Z"}}))
            target=root/"probe.json"
            with patch.object(pipeline,"ROOT",root),patch.object(pipeline,"usable_previous",return_value=True):
                output=pipeline.run_cli_pipeline(catalog(),target,input_path=root/"data.json",probe=True,loader=fake_loader([]),analysis_runner=runner)
                self.assertIn("snapshotId",output)
                self.assertEqual((root/"analysis.json").read_bytes(),original)
                self.assertEqual((root/"probe.json.analysis.json").read_bytes(),original)
                self.assertEqual(json.loads((root/"probe.json.analysis-health.json").read_text())["status"],"retained")
                with self.assertRaises(shared.InvalidResults):
                    pipeline.run_cli_pipeline(catalog(),root/"data.json",input_path=root/"data.json",probe=True,loader=fake_loader([]))

    def test_unusable_analysis_failure_fails_closed_and_emits_error_health(self):
        scratch = Path(__file__).resolve().parent / "work" / "test-temp"
        scratch.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as directory:
            root=Path(directory)
            with patch.object(pipeline,"usable_previous",return_value=False):
                with self.assertRaises(shared.InvalidResults):
                    pipeline.refresh_analysis(catalog(),root/"analysis.json",root/"health.json",runner=lambda *a,**k: (_ for _ in ()).throw(OSError("synthetic missing process")))
            self.assertEqual(json.loads((root/"health.json").read_text())["status"],"error")

    def test_core_cli_default_pipeline_and_explicit_sources_stay_narrow(self):
        scratch = Path(__file__).resolve().parent / "work" / "test-temp"
        scratch.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as directory:
            root=Path(directory); source=root/"in.json"; target=root/"out.json"
            source.write_text(json.dumps(catalog()),encoding="utf-8")
            result={**catalog(),"snapshotId":"synthetic-pipeline","resultHealth":{}}
            with patch("sys.argv",["update_results.py","--input",str(source),"--output",str(target)]),patch.object(pipeline,"run_cli_pipeline",return_value=result) as full,patch.object(shared,"update") as narrow,contextlib.redirect_stdout(io.StringIO()):
                shared.main();full.assert_called_once();narrow.assert_not_called()
            with patch("sys.argv",["update_results.py","--input",str(source),"--output",str(target),"--sources","nc-official"]),patch.object(pipeline,"run_cli_pipeline") as full,patch.object(shared,"update",return_value=result) as narrow,contextlib.redirect_stdout(io.StringIO()):
                shared.main();full.assert_not_called();self.assertEqual(narrow.call_args.args[1],["nc-official"])
            with patch("sys.argv",["update_results.py","--input",str(source),"--probe",str(source)]),contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):shared.main()
            self.assertEqual(json.loads(source.read_text()),catalog())


if __name__ == "__main__":
    unittest.main()
