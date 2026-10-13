#!/usr/bin/env node
/**
 * AuScope NVCL - Live Harvester (merged-v1.2 methodology)
 *
 * Ported from bvkay/AuScope_doi_tracker src/nvcl/harvest.js on 2026-10-13 and
 * trimmed to what the AuScope_Outreach maps need (see scripts/nvcl/README.md
 * for what was left behind and why). This repo owns this copy: nothing here
 * reads from, or depends on, AuScope_doi_tracker at runtime.
 *
 * Queries every NVCL node's PUBLIC services directly:
 *   1. WFS GetFeature gsmlp:BoreholeView (CQL nvclCollection='true', paged)
 *      -> registered borehole list per node (id, name, lat/lng, length)
 *   2. NVCLDataServices getDatasetCollection.html per borehole
 *      -> datasets with TSG metadata (instrument, dates) + DepthRange,
 *         each with its DatasetID (the TSG header's UUID) and the number
 *         of sample positions it holds spectra for
 *
 * Counting rules (see scripts/nvcl/METHODOLOGY.md - the citable document):
 *   - The atom is the per-DATASET scan interval (depth_start, depth_end).
 *   - unique_scanned_km  = union of each borehole's intervals (overlaps merged)
 *   - total_scan_km      = plain sum of interval lengths (rescans count)
 *   - A dataset with a missing/invalid interval contributes ZERO metres and
 *     increments interval_unrecorded. Borehole length is NEVER substituted.
 *   - Garbage clamp: an interval longer than 1.5x the drilled borehole length
 *     (when known) is discarded as metadata garbage and counted.
 *
 * TSG enrichment (merged-v1.2), from data/nvcl/tsg-cache.jsonl, built by
 * scripts/nvcl/tsg-enrich.js out of the AuScope TSG mirror on NCI THREDDS
 * (collection DOI 10.25914/bztg-rg43). Rows thredds-catalog.js has stamped
 * `gone` (no longer on the mirror) are neither matched nor counted, and
 * rows sharing a TSG UUID count once (see loadTsgIndex):
 *   - DEPTH precedence:  TSG-measured interval > API-published interval >
 *     drilled-length estimate. A TSG interval counts as MEASURED and is
 *     tracked separately as tsg_measured_km.
 *   - DATE precedence:   TSG header scan date > API date. The API's
 *     createdDate is an INGEST date, not a scan date - whole states arrive in
 *     one month (TAS 30% in 2020-10, SA 20% in 2019-07) and those clusters
 *     vanish under TSG dates. Every date carries a dateSource.
 *
 * Outputs (only when the run is healthy - see health guard below):
 *   data/nvcl_stats.json              canonical snapshot (per-state figures)
 *   data/nvcl/boreholes-detail.jsonl  one line per harvested borehole: its
 *                                     WFS record, API datasets and matched
 *                                     TSG archives (input to write-map-data.js)
 *   data/nvcl_history.jsonl           one appended line per run (trend record)
 * Always written (even when the guard fails):
 *   data/nvcl/boreholes.jsonl         carry-forward coordinate cache
 *
 * Health guard: outputs are written only if >= 5 nodes are reachable AND
 * total boreholes-with-data >= 80% of the previous snapshot's count.
 * Otherwise the run exits 1 loudly and touches nothing - a half-blind
 * harvest must never replace a good national snapshot.
 *
 * Env:
 *   NVCL_ONLY=TAS,CSIRO   harvest only these nodes (testing)
 *   NVCL_OUT_DIR=/tmp/x   redirect every output, cache included (testing)
 *   NVCL_FORCE=1          bypass the health guard (testing / rebaseline only)
 *   NVCL_TRACE=1          print the stack trace on a fatal error
 *
 * Usage: node scripts/nvcl/harvest.js   (any working directory)
 */

const fs = require('fs');
const path = require('path');

// Resolved from this file, so the script runs from any working directory.
const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const STATS_FILE = path.join(DATA_DIR, 'nvcl_stats.json');
const HISTORY_FILE = path.join(DATA_DIR, 'nvcl_history.jsonl');
const DETAIL_FILE = path.join(DATA_DIR, 'nvcl', 'boreholes-detail.jsonl');

// Every borehole coordinate we have ever successfully read, so a node being
// down stops meaning its boreholes vanish. See loadBoreholeCache().
const BOREHOLE_CACHE = path.join(DATA_DIR, 'nvcl', 'boreholes.jsonl');

const OUT_DIR = process.env.NVCL_OUT_DIR ? path.resolve(process.env.NVCL_OUT_DIR) : null;
const FORCE = process.env.NVCL_FORCE === '1';
const ONLY = (process.env.NVCL_ONLY || '').split(',')
  .map(function(s) { return s.trim().toUpperCase(); }).filter(Boolean);

const USER_AGENT = 'AuScope-Outreach NVCL harvester (+https://github.com/AuScope/AuScope_Outreach)';

const WFS_TIMEOUT_MS = 60000;      // standard filtered WFS pages (1k features)
// NT's GeoServer ignores the nvclCollection CQL filter, so its boreholes are
// paged UNFILTERED at 10k features a page. Those pages routinely take longer
// than 60s to build and 60s cost NT the whole harvest (observed 2026-08-06:
// three attempts, all timed out, node reported unreachable). The fallback
// path gets its own, far more patient budget.
const WFS_FALLBACK_TIMEOUT_MS = 240000;
const DS_TIMEOUT_MS = 15000;
const RETRIES = 2;
const RETRY_DELAY_MS = 3000;
const CONCURRENCY = 8;             // dataset fetches in flight per node
const RETRY_PASS_CONCURRENCY = 2;  // second, quieter pass over failed fetches
const RETRY_PASS_TIMEOUT_MS = 30000;
const RETRY_PASS_BUDGET_MS = 15 * 60 * 1000;   // per node
// Main dataset pass, per node (added 2026-10-13). On 2026-10-13 the slowest
// was QLD at about 27 minutes (154 of 587 queries timing out three times
// each under load before the retry pass recovered all of them); the rest
// took under 9. A service slow enough to hang without ever failing would
// otherwise run the job into its 300-minute timeout and lose the week's
// enrichment with it. Tripping it marks the node degraded.
const DATASET_PASS_BUDGET_MS = 40 * 60 * 1000;
const WFS_PAGE = 1000;
const WFS_SINGLE_MAX = 20000;

// Share of a node's dataset queries that must fail before we stop believing
// this run's figures for it and carry the previous run's forward instead.
const DEGRADED_FRACTION = 0.5;
const FALLBACK_PAGE = 10000;       // unfiltered paging (NT: CQL disabled)
// The stable order unfiltered pages are taken in, and the share of the
// node's own feature count (resultType=hits) the pages must reach before the
// borehole list is believed. See fetchWfsUnfiltered().
const FALLBACK_SORT = 'gsmlp:identifier ASC';
const MIN_PAGED_FRACTION = 0.98;
const CLAMP_FACTOR = 1.5;          // interval vs borehole length garbage clamp
const MIN_NODES_UP = 5;            // health guard
const MIN_PREV_FRACTION = 0.8;     // health guard

const TSG_CACHE = path.join(DATA_DIR, 'nvcl', 'tsg-cache.jsonl');
const THREDDS_CATALOG = path.join(DATA_DIR, 'nvcl', 'thredds-catalog.json');
// Loaded once at module scope: aggregate() needs it and runs outside run().
const THREDDS_CAT = readJson(THREDDS_CATALOG, null);
const TSG_SOURCE = 'NCI THREDDS TSG (10.25914/bztg-rg43)';

// The 8 public NVCL nodes. cqlBroken: GeoServer ignores CQL on nvclCollection
// (returns 0 rows) so we page ALL boreholes and filter locally. wfsOnly: VIC
// has no HyLogger node and no NVCLDataServices (confirmed 404) - its WFS is
// still queried so the registered-borehole count stays honest.
const NODES = [
  { code: 'CSIRO', name: 'CSIRO',              wfs: 'https://nvclwebservices.csiro.au/geoserver/ows',       nvcl: 'https://nvclwebservices.csiro.au/NVCLDataServices' },
  { code: 'NSW',   name: 'New South Wales',    wfs: 'https://gs.geoscience.nsw.gov.au/geoserver/ows',       nvcl: 'https://nvcl.geoscience.nsw.gov.au/NVCLDataServices' },
  { code: 'NT',    name: 'Northern Territory', wfs: 'https://geology.data.nt.gov.au/geoserver/ows',         nvcl: 'https://geology.data.nt.gov.au/NVCLDataServices', cqlBroken: true },
  { code: 'QLD',   name: 'Queensland',         wfs: 'https://geology.information.qld.gov.au/geoserver/ows', nvcl: 'https://geology.information.qld.gov.au/NVCLDataServices' },
  { code: 'SA',    name: 'South Australia',    wfs: 'https://sarigdata.pir.sa.gov.au/geoserver/ows',        nvcl: 'https://sarigdata.pir.sa.gov.au/nvcl/NVCLDataServices' },
  { code: 'TAS',   name: 'Tasmania',           wfs: 'https://www.mrt.tas.gov.au/web-services/ows',          nvcl: 'https://www.mrt.tas.gov.au/NVCLDataServices' },
  { code: 'VIC',   name: 'Victoria',           wfs: 'https://geology.data.vic.gov.au/nvcl/ows',             nvcl: 'https://geology.data.vic.gov.au/NVCLDataServices', wfsOnly: true,
    note: 'No HyLogger node. Boreholes flagged here may have been scanned at another node.' },
  { code: 'WA',    name: 'Western Australia',  wfs: 'https://geossdi.dmp.wa.gov.au/services/ows',           nvcl: 'https://geossdi.dmp.wa.gov.au/NVCLDataServices' },
];

// -- Main ----------------------------------------------------------

