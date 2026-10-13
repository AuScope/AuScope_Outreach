# NVCL Scan-Length Methodology (merged-v1.2)

> **Provenance (AuScope_Outreach copy).** Ported from
> `bvkay/AuScope_doi_tracker` `src/nvcl/METHODOLOGY.md` (commit `f680d83d`)
> on 2026-10-13. The text below is that document verbatim except that dashes
> follow this repo's house style (spaced hyphens). It is kept as the citable
> description of the method; this repo now runs its own copy of the code and
> does not read from doi_tracker.
>
> **Path mapping.** `src/nvcl/*.js` is `scripts/nvcl/*.js` here;
> `data/nvcl-stats.json` is `data/nvcl_stats.json`; `data/nvcl-history.jsonl`
> is `data/nvcl_history.jsonl`. `docs/nvcl-data.json`, the dashboard and the
> doi_tracker NVCL page do not exist here: this repo publishes
> `data/map_boreholes.json`, `data/map_timeline.json`,
> `data/map_summary.json` (NVCL_Map.html) and `data/nvcl_<state>.geojson`
> (index.html), built by `scripts/nvcl/write-map-data.js`.
>
> **Which sections apply here.** Everything from *Evidence precedence*
> through *The garbage clamp*, *Rescans*, *Node failures and the 80% write
> guard*, *Provenance*, *TSG enrichment tier*, *Scan dates vs ingest dates*,
> *TSG as the single source of truth*, *Verification*, *Mirror
> reconciliation*, *Mirror-only measurement* and *Carry-forward* apply to
> `data/nvcl_stats.json` as written. Not ported: the *Bulk-upload detector*
> (a doi_tracker page badge) and the *Seeding* of the borehole cache from
> `docs/nvcl-data.json`. The 482 seeded Tasmanian rows the cache arrived
> with were replaced by the live TAS answer on 2026-10-13, the first time
> this repo's harvest reached the TAS service. The
> *Estimation tier* and *Mirror-only* figures stay in the snapshot but are
> never drawn on the maps: a map borehole shows measured metres or none.
> *TSG collar coordinates* place one kind of hole only: an archive on the
> mirror that no node lists, when its header's position class is validated
> for its state against WFS collars (p95 within 5 km; `coords.js`). Such a
> hole is drawn, flagged as positioned from its TSG header, and counts in
> `nvcl_stats.json` as mirror-only exactly as before. How the map
> picks each borehole's month, instrument and metres is set out in
> `scripts/nvcl/README.md`.
>
> **Changes in this port** (each is set out, with the evidence for it, in
> `scripts/nvcl/README.md` under *What was ported, changed and left
> behind*; where they differ, the code and README describe this repo and
> the text below describes merged-v1.2 as doi_tracker ran it):
>
> - a `local-name` TSG match tier, lowest precedence, for Victoria's
>   `LOCAL-<hole>` names;
> - a quieter retry pass over dataset queries that failed under load, and a
>   40-minute per-node budget on the main dataset pass;
> - HyChips instruments labelled with their recorded name, never converted
>   to a HyLogger generation;
> - the borehole id is the WFS identifier after the node's `/borehole/`
>   base, keeping any `/` in the hole name, not its last `/` segment;
> - each TSG archive goes to at most one hole: never again at a weaker tier
>   once matched, and to neither hole when two claim it at the same tier;
>   the suffix tiers also refuse an archive filed under another hole's
>   feature number, and a generic suffix (`DDH1`, `BD2`) must be the hole's
>   whole name;
> - the map writer carries a state's previous rows forward when its fresh
>   rows fall below 90% of them by at least 10 rows (`NVCL_REBASELINE=1`
>   accepts a drop deliberately), and fails when more than two states do;
>   the workflow warns whenever a state is carried or a node degraded;
> - NT's unfiltered borehole list is paged in a stable order (sorted on the
>   identifier) until an empty page, and reconciled against the node's
>   `resultType=hits` count, and its NVCL holes against the node's own NVCL
>   count (an OGC XML filter on `nvclCollection`); below 98% of either the
>   node is marked degraded. The unsorted paging stopped at about 210,000
>   of ~329,000 features;
> - a `uuid` TSG match tier above every name tier: an archive joins the
>   hole whose `getDatasetCollection` lists its TSG UUID as a DatasetID
>   (additive: the hole still takes its other archives by name), and within
>   a name tier a whole-name hit beats a prefix hit before an archive is
>   called ambiguous;
> - `tsg-enrich.js` also caches the `[dbextra]` identity fields (drillhole
>   name, hole service, dataset name, collar, drill date, tray and sample
>   counts, image log GUIDs) and the raw `lat lon` / `geo datum` for every
>   archive it reads, and `--backfill-identity` re-reads only that block
>   (about 97 KB an archive) for rows read before 2026-10-13;
> - a `drillhole` TSG match tier after `uuid` (the header's drillhole name
>   is the node's hole id), and, while a node is down or degraded, the
>   previous run's attribution in place of the node's datasets;
> - the TSG cache is reconciled against the live NCI catalogue each run:
>   rows whose archive the mirror no longer lists are stamped `gone`; with a
>   successor (a renamed archive) they are neither matched nor counted,
>   without one they still measure their hole but are never linked or
>   counted as mirror-only; rows sharing a TSG UUID and a scan interval
>   count as one dataset; a state listing under 80% of its previous names
>   is not believed;
> - a `uuid` hit loses to the archive's feature number when the hole it
>   is filed under has no archive at all and the listing hole already holds
>   one of its own by id (SA `134154_COM25.zip` returns to 134154).
>
> **Mirror-only double counted (corrected 2026-10-13).** The *Mirror-only
> measurement* figure below counted every archive the harvest could not
> attach to a hole, and most of those archives belonged to holes already on
> the map, measured from their node's API interval. Of the 248.77 km (743
> archives) the 2026-10-13 harvest reported as mirror-only, 184.52 km (522
> archives; 160.25 km of it Queensland) was such a double count, 16.07 km
> (62 archives) came from archives no longer on the mirror, and 38.34 km
> (125 archives) belonged to NT holes beyond the old paging horizon. After
> the UUID join, the NT paging fix and the catalogue reconciliation the
> same day, mirror-only is 9.85 km (37 archives, 43 holes) and
> `national_measured_km` moved from 2,115.96 km to 1,921.33 km (-194.63
> km), while per-borehole `unique_scanned_km` rose from 1,867.19 to
> 1,911.48 km (+44.29 km, the NT holes the paging now reaches). The tables
> below are merged-v1.3's figures and are kept as they were published.
>
> **Corrections to the text below.** Two block names were wrong in
> merged-v1.2 and are corrected in place: the `Depth (m)` and `TIDL Depth
> Backup` lines sit in the `[band headers]` block, not `[coordinates]`, and
> `lat lon =` sits in `[dbextra]`; a TSG header has no `[borehole]` block
> (inventory of full headers, 2026-10-13).

