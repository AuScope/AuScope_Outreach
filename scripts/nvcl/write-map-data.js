#!/usr/bin/env node
/**
 * AuScope NVCL - map feeds from the weekly harvest
 *
 * Turns the harvest snapshot (data/nvcl_stats.json) and its per-borehole
 * evidence (data/nvcl/boreholes-detail.jsonl), both written by harvest.js,
 * into the files the two public maps read:
 *
 *   data/map_boreholes.json    NVCL_Map.html: one row per borehole with
 *                              coordinates and scan evidence
 *   data/map_timeline.json     NVCL_Map.html: monthly additions + running totals
 *   data/map_summary.json      NVCL_Map.html: 'generated' + national summary
 *   data/nvcl_<state>.geojson  index.html: every NVCL-registered borehole
 *
 * Map rules (one place only - harvest.js records evidence, this decides):
 *   month   first scan month. TSG header scan date (confidence high/good)
 *           > TSG 'Created :' date > node API date (ScanDate, else
 *           createdDate, an ingest date). A month before 2002-01 (no HyLogger existed) or after the
 *           harvest month is not a scan month; the next tier is tried, and a
 *           borehole with none keeps its row but has no month (undated).
 *   v       HyLogger generation 1-4, parsed from the instrument string (TSG
 *           header first, else the node API) with the rules of the retired
 *           build_fact_table.py, v6-to-3 typo fix included (HyLogger strings
 *           only). Otherwise null, with instrument_label when the instrument
 *           type is known.
 *   depth_m unique scanned metres (union of intervals, TSG first) from the
 *           harvest; null when no interval was recorded. Never drilled length.
 *   z, mb   the TSG archive behind the first scan (name without '.zip') and
 *           its size in whole MB, for the popup's NCI THREDDS link: the
 *           catalogue's dataSize when it has one, else the TSG cache's
 *           zipBytes. Only archives the mirror lists right now; none at all
 *           for a state whose catalogue listing is missing.
 *
 * spectra_measured (map_summary.json, nationally and per state): the sum,
 *           over every dataset of the boreholes on the map, of the sample
 *           positions the node says it holds spectra for (the largest
 *           SpectralLog sampleCount of each dataset). Holes known only from a
 *           TSG archive add nothing. A held state keeps its previous figure.
 *
 * Carry-forward: a state whose node was unreachable or degraded this run
 * keeps its previous map rows and its previous geojson file. So does a state
 * whose fresh rows fall below 90% of its rows on the live map (status
 * 'carried'). Both are listed in map_summary.json stale_states.
 *
 * Guards (exit 1, nothing written): more than two states carried by the 90%
 * rule; a negative scanned length on a freshly harvested borehole (carried
 * rows are the only ones sanitised); a state on the current map missing from
 * the new one; total boreholes below 95% of the current map; any month out
 * of range; fewer than 6 states; a duplicate (state, id); a row without
 * coordinates; detail and snapshot from different runs.
 *
 * Env:
 *   NVCL_OUT_DIR=/tmp/x   read the snapshot + detail from, and write every
 *                         output to, this directory (testing); the current
 *                         map in data/ is still the guard baseline
 *
 * Usage: node scripts/nvcl/write-map-data.js   (any working directory)
 */

const fs = require('fs');
const path = require('path');

// scripts/nvcl/ -> repo root, so the script runs from any working directory.
const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const OUT_DIR = process.env.NVCL_OUT_DIR ? path.resolve(process.env.NVCL_OUT_DIR) : null;
const IN_DIR = OUT_DIR || DATA_DIR;
const DEST = OUT_DIR || DATA_DIR;

