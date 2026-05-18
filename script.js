// --- 1. ČTENÍ URL PŘI STARTU ---
let startZoom = 10;
let startLat = 49.4;
let startLng = 15.6;
let initialRoute = null;
let isRealtimeMode = false;

const urlParams = new URLSearchParams(window.location.search);
if (urlParams.has('z')) startZoom = parseInt(urlParams.get('z'), 10);
if (urlParams.has('y')) startLat = parseFloat(urlParams.get('y'));
if (urlParams.has('x')) startLng = parseFloat(urlParams.get('x'));
if (urlParams.has('line')) initialRoute = urlParams.get('line');
if (urlParams.has('rt') && urlParams.get('rt') === '1') isRealtimeMode = true;

// Inicializace mapy
const map = L.map('map', { 
    preferCanvas: true,
    minZoom: 10,
    maxZoom: 15
}).setView([startLat, startLng], startZoom); 

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap © CARTO',
    minZoom: 10, maxZoom: 15
}).addTo(map);

const linesLayer = L.layerGroup().addTo(map);
const routeBadgesLayer = L.layerGroup().addTo(map); 
const stopsLayer = L.layerGroup().addTo(map); 
const liveVehiclesLayer = L.layerGroup().addTo(map); // Zcela nová vrstva pro vozidla

let allBadges = [];
let allStops = [];
let liveVehicleMarkers = {}; // Drží v paměti ID vozidel, aby s nimi šlo hýbat
let activeRouteGroup = null;

// --- 2. ZAPISOVÁNÍ DO URL PŘI POHYBU ---
function updateURL() {
    const center = map.getCenter();
    const zoom = map.getZoom();
    
    const params = new URLSearchParams();
    params.set('x', center.lng.toFixed(4));
    params.set('y', center.lat.toFixed(4));
    params.set('z', zoom);
    
    if (activeRouteGroup && !isRealtimeMode) params.set('line', activeRouteGroup);
    if (isRealtimeMode) params.set('rt', '1');
    
    const newUrl = window.location.pathname + '?' + params.toString();
    window.history.replaceState(null, '', newUrl);
}

// FOCUS MÓD (Modifikován pro Live mapu)
function highlightRoute(group) {
    if (isRealtimeMode) {
        // V Realtime módu Focus vůbec nepustíme, vše ztlumíme na 10 %
        activeRouteGroup = null;
        linesLayer.eachLayer(layer => layer.setStyle({ opacity: 0.10, weight: 3 }));
    } else {
        // Klasická logika
        activeRouteGroup = group;
        linesLayer.eachLayer(layer => {
            if (!activeRouteGroup) {
                layer.setStyle({ opacity: 0.9, weight: 4 });
            } else if (layer.feature.properties.group === activeRouteGroup) {
                layer.setStyle({ opacity: 1, weight: 6 });
                if (layer.bringToFront) layer.bringToFront();
            } else {
                layer.setStyle({ opacity: 0.10, weight: 3 }); 
            }
        });
    }

    renderVisibleElements(); 
    updateURL();
}

map.on('click', function() {
    if (activeRouteGroup !== null) highlightRoute(null);
});

// Změna velikosti štítků podle zoomu
function adjustBadgeSize(element, zoom) {
    const fontSize = 6 + (zoom - 10); 
    element.style.fontSize = fontSize + 'px';
    if (zoom <= 11) {
        element.style.padding = '0px 2px'; element.style.borderWidth = '1px';
    } else if (zoom <= 13) {
        element.style.padding = '1px 3px'; element.style.borderWidth = '1.5px';
    } else {
        element.style.padding = '2px 5px'; element.style.borderWidth = '2px';
    }
}

function updateAllBadgeSizes() {
    const currentZoom = map.getZoom();
    document.querySelectorAll('.route-map-badge').forEach(badge => adjustBadgeSize(badge, currentZoom));
}