async function run() {
  const startedAt = new Date();
  const asOf = startedAt.toISOString().substring(0, 10);
  console.log('NVCL Harvest (merged-v1.2) - ' + asOf);
  console.log('=================================\n');
  if (ONLY.length) console.log('Node filter: ' + ONLY.join(', ') + ' (NVCL_ONLY)');
  if (OUT_DIR) console.log('Output redirect: ' + OUT_DIR + ' (NVCL_OUT_DIR)');
  if (FORCE) console.log('WARNING: health guard bypassed (NVCL_FORCE=1)');

  const t0 = Date.now();
  const nodes = ONLY.length
    ? NODES.filter(function(n) { return ONLY.indexOf(n.code) !== -1; })
    : NODES;
  if (!nodes.length) throw new Error('NVCL_ONLY matched no nodes');

  // The previous snapshot, read before an hour of harvesting rather than
  // after it. A file that exists but does not parse is a corrupted commit,
  // not a first run: skipping the 80% check over it would let any harvest,
  // however blind, replace the national snapshot. So it stops the run.
  let prev = null;
  if (fs.existsSync(STATS_FILE)) {
    try { prev = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); }
    catch (e) {
      throw new Error(STATS_FILE + ' exists but does not parse (' + e.message + '); '
        + 'restore it from git before harvesting');
    }
  }

  // TSG enrichment cache (optional - the harvest is fully functional without
  // it, just less measured and on ingest dates).
  const tsgIndex = loadTsgIndex(TSG_CACHE);

  // Coordinates we already hold. A node that cannot be reached now falls back
  // to these instead of dropping its boreholes off the map.
  const bhCache = loadBoreholeCache(BOREHOLE_CACHE);

  // Harvest nodes sequentially (politeness); boreholes within a node
  // are fetched with CONCURRENCY workers.
  const results = [];
  for (let i = 0; i < nodes.length; i++) {
    const r = await harvestNode(nodes[i], bhCache, asOf);
    attachTsg(r, tsgIndex);
    results.push(r);
  }

  // Written even when the run later fails its health guard: a coordinate we
  // successfully read is worth keeping regardless of what the rest of the
  // harvest did.
  const cachePath = OUT_DIR ? path.join(OUT_DIR, 'nvcl', 'boreholes.jsonl') : BOREHOLE_CACHE;
  console.log('\nBorehole cache: ' + saveBoreholeCache(bhCache, cachePath) + ' rows written');

  // The previous snapshot serves two purposes: carrying an unreachable node
  // forward inside aggregate(), and the health guard below. A snapshot in
  // the retired Python scraper's schema has no per-state figures and no
  // total_boreholes_with_data, so it can serve neither; it is ignored.
  if (prev && !(prev.summary && typeof prev.summary.total_boreholes_with_data === 'number')) {
    console.log('\nPrevious snapshot ' + STATS_FILE + ' is not in the harvest schema'
      + ' (first run of this harvester?): no carry-forward figures, 80% check skipped.');
    prev = null;
  }
  const snapshot = aggregate(results, asOf, tsgIndex, prev);
  snapshot.harvested_at = startedAt.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const elapsed = Math.round((Date.now() - t0) / 1000);
  snapshot.harvest_seconds = elapsed;
  console.log('\nHarvest finished in ' + elapsed + 's');
  printSummary(snapshot);

  // -- Health guard --
  // Compare against the CANONICAL previous snapshot (data/nvcl_stats.json),
  // not the redirect target - the guard exists to protect the national file.
  const prevCount = prev && prev.summary ? prev.summary.total_boreholes_with_data : null;
  const nodesUp = results.filter(function(r) { return r.wfsOk; }).length;
  const bhCount = snapshot.summary.total_boreholes_with_data;
  const guardErrors = [];
  if (nodesUp < MIN_NODES_UP) {
    guardErrors.push('only ' + nodesUp + ' of ' + NODES.length + ' nodes reachable (need >= ' + MIN_NODES_UP + ')');
  }
  if (prevCount && bhCount < prevCount * MIN_PREV_FRACTION) {
    guardErrors.push('boreholes with data ' + bhCount + ' < 80% of previous snapshot (' + prevCount + ')');
  }
  console.log('\nHealth guard: ' + nodesUp + '/' + NODES.length + ' nodes reachable, '
    + bhCount + ' boreholes with data'
    + (prevCount ? ' (previous ' + prevCount + ')' : ' (no comparable previous snapshot)'));
  if (guardErrors.length && !FORCE) {
    console.error('\nHEALTH GUARD FAILED - refusing to write outputs:');
    guardErrors.forEach(function(e) { console.error('  - ' + e); });
    console.error('The previous snapshot stays in place. Re-run when nodes recover,');
    console.error('or set NVCL_FORCE=1 to rebaseline deliberately.');
    process.exit(1);
  }
  if (guardErrors.length && FORCE) {
    console.warn('\nHealth guard WOULD have failed (bypassed by NVCL_FORCE=1):');
    guardErrors.forEach(function(e) { console.warn('  - ' + e); });
  }

  // -- Write outputs --
  const statsPath = OUT_DIR ? path.join(OUT_DIR, 'nvcl_stats.json') : STATS_FILE;
  const detailPath = OUT_DIR ? path.join(OUT_DIR, 'nvcl', 'boreholes-detail.jsonl') : DETAIL_FILE;
  const histPath = OUT_DIR ? path.join(OUT_DIR, 'nvcl_history.jsonl') : HISTORY_FILE;

  const detail = buildDetail(results);
  snapshot.detail = { path: 'data/nvcl/boreholes-detail.jsonl', rows: detail.length };

  fs.mkdirSync(path.dirname(detailPath), { recursive: true });
  fs.writeFileSync(detailPath, detail.join('\n') + (detail.length ? '\n' : ''));
  console.log('\nWrote ' + detailPath + ' (' + detail.length + ' boreholes)');

  fs.writeFileSync(statsPath, JSON.stringify(snapshot, null, 1) + '\n');
  console.log('Wrote ' + statsPath);

  const histLine = JSON.stringify({
    date: asOf,
    boreholes: bhCount,
    datasets: snapshot.summary.total_datasets,
    unique_km: snapshot.summary.unique_scanned_km,
    total_scan_km: snapshot.summary.total_scan_km,
    unrecorded: snapshot.summary.interval_unrecorded_datasets,
    nodes_up: nodesUp,
    stale: snapshot.states.filter(function(s) {
      return s.status === 'cached' || s.status === 'degraded' || s.status === 'unreachable';
    }).map(function(s) { return s.state; }),
  });
  fs.appendFileSync(histPath, histLine + '\n');
  console.log('Appended ' + histPath);
}

// -- Per-node harvest ----------------------------------------------

async function harvestNode(node, bhCache, today) {
  console.log('\n[' + node.code + '] ' + node.name);
  const result = {
    node: node, wfsOk: false, dsOk: false,
    boreholes: [],            // { id, name, lat, lng, lengthM, datasets: [] }
    wfsCount: 0,
    fetchFailures: 0,         // borehole dataset fetches that hard-failed
    fromCache: false,         // coordinates came from cache, not from the node
    coordsAsOf: null,         // when those cached coordinates were last read
  };

  // 1. WFS borehole list
  try {
    if (node.cqlBroken) {
      const paged = await fetchWfsUnfiltered(node);
      result.boreholes = paged.boreholes;
      result.wfsPaging = { features: paged.features, reported: paged.hits };
    } else {
      result.boreholes = await fetchWfsFiltered(node);
    }
    result.wfsOk = true;
    result.wfsCount = result.boreholes.length;
    console.log('  WFS: ' + result.wfsCount + ' NVCL boreholes registered');
    if (result.wfsPaging) {
      const pg = result.wfsPaging;
      const frac = pg.reported ? pg.features / pg.reported : 0;
      console.log('  WFS: paged ' + pg.features + ' features against ' + (pg.reported === null ? 'no count'
        : pg.reported + ' reported by resultType=hits') + ' (' + Math.round(frac * 1000) / 10 + '%)');
      // Short of the node's own count, the borehole list is not the node's
      // list, and the holes past the shortfall would leave the map silently.
      if (frac < MIN_PAGED_FRACTION) {
        result.wfsShort = true;
        console.warn('  WFS PAGING SHORT: below ' + Math.round(MIN_PAGED_FRACTION * 100)
          + '% of the reported count - the node will be marked degraded');
      }
    }
    if (bhCache) {
      const dropped = purgeSeeded(bhCache, node.code);
      const legacy = purgeTruncatedIds(bhCache, node.code, result.boreholes);
      const added = mergeBoreholeCache(bhCache, node.code, result.boreholes, today, legacy.firstSeenByName);
      if (dropped) console.log('  Cache: replaced ' + dropped + ' seeded placeholder(s) with real rows');
      if (legacy.n) console.log('  Cache: dropped ' + legacy.n + ' row(s) under a truncated pre-fix id ('
        + legacy.ids.join(', ') + ')');
      if (added) console.log('  Cache: +' + added + ' borehole(s) not seen before');
    }
  } catch (e) {
    console.warn('  WFS UNREACHABLE: ' + e.message);
    // Fall back to the coordinates we already hold rather than dropping the
    // state. Its boreholes still plot, and TSG evidence still measures them.
    const cached = bhCache ? boreholesFromCache(bhCache, node.code) : [];
    if (cached.length) {
      result.boreholes = cached;
      result.wfsCount = cached.length;
      result.fromCache = true;
      result.coordsAsOf = cached[0].coordsAsOf || null;
      console.log('  CACHED: ' + cached.length + ' borehole(s) from a previous run'
        + (result.coordsAsOf ? ' (coordinates as at ' + result.coordsAsOf + ')' : ''));
      return result;          // dsOk stays false: no datasets without the node
    }
    return result;            // status 'unreachable'; never kills the run
  }

  if (node.wfsOnly) {
    console.log('  Skipping dataset harvest (' + (node.note || 'WFS-only node') + ')');
    result.dsOk = true;       // node answered everything it has
    return result;
  }

  // 2. Dataset collections, CONCURRENCY at a time, inside a time budget.
  // Holes still queued when it runs out count as failed queries, and the
  // node is marked degraded below whatever share that comes to.
  let done = 0, withData = 0;
  const queue = result.boreholes.slice();
  const passStart = Date.now();
  let budgetTripped = false;
  async function worker() {
    for (;;) {
      if (Date.now() - passStart > DATASET_PASS_BUDGET_MS) {
        if (!budgetTripped && queue.length) {
          budgetTripped = true;
          console.warn('  DATASET PASS BUDGET SPENT: ' + Math.round(DATASET_PASS_BUDGET_MS / 60000)
            + ' min with ' + queue.length + ' of ' + result.boreholes.length + ' boreholes not yet queried'
            + ' - the node will be marked degraded');
        }
        queue.splice(0).forEach(function(bh) {
          bh.datasets = [];
          bh.fetchFailed = true;
          result.fetchFailures++;
        });
        return;
      }
      const bh = queue.shift();
      if (!bh) return;
      try {
        bh.datasets = await fetchDatasets(node, bh.id);
        if (bh.datasets.length) withData++;
      } catch (e) {
        bh.datasets = [];
        bh.fetchFailed = true;
        result.fetchFailures++;
      }
      done++;
      if (done % 200 === 0) console.log('  ' + done + '/' + result.boreholes.length + ' boreholes queried...');
    }
  }
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);

  // Retry pass (added in the AuScope_Outreach port, 2026-10-13). On the first
  // run here QLD's dataset service failed 160 of 587 queries under 8-way
  // concurrency, yet the same boreholes answered in ~3 s each when asked one
  // at a time: the failures were load, not absence, and a different ~60
  // boreholes would have dropped off the map every week. So failed queries
  // get one quieter pass (2 in flight, 30 s timeout) inside a fixed time
  // budget. A node whose service is genuinely down fails every query and is
  // not retried; the budget stops a slow node from eating the job's time.
  // A node that spent its whole budget gets no retry pass: it is slow, not
  // overloaded, and another 15 minutes of it would not change the verdict.
  if (result.fetchFailures && result.fetchFailures < result.boreholes.length && !budgetTripped) {
    const failed = result.boreholes.filter(function(bh) { return bh.fetchFailed; });
    const retryStart = Date.now();
    let recovered = 0, attempted = 0;
    async function retryWorker() {
      for (;;) {
        if (Date.now() - retryStart > RETRY_PASS_BUDGET_MS) return;
        const bh = failed.shift();
        if (!bh) return;
        attempted++;
        try {
          bh.datasets = await fetchDatasets(node, bh.id, RETRY_PASS_TIMEOUT_MS);
          delete bh.fetchFailed;
          result.fetchFailures--;
          recovered++;
          if (bh.datasets.length) withData++;
        } catch (e) { /* still failed; counted as before */ }
      }
    }
    const retryWorkers = [];
    for (let i = 0; i < RETRY_PASS_CONCURRENCY; i++) retryWorkers.push(retryWorker());
    await Promise.all(retryWorkers);
    console.log('  Retry pass: recovered ' + recovered + ' of ' + attempted + ' failed queries in '
      + Math.round((Date.now() - retryStart) / 1000) + 's'
      + (failed.length ? ' (' + failed.length + ' not retried: time budget spent)' : ''));
  }

  // A node whose dataset service rejected every single query is down even
  // though its WFS answered - count it as reached (WFS worked) but flag it.
  result.dsOk = result.fetchFailures < result.boreholes.length || result.boreholes.length === 0;
  console.log('  Datasets: ' + withData + '/' + result.boreholes.length + ' boreholes have data'
    + (result.fetchFailures ? ' (' + result.fetchFailures + ' fetch failures)' : '')
    + ' in ' + Math.round((Date.now() - passStart) / 1000) + 's');
  if (!result.dsOk) console.warn('  DATASET SERVICE UNREACHABLE (all ' + result.fetchFailures + ' queries failed)');

  // A half-answering node is the harder case, and the one that actually bit:
  // on 17 Aug QLD's WFS served all 587 boreholes while its dataset service
  // refused every query, so the state came out at 71 boreholes instead of 366
  // and NOTHING flagged it - the node was "reachable", so the guard was happy.
  // Losing most of a state's measurements is the same event as losing the
  // state, and it gets the same treatment: keep the fresh coordinates, but
  // carry the figures forward rather than publish a collapse as a measurement.
  const failedFrac = result.boreholes.length
    ? result.fetchFailures / result.boreholes.length : 0;
  if (failedFrac > DEGRADED_FRACTION || budgetTripped || result.wfsShort) {
    result.degraded = true;
    result.fromCache = true;          // carry stats forward, same as an outage
    result.coordsAsOf = today;        // coordinates ARE fresh; the figures are not
    console.warn('  DEGRADED: ' + (result.wfsShort ? 'WFS paging fell short of the node\'s count, ' : '')
      + (budgetTripped ? 'dataset pass ran out of time, ' : '')
      + Math.round(failedFrac * 100) + '% of dataset queries failed'
      + ' - figures will be carried forward, coordinates kept fresh');
  }
  return result;
}

// Standard path: WFS 2.0.0 GET, JSON output, server-side CQL filter, paged.
async function fetchWfsFiltered(node) {
  const out = new Map();

  // Try the whole collection in ONE request first. WA's GeoServer does not
  // honour startIndex reliably: paging it at 1000 returns page 0 and page
  // 1000 with 177 records IN COMMON, so the union came to 1,680 of its 1,897
  // boreholes - 223 silently lost, which is most of the "unmatched" TSG
  // archives we were writing off as absent. sortBy does not fix it. Every
  // other node paginates correctly, but a single request is correct
  // everywhere and cheaper, so it is the primary path.
  try {
    const url = node.wfs + '?service=WFS&version=2.0.0&request=GetFeature'
      + '&typeName=gsmlp:BoreholeView&outputFormat=application/json'
      + '&count=' + WFS_SINGLE_MAX
      + '&CQL_FILTER=' + encodeURIComponent("nvclCollection='true'");
    const text = await fetchText(url, WFS_TIMEOUT_MS);
    let features;
    try { features = (JSON.parse(text).features) || []; }
    catch (e) { features = parseWfsXml(text); }
    // Short of the ceiling means we saw everything. Hitting it exactly means
    // the server capped us, so fall through to paging.
    if (features.length && features.length < WFS_SINGLE_MAX) {
      features.forEach(function(f) { addFeature(out, f); });
      return Array.from(out.values());
    }
  } catch (e) {
    // Fall through to paging - a node that rejects a large count still works.
  }

  let startIndex = 0;
  for (;;) {
    const url = node.wfs + '?service=WFS&version=2.0.0&request=GetFeature'
      + '&typeName=gsmlp:BoreholeView&outputFormat=application/json'
      + '&count=' + WFS_PAGE + '&startIndex=' + startIndex
      + '&CQL_FILTER=' + encodeURIComponent("nvclCollection='true'");
    const text = await fetchText(url, WFS_TIMEOUT_MS);
    let features;
    try {
      features = (JSON.parse(text).features) || [];
    } catch (e) {
      // Server ignored outputFormat and sent GML - parse the XML instead.
      features = parseWfsXml(text);
    }
    features.forEach(function(f) { addFeature(out, f); });
    if (features.length < WFS_PAGE) break;
    startIndex += features.length;
  }
  return Array.from(out.values());
}

// Fallback path (NT): CQL on nvclCollection silently matches nothing, so
// page through ALL boreholes (POST, the nvcl_kit approach) and filter
// locally on the nvclCollection property.
//
// In a STABLE order, to the node's own count (changed 2026-10-13). The
// doi_tracker version paged WFS 1.0.0 with no sort order and stopped at the
// first page holding fewer than FALLBACK_PAGE features. NT's view pages in
// ROWS, and a hole with several rows is one feature, so a full page can hold
// fewer features than it asked for: the page at 200,000 held 9,940. That
// short page ended the loop at about 210,000 of NT's ~329,000 features, and
// every hole past it was lost: 20 of the 41 NVCL holes with a '/' in their
// name, and the owners of 8618198_DDH1.zip and eight other mirrored
// archives. Now the pages are WFS 2.0 sorted on the identifier (verified
// 2026-10-13: count=10 pages at startIndex 0 and 10, and at 300,000 and
// 300,010, abut exactly, and pages offset by 5 overlap by exactly 5),
// startIndex advances by the rows asked for rather than the features
// returned, and only an empty page ends the loop. The node's
// resultType=hits count is returned with the list; harvestNode() marks the
// node degraded when the pages fall below MIN_PAGED_FRACTION of it.
async function fetchWfsUnfiltered(node) {
  const out = new Map();
  const seen = new Set();            // every feature paged, NVCL or not
  let hits = null;
  try {
    hits = await fetchWfsHits(node);
  } catch (e) {
    console.warn('  WFS hits count failed (' + e.message + '); using the count on the first page');
  }
  let startIndex = 0;
  for (;;) {
    const body = 'service=WFS&version=2.0.0&request=GetFeature'
      + '&typeNames=gsmlp:BoreholeView&outputFormat=application/json'
      + '&count=' + FALLBACK_PAGE + '&startIndex=' + startIndex
      + '&sortBy=' + encodeURIComponent(FALLBACK_SORT);
    const text = await fetchText(node.wfs, WFS_FALLBACK_TIMEOUT_MS, {
      method: 'POST', body: body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const page = JSON.parse(text);
    const features = page.features || [];
    if (hits === null && typeof page.numberMatched === 'number') hits = page.numberMatched;
    if (!features.length) break;
    let fresh = 0;
    features.forEach(function(f) {
      const p = f.properties || {};
      const key = String(f.id || p.identifier || '');
      if (!seen.has(key)) { seen.add(key); fresh++; }
      if (String(p.nvclCollection) !== 'true') return;
      addFeature(out, f);
    });
    // A server that ignores startIndex hands back the same page for ever.
    if (!fresh) throw new Error('WFS page at startIndex ' + startIndex + ' held no new features (startIndex ignored?)');
    startIndex += FALLBACK_PAGE;
    if (startIndex > Math.max(2 * (hits || 0), 1000000)) {
      throw new Error('WFS paging passed ' + startIndex + ' rows without an empty page (count ' + hits + ')');
    }
    console.log('  paged ' + startIndex + ' rows, ' + seen.size + ' features, ' + out.size + ' NVCL so far...');
  }
  return { boreholes: Array.from(out.values()), features: seen.size, hits: hits };
}

// The node's own count of BoreholeView features (resultType=hits, no
// filter). NT took about 50 s to answer it on 2026-10-13.
async function fetchWfsHits(node) {
  const url = node.wfs + '?service=WFS&version=2.0.0&request=GetFeature'
    + '&typeNames=gsmlp:BoreholeView&resultType=hits';
  const text = await fetchText(url, WFS_FALLBACK_TIMEOUT_MS);
  const m = text.match(/numberMatched="(\d+)"/);
  if (!m) throw new Error('no numberMatched in the hits response');
  return Number(m[1]);
}

// The borehole id is the WFS identifier with the node's borehole-URL base
// removed: everything after the first '/borehole/' in
// 'https://<host>/resource/feature/<ns>/borehole/<id>', which is the form
// all eight nodes use. It is NOT the last '/' segment. Hole names can hold a
// '/' (NT '82/1', 'NTGS96/1'; WA 'LONDDH1/94'), and cutting at the last one
// gave NT's 82/1, NTGS00/1 and NTGS99/1 the same id '1' and seven WA LONDDH
// holes the id '94', so each overwrote the one before it in the map below
// and real holes vanished (fixed 2026-10-13). The full id is also what each
// node's getDatasetCollection expects: holeidentifier=LONDDH1/94 answers, 94
// does not. An identifier without '/borehole/' keeps the old last-segment
// rule, so an id with no '/' in it is exactly what it always was.
function boreholeIdFrom(identifier) {
  const s = String(identifier || '').replace(/\/+$/, '');
  const m = s.match(/\/borehole\/(.+)$/);
  return m ? m[1] : s.split('/').pop();
}

function addFeature(map, f) {
  const p = f.properties || {};
  const id = boreholeIdFrom(p.identifier);
  if (!id) return;
  const coords = (f.geometry && f.geometry.coordinates) || [];
  const lng = num(coords[0]), lat = num(coords[1]);
  if (lat === null || lng === null || (lat === 0 && lng === 0)) return;
  // The node's own feature number, taken from the GeoJSON feature id
  // ("gsml.borehole.877270"), NOT from properties.identifier - VIC's
  // identifier ends in a free-text name ("...borehole/PROSP-KINGSTON;
  // LOCAL-KIND168"), so the number is nowhere in `id`. VIC and NT name their
  // mirror archives `<featureNumber>_<HOLE>.zip`, so without this the match
  // is impossible and VIC reported 0 of its 39 archives.
  const featureNum = (String(f.id || '').match(/(\d+)\s*$/) || [])[1] || '';
  // The leading number a node files this hole's archives under, when it has
  // one: VIC 'gsml.borehole.877270', NT 'gsml.borehole.8445355_DDH1', SA
  // 'gsml.borehole.72812'. It says whose archive '<number>_<HOLE>.zip' is, so
  // a suffix match cannot hand one hole's archive to another (attachTsg).
  const ownNum = (String(f.id || '').replace(/^[^.]*\.borehole\./i, '').match(/^(\d+)(?=_|$)/) || [])[1]
    || (id.match(/^(\d+)(?=_|$)/) || [])[1] || '';

  map.set(id, {
    id: id,
    featureNum: featureNum,
    ownNum: ownNum,
    name: p.name || id,
    lat: lat, lng: lng,
    lengthM: num(p.boreholeLength_m),
    custodian: p.boreholeMaterialCustodian || '',
    // Descriptive BoreholeView fields the infrastructure map (index.html)
    // shows in its popups. Free on the same response; never used in a count.
    elevation: num(p.elevation_m),
    drillingMethod: p.drillingMethod || '',
    drillEndDate: p.drillEndDate || '',
    purpose: p.description || p.purpose || '',
    datasets: [],
  });
}

// Minimal GML fallback for servers that ignore outputFormat=application/json.
// Enough structure to keep a node alive, not a general GML parser.
function parseWfsXml(text) {
  const features = [];
  const blocks = text.match(/<gsmlp:BoreholeView[\s\S]*?<\/gsmlp:BoreholeView>/g) || [];
  blocks.forEach(function(b) {
    if (!/<gsmlp:nvclCollection>\s*true\s*</.test(b)) return;
    const pos = tag(b, 'gml:pos').split(/\s+/).map(Number);
    // GML 3.2 EPSG:4326 axis order is lat lng; swap if it looks reversed.
    let lat = pos[0], lng = pos[1];
    if (lat > 90 || lat < -90) { lat = pos[1]; lng = pos[0]; }
    features.push({
      properties: {
        identifier: tag(b, 'gsmlp:identifier'),
        name: tag(b, 'gsmlp:name'),
        boreholeLength_m: tag(b, 'gsmlp:boreholeLength_m') || null,
        boreholeMaterialCustodian: tag(b, 'gsmlp:boreholeMaterialCustodian'),
        elevation_m: tag(b, 'gsmlp:elevation_m') || null,
        drillingMethod: tag(b, 'gsmlp:drillingMethod'),
        drillEndDate: tag(b, 'gsmlp:drillEndDate'),
        description: tag(b, 'gsmlp:description'),
        purpose: tag(b, 'gsmlp:purpose'),
        nvclCollection: 'true',
      },
      geometry: { coordinates: [lng, lat] },
    });
  });
  return features;
}

// -- Dataset collection parsing ------------------------------------

async function fetchDatasets(node, boreholeId, timeoutMs) {
  const url = node.nvcl + '/getDatasetCollection.html?holeidentifier='
    + encodeURIComponent(boreholeId);
  const xml = await fetchText(url, timeoutMs || DS_TIMEOUT_MS);
  const datasets = [];
  const blocks = xml.match(/<Dataset>[\s\S]*?<\/Dataset>/g) || [];
  blocks.forEach(function(b) {
    const desc = unescapeXml(tag(b, 'description'));
    const range = b.match(/<DepthRange>[\s\S]*?<\/DepthRange>/);
    const ds = {
      id: tag(b, 'DatasetID'),
      name: tag(b, 'DatasetName'),
      created: dateOnly(tag(b, 'createdDate')),
      instrument: canonicalInstrument(tag(desc, 'InstrumentName')),
      scanDate: dateOnly(tag(desc, 'ScanDate')) || null,
      depthStart: range ? num(tag(range[0], 'start')) : null,
      depthEnd: range ? num(tag(range[0], 'end')) : null,
      // TIR marker: a tirq spectrum element, or 'TIR' in any log name -
      // the same detection rule the retired deep pipeline used.
      tir: /<tirq>/.test(b) || /<logName>[^<]*tir/i.test(b),
      // Descriptive TSG fields the infrastructure map shows (drill date,
      // project, owner). Same response, no extra request, never counted.
      drillDate: dateOnly(tag(desc, 'DrillDate')) || null,
      project: tag(desc, 'Project') || null,
      owner: tag(desc, 'Owner') || null,
      // Spectra measured: the sample positions the instrument recorded a
      // spectrum at (added 2026-10-13, for map_summary.json). Every
      // SpectralLog of a dataset (Reflectance, HullQuot, the derivatives,
      // the TIR set) carries the same sampleCount, because each is a product
      // of the same measurements, so the dataset's figure is the largest of
      // them; summing the logs would count one spectrum up to 15 times.
      spectra: (b.match(/<SpectralLog>[\s\S]*?<\/SpectralLog>/g) || []).reduce(function(acc, sl) {
        const n = num(tag(sl, 'sampleCount'));
        return n !== null && n > acc ? n : acc;
      }, 0) || null,
    };
    // The node's own instrument string, kept apart from `instrument`, which
    // aggregate() back-fills from the TSG header when the node says Unknown.
    ds.apiInstrument = ds.instrument;
    // Effective date: TSG ScanDate when recorded, else system createdDate.
    ds.date = ds.scanDate || ds.created || null;
    datasets.push(ds);
  });
  return datasets;
}

// Canonicalise messy TSG instrument names: trim, collapse whitespace, and
// normalise HyLogger/HyChips version-unit forms ('Hylogger3-2', 'HyLogger 3.2'
// -> 'HyLogger 3-2'). Anything blank or NA-ish lands in the Unknown bucket.
function canonicalInstrument(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!s || /^(na|unknown|na or unknown|none)$/i.test(s)) return 'Unknown';
  const m = s.match(/^(hylogger|hychips)s?\s*(\d+)\s*[-. ]?\s*(\d+)?$/i);
  if (m) {
    const kind = m[1].toLowerCase() === 'hychips' ? 'HyChips' : 'HyLogger';
    return kind + ' ' + m[2] + (m[3] ? '-' + m[3] : '');
  }
  return s;
}

// -- TSG enrichment (data/nvcl/tsg-cache.jsonl) --------------------

// The cache is keyed by THREDDS archive name, which is NOT the WFS borehole
// identifier. WA names an archive after the hole (05GJD001.zip, plus daughter
// archives like 12CADD001_wedge.zip); NT prefixes the numeric feature id
// (1113660_ECD10.zip). So each archive is indexed under three normalised
// keys - whole name, part before the first underscore, part after it - and a
// borehole is matched against them in a fixed precedence order.
function loadTsgIndex(file) {
  const idx = {
    loaded: false, path: file, rows: 0, goneRows: 0, twinRows: 0, byState: {},
    matchedRows: new Set(), states: [],
  };
  if (!fs.existsSync(file)) {
    console.log('\nTSG cache: none at ' + file + ' (no enrichment this run)');
    return idx;
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach(function(line) {
    if (!line.trim()) return;
    let r;
    try { r = JSON.parse(line); } catch (e) { return; }
    if (!r || !r.state || !r.zipName) return;
    const st = idx.byState[r.state] || (idx.byState[r.state] = {
      rows: [], full: new Map(), prefix: new Map(), suffix: new Map(), uuid: new Map(),
      groups: new Map(), gone: 0,
    });
    r._key = r.state + '/' + r.zipName;
    // Gone from the mirror (added 2026-10-13; thredds-catalog.js stamps it).
    // The row stays in the cache as the record of a scan, but there is no
    // archive to link and, when the file was renamed, its successor carries
    // the same scan: matching or counting it would count that scan twice or
    // point at a missing file. So it is neither.
    if (r.gone) { st.gone++; idx.goneRows++; return; }
    idx.rows++;
    // Rows sharing a TSG UUID AND a scan interval are ONE dataset under two
    // archive names (added 2026-10-13): NT 7882528_TDD01.zip and
    // 7882528_TDD01_Old.zip, DD91DC1.zip and 1311112_DD91DC1.zip. The cache
    // held 96 groups of rows sharing a UUID on 2026-10-13 (98 surplus rows),
    // and each counted once per archive, in a hole's datasets and metres or
    // in mirror-only. In all 93 groups whose rows record an interval it is
    // the same interval. Most are an old name the mirror has since replaced,
    // which the gone stamp above removes; for the rest the group is
    // matched, claimed and counted as one dataset, carried by one
    // representative. A UUID alone is not enough: the other three groups
    // have no interval, and are one header copied into several holes'
    // archives (NT 8440883_Baldwin1.zip, 8440896_MacIntyre1.zip and
    // 8445494_Ross_1.zip: one UUID, one 'Created' date, files of 2.5, 1.4
    // and 2.1 GB; QLD EloiseDeeps_ED126, MountFortConstantine_EHMT001 and
    // Trekelano_QMD13; QLD WolframCamp_DRD01 and _DRD06). Grouping those
    // made three holes rival claimants of one 'dataset', and all three lost
    // their own archive, so rows without an interval are never grouped.
    const u = uuidKey(r.tsgUuid);
    const iv = r.depthFromM != null && r.depthToM != null ? r.depthFromM + '-' + r.depthToM : '';
    r._group = u && iv ? r.state + '#' + u + '#' + iv : r._key;
    const g = st.groups.get(r._group);
    if (g) { g.push(r); idx.twinRows++; } else st.groups.set(r._group, [r]);
    st.rows.push(r);
    const base = String(r.zipName).replace(/\.zip$/i, '');
    const cut = base.indexOf('_');
    push(st.uuid, uuidKey(r.tsgUuid), r);
    push(st.full, normKey(base), r);
    if (cut > 0) {
      push(st.prefix, normKey(base.slice(0, cut)), r);
      push(st.suffix, normKey(base.slice(cut + 1)), r);
    }
  });
  // One representative per UUID group, the row the hole's figures and the
  // map's link are taken from: one with an interval, then one with a scan
  // date, then not an '_Old' copy, then the shorter name. The others are
  // listed on it as twins.
  Object.keys(idx.byState).forEach(function(code) {
    const st = idx.byState[code];
    st.rep = new Map();
    st.groups.forEach(function(members, key) {
      const ranked = members.slice().sort(function(a, b) {
        return rank(a) - rank(b) || a.zipName.length - b.zipName.length
          || (a.zipName < b.zipName ? -1 : (a.zipName > b.zipName ? 1 : 0));
      });
      ranked[0]._twins = ranked.slice(1).map(function(r) { return r.zipName; });
      st.rep.set(key, ranked[0]);
    });
  });
  idx.loaded = true;
  idx.states = Object.keys(idx.byState).sort();
  console.log('\nTSG cache: ' + idx.rows + ' rows across ' + idx.states.join(', ')
    + ' (' + idx.goneRows + ' more gone from the mirror, never matched or counted; '
    + idx.twinRows + ' share a TSG UUID and scan interval with another row and count with it)');
  return idx;

  function rank(r) {
    return (r.depthFromM != null && r.depthToM != null ? 0 : 4)
      + (r.scanDate ? 0 : 2) + (/old/i.test(r.zipName) ? 1 : 0);
  }

  function push(map, k, v) {
    if (!k) return;
    const a = map.get(k);
    if (a) a.push(v); else map.set(k, [v]);
  }
}

// The TSG header's UUID as a join key (added 2026-10-13). It is the same
// value as the node's getDatasetCollection DatasetID. Most headers and most
// DatasetIDs carry a 35-character form missing the GUID's last digit
// ('45abb8f4-267e-46a6-bab1-63bf4d2f17a'); some of both carry all 36 (141
// cached headers; 121 of SA's and TAS's 2,327 DatasetIDs on 2026-10-13).
// Both sides are lower-cased and cut to 35 characters so either form meets
// the other. Anything that is not GUID-shaped gives no key, and joins nothing.
function uuidKey(s) {
  const v = String(s || '').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{11,12}$/.test(v) ? v.slice(0, 35) : '';
}

// Uppercase, strip every separator. '115904_ALF006/01' and 'ALF006-01' both
// collapse so a punctuation difference between WFS and filename never costs
// a match.
function normKey(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Sum the scan intervals of cache rows that matched no harvested borehole.
// Per archive, not per borehole: there is no borehole to union against, so
// each archive contributes its own interval once. The same garbage clamp
// cannot be applied (no drilled length is known without the borehole), so a
// hard 5 km ceiling stands in for it - longer than any real scanned core.
function mirrorOnly(st, used) {
  let m = 0, n = 0;
  // One archive basename = one borehole. An earlier version collapsed a
  // trailing `-N` on the theory that a hole scanned in sections is mirrored
  // as `203950-3.zip`, `203950-4.zip`. The cache does not bear that out: all
  // ten `-N` groups in it have OVERLAPPING depth intervals, so none are
  // sequential sections. They are distinct holes sharing a project prefix -
  // WA/MG19-001..010 each start at 0 m, and WA/WTB skips from -07 to -09 to
  // -14, which no section numbering would do. Collapsing merged 41 real WA
  // boreholes into 10. If a state ever does mirror true sections, add the
  // rule back behind a non-overlap test rather than on the name alone.
  const holes = {};
  // Per dataset, not per archive name: a UUID group counts once, through its
  // representative (see loadTsgIndex). Gone rows are not in st at all.
  st.rep.forEach(function(r) {
    if (used.has(r._key)) return;
    // Archives sharing a leading feature number are one borehole scanned in
    // sections, not several holes. VIC/976431 is STAVELY04 twice - 0-54.5 m
    // sonic then 56.4-102.8 m diamond - contiguous, non-overlapping, one hole.
    // Counting per archive inflated VIC from 29 boreholes to 39. This is the
    // collapse that IS supported by the data; an earlier rule keyed on a
    // trailing `-N` was not, and was removed.
    const base = String(r.zipName || '').replace(/\.zip$/i, '');
    // NOT `m` - that is the metre accumulator in the enclosing scope.
    const featureId = base.match(/^(\d+)_/);
    const hole = featureId ? featureId[1] : base;
    if (hole) holes[hole] = true;
    if (r.depthFromM === null || r.depthFromM === undefined) return;
    if (r.depthToM === null || r.depthToM === undefined) return;
    const len = r.depthToM - r.depthFromM;
    if (!(len > 0) || len > 5000) return;
    m += len; n++;
  });
  return { m: m, n: n, boreholes: Object.keys(holes).length };
}

// ============================================================
// BOREHOLE COORDINATE CACHE
// ============================================================
// The state WFS services are the only source of a borehole's coordinates, and
// they are not reliable: TAS answered HTTP 500 on 10 Aug and again on 17 Aug,
// and because each harvest rebuilt the snapshot from whatever answered THAT
// DAY, its 482 boreholes simply left the map - for eleven days, unnoticed,
// because five of eight nodes were up and the health guard only counts nodes.
//
// A borehole does not stop existing because a web service is down. So every
// coordinate we successfully read is written here and reused when the service
// that gave it to us cannot be reached. WFS becomes the thing that ADDS and
// CORRECTS rows rather than the thing the map depends on being up.
//
// Measurement is already durable this way - tsg-cache.jsonl holds the scan
// intervals - so with both caches a node that is completely down still
// reports its boreholes, its kilometres and its scan dates.
//
// Rows flagged `seeded` (synthetic `seed:STATE:N` ids, coordinates only) came
// from the doi_tracker page feed while TAS was down in August 2026. They can
// place a dot but cannot match a TSG archive; purgeSeeded() drops them the
// first time the real service answers.
function loadBoreholeCache(file) {
  const byState = {};
  let rows = 0;
  if (!fs.existsSync(file)) {
    console.log('\nBorehole cache: none at ' + file + ' (first run seeds it)');
    return { byState: byState, rows: 0, path: file };
  }
  fs.readFileSync(file, 'utf8').split('\n').forEach(function(line) {
    if (!line.trim()) return;
    let r;
    try { r = JSON.parse(line); } catch (e) { return; }
    if (!r || !r.state || !r.id) return;
    (byState[r.state] || (byState[r.state] = new Map())).set(r.id, r);
    rows++;
  });
  const states = Object.keys(byState).sort().map(function(k) {
    return k + ':' + byState[k].size;
  }).join(' ');
  console.log('\nBorehole cache: ' + rows + ' rows  [' + states + ']');
  return { byState: byState, rows: rows, path: file };
}

// Fold a live WFS answer back into the cache. Coordinates are overwritten from
// the service (it is authoritative when it answers); firstSeen is preserved so
// the cache also records how long we have known about a hole.
function mergeBoreholeCache(cache, state, boreholes, today, legacyFirstSeen) {
  const m = cache.byState[state] || (cache.byState[state] = new Map());
  let added = 0;
  boreholes.forEach(function(bh) {
    const prev = m.get(bh.id);
    m.set(bh.id, {
      state: state, id: bh.id, name: bh.name,
      lat: bh.lat, lng: bh.lng,
      lengthM: bh.lengthM, custodian: bh.custodian || '',
      firstSeen: (prev && prev.firstSeen) || (legacyFirstSeen && legacyFirstSeen[bh.name]) || today,
      lastSeen: today,
    });
    if (!prev) added++;
  });
  return added;
}

// Rebuild a node's borehole list from cache. Returned rows are the same shape
// fetchWfs* produces, so nothing downstream needs to know where they came from.
function boreholesFromCache(cache, state) {
  const m = cache.byState[state];
  if (!m || !m.size) return [];
  return Array.from(m.values()).map(function(r) {
    return {
      id: r.id, name: r.name, lat: r.lat, lng: r.lng,
      lengthM: r.lengthM, custodian: r.custodian || '',
      datasets: [], fromCache: true, coordsAsOf: r.lastSeen || null,
      seeded: !!r.seeded,
    };
  });
}

// Drop rows cached under a truncated pre-fix id (see boreholeIdFrom): '1'
// where the node now says '1654228_82/1', '94' where it says 'LONDDH1/94'.
// Left in place they would be drawn twice whenever the node is down. A row
// goes only when its id has no '/', is not a live id, and is the last
// segment of a live id that has one. Its firstSeen passes to the live row of
// the same name: the cache knew that hole, under the wrong key.
function purgeTruncatedIds(cache, state, boreholes) {
  const out = { n: 0, ids: [], firstSeenByName: {} };
  const m = cache.byState[state];
  if (!m) return out;
  const live = new Set(), tails = new Set();
  boreholes.forEach(function(bh) {
    live.add(bh.id);
    if (bh.id.indexOf('/') !== -1) tails.add(bh.id.split('/').pop());
  });
  if (!tails.size) return out;
  Array.from(m.keys()).forEach(function(k) {
    if (live.has(k) || k.indexOf('/') !== -1 || !tails.has(k)) return;
    const r = m.get(k);
    if (r && r.name && r.firstSeen) out.firstSeenByName[r.name] = r.firstSeen;
    m.delete(k);
    out.n++;
    out.ids.push(k);
  });
  return out;
}

// Drop seeded placeholders for a state once its service answers for real.
function purgeSeeded(cache, state) {
  const m = cache.byState[state];
  if (!m) return 0;
  let n = 0;
  Array.from(m.keys()).forEach(function(k) {
    if (m.get(k) && m.get(k).seeded) { m.delete(k); n++; }
  });
  return n;
}

function saveBoreholeCache(cache, file) {
  const out = [];
  Object.keys(cache.byState).sort().forEach(function(st) {
    Array.from(cache.byState[st].values())
      .sort(function(a, b) { return a.id < b.id ? -1 : 1; })
      .forEach(function(r) { out.push(JSON.stringify(r)); });
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.join('\n') + (out.length ? '\n' : ''));
  return out.length;
}

// Attach cache rows to boreholes and report the match rate. Rows that match
// nothing are counted and logged - never silently dropped.
function attachTsg(result, idx) {
  const st = idx.byState[result.node.code];
  result.tsg = { rows: st ? st.rows.length : 0, gone: st ? st.gone : 0, matchedRows: 0, matchedBoreholes: 0,
    tiers: {}, tierRows: {} };
  if (!st) return;

  // A node that returned NO boreholes - unreachable, or not participating -
  // still has mirror evidence, and it is the case that needs counting most.
  // Returning early here dropped 100% of such a state's scanning record: on
  // 17 Aug 2026 TAS answered HTTP 500 and its 506 archives (~142 km) vanished
  // from the national figure entirely, as did VIC's 39. That inverts the rule
  // this whole section exists to enforce. With no boreholes to match against,
  // `used` stays empty and every cache row falls through to mirror-only.
  const used = new Set();

  // A node serving cached coordinates reports figures carried forward from the
  // run that last reached it, and those figures already include every one of
  // its TSG archives. Letting the same archives fall through to mirror-only
  // would count the same holes twice - 482 cached TAS boreholes PLUS 499
  // mirror-only TAS archives, for a state that has about 500 holes in total.
  if (result.fromCache) {
    st.rows.forEach(function(r) { used.add(r._key); idx.matchedRows.add(r._key); });
    result.tsg.matchedRows = used.size;
    result.tsg.mirrorOnlyKm = 0;
    result.tsg.mirrorOnlyArchives = 0;
    result.tsg.mirrorOnlyBoreholes = 0;
    console.log('  TSG: ' + st.rows.length + ' cache row(s) attributed to the '
      + 'carried-forward figures for this node, not to mirror-only');
    return;
  }

  const resolved = resolveTsgMatches(st, result.boreholes);
  result.boreholes.forEach(function(bh, i) {
    const hit = resolved.hits[i];
    if (!hit) return;
    bh.tsg = hit.rows;
    bh.tsgTier = hit.tiers.join('+');
    result.tsg.matchedBoreholes++;
    result.tsg.tiers[hit.tier] = (result.tsg.tiers[hit.tier] || 0) + 1;
    // A matched representative takes its UUID twins with it.
    hit.rows.forEach(function(r) {
      st.groups.get(r._group).forEach(function(m) { used.add(m._key); idx.matchedRows.add(m._key); });
    });
    Object.keys(hit.rowTiers).forEach(function(t) {
      result.tsg.tierRows[t] = (result.tsg.tierRows[t] || 0) + hit.rowTiers[t];
    });
  });
  result.tsg.matchedRows = used.size;
  result.tsg.rejected = resolved.rejected;
  const rj = resolved.rejected;
  if (rj.claimed || rj.owner || rj.generic || rj.ambiguous || rj.prefix) {
    console.log('  TSG: weaker-tier hits refused - ' + rj.claimed + ' already matched to another hole, '
      + rj.owner + ' filed under another hole\'s feature number, ' + rj.generic
      + ' generic suffix not the hole\'s whole name, ' + rj.prefix
      + ' prefix hit beaten by another hole\'s whole-name hit, ' + rj.ambiguous + ' ambiguous'
      + (rj.examples.length ? ' (e.g. ' + rj.examples.slice(0, 4).join('; ') + ')' : ''));
  }

  // MIRROR-ONLY MEASUREMENT. A cache row that matched no borehole is not
  // noise: the instrument file records core it actually scanned, for a hole
  // the node does not surface (QLD's API fails ~27% of its queries; VIC
  // publishes no datasets at all). Discarding these understated the national
  // figure by ~355 km, and did so worst where a state's service is weakest -
  // exactly backwards. They are measured, sourced to the mirror, and counted
  // on their own line rather than blended into per-borehole coverage.
  const mo = mirrorOnly(st, used);
  result.tsg.mirrorOnlyKm = km(mo.m);
  result.tsg.mirrorOnlyArchives = mo.n;
  result.tsg.mirrorOnlyBoreholes = mo.boreholes;

  if (!result.boreholes.length) {
    console.log('  TSG: no boreholes harvested - all ' + st.rows.length
      + ' cache rows counted as mirror-only ('
      + result.tsg.mirrorOnlyBoreholes + ' boreholes, '
      + result.tsg.mirrorOnlyKm + ' km from the mirror)');
    return;
  }

  const pct = st.rows.length ? Math.round(used.size / st.rows.length * 1000) / 10 : 0;
  console.log('  TSG: ' + used.size + '/' + st.rows.length + ' cache rows matched ('
    + pct + '%) to ' + result.tsg.matchedBoreholes + ' boreholes'
    + '  [holes by first tier ' + tierList(result.tsg.tiers) + ']'
    + '  [archives by tier ' + tierList(result.tsg.tierRows) + ']');
  const orphan = st.rows.length - used.size;
  if (orphan > 0) {
    const sample = st.rows.filter(function(r) { return !used.has(r._key); })
      .slice(0, 4).map(function(r) { return r.zipName; }).join(', ');
    console.log('  TSG: ' + orphan + ' cache rows matched no harvested borehole (e.g. ' + sample + ')');
  }
}

function tierList(counts) {
  return TSG_TIERS.filter(function(t) { return counts[t]; }).map(function(t) {
    return t + ':' + counts[t];
  }).join(' ');
}

// Tier order, strongest first. 'uuid' (added 2026-10-13) is not a name
// match at all: the archive's TSG UUID is one of the hole's DatasetIDs, so
// the node itself says the archive is that hole's dataset. The suffix tiers
// key on the part of an archive name after its first underscore, which is
// how NT, SA and VIC file a hole ('<featureNumber>_<HOLE>.zip') - and also
// where generic hole names like DDH1 or BD2 live, so those two tiers carry
// extra conditions.
const TSG_TIERS = ['uuid', 'id', 'num', 'name', 'name-suffix', 'id-suffix', 'local-name'];
const SUFFIX_TIERS = { 'name-suffix': true, 'id-suffix': true };

// Assign each archive to at most one borehole (added 2026-10-13). Matching
// hole by hole, each taking the first tier that hit anything, let one
// archive land on several holes: NT 8445355 and 8446742 are both named DDH1,
// so each took the six NN_DDH1.zip archives (8618198_DDH1.zip and five
// more), which belong to six other NT holes; SA 139115 'DDH 1' took
// 72812_DDH1.zip from SA 72812. The NT owners were not in the harvest at the
// time: all six lie past the point where the unsorted NT paging stopped (see
// fetchWfsUnfiltered), so nothing else claimed their archives. Ten archives
// were counted twice, their metres too, and gave the wrong month to the
// hole that borrowed them. Now the tiers run in order across the whole
// node, and:
//   - an archive matched at one tier is never matched again at a weaker one;
//   - an archive two holes claim at the same tier goes to neither (it is
//     counted as mirror-only rather than guessed);
//   - a suffix hit is refused when the archive's leading number is another
//     hole's feature number - 72812_DDH1.zip is filed under SA 72812;
//   - a generic suffix (shorter than 5 characters, or letters-then-digits
//     like DDH1, BD2, BDH3) matches only a hole whose whole normalised name
//     it is;
//   - (e) within a tier, a hole whose WHOLE name or id is the archive's
//     name beats holes that only reach it as a prefix (added 2026-10-13):
//     when exactly one claimant has the whole-name hit, it takes the
//     archive, and only otherwise is the archive declared ambiguous.
// A hole whose candidates at one tier are all refused falls through to the
// next tier, exactly as a hole with no candidates there does.
//
// The 'uuid' tier runs first and is ADDITIVE (added 2026-10-13): the
// archives whose UUID is one of a hole's DatasetIDs are that hole's, and are
// out of reach of every name tier, but the hole still takes part in the name
// tiers for its other archives. A node lists only the datasets it publishes,
// and a hole's unpublished scan (a wedge, an older run) is still matched by
// name exactly as before. Two holes listing the same DatasetID would make
// its archive ambiguous like any other tier; none did on 2026-10-13.
function resolveTsgMatches(st, boreholes) {
  const cands = boreholes.map(function(bh) { return tsgCandidates(st, bh); });
  const numOwners = new Map();
  boreholes.forEach(function(bh, i) {
    if (!bh.ownNum) return;
    (numOwners.get(bh.ownNum) || numOwners.set(bh.ownNum, []).get(bh.ownNum)).push(i);
  });
  const hits = boreholes.map(function() { return null; });
  const claimed = new Map();               // dataset (UUID group) -> borehole index
  const ambiguousSeen = new Set();
  const rejected = { claimed: 0, owner: 0, generic: 0, ambiguous: 0, prefix: 0, examples: [] };
  TSG_TIERS.forEach(function(tier, t) {
    const tentative = new Map();           // borehole index -> rows
    const claimants = new Map();           // archive key -> borehole indexes
    boreholes.forEach(function(bh, i) {
      // A name-tier hit ends a hole's matching; a uuid hit does not.
      if ((hits[i] && hits[i].named) || !cands[i] || !cands[i][t] || !cands[i][t].length) return;
      const rows = cands[i][t].filter(function(r) {
        if (claimed.has(r._group)) {
          // Already this hole's (by uuid) is not a refusal.
          if (claimed.get(r._group) !== i) refuse('claimed', r, bh, boreholes[claimed.get(r._group)]);
          return false;
        }
        if (!SUFFIX_TIERS[tier]) return true;
        const base = String(r.zipName).replace(/\.zip$/i, '');
        const lead = (base.match(/^(\d+)_/) || [])[1];
        const owners = lead ? numOwners.get(lead) : null;
        if (owners && owners.some(function(o) { return o !== i; })) {
          refuse('owner', r, bh, boreholes[owners.filter(function(o) { return o !== i; })[0]]);
          return false;
        }
        // A hole that has its own feature number cannot own an archive filed
        // under a different one, even when that other hole is not in the
        // harvested list: NT 8445359 'DDH3' was taking 8708941_DDH3.zip and
        // 8750821_DDH3.zip, two holes scanned 20 months apart whose owners
        // the unsorted NT paging never reached.
        if (lead && bh.ownNum && lead !== bh.ownNum) {
          refuse('owner', r, bh, null);
          return false;
        }
        const token = normKey(base.slice(base.indexOf('_') + 1));
        if (isGenericToken(token) && normKey(bh.name) !== token) {
          refuse('generic', r, bh, null);
          return false;
        }
        return true;
      });
      if (!rows.length) return;
      tentative.set(i, rows);
      // Claims are on the dataset (a UUID group), not the archive name: two
      // holes reaching different names of one dataset are rival claimants.
      const mine = new Set();
      rows.forEach(function(r) {
        if (mine.has(r._group)) return;
        mine.add(r._group);
        (claimants.get(r._group) || claimants.set(r._group, []).get(r._group)).push(i);
      });
    });
    tentative.forEach(function(rows, i) {
      const kept = rows.filter(function(r) {
        const who = claimants.get(r._group);
        if (who.length === 1) return true;
        // (e) one whole-name claimant beats prefix claimants.
        const whole = who.filter(function(k) { return cands[k].whole[t].has(r._group); });
        if (whole.length === 1) {
          if (whole[0] === i) return true;
          rejected.prefix++;
          example(r.zipName + ' not ' + boreholes[i].id + ' (whole name of ' + boreholes[whole[0]].id + ')');
          return false;
        }
        if (who[0] === i && !ambiguousSeen.has(r._group)) {
          ambiguousSeen.add(r._group);
          rejected.ambiguous++;
          example(r.zipName + ' claimed at ' + tier + ' by ' + who.map(function(k) {
            return boreholes[k].id;
          }).join(' and '));
        }
        return false;
      });
      if (!kept.length) return;
      const h = hits[i] || (hits[i] = { tier: tier, tiers: [], rows: [], rowTiers: {}, named: false });
      // One representative per dataset; rowTiers counts every archive name
      // the tier brought in, twins included, so the tiers sum to the rows
      // matched.
      const groups = [];
      kept.forEach(function(r) {
        if (claimed.has(r._group)) return;
        claimed.set(r._group, i);
        groups.push(r._group);
      });
      h.tiers.push(tier);
      h.rowTiers[tier] = groups.reduce(function(n, g) { return n + st.groups.get(g).length; }, 0);
      h.rows = h.rows.concat(groups.map(function(g) { return st.rep.get(g); }));
      if (tier !== 'uuid') h.named = true;
    });
  });
  return { hits: hits, rejected: rejected };

  function refuse(kind, r, bh, other) {
    rejected[kind]++;
    example(r.zipName + ' not ' + bh.id + (other ? ' (' + other.id + ')' : ''));
  }
  function example(s) { if (rejected.examples.length < 12) rejected.examples.push(s); }
}

// DDH1, BD2, BDH3, 'DDH 1': a hole name that many unrelated holes share.
function isGenericToken(token) {
  return token.length < 5 || /^[A-Z]{1,4} ?\d{1,3}$/.test(token);
}

// Every tier's candidate archives for one borehole, in TSG_TIERS order
// (null for a seeded placeholder), with `whole[t]` the keys of the ones the
// tier reached by the archive's WHOLE name (or, for 'uuid', all of them),
// which rule (e) in resolveTsgMatches ranks above prefix hits. Whole-name
// and prefix hits are unioned at
// the same tier so a hole and its daughter wedges (12CADD001.zip +
// 12CADD001_wedge.zip) are counted together - the interval union then
// absorbs their overlap. normKey drops every separator, so an id written
// '82/1' meets its archive 1654228_82_1.zip and 'LONDDH1/94' meets
// LONDDH1-94.zip.
function tsgCandidates(st, bh) {
  // Seeded placeholders carry synthetic ids and no names: matching them
  // against archive names could only ever produce a false hit.
  if (bh.seeded) return null;
  const idKey = normKey(bh.id);
  const nameKey = normKey(bh.name);
  // The bare feature number. VIC and NT name their archives
  // `<featureNumber>_<HOLE>...` - 877270_KIND168.zip - while their WFS ids
  // arrive as `gsml.borehole.877270`. normKey flattens that whole string to
  // GSMLBOREHOLE877270, which can never equal the archive's 877270 key, so
  // every VIC row missed: 39 archives, 0 matched, and a state that has been
  // scanned since 2010 reported zero boreholes on the map. Matching the
  // trailing number as its own tier fixes it, and it is a SAFE key precisely
  // because it is a node's own feature id, not a free-text name.
  const numKey = bh.featureNum
    || (String(bh.id || '').match(/(\d+)\s*$/) || [])[1] || '';
  // Added in the AuScope_Outreach port (2026-10-13), lowest precedence: the
  // GSV local hole name. VIC names some boreholes 'LOCAL-BEU162' or
  // 'LOCAL-BL214; PROSP-HARROW-DOUGLAS' and mirrors them as BEU162.zip,
  // BL214.zip, with no feature number, so none of the tiers above can join
  // them: 13 of VIC's 29 boreholes fell through to mirror-only and off the
  // map. Only an explicit 'LOCAL-' token is used, never free text.
  const localKeys = String(bh.name || '').split(';').map(function(t) {
    const m = t.trim().match(/^LOCAL-(.+)$/i);
    return m ? normKey(m[1]) : '';
  }).filter(Boolean);
  let localHit = null, localWhole = null;
  localKeys.forEach(function(k) {
    localHit = union(localHit, union(st.full.get(k), st.prefix.get(k)));
    localWhole = union(localWhole, st.full.get(k));
  });
  // The archives whose UUID is one of this hole's DatasetIDs. A UUID that
  // several archives carry without being one dataset (a copied header; see
  // loadTsgIndex) identifies none of them and joins nothing here; their
  // names still can, at the tiers below.
  let uuidHit = null;
  (bh.datasets || []).forEach(function(ds) {
    const k = uuidKey(ds.id);
    const rows = k ? st.uuid.get(k) : null;
    if (rows && rows.every(function(r) { return r._group === rows[0]._group; })) {
      uuidHit = union(uuidHit, rows);
    }
  });
  // Same order as TSG_TIERS.
  const out = [
    uuidHit,
    union(st.full.get(idKey), st.prefix.get(idKey)),
    numKey ? union(st.full.get(numKey), st.prefix.get(numKey)) : null,
    union(st.full.get(nameKey), st.prefix.get(nameKey)),
    st.suffix.get(nameKey) || null,
    st.suffix.get(idKey) || null,
    localHit,
  ];
  out.whole = [
    uuidHit,
    st.full.get(idKey),
    numKey ? st.full.get(numKey) : null,
    st.full.get(nameKey),
    null,
    null,
    localWhole,
  ].map(function(rows) { return new Set((rows || []).map(function(r) { return r._group; })); });
  return out;

  function union(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    const seen = new Set(a.map(function(r) { return r._key; }));
    return a.concat(b.filter(function(r) { return !seen.has(r._key); }));
  }
}

// The scan dates a borehole's TSG archives report, ascending. These override
// the API's createdDate, which is the day the record was ingested.
function tsgDates(bh) {
  if (!bh.tsg) return [];
  return bh.tsg.map(function(r) { return r.scanDate ? String(r.scanDate).substring(0, 10) : null; })
    .filter(Boolean).sort();
}

function tsgInstrument(bh) {
  if (!bh.tsg) return null;
  for (let i = 0; i < bh.tsg.length; i++) {
    if (bh.tsg[i].instrument) return canonicalInstrument(bh.tsg[i].instrument);
  }
  return null;
}

// -- Metrics (the merged methodology) ------------------------------

// Per-borehole scan metrics from its datasets' depth intervals.
//   valid interval: start & end present, end > start, and (end-start) within
//   CLAMP_FACTOR x drilled length when the drilled length is known.
//   uniqueM: union of valid intervals.  totalM: plain sum (rescans count).
//   unrecorded: datasets contributing zero because their interval is
//   missing or invalid - NEVER substituted with borehole length.
function boreholeMetrics(bh) {
  const intervals = [];
  let unrecorded = 0, clamped = 0;
  bh.datasets.forEach(function(ds) {
    if (ds.depthStart === null || ds.depthEnd === null || ds.depthEnd <= ds.depthStart) {
      unrecorded++;
      return;
    }
    const len = ds.depthEnd - ds.depthStart;
    if (bh.lengthM && bh.lengthM > 0 && len > bh.lengthM * CLAMP_FACTOR) {
      clamped++;
      unrecorded++;           // clamped intervals are a subtype of unrecorded
      return;
    }
    intervals.push([ds.depthStart, ds.depthEnd]);
  });

  let totalM = 0;
  intervals.forEach(function(iv) { totalM += iv[1] - iv[0]; });

  // Union: sort by start, merge overlapping/adjacent, sum survivor lengths.
  let uniqueM = unionLength(intervals);

  // -- Precedence: TSG interval > API interval > drilled-length estimate --
  //
  // TSG FIRST, deliberately. The TSG header is the instrument's own record of
  // the interval it scanned; the node API is a downstream republication of it.
  // Preferring the API would measure the country two different ways - some
  // states from instrument files, others from node metadata - and a national
  // total assembled from two definitions is not one number. The same source
  // already had to win for DATES, where the API's value turned out to be an
  // ingest timestamp; consistency means it wins for depth too, not only where
  // the API happens to be silent.
  //
  // The API remains the FALLBACK, and that matters: some boreholes are
  // published by a node but have no archive on the mirror (NT lists 420 with
  // data against 345 archives), so an API interval is used wherever no TSG
  // interval exists. Nothing is discarded - the sources swap rank, and every
  // borehole records which one it used in `source`.
  let tsgM = 0;
  if (bh.tsg && bh.tsg.length) {
    const tsgIntervals = [];
    bh.tsg.forEach(function(r) {
      if (r.depthFromM === null || r.depthFromM === undefined) return;
      if (r.depthToM === null || r.depthToM === undefined) return;
      if (!(r.depthToM > r.depthFromM)) return;
      // Same garbage clamp the API path uses - one rule for all sources.
      if (bh.lengthM && bh.lengthM > 0 && (r.depthToM - r.depthFromM) > bh.lengthM * CLAMP_FACTOR) return;
      tsgIntervals.push([r.depthFromM, r.depthToM]);
    });
    tsgM = unionLength(tsgIntervals);
    if (tsgM > 0) {
      uniqueM = tsgM;
      // Total scan work: a wedge archive is genuine extra instrument time,
      // so total sums them while unique unions them.
      let sum = 0;
      tsgIntervals.forEach(function(iv) { sum += iv[1] - iv[0]; });
      totalM = sum;
    }
  }

  // Tier 3 (estimate). Neither an API interval nor a TSG one: fall back to
  // the drilled hole length, ONCE per borehole (never per dataset; rescans
  // must not inflate an estimate). Reported separately as estimated_km and
  // never blended into the measured total.
  let estimatedM = 0;
  if (uniqueM === 0 && unrecorded > 0 && bh.lengthM && bh.lengthM > 0) {
    estimatedM = bh.lengthM;
  }

  return {
    uniqueM: uniqueM, totalM: totalM, estimatedM: estimatedM,
    apiM: (tsgM === 0 && intervals.length) ? uniqueM : 0,
    tsgM: tsgM,
    source: tsgM > 0 ? 'tsg' : (intervals.length ? 'api' : (estimatedM > 0 ? 'estimate' : 'none')),
    unrecorded: unrecorded, clamped: clamped,
    intervalDatasets: intervals.length,
  };
}

// Length of the union of [start, end] intervals: sort, merge touching or
// overlapping, sum the survivors.
function unionLength(list) {
  const ivs = list.slice().sort(function(a, b) { return a[0] - b[0]; });
  let total = 0, curStart = null, curEnd = null;
  ivs.forEach(function(iv) {
    if (curStart === null) { curStart = iv[0]; curEnd = iv[1]; return; }
    if (iv[0] <= curEnd) { if (iv[1] > curEnd) curEnd = iv[1]; return; }
    total += curEnd - curStart;
    curStart = iv[0]; curEnd = iv[1];
  });
  if (curStart !== null) total += curEnd - curStart;
  return total;
}

// -- Aggregation ---------------------------------------------------

// prev is the previous snapshot, used ONLY to carry a node forward when it
// could not be reached this run.
function aggregate(results, asOf, tsgIndex, prev) {
  const prevStates = {};
  ((prev && prev.states) || []).forEach(function(e) {
    if (e && e.state) prevStates[e.state] = e;
  });
  const today = new Date(asOf + 'T00:00:00Z');
  const cutoff12mo = new Date(today.getTime() - 365 * 86400000).toISOString().substring(0, 10);
  tsgIndex = tsgIndex || { loaded: false, rows: 0, byState: {}, matchedRows: new Set() };

  const states = [];
  let sumDatasets = 0, sumBoreholesWithData = 0, sumUniqueM = 0, sumTotalM = 0;
  let sumUnrecorded = 0, sumClamped = 0, sumDrilledM = 0, sumWithInstrument = 0, sumTir = 0;
  let sumEstimatedM = 0, sumEstimatedBh = 0;
  let sumMirrorOnlyKm = 0, sumMirrorOnlyArchives = 0, sumMirrorOnlyBoreholes = 0;
  let sumApiM = 0, sumTsgM = 0, sumTsgBh = 0;
  let sumDatesTsg = 0, sumDatesApi = 0;
  let earliest = null, latest = null;
  let rescanBoreholes = 0, maxScans = 0;
  const participating = [], nonParticipating = [];
  let nonPartBoreholes = 0;

  results.forEach(function(r) {
    const node = r.node;
    if (!r.wfsOk && !r.boreholes.length) {
      // The node did not answer AND we hold no cached coordinates for it, so
      // there is nothing to place on a map. The mirror may still hold its
      // archives.
      // Those are scans the instrument demonstrably performed, and they do not
      // stop being evidence because a state service is down - so they are
      // counted here rather than lost alongside the node. TAS answered HTTP
      // 500 on 17 Aug 2026 while the mirror held 506 of its archives; dropping
      // them cost the national figure ~142 km and penalised the state hardest
      // hit by its own outage.
      const moKm = (r.tsg && r.tsg.mirrorOnlyKm) || 0;
      const moArchives = (r.tsg && r.tsg.mirrorOnlyArchives) || 0;
      const moBoreholes = (r.tsg && r.tsg.mirrorOnlyBoreholes) || 0;
      sumMirrorOnlyKm += moKm;
      sumMirrorOnlyArchives += moArchives;
      sumMirrorOnlyBoreholes += moBoreholes;
      states.push({
        state: node.code, status: 'unreachable',
        wfs_registered_boreholes: null, total_datasets: 0,
        total_boreholes_with_data: 0, total_km_scanned: 0,
        unique_scanned_km: 0, total_scan_km: 0, interval_unrecorded: 0,
        latest_dataset_date: null, days_since_latest: null,
        datasets_last_12mo: 0, km_scanned_last_12mo: 0,
        mirror_only_km: moKm,
        mirror_only_archives: moArchives,
        mirror_only_boreholes: moBoreholes,
        evidenced_boreholes: moBoreholes,
        note: moArchives
          ? 'Node did not answer during this harvest. Its own figures are absent, '
            + 'not zero; the ' + moArchives + ' archives the mirror holds for it are '
            + 'counted as mirror-only.'
          : 'Node did not answer during this harvest. Figures from this node are absent, not zero.',
      });
      return;
    }

    // A node we could not reach keeps the numbers it had, rather than
    // reporting zero. Its boreholes still plot (cached coordinates) and its
    // kilometres still count, but both are stamped with the date they were
    // actually measured so nothing here poses as fresh.
    if (r.fromCache) {
      const before = prevStates[node.code];
      if (before) {
        const carried = Object.assign({}, before, {
          status: r.degraded ? 'degraded' : 'cached',
          coords_as_of: r.coordsAsOf || null,
          coords_from_cache: !r.degraded,
          // The date this state was last really MEASURED, not the date of the
          // run that last carried it. Without the first clause each carry
          // stamps the previous run's date onto figures it also only carried,
          // so a node down for months would keep reporting that it was
          // measured last week - which is precisely the lie this field exists
          // to prevent.
          measured_as_of: before.measured_as_of || (prev && prev.as_of) || null,
          wfs_paging: r.wfsPaging ? pagingEntry(r.wfsPaging) : before.wfs_paging,
          note: r.wfsShort
            ? 'This node\'s borehole list paged short of the count the node reports, '
              + 'so the figures are those last measured on '
              + ((prev && prev.as_of) || 'an earlier run')
              + '. Coordinates read this run are kept; the measurements are not current.'
            : r.degraded
            ? 'This node served its borehole list but its dataset service failed '
              + 'most queries, so the figures are those last measured on '
              + ((prev && prev.as_of) || 'an earlier run')
              + '. Coordinates are current; the measurements are not.'
            : 'Node did not answer this run. Boreholes are drawn from cached '
              + 'coordinates and the figures are those last measured on '
              + ((prev && prev.as_of) || 'an earlier run')
              + '. Carried forward rather than reported as zero.',
        });
        states.push(carried);
        sumDatasets += carried.total_datasets || 0;
        sumBoreholesWithData += carried.total_boreholes_with_data || 0;
        sumUniqueM += (carried.unique_scanned_km || 0) * 1000;
        sumTotalM += (carried.total_scan_km || 0) * 1000;
        sumEstimatedM += (carried.estimated_km || 0) * 1000;
        sumEstimatedBh += carried.estimated_boreholes || 0;
        sumMirrorOnlyKm += carried.mirror_only_km || 0;
        sumMirrorOnlyArchives += carried.mirror_only_archives || 0;
        sumMirrorOnlyBoreholes += carried.mirror_only_boreholes || 0;
        participating.push(node.code);
        console.log('  [' + node.code + '] carried forward from '
          + ((prev && prev.as_of) || '?') + ': '
          + (carried.total_boreholes_with_data || 0) + ' boreholes, '
          + (carried.unique_scanned_km || 0) + ' km');
        return;
      }
    }

    let stDatasets = 0, stWithData = 0, stUniqueM = 0, stTotalM = 0;
    let stEstimatedM = 0, stEstimatedBh = 0;
    let stTsgOnlyBoreholes = 0;
    let stApiM = 0, stTsgM = 0, stTsgBh = 0;
    let stDatesTsg = 0, stDatesApi = 0, stDatesApiScan = 0, stDatesApiCreated = 0;
    let stUnrecorded = 0, stClamped = 0, stLatest = null;
    let st12moDatasets = 0, st12moM = 0;

    r.boreholes.forEach(function(bh) {
      // A borehole counts as having data if EITHER its node returned datasets
      // OR we hold a TSG archive for it. Requiring the API to answer meant a
      // node's failures erased boreholes whose scans we had already read and
      // measured: QLD's service failed 160 of 587 queries, so a third of its
      // archive vanished from the map despite sitting in the TSG cache. The
      // instrument's own file is evidence the scan happened; a broken
      // endpoint is not evidence that it did not.
      const tsgOnly = !bh.datasets.length && bh.tsg && bh.tsg.length;
      if (!bh.datasets.length && !tsgOnly) return;
      stWithData++;
      if (tsgOnly) stTsgOnlyBoreholes++;
      // Dataset count follows the evidence: API datasets where the node
      // answered, otherwise one per TSG archive (each archive IS a dataset).
      stDatasets += bh.datasets.length || bh.tsg.length;
      if (bh.lengthM && bh.lengthM > 0) sumDrilledM += bh.lengthM;

      // Dates first: the metrics below and every date-keyed roll-up must see
      // the TSG scan date, not the node's ingest date.
      resolveDates(bh);

      const m = boreholeMetrics(bh);
      bh.metrics = m;
      stUniqueM += m.uniqueM;
      stTotalM += m.totalM;
      stApiM += m.apiM;
      if (m.tsgM > 0) { stTsgM += m.tsgM; stTsgBh++; }
      if (m.estimatedM > 0) { stEstimatedM += m.estimatedM; stEstimatedBh++; }
      stUnrecorded += m.unrecorded;
      stClamped += m.clamped;
      if (m.intervalDatasets > 1) rescanBoreholes++;
      if (m.intervalDatasets > maxScans) maxScans = m.intervalDatasets;

      // A TSG-measured borehole has no per-dataset interval, so its recent
      // work is credited once at borehole level (same rule as the estimate).
      const bhDate = bh.datasets.reduce(function(acc, d) {
        return d.date && (!acc || d.date > acc) ? d.date : acc;
      }, null);
      if (m.tsgM > 0 && bhDate && bhDate >= cutoff12mo) st12moM += m.tsgM;

      const bhInstrument = tsgInstrument(bh);

      bh.datasets.forEach(function(ds) {
        // The node's InstrumentName wins; the TSG header fills its gaps.
        if (ds.instrument === 'Unknown' && bhInstrument) {
          ds.instrument = bhInstrument;
          ds.instrumentSource = 'tsg';
        }
        if (ds.instrument !== 'Unknown') sumWithInstrument++;
        if (ds.tir) sumTir++;
        if (ds.dateSource === 'tsg') { stDatesTsg++; sumDatesTsg++; }
        else if (ds.dateSource === 'api_scan') { stDatesApi++; stDatesApiScan++; sumDatesApi++; }
        else if (ds.dateSource === 'api_created') { stDatesApi++; stDatesApiCreated++; sumDatesApi++; }
        if (ds.date) {
          if (!earliest || ds.date < earliest) earliest = ds.date;
          if (!latest || ds.date > latest) latest = ds.date;
          if (!stLatest || ds.date > stLatest) stLatest = ds.date;
          if (ds.date >= cutoff12mo) {
            st12moDatasets++;
            if (ds.depthStart !== null && ds.depthEnd !== null && ds.depthEnd > ds.depthStart) {
              st12moM += ds.depthEnd - ds.depthStart;
            }
          }
        }
      });
    });

    sumDatasets += stDatasets;
    sumBoreholesWithData += stWithData;
    sumUniqueM += stUniqueM;
    sumTotalM += stTotalM;
    sumApiM += stApiM;
    sumTsgM += stTsgM;
    sumTsgBh += stTsgBh;
    sumEstimatedM += stEstimatedM;
    sumEstimatedBh += stEstimatedBh;
    sumUnrecorded += stUnrecorded;
    sumClamped += stClamped;

    const isParticipating = stDatasets > 0;
    if (isParticipating) participating.push(node.code);
    else { nonParticipating.push(node.code); nonPartBoreholes += r.wfsCount; }

    // 'cached' is a THIRD state, distinct from both participating and
    // unreachable: the node did not answer this run, but we hold its
    // coordinates from a previous one and its TSG evidence is durable, so it
    // still reports real boreholes and real kilometres - just not fresh ones.
    const entry = {
      state: node.code,
      status: r.fromCache ? (r.degraded ? 'degraded' : 'cached') : (isParticipating ? 'participating' : 'non_participating'),
      coords_as_of: r.fromCache ? r.coordsAsOf : null,
      coords_from_cache: !!r.fromCache && !r.degraded,
      wfs_registered_boreholes: r.wfsCount,
      total_datasets: stDatasets,
      total_boreholes_with_data: stWithData,
      total_km_scanned: km(stUniqueM),          // page-compat alias of unique
      unique_scanned_km: km(stUniqueM),         // measured total: API + TSG
      api_measured_km: km(stApiM),
      tsg_measured_km: km(stTsgM),
      tsg_measured_boreholes: stTsgBh,
      total_scan_km: km(stTotalM),
      estimated_km: km(stEstimatedM),
      estimated_boreholes: stEstimatedBh,
      interval_unrecorded: stUnrecorded,
      interval_clamped: stClamped,
      dates_from_tsg: stDatesTsg,
      dates_from_api: stDatesApi,
      dates_from_api_scandate: stDatesApiScan,
      dates_from_api_createddate: stDatesApiCreated,
      latest_dataset_date: stLatest,
      days_since_latest: stLatest ? Math.max(0, Math.round((today - new Date(stLatest + 'T00:00:00Z')) / 86400000)) : null,
      datasets_last_12mo: st12moDatasets,
      km_scanned_last_12mo: km(st12moM),
      measured_as_of: r.fromCache ? null : asOf,
    };
    if (stTsgM > 0) entry.tsg_source = TSG_SOURCE;

    // -- Mirror reconciliation --
    if (THREDDS_CAT && THREDDS_CAT.states && THREDDS_CAT.states[node.code]
      && typeof THREDDS_CAT.states[node.code].count === 'number') {
      const mirrorN = THREDDS_CAT.states[node.code].count;
      entry.mirror_archives = mirrorN;
      entry.mirror_unsurfaced = Math.max(0, mirrorN - stWithData);
      if (entry.mirror_unsurfaced > 0) {
        entry.mirror_note = entry.mirror_unsurfaced.toLocaleString('en-AU') + ' archive(s) on the AuScope NCI mirror '
          + 'beyond the ' + stWithData.toLocaleString('en-AU') + ' borehole(s) this node surfaces as having data. '
          + 'Scanned core the state service does not advertise is still scanned core.';
      }
    }
    if (node.note && !isParticipating) entry.note = node.note;
    if (r.wfsPaging) entry.wfs_paging = pagingEntry(r.wfsPaging);
    if (r.fetchFailures) entry.dataset_fetch_failures = r.fetchFailures;
    if (r.tsg && r.tsg.rows) {
      entry.tsg_cache_rows = r.tsg.rows;
      entry.tsg_cache_rows_gone = r.tsg.gone || 0;
      entry.tsg_only_boreholes = stTsgOnlyBoreholes;
      entry.mirror_only_km = r.tsg.mirrorOnlyKm || 0;
      entry.mirror_only_archives = r.tsg.mirrorOnlyArchives || 0;
      entry.mirror_only_boreholes = r.tsg.mirrorOnlyBoreholes || 0;
      // The total this state can actually evidence, versus what its own
      // services expose. These boreholes have no WFS record, so they carry
      // no coordinates and cannot be plotted - counted, not drawn.
      entry.evidenced_boreholes = stWithData + (r.tsg.mirrorOnlyBoreholes || 0);
      sumMirrorOnlyKm += entry.mirror_only_km;
      sumMirrorOnlyArchives += entry.mirror_only_archives;
      sumMirrorOnlyBoreholes += entry.mirror_only_boreholes;
      entry.tsg_cache_rows_matched = r.tsg.matchedRows;
      entry.tsg_cache_rows_unmatched = r.tsg.rows - r.tsg.matchedRows;
      entry.tsg_matched_boreholes = r.tsg.matchedBoreholes;
      // Archives matched at each tier, and holes by the first tier they
      // matched at (a hole matched by uuid and by name counts under uuid).
      entry.tsg_match_tiers = { archives: r.tsg.tierRows || {}, boreholes: r.tsg.tiers || {} };
      entry.tsg_match_rate_pct = Math.round(r.tsg.matchedRows / r.tsg.rows * 1000) / 10;
    }
    states.push(entry);
  });

  const endpoints = {};
  NODES.forEach(function(n) {
    endpoints[n.code] = {
      name: n.name,
      wfs: n.wfs,
      nvcl: n.nvcl,
      hits_url: n.wfs + '?service=WFS&version=2.0.0&request=GetFeature'
        + '&typeName=gsmlp:BoreholeView&resultType=hits'
        + '&CQL_FILTER=nvclCollection=%27true%27',
    };
  });

  const tsgUnmatched = Math.max(0, tsgIndex.rows - tsgIndex.matchedRows.size);

  return {
    as_of: asOf,
    method: 'merged-v1.2',
    source: 'scripts/nvcl/harvest.js - live harvest of all public NVCL node services (see scripts/nvcl/METHODOLOGY.md)',
    summary: {
      total_datasets: sumDatasets,
      total_boreholes_with_data: sumBoreholesWithData,
      // total_scanned_km is kept as an ALIAS of unique_scanned_km for
      // compatibility with the doi_tracker schema; unique_scanned_km is the
      // real name.
      total_scanned_km: km(sumUniqueM),
      total_scanned_km_note: 'alias of unique_scanned_km (union of per-dataset scan intervals per borehole)',
      unique_scanned_km: km(sumUniqueM),
      // The measured total splits by provenance. API = intervals the node
      // publishes. TSG = intervals read from the instrument's own file on
      // the AuScope NCI mirror. Both are measurements; neither is a guess.
      api_measured_km: km(sumApiM),
      tsg_measured_km: km(sumTsgM),
      tsg_measured_boreholes: sumTsgBh,
      tsg_source: TSG_SOURCE,
      total_scan_km: km(sumTotalM),
      // Measured on the mirror for boreholes the node does not surface -
      // counted on its own line, never folded into per-borehole coverage.
      mirror_only_km: Math.round(sumMirrorOnlyKm * 100) / 100,
      mirror_only_archives: sumMirrorOnlyArchives,
      mirror_only_boreholes: sumMirrorOnlyBoreholes,
      evidenced_boreholes: sumBoreholesWithData + sumMirrorOnlyBoreholes,
      national_measured_km: Math.round((sumUniqueM / 1000 + sumMirrorOnlyKm) * 100) / 100,
      // Estimation tier - DISCLOSED, never blended: boreholes with neither an
      // API interval nor a TSG one, estimated once each at drilled length.
      estimated_km: km(sumEstimatedM),
      estimated_boreholes: sumEstimatedBh,
      // Everything we can account for: attributed measurement + mirror-only
      // measurement + the disclosed estimate. Omitting mirror-only here
      // would leave the headline lower than national_measured_km, which
      // reads as nonsense (a 'combined' figure below its own subtotal).
      combined_estimate_km: Math.round((sumUniqueM / 1000 + sumMirrorOnlyKm
        + sumEstimatedM / 1000) * 100) / 100,
      // Date provenance. API dates are INGEST dates (createdDate); TSG dates
      // are the instrument's own record of when it scanned.
      dates_from_tsg: sumDatesTsg,
      dates_from_api: sumDatesApi,
      dates_from_tsg_pct: (sumDatesTsg + sumDatesApi)
        ? Math.round(sumDatesTsg / (sumDatesTsg + sumDatesApi) * 1000) / 10 : 0,
      tsg_cache: {
        path: 'data/nvcl/tsg-cache.jsonl',
        rows: tsgIndex.rows,
        matched_rows: tsgIndex.matchedRows.size,
        unmatched_rows: tsgUnmatched,
        // Not in rows: stamped gone by thredds-catalog.js (off the mirror).
        gone_rows: tsgIndex.goneRows || 0,
        // In rows, but each one the same dataset (TSG UUID and scan
        // interval) as another row, matched and counted with it.
        uuid_twin_rows: tsgIndex.twinRows || 0,
        match_rate_pct: tsgIndex.rows
          ? Math.round(tsgIndex.matchedRows.size / tsgIndex.rows * 1000) / 10 : null,
        states_cached: tsgIndex.states,
      },
      interval_unrecorded_datasets: sumUnrecorded,
      interval_clamped_datasets: sumClamped,
      total_borehole_drilled_km: km(sumDrilledM),
      datasets_with_instrument_data: sumWithInstrument,
      participating_nodes: participating.sort(),
      participating_node_count: participating.length,
      non_participating_jurisdictions: nonParticipating.sort(),
      non_participating_borehole_count: nonPartBoreholes,
      date_range: { earliest_scan: earliest, latest_scan: latest },
      rescan_stats: {
        boreholes_with_multiple_scans: rescanBoreholes,
        max_scans_one_borehole: maxScans,
      },
      tir_stats: {
        tir_datasets: sumTir,
        tir_pct_of_total: sumDatasets ? Math.round(sumTir / sumDatasets * 1000) / 10 : null,
      },
    },
    states: states.sort(function(a, b) { return a.state < b.state ? -1 : 1; }),
    endpoints: endpoints,
  };
}

// What an unfiltered (sorted, paged) borehole list covered, for the snapshot.
function pagingEntry(pg) {
  return {
    features_paged: pg.features,
    features_reported: pg.reported,
    paged_pct: pg.reported ? Math.round(pg.features / pg.reported * 1000) / 10 : null,
  };
}

// Assign each dataset its best available date and record where it came from.
//
// PRECEDENCE: the TSG header's scan date beats anything the API says. The
// node's createdDate is the day the record was INGESTED - whole states land
// in a single month under it - so it is a fallback, never the truth.
//
// When a borehole has more archives than datasets, or fewer, the two lists
// are paired in chronological order; leftover datasets take the borehole's
// latest TSG date rather than fall back to an ingest date that would invent
// a scanning month.
function resolveDates(bh) {
  const tsg = tsgDates(bh);
  const order = bh.datasets.map(function(_, i) { return i; }).sort(function(a, b) {
    const da = bh.datasets[a].scanDate || bh.datasets[a].created || '';
    const db = bh.datasets[b].scanDate || bh.datasets[b].created || '';
    return da < db ? -1 : (da > db ? 1 : a - b);
  });
  order.forEach(function(dsIdx, rank) {
    const ds = bh.datasets[dsIdx];
    if (tsg.length) {
      ds.date = rank < tsg.length ? tsg[rank] : tsg[tsg.length - 1];
      ds.dateSource = 'tsg';
      return;
    }
    if (ds.scanDate) { ds.date = ds.scanDate; ds.dateSource = 'api_scan'; return; }
    if (ds.created) { ds.date = ds.created; ds.dateSource = 'api_created'; return; }
    ds.date = null;
    ds.dateSource = null;
  });
}

// -- Per-borehole detail (input to write-map-data.js) ---------------

// One JSON line per harvested borehole, sorted by state then id: the WFS
// record, the node's datasets exactly as published, and the TSG archives the
// matcher attached. Raw evidence only - which month, which instrument and
// which depth the MAP shows is decided in one place, write-map-data.js.
// Every WFS borehole is included (has_data says which carry evidence),
// because the infrastructure map plots registered boreholes too.
function buildDetail(results) {
  const rows = [];
  results.forEach(function(r) {
    r.boreholes.forEach(function(bh) {
      const datasets = (bh.datasets || []).map(function(ds) {
        return {
          // The node's DatasetID: the TSG header's UUID, and the key the
          // 'uuid' match tier joins on.
          id: ds.id || undefined,
          created: ds.created || null,
          scanDate: ds.scanDate || undefined,
          instrument: ds.apiInstrument || 'Unknown',
          from: ds.depthStart,
          to: ds.depthEnd,
          tir: ds.tir ? true : undefined,
          drillDate: ds.drillDate || undefined,
          project: ds.project || undefined,
          owner: ds.owner || undefined,
          spectra: ds.spectra || undefined,
        };
      }).sort(function(a, b) {
        const ka = (a.scanDate || a.created || '') + '|' + a.from + '|' + a.to + '|' + a.instrument;
        const kb = (b.scanDate || b.created || '') + '|' + b.from + '|' + b.to + '|' + b.instrument;
        return ka < kb ? -1 : (ka > kb ? 1 : 0);
      });
      const tsg = (bh.tsg || []).map(function(t) {
        return {
          zip: t.zipName,
          scanDate: t.scanDate ? String(t.scanDate).substring(0, 10) : null,
          confidence: t.dateConfidence || null,
          from: t.depthFromM == null ? null : t.depthFromM,
          to: t.depthToM == null ? null : t.depthToM,
          instrument: t.instrument || null,
          // Other archive names of the same dataset (same TSG UUID).
          twins: t._twins && t._twins.length ? t._twins : undefined,
        };
      }).sort(function(a, b) { return a.zip < b.zip ? -1 : (a.zip > b.zip ? 1 : 0); });
      const m = bh.metrics || null;
      rows.push({
        state: r.node.code,
        id: bh.id,
        name: bh.name || '',
        lat: bh.lat,
        lng: bh.lng,
        lengthM: bh.lengthM == null ? null : bh.lengthM,
        custodian: bh.custodian || '',
        elevation: bh.elevation == null ? null : bh.elevation,
        drillingMethod: bh.drillingMethod || '',
        drillEndDate: bh.drillEndDate || '',
        purpose: bh.purpose || '',
        from_cache: bh.fromCache ? true : undefined,
        seeded: bh.seeded ? true : undefined,
        fetch_failed: bh.fetchFailed ? true : undefined,
        has_data: datasets.length > 0 || tsg.length > 0,
        tsg_tier: bh.tsgTier || undefined,
        unique_scanned_m: m && m.uniqueM > 0 ? Math.round(m.uniqueM * 1000) / 1000 : null,
        depth_source: m ? m.source : null,
        datasets: datasets,
        tsg: tsg,
      });
    });
  });
  rows.sort(function(a, b) {
    if (a.state !== b.state) return a.state < b.state ? -1 : 1;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  });
  return rows.map(function(r) { return JSON.stringify(r); });
}

function printSummary(s) {
  const sm = s.summary;
  console.log('\n=== NATIONAL SUMMARY (' + s.as_of + ') ===');
  console.log('Boreholes with data:  ' + sm.total_boreholes_with_data);
  console.log('Datasets:             ' + sm.total_datasets);
  console.log('Unique scanned:       ' + sm.unique_scanned_km + ' km measured (union of intervals)');
  console.log('  from node APIs:     ' + sm.api_measured_km + ' km');
  console.log('  from TSG headers:   ' + sm.tsg_measured_km + ' km across ' + sm.tsg_measured_boreholes + ' boreholes (' + sm.tsg_source + ')');
  console.log('Mirror-only measured: ' + sm.mirror_only_km + ' km across '
    + sm.mirror_only_archives + ' archives = ' + sm.mirror_only_boreholes
    + ' boreholes their node does not surface (no WFS record, so not plottable)');
  console.log('EVIDENCED BOREHOLES:  ' + sm.evidenced_boreholes
    + ' (' + sm.total_boreholes_with_data + ' plottable + ' + sm.mirror_only_boreholes + ' mirror-only)');
  console.log('NATIONAL MEASURED:    ' + sm.national_measured_km + ' km (attributed + mirror-only)');
  console.log('Estimated (no data):  ' + sm.estimated_km + ' km across ' + sm.estimated_boreholes + ' boreholes (drilled-length estimate, disclosed)');
  console.log('Combined estimate:    ' + sm.combined_estimate_km + ' km (measured + estimated)');
  console.log('Dates from TSG:       ' + sm.dates_from_tsg + ' (' + sm.dates_from_tsg_pct + '%), from API (ingest): ' + sm.dates_from_api);
  console.log('TSG cache:            ' + sm.tsg_cache.rows + ' rows, ' + sm.tsg_cache.matched_rows
    + ' matched (' + sm.tsg_cache.match_rate_pct + '%), ' + sm.tsg_cache.unmatched_rows + ' unmatched');
  console.log('Total scan work:      ' + sm.total_scan_km + ' km (rescans counted)');
  console.log('Interval unrecorded:  ' + sm.interval_unrecorded_datasets
    + ' datasets (' + sm.interval_clamped_datasets + ' clamped as garbage)');
  console.log('Drilled length:       ' + sm.total_borehole_drilled_km + ' km');
  console.log('Rescanned boreholes:  ' + sm.rescan_stats.boreholes_with_multiple_scans
    + ' (max ' + sm.rescan_stats.max_scans_one_borehole + ' scans)');
  s.states.forEach(function(st) {
    console.log('  ' + st.state + ': ' + st.total_boreholes_with_data + ' bh, '
      + st.total_datasets + ' ds, ' + st.unique_scanned_km + ' km measured'
      + (st.tsg_measured_km ? ' (' + st.api_measured_km + ' api + ' + st.tsg_measured_km + ' tsg)' : '')
      + (st.estimated_km ? ' + ' + st.estimated_km + ' km est' : '')
      + ', dates ' + (st.dates_from_tsg || 0) + ' tsg / ' + (st.dates_from_api || 0) + ' api'
      + ' [' + st.status + ']');
  });
}

// -- Plumbing ------------------------------------------------------

async function fetchText(url, timeoutMs, opts) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS);
    const controller = new AbortController();
    const timer = setTimeout(function() { controller.abort(); }, timeoutMs);
    try {
      const init = Object.assign({ headers: {} }, opts || {});
      init.headers = Object.assign({ 'User-Agent': USER_AGENT }, init.headers);
      init.signal = controller.signal;
      const resp = await fetch(url, init);
      if (resp.status === 429 || resp.status >= 500) {
        lastErr = new Error('HTTP ' + resp.status);
        continue;                              // polite retry
      }
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return await resp.text();
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error('timeout after ' + timeoutMs + 'ms') : e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('fetch failed');
}

function tag(xml, name) {
  const m = String(xml).match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>'));
  return m ? m[1].trim() : '';
}

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function dateOnly(s) {
  const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function km(metres) {
  return Math.round(metres / 1000 * 100) / 100;
}

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { /* fall through */ }
  return fallback;
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

if (require.main === module) {
  run().catch(function(err) {
    console.error('Harvest failed: ' + err.message);
    if (process.env.NVCL_TRACE) console.error(err.stack);
    process.exit(1);
  });
} else {
  // Required rather than run: expose the pure parts (id rule, TSG matching)
  // so they can be checked offline without touching any node.
  module.exports = {
    boreholeIdFrom: boreholeIdFrom, addFeature: addFeature, loadTsgIndex: loadTsgIndex,
    attachTsg: attachTsg, resolveTsgMatches: resolveTsgMatches, normKey: normKey,
    uuidKey: uuidKey,
  };
}
