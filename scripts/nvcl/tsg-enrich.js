#!/usr/bin/env node
/**
 * AuScope NVCL - TSG enrichment harvester (incremental)
 *
 * Ported from bvkay/AuScope_doi_tracker src/nvcl/tsg-enrich.js on 2026-10-13.
 * Changes: paths resolve from scripts/nvcl/, the config.json mailto in the
 * User-Agent is replaced by the repo URL, dashes follow house style. The
 * fetching and parsing logic is unchanged.
 *
 * Some NVCL nodes publish no scan intervals and no scan dates through
 * getDatasetCollection (at the time of writing: WA and NT). The information
 * exists - it is inside the TSG files themselves, and AuScope mirrors every
 * TSG archive on NCI THREDDS (collection DOI 10.25914/bztg-rg43). This script
 * reads the header of each mirrored TSG file and caches what it finds so
 * scripts/nvcl/harvest.js can promote those boreholes from ESTIMATED to MEASURED.
 *
 * Bandwidth technique (ported from Ben Kay's harvest_thredds.py):
 *   The archives are 30 MB - 1 GB ZIPs. We never download one. Instead:
 *     1. HEAD                      -> size + Accept-Ranges
 *     2. Range: last 64 KB         -> End Of Central Directory record
 *     3. Range: central directory  -> entry table (~2 KB)
 *     4. Range: the .tsg entry only-> ~200 KB compressed, inflated in memory
 *   About 0.1% of the archive is transferred. Verified: NT 1113660_ECD10.zip
 *   is 295 MB; 253 KB was read.
 *
 * Fields parsed out of the TSG header:
 *   Depth (m);<from>;<to>        the scanned depth interval, in metres
 *   TIDL Depth Backup;<from>;<to>  secondary source for the same interval
 *   scan date = / scan date: / Created :   three-tier scan date
 *   hylogger name = / HyLogger : instrument
 *   UUID :                       TSG identity (the node's DatasetID)
 *   [dbextra] identity           drillhole name, hole service, dataset name,
 *                                collar, ntrays, nsamples and the four
 *                                image-log GUIDs (added 2026-10-13; read
 *                                for archives fetched from then on only)
 *
 * Cache: data/nvcl/tsg-cache.jsonl - one JSON line per archive, keyed by
 * state + zipName. It is committed to git and is the durable asset: a weekly
 * run lists each catalog, diffs against the cache, and fetches ONLY what is
 * new. Nothing already read is ever re-read (unless --retry-failed).
 *
 * Usage:
 *   node scripts/nvcl/tsg-enrich.js                    # default states, 400 new
 *   node scripts/nvcl/tsg-enrich.js --state=NT --limit=5
 *   node scripts/nvcl/tsg-enrich.js --state=WA --max-new=400
 *   node scripts/nvcl/tsg-enrich.js --retry-failed     # re-attempt cached errors
 *   node scripts/nvcl/tsg-enrich.js --dry-run          # list the diff, fetch none
 *
 * Env: NVCL_TSG_STATES=WA,NT   NVCL_TSG_MAX_NEW=400   NVCL_TSG_CACHE=path
 * Runs from any working directory (paths resolve from this file).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// scripts/nvcl/ -> repo root, so the script runs from any working directory.
const ROOT = path.join(__dirname, '..', '..');
const CACHE_PATH = process.env.NVCL_TSG_CACHE
  || path.join(ROOT, 'data', 'nvcl', 'tsg-cache.jsonl');

const THREDDS = 'https://thredds.nci.org.au/thredds';
const MIRROR_DOI = '10.25914/bztg-rg43';
const SOURCE_TAG = 'NCI THREDDS TSG (' + MIRROR_DOI + ')';

// THREDDS subpaths are case-sensitive. Verified 2026-08-06: SA, Tas, WA, NT,
// Qld, Vic resolve; Nsw / Wa / Nt all 404. NSW has no mirror on this catalog.
const STATE_SUBPATH = {
  SA: 'SA', TAS: 'Tas', WA: 'WA', NT: 'NT', QLD: 'Qld', VIC: 'Vic',
};

// Backfill priority order - the budget is spent down this list.
//   WA, NT  gain BOTH measured depth and real scan dates (their APIs give
//           neither), so they convert estimated km into measured km.
//   TAS, SA gain date CORRECTIONS: their API dates are bulk-ingest dates
//           (TAS's top month holds 30% of the state, SA's 20% - clusters that
//           vanish under TSG dates), and Ben Kay's 2026-05 scrape already
//           seeded most of them.
//   QLD, VIC last - smallest gain.
// NSW has no mirror on the rs07 catalog.
const DEFAULT_STATES = ['WA', 'NT', 'TAS', 'SA', 'QLD', 'VIC'];

const USER_AGENT = 'AuScope-Outreach NVCL harvester (+https://github.com/AuScope/AuScope_Outreach)';

const TIMEOUT_MS = 60000;
const RETRIES = 2;
const RETRY_DELAY_MS = 3000;
const DELAY_MS = 300;              // politeness pause between archives
const CONCURRENCY = 3;
const CATALOG_TIMEOUT_MS = 180000; // WA's catalog.xml is ~420 KB
const EOCD_TAIL = 65536;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;  // cap on one compressed .tsg read
const MAX_INTERVAL_M = 5000;       // sanity clamp on a parsed scan interval
const CIRCUIT_BREAKER = 8;         // consecutive network failures -> stop

// The live cache, module-scoped so a shutdown signal can flush it. A
// cancelled CI job or a Ctrl-C must keep the archives it already read - 
// they cost real bandwidth on a shared national facility.
let LIVE_CACHE = null;

// Upstream problems seen this run (unreachable catalogue, tripped circuit
// breaker). The cache keeps every good row regardless, but the run exits
// non-zero so the workflow step shows red instead of passing quietly.
const UPSTREAM_PROBLEMS = [];

// ── CLI ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { states: null, limit: 0, maxNew: 0, retryFailed: false, dryRun: false };
  argv.slice(2).forEach(function(arg) {
    let m;
    if ((m = arg.match(/^--state=(.+)$/))) {
      a.states = m[1].split(',').map(function(s) { return s.trim().toUpperCase(); }).filter(Boolean);
    } else if ((m = arg.match(/^--limit=(\d+)$/))) {
      a.limit = Number(m[1]);
    } else if ((m = arg.match(/^--max-new=(\d+)$/))) {
      a.maxNew = Number(m[1]);
    } else if (arg === '--retry-failed') {
      a.retryFailed = true;
    } else if (arg === '--dry-run') {
      a.dryRun = true;
    } else {
      throw new Error('Unknown flag: ' + arg + '\nSee the header of ' + __filename);
    }
  });
  if (!a.states) {
    const env = (process.env.NVCL_TSG_STATES || '').split(',')
      .map(function(s) { return s.trim().toUpperCase(); }).filter(Boolean);
    a.states = env.length ? env : DEFAULT_STATES.slice();
  }
  if (!a.maxNew) a.maxNew = Number(process.env.NVCL_TSG_MAX_NEW || 400);
  return a;
}

// ── Main ──────────────────────────────────────────────────────────

async function run() {
  const args = parseArgs(process.argv);
  console.log('NVCL TSG enrichment - ' + new Date().toISOString().substring(0, 10));
  console.log('=========================================\n');
  console.log('States:      ' + args.states.join(', '));
  console.log('Cache:       ' + CACHE_PATH);
  console.log('Budget:      ' + args.maxNew + ' new archives this run'
    + (args.limit ? ' (--limit=' + args.limit + ')' : ''));
  if (args.retryFailed) console.log('Retry mode:  cached error rows will be re-attempted');
  if (args.dryRun) console.log('DRY RUN:     no archives will be fetched');

  const unknown = args.states.filter(function(s) { return !STATE_SUBPATH[s]; });
  if (unknown.length) {
    throw new Error('No THREDDS subpath known for: ' + unknown.join(', ')
      + ' (known: ' + Object.keys(STATE_SUBPATH).join(', ') + ')');
  }

  const cache = loadCache(CACHE_PATH);
  LIVE_CACHE = cache;
  console.log('\nCache loaded: ' + cache.size + ' rows');
  const seeded = countBy(cache, function(r) { return r.source && /^seed:/.test(r.source) ? 'seed' : 'live'; });
  console.log('  seeded: ' + (seeded.seed || 0) + '   live: ' + (seeded.live || 0));

  const t0 = Date.now();
  let budget = args.maxNew;
  let fetched = 0, remainingAll = 0;
  const perState = [];

  // One state at a time - NCI is a shared national facility, not a CDN.
  for (const state of args.states) {
    if (budget <= 0) {
      console.log('\n[' + state + '] skipped - run budget exhausted');
      const cat0 = await listCatalog(state).catch(function() { return []; });
      const todo0 = diffTodo(cat0, cache, state, args.retryFailed);
      remainingAll += todo0.length;
      perState.push({ state: state, catalog: cat0.length, todo: todo0.length, fetched: 0 });
      continue;
    }

    console.log('\n[' + state + '] ' + THREDDS + '/catalog/rs07/' + STATE_SUBPATH[state] + '/catalog.xml');
    let catalog;
    try {
      catalog = await listCatalog(state);
    } catch (e) {
      console.warn('  CATALOG UNREACHABLE: ' + e.message + ' - skipping this state');
      UPSTREAM_PROBLEMS.push(state + ' catalogue unreachable (' + e.message + ')');
      perState.push({ state: state, catalog: 0, todo: 0, fetched: 0, error: e.message });
      continue;
    }
    console.log('  catalog: ' + catalog.length + ' archives');

    const todo = diffTodo(catalog, cache, state, args.retryFailed);
    console.log('  already cached: ' + (catalog.length - todo.length) + '   to fetch: ' + todo.length);

    let slice = todo;
    if (args.limit) slice = slice.slice(0, args.limit);
    if (slice.length > budget) slice = slice.slice(0, budget);
    remainingAll += todo.length - slice.length;

    if (args.dryRun) {
      console.log('  DRY RUN - would fetch ' + slice.length + ': '
        + slice.slice(0, 5).join(', ') + (slice.length > 5 ? ' ...' : ''));
      perState.push({ state: state, catalog: catalog.length, todo: todo.length, fetched: 0 });
      continue;
    }
    if (!slice.length) {
      perState.push({ state: state, catalog: catalog.length, todo: todo.length, fetched: 0 });
      continue;
    }

    const got = await harvestState(state, slice, cache);
    fetched += got;
    budget -= got;
    perState.push({ state: state, catalog: catalog.length, todo: todo.length, fetched: got });
    saveCache(CACHE_PATH, cache);
  }

  if (!args.dryRun) saveCache(CACHE_PATH, cache);

  const mins = ((Date.now() - t0) / 60000);
  console.log('\n=== TSG ENRICHMENT SUMMARY ===');
  perState.forEach(function(p) {
    console.log('  ' + p.state + ': catalog ' + p.catalog + ', outstanding ' + p.todo
      + ', fetched this run ' + p.fetched + (p.error ? '  [' + p.error + ']' : ''));
  });
  console.log('  Fetched:   ' + fetched + ' archives in ' + mins.toFixed(1) + ' min'
    + (fetched ? ' (' + (mins * 60 / fetched).toFixed(1) + ' s/archive)' : ''));
  console.log('  Remaining: ' + remainingAll + ' archives - picked up by the next run');
  console.log('  Cache now: ' + cache.size + ' rows -> ' + CACHE_PATH);
  reportCache(cache);
  if (UPSTREAM_PROBLEMS.length) {
    console.error('\nUpstream problems this run (cache saved; exiting 1):');
    UPSTREAM_PROBLEMS.forEach(function(p) { console.error('  - ' + p); });
    process.exitCode = 1;
  }
}

// ── Cache ─────────────────────────────────────────────────────────

function cacheKey(state, zipName) { return state + '/' + zipName; }

function loadCache(file) {
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach(function(line) {
    if (!line.trim()) return;
    try {
      const r = JSON.parse(line);
      if (r && r.state && r.zipName) map.set(cacheKey(r.state, r.zipName), r);
    } catch (e) { /* a corrupt line must not destroy the rest of the cache */ }
  });
  return map;
}

