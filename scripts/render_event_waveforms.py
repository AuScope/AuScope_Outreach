#!/usr/bin/env python3
"""
render_event_waveforms.py

For each qualifying Australian-region earthquake, renders ONE composite
"record section": the event's ground motion at the 5 nearest streaming AuSIS
(S1) stations that have data, stacked nearest-to-furthest on a shared time
axis so the wavefront is visibly later at more distant stations.

Selection (from data/earthquakes_24mo.geojson), two classes:
  - LOCAL: Australian region (GA inAU flag OR near-coast bbox),
    magnitude >= LOCAL_MIN_MAG. Nearby stations (<=1500 km), short window
    (origin-5 .. origin+15), 1 Hz high-pass — sharp regional arrival.
  - TELE : international, magnitude >= TELE_MIN_MAG. A big distant quake
    whose long-period surface waves reach Australia. No distance cap, long
    window (origin .. origin+60), 0.02-0.1 Hz band-pass. Threshold is high
    on purpose: below ~M6.5 a teleseism is not visible on a school sensor.
  - both: origin age between MIN_AGE_HOURS and MAX_AGE_DAYS.

Per event:
  - 10 nearest streaming stations are candidates (capped by mode)
  - ONE bulk FDSN request for the mode's window
  - keep the 5 closest that returned usable data (fall-through is implicit);
    skip the event if fewer than MIN_TRACES have data
  - response removed -> um/s, mode-appropriate filter, one PNG per event

Render-once: a manifest on the event-waveforms branch lists rendered event
ids. Only new qualifying events are fetched; revisions are NOT chased; events
that age past MAX_AGE_DAYS are pruned. Steady state does almost no work.

Output (./out/):  <event_id>.png  +  manifest.json
Published by .github/workflows/event_waveforms.yml to a flat, force-pushed
`event-waveforms` branch.
"""

import json
import math
import os
import re
import sys
import time
import traceback
from datetime import datetime, timezone, timedelta

import numpy as np

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import matplotlib.transforms as mtransforms

from obspy import UTCDateTime, Stream
from obspy.clients.fdsn import Client
from obspy.clients.fdsn.header import FDSNNoDataException
from obspy.geodetics import kilometer2degrees
from obspy.taup import TauPyModel

# ── Age window ───────────────────────────────────────────────
MIN_AGE_HOURS = 6
MAX_AGE_DAYS  = 30   # sections stay published for a month (render-once, so
                     # longer retention costs storage only, not compute)
# (At a 1 h floor, expect many events to be skipped for missing data — that
#  is data latency, not a bug. Bump MIN_AGE_HOURS to ~6–12 if
#  too few events have complete data to validate the renderer.)

# ── Selection ────────────────────────────────────────────────
STORE_PATH   = "data/earthquakes_24mo.geojson"

# Two classes of event get a record section:
#   LOCAL  — Australian region, magnitude >= LOCAL_MIN_MAG. Nearby school
#            stations, short window, 1 Hz high-pass (sharp regional arrival).
#   TELE   — anywhere else (international), magnitude >= TELE_MIN_MAG. A big
#            distant quake whose long-period surface waves reach Australia.
#            No distance cap, long window, long-period band-pass. Below ~M6.5
#            a teleseism is not visible on a school sensor, so the threshold
#            is high on purpose — do NOT lower it or sections become flat noise.
LOCAL_MIN_MAG = 3.0
TELE_MIN_MAG  = 6.5
# Generous continental + near-coast bounding box (pragmatic stand-in for a
# true 200 km-from-coastline buffer; combined with GA's regional focus this
# captures onshore + near-offshore events without a coastline dataset).
AU_BBOX      = {"minlat": -46.0, "maxlat": -8.0, "minlon": 110.0, "maxlon": 156.0}

# ── Window & stations (per mode) ─────────────────────────────
# LOCAL: origin-5 .. origin+15  (20-min window), stations within 1500 km,
#        1 Hz high-pass.
# TELE : origin .. origin+60    (surface waves arrive ~10-20 min later and
#        ring for many minutes), NO distance cap, 0.02-0.1 Hz band-pass.
LOCAL_PRE_MIN   = 5
LOCAL_POST_MIN  = 15
LOCAL_MAX_DIST  = 1500   # km cap for local events
LOCAL_HP_HZ     = 1.0    # high-pass corner — emphasises regional arrivals

