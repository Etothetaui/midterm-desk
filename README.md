# Midterm Desk

**v0.1.2-dev** · A source-grounded desk for the November 3, 2026 U.S. midterms.

Explore every state House seat, Senate contest and state governor contest, plus delegate and territorial governor contests in separate denominators. The catalog contains 514 contest records with source-attributed candidate inventories. Browse the race board and geographic tiles, compare candidates and reported finances, inspect individual polling, save a local watchlist, and build a clearly separate hypothetical seat scenario.

## Evidence and coverage

Contest-catalog completeness is distinct from an independent official-ballot audit. Candidate inventories are publisher compilations with original-source links and recorded corrections; the independent nationwide candidate audit remains incomplete. Known conflicts are corrected with preserved provenance. See [data sources](DATA-SOURCES.md).

Reported vote counts, media calls, certification, polls and scenarios are separate. Missing counts remain unavailable. Pre-reporting templates do not produce invented zero-vote results. Official Arizona and North Carolina adapters retain their strict reconciliation. The free civicAPI publisher integration supplies separate native records for506state contests and on-demand county detail. Candidate/stage conflicts remain visible; source-native counts never silently join to a different candidate. Eight supplementary delegate/territorial contests have no connected national feed. Numerical leaders never create calls.

The four checked national generic-ballot observations retain field dates, population, sample basis and correction history. They do not supply enough compatible organizations for the declared descriptive average; the app shows individual observations instead. Candidate fundraising is reported receipts, not spending or voter support.

## Polls, forecasts and Big Board tools

Attributed Polling Forecast estimates cover the voting state contests. Inspect the modeled matchup, win frequency, projected margin/80%range, polling/fundamentals and method. General-election poll observations retain dates, populations, sponsors, raw shares and provenance. Original AtlasIntel public releases preserve exact decimals and valid-vote/first-choice distinctions. Unmodeled candidates and name conflicts stay explicit.

Compare House/Senate control odds, seat ranges and history. Discover competitive races, compare up to four races, save a watchlist or seed a separate hypothetical margin-shift scenario. The Big Board adds state/county maps, historical2020/2024comparisons, county-return loading, pan/zoom, fullscreen, annotations and exact outstanding-vote arithmetic. Remaining-vote amounts require a source or an explicit user assumption. Missing exit-poll or ballot-method figures are not invented.

See [methods](METHODOLOGY.md), [changes](CHANGELOG.md) and [data rights](DATA-SOURCES.md).

## Updates

AP is an additional free source alongside civicAPI and the official adapters. The app checks AP's verified public Bluesky announcements directly about once a minute while open; the publication updater also records them. Only unambiguous current-election winner statements matching the catalog are marked, with an original-post link and publication time. **This is partial public-announcement coverage, not the comprehensive AP Elections feed.** AP may announce other calls or corrections elsewhere; no matching post does not mean uncalled. Failures retain earlier supported observations. Announcements do not certify results or replace other publishers' calls. Live positive classification remains unverified until a genuine current-election announcement is admitted; synthetic parser cases are tested separately. Pause holds displayed AP observations and queues new ones until Resume.

GitHub Actions attempts publication every five minutes and on main-branch changes. Scheduling and source availability are best-effort; neither a successful page check nor a new publication time establishes fresh votes. Source-as-of, check time and publication identity stay distinct. A failed source retains its last good data. Earlier source timestamps require explicit provenance review; correction histories remain attached. The browser checks the published snapshot each minute, with Pause/Cancel/Resume controls.

`version.json` records the exact content hashes, source commit, snapshot identity and workflow run for the deployed artifact. It does not claim every candidate has been independently audited.

## Run locally

Serve this directory with a static HTTP server, then open index.html. No package installation or build framework is needed. The app uses project-relative assets and no embedded credentials, analytics or geolocation.

```text
python -m http.server 8000
node --test model.test.mjs carry_forward.test.mjs analysis.test.mjs big-board.test.mjs ap-source.test.mjs
python -m unittest discover -s . -p "test_update*.py"
node verify_release.mjs
node make_release.mjs --data data.json --out work/site
```

The coordinated updater prepares a separate candidate snapshot, refreshes all supported public sources and writes analytics health:

```text
python update_results.py --input data.json --output work/next-data.json
```

Validate that output through the app model before publishing. Preserve the previous published result components on subsequent runs; the included workflow handles this. Do not shorten a source's permitted polling interval or insert provider keys into the client.

For isolated UI exercises, `?exercise=1` exposes visibly synthetic correction/error controls. This mode does not represent election results.

## Data and reuse

Retain each source's rights and attribution. Original ballots, publisher text and graphics are not relicensed by this repository. Designated public data exports and source facts are used within their stated scope; see DATA-SOURCES.md for credits, transformations and limits.

For a narrow official-source diagnostic, pass `--sources az-official nc-official`. Individual `update_vote_methods.py`, `update_national_results.py` and `refresh_analysis.py` entry points remain available. The coordinated command fetches each official source once and reuses its bytes for voting methods. The established Pages workflow runs it, and packaging verifies every adapter/view test, the exact catalog, analytics, software version and change documentation before deployment.