Counting rules for every NVCL figure published by this repository
(`data/nvcl-stats.json`, `docs/nvcl-data.json`, the dashboard and the NVCL
page). Implemented by `src/nvcl/harvest.js`, with the TSG enrichment cache
built by `src/nvcl/tsg-enrich.js`. This document is the citable reference: if
a number appears in a report, this is how it was made.

## Evidence precedence (the one rule that governs everything)

**Depth.** TSG-measured interval **>** API-published interval **>**
drilled-length estimate.

TSG leads deliberately. The TSG header is the instrument's own record of the
interval it scanned; a node's API value is a downstream republication of the
same event. Preferring the API would measure the country two different ways - 
some states from instrument files, others from node metadata - and a national
total assembled from two definitions is not one number. The same source
already had to win for dates, where the API's value proved to be an ingest
timestamp; consistency means it wins for depth too, not only where the API is
silent.

The API stays the fallback and that matters: some boreholes are published by a
node with no archive on the mirror (NT lists 420 boreholes with data against
345 archives), so an API interval is used wherever no TSG interval exists.
Nothing is discarded - the sources swap rank, and every borehole records which
one it used.

Where both exist they agree closely: SA measures **419.6 km** from TSG headers
against **427.19 km** published by its API, a 1.8% difference. The dates were
badly wrong; the depths, at least where we can compare, are sound. The two
problems are separable, and the switch costs little accuracy while buying
consistency.

**Date.** TSG header scan date **>** node API date (which is an *ingest*
date).

Tiers are never blended. Each figure is published with its provenance, and a
lower tier is used only where every higher tier is silent.

## Headline metrics

| Metric | One-line definition |
|---|---|
| **Unique core scanned** (`unique_scanned_km`) | Kilometres of distinct borehole depth covered by at least one HyLogger scan - the union of each borehole's scan intervals, overlaps merged, then summed nationally. |
| **Total scan work** (`total_scan_km`) | Kilometres the instruments actually logged - the plain sum of every dataset's scan interval, so re-scanning the same core counts each time. |

Unique answers *"how much of Australia's core has been scanned?"* Total
answers *"how much scanning have the instruments done?"* Unique can never
exceed total. The legacy field `total_scanned_km` is retained as an alias of
`unique_scanned_km` for page compatibility (see `total_scanned_km_note` in
the output).

## The atom: per-dataset scan intervals

