let startZoom = 10;
let startLat = 49.4;
let startLng = 15.6;
let initialRoute = null;
let isRealtimeMode = false;
let selectedVehicleId = null; // NOVÉ: Pamatuje si vybrané vozidlo
let rtInterval = null;

const urlParams = new URLSearchParams(window.location.search);
if (urlParams.has('z')) startZoom = parseInt(urlParams.get('z'), 10);
if (urlParams.has('y')) startLat = parseFloat(urlParams.get('y'));
if (urlParams.has('x')) startLng = parseFloat(urlParams.get('x'));
if (urlParams.has('line')) initialRoute = urlParams.get('line');
if (urlParams.has('rt') && urlParams.get('rt') === '1') isRealtimeMode = true;
if (urlParams.has('id')) selectedVehicleId = parseInt(urlParams.get('id'), 10);

const map = L.map('map', { preferCanvas: true, minZoom: 10, maxZoom: 15 }).setView([startLat, startLng], startZoom); 

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: '© OSMC', minZoom: 10, maxZoom: 15 }).addTo(map);

const linesLayer = L.layerGroup().addTo(map);
const routeBadgesLayer = L.layerGroup().addTo(map); 
const stopsLayer = L.layerGroup().addTo(map); 
const liveVehiclesLayer = L.layerGroup().addTo(map);

let allBadges = [];
let allStops = [];
let liveVehicleMarkers = {}; 
let activeRouteGroup = null;

// --- POMOCNÁ FUNKCE PRO BEZPEČNÉ STAHOVÁNÍ HTML PŘES PROXY ---
async function fetchKrajskeHtml(url) {
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
    const res = await fetch(proxyUrl);
    return await res.text();
}

function updateURL() {
    const center = map.getCenter();
    const params = new URLSearchParams();
    params.set('x', center.lng.toFixed(4));
    params.set('y', center.lat.toFixed(4));
    params.set('z', map.getZoom());
    
    if (isRealtimeMode) params.set('rt', '1');
    else if (activeRouteGroup) params.set('line', activeRouteGroup);
    
    if (selectedVehicleId) params.set('id', selectedVehicleId);
    
    window.history.replaceState(null, '', window.location.pathname + '?' + params.toString());
}

// Zvýraznění trasy (Nyní funguje i v RT módu pro zobrazení trasy konkrétního vozidla)
function highlightRoute(group) {
    activeRouteGroup = group;
    linesLayer.eachLayer(layer => {
        if (!activeRouteGroup) {
            layer.setStyle({ opacity: isRealtimeMode ? 0.10 : 0.9, weight: isRealtimeMode ? 3 : 4 });
        } else if (layer.feature.properties.group === activeRouteGroup) {
            layer.setStyle({ opacity: 1, weight: 6 });
            if (layer.bringToFront) layer.bringToFront();
        } else {
            layer.setStyle({ opacity: 0.10, weight: 3 }); 
        }
    });
    renderVisibleElements(); 
    updateURL();
}

map.on('click', function() {
    // Kliknutí do prázdna zruší výběry
    if (activeRouteGroup !== null) highlightRoute(null);
    if (selectedVehicleId !== null) {
        selectedVehicleId = null;
        updateURL();
        document.getElementById('mobile-bottom-bar').classList.add('hidden');
    }
});

function adjustBadgeSize(element, zoom) {
    element.style.fontSize = (6 + (zoom - 10)) + 'px';
    if (zoom <= 11) { element.style.padding = '0px 2px'; element.style.borderWidth = '1px'; } 
    else if (zoom <= 13) { element.style.padding = '1px 3px'; element.style.borderWidth = '1.5px'; } 
    else { element.style.padding = '2px 5px'; element.style.borderWidth = '2px'; }
}

function updateAllBadgeSizes() {
    document.querySelectorAll('.route-map-badge').forEach(badge => adjustBadgeSize(badge, map.getZoom()));
}

