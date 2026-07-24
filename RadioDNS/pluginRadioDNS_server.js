/*
    RadioDNS v1.0.0
    Server-side: FM RadioDNS lookup (DNS + SPI/SI.xml) and a best-effort RadioVIS
    (live slideshow) relay, exposed to the frontend over the existing /data_plugins
    WebSocket relay.

    Spec references used to build this:
    - RadioDNS FM FQDN construction & DNS resolution: ETSI TS 103 270
    - Service and Programme Information (SI.xml): ETSI TS 102 818 v3.x, served at
      /radiodns/spi/3.1/SI.xml on the host discovered via the resolved FQDN / SRV records
    - RadioVIS (slideshow) over STOMP: ETSI TS 101 499. The exact XML message schema
      is not publicly documented in a machine-checkable way, so parsing of RadioVIS
      payloads below is intentionally defensive/best-effort.
*/

'use strict';

const pluginName = 'RadioDNS';

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');

const { serverConfig } = require('../../server/server_config');
const { logInfo, logWarn, logError, logDebug } = require('../../server/console');

// ---- plugin settings (plugins_configs/RadioDNS.json) ----

const rootDir = path.dirname(require.main.filename);
const configFolderPath = path.join(rootDir, 'plugins_configs');
const configFilePath = path.join(configFolderPath, 'RadioDNS.json');

let pluginSettings = {
    // Force an ECC (2 hex digits, e.g. "e1") when the tuner never decodes RDS
    // group 1A for a station. Leave null to only use the live-decoded ECC.
    manualEcc: null,
    // Attempt to connect to the broadcaster's RadioVIS slideshow feed when found.
    enableRadioVis: true,
    lookupTimeoutMs: 6000,
    cacheTtlMs: 10 * 60 * 1000
};

function checkConfigFile() {
    if (!fs.existsSync(configFolderPath)) {
        logInfo(`${pluginName}: Creating plugins_configs folder...`);
        fs.mkdirSync(configFolderPath, { recursive: true });
    }
    if (!fs.existsSync(configFilePath)) {
        logInfo(`${pluginName}: Creating default RadioDNS.json...`);
        fs.writeFileSync(configFilePath, JSON.stringify(pluginSettings, null, 4));
    }
}

function loadSettings() {
    try {
        const raw = fs.readFileSync(configFilePath, 'utf8');
        Object.assign(pluginSettings, JSON.parse(raw));
        logInfo(`${pluginName}: Settings loaded (manualEcc=${pluginSettings.manualEcc}, enableRadioVis=${pluginSettings.enableRadioVis})`);
    } catch (err) {
        logError(`${pluginName}: Failed to parse RadioDNS.json:`, err.message);
    }
}

// ---- RadioDNS resolution helpers ----

const cache = new Map(); // key -> { time, result }

function freqCode(freqMHz) {
    return String(Math.round(freqMHz * 100)).padStart(5, '0');
}

function normalizeEcc(rawEcc) {
    let hex = null;

    if (typeof rawEcc === 'number' && Number.isFinite(rawEcc) && rawEcc > 0) {
        hex = rawEcc.toString(16).padStart(2, '0');
    } else if (typeof rawEcc === 'string') {
        const cleaned = rawEcc.toLowerCase().replace(/^0x/, '');
        if (/^[0-9a-f]{2}$/.test(cleaned)) hex = cleaned;
    }

    if (!hex && pluginSettings.manualEcc) {
        const cleaned = String(pluginSettings.manualEcc).toLowerCase().replace(/^0x/, '');
        if (/^[0-9a-f]{2}$/.test(cleaned)) hex = cleaned;
    }

    return hex;
}

function stripTrailingDot(name) {
    return name.endsWith('.') ? name.slice(0, -1) : name;
}

async function resolveAuthoritativeFqdn(fqdn) {
    let current = fqdn;
    for (let i = 0; i < 8; i++) {
        try {
            const cnames = await dns.resolveCname(current);
            if (cnames && cnames.length) {
                current = stripTrailingDot(cnames[0]);
                continue;
            }
        } catch (err) {
            break;
        }
        break;
    }
    return current;
}

