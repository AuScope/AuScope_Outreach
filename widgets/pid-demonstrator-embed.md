# Embedding the PID demonstrator on auscope.org.au

Page: `https://auscope.github.io/AuScope_Outreach/widgets/pid-demonstrator.html`
(served from the **org** repo `AuScope/AuScope_Outreach`; promote
`widgets/pid-demonstrator.html` and `widgets/australia-outline.json` there
from this dev repo first, as with the AuSIS/NVCL maps).

The page sizes itself: it measures its single `#embed-root` wrapper and
posts `{type: 'auscope-embed:height', height}` to the parent (debounced
50 ms). The listener below, on the Squarespace side, sets the iframe's
height from that message. Once the frame is sized to its content, its
in-page links ("See all instruments on the map", "Back to the instrument",
"Follow this instrument") post `{type: 'auscope-embed:scroll', top}` and the
same listener scrolls the host page, because a fragment jump inside a
content-sized frame has nothing to scroll. Without the listener the iframe
simply stays at its 900 px fallback height and scrolls inside itself, so
nothing breaks and the in-page links jump within the frame.

## 1. Code Block (on the page)

Add a **Code** block (not an Embed block), Mode = HTML, in a full-width
(12-column) row, and paste:

```html
<!--
  AuScope PID demonstrator embed. Paste into a Squarespace CODE block
  (not an Embed block), Mode = HTML, in a full-width (12-column) row.
  The script element below is also safe to paste, unchanged, into
  Settings > Advanced > Code Injection > FOOTER. That copy survives
  Ajax page loads. The window flag stops a second copy from registering twice.
-->
<iframe
  data-auscope-autoheight
  src="https://auscope.github.io/AuScope_Outreach/widgets/pid-demonstrator.html"
  title="AuScope magnetotelluric instruments: where each one has recorded, and the data and papers that came out of that work"
  loading="lazy"
  allow="fullscreen"
  width="100%"
  height="900"
  style="display:block;width:100%;height:900px;min-height:320px;border:0;background:transparent;">
</iframe>
<p style="margin:8px 0 0;font-size:13px;">
  <a href="https://auscope.github.io/AuScope_Outreach/widgets/pid-demonstrator.html" target="_blank" rel="noopener">Open the demonstrator full screen &#8599;</a>
</p>
<script>
(function () {
  if (window.__auscopeAutoHeight) return;          // already installed (Code Injection or another block)
  window.__auscopeAutoHeight = true;
  var ORIGIN = 'https://auscope.github.io';        // keep lowercase: event.origin is always lowercase
  var MIN = 320, MAX = 12000;                      // clamp stops a runaway child from growing the page forever
  window.addEventListener('message', function (e) {
    if (e.origin !== ORIGIN) return;
    var d = e.data;
    if (!d || (d.type !== 'auscope-embed:height' && d.type !== 'auscope-embed:scroll')) return;
    // Look the frame up per message rather than caching it, so a frame swapped in by Squarespace Ajax is still found.
    var frames = document.querySelectorAll('iframe[data-auscope-autoheight]');
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow !== e.source) continue;  // other auscope.github.io embeds on the site share this origin
      if (d.type === 'auscope-embed:height' && typeof d.height === 'number' && isFinite(d.height)) {
        frames[i].style.height = Math.min(MAX, Math.max(MIN, Math.ceil(d.height))) + 'px';
      } else if (d.type === 'auscope-embed:scroll' && typeof d.height !== 'number' && typeof d.top === 'number' && isFinite(d.top)) {
        // An in-page link inside the frame: jump the host page there, below the fixed phone bar.
        // Not smooth: the frame can grow above the target mid-scroll and the jump would land short.
        var bar = document.querySelector('.Mobile-bar--top');
        var off = 16 + (bar && getComputedStyle(bar).position === 'fixed' ? bar.getBoundingClientRect().height : 0);
        var y = window.pageYOffset + frames[i].getBoundingClientRect().top + Math.max(0, d.top) - off;
        window.scrollTo(0, Math.max(0, y));
      }
      return;
    }
  });
  // Ask frames that are already loaded to report again, in case this listener arrived after their first message.
  var frames = document.querySelectorAll('iframe[data-auscope-autoheight]');
  for (var i = 0; i < frames.length; i++) {
    try { frames[i].contentWindow.postMessage({ type: 'auscope-embed:hello' }, ORIGIN); } catch (err) {}
  }
})();
</script>
```

## 2. Footer listener (site-wide, required on auscope.org.au)

Squarespace's Ajax page loading can swap a page in without re-running a
Code Block's script. The site loads pages by Ajax, so a Code Block script
does not run when a visitor arrives from the site menu; only the footer
copy runs then. Pasting the same listener into
**Settings > Advanced > Code Injection > FOOTER** keeps auto-height working
after in-site navigation. It is safe to have both copies: the
`window.__auscopeAutoHeight` flag makes the second one a no-op, and
any later `iframe[data-auscope-autoheight]` on any page is handled too.