# Local sections are TRIMMED after filtering to an adaptive view window:
# a little pre-origin context through predicted-S-at-the-farthest-lane plus
# a coda margin. Nearby quakes then fill the plot (visible moveout) instead
# of being squeezed into a sliver of the fixed 20-minute fetch window. The
# fetch stays wide so response removal / filter edge effects land outside
# the displayed part.
LOCAL_VIEW_PRE_S    = 60      # seconds of quiet shown before origin
LOCAL_VIEW_MIN_S    = 180     # never show less than this after origin
LOCAL_CODA_FACTOR   = 1.6     # view ends at S_farthest * this ...
LOCAL_CODA_PAD_S    = 60      # ... plus this pad

TELE_PRE_MIN    = 5      # pre-origin quiet is needed for the SNR count below
TELE_POST_MIN   = 60
TELE_MAX_DIST   = None   # no cap — the whole point is "even from far away"
TELE_BP_HZ      = (0.02, 0.1)  # long-period band-pass — teleseism surface waves

N_CANDIDATES = 10        # nearest streaming stations considered per event
N_KEEP       = 5         # stations drawn in the section
MIN_TRACES   = 2         # skip the event if fewer than this have data

NETWORK      = "S1"
CHANNEL_GLOB = "?HZ"
CHANNEL_PREF = ["BHZ", "HHZ", "EHZ", "SHZ"]
DATA_CENTRES = ["EARTHSCOPE"]

OUT_DIR      = "out"
CLIENT_TIMEOUT = 180
MAX_RETRIES    = 4
BACKOFF_BASE   = 15
BACKOFF_CAP    = 180

PLOT_W       = 7.0
ROW_H        = 0.95      # inches per station lane
PLOT_DPI     = 192       # 2x so sections stay sharp when the map is enlarged
BRAND        = "#282572"
ORIGIN_CLR   = "#b91c1c"
P_CLR        = "#2563eb"  # predicted P arrival — blue
S_CLR        = "#dc2626"  # predicted S arrival — red
LG_CLR       = "#6b7280"  # Lg / surface-wave arrival — grey

# The biggest shaking on Australian regional records is Lg (crust-guided
# shear energy, ~3.5 km/s), which always FOLLOWS direct S — without a mark
# it reads as "S is early". Teleseismic sections likewise peak at the
# surface waves (~4 km/s), minutes after S.
LG_KM_S      = 3.5
SURF_KM_S    = 4.0

# Bump to force re-render of already-published sections when the plot
# changes (manifest entries carry "v"; mismatches are treated as new).
RENDER_VERSION = 6

TRANSIENT = ("503", "service unavailable", "timed out", "timeout",
             "temporarily unavailable", "connection reset",
             "connection aborted", "502", "504", "bad gateway",
             "429", "too many requests")

# Event ids become filenames (out/<id>.png) — belt-and-braces guard on top of
# the same check in update_quakes.py, since the store is a committed file
# anyone could edit.
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]+$")


def short(exc):
    return str(exc).splitlines()[0][:140]


def is_transient(exc):
    m = str(exc).lower()
    return any(t in m for t in TRANSIENT)


def iso(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)
    except (ValueError, AttributeError):
        return None


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def make_client(name):
    return Client(name, timeout=CLIENT_TIMEOUT)


def retrying(label, call):
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            return call()
        except FDSNNoDataException:
            return None
        except Exception as exc:
            if attempt < MAX_RETRIES and is_transient(exc):
                wait = min(BACKOFF_CAP, BACKOFF_BASE * 2 ** (attempt - 1))
                print(f"  {label}: transient {attempt}/{MAX_RETRIES}, "
                      f"backing off {wait}s [{short(exc)}]")
                time.sleep(wait)
                continue
            print(f"  {label}: giving up ({short(exc)})")
            return None
    return None


def in_region(props, lat, lon):
    if props.get("inAU"):
        return True
    b = AU_BBOX
    return (b["minlat"] <= lat <= b["maxlat"]) and (b["minlon"] <= lon <= b["maxlon"])


