#!/usr/bin/env node
/**
 * AuScope NVCL - THREDDS catalogue snapshot
 *
 * Ported from bvkay/AuScope_doi_tracker src/nvcl/thredds-catalog.js on
 * 2026-10-13. Changes: paths resolve from scripts/nvcl/, the config.json
 * mailto in the User-Agent is replaced by the repo URL, and a state whose
 * catalogue cannot be read keeps its previous entry (flagged) instead of
 * being blanked, with a non-zero exit so the failure is visible.
 *
 * Records what the AuScope TSG mirror on NCI THREDDS actually holds, per
 * state, so the harvest can RECONCILE it against what each state's own
 * services surface.
 *
 * This matters because the two disagree. Measured 2026-08-06: the mirror
 * holds 407 archives more than the state nodes expose as boreholes-with-
 * data - WA +282, QLD +144, TAS +24 - and Victoria, whose node reports no
 * NVCL datasets at all, has 39 archives sitting on the mirror. Scanned
 * core that a state service does not advertise is still scanned core; the
 * page should say so rather than quietly inherit the node's blind spot.
 *
 * Writes data/nvcl/thredds-catalog.json:
 *   { fetched, source, states: { WA: { subpath, count, names: [...],
 *     archives: { '<name>.zip': { bytes, modified }, ... } }, ... } }
 * bytes is the catalogue's dataSize in bytes (THREDDS prints it to four
 * figures in decimal units: '402.7 Mbytes' is 402,700,000 bytes for a file
 * of 402,744,170) and modified its 'modified' date. Both were discarded
 * until 2026-10-13; the map now takes each archive's size from here, and
 * tsg-enrich.js re-reads an archive whose file is newer than its read.
 *
 * Then reconciles data/nvcl/tsg-cache.jsonl against the listing (added
 * 2026-10-13). The cache only ever grew, so an archive the mirror had
 * dropped or renamed stayed in it and kept counting: on 2026-10-13, 115 of
 * its 5,610 rows were no longer on the mirror (88 of them renamed, with a
 * successor listed), 62 of those among the 752 rows the previous harvest
 * had left unmatched and counted as mirror-only. Now, for every state whose
 * catalogue was read THIS run, a cache row whose archive is not listed is
 * stamped `gone: <date first missed>` (the row is kept: it is still the
 * record of a scan) and, when a listed archive carries the same TSG UUID
 * and the same scan interval, `successor: <its name>`; a row whose archive
 * is listed again loses both. (A UUID alone is not enough: a few headers
 * were copied into several holes' archives; see harvest.js loadTsgIndex.)
 * harvest.js matches and counts no gone row, and the map links none. A
 * state whose catalogue failed is left exactly as it was.
 *
 * Shrink guard (added 2026-10-13): a listing with fewer than 80% of the
 * names the previous snapshot held for that state is not believed. A
 * truncated catalogue page would otherwise stamp a fifth of a state's
 * archives gone, and gone rows stop counting. Such a state is treated like
 * one whose catalogue failed: its previous entry is kept, flagged, its
 * cache rows are not reconciled, and the run exits 1 at the end (the
 * workflow step is continue-on-error, so the warning issue fires).
 *
 * Cheap (six catalogue XMLs, no archives touched). Run before harvest.js.
 * Exit status: 0 when every catalogue was read and believed; 1 when any
 * failed or shrank (those states keep their previous entry, flagged with
 * `error` and `stale_since`); 1 without writing anything when every
 * catalogue failed.
 *
 * Usage: node scripts/nvcl/thredds-catalog.js   (any working directory)
 */

const fs = require('fs');
const path = require('path');
// Cache I/O and the UUID join key are tsg-enrich.js's own, so the two
// scripts can never disagree on the cache's format.
const tsgEnrich = require('./tsg-enrich.js');

// scripts/nvcl/ -> repo root, so the script runs from any working directory.
const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'data', 'nvcl', 'thredds-catalog.json');
const UA = 'AuScope-Outreach NVCL harvester (+https://github.com/AuScope/AuScope_Outreach)';