const SNAPSHOT_FILE = path.join(IN_DIR, 'nvcl_stats.json');
const DETAIL_FILE = path.join(IN_DIR, 'nvcl', 'boreholes-detail.jsonl');
const CACHE_FILE = path.join(IN_DIR, 'nvcl', 'boreholes.jsonl');
// Archive sizes (the catalogue's dataSize, else the cache's zipBytes) and the
// mirror's current listing, for the popup's link to each hole's TSG archive.
// Both live in data/ even under NVCL_OUT_DIR: the harvest never writes them.
const TSG_CACHE_FILE = path.join(DATA_DIR, 'nvcl', 'tsg-cache.jsonl');
const CATALOG_FILE = path.join(DATA_DIR, 'nvcl', 'thredds-catalog.json');

// The node codes harvest.js uses, with the geojson file and label index.html
// expects for each.
const STATES = [
  { code: 'CSIRO', file: 'csiro', label: 'CSIRO' },
  { code: 'NSW',   file: 'nsw',   label: 'New South Wales' },
  { code: 'NT',    file: 'nt',    label: 'Northern Territory' },
  { code: 'QLD',   file: 'qld',   label: 'Queensland' },
  { code: 'SA',    file: 'sa',    label: 'South Australia' },
  { code: 'TAS',   file: 'tas',   label: 'Tasmania' },
  { code: 'VIC',   file: 'vic',   label: 'Victoria' },
  { code: 'WA',    file: 'wa',    label: 'Western Australia' },
];

const MIN_MONTH = '2002-01';           // no HyLogger scanned core before 2002
const MIN_STATES = 6;
const MIN_PREV_FRACTION = 0.95;
const MIN_STATE_FRACTION = 0.9;        // per state, against the live map
const MAX_CARRIED_STATES = 2;          // more carried than this fails the run
const STALE = new Set(['cached', 'degraded', 'unreachable']);
const METHODOLOGY = 'merged, TSG-first; see scripts/nvcl/METHODOLOGY.md';
const GEOJSON_SOURCE = 'NVCL WFS + NVCLDataServices + TSG headers on NCI THREDDS (10.25914/bztg-rg43)';

