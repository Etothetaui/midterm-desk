"""Synthetic adapter fixtures only; not evidence of real election counts."""

import copy
import csv
import io
import json
import unittest
import zipfile

import update_results as adapter


def catalog(state="AZ", office="house", district=1):
    return {"schemaVersion": 1, "version": "v0.0.0-dev", "races": [{
        "id": "fixture-race", "state": state, "office": office, "district": district,
        "kind": "regular", "stage": "general", "electionDate": adapter.ELECTION,
        "candidates": [{"id": "fixture-a", "name": "Alex Example", "party": "D"},
                       {"id": "fixture-b", "name": "Blair Example", "party": "R"}],
        "results": {"available": False, "votes": [], "asOf": None, "call": None, "certification": None}}]}


def az_payload(a=20, b=10):
    return {"electionDate": adapter.ELECTION, "electionName": "2026 General Election",
            "createdAt": "2026-11-04T04:00:00Z", "results": {"name": "Arizona", "ballotItems": [{
                "id": "AZ-1", "type": "State", "name": "U.S. Representative in Congress - District No. 1",
                "voteFor": 1, "ballotOptions": [
                    {"id": "a", "name": "Alex Example", "politicalParty": "Democratic", "voteCount": a},
                    {"id": "b", "name": "Blair Example", "politicalParty": "Republican", "voteCount": b}]}]}}


def encoded_az(a=20, b=10):
    return json.dumps(az_payload(a, b)).encode()


NC_HEADERS = ["County", "Election Date", "Precinct", "Contest Group ID", "Contest Type", "Contest Name",
              "Choice", "Choice Party", "Vote For", "Election Day", "Early Voting", "Absentee by Mail",
              "Provisional", "Total Votes", "Real Precinct"]


def nc_rows():
    return [["Fixture County", "11/03/2026", "01", "1369", "S", "US HOUSE OF REPRESENTATIVES DISTRICT 01",
             "Alex Example", "DEM", "1", "10", "5", "4", "1", "20", "Y"],
            ["Fixture County", "11/03/2026", "01", "1369", "S", "US HOUSE OF REPRESENTATIVES DISTRICT 01",
             "Blair Example", "REP", "1", "4", "4", "2", "0", "10", "Y"]]


def nc_zip(rows=None, member="results_pct_20261103.txt"):
    text = io.StringIO()
    writer = csv.writer(text, delimiter="\t", lineterminator="\r\n")
    writer.writerow(NC_HEADERS)
    writer.writerows(rows if rows is not None else nc_rows())
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(member, text.getvalue())
    return buffer.getvalue()


