#!/usr/bin/env node
/**
 * AuScope NVCL - a hole's collar position from its TSG header
 *
 * Added 2026-10-13. Every TSG header carries a 'lat lon =' line and often a
 * 'geo datum =' line in its [dbextra] block (tsg-enrich.js caches both, raw,
 * as latRaw / lonRaw / geoDatum, with coordStatus 'zeroed' or 'absent' when
 * there is nothing to read). They are operator-entered free text: decimal
 * degrees in some states, MGA eastings and northings in others, with or
 * without the zone, sometimes northing first, often 0 0. This module turns
 * them into a position where one can be had, and says how:
 *
 *   decimal          decimal degrees: lat in [-45, -9], lon in [111, 155]
 *                    and inside the state's box (STATE_BOX)
 *   decimal_swapped  the same, axes reversed ('138.91 -34.34')
 *   decimal_sign     the same, latitude's minus sign dropped ('21.73 140.5')
 *   mga_explicit     easting/northing with the zone named in 'geo datum'
 *                    ('GDA94_MGA54'): inverse transverse Mercator on GRS80,
 *                    k0 0.9996, false easting 500000, false northing
 *                    10000000, central meridian 6 x zone - 183. Datum
 *                    differences (AGD66 against GDA94, about 200 m) are
 *                    below anything the map shows and are not modelled.
 *   mga_inferred     easting 150000-850000, northing 5000000-9000000, no
 *                    zone (the northing floor is 5,000,000, not 6,000,000:
 *                    Tasmania lies at 5.16-5.62 million and southern
 *                    Victoria below 6 million, and the TAS header that
 *                    showed the problem, GL14_25, reads '5340643 382466'):
 *                    every zone the state spans (STATE_ZONES) is
 *                    tried and the candidates inside the state's box kept.
 *                    One: used ('single_zone'). Several: the one nearest
 *                    the median collar of the hole's project neighbours
 *                    (archives sharing the name prefix before the first
 *                    underscore, and the node's holes whose name starts
 *                    with that word), when at least 3 of them are placed
 *                    and that candidate lies within 50 km of the median
 *                    ('neighbour_median'). Otherwise unresolved.
 *   swapped          the first value above 1,000,000 and the second below
 *                    it: northing first. Swapped, then as mga_explicit
 *                    (zone named) or mga_inferred.
 *   zeroed / absent  no position ('0 0', or no 'lat lon' line)
 *   unresolved       a value none of the above can place, or whole degrees
 *                    on both axes ('-30 134': a placeholder)
 *   unread           the row predates the identity read (no coordStatus)
 *
 * Validation: for every cached row whose archive belongs to a hole with a
 * WFS collar (the last harvest's data/nvcl/boreholes-detail.jsonl), the
 * distance from the header position to that collar. Median and p95 per
 * class and state; a class/state with p95 above 5 km is NOT used for
 * placement (ACCEPT_P95_M). One with fewer than MIN_VALIDATED rows to judge
 * by takes the class's national verdict (all states pooled), except
 * mga_inferred (OWN_STATE_ONLY), which is placed only in a state whose own
 * validated rows pass: the zone it settles on depends on the state's zones
 * and its projects' neighbours, so QLD's verdict says nothing about WA's.
 *
 * CLI: node scripts/nvcl/coords.js
 *   Classifies every live cache row, records the result on the row
 *   (headerLat, headerLng, headerPosClass, headerPosZone, headerPosHow),
 *   writes the validation table and the accepted class/state pairs to
 *   data/nvcl/header-positions.json and prints both. harvest.js reads the
 *   two to place holes the mirror holds and no node lists (provisional,
 *   source 'thredds'). Runs from any working directory. Exit 1 when the
 *   cache or the detail cannot be read.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DETAIL_FILE = path.join(ROOT, 'data', 'nvcl', 'boreholes-detail.jsonl');
const TABLE_FILE = path.join(ROOT, 'data', 'nvcl', 'header-positions.json');

// [south, north, west, east] in degrees, each state's land and islands with
// about 0.1 degrees to spare. Borders: WA/NT/SA at 129 E, NT/QLD at 138 E,
// SA/QLD/NSW/VIC at 141 E, SA/NT at 26 S, NSW/QLD at about 29 S.
const STATE_BOX = {
  WA:  [-35.3, -13.5, 112.8, 129.1],
  NT:  [-26.1, -10.8, 128.9, 138.1],
  SA:  [-38.2, -25.9, 128.9, 141.1],
  QLD: [-29.3, -9.0, 137.9, 153.7],
  NSW: [-37.6, -28.1, 140.9, 153.7],
  VIC: [-39.2, -33.9, 140.9, 150.1],
  TAS: [-43.8, -39.4, 143.7, 148.6],
};
// MGA zones each state spans.
const STATE_ZONES = {
  WA: [49, 50, 51, 52], NT: [52, 53], SA: [52, 53, 54], QLD: [54, 55, 56],
  NSW: [54, 55, 56], VIC: [54, 55], TAS: [55],
};

const ACCEPT_P95_M = 5000;
const MIN_VALIDATED = 5;
// Classes that never take the national verdict: accepted only on validated
// rows of their own state (changed 2026-10-13).
const OWN_STATE_ONLY = ['mga_inferred'];
const NEIGHBOUR_MIN = 3;
const NEIGHBOUR_MAX_M = 50000;
// A plausible MGA easting and (southern hemisphere) northing anywhere in
// Australia; the state box decides the rest.
const E_MIN = 150000, E_MAX = 850000, N_MIN = 5000000, N_MAX = 9000000;
// Classes that carry a position, in the order a hole's archives are
// preferred when they disagree.
const PLACED_CLASSES = ['decimal', 'mga_explicit', 'swapped', 'mga_inferred', 'decimal_swapped', 'decimal_sign'];

// ── Projection ────────────────────────────────────────────────────

// Inverse transverse Mercator (Snyder 1987, eqs 8-18 to 8-25) on GRS80,
// southern hemisphere: easting/northing in zone -> [lat, lng] in degrees.
function mgaToLatLng(e, n, zone) {
  const a = 6378137.0, f = 1 / 298.257222101, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const x = e - 500000.0, y = n - 10000000.0;
  const M = y / k0;
  const mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 = mu + (3 * e1 / 2 - 27 * Math.pow(e1, 3) / 32) * Math.sin(2 * mu)
    + (21 * e1 * e1 / 16 - 55 * Math.pow(e1, 4) / 32) * Math.sin(4 * mu)
    + (151 * Math.pow(e1, 3) / 96) * Math.sin(6 * mu)
    + (1097 * Math.pow(e1, 4) / 512) * Math.sin(8 * mu);
  const s = Math.sin(phi1), c = Math.cos(phi1), t = Math.tan(phi1);
  const N1 = a / Math.sqrt(1 - e2 * s * s);
  const T1 = t * t, C1 = ep2 * c * c;
  const R1 = a * (1 - e2) / Math.pow(1 - e2 * s * s, 1.5);
  const D = x / (N1 * k0);
  const lat = phi1 - (N1 * t / R1) * (D * D / 2
    - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * Math.pow(D, 4) / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * Math.pow(D, 6) / 720);
  const lon = (D - (1 + 2 * T1 + C1) * Math.pow(D, 3) / 6
    + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * Math.pow(D, 5) / 120) / c;
  return [lat * 180 / Math.PI, zone * 6 - 183 + lon * 180 / Math.PI];
}

// Great-circle distance in metres.
function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000, r = Math.PI / 180;
  const h = Math.pow(Math.sin((lat2 - lat1) * r / 2), 2)
    + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.pow(Math.sin((lng2 - lng1) * r / 2), 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function inBox(state, lat, lng) {
  const b = STATE_BOX[state];
  if (!b) return lat >= -45 && lat <= -9 && lng >= 111 && lng <= 155;
  return lat >= b[0] && lat <= b[1] && lng >= b[2] && lng <= b[3];
}

function decimalOk(state, lat, lng) {
  return lat >= -45 && lat <= -9 && lng >= 111 && lng <= 155 && inBox(state, lat, lng);
}

// The MGA/AMG/UTM zone a 'geo datum' value names, or null ('AHD' is a
// height datum and names none).
function zoneOf(datum) {
  const m = String(datum || '').match(/(?:MGA|AMG|UTM)\D{0,6}(\d{2})/i);
  const z = m ? Number(m[1]) : null;
  return z >= 49 && z <= 56 ? z : null;
}

// ── Classification ────────────────────────────────────────────────

// One row -> { cls, lat, lng, zone, how }. `neighbours` (optional) returns
// the placed positions [[lat, lng], ...] of the row's project neighbours,
// asked only when several zones fit.
function classify(row, state, neighbours) {
  if (row.coordStatus === undefined && row.latRaw === undefined) {
    // Read before positions were parsed: unread, unless the identity block
    // was read (an older parser that dropped '0 0' pairs silently).
    return { cls: row.drillholeName || row.identityFetchedAt ? 'absent' : 'unread' };
  }
  if (row.coordStatus === 'absent') return { cls: 'absent' };
  const a = Number(row.latRaw), b = Number(row.lonRaw);
  if (!isFinite(a) || !isFinite(b)) return { cls: 'absent' };
  if (a === 0 || b === 0) return { cls: 'zeroed' };

  // Degrees. Whole degrees on both axes ('-30 134', SA 185513_TARDD87,
  // 108 km from its collar) are a placeholder, not a position.
  if (Math.abs(a) <= 180 && Math.abs(b) <= 180) {
    if (Number.isInteger(a) && Number.isInteger(b)) return { cls: 'unresolved', how: 'whole_degrees' };
    if (decimalOk(state, a, b)) return { cls: 'decimal', lat: a, lng: b, how: 'decimal' };
    if (decimalOk(state, b, a)) return { cls: 'decimal_swapped', lat: b, lng: a, how: 'axes_swapped' };
    if (decimalOk(state, -a, b)) return { cls: 'decimal_sign', lat: -a, lng: b, how: 'sign_restored' };
    return { cls: 'unresolved', how: 'degrees_outside_state' };
  }

  // Projected. Northing first when the first value is the big one.
  let e = a, n = b, cls = null;
  if (a > 1000000 && b < 1000000) { e = b; n = a; cls = 'swapped'; }
  const zone = zoneOf(row.geoDatum);
  if (zone && e >= E_MIN && e <= E_MAX && n >= N_MIN && n <= N_MAX) {
    const ll = mgaToLatLng(e, n, zone);
    if (inBox(state, ll[0], ll[1])) {
      return { cls: cls || 'mga_explicit', lat: ll[0], lng: ll[1], zone: zone, how: 'zone_from_datum' };
    }
    return { cls: 'unresolved', zone: zone, how: 'named_zone_outside_state' };
  }
  if (!(e >= E_MIN && e <= E_MAX && n >= N_MIN && n <= N_MAX)) {
    return { cls: 'unresolved', how: 'not_mga' };
  }
  cls = cls || 'mga_inferred';
  const cands = (STATE_ZONES[state] || []).map(function(z) {
    const ll = mgaToLatLng(e, n, z);
    return { zone: z, lat: ll[0], lng: ll[1] };
  }).filter(function(c) { return inBox(state, c.lat, c.lng); });
  if (cands.length === 1) {
    return { cls: cls, lat: cands[0].lat, lng: cands[0].lng, zone: cands[0].zone, how: 'single_zone' };
  }
  if (!cands.length) return { cls: 'unresolved', how: 'no_zone_in_state' };
  const pts = neighbours ? neighbours() : [];
  if (pts.length < NEIGHBOUR_MIN) {
    return { cls: 'unresolved', how: cands.length + '_zones_too_few_neighbours' };
  }
  const med = [median(pts.map(function(p) { return p[0]; })), median(pts.map(function(p) { return p[1]; }))];
  const best = cands.map(function(c) {
    return { c: c, d: distanceM(c.lat, c.lng, med[0], med[1]) };
  }).sort(function(x, y) { return x.d - y.d; })[0];
  if (best.d > NEIGHBOUR_MAX_M) {
    return { cls: 'unresolved', how: cands.length + '_zones_none_near_neighbours' };
  }
  return { cls: cls, lat: best.c.lat, lng: best.c.lng, zone: best.c.zone, how: 'neighbour_median' };
}

// The project an archive belongs to: the part of its name before the first
// underscore, when there is one and it is not a feature number (a number
// names one hole, not a project). Normalised like harvest.js normKey.
function projectKey(zipName) {
  const base = String(zipName || '').replace(/\.zip$/i, '');
  const cut = base.indexOf('_');
  if (cut <= 0) return '';
  const k = normKey(base.slice(0, cut));
  return /^\d+$/.test(k) || k.length < 3 ? '' : k;
}

function firstWordKey(name) {
  return normKey(String(name || '').trim().split(/\s+/)[0]);
}

function normKey(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function median(list) {
  const v = list.slice().sort(function(x, y) { return x - y; });
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Nearest-rank percentile.
function percentile(list, p) {
  const v = list.slice().sort(function(x, y) { return x - y; });
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))];
}

// ── Classifying a whole cache ─────────────────────────────────────

// rows: live cache rows. holes: { state: [{ id, name, lat, lng, zips: [...] }] }
// (WFS holes, with the archives the last harvest joined to each). Returns
// Map(row key -> result) and, per row with a WFS collar, the distance.
function classifyAll(rows, holes) {
  const collarByZip = {};
  const byFirstWord = {};
  Object.keys(holes).forEach(function(state) {
    holes[state].forEach(function(h) {
      (h.zips || []).forEach(function(z) { collarByZip[state + '/' + z] = h; });
      const w = firstWordKey(h.name);
      if (w.length >= 3) (byFirstWord[state + '/' + w] || (byFirstWord[state + '/' + w] = [])).push(h);
    });
  });
  // Pass 1: everything that needs no neighbours.
  const first = new Map();
  rows.forEach(function(r) { first.set(r.state + '/' + r.zipName, classify(r, r.state, null)); });
  const byProject = {};
  rows.forEach(function(r) {
    const k = projectKey(r.zipName);
    if (k) (byProject[r.state + '/' + k] || (byProject[r.state + '/' + k] = [])).push(r);
  });
  // Pass 2: several zones fit; ask the neighbours.
  const out = new Map();
  rows.forEach(function(r) {
    const key = r.state + '/' + r.zipName;
    let res = first.get(key);
    if (res.cls === 'unresolved' && /_too_few_neighbours$/.test(res.how || '')) {
      res = classify(r, r.state, function() { return neighbourPoints(r); });
    }
    const hole = collarByZip[key];
    if (hole && res.lat != null) res.errM = distanceM(res.lat, res.lng, hole.lat, hole.lng);
    if (hole) res.hasCollar = true;
    out.set(key, res);
  });
  return out;

  // One position per hole: a neighbour archive's WFS collar when it has
  // one, else its own header position (first pass only, so no answer
  // depends on another guess); then the node's holes named with the
  // project's word.
  function neighbourPoints(r) {
    const k = projectKey(r.zipName);
    const own = collarByZip[r.state + '/' + r.zipName];
    const seen = new Set(own ? [own.id] : []);
    const pts = [];
    (k ? byProject[r.state + '/' + k] || [] : []).forEach(function(o) {
      if (o === r) return;
      const h = collarByZip[o.state + '/' + o.zipName];
      if (h) {
        if (seen.has(h.id)) return;
        seen.add(h.id);
        pts.push([h.lat, h.lng]);
        return;
      }
      const f = first.get(o.state + '/' + o.zipName);
      if (f && f.lat != null) {
        const id = 'zip:' + (o.drillholeName || o.zipName);
        if (seen.has(id)) return;
        seen.add(id);
        pts.push([f.lat, f.lng]);
      }
    });
    (k ? byFirstWord[r.state + '/' + k] || [] : []).forEach(function(h) {
      if (seen.has(h.id)) return;
      seen.add(h.id);
      pts.push([h.lat, h.lng]);
    });
    return pts;
  }
}

// Validation table: per class and state (and per class nationally), n
// validated, median and p95 distance in metres, and the verdict.
function validate(rows, results) {
  const groups = {};
  rows.forEach(function(r) {
    const res = results.get(r.state + '/' + r.zipName);
    if (!res || res.errM == null) return;
    (groups[res.cls + '/' + r.state] || (groups[res.cls + '/' + r.state] = [])).push(res.errM);
    (groups[res.cls + '/*'] || (groups[res.cls + '/*'] = [])).push(res.errM);
  });
  const table = {};
  Object.keys(groups).sort().forEach(function(k) {
    const d = groups[k];
    table[k] = { n: d.length, median_m: Math.round(median(d)), p95_m: Math.round(percentile(d, 0.95)),
      max_m: Math.round(Math.max.apply(null, d)) };
  });
  return table;
}

// Accepted for placement: p95 <= 5 km over at least MIN_VALIDATED rows of
// the class in the state; with fewer, the class's national verdict, except
// for an OWN_STATE_ONLY class, which is refused there.
function accepted(table, cls, state) {
  if (PLACED_CLASSES.indexOf(cls) === -1) return false;
  const own = table[cls + '/' + state];
  if (own && own.n >= MIN_VALIDATED) return own.p95_m <= ACCEPT_P95_M;
  if (OWN_STATE_ONLY.indexOf(cls) !== -1) return false;
  const all = table[cls + '/*'];
  if (all && all.n >= MIN_VALIDATED) return all.p95_m <= ACCEPT_P95_M && !(own && own.p95_m > ACCEPT_P95_M);
  return false;
}

// The record harvest.js reads: the table and, per class and state seen,
// the verdict.
function acceptance(table, rows, results) {
  const out = {};
  rows.forEach(function(r) {
    const res = results.get(r.state + '/' + r.zipName);
    if (!res || PLACED_CLASSES.indexOf(res.cls) === -1) return;
    out[res.cls + '/' + r.state] = accepted(table, res.cls, r.state);
  });
  Object.keys(STATE_BOX).forEach(function(state) {
    PLACED_CLASSES.forEach(function(cls) {
      const k = cls + '/' + state;
      if (!(k in out) && table[k]) out[k] = accepted(table, cls, state);
    });
  });
  const sorted = {};
  Object.keys(out).sort().forEach(function(k) { sorted[k] = out[k]; });
  return sorted;
}

// The fields a row records. A row never read for its position records
// nothing (no line of the cache changes until it is).
function rowFields(res) {
  if (res.cls === 'unread') return {};
  const f = { headerPosClass: res.cls };
  if (res.lat != null) {
    f.headerLat = Math.round(res.lat * 1e6) / 1e6;
    f.headerLng = Math.round(res.lng * 1e6) / 1e6;
  }
  if (res.zone) f.headerPosZone = res.zone;
  if (res.how) f.headerPosHow = res.how;
  return f;
}
const ROW_FIELDS = ['headerPosClass', 'headerLat', 'headerLng', 'headerPosZone', 'headerPosHow'];

// WFS holes from a harvest detail file: { state: [{ id, name, lat, lng,
// zips }] }, every archive name and twin each hole carries. THREDDS-only
// rows (provisional) are header positions, not collars, and are left out.
function holesFromDetail(lines) {
  const holes = {};
  lines.forEach(function(d) {
    if (!d || d.provisional || d.source === 'thredds' || d.seeded) return;
    if (!isFinite(d.lat) || !isFinite(d.lng)) return;
    const zips = [];
    (d.tsg || []).forEach(function(t) { zips.push(t.zip); (t.twins || []).forEach(function(z) { zips.push(z); }); });
    (holes[d.state] || (holes[d.state] = [])).push({ id: d.id, name: d.name, lat: d.lat, lng: d.lng, zips: zips });
  });
  return holes;
}

// ── CLI ───────────────────────────────────────────────────────────

function main() {
  const tsgEnrich = require('./tsg-enrich.js');
  const cache = tsgEnrich.loadCache(tsgEnrich.CACHE_PATH);
  if (!cache.size) { console.error('coords: no TSG cache at ' + tsgEnrich.CACHE_PATH); process.exit(1); }
  if (!fs.existsSync(DETAIL_FILE)) { console.error('coords: no harvest detail at ' + DETAIL_FILE); process.exit(1); }
  const detail = fs.readFileSync(DETAIL_FILE, 'utf8').split('\n').filter(function(l) { return l.trim(); })
    .map(function(l) { return JSON.parse(l); });
  const rows = Array.from(cache.values()).filter(function(r) { return !r.gone; });
  const results = classifyAll(rows, holesFromDetail(detail));
  const table = validate(rows, results);
  const acc = acceptance(table, rows, results);

  let changed = 0;
  rows.forEach(function(r) {
    const f = rowFields(results.get(r.state + '/' + r.zipName));
    const before = JSON.stringify(ROW_FIELDS.map(function(k) { return r[k]; }));
    ROW_FIELDS.forEach(function(k) { delete r[k]; });
    Object.assign(r, f);
    if (JSON.stringify(ROW_FIELDS.map(function(k) { return r[k]; })) !== before) changed++;
  });
  // Gone rows keep no position of their own.
  cache.forEach(function(r) { if (r.gone) ROW_FIELDS.forEach(function(k) { delete r[k]; }); });
  if (changed) tsgEnrich.saveCache(tsgEnrich.CACHE_PATH, cache);

  const counts = {};
  rows.forEach(function(r) {
    const res = results.get(r.state + '/' + r.zipName);
    const c = counts[r.state] || (counts[r.state] = {});
    const k = res.cls + (res.cls === 'mga_inferred' || res.cls === 'swapped' || res.cls === 'unresolved'
      ? ':' + res.how : '');
    c[k] = (c[k] || 0) + 1;
  });
  const doc = {
    generated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: 'scripts/nvcl/coords.js - TSG header lat lon against the WFS collar of the hole each archive joined',
    rule: 'a class/state pair is used for placement when the p95 distance to the WFS collar is at most '
      + ACCEPT_P95_M + ' m over at least ' + MIN_VALIDATED + ' validated rows; with fewer, the class\'s national verdict, except '
      + OWN_STATE_ONLY.join(', ') + ', which needs validated rows of its own state',
    classes_by_state: counts,
    validation: table,
    accepted: acc,
  };
  fs.writeFileSync(TABLE_FILE, JSON.stringify(doc, null, 1) + '\n');

  console.log('Header positions - ' + rows.length + ' live cache rows; ' + changed + ' row(s) changed');
  console.log('\nClasses by state:');
  Object.keys(counts).sort().forEach(function(s) {
    console.log('  ' + s + ': ' + Object.keys(counts[s]).sort().map(function(k) { return k + ' ' + counts[s][k]; }).join(', '));
  });
  console.log('\nValidation against WFS collars (class/state  n  median  p95  max  accepted):');
  Object.keys(table).forEach(function(k) {
    const t = table[k];
    const parts = k.split('/');
    const verdict = parts[1] === '*' ? '' : (acc[k] ? 'yes' : 'no');
    console.log('  ' + (k + '              ').slice(0, 24) + String(t.n).padStart(5) + String(t.median_m).padStart(9) + ' m'
      + String(t.p95_m).padStart(10) + ' m' + String(t.max_m).padStart(10) + ' m  ' + verdict);
  });
  console.log('\nWrote ' + TABLE_FILE);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('coords failed: ' + e.message); process.exit(1); }
}

module.exports = {
  STATE_BOX, STATE_ZONES, PLACED_CLASSES, OWN_STATE_ONLY, ACCEPT_P95_M,
  mgaToLatLng, distanceM, classify, classifyAll, validate, accepted, acceptance,
  rowFields, holesFromDetail, projectKey, zoneOf, TABLE_FILE,
};
