"""Fetch validated public result components; never infer calls or publish placeholder zeroes.

Publisher route (Python standard library):
  python update_results.py --input data.json --output next-data.json
Inspect without touching the app snapshot:
  python update_results.py --input data.json --probe work/result-probe.json

An unknown or rejected component retains its last good values, with resultHealth
reporting the failure separately. Repeated retrieval is not evidence of source
movement. Source-as-of is null when the source does not provide it.
"""

import argparse
import copy
import csv
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import unicodedata
import urllib.parse
import urllib.request
import zipfile


ELECTION = "2026-11-03"
SOURCES = {
    "az-official": "https://app.enhancedvoting.com/cdn/results/Arizona/export-110326GeneralElection.json",
    "nc-official": "https://s3.amazonaws.com/dl.ncsbe.gov/ENRS/2026_11_03/results_pct_20261103.zip",
    "deepsyte-results": "https://deepsyte.app/data/race-results-2026.csv",
}
PARTIES = {"D": "D", "DEM": "D", "DEMOCRAT": "D", "DEMOCRATIC": "D",
           "R": "R", "REP": "R", "REPUBLICAN": "R", "L": "L", "LIB": "L",
           "LIBERTARIAN": "L", "G": "G", "GRE": "G", "GREEN": "G",
           "I": "I", "IND": "I", "INDEPENDENT": "I", "UNA": "I",
           "OTHER": "OTHER", "OTH": "OTHER"}
MAX_BODY = 100_000_000


class InvalidResults(ValueError):
    """A component cannot be admitted safely."""


class RevisionReviewRequired(InvalidResults):
    def __init__(self, prior_as_of, incoming_as_of, body_hash):
        super().__init__("Earlier source timestamp requires reviewed revision evidence; last good values retained. Timestamp order alone does not establish which revision is correct.")
        self.review = {"previousSourceAsOf": prior_as_of, "incomingSourceAsOf": incoming_as_of,
                       "bodySha256": body_hash}


def instant():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def normalized(value):
    value = unicodedata.normalize("NFKD", str(value or ""))
    return " ".join(re.sub(r"[^a-z0-9]+", " ", value.encode("ascii", "ignore").decode().lower()).split())


def party(value):
    return PARTIES.get(str(value or "").strip().upper())


def integer(value):
    if isinstance(value, bool):
        raise InvalidResults("Boolean is not a vote count")
    if isinstance(value, str) and re.fullmatch(r"[0-9]+", value.strip()):
        value = int(value)
    if not isinstance(value, int) or not 0 <= value <= 2**53 - 1:
        raise InvalidResults("Votes must be nonnegative safe integers")
    return value


def source_time(value):
    if value is None:
        return None
    if not isinstance(value, str) or not re.match(r"^\d{4}-\d{2}-\d{2}T", value):
        raise InvalidResults("Invalid source timestamp")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise InvalidResults("Invalid source timestamp") from exc
    if parsed.tzinfo is None:
        raise InvalidResults("Source timestamp lacks timezone")
    return value


def reject_test(value):
    """Check explicit source test indicators, not arbitrary candidate names."""
    if not isinstance(value, dict):
        return
    for key, item in value.items():
        if key.lower() in {"test", "istest", "testdata", "istestdata", "istestresults", "testmode", "testelection", "isdemonstration"}:
            if item not in (False, None, 0, "false", "False", "0", ""):
                raise InvalidResults("Source explicitly identifies test data")
    if re.search(r"\b(test|demo|demonstration)\b", str(value.get("electionName", "")), re.I):
        raise InvalidResults("Election name identifies test data")
    if str(value.get("mode", value.get("resultsType", ""))).lower() in {"test", "demo", "demonstration"}:
        raise InvalidResults("Source mode identifies test data")


def catalog_race(catalog, state, office, district=None):
    matches = [race for race in catalog["races"]
               if race["state"] == state and race["office"] == office
               and race.get("district") == district and race.get("kind") == "regular"
               and race.get("stage") == "general" and race.get("electionDate") == ELECTION]
    return matches[0] if len(matches) == 1 else None


