#!/usr/bin/env python3
"""
build_basemap.py

One-off builder for data/au_basemap.json, the self-hosted basemap that
NVCL_Map.html draws on a Leaflet canvas instead of loading third-party tiles.
The browser makes no third-party request for the basemap: it reads this file
same-origin, like every other data file in the repo.

Source (download it yourself, it is NOT committed):
  Australian Bureau of Statistics, Australian Statistical Geography Standard
  (ASGS) Edition 3, States and Territories 2021, shapefile, GDA2020.
  Licence CC BY 4.0.
  https://www.abs.gov.au/statistics/standards/australian-statistical-geography-standard-asgs/edition-3-july-2021-june-2026/access-and-downloads/digital-boundary-files/STE_2021_AUST_SHP_GDA2020.zip
  (The ABS server sends no Content-Length and may refuse non-browser
  User-Agents, although plain curl worked in October 2026. That build used a
  zip of 21,559,880 bytes, sha256
  d9b7f735de6085b37414faf011f796dda3c7f768c55e9dce01f96e790f399a21.)

Usage (from the repo root; the zip is read in place, no need to unzip):
  python3 -I scripts/build_basemap.py --zip /path/to/STE_2021_AUST_SHP_GDA2020.zip \\
      --out data/au_basemap.json [--tolerance 400]

Requires geopandas (pyogrio engine), shapely >= 2 and pyproj. These are NOT in
scripts/requirements.txt because no workflow runs this script.

What it does:
  1. Reads the shapefile and keeps the eight states and territories
     (STE_CODE21 1..8). "Other Territories" (9) and "Outside Australia" (Z)
     are dropped as features, with one exception: the mainland pieces of
     "Other Territories" that fall inside the map box (in practice only Jervis
     Bay Territory) are added to the land fill, otherwise the NSW south coast
     would show a sea-coloured notch. They never contribute borders.
  2. Repairs any invalid state geometry (make_valid), then clips everything
     to the map box (lon 112..154, lat -44..-9). This drops only the Lord
     Howe Island group (NSW, about 159 E), which lies outside the area the
     NVCL map is about.
  3. Reprojects to EPSG:3857 (Leaflet's projection) so the simplification
     tolerance is in on-screen metres. At maxZoom 9 near lat -30 one pixel
     is about 265 m.
  4. Builds two layers. Simplifying adjacent state polygons independently
     leaves hairline slivers between them, so instead:
       land    - the union of all states (coastline only, inland borders
                 dissolved), simplified with topology preserved, with
                 polygon parts under 3 km^2 of ground area dropped.
       borders - the inland state borders as lines: for each pair of states,
                 the intersection of their boundaries, merged and simplified
                 at the same tolerance. Includes the ACT boundary, contains
                 no coastline.
  5. Reprojects back to EPSG:4326, snaps coordinates to 4 decimal places
     (about 11 m) and applies the 3 km^2 islet cut again with geodesic areas
     (snapping can pinch off slivers).
  6. Rebuilds each land polygon from its exterior ring only, so the land
     has no holes. The ABS state polygons cover inland water, so any hole is
     a snapping artefact (for example the Brisbane River mouth closing at
     200 m).
  7. Writes a compact GeoJSON FeatureCollection with exactly two features,
     {"layer": "land"} and {"layer": "borders"}.

Tolerance candidates (October 2026 builds of the minified JSON; gzipped is
gzip -9 -n bytes):
  tolerance  islet cut      bytes    gzipped   land / border vertices
     40 m      1 km^2   3,725,069   921,811     176,993 / 11,203
     60 m      1 km^2   2,746,599   700,070     130,022 / 8,699
    100 m      1 km^2   1,852,057   489,152      87,328 / 6,163
    200 m      2 km^2   1,030,258   285,255      48,197 / 3,784
    400 m      3 km^2     568,464   164,887      26,524 / 2,123   <- default
At maxZoom 9 near lat -30 one pixel is about 265 m, so 400 m is about 1.5 px.

It exits 1 (and writes nothing) if any sanity check fails: 8 input states,
land inside the map box, exactly the 10 expected state-pair borders, total
border length 9,000 to 10,500 km (geodesic; the October 2026 builds
measured 9,384 km at 200 m and 9,199 km at 400 m), the ACT boundary present
in the borders, no coastline in the borders, valid land geometry, no empty
geometries.
"""