def qualifying_events(now):
    """Return [(event_id, origin_dt, lat, lon, mag, place, mode)] where mode
    is 'local' (AU region, M>=LOCAL_MIN_MAG) or 'tele' (international,
    M>=TELE_MIN_MAG)."""
    if not os.path.exists(STORE_PATH):
        print(f"No quake store at {STORE_PATH}")
        return []
    with open(STORE_PATH) as fh:
        gj = json.load(fh)
    lo = now - timedelta(days=MAX_AGE_DAYS)
    hi = now - timedelta(hours=MIN_AGE_HOURS)
    out = []
    for f in gj.get("features", []):
        p = f.get("properties", {}) or {}
        g = f.get("geometry", {}) or {}
        c = g.get("coordinates") or []
        if len(c) < 2 or p.get("mag") is None or p.get("id") is None:
            continue
        if not SAFE_ID.match(str(p["id"])):
            continue
        try:
            mag = float(p["mag"])
        except (TypeError, ValueError):
            continue
        t = iso(p.get("time"))
        if t is None or not (lo <= t <= hi):
            continue
        lon, lat = c[0], c[1]
        if in_region(p, lat, lon):
            if mag < LOCAL_MIN_MAG:
                continue
            mode = "local"
        else:
            if mag < TELE_MIN_MAG:
                continue
            mode = "tele"
        try:
            depth = float(p.get("depth"))
        except (TypeError, ValueError):
            depth = None
        out.append((p["id"], t, lat, lon, mag,
                    p.get("place") or "Unknown location", mode, depth))
    return out


# ── Predicted P & S arrivals (iasp91) ────────────────────────
_TAUP = None

def ps_arrivals(dist_km, depth_km):
    """First predicted P and S arrival, in seconds after origin, or None.
    Uses TauP's wildcard phase groups so local (Pg/Pn) and teleseismic
    (P/PKP...) geometries both resolve without hand-picking phases."""
    global _TAUP
    try:
        if _TAUP is None:
            _TAUP = TauPyModel("iasp91")
        depth = min(700.0, max(0.0, depth_km if depth_km is not None else 10.0))
        arrs = _TAUP.get_travel_times(source_depth_in_km=depth,
                                      distance_in_degree=kilometer2degrees(dist_km),
                                      phase_list=["ttp", "tts"])
        p = min((a.time for a in arrs if a.name[0] in "Pp"), default=None)
        s = min((a.time for a in arrs if a.name[0] in "Ss"), default=None)
        return p, s
    except Exception as exc:
        print(f"  taup failed for {dist_km:.0f} km / {depth_km} km: {short(exc)}")
        return None, None


def clean_site_name(raw, code):
    """Return a tidy school name, or None if the metadata name is unusable."""
    if not raw:
        return None
    name = " ".join(str(raw).split()).strip()
    # Reject junk / non-descriptive site names so we fall back to the code.
    if len(name) < 3 or name.upper() == code.upper():
        return None
    low = name.lower()
    if low in ("n/a", "na", "unknown", "none", "-", "tbd", "test"):
        return None
    if len(name) > 42:                 # keep lane labels from overflowing
        name = name[:41].rstrip() + "…"
    return name


def load_inventory(client):
    """Station-level inventory for S1: code -> (lat, lon, site_name|None)."""
    inv = retrying("S1 stations", lambda: client.get_stations(
        network=NETWORK, channel=CHANNEL_GLOB, level="station"))
    sites = {}
    if inv is None:
        return sites
    for net in inv:
        for sta in net:
            site = None
            try:
                site = clean_site_name(
                    getattr(getattr(sta, "site", None), "name", None), sta.code)
            except Exception:
                site = None
            sites[sta.code] = (sta.latitude, sta.longitude, site)
    return sites


def pick_channel(channels):
    for pref in CHANNEL_PREF:
        if pref in channels:
            return pref
    return sorted(channels)[0] if channels else None


