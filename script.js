// --- 1. GLOBÁLNÍ PROMĚNNÉ A ČTENÍ URL ---
let startZoom = 10;
let startLat = 49.4;
let startLng = 15.6;
let initialRoute = null;
let isRealtimeMode = false;
let selectedVehicleId = null;
let rtInterval = null;

const urlParams = new URLSearchParams(window.location.search);
if (urlParams.has('z')) startZoom = parseInt(urlParams.get('z'), 10);
if (urlParams.has('y')) startLat = parseFloat(urlParams.get('y'));
if (urlParams.has('x')) startLng = parseFloat(urlParams.get('x'));
if (urlParams.has('line')) initialRoute = urlParams.get('line');
if (urlParams.has('rt') && urlParams.get('rt') === '1') isRealtimeMode = true;
if (urlParams.has('id')) selectedVehicleId = parseInt(urlParams.get('id'), 10);

// --- 2. INICIALIZACE MAPY ---
const initialMaxZoom = isRealtimeMode ? 19 : 15;
const map = L.map('map', { preferCanvas: true, minZoom: 10, maxZoom: initialMaxZoom }).setView([startLat, startLng], startZoom); 

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { 
    attribution: '© OpenStreetMap © CARTO', minZoom: 10, maxZoom: 19, maxNativeZoom: 19
}).addTo(map);

const linesLayer = L.layerGroup().addTo(map);
const routeBadgesLayer = L.layerGroup().addTo(map); 
const stopsLayer = L.layerGroup().addTo(map); 
const tripRouteLayer = L.layerGroup().addTo(map); 
const liveVehiclesLayer = L.layerGroup().addTo(map);

let allBadges = [];
let allStops = [];
let liveVehicleMarkers = {}; 
let activeRouteGroup = null;