// Rewrite in full, sorted by state + zipName, so git diffs stay readable and
// row order is deterministic. Good rows are never dropped.
function saveCache(file, map) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rows = Array.from(map.values()).sort(function(a, b) {
    if (a.state !== b.state) return a.state < b.state ? -1 : 1;
    return a.zipName < b.zipName ? -1 : (a.zipName > b.zipName ? 1 : 0);
  });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, rows.map(function(r) { return JSON.stringify(r); }).join('\n') + '\n');
  fs.renameSync(tmp, file);
}

// Errors that will never heal by asking again: the archive was read and the
// answer is settled. These count as done, so a weekly run does not burn its
// budget re-reading the same files. Transport errors (timeout, 5xx, network)
// are NOT here - those are retried automatically on the next run.
// 'zip64_unsupported' is deliberately absent: archives that hit it before
// ZIP64 support existed are re-read once, now that they can be parsed.
const PERMANENT_ERRORS = new Set([
  'no depth field', 'implausible depth', 'no_tsg_in_zip',
  'range_unsupported', 'empty_file', 'eocd_not_found', 'decompress_failed',
  'zip64_eocd_not_found', 'http_404', 'http_403', 'http_410',
]);

function isDone(row, retryFailed) {
  if (!row) return false;
  if (retryFailed) return !row.error;
  if (!row.error) return true;
  return PERMANENT_ERRORS.has(row.error);
}