def count_recorded(st, origin, mode):
    """How many stations visibly recorded the event: robust post/pre amplitude
    ratio per station on mode-filtered raw counts (a ratio needs no physical
    units, so no response removal). Returns (recorded_codes, n_with_data).
    Outreach-grade signal detection, not a scientific pick."""
    o = UTCDateTime(origin)
    recorded, n_tot = [], 0
    for code in sorted(set(tr.stats.station for tr in st)):
        try:
            sub = st.select(station=code)
            cha = pick_channel(set(tr.stats.channel for tr in sub))
            if cha is None:
                continue
            merged = sub.select(channel=cha).merge(method=1, fill_value="latest")
            if not len(merged) or not len(merged[0].data):
                continue
            tr = merged[0].copy()
            tr.detrend("demean")
            if mode == "tele":
                tr.filter("bandpass", freqmin=TELE_BP_HZ[0],
                          freqmax=TELE_BP_HZ[1], corners=2, zerophase=True)
            else:
                tr.filter("highpass", freq=LOCAL_HP_HZ, corners=2, zerophase=True)
            noise = tr.slice(endtime=o - 10)
            sig = tr.slice(starttime=o + 10)
            if len(noise.data) < 100 or len(sig.data) < 100:
                continue
            # A local quake is ~30 s of signal in a 15-minute window, so a
            # whole-window percentile washes it out. Compare the LOUDEST
            # 10-second RMS after origin against the TYPICAL 10-second RMS
            # before it — catches brief packets, resists single-sample spikes.
            sr = tr.stats.sampling_rate

            def chunk_rms(data, secs=10.0):
                nsamp = max(1, int(sr * secs))
                m = len(data) // nsamp
                if m < 1:
                    return None
                a = np.asarray(data[:m * nsamp], dtype=np.float64).reshape(m, nsamp)
                return np.sqrt((a * a).mean(axis=1))

            nr = chunk_rms(noise.data)
            sg = chunk_rms(sig.data)
            if nr is None or sg is None:
                continue
            n_amp = float(np.median(nr))
            s_amp = float(sg.max())
            n_tot += 1
            if n_amp > 0 and s_amp / n_amp >= 4.0:
                recorded.append(code)
        except Exception:
            continue
    return recorded, n_tot


