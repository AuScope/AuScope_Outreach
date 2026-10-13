# NVCL harvest (`scripts/nvcl/`)

Weekly pipeline behind `NVCL_Map.html` (the drill-core map embedded on
auscope.org.au/nvcl) and the NVCL layers of `index.html`. Ported on
2026-10-13 from `bvkay/AuScope_doi_tracker` (`src/nvcl/`, commit `f680d83d`)
and owned by this repo from then on: no script or workflow here reads from
doi_tracker, so changes there cannot break these maps. The counting method is
in [`METHODOLOGY.md`](METHODOLOGY.md) (merged-v1.2, TSG-first).

## What runs when

`.github/workflows/nvcl-harvest.yml`, Sundays 20:33 UTC (Monday 06:33 AEST),
plus manual dispatch. Node 22, built-ins only (no `npm install`).

| Step | Script | Fails the run? |
|---|---|---|
| 1 | `thredds-catalog.js` - list what the NCI TSG mirror holds per state (names, sizes, modified dates) and stamp cache rows the mirror no longer lists | no (continue-on-error; warns) |
| 2 | `tsg-enrich.js --max-new=150` - read TSG headers of newly mirrored archives | no (continue-on-error; warns) |
| 2b | `tsg-enrich.js --backfill-identity --max-new=400 --max-minutes=60` - read the identity block of archives read before it was parsed | no (continue-on-error; warns) |
| 2c | `coords.js` - classify each cached header position, validate it against the WFS collars, write `header-positions.json` | no (continue-on-error; warns) |
| 3 | `harvest.js` - WFS + `getDatasetCollection` on all 8 nodes, TSG matching, snapshot | **yes** |
| 4 | `write-map-data.js` - map feeds from the snapshot | **yes** |
| 5 | commit by explicit path, `git pull --rebase`, push (3 tries) | **yes** |

Any failure opens (or comments on) a `Pipeline failure: Weekly NVCL harvest`
issue. **Why the rebase:** the hourly earthquake and status bots push to
`main` throughout this job, which can run for hours, so `main` has nearly
always moved since checkout and a plain push would be rejected. The files
never overlap, so rebasing onto the new `main` is always clean.

When step 1, 2, 2b or 2c fails, a last step (`if: always()`, keyed on those steps'
`outcome`, since `continue-on-error` makes their conclusion a success)
comments a warning on the same issue, or opens it, and the run stays green.
The harvest works without either step, but a catalogue or enrichment that
fails every week would otherwise go unnoticed behind the green tick. The
same warning fires when `map_summary.json` `stale_states` is not empty or
any node in `nvcl_stats.json` is `degraded` (a step after step 4 reads both
back): a state on carried-forward figures is by design, but it must not
stay that way unseen for weeks.

## Inputs and outputs

| Path | Written by | Role |
|---|---|---|
| `data/nvcl/thredds-catalog.json` | step 1 | archive names per state on the mirror, each with its size and modified date (reconciliation, map link sizes, re-read queue) |
| `data/nvcl/tsg-cache.jsonl` | steps 2 and 2b (step 1 stamps `gone`) | one line per mirrored archive: scan interval, scan date + confidence, instrument, TSG UUID, and the `[dbextra]` identity and position fields (`identityFetchedAt` says when those were read; older rows get them from step 2b). Durable; re-read only when the mirror's file is newer than the read |
| `data/nvcl/header-positions.json` | step 2c (which also stamps `headerLat`, `headerLng`, `headerPosClass`, `headerPosZone`, `headerPosHow` on cache rows) | header-position classes by state, their validation against WFS collars, and the class/state pairs accepted for placing a hole |
| `data/nvcl/boreholes.jsonl` | step 3 (always) | every borehole coordinate ever read; a down node is drawn from here |
| `data/nvcl_stats.json` | step 3 | canonical per-state snapshot (the 80% guard and carry-forward read it) |
| `data/nvcl/boreholes-detail.jsonl` | step 3 | one line per WFS borehole: its datasets and matched TSG archives (raw evidence); plus one per THREDDS-only hole (`provisional`, `source: "thredds"`) |
| `data/nvcl_history.jsonl` | step 3 | one line per run |
| `data/map_boreholes.json`, `map_timeline.json`, `map_summary.json` | step 4 | read by `NVCL_Map.html` |
| `data/nvcl_<state>.geojson` (8) | step 4 | read by `index.html`; every registered borehole, same property names as before |