// Field-by-field merge, new value wins where it has one. A re-read that
// times out, or one that reaches a file with no depth line, must not erase
// the scan date a previous run (or the 2026-05 seed) already recorded.
const MERGE_KEEP = [
  'tsgEntryName', 'boreholeId', 'datasetId', 'scanDate', 'dateConfidence',
  'depthFromM', 'depthToM', 'depthSource', 'instrument', 'tsgUuid', 'zipBytes',
  'drillholeName', 'holeService', 'datasetName', 'collar', 'ntrays', 'nsamples',
  'traypicsLogId', 'traythumbsLogId', 'mospicLogId', 'imageLogId',
];

function mergeRow(prev, next) {
  if (!prev) return next;
  const out = Object.assign({}, next);
  let kept = false;
  MERGE_KEEP.forEach(function(k) {
    if ((out[k] === null || out[k] === undefined) && prev[k] !== null && prev[k] !== undefined) {
      out[k] = prev[k];
      kept = true;
    }
  });
  // Depth is a pair: never mix a fresh 'from' with a stale 'to'.
  if (next.depthFromM == null || next.depthToM == null) {
    if (prev.depthFromM != null && prev.depthToM != null) {
      out.depthFromM = prev.depthFromM;
      out.depthToM = prev.depthToM;
      out.depthSource = prev.depthSource;
      if (out.error === 'no depth field' || out.error === 'implausible depth') out.error = null;
    } else {
      out.depthFromM = next.depthFromM;
      out.depthToM = next.depthToM;
    }
  }
  if (kept && prev.source && prev.source !== out.source) {
    out.mergedFrom = prev.source;
  }
  return out;
}

function diffTodo(catalog, cache, state, retryFailed) {
  return catalog.filter(function(zipName) {
    return !isDone(cache.get(cacheKey(state, zipName)), retryFailed);
  });
}