class AdapterTests(unittest.TestCase):
    def test_exact_az_match_and_no_calls(self):
        parsed = adapter.parse_az(encoded_az(), catalog())
        self.assertEqual([v["votes"] for v in parsed["matches"]["fixture-race"]["votes"]], [20, 10])
        self.assertNotIn("call", parsed["matches"]["fixture-race"])

    def test_wrong_election_test_and_malformed_rejected(self):
        for mutate in (lambda p: p.update(electionDate="2026-08-04"), lambda p: p.update(isTest=True),
                       lambda p: p.update(createdAt="2026-11-03T17:25:00Z"), lambda p: p.pop("createdAt")):
            payload = az_payload()
            mutate(payload)
            with self.assertRaises(adapter.InvalidResults):
                adapter.parse_az(json.dumps(payload).encode(), catalog())
        with self.assertRaises(adapter.InvalidResults):
            adapter.parse_az(b'{"truncated":', catalog())

    def test_negative_boolean_and_duplicate_choices_rejected(self):
        for value in (-1, True, 1.5):
            with self.assertRaises(adapter.InvalidResults):
                adapter.parse_az(encoded_az(value), catalog())
        payload = az_payload()
        payload["results"]["ballotItems"][0]["ballotOptions"].append(copy.deepcopy(payload["results"]["ballotItems"][0]["ballotOptions"][0]))
        with self.assertRaises(adapter.InvalidResults):
            adapter.parse_az(json.dumps(payload).encode(), catalog())

    def test_zero_and_positive_unknown_never_published(self):
        with self.assertRaises(adapter.InvalidResults):
            adapter.parse_az(encoded_az(0, 0), catalog())
        payload = az_payload()
        payload["results"]["ballotItems"][0]["ballotOptions"].append(
            {"id": "unknown", "name": "Unreconciled Write-in", "politicalParty": None, "voteCount": 1})
        with self.assertRaises(adapter.InvalidResults):
            adapter.parse_az(json.dumps(payload).encode(), catalog())

    def test_party_conflict_and_missing_candidate_quarantine(self):
        payload = az_payload()
        payload["results"]["ballotItems"][0]["ballotOptions"][0]["politicalParty"] = "Independent"
        with self.assertRaises(adapter.InvalidResults):
            adapter.parse_az(json.dumps(payload).encode(), catalog())
        payload = az_payload()
        payload["results"]["ballotItems"][0]["ballotOptions"].pop()
        with self.assertRaises(adapter.InvalidResults):
            adapter.parse_az(json.dumps(payload).encode(), catalog())

    def test_duplicate_contest_rejected(self):
        payload = az_payload()
        payload["results"]["ballotItems"].append(copy.deepcopy(payload["results"]["ballotItems"][0]))
        with self.assertRaises(adapter.InvalidResults):
            adapter.parse_az(json.dumps(payload).encode(), catalog())

    def test_governor_ticket_uses_explicit_lead_name(self):
        payload = az_payload()
        item = payload["results"]["ballotItems"][0]
        item["id"] = "AZ-10"
        item["name"] = "Governor and Lieutenant Governor"
        item["ballotOptions"][0]["name"] = "Alex Example (DEM) / Deputy Person (DEM)"
        item["ballotOptions"][1]["name"] = "Blair Example (REP) / Another Deputy (REP)"
        parsed = adapter.parse_az(json.dumps(payload).encode(), catalog("AZ", "governor", None))
        self.assertEqual(len(parsed["matches"]), 1)

    def test_no_fuzzy_candidate_alias(self):
        payload = az_payload()
        payload["results"]["ballotItems"][0]["ballotOptions"][0]["name"] = "A. Example"
        with self.assertRaises(adapter.InvalidResults):
            adapter.parse_az(json.dumps(payload).encode(), catalog())

    def test_nc_totals_once_with_administrative_rows(self):
        rows = nc_rows()
        administrative = copy.deepcopy(rows[0])
        administrative[2] = "EARLY"
        administrative[9:14] = ["0", "5", "0", "0", "5"]
        administrative[14] = "N"
        parsed = adapter.parse_nc(nc_zip(rows + [administrative]), catalog("NC"))
        votes = parsed["matches"]["fixture-race"]["votes"]
        self.assertEqual([value["votes"] for value in votes], [25, 10])
        self.assertIsNone(parsed["asOf"])

    def test_nc_duplicates_wrong_date_method_mismatch_and_wrong_zip(self):
        cases = [nc_rows() + [nc_rows()[0]]]
        for field, value in ((1, "03/03/2026"), (13, "999"), (9, "-1")):
            rows = nc_rows()
            rows[0][field] = value
            cases.append(rows)
        for rows in cases:
            with self.assertRaises(adapter.InvalidResults):
                adapter.parse_nc(nc_zip(rows), catalog("NC"))
        with self.assertRaises(adapter.InvalidResults):
            adapter.parse_nc(nc_zip(member="precinct_sort.txt"), catalog("NC"))

    def test_retained_failure_and_real_downward_correction(self):
        initial = catalog()
        first = adapter.update(initial, ["az-official"], lambda *args: (encoded_az(), {"sha256": "first"}), "2026-11-04T04:00:01Z")
        corrected = adapter.update(first, ["az-official"], lambda *args: (encoded_az(19, 10), {"sha256": "second"}), "2026-11-04T04:02:02Z")
        result = corrected["races"][0]["results"]
        self.assertEqual(result["votes"][0]["votes"], 19)
        self.assertEqual(result["correction"]["previousVotes"][0]["votes"], 20)
        self.assertIsNone(result["call"])
        self.assertEqual(initial["races"][0]["results"]["votes"], [])
        retained = adapter.update(corrected, ["az-official"], lambda *args: (_ for _ in ()).throw(OSError("fixture timeout")))
        self.assertEqual(retained["races"][0]["results"], result)
        self.assertEqual(retained["resultHealth"]["az-official"]["status"], "retained-error")
        repeated = adapter.update(retained, ["az-official"], lambda *args: (_ for _ in ()).throw(OSError("fixture timeout")))
        self.assertEqual(repeated["resultHealth"]["az-official"]["status"], "retained-error")
        self.assertEqual(repeated["races"][0]["results"], result)

    def test_no_cross_source_overwrite_and_atomic_component(self):
        initial = catalog()
        initial["races"][0]["results"] = {"available": True, "sourceId": "nc-official", "votes": [
            {"candidateId": "fixture-a", "votes": 100}, {"candidateId": "fixture-b", "votes": 90}]}
        result = adapter.update(initial, ["az-official"], lambda *args: (encoded_az(), {}))
        self.assertEqual(result["races"][0]["results"], initial["races"][0]["results"])
        self.assertIn("Competing source", result["resultHealth"]["az-official"]["error"])

    def test_unchanged_body_not_source_movement(self):
        first = adapter.update(catalog(), ["az-official"], lambda *args: (encoded_az(), {"sha256": "same"}))
        second = adapter.update(first, ["az-official"], lambda *args: (encoded_az(), {"sha256": "same"}))
        self.assertFalse(second["resultHealth"]["az-official"]["observedChange"])
        self.assertEqual(second["races"][0]["results"]["asOf"], "2026-11-04T04:00:00Z")

    def test_publisher_historical_primary_not_general(self):
        csv_bytes = b'election_date,election_type,candidate,outcome,vote_pct\n2026-08-04,primary,Alex Example,won,70\n'
        with self.assertRaisesRegex(adapter.InvalidResults, "historical outcomes excluded"):
            adapter.parse_publisher(csv_bytes, catalog())

    def test_az_request_spacing_before_network(self):
        with self.assertRaisesRegex(adapter.InvalidResults, "120-second"):
            adapter.fetch("az-official", {"checkedAt": adapter.instant()})

    def test_successive_corrections_are_append_only(self):
        current = catalog()
        for count, minute in ((100, "00"), (90, "02"), (80, "04")):
            payload = az_payload(count, 60)
            payload["createdAt"] = f"2026-11-04T05:{minute}:00Z"
            body = json.dumps(payload).encode()
            current = adapter.update(current, ["az-official"], lambda *args: (body, {}), f"2026-11-04T05:{minute}:01Z")
        result = current["races"][0]["results"]
        history = result["correctionHistory"]
        self.assertEqual(len(history), 2)
        self.assertEqual([(entry["previousVotes"][0]["votes"], entry["newVotes"][0]["votes"])
                          for entry in history], [(100, 90), (90, 80)])
        self.assertEqual(result["correction"], history[-1])
        self.assertEqual(history[0]["sourceAsOf"], "2026-11-04T05:02:00Z")
        self.assertEqual(len(history[0]["bodySha256"]), 64)
        unchanged = adapter.update(current, ["az-official"], lambda *args: (body, {}))
        self.assertEqual(unchanged["races"][0]["results"]["correctionHistory"], history)

    def test_legacy_correction_notice_survives_migration(self):
        first = adapter.update(catalog(), ["az-official"], lambda *args: (encoded_az(90, 60), {}))
        legacy = {"detectedAt": "2026-11-04T03:59:00Z", "previousVotes": [{"candidateId": "fixture-a", "votes": 100}]}
        first["races"][0]["results"]["correction"] = legacy
        second = adapter.update(first, ["az-official"], lambda *args: (encoded_az(80, 60), {}))
        self.assertEqual(second["races"][0]["results"]["correctionHistory"][0], legacy)
        self.assertEqual(len(second["races"][0]["results"]["correctionHistory"]), 2)

    def regression_pair(self):
        first_payload = az_payload(80, 60)
        first_payload["createdAt"] = "2026-11-04T05:04:00Z"
        first = adapter.update(catalog(), ["az-official"], lambda *args: (json.dumps(first_payload).encode(), {}))
        older_payload = az_payload(100, 60)
        older_payload["createdAt"] = "2026-11-04T04:30:00Z"
        body = json.dumps(older_payload).encode()
        review = {"sourceId": "az-official", "previousSourceAsOf": "2026-11-04T05:04:00Z",
                  "incomingSourceAsOf": "2026-11-04T04:30:00Z", "bodySha256": adapter.hashlib.sha256(body).hexdigest(),
                  "reason": "Synthetic official revision notice confirms regenerated older source clock",
                  "evidenceUrl": "https://example.org/synthetic-revision-evidence", "reviewer": "fixture operator",
                  "reviewedAt": "2026-11-04T05:08:00Z"}
        return first, body, review

    def test_older_source_timestamp_retains_and_requires_review(self):
        first, body, _ = self.regression_pair()
        result = adapter.update(first, ["az-official"], lambda *args: (body, {}))
        self.assertEqual(result["races"][0]["results"], first["races"][0]["results"])
        health = result["resultHealth"]["az-official"]
        self.assertEqual(health["status"], "retained-error")
        self.assertTrue(health["reviewRequired"])
        self.assertEqual(health["pendingRevision"]["incomingSourceAsOf"], "2026-11-04T04:30:00Z")

    def test_explicit_review_can_admit_earlier_clock_with_lineage(self):
        first, body, review = self.regression_pair()
        result = adapter.update(first, ["az-official"], lambda *args: (body, {}), reviewed_revisions=[review])
        new = result["races"][0]["results"]
        self.assertEqual(new["asOf"], "2026-11-04T04:30:00Z")
        self.assertEqual(new["votes"][0]["votes"], 100)
        self.assertEqual(new["correctionHistory"][-1]["revisionReview"], review)
        self.assertEqual(result["resultHealth"]["az-official"]["sourceClockAssessment"], "reviewed-regression")
        self.assertIsNone(new["call"])

    def test_review_is_bound_to_exact_body_clocks_and_evidence(self):
        first, body, review = self.regression_pair()
        for field, value in (("bodySha256", "0" * 64), ("previousSourceAsOf", "2026-11-04T05:03:00Z"),
                             ("reason", ""), ("evidenceUrl", "javascript:alert(1)")):
            invalid = {**review, field: value}
            result = adapter.update(first, ["az-official"], lambda *args: (body, {}), reviewed_revisions=[invalid])
            self.assertTrue(result["resultHealth"]["az-official"]["reviewRequired"])
            self.assertEqual(result["races"][0]["results"], first["races"][0]["results"])

    def test_unknown_nc_clock_stays_unknown_and_preserves_corrections(self):
        first = adapter.update(catalog("NC"), ["nc-official"], lambda *args: (nc_zip(), {}))
        rows = nc_rows()
        rows[0][9], rows[0][13] = "9", "19"
        second = adapter.update(first, ["nc-official"], lambda *args: (nc_zip(rows), {}))
        new = second["races"][0]["results"]
        self.assertIsNone(new["asOf"])
        self.assertIsNone(new["correctionHistory"][0]["sourceAsOf"])
        self.assertEqual(second["resultHealth"]["nc-official"]["sourceClockAssessment"], "unknown")
        self.assertNotIn("reviewRequired", second["resultHealth"]["nc-official"])


if __name__ == "__main__":
    unittest.main()