Upstream: the eight NVCL node services (CSIRO, NSW, NT, QLD, SA, TAS, VIC,
WA; endpoints in `harvest.js` and in the snapshot's `endpoints` block) and
`thredds.nci.org.au/thredds/catalog/rs07/` (collection DOI
10.25914/bztg-rg43). All fetching happens here, never in the browser.

## How the map chooses what it shows (`write-map-data.js`)

- **Which boreholes:** coordinates plus evidence (an API dataset or a
  matched TSG archive). Key `(state, id)`, sorted by state then id. The id
  is the WFS identifier after the node's `.../borehole/` base, so it can
  hold a `/` (NT `1654228_82/1`, WA `LONDDH1/94`); see *Changed* below.
  Plus the THREDDS-only holes: archives on the mirror that no node lists,
  placed from their TSG header (id: the header's drillhole name, else the
  archive name).
- **p:** `'t'` on a THREDDS-only hole, whose position comes from its TSG
  header; absent otherwise. `NVCL_Map.html` adds "(position from TSG
  header)" to its popup. `map_summary.json` `provisional_holes` counts them
  by state and reason (`orphan`: the node answered and does not list the
  hole; `node_unreachable`: the node was down or degraded) and lists per
  state the holes left unplaced for want of an accepted position. They
  count in the timeline and km like any other hole, and are left out of the
  geojson files (those list registered holes).
- **month** (first scan): TSG header scan date (confidence `high`/`good`),
  else the TSG `Created :` date, else the node's date (ScanDate, else
  createdDate, which is an ingest date). Every TSG tier outranks the API,
  as METHODOLOGY.md requires: where both exist the API date is later in
  689 of 690 boreholes, by a median of 99 months. Months before 2002-01 or after the
  harvest month are not scan months: the next tier is tried, and a borehole
  with no usable month keeps its row without one (`undated`, not drawn).
  `month_source` says `tsg` or `api`.
- **v** (HyLogger 1-4): the instrument string, TSG header first, parsed with
  the rules of the retired `build_fact_table.py` (including the v6-to-3 typo
  fix, applied to HyLogger strings only). Otherwise `null`, with
  `instrument_label` when the type is known (a HyChips keeps its recorded
  name, e.g. `HyChips 6-3`, rather than becoming a HyLogger 3 dot).
- **depth_m:** unique scanned metres (union of intervals, TSG first), never
  drilled length; `null` when no interval was recorded.
- **z, mb** (popup link): the TSG archive behind the hole's first scan
  (earliest TSG scan date among its matched archives, ties by name), as the
  file name without `.zip`, and its size in whole MB (10^6 bytes): the
  catalogue's `dataSize` from `thredds-catalog.json` when it has one, else
  `tsg-cache.jsonl` `zipBytes` (omitted when neither is known). Only
  archives the current `thredds-catalog.json` lists are linked, and a state
  with no listing gets no links at all. `NVCL_Map.html` builds
  `https://thredds.nci.org.au/thredds/fileServer/rs07/<Subpath>/<z>.zip`
  with the case-sensitive subpaths `SA`, `Tas`, `WA`, `NT`, `Qld`, `Vic`.
- **Timeline** is computed from the final rows, so the counters always match
  the dots.
- **Stale nodes** (unreachable or degraded this run) keep their previous map
  rows and geojson file and are listed in `map_summary.json` `stale_states`.
  Their THREDDS-only rows are the exception: this run's replace the
  previous run's, so an archive mirrored during an outage reaches the map.