def match_choices(race, choices):
    """Exact normalized name AND party; no fuzzy, surname-only or silent zero fill.

    Unknown source choices with zero counts may be placeholders/write-ins. Any
    positive unmatched choice, duplicate choice, or missing catalog candidate
    quarantines this race. Explicit reviewed ID bindings can be added later.
    """
    by_key = {}
    for candidate in race["candidates"]:
        key = (normalized(candidate["name"]), candidate["party"])
        if key in by_key:
            raise InvalidResults("Ambiguous catalog candidate name/party")
        by_key[key] = candidate["id"]
    seen_source, votes = set(), {}
    for source_id, name, source_party, value in choices:
        value = integer(value)
        if source_id in seen_source:
            raise InvalidResults("Duplicate source choice ID")
        seen_source.add(source_id)
        candidate_id = by_key.get((normalized(name), party(source_party)))
        if candidate_id is None:
            if value:
                raise InvalidResults(f"Positive unmatched source choice: {name}")
            continue
        if candidate_id in votes:
            raise InvalidResults("Two source choices map to one catalog candidate")
        votes[candidate_id] = {"candidateId": candidate_id, "votes": value,
                               "sourceChoiceId": source_id, "sourceName": name,
                               "sourceParty": source_party}
    if set(votes) != {candidate["id"] for candidate in race["candidates"]}:
        raise InvalidResults("Catalog candidate absent or name/party not reconciled")
    return [votes[candidate["id"]] for candidate in race["candidates"]]


def component(source_id, matches, as_of, skipped):
    if not matches:
        raise InvalidResults("No nonzero, fully reconciled target races; pre-reporting zeroes are unavailable")
    return {"sourceId": source_id, "sourceUrl": SOURCES[source_id], "asOf": as_of,
            "matches": matches, "skipped": skipped}


def parse_az(body, catalog):
    try:
        data = json.loads(body)
    except (ValueError, UnicodeDecodeError) as exc:
        raise InvalidResults("Malformed Arizona JSON") from exc
    if not isinstance(data, dict) or data.get("electionDate") != ELECTION:
        raise InvalidResults("Wrong Arizona election")
    reject_test(data)
    created = source_time(data.get("createdAt"))
    if created is None:
        raise InvalidResults("Arizona documented export generation time is missing")
    # AZ's official documentation starts unofficial reporting after 8pm local
    # on Nov 3 (MST, UTC-7); a pre-opening export cannot establish reported votes.
    if created and dt.datetime.fromisoformat(created.replace("Z", "+00:00")) < dt.datetime(2026, 11, 4, 3, tzinfo=dt.timezone.utc):
        raise InvalidResults("Arizona export predates documented reporting start; unavailable")
    results = data.get("results")
    if not isinstance(results, dict) or results.get("name") != "Arizona":
        raise InvalidResults("Missing statewide Arizona aggregate")
    reject_test(results)
    items = results.get("ballotItems")
    if not isinstance(items, list) or len(items) > 5000:
        raise InvalidResults("Invalid statewide ballot items")
    matches, skipped, ids = {}, [], set()
    for item in items:
        if not isinstance(item, dict):
            raise InvalidResults("Invalid Arizona contest")
        reject_test(item)
        name = item.get("name", "")
        district = re.fullmatch(r"U\.S\. Representative in Congress - District No\. (\d+)", name)
        office = "house" if district else "governor" if name == "Governor and Lieutenant Governor" else None
        if not office:
            continue
        contest_id = str(item.get("id", ""))
        if not contest_id or contest_id in ids:
            raise InvalidResults("Duplicate/missing Arizona contest ID")
        ids.add(contest_id)
        if item.get("type") != "State" or item.get("voteFor") != 1:
            raise InvalidResults("Unsupported Arizona contest scope")
        race = catalog_race(catalog, "AZ", office, int(district[1]) if district else None)
        if race is None:
            skipped.append({"sourceContestId": contest_id, "reason": "No exact catalog contest"})
            continue
        options = item.get("ballotOptions")
        if not isinstance(options, list) or not options:
            raise InvalidResults("Missing Arizona choices")
        choices = []
        for option in options:
            if not isinstance(option, dict) or not option.get("id") or not option.get("name"):
                raise InvalidResults("Invalid Arizona choice")
            choice_name = option["name"]
            if office == "governor" and " / " in choice_name:
                # Observed official schema is Governor (PARTY) / Lieutenant (PARTY).
                choice_name = re.sub(r" \([A-Z]+\)$", "", choice_name.split(" / ", 1)[0])
            choices.append((str(option["id"]), choice_name, option.get("politicalParty"), integer(option.get("voteCount"))))
        if not sum(choice[3] for choice in choices):
            skipped.append({"sourceContestId": contest_id, "reason": "All-zero pre-reporting/empty contest"})
            continue
        try:
            votes = match_choices(race, choices)
        except InvalidResults as exc:
            skipped.append({"sourceContestId": contest_id, "reason": str(exc)})
            continue
        if race["id"] in matches:
            raise InvalidResults("Duplicate catalog contest mapping")
        matches[race["id"]] = {"votes": votes, "sourceContestId": contest_id}
    return component("az-official", matches, created, skipped)