The unit of measure is the **scan interval `(depth_start_m, depth_end_m)` of
one dataset**, parsed from the `DepthRange` element of each borehole's
`getDatasetCollection` response on its state node. Nothing else is ever
counted as scanned length - not borehole length, not drilled depth, not
metadata claims.

An interval is **valid** when:

1. both `start` and `end` are present and numeric, and
2. `end > start`, and
3. `(end − start) ≤ 1.5 × boreholeLength_m` when the drilled length is known
   (the **garbage clamp** - see below).

## The union rule

Per borehole, `unique_scanned_m` is the length of the union of its valid
intervals: sort by start, merge overlapping or touching intervals, sum the
survivors. Two scans of the same 100 m of core contribute 100 m unique and
200 m total.

## The no-substitution rule and the unrecorded bucket

A dataset whose interval is missing or invalid contributes **zero metres**
and increments `interval_unrecorded` (per node and nationally). Borehole
length is **never** substituted for a missing scan interval. The unrecorded
count is published beside the kilometre figures so the size of the
"we cannot say" bucket is always visible - an honest zero plus a disclosed
gap, rather than a guessed number.

## The garbage clamp

An interval longer than 1.5× the drilled borehole length (when the WFS
reports one) is physically impossible and treated as metadata garbage: it is
excluded from both metrics and counted in `interval_clamped` (a disclosed
subset of `interval_unrecorded`). The 1.5 factor tolerates legitimate
inclined-hole and re-surveyed-length cases while rejecting order-of-magnitude
entry errors.

## Rescans

Re-scanning is real instrument work and is deliberately visible: it widens
the gap between total and unique. `rescan_stats` reports how many boreholes
carry more than one interval-bearing dataset and the maximum per borehole.
Rescans are never collapsed away (that would understate instrument service)
and never inflate unique coverage (the union absorbs them). `rescan_stats`
counts API-interval datasets only; multiple TSG archives on one borehole are
unioned into a single measurement rather than reported as a rescan, because
a daughter-hole archive is not the same event as a re-scan of the same core.

## Node failures and the 80% write guard

Each of the 8 public nodes is harvested independently; a down node yields
state status `unreachable` and never aborts the run. Its figures are then
*absent, not zero* - which is exactly why outputs are only written when the
run is healthy:

- at least **5 of 8 nodes** answered their WFS, **and**
- boreholes-with-data is at least **80% of the previous snapshot's count**.

Otherwise the harvester exits non-zero and the previous snapshot stays in
place. A half-blind harvest must never replace a good national figure with a
smaller one that would read as decline. (`NVCL_FORCE=1` exists for deliberate
rebaselining only.)

Victoria is a special case: it registers NVCL-flagged boreholes on its WFS
but operates no HyLogger node and no NVCLDataServices (confirmed 404), so it
is reported as `non_participating` with its registered-borehole count and
contributes no scan figures.

## Provenance

Every figure is reproducible by querying the same public services cited in
the output's `endpoints` block:

1. WFS `GetFeature` on `gsmlp:BoreholeView` with `nvclCollection='true'`
   (paged; NT's GeoServer ignores that CQL filter, so NT is paged unfiltered
   and filtered client-side) - borehole identity, location, drilled length;
2. `NVCLDataServices/getDatasetCollection.html?holeidentifier={id}` - 
   datasets, `DepthRange`, created dates, and the embedded TSG metadata
   (instrument name, scan/drill dates) plus TIR markers (`tirq` element or
   `TIR` in a log name);
3. `https://thredds.nci.org.au/thredds/catalog/rs07/{STATE}/catalog.xml` and
   the matching `fileServer` URLs - the AuScope NVCL TSG mirror on NCI,
   collection DOI **10.25914/bztg-rg43**, cited wherever a TSG-sourced figure
   appears. State subpaths are case-sensitive: `SA`, `Tas`, `WA`, `NT`,
   `Qld`, `Vic` (NSW has no mirror there).

No private databases, no manual numbers. `as_of` in every output records the
harvest date; `data/nvcl-history.jsonl` keeps one line per run so trends are
reconstructable from git history alone.

Instrument names are canonicalised (trim, collapse whitespace,
`Hylogger3-2` / `HyLogger 3.2` → `HyLogger 3-2`); unparseable or absent names
land in an explicit `Unknown` bucket rather than being dropped.

## Differences from the two retired methods

**Conservative scraper** (`AuScope_Outreach/scripts/scrape_nvcl.py`): took
only the *first* dataset's interval per borehole and zero on anything
missing. Retired because it silently discarded every additional dataset - 
understating both coverage (extra depth ranges) and instrument work
(rescans), and making dataset counts and scan kilometres inconsistent with
each other.