- **Per-state carry-forward:** a state whose fresh rows come to fewer than
  90% of its rows on the live map, and at least 10 rows fewer, keeps its
  live rows and geojson file instead, with `by_state[].status` `carried`,
  and is listed in `stale_states` (VIC's 29 holes losing 3 is 10%, but not
  a collapse). To accept a drop deliberately, run the writer with
  `NVCL_REBASELINE=1`: no state is carried by this rule and the 95%
  national check is skipped, both logged. One state collapsing is treated
  as a measurement fault (a dataset service failing a share of its
  queries, a matching rule gone wrong) rather than published. More than two states carried in one run
  fails it. `NVCL_Map.html` names every state in `stale_states` in its
  footer with the date it was last refreshed (`by_state[].fetched`).
- **Guards** (exit 1, nothing written): more than two states carried by the
  90% rule, a negative scanned length on a freshly harvested borehole, a
  state on the live map missing from the new one, fewer than 95% of the live
  map's boreholes, a month out of range, fewer than 6 states, a duplicate
  key, a row without coordinates, or a detail file from a different run than
  the snapshot. Rows carried forward (from a stale node or by the 90% rule)
  are the only ones sanitised rather than failed on: an out-of-range month
  is dropped and a negative depth becomes `null`.

## Running locally

```bash
node scripts/nvcl/thredds-catalog.js          # ~10 s
node scripts/nvcl/tsg-enrich.js --max-new=10  # a few minutes; --dry-run lists only
node scripts/nvcl/tsg-enrich.js --backfill-identity --max-new=50 --max-minutes=10
node scripts/nvcl/coords.js                   # seconds; header positions + validation
node scripts/nvcl/harvest.js                  # 20-60 min, all 8 nodes
node scripts/nvcl/write-map-data.js           # seconds
```

Every script resolves its paths from its own location, so any working
directory works. Then serve the repo (`python3 -m http.server`) and open
`NVCL_Map.html` and `index.html`.

| Env flag | Script | Effect |
|---|---|---|
| `NVCL_ONLY=TAS,CSIRO` | harvest | harvest only these nodes (others are carried forward by the map writer) |
| `NVCL_OUT_DIR=/tmp/x` | harvest, write-map-data | write everything there instead of `data/` (the live map stays the guard baseline) |
| `NVCL_FORCE=1` | harvest | bypass the health guard (deliberate rebaseline only) |
| `NVCL_REBASELINE=1` | write-map-data | accept a drop: no 90% per-state carry-forward, no 95% national check (logged) |
| `NVCL_TRACE=1` | harvest | stack trace on a fatal error |
| `NVCL_TSG_STATES`, `NVCL_TSG_MAX_NEW`, `NVCL_TSG_CACHE` | tsg-enrich | states, budget, cache path |

## What was ported, changed and left behind

