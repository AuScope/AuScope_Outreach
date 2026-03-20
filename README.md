# AuSIS Map — Australian Seismometers In Schools

Interactive map displaying all station locations from the **AuSIS** (Australian Seismometers In Schools) program, part of [AuScope](https://www.auscope.org.au/).

## Data Source

Station metadata is fetched live from the [AusPass FDSN Station Service](https://auspass.edu.au):

```
https://auspass.edu.au/fdsnws/station/1/query?network=S1&level=station&format=text
```

- **FDSN Network Code:** S1
- **Network DOI:** [10.7914/SN/S1](https://doi.org/10.7914/SN/S1)

## Features

- Satellite imagery base map (Esri World Imagery)
- Triangle markers for each seismometer station
- Click a marker to see: school name, station code, recording start date, status, coordinates, elevation, and a link to the [IRIS Webicorder](https://www.iris.edu/app/station_monitor/) helicorder view
- Search box to find stations by name or code
- Home button to reset the map view
- Marker icons scale with zoom level

## Embedding

The map is designed to be embedded via iframe on the AuScope website:

```html
<iframe src="https://<your-github-pages-url>/AuSIS_Map.html"
        width="100%" height="500" frameborder="0"
        style="border:0;" allowfullscreen>
</iframe>
```

Hosted on GitHub Pages to avoid Squarespace AJAX navigation issues that prevent scripts from re-executing on page transitions.

## Tech Stack

- [Leaflet 1.9.4](https://leafletjs.com/) — map rendering
- [Esri ArcGIS](https://www.arcgis.com/) — satellite imagery and boundary labels
- Vanilla JavaScript — no build tools or frameworks


```

## License

Data provided by AusPass under the FDSN network S1. Map tiles courtesy of Esri.
