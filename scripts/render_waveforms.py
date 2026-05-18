#!/usr/bin/env python3
"""
render_waveforms.py

Generates a compact PNG of the last hour of vertical ground motion for every
streaming AuSIS (network S1) station, using waveform data from AusPass
(the authoritative FDSN data centre for the S1 network).

Run hourly by .github/workflows/waveforms.yml. Output goes to ./out/:
    out/<STATION>.png       e.g. out/AUKUL.png
    out/manifest.json       { generated, stations: { CODE: {channel,start,end} } }

Stations with no data in the last hour are simply skipped (this naturally
filters to currently-streaming stations without needing a status file).

Why AusPass and not IRIS: S1 is an Australian network; its real-time data is
archived at AusPass. IRIS does not hold recent S1 waveforms, which is why the
IRIS timeseriesplot service returned HTTP 400 for last-hour requests.
"""

import json
import os
import sys
import time
import traceback
from datetime import datetime, timezone

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates

from obspy import UTCDateTime
from obspy.clients.fdsn import Client
from obspy.clients.fdsn.header import FDSNNoDataException

# ── Configuration ────────────────────────────────────────────
NETWORK        = "S1"
WINDOW_MINUTES = 60                       # length of trace to plot
CHANNEL_PREF   = ["BHZ", "HHZ"]           # preferred vertical channel (BHZ is lighter)
OUT_DIR        = "out"
REQUEST_PAUSE  = 1.0                      # seconds between stations (be polite to AusPass)
CLIENT_TIMEOUT = 40                       # seconds per request
PLOT_W, PLOT_H = 5.0, 2.1                 # inches
PLOT_DPI       = 96                       # ~480 x 200 px
BRAND          = "#282572"                # AuScope purple


def get_client():
    """ObsPy has 'AUSPASS' in its routing table (>=1.3); fall back to the URL."""
    try:
        return Client("AUSPASS", timeout=CLIENT_TIMEOUT)
    except Exception:
        return Client(base_url="http://auspass.edu.au", timeout=CLIENT_TIMEOUT)


def list_stations(client):
    """Return a list of S1 station codes that are currently open (no end date)."""
    inv = client.get_stations(network=NETWORK, level="station")
    codes = []
    now = UTCDateTime()
    for net in inv:
        for sta in net:
            # Keep stations whose operational epoch is still open
            if sta.end_date is None or sta.end_date > now:
                codes.append(sta.code)
    return sorted(set(codes))


def fetch_stream(client, code, t1, t2):
    """Try preferred channels in order; return (stream, channel_code) or (None, None)."""
    for cha in CHANNEL_PREF:
        try:
            st = client.get_waveforms(NETWORK, code, "*", cha, t1, t2)
            if len(st) and len(st[0].data):
                return st, cha
        except FDSNNoDataException:
            continue
        except Exception as exc:                       # network hiccup, keep trying
            print(f"  {code} {cha}: {exc}")
            continue
    return None, None


def render(code, st, cha, t1, t2, out_path):
    """Plot a single trace as a clean, compact PNG."""
    tr = st.merge(method=1, fill_value="latest")[0]
    tr.detrend("demean")

    fig, ax = plt.subplots(figsize=(PLOT_W, PLOT_H))
    # ObsPy returns matplotlib date numbers directly — no tz handling needed
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
    client = get_client()

    t2 = UTCDateTime()
    t1 = t2 - WINDOW_MINUTES * 60

    try:
        codes = list_stations(client)
    except Exception as exc:
        print(f"FATAL: could not list S1 stations: {exc}")
        traceback.print_exc()
        sys.exit(1)

    print(f"{len(codes)} S1 stations; window {t1} → {t2}")

    manifest = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "window_minutes": WINDOW_MINUTES,
        "stations": {},
    }

    ok = 0
    for code in codes:
        try:
            st, cha = fetch_stream(client, code, t1, t2)
            if st is None:
                print(f"  {code}: no data in last hour (skipped)")
            else:
                render(code, st, cha, t1, t2, os.path.join(OUT_DIR, f"{code}.png"))
                manifest["stations"][code] = {
                    "channel": f"S1.{code}..{cha}",
                    "start": t1.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "end":   t2.strftime("%Y-%m-%dT%H:%M:%SZ"),
                }
                ok += 1
                print(f"  {code}: OK ({cha})")
        except Exception as exc:
            print(f"  {code}: ERROR {exc}")
        time.sleep(REQUEST_PAUSE)

    with open(os.path.join(OUT_DIR, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=2)

    print(f"Done: {ok}/{len(codes)} stations rendered.")
    # Don't fail the workflow if a few stations are quiet; only fail if none worked.
    if ok == 0:
        print("WARNING: no waveforms rendered this run.")
        sys.exit(1)


if __name__ == "__main__":
    main()