Kept as in doi_tracker: the 8-node WFS harvest (single-request first, NT's
unfiltered patient paging, now sorted and reconciled; see below), per-borehole `getDatasetCollection`, TSG
matching and precedence (TSG interval and TSG date first), the garbage
clamp, the union rule, the borehole coordinate cache and carry-forward, the
mirror reconciliation and mirror-only figures, and the health guard (>= 5
nodes and >= 80% of the previous snapshot's boreholes-with-data).

Changed:

- Paths: `src/nvcl/` -> `scripts/nvcl/`; `nvcl-stats.json` ->
  `nvcl_stats.json`; `nvcl-history.jsonl` -> `nvcl_history.jsonl`.
- User-Agent: the `config.json` mailto is replaced by
  `AuScope-Outreach NVCL harvester (+https://github.com/AuScope/AuScope_Outreach)`.
- New TSG match tier `local-name` (lowest precedence): VIC's `LOCAL-<hole>`
  names now join their `<hole>.zip` archives, which no doi_tracker tier
  could; this restores 13 of VIC's 29 boreholes. Worth upstreaming.
- Retry pass in `harvest.js`: dataset queries that failed under 8-way
  concurrency get one quieter pass (2 in flight, 30 s timeout, 15 min budget
  per node). On 2026-10-13 QLD failed 160 of 587 queries that all answered
  in ~3 s one at a time; without the pass ~60 QLD boreholes would drop off
  the map in a different combination every week.
- Per-node dataset concurrency: QLD runs 4 queries in flight instead of 8
  (`concurrency` on its node entry). At 8 its service failed 154 of 587
  queries three times each on 2026-10-13 (all answered on the retry pass)
  and the main pass took about 27 of its 40 minutes. At 4, later the same
  day, 18 failed (all recovered) and the whole node took under 18 minutes.
- Dataset pass budget: the main `getDatasetCollection` pass gets 40 minutes
  per node. A node that runs out is logged (`DATASET PASS BUDGET SPENT`),
  its unqueried holes count as failed queries, it gets no retry pass, and
  it is marked degraded (figures carried forward, coordinates fresh), so a
  service that hangs without failing cannot run the job into its
  300-minute timeout.
- Borehole id rule: the id is the WFS identifier with the node's
  `.../resource/feature/<ns>/borehole/` base removed, not its last `/`
  segment. doi_tracker cut at the last `/`, so NT holes named `82/1`,
  `NTGS00/1`, `NTGS99/1` all became id `1`, seven WA `LONDDH<n>/94` holes
  became `94`, each overwrote the last, and 14 holes with data vanished from
  the map. The full id is also what `getDatasetCollection` answers to
  (`LONDDH1/94` returns datasets, `94` returns none). Ids without a `/` are
  unchanged. Cached rows under a truncated id are dropped the first time the
  node answers with the full one (their `firstSeen` passes to the row of the
  same name). TSG matching was already separator-blind (`82/1` meets
  `1654228_82_1.zip`, `LONDDH1/94` meets `LONDDH1-94.zip`).
- TSG matching assigns each archive to at most one borehole. The tiers run
  in order across the whole node: an archive matched at one tier is never
  matched again at a weaker one, and one that two holes claim at the same
  tier goes to neither (it counts as mirror-only). The suffix tiers
  (`name-suffix`, `id-suffix`) also refuse an archive whose leading number
  is another hole's feature number, or is not the hole's own when it has
  one, and a generic suffix (under 5 characters, or letters-then-digits
  like `DDH1`, `BD2`, `BDH3`) matches only a hole whose whole normalised
  name it is. doi_tracker matched hole by hole, so NT's two `DDH1` holes
  each took six other holes' `NN_DDH1.zip` archives and SA 139115 `DDH 1`
  took `72812_DDH1.zip` from SA 72812: ten archives counted twice, with
  their metres, and the wrong first-scan month on the borrowing hole.
- Mirror-only no longer double counts. It counted every archive the
  harvest could not attach to a hole, and most belonged to holes already
  on the map, measured from their API interval: of 248.77 km (743
  archives) on 2026-10-13, 184.52 km was that double count (160.25 km in
  QLD), 16.07 km was archives gone from the mirror and 38.34 km was NT
  holes past the old paging horizon. With the UUID join, the paging fix
  and the catalogue reconciliation it is 9.85 km (37 archives, 43 holes),
  and `national_measured_km` went from 2,115.96 to 1,921.33 km.
- NT's borehole list is paged in a stable order and checked against the
  node's own count. NT ignores the `nvclCollection` filter, so all of its
  ~329,000 BoreholeView features are paged unfiltered. doi_tracker paged
  them unsorted and stopped at the first page holding fewer features than
  it asked for, but NT pages in rows and a hole with several rows is one
  feature, so a full page can come back short (the page at 200,000 held
  9,940) and the harvest stopped at about 210,000. Every hole past that was
  missing: 20 of NT's 41 NVCL holes with a `/` in their name, and the owners
  of nine mirrored archives (six `NN_DDH1.zip`, `8708941_DDH3`,
  `8750821_DDH3`, `8724181_DDH2`). Now the pages are WFS 2.0 with
  `sortBy=gsmlp:identifier ASC`, `startIndex` advances by the rows asked
  for, only an empty page ends the loop, and the features paged are
  reconciled against `resultType=hits`: below 98% the node is marked
  degraded (figures carried forward). The count comes from page 0's
  `numberMatched` (the separate unfiltered hits request, about 50 s, is
  made only when page 0 lacks it). The node's own count of NVCL holes is
  checked too, by a WFS 1.1.0 `resultType=hits` POST with an OGC XML filter
  `gsmlp:nvclCollection = 'true'` (NT ignores the CQL form, not this one:
  718 in 39 s): below 98% of it in NVCL holes paged also degrades the
  node. The snapshot records the coverage in the state's `wfs_paging`
  (`nvcl_paged`, `nvcl_reported`).
- TSG archives join node datasets by UUID first. The TSG header's `UUID`
  (cached as `tsgUuid`) is the same value as the node's
  `getDatasetCollection` `DatasetID`, which the harvest now keeps (`id` on
  each dataset in `boreholes-detail.jsonl`). A new top tier `uuid` gives an
  archive to the hole that lists its UUID as a dataset, before any name
  tier can claim it; it is additive, so the hole still takes its
  unpublished archives (a wedge, an older run) by name. Most UUIDs are
  written 35 characters long (one digit short of a GUID) on both sides and
  some of both carry all 36, so both are lower-cased and cut to 35. This
  joins archives no name rule could, such as QLD's `BlueBush_BBDD51.zip`
  for hole `bh076416`. Where the node links a dataset to a different hole
  than the archive's name does, the node wins: SA lists `131277_INL06.zip`
  and `131278_INL07.zip` under hole 131276 (`INL 5`, 7.7 m drilled), whose
  own archive they continue (6.2-6.7, 6.7-7.2, 7.2-7.7 m) and which `INL 6`
  (5.5 m drilled) could not hold. On 2026-10-13 the node won seven such
  conflicts: SA 131277, 131278, 131281 and 134154 lost their only archive
  to a neighbouring hole the node lists it under, WA `79/9D1` and `79/9D2`
  swapped archives (each lists the other's dataset), and TAS 13978 took
  `13968_BB-BH1_Bell_Bay.zip`, filed under a feature number that is not on
  TAS's NVCL list.
  `nvcl_stats.json` records per state `tsg_match_tiers` (archives per
  tier, holes by first tier). Also in matching: within a name
  tier, when exactly one claimant reaches an archive by its whole name and
  the rest only by a prefix, the whole-name claimant takes it instead of
  the archive being declared ambiguous.
- `tsg-enrich.js` also parses the `[dbextra]` identity fields
  (`drillholeName`, `holeService`, `datasetName`, `collar`, `drillDate`,
  `ntrays`, `nsamples`, `traypicsLogId`, `traythumbsLogId`, `mospicLogId`,
  `imageLogId`) and the header's position (`lat lon`, `geo datum`: raw
  `latRaw`/`lonRaw`/`geoDatum`, with `coordStatus` `zeroed` or `absent`
  when there is nothing to read) into the cache row, and stamps
  `identityFetchedAt`. Rows read before 2026-10-13 get them from
  `--backfill-identity`, which re-reads ONLY the identity block: a HEAD,
  the 64 KB tail (EOCD, and the central directory when it lies inside the
  tail; ZIP64-aware) and the first 32 KB of the `.tsg` entry, inflated
  with a sync flush so the cut deflate stream decodes as far as it goes.
  `[description]` and `[dbextra]` end 2-3.5 KB into the entry in every
  header sampled; a header whose `[dbextra]` is not closed within 32 KB is
  read again at four times the length. About 97 KB per archive. Order
  TAS, NT, QLD, SA, WA, VIC; `--max-minutes` stops it cleanly at a wall
  clock cap, keeping what it read. A row whose header has no drillhole
  name is not asked twice (`identityFetchedAt`), and within a state the
  archives the last harvest joined to no hole go first. NCI answered at
  7.7 s an archive at three in flight on 2026-10-13 (each request 4-6 s on
  its own), not the 1.5-3 s expected, so the first 75-minute run read 584
  archives (all 504 of TAS, 80 of NT; 55 MB) and the weekly step is capped
  at 60 minutes. Two comments
  were also corrected: the `Depth (m)` lines sit in `[band headers]` and
  `lat lon =` in `[dbextra]` (there is no `[borehole]` block). A range
  request answered with the whole file (a server ignoring `Range`) is
  refused before its body is read.
- THREDDS-only holes (added 2026-10-13). State survey services are down
  often, and a hole belongs on the map if either the survey or the mirror
  can place it. `coords.js` classifies each cached header's `lat lon` /
  `geo datum`: `decimal` (lat -45 to -9, lon 111 to 155, inside the
  state's box), `decimal_swapped` and `decimal_sign` (axes reversed, minus
  sign dropped), `mga_explicit` (zone named in `geo datum`, e.g.
  `GDA94_MGA54`; inverse transverse Mercator on GRS80), `mga_inferred`
  (no zone: every zone the state spans is tried, a single in-state answer
  is used, several are settled by the median collar of the hole's project
  neighbours when at least 3 are placed and the nearest answer is within
  50 km), `swapped` (northing first), `zeroed`, `absent`, `unresolved`
  (including whole degrees such as `-30 134`, a placeholder). It checks
  every row whose archive joined a hole against that hole's WFS collar and
  writes median and p95 distance per class and state to
  `header-positions.json`; a class/state pair whose p95 exceeds 5 km places
  nothing (with fewer than 5 rows to judge by, the class's national verdict
  applies). `harvest.js` groups the archives that joined no hole by the
  header's drillhole name and emits each group with an accepted position as
  a provisional hole, reason `orphan` or `node_unreachable`. The MGA
  northing floor is 5,000,000, not 6,000,000: Tasmania lies at 5.16-5.62
  million (TAS `GL14_25` reads `5340643 382466`).
- A `drillhole` TSG match tier (second, after `uuid`, and additive like
  it): the header's `[dbextra]` drillhole name is the node's own hole id
  (QLD `bh080912`, TAS `82799`, NT `8618203_NTGS83/5`), so an archive finds
  its hole without the node's datasets, and a THREDDS-only hole is joined
  to its WFS record, and leaves the provisional list, the first run the
  node lists it. Copied headers (one UUID in several datasets) are not in
  its index, and it obeys the suffix tiers' feature-number rule.
- A node down or degraded keeps its holes' archives. Its holes come from
  the coordinate cache with no datasets (or most queries failed), so the
  `uuid` tier is blind; the previous run's detail file stands in for it
  (tier `prev`), the other tiers run as usual, and only archives no hole
  has ever held become THREDDS-only (`node_unreachable`). The coordinate
  cache now keeps each hole's feature numbers for the same reason. In a
  simulated TAS outage with the previous attribution removed as well, the
  `drillhole` tier alone joined the archives of 478 of TAS's 482 holes.
- `map_summary.json` carries `spectra_measured`, nationally and per state
  in `by_state`: for every dataset of the boreholes on the map, the largest
  `SpectralLog` `sampleCount` the node reports (each log of a dataset is a
  product of the same measurements, so they are not summed), i.e. the
  sample positions a spectrum was recorded at. Holes known only from a TSG
  archive add nothing; a held state keeps its previous figure.
- The TSG cache is reconciled against the live NCI catalogue each run.
  `thredds-catalog.js` now keeps each archive's catalogue `dataSize` (in
  bytes) and `modified` date, and for every state whose catalogue it read
  stamps cache rows whose archive is no longer listed `gone: <date>`, with
  `successor: <name>` when a listed archive carries the same TSG UUID (a
  rename); a row whose archive returns loses both. The row stays, as the
  record of a scan, and the map links none. A row with a successor is
  neither matched nor counted (its successor carries the scan). One with
  no successor still measures its hole (changed later on 2026-10-13): it
  is matched, and its date and interval count for the hole it joins, but
  it is never linked, never counted as mirror-only and never placed as a
  hole of its own; `boreholes-detail.jsonl` marks it `gone: true`. Dropping
  those had taken the only archive from 12 holes, and NT `7963228_MURD013`
  and `8418381_BND1`, with no node datasets either, off the map. Eleven
  more are an old copy of a hole's live archive under another UUID
  (`7853531_LBD1 OLD.zip`, WA `BBDD0001_hole2.zip`): the union leaves
  their hole's metres as they were, but `total_scan_km`, which sums
  rescans, counts them (+3.9 km of 1,926 offline on 2026-10-13), and an
  older copy can give its hole an earlier month. On
  2026-10-13 that was 115 of 5,610 rows (88 renamed, with a successor), 62
  of them among the rows previously counted as mirror-only. Rows
  sharing a TSG UUID and a scan interval are one dataset: matched, claimed
  and counted once,
  through a representative that lists the others as `twins` in
  `boreholes-detail.jsonl`. The cache held 96 groups of rows sharing a UUID
  (98 surplus rows). In the 93 that record an interval it is the same in
  every row, and most were a renamed archive and its old name, so once the
  old names are gone 2 such groups remain among the live rows
  (`8471153_CCD09` and `_Old`; `Mundubbera1` and `_Old_Problematic`). The
  other 3 have no interval and are one header copied into several holes'
  archives (NT `8440883_Baldwin1`, `8440896_MacIntyre1`, `8445494_Ross_1`):
  they are never grouped, and their shared UUID joins nothing in the `uuid`
  tier, so each still goes to its own hole by name.
  `tsg-enrich.js` re-queues a row whose archive's catalogue `modified` date
  is later than its `fetchedAt` (1,192 rows on 2026-10-13, 1,112 of them
  WA), at the lowest priority: only `--max-new` budget left after every new
  archive goes to them.
  `nvcl_stats.json` records `tsg_cache.gone_rows`, `tsg_cache.uuid_twin_rows`
  and per state `tsg_cache_rows_gone`.