// THREDDS subpaths are case-sensitive and do NOT all match our node codes
// (Nsw/Wa/Nt all 404). Keys here are our node codes; values are the paths.
const SUBPATHS = { SA: 'SA', TAS: 'Tas', WA: 'WA', NT: 'NT', QLD: 'Qld', VIC: 'Vic' };
const BASE = 'https://thredds.nci.org.au/thredds/catalog/rs07/';
// A listing below this share of the previous snapshot's names is not
// believed (see the header).
const MIN_LISTING_FRACTION = 0.8;

async function run() {
  console.log('THREDDS catalogue snapshot');
  console.log('==========================\n');
  const previous = readJson(OUT, null);
  const prevStates = (previous && previous.states) || {};
  const states = {};
  const failed = [];
  for (const code of Object.keys(SUBPATHS)) {
    const url = BASE + SUBPATHS[code] + '/catalog.xml';
    try {
      const xml = await fetchText(url);
      const archives = parseCatalog(xml);
      const names = Object.keys(archives).sort();
      const before = prevStates[code];
      const prevN = before && Array.isArray(before.names) ? before.names.length : 0;
      if (prevN && names.length < prevN * MIN_LISTING_FRACTION) {
        throw new Error('listing shrank to ' + names.length + ' of the ' + prevN
          + ' names in the previous snapshot (below ' + Math.round(MIN_LISTING_FRACTION * 100)
          + '%); not believed, not reconciled');
      }
      states[code] = { subpath: SUBPATHS[code], count: names.length, names: names, archives: archives };
      console.log('  ' + code + ': ' + names.length + ' archives');
    } catch (e) {
      failed.push(code);
      const before = prevStates[code];
      if (before && typeof before.count === 'number') {
        // Keep what we last knew, flagged, rather than blank a good entry.
        states[code] = Object.assign({}, before, {
          error: String(e.message),
          stale_since: before.stale_since || (previous && previous.fetched) || null,
        });
        console.warn('  ' + code + ': catalogue not used (' + e.message + ') - previous entry kept ('
          + before.count + ' archives)');
      } else {
        console.warn('  ' + code + ': catalogue not used (' + e.message + ') - omitted, not zeroed');
        states[code] = { subpath: SUBPATHS[code], count: null, names: [], error: String(e.message) };
      }
    }
  }
  if (failed.length === Object.keys(SUBPATHS).length) {
    console.error('\nEvery catalogue failed - nothing written; the previous snapshot stays.');
    process.exit(1);
  }
  const fetched = new Date().toISOString();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, serialise({
    fetched: fetched,
    source: 'NCI THREDDS rs07 - AuScope NVCL TSG mirror (10.25914/bztg-rg43)',
    states: states,
  }));
  console.log('\nWrote ' + OUT);
  const fresh = Object.keys(states).filter(function(code) { return failed.indexOf(code) === -1; });
  reconcileCache(states, fresh, fetched.substring(0, 10));
  if (failed.length) {
    console.error('Catalogue(s) unreachable or not believed: ' + failed.join(', ') + ' (exiting 1)');
    process.exitCode = 1;
  }
}

// Every '<name>.zip' dataset in a catalogue with its size and modified date.
// Names are entity-decoded the way tsg-enrich.js decodes them, so the two
// agree on every key.
const UNIT_BYTES = { bytes: 1, kbytes: 1e3, mbytes: 1e6, gbytes: 1e9, tbytes: 1e12 };

function parseCatalog(xml) {
  const out = {};
  const re = /<dataset\b[^>]*\bname="([^"]+\.zip)"[^>]*?(\/?)>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const name = decodeXml(m[1]);
    let body = '';
    if (!m[2]) {
      const end = xml.indexOf('</dataset>', re.lastIndex);
      body = end === -1 ? '' : xml.slice(re.lastIndex, end);
    }
    const size = body.match(/<dataSize[^>]*units="([^"]+)"[^>]*>\s*([\d.]+)\s*</);
    const mod = body.match(/<date[^>]*type="modified"[^>]*>\s*([^<\s]+)\s*</);
    const mult = size ? UNIT_BYTES[size[1].toLowerCase()] : null;
    out[name] = {
      bytes: mult && isFinite(Number(size[2])) ? Math.round(Number(size[2]) * mult) : null,
      modified: mod ? mod[1] : null,
    };
  }
  return out;
}

