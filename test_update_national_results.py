"""Synthetic fixtures for national publisher counts; no live-data claim."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import update_national_results as national


def race(office="house", state="AZ", district=1, kind="regular", stage="general"):
    return {"id": f"{state}-{office}-{kind}", "state": state, "office": office, "district": district,
            "kind": kind, "stage": stage, "electionDate": "2026-11-03",
            "candidates": [{"id": "a", "name": "Alex Example", "party": "D"},
                           {"id": "b", "name": "Blair Example", "party": "R"}],
            "results": {"available": False, "votes": [], "asOf": None, "call": None, "certification": None}}


def snapshot(office="house", state="AZ", district=1, kind="regular", stage="general"):
    return {"schemaVersion": 1, "races": [race(office, state, district, kind, stage)]}


def payload(office="house", key="az-01", count=100, time="2026-11-04T05:00:00Z"):
    _, _, name, election_type = national.CONFIG[office]
    return {"election_name": name, "election_type": election_type, "country": "US", "election_scope": "General",
            "test_data": False, "election_date": "2026-11-03T05:00:00.000Z", "last_updated": time,
            "region_results": {key: {"name": "Synthetic region", "election_id": 123,
                "percent_reporting": 1, "candidates": [
                    {"candidate_id": 1, "name": "Alex Example", "party": "Democratic", "votes": count, "winner": True},
                    {"candidate_id": 2, "name": "Blair Example", "party": "Republican", "votes": 60 if count else 0, "winner": False}]}}}


def run(previous, data, office="house", reviews=None):
    body = json.dumps(data).encode()
    return national.update_national(previous, lambda *_: (body, {"bytes": len(body)}),
                                    "2026-11-04T05:08:01Z", reviews, [office])


class NationalTests(unittest.TestCase):
    def test_valid_counts_no_call_and_public_attribution(self):
        prior_sources, prior_parsers = dict(national.shared.SOURCES), dict(national.shared.PARSERS)
        result = run(snapshot(), payload())
        returns = result["races"][0]["results"]
        self.assertTrue(returns["available"])
        self.assertEqual(returns["votes"][0]["votes"], 100)
        self.assertIsNone(returns["call"])
        self.assertIsNone(returns["certification"])
        self.assertEqual(returns["sourceId"], "civicapi-house")
        self.assertEqual(result["resultHealth"]["civicapi-house"]["coverage"]["admittedRaceCount"], 1)
        self.assertEqual(national.shared.SOURCES, prior_sources)
        self.assertEqual(national.shared.PARSERS, prior_parsers)

    def test_all_zero_stays_unreported(self):
        result = run(snapshot(), payload(count=0))
        self.assertFalse(result["races"][0]["results"]["available"])
        self.assertEqual(result["races"][0]["results"]["votes"], [])
        self.assertEqual(result["resultHealth"]["civicapi-house"]["status"], "unreported")
        source = result["nationalResultRecords"][result["races"][0]["id"]]
        self.assertFalse(source["reported"])
        self.assertEqual(source["matchStatus"], "exact-candidate-match")
        self.assertEqual(source["candidates"][0]["votes"], 0)
        self.assertTrue(national.validate_national_records(result))

    def test_wrong_test_office_election_or_malformed_rejected(self):
        for key, value in (("test_data", True), ("test_data", None), ("election_name", "Wrong Office"),
                           ("election_date", "2026-08-04T05:00:00Z"), ("election_scope", "Primary"), ("country", "CA")):
            data = payload()
            data[key] = value
            with self.assertRaises(national.shared.InvalidResults):
                national.parse_component(json.dumps(data).encode(), snapshot(), "house")
        with self.assertRaises(national.shared.InvalidResults):
            national.parse_component(b'{"broken":', snapshot(), "house")

    def test_negative_boolean_fractional_and_duplicate_choice_rejected(self):
        for value in (-1, True, 1.5):
            data = payload()
            data["region_results"]["az-01"]["candidates"][0]["votes"] = value
            with self.assertRaises(national.shared.InvalidResults):
                national.parse_component(json.dumps(data).encode(), snapshot(), "house")
        data = payload()
        data["region_results"]["az-01"]["candidates"][1]["candidate_id"] = "1"
        with self.assertRaises(national.shared.InvalidResults):
            national.parse_component(json.dumps(data).encode(), snapshot(), "house")

    def test_duplicate_json_region_and_contest_rejected(self):
        data = payload()
        data["region_results"]["az-02"] = copy.deepcopy(data["region_results"]["az-01"])
        with self.assertRaises(national.shared.InvalidResults):
            national.parse_component(json.dumps(data).encode(), snapshot(), "house")
        with self.assertRaises(national.shared.InvalidResults):
            national.parse_component(b'{"test_data":false,"test_data":false}', snapshot(), "house")

    def test_at_large_special_and_stage_do_not_collapse(self):
        self.assertIsNotNone(national.ledger_match(snapshot(state="AK", district=0), "house", "ak-al")[0])
        special = snapshot("senate", "FL", None, "special")
        result = run(special, payload("senate", "fl"), "senate")
        self.assertTrue(result["races"][0]["results"]["available"])
        self.assertEqual(result["races"][0]["kind"], "special")
        louisiana = snapshot("house", "LA", 1, stage="primary")
        held = run(louisiana, payload(key="la-01"))
        self.assertFalse(held["races"][0]["results"]["available"])
        self.assertEqual(len(held["resultHealth"]["civicapi-house"]["coverage"]["identityConflicts"]), 1)
        record = held["nationalResultRecords"][louisiana["races"][0]["id"]]
        self.assertEqual((record["stage"], record["catalogStage"], record["matchStatus"]), ("general", "primary", "stage-conflict"))
        self.assertTrue(record["reported"])

    def test_nominee_conflicts_visible_even_before_reporting(self):
        data = payload(count=0)
        data["region_results"]["az-01"]["candidates"][0]["name"] = "Different Alex"
        result = run(snapshot(), data)
        conflicts = result["resultHealth"]["civicapi-house"]["coverage"]["nomineeConflicts"]
        self.assertEqual(conflicts[0]["missingCatalogCandidateIds"], ["a"])
        self.assertEqual(conflicts[0]["unmatchedSourceCandidates"][0]["name"], "Different Alex")
        self.assertEqual(result["resultHealth"]["civicapi-house"]["status"], "unreported")

    def test_positive_unmatched_quarantines_and_explicit_alias_is_allowed(self):
        data = payload()
        data["region_results"]["az-01"]["candidates"][0]["name"] = "Alex A. Example"
        result = run(snapshot(), data)
        self.assertEqual(result["resultHealth"]["civicapi-house"]["status"], "quarantined")
        allowed = snapshot()
        allowed["races"][0]["candidates"][0]["ballotName"] = "Alex A. Example"
        self.assertTrue(run(allowed, data)["races"][0]["results"]["available"])

    def test_existing_official_counts_are_not_replaced(self):
        previous = snapshot()
        previous["races"][0]["results"] = {"available": True, "sourceId": "az-official", "votes": [
            {"candidateId": "a", "votes": 90}, {"candidateId": "b", "votes": 60}]}
        result = run(previous, payload())
        self.assertEqual(result["races"][0]["results"], previous["races"][0]["results"])
        self.assertEqual(result["resultHealth"]["civicapi-house"]["status"], "quarantined")

    def test_successive_corrections_and_older_clock_review(self):
        current = snapshot()
        for count, minute in ((100, "00"), (90, "02"), (80, "04")):
            current = run(current, payload(count=count, time=f"2026-11-04T05:{minute}:00Z"))
        result = current["races"][0]["results"]
        self.assertEqual([(entry["previousVotes"][0]["votes"], entry["newVotes"][0]["votes"])
                          for entry in result["correctionHistory"]], [(100, 90), (90, 80)])
        older_data = payload(count=100, time="2026-11-04T04:30:00Z")
        older = run(current, older_data)
        self.assertEqual(older["races"][0]["results"], result)
        self.assertTrue(older["resultHealth"]["civicapi-house"]["reviewRequired"])
        review = {"sourceId": "civicapi-house", "previousSourceAsOf": "2026-11-04T05:04:00Z", "incomingSourceAsOf": "2026-11-04T04:30:00Z",
                  "bodySha256": hashlib.sha256(json.dumps(older_data).encode()).hexdigest(), "reason": "Synthetic reviewed revision",
                  "reviewer": "synthetic operator", "reviewedAt": "2026-11-04T05:08:00Z", "evidenceUrl": "https://example.org/fixture"}
        reviewed = run(current, older_data, reviews=[review])
        self.assertEqual(reviewed["races"][0]["results"]["correctionHistory"][-1]["revisionReview"], review)

    def test_unknown_clock_retained_failure_and_empty_update(self):
        current = run(snapshot(), payload(time=None))
        self.assertIsNone(current["races"][0]["results"]["asOf"])
        failed = national.update_national(current, lambda *_: (_ for _ in ()).throw(OSError("synthetic timeout")), offices=["house"])
        self.assertEqual(failed["races"][0]["results"], current["races"][0]["results"])
        self.assertEqual(failed["resultHealth"]["civicapi-house"]["status"], "retained-error")
        empty = run(current, payload(count=0, time=None))
        self.assertEqual(empty["races"][0]["results"]["votes"], current["races"][0]["results"]["votes"])
        self.assertEqual(empty["resultHealth"]["civicapi-house"]["status"], "retained-unreported")

    def test_main_allows_atomic_same_input_output(self):
        scratch = Path.cwd() / "work" / "source-data" / "rebuild-coverage"
        scratch.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as directory:
            path = Path(directory) / "fixture.json"
            path.write_text(json.dumps(snapshot()), encoding="utf-8")
            with patch("sys.argv", ["update_national_results.py", "--input", str(path), "--output", str(path)]), \
                 patch.object(national, "update_national", return_value={**snapshot(), "snapshotId": "fixture", "resultHealth": {
                     item[0]: {"status": "unreported"} for item in national.CONFIG.values()}}):
                national.main()
            self.assertEqual(json.loads(path.read_text())["snapshotId"], "fixture")

    def test_native_nominee_conflict_keeps_source_names_without_catalog_votes(self):
        data = payload()
        data["region_results"]["az-01"]["candidates"][0]["name"] = "Different Alex"
        result = run(snapshot(), data)
        self.assertFalse(result["races"][0]["results"]["available"])
        record = result["nationalResultRecords"][result["races"][0]["id"]]
        self.assertEqual(record["matchStatus"], "nominee-conflict")
        self.assertEqual(record["candidates"][0], {"sourceId": "1", "name": "Different Alex", "party": "Democratic", "votes": 100, "sourceWinnerFlag": True})
        self.assertTrue(record["reported"])
        self.assertNotIn("winner", record["candidates"][0])
        self.assertEqual(result["resultHealth"]["civicapi-house"]["nativeReportedRaceCount"], 1)

    def test_native_successive_corrections_preserve_full_lineage(self):
        current = snapshot()
        for count, minute in ((100, "00"), (90, "02"), (80, "04")):
            data = payload(count=count, time=f"2026-11-04T05:{minute}:00Z")
            data["region_results"]["az-01"]["candidates"][0]["name"] = "Different Alex"
            current = run(current, data)
        record = current["nationalResultRecords"][current["races"][0]["id"]]
        self.assertEqual([(entry["previousCandidates"][0]["votes"], entry["newCandidates"][0]["votes"])
                          for entry in record["correctionHistory"]], [(100, 90), (90, 80)])
        self.assertEqual(record["correction"], record["correctionHistory"][-1])
        self.assertEqual(len(record["correctionHistory"][0]["bodySha256"]), 64)

    def test_native_only_earlier_clock_held_until_exact_review(self):
        data = payload(time="2026-11-04T05:04:00Z")
        data["region_results"]["az-01"]["candidates"][0]["name"] = "Different Alex"
        current = run(snapshot(), data)
        current.pop("resultHealth")  # The source table itself must enforce the guard.
        data["last_updated"] = "2026-11-04T04:30:00Z"
        data["region_results"]["az-01"]["candidates"][0]["votes"] = 90
        held = run(current, data)
        record = held["nationalResultRecords"][current["races"][0]["id"]]
        self.assertEqual((record["asOf"], record["candidates"][0]["votes"]), ("2026-11-04T05:04:00Z", 100))
        self.assertTrue(record["fetchHealth"]["reviewRequired"])
        review = {"sourceId": "civicapi-house", "previousSourceAsOf": "2026-11-04T05:04:00Z", "incomingSourceAsOf": data["last_updated"],
                  "bodySha256": hashlib.sha256(json.dumps(data).encode()).hexdigest(), "reason": "Synthetic reviewed native revision",
                  "reviewer": "synthetic operator", "reviewedAt": "2026-11-04T05:08:00Z", "evidenceUrl": "https://example.org/fixture"}
        for bad in ({**review, "bodySha256": "0" * 64}, {**review, "reason": ""}):
            self.assertTrue(run(current, data, reviews=[bad])["resultHealth"]["civicapi-house"]["reviewRequired"])
        admitted = run(current, data, reviews=[review])
        record = admitted["nationalResultRecords"][current["races"][0]["id"]]
        self.assertEqual(record["candidates"][0]["votes"], 90)
        self.assertEqual(record["correctionHistory"][-1]["revisionReview"], review)

    def test_native_unknown_clock_stays_unknown_and_errors_retain_last_good(self):
        current = run(snapshot(), payload(time=None))
        race_id = current["races"][0]["id"]
        self.assertIsNone(current["nationalResultRecords"][race_id]["asOf"])
        failed = national.update_national(current, lambda *_: (_ for _ in ()).throw(OSError("synthetic timeout")), offices=["house"])
        self.assertEqual(failed["nationalResultRecords"][race_id]["candidates"], current["nationalResultRecords"][race_id]["candidates"])
        self.assertEqual(failed["nationalResultRecords"][race_id]["fetchHealth"]["status"], "retained-error")
        zero = run(current, payload(count=0, time=None))
        self.assertTrue(zero["nationalResultRecords"][race_id]["reported"])
        self.assertEqual(zero["nationalResultRecords"][race_id]["fetchHealth"]["status"], "retained-unreported")

    def test_missing_native_contest_does_not_erase_prior_source_table(self):
        current = run(snapshot(), payload())
        data = payload(time="2026-11-04T05:04:00Z")
        data["region_results"] = {}
        retained = run(current, data)
        record = retained["nationalResultRecords"][current["races"][0]["id"]]
        self.assertEqual(record["candidates"][0]["votes"], 100)
        self.assertEqual(record["fetchHealth"]["status"], "retained-absent")

    def test_unknown_clock_does_not_erase_last_known_review_boundary(self):
        current = run(snapshot(), payload(time="2026-11-04T05:04:00Z"))
        unknown = run(current, payload(count=90, time=None))
        race_id = current["races"][0]["id"]
        record = unknown["nationalResultRecords"][race_id]
        self.assertIsNone(record["asOf"])
        self.assertEqual(record["lastKnownSourceAsOf"], "2026-11-04T05:04:00Z")
        older = run(unknown, payload(count=80, time="2026-11-04T04:30:00Z"))
        self.assertTrue(older["resultHealth"]["civicapi-house"]["reviewRequired"])
        self.assertEqual(older["nationalResultRecords"][race_id]["candidates"][0]["votes"], 90)

    def test_native_candidate_lineup_revision_has_lineage(self):
        current = run(snapshot(), payload())
        data = payload(time="2026-11-04T05:04:00Z")
        data["region_results"]["az-01"]["candidates"][0]["candidate_id"] = 3
        revised = run(current, data)
        record = revised["nationalResultRecords"][current["races"][0]["id"]]
        self.assertEqual(record["correctionHistory"][-1]["previousCandidates"][0]["sourceId"], "1")
        self.assertEqual(record["candidates"][0]["sourceId"], "3")

    def test_additive_detail_link_upgrades_old_record_even_on_fetch_error(self):
        current = run(snapshot(), payload())
        race_id = current["races"][0]["id"]
        old_record = current["nationalResultRecords"][race_id]
        old_record.pop("detailUrl")
        failed = national.update_national(current, lambda *_: (_ for _ in ()).throw(OSError("synthetic timeout")), offices=["house"])
        record = failed["nationalResultRecords"][race_id]
        self.assertEqual(record["detailUrl"], old_record["sourceRaceUrl"])
        self.assertEqual(record["candidates"], old_record["candidates"])

    def test_native_schema_rejects_claimed_reporting_and_bad_identity(self):
        current = run(snapshot(), payload(count=0))
        race_id = current["races"][0]["id"]
        for key, value in (("reported", True), ("asOf", "not a clock"), ("sourceRaceUrl", "https://example.org/"),
                           ("sourceContestId", "../1"), ("bodySha256", "bad"), ("sourceId", "unknown")):
            altered = copy.deepcopy(current)
            altered["nationalResultRecords"][race_id][key] = value
            with self.assertRaises(national.shared.InvalidResults):
                national.validate_national_records(altered)

        for key, value in (("sourceId", "bad/id"), ("votes", "0"), ("party", {})):
            altered = copy.deepcopy(current)
            altered["nationalResultRecords"][race_id]["candidates"][0][key] = value
            with self.assertRaises(national.shared.InvalidResults):
                national.validate_national_records(altered)

    def test_detail_preserves_fips_source_names_and_unknown_remaining_votes(self):
        current = run(snapshot(), payload())
        contest = current["races"][0]
        record = current["nationalResultRecords"][contest["id"]]
        data = payload(count=0)
        data.update(province="AZ", district="AZ-01")
        data["region_results"] = {"maricopa": {"name": "Maricopa", "type": "County", "fips": "04013",
            "percent_reporting": 50, "candidates": [{"name": "Alex Example", "party": "Democratic", "votes": 0, "winner": True}]}}
        detail = national.normalize_detail(json.dumps(data).encode(), contest, record)
        self.assertFalse(detail["reported"])
        self.assertEqual(detail["regions"][0]["fips"], "04013")
        self.assertEqual(detail["geographicScope"], "county portion within this congressional district")
        self.assertEqual(detail["publisherReportingPercent"], None)
        self.assertEqual(detail["regions"][0]["publisherReportingPercent"], 50)
        self.assertIsNone(detail["expectedTotalVotes"])
        self.assertIsNone(detail["remainingVotes"])
        self.assertIsNone(detail["voteMethods"])
        self.assertNotIn("winner", detail["regions"][0]["candidates"][0])

    def test_detail_rejects_wrong_jurisdiction_test_duplicate_fips_or_bad_counts(self):
        current = run(snapshot(), payload())
        contest = current["races"][0]
        record = current["nationalResultRecords"][contest["id"]]
        data = payload(count=0)
        data.update(province="AZ", district="AZ-01")
        data["region_results"] = {"maricopa": {"name": "Maricopa", "type": "County", "fips": "04013",
            "candidates": [{"name": "Alex Example", "party": "Democratic", "votes": 100}]}}
        for key, value in (("province", "NC"), ("district", "AZ-02"), ("test_data", True), ("election_scope", "Primary")):
            altered = copy.deepcopy(data)
            altered[key] = value
            with self.assertRaises(national.shared.InvalidResults):
                national.normalize_detail(json.dumps(altered).encode(), contest, record)
        altered = copy.deepcopy(data)
        altered["region_results"]["duplicate"] = copy.deepcopy(altered["region_results"]["maricopa"])
        with self.assertRaises(national.shared.InvalidResults):
            national.normalize_detail(json.dumps(altered).encode(), contest, record)
        for value in (-1, True, 1.5):
            altered = copy.deepcopy(data)
            altered["region_results"]["maricopa"]["candidates"][0]["votes"] = value
            with self.assertRaises(national.shared.InvalidResults):
                national.normalize_detail(json.dumps(altered).encode(), contest, record)

    def test_detail_governor_observed_statewide_scope_is_explicit(self):
        current = run(snapshot("governor", "AL", None), payload("governor", "al"), "governor")
        contest = current["races"][0]
        data = payload("governor", "al", count=0)
        data.update(province="AL", district=None, election_scope="Statewide")
        data["region_results"] = {}
        detail = national.normalize_detail(json.dumps(data).encode(), contest, current["nationalResultRecords"][contest["id"]])
        self.assertEqual(detail["sourceScope"], "Statewide")
        self.assertEqual(detail["regions"], [])

    def test_source_call_requires_flag_not_lead_and_keeps_observation_not_call_time(self):
        data = payload()
        data["region_results"]["az-01"]["candidates"][0]["winner"] = False
        uncalled = run(snapshot(), data)
        race_id = uncalled["races"][0]["id"]
        self.assertIsNone(uncalled["nationalResultRecords"][race_id]["sourceCall"])
        data["last_updated"] = "2026-11-04T05:02:00Z"
        data["region_results"]["az-01"]["candidates"][0]["winner"] = True
        called = run(uncalled, data)
        record = called["nationalResultRecords"][race_id]
        self.assertEqual(record["sourceCallStatus"], "called")
        self.assertEqual(record["sourceCall"]["candidateSourceId"], "1")
        self.assertEqual(record["sourceCall"]["sourceName"], "civicAPI decision desk")
        self.assertIsNone(record["sourceCall"]["calledAt"])
        self.assertIsNone(record["sourceCall"]["certification"])
        self.assertEqual(record["sourceCall"]["firstObservedAt"], "2026-11-04T05:08:01Z")
        self.assertIsNone(called["races"][0]["results"]["call"])
        repeated = run(called, data)["nationalResultRecords"][race_id]
        self.assertEqual(len(repeated["sourceCallHistory"]), 1)
        self.assertEqual(repeated["sourceCall"]["firstObservedAt"], record["sourceCall"]["firstObservedAt"])

    def test_source_call_retraction_lineage_and_older_clock_hold(self):
        called = run(snapshot(), payload())
        race_id = called["races"][0]["id"]
        correction = payload(count=90, time="2026-11-04T05:02:00Z")
        revised = run(called, correction)
        self.assertEqual(len(revised["nationalResultRecords"][race_id]["sourceCallHistory"]), 1)
        self.assertEqual(len(revised["nationalResultRecords"][race_id]["correctionHistory"]), 1)
        removal = payload(count=80, time="2026-11-04T05:04:00Z")
        removal["region_results"]["az-01"]["candidates"][0]["winner"] = False
        retracted = run(revised, removal)
        record = retracted["nationalResultRecords"][race_id]
        self.assertIsNone(record["sourceCall"])
        self.assertEqual(record["sourceCallStatus"], "retracted")
        self.assertEqual(record["sourceCallHistory"][-1]["action"], "publisher-winner-flag-removed")
        self.assertEqual(len(record["correctionHistory"]), 2)
        held = run(retracted, payload(time="2026-11-04T04:30:00Z"))
        self.assertIsNone(held["nationalResultRecords"][race_id]["sourceCall"])
        self.assertTrue(held["resultHealth"]["civicapi-house"]["reviewRequired"])

    def test_missing_flag_or_unknown_clock_does_not_retract_a_call(self):
        current = run(snapshot(), payload())
        race_id = current["races"][0]["id"]
        missing = payload(time="2026-11-04T05:02:00Z")
        missing["region_results"]["az-01"]["candidates"][0].pop("winner")
        retained = run(current, missing)["nationalResultRecords"][race_id]
        self.assertEqual(retained["sourceCallStatus"], "retained-unknown")
        self.assertEqual(retained["sourceCall"], current["nationalResultRecords"][race_id]["sourceCall"])
        unknown = payload(time=None)
        unknown["region_results"]["az-01"]["candidates"][0]["winner"] = False
        retained = run(current, unknown)["nationalResultRecords"][race_id]
        self.assertEqual(retained["sourceCallStatus"], "retained-unknown-source-clock")
        self.assertEqual(len(retained["sourceCallHistory"]), 1)

    def test_stage_zero_old_clock_and_ambiguous_flags_cannot_create_call(self):
        for previous, data in ((snapshot(stage="primary"), payload()), (snapshot(), payload(count=0)),
                               (snapshot(), payload(time="2026-10-23T15:00:00Z"))):
            result = run(previous, data)
            record = result["nationalResultRecords"][previous["races"][0]["id"]]
            self.assertIsNone(record["sourceCall"])
        data = payload()
        data["region_results"]["az-01"]["candidates"][1]["winner"] = True
        result = run(snapshot(), data)
        self.assertIn("Multiple winner flags", result["resultHealth"]["civicapi-house"]["error"])
        self.assertEqual(result["nationalResultRecords"], {})

    def test_county_propagated_winner_is_never_a_county_or_contest_call(self):
        data = payload()
        data["region_results"]["az-01"]["candidates"][0]["winner"] = False
        current = run(snapshot(), data)
        contest = current["races"][0]
        detail_data = payload()
        detail_data.update(province="AZ", district="AZ-01")
        detail_data["region_results"] = {"maricopa": {"name": "Maricopa", "type": "County", "fips": "04013",
            "candidates": [{"name": "Alex Example", "party": "Democratic", "votes": 192, "winner": True},
                           {"name": "Blair Example", "party": "Republican", "votes": 699, "winner": False}]}}
        detail = national.normalize_detail(json.dumps(detail_data).encode(), contest, current["nationalResultRecords"][contest["id"]])
        self.assertNotIn("sourceCall", detail)
        self.assertNotIn("winner", detail["regions"][0]["candidates"][0])
        self.assertIsNone(current["nationalResultRecords"][contest["id"]]["sourceCall"])

if __name__ == "__main__":
    unittest.main()