import argparse
import json
import math
import os
import sys
import time
from datetime import date

import geopandas as gpd
import shapely
from pyproj import Geod
from shapely.geometry import MultiLineString, MultiPolygon, Polygon, box, mapping

# ── Configuration ────────────────────────────────────────────
SHP_NAME = "STE_2021_AUST_GDA2020.shp"
STATE_CODES = ["1", "2", "3", "4", "5", "6", "7", "8"]   # NSW VIC QLD SA WA TAS NT ACT
ACT_CODE = "8"
OTHER_TERRITORIES_CODE = "9"

# Map box, lon/lat. The map itself fits to lon 112..154, lat -44..-10; -9
# keeps the northern Torres Strait islands (Boigu, Saibai) in.
MAP_BOX = (112.0, -44.0, 154.0, -9.0)

# Defaults chosen from the tolerance candidates table in the docstring.
DEFAULT_TOLERANCE_M = 400
MIN_PART_KM2 = 3.0             # drop islets smaller than this (ground area)
COORD_DECIMALS = 4             # about 11 m
BORDER_KM_RANGE = (9000, 10500)
MAX_COAST_IN_BORDERS_KM = 1.0

# Every land border in Australia, as STE_CODE21 pairs. A missing or extra
# pair means the boundary intersection went wrong.
EXPECTED_BORDERS = {
    ("1", "2"), ("1", "3"), ("1", "4"), ("1", "8"),   # NSW-VIC, NSW-QLD, NSW-SA, NSW-ACT
    ("2", "4"), ("3", "4"), ("3", "7"),               # VIC-SA, QLD-SA, QLD-NT
    ("4", "5"), ("4", "7"), ("5", "7"),               # SA-WA, SA-NT, WA-NT
}

EARTH_R = 6378137.0            # EPSG:3857 sphere radius
GEOD = Geod(ellps="GRS80")     # GDA2020 ellipsoid, for true areas and lengths

SOURCE = ("Australian Bureau of Statistics, Australian Statistical Geography "
          "Standard (ASGS) Edition 3, States and Territories 2021 (GDA2020), "
          "CC BY 4.0. Dissolved, simplified and clipped to the mainland map "
          "area by scripts/build_basemap.py")


def fail(msg):
    print(f"SANITY CHECK FAILED: {msg}", file=sys.stderr)
    sys.exit(1)


def ground_area_km2(poly_3857):
    """Ground area of a small polygon in EPSG:3857: Mercator area scaled by
    cos^2 of its latitude (cos(lat) = 1 / cosh(y / R) on the sphere)."""
    y = poly_3857.centroid.y
    scale = 1.0 / math.cosh(y / EARTH_R)
    return poly_3857.area * scale * scale / 1e6


def geodesic_km2(ring):
    return abs(GEOD.geometry_area_perimeter(Polygon(ring))[0]) / 1e6


def clean_land(geom_ll):
    """Drop lon/lat polygon parts under MIN_PART_KM2 (holes are filled next)."""
    return MultiPolygon([p for p in shapely.get_parts(geom_ll)
                         if p.geom_type == "Polygon" and geodesic_km2(p.exterior) >= MIN_PART_KM2])


def fill_holes(land_ll):
    """Rebuild each land polygon from its exterior ring only. The ABS state
    polygons cover inland water, so any hole is a snapping artefact (for
    example the Brisbane River mouth closing at 200 m)."""
    return MultiPolygon([Polygon(p.exterior) for p in land_ll.geoms])


def line_parts(geom):
    """The LineString parts of an overlay result (drops points)."""
    return [g for g in shapely.get_parts(geom)
            if g.geom_type == "LineString" and not g.is_empty]


def geojson(geom):
    return {"type": geom.geom_type, "coordinates": round_coords(mapping(geom)["coordinates"])}


def round_coords(obj):
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(v, COORD_DECIMALS) for v in obj]
        return [round_coords(o) for o in obj]
    return obj