```html
<script>
(function () {
  if (window.__auscopeAutoHeight) return;          // already installed (Code Injection or another block)
  window.__auscopeAutoHeight = true;
  var ORIGIN = 'https://auscope.github.io';        // keep lowercase: event.origin is always lowercase
  var MIN = 320, MAX = 12000;                      // clamp stops a runaway child from growing the page forever
  window.addEventListener('message', function (e) {
    if (e.origin !== ORIGIN) return;
    var d = e.data;
    if (!d || (d.type !== 'auscope-embed:height' && d.type !== 'auscope-embed:scroll')) return;
    // Look the frame up per message rather than caching it, so a frame swapped in by Squarespace Ajax is still found.
    var frames = document.querySelectorAll('iframe[data-auscope-autoheight]');
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow !== e.source) continue;  // other auscope.github.io embeds on the site share this origin
      if (d.type === 'auscope-embed:height' && typeof d.height === 'number' && isFinite(d.height)) {
        frames[i].style.height = Math.min(MAX, Math.max(MIN, Math.ceil(d.height))) + 'px';
      } else if (d.type === 'auscope-embed:scroll' && typeof d.height !== 'number' && typeof d.top === 'number' && isFinite(d.top)) {
        // An in-page link inside the frame: jump the host page there, below the fixed phone bar.
        // Not smooth: the frame can grow above the target mid-scroll and the jump would land short.
        var bar = document.querySelector('.Mobile-bar--top');
        var off = 16 + (bar && getComputedStyle(bar).position === 'fixed' ? bar.getBoundingClientRect().height : 0);
        var y = window.pageYOffset + frames[i].getBoundingClientRect().top + Math.max(0, d.top) - off;
        window.scrollTo(0, Math.max(0, y));
      }
      return;
    }
  });
  // Ask frames that are already loaded to report again, in case this listener arrived after their first message.
  var frames = document.querySelectorAll('iframe[data-auscope-autoheight]');
  for (var i = 0; i < frames.length; i++) {
    try { frames[i].contentWindow.postMessage({ type: 'auscope-embed:hello' }, ORIGIN); } catch (err) {}
  }
})();
</script>
```

## Checks after pasting

- The iframe should grow to fit with no inner scrollbar. If it stays at
  900 px, the listener is not running: Squarespace only runs scripts in
  Code Blocks / Code Injection on plans that allow custom code, and not in
  some editor previews. Check on the live page, logged out. Also navigate
  to the page from the site menu, not only by loading it directly.
- Links in the demonstrator open in a new tab (doi.org and
  ausmt.auscope.org.au refuse to be framed). The three in-page section
  links should scroll the host page; if they do nothing, the listener is
  not running (same cause as a frame stuck at 900 px).
- Data: the page reads
  `https://bvkay.github.io/AuScope_doi_tracker/pid-demonstrator-data.json`
  (the `DATA_BASE` constant near the top of the page script) on load, and
  fetches `https://ausmt.auscope.org.au/data/build.json` for the footer's
  "newer AusMT release" note; if that fetch fails the note is omitted.

## Live browser calls - a deliberate exception to this repo's rule

This repo's standing rule is that **the browser never calls a third-party
API** (all upstream fetching happens in GitHub Actions). This page is the
documented exception, because the live calls *are* the demonstration: the
"Watch it resolve" feature shows a persistent identifier resolving, hop by
hop, from the visitor's own browser, with the measured time of each hop.
On every resolve the page calls, from the browser:

| hop | request | CORS |
|---|---|---|
| 1 | `https://doi.org/api/handles/<doi>?type=URL` | echoes the origin |
| 2 | `https://api.datacite.org/dois/<doi>` | echoes the origin |
| 3 | `DATA_BASE + pid-demonstrator-data.json` (our own index) | `*` |
| 4 | `https://ausmt.auscope.org.au/data/products/<survey>/<station>/station.json` | `*` |

The "Follow one instrument" feature also fetches
`https://api.datacite.org/dois/<dataset doi>` for its live citation count,
once per page view for each stop's collection DOIs (or its first dataset
when the stop has no collection); a failed lookup is asked again the next
time that stop is drawn. No request goes to the CKAN registry
(`pidinst.data.auscope.org.au`), which sends no CORS headers; the PIDINST
detail comes from the DataCite record instead.

Every call has a failure state the visitor can read (the card shows the
error in muted type and no latency), except the footer's `build.json`
staleness check, which fails silently: the "newer AusMT release" note is
simply omitted. Nothing on the page is fabricated when a service is down,
and the deployment data itself still comes from the pre-built feed. If any of these hosts ever redirects without CORS (the
EarthScope case that motivated the rule), the affected hop degrades to its
error state and the rest of the page is unaffected.
