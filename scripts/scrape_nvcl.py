#!/usr/bin/env python3
"""
NVCL Borehole Scraper
Fetches borehole locations from state WFS endpoints, then queries
NVCLDataServices for HyLogger instrument details per borehole.
Outputs GeoJSON per state + a stats JSON for funder reporting.

Usage:
    python3 scripts/scrape_nvcl.py          # Full scrape
    python3 scripts/scrape_nvcl.py --update # Only query new boreholes (uses cache)
"""

import json
import urllib.request
import urllib.parse
import datetime
import sys
import os
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed

# ── Configuration ─────────────────────────────────────────────────

STATES = {
    'sa':    {'wfs': 'https://sarigdata.pir.sa.gov.au/geoserver/ows',        'nvcl': 'https://sarigdata.pir.sa.gov.au/nvcl/NVCLDataServices',  'label': 'South Australia'},
    'wa':    {'wfs': 'https://geossdi.dmp.wa.gov.au/services/ows',           'nvcl': 'https://geossdi.dmp.wa.gov.au/NVCLDataServices',          'label': 'Western Australia'},
    'nsw':   {'wfs': 'https://gs.geoscience.nsw.gov.au/geoserver/ows',      'nvcl': 'https://nvcl.geoscience.nsw.gov.au/NVCLDataServices',     'label': 'New South Wales'},
    'qld':   {'wfs': 'https://geology.information.qld.gov.au/geoserver/ows', 'nvcl': 'https://geology.information.qld.gov.au/NVCLDataServices', 'label': 'Queensland'},
    'vic':   {'wfs': 'https://geology.data.vic.gov.au/nvcl/ows',            'nvcl': 'https://geology.data.vic.gov.au/NVCLDataServices',         'label': 'Victoria'},
    'tas':   {'wfs': 'https://www.mrt.tas.gov.au/web-services/ows',         'nvcl': 'https://www.mrt.tas.gov.au/NVCLDataServices',              'label': 'Tasmania'},
    'nt':    {'wfs': 'https://geology.data.nt.gov.au/geoserver/ows',        'nvcl': 'https://geology.data.nt.gov.au/NVCLDataServices',          'label': 'Northern Territory'},
    'csiro': {'wfs': 'https://nvclwebservices.csiro.au/geoserver/ows',      'nvcl': 'https://nvclwebservices.csiro.au/NVCLDataServices',         'label': 'CSIRO'},
}

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')
MAX_WORKERS = 8  # Concurrent dataset queries per state
TIMEOUT = 30
USER_AGENT = 'AuScope-Outreach/1.0 (https://github.com/bvkay/AuScope_Outreach)'


def urlopen_ua(url, timeout=TIMEOUT, method='GET', data=None, content_type=None):
    """Open URL with proper User-Agent (TAS blocks default Python UA)."""
    headers = {'User-Agent': USER_AGENT}
    if content_type:
        headers['Content-Type'] = content_type
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    return urllib.request.urlopen(req, timeout=timeout)

# ── WFS: Fetch borehole locations ─────────────────────────────────

