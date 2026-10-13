# NVCL harvest (`scripts/nvcl/`)

Weekly pipeline behind `NVCL_Map.html` (the drill-core map embedded on
auscope.org.au/nvcl) and the NVCL layers of `index.html`. Ported on
2026-10-13 from `bvkay/AuScope_doi_tracker` (`src/nvcl/`, commit `f680d83d`)
and owned by this repo from then on: no script or workflow here reads from
doi_tracker, so changes there cannot break these maps. The counting method is
in [`METHODOLOGY.md`](METHODOLOGY.md) (merged-v1.2, TSG-first).

## What runs when

`.github/workflows/nvcl-harvest.yml`, Sundays 20:33 UTC (Monday 06:33 AEST),
plus manual dispatch. Node 20, built-ins only (no `npm install`).

| Step | Script | Fails the run? |
|---|---|---|
| 1 | `thredds-catalog.js` - list what the NCI TSG mirror holds per state | no (continue-on-error) |
| 2 | `tsg-enrich.js --max-new=150` - read TSG headers of newly mirrored archives | no (continue-on-error) |
| 3 | `harvest.js` - WFS + `getDatasetCollection` on all 8 nodes, TSG matching, snapshot | **yes** |
| 4 | `write-map-data.js` - map feeds from the snapshot | **yes** |
| 5 | commit by explicit path, `git pull --rebase`, push (3 tries) | **yes** |

Any failure opens (or comments on) a `Pipeline failure: Weekly NVCL harvest`
issue. **Why the rebase:** the hourly earthquake and status bots push to
`main` throughout this job, which can run for hours, so `main` has nearly
always moved since checkout and a plain push would be rejected. The files
never overlap, so rebasing onto the new `main` is always clean.

## Inputs and outputs

| Path | Written by | Role |
|---|---|---|
| `data/nvcl/thredds-catalog.json` | step 1 | archive names per state on the mirror (reconciliation) |
| `data/nvcl/tsg-cache.jsonl` | step 2 | one line per mirrored archive: scan interval, scan date + confidence, instrument. Durable; never re-read |
| `data/nvcl/boreholes.jsonl` | step 3 (always) | every borehole coordinate ever read; a down node is drawn from here |
| `data/nvcl_stats.json` | step 3 | canonical per-state snapshot (the 80% guard and carry-forward read it) |
| `data/nvcl/boreholes-detail.jsonl` | step 3 | one line per WFS borehole: its datasets and matched TSG archives (raw evidence) |
| `data/nvcl_history.jsonl` | step 3 | one line per run |
| `data/map_boreholes.json`, `map_timeline.json`, `map_summary.json` | step 4 | read by `NVCL_Map.html` |
| `data/nvcl_<state>.geojson` (8) | step 4 | read by `index.html`; every registered borehole, same property names as before |

Upstream: the eight NVCL node services (CSIRO, NSW, NT, QLD, SA, TAS, VIC,
WA; endpoints in `harvest.js` and in the snapshot's `endpoints` block) and
`thredds.nci.org.au/thredds/catalog/rs07/` (collection DOI
10.25914/bztg-rg43). All fetching happens here, never in the browser.

## How the map chooses what it shows (`write-map-data.js`)

- **Which boreholes:** coordinates plus evidence (an API dataset or a
  matched TSG archive). Key `(state, id)`, sorted by state then id.
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
- **Timeline** is computed from the final rows, so the counters always match
  the dots.
- **Stale nodes** (unreachable or degraded this run) keep their previous map
  rows and geojson file and are listed in `map_summary.json` `stale_states`.
- **Guards** (exit 1, nothing written): a state on the live map missing from
  the new one, fewer than 95% of the live map's boreholes, a negative depth, a
  month out of range, fewer than 6 states, a duplicate key, a row without
  coordinates, or a detail file from a different run than the snapshot.

## Running locally

```bash
node scripts/nvcl/thredds-catalog.js          # ~10 s
node scripts/nvcl/tsg-enrich.js --max-new=10  # a few minutes; --dry-run lists only
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
| `NVCL_TRACE=1` | harvest | stack trace on a fatal error |
| `NVCL_TSG_STATES`, `NVCL_TSG_MAX_NEW`, `NVCL_TSG_CACHE` | tsg-enrich | states, budget, cache path |

## What was ported, changed and left behind

Kept as in doi_tracker: the 8-node WFS harvest (single-request first, NT's
unfiltered patient paging), per-borehole `getDatasetCollection`, TSG
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
- `harvest.js` also keeps the descriptive WFS fields (elevation, drilling
  method, drill end date, purpose) and TSG meta (drill date, project, owner)
  that `index.html` popups show, and writes `boreholes-detail.jsonl`.
- `thredds-catalog.js` keeps a state's previous entry when its catalogue
  fails, and both it and `tsg-enrich.js` exit 1 on upstream failure (the
  workflow tolerates it; the step still shows red).

Left behind, because nothing in this repo uses them: the `docs/nvcl-data.json`
page feed and its dot array, seeding the coordinate cache from that feed,
`config.json`, the `src/stats.js` / `src/dashboard.js` steps and dashboards,
the instrument fleet table, the bulk-upload detector, and everything about
DOIs, publications and software.

Replaced: `scripts/scrape_nvcl.py` and `nvcl-backup.yml` (the retired
"conservative scraper": first dataset only, no TSG, silently dropped nodes
that timed out) and the hand-built May 2026 map files.
