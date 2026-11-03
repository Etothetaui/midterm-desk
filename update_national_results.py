"""Public civicAPI result captures, cautiously matched to the app's contest ledger.

  python update_national_results.py --input next-data.json --output next-data.json

No forecast endpoint, inferred calls, invented aliases or source zeroes admitted
as reported returns. Explicit contest-level publisher winner flags remain
attributed separately from canonical calls and certification. Uses atomic
correction/review safeguards; existing official-source results take precedence.
"""

import argparse
import copy
import datetime as dt
import hashlib
import json
from pathlib import Path
import re

import update_results as shared


CONFIG = {
    "house": ("civicapi-house", "https://civicapi.org/api/v2/race/87524", "United States House of Representatives", "House of Representatives"),
    "senate": ("civicapi-senate", "https://civicapi.org/api/v2/race/87528", "United States Senate", "US Senate"),
    "governor": ("civicapi-governor", "https://civicapi.org/api/v2/race/87535", "United States Governors", "Governor"),
}
TERMS = "https://civicapi.org/api-documentation"
AUTHORITY = "Publisher aggregation via civicAPI; unofficial. Not independent election-official certification."


def publisher_id(value):
    if isinstance(value, bool) or not isinstance(value, (str, int)) or not re.fullmatch(r"[0-9]{1,20}", str(value)):
        raise shared.InvalidResults("Invalid publisher numeric identity")
    return str(value)


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise shared.InvalidResults("Duplicate JSON field or region key")
        result[key] = value
    return result


def ledger_match(snapshot, office, region_key):
    state = region_key[:2].upper()
    if office == "house":
        match = re.fullmatch(r"([a-z]{2})-(al|\d{2})", region_key)
        if not match:
            return None, "Invalid House region key"
        district = 0 if match[2] == "al" else int(match[2])
        races = [race for race in snapshot["races"] if race["office"] == office and race["state"] == state
                 and race.get("district") == district and race.get("kind") == "regular"]
    else:
        if not re.fullmatch(r"[a-z]{2}", region_key):
            return None, "Invalid statewide region key"
        # FL/OH have exactly one Senate contest in this year's verified ledger,
        # explicitly a special. Do not invent regular status from the state key.
        races = [race for race in snapshot["races"] if race["office"] == office and race["state"] == state]
    races = [race for race in races if race.get("electionDate") == shared.ELECTION]
    if len(races) != 1:
        return None, "No unique current catalog contest; regular/special identity requires review"
    if races[0].get("stage") != "general":
        return races[0], "Catalog stage differs from publisher General scope; not silently remapped"
    return races[0], None


def choice_inventory(race, candidates):
    """Exact name+party, with only explicit ballotName/aliases already in ledger."""
    mapping = {}
    for candidate in race["candidates"]:
        names = [candidate["name"], candidate.get("ballotName")]
        aliases = candidate.get("aliases", [])
        if isinstance(aliases, list):
            names.extend(alias for alias in aliases if isinstance(alias, str))
        for name in names:
            if not name:
                continue
            key = (shared.normalized(name), candidate["party"])
            if key in mapping and mapping[key] != candidate["id"]:
                raise shared.InvalidResults("Ambiguous explicit catalog alias")
            mapping[key] = candidate["id"]
    seen, mapped, unmatched = set(), {}, []
    for candidate in candidates:
        if not isinstance(candidate, dict) or not isinstance(candidate.get("name"), str):
            raise shared.InvalidResults("Invalid publisher candidate")
        candidate_id = candidate.get("candidate_id")
        if isinstance(candidate_id, bool) or not isinstance(candidate_id, (str, int)) or candidate_id == "" or str(candidate_id) in seen:
            raise shared.InvalidResults("Missing/duplicate publisher candidate ID")
        seen.add(str(candidate_id))
        count = shared.integer(candidate.get("votes"))
        name = candidate["name"]
        target_id = mapping.get((shared.normalized(name), shared.party(candidate.get("party"))))
        if target_id is None:
            # A generic write-in placeholder is not a missing named nominee.
            if count or shared.normalized(name) not in {"write in", "write in miscellaneous", "unassigned write in", "unofficial write in"}:
                unmatched.append({"sourceCandidateId": candidate_id, "name": name, "party": candidate.get("party"), "votes": count})
            continue
        if target_id in mapped:
            raise shared.InvalidResults("Multiple publisher choices map to one catalog candidate")
        mapped[target_id] = {"candidateId": target_id, "votes": count,
                             "sourceChoiceId": str(candidate_id), "sourceName": name,
                             "sourceParty": candidate.get("party")}
    missing = [candidate["id"] for candidate in race["candidates"] if candidate["id"] not in mapped]
    return list(mapped.values()), {"missingCatalogCandidateIds": missing, "unmatchedSourceCandidates": unmatched}