def parse_nc(body, catalog):
    try:
        archive = zipfile.ZipFile(io.BytesIO(body))
        files = archive.infolist()
        if len(files) != 1 or files[0].filename != "results_pct_20261103.txt" or files[0].file_size > MAX_BODY:
            raise InvalidResults("Wrong NC ZIP member/size; precinct-sort files prohibited")
        text = archive.read(files[0]).decode("utf-8-sig")
    except (zipfile.BadZipFile, UnicodeDecodeError, RuntimeError) as exc:
        raise InvalidResults("Malformed NC results ZIP") from exc
    reader = csv.DictReader(io.StringIO(text, newline=None), delimiter="\t")
    required = {"County", "Election Date", "Precinct", "Contest Group ID", "Contest Name", "Choice",
                "Choice Party", "Election Day", "Early Voting", "Absentee by Mail", "Provisional", "Total Votes", "Real Precinct", "Vote For"}
    if not required.issubset(reader.fieldnames or []):
        raise InvalidResults("Unknown NC results layout")
    contests, row_ids = {}, set()
    for row in reader:
        if row.get("Election Date") != "11/03/2026":
            raise InvalidResults("Wrong NC election")
        name = row.get("Contest Name", "")
        district = re.fullmatch(r"US HOUSE OF REPRESENTATIVES DISTRICT (\d+)", name)
        office = "house" if district else "senate" if name == "US SENATE" else None
        if not office:
            continue
        if row["Real Precinct"] not in ("Y", "N") or integer(row["Vote For"]) != 1:
            raise InvalidResults("Invalid NC row scope")
        key = tuple(row[field] for field in ("County", "Precinct", "Contest Group ID", "Choice", "Choice Party"))
        if key in row_ids:
            raise InvalidResults("Duplicate NC county/precinct/contest/choice row")
        row_ids.add(key)
        methods = [integer(row[field]) for field in ("Election Day", "Early Voting", "Absentee by Mail", "Provisional")]
        total = integer(row["Total Votes"])
        if sum(methods) != total:
            raise InvalidResults("NC method totals do not reconcile")
        contest_id = row["Contest Group ID"]
        contest = contests.setdefault(contest_id, {"identity": (office, int(district[1]) if district else None), "name": name, "choices": {}})
        if contest["name"] != name:
            raise InvalidResults("NC contest group collision")
        choice = (row["Choice"], row["Choice Party"])
        contest["choices"][choice] = contest["choices"].get(choice, 0) + total
    matches, skipped = {}, []
    for contest_id, contest in contests.items():
        if not sum(contest["choices"].values()):
            skipped.append({"sourceContestId": contest_id, "reason": "All-zero pre-reporting/empty contest"})
            continue
        race = catalog_race(catalog, "NC", *contest["identity"])
        if race is None:
            skipped.append({"sourceContestId": contest_id, "reason": "No exact catalog contest"})
            continue
        choices = [(f"{name}|{source_party}", name, source_party, count)
                   for (name, source_party), count in contest["choices"].items()]
        try:
            votes = match_choices(race, choices)
        except InvalidResults as exc:
            skipped.append({"sourceContestId": contest_id, "reason": str(exc)})
            continue
        if race["id"] in matches:
            raise InvalidResults("Multiple NC groups map to one catalog contest")
        matches[race["id"]] = {"votes": votes, "sourceContestId": contest_id}
    return component("nc-official", matches, None, skipped)


