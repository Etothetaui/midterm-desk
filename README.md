# Midterm Desk

**v0.0.0-dev** · A source-grounded desk for the November 3, 2026 U.S. midterms.

Explore every state House seat, Senate contest and state governor contest, plus delegate and territorial governor contests in separate denominators. The catalog contains 514 contest records with source-attributed candidate inventories. Browse the race board and geographic tiles, compare candidates and reported finances, inspect individual polling, save a local watchlist, and build a clearly separate hypothetical seat scenario.

## Evidence and coverage

Contest-catalog completeness is distinct from an independent official-ballot audit. Candidate inventories are publisher compilations with original-source links and recorded corrections; the independent nationwide candidate audit remains incomplete. Known conflicts are corrected with preserved provenance. See [data sources](DATA-SOURCES.md).

Reported vote counts, media calls, certification, polls and scenarios are separate. Missing counts remain unavailable. The initial pre-reporting official exports contain placeholders, so they do not produce invented zero-vote results. Official Arizona and North Carolina adapters admit only fully reconciled unofficial race counts. Other contests retain source links and explicit result-coverage gaps. No win probability or race call is inferred.

The four checked national generic-ballot observations retain field dates, population, sample basis and correction history. They do not supply enough compatible organizations for the declared descriptive average; the app shows individual observations instead. Candidate fundraising is reported receipts, not spending or voter support.

## Updates

GitHub Actions attempts publication every five minutes and on main-branch changes. Scheduling and source availability are best-effort; neither a successful page check nor a new publication time establishes fresh votes. Source-as-of, check time and publication identity stay distinct. A failed source retains its last good data. Earlier source timestamps require explicit provenance review; correction histories remain attached. The browser checks the published snapshot each minute, with Pause/Cancel/Resume controls.

`version.json` records the exact content hashes, source commit, snapshot identity and workflow run for the deployed artifact. It does not claim every candidate has been independently audited.

## Run locally

Serve this directory with a static HTTP server, then open index.html. No package installation or build framework is needed. The app uses project-relative assets and no embedded credentials, analytics or geolocation.

```text
python -m http.server 8000
node --test model.test.mjs carry_forward.test.mjs
python -m unittest discover -s . -p test_update_results.py
node make_release.mjs --data data.json --out work/site
```

The updater can prepare a separate candidate snapshot:

```text
python update_results.py --input data.json --output work/next-data.json
```

Validate that output through the app model before publishing. Preserve the previous published result components on subsequent runs; the included workflow handles this. Do not shorten a source's permitted polling interval or insert provider keys into the client.

For isolated UI exercises, `?exercise=1` exposes visibly synthetic correction/error controls. This mode does not represent election results.

## Data and reuse

Retain each source's rights and attribution. Original ballots, publisher text and graphics are not relicensed by this repository. Designated public data exports and source facts are used within their stated scope; see DATA-SOURCES.md for credits, transformations and limits.