// NAČÍTÁNÍ PŘEDŽVÝKANÝCH DAT Z PYTHONU
fetch('trasy.geojson?t=' + new Date().getTime())
    .then(response => response.json())
    .then(data => {
        L.geoJSON(data, {
            style: function(feature) {
                if (feature.geometry.type === "MultiLineString") {
                    // Inicializační vrstva (změní se hned po načtení přes highlightRoute)
                    return { color: feature.properties.color, weight: 4, opacity: 0.9, lineCap: 'round', lineJoin: 'round' };
                }
            },
            onEachFeature: function (feature, layer) {
                const props = feature.properties;

                if (feature.geometry.type === "MultiLineString") {
                    layer.on('click', function(e) {
                        L.DomEvent.stopPropagation(e);
                        // Klikání ignorujeme v realtime módu
                        if (!isRealtimeMode) highlightRoute(activeRouteGroup === props.group ? null : props.group);
                    });
                    linesLayer.addLayer(layer);

                } else if (props.type === "badge") {
                    const latlng = L.latLng(feature.geometry.coordinates[1], feature.geometry.coordinates[0]);

                    const badgeTooltip = L.tooltip(latlng, {
                        permanent: true, direction: 'center', className: 'route-map-badge', interactive: true
                    }).setContent(props.group);

                    badgeTooltip.on('add', function(e) {
                        const el = e.target.getElement();
                        el.style.borderColor = props.color;
                        el.style.cursor = 'pointer';
                        el.style.pointerEvents = 'auto';
                        
                        el.onclick = function(domEvent) {
                            domEvent.stopPropagation();
                            if (!isRealtimeMode) highlightRoute(activeRouteGroup === props.group ? null : props.group);
                        };

                        adjustBadgeSize(el, map.getZoom());
                    });

                    allBadges.push({ layer: badgeTooltip, latlng: latlng, group: props.group });

                } else if (props.type === "stop" && props.show_label) {
                    const latlng = L.latLng(feature.geometry.coordinates[1], feature.geometry.coordinates[0]);

                    const htmlContent = `
                        <span class="stop-dot"></span>
                        <span>${props.name}</span>
                        <span class="stop-zone-text">${props.zones_formatted}</span>
                    `;

                    const marker = L.circleMarker(latlng, {
                        radius: 4, color: '#fff', weight: 1.5, fillColor: '#58d68d', fillOpacity: 1
                    }).bindTooltip(htmlContent, { 
                        permanent: true, direction: 'top', className: 'modern-stop-label', offset: [0, -6]
                    });
                    
                    allStops.push({ layer: marker, latlng: latlng });
                }
            }
        });
        
        // Okamžité aplikování filtrů z URL po stažení GeoJSONu
        highlightRoute(initialRoute);
        document.getElementById('loading').style.display = 'none';
    })
    .catch(error => {
        document.getElementById('loading').innerText = "Chyba při načítání dat tras.";
        console.error(error);
    });

// RENDEROVACÍ LOOP
function renderVisibleElements() {
    const bounds = map.getBounds().pad(0.1);
    const currentZoom = map.getZoom();

    allBadges.forEach(badge => {
        const isFocused = !activeRouteGroup || activeRouteGroup === badge.group;
        const isVisible = bounds.contains(badge.latlng);

        // Skryjeme štítky, pokud jsme v Live módu. Jinak normální logika.
        if (!isRealtimeMode && isFocused && isVisible) {
            if (!routeBadgesLayer.hasLayer(badge.layer)) routeBadgesLayer.addLayer(badge.layer);
        } else {
            if (routeBadgesLayer.hasLayer(badge.layer)) routeBadgesLayer.removeLayer(badge.layer);
        }
    });

    if (currentZoom >= 15) {
        allStops.forEach(stop => {
            if (bounds.contains(stop.latlng)) {
                if (!stopsLayer.hasLayer(stop.layer)) stopsLayer.addLayer(stop.layer);
            } else {
                if (stopsLayer.hasLayer(stop.layer)) stopsLayer.removeLayer(stop.layer);
            }
        });
    } else {
        stopsLayer.clearLayers();
    }
}

map.on('moveend', function() {
    renderVisibleElements();
    updateURL();
});

map.on('zoomend', function() {
    renderVisibleElements();
    updateAllBadgeSizes();
    updateURL();
});