def parse_publisher(body, catalog):
    """This designated export currently has outcomes/percentages, not vote counts.

    Historical primary calls must never leak into today's general-election state.
    Admit no outcomes as current calls without a separately verified call adapter.
    """
    try:
        rows = list(csv.DictReader(io.StringIO(body.decode("utf-8-sig"))))
    except (UnicodeDecodeError, csv.Error) as exc:
        raise InvalidResults("Malformed publisher CSV") from exc
    current = [row for row in rows if row.get("election_date") == ELECTION and row.get("election_type") == "general"]
    if not current:
        raise InvalidResults("Publisher export contains no current general-election records; historical outcomes excluded")
    raise InvalidResults("Publisher percentages/outcomes are not a verified current vote-count/call schema")


PARSERS = {"az-official": parse_az, "nc-official": parse_nc, "deepsyte-results": parse_publisher}


def validate_catalog(snapshot):
    if not isinstance(snapshot, dict) or snapshot.get("schemaVersion") != 1:
        raise InvalidResults("Unsupported input snapshot")
    races = snapshot.get("races")
    if not isinstance(races, list) or not 1 <= len(races) <= 2000:
        raise InvalidResults("Invalid input race list")
    ids = set()
    for race in races:
        if not isinstance(race, dict) or not isinstance(race.get("id"), str) or race["id"] in ids:
            raise InvalidResults("Invalid/duplicate input race identity")
        ids.add(race["id"])
        if not isinstance(race.get("candidates"), list) or not race["candidates"]:
            raise InvalidResults("Missing input candidates")
        candidates = {candidate["id"] for candidate in race["candidates"]}
        if len(candidates) != len(race["candidates"]):
            raise InvalidResults("Duplicate input candidate identity")
        results = race.get("results")
        if not isinstance(results, dict) or type(results.get("available")) is not bool or not isinstance(results.get("votes"), list):
            raise InvalidResults("Invalid prior results")
        seen = set()
        for entry in results["votes"]:
            candidate_id = entry.get("candidateId")
            if candidate_id not in candidates or candidate_id in seen:
                raise InvalidResults("Unknown/duplicate prior result candidate")
            seen.add(candidate_id)
            integer(entry.get("votes"))
        if not results["available"] and results["votes"]:
            raise InvalidResults("Unavailable prior result has counts")


def fetch(source_id, previous_health=None):
    now = dt.datetime.now(dt.timezone.utc)
    if source_id == "az-official" and previous_health and previous_health.get("checkedAt"):
        try:
            elapsed = (now - dt.datetime.fromisoformat(previous_health["checkedAt"].replace("Z", "+00:00"))).total_seconds()
        except (ValueError, TypeError):
            elapsed = 0
        if elapsed < 120:
            raise InvalidResults("Arizona minimum 120-second download spacing; previous attempt retained")
    request = urllib.request.Request(SOURCES[source_id], headers={"User-Agent": "MidtermDesk/0.0.0 public-results-validation"})
    with urllib.request.urlopen(request, timeout=45) as response:
        body = response.read(MAX_BODY + 1)
        if len(body) > MAX_BODY:
            raise InvalidResults("Source body exceeds bounded 100MB limit")
        return body, {"httpStatus": response.status, "contentType": response.headers.get("Content-Type"),
                      "etag": response.headers.get("ETag"), "lastModified": response.headers.get("Last-Modified"),
                      "sha256": hashlib.sha256(body).hexdigest(), "bytes": len(body)}