function main() {
  // -- Inputs --
  const snapshot = readJson(SNAPSHOT_FILE);
  if (!snapshot || !snapshot.summary || !Array.isArray(snapshot.states) || !snapshot.as_of) {
    fail('no harvest snapshot at ' + SNAPSHOT_FILE + ' (run scripts/nvcl/harvest.js first)');
  }
  if (!fs.existsSync(DETAIL_FILE)) fail('no borehole detail at ' + DETAIL_FILE);
  const detail = readJsonl(DETAIL_FILE);
  if (snapshot.detail && snapshot.detail.rows !== detail.length) {
    fail('detail has ' + detail.length + ' rows but the snapshot recorded '
      + snapshot.detail.rows + ': the two files are from different runs');
  }
  const maxMonth = snapshot.as_of.substring(0, 7);
  const cacheFirstSeen = loadFirstSeen(CACHE_FILE);

  // The live map: the carry-forward source and the guard baseline.
  const prevRows = readJson(path.join(DATA_DIR, 'map_boreholes.json')) || [];
  const prevSummary = readJson(path.join(DATA_DIR, 'map_summary.json')) || {};
  const prevByState = groupBy(prevRows, function(r) { return r.state; });

  const statusOf = {};
  snapshot.states.forEach(function(s) { statusOf[s.state] = s.status; });
  // A state the snapshot does not cover at all (an NVCL_ONLY test run) is
  // carried forward exactly like one whose node was down.
  const stale = STATES.map(function(s) { return s.code; }).filter(function(code) {
    return !statusOf[code] || STALE.has(statusOf[code]);
  });

  console.log('NVCL map data - harvest of ' + snapshot.as_of + ' (' + detail.length + ' boreholes in detail)');
  if (stale.length) console.log('Carried forward (node stale this run): ' + stale.join(', '));

  // -- Map rows --
  const errors = [];
  const archives = loadArchives(TSG_CACHE_FILE, CATALOG_FILE);
  const freshByState = {};
  const spectraByState = {};
  const tierCounts = { tsg_scan: 0, api: 0, tsg_created: 0, none: 0, out_of_range_skipped: 0 };
  detail.forEach(function(d) {
    if (stale.indexOf(d.state) !== -1) return;
    if (!d.has_data || d.seeded) return;
    if (!isFinite(d.lat) || !isFinite(d.lng)) return;
    // A negative scanned length in a fresh harvest is a bug upstream, not a
    // value to tidy away: it fails the run. Only carried rows are sanitised.
    if (d.unique_scanned_m != null && d.unique_scanned_m < 0) {
      errors.push('negative unique_scanned_m ' + d.unique_scanned_m + ' at ' + d.state + '/' + d.id
        + ' in the fresh harvest');
    }
    const when = pickMonth(d, maxMonth);
    tierCounts[when.tier]++;
    tierCounts.out_of_range_skipped += when.skipped;
    const inst = pickInstrument(d);
    const row = {
      id: d.id,
      name: d.name || d.id,
      state: d.state,
      lat: round(d.lat, 4),
      lng: round(d.lng, 4),
      month: when.month || undefined,
      month_source: when.source,
      v: inst.v,
      depth_m: d.unique_scanned_m > 0 ? round(d.unique_scanned_m, 1) : null,
      n_datasets: (d.datasets && d.datasets.length) || (d.tsg && d.tsg.length) || 0,
    };
    if (inst.label) row.instrument_label = inst.label;
    spectraByState[d.state] = (spectraByState[d.state] || 0) + (d.datasets || []).reduce(function(acc, x) {
      return acc + (x.spectra > 0 ? x.spectra : 0);
    }, 0);
    const arc = pickArchive(d, archives);
    if (arc) {
      row.z = arc.z;
      if (arc.mb) row.mb = arc.mb;
    }
    (freshByState[d.state] || (freshByState[d.state] = [])).push(row);
  });

  // Per-state guard: a state whose fresh rows fall below 90% of what the
  // live map shows for it keeps its live rows instead, marked 'carried'. A
  // node can answer well enough to pass the harvest's own guards and still
  // lose a large share of one state (a dataset service failing a third of
  // its queries, a TSG match rule gone wrong), and one state's collapse is
  // a measurement fault, not a national event worth failing for. More than
  // two such states in one run is, and stops it.
  const carried = [];
  Object.keys(freshByState).sort().forEach(function(code) {
    const before = (prevByState[code] || []).length;
    const now = freshByState[code].length;
    if (before && now < before * MIN_STATE_FRACTION) {
      carried.push(code);
      console.log('Carried forward (fell below ' + Math.round(MIN_STATE_FRACTION * 100) + '% of the live map): '
        + code + ' ' + now + ' rows against ' + before);
    }
  });
  // A live state the fresh harvest produced no rows for at all is the same
  // event at 100%.
  Object.keys(prevByState).sort().forEach(function(code) {
    if (stale.indexOf(code) === -1 && !freshByState[code] && carried.indexOf(code) === -1) {
      carried.push(code);
      console.log('Carried forward (no fresh rows): ' + code + ' against ' + prevByState[code].length + ' on the live map');
    }
  });
  if (carried.length > MAX_CARRIED_STATES) {
    errors.push(carried.length + ' states fell below ' + Math.round(MIN_STATE_FRACTION * 100)
      + '% of their live map rows (' + carried.join(', ') + '; at most ' + MAX_CARRIED_STATES + ' may be carried)');
  }
  const held = stale.concat(carried);     // every state whose live rows stand

  const rows = [];
  Object.keys(freshByState).forEach(function(code) {
    if (carried.indexOf(code) === -1) freshByState[code].forEach(function(r) { rows.push(r); });
  });
  // Carried rows obey the same rules as fresh ones: the hand-built May 2026
  // map holds a 1993 month (WA/VHD10) and a negative depth (WA/YGD4), and a
  // stale node must not smuggle those back in. These are the only rows that
  // are ever sanitised rather than failed on.
  let sanitised = 0;
  held.forEach(function(code) {
    (prevByState[code] || []).forEach(function(r) {
      const row = Object.assign({}, r);
      if (row.month && !(row.month >= MIN_MONTH && row.month <= maxMonth)) { delete row.month; sanitised++; }
      if (row.depth_m != null && !(row.depth_m >= 0)) { row.depth_m = null; sanitised++; }
      rows.push(row);
    });
  });
  if (sanitised) console.log('Carried rows: ' + sanitised + ' out-of-range month(s) / negative depth(s) dropped');
  rows.sort(function(a, b) {
    if (a.state !== b.state) return a.state < b.state ? -1 : 1;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  });

  // -- Guards --
  const newStates = new Set(rows.map(function(r) { return r.state; }));
  Object.keys(prevByState).forEach(function(st) {
    if (!newStates.has(st)) errors.push('state ' + st + ' is on the current map but missing from the new one');
  });
  if (prevRows.length && rows.length < prevRows.length * MIN_PREV_FRACTION) {
    errors.push('boreholes ' + rows.length + ' < 95% of the current map (' + prevRows.length + ')');
  }
  if (newStates.size < MIN_STATES) errors.push('only ' + newStates.size + ' states (need >= ' + MIN_STATES + ')');
  const seen = new Set();
  rows.forEach(function(r) {
    const key = r.state + '/' + r.id;
    if (seen.has(key)) errors.push('duplicate borehole ' + key);
    seen.add(key);
    // Backstop only: fresh rows failed above on a negative length and
    // carried rows were sanitised, so nothing should reach this.
    if (r.depth_m != null && !(r.depth_m >= 0)) errors.push('negative depth ' + r.depth_m + ' at ' + key);
    if (r.month && !(r.month >= MIN_MONTH && r.month <= maxMonth)) errors.push('month ' + r.month + ' out of range at ' + key);
    if (!isFinite(r.lat) || !isFinite(r.lng)) errors.push('no coordinates at ' + key);
  });
  if (errors.length) {
    console.error('\nMAP DATA GUARD FAILED - nothing written:');
    errors.slice(0, 30).forEach(function(e) { console.error('  - ' + e); });
    if (errors.length > 30) console.error('  ... and ' + (errors.length - 30) + ' more');
    process.exit(1);
  }

  // -- Timeline: built FROM the final rows, so the map's counters always
  // agree with the dots it draws. Undated rows are not drawn, so not counted.
  const byMonth = {};
  rows.forEach(function(r) {
    if (!r.month) return;
    const m = byMonth[r.month] || (byMonth[r.month] = { n: 0, metres: 0 });
    m.n++;
    m.metres += r.depth_m || 0;
  });
  let cumN = 0, cumM = 0;
  const timeline = Object.keys(byMonth).sort().map(function(month) {
    cumN += byMonth[month].n;
    cumM += byMonth[month].metres;
    return {
      month: month,
      new_boreholes: byMonth[month].n,
      new_km: round(byMonth[month].metres / 1000, 1),
      cum_boreholes: cumN,
      cum_km: round(cumM / 1000, 1),
    };
  });

  // -- Summary --
  const generated = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const prevFetched = {}, prevSpectra = {};
  (prevSummary.by_state || []).forEach(function(s) {
    if (s.fetched) prevFetched[s.state] = s.fetched;
    if (typeof s.spectra_measured === 'number') prevSpectra[s.state] = s.spectra_measured;
  });
  const prevGenerated = prevSummary.generated ? String(prevSummary.generated).substring(0, 10) : null;
  const byState = STATES.map(function(s) {
    const mine = rows.filter(function(r) { return r.state === s.code; });
    const isHeld = held.indexOf(s.code) !== -1;
    return {
      state: s.code,
      boreholes: mine.length,
      km: round(sum(mine, 'depth_m') / 1000, 1),
      status: carried.indexOf(s.code) !== -1 ? 'carried' : (statusOf[s.code] || 'not_harvested'),
      fetched: isHeld ? (prevFetched[s.code] || prevGenerated) : snapshot.as_of,
      // A held state keeps the figure it had; null when it never had one.
      spectra_measured: isHeld ? (prevSpectra[s.code] !== undefined ? prevSpectra[s.code] : null)
        : (spectraByState[s.code] || 0),
    };
  }).filter(function(s) { return s.boreholes > 0 || statusOf[s.state]; });
  const months = rows.map(function(r) { return r.month; }).filter(Boolean).sort();
  const sources = { tsg: 0, api: 0, none: 0, carried: 0 };
  rows.forEach(function(r) {
    if (held.indexOf(r.state) !== -1) sources.carried++;
    else if (r.month_source === 'tsg') sources.tsg++;
    else if (r.month_source === 'api') sources.api++;
    else sources.none++;
  });
  const summary = {
    generated: generated,
    methodology: METHODOLOGY,
    harvest_as_of: snapshot.as_of,
    total_boreholes: rows.length,
    total_km: round(sum(rows, 'depth_m') / 1000, 1),
    // Spectra the nodes hold for the boreholes on the map (see the header).
    spectra_measured: sum(byState, 'spectra_measured'),
    undated: rows.filter(function(r) { return !r.month; }).length,
    by_state: byState,
    date_range: { earliest: months[0] || null, latest: months[months.length - 1] || null },
    month_sources: sources,
    stale_states: held.filter(function(code) { return (prevByState[code] || []).length; }).sort(),
  };

  // -- GeoJSON for index.html: every registered borehole, fresh states only.
  // A state carried by the per-state guard keeps its previous file too: its
  // harvest is the thing in doubt.
  const detailByState = groupBy(detail, function(d) { return d.state; });
  const geo = [];
  STATES.forEach(function(s) {
    if (held.indexOf(s.code) !== -1) return;      // previous file stays
    const prevGeo = readJson(path.join(DATA_DIR, 'nvcl_' + s.file + '.geojson'));
    geo.push({ state: s, collection: buildGeojson(s, detailByState[s.code] || [], prevGeo,
      cacheFirstSeen, snapshot), prevCount: prevGeo ? (prevGeo.features || []).length : null });
  });

  // -- Write --
  fs.mkdirSync(DEST, { recursive: true });
  writeRows(path.join(DEST, 'map_boreholes.json'), rows);
  writeRows(path.join(DEST, 'map_timeline.json'), timeline);
  fs.writeFileSync(path.join(DEST, 'map_summary.json'), JSON.stringify(summary, null, 2) + '\n');
  geo.forEach(function(g) {
    fs.writeFileSync(path.join(DEST, 'nvcl_' + g.state.file + '.geojson'),
      JSON.stringify(g.collection, null, 2) + '\n');
  });

  // -- Report --
  console.log('\nWrote ' + rows.length + ' map boreholes, ' + timeline.length + ' timeline months, '
    + 'summary and ' + geo.length + ' geojson file(s) to ' + DEST);
  console.log('Month tiers: ' + JSON.stringify(tierCounts));
  console.log('Month sources: ' + JSON.stringify(sources) + ', undated ' + summary.undated);
  console.log('Spectra measured: ' + summary.spectra_measured.toLocaleString('en-AU'));
  console.log('Total ' + summary.total_km + ' km; timeline ends ' + (timeline.length
    ? timeline[timeline.length - 1].month + ' at ' + timeline[timeline.length - 1].cum_boreholes
      + ' boreholes / ' + timeline[timeline.length - 1].cum_km + ' km' : 'empty'));
  byState.forEach(function(s) {
    const before = (prevByState[s.state] || []).length;
    console.log('  ' + pad(s.state, 6) + pad(s.boreholes, 6) + pad(s.km + ' km', 12)
      + '(map was ' + before + ')  ' + s.status + ', ' + s.fetched);
  });
  geo.forEach(function(g) {
    console.log('  nvcl_' + pad(g.state.file + '.geojson', 15) + pad(g.collection.features.length, 6)
      + 'features (was ' + (g.prevCount == null ? 'absent' : g.prevCount) + ')');
  });
}

