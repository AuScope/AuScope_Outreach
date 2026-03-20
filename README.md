# AuScope Outreach Maps

Interactive maps for AuScope outreach programs, part of the [AuScope](https://www.auscope.org.au/) national research infrastructure funded by the Australian Government through NCRIS.

Hosted on GitHub Pages and embedded via iframe on the AuScope website.

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

### Features

- Satellite imagery base map (Esri World Imagery)
- Colour-coded triangle markers: green (streaming), yellow (offline), red (ended)
- Click a marker to see: school name, station code, recording dates, streaming status, coordinates, elevation
- Link to [IRIS Webicorder](https://www.iris.edu/app/station_monitor/) for actively streaming stations
- Search box to find stations by name or code
- Home button to reset the map view
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
| Seismometers in Schools (AuSIS) | Triangle (green) | Live from IRIS FDSN |
| Magnetometers in Schools | Diamond (purple) | `data/Magnetometers_in_Schools.txt` |
| EarthBank in the Classroom | Circle (blue) | `data/EarthBank_in_Schools.txt` |
| GPlates in Schools | Square (amber) | `data/GPlates_in_Schools.txt` (when available) |

### Features

- All AuSIS stations loaded live from IRIS (ended stations excluded)
- Static program data loaded from CSV files in `data/` folder
- Each program has a distinct icon shape and colour
- Click a marker to see the school name and program
- GPlates legend item auto-shows when its data file is present
- Search box, home button, zoom-scaling icons
- Header with AuScope branding, footer with centred legend

### Data File Format

Static data files use simple CSV with a header row:

```
Station Name, Latitude, Longitude
Dover High, -43.31065, 147.013058
```

To add a new program, create a CSV file in the `data/` folder and add a `fetchCSV()` call in the HTML.

---

## Folder Structure

```
Outreach/
  AuSIS_Map.html              # AuSIS station map (live IRIS data)
  AuScope_Outreach.html       # Combined outreach map
  assets/
    auscope-logo.png           # AuScope logo (white, for dark header)
  data/
    Magnetometers_in_Schools.txt
    EarthBank_in_Schools.txt
    GPlates_in_Schools.txt     # Add when coordinates available
```

## Tech Stack

- [Leaflet 1.9.4](https://leafletjs.com/) — map rendering
- [Esri ArcGIS](https://www.arcgis.com/) — satellite imagery and boundary labels
- Vanilla JavaScript — no build tools or frameworks