"""Official AZ/NC counts and voting-method tables from one fetch per source.

Use this in place of a separate immediate AZ/NC update_results.py invocation:
  python update_vote_methods.py --input next-data.json --output next-data.json

All original result-admission and clock-review gates remain in update_results.
This wrapper reuses the exact downloaded bytes for methods, avoiding an extra
Arizona request. No county subtotals are added to a statewide aggregate.
"""

import argparse
import copy
import csv
import hashlib
import io
import json
from pathlib import Path
import re
import zipfile

import update_results as shared


SOURCE_IDS = ("az-official", "nc-official")
NC_METHODS = ["Election Day", "Early Voting", "Absentee by Mail", "Provisional"]
GENERIC_WRITEINS = {"write in", "write in miscellaneous", "unassigned write in", "unofficial write in"}


def method_table(race, choices, headers, source_id, as_of, body_hash, checked_at):
    """Choices are (source ID, name, party, total, method-count mapping)."""
    known = {(shared.normalized(candidate["name"]), candidate["party"]) for candidate in race["candidates"]}
    for _, name, party, total, methods in choices:
        if (shared.normalized(name), shared.party(party)) not in known and (total or shared.normalized(name) not in GENERIC_WRITEINS):
            raise shared.InvalidResults("Unreconciled named method candidate; no hidden inventory filtering")
        if set(methods) != set(headers) or sum(methods.values()) != total:
            raise shared.InvalidResults("Method counts do not reconcile with source choice total")
    votes = shared.match_choices(race, [choice[:4] for choice in choices])
    if not sum(vote["votes"] for vote in votes):
        raise shared.InvalidResults("All-zero method data is unreported")
    expected = {vote["candidateId"]: vote["votes"] for vote in race["results"]["votes"]}
    if {vote["candidateId"]: vote["votes"] for vote in votes} != expected:
        raise shared.InvalidResults("Method source differs from admitted official count snapshot")
    by_source = {str(choice[0]): choice for choice in choices}
    rows, candidate_methods = [], []
    candidates = {candidate["id"]: candidate for candidate in race["candidates"]}
    for vote in votes:
        choice = by_source[vote["sourceChoiceId"]]
        candidate = candidates[vote["candidateId"]]
        rows.append([candidate["name"], candidate["party"], *[choice[4][label] for label in headers], vote["votes"]])
        candidate_methods.append({"candidateId": vote["candidateId"], "sourceChoiceId": vote["sourceChoiceId"],
                                  "sourceName": choice[1], "sourceParty": choice[2], "methods": choice[4], "totalVotes": vote["votes"]})
    return {"headers": ["Candidate", "Party", *headers, "Total"], "rows": rows,
            "candidateMethods": candidate_methods, "sourceId": source_id, "sourceUrl": shared.SOURCES[source_id],
            "asOf": as_of, "checkedAt": checked_at, "bodySha256": body_hash, "reported": True,
            "status": "unofficial", "geographicScope": "selected contest aggregate; methods already included in Total",
            "sourceClockAssessment": "unknown" if as_of is None else "source-generation-time"}


def extract_az(body, snapshot, checked_at):
    data = json.loads(body)
    items = {str(item["id"]): item for item in data["results"]["ballotItems"]}
    digest = hashlib.sha256(body).hexdigest()
    tables, errors = {}, []
    for race in snapshot["races"]:
        result = race["results"]
        if not result.get("available") or result.get("sourceId") != "az-official" or result.get("bodySha256") != digest:
            continue
        try:
            item = items[result["sourceContestId"]]
            choices, labels = [], None
            for option in item["ballotOptions"]:
                groups = option.get("groupResults")
                if not isinstance(groups, list) or not 1 <= len(groups) <= 30:
                    raise shared.InvalidResults("Missing/bounded Arizona voting groups required")
                methods = {}
                for group in groups:
                    if not isinstance(group, dict) or not isinstance(group.get("groupName"), str) or not 1 <= len(group["groupName"]) <= 100 or group["groupName"] in methods:
                        raise shared.InvalidResults("Invalid/duplicate Arizona method label")
                    if type(group.get("isFromVirtualPrecinct")) is not bool:
                        raise shared.InvalidResults("Unknown Arizona virtual-precinct marker")
                    methods[group["groupName"]] = shared.integer(group.get("voteCount"))
                if labels is None:
                    labels = list(methods)
                name = option["name"]
                if race["office"] == "governor" and " / " in name:
                    name = re.sub(r" \([A-Z]+\)$", "", name.split(" / ", 1)[0])
                choices.append((str(option["id"]), name, option.get("politicalParty"), shared.integer(option["voteCount"]), methods))
            tables[race["id"]] = method_table(race, choices, labels, "az-official", shared.source_time(data.get("createdAt")), digest, checked_at)
        except (shared.InvalidResults, KeyError, TypeError, ValueError) as exc:
            errors.append({"raceId": race["id"], "reason": str(exc)})
    return tables, errors


