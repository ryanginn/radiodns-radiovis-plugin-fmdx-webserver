/*
    RadioDNS v1.0.0
    Frontend: draws a tower icon to the left of the frequency display (dim when no
    RadioDNS has been detected for the tuned station, full brightness when it has),
    and a popup showing RDS details, RadioDNS/SPI station info and a live RadioVIS
    slideshow when the broadcaster publishes one.
*/

'use strict';

(() => {
    const pluginName = 'RadioDNS';

    const POLL_INTERVAL_MS = 700;
    const LOOKUP_DEBOUNCE_MS = 1500;

    const currentURL = new URL(window.location.href);
    const WebserverURL = currentURL.hostname;
    const WebserverPath = currentURL.pathname.replace(/setup/g, '');
    const WebserverPORT = currentURL.port || (currentURL.protocol === 'https:' ? '443' : '80');
    const wsProtocol = currentURL.protocol === 'https:' ? 'wss:' : 'ws:';
    const WEBSOCKET_URL = `${wsProtocol}//${WebserverURL}:${WebserverPORT}${WebserverPath}data_plugins`;

    let ws;
    let reconnectTimer;

    const RETRY_MIN_MS = 3000;
    const RETRY_MAX_MS = 20000;

    let lastPi = null;
    let lastFreq = null;
    let currentResult = null;
    let lookupDebounceTimer;
    let retryTimer;
    let retryAttempt = 0;
    let radioVisActive = false;
    let wasPopupVisible = false;

    document.addEventListener('DOMContentLoaded', () => {
        injectStyles();
        connectSocket();
        drawIcon();

        setInterval(tick, POLL_INTERVAL_MS);
    });

    // ---- WebSocket (joins the existing /data_plugins relay, same as the server side) ----

    function connectSocket() {
        try {
            ws = new WebSocket(WEBSOCKET_URL);
        } catch (err) {
            reconnectTimer = setTimeout(connectSocket, 5000);
            return;
        }

        ws.addEventListener('open', () => clearTimeout(reconnectTimer));
        ws.addEventListener('close', () => {
            reconnectTimer = setTimeout(connectSocket, 5000);
        });
        ws.addEventListener('error', () => { /* onclose will handle reconnect */ });
        ws.addEventListener('message', (event) => {
            let message;
            try {
                message = JSON.parse(event.data);
            } catch (err) {
                return;
            }
            handleMessage(message);
        });
    }

    function send(payload) {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    }

    function handleMessage(message) {
        if (!message || typeof message !== 'object') return;

        if (message.type === 'radiodns-result') {
            onLookupResult(message);
        } else if (message.type === 'radiovis-event') {
            onRadioVisEvent(message.event);
        } else if (message.type === 'radiodns-epg-result') {
            onEpgResult(message);
        }
    }

    // ---- polling window.parsedData for station changes ----
    // window.parsedData is set (as an implicit global) by the webserver's main.js on
    // every /text socket message and already carries pi/ecc/freq/ps/rt/pty/etc, so no
    // extra plumbing is needed to read live RDS state.

    function tick() {
        checkPopupVisibility();

        const data = window.parsedData;
        if (!data) return;

        const pi = (data.pi || '').toString().trim();
        const freq = Number(data.freq);

        if (!pi || pi === '?' || !Number.isFinite(freq)) {
            if (lastPi !== null) resetStation();
            return;
        }

        const stationChanged = pi !== lastPi || lastFreq === null || Math.abs(freq - lastFreq) > 0.03;

        if (stationChanged) {
            lastPi = pi;
            lastFreq = freq;
            currentResult = null;
            retryAttempt = 0;
            setIconState('idle');
            stopRadioVisIfActive();

            clearTimeout(lookupDebounceTimer);
            clearTimeout(retryTimer);
            lookupDebounceTimer = setTimeout(() => requestLookup(pi, data.ecc, freq), LOOKUP_DEBOUNCE_MS);

            if (wasPopupVisible) renderPopup();
        }
    }

    function resetStation() {
        lastPi = null;
        lastFreq = null;
        currentResult = null;
        retryAttempt = 0;
        clearTimeout(lookupDebounceTimer);
        clearTimeout(retryTimer);
        setIconState('idle');
        stopRadioVisIfActive();
        if (wasPopupVisible) renderPopup();
    }

    function requestLookup(pi, ecc, freq) {
        send({ type: 'radiodns-lookup', pi, ecc, freq });
    }

    function onLookupResult(message) {
        // Guard against a stale response arriving after the user has already retuned
        if (!lastPi || message.pi.toLowerCase() !== lastPi.toLowerCase()) return;
        if (lastFreq === null || Math.abs(message.freq - lastFreq) > 0.03) return;

        currentResult = message;
        setIconState(message.found ? 'found' : 'idle');

        if (wasPopupVisible) {
            renderPopup();
            maybeStartRadioVis();
        }

        if (message.found) {
            clearTimeout(retryTimer);
        } else {
            scheduleRetry();
        }
    }

    // RDS group 1A (which carries ECC) isn't repeated as often as PS/RT, and can take
    // a while after retuning to be decoded (longer still on a weak/noisy signal) -- so
    // a single lookup attempt right after tuning in often finds no ECC yet. Keep
    // scanning in the background for as long as this station stays tuned in, backing
    // off up to a 20s cadence, so the icon still lights up on its own whenever RDS
    // group 1A actually arrives rather than giving up after a fixed number of tries.
    function scheduleRetry() {
        retryAttempt += 1;
        const delay = Math.min(RETRY_MIN_MS * retryAttempt, RETRY_MAX_MS);

        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
            if (!lastPi || lastFreq === null) return;
            const data = window.parsedData;
            if (!data) return;
            requestLookup(lastPi, data.ecc, lastFreq);
        }, delay);
    }

    // ---- icon ----

    // Same placement technique as the Autotune plugin's button: a plain CSS corner-pin
    // (position:absolute + bottom/left) inside #freq-container (position:relative).
    // No rect measurement/math at all, which is exactly what kept going wrong -- this
    // is the proven-reliable approach already used elsewhere in this same webserver.
    function drawIcon() {
        if (document.getElementById('radiodns-icon')) return;

        const container = document.getElementById('freq-container');
        if (!container) return;

        const icon = document.createElement('i');
        icon.id = 'radiodns-icon';
        icon.className = 'fa-solid fa-tower-broadcast tooltip';
        icon.setAttribute('aria-label', 'RadioDNS station details');
        icon.setAttribute('data-tooltip', 'RadioDNS: not detected for this station');

        setIconState('idle');

        icon.addEventListener('mouseenter', () => {
            icon.style.opacity = '1';
            icon.style.filter = 'brightness(1.5)';
        });
        icon.addEventListener('mouseleave', () => {
            const active = icon.classList.contains('radiodns-active');
            icon.style.opacity = active ? '1' : '0.5';
            icon.style.filter = active ? 'brightness(1.1)' : 'brightness(1)';
        });

        icon.addEventListener('click', (event) => {
            event.stopPropagation();
            event.preventDefault();
            openOrCloseFreqIcon();
        });

        container.appendChild(icon);
    }

    function setIconState(state) {
        const icon = document.getElementById('radiodns-icon');
        if (!icon) return;

        if (state === 'found') {
            icon.classList.add('radiodns-active');
            icon.style.opacity = '1';
            icon.style.filter = 'brightness(1.1)';
            const visNote = currentResult && currentResult.radiovis ? ' & RadioVIS' : '';
            icon.setAttribute('data-tooltip', `RadioDNS detected -- click for station details${visNote}`);
        } else {
            icon.classList.remove('radiodns-active');
            icon.style.opacity = '0.5';
            icon.style.filter = 'brightness(1)';
            icon.setAttribute('data-tooltip', 'RadioDNS: not detected for this station');
        }

        if (typeof initTooltips === 'function') initTooltips(icon);
    }

    function openOrCloseFreqIcon() {
        ensurePopup();
        togglePopup('#popup-panel-radiodns');
        checkPopupVisibility();
        if (wasPopupVisible) {
            renderPopup();
            maybeStartRadioVis();
        }
    }

    // ---- popup ----

    function ensurePopup() {
        if (document.getElementById('popup-panel-radiodns')) return;

        const html = `
            <div class="popup-window" id="popup-panel-radiodns" style="width:460px;height:460px;top:70px;left:calc(50vw - 230px);">
                <div class="flex-container flex-column flex-phone flex-phone-column" style="height:calc(100%);">
                    <div class="popup-header hover-brighten flex-center">
                        <p class="color-4 popup-title" style="margin:0;padding-left:10px;">RadioDNS Monitor</p>
                        <button class="popup-close" aria-label="Close">&#10005;</button>
                    </div>
                    <div class="popup-content radiodns-popup-content text-left" style="flex:1;overflow-y:auto;"></div>
                </div>
            </div>`;

        $('body').append(html);

        const $popup = $('#popup-panel-radiodns');
        if (typeof $popup.draggable === 'function') {
            $popup.draggable({ handle: '.popup-header', containment: 'body' });
        }
        if (typeof $popup.resizable === 'function') {
            $popup.resizable({ minHeight: 330, minWidth: 350, containment: 'body' });
        }

        $popup.find('.popup-close').on('click', () => {
            $('.popup-window').fadeOut(200);
        });

        // Delegated so it keeps working after renderPopup() rebuilds the badge markup
        $popup.on('click', '#radiodns-epg-badge', () => {
            openEpgView();
        });
    }

    // A second themed popup (same .popup-window styling as the rest of the app) for
    // "EPG" -- shows the parsed SPI info plus a best-effort "now / next" schedule
    // fetched from the broadcaster's PI.xml.
    function ensureEpgPopup() {
        if (document.getElementById('popup-panel-radiodns-epg')) return;

        const html = `
            <div class="popup-window" id="popup-panel-radiodns-epg" style="width:400px;height:460px;top:90px;left:calc(50vw - 200px);">
                <div class="flex-container flex-column flex-phone flex-phone-column" style="height:calc(100%);">
                    <div class="popup-header hover-brighten flex-center">
                        <p class="color-4 popup-title" style="margin:0;padding-left:10px;">Station EPG</p>
                        <button class="popup-close" aria-label="Close">&#10005;</button>
                    </div>
                    <div class="popup-content radiodns-popup-content text-left" id="radiodns-epg-content" style="flex:1;overflow-y:auto;"></div>
                </div>
            </div>`;

        $('body').append(html);

        const $popup = $('#popup-panel-radiodns-epg');
        if (typeof $popup.draggable === 'function') {
            $popup.draggable({ handle: '.popup-header', containment: 'body' });
        }
        if (typeof $popup.resizable === 'function') {
            $popup.resizable({ minHeight: 300, minWidth: 320, containment: 'body' });
        }
        $popup.find('.popup-close').on('click', () => {
            $('.popup-window').fadeOut(200);
        });
    }

    function openEpgView() {
        if (!currentResult || !currentResult.found) return;
        ensureEpgPopup();

        const name = currentResult.longName || currentResult.mediumName || currentResult.shortName || 'Unknown station';
        const desc = currentResult.description || '';
        const logo = safeHttpUrl(currentResult.logo);

        const html = `
            <div class="radiodns-card">
                <div class="radiodns-card-text">
                    <h3 class="m-0">${escapeHtml(name)}</h3>
                    ${desc ? `<p class="text-small">${escapeHtml(desc)}</p>` : ''}
                </div>
                ${logo ? `<img src="${escapeAttr(logo)}" class="radiodns-logo-thumb" alt="Station logo">` : ''}
            </div>
            <hr>
            <div id="radiodns-epg-schedule">
                <p class="text-small text-gray">Loading schedule...</p>
            </div>
        `;

        $('#radiodns-epg-content').html(html);
        togglePopup('#popup-panel-radiodns-epg');

        send({ type: 'radiodns-epg-request', pi: lastPi, ecc: (window.parsedData && window.parsedData.ecc) || null, freq: lastFreq });
    }

    function formatProgrammeTime(ms) {
        if (!Number.isFinite(ms)) return '';
        return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function renderProgramme(label, programme) {
        if (!programme) return '';
        const time = formatProgrammeTime(programme.startMs);
        return `
            <div class="radiodns-block">
                <span class="label">${label}${time ? ` &middot; ${time}` : ''}</span>
                <p><strong>${escapeHtml(programme.name || 'Untitled programme')}</strong></p>
                ${programme.description ? `<p class="text-small">${escapeHtml(programme.description)}</p>` : ''}
            </div>
        `;
    }

    function onEpgResult(message) {
        const $schedule = $('#radiodns-epg-schedule');
        if (!$schedule.length) return; // popup closed/rebuilt before the response arrived
        if (!lastPi || !message.pi || message.pi.toLowerCase() !== lastPi.toLowerCase()) return;

        if (message.error) {
            const errorMessages = {
                'unavailable': "Couldn't reach the broadcaster's programme information feed.",
                'no-schedule': 'No programme schedule was found for today.',
                'no-service-identifier': "This broadcaster's feed doesn't declare a service identifier for programme lookups.",
                'no-data': 'No station data available yet.',
                'error': message.message || 'Failed to fetch programme information.'
            };
            $schedule.html(`<p class="text-small text-gray">${escapeHtml(errorMessages[message.error] || errorMessages.error)}</p>`);
            return;
        }

        const nowHtml = renderProgramme('Now', message.now);
        const nextHtml = renderProgramme('Next', message.next);

        $schedule.html(nowHtml || nextHtml ? `${nowHtml}${nextHtml}` : '<p class="text-small text-gray">No current schedule information available.</p>');
    }

    function checkPopupVisibility() {
        const $popup = $('#popup-panel-radiodns');
        const visibleNow = $popup.length > 0 && $popup.is(':visible');

        if (visibleNow && !wasPopupVisible) {
            renderPopup();
            maybeStartRadioVis();
        } else if (!visibleNow && wasPopupVisible) {
            stopRadioVisIfActive();
        }

        wasPopupVisible = visibleNow;
    }

    // Full rebuild: only called on popup open, station change, or a new lookup result --
    // NOT on every poll tick, since that would tear down the live RadioVIS section
    // (image/text/connection status) and reset it back to "Connecting..." constantly.
    function renderPopup() {
        const $content = $('#popup-panel-radiodns .radiodns-popup-content');
        if (!$content.length) return;

        if (!lastPi) {
            $content.html('<p class="text-gray">Waiting for a station with a decoded PI code...</p>');
            return;
        }

        const html = `
            <div class="radiodns-section">
                <h3><i class="fa-solid fa-tower-broadcast"></i> RadioDNS</h3>
                ${renderRadioDnsSection()}
            </div>
            <hr>
            <div class="radiodns-section" id="radiodns-vis-section">
                <h3><i class="fa-solid fa-images"></i> RadioVIS</h3>
                ${renderRadioVisSection()}
            </div>
        `;

        $content.html(html);
    }

    function renderRadioDnsSection() {
        if (!currentResult) {
            return '<p class="text-gray">Looking up RadioDNS...</p>';
        }

        if (!currentResult.found) {
            const reasonMessages = {
                'no-ecc': 'RadioDNS is unavailable on this station due to the lack of 1A transmission.',
                'invalid-pi': 'Invalid PI code.',
                'error': currentResult.message || 'Lookup failed.',
                'not-published': 'This station does not appear to publish RadioDNS.'
            };
            const reasonMsg = reasonMessages[currentResult.reason] || reasonMessages['not-published'];
            return `<p class="text-gray">Not available. ${escapeHtml(reasonMsg)}</p>`;
        }

        const name = currentResult.longName || currentResult.mediumName || currentResult.shortName || '';
        const desc = currentResult.description || '';
        const logo = safeHttpUrl(currentResult.logo);

        const badges = [
            currentResult.radioepg ? '<span class="radiodns-badge radiodns-badge-link" id="radiodns-epg-badge" title="Open this broadcaster\'s SPI/EPG feed">EPG</span>' : null,
            currentResult.radiovis ? '<span class="radiodns-badge">VIS</span>' : null,
            currentResult.radiotag ? '<span class="radiodns-badge">TAG</span>' : null
        ].filter(Boolean).join(' ');

        return `
            <div class="radiodns-card">
                <div class="radiodns-card-text">
                    ${name ? `<p class="m-0"><strong>${escapeHtml(name)}</strong></p>` : ''}
                    ${desc ? `<p class="text-small">${escapeHtml(desc)}</p>` : ''}
                    <p class="text-small text-gray">FQDN: ${escapeHtml(currentResult.fqdn)}<br>Resolved to: ${escapeHtml(currentResult.authoritativeFqdn)}</p>
                    ${badges ? `<p>${badges}</p>` : ''}
                </div>
                ${logo ? `<img src="${escapeAttr(logo)}" class="radiodns-logo-thumb" alt="Station logo">` : ''}
            </div>
        `;
    }

    function renderRadioVisSection() {
        if (!currentResult || !currentResult.found) {
            return '<p class="text-gray">Unavailable -- no RadioDNS for this station.</p>';
        }
        if (!currentResult.radiovis) {
            return '<p class="text-gray">This broadcaster does not publish RadioVIS.</p>';
        }

        return `
            <p class="text-small text-gray" id="radiovis-status">Connecting...</p>
            <div id="radiovis-image-wrap" style="display:none;">
                <a id="radiovis-link" href="#" target="_blank" rel="noopener noreferrer">
                    <img id="radiovis-image" alt="RadioVIS slideshow" class="radiodns-logo">
                </a>
            </div>
            <p id="radiovis-text" class="text-small"></p>
        `;
    }

    function onRadioVisEvent(event) {
        if (!event) return;
        const $status = $('#radiovis-status');
        if (!$status.length) return; // section isn't currently rendered

        if (event.type === 'connected') {
            $status.show().text('Connected -- waiting for content...');
        } else if (event.type === 'unavailable') {
            $status.show().text('RadioVIS not available.');
        } else if (event.type === 'error') {
            $status.show().text(`RadioVIS error: ${event.message || 'connection failed'}`);
        } else if (event.type === 'closed') {
            $status.show().text('RadioVIS connection closed.');
        } else if (event.type === 'update') {
            // Once real content has arrived, the status line is just noise -- hide it
            // rather than showing a "Live" label.
            $status.hide();
            if (event.kind === 'image') {
                const imageUrl = safeHttpUrl(event.imageUri);
                if (imageUrl) {
                    $('#radiovis-image').attr('src', imageUrl);
                    $('#radiovis-link').attr('href', safeHttpUrl(event.linkUri) || imageUrl);
                    $('#radiovis-image-wrap').show();
                }
            }
            if (event.text) $('#radiovis-text').text(event.text);
        }
    }

    function maybeStartRadioVis() {
        if (!currentResult || !currentResult.found || !currentResult.radiovis) return;
        if (radioVisActive) return;

        radioVisActive = true;
        send({
            type: 'radiovis-subscribe',
            pi: lastPi,
            ecc: (window.parsedData && window.parsedData.ecc) || null,
            freq: lastFreq,
            radiovis: currentResult.radiovis
        });
    }

    function stopRadioVisIfActive() {
        if (!radioVisActive) return;
        radioVisActive = false;
        send({ type: 'radiovis-unsubscribe' });
    }

    // ---- helpers ----

    function safeHttpUrl(url) {
        if (!url) return null;
        try {
            const parsed = new URL(url, window.location.href);
            return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : null;
        } catch (err) {
            return null;
        }
    }

    function escapeHtml(str) {
        return String(str === undefined || str === null ? '' : str).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    function escapeAttr(str) {
        return escapeHtml(str).replace(/`/g, '&#96;');
    }

    // ---- styles ----

    function injectStyles() {
        const css = `
            #freq-container { position: relative !important; }
            #radiodns-icon {
                position: absolute !important;
                bottom: 6px !important;
                left: 5px !important;
                z-index: 1000 !important;
                width: 30px;
                height: 30px;
                display: flex !important;
                align-items: center;
                justify-content: center;
                border-radius: 10px;
                border: 1px solid rgba(255, 255, 255, 0.1);
                background-color: var(--color-3);
                color: var(--color-text);
                font-size: 14px;
                cursor: pointer;
                opacity: 0.5;
                transition: opacity 0.2s ease-in-out, filter 0.2s ease-in-out, background-color 0.2s ease-in-out;
            }
            #radiodns-icon.radiodns-active {
                opacity: 1;
                color: var(--color-4);
                background-color: var(--color-3);
            }
            .radiodns-popup-content {
                padding: 14px;
            }
            .radiodns-popup-content h3 {
                margin-bottom: 8px;
            }
            .radiodns-popup-content hr {
                border: none;
                border-top: 1px solid var(--color-3);
                margin: 14px 0;
            }
            .radiodns-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 6px 14px;
                margin-top: 8px;
            }
            .radiodns-grid > div {
                display: flex;
                justify-content: space-between;
                background: var(--color-1);
                border-radius: 8px;
                padding: 6px 10px;
                font-size: 13px;
            }
            .radiodns-grid .label {
                opacity: 0.7;
                margin-right: 8px;
            }
            .radiodns-block {
                margin-top: 10px;
            }
            .radiodns-block .label {
                opacity: 0.7;
                font-size: 12px;
            }
            .radiodns-block p {
                margin: 2px 0 0 0;
            }
            .radiodns-badge {
                display: inline-block;
                background: var(--color-4);
                color: var(--color-main);
                font-weight: 700;
                font-size: 11px;
                padding: 2px 8px;
                border-radius: 10px;
                margin-right: 6px;
            }
            .radiodns-badge-link {
                cursor: pointer;
                text-decoration: underline;
            }
            .radiodns-badge-link:hover {
                filter: brightness(1.15);
            }
            .radiodns-card {
                display: flex;
                align-items: flex-start;
                gap: 12px;
            }
            .radiodns-card-text {
                flex: 1;
                min-width: 0;
            }
            .radiodns-logo-thumb {
                width: 140px;
                height: 105px;
                object-fit: contain;
                border-radius: 8px;
                background: var(--color-1);
                padding: 6px;
                flex-shrink: 0;
            }
            .radiodns-logo {
                max-width: 100%;
                height: auto;
                border-radius: 8px;
                display: block;
                margin: 8px 0;
            }
        `;
        $('<style>').prop('type', 'text/css').html(css).appendTo('head');
    }

})();
