# AuSIS Map — Australian Seismometers In Schools

Interactive map displaying all station locations from the **AuSIS** (Australian Seismometers In Schools) program, part of the [AuScope](https://www.auscope.org.au/) national research infrastructure, which is funded by the Australian Government through the National Collaborative Research Infrastructure Strategy.

## Data Source

Station metadata and data availability are fetched live from the [IRIS FDSN Web Services](https://service.iris.edu):

```
https://service.iris.edu/fdsnws/station/1/query?network=S1&level=station&format=text
https://service.iris.edu/fdsnws/availability/1/extent?network=S1&channel=BHZ&format=text
```

- **FDSN Network Code:** S1
- **Network DOI:** [10.7914/SN/S1](https://doi.org/10.7914/SN/S1)

## Features

- Satellite imagery base map (Esri World Imagery)
- Triangle markers for each seismometer station
- Click a marker to see: school name, station code, recording start date, streaming status, coordinates, elevation, and a link to the [IRIS Webicorder](https://www.iris.edu/app/station_monitor/) helicorder view
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

Data provided by IRIS/SAGE under the FDSN network S1. Map tiles courtesy of Esri.