**Deep pipeline** (`NVCL_Metadata/2026_Update` `build_fact_table.py`): used
`scanned_length_m = depth_range` with a **fallback to borehole length** when
the depth range was missing, and summed across datasets without a union.
Retired because the fallback fabricated scan metres from drilling metadata
(a borehole can be drilled 1,000 m and scanned 50 m), and the straight sum
multiplied rescanned core into the headline coverage figure. merged-v1 keeps
its per-dataset atom but removes the substitution (unrecorded bucket instead)
and separates coverage (union) from work (sum).

## TSG enrichment tier (added merged-v1.2)

### What it is

Every TSG archive produced by the NVCL is mirrored by AuScope on NCI THREDDS
as the collection **`10.25914/bztg-rg43`** - that DOI is the citation for
every figure this tier contributes. Where a node's API is silent, the TSG
file itself is not: its header records the depth interval the instrument
scanned, the date it scanned it, the HyLogger unit used, and the TSG UUID.

`src/nvcl/tsg-enrich.js` reads those headers and caches them in
`data/nvcl/tsg-cache.jsonl`, one line per archive, keyed by `state` +
`zipName`. That file is committed: it is the durable asset, and it is what
makes the weekly run cheap.

### Technique - HTTP range requests

The archives run from 30 MB to nearly 2 GB. None is ever downloaded. Per
archive:

1. `HEAD` → size and `Accept-Ranges`;
2. `Range:` the last 64 KB → the ZIP End Of Central Directory record;
3. `Range:` the central directory → the entry table (~2 KB);
4. `Range:` the `.tsg` entry alone → ~200 KB compressed, inflated in memory
   (`zlib.inflateRawSync`; stored entries are handled too).

Roughly **0.1%** of each archive is transferred. Verified: NT
`1113660_ECD10.zip` is 295 MB and 253 KB was read. The base `_tsg.tsg` entry
is preferred over the `_tsg_tir.tsg` companion; the entry actually read is
recorded in `tsgEntryName`.

### The depth field

The interval comes from the `[band headers]` block, whose lines are written
`<index>:<name>;<min>;<max>;…` (the index prefix is present in some files,
absent in others):

```
80:Depth (m);24.003340;103.486778;2;-1;0;…
92:TIDL Depth Backup;24.003338;103.486778;…
```

`Depth (m)` is primary; `TIDL Depth Backup` is the secondary source for the
same pair. The name is anchored so the decoys in that same block never match
 - `Interactive Depth Logging` (±16,777,216) and the per-mineral
`… PFIT depth` scalars are not scan intervals.

**Sanity clamp.** A parsed interval is accepted only if `to > from`,
`from ≥ 0`, `to ≤ 20,000 m` and `to − from ≤ 5,000 m`; otherwise the row is
recorded with error `implausible depth` and the borehole stays in the
estimation tier. The harvester then applies the *same* 1.5 × drilled-length
garbage clamp it applies to API intervals - one rule for all sources.

Some archives carry no depth line at all. Those rows are kept with their date
and error `no depth field`: the borehole gains a real scan date but stays in
the estimation tier for kilometres. The `dates_from_tsg` / `tsg_measured_km`
split makes that visible.

### How a TSG interval is counted

A TSG interval is a **measurement**, not an estimate - it is the instrument's
own record. It is included in `unique_scanned_km` and reported separately as
`tsg_measured_km` / `tsg_measured_boreholes` per state and nationally, with
`tsg_source: "NCI THREDDS TSG (10.25914/bztg-rg43)"`. It is used **only**
when the node publishes no interval for that borehole. Where several archives
map to one borehole (WA daughter holes: `12CADD001.zip` plus
`12CADD001_wedge.zip`), their intervals are unioned - the conservative
choice, since a wedge overlaps its parent.

### Matching cache rows to boreholes

Archive names are not WFS identifiers. WA names an archive after the hole
(`05GJD001.zip`); NT prefixes the numeric feature id
(`1113660_ECD10.zip`). Each archive is therefore indexed under three
normalised keys - whole name, part before the first underscore, part after it
 - with normalisation to uppercase alphanumerics only, so punctuation
differences never cost a match. A borehole is matched in fixed precedence:
exact on WFS id, exact on WFS name, then name-as-suffix, then id-as-suffix.
(In this repository a `uuid` tier comes first: see the port header.)
Rows that match nothing are **counted and logged**, never silently dropped:
see `tsg_cache.unmatched_rows` nationally and `tsg_cache_rows_unmatched` per
state.

### Incremental, budgeted, hands-off

Each run lists the state's THREDDS catalog, diffs it against the cache by
`state + zipName`, and fetches only what is missing. Settled outcomes
(including `no depth field`, `no_tsg_in_zip`, HTTP 404) are never re-read;
transport failures are retried automatically next run; `--retry-failed`
re-reads everything with an error. `--max-new=N` (default 400) caps the work
per run so the weekly GitHub Action stays inside its time budget, and the
remainder is reported and picked up the following week. Politeness: one state
at a time, concurrency 3, 0.3 s between archives, 2 retries with backoff, and
a circuit breaker that stops after 8 consecutive network failures.