def process_event(client, resp_inv, sites, eid, origin, ev_lat, ev_lon,
                  mag, place, mode, depth):
    """Fetch nearest candidates, keep best N_KEEP with data, render section.
    `mode` is 'local' or 'tele' and selects distance cap / window / filter."""
    if mode == "tele":
        max_dist = TELE_MAX_DIST
        pre_min, post_min = TELE_PRE_MIN, TELE_POST_MIN
    else:
        max_dist = LOCAL_MAX_DIST
        pre_min, post_min = LOCAL_PRE_MIN, LOCAL_POST_MIN

    ranked = sorted(
        ((code, haversine_km(ev_lat, ev_lon, v[0], v[1]))
         for code, v in sites.items()),
        key=lambda x: x[1],
    )
    if max_dist is not None:
        ranked = [(c, d) for c, d in ranked if d <= max_dist]
    ranked = ranked[:N_CANDIDATES]
    if not ranked:
        print(f"  {eid}: no candidate stations")
        return None

    t1 = UTCDateTime(origin) - pre_min * 60
    t2 = UTCDateTime(origin) + post_min * 60
    # Fetch the WHOLE network, not just the drawn candidates: big quakes are
    # recorded by most of the fleet, and the "seen at N of M stations" count
    # (and each school's personal catch list) comes from this stream.
    bulk = [(NETWORK, code, "*", CHANNEL_GLOB, t1, t2) for code in sorted(sites)]
    st = retrying(f"{eid} waveforms",
                  lambda: client.get_waveforms_bulk(bulk))
    if not st or not len(st):
        print(f"  {eid}: no waveform data for any candidate")
        return None

    recorded_codes, n_with_data = count_recorded(st, origin, mode)
    print(f"  {eid}: visible at {len(recorded_codes)} of {n_with_data} stations with data")

    dist_by_code = dict(ranked)
    lanes = []
    for code, _ in ranked:
        sub = st.select(station=code)
        if not len(sub):
            continue
        chans = set(tr.stats.channel for tr in sub)
        cha = pick_channel(chans)
        if cha is None:
            continue
        merged = sub.select(channel=cha).merge(method=1, fill_value="latest")
        if not len(merged) or not len(merged[0].data):
            continue
        tr = merged[0]
        try:
            tr = tr.copy()
            tr.detrend("demean")
            tr.detrend("linear")
            tr.taper(0.05, type="hann")
            sr = tr.stats.sampling_rate
            tr.remove_response(inventory=resp_inv, output="VEL",
                               pre_filt=(0.005, 0.01, 0.45 * sr, 0.49 * sr),
                               water_level=60, zero_mean=True,
                               taper=False, plot=False)
            tr.data = tr.data * 1.0e6
            if mode == "tele":
                tr.filter("bandpass", freqmin=TELE_BP_HZ[0],
                          freqmax=TELE_BP_HZ[1], corners=4, zerophase=True)
            else:
                tr.filter("highpass", freq=LOCAL_HP_HZ, corners=4,
                          zerophase=True)
        except Exception as exc:
            print(f"  {eid}/{code}: response/filter failed ({short(exc)})")
            continue
        site_name = sites.get(code, (None, None, None))[2]
        lanes.append((code, dist_by_code[code], cha, tr, site_name))
        if len(lanes) >= N_KEEP:
            break

    if len(lanes) < MIN_TRACES:
        print(f"  {eid}: only {len(lanes)} usable trace(s) (<{MIN_TRACES}), skipped")
        return None

    lanes.sort(key=lambda x: x[1])  # nearest -> furthest

    # Tele fetch now starts 5 min early (for the SNR noise window) — keep the
    # displayed drum starting just before the origin line as before.
    if mode == "tele":
        w0 = UTCDateTime(origin) - 60
        for _, _, _, tr, _ in lanes:
            tr.trim(w0, t2)
        lanes = [l for l in lanes if len(l[3].data)]
        if len(lanes) < MIN_TRACES:
            print(f"  {eid}: <{MIN_TRACES} usable trace(s) after view trim, skipped")
            return None

    # Adaptive local view: trim to origin-context .. S-at-farthest + coda.
    # Done AFTER response removal/filtering so edge tapers stay off-screen.
    if mode == "local":
        far_km = lanes[-1][1]
        _, s_far = ps_arrivals(far_km, depth)
        if s_far is None:
            s_far = far_km / 3.0                     # ~crustal S speed fallback
        view_len = max(LOCAL_VIEW_MIN_S,
                       s_far * LOCAL_CODA_FACTOR + LOCAL_CODA_PAD_S)
        view_len = min(view_len, post_min * 60.0)    # never beyond the fetch
        w0 = UTCDateTime(origin) - LOCAL_VIEW_PRE_S
        w1 = UTCDateTime(origin) + view_len
        for _, _, _, tr, _ in lanes:
            tr.trim(w0, w1)
        lanes = [l for l in lanes if len(l[3].data)]
        if len(lanes) < MIN_TRACES:
            print(f"  {eid}: <{MIN_TRACES} usable trace(s) after view trim, skipped")
            return None
        print(f"  {eid}: view window {view_len:.0f}s "
              f"(farthest lane {far_km:.0f} km, S ~{s_far:.0f}s)")

    render_section(eid, origin, mag, place, lanes, mode, depth,
                    len(recorded_codes), n_with_data,
                    os.path.join(OUT_DIR, f"{eid}.png"))
    return {
        "event_id": eid,
        "origin": origin.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "mag": mag,
        "place": place,
        "mode": mode,
        "v": RENDER_VERSION,
        "depth": round(depth, 1) if depth is not None else None,
        "lat": round(ev_lat, 3),
        "lon": round(ev_lon, 3),
        "n_recorded": len(recorded_codes),
        "n_with_data": n_with_data,
        "recorded_codes": recorded_codes,
        "stations": [{"code": c, "dist_km": round(d), "channel": ch,
                       "site": nm}
                     for c, d, ch, _, nm in lanes],
    }