function reportCache(cache) {
  const byState = {};
  cache.forEach(function(r) {
    const s = byState[r.state] || (byState[r.state] = { rows: 0, depth: 0, date: 0, dateOnly: 0, err: 0, m: 0 });
    s.rows++;
    const hasDepth = r.depthFromM != null && r.depthToM != null;
    if (hasDepth) { s.depth++; s.m += r.depthToM - r.depthFromM; }
    if (r.scanDate) s.date++;
    if (r.scanDate && !hasDepth) s.dateOnly++;
    if (r.error) s.err++;
  });
  console.log('\n  state   rows   with depth   with date   date-only   errors    km');
  Object.keys(byState).sort().forEach(function(k) {
    const s = byState[k];
    console.log('  ' + pad(k, 6) + pad(s.rows, 7) + pad(s.depth, 13) + pad(s.date, 12)
      + pad(s.dateOnly, 12) + pad(s.err, 9) + (s.m / 1000).toFixed(2));
  });
}

function pad(v, w) { return String(v).padEnd(w); }

function countBy(map, fn) {
  const out = {};
  map.forEach(function(v) { const k = fn(v); out[k] = (out[k] || 0) + 1; });
  return out;
}

// ── THREDDS catalog ───────────────────────────────────────────────

async function listCatalog(state) {
  const url = THREDDS + '/catalog/rs07/' + STATE_SUBPATH[state] + '/catalog.xml';
  const xml = await fetchText(url, CATALOG_TIMEOUT_MS);
  const names = [];
  const seen = new Set();
  const re = /name="([^"]+\.zip)"/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const n = decodeXmlEntities(m[1]);
    if (!seen.has(n)) { seen.add(n); names.push(n); }
  }
  names.sort();
  return names;
}

function fileUrl(state, zipName) {
  return THREDDS + '/fileServer/rs07/' + STATE_SUBPATH[state] + '/'
    + encodeURIComponent(zipName).replace(/%2F/g, '/');
}

// ── Per-state worker pool ─────────────────────────────────────────

async function harvestState(state, zipNames, cache) {
  const queue = zipNames.slice();
  const total = queue.length;
  let done = 0, ok = 0, dateOnly = 0, fail = 0, bytes = 0;
  let consecutiveNetFails = 0;
  let tripped = false;
  const tStart = Date.now();

  async function worker() {
    for (;;) {
      if (tripped) return;
      const zipName = queue.shift();
      if (!zipName) return;
      const t0 = Date.now();
      const fresh = await harvestOne(state, zipName);
      const secs = (Date.now() - t0) / 1000;
      // Never let a failed or partial re-read destroy what an earlier run
      // already established - a seeded scan date must survive a timeout.
      const row = mergeRow(cache.get(cacheKey(state, zipName)), fresh);
      cache.set(cacheKey(state, zipName), row);
      bytes += row.bytesFetched || 0;
      done++;

      let status;
      if (row.depthFromM != null) {
        ok++;
        status = 'DEPTH ' + row.depthFromM.toFixed(1) + '-' + row.depthToM.toFixed(1) + ' m'
          + (row.scanDate ? ' · ' + row.scanDate.substring(0, 10) : '');
      } else if (row.scanDate) {
        dateOnly++;
        status = 'date only ' + row.scanDate.substring(0, 10) + ' (' + row.error + ')';
      } else {
        fail++;
        status = 'FAIL ' + row.error;
      }

      // Checkpoint often: a long backfill must never lose an hour of reads
      // to a dropped connection or a Ctrl-C.
      if (done % 25 === 0) saveCache(CACHE_PATH, cache);

      const elapsed = (Date.now() - tStart) / 1000;
      const eta = done ? (total - done) * (elapsed / done) / 60 : 0;
      console.log('  [' + String(done).padStart(4) + '/' + total + '] ' + pad(zipName.slice(0, 28), 30)
        + pad(Math.round((row.zipBytes || 0) / 1048576) + 'MB', 8)
        + pad(Math.round((row.bytesFetched || 0) / 1024) + 'KB', 8)
        + pad(secs.toFixed(1) + 's', 8) + status.slice(0, 46)
        + '  (ok=' + ok + ' date=' + dateOnly + ' fail=' + fail + ' ETA ' + eta.toFixed(0) + 'm)');

      // Circuit breaker: NCI has gone away and every further request is waste.
      if (row.error && /^(http_5|timeout|network|range_)/.test(row.error)) {
        consecutiveNetFails++;
        if (consecutiveNetFails >= CIRCUIT_BREAKER) {
          tripped = true;
          UPSTREAM_PROBLEMS.push(state + ' circuit breaker tripped');
          console.warn('\n  CIRCUIT BREAKER: ' + consecutiveNetFails + ' consecutive network failures.');
          console.warn('  NCI THREDDS looks unreachable. Stopping this state; the cache keeps what it has.');
          return;
        }
      } else {
        consecutiveNetFails = 0;
      }

      if (queue.length && DELAY_MS > 0) await sleep(DELAY_MS);
    }
  }

  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);

  console.log('  [' + state + '] ' + done + ' read · ' + ok + ' with depth · ' + dateOnly
    + ' date-only · ' + fail + ' failed · ' + (bytes / 1048576).toFixed(0) + ' MB transferred');
  return done;
}

// ── One archive ───────────────────────────────────────────────────