// -- Month ---------------------------------------------------------

// First scan month by tier. Within a tier the earliest in-range month wins;
// an out-of-range value never blocks a lower tier that has a real one.
function pickMonth(d, maxMonth) {
  let skipped = 0;
  function earliest(dates) {
    let best = null;
    dates.forEach(function(s) {
      const m = /^\d{4}-\d{2}/.test(String(s || '')) ? String(s).substring(0, 7) : null;
      if (!m) return;
      if (m < MIN_MONTH || m > maxMonth) { skipped++; return; }
      if (!best || m < best) best = m;
    });
    return best;
  }
  const tsg = d.tsg || [];
  const ds = d.datasets || [];
  // Every TSG tier outranks the node API, as METHODOLOGY.md requires ("TSG
  // header scan date > node API date"). Measured on the 2026-10-13 harvest:
  // of 690 boreholes with both a TSG 'Created :' date and an API date, the
  // API date was LATER in 689, by a median of 99 months - it is the ingest
  // date. Ranking it above 'Created :' put 711 boreholes into the 2019-2020
  // bulk-upload months, and only 71 of them within a month of the curated
  // May 2026 map, against 582 with 'Created :' ranked first.
  const tiers = [
    ['tsg_scan', 'tsg', tsg.filter(function(t) { return t.confidence === 'high' || t.confidence === 'good'; })
      .map(function(t) { return t.scanDate; })],
    ['tsg_created', 'tsg', tsg.filter(function(t) { return t.confidence === 'created'; })
      .map(function(t) { return t.scanDate; })],
    ['api', 'api', [].concat(
      ds.map(function(x) { return x.scanDate; }),
      ds.map(function(x) { return x.created; }))],
  ];
  for (let i = 0; i < tiers.length; i++) {
    const m = earliest(tiers[i][2]);
    if (m) return { month: m, source: tiers[i][1], tier: tiers[i][0], skipped: skipped };
  }
  return { month: null, source: null, tier: 'none', skipped: skipped };
}