function decodeXml(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// One archive per line, so the weekly diff shows exactly which archives
// changed and the file does not grow four lines per archive.
function serialise(doc) {
  const lines = ['{', ' "fetched": ' + JSON.stringify(doc.fetched) + ',',
    ' "source": ' + JSON.stringify(doc.source) + ',', ' "states": {'];
  const codes = Object.keys(doc.states);
  codes.forEach(function(code, i) {
    const st = doc.states[code];
    const head = Object.keys(st).filter(function(k) { return k !== 'names' && k !== 'archives'; });
    lines.push('  ' + JSON.stringify(code) + ': {');
    head.forEach(function(k) { lines.push('   ' + JSON.stringify(k) + ': ' + JSON.stringify(st[k]) + ','); });
    const names = st.names || [];
    lines.push('   "names": [' + (names.length ? '' : '],'));
    names.forEach(function(n, j) { lines.push('    ' + JSON.stringify(n) + (j < names.length - 1 ? ',' : '')); });
    if (names.length) lines.push('   ],');
    const arc = st.archives || {};
    const keys = Object.keys(arc).sort();
    lines.push('   "archives": {' + (keys.length ? '' : '}'));
    keys.forEach(function(n, j) {
      lines.push('    ' + JSON.stringify(n) + ': ' + JSON.stringify(arc[n]) + (j < keys.length - 1 ? ',' : ''));
    });
    if (keys.length) lines.push('   }');
    lines.push('  }' + (i < codes.length - 1 ? ',' : ''));
  });
  lines.push(' }', '}');
  return lines.join('\n') + '\n';
}

// Stamp cache rows whose archive the mirror no longer lists (see the header).
// Only states in `fresh` (catalogue read this run) are touched.
function reconcileCache(states, fresh, today) {
  const file = tsgEnrich.CACHE_PATH;
  if (!fs.existsSync(file)) {
    console.log('\nTSG cache: none at ' + file + ' (nothing to reconcile)');
    return;
  }
  const cache = tsgEnrich.loadCache(file);
  const byState = {};
  cache.forEach(function(r) { (byState[r.state] || (byState[r.state] = [])).push(r); });
  let changed = 0;
  console.log('\nTSG cache reconciliation (' + cache.size + ' rows):');
  fresh.forEach(function(code) {
    const rows = byState[code] || [];
    const listed = new Set(states[code].names || []);
    // Listed archives by TSG UUID and scan interval, for pointing a gone
    // row at its successor.
    const datasetKey = function(r) {
      const u = tsgEnrich.uuidKey(r.tsgUuid);
      return u && r.depthFromM != null && r.depthToM != null ? u + '#' + r.depthFromM + '-' + r.depthToM : '';
    };
    const liveByUuid = new Map();
    rows.forEach(function(r) {
      const u = datasetKey(r);
      if (u && listed.has(r.zipName)) (liveByUuid.get(u) || liveByUuid.set(u, []).get(u)).push(r.zipName);
    });
    let gone = 0, newlyGone = 0, back = 0, succ = 0;
    rows.forEach(function(r) {
      const before = JSON.stringify([r.gone, r.successor]);
      if (listed.has(r.zipName)) {
        if (r.gone) back++;
        delete r.gone;
        delete r.successor;
      } else {
        if (!r.gone) { r.gone = today; newlyGone++; }
        gone++;
        const twins = (liveByUuid.get(datasetKey(r)) || []).sort();
        if (twins.length) { r.successor = twins[0]; succ++; } else delete r.successor;
      }
      if (JSON.stringify([r.gone, r.successor]) !== before) changed++;
    });
    console.log('  ' + code + ': ' + rows.length + ' rows, ' + gone + ' gone from the mirror ('
      + newlyGone + ' newly, ' + succ + ' with a same-UUID successor), ' + back + ' listed again');
  });
  if (changed) {
    tsgEnrich.saveCache(file, cache);
    console.log('  Wrote ' + file + ' (' + changed + ' row(s) changed)');
  } else {
    console.log('  No change');
  }
}

function fetchText(url) {
  const controller = new AbortController();
  const t = setTimeout(function () { controller.abort(); }, 60000);
  return fetch(url, { headers: { 'User-Agent': UA }, signal: controller.signal })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    })
    .finally(function () { clearTimeout(t); });
}

function readJson(f, fallback) {
  try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {}
  return fallback;
}

run().catch(function (e) { console.error('Failed: ' + e.message); process.exit(1); });