def reviewed_revision(source_id, prior, incoming, body_hash, reviews):
    """Operator-supplied evidence, never a field imported from the feed itself."""
    for review in reviews:
        if not isinstance(review, dict) or any(review.get(key) != value for key, value in (
                ("sourceId", source_id), ("previousSourceAsOf", prior),
                ("incomingSourceAsOf", incoming), ("bodySha256", body_hash))):
            continue
        if not all(isinstance(review.get(key), str) and 1 <= len(review[key].strip()) <= 2000
                   for key in ("reason", "reviewer", "evidenceUrl", "reviewedAt")):
            continue
        try:
            url = urllib.parse.urlsplit(review["evidenceUrl"])
        except ValueError:
            continue
        if url.scheme != "https" or not url.hostname or url.username or url.password:
            continue
        try:
            source_time(review["reviewedAt"])
        except InvalidResults:
            continue
        return copy.deepcopy(review)
    return None


def correction_history(old):
    history = copy.deepcopy(old.get("correctionHistory", []))
    if not isinstance(history, list):
        raise InvalidResults("Invalid existing correction history; cannot discard lineage")
    # Preserve a pre-history-version compatibility notice rather than losing it.
    if old.get("correction") and (not history or history[-1] != old["correction"]):
        history.append(copy.deepcopy(old["correction"]))
    return history


def update(snapshot, source_ids, loader=fetch, checked_at=None, reviewed_revisions=None):
    validate_catalog(snapshot)
    output = copy.deepcopy(snapshot)
    checked_at = checked_at or instant()
    health = output.setdefault("resultHealth", {})
    reviews = reviewed_revisions or []
    if not isinstance(reviews, list) or len(reviews) > 100:
        raise InvalidResults("Reviewed revisions must be an explicit list of at most 100 records")
    for source_id in source_ids:
        previous = copy.deepcopy(health.get(source_id, {}))
        metadata = {}
        try:
            body, metadata = loader(source_id, previous)
            metadata = {**metadata, "sha256": hashlib.sha256(body).hexdigest()}
            parsed = PARSERS[source_id](body, output)
            prior_clocks = [previous.get("sourceAsOf"), (previous.get("lastGood") or {}).get("sourceAsOf")]
            prior_clocks.extend(race["results"].get("asOf") for race in output["races"]
                                if race["results"].get("sourceId") == source_id and race["results"].get("available"))
            known_clocks = [clock for clock in prior_clocks if clock is not None]
            prior_clock = max(known_clocks, key=lambda clock: dt.datetime.fromisoformat(source_time(clock).replace("Z", "+00:00"))) if known_clocks else None
            revision_review = None
            if prior_clock and parsed["asOf"] and dt.datetime.fromisoformat(parsed["asOf"].replace("Z", "+00:00")) < dt.datetime.fromisoformat(prior_clock.replace("Z", "+00:00")):
                revision_review = reviewed_revision(source_id, prior_clock, parsed["asOf"], metadata["sha256"], reviews)
                if revision_review is None:
                    raise RevisionReviewRequired(prior_clock, parsed["asOf"], metadata["sha256"])
            source_matches = []
            for race in output["races"]:
                match = parsed["matches"].get(race["id"])
                if match is None:
                    continue
                old = race["results"]
                if old.get("available") and old.get("sourceId") not in (None, source_id):
                    raise InvalidResults("Competing source for existing race requires explicit review")
                correction = bool(old.get("available") and any(
                    entry["votes"] < next((item.get("votes", 0) for item in old["votes"] if item.get("candidateId") == entry["candidateId"]), 0)
                    for entry in match["votes"]))
                new = {"available": True, "sourceId": source_id, "sourceUrl": SOURCES[source_id],
                       "sourceContestId": match["sourceContestId"], "asOf": parsed["asOf"],
                       "bodySha256": metadata["sha256"],
                       "checkedAt": checked_at, "status": "unofficial", "votes": match["votes"],
                       "call": old.get("call"), "certification": old.get("certification")}
                history = correction_history(old)
                if correction or revision_review:
                    notice = {"detectedAt": checked_at,
                              "reason": revision_review["reason"] if revision_review else "Official source count decreased; prior values retained in correction history",
                              "previousVotes": copy.deepcopy(old["votes"]), "newVotes": copy.deepcopy(match["votes"]),
                              "previousSourceAsOf": old.get("asOf"), "sourceAsOf": parsed["asOf"],
                              "previousBodySha256": old.get("bodySha256"), "bodySha256": metadata["sha256"]}
                    if revision_review:
                        notice["revisionReview"] = revision_review
                    history.append(notice)
                if history:
                    new["correctionHistory"] = history
                    new["correction"] = copy.deepcopy(history[-1])
                race["results"] = new
                source_matches.append(race["id"])
            health[source_id] = {"status": "validated-partial", "checkedAt": checked_at,
                                 "sourceAsOf": parsed["asOf"], "sourceUrl": SOURCES[source_id],
                                 "matchedRaceIds": source_matches, "skipped": parsed["skipped"],
                                 "observedChange": bool(previous.get("sha256") and previous["sha256"] != metadata.get("sha256")),
                                 "sourceClockAssessment": "reviewed-regression" if revision_review else "unknown" if parsed["asOf"] is None else "no-regression-observed",
                                 "note": "Validated unofficial matched races only; source movement is not a freshness guarantee", **metadata}
        except Exception as exc:
            # Roll back this component atomically; another valid source may still update.
            for race in output["races"]:
                original = next(item for item in snapshot["races"] if item["id"] == race["id"])
                if race.get("results", {}).get("sourceId") == source_id:
                    race["results"] = copy.deepcopy(original["results"])
            retained = any(race["results"].get("available") and race["results"].get("sourceId") == source_id
                           for race in output["races"])
            health[source_id] = {"status": "retained-error" if retained else "unavailable",
                                 "checkedAt": checked_at, "sourceUrl": SOURCES[source_id], "error": str(exc),
                                 "lastGood": previous.get("lastGood") or (previous if previous.get("matchedRaceIds") else None), **metadata}
            if isinstance(exc, RevisionReviewRequired):
                health[source_id]["reviewRequired"] = True
                health[source_id]["pendingRevision"] = exc.review
    output["generatedAt"] = checked_at
    output["sourceAsOf"] = None  # National source time is not synchronized.
    canonical = json.dumps({"races": output["races"], "resultHealth": health}, sort_keys=True, separators=(",", ":"))
    output["snapshotId"] = "results-" + hashlib.sha256(canonical.encode()).hexdigest()[:16]
    validate_catalog(output)
    return output