def extract_nc(body, snapshot, checked_at):
    digest = hashlib.sha256(body).hexdigest()
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        text = archive.read("results_pct_20261103.txt").decode("utf-8-sig")
    contests, row_ids = {}, set()
    for row in csv.DictReader(io.StringIO(text, newline=None), delimiter="\t"):
        if row["Election Date"] != "11/03/2026":
            raise shared.InvalidResults("Wrong NC method election")
        name = row["Contest Name"]
        if name != "US SENATE" and not re.fullmatch(r"US HOUSE OF REPRESENTATIVES DISTRICT \d+", name):
            continue
        key = tuple(row[field] for field in ("County", "Precinct", "Contest Group ID", "Choice", "Choice Party"))
        if key in row_ids or row["Real Precinct"] not in {"Y", "N"}:
            raise shared.InvalidResults("Duplicate/invalid NC method row")
        row_ids.add(key)
        methods = {label: shared.integer(row[label]) for label in NC_METHODS}
        if sum(methods.values()) != shared.integer(row["Total Votes"]):
            raise shared.InvalidResults("NC row method/total mismatch")
        choices = contests.setdefault(row["Contest Group ID"], {})
        choice_key = (row["Choice"], row["Choice Party"])
        choice = choices.setdefault(choice_key, {label: 0 for label in NC_METHODS})
        for label, value in methods.items():
            choice[label] += value  # Every real AND administrative row exactly once.
    tables, errors = {}, []
    for race in snapshot["races"]:
        result = race["results"]
        if not result.get("available") or result.get("sourceId") != "nc-official" or result.get("bodySha256") != digest:
            continue
        try:
            choices = [(f"{name}|{party}", name, party, sum(methods.values()), methods)
                       for (name, party), methods in contests[result["sourceContestId"]].items()]
            tables[race["id"]] = method_table(race, choices, NC_METHODS, "nc-official", None, digest, checked_at)
        except (shared.InvalidResults, KeyError) as exc:
            errors.append({"raceId": race["id"], "reason": str(exc)})
    return tables, errors