async function resolveApplicationSrv(service, fqdn) {
    try {
        const records = await dns.resolveSrv(`_${service}._tcp.${fqdn}`);
        if (!records || !records.length) return null;
        records.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
        return { host: stripTrailingDot(records[0].name), port: records[0].port };
    } catch (err) {
        return null;
    }
}

function httpGet(url, timeoutMs, redirectsLeft = 3) {
    return new Promise((resolve, reject) => {
        let target;
        try {
            target = new URL(url);
        } catch (err) {
            return reject(err);
        }

        const lib = target.protocol === 'https:' ? https : http;
        const req = lib.get(target, { timeout: timeoutMs }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
                res.resume();
                const nextUrl = new URL(res.headers.location, target).toString();
                resolve(httpGet(nextUrl, timeoutMs, redirectsLeft - 1));
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }

            let body = '';
            let size = 0;
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > 2_000_000) {
                    req.destroy(new Error('Response too large'));
                    return;
                }
                body += chunk;
            });
            res.on('end', () => resolve(body));
        });

        req.on('timeout', () => req.destroy(new Error('Request timed out')));
        req.on('error', reject);
    });
}

// ---- minimal, tolerant SI.xml field extraction (no external XML dependency) ----

// XML escapes "&" as "&amp;" etc in the source -- decode those before handing text
// back, otherwise the frontend's own HTML-escaping double-encodes it (producing a
// literal "&amp;" on screen instead of "&").
function decodeXmlEntities(str) {
    return str
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function extractTag(xml, tag) {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    if (!m) return null;
    const cleaned = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, '').trim();
    return cleaned ? decodeXmlEntities(cleaned) : null;
}

function extractLinks(xml) {
    const links = [];
    const re = /<link\b([^>]*)\/?>/gi;
    let m;
    while ((m = re.exec(xml))) {
        const attrs = m[1];
        const uri = (attrs.match(/uri\s*=\s*["']([^"']*)["']/i) || [])[1];
        const mime = (attrs.match(/mimeValue\s*=\s*["']([^"']*)["']/i) || [])[1];
        if (uri) links.push({ uri, mime: mime || '' });
    }
    return links;
}

// SI.xml (ETSI TS 102 818) declares logos via <mediaDescription><multimedia url="..."
// mimeValue="image/..." type="logo_colour_square" width="..." height="..."/>, not via
// <link> -- <link> is normally just a hyperlink to the broadcaster's website.
// Broadcasters typically publish several sizes (32x32, 128x128, 320x240, 600x600...);
// 320x240 is the standard "logo_colour_landscape" size and looks best in the popup.
function extractMultimedia(xml) {
    const items = [];
    const re = /<multimedia\b([^>]*)\/?>/gi;
    let m;
    while ((m = re.exec(xml))) {
        const attrs = m[1];
        const url = (attrs.match(/url\s*=\s*["']([^"']*)["']/i) || [])[1];
        const mime = (attrs.match(/mimeValue\s*=\s*["']([^"']*)["']/i) || [])[1];
        const type = (attrs.match(/type\s*=\s*["']([^"']*)["']/i) || [])[1];
        const width = parseInt((attrs.match(/width\s*=\s*["']([^"']*)["']/i) || [])[1], 10);
        const height = parseInt((attrs.match(/height\s*=\s*["']([^"']*)["']/i) || [])[1], 10);
        if (url) items.push({ url, mime: mime || '', type: type || '', width: width || null, height: height || null });
    }
    return items;
}

function findLogoUrl(block) {
    const media = extractMultimedia(block);
    const images = media.filter(m => (m.mime && m.mime.startsWith('image/')) || /logo/i.test(m.type));

    const preferred = images.find(m => m.width === 320 && m.height === 240);
    if (preferred) return preferred.url;

    const byType = images.find(m => /logo/i.test(m.type));
    if (byType) return byType.url;
    if (images.length) return images[0].url;

    const links = extractLinks(block);
    const linkLogo = links.find(l => l.mime && l.mime.startsWith('image/'));
    return linkLogo ? linkLogo.uri : null;
}