async function fetchKrajskeHtml(url) {
    const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(url)}`;
    const res = await fetch(proxyUrl);
    if (!res.ok) throw new Error("Chyba při stahování HTML");
    return await res.text();
}

// --- 3. EXTRÉMNĚ CHYTRÁ NORMALIZACE NÁZVŮ (Řeší zkratky a řeky) ---
function normalizeStopName(name) {
    // 1. Odstranění diakritiky (háčky, čárky) a převod na malá písmena
    let s = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    
    // 2. Nahrazení interpunkce mezerami (rozsekne to tvé n.Osl. -> n osl)
    s = s.replace(/[,.-]/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    
    // 3. Rozbalení víceslovných frází
    s = s.replace(/\baut nadr\b/g, 'autobusovenadrazi');
    s = s.replace(/\baut nadrazi\b/g, 'autobusovenadrazi');
    s = s.replace(/\bzel st\b/g, 'zeleznicnistanice');
    
    // 4. Slovník samostatných zkratek
    const dict = {
        'nam': 'namesti',
        'rozc': 'rozcesti',
        'zast': 'zastavka',
        'sidl': 'sidliste',
        'nem': 'nemocnice',
        'nemoc': 'nemocnice',
        'vyzk': 'vyzkumny',
        'ust': 'ustav',
        'n': 'nad',
        'p': 'pod',
        'm': 'mesto',
        'saz': 'sazavou',
        'osl': 'oslavou',
        'doubr': 'doubravou',
        'bystr': 'bystrici',
        'mor': 'morave',
        'l': 'labem',
        'vlt': 'vltavou'
    };

    // Složení zpět do jednoho "slepence" bez mezer
    let words = s.split(' ').map(w => dict[w] || w);
    return words.join('');
}

function getDistanceToLines(latlng, multiLineCoords) {
    if (!multiLineCoords || multiLineCoords.length === 0) return Infinity;
    let minDist = Infinity;
    for (let line of multiLineCoords) {
        for (let pt of line) {
            let d = latlng.distanceTo(L.latLng(pt[1], pt[0]));
            if (d < minDist) minDist = d;
        }
    }
    return minDist;
}

// Chytřejší vyhledávání zastávky (S podporou částečné shody)
function findBestStop(normName, multiLineCoords, previousLatLng) {
    // 1. Přesná shoda po normalizaci (např. zdarnadsazavouautobusovenadrazi)
    let candidates = allStops.filter(s => s.normalized === normName);
    
    // 2. Záchranné kolo (Fallback): Jeden zdroj má méně slov než druhý
    if (candidates.length === 0) {
        candidates = allStops.filter(s => 
            (s.normalized.includes(normName) || normName.includes(s.normalized)) && 
            s.normalized.length > 5 && normName.length > 5
        );
    }

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0].latlng;

    // 3. Záchranné kolo 2: Stejnojmenné obce, rozhodne blízskost k trase
    let bestCandidate = null;
    let minScore = Infinity;

    for (let c of candidates) {
        let score = Infinity;
        if (multiLineCoords && multiLineCoords.length > 0) {
            score = getDistanceToLines(c.latlng, multiLineCoords);
        } else if (previousLatLng) {
            score = c.latlng.distanceTo(previousLatLng);
        }

        if (score < minScore) {
            minScore = score;
            bestCandidate = c.latlng;
        }
    }
    return bestCandidate || candidates[0].latlng;
}

function getPathBetweenStops(latlngA, latlngB, multiLineCoords) {
    let bestPath = null;
    let minError = Infinity;

    for (let line of multiLineCoords) {
        let idxA = -1, idxB = -1;
        let MathMinA = Infinity, MathMinB = Infinity;

        for (let i = 0; i < line.length; i++) {
            let pt = L.latLng(line[i][1], line[i][0]);
            let dA = pt.distanceTo(latlngA);
            let dB = pt.distanceTo(latlngB);

            if (dA < MathMinA) { MathMinA = dA; idxA = i; }
            if (dB < MathMinB) { MathMinB = dB; idxB = i; }
        }

        if (MathMinA < 500 && MathMinB < 500 && idxA !== -1 && idxB !== -1) {
            let error = MathMinA + MathMinB;
            if (error < minError) {
                minError = error;
                let path = [];
                if (idxA <= idxB) {
                    for (let k = idxA; k <= idxB; k++) path.push(L.latLng(line[k][1], line[k][0]));
                } else {
                    for (let k = idxA; k >= idxB; k--) path.push(L.latLng(line[k][1], line[k][0]));
                }
                bestPath = path;
            }
        }
    }
    return bestPath; 
}

// --- 4. AKTUALIZACE URL A UI ---
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
    if (activeRouteGroup !== null && !selectedVehicleId) highlightRoute(null);
    if (selectedVehicleId !== null) {
        selectedVehicleId = null;
        tripRouteLayer.clearLayers();
        if (isRealtimeMode) highlightRoute(null);
        updateURL();
        const bottomBar = document.getElementById('mobile-bottom-bar');
        if(bottomBar) bottomBar.classList.add('hidden');
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

// --- 5. PŘEPÍNAČ ŽIVÉ MAPY ---
function toggleRealtimeMode(forceState = null) {
    isRealtimeMode = forceState !== null ? forceState : !isRealtimeMode;
    const btn = document.getElementById('rt-btn');
    
    if (isRealtimeMode) {
        map.setMaxZoom(19);
        if(btn) btn.classList.add('active');
        if(!selectedVehicleId) highlightRoute(null);
        fetchLiveVehicles();
        rtInterval = setInterval(fetchLiveVehicles, 10000);
    } else {
        map.setMaxZoom(15);
        if (map.getZoom() > 15) map.setZoom(15);
        
        if(btn) btn.classList.remove('active');
        clearInterval(rtInterval);
        liveVehiclesLayer.clearLayers();
        tripRouteLayer.clearLayers();
        liveVehicleMarkers = {};
        
        const bottomBar = document.getElementById('mobile-bottom-bar');
        if(bottomBar) bottomBar.classList.add('hidden');
        selectedVehicleId = null;
        
        highlightRoute(initialRoute || null); 
    }
    updateURL();
}

if(document.getElementById('rt-btn')) {
    document.getElementById('rt-btn').addEventListener('click', () => toggleRealtimeMode());
}

// --- 6. NAČÍTÁNÍ GEOJSON DAT ---
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
                    layer.on('click', function(e) { 
                        L.DomEvent.stopPropagation(e); 
                        if(!isRealtimeMode) highlightRoute(activeRouteGroup === props.group ? null : props.group); 
                    });
                    linesLayer.addLayer(layer);
                } else if (props.type === "badge") {
                    const latlng = L.latLng(feature.geometry.coordinates[1], feature.geometry.coordinates[0]);
                    const badgeTooltip = L.tooltip(latlng, { permanent: true, direction: 'center', className: 'route-map-badge', interactive: true }).setContent(props.group);
                    badgeTooltip.on('add', function(e) {
                        const el = e.target.getElement();
                        el.style.borderColor = props.color; el.style.cursor = 'pointer'; el.style.pointerEvents = 'auto';
                        el.onclick = function(domEvent) { 
                            domEvent.stopPropagation(); 
                            if(!isRealtimeMode) highlightRoute(activeRouteGroup === props.group ? null : props.group); 
                        };
                        adjustBadgeSize(el, map.getZoom());
                    });
                    allBadges.push({ layer: badgeTooltip, latlng: latlng, group: props.group });
                } else if (props.type === "stop" && props.show_label) {
                    const latlng = L.latLng(feature.geometry.coordinates[1], feature.geometry.coordinates[0]);
                    const marker = L.circleMarker(latlng, { radius: 4, color: '#fff', weight: 1.5, fillColor: '#58d68d', fillOpacity: 1 })
                        .bindTooltip(`<span class="stop-dot"></span><span>${props.name}</span><span class="stop-zone-text">${props.zones_formatted}</span>`, { permanent: true, direction: 'top', className: 'modern-stop-label', offset: [0, -6] });
                    
                    allStops.push({ layer: marker, latlng: latlng, name: props.name, normalized: normalizeStopName(props.name) });
                }
            }
        });
        
        document.getElementById('loading').style.display = 'none';
        
        if (isRealtimeMode) toggleRealtimeMode(true);
        else if (initialRoute) highlightRoute(initialRoute);
        else renderVisibleElements();
    })
    .catch(error => console.error("GeoJSON Error:", error));

// --- 7. RENDEROVACÍ LOOP ---
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

// --- 8. GPS LOKALIZACE ---
let userMarker = null;
const locateBtn = document.getElementById('locate-btn');
if(locateBtn) locateBtn.addEventListener('click', () => map.locate({ setView: true, maxZoom: 16 }));
map.on('locationfound', function(e) {
    if (!userMarker) userMarker = L.circleMarker(e.latlng, { radius: 7, color: '#fff', weight: 2, fillColor: '#3388ff', fillOpacity: 1 }).addTo(map);
    else userMarker.setLatLng(e.latlng);
});


// --- 9. MODÁLNÍ OKNA A DETAIL SPOJE ---
window.openTimetable = async function(vehicleId, delayInMinutes) {
    document.getElementById('timetable-modal-content').innerHTML = "<div class='has-text-centered'>Načítám jízdní řád...</div>";
    document.getElementById('timetable-modal').classList.remove('hidden');
    
    try {
        let rawHtml = await fetchKrajskeHtml(`https://mapavdv.kr-vysocina.cz/Ajax/GetTimetable?vehicleNumber=${vehicleId}&currentStopId=0`);
        let cleanHtml = rawHtml.replace(/inflow\.InfoWindow\.closeTimetable\(\)/g, 'closeTimetable()');
        
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = cleanHtml;
        
        if (delayInMinutes !== undefined && delayInMinutes !== null && delayInMinutes !== -2147483648) {
            const headerRight = tempDiv.querySelector('.level-right .level-item');
            if (headerRight) {
                let delayClass = delayInMinutes >= 10 ? 'delay-alert-text' : (delayInMinutes > 0 ? 'delay-warn-text' : 'delay-ok-text');
                let delayText = delayInMinutes > 0 ? `+${delayInMinutes} min` : (delayInMinutes < 0 ? `${Math.abs(delayInMinutes)} min náskok` : 'Na čas');
                
                const delaySpan = document.createElement('span');
                delaySpan.style.marginLeft = "15px";
                delaySpan.innerHTML = `Zpoždění: <b class="${delayClass}">${delayText}</b>`;
                headerRight.appendChild(delaySpan);
            }
            
            if (delayInMinutes !== 0) {
                const timeCells = tempDiv.querySelectorAll('td.has-text-centered');
                timeCells.forEach(cell => {
                    const timeMatch = cell.innerText.match(/^(\d{1,2}):(\d{2})$/);
                    if (timeMatch) {
                        let h = parseInt(timeMatch[1], 10);
                        let m = parseInt(timeMatch[2], 10);
                        let totalMin = h * 60 + m + delayInMinutes;
                        if (totalMin < 0) totalMin += 24 * 60; 
                        let newH = Math.floor(totalMin / 60) % 24;
                        let newM = totalMin % 60;
                        let newTimeStr = `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
                        let colorClass = delayInMinutes >= 10 ? 'delay-alert-text' : (delayInMinutes > 0 ? 'delay-warn-text' : 'delay-ok-text');
                        cell.innerHTML = `<s style="color:#666; font-size: 11px; margin-right: 4px;">${cell.innerText}</s><span class="${colorClass}">${newTimeStr}</span>`;
                    }
                });
            }
        }
        document.getElementById('timetable-modal-content').innerHTML = tempDiv.innerHTML;
    } catch(e) {
        document.getElementById('timetable-modal-content').innerHTML = "<div class='has-text-centered'>Chyba při načítání jízdního řádu.</div>";
    }
};

window.closeTimetable = function() {
    document.getElementById('timetable-modal').classList.add('hidden');
};

async function handleVehicleClick(v) {
    selectedVehicleId = v.id;
    updateURL();
    highlightRoute(null);

    const isTrain = v.traction === 'TRAIN';
    const routeToHighlight = isTrain ? v.text : v.text.replace(/\D/g, '').slice(-3); 

    try {
        const [infoRaw, timetableRaw] = await Promise.all([
            fetchKrajskeHtml(`https://mapavdv.kr-vysocina.cz/Ajax/OpenInfoWindow?id=${v.id}`),
            fetchKrajskeHtml(`https://mapavdv.kr-vysocina.cz/Ajax/GetTimetable?vehicleNumber=${v.id}&currentStopId=0`)
        ]);

        let multiLineCoords = [];
        linesLayer.eachLayer(layer => {
            if (layer.feature.properties.group === routeToHighlight) {
                multiLineCoords = layer.feature.geometry.coordinates;
            }
        });

        const parser = new DOMParser();
        const doc = parser.parseFromString(timetableRaw, 'text/html');
        const stopCells = doc.querySelectorAll('tbody tr td:first-child');
        
        let stopCoords = [];
        let previousLatLng = null;

        stopCells.forEach(cell => {
            const normName = normalizeStopName(cell.innerText);
            // ZDE JE TO KOUZLO S NOVOU CHYTROU FUNKCÍ
            const bestLatLng = findBestStop(normName, multiLineCoords, previousLatLng);
            
            if (bestLatLng) {
                stopCoords.push(bestLatLng);
                previousLatLng = bestLatLng;
            }
        });

        tripRouteLayer.clearLayers();
        if (stopCoords.length > 1) {
            let finalTripCoords = [stopCoords[0]];
            for (let i = 0; i < stopCoords.length - 1; i++) {
                let A = stopCoords[i];
                let B = stopCoords[i+1];
                let roadPath = getPathBetweenStops(A, B, multiLineCoords);
                if (roadPath) finalTripCoords.push(...roadPath);
                else finalTripCoords.push(B); 
            }

            const polyline = L.polyline(finalTripCoords, { 
                color: '#00e5ff',     
                weight: 5, 
                opacity: 1,
                lineCap: 'round', 
                lineJoin: 'round'
            });
            tripRouteLayer.addLayer(polyline);
        }

        let cleanHtml = infoRaw.replace(/inflow\.InfoWindow\.loadTimetable\((-?\d+),\s*-?\d+\)/g, `openTimetable($1, ${v.delay})`);

        if (window.innerWidth <= 768) {
            const bar = document.getElementById('mobile-bottom-bar');
            document.getElementById('mobile-bar-content').innerHTML = cleanHtml;
            bar.classList.remove('hidden');
            bar.onclick = function(e) {
                if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'I' && !e.target.closest('button')) {
                    openTimetable(v.id, v.delay);
                }
            };
        } else {
            L.popup().setLatLng([v.lat, v.lng]).setContent(cleanHtml).openOn(map);
        }
    } catch(e) {
        console.error("Nelze načíst detail vozidla", e);
    }
}