- Catalogue shrink guard: `thredds-catalog.js` does not believe a state's
  listing with fewer than 80% of the names its previous snapshot held. That
  state keeps its previous entry, flagged with `error`, its cache rows are
  not reconciled (a truncated listing would otherwise stamp a share of its
  archives gone), and the script exits 1 at the end, so the workflow's
  warning issue fires. A genuine shrink has to be accepted by hand: remove
  the state's entry from `thredds-catalog.json` and run it again.
- A `data/nvcl_stats.json` that exists but does not parse stops the harvest
  before it starts (exit 1), instead of being treated as a first run with
  the 80% check skipped.
- HyChips instruments are labelled with the name their TSG file records
  (`instrument_label`, e.g. `HyChips 6-3`), never converted to a HyLogger
  generation by the v6-to-3 typo fix, which applies to HyLogger strings only.
- `harvest.js` also keeps the descriptive WFS fields (elevation, drilling
  method, drill end date, purpose) and TSG meta (drill date, project, owner)
  that `index.html` popups show, and writes `boreholes-detail.jsonl`.
- `thredds-catalog.js` keeps a state's previous entry when its catalogue
  fails, and both it and `tsg-enrich.js` exit 1 on upstream failure (the
  workflow tolerates it, the step still shows red, and the warning step
  comments on the issue).

Left behind, because nothing in this repo uses them: the `docs/nvcl-data.json`
page feed and its dot array, seeding the coordinate cache from that feed,
`config.json`, the `src/stats.js` / `src/dashboard.js` steps and dashboards,
the instrument fleet table, the bulk-upload detector, and everything about
DOIs, publications and software.

Replaced: `scripts/scrape_nvcl.py` and `nvcl-backup.yml` (the retired
"conservative scraper": first dataset only, no TSG, silently dropped nodes
that timed out) and the hand-built May 2026 map files.