// Each <service> carries a <radiodns fqdn="..." serviceIdentifier="..."/> element --
// the serviceIdentifier is the path segment PI.xml (programme schedule) is served
// under: /radiodns/spi/3.1/<serviceIdentifier>/<YYYYMMDD>_PI.xml
function extractServiceIdentifier(block) {
    const m = block.match(/<radiodns\b([^>]*)\/?>/i);
    if (!m) return null;
    return (m[1].match(/serviceIdentifier\s*=\s*["']([^"']*)["']/i) || [])[1] || null;
}

function findMatchingServiceBlock(xml, gcc, pi, freq5) {
    const blocks = xml.match(/<service\b[\s\S]*?<\/service>/gi) || [];
    if (!blocks.length) return null;

    const bearerFull = new RegExp(`fm:${gcc}\\.${pi}(\\.${freq5})?`, 'i');
    const bearerPiOnly = new RegExp(`fm:[a-f0-9]{3}\\.${pi}\\b`, 'i');
    const piTag = new RegExp(`<pi>\\s*${pi}\\s*<\\/pi>`, 'i');

    return blocks.find(b => bearerFull.test(b))
        || blocks.find(b => bearerPiOnly.test(b))
        || blocks.find(b => piTag.test(b))
        || (blocks.length === 1 ? blocks[0] : null);
}

async function lookupRadioDns(pi, ecc, freqMHz) {
    const piLower = pi.toLowerCase();
    const gcc = piLower[0] + ecc;
    const freq5 = freqCode(freqMHz);
    const fqdn = `${freq5}.${piLower}.${gcc}.fm.radiodns.org`;

    logDebug(`${pluginName}: Looking up ${fqdn}`);

    const authoritativeFqdn = await resolveAuthoritativeFqdn(fqdn);
    if (authoritativeFqdn === fqdn) {
        // No CNAME chain at all -- this station does not publish RadioDNS
        return { found: false, reason: 'not-published', fqdn };
    }

    const [radioepg, radiovis, radiotag] = await Promise.all([
        resolveApplicationSrv('radioepg', authoritativeFqdn),
        resolveApplicationSrv('radiovis', authoritativeFqdn),
        resolveApplicationSrv('radiotag', authoritativeFqdn)
    ]);

    const spiHost = radioepg ? radioepg.host : authoritativeFqdn;
    const spiPort = radioepg ? radioepg.port : null;
    const spiPortSuffix = (spiPort && spiPort !== 80 && spiPort !== 443) ? `:${spiPort}` : '';

    const result = {
        found: true,
        fqdn,
        authoritativeFqdn,
        radioepg,
        radiovis,
        radiotag,
        siUrl: null,
        spiHost,
        spiPortSuffix,
        serviceIdentifier: null,
        shortName: null,
        mediumName: null,
        longName: null,
        description: null,
        logo: null
    };

    let siXml = null;
    for (const scheme of ['http', 'https']) {
        try {
            const url = `${scheme}://${spiHost}${spiPortSuffix}/radiodns/spi/3.1/SI.xml`;
            siXml = await httpGet(url, pluginSettings.lookupTimeoutMs);
            result.siUrl = url;
            break;
        } catch (err) {
            logDebug(`${pluginName}: SI.xml fetch via ${scheme} failed: ${err.message}`);
        }
    }

    if (siXml) {
        const block = findMatchingServiceBlock(siXml, gcc, piLower, freq5) || siXml;
        result.shortName = extractTag(block, 'shortName');
        result.mediumName = extractTag(block, 'mediumName');
        result.longName = extractTag(block, 'longName');
        result.description = extractTag(block, 'longDescription') || extractTag(block, 'shortDescription');
        result.logo = findLogoUrl(block);
        result.serviceIdentifier = extractServiceIdentifier(block);
    }

    return result;
}

// ---- EPG: fetch and parse the current day's Programme Information (PI.xml) ----
// URL convention: /radiodns/spi/3.1/<serviceIdentifier>/<YYYYMMDD>_PI.xml
// PI.xml (DAB EPG XML / ETSI TS 102 818) lists <programme> elements, each with a
// <location><time time="..." duration="..."/></location> giving its broadcast window.
// "Now" is whichever programme's window contains the current time; "next" is the
// soonest one starting after now.