def fetch_boreholes_wfs(state_id, config):
    """Fetch all NVCL boreholes from a state's WFS endpoint."""
    params = {
        'service': 'WFS',
        'version': '1.1.0',
        'request': 'GetFeature',
        'typename': 'gsmlp:BoreholeView',
        'outputFormat': 'json',
        'CQL_FILTER': "nvclCollection = 'true'",
    }

    url = config['wfs'] + '?' + urllib.parse.urlencode(params)
    boreholes = []

    try:
        resp = urlopen_ua(url, timeout=TIMEOUT * 2)
        data = json.loads(resp.read().decode('utf-8'))

        for f in data.get('features', []):
            props = f.get('properties', {})
            geom = f.get('geometry', {})
            coords = geom.get('coordinates', [0, 0])

            # Extract borehole ID (last segment of identifier URL)
            identifier = props.get('identifier', '')
            bh_id = identifier.rstrip('/').split('/')[-1] if identifier else ''
            if not bh_id:
                continue

            lng = coords[0] if len(coords) > 0 else 0
            lat = coords[1] if len(coords) > 1 else 0
            if lat == 0 and lng == 0:
                continue

            boreholes.append({
                'id': bh_id,
                'identifier': identifier,
                'name': props.get('name', bh_id),
                'lat': lat,
                'lng': lng,
                'elevation': props.get('elevation_m'),
                'boreholeLength': props.get('boreholeLength_m'),
                'custodian': props.get('boreholeMaterialCustodian', ''),
                'drillingMethod': props.get('drillingMethod', ''),
                'drillEndDate': props.get('drillEndDate', ''),
                'description': props.get('description', ''),
                'purpose': props.get('purpose', ''),
                'state': state_id.upper(),
            })

    except Exception as e:
        print(f'  WFS error for {state_id}: {e}')

    return boreholes


def fetch_boreholes_wfs_paged(state_id, config):
    """Fetch NVCL boreholes by paging through ALL boreholes and filtering locally.
    Required for NT where CQL filtering is disabled on GeoServer.
    Uses WFS v1.0.0 POST with form data (matching nvcl_kit approach)."""
    url = config['wfs']
    boreholes = []
    start_index = 0
    page_size = 10000

    try:
        while True:
            form_data = urllib.parse.urlencode({
                'service': 'WFS', 'version': '1.0.0', 'request': 'GetFeature',
                'typeName': 'gsmlp:BoreholeView', 'outputFormat': 'json',
                'maxFeatures': str(page_size), 'startIndex': str(start_index)
            }).encode('utf-8')

            resp = urlopen_ua(url, timeout=TIMEOUT * 4, data=form_data,
                              content_type='application/x-www-form-urlencoded')
            data = json.loads(resp.read().decode('utf-8'))
            features = data.get('features', [])

            if not features:
                break

            for f in features:
                props = f.get('properties', {})
                if props.get('nvclCollection') != 'true':
                    continue

                geom = f.get('geometry', {})
                coords = geom.get('coordinates', [0, 0])
                identifier = props.get('identifier', '')
                bh_id = identifier.rstrip('/').split('/')[-1] if identifier else ''
                if not bh_id:
                    continue

                lng = coords[0] if len(coords) > 0 else 0
                lat = coords[1] if len(coords) > 1 else 0
                if lat == 0 and lng == 0:
                    continue

                boreholes.append({
                    'id': bh_id,
                    'identifier': identifier,
                    'name': props.get('name', bh_id),
                    'lat': lat,
                    'lng': lng,
                    'elevation': props.get('elevation_m'),
                    'boreholeLength': props.get('boreholeLength_m'),
                    'custodian': props.get('boreholeMaterialCustodian', ''),
                    'drillingMethod': props.get('drillingMethod', ''),
                    'drillEndDate': props.get('drillEndDate', ''),
                    'description': props.get('description', ''),
                    'purpose': props.get('purpose', ''),
                    'state': state_id.upper(),
                })

            start_index += len(features)
            print(f'  Paged {start_index} boreholes, {len(boreholes)} NVCL found...')

            if len(features) < page_size:
                break

    except Exception as e:
        print(f'  WFS paged error for {state_id}: {e}')

    return boreholes


# ── NVCLDataServices: Fetch HyLogger details ──────────────────────