async function harvestOne(state, zipName) {
  const url = fileUrl(state, zipName);
  const row = {
    state: state,
    zipName: zipName,
    tsgEntryName: null,
    boreholeId: boreholeIdFromZip(zipName),
    datasetId: null,
    scanDate: null,
    dateConfidence: null,
    depthFromM: null,
    depthToM: null,
    depthSource: null,
    instrument: null,
    tsgUuid: null,
    zipBytes: null,
    bytesFetched: 0,
    fetchedAt: new Date().toISOString(),
    source: SOURCE_TAG,
    error: null,
  };

  let head;
  try {
    head = await httpHead(url);
  } catch (e) {
    row.error = classifyError(e);
    return row;
  }
  row.zipBytes = head.size;
  if (!/bytes/i.test(head.acceptRanges || '')) {
    row.error = 'range_unsupported';
    return row;
  }
  if (!head.size) {
    row.error = 'empty_file';
    return row;
  }

  // 2. EOCD tail -> central directory location
  let entries;
  try {
    const tailStart = Math.max(0, head.size - EOCD_TAIL);
    const tail = await httpRange(url, tailStart, head.size - 1);
    row.bytesFetched += tail.length;
    let eocd = findEocd(tail);
    if (!eocd) { row.error = 'eocd_not_found'; return row; }
    // Archives over 4 GB (the deepest holes: one NT archive is 5.1 GB) put
    // the real central-directory location in a ZIP64 record instead.
    if (eocd.cdOffset === 0xFFFFFFFF || eocd.cdSize === 0xFFFFFFFF || eocd.zip64Locator) {
      const z = await readZip64Eocd(url, tail, tailStart, eocd, row);
      if (!z) { row.error = 'zip64_eocd_not_found'; return row; }
      eocd = z;
    }
    const cd = await httpRange(url, eocd.cdOffset, eocd.cdOffset + eocd.cdSize - 1);
    row.bytesFetched += cd.length;
    entries = parseCentralDirectory(cd);
  } catch (e) {
    row.error = classifyError(e);
    return row;
  }

  const tsgEntries = entries.filter(function(e) { return /\.tsg$/i.test(e.name); });
  if (!tsgEntries.length) { row.error = 'no_tsg_in_zip'; return row; }

  // Prefer the base scan file over the thermal-infrared companion: the base
  // file carries the visible/SWIR scan geometry the Depth line describes.
  const base = tsgEntries.filter(function(e) { return !/_tir/i.test(e.name); });
  const pick = (base.length ? base : tsgEntries)
    .sort(function(a, b) { return a.name.length - b.name.length; })[0];
  row.tsgEntryName = pick.name;

  let text;
  try {
    text = await readEntryText(url, pick, row);
  } catch (e) {
    row.error = classifyError(e);
    return row;
  }
  if (text == null) { row.error = 'decompress_failed'; return row; }

  const parsed = parseTsgHeader(text);
  row.scanDate = parsed.scanDate;
  row.dateConfidence = parsed.dateConfidence;
  row.instrument = parsed.instrument;
  row.tsgUuid = parsed.tsgUuid;
  row.datasetId = parsed.tsgUuid || null;
  // Only the identity fields the header actually carries are written, so a
  // row read before they were parsed and one whose file lacks them look the
  // same: absent, not null.
  Object.keys(parsed.identity).forEach(function(k) { row[k] = parsed.identity[k]; });
  if (parsed.coords) {
    row.latRaw = parsed.coords.rawLat;
    row.lonRaw = parsed.coords.rawLon;
    row.coordStatus = parsed.coords.status;
    if (parsed.coords.lat != null) { row.lat = parsed.coords.lat; row.lng = parsed.coords.lng; }
    if (parsed.coords.datum) row.geoDatum = parsed.coords.datum;
  }

  if (parsed.depth) {
    row.depthFromM = parsed.depth.from;
    row.depthToM = parsed.depth.to;
    row.depthSource = parsed.depth.source;
  } else if (parsed.depthRejected) {
    row.error = 'implausible depth';
  } else {
    row.error = 'no depth field';
  }
  return row;
}

// The .tsg entry, pulled by range and inflated. Deflate (method 8) and store
// (method 0) are both handled; anything else is reported rather than guessed.
async function readEntryText(url, entry, row) {
  const lfh = await httpRange(url, entry.lfhOffset, entry.lfhOffset + 29);
  row.bytesFetched += lfh.length;
  if (lfh.readUInt32LE(0) !== 0x04034b50) return null;
  const fnLen = lfh.readUInt16LE(26);
  const extraLen = lfh.readUInt16LE(28);
  const dataOffset = entry.lfhOffset + 30 + fnLen + extraLen;
  const want = Math.min(entry.compSize, MAX_ENTRY_BYTES);
  if (want <= 0) return null;
  const comp = await httpRange(url, dataOffset, dataOffset + want - 1);
  row.bytesFetched += comp.length;

  if (entry.method === 0) return comp.toString('latin1');
  if (entry.method !== 8) return null;
  // Z_SYNC_FLUSH so a deliberately truncated read (MAX_ENTRY_BYTES) still
  // yields everything decoded up to the cut instead of throwing.
  const out = zlib.inflateRawSync(comp, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  return out.toString('latin1');
}

// ── ZIP structures ────────────────────────────────────────────────

const Z64 = 0xFFFFFFFF;

function findEocd(buf) {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      // The ZIP64 end-of-central-directory LOCATOR, when present, sits in
      // the 20 bytes immediately before the classic EOCD.
      let zip64Locator = null;
      if (i >= 20 && buf.readUInt32LE(i - 20) === 0x07064b50) {
        zip64Locator = Number(buf.readBigUInt64LE(i - 12));
      }
      return {
        cdSize: buf.readUInt32LE(i + 12),
        cdOffset: buf.readUInt32LE(i + 16),
        zip64Locator: zip64Locator,
      };
    }
  }
  return null;
}