// -- TSG archive link ------------------------------------------------

// Sizes and, per state, the archive names the mirror lists right now. The
// size is the catalogue's dataSize when it has one (the mirror's current
// file, to four figures), else the TSG cache's zipBytes (exact, but as of
// the read, and the file may have been rewritten since). A state whose
// listing is missing (its catalogue failed and never succeeded) gets no
// listing, and pickArchive() links none of its archives.
function loadArchives(cacheFile, catalogFile) {
  const bytes = {};
  // Line by line and forgiving, as harvest.js reads this file: a size is a
  // popup detail, and a torn line from an interrupted enrichment run must
  // not stop the map being written.
  if (fs.existsSync(cacheFile)) {
    fs.readFileSync(cacheFile, 'utf8').split('\n').forEach(function(l) {
      let r = null;
      try { r = l.trim() ? JSON.parse(l) : null; } catch (e) { return; }
      if (r && r.state && r.zipName && r.zipBytes > 0) bytes[r.state + '/' + r.zipName] = r.zipBytes;
    });
  }
  const listed = {};
  const cat = readJson(catalogFile);
  Object.keys((cat && cat.states) || {}).forEach(function(code) {
    const names = cat.states[code].names || [];
    if (names.length) listed[code] = new Set(names);
    const arc = cat.states[code].archives || {};
    Object.keys(arc).forEach(function(n) {
      if (arc[n] && arc[n].bytes > 0) bytes[code + '/' + n] = arc[n].bytes;
    });
  });
  return { bytes: bytes, listed: listed };
}

