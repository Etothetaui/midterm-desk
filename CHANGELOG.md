# Changes

## v0.1.3-dev — November 3, 2026

Add a news ticker above the page header. Incoming validated vote totals, civicAPI projections/withdrawals, AP public announcements, candidate corrections and polling/model changes generate attributed headlines. A new publication without changed totals is labeled explicitly; routine checks never masquerade as new votes. Preserve all existing sources and features. The ticker scrolls on new updates, retains the latest40 headlines with source links and receipt times, supports stopping motion and reduced-motion preferences, and holds incoming display changes behind the dashboard's existing Pause/Resume controls. Preserve published results and AP observation history when upgrading from v0.1.2-dev.

## v0.1.2-dev — November 3, 2026

Add a free AP public-announcement monitor while preserving every existing source and feature. Pin AP's verified Bluesky identity, classify only unambiguous current-election winner announcements, retain source links/publication times and observation history, and label partial coverage. Check from the open browser and during the existing publication pipeline. Separate observed AP announcements from civicAPI projections, forecasts, counts and certification. Preserve last-good observations on failures and across upgrades; missing posts do not retract calls. Queue AP display updates behind Pause/Resume. Synthetic parser and preservation tests supplement the existing regression suite; no genuine positive AP announcement has yet been admitted in the pre-close source capture.

## v0.1.1-dev — November 3, 2026

Fix the clean-checkout publication check: analytical tests create their temporary workspace independently, without relying on development capture directories or test order. Verify all 70 JavaScript and 87 Python checks from an isolated source-only checkout. Preserve validated results from both prior development versions during software upgrades. The v0.1.0-dev source commit was retained, but its hosted packaging check prevented deployment; this patch completes that release.

## v0.1.0-dev — November 3, 2026

Substantive election analysis and election-night tools, following v0.0.0-dev.

- Add attributed statewide and district forecasts, modeled candidate win frequencies, projected margins, 80% ranges and polling/fundamental context.
- Add general-election polling histories, raw response comparisons, population/date/scale controls and original-source corrections.
- Add chamber-control probabilities, historical control trends, competitive-race discovery, comparative race tables and scenario seeding/swing tools.
- Add national publisher result intake with separate source-native candidate tables and explicit reconciliation conflicts; retain direct official adapters and last good counts.
- Add Big Board maps, historical county comparisons and outstanding-vote arithmetic. Coverage and data assumptions are displayed beside the tools.
- Preserve source-provenance grades, reuse terms, source timestamps and missing-data distinctions. Separate party ownership in same-party contests from individual win odds.
- Add analytical input validation, version-upgrade result retention and release-documentation gates.

Coverage:514contests and1,432candidate records;506attributed state-contest forecasts;1,506compatible race polls across139races, plus5flagged original Atlas observations. Atlas coverage includes19race observations and1national question from11original public surveys. National generic workbench includes232observations with the four earlier original-checked corrections preserved. Native national result intake covers506state contests; eight supplementary feeds and unmodeled candidate probabilities remain unavailable.

The coordinated existing updater refreshes official counts/methods, national publisher records and analytics once per source. Publication runs all70Node and87Python checks plus version/catalog/analysis gates. Browser checks cover core race, comparison, scenario, map, pause and sampled responsive views. Current real captures are pre-reporting; all-zero templates do not establish turnout, calls or positive-count accuracy. Exit-poll API access is licensed; public coverage links are provided without a proprietary integration.

Candidate corrections add Maine independent Rick Bennett and Louisiana Democrat Antonio Wilson, preserve official No Party labels, and correct Darline Graham’s current incumbent flag. Joint territorial governor tickets are visible. Release packaging rejects synthetic exercise snapshots and preserves the original v0.0.0-dev release.

## v0.0.0-dev — November 3, 2026

First public release: nationwide race catalog, candidate/fundraising comparison, geographic tiles, four checked national polls, watchlist, isolated scenarios, Arizona/North Carolina result adapters and GitHub Pages publication. Its polling, forecast and national result coverage was insufficient for the intended complete tracker; v0.1.0-dev addresses those gaps.