// The ZIP64 EOCD record holds the true 64-bit central-directory size and
// offset. It is usually already inside the tail we fetched; if not, one more
// small range request gets it.
async function readZip64Eocd(url, tail, tailStart, eocd, row) {
  const at = eocd.zip64Locator;
  let buf = null;
  if (at != null && at >= tailStart && at + 56 <= tailStart + tail.length) {
    buf = tail.slice(at - tailStart, at - tailStart + 56);
  } else if (at != null) {
    buf = await httpRange(url, at, at + 55);
    row.bytesFetched += buf.length;
  } else {
    // No locator: scan the tail for the record signature directly.
    for (let i = tail.length - 56; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06064b50) { buf = tail.slice(i, i + 56); break; }
    }
  }
  if (!buf || buf.length < 56 || buf.readUInt32LE(0) !== 0x06064b50) return null;
  return {
    cdSize: Number(buf.readBigUInt64LE(40)),
    cdOffset: Number(buf.readBigUInt64LE(48)),
  };
}

function parseCentralDirectory(buf) {
  const out = [];
  let pos = 0;
  while (pos + 46 <= buf.length) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buf.readUInt16LE(pos + 10);
    let compSize = buf.readUInt32LE(pos + 20);
    let uncompSize = buf.readUInt32LE(pos + 24);
    const fnLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const cmtLen = buf.readUInt16LE(pos + 32);
    let lfhOffset = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + fnLen).toString('utf8');

    // In a ZIP64 archive the oversized fields read 0xFFFFFFFF here and their
    // real values live in the 0x0001 extra field, in this fixed order:
    // uncompressed size, compressed size, local-header offset, disk start - 
    // present only for the fields that overflowed.
    if (uncompSize === Z64 || compSize === Z64 || lfhOffset === Z64) {
      const ex = buf.slice(pos + 46 + fnLen, pos + 46 + fnLen + extraLen);
      let p = 0;
      while (p + 4 <= ex.length) {
        const id = ex.readUInt16LE(p), sz = ex.readUInt16LE(p + 2);
        if (id === 0x0001) {
          let q = p + 4;
          if (uncompSize === Z64 && q + 8 <= p + 4 + sz) { uncompSize = Number(ex.readBigUInt64LE(q)); q += 8; }
          if (compSize === Z64 && q + 8 <= p + 4 + sz) { compSize = Number(ex.readBigUInt64LE(q)); q += 8; }
          if (lfhOffset === Z64 && q + 8 <= p + 4 + sz) { lfhOffset = Number(ex.readBigUInt64LE(q)); q += 8; }
          break;
        }
        p += 4 + sz;
      }
    }

    out.push({ name: name, method: method, compSize: compSize, uncompSize: uncompSize, lfhOffset: lfhOffset });
    pos += 46 + fnLen + extraLen + cmtLen;
  }
  return out;
}

// ── TSG header parsing ────────────────────────────────────────────

// The scanned interval, from the [band headers] block (corrected
// 2026-10-13: an inventory of full headers found these lines there, not in
// [coordinates]). Entries there are
// written as "<index>:<name>;<min>;<max>;..." - the index prefix is present
// in some files and absent in others, hence the optional group.
// Verified WA/05GJD001:  Depth (m);150.000000;316.000000;2;-1;0;
//                        TIDL Depth Backup;150.002975;315.982697
// Verified NT/1113660_ECD10:  80:Depth (m);24.003340;103.486778;2;-1;0;
//                             92:TIDL Depth Backup;24.003338;103.486778;
// The name is anchored so decoys in the same block - "Interactive Depth
// Logging" (+/-16777216) and per-mineral "PFIT depth" scalars - never match.
const DEPTH_RE = /^\s*(?:\d+\s*:\s*)?Depth\s*\(m\)\s*;\s*(-?\d+(?:\.\d+)?)\s*;\s*(-?\d+(?:\.\d+)?)/mi;
const DEPTH_BACKUP_RE = /^\s*(?:\d+\s*:\s*)?TIDL\s+Depth\s+Backup\s*;\s*(-?\d+(?:\.\d+)?)\s*;\s*(-?\d+(?:\.\d+)?)/mi;

// Three-tier scan date, highest confidence first (Ben Kay's tiering).
const SCAN_DATE_EQ_RE = /^\s*scan date\s*=\s*(\S+(?:\s+\S+)?)/mi;
const SCAN_DATE_HIST_RE = /scan date\s*:\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}:\d{2})?)/i;
const CREATED_RE = /^\s*Created\s*:\s*(\S.*?)\s*$/mi;

// Instrument appears in two forms in the wild:
//   hylogger name = HyLogger 2-7        (NT files)
//   HyLogger :<value>                   (older files)
// The second form also matches numeric data lines, so numeric-only values are
// rejected rather than fed to the fleet chart as a fake instrument.
const INSTRUMENT_EQ_RE = /^\s*hylogger\s*name\s*=\s*(\S.*?)\s*$/mi;
const INSTRUMENT_COLON_RE = /^\s*HyLogger\s*:\s*(\S.*?)\s*$/mi;
const UUID_RE = /^\s*UUID\s*:\s*(\S+)/mi;