// The archive behind a borehole's first scan: the earliest scan date among
// its matched archives, ties (and undated archives, which sort last) by
// name. Only archives the mirror lists are linked, so the popup never
// points at a file that has gone, and a state with no listing gets no link
// at all (until 2026-10-13 it got a link to every archive, unchecked). z is
// the name without '.zip' (the popup rebuilds the URL); mb is the size in
// whole megabytes (10^6 bytes, at least 1), omitted when no size is known.
function pickArchive(d, archives) {
  const listed = archives.listed[d.state];
  if (!listed) return null;
  const tsg = (d.tsg || []).filter(function(t) {
    return t.zip && listed.has(t.zip);
  }).sort(function(a, b) {
    return cmp(a.scanDate || '9999', b.scanDate || '9999') || cmp(a.zip, b.zip);
  });
  if (!tsg.length) return null;
  const size = archives.bytes[d.state + '/' + tsg[0].zip];
  return {
    z: tsg[0].zip.replace(/\.zip$/i, ''),
    mb: size ? Math.max(1, Math.round(size / 1e6)) : null,
  };
}

// -- Instrument ----------------------------------------------------

// Port of parse_instrument() and _fix_v6_typo() from the retired pipeline,
// NVCL_Metadata/2026_Update/nvcl_pipeline/scripts/build_fact_table.py
// lines 33-73. Python's re.match() anchors at the start only; so do these.
const INSTRUMENT_PATTERNS = [
  [/^hylogger[s]?\s*(\d+)\s*[-]?\s*(\d+)?/, 'HyLogger'],   // HyLogger 3-4, Hylogger2-6, hyLogger 3
  [/^hychips\s*(\d+)\s*[-]?\s*(\d+)?/, 'HyChips'],          // HyChips 1, hychips2-3
];
const BLANK_INSTRUMENT = ['', 'NA or Unknown', 'Unknown', 'NA', 'nan', 'None'];