function extractTagNs(xml, tag) {
    // Namespace-tolerant: matches <tag>, <ns:tag>, etc.
    const m = xml.match(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, 'i'));
    if (!m) return null;
    const cleaned = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, '').trim();
    return cleaned ? decodeXmlEntities(cleaned) : null;
}

function parseIsoDuration(value) {
    if (!value) return null;
    const m = value.match(/^P(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
    if (!m || (!m[1] && !m[2] && !m[3])) return null;
    const hours = parseInt(m[1] || '0', 10);
    const minutes = parseInt(m[2] || '0', 10);
    const seconds = parseFloat(m[3] || '0');
    return ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

function parseSpiDateTime(value, dateStr) {
    if (!value) return null;
    let d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.getTime();

    // Some feeds give a bare time (e.g. "08:00:00") relying on the filename's date.
    if (dateStr && dateStr.length === 8) {
        const iso = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}T${value}`;
        d = new Date(iso);
        if (!Number.isNaN(d.getTime())) return d.getTime();
    }
    return null;
}

function extractProgrammes(xml, dateStr) {
    const blocks = xml.match(/<(?:\w+:)?programme\b[\s\S]*?<\/(?:\w+:)?programme>/gi) || [];

    return blocks.map(block => {
        const name = extractTagNs(block, 'name') || extractTagNs(block, 'shortName')
            || extractTagNs(block, 'mediumName') || extractTagNs(block, 'longName');
        const description = extractTagNs(block, 'shortDescription') || extractTagNs(block, 'longDescription');

        const timeTagMatch = block.match(/<(?:\w+:)?time\b[^>]*>/i);
        const timeTag = timeTagMatch ? timeTagMatch[0] : '';
        const timeAttr = (timeTag.match(/\btime\s*=\s*["']([^"']+)["']/i) || [])[1];
        const durationAttr = (timeTag.match(/\bduration\s*=\s*["']([^"']+)["']/i) || [])[1];

        const startMs = parseSpiDateTime(timeAttr, dateStr);
        const durationMs = parseIsoDuration(durationAttr);
        const endMs = (startMs !== null && durationMs !== null) ? startMs + durationMs : null;

        return { name, description, startMs, endMs };
    }).filter(p => p.startMs !== null);
}

async function fetchProgrammeInfo(spiHost, spiPortSuffix, serviceIdentifier) {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');

    let piXml = null;
    let piUrl = null;
    for (const scheme of ['http', 'https']) {
        try {
            const url = `${scheme}://${spiHost}${spiPortSuffix}/radiodns/spi/3.1/${serviceIdentifier}/${dateStr}_PI.xml`;
            piXml = await httpGet(url, pluginSettings.lookupTimeoutMs);
            piUrl = url;
            break;
        } catch (err) {
            logDebug(`${pluginName}: PI.xml fetch via ${scheme} failed: ${err.message}`);
        }
    }

    if (!piXml) return { error: 'unavailable' };

    const programmes = extractProgrammes(piXml, dateStr);
    if (!programmes.length) return { error: 'no-schedule', piUrl };

    const nowMs = Date.now();
    let current = null;
    let upcoming = null;

    for (const p of programmes) {
        const endMs = p.endMs !== null ? p.endMs : (p.startMs + 30 * 60000);
        if (nowMs >= p.startMs && nowMs < endMs) {
            current = p;
        } else if (p.startMs > nowMs && (!upcoming || p.startMs < upcoming.startMs)) {
            upcoming = p;
        }
    }

    return { piUrl, now: current, next: upcoming };
}

// ---- RadioVIS: best-effort STOMP client over a plain TCP socket ----

let visSocket = null;

function stopRadioVis() {
    if (visSocket) {
        try { visSocket.destroy(); } catch (err) { /* ignore */ }
        visSocket = null;
    }
}

function buildStompFrame(command, headers, body = '') {
    let frame = command + '\n';
    for (const key of Object.keys(headers)) frame += `${key}:${headers[key]}\n`;
    frame += '\n' + body + '\0';
    return frame;
}

function parseStompFrame(raw) {
    // Some STOMP servers use CRLF line endings even though the spec allows bare LF --
    // normalize up front so command/header comparisons below don't silently fail on a
    // trailing "\r" (which would otherwise make "CONNECTED\r" !== "CONNECTED" and hang
    // the client forever waiting for a frame it already received).
    const normalized = raw.replace(/\r\n/g, '\n');
    const sepIndex = normalized.indexOf('\n\n');
    const headPart = sepIndex === -1 ? normalized : normalized.slice(0, sepIndex);
    const body = sepIndex === -1 ? '' : normalized.slice(sepIndex + 2);
    const lines = headPart.split('\n');
    const command = lines[0].trim();
    const headers = {};
    for (let i = 1; i < lines.length; i++) {
        const idx = lines[i].indexOf(':');
        if (idx > -1) headers[lines[i].slice(0, idx)] = lines[i].slice(idx + 1);
    }
    return { command, headers, body };
}

function extractXmlAttr(xml, attr) {
    const m = xml.match(new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, 'i'));
    return m ? m[1] : null;
}