def validate_vote_methods(snapshot):
    shared.validate_catalog(snapshot)
    for race in snapshot["races"]:
        table = race["results"].get("voteMethods")
        if table is None:
            continue
        if not isinstance(table, dict) or table.get("sourceId") not in SOURCE_IDS or table.get("sourceUrl") != shared.SOURCES[table["sourceId"]] or table.get("reported") is not True:
            raise shared.InvalidResults("Invalid vote-method provenance")
        if not isinstance(table.get("bodySha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", table["bodySha256"]):
            raise shared.InvalidResults("Invalid vote-method body identity")
        shared.source_time(table.get("asOf"))
        if table["sourceId"] == "nc-official" and table.get("asOf") is not None:
            raise shared.InvalidResults("NC voting-method source time must remain unknown")
        if not shared.source_time(table.get("checkedAt")):
            raise shared.InvalidResults("Missing vote-method check time")
        headers, rows = table.get("headers"), table.get("rows")
        if (not isinstance(headers, list) or not 4 <= len(headers) <= 33 or headers[:2] != ["Candidate", "Party"]
                or headers[-1] != "Total" or any(not isinstance(label, str) or not 1 <= len(label) <= 100 for label in headers)
                or len(set(headers)) != len(headers) or not isinstance(rows, list) or len(rows) != len(race["candidates"])):
            raise shared.InvalidResults("Invalid voting-method table shape")
        if not race["results"]["available"] or race["results"].get("sourceId") != table["sourceId"] or race["results"].get("bodySha256") != table.get("bodySha256"):
            raise shared.InvalidResults("Method table not bound to admitted count body")
        votes = {vote["candidateId"]: vote["votes"] for vote in race["results"]["votes"]}
        for candidate, row in zip(race["candidates"], rows):
            if not isinstance(row, list) or len(row) != len(headers) or row[:2] != [candidate["name"], candidate["party"]]:
                raise shared.InvalidResults("Invalid method row identity")
            for value in row[2:]:
                if type(value) is not int:
                    raise shared.InvalidResults("Method count is not a normalized integer")
                shared.integer(value)
            if sum(row[2:-1]) != row[-1] or row[-1] != votes.get(candidate["id"]):
                raise shared.InvalidResults("Method total disagrees with admitted candidate votes")
        if not sum(row[-1] for row in rows):
            raise shared.InvalidResults("All-zero method table cannot be reported")
        shared.correction_history(table)
    return True


def update_vote_methods(snapshot, loader=shared.fetch, checked_at=None, reviewed_revisions=None, source_ids=None):
    """Run existing official count gates, then attach same-body method tables."""
    validate_vote_methods(snapshot)
    checked_at = checked_at or shared.instant()
    source_ids = list(source_ids or SOURCE_IDS)
    if any(source_id not in SOURCE_IDS for source_id in source_ids):
        raise shared.InvalidResults("Unsupported voting-method source")
    if len(set(source_ids)) != len(source_ids):
        raise shared.InvalidResults("Duplicate method source; avoid repeated official requests")
    captures = {}
    def cached_loader(source_id, previous):
        body, metadata = loader(source_id, previous)
        captures[source_id] = body
        return body, metadata
    output = shared.update(snapshot, source_ids, cached_loader, checked_at, reviewed_revisions)
    for source_id in source_ids:
        health = output["resultHealth"][source_id]
        if "error" in health:
            health["voteMethods"] = {"status": "retained-error" if any(race["results"].get("voteMethods") for race in output["races"] if race["results"].get("sourceId") == source_id) else "unavailable", "reason": health["error"]}
            continue
        try:
            tables, errors = (extract_az if source_id == "az-official" else extract_nc)(captures[source_id], output, checked_at)
            for race in output["races"]:
                table = tables.get(race["id"])
                if table is None:
                    continue
                old_race = next(previous for previous in snapshot["races"] if previous["id"] == race["id"])
                old = old_race["results"].get("voteMethods") or snapshot.get("resultHealth", {}).get(source_id, {}).get("voteMethods", {}).get("lastGood", {}).get(race["id"], {})
                history = shared.correction_history(old)
                prior_cells = {(row[0], row[1], label): value for row in old.get("rows", []) for label, value in zip(old.get("headers", [])[2:], row[2:])}
                new_cells = {(row[0], row[1], label): value for row in table["rows"] for label, value in zip(table["headers"][2:], row[2:])}
                if old and any(new_cells.get(key, 0) < value for key, value in prior_cells.items()):
                    history.append({"detectedAt": checked_at, "previousRows": copy.deepcopy(old["rows"]), "newRows": copy.deepcopy(table["rows"]),
                                    "previousSourceAsOf": old.get("asOf"), "sourceAsOf": table["asOf"],
                                    "previousBodySha256": old.get("bodySha256"), "bodySha256": table["bodySha256"],
                                    "reason": "Official voting-method counts revised downward"})
                if history:
                    table["correctionHistory"] = history
                    table["correction"] = copy.deepcopy(history[-1])
                race["results"]["voteMethods"] = table
            health["voteMethods"] = {"status": "validated-partial" if tables else "unavailable", "matchedRaceIds": list(tables), "errors": errors}
            failed_ids = {error["raceId"] for error in errors}
            last_good = copy.deepcopy(snapshot.get("resultHealth", {}).get(source_id, {}).get("voteMethods", {}).get("lastGood", {}))
            last_good.update({race["id"]: copy.deepcopy(race["results"]["voteMethods"]) for race in snapshot["races"] if race["id"] in failed_ids and race["results"].get("voteMethods")})
            for race_id in tables:
                last_good.pop(race_id, None)
            if last_good:
                health["voteMethods"]["lastGood"] = last_good
        except (shared.InvalidResults, KeyError, ValueError, TypeError, zipfile.BadZipFile) as exc:
            health["voteMethods"] = {"status": "unavailable", "reason": str(exc)}
    validate_vote_methods(output)
    identity = json.dumps({"races": output["races"], "resultHealth": output["resultHealth"], "nationalResultRecords": output.get("nationalResultRecords", {})}, sort_keys=True, separators=(",", ":"))
    output["snapshotId"] = "results-" + hashlib.sha256(identity.encode()).hexdigest()[:16]
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--sources", choices=SOURCE_IDS, nargs="+", default=list(SOURCE_IDS))
    parser.add_argument("--reviewed-revisions", type=Path)
    parser.add_argument("--capture-dir", type=Path, help="Replay preserved results-az.body / results-nc.body")
    args = parser.parse_args()
    loader = shared.fetch
    if args.capture_dir:
        def loader(source_id, previous):
            body = (args.capture_dir / ("results-az.body" if source_id == "az-official" else "results-nc.body")).read_bytes()
            return body, {"captureMode": "saved source replay"}
    snapshot = json.loads(args.input.read_text(encoding="utf-8"))
    reviews = json.loads(args.reviewed_revisions.read_text(encoding="utf-8")) if args.reviewed_revisions else None
    output = update_vote_methods(snapshot, loader, reviewed_revisions=reviews, source_ids=args.sources)
    shared.atomic_write(args.output, output)
    print(json.dumps({"snapshotId": output["snapshotId"], "methodRaceCount": sum(bool(race["results"].get("voteMethods")) for race in output["races"])}))


if __name__ == "__main__":
    main()