def fetch_dataset_info(bh_id, nvcl_base):
    """Query NVCLDataServices for a single borehole's dataset info."""
    url = f'{nvcl_base}/getDatasetCollection.html?holeidentifier={urllib.parse.quote(bh_id)}'

    try:
        resp = urlopen_ua(url)
        xml_str = resp.read().decode('utf-8')

        root = ET.fromstring(xml_str)
        datasets = root.findall('.//Dataset')
        if not datasets:
            return None

        # Use first dataset (primary scan)
        ds = datasets[0]
        desc_xml = ds.findtext('description', '')
        created = ds.findtext('createdDate', '')

        # Parse depth range
        depth_start = ds.findtext('.//DepthRange/start', '')
        depth_end = ds.findtext('.//DepthRange/end', '')

        # Parse embedded TSG metadata XML from description field
        instrument = ''
        scan_date = ''
        project = ''
        owner = ''

        if '<TSGDrillHoleMiscMeta' in desc_xml:
            # Unescape HTML entities in description
            desc_clean = desc_xml.replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&')
            try:
                meta = ET.fromstring(desc_clean)
                instrument = meta.findtext('InstrumentName', '') or ''
                scan_date = meta.findtext('DrillDate', '') or ''
                project = meta.findtext('Project', '') or ''
                owner = meta.findtext('Owner', '') or ''
            except ET.ParseError:
                pass

        # Clean up instrument name
        if instrument in ('', 'NA or Unknown', 'Unknown', 'NA'):
            instrument = None

        # Clean up scan date
        if scan_date:
            scan_date = scan_date.strip()
            if len(scan_date) > 10:
                scan_date = scan_date[:10]  # Keep just date part

        scanned_metres = None
        try:
            if depth_start and depth_end:
                scanned_metres = round(float(depth_end) - float(depth_start), 2)
        except (ValueError, TypeError):
            pass

        return {
            'instrument': instrument,
            'scanDate': scan_date if scan_date else None,
            'project': project if project else None,
            'owner': owner if owner else None,
            'scannedMetres': scanned_metres,
            'datasetCreated': created[:10] if created else None,
            'numDatasets': len(datasets),
        }

    except Exception:
        return None


def enrich_boreholes(boreholes, nvcl_base, state_id, cache=None):
    """Enrich boreholes with HyLogger details using concurrent requests."""
    total = len(boreholes)
    enriched = 0
    cached_hits = 0

    def process_bh(bh):
        nonlocal enriched, cached_hits
        bh_id = bh['id']

        # Check cache
        if cache and bh_id in cache:
            bh.update(cache[bh_id])
            cached_hits += 1
            return

        info = fetch_dataset_info(bh_id, nvcl_base)
        if info:
            bh.update(info)
            enriched += 1
        else:
            bh['instrument'] = None
            bh['scanDate'] = None
            bh['scannedMetres'] = None

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(process_bh, bh): bh for bh in boreholes}
        done = 0
        for future in as_completed(futures):
            done += 1
            if done % 50 == 0 or done == total:
                print(f'  {state_id}: {done}/{total} boreholes processed ({enriched} enriched, {cached_hits} cached)')
            future.result()

    return boreholes


# ── Output: GeoJSON + Stats ───────────────────────────────────────

def build_geojson(boreholes, state_id, state_label, fetched):
    """Build a GeoJSON FeatureCollection from enriched boreholes."""
    features = []
    for bh in boreholes:
        features.append({
            'type': 'Feature',
            'properties': {
                'name': bh['name'],
                'boreholeId': bh['id'],
                'boreholeLength': bh.get('boreholeLength'),
                'elevation': bh.get('elevation'),
                'custodian': bh.get('custodian', ''),
                'drillingMethod': bh.get('drillingMethod', ''),
                'drillEndDate': bh.get('drillEndDate', ''),
                'purpose': bh.get('description', '') or bh.get('purpose', ''),
                'instrument': bh.get('instrument'),
                'scanDate': bh.get('scanDate'),
                'scannedMetres': bh.get('scannedMetres'),
                'project': bh.get('project'),
                'owner': bh.get('owner'),
                'state': bh['state'],
            },
            'geometry': {
                'type': 'Point',
                'coordinates': [bh['lng'], bh['lat']]
            }
        })

    return {
        'type': 'FeatureCollection',
        'metadata': {
            'source': 'NVCL WFS + NVCLDataServices',
            'state': state_id,
            'stateLabel': state_label,
            'fetched': fetched,
        },
        'features': features
    }