// --- PŘEPÍNAČ ŽIVÉ MAPY ---
function toggleRealtimeMode(forceState = null) {
    isRealtimeMode = forceState !== null ? forceState : !isRealtimeMode;
    const btn = document.getElementById('rt-btn');
    
    if (isRealtimeMode) {
        btn.classList.add('active');
        if(!selectedVehicleId) highlightRoute(null); // Ztlumí linky, pokud není žádná vybraná
        fetchLiveVehicles();
        rtInterval = setInterval(fetchLiveVehicles, 10000);
    } else {
        btn.classList.remove('active');
        clearInterval(rtInterval);
        liveVehiclesLayer.clearLayers();
        liveVehicleMarkers = {};
        document.getElementById('mobile-bottom-bar').classList.add('hidden');
        selectedVehicleId = null;
        highlightRoute(initialRoute || null); // Vrátí linky zpět
    }
    updateURL();
}

document.getElementById('rt-btn').addEventListener('click', () => toggleRealtimeMode());

// Načítání GeoJSON tras
fetch('trasy.geojson?t=' + new Date().getTime())
    .then(response => response.json())
    .then(data => {
        L.geoJSON(data, {
            style: function(feature) {
                if (feature.geometry.type === "MultiLineString") return { color: feature.properties.color, weight: 4, opacity: 0.9, lineCap: 'round', lineJoin: 'round' };
            },
            onEachFeature: function (feature, layer) {
                const props = feature.properties;
                if (feature.geometry.type === "MultiLineString") {
                    layer.on('click', function(e) { L.DomEvent.stopPropagation(e); if(!isRealtimeMode) highlightRoute(activeRouteGroup === props.group ? null : props.group); });
                    linesLayer.addLayer(layer);
                } else if (props.type === "badge") {
                    const latlng = L.latLng(feature.geometry.coordinates[1], feature.geometry.coordinates[0]);
                    const badgeTooltip = L.tooltip(latlng, { permanent: true, direction: 'center', className: 'route-map-badge', interactive: true }).setContent(props.group);
                    badgeTooltip.on('add', function(e) {
                        const el = e.target.getElement();
                        el.style.borderColor = props.color; el.style.cursor = 'pointer'; el.style.pointerEvents = 'auto';
                        el.onclick = function(domEvent) { domEvent.stopPropagation(); if(!isRealtimeMode) highlightRoute(activeRouteGroup === props.group ? null : props.group); };
                        adjustBadgeSize(el, map.getZoom());
                    });
                    allBadges.push({ layer: badgeTooltip, latlng: latlng, group: props.group });
                } else if (props.type === "stop" && props.show_label) {
                    const latlng = L.latLng(feature.geometry.coordinates[1], feature.geometry.coordinates[0]);
                    const marker = L.circleMarker(latlng, { radius: 4, color: '#fff', weight: 1.5, fillColor: '#58d68d', fillOpacity: 1 })
                        .bindTooltip(`<span class="stop-dot"></span><span>${props.name}</span><span class="stop-zone-text">${props.zones_formatted}</span>`, { permanent: true, direction: 'top', className: 'modern-stop-label', offset: [0, -6] });
                    allStops.push({ layer: marker, latlng: latlng });
                }
            }
        });
        
        document.getElementById('loading').style.display = 'none';
        if (isRealtimeMode) toggleRealtimeMode(true);
        else if (initialRoute) highlightRoute(initialRoute);
        else renderVisibleElements();
    });

function renderVisibleElements() {
    const bounds = map.getBounds().pad(0.1);
    allBadges.forEach(badge => {
        const isFocused = !activeRouteGroup || activeRouteGroup === badge.group;
        if (!isRealtimeMode && isFocused && bounds.contains(badge.latlng)) {
            if (!routeBadgesLayer.hasLayer(badge.layer)) routeBadgesLayer.addLayer(badge.layer);
        } else routeBadgesLayer.removeLayer(badge.layer);
    });
    if (map.getZoom() >= 15) {
        allStops.forEach(stop => {
            if (bounds.contains(stop.latlng)) { if (!stopsLayer.hasLayer(stop.layer)) stopsLayer.addLayer(stop.layer); } 
            else { stopsLayer.removeLayer(stop.layer); }
        });
    } else stopsLayer.clearLayers();
}

map.on('moveend', function() { renderVisibleElements(); updateURL(); });
map.on('zoomend', function() { renderVisibleElements(); updateAllBadgeSizes(); updateURL(); });


// --- MODÁLNÍ OKNA A JÍZDNÍ ŘÁDY ---