function parseRadioVisBody(destination, rawBody) {
    const kind = destination.endsWith('/image') ? 'image' : destination.endsWith('/text') ? 'text' : 'unknown';
    const trimmed = (rawBody || '').trim();

    // Confirmed from a live broadcaster: RadioVIS (RVIS01/ETSI TS 101 499) actually
    // uses a simple keyword-prefixed plain-text wire format, not XML -- bodies look
    // like "TEXT <the text>" and (presumably, by the same convention) "SHOW <mediaUri>
    // [<hyperlinkUri>]". Strip that leading keyword rather than showing it verbatim.
    const commandMatch = trimmed.match(/^(TEXT|SHOW)\s+([\s\S]*)$/i);
    const rest = commandMatch ? commandMatch[2].trim() : trimmed;

    if (kind === 'text') {
        const xmlText = extractTag(rest, 'text');
        return { kind, text: xmlText || rest.replace(/<[^>]*>/g, '').trim() };
    }

    if (kind === 'image') {
        // "SHOW" bodies are whitespace-separated tokens: media URL, optionally a
        // hyperlink URL, optionally a trigger time -- pull out any URL-shaped tokens.
        const urlTokens = rest.match(/https?:\/\/\S+/gi) || [];
        let mediaUri = urlTokens[0] || null;
        let linkUri = urlTokens[1] || null;
        let text = null;

        // Fall back to XML/JSON parsing in case a broadcaster sends the richer form.
        if (!mediaUri) {
            mediaUri = extractXmlAttr(rest, 'mediaUri') || extractXmlAttr(rest, 'uri')
                || extractXmlAttr(rest, 'src') || extractXmlAttr(rest, 'url') || extractXmlAttr(rest, 'location')
                || extractTag(rest, 'mediaUri') || extractTag(rest, 'uri') || extractTag(rest, 'url');
            linkUri = extractXmlAttr(rest, 'hyperlink') || extractXmlAttr(rest, 'href') || extractTag(rest, 'hyperlink');
            text = extractTag(rest, 'text') || extractXmlAttr(rest, 'text');

            if (!mediaUri && rest.startsWith('{')) {
                try {
                    const json = JSON.parse(rest);
                    mediaUri = json.mediaUri || json.imageUri || json.image || json.url || json.src || null;
                    linkUri = linkUri || json.hyperlink || json.link || json.href || null;
                    text = text || json.text || null;
                } catch (err) { /* not JSON, fall through */ }
            }
        }

        return { kind, imageUri: mediaUri, linkUri, text };
    }

    return { kind: 'unknown', raw: trimmed };
}

function parseHeartBeatHeader(value) {
    if (!value) return null;
    const parts = value.split(',').map(n => parseInt(n, 10));
    if (parts.length !== 2 || parts.some(Number.isNaN)) return null;
    return { serverSendsEveryMs: parts[0], serverWantsEveryMs: parts[1] };
}

