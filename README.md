# RadioDNS plugin for FM-DX Webserver

Adds a small tower icon in the bottom-left corner of the Frequency panel (same
placement technique as Highpoint's "Autotune" plugin button, opposite corner). It sits
there at all times, dimmed while nothing has been detected for the current
station, and lights up to full brightness and the theme's accent colour the
moment RadioDNS is found for the tuned PI/ECC/frequency. Click it to open a
popup with:

* **RadioDNS / SPI**: resolved FQDN, service name, description, logo (prefers
  the 320x240 size when the broadcaster publishes multiple), and badges for
  which of RadioEPG / RadioVIS / RadioTAG it publishes.
* **RadioVIS**: the broadcaster's live slideshow (image + text), updating in
  real time while the popup is open.
* **EPG**: clicking the "EPG" badge opens a second themed popup with a
  best-effort "Now / Next" programme schedule, parsed from the broadcaster's
  PI.xml feed.

## Installation

* Copy `RadioDNS.js` and the `RadioDNS` folder into your FM-DX Webserver's
  `plugins` folder.
* Restart the webserver.
* Log in to the Administrator Panel and enable the plugin.

## How it works

FM RadioDNS identifies a station by its RDS PI code plus ECC (Extended
Country Code, from RDS group 1A) and frequency. The webserver's own RDS
decoder already exposes `pi`, `ecc`, `country_name`/`country_iso` and the rest
of the RDS fields on the client (`window.parsedData`), so this plugin reads
those directly with no extra wiring.

When the tuned PI/frequency changes, the frontend asks the plugin's backend
(over the same `/data_plugins` relay used by other plugins) to do the actual
RadioDNS lookup, since that needs real DNS resolution and an HTTP fetch that
can't be done from the browser:

1. Build the FQDN `<freq>.<pi>.<gcc>.fm.radiodns.org` and follow its CNAME
   chain to the broadcaster's authoritative domain.
2. Look up `_radioepg._tcp`, `_radiovis._tcp` and `_radiotag._tcp` SRV records
   under that domain.
3. Fetch `/radiodns/spi/3.1/SI.xml` from the RadioEPG host and pull out the
   matching service's name, description, logo and `serviceIdentifier`.
4. If RDS group 1A hasn't been decoded yet (so ECC is missing), or a lookup
   otherwise comes back empty, keep quietly retrying in the background for as
   long as that station stays tuned in, backing off up to a 20s cadence,
   rather than giving up after a fixed number of tries.

A station that simply doesn't publish RadioDNS will fail step 1 quickly (no
CNAME record exists) and the icon just stays dimmed -- that's the expected,
common case.

### RadioVIS

If a `_radiovis._tcp` SRV record is found, opening the popup connects to it: a
small STOMP client over a plain TCP socket (port from the SRV record,
typically 61613), with a negotiated heartbeat to keep the connection alive.
The wire format turned out to be simple keyword-prefixed plain text rather
than XML -- `TEXT <text>` and `SHOW <mediaUri> [<hyperlinkUri>]` -- which the
backend parses directly. The connection is only open while the popup is open
and is torn down when it's closed or you retune.

### EPG

Each `<service>` in SI.xml declares a `<radiodns serviceIdentifier="..."/>`;
the schedule for that service is fetched from
`/radiodns/spi/3.1/<serviceIdentifier>/<YYYYMMDD>_PI.xml` and its
`<programme>` elements are matched against the current time (using each
programme's `<location><time time="..." duration="..."/>`) to work out
what's on now and what's next.

## Options

Open `plugins_configs/RadioDNS.json` (created on first run) to configure.
**The backend only reads this file at startup, so restart the webserver after
changing it:**

* `manualEcc`: force a 2-hex-digit ECC (e.g. `"e1"`) to be used whenever the
  tuner hasn't decoded RDS group 1A for a station. Leave `null` to only use
  the live-decoded ECC.
* `enableRadioVis`: set to `false` to disable RadioVIS connections entirely.
* `lookupTimeoutMs` / `cacheTtlMs`: tuning knobs for the HTTP fetch timeout
  and how long a lookup result is cached per PI/ECC/frequency.

## Known limitations

* RadioVIS's `SHOW` message parsing has been confirmed against a real
  broadcaster (BBC), but the exact wording/structure can still vary between
  broadcasters -- if a specific station's slideshow doesn't render, run the
  webserver with `--debug` and check the server console for the raw
  `RadioVIS message on .../image: ...` log line.
* The EPG "Now / Next" schedule is best-effort: the exact PI.xml
  `<time>`/`<duration>` attribute format couldn't be confirmed against a real
  example ahead of time, so parsing is defensive but may not work on every
  broadcaster's feed. It clearly reports when nothing could be parsed rather
  than showing wrong data.
* Some tuners/stations never send RDS group 1A, so ECC may stay undetected
  even for stations that do publish RadioDNS -- use `manualEcc` as a
  workaround if you mostly listen within one country.

v1.0.0
------
* Initial release: RadioDNS lookup, live RadioVIS slideshow, and best-effort
  EPG "Now / Next" schedule.