// Collar position from the [dbextra] block (corrected 2026-10-13: there is
// no [borehole] block; 'lat lon =' sits in [dbextra]). Verified in the wild (31 Aug
// 2026, 36-archive sample across six states): the field EXISTS everywhere
// but is operator-entered free text - WA populates it 6/6 in clean GDA94,
// VIC zeroes it 6/6, and the populated remainder includes swapped axes
// (SA: "138.91 -34.34"), dropped minus signs (QLD: "+21.73"), and MGA
// eastings/northings stuffed straight into the field (TAS: "5340643
// 382466"). So every value is classified, never trusted: the raw pair is
// stored verbatim, and lat/lng are emitted only when the value is
// unambiguous - as-is, axis-swapped, or sign-flipped INTO the Australian
// window. Projected-looking magnitudes are kept raw and never converted.
const LAT_LON_RE = /^\s*lat lon\s*=\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/mi;
const GEO_DATUM_RE = /^\s*geo datum\s*=\s*(\S+)/mi;

// Identity fields of the [dbextra] block, read only inside that block so a
// same-named key elsewhere in the header can never stand in for one. Seen
// in all 20 full headers sampled on 2026-10-13 (NT, QLD, TAS):
//   drillhole name = bh080912      the node's hole id (QLD), or a number
//   hole service = http://.../borehole/    the node the hole belongs to
//   dataset name = BaalGammon_BG053
//   collar = 0.0 0.0 -90.0         three numbers, operator-entered
//   ntrays = 43    nsamples = 28380
//   traypicslog id / traythumbslog id / mospiclog id / imagelog id = GUIDs
//     of the node's image logs (tray photos, thumbnails, mosaic, imagery)
// [key, row field, kind]
const DBEXTRA_FIELDS = [
  ['drillhole name', 'drillholeName', 'text'],
  ['hole service', 'holeService', 'text'],
  ['dataset name', 'datasetName', 'text'],
  ['collar', 'collar', 'numbers'],
  ['ntrays', 'ntrays', 'int'],
  ['nsamples', 'nsamples', 'int'],
  ['traypicslog id', 'traypicsLogId', 'text'],
  ['traythumbslog id', 'traythumbsLogId', 'text'],
  ['mospiclog id', 'mospicLogId', 'text'],
  ['imagelog id', 'imageLogId', 'text'],
];

function parseDbextra(text) {
  const out = {};
  const lines = String(text).split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !/^\s*\[dbextra\]\s*$/i.test(lines[i])) i++;
  if (i >= lines.length) return out;
  const kv = {};
  for (i++; i < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[i]); i++) {
    const m = lines[i].match(/^\s*([^=]+?)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1].toLowerCase() in kv)) kv[m[1].toLowerCase()] = m[2];
  }
  DBEXTRA_FIELDS.forEach(function(f) {
    const v = kv[f[0]];
    if (v === undefined || v === '') return;
    if (f[2] === 'int') {
      const n = Number(v);
      if (Number.isInteger(n) && n >= 0) out[f[1]] = n;
    } else if (f[2] === 'numbers') {
      const a = v.split(/\s+/).map(Number);
      if (a.length && a.every(isFinite)) out[f[1]] = a;
    } else {
      out[f[1]] = v;
    }
  });
  return out;
}

// The Australian window: lat -45..-8, lng 110..155.
function inAu(lat, lng) {
  return lat >= -45 && lat <= -8 && lng >= 110 && lng <= 155;
}

function classifyLatLon(a, b) {
  if (a === 0 && b === 0) return { status: 'zeroed' };
  if (Math.abs(a) > 360 || Math.abs(b) > 360) return { status: 'projected' };
  if (inAu(a, b)) return { status: 'ok', lat: a, lng: b };
  if (inAu(b, a)) return { status: 'swapped', lat: b, lng: a };
  if (inAu(-a, b)) return { status: 'sign', lat: -a, lng: b };
  return { status: 'out-of-range' };
}

