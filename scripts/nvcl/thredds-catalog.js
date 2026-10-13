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
 *   { fetched, source, states: { WA: { subpath, count, names: [...] }, ... } }
 *
 * Cheap (six catalogue XMLs, no archives touched). Run before harvest.js.
 * Exit status: 0 when every catalogue was read; 1 when any failed (failed
 * states keep their previous entry, flagged with `error` and `stale_since`);
 * 1 without writing anything when every catalogue failed.
 *
 * Usage: node scripts/nvcl/thredds-catalog.js   (any working directory)
 */

const fs = require('fs');
const path = require('path');

// scripts/nvcl/ -> repo root, so the script runs from any working directory.
const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'data', 'nvcl', 'thredds-catalog.json');
const UA = 'AuScope-Outreach NVCL harvester (+https://github.com/AuScope/AuScope_Outreach)';

// THREDDS subpaths are case-sensitive and do NOT all match our node codes
// (Nsw/Wa/Nt all 404). Keys here are our node codes; values are the paths.
const SUBPATHS = { SA: 'SA', TAS: 'Tas', WA: 'WA', NT: 'NT', QLD: 'Qld', VIC: 'Vic' };
const BASE = 'https://thredds.nci.org.au/thredds/catalog/rs07/';

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
      const names = [];
      const re = /<dataset[^>]*name="([^"]+\.zip)"/g;
      let m;
      while ((m = re.exec(xml)) !== null) names.push(m[1]);
      states[code] = { subpath: SUBPATHS[code], count: names.length, names: names.sort() };
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
        console.warn('  ' + code + ': catalogue unreachable (' + e.message + ') - previous entry kept ('
          + before.count + ' archives)');
      } else {
        console.warn('  ' + code + ': catalogue unreachable (' + e.message + ') - omitted, not zeroed');
        states[code] = { subpath: SUBPATHS[code], count: null, names: [], error: String(e.message) };
      }
    }
  }
  if (failed.length === Object.keys(SUBPATHS).length) {
    console.error('\nEvery catalogue failed - nothing written; the previous snapshot stays.');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    fetched: new Date().toISOString(),
    source: 'NCI THREDDS rs07 - AuScope NVCL TSG mirror (10.25914/bztg-rg43)',
    states: states,
  }, null, 1));
  console.log('\nWrote ' + OUT);
  if (failed.length) {
    console.error('Catalogue(s) unreachable: ' + failed.join(', ') + ' (exiting 1)');
    process.exitCode = 1;
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