## Scan dates vs ingest dates

A node's `createdDate` is the day a record was **loaded into its database**,
not the day the core was scanned. Measured on the 2026-08-06 harvest:

| Source of dates | SA busiest month | TAS busiest month |
|---|---|---|
| Node API (`createdDate`) | 2019-07 = **20%** of the state | 2020-10 = **30%** of the state (2025-02 = 15%, 2022-11 = 14%) |
| TSG headers | 2022-10 = 4% (no cluster) | 2010-02 = 4% (no cluster) |

A fifth of South Australia was not scanned in July 2019 - it was *ingested*
then. Under TSG dates the clusters vanish and the distribution is smooth,
which is what real scanning activity looks like. Publishing the API date as a
scan date corrupts the growth chart, `days_since_latest`, the freshness
badges, the published scan-date range and any annual-throughput figure
derived from them.

So every date carries a `dateSource`:

- **`tsg`** - the TSG header's own scan date. Three tiers inside the file,
  highest confidence first: `scan date =` in `[description]`, then
  `scan date:` in `[history]`, then `Created :`. Years outside 2000-2035 are
  rejected as typos and fall through to the next tier.
- **`api_scan`** - `ScanDate` embedded in the API's dataset description.
- **`api_created`** - `createdDate`. An ingest date. Last resort.

Counts are published per state and nationally as `dates_from_tsg` /
`dates_from_api` (with the `api_scan` / `api_created` breakdown), plus
`dates_from_tsg_pct`. Where a borehole has more datasets than archives, the
lists are paired chronologically and leftover datasets take the borehole's
latest TSG date rather than fall back to an ingest date that would invent a
scanning month.

### Bulk-upload detector

For each state, the share of dated records falling in its single busiest
month is published as `date_cluster` - descriptive, always present.

The **flag** is computed over that state's **API-dated records only**, and
fires when all three hold:

| Condition | Threshold | Why |
|---|---|---|
| top month's share of API-dated records | > **15%** | 15% of a node's records in one month is already implausible for one instrument |
| API-dated records | ≥ **20** | below that, one shared `createdDate` proves nothing (CSIRO's whole history is 5 records dated the same day) |
| API-dated share of the node's dates | ≥ **25%** | once TSG dates dominate, the remaining ingest dates no longer drive the reading |

Computing the share over API-dated records only matters: blending in
TSG-dated ones dilutes the very cluster being looked for, so a half-enriched
node would slip under a blended threshold while still publishing hundreds of
ingest dates.

When it fires, the state entry gains `suspected_bulk_upload_month`,
`suspected_bulk_upload_share_pct`, `suspected_bulk_upload_api_records` and an
explanatory note, and the NVCL page replaces that state's freshness badge
with an *ingest date* marker. The flag clears automatically as TSG enrichment
covers the state - on the 2026-08-06 harvest SA's 2019-07 cluster had already
fallen from 20.4% of the whole state to 13.5% of its remaining API dates, and
no node is flagged.

## Estimation tier (added merged-v1.1, narrowed in v1.2)

Some nodes publish no scan intervals at all through `getDatasetCollection`
(at the time of writing: WA and NT). Their scanning is real; their APIs
simply omit depth ranges. For boreholes with **neither an API interval nor a
TSG one**:

- A borehole whose datasets are *all* interval-less is estimated **once**
  at its drilled length (`boreholeLength_m` from the WFS). Never per
  dataset - rescans must not inflate an estimate.
- Estimates are reported as `estimated_km` / `estimated_boreholes`,
  **separately** from `unique_scanned_km` (measured). The headline
  `combined_estimate_km = measured + estimated` always travels with the
  split. Blending them silently was the retired deep-pipeline method's
  flaw; disclosure is the difference between an estimate and a fabrication.
- When a node begins publishing intervals, or the TSG cache reaches that
  borehole, it leaves the estimation tier automatically - measured always
  wins over estimated. WA and NT rows on the page therefore move from
  `≈ … est.` to a measured figure state by state as the backfill proceeds,
  and read as `312 km · 140 km est.` while a state is part-way through.

### What the first conversions showed: the estimate ran ~20% high

The drilled-length estimate assumes a hole was scanned end to end. It was
not. On the 2026-08-06 harvest, NT's first 166 TSG-measured boreholes
replaced **52.26 km of estimate with 42.08 km of measurement** - the estimate
was about **24% too high**, because core is routinely scanned over part of
the hole (NT `1113660_ECD10`: drilled 94.17 m, scanned 24.0-103.5 m; NT
`1113664_ECD11`: drilled 103.5 m, scanned 51.3-103.3 m).

So the national combined figure will *fall* as enrichment proceeds even as
the measured figure rises: 1,692.44 km → 1,681.32 km on this harvest, with
measured up 42.34 km and estimated down 53.47 km. That is the expected and
correct direction. The estimation tier was always disclosed as an upper
bound; each conversion trades a generous guess for a smaller true number.
Anyone quoting the combined figure across harvests should quote the split
with it.

## TSG as the single source of truth (national scan, from 6 Aug 2026)

The TSG headers on the NCI THREDDS mirror are being read for **every**
archive in the collection - all six state subcatalogs, 5,168 archives - 
not only the two nodes whose APIs omit intervals.

Why the whole country rather than just the gaps:

- **Dates.** The ingest-vs-scan problem is national, not local to WA/NT
  (see the spot-check below). Every state's dates need the TSG source.
- **One methodology.** Mixing API-derived and TSG-derived measurements
  across states makes national totals a blend of two definitions. Reading
  every archive means one rule applied uniformly.
- **Independent verification.** Where a node *does* publish intervals, the
  TSG measurement is a cross-check on it - the same relationship that
  exposed the date problem. The API stays the primary depth source
  (precedence is unchanged); TSG makes disagreement visible instead of
  invisible.
- **Resilience.** Node APIs change, break, and lose fields. A TSG-derived
  cache in the repo keeps the archive measurable regardless.

The cache is committed and diffed per archive, so this is a one-time
national baseline; weekly runs then read only newly published archives.

## Verification: API dates are ingest dates (random spot-check, 6 Aug 2026)

The aggregate evidence (bulk-upload clusters that vanish under TSG dates)
was confirmed by sampling ten random SA/TAS boreholes and querying each
node's own `getDatasetCollection` live, alongside the TSG header scan date
for the same hole.

**The API date was later than the TSG scan date in 10 of 10 cases** - never
earlier, never equal. The lag is bimodal:

| Borehole | TSG scan date | API date | Lag |
|---|---|---|---|
| SA 136331 | 2019-05-07 | 2019-05-16 | 9 days |
| SA 149886 | 2017-11-24 | 2017-12-05 | 11 days |
| SA 134141 | 2022-10-28 | 2022-11-22 | 24 days |
| TAS 2287 | 2009-11-19 | 2010-11-10 | 356 days |
| TAS 93336 | 2022-01-31 | 2025-03-21 | 1,144 days |
| SA 139526 | 2013-07-01 | 2018-01-24 | 1,668 days |
| TAS 38238 | 2014-07-30 | 2020-10-13 | 2,266 days |
| SA 206163 | 2012-08-21 | 2018-11-05 | 2,267 days |
| SA 218473 | 2012-01-31 | 2019-07-02 | 2,709 days |
| SA 23196 | 2009-07-31 | 2018-02-13 | 3,119 days |

Either days-to-weeks (scanned, then uploaded promptly) or years (a bulk
backfill of older archives). A date field that is *always* later than the
event it supposedly records is an ingest timestamp, not a scan timestamp.

TAS 38238 is the clearest single case: its API date falls inside the
2020-10 ingest cluster that first raised the suspicion, while its actual
scan was July 2014 - six years earlier.

Corroborating detail: TSG timestamps spread across the working day
(09:29, 10:35, 14:03 …), consistent with an operator running an
instrument. API timestamps cluster in the afternoon (16:22, 16:49,
16:52 …), consistent with scheduled batch ingests.

This is why date precedence is **TSG > API**, why every date carries a
`dateSource`, and why states still relying on API dates are eligible for
the bulk-upload flag.

## Mirror reconciliation: archives the state services do not surface

`src/nvcl/thredds-catalog.js` records what the NCI mirror holds per state,
and the harvest compares it with what each node advertises. The two
disagree, measured 6 Aug 2026:

| State | Mirror archives | Boreholes the node surfaces with data | Not surfaced |
|---|---|---|---|
| WA | 1,951 | 1,669 | +282 |
| QLD | 512 | 368 | +144 |
| TAS | 506 | 482 | +24 |
| VIC | 39 | **0** | **+39** |
| SA | 1,815 | 1,822 | - |
| NT | 345 | 420 | - |

**407 archives nationally** sit on the mirror beyond what the state
services expose as boreholes-with-data. Victoria is the clearest case: its
node reports no NVCL datasets at all and the page has been calling it
"non-participating", yet 39 Victorian archives exist on the mirror - 
consistent with Victorian core having been scanned at another state's
HyLogger, which the VIC node has no way to advertise.

Two states run the other way (SA, NT), where the node lists boreholes the
mirror has no archive for - an upload backlog rather than a hidden holding.

Neither direction is an error to be corrected silently. A state's service
not advertising scanned core does not mean the core was not scanned, and
inheriting a node's blind spot would understate the national archive. The
gap is therefore published per state (`mirror_archives`,
`mirror_unsurfaced`) and shown on the page as a "+N on mirror" badge.

## Mirror-only measurement (added merged-v1.3)

A TSG archive can only be attributed to a borehole if the state node
surfaces that borehole. Measured 6 Aug 2026, **834 archives matched no
harvested borehole** - not noise, but core the instrument demonstrably
scanned for holes the node does not publish.

Excluding them understated the national figure by **~355 km**, and did so
worst where a state's service is weakest:

| State | TSG measured | Attributable to published boreholes | Mirror-only |
|---|---|---|---|
| QLD | 181.1 km | 7.9 km | **173.1 km** |
| WA | 685.3 km | 558.9 km | 126.5 km |
| NT | 115.9 km | 85.7 km | 30.2 km |
| SA | 419.6 km | 405.1 km | 14.4 km |
| TAS | 142.3 km | 136.9 km | 5.4 km |
| VIC | 6.0 km | 0 km | **6.0 km** |

Queensland is the clearest case: its API fails roughly a quarter of its
borehole queries, so the better its scanning record, the *less* of it we
could report. Victoria's entire 6 km was invisible because its node
publishes no NVCL datasets at all.

**These kilometres now count**, on their own line:

- `mirror_only_km` / `mirror_only_archives` - measured from TSG headers,
  attributable to the mirror rather than to a published borehole;
- `national_measured_km` = per-borehole measured + mirror-only.

They are **not** folded into per-borehole coverage (`unique_scanned_km`),
because there is no borehole record to union against - each archive
contributes its interval once. The garbage clamp cannot apply either
(no drilled length is known without the borehole), so a flat 5 km ceiling
substitutes; no legitimate scanned interval approaches it.

### A node that is entirely down still counts

Mirror-only applies to nodes that answered *and* to nodes that did not. If a
state's WFS fails outright, every archive the mirror holds for it becomes
mirror-only, because a service outage is not evidence that scanning did not
happen.

This was not always true. Until 17 Aug 2026 an unreachable node returned
before mirror reconciliation ran, and its entry was written as a zeroed stub.
Tasmania answered HTTP 500 that day, and its **506 archives - roughly 142 km - 
left the national figure entirely**, while the states whose services happened
to be up were counted in full. That is the precise inversion this section
exists to prevent, so it now runs for every node and the stub carries the
mirror figures with a note distinguishing *absent* from *zero*.

An unreachable node therefore reports `total_boreholes_with_data: 0` (nothing
is plottable without a WFS record) alongside a non-zero `mirror_only_km` and
`evidenced_boreholes`. The two are not in conflict: the first says the state
published nothing this run, the second says the instrument's own files record
the work regardless.

### Counting mirror-only boreholes

`mirror_only_boreholes` answers a different question from
`mirror_only_archives`: not "how many files did the mirror hold?" but "how
many holes has this state scanned that its own service never published?"

The rule is **one archive basename, one borehole**. No name-based grouping
is applied. An earlier version collapsed a trailing `-N` - reading
`203950-3.zip` and `203950-4.zip` as two sections of one hole - but the
cache contradicts that: all ten `-N` groups in it have *overlapping* depth
intervals, so none can be sequential sections. They are distinct holes
sharing a project prefix. `WA/MG19-001` through `-010` each start at 0 m,
and `WA/WTB` runs -05, -06, -07, -09, -14, -21 … , a gapped series no
section numbering produces. The collapse merged 41 real WA boreholes into
10 and was removed.

If a state does begin mirroring genuine sections, the rule should return
behind a non-overlap test on the depth intervals, never on the filename
alone.

The principle is the same one that governs the dates: if the instrument's
own file records the scan, the scan happened, whether or not a state
service mentions the hole. Reporting less because a node is degraded would
penalise exactly the states most in need of the visibility.

---

## Carry-forward: a snapshot is not a status report (added merged-v1.4, 20 Aug 2026)

Every harvest before this one rebuilt the national snapshot from whatever
answered **that day**. A state whose service was down did not report "no new
data" - it reported **nothing**, and its boreholes left the map.

That is the wrong model for what this data is. The NVCL archive is
cumulative: **core that has been scanned does not become unscanned because a
web service is returning HTTP 500.** Node uptime is a fact about a server on a
Tuesday; it is not evidence about scanning.

### What it cost

Measured, not hypothetical. The scheduled harvest of **10 Aug 2026** ran while
the Tasmanian WFS was down. It wrote, committed and published a snapshot with
**TAS at zero**: 6,006 boreholes fell to 5,530 and the national figure fell
from 1,876 km to 1,738 km. Nothing flagged it. The health guard passed,
because it counts *nodes reachable* (5 of 8 cleared the threshold) and total
boreholes against an 80% floor, which 5,530/6,006 = 92% comfortably cleared.
**The loss was invisible for eleven days** and was noticed only because
Tasmania looked empty on the map.

Queensland showed the same failure in a harder form on 17 Aug: its WFS served
all 587 boreholes while its **dataset service refused every query**, so the
state reported 71 boreholes instead of 366. The node was "reachable", so
nothing complained at all.

### The rules

Three sources of durability, in order of preference:

1. **`data/nvcl/boreholes.jsonl`** - every borehole coordinate ever
   successfully read, keyed by state and node identifier. WFS becomes the
   thing that *adds and corrects* rows, not the thing the map depends on being
   up.
2. **`data/nvcl/tsg-cache.jsonl`** - scan intervals, dates and instrument, as
   already established. Measurement was durable before this change; location
   was not.
3. **The previous snapshot** - for a node that cannot be measured this run.

A node is carried forward when either:

- its **WFS fails** (`status: cached`) - boreholes are drawn from cached
  coordinates, and the figures are those last measured; or
- **more than 50% of its dataset queries fail** (`status: degraded`) - 
  coordinates are current, the figures are not.

In both cases the state entry carries `coords_as_of` and `measured_as_of`, so
a carried-forward number can always be told from a fresh one.

**A carried-forward node's TSG archives are excluded from mirror-only.** They
are already represented in the figures being carried forward, and counting
both would double-count the same holes - 482 cached Tasmanian boreholes *plus*
499 mirror-only Tasmanian archives, for a state with about 500 holes in total.

### Seeding, and its limits

The cache cannot be populated retroactively from a service that is down. When
Tasmania went dark on 10 Aug there was no way to ask it for the 482
coordinates it had served the week before; the only surviving copy was the
published feed. So a state the cache has never held is seeded from
`docs/nvcl-data.json`, whose rows are `[lat, lng, stateIdx, month, m, tsg]`
with **no identifier**. Seeded rows therefore carry a synthetic id and a
`seeded` flag: good enough to place a dot, deliberately not good enough to
match a TSG archive or fetch a dataset. The first time the real service
answers, its rows replace the seeds for that state outright.

### What this does not fix

Carry-forward keeps a number from vanishing; it does not keep it true. A node
down for six months will keep reporting six-month-old figures. That is why
every carried-forward entry is dated and labelled rather than silently merged
 - **staleness is disclosed, never averaged away.** Deciding when stale becomes
unacceptable is a judgement for whoever reads the page, and they can only make
it if the page says which numbers are old.

---

## TSG collar coordinates (added 31 Aug 2026, extraction from merged-v1.4)

The `.tsg` header's `[dbextra]` block carries a `lat lon =` pair, a
`geo datum =` line, and a `collar =` triple. This was checked properly - 
full archives, six states, 36 samples spread through each catalogue - after
an earlier inference ("the cache has no coordinates, therefore TSG has
none") was wrongly repeated as fact. The field is real; the DATA is
operator-entered free text:

| state | populated | observed faults |
|---|---|---|
| WA | 6/6 | none - clean GDA94 |
| QLD | 3/6 | dropped minus sign (`21.73 148.05`) |
| SA | 3/6 | swapped axes (`138.92 -34.35`) |
| NT | 2/6 | rest zeroed |
| TAS | 2/6 | MGA eastings/northings in the field (`5340643 382466`) |
| VIC | 0/6 | all zeroed |

**The rule: classify, never trust.** The raw pair is stored verbatim
(`latRaw`/`lonRaw`), and `lat`/`lng` are emitted only when the value is
unambiguous under the Australian window (lat −45…−8, lon 110…155):

- `ok` - in the window as written;
- `swapped` - in the window with axes exchanged;
- `sign` - in the window with the latitude's sign flipped;
- `projected` - magnitudes far beyond degrees (MGA/UTM); kept raw, never
  converted - a zone guess is a wrong map dot with confidence;
- `out-of-range` - none of the above; kept raw, unplaced.

`coordStatus` travels with every row so a page can disclose which dots are
corrected values.

**What this changes, and what it does not.** WFS remains the coordinate
authority: ~44% population with these fault classes cannot anchor a map.
TSG coordinates serve two roles - **recovering mirror-only boreholes**
(archives with no WFS record; previously measurable but unplottable) and
**cross-checking WFS positions** where both exist. Rows enriched before
this change carry no coordinate fields; a budgeted backfill pass over the
mirror-only archives is the priority re-read, WA first (best population,
largest mirror-only share after QLD).