def render_section(eid, origin, mag, place, lanes, mode, depth,
                   n_rec, n_tot, out_path):
    n = len(lanes)
    fig, axes = plt.subplots(n, 1, figsize=(PLOT_W, ROW_H * n + 0.8),
                             sharex=True, squeeze=False)
    axes = axes[:, 0]
    o_mpl = mdates.date2num(origin)

    for ax, (code, dist, cha, tr, site) in zip(axes, lanes):
        ax.plot(tr.times("matplotlib"), tr.data, linewidth=0.5, color=BRAND)
        ax.axvline(o_mpl, color=ORIGIN_CLR, linewidth=1.0, alpha=0.8)
        ax.set_yticks([])
        # Tighten the trace into a central band so edge labels never overlap it
        ax.margins(x=0)
        peak = float(max(abs(tr.data.min()), abs(tr.data.max()))) or 1.0
        ax.set_ylim(-peak * 1.9, peak * 1.9)
        for sp in ("top", "right", "left"):
            ax.spines[sp].set_visible(False)
        ax.grid(True, axis="x", color="#e5e7eb", linewidth=0.5)
        # TOP edge: school name prominent; station code small/grey beneath.
        # White boxes behind the labels so dashed arrival lines can't cut
        # through the text. If metadata had no usable name, fall back to code.
        label_box = dict(facecolor="white", alpha=0.85, edgecolor="none",
                         boxstyle="square,pad=0.15")
        if site:
            ax.text(0.006, 0.96, site,
                    transform=ax.transAxes, va="top", ha="left",
                    fontsize=10.5, fontweight="bold", color="#282572",
                    bbox=label_box, zorder=5)
            ax.text(0.006, 0.70, f"S1.{code}",
                    transform=ax.transAxes, va="top", ha="left",
                    fontsize=8, color="#94a3b8", bbox=label_box, zorder=5)
        else:
            ax.text(0.006, 0.96, f"S1.{code}",
                    transform=ax.transAxes, va="top", ha="left",
                    fontsize=10.5, fontweight="bold", color="#282572",
                    bbox=label_box, zorder=5)
        # BOTTOM edge: distance
        ax.text(0.006, 0.06, f"{round(dist)} km",
                transform=ax.transAxes, va="bottom", ha="left",
                fontsize=9.5, color="#555")
        # Predicted P & S arrivals (iasp91) — the classroom moment: P beats
        # S to every station, and both get later with distance.
        p_sec, s_sec = ps_arrivals(dist, depth)
        if mode == "tele":
            big_sec, big_lbl = dist / SURF_KM_S, "Surf"
        else:
            big_sec, big_lbl = dist / LG_KM_S, "Lg"
        times_mpl = tr.times("matplotlib")
        x0, x1 = times_mpl[0], times_mpl[-1]
        lane_trans = mtransforms.blended_transform_factory(ax.transData, ax.transAxes)
        for t_sec, lbl, clr in ((p_sec, "P", P_CLR), (s_sec, "S", S_CLR),
                                 (big_sec, big_lbl, LG_CLR)):
            if t_sec is None:
                continue
            t_mpl = o_mpl + t_sec / 86400.0
            if not (x0 <= t_mpl <= x1):
                continue
            ax.axvline(t_mpl, color=clr, linewidth=0.9, alpha=0.85,
                       linestyle=(0, (4, 3)))
            # Label at the BOTTOM of the dash — the top is where the bold
            # school-name text lives and was masking P/S on some lanes.
            ax.text(t_mpl, 0.04, " " + lbl, transform=lane_trans,
                    va="bottom", ha="left", fontsize=8.5,
                    fontweight="bold", color=clr)

    axes[-1].xaxis_date()
    axes[-1].xaxis.set_major_formatter(mdates.DateFormatter("%H:%M"))
    axes[-1].tick_params(labelsize=8, length=2)
    seen = (f"seen at {n_rec}/{n_tot} stations · {n} shown"
            if n_rec and n_tot else f"{n} AuSIS stations")
    if mode == "tele":
        sub = (f"\n{seen} · red = origin · dashed: P, S, Surf"
               f" · {TELE_BP_HZ[0]:g}–{TELE_BP_HZ[1]:g} Hz (µm/s)")
    else:
        sub = (f"\n{seen} · red = origin · dashed: P, S, Lg"
               f" · {LOCAL_HP_HZ:g} Hz high-pass (µm/s)")
    axes[0].set_title(
        f"M{mag:.1f}  {place}  ·  {origin.strftime('%Y-%m-%d %H:%M:%S')} UTC"
        + sub,
        fontsize=9, color="#333", pad=8,
    )
    fig.tight_layout(pad=0.5)
    fig.savefig(out_path, dpi=PLOT_DPI, facecolor="white")
    plt.close(fig)