// --- 10. ENGINE PRO ŽIVÁ VOZIDLA ---
async function fetchLiveVehicles() {
    if (!isRealtimeMode) return;
    try {
        const timestamp = new Date().getTime();
        const targetUrl = `https://mapavdv.kr-vysocina.cz/Ajax/GetPoints?t=${timestamp}`;
        const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`;
        
        const response = await fetch(proxyUrl);
        if (!response.ok) throw new Error(`Chyba serveru: ${response.status}`);

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

            let innerContent = isTrain ? `
                <svg viewBox="0 0 24 24" width="16" height="16" fill="#111" style="margin-top: 2px;">
                    <path d="M12 2C8 2 4 2.5 4 6v9.5C4 17.4 5.6 19 7.5 19L6 20.5v.5h2.2l1.5-1.5h4.6l1.5 1.5h2.2v-.5L16.5 19c1.9 0 3.5-1.6 3.5-3.5V6c0-3.5-4-4-8-4zm0 2c3.5 0 5.5.5 5.5 2s-2 2-5.5 2-5.5-.5-5.5-2 2-2 5.5-2zm-3.5 11c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm7 0c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zM12 11c-3.9 0-6-1.5-6-1.5V7.5S8.1 9 12 9s6-1.5 6-1.5v2s-2.1 1.5-6 1.5z"/>
                </svg>` : (v.text.replace(/\D/g, '').slice(-3) || "??");

            const iconHtml = `<div class="live-vehicle ${shapeClass} ${delayClass}">${innerContent}</div>`;

            if (liveVehicleMarkers[v.id]) {
                liveVehicleMarkers[v.id].setLatLng([v.lat, v.lng]);
                liveVehicleMarkers[v.id].setIcon(L.divIcon({ className: '', html: iconHtml, iconSize: [28, 28], iconAnchor: [14, 14] }));
                liveVehicleMarkers[v.id].off('click');
                liveVehicleMarkers[v.id].on('click', () => handleVehicleClick(v));
            } else {
                const marker = L.marker([v.lat, v.lng], { icon: L.divIcon({ className: '', html: iconHtml, iconSize: [28, 28], iconAnchor: [14, 14] }) });
                marker.on('click', () => handleVehicleClick(v));
                liveVehiclesLayer.addLayer(marker);
                liveVehicleMarkers[v.id] = marker;
            }

            if (selectedVehicleId === v.id && document.getElementById('mobile-bottom-bar') && document.getElementById('mobile-bottom-bar').classList.contains('hidden')) {
                handleVehicleClick(v);
            }
        });
    } catch (e) {
        console.error("Chyba RT dat:", e);
    }
}
