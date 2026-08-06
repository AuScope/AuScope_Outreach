# AuScope Interactive Maps

Interactive maps for AuScope programs, part of the [AuScope](https://www.auscope.org.au/) national research infrastructure funded by the Australian Government through NCRIS.

Hosted on GitHub Pages and embedded via iframe on the AuScope website.

## Repository organisation

```
/                    Maps (AuSIS_Map.html, NVCL_Map.html, ...) - static, no build step
assets/              Images + vendor/ (pinned, self-hosted JS: seisplotjs, qrcode-generator;
                     nothing is loaded from a CDN at runtime)
data/                Committed data products - written by GitHub Actions, never hand-edited
scripts/             Pipeline Python - run by the scheduled workflows only
widgets/             Static, embeddable, URL-parameterised pages (see below)
.github/workflows/   Scheduled jobs; every one auto-files an issue on failure
```

Branches `waveforms` and `event-waveforms` are force-pushed flat by the hourly/3-hourly
render jobs (PNGs + manifest.json) and never accumulate history.

**Design rule: the browser never calls a third-party API** (exception: the live
webicorder, an optional page that degrades gracefully). All upstream fetching happens
server-side in Actions, where redirects and CORS changes can't break the pages.

### Widgets (`widgets/`)

| Page | Purpose |
|---|---|
| `latest_quake.html` | Card: newest earthquake with its AuSIS record section |
| `recent_quakes.html` | Card: 10 newest quakes, recency-coloured, deep-linking to the map |
| `top_wiggles.html` | Card: peak-ground-velocity leaderboard across schools |
| `station.html?code=X` | "My School" dashboard: live drum, catches, rank, health |
| `webicorder.html?code=X` | Live 24 h drum (IRIS-webicorder style), seconds-fresh via EarthScope dataselect |
| `poster.html?code=X` | Printable A4 classroom QR poster (QR generated in-browser) |
| `event.html?id=X` | Printable class worksheet for a recorded earthquake (S-P exercise) |
| `locate.html?id=X` | Pick P and S arrivals on real waveform samples, then triangulate the epicentre from three schools |
| `quakes3d.html` | 3D earthquake viewer: tilting Australia block + rotatable Ring of Fire globe |

All widgets read the same published data (same-origin `data/` + the render branches on
the AuScope org repo), take their subject from the query string, and are embeddable as
iframes (AuScope website, Google Sites) or used standalone.

### Live Maps

- [AuScope Interactive Map](https://bvkay.github.io/AuScope_Outreach/) - All programs combined with layer toggles
- [AuSIS Station Map](https://bvkay.github.io/AuScope_Outreach/AuSIS_Map.html) - Seismometers in Schools
- [AuScope Outreach Locations](https://bvkay.github.io/AuScope_Outreach/AuScope_Outreach.html) - Schools outreach programs
- [AuScope CoastRI Locations](https://bvkay.github.io/AuScope_Outreach/AuScope_CoastRI.html) - Coastal monitoring sites

---

## AuScope Interactive Map (`index.html`)

Combined map showing all AuScope programs with a categorised layer control panel.

### Features

- All programs from every map on a single page
- Collapsible **layers panel** in the toolbar with category headings (Outreach, CoastRI)
- Click a category heading to toggle all programs in that group
- Individual program checkboxes with icon, name, and site count
- Footer dynamically updates to show only visible layers
- Search across all visible sites
- Designed to scale - add new categories (Seismic, MT, Geochem, VLBI, etc.) by adding entries to the `CATEGORIES` config array

### Current Categories

| Category | Programs |
|----------|----------|
| **Outreach** | AuSIS, Magnetometers, EarthBank, GPlates |
| **CoastRI** | Camera Stations, Low-Cost Drones, Long-Range Drones |

---

## AuSIS Station Map (`AuSIS_Map.html`)

Interactive map of **AuSIS** (Australian Seismometers In Schools) stations.

### Data Source

Station metadata and availability are fetched **live** from [IRIS FDSN Web Services](https://service.iris.edu):

```
https://service.iris.edu/fdsnws/station/1/query?network=S1&level=station&format=text
https://service.iris.edu/fdsnws/availability/1/extent?network=S1&channel=BH?,HH?&format=text
```

- **FDSN Network Code:** S1
- **Network DOI:** [10.7914/SN/S1](https://doi.org/10.7914/SN/S1)

A local GeoJSON backup (`data/ausis_stations.geojson`) is loaded first for instant display. Live IRIS data refreshes in the background. If IRIS is unavailable, the backup data remains visible. The backup is updated daily via a GitHub Action.

### Features

- Satellite imagery base map (Esri World Imagery)
- Colour-coded triangle markers: green (streaming), yellow (offline), red (ended)
- Click a marker to see: school name, station code, recording dates, streaming status, coordinates, elevation
- Link to [IRIS Webicorder](https://www.iris.edu/app/station_monitor/) for actively streaming stations
- Search box to find stations by name or code
- Collapsible toolbar (three-dots toggle) with zoom and home controls
- Marker icons scale with zoom level
- Footer legend with live counts of active and streaming stations
- Header with AuScope branding

### Notes

- The `TEST` station is filtered out
- Availability checks both BH and HH channels (some stations like AUDAR only stream HH)
- A station is considered "streaming" if its latest data is within 7 days

---

## AuScope Outreach Locations (`AuScope_Outreach.html`)

Combined map showing all AuScope schools outreach programs.

### Programs

| Program | Icon | Data Source |
|---------|------|-------------|
| Seismometers in Schools (AuSIS) | Triangle (green) | Live from IRIS FDSN (backup: `data/ausis_stations.geojson`) |
| Magnetometers in Schools | Diamond (purple) | `data/magnetometers.geojson` |
| EarthBank in the Classroom | Circle (blue) | `data/earthbank.geojson` |
| GPlates in Schools | Square (amber) | `data/gplates.geojson` (when available) |

### Features

- AuSIS stations loaded from local backup instantly, refreshed with live IRIS data in background
- Static program data loaded from GeoJSON files in `data/` folder
- Each program has a distinct icon shape and colour
- Click a marker to see the school name and program
- GPlates legend item auto-shows when its data file is present
- Search box, collapsible toolbar, zoom-scaling icons
- Header with AuScope branding, footer with centred legend

---

## AuScope CoastRI Locations (`AuScope_CoastRI.html`)

Interactive map of AuScope-funded [CoastRI](https://coastri.org.au/) (Coastal Research Infrastructure) monitoring sites across Australia.

### Programs

| Program | Icon | Data Source |
|---------|------|-------------|
| Fixed Camera Stations | Triangle (red) | `data/coastri_cameras.geojson` |
| Low-Cost Drone Surveys | Diamond (green) | `data/coastri_lowcost_drones.geojson` |
| Long-Range Drones | Circle (blue) | `data/coastri_longrange_drones.geojson` |

### Data Source

CoastRI site data was extracted from the [CoastRI-Asset-Locations](https://github.com/RZitoun/CoastRI-Asset-Locations) repository (maintained by R. Zitoun). Only the three AuScope-funded layers were included:

- `AuScopefixedstation_7.js` - 4 fixed coastal camera stations
- `AuScopeLowCostDrones_8.js` - 59 low-cost drone survey sites
- `AuScopeLongRangeDrones_9.js` - 5 long-range drone sites

The original GeoJSON data (embedded in JS variables) was extracted, field names were cleaned and standardised, and the data was saved as standalone GeoJSON files.

### Features

- Satellite imagery base map (Esri World Imagery)
- Each program has a distinct icon shape and colour
- Click a marker to see: site name, state, status, sensor/airframe, purpose
- Search box to find sites by name
- Collapsible toolbar, zoom-scaling icons
- Header with AuScope branding, footer with centred legend and counts

---

## Data Format

All static data uses [GeoJSON](https://geojson.org/) FeatureCollection format:

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": { "name": "Site Name" },
      "geometry": { "type": "Point", "coordinates": [longitude, latitude] }
    }
  ]
}
```

To add a new program or data source, create a `.geojson` file in the `data/` folder and add a `fetchGeoJSON()` call in the relevant HTML file.

---

## Folder Structure

```
AuScope_Outreach/
  index.html                            # Combined map — all programs, layer toggles
  AuSIS_Map.html                        # AuSIS station map (live IRIS + local fallback)
  AuScope_Outreach.html                 # Schools outreach map (AuSIS, Mag, EarthBank, GPlates)
  AuScope_CoastRI.html                  # CoastRI coastal monitoring map
  assets/
    auscope-logo.png                    # AuScope logo (white, for dark header)
  data/
    ausis_stations.geojson              # AuSIS stations + availability (daily backup)
    magnetometers.geojson               # Magnetometers in Schools locations
    earthbank.geojson                   # EarthBank in the Classroom locations
    gplates.geojson                     # GPlates in Schools (add when available)
    coastri_cameras.geojson             # CoastRI fixed camera stations
    coastri_lowcost_drones.geojson      # CoastRI low-cost drone survey sites
    coastri_longrange_drones.geojson    # CoastRI long-range drone sites
  .github/workflows/
    ausis-backup.yml                    # Daily AuSIS station + availability backup
```

## Tech Stack

- [Leaflet 1.9.4](https://leafletjs.com/) - map rendering
- [Esri ArcGIS](https://www.arcgis.com/) - satellite imagery and boundary labels
- [GeoJSON](https://geojson.org/) - spatial data format
- [IRIS FDSN](https://service.iris.edu/) - live seismic station data
- Vanilla JavaScript - no build tools or frameworks
- GitHub Actions - automated daily AuSIS data backup