def build_stats(all_boreholes, fetched):
    """Build comprehensive stats JSON for funder reporting."""

    # Monthly breakdown records
    monthly = {}  # key: (year-month, state, instrument) -> {boreholes, metres}

    # Aggregate counters
    by_state = {}
    by_instrument = {}
    total_boreholes = 0
    total_metres = 0
    total_scanned_metres = 0
    boreholes_with_data = 0

    for bh in all_boreholes:
        state = bh['state']
        instrument = bh.get('instrument') or 'Unknown'
        bh_length = bh.get('boreholeLength') or 0
        scanned = bh.get('scannedMetres') or 0
        scan_date = bh.get('scanDate') or ''

        total_boreholes += 1
        try:
            total_metres += float(bh_length)
        except (ValueError, TypeError):
            pass
        try:
            total_scanned_metres += float(scanned)
        except (ValueError, TypeError):
            pass

        if bh.get('instrument'):
            boreholes_with_data += 1

        # By state
        if state not in by_state:
            by_state[state] = {'boreholes': 0, 'boreholeLengthMetres': 0, 'scannedMetres': 0, 'withInstrumentData': 0}
        by_state[state]['boreholes'] += 1
        try:
            by_state[state]['boreholeLengthMetres'] += float(bh_length)
        except (ValueError, TypeError):
            pass
        try:
            by_state[state]['scannedMetres'] += float(scanned)
        except (ValueError, TypeError):
            pass
        if bh.get('instrument'):
            by_state[state]['withInstrumentData'] += 1

        # By instrument
        if instrument not in by_instrument:
            by_instrument[instrument] = {'boreholes': 0, 'scannedMetres': 0}
        by_instrument[instrument]['boreholes'] += 1
        try:
            by_instrument[instrument]['scannedMetres'] += float(scanned)
        except (ValueError, TypeError):
            pass

        # Monthly breakdown (by scan date)
        if scan_date and len(scan_date) >= 7:
            month_key = scan_date[:7]  # "YYYY-MM"
        elif bh.get('datasetCreated') and len(bh['datasetCreated']) >= 7:
            month_key = bh['datasetCreated'][:7]
        else:
            month_key = 'unknown'

        mk = (month_key, state, instrument)
        if mk not in monthly:
            monthly[mk] = {'boreholes': 0, 'scannedMetres': 0}
        monthly[mk]['boreholes'] += 1
        try:
            monthly[mk]['scannedMetres'] += float(scanned)
        except (ValueError, TypeError):
            pass

    # Sort and format monthly records
    monthly_records = []
    for (month, state, instrument), counts in sorted(monthly.items()):
        monthly_records.append({
            'month': month,
            'state': state,
            'instrument': instrument,
            'boreholes': counts['boreholes'],
            'scannedMetres': round(counts['scannedMetres'], 2),
        })

    # Round aggregates
    for v in by_state.values():
        v['boreholeLengthMetres'] = round(v['boreholeLengthMetres'], 2)
        v['scannedMetres'] = round(v['scannedMetres'], 2)
    for v in by_instrument.values():
        v['scannedMetres'] = round(v['scannedMetres'], 2)

    return {
        'generated': fetched,
        'summary': {
            'totalBoreholes': total_boreholes,
            'totalBoreholeLengthMetres': round(total_metres, 2),
            'totalBoreholeLengthKm': round(total_metres / 1000, 2),
            'totalScannedMetres': round(total_scanned_metres, 2),
            'totalScannedKm': round(total_scanned_metres / 1000, 2),
            'boreholesWithInstrumentData': boreholes_with_data,
        },
        'byState': dict(sorted(by_state.items())),
        'byInstrument': dict(sorted(by_instrument.items())),
        'monthly': monthly_records,
    }