def atomic_write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temp = handle.name
    os.replace(temp, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=Path(__file__).with_name("data.json"))
    destination = parser.add_mutually_exclusive_group(required=True)
    destination.add_argument("--output", type=Path)
    destination.add_argument("--probe", type=Path, help="Isolated probe snapshot path; never alters input")
    parser.add_argument("--sources", nargs="+", choices=list(SOURCES), default=None,
                        help="Explicit list uses the narrow legacy updater; omission runs the coordinated pipeline")
    parser.add_argument("--reviewed-revisions", type=Path,
                        help="Operator-reviewed revision records bound to source, clocks and exact body SHA256")
    args = parser.parse_args()
    target = args.probe or args.output
    if args.probe and target.resolve() == args.input.resolve():
        parser.error("Probe destination must differ from input snapshot")
    snapshot = json.loads(args.input.read_text(encoding="utf-8"))
    reviews = json.loads(args.reviewed_revisions.read_text(encoding="utf-8")) if args.reviewed_revisions else None
    if args.sources is None:
        from update_pipeline import run_cli_pipeline
        output = run_cli_pipeline(snapshot, target, input_path=args.input, probe=bool(args.probe), reviewed_revisions=reviews)
    else:
        output = update(snapshot, args.sources, reviewed_revisions=reviews)
    atomic_write(target, output)
    print(json.dumps({"output": str(target), "snapshotId": output["snapshotId"],
                      "sources": {key: {"status": value["status"], "error": value.get("error"), "matches": len(value.get("matchedRaceIds", []))}
                                  for key, value in output["resultHealth"].items()}}, indent=2))


if __name__ == "__main__":
    # All lazy pipeline imports must share this module's registries/classes.
    sys.modules.setdefault("update_results", sys.modules[__name__])
    main()