def parse_component(body, snapshot, office):
    source_id, url, election_name, election_type = CONFIG[office]
    try:
        data = json.loads(body, object_pairs_hook=unique_pairs)
    except (ValueError, UnicodeDecodeError) as exc:
        raise shared.InvalidResults("Malformed national result JSON") from exc
    if not isinstance(data, dict) or data.get("test_data") is not False:
        raise shared.InvalidResults("Explicit non-test publisher response required")
    if data.get("country") != "US" or data.get("election_name") != election_name or data.get("election_type") != election_type or data.get("election_scope") != "General":
        raise shared.InvalidResults("Wrong national office/election scope")
    election_date = shared.source_time(data.get("election_date"))
    if not election_date or election_date[:10] != shared.ELECTION:
        raise shared.InvalidResults("Wrong national election date")
    shared.reject_test(data)
    as_of = shared.source_time(data.get("last_updated"))
    regions = data.get("region_results")
    if not isinstance(regions, dict) or len(regions) > 1000:
        raise shared.InvalidResults("Invalid/oversized national regions")
    assessment = {"feedRaceCount": len(regions), "mappedRaceCount": 0, "nomineeReconciledRaceCount": 0,
                  "admittedRaceCount": 0, "zeroRaceCount": 0, "positiveRaceCount": 0,
                  "nomineeConflicts": [], "identityConflicts": [], "sourceAuthority": AUTHORITY,
                  "attribution": "civicAPI (civicapi.org)", "termsUrl": TERMS,
                  "notCovered": "These aggregate routes omit House delegates and territorial governors. Stage conflicts remain separate."}
    matches, records, skipped, election_ids = {}, {}, [], set()
    for key, region in regions.items():
        if not isinstance(key, str) or not isinstance(region, dict):
            raise shared.InvalidResults("Invalid national region")
        shared.reject_test(region)
        source_contest_id = region.get("election_id")
        if publisher_id(source_contest_id) in election_ids:
            raise shared.InvalidResults("Missing/duplicate publisher contest ID")
        election_ids.add(str(source_contest_id))
        candidates = region.get("candidates")
        if not isinstance(candidates, list) or not 1 <= len(candidates) <= 100:
            raise shared.InvalidResults("Invalid national candidate list")
        # Validate counts even when identity/stage cannot be admitted.
        if any(not isinstance(candidate, dict) for candidate in candidates):
            raise shared.InvalidResults("Invalid publisher candidate record")
        total = sum(shared.integer(candidate.get("votes")) for candidate in candidates)
        if total > 2**53 - 1:
            raise shared.InvalidResults("Unsafe aggregate vote count")
        if total:
            assessment["positiveRaceCount"] += 1
        else:
            assessment["zeroRaceCount"] += 1
        race, conflict = ledger_match(snapshot, office, key)
        if conflict:
            assessment["identityConflicts"].append({"regionKey": key, "reason": conflict})
            skipped.append({"sourceContestId": str(source_contest_id), "reason": conflict})
            if race is None:
                continue
        raw_candidates = []
        raw_ids = set()
        for candidate in candidates:
            candidate_id = candidate.get("candidate_id")
            name, source_party = candidate.get("name"), candidate.get("party")
            if publisher_id(candidate_id) in raw_ids:
                raise shared.InvalidResults("Invalid/duplicate publisher choice identity")
            if not isinstance(name, str) or not 1 <= len(name) <= 500 or (source_party is not None and (not isinstance(source_party, str) or len(source_party) > 100)):
                raise shared.InvalidResults("Invalid publisher candidate name/party")
            raw_ids.add(str(candidate_id))
            winner = candidate.get("winner")
            if winner is not None and type(winner) is not bool:
                raise shared.InvalidResults("Invalid contest winner flag")
            raw_candidates.append({"sourceId": str(candidate_id), "name": name, "party": source_party,
                                   "votes": shared.integer(candidate.get("votes")), "sourceWinnerFlag": winner})
        winners = [candidate for candidate in raw_candidates if candidate["sourceWinnerFlag"] is True]
        if len(winners) > 1:
            raise shared.InvalidResults("Multiple winner flags in single-winner contest")
        flags_known = all(candidate["sourceWinnerFlag"] is not None for candidate in raw_candidates)
        clock_current = as_of is not None and dt.datetime.fromisoformat(as_of.replace("Z", "+00:00")).date() >= dt.date.fromisoformat(shared.ELECTION)
        call_status = "stage-conflict" if conflict else "unknown" if not flags_known else "unreported" if not total else "unknown-source-clock" if not clock_current else "called" if winners else "uncalled"
        source_call = None
        if call_status == "called":
            winner = winners[0]
            source_call = {"candidateSourceId": winner["sourceId"], "name": winner["name"], "party": winner["party"],
                           "sourceName": "civicAPI decision desk", "sourceUrl": url, "asOf": as_of,
                           "firstObservedAt": None, "calledAt": None, "certification": None}
        record = {"sourceId": source_id, "sourceContestId": str(source_contest_id), "sourceUrl": url,
                  "sourceRaceUrl": f"https://civicapi.org/api/v2/race/{source_contest_id}",
                  "detailUrl": f"https://civicapi.org/api/v2/race/{source_contest_id}",
                  "asOf": as_of, "sourceAsOfKind": "publisher-record-update", "electionDate": shared.ELECTION,
                  "stage": "general", "catalogStage": race.get("stage"), "reported": total > 0,
                  "candidates": raw_candidates, "matchStatus": "stage-conflict" if conflict else "pending-name-check",
                  "attribution": "civicAPI (civicapi.org)", "sourceAuthority": AUTHORITY,
                  "sourceCall": source_call, "sourceCallStatus": call_status,
                  "callStatus": "Attributed contest-level publisher flag only; not a county call or certification"}
        records[race["id"]] = record
        if conflict:
            continue
        assessment["mappedRaceCount"] += 1
        votes, inventory = choice_inventory(race, candidates)
        if inventory["missingCatalogCandidateIds"] or inventory["unmatchedSourceCandidates"]:
            record["matchStatus"] = "nominee-conflict"
            record["nomineeConflict"] = inventory
            assessment["nomineeConflicts"].append({"raceId": race["id"], "regionKey": key, **inventory})
            skipped.append({"sourceContestId": str(source_contest_id), "reason": "Named candidate/party reconciliation required"})
            continue
        record["matchStatus"] = "exact-candidate-match"
        assessment["nomineeReconciledRaceCount"] += 1
        if not total:
            skipped.append({"sourceContestId": str(source_contest_id), "reason": "All-zero pre-reporting/empty race; not reported returns"})
            continue
        old = race["results"]
        if old.get("available") and old.get("sourceId") not in (None, source_id):
            skipped.append({"sourceContestId": str(source_contest_id), "reason": "Existing other-source results retained; no silent priority override"})
            continue
        if race["id"] in matches:
            raise shared.InvalidResults("Duplicate catalog mapping")
        # Root publisher clock is the publisher record update, not official certification.
        matches[race["id"]] = {"votes": votes, "sourceContestId": str(source_contest_id)}
    assessment["admittedRaceCount"] = len(matches)
    return {"sourceId": source_id, "sourceUrl": url, "asOf": as_of,
            "matches": matches, "records": records, "skipped": skipped, "assessment": assessment}