function parseInstrument(name) {
  if (name == null || BLANK_INSTRUMENT.indexOf(String(name).trim()) !== -1) {
    return { type: 'Unknown', version: null, unit: null, canonical: null };
  }
  const s = String(name).trim();
  for (let i = 0; i < INSTRUMENT_PATTERNS.length; i++) {
    const m = s.toLowerCase().match(INSTRUMENT_PATTERNS[i][0]);
    if (m) {
      const version = parseInt(m[1], 10);
      const unit = m[2] ? parseInt(m[2], 10) : null;
      const kind = INSTRUMENT_PATTERNS[i][1];
      return { type: kind, version: version, unit: unit,
        canonical: kind + ' ' + version + (unit ? '-' + unit : '') };
    }
  }
  return { type: 'Other', version: null, unit: null, canonical: s };
}

// There is no real HyLogger version 6 - the highest is v4. Rows with v6 come
// from operator typos in TSG metadata (Hylogger 6-X should be 3-X).
function fixV6Typo(version, unit) {
  if (version === 6 && (unit === 2 || unit === 3 || unit === 4)) return 3;
  return version;
}

// TSG header first (the instrument's own record), else the node API. The
// earliest-dated archive / dataset that names an instrument speaks for the
// borehole, matching the first-scan month.
function pickInstrument(d) {
  const tsg = (d.tsg || []).filter(function(t) { return t.instrument; })
    .sort(function(a, b) { return cmp(a.scanDate || '9999', b.scanDate || '9999') || cmp(a.zip, b.zip); });
  const api = (d.datasets || []).filter(function(x) { return x.instrument && x.instrument !== 'Unknown'; })
    .sort(function(a, b) { return cmp(a.scanDate || a.created || '9999', b.scanDate || b.created || '9999'); });
  let p = tsg.length ? parseInstrument(tsg[0].instrument) : null;
  if (!p || p.type === 'Unknown') p = api.length ? parseInstrument(api[0].instrument) : null;
  if (!p || p.type === 'Unknown') return { v: null, label: null, name: null };
  // v is a HyLogger generation, so it is only ever set for a HyLogger. The
  // v6 rule is a HyLogger typo fix; the retired prep step applied it to any
  // type, which turned 'HyChips 6-3' into a HyLogger 3 dot. A HyChips is
  // labelled with the name its file records instead.
  if (p.type === 'HyLogger') {
    const version = fixV6Typo(p.version, p.unit);
    if (version >= 1 && version <= 4) return { v: version, label: null, name: p.canonical };
    return { v: null, label: 'HyLogger (version unknown)', name: p.canonical };
  }
  if (p.type === 'HyChips') return { v: null, label: p.canonical, name: p.canonical };
  return { v: null, label: 'Other (version unknown)', name: p.canonical };
}

