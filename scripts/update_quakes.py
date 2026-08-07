#!/usr/bin/env python3
"""
update_quakes.py

Maintains a 24-month rolling earthquake catalogue for the AuSIS map.

Each hour:
  1. Fetch Geoscience Australia's pre-built recent-earthquakes feed
     (https://earthquakes.ga.gov.au/cache/recent-earthquakes.json - a rolling
     ~7-day GeoJSON FeatureCollection, GA-authoritative).
  2. Normalise each event to a small, source-agnostic shape.
  3. MERGE into data/earthquakes_24mo.geojson keyed by event_id, keeping the
     most-recently-modified version of each quake (GA revises magnitude /
     depth / review status over time).
  4. Prune anything older than RETENTION_DAYS by origin time.
  5. Write the store back (committed to main by the workflow).

If GA fails AND there is no existing store to fall back on, USGS FDSN is used
as a one-off seed so the map is never empty. Normal hourly operation uses GA.

The browser never calls GA directly (CloudFront blocks non-app origins and
CORS is unverified) - it reads the committed store same-origin.
"""

import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone, timedelta

# ── Configuration ────────────────────────────────────────────
GA_URL   = "https://earthquakes.ga.gov.au/cache/recent-earthquakes.json"
USGS_URL = ("https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson"
            "&starttime={start}&minmagnitude=2.5"
            "&minlatitude=-48&maxlatitude=-5&minlongitude=108&maxlongitude=162"
            "&orderby=time&limit=500")

STORE_PATH     = "data/earthquakes_24mo.geojson"
RETENTION_DAYS = 730                 # ~24 months
GLOBAL_MIN_MAG = 4.5                 # keep global quakes only if at least this
TIMEOUT        = 60

# Event ids flow into filenames downstream (render_event_waveforms.py writes
# out/<id>.png) - reject anything that isn't a plain token at ingest.
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]+$")

# Mimic the GA web app so CloudFront doesn't 403 a "non-app" request.
HEADERS = {
    "User-Agent": "Mozilla/5.0 (AuScope AuSIS map data updater; +https://www.auscope.org.au/ausis)",
    "Referer": "https://earthquakes.ga.gov.au/",
    "Accept": "application/json",
}


def http_json(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))


def iso(s):
    """Parse an ISO timestamp to aware UTC datetime, or None."""
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)
    except (ValueError, AttributeError):
        return None


def feature(geom_lon, geom_lat, props):
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [geom_lon, geom_lat]},
        "properties": props,
    }


def normalise_ga(gj):
    """GA recent-earthquakes.json → list of normalised features."""
    out = []
    for f in gj.get("features", []):
        p = f.get("properties", {}) or {}
        g = f.get("geometry", {}) or {}
        coords = g.get("coordinates") or []
        if len(coords) < 2:
            continue
        eid = p.get("event_id")
        if not eid or not SAFE_ID.match(str(eid)):
            continue
        mag = p.get("preferred_magnitude")
        if mag is None:
            mag = p.get("mw") or p.get("mb") or p.get("ms") or p.get("md")
        in_au = str(p.get("located_in_australia", "")).upper() == "Y"
        out.append(feature(coords[0], coords[1], {
            "id": eid,
            "mag": mag,
            "magType": p.get("preferred_magnitude_type"),
            "place": p.get("description") or "Unknown location",
            "time": p.get("origin_time") or p.get("epicentral_time"),
            "depth": p.get("depth"),
            "inAU": in_au,
            "source": p.get("source") or "GA",
            "modified": p.get("event_modification_time")
                        or p.get("event_creation_time")
                        or p.get("origin_time"),
        }))
    return out


def normalise_usgs(gj):
    """USGS FDSN GeoJSON → list of normalised features (fallback seed only)."""
    out = []
    for f in gj.get("features", []):
        p = f.get("properties", {}) or {}
        g = f.get("geometry", {}) or {}
        coords = g.get("coordinates") or []
        if len(coords) < 2 or p.get("mag") is None:
            continue
        eid = f.get("id")
        if not eid or not SAFE_ID.match(str(eid)):
            continue
        t = p.get("time")
        tiso = (datetime.fromtimestamp(t / 1000, timezone.utc).isoformat()
                if isinstance(t, (int, float)) else None)
        m = p.get("updated")
        miso = (datetime.fromtimestamp(m / 1000, timezone.utc).isoformat()
                if isinstance(m, (int, float)) else tiso)
        lat = coords[1]
        lon = coords[0]
        in_au = (-48 <= lat <= -5) and (108 <= lon <= 162)
        out.append(feature(lon, lat, {
            "id": eid,
            "mag": p.get("mag"),
            "magType": p.get("magType"),
            "place": p.get("place") or "Unknown location",
            "time": tiso,
            "depth": coords[2] if len(coords) > 2 else None,
            "inAU": in_au,
            "source": "USGS",
            "modified": miso,
        }))
    return out