function startRadioVisSession(host, port, gcc, pi, freq5, onEvent) {
    stopRadioVis();

    let buffer = '';
    let heartbeatTimer = null;
    const socket = net.createConnection({ host, port, timeout: 30000 });
    visSocket = socket;

    socket.on('connect', () => {
        // Propose that we *can* send a heartbeat every 10s and would like one every 10s
        // from the server. Some simple STOMP servers (this is a small bespoke broker,
        // not a full broker like ActiveMQ) apply their own idle-connection reaper
        // regardless of heart-beat negotiation, so periodically sending *something*
        // keeps the connection looking alive to them even if they never asked for it.
        socket.write(buildStompFrame('CONNECT', { 'accept-version': '1.0,1.1', host, 'heart-beat': '10000,10000' }));
    });

    socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\0')) !== -1) {
            const rawFrame = buffer.slice(0, idx).replace(/^\r?\n+/, '');
            buffer = buffer.slice(idx + 1);
            if (!rawFrame.trim()) continue;

            const frame = parseStompFrame(rawFrame);
            if (frame.command === 'CONNECTED') {
                socket.write(buildStompFrame('SUBSCRIBE', { id: 'rvis-text', destination: `/topic/fm/${gcc}/${pi}/${freq5}/text`, ack: 'auto' }));
                socket.write(buildStompFrame('SUBSCRIBE', { id: 'rvis-image', destination: `/topic/fm/${gcc}/${pi}/${freq5}/image`, ack: 'auto' }));
                onEvent({ type: 'connected' });

                clearInterval(heartbeatTimer);
                const negotiated = parseHeartBeatHeader(frame.headers['heart-beat']);
                const wantsHeartbeat = !negotiated || negotiated.serverWantsEveryMs !== 0;
                if (wantsHeartbeat) {
                    const intervalMs = Math.max((negotiated && negotiated.serverWantsEveryMs) || 0, 10000);
                    heartbeatTimer = setInterval(() => {
                        if (!socket.destroyed) socket.write('\n');
                    }, intervalMs);
                }
            } else if (frame.command === 'MESSAGE') {
                logDebug(`${pluginName}: RadioVIS message on ${frame.headers.destination}: ${frame.body.slice(0, 300)}`);
                const parsed = parseRadioVisBody(frame.headers.destination || '', frame.body);
                onEvent({ type: 'update', ...parsed });
            } else if (frame.command === 'ERROR') {
                onEvent({ type: 'error', message: frame.body || 'RadioVIS server returned an ERROR frame' });
            }
        }
    });

    socket.on('timeout', () => {
        onEvent({ type: 'error', message: 'RadioVIS connection timed out' });
        stopRadioVis();
    });

    socket.on('error', (err) => {
        onEvent({ type: 'error', message: err.message });
    });

    socket.on('close', () => {
        clearInterval(heartbeatTimer);
        onEvent({ type: 'closed' });
    });
}

// ---- /data_plugins relay client ----
// The webserver's /data_plugins socket is a blind fan-out relay between connected
// clients (see server/index.js) -- it does not push RDS state itself, so this
// plugin joins it as just another client, the same way the frontend does.

let extraSocket;
const webserverPort = (serverConfig.webserver && serverConfig.webserver.webserverPort) || 8080;
const externalWsUrl = `ws://127.0.0.1:${webserverPort}/data_plugins`;

function send(payload) {
    if (extraSocket && extraSocket.readyState === WebSocket.OPEN) {
        extraSocket.send(JSON.stringify(payload));
    }
}

async function handleLookupRequest(pi, rawEcc, freq) {
    if (!pi || typeof freq !== 'number' || !Number.isFinite(freq)) return;
    if (!/^[0-9a-f]{4}$/i.test(pi)) {
        send({ type: 'radiodns-result', pi, freq, found: false, reason: 'invalid-pi' });
        return;
    }

    const ecc = normalizeEcc(rawEcc);
    if (!ecc) {
        send({ type: 'radiodns-result', pi, freq, found: false, reason: 'no-ecc' });
        return;
    }

    const key = `${pi.toLowerCase()}|${ecc}|${freqCode(freq)}`;
    const cached = cache.get(key);
    if (cached && (Date.now() - cached.time) < pluginSettings.cacheTtlMs) {
        send({ type: 'radiodns-result', pi, ecc, freq, key, ...cached.result });
        return;
    }

    try {
        const result = await lookupRadioDns(pi, ecc, freq);
        cache.set(key, { time: Date.now(), result });
        send({ type: 'radiodns-result', pi, ecc, freq, key, ...result });
    } catch (err) {
        logWarn(`${pluginName}: Lookup failed for PI ${pi} ECC ${ecc}:`, err.message);
        send({ type: 'radiodns-result', pi, ecc, freq, key, found: false, reason: 'error', message: err.message });
    }
}

