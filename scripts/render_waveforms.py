#!/usr/bin/env python3
"""
render_waveforms.py

Generates compact PNGs of the last hour of *ground velocity* (µm/s, with the
instrument response removed) for every streaming AuSIS (network S1) station,
in three views:

    <CODE>_raw.png      response-removed velocity, no filter
    <CODE>_local.png     1 Hz high-pass — enhances nearby (local) earthquakes
    <CODE>_distant.png   0.02–0.1 Hz band-pass — enhances distant teleseisms

Strategy: TWO bulk FDSN requests for the whole network — one POST for the
hour of waveforms (`S1 * * ?HZ`) and one for station responses (level=
response). No per-station network calls; everything else is local CPU.
Data comes from EarthScope (formerly IRIS), which carries S1.

Output (./out/):
    out/<CODE>_<variant>.png
    out/manifest.json   { generated, source, filters, stations: { CODE:
                          {channel, variants:[...], start, end} } }

Run hourly by .github/workflows/waveforms.yml.
"""

import json
import os
import sys
import time
import traceback
from collections import defaultdict
from datetime import datetime, timezone

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates

from obspy import UTCDateTime, Stream
from obspy.clients.fdsn import Client
from obspy.clients.fdsn.header import FDSNNoDataException

# ── Configuration ────────────────────────────────────────────
NETWORK        = "S1"
WINDOW_MINUTES = 60                              # length of trace to plot
CHANNEL_GLOB   = "?HZ"                           # vertical channels
CHANNEL_PREF   = ["BHZ", "HHZ", "EHZ", "SHZ"]    # which to keep, in order
OUT_DIR        = "out"

CLIENT_TIMEOUT = 180                             # seconds for a bulk request
MAX_RETRIES    = 5
BACKOFF_BASE   = 15                              # wait = BASE * 2**(n-1)
BACKOFF_CAP    = 240

# EarthScope (formerly "IRIS") carries S1. AusPass is the authoritative S1
# archive but its public endpoint has not reliably served this bulk request;
# to prefer it, prepend "AUSPASS" and confirm it returns data in the logs.
DATA_CENTRES   = ["EARTHSCOPE"]

# Filters applied AFTER response removal, so units stay µm/s.
LOCAL_HP_HZ    = 1.0                             # high-pass corner (local quakes)
DISTANT_BP_HZ  = (0.02, 0.1)                     # band-pass (distant teleseisms)
VARIANTS       = ["raw", "local", "distant"]

PLOT_W, PLOT_H = 5.0, 2.1                        # inches
PLOT_DPI       = 192                             # 2x (~960px wide) so the
                                                 # image stays sharp when the
                                                 # map is enlarged; downscales
                                                 # crisply in the small embed
BRAND          = "#282572"                       # AuScope purple

TRANSIENT = ("503", "service unavailable", "timed out", "timeout",
             "temporarily unavailable", "connection reset",
             "connection aborted", "502", "504", "bad gateway",
             "429", "too many requests")

# Stations that miss one flaky upstream hour keep their previous plot (the
# workflow restores the old branch contents into out/ first) — but only this
# long, so a genuinely silent station ages out rather than showing forever.
CARRY_HOURS = 6


def short(exc):
    return str(exc).splitlines()[0][:140]


def is_transient(exc):
    msg = str(exc).lower()
    return any(t in msg for t in TRANSIENT)


def make_client(name):
    return Client(name, timeout=CLIENT_TIMEOUT)


def _retrying(label, call):
    """Run `call()` with transient-error retry/backoff. Returns result or None."""
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            return call()
        except FDSNNoDataException:
            print(f"  {label}: no data")
            return None
        except Exception as exc:
            if attempt < MAX_RETRIES and is_transient(exc):
                wait = min(BACKOFF_CAP, BACKOFF_BASE * 2 ** (attempt - 1))
                print(f"  {label}: transient (attempt {attempt}/{MAX_RETRIES})"
                      f" — backing off {wait}s [{short(exc)}]")
                time.sleep(wait)
                continue
            print(f"  {label}: giving up ({short(exc)})")
            return None
    return None


