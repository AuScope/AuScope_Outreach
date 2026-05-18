#!/usr/bin/env python3
"""
render_waveforms.py

Generates a compact PNG of the last hour of vertical ground motion for every
streaming AuSIS (network S1) station.

Strategy: ONE bulk FDSN dataselect POST request for the whole network
(`S1 * * ?HZ <start> <end>`). Data comes from EarthScope, which carries the
S1 network.

Output (./out/):
    out/<STATION>.png       e.g. out/AUKUL.png
    out/manifest.json       { generated, stations: { CODE: {channel,start,end} } }

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
WINDOW_MINUTES = 60                       # length of trace to plot
CHANNEL_GLOB   = "?HZ"                    # vertical channels (BHZ, HHZ, EHZ, SHZ…)
CHANNEL_PREF   = ["BHZ", "HHZ", "EHZ", "SHZ"]  # which to keep, in order, per station
OUT_DIR        = "out"

# One big request — give it room, and retry the whole thing on 503/timeout
CLIENT_TIMEOUT = 180                      # seconds for the bulk POST
MAX_RETRIES    = 5                        # attempts for the single bulk request
BACKOFF_BASE   = 15                       # seconds; wait = BACKOFF_BASE * 2**(n-1)
BACKOFF_CAP    = 240                      # max single backoff wait (seconds)

# Data centre(s) to try, in order. EarthScope (formerly "IRIS") carries S1 and
# is what works in practice. AusPass is the authoritative S1 archive but its
# public endpoint has not reliably served this bulk request; if you want to
# prefer it, prepend "AUSPASS" here and confirm it returns data in the logs.
DATA_CENTRES   = ["EARTHSCOPE"]

PLOT_W, PLOT_H = 5.0, 2.1                 # inches
PLOT_DPI       = 96                       # ~480 x 200 px
BRAND          = "#282572"                # AuScope purple

TRANSIENT = ("503", "service unavailable", "timed out", "timeout",
             "temporarily unavailable", "connection reset",
             "connection aborted", "502", "504", "bad gateway")


def short(exc):
    return str(exc).splitlines()[0][:140]


def is_transient(exc):
    msg = str(exc).lower()
    return any(t in msg for t in TRANSIENT)


def make_client(name):
    return Client(name, timeout=CLIENT_TIMEOUT)


def bulk_fetch(t1, t2):
    """
    One wildcard bulk POST for the whole S1 network. Tries each data centre;
    within a centre, retries the single request on transient errors with
    exponential backoff. Returns (Stream, centre_name) or (None, None).
    """
    bulk = [(NETWORK, "*", "*", CHANNEL_GLOB, t1, t2)]
    for centre in DATA_CENTRES:
        try:
            client = make_client(centre)
        except Exception as exc:
            print(f"  {centre}: client init failed ({short(exc)})")
            continue

        for attempt in range(1, MAX_RETRIES + 1):
            try:
                st = client.get_waveforms_bulk(bulk)
                if len(st):
                    print(f"  {centre}: bulk OK — {len(st)} traces")
                    return st, centre
                print(f"  {centre}: bulk returned no data")
                break  # valid empty response → try next centre
            except FDSNNoDataException:
                print(f"  {centre}: no data for window")
                break
            except Exception as exc:
                if attempt < MAX_RETRIES and is_transient(exc):
                    wait = min(BACKOFF_CAP, BACKOFF_BASE * 2 ** (attempt - 1))
                    print(f"  {centre}: transient (attempt {attempt}/"
                          f"{MAX_RETRIES}) — backing off {wait}s [{short(exc)}]")
                    time.sleep(wait)
                    continue
                print(f"  {centre}: giving up ({short(exc)})")
                break
    return None, None


def pick_channel(channels):
    """Choose the best vertical channel code from those a station returned."""
    for pref in CHANNEL_PREF:
        if pref in channels:
            return pref
    return sorted(channels)[0] if channels else None


def render(code, tr, cha, t2, out_path):
    """Plot a single merged trace as a clean, compact PNG."""
    tr = tr.copy()
    tr.detrend("demean")

    fig, ax = plt.subplots(figsize=(PLOT_W, PLOT_H))
    ax.plot(tr.times("matplotlib"), tr.data, linewidth=0.45, color=BRAND)
    ax.xaxis_date()

    ax.set_title(
        f"S1.{code}..{cha}   last {WINDOW_MINUTES} min "
        f"(to {t2.strftime('%Y-%m-%d %H:%M')} UTC)",
        fontsize=8, color="#333", pad=4,
    )
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M"))
    ax.tick_params(labelsize=7, length=2)
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    ax.margins(x=0)
    ax.grid(True, axis="x", color="#e5e7eb", linewidth=0.5)
    ax.set_yticks([])
    fig.tight_layout(pad=0.4)
    fig.savefig(out_path, dpi=PLOT_DPI, facecolor="white")
    plt.close(fig)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    t2 = UTCDateTime()
    t1 = t2 - WINDOW_MINUTES * 60
    print(f"Window {t1} -> {t2}")

    try:
        st, centre = bulk_fetch(t1, t2)
    except Exception as exc:
        print(f"FATAL: bulk request crashed: {exc}")
        traceback.print_exc()
        sys.exit(1)

    manifest = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "window_minutes": WINDOW_MINUTES,
        "source": centre or "none",
        "stations": {},
    }

    if not st or not len(st):
        with open(os.path.join(OUT_DIR, "manifest.json"), "w") as fh:
            json.dump(manifest, fh, indent=2)
        print("ERROR: no waveforms returned from any data centre.")
        sys.exit(1)

    # Group the returned traces by station, then by channel
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
            render(code, tr, cha, t2, os.path.join(OUT_DIR, f"{code}.png"))
            manifest["stations"][code] = {
                "channel": f"S1.{code}.{tr.stats.location or ''}.{cha}",
                "start": t1.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "end":   t2.strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
            ok += 1
            print(f"  {code}: OK ({cha})")
        except Exception as exc:
            print(f"  {code}: render error {short(exc)}")

    with open(os.path.join(OUT_DIR, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=2)

    print(f"Done: {ok} stations rendered from {centre}.")
    if ok == 0:
        print("ERROR: data returned but nothing could be rendered.")
        sys.exit(1)


if __name__ == "__main__":
    main()