def main():
    ap = argparse.ArgumentParser(description="Build data/au_basemap.json from the ABS STE 2021 shapefile.")
    ap.add_argument("--zip", required=True, help="path to STE_2021_AUST_SHP_GDA2020.zip")
    ap.add_argument("--out", required=True, help="output GeoJSON, e.g. data/au_basemap.json")
    ap.add_argument("--tolerance", type=float, default=DEFAULT_TOLERANCE_M,
                    help=f"simplification tolerance in EPSG:3857 metres (default {DEFAULT_TOLERANCE_M})")
    args = ap.parse_args()
    t0 = time.time()
    tol = args.tolerance

    # 1. Read and filter ------------------------------------------------
    src = f"/vsizip/{os.path.abspath(args.zip)}/{SHP_NAME}"
    gdf = gpd.read_file(src, engine="pyogrio")
    print(f"read {len(gdf)} features, CRS {gdf.crs}")
    for col in ("STE_CODE21", "STE_NAME21"):
        if col not in gdf.columns:
            fail(f"column {col} missing")

    states = gdf[gdf["STE_CODE21"].isin(STATE_CODES)].copy()
    if len(states) != 8 or sorted(states["STE_CODE21"]) != STATE_CODES:
        fail(f"expected the 8 states and territories, got {sorted(states['STE_CODE21'])}")
    if states.geometry.isna().any() or states.geometry.is_empty.any():
        fail("a state has empty geometry")
    print("states:", ", ".join(states["STE_NAME21"]))

    # Mainland pieces of "Other Territories" (Jervis Bay Territory) - land fill only.
    map_box = box(*MAP_BOX)
    other = gdf[gdf["STE_CODE21"] == OTHER_TERRITORIES_CODE].geometry.dropna()
    extra_land = [p for g in other for p in shapely.get_parts(g) if p.intersects(map_box)]
    print(f"Other Territories parts inside the map box (land fill only): {len(extra_land)}")

    # 2. Repair, then clip to the map box (drops Lord Howe Island) ---------
    # Repair first: an intersection on an invalid input can raise a GEOS
    # TopologyException or return a damaged result.
    invalid = ~states.geometry.is_valid
    if invalid.any():
        print(f"repairing {int(invalid.sum())} invalid state geometries")
        states.loc[invalid, "geometry"] = states.geometry[invalid].make_valid()
    states["geometry"] = states.geometry.intersection(map_box)
    extra = gpd.GeoSeries(extra_land, crs=gdf.crs).intersection(map_box)

    # 3. Reproject to Leaflet's EPSG:3857 --------------------------------
    states = states.to_crs(3857)
    extra = extra.to_crs(3857)
    codes = list(states["STE_CODE21"])
    geoms = list(states.geometry)

    # 4a. Land: union, simplify, drop islets ------------------------------
    t = time.time()
    land_raw = shapely.union_all(geoms + list(extra))
    holes = [r for p in shapely.get_parts(land_raw) for r in p.interiors]
    print(f"union: {len(shapely.get_parts(land_raw))} parts, {len(holes)} holes, "
          f"{shapely.get_num_coordinates(land_raw)} vertices ({time.time() - t:.1f} s)")
    land_s = shapely.simplify(land_raw, tol, preserve_topology=True)
    parts = [p for p in shapely.get_parts(land_s)
             if p.geom_type == "Polygon" and ground_area_km2(p) >= MIN_PART_KM2]
    land = MultiPolygon(parts)
    print(f"land: kept {len(parts)} of {len(shapely.get_parts(land_s))} parts >= {MIN_PART_KM2} km^2")

    # 4b. Borders: shared boundaries of each adjacent pair ----------------
    t = time.time()
    bounds = [shapely.boundary(g) for g in geoms]
    pieces, pairs = [], set()
    for i in range(len(geoms)):
        for j in range(i + 1, len(geoms)):
            if not geoms[i].intersects(geoms[j]):
                continue
            shared = line_parts(shapely.intersection(bounds[i], bounds[j]))
            if shared:
                pairs.add(tuple(sorted((codes[i], codes[j]))))
                pieces.extend(shared)
    if pairs != EXPECTED_BORDERS:
        fail(f"border pairs differ from expected: missing {sorted(EXPECTED_BORDERS - pairs)}, "
             f"extra {sorted(pairs - EXPECTED_BORDERS)}")
    borders_raw = shapely.line_merge(MultiLineString(pieces))
    raw_km = GEOD.geometry_length(
        gpd.GeoSeries([borders_raw], crs=3857).to_crs(4326).iloc[0]) / 1000
    print(f"borders: {len(pairs)} state pairs, {len(line_parts(borders_raw))} merged lines, "
          f"{raw_km:,.0f} km before simplification ({time.time() - t:.1f} s)")

    # The ACT ring must be in the borders.
    act_ring = bounds[codes.index(ACT_CODE)]
    act_cover = shapely.intersection(act_ring, borders_raw).length / act_ring.length
    if act_cover < 0.99:
        fail(f"ACT boundary only {act_cover:.1%} present in borders")
    # No coastline in the borders.
    coast_km = shapely.intersection(borders_raw, shapely.boundary(land_raw)).length / 1000
    if coast_km > MAX_COAST_IN_BORDERS_KM:
        fail(f"{coast_km:.1f} km of coastline found in the borders layer")
    print(f"checks: ACT boundary {act_cover:.1%} in borders, coastline in borders {coast_km:.3f} km")

    borders_s = shapely.simplify(borders_raw, tol, preserve_topology=True)
    borders = MultiLineString(line_parts(borders_s))

    # 5. Back to lon/lat, snap to 4 decimals ------------------------------
    out = gpd.GeoSeries([land, borders], crs=3857).to_crs(4326)
    grid = 10 ** -COORD_DECIMALS
    # set_precision keeps the result valid, but where an inlet or neck is
    # narrower than the grid it pinches off a sliver part or an enclosed
    # hole; apply the MIN_PART_KM2 rule again to the parts.
    land_ll = clean_land(shapely.set_precision(out.iloc[0], grid))
    borders_ll = shapely.set_precision(out.iloc[1], grid)
    if borders_ll.geom_type == "LineString":
        borders_ll = MultiLineString([borders_ll])

    # 6. Fill every hole in the land ---------------------------------------
    # The ABS state polygons cover inland water, so any hole is a snapping
    # artefact (for example the Brisbane River mouth closing at 200 m).
    n_holes = sum(len(p.interiors) for p in land_ll.geoms)
    land_ll = fill_holes(land_ll)
    print(f"land: filled {n_holes} holes")

    # Sanity checks -------------------------------------------------------
    for name, g in (("land", land_ll), ("borders", borders_ll)):
        if g.is_empty:
            fail(f"{name} is empty")
    if land_ll.geom_type != "MultiPolygon" or borders_ll.geom_type != "MultiLineString":
        fail(f"unexpected types {land_ll.geom_type} / {borders_ll.geom_type}")
    if not land_ll.is_valid:
        fail(f"land is invalid: {shapely.is_valid_reason(land_ll)}")
    minx, miny, maxx, maxy = land_ll.bounds
    if not (MAP_BOX[0] <= minx and maxx <= MAP_BOX[2] and MAP_BOX[1] <= miny and maxy <= MAP_BOX[3]):
        fail(f"land bbox {land_ll.bounds} outside {MAP_BOX}")
    border_km = GEOD.geometry_length(borders_ll) / 1000
    print(f"land bbox lon {minx:.3f}..{maxx:.3f} lat {miny:.3f}..{maxy:.3f}")
    print(f"total border length (geodesic): {border_km:,.0f} km")
    if not (BORDER_KM_RANGE[0] <= border_km <= BORDER_KM_RANGE[1]):
        fail(f"border length {border_km:,.0f} km outside {BORDER_KM_RANGE}")

    # 7. Write -------------------------------------------------------------
    fc = {
        "type": "FeatureCollection",
        "source": SOURCE,
        "generated": date.today().isoformat(),
        "features": [
            {"type": "Feature", "properties": {"layer": "land"}, "geometry": geojson(land_ll)},
            {"type": "Feature", "properties": {"layer": "borders"}, "geometry": geojson(borders_ll)},
        ],
    }
    text = json.dumps(fc, separators=(",", ":"))
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(text)

    print(f"tolerance {tol:g} m: land {shapely.get_num_coordinates(land_ll):,} vertices "
          f"in {len(shapely.get_parts(land_ll))} parts, borders "
          f"{shapely.get_num_coordinates(borders_ll):,} vertices, "
          f"{len(text.encode('utf-8')):,} bytes -> {args.out}")
    print(f"done in {time.time() - t0:.1f} s")


if __name__ == "__main__":
    main()
