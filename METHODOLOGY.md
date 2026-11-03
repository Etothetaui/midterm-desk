# Reading Midterm Desk

Counts, forecasts, polls and scenarios answer different questions. A forecast favorite or a numerical leader is not a race call. No unavailable number is replaced with zero.

## Forecasts and control

The attributed forecast provider is [Polling Forecast](https://www.pollingforecast.com/us/data). Its published state-contest output covers 435 House districts,35 Senate races and36 governor races. The app retains the provider's modeled candidate names, margin,80% simulated range,polling blend and forecast date. Candidate-name disagreements remain visible. Unmodeled candidates have no invented odds. Same-party seats describe party ownership, not the named nominee's individual victory chance.

The provider's [method](https://www.pollingforecast.com/us/method) combines adjusted polling with fundamentals and correlated-error simulations. The source's main-candidate simulation frequency is a model estimate. A conditional complement is labeled when a named Democratic/Republican pair is modeled. It does not assign minor candidates zero real-world chance. The model has not been independently replicated by Midterm Desk.

House control needs218 voting seats. The provider's Senate control convention needs51 Democratic seats or50 Republican seats because the Republican vice president breaks ties. Independents who have not committed to a caucus can hold the balance. Do not add independent winners automatically to a party.

Chamber summaries and weekly history use the publisher's [rendered history table](https://www.pollingforecast.com/us/history). Dates before September29 are reconstructed using today's code/candidates; later rows are recorded snapshots. Race exports and national history can have different source dates, both displayed. A website retrieval time does not make an older forecast current.

## Polls

Only relevant general-election questions with a compatible named candidate field enter the race polling views. Primary/hypothetical mismatches are excluded with diagnostic counts. A poll may contain multiple question variants or ranked-choice rounds: the table preserves its question and response categories. Do not treat variants as independent surveys.

Raw published shares remain on their reported denominator; they may round above/below100. The provider's adjusted decided-vote polling margin is shown separately. Its number of polls used can differ from this app's raw admitted record count. Charts show observations, not an invented confidence interval. Date, population, sample, sponsor, source and corrections accompany each record. A missing or inapplicable subgroup sample stays unknown.

Provenance grades identify where the provider transcribed a poll: A original release,B commissioning outlet,C Wikipedia compilation. They are not accuracy grades. An original-release check by this app is labeled separately. Four previously checked national observations remain a separate evidence collection; they are not silently overwritten by the broader feed.

## Counts and election-night arithmetic

Direct official Arizona and North Carolina feeds retain their individual validation. The [civicAPI](https://civicapi.org/api-documentation) national publisher feeds are a separate attributed source. The app keeps original publisher names and IDs in separate result tables when an exact canonical candidate join is not established. A conflicting name, party or stage cannot put votes onto another candidate. Zero-filled pre-reporting feeds remain unreported. Provider calls, official certification and numerical leads are distinct.

Outstanding-vote calculations require a known or explicitly assumed remaining-vote amount. They are arithmetic scenarios, not a probability or an estimate that all remaining ballots favor one side. Reporting precinct percentages cannot be substituted for the percentage of votes counted.

Historical county maps show 2020/2024 presidential results, not2026 returns. Geography and election years are labeled; unjoined areas stay unavailable. Boundaries are not evidence of current congressional district lines. Source estimates, user assumptions and annotations are labeled separately.

## Reuse and publication

Forecast output is CC BY4.0 with credit to Polling Forecast. Wikipedia-derived polling figures are CC BY-SA4.0, credited to Wikipedia contributors through the provider and linked source records; normalized polling tables retain those terms.Historical county figures use Tony McGovern’s MIT-licensed compilation; original source links and its required copyright notice are retained. Census-based map redistribution and its ISC notice are retained. See [data-source notes](./DATA-SOURCES.md).

Every source update pushed to the repository requires a new software version and a change entry, appropriate validation and a descriptive commit. Versioned releases retain their predecessor. Scheduled data publications do not make source commits: their distinct snapshot, source dates, hashes and workflow identity identify the data revision. No paid subscription, account bridge or embedded personal credential is required.

## Voter and ballot evidence

Official Arizona and North Carolina voting-method tables are extracted from the same downloaded response as their admitted count totals, and must reconcile candidate by candidate. Early, Election Day, mail and provisional votes are components of the total, never added to it twice. No method table is published from an all-zero template.

The AP/SSRS 2026 Voter Poll is a survey, not an official count or a win probability. Public findings are expected from 5 p.m. Eastern; candidate cross-tabs are time-gated by poll closing. Its [API requires an entitled key](https://developer.ap.org/ap-elections-api/docs/Voter_Poll.htm), so no proprietary feed is claimed or bypassed. The board links public election coverage and clearly labels the absence of a connected free cross-tab dataset.