function parseTsgHeader(text) {
  const out = {
    scanDate: null, dateConfidence: null, instrument: null, tsgUuid: null,
    depth: null, depthRejected: false, identity: parseDbextra(text),
  };

  const u = text.match(UUID_RE);
  if (u) out.tsgUuid = u[1].trim();

  const ll = text.match(LAT_LON_RE);
  if (ll) {
    const rawLat = Number(ll[1]), rawLon = Number(ll[2]);
    const cls = classifyLatLon(rawLat, rawLon);
    if (cls.status !== 'zeroed') {
      out.coords = {
        rawLat: rawLat, rawLon: rawLon,
        status: cls.status,
        lat: cls.lat != null ? cls.lat : null,
        lng: cls.lng != null ? cls.lng : null,
        datum: (text.match(GEO_DATUM_RE) || [, ''])[1],
      };
    }
  }

  let inst = text.match(INSTRUMENT_EQ_RE);
  if (!inst) inst = text.match(INSTRUMENT_COLON_RE);
  if (inst) {
    const v = inst[1].trim();
    // '0 0.000000 14' is a data row, not an instrument name.
    if (v && !/^[\d\s.,+-]+$/.test(v)) out.instrument = canonicalInstrument(v);
  }

  // Depth - scan the WHOLE header; the line sits at different offsets in
  // different files and is absent from some altogether.
  let d = text.match(DEPTH_RE);
  let source = 'Depth (m)';
  if (!d) { d = text.match(DEPTH_BACKUP_RE); source = 'TIDL Depth Backup'; }
  if (d) {
    const from = Number(d[1]), to = Number(d[2]);
    if (plausibleInterval(from, to)) {
      out.depth = { from: from, to: to, source: source };
    } else {
      out.depthRejected = true;
    }
  }

  // Scan date, three tiers.
  let m = text.match(SCAN_DATE_EQ_RE);
  if (m && plausibleYear(m[1])) {
    out.scanDate = normDate(m[1]); out.dateConfidence = 'high'; return out;
  }
  m = text.match(SCAN_DATE_HIST_RE);
  if (m && plausibleYear(m[1])) {
    out.scanDate = normDate(m[1]); out.dateConfidence = 'good'; return out;
  }
  m = text.match(CREATED_RE);
  if (m && plausibleYear(m[1])) {
    out.scanDate = normDate(m[1]); out.dateConfidence = 'created';
  }
  return out;
}

// Sanity clamp: an interval must run downhole and stay inside the deepest
// plausible HyLogger run. Anything else is a parse artefact, not a scan.
function plausibleInterval(from, to) {
  if (!isFinite(from) || !isFinite(to)) return false;
  if (to <= from) return false;
  if (from < 0 || to > 20000) return false;
  if (to - from > MAX_INTERVAL_M) return false;
  return true;
}

function plausibleYear(s) {
  const m = String(s || '').match(/(\d{4})/);
  if (!m) return false;
  const y = Number(m[1]);
  return y >= 2000 && y <= 2035;
}

function normDate(s) {
  const m = String(s || '').match(/(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?/);
  if (!m) return String(s).trim();
  return m[2] ? m[1] + ' ' + m[2] : m[1];
}

// Mirror of harvest.js canonicalInstrument so the fleet chart stays one table.
function canonicalInstrument(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!s || /^(na|unknown|na or unknown|none)$/i.test(s)) return null;
  const m = s.match(/^(hylogger|hychips)s?\s*(\d+)\s*[-. ]?\s*(\d+)?$/i);
  if (m) {
    const kind = m[1].toLowerCase() === 'hychips' ? 'HyChips' : 'HyLogger';
    return kind + ' ' + m[2] + (m[3] ? '-' + m[3] : '');
  }
  return s;
}

// The archive name is the borehole handle on THREDDS. WA names the archive
// after the borehole (05GJD001.zip); NT prefixes the numeric feature id
// (1113660_ECD10.zip). Both are kept whole here - harvest.js does the
// tolerant matching, because only it knows what the WFS called the hole.
function boreholeIdFromZip(zipName) {
  return zipName.replace(/\.zip$/i, '');
}

// ── HTTP ──────────────────────────────────────────────────────────

async function httpHead(url) {
  const resp = await fetchWithRetry(url, { method: 'HEAD' });
  return {
    size: Number(resp.headers.get('content-length') || 0),
    acceptRanges: resp.headers.get('accept-ranges') || '',
  };
}

async function httpRange(url, start, end) {
  const resp = await fetchWithRetry(url, { headers: { Range: 'bytes=' + start + '-' + end } });
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

async function fetchWithRetry(url, opts) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS * attempt);
    const controller = new AbortController();
    const timer = setTimeout(function() { controller.abort(); }, TIMEOUT_MS);
    try {
      const init = Object.assign({}, opts || {});
      init.headers = Object.assign({ 'User-Agent': USER_AGENT }, init.headers || {});
      init.signal = controller.signal;
      const resp = await fetch(url, init);
      if (resp.status === 429 || resp.status >= 500) {
        lastErr = new Error('http_' + resp.status);
        continue;
      }
      if (!resp.ok && resp.status !== 206) throw new Error('http_' + resp.status);
      return resp;
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error('timeout') : e;
      if (/^http_4/.test(lastErr.message)) throw lastErr;   // 404 will not heal
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('network');
}

function classifyError(e) {
  const m = String((e && e.message) || e || 'network');
  if (/^http_/.test(m) || m === 'timeout') return m;
  return 'network_' + m.slice(0, 60);
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(function() { controller.abort(); }, timeoutMs || TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

function decodeXmlEntities(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function flushAndExit(signal) {
  if (LIVE_CACHE) {
    saveCache(CACHE_PATH, LIVE_CACHE);
    console.log('\n' + signal + ' - flushed ' + LIVE_CACHE.size + ' cache rows to ' + CACHE_PATH);
  }
  process.exit(130);
}

if (require.main === module) {
  process.on('SIGINT', function() { flushAndExit('SIGINT'); });
  process.on('SIGTERM', function() { flushAndExit('SIGTERM'); });
  run().catch(function(err) {
    if (LIVE_CACHE) saveCache(CACHE_PATH, LIVE_CACHE);
    console.error('TSG enrichment failed: ' + err.message);
    process.exit(1);
  });
}

module.exports = { parseTsgHeader, loadCache, boreholeIdFromZip, CACHE_PATH, SOURCE_TAG, MIRROR_DOI };