def keep(feat):
    """Region/magnitude policy: Australian events, or global M >= threshold."""
    p = feat["properties"]
    if p.get("mag") is None or not p.get("time"):
        return False
    if p.get("inAU"):
        return True
    try:
        return float(p["mag"]) >= GLOBAL_MIN_MAG
    except (TypeError, ValueError):
        return False


def load_store():
    if not os.path.exists(STORE_PATH):
        return {}
    try:
        with open(STORE_PATH) as fh:
            gj = json.load(fh)
        return {f["properties"]["id"]: f
                for f in gj.get("features", [])
                if f.get("properties", {}).get("id")}
    except (json.JSONDecodeError, KeyError, OSError) as exc:
        # An existing-but-unreadable store must NOT be silently replaced with
        # this week's feed - that would wipe up to 24 months of catalogue in
        # a green run. Fail visibly instead; git history holds the last good.
        print(f"ERROR: existing store unreadable ({exc}); refusing to overwrite it.")
        sys.exit(1)


def main():
    os.makedirs(os.path.dirname(STORE_PATH), exist_ok=True)
    store = load_store()
    print(f"Existing store: {len(store)} events")

    incoming, source = [], None
    try:
        incoming = normalise_ga(http_json(GA_URL))
        source = "GA"
        print(f"GA: {len(incoming)} events fetched")
    except Exception as exc:
        # ::warning:: surfaces on the run's summary page - a quiet GA outage
        # should be visible without reading logs line by line.
        print(f"::warning title=GA feed::GA fetch failed: {exc}")
        if not store:
            try:
                start = (datetime.now(timezone.utc)
                         - timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%S")
                incoming = normalise_usgs(http_json(USGS_URL.format(start=start)))
                source = "USGS (fallback seed)"
                print(f"USGS fallback: {len(incoming)} events fetched")
            except Exception as exc2:
                print(f"USGS fallback also failed: {exc2}")
        else:
            print("Keeping existing store unchanged this run.")

    # Merge by event id, keeping the most-recently-modified version
    added = updated = 0
    for f in incoming:
        if not keep(f):
            continue
        eid = f["properties"]["id"]
        cur = store.get(eid)
        if cur is None:
            store[eid] = f
            added += 1
        else:
            new_m = iso(f["properties"].get("modified"))
            old_m = iso(cur["properties"].get("modified"))
            if new_m and (old_m is None or new_m > old_m):
                store[eid] = f
                updated += 1

    # Prune older than retention window by origin time
    cutoff = datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)
    before = len(store)
    store = {eid: f for eid, f in store.items()
             if (iso(f["properties"].get("time")) or cutoff) >= cutoff}
    pruned = before - len(store)

    features = sorted(
        store.values(),
        key=lambda f: f["properties"].get("time") or "",
        reverse=True,
    )

    # Skip the write when the catalogue is unchanged. The 'generated' stamp
    # would otherwise differ every run, defeating the workflow's
    # commit-if-changed guard - hourly no-op commits, and a dead GA feed that
    # still looks "fresh". No commits during an outage is the honest signal.
    if os.path.exists(STORE_PATH):
        try:
            with open(STORE_PATH) as fh:
                if json.load(fh).get("features") == features:
                    print(f"No catalogue changes this run - leaving {STORE_PATH} untouched.")
                    return
        except (json.JSONDecodeError, OSError):
            pass  # unreadable now? fall through and rewrite it

    out = {
        "type": "FeatureCollection",
        "crs": {"type": "name",
                "properties": {"name": "urn:ogc:def:crs:EPSG::4326"}},
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": source or "unchanged",
        "retention_days": RETENTION_DAYS,
        "features": features,
    }
    with open(STORE_PATH, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))

    print(f"Merged: +{added} new, {updated} updated, -{pruned} pruned. "
          f"Store now {len(features)} events (source: {source or 'unchanged'}).")
    # Never hard-fail: a bad hour just leaves the store as-is for next run.


if __name__ == "__main__":
    main()
