"""Synthetic method fixtures; real empty captures are replayed separately."""

import copy
import hashlib
import json
import unittest

import test_update_results as fixtures
import update_vote_methods as methods


def az_body(a=20, b=10, clock="2026-11-04T04:00:00Z"):
    data = fixtures.az_payload(a, b)
    data["createdAt"] = clock
    for option in data["results"]["ballotItems"][0]["ballotOptions"]:
        total = option["voteCount"]
        option["groupResults"] = [{"groupName": "Election Day", "voteCount": total // 2, "isFromVirtualPrecinct": False},
                                  {"groupName": "Early Voting", "voteCount": total - total // 2, "isFromVirtualPrecinct": False}]
    return data


def update(snapshot, body, source="az-official", reviews=None):
    return methods.update_vote_methods(snapshot, lambda *_: (body, {}), "2026-11-04T05:08:00Z", reviews, [source])


class MethodTests(unittest.TestCase):
    def test_az_uses_one_fetch_and_only_statewide_contest_not_county_copy(self):
        data = az_body()
        local = copy.deepcopy(data["results"])
        local["name"] = "Synthetic County"
        local["ballotItems"][0]["ballotOptions"][0]["voteCount"] = 999
        data["localResults"] = [local]
        body = json.dumps(data).encode()
        calls = []
        def loader(*args):
            calls.append(args)
            return body, {}
        result = methods.update_vote_methods(fixtures.catalog(), loader, source_ids=["az-official"])
        table = result["races"][0]["results"]["voteMethods"]
        self.assertEqual(len(calls), 1)
        self.assertEqual(table["headers"], ["Candidate", "Party", "Election Day", "Early Voting", "Total"])
        self.assertEqual(table["rows"][0][2:], [10, 10, 20])
        self.assertEqual(table["bodySha256"], hashlib.sha256(body).hexdigest())
        self.assertEqual(table["bodySha256"], result["races"][0]["results"]["bodySha256"])
        self.assertTrue(methods.validate_vote_methods(result))

    def test_nc_includes_administrative_rows_once_and_keeps_unknown_clock(self):
        rows = fixtures.nc_rows()
        extra = rows[0].copy()
        extra[2], extra[9], extra[10], extra[11], extra[12], extra[13], extra[14] = "ABSENTEE", "0", "2", "3", "0", "5", "N"
        rows.append(extra)
        result = update(fixtures.catalog("NC"), fixtures.nc_zip(rows), "nc-official")
        table = result["races"][0]["results"]["voteMethods"]
        self.assertEqual(table["rows"][0][2:], [10, 7, 7, 1, 25])
        self.assertIsNone(table["asOf"])
        self.assertEqual(table["sourceClockAssessment"], "unknown")
        self.assertEqual(result["races"][0]["results"]["votes"][0]["votes"], 25)

    def test_zero_placeholders_do_not_produce_tables(self):
        result = update(fixtures.catalog(), json.dumps(az_body(0, 0)).encode())
        self.assertNotIn("voteMethods", result["races"][0]["results"])
        self.assertFalse(result["races"][0]["results"]["available"])

    def test_missing_duplicate_negative_or_nonadditive_groups_never_admit_methods(self):
        for mode in ["missing", "duplicate", "negative", "nonadditive", "boolean"]:
            data = az_body()
            option = data["results"]["ballotItems"][0]["ballotOptions"][0]
            if mode == "missing": option.pop("groupResults")
            elif mode == "duplicate": option["groupResults"].append(copy.deepcopy(option["groupResults"][0]))
            elif mode == "negative": option["groupResults"][0]["voteCount"] = -1
            elif mode == "boolean": option["groupResults"][0]["voteCount"] = True
            else: option["groupResults"][0]["voteCount"] = 11
            result = update(fixtures.catalog(), json.dumps(data).encode())
            self.assertTrue(result["races"][0]["results"]["available"])
            self.assertNotIn("voteMethods", result["races"][0]["results"])
            self.assertTrue(result["resultHealth"]["az-official"]["voteMethods"]["errors"])

    def test_named_unmatched_zero_choice_is_not_hidden_from_methods(self):
        data = az_body()
        extra = copy.deepcopy(data["results"]["ballotItems"][0]["ballotOptions"][0])
        extra.update(id="extra", name="Different Named Person", voteCount=0)
        for group in extra["groupResults"]: group["voteCount"] = 0
        data["results"]["ballotItems"][0]["ballotOptions"].append(extra)
        result = update(fixtures.catalog(), json.dumps(data).encode())
        self.assertNotIn("voteMethods", result["races"][0]["results"])
        self.assertIn("Unreconciled named", result["resultHealth"]["az-official"]["voteMethods"]["errors"][0]["reason"])

    def test_nc_duplicate_wrong_election_and_method_mismatch_retain_last_good(self):
        current = update(fixtures.catalog("NC"), fixtures.nc_zip(), "nc-official")
        for mode in ["duplicate", "date", "mismatch"]:
            rows = fixtures.nc_rows()
            if mode == "duplicate": rows.append(rows[0].copy())
            elif mode == "date": rows[0][1] = "03/03/2026"
            else: rows[0][9] = "11"
            result = update(current, fixtures.nc_zip(rows), "nc-official")
            self.assertEqual(result["races"][0]["results"]["voteMethods"], current["races"][0]["results"]["voteMethods"])
            self.assertEqual(result["resultHealth"]["nc-official"]["voteMethods"]["status"], "retained-error")

    def test_method_downward_history_and_clock_rollback(self):
        current = fixtures.catalog()
        for value, minute in [(20, "00"), (16, "02"), (12, "04")]:
            current = update(current, json.dumps(az_body(value, 10, f"2026-11-04T04:{minute}:00Z")).encode())
        table = current["races"][0]["results"]["voteMethods"]
        self.assertEqual([(entry["previousRows"][0][-1], entry["newRows"][0][-1]) for entry in table["correctionHistory"]], [(20,16),(16,12)])
        held = update(current, json.dumps(az_body(20, 10, "2026-11-04T03:30:00Z")).encode())
        self.assertEqual(held["races"][0]["results"]["voteMethods"], table)
        self.assertTrue(held["resultHealth"]["az-official"]["reviewRequired"])

    def test_method_failure_retains_lineage_outside_current_incompatible_counts(self):
        current = update(fixtures.catalog(), json.dumps(az_body()).encode())
        broken = az_body(16,10,"2026-11-04T04:02:00Z")
        broken["results"]["ballotItems"][0]["ballotOptions"][0].pop("groupResults")
        held = update(current, json.dumps(broken).encode())
        self.assertNotIn("voteMethods", held["races"][0]["results"])
        self.assertIn("fixture-race", held["resultHealth"]["az-official"]["voteMethods"]["lastGood"])
        held_again = update(held, json.dumps(broken).encode())
        repaired = update(held_again, json.dumps(az_body(12,10,"2026-11-04T04:04:00Z")).encode())
        self.assertEqual(repaired["races"][0]["results"]["voteMethods"]["correctionHistory"][0]["previousRows"][0][-1], 20)

    def test_schema_rejects_wrong_counts_identity_and_invented_nc_clock(self):
        current = update(fixtures.catalog("NC"), fixtures.nc_zip(), "nc-official")
        for mode in ["total", "name", "clock"]:
            altered = copy.deepcopy(current)
            table = altered["races"][0]["results"]["voteMethods"]
            if mode == "total": table["rows"][0][-1] += 1
            elif mode == "name": table["rows"][0][0] = "Wrong candidate"
            else: table["asOf"] = "2026-11-04T05:00:00Z"
            with self.assertRaises(methods.shared.InvalidResults): methods.validate_vote_methods(altered)


if __name__ == "__main__":
    unittest.main()