// --- 3. GPS LOKALIZACE UŽIVATELE ---
let userMarker = null;
const locateBtn = document.getElementById('locate-btn');
if (locateBtn) {
    locateBtn.addEventListener('click', () => {
        map.locate({ setView: true, maxZoom: 14 });
    });
}

map.on('locationfound', function(e) {
    if (!userMarker) {
        userMarker = L.circleMarker(e.latlng, { radius: 7, color: '#fff', weight: 2, fillColor: '#3388ff', fillOpacity: 1 }).addTo(map);
    } else {
        userMarker.setLatLng(e.latlng);
    }
});


// --- 4. ENGINE PRO ŽIVÁ VOZIDLA (Spustí se pouze pokud rt=1) ---
async function fetchLiveVehicles() {
    if (!isRealtimeMode) return;
    
    try {
        const response = await fetch('https://mapavdv.kr-vysocina.cz/Ajax/GetPoints');
        const data = await response.json();

        // Garbage collection: Smažeme z mapy vozidla, která už z API zmizela (např. dojela do cíle)
        const activeIds = new Set(data.map(v => v.id));
        for (let id in liveVehicleMarkers) {
            if (!activeIds.has(parseInt(id))) {
                liveVehiclesLayer.removeLayer(liveVehicleMarkers[id]);
                delete liveVehicleMarkers[id];
            }
        }

        data.forEach(v => {
            const isTrain = v.traction === 'TRAIN';
            const shapeClass = isTrain ? 'train' : 'bus';
            const iconSymbol = isTrain ? '🚆' : '🚌';
            
            let delayClass = 'delay-ok';
            let delayText = 'Na čas';
            
            // Matematika zpoždění (předpokládáme formát v minutách)
            if (v.delay === -2147483648) {
                delayClass = 'delay-unknown';
                delayText = 'Neznámé zpoždění';
            } else if (v.delay < 0) {
                delayText = `${Math.abs(v.delay)} min náskok`;
            } else if (v.delay > 0 && v.delay < 10) {
                delayClass = 'delay-warn';
                delayText = `+${v.delay} min zpoždění`;
            } else if (v.delay >= 10) {
                delayClass = 'delay-alert';
                delayText = `+${v.delay} min zpoždění`;
            }

            const dest = (v.finalStopName === '-1 N/a' || v.finalStopName.includes('N/a')) ? 'Neznámý cíl' : v.finalStopName;

            const iconHtml = `<div class="live-vehicle ${shapeClass} ${delayClass}">${iconSymbol}</div>`;
            const tooltipHtml = `
                <div style="font-size: 13px; font-weight: bold; margin-bottom: 2px;">${isTrain ? 'Vlak' : 'Linka'} ${v.text}</div>
                <div style="font-size: 11px; color: #ccc;">Směr: ${dest}</div>
                <div style="font-size: 12px; font-weight: bold; margin-top: 4px;" class="${delayClass}-text">${delayText}</div>
            `;

            if (liveVehicleMarkers[v.id]) {
                // Vozidlo už na mapě je - pouze ho hladce posuneme a aktualizujeme texty
                liveVehicleMarkers[v.id].setLatLng([v.lat, v.lng]);
                liveVehicleMarkers[v.id].setIcon(L.divIcon({ className: '', html: iconHtml, iconSize: [26, 26], iconAnchor: [13, 13] }));
                liveVehicleMarkers[v.id].setTooltipContent(tooltipHtml);
            } else {
                // Nové vozidlo
                const marker = L.marker([v.lat, v.lng], {
                    icon: L.divIcon({ className: '', html: iconHtml, iconSize: [26, 26], iconAnchor: [13, 13] })
                }).bindTooltip(tooltipHtml, {
                    permanent: false, direction: 'top', className: 'vehicle-tooltip', offset: [0, -14]
                });
                liveVehiclesLayer.addLayer(marker);
                liveVehicleMarkers[v.id] = marker;
            }
        });

    } catch (e) {
        console.error("Nelze načíst realtime data vozidel:", e);
    }
}

// Spustíme první načtení a pak loop každých 10 vteřin
if (isRealtimeMode) {
    fetchLiveVehicles();
    setInterval(fetchLiveVehicles, 10000); 
}