// -- GeoJSON for index.html ------------------------------------------

// Same property names, in the same order, as the retired Python scraper
// wrote, so index.html reads it unchanged. Fields the harvest does not know
// are null.
function buildGeojson(s, rows, prevGeo, cacheFirstSeen, snapshot) {
  const prevFirstSeen = {};
  ((prevGeo && prevGeo.features) || []).forEach(function(f) {
    const p = f.properties || {};
    if (p.boreholeId && p.firstSeen) prevFirstSeen[p.boreholeId] = p.firstSeen;
  });
  const features = rows.filter(function(d) {
    return !d.seeded && isFinite(d.lat) && isFinite(d.lng);
  }).map(function(d) {
    const ds = (d.datasets || []).slice().sort(function(a, b) {
      return cmp(a.created || '9999', b.created || '9999');
    });
    const firstOf = function(k) {
      for (let i = 0; i < ds.length; i++) if (ds[i][k]) return ds[i][k];
      return null;
    };
    const seenDates = [prevFirstSeen[d.id], cacheFirstSeen[d.state + '/' + d.id]].filter(Boolean).sort();
    return {
      type: 'Feature',
      properties: {
        name: d.name || d.id,
        boreholeId: d.id,
        boreholeLength: d.lengthM == null ? null : d.lengthM,
        elevation: d.elevation == null ? null : d.elevation,
        custodian: d.custodian || null,
        drillingMethod: d.drillingMethod || null,
        drillEndDate: d.drillEndDate || null,
        purpose: d.purpose || null,
        instrument: pickInstrument(d).name,
        drillDate: firstOf('drillDate'),
        datasetCreated: firstOf('created'),
        firstSeen: seenDates[0] || snapshot.as_of,
        scannedMetres: d.unique_scanned_m > 0 ? round(d.unique_scanned_m, 2) : null,
        project: firstOf('project'),
        owner: firstOf('owner'),
        state: d.state,
      },
      geometry: { type: 'Point', coordinates: [d.lng, d.lat] },
    };
  });
  return {
    type: 'FeatureCollection',
    metadata: {
      source: GEOJSON_SOURCE,
      state: s.file,
      stateLabel: s.label,
      fetched: snapshot.harvested_at || (snapshot.as_of + 'T00:00:00Z'),
    },
    features: features,
  };
}

// -- Plumbing --------------------------------------------------------

// A JSON array with one element per line: valid JSON, and a weekly git diff
// shows exactly which boreholes changed.
function writeRows(file, rows) {
  const body = rows.map(function(r) { return JSON.stringify(r); }).join(',\n');
  fs.writeFileSync(file, '[\n' + body + (rows.length ? '\n' : '') + ']\n');
}

function loadFirstSeen(file) {
  const out = {};
  readJsonl(file).forEach(function(r) {
    if (r && r.state && r.id && r.firstSeen) out[r.state + '/' + r.id] = r.firstSeen;
  });
  return out;
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { fail('cannot parse ' + file + ': ' + e.message); }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(function(l) { return l.trim(); })
    .map(function(l, i) {
      try { return JSON.parse(l); }
      catch (e) { return fail('cannot parse line ' + (i + 1) + ' of ' + file + ': ' + e.message); }
    });
}

function groupBy(list, fn) {
  const out = {};
  list.forEach(function(x) { const k = fn(x); (out[k] || (out[k] = [])).push(x); });
  return out;
}

function sum(list, key) {
  return list.reduce(function(acc, r) { return acc + (r[key] || 0); }, 0);
}

function round(x, dp) {
  const f = Math.pow(10, dp);
  return Math.round(x * f) / f;
}

function cmp(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

function pad(v, w) { return String(v).padEnd(w); }

function fail(msg) {
  console.error('write-map-data: ' + msg);
  process.exit(1);
}

main();