def bulk_fetch(t1, t2):
    """
    Two bulk requests per data centre: the hour of waveforms and the station
    responses. Returns (Stream, Inventory, centre) or (None, None, None).
    """
    wf_bulk = [(NETWORK, "*", "*", CHANNEL_GLOB, t1, t2)]
    for centre in DATA_CENTRES:
        try:
            client = make_client(centre)
        except Exception as exc:
            print(f"  {centre}: client init failed ({short(exc)})")
            continue

        st = _retrying(f"{centre} waveforms",
                       lambda: client.get_waveforms_bulk(wf_bulk))
        if not st or not len(st):
            continue

        inv = _retrying(f"{centre} responses",
                        lambda: client.get_stations(
                            network=NETWORK, channel=CHANNEL_GLOB,
                            level="response", starttime=t1, endtime=t2))
        if inv is None:
            print(f"  {centre}: responses unavailable — cannot make µm/s plots")
            continue

        print(f"  {centre}: {len(st)} traces + response metadata OK")
        return st, inv, centre
    return None, None, None


def pick_channel(channels):
    for pref in CHANNEL_PREF:
        if pref in channels:
            return pref
    return sorted(channels)[0] if channels else None


def to_velocity_um(tr, inv):
    """Remove instrument response → ground velocity, scaled to µm/s."""
    tr = tr.copy()
    tr.detrend("demean")
    tr.detrend("linear")
    tr.taper(0.05, type="hann")
    sr = tr.stats.sampling_rate
    # Band-limit the deconvolution sensibly for the channel's sample rate
    pre_filt = (0.005, 0.01, 0.45 * sr, 0.49 * sr)
    tr.remove_response(inventory=inv, output="VEL",
                       pre_filt=pre_filt, water_level=60, zero_mean=True,
                       taper=False, plot=False)
    tr.data = tr.data * 1.0e6   # m/s → µm/s
    return tr


def apply_variant(vel_tr, variant):
    """Return a filtered copy of the µm/s velocity trace for a variant."""
    tr = vel_tr.copy()
    if variant == "local":
        tr.filter("highpass", freq=LOCAL_HP_HZ, corners=4, zerophase=True)
    elif variant == "distant":
        tr.filter("bandpass", freqmin=DISTANT_BP_HZ[0],
                  freqmax=DISTANT_BP_HZ[1], corners=4, zerophase=True)
    return tr


VARIANT_SUB = {
    "raw":     "ground velocity (no filter)",
    "local":   f"{LOCAL_HP_HZ:g} Hz high-pass — local earthquakes",
    "distant": f"{DISTANT_BP_HZ[0]:g}–{DISTANT_BP_HZ[1]:g} Hz band-pass — distant earthquakes",
}