async function handleEpgRequest(pi, rawEcc, freq) {
    if (!pi || typeof freq !== 'number' || !Number.isFinite(freq)) return;

    const ecc = normalizeEcc(rawEcc);
    if (!ecc) {
        send({ type: 'radiodns-epg-result', pi, freq, error: 'no-data' });
        return;
    }

    const key = `${pi.toLowerCase()}|${ecc}|${freqCode(freq)}`;
    const cached = cache.get(key);
    if (!cached || !cached.result.found || !cached.result.serviceIdentifier) {
        send({ type: 'radiodns-epg-result', pi, ecc, freq, error: 'no-service-identifier' });
        return;
    }

    try {
        const epg = await fetchProgrammeInfo(cached.result.spiHost, cached.result.spiPortSuffix, cached.result.serviceIdentifier);
        send({ type: 'radiodns-epg-result', pi, ecc, freq, ...epg });
    } catch (err) {
        logWarn(`${pluginName}: EPG fetch failed for PI ${pi}:`, err.message);
        send({ type: 'radiodns-epg-result', pi, ecc, freq, error: 'error', message: err.message });
    }
}

function handleRadioVisSubscribe(message) {
    if (!pluginSettings.enableRadioVis) {
        send({ type: 'radiovis-event', event: { type: 'unavailable' } });
        return;
    }

    const { pi, ecc: rawEcc, freq, radiovis } = message;
    if (!radiovis || !radiovis.host || !pi || typeof freq !== 'number') {
        send({ type: 'radiovis-event', event: { type: 'unavailable' } });
        return;
    }

    const ecc = normalizeEcc(rawEcc);
    if (!ecc) {
        send({ type: 'radiovis-event', event: { type: 'unavailable' } });
        return;
    }

    const gcc = pi[0].toLowerCase() + ecc;
    const freq5 = freqCode(freq);

    startRadioVisSession(radiovis.host, radiovis.port, gcc, pi.toLowerCase(), freq5, (event) => {
        send({ type: 'radiovis-event', event });
    });
}

function handlePluginMessage(message) {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'radiodns-lookup') {
        handleLookupRequest(message.pi, message.ecc, message.freq);
    } else if (message.type === 'radiodns-epg-request') {
        handleEpgRequest(message.pi, message.ecc, message.freq);
    } else if (message.type === 'radiovis-subscribe') {
        handleRadioVisSubscribe(message);
    } else if (message.type === 'radiovis-unsubscribe') {
        stopRadioVis();
    }
}

function extraWebSocket() {
    if (extraSocket && extraSocket.readyState !== WebSocket.CLOSED) return;

    try {
        extraSocket = new WebSocket(externalWsUrl);

        extraSocket.onopen = () => {
            logInfo(`${pluginName}: Connected to /data_plugins`);
        };

        extraSocket.onerror = (err) => {
            logError(`${pluginName}: WebSocket error:`, err.message);
        };

        extraSocket.onclose = () => {
            logInfo(`${pluginName}: WebSocket closed, retrying in 8s`);
            stopRadioVis();
            setTimeout(extraWebSocket, 8000);
        };

        extraSocket.onmessage = (event) => {
            let message;
            try {
                message = JSON.parse(event.data);
            } catch (err) {
                return;
            }
            handlePluginMessage(message);
        };
    } catch (error) {
        logError(`${pluginName}: Failed to set up WebSocket:`, error.message);
        setTimeout(extraWebSocket, 8000);
    }
}

// ---- init ----

checkConfigFile();
loadSettings();
extraWebSocket();