# ── Cache management ──────────────────────────────────────────────

def load_cache(state_id):
    """Load previously scraped dataset info from existing GeoJSON."""
    filepath = os.path.join(DATA_DIR, f'nvcl_{state_id}.geojson')
    cache = {}
    if os.path.exists(filepath):
        with open(filepath, 'r') as f:
            data = json.load(f)
        for feat in data.get('features', []):
            p = feat['properties']
            bh_id = p.get('boreholeId', '')
            if bh_id and p.get('instrument') is not None:
                cache[bh_id] = {
                    'instrument': p['instrument'],
                    'scanDate': p.get('scanDate'),
                    'scannedMetres': p.get('scannedMetres'),
                    'project': p.get('project'),
                    'owner': p.get('owner'),
                    'datasetCreated': None,
                    'numDatasets': None,
                }
    return cache


# ── Main ──────────────────────────────────────────────────────────

def main():
    use_cache = '--update' in sys.argv
    fetched = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')

    print(f'NVCL Borehole Scraper - {fetched}')
    print(f'Mode: {"update (using cache)" if use_cache else "full scrape"}')
    print()

    all_boreholes = []

    for state_id, config in STATES.items():
        print(f'[{state_id.upper()}] Fetching boreholes from WFS...')

        # NT needs paging through all boreholes (CQL disabled on their GeoServer)
        if state_id == 'nt':
            boreholes = fetch_boreholes_wfs_paged(state_id, config)
        else:
            boreholes = fetch_boreholes_wfs(state_id, config)

        print(f'  Found {len(boreholes)} NVCL boreholes')

        if not boreholes:
            continue

        # Load cache if updating
        cache = load_cache(state_id) if use_cache else None
        if cache:
            print(f'  Cache: {len(cache)} previously enriched boreholes')

        # Enrich with HyLogger details
        print(f'  Querying NVCLDataServices for HyLogger details...')
        enrich_boreholes(boreholes, config['nvcl'], state_id.upper(), cache)

        with_data = sum(1 for bh in boreholes if bh.get('instrument'))
        print(f'  Result: {with_data}/{len(boreholes)} have instrument data')

        # Write GeoJSON
        geojson = build_geojson(boreholes, state_id, config['label'], fetched)
        filepath = os.path.join(DATA_DIR, f'nvcl_{state_id}.geojson')
        with open(filepath, 'w') as f:
            json.dump(geojson, f, indent=2)
        print(f'  Saved {filepath}')

        all_boreholes.extend(boreholes)
        print()

    # Build stats
    print('Generating statistics...')
    stats = build_stats(all_boreholes, fetched)
    stats_path = os.path.join(DATA_DIR, 'nvcl_stats.json')
    with open(stats_path, 'w') as f:
        json.dump(stats, f, indent=2)
    print(f'Saved {stats_path}')

    # Print summary
    s = stats['summary']
    print()
    print(f'=== SUMMARY ===')
    print(f'Total boreholes:     {s["totalBoreholes"]}')
    print(f'Borehole length:     {s["totalBoreholeLengthKm"]} km')
    print(f'Scanned length:      {s["totalScannedKm"]} km')
    print(f'With instrument data: {s["boreholesWithInstrumentData"]}')
    print()
    print('By state:')
    for state, data in stats['byState'].items():
        print(f'  {state}: {data["boreholes"]} boreholes, {data["boreholeLengthMetres"]/1000:.1f} km total, {data["scannedMetres"]/1000:.1f} km scanned')
    print()
    print('By instrument:')
    for inst, data in sorted(stats['byInstrument'].items(), key=lambda x: -x[1]['boreholes']):
        print(f'  {inst}: {data["boreholes"]} boreholes, {data["scannedMetres"]/1000:.1f} km scanned')


if __name__ == '__main__':
    main()