def load_manifest():
    path = os.path.join(OUT_DIR, "manifest.json")
    if not os.path.exists(path):
        return {}
    try:
        with open(path) as fh:
            m = json.load(fh)
        return {e["event_id"]: e for e in m.get("events", [])}
    except (json.JSONDecodeError, KeyError, OSError):
        return {}


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    now = datetime.now(timezone.utc)

    events = qualifying_events(now)
    n_local = sum(1 for e in events if e[6] == "local")
    n_tele = sum(1 for e in events if e[6] == "tele")
    print(f"{len(events)} event(s) qualify — {n_local} local "
          f"(AU, M>={LOCAL_MIN_MAG}), {n_tele} international "
          f"(M>={TELE_MIN_MAG}); age {MIN_AGE_HOURS}h–{MAX_AGE_DAYS}d")

    # Render-once: keep already-rendered events whose PNG still exists and
    # which still fall inside the age window; only fetch genuinely new ones.
    prev = load_manifest()
    qualifying_ids = {e[0] for e in events}
    # GA revises origins/depths after first publication; the P/S/Lg marks are
    # computed from them, so a kept section must still match the CURRENT
    # catalogue values or it gets re-rendered.
    current = {e[0]: (e[1].strftime("%Y-%m-%dT%H:%M:%SZ"),
                      round(e[7], 1) if e[7] is not None else None)
               for e in events}
    kept = {}
    for eid, meta in prev.items():
        if (eid in qualifying_ids
                and meta.get("v") == RENDER_VERSION
                and (meta.get("origin"), meta.get("depth")) == current.get(eid)
                and os.path.exists(os.path.join(OUT_DIR, f"{eid}.png"))):
            kept[eid] = meta
    todo = [e for e in events if e[0] not in kept]
    print(f"{len(kept)} already rendered & still valid, {len(todo)} new to render")

    rendered = dict(kept)
    if todo:
        try:
            client = make_client(DATA_CENTRES[0])
        except Exception as exc:
            print(f"FATAL: client init failed: {exc}")
            sys.exit(1)
        sites = load_inventory(client)
        if not sites:
            print("ERROR: could not load S1 station inventory; aborting.")
            sys.exit(1)
        resp_inv = retrying("S1 responses", lambda: client.get_stations(
            network=NETWORK, channel=CHANNEL_GLOB, level="response"))
        if resp_inv is None:
            print("ERROR: could not load S1 response metadata; aborting.")
            sys.exit(1)

        for eid, origin, lat, lon, mag, place, mode, depth in todo:
            try:
                rec = process_event(client, resp_inv, sites, eid,
                                     origin, lat, lon, mag, place, mode, depth)
                if rec:
                    rendered[eid] = rec
                    print(f"  {eid}: rendered [{mode}] "
                          f"({len(rec['stations'])} stations)")
            except Exception as exc:
                print(f"  {eid}: error ({short(exc)})")
                traceback.print_exc()

    # Prune PNGs for events no longer qualifying (aged out)
    for fn in os.listdir(OUT_DIR):
        if fn.endswith(".png"):
            eid = fn[:-4]
            if eid not in rendered:
                os.remove(os.path.join(OUT_DIR, fn))

    manifest = {
        "generated": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "selection": {
            "min_age_hours": MIN_AGE_HOURS,
            "max_age_days": MAX_AGE_DAYS,
            "local": {
                "min_mag": LOCAL_MIN_MAG,
                "window_min": [-LOCAL_PRE_MIN, LOCAL_POST_MIN],
                "max_dist_km": LOCAL_MAX_DIST,
                "filter": f"{LOCAL_HP_HZ:g} Hz high-pass",
            },
            "tele": {
                "min_mag": TELE_MIN_MAG,
                "window_min": [-TELE_PRE_MIN, TELE_POST_MIN],
                "max_dist_km": TELE_MAX_DIST,
                "filter": f"{TELE_BP_HZ[0]:g}-{TELE_BP_HZ[1]:g} Hz band-pass",
            },
        },
        "events": sorted(rendered.values(),
                         key=lambda e: e["origin"], reverse=True),
    }
    with open(os.path.join(OUT_DIR, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=2)

    print(f"Done: {len(rendered)} event section(s) in the store.")


if __name__ == "__main__":
    main()