def render(code, tr, cha, variant, t2, out_path):
    """Plot one µm/s trace as a clean, compact PNG with a labelled y-axis."""
    peak = float(max(abs(tr.data.min()), abs(tr.data.max()))) if len(tr.data) else 0.0

    fig, ax = plt.subplots(figsize=(PLOT_W, PLOT_H))
    ax.plot(tr.times("matplotlib"), tr.data, linewidth=0.45, color=BRAND)
    ax.xaxis_date()

    ax.set_title(
        f"S1.{code}..{cha}   {VARIANT_SUB[variant]}\n"
        f"last {WINDOW_MINUTES} min to {t2.strftime('%Y-%m-%d %H:%M')} UTC"
        f"   ·   peak {peak:.3g} µm/s",
        fontsize=7.5, color="#333", pad=4,
    )
    ax.set_ylabel("µm/s", fontsize=7.5, color="#333")
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M"))
    ax.tick_params(labelsize=7, length=2)
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    ax.margins(x=0)
    ax.grid(True, color="#e5e7eb", linewidth=0.5)
    fig.tight_layout(pad=0.4)
    fig.savefig(out_path, dpi=PLOT_DPI, facecolor="white")
    plt.close(fig)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    # Previous run's manifest (restored into out/ by the workflow) — used to
    # carry recent plots forward for stations that miss this hour.
    prev_stations = {}
    try:
        with open(os.path.join(OUT_DIR, "manifest.json")) as fh:
            prev_stations = json.load(fh).get("stations", {})
    except (OSError, ValueError):
        pass

    t2 = UTCDateTime()
    t1 = t2 - WINDOW_MINUTES * 60
    print(f"Window {t1} -> {t2}")

    try:
        st, inv, centre = bulk_fetch(t1, t2)
    except Exception as exc:
        print(f"FATAL: bulk request crashed: {exc}")
        traceback.print_exc()
        sys.exit(1)

    manifest = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "window_minutes": WINDOW_MINUTES,
        "source": centre or "none",
        "filters": {
            "raw": "none",
            "local": f"{LOCAL_HP_HZ:g} Hz high-pass",
            "distant": f"{DISTANT_BP_HZ[0]:g}-{DISTANT_BP_HZ[1]:g} Hz band-pass",
        },
        "stations": {},
    }

    if not st or not len(st):
        with open(os.path.join(OUT_DIR, "manifest.json"), "w") as fh:
            json.dump(manifest, fh, indent=2)
        print("ERROR: no waveforms returned.")
        sys.exit(1)

    by_station = defaultdict(lambda: defaultdict(Stream))
    for tr in st:
        by_station[tr.stats.station][tr.stats.channel] += tr

    ok = 0
    for code in sorted(by_station):
        try:
            channels = by_station[code]
            cha = pick_channel(set(channels.keys()))
            if cha is None:
                continue
            merged = channels[cha].merge(method=1, fill_value="latest")
            tr = merged[0]
            if not len(tr.data):
                print(f"  {code}: empty trace, skipped")
                continue

            vel = to_velocity_um(tr, inv)        # µm/s, response removed

            made = []
            for variant in VARIANTS:
                fname = f"{code}_{variant}.png"
                render(code, apply_variant(vel, variant), cha, variant, t2,
                       os.path.join(OUT_DIR, fname))
                made.append(variant)

            manifest["stations"][code] = {
                "channel": f"S1.{code}.{tr.stats.location or ''}.{cha}",
                "variants": made,
                "start": t1.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "end":   t2.strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
            ok += 1
            print(f"  {code}: OK ({cha}) — {', '.join(made)}")
        except Exception as exc:
            print(f"  {code}: skipped ({short(exc)})")

    # Carry forward previous plots for stations that returned nothing this
    # hour (their PNGs are already in out/ from the workflow's restore step),
    # capped at CARRY_HOURS. Anything older is pruned from out/ so a silent
    # station drops off rather than showing a stale plot indefinitely.
    carried = 0
    for code, entry in prev_stations.items():
        if code in manifest["stations"]:
            continue
        try:
            age_h = (t2 - UTCDateTime(entry.get("end"))) / 3600.0
        except Exception:
            age_h = None
        pngs_exist = all(os.path.exists(os.path.join(OUT_DIR, f"{code}_{v}.png"))
                         for v in entry.get("variants", []) or VARIANTS)
        if age_h is not None and 0 <= age_h <= CARRY_HOURS and pngs_exist:
            manifest["stations"][code] = dict(entry, carried=True)
            carried += 1
        else:
            for v in VARIANTS:
                path = os.path.join(OUT_DIR, f"{code}_{v}.png")
                if os.path.exists(path):
                    os.remove(path)
    if carried:
        print(f"Carried forward {carried} station(s) from the previous run "
              f"(within {CARRY_HOURS} h).")

    with open(os.path.join(OUT_DIR, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=2)

    # Diagnostics: which S1 stations EarthScope knows about (from the response
    # inventory we already fetched — no extra request) but that returned no
    # usable data this run. Turns "got N" into "got N of M, missing: ...".
    expected = set()
    try:
        for net in inv:
            for sta in net:
                expected.add(sta.code)
    except Exception:
        pass
    rendered_codes = set(manifest["stations"].keys())
    if expected:
        missing = sorted(expected - rendered_codes)
        print(f"Coverage: {len(rendered_codes)} rendered of "
              f"{len(expected)} S1 stations known to {centre}.")
        if missing:
            print(f"  no data this run ({len(missing)}): {', '.join(missing)}")
    else:
        print(f"Coverage: {len(rendered_codes)} rendered "
              f"(station inventory unavailable for a missing-list diff).")

    print(f"Done: {ok} stations rendered from {centre}.")
    if ok == 0:
        print("ERROR: data returned but nothing could be rendered.")
        sys.exit(1)


if __name__ == "__main__":
    main()