// Tuto funkci zavolá tlačítko v krajském HTML, které jsme pomocí Regexu upravili
window.openTimetable = async function(vehicleId) {
    document.getElementById('timetable-modal-content').innerHTML = "<div class='has-text-centered'>Načítám jízdní řád...</div>";
    document.getElementById('timetable-modal').classList.remove('hidden');
    
    try {
        let rawHtml = await fetchKrajskeHtml(`https://mapavdv.kr-vysocina.cz/Ajax/GetTimetable?vehicleNumber=${vehicleId}&currentStopId=0`);
        // Přepíšeme krajské funkce na naše zavírací
        let cleanHtml = rawHtml.replace(/inflow\.InfoWindow\.closeTimetable\(\)/g, 'closeTimetable()');
        document.getElementById('timetable-modal-content').innerHTML = cleanHtml;
    } catch(e) {
        document.getElementById('timetable-modal-content').innerHTML = "<div class='has-text-centered'>Chyba při načítání jízdního řádu.</div>";
    }
};

window.closeTimetable = function() {
    document.getElementById('timetable-modal').classList.add('hidden');
};

// Logika kliknutí na vozidlo
async function handleVehicleClick(v) {
    selectedVehicleId = v.id;
    updateURL();

    // 1. Zvýrazníme trasu na mapě (získáme číslo linky)
    const shortLine = v.text.replace(/\D/g, ''); 
    highlightRoute(shortLine);

    // 2. Stáhneme HTML pro Info Window
    let rawHtml = await fetchKrajskeHtml(`https://mapavdv.kr-vysocina.cz/Ajax/OpenInfoWindow?id=${v.id}`);
    
    // Přepíšeme krajské onclick na naše openTimetable(id)
    let cleanHtml = rawHtml.replace(/inflow\.InfoWindow\.loadTimetable\((\d+),\s*\d+\)/g, 'openTimetable($1)');

    const isMobile = window.innerWidth <= 768;

    if (isMobile) {
        // Na mobilu zobrazíme spodní lištu
        const bar = document.getElementById('mobile-bottom-bar');
        document.getElementById('mobile-bar-content').innerHTML = cleanHtml;
        bar.classList.remove('hidden');
        
        // Kliknutí kamkoliv na lištu (kromě tlačítka) otevře rovnou jízdní řád
        bar.onclick = function(e) {
            if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'I') {
                openTimetable(v.id);
            }
        };
    } else {
        // Na PC otevřeme klasický Leaflet Popup přímo nad bodem
        L.popup()
            .setLatLng([v.lat, v.lng])
            .setContent(cleanHtml)
            .openOn(map);
    }
}


// --- ENGINE PRO ŽIVÁ VOZIDLA ---
async function fetchLiveVehicles() {
    if (!isRealtimeMode) return;
    
    try {
        const response = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent('https://mapavdv.kr-vysocina.cz/Ajax/GetPoints')}`);
        const data = await response.json();

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
            
            let delayClass = 'delay-ok';
            if (v.delay === -2147483648) delayClass = 'delay-unknown';
            else if (v.delay > 0 && v.delay <= 9) delayClass = 'delay-warn';
            else if (v.delay >= 10) delayClass = 'delay-alert';

            // Získáme jen číslice (např. 842117 -> 117)
            const shortLine = v.text.replace(/\D/g, '').slice(-3) || "??";

            const iconHtml = `<div class="live-vehicle ${shapeClass} ${delayClass}">${shortLine}</div>`;

            if (liveVehicleMarkers[v.id]) {
                liveVehicleMarkers[v.id].setLatLng([v.lat, v.lng]);
                liveVehicleMarkers[v.id].setIcon(L.divIcon({ className: '', html: iconHtml, iconSize: [28, 28], iconAnchor: [14, 14] }));
            } else {
                const marker = L.marker([v.lat, v.lng], { icon: L.divIcon({ className: '', html: iconHtml, iconSize: [28, 28], iconAnchor: [14, 14] }) });
                
                // Událost pro kliknutí na vozidlo
                marker.on('click', function() {
                    handleVehicleClick(v);
                });

                liveVehiclesLayer.addLayer(marker);
                liveVehicleMarkers[v.id] = marker;
            }

            // Pokud jsme web načetli s &id=... v URL a našli jsme to vozidlo, automaticky na něj klikneme
            if (selectedVehicleId === v.id && !document.getElementById('mobile-bottom-bar').classList.contains('hidden') === false) {
                handleVehicleClick(v);
            }
        });
    } catch (e) {
        console.error("Chyba RT dat:", e);
    }
}