def validate_national_records(snapshot):
    """Validate the additive publisher-native tables without admitting catalog votes."""
    shared.validate_catalog(snapshot)
    records = snapshot.get("nationalResultRecords", {})
    if not isinstance(records, dict) or len(records) > 2000:
        raise shared.InvalidResults("Invalid nationalResultRecords component")
    ledger = {race["id"]: race for race in snapshot["races"]}
    known_sources = {value[0]: value[1] for value in CONFIG.values()}
    offices = {value[0]: office for office, value in CONFIG.items()}
    contests = set()
    for race_id, record in records.items():
        if race_id not in ledger or not isinstance(record, dict) or record.get("sourceId") not in known_sources:
            raise shared.InvalidResults("Unknown national record/catalog identity")
        if ledger[race_id].get("office") != offices[record["sourceId"]] or record.get("catalogStage") != ledger[race_id].get("stage"):
            raise shared.InvalidResults("Native record disagrees with catalog office/stage")
        if record.get("sourceUrl") != known_sources[record["sourceId"]] or record.get("stage") != "general" or record.get("electionDate") != shared.ELECTION:
            raise shared.InvalidResults("Invalid national record provenance/stage")
        contest_id = publisher_id(record.get("sourceContestId"))
        identity = (record["sourceId"], contest_id)
        if identity in contests:
            raise shared.InvalidResults("Duplicate native source contest")
        contests.add(identity)
        if record.get("sourceRaceUrl") != f"https://civicapi.org/api/v2/race/{contest_id}":
            raise shared.InvalidResults("Invalid native contest link")
        if record.get("detailUrl", record["sourceRaceUrl"]) != record["sourceRaceUrl"]:
            raise shared.InvalidResults("Invalid native detail link")
        shared.source_time(record.get("asOf"))
        shared.source_time(record.get("lastKnownSourceAsOf"))
        shared.source_time(record.get("checkedAt"))
        if not isinstance(record.get("bodySha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", record["bodySha256"]):
            raise shared.InvalidResults("Invalid native body identity")
        if type(record.get("reported")) is not bool or record.get("matchStatus") not in {"stage-conflict", "nominee-conflict", "exact-candidate-match"}:
            raise shared.InvalidResults("Invalid national record admission state")
        candidates = record.get("candidates")
        if not isinstance(candidates, list) or not 1 <= len(candidates) <= 100:
            raise shared.InvalidResults("Invalid national record choices")
        ids = set()
        for candidate in candidates:
            if not isinstance(candidate, dict) or not isinstance(candidate.get("sourceId"), str) or not candidate["sourceId"] or candidate["sourceId"] in ids:
                raise shared.InvalidResults("Invalid/duplicate native candidate ID")
            ids.add(candidate["sourceId"])
            publisher_id(candidate["sourceId"])
            if not isinstance(candidate.get("name"), str) or not 1 <= len(candidate["name"]) <= 500:
                raise shared.InvalidResults("Invalid native candidate name")
            if candidate.get("party") is not None and (not isinstance(candidate["party"], str) or len(candidate["party"]) > 100):
                raise shared.InvalidResults("Invalid native candidate party")
            if candidate.get("sourceWinnerFlag") is not None and type(candidate["sourceWinnerFlag"]) is not bool:
                raise shared.InvalidResults("Invalid native winner flag")
            if type(candidate.get("votes")) is not int:
                raise shared.InvalidResults("Native counts must be normalized integers")
            shared.integer(candidate["votes"])
        if sum(candidate["votes"] for candidate in candidates) > 2**53 - 1:
            raise shared.InvalidResults("Unsafe native aggregate vote count")
        shared.correction_history(record)
        if record["reported"] != any(candidate["votes"] > 0 for candidate in candidates):
            raise shared.InvalidResults("Zero records cannot claim reported votes")
        call = record.get("sourceCall")
        if record.get("sourceCallStatus", "unknown") not in {"called", "uncalled", "retracted", "unknown", "unreported", "unknown-source-clock", "retained-unknown", "retained-unknown-source-clock", "stage-conflict"}:
            raise shared.InvalidResults("Invalid source call status")
        if call is not None:
            if not isinstance(call, dict) or call.get("sourceName") != "civicAPI decision desk" or call.get("sourceUrl") != record["sourceUrl"] or call.get("calledAt") is not None or call.get("certification") is not None:
                raise shared.InvalidResults("Invalid source call provenance")
            publisher_id(call.get("candidateSourceId"))
            if not isinstance(call.get("name"), str) or not 1 <= len(call["name"]) <= 500 or (call.get("party") is not None and not isinstance(call["party"], str)):
                raise shared.InvalidResults("Invalid source call identity")
            if not shared.source_time(call.get("asOf")) or not shared.source_time(call.get("firstObservedAt")):
                raise shared.InvalidResults("Missing source call observation clock")
        if record.get("sourceCallStatus") == "called":
            flagged = [candidate for candidate in candidates if candidate.get("sourceWinnerFlag") is True]
            if (not call or not record["reported"] or record.get("catalogStage") != "general" or len(flagged) != 1
                    or any(candidate.get("sourceWinnerFlag") is None for candidate in candidates)
                    or call.get("asOf") != record.get("asOf")
                    or dt.datetime.fromisoformat(call["asOf"].replace("Z", "+00:00")).date() < dt.date.fromisoformat(shared.ELECTION)
                    or (flagged[0]["sourceId"], flagged[0]["name"], flagged[0]["party"]) != (call["candidateSourceId"], call["name"], call["party"])):
                raise shared.InvalidResults("Unproved contest-level source call")
        if not isinstance(record.get("sourceCallHistory", []), list):
            raise shared.InvalidResults("Invalid source call history")
    return True


def normalize_detail(body, race, source_record, checked_at=None):
    """Pure publisher-region normalizer; never infers remaining votes or calls.

    Fetch source_record['detailUrl'] only on selection. Regional candidates have
    no source candidate_id in observed payloads, so retain names/parties rather
    than inventing ID bindings. House county rows cover only the district part.
    Cache replacement/clock-review policy is the caller's responsibility.
    """
    if race.get("office") not in CONFIG or source_record.get("sourceId") != CONFIG[race["office"]][0]:
        raise shared.InvalidResults("Wrong detail source/office")
    expected_url = "https://civicapi.org/api/v2/race/" + publisher_id(source_record.get("sourceContestId"))
    if source_record.get("detailUrl") != expected_url:
        raise shared.InvalidResults("Unrecognized detail URL")
    try:
        data = json.loads(body, object_pairs_hook=unique_pairs)
    except (ValueError, UnicodeDecodeError) as exc:
        raise shared.InvalidResults("Malformed detail JSON") from exc
    office = race["office"]
    if not isinstance(data, dict) or data.get("test_data") is not False:
        raise shared.InvalidResults("Explicit non-test detail required")
    shared.reject_test(data)
    date = shared.source_time(data.get("election_date"))
    allowed_scope = {"General", "Statewide"} if office == "governor" else {"General"}
    if (data.get("country") != "US" or data.get("province") != race.get("state")
            or data.get("election_type") != CONFIG[office][3] or data.get("election_scope") not in allowed_scope
            or not date or date[:10] != shared.ELECTION):
        raise shared.InvalidResults("Wrong detail election/jurisdiction")
    if office == "house":
        district = "AL" if race.get("district") == 0 else str(race.get("district")).zfill(2)
        if data.get("district") != f"{race['state']}-{district}":
            raise shared.InvalidResults("Wrong detail congressional district")
    elif data.get("district") is not None:
        raise shared.InvalidResults("Unexpected statewide detail district")
    raw_regions = data.get("region_results")
    if not isinstance(raw_regions, dict) or len(raw_regions) > 5000:
        raise shared.InvalidResults("Invalid detail regions")
    def reporting(value):
        if value is None:
            return None
        if type(value) not in (int, float) or not 0 <= value <= 100:
            raise shared.InvalidResults("Invalid publisher reporting percentage")
        return value
    regions = []
    fips_seen = set()
    for key, region in raw_regions.items():
        if not isinstance(key, str) or not 1 <= len(key) <= 500 or not isinstance(region, dict):
            raise shared.InvalidResults("Invalid detail region")
        shared.reject_test(region)
        fips = region.get("fips")
        if not isinstance(fips, str) or not re.fullmatch(r"[0-9]{5}", fips) or fips in fips_seen:
            raise shared.InvalidResults("Missing/duplicate five-digit county FIPS")
        fips_seen.add(fips)
        if any(not isinstance(region.get(field), str) or not 1 <= len(region[field]) <= 500 for field in ("name", "type")):
            raise shared.InvalidResults("Invalid detail region label")
        candidates = region.get("candidates")
        if not isinstance(candidates, list) or not 1 <= len(candidates) <= 100:
            raise shared.InvalidResults("Invalid detail candidates")
        native, seen = [], set()
        for candidate in candidates:
            if not isinstance(candidate, dict) or not isinstance(candidate.get("name"), str) or not 1 <= len(candidate["name"]) <= 500:
                raise shared.InvalidResults("Invalid detail candidate name")
            party = candidate.get("party")
            if party is not None and (not isinstance(party, str) or len(party) > 100):
                raise shared.InvalidResults("Invalid detail candidate party")
            identity = (shared.normalized(candidate["name"]), party)
            if identity in seen:
                raise shared.InvalidResults("Ambiguous duplicate detail candidate")
            seen.add(identity)
            native.append({"name": candidate["name"], "party": party, "votes": shared.integer(candidate.get("votes"))})
        if sum(candidate["votes"] for candidate in native) > 2**53 - 1:
            raise shared.InvalidResults("Unsafe detail vote total")
        regions.append({"sourceRegionKey": key, "name": region["name"], "type": region["type"], "fips": fips,
                        "publisherReportingPercent": reporting(region.get("percent_reporting")),
                        "reported": any(candidate["votes"] > 0 for candidate in native), "candidates": native})
    return {"raceId": race["id"], "sourceId": source_record["sourceId"], "sourceUrl": expected_url,
            "asOf": shared.source_time(data.get("last_updated")), "checkedAt": checked_at or shared.instant(),
            "bodySha256": hashlib.sha256(body).hexdigest(), "sourceScope": data["election_scope"],
            "electionDate": shared.ELECTION, "sourceAuthority": AUTHORITY,
            "geographicScope": "county portion within this congressional district" if office == "house" else "county within this statewide contest",
            "publisherReportingPercent": reporting(data.get("percent_reporting")),
            "reportingMeasure": "publisher estimated precinct/batch reporting; not percentage of votes counted",
            "reported": any(region["reported"] for region in regions), "regions": regions,
            "expectedTotalVotes": None, "remainingVotes": None, "voteMethods": None,
            "matchStatus": "publisher-native; no catalog candidate mapping", "attribution": "civicAPI (civicapi.org)"}


def reviewed_native_records(snapshot, incoming, source_id, body_hash, checked_at, reviews):
    """Native source identities retain their own history without catalog remapping."""
    previous_records = snapshot.get("nationalResultRecords", {})
    clocks = [clock for record in previous_records.values() if record.get("sourceId") == source_id
              for clock in (record.get("asOf"), record.get("lastKnownSourceAsOf")) if clock]
    prior_clock = max(clocks, key=lambda value: dt.datetime.fromisoformat(value.replace("Z", "+00:00"))) if clocks else None
    new_clock = next((record["asOf"] for record in incoming.values() if record.get("asOf")), None)
    review = None
    if prior_clock and new_clock and dt.datetime.fromisoformat(new_clock.replace("Z", "+00:00")) < dt.datetime.fromisoformat(prior_clock.replace("Z", "+00:00")):
        review = shared.reviewed_revision(source_id, prior_clock, new_clock, body_hash, reviews)
        if review is None:
            raise shared.RevisionReviewRequired(prior_clock, new_clock, body_hash)
    prepared = {}
    for race_id, incoming_record in incoming.items():
        old = previous_records.get(race_id)
        new = copy.deepcopy(incoming_record)
        new.update(checkedAt=checked_at, bodySha256=body_hash)
        # Unknown source time stays null; keep a separate guard against a later
        # known but older cache response bypassing the last observed clock.
        new["lastKnownSourceAsOf"] = new["asOf"] or (old or {}).get("lastKnownSourceAsOf") or (old or {}).get("asOf")
        if old and old.get("sourceId") != source_id:
            raise shared.InvalidResults("Competing native result source requires review")
        if old and old.get("reported") and not new["reported"]:
            retained = copy.deepcopy(old)
            retained["fetchHealth"] = {"status": "retained-unreported", "checkedAt": checked_at,
                                       "reason": "Incoming source record contains no reported votes"}
            prepared[race_id] = retained
            continue
        call_history = copy.deepcopy((old or {}).get("sourceCallHistory", []))
        if not isinstance(call_history, list):
            raise shared.InvalidResults("Invalid prior source call lineage")
        old_call = (old or {}).get("sourceCall")
        if new["sourceCallStatus"] in {"unknown", "unknown-source-clock"} and old_call:
            new["sourceCall"] = copy.deepcopy(old_call)
            new["sourceCallStatus"] = "retained-" + new["sourceCallStatus"]
        elif new["sourceCallStatus"] == "called":
            new_call = new["sourceCall"]
            same_call = old_call and old_call.get("candidateSourceId") == new_call["candidateSourceId"] and old_call.get("name") == new_call["name"] and old_call.get("party") == new_call["party"]
            new_call["firstObservedAt"] = old_call["firstObservedAt"] if same_call else checked_at
            if not same_call:
                call_history.append({"action": "publisher-call-changed" if old_call else "publisher-winner-flag-observed",
                    "detectedAt": checked_at, "previousCall": copy.deepcopy(old_call), "newCall": copy.deepcopy(new_call),
                    "previousBodySha256": (old or {}).get("bodySha256"), "bodySha256": body_hash})
        elif new["sourceCallStatus"] == "uncalled" and old_call:
            call_history.append({"action": "publisher-winner-flag-removed", "detectedAt": checked_at,
                "previousCall": copy.deepcopy(old_call), "newCall": None,
                "previousBodySha256": (old or {}).get("bodySha256"), "bodySha256": body_hash,
                "sourceAsOf": new["asOf"]})
            new["sourceCallStatus"] = "retracted"
        elif new["sourceCallStatus"] == "uncalled" and call_history and call_history[-1].get("newCall") is None:
            new["sourceCallStatus"] = "retracted"
        if call_history:
            if review and call_history[-1].get("detectedAt") == checked_at and call_history[-1].get("bodySha256") == body_hash:
                call_history[-1]["revisionReview"] = copy.deepcopy(review)
            new["sourceCallHistory"] = call_history
        history = shared.correction_history(old or {})
        if old:
            old_counts = {candidate["sourceId"]: candidate["votes"] for candidate in old["candidates"]}
            new_counts = {candidate["sourceId"]: candidate["votes"] for candidate in new["candidates"]}
            downward = old.get("reported") and any(new_counts.get(key, 0) < value for key, value in old_counts.items())
            lineup_changed = old.get("reported") and set(old_counts) != set(new_counts)
            if downward or lineup_changed or review:
                notice = {"detectedAt": checked_at, "previousCandidates": copy.deepcopy(old["candidates"]),
                          "newCandidates": copy.deepcopy(new["candidates"]), "previousSourceAsOf": old.get("asOf"),
                          "sourceAsOf": new.get("asOf"), "previousBodySha256": old.get("bodySha256"), "bodySha256": body_hash,
                          "reason": review["reason"] if review else "Publisher-native record revised downward or candidate lineup changed"}
                if review:
                    notice["revisionReview"] = review
                history.append(notice)
        if history:
            new["correctionHistory"] = history
            new["correction"] = copy.deepcopy(history[-1])
        prepared[race_id] = new
    return prepared


def update_national(snapshot, loader=shared.fetch, checked_at=None, reviewed_revisions=None, offices=None):
    """Reuses prior correction history, atomic component rollback and review guard."""
    offices = list(offices or CONFIG)
    validate_national_records(snapshot)
    assessments = {}
    prepared_records = {}
    checked_at = checked_at or shared.instant()
    reviews = reviewed_revisions or []
    prior_sources = dict(shared.SOURCES)
    prior_parsers = dict(shared.PARSERS)
    for office in offices:
        source_id, url, _, _ = CONFIG[office]
        shared.SOURCES[source_id] = url
        def parse(body, catalog, office=office, source_id=source_id):
            result = parse_component(body, catalog, office)
            assessments[source_id] = result["assessment"]
            prepared_records[source_id] = reviewed_native_records(snapshot, result["records"], source_id,
                hashlib.sha256(body).hexdigest(), checked_at, reviews)
            return result
        shared.PARSERS[source_id] = parse
    source_ids = [CONFIG[office][0] for office in offices]
    try:
        output = shared.update(snapshot, source_ids, loader, checked_at, reviewed_revisions)
    finally:
        # Keep a library invocation from changing the old updater's CLI defaults.
        for source_id in source_ids:
            if source_id in prior_sources:
                shared.SOURCES[source_id] = prior_sources[source_id]
            else:
                shared.SOURCES.pop(source_id, None)
            if source_id in prior_parsers:
                shared.PARSERS[source_id] = prior_parsers[source_id]
            else:
                shared.PARSERS.pop(source_id, None)
    for source_id, assessment in assessments.items():
        health = output["resultHealth"][source_id]
        health["coverage"] = assessment
        if "error" not in health and not health.get("matchedRaceIds"):
            retained = any(race["results"].get("available") and race["results"].get("sourceId") == source_id for race in output["races"])
            health["status"] = "retained-unreported" if retained else "quarantined" if assessment["positiveRaceCount"] else "unreported"
        health["sourceAuthority"] = AUTHORITY
        health["attribution"] = "civicAPI (civicapi.org)"
        health["termsUrl"] = TERMS
    records = output.setdefault("nationalResultRecords", {})
    for record in records.values():
        # Upgrade additive link metadata from a validated earlier native table.
        record.setdefault("detailUrl", record["sourceRaceUrl"])
    for source_id in source_ids:
        health = output["resultHealth"][source_id]
        if "error" not in health:
            records.update(prepared_records.get(source_id, {}))
            for race_id, record in records.items():
                if record.get("sourceId") == source_id and race_id not in prepared_records.get(source_id, {}):
                    record["fetchHealth"] = {"status": "retained-absent", "checkedAt": checked_at,
                                             "reason": "Prior contest absent from incoming publisher component; prior source table retained"}
        else:
            for record in records.values():
                if record.get("sourceId") == source_id:
                    record["fetchHealth"] = {"status": "retained-error", "checkedAt": checked_at,
                                             "reason": health["error"], "reviewRequired": health.get("reviewRequired", False)}
        health["nativeRecordCount"] = sum(record.get("sourceId") == source_id for record in records.values())
        health["nativeReportedRaceCount"] = sum(record.get("sourceId") == source_id and record.get("reported") for record in records.values())
        health["nativeStatus"] = "retained-error" if "error" in health and health["nativeRecordCount"] else "unavailable" if "error" in health else "reported" if health["nativeReportedRaceCount"] else "unreported"
    for race in output["races"]:
        if race["results"].get("sourceId") in source_ids:
            race["results"]["sourceAuthority"] = AUTHORITY
            race["results"]["attribution"] = "civicAPI (civicapi.org)"
            for notice in race["results"].get("correctionHistory", []):
                if notice.get("detectedAt") == checked_at and notice.get("reason") == "Official source count decreased; prior values retained in correction history":
                    notice["reason"] = "Publisher source count decreased; prior values retained in correction history"
            if race["results"].get("correctionHistory"):
                race["results"]["correction"] = copy.deepcopy(race["results"]["correctionHistory"][-1])
    identity = json.dumps({"races": output["races"], "resultHealth": output["resultHealth"], "nationalResultRecords": records}, sort_keys=True, separators=(",", ":"))
    output["snapshotId"] = "results-" + hashlib.sha256(identity.encode()).hexdigest()[:16]
    shared.validate_catalog(output)
    validate_national_records(output)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--offices", nargs="+", choices=list(CONFIG), default=list(CONFIG))
    parser.add_argument("--reviewed-revisions", type=Path)
    parser.add_argument("--capture-dir", type=Path, help="Replay previously preserved real source bodies; no network")
    args = parser.parse_args()
    snapshot = json.loads(args.input.read_text(encoding="utf-8"))
    reviews = json.loads(args.reviewed_revisions.read_text(encoding="utf-8")) if args.reviewed_revisions else None
    loader = shared.fetch
    if args.capture_dir:
        def loader(source_id, previous):
            office = source_id.removeprefix("civicapi-")
            body = (args.capture_dir / f"civicapi-results-{office}.body").read_bytes()
            return body, {"captureMode": "saved source replay", "bytes": len(body)}
    result = update_national(snapshot, loader, reviewed_revisions=reviews, offices=args.offices)
    shared.atomic_write(args.output, result)
    print(json.dumps({"snapshotId": result["snapshotId"], "sources": {
        source_id: {"status": result["resultHealth"][source_id]["status"],
                    "error": result["resultHealth"][source_id].get("error"),
                    "nativeRecordCount": result["resultHealth"][source_id].get("nativeRecordCount", 0),
                    "nativeReportedRaceCount": result["resultHealth"][source_id].get("nativeReportedRaceCount", 0),
                    "coverage": {key: value for key, value in result["resultHealth"][source_id].get("coverage", {}).items()
                                 if key not in ("nomineeConflicts", "identityConflicts")}}
        for source_id in [CONFIG[office][0] for office in args.offices]}}, indent=2))


if __name__ == "__main__":
    main()
