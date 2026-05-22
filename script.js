let startZoom = 10;
let startLat = 49.4;
let startLng = 15.6;
let isRealtimeMode = false;
let selectedVehicleId = null;
let isTimetableOpen = false;
let rtInterval = null;
let initialLoadAutoClickDone = false; 
let isFetchingVehicles = false; 

// Pole pro uložení jedné nebo vícero linek z URL
let activeRouteGroups = [];

const urlParams = new URLSearchParams(window.location.search);

// Výchozí chování: Pokud je URL čistá (bez parametrů), rovnou spustíme Realtime režim!
if (!window.location.search || window.location.search === '?') {
    isRealtimeMode = true;
} else {
    if (urlParams.has('z')) startZoom = parseFloat(urlParams.get('z'));
    if (urlParams.has('y')) startLat = parseFloat(urlParams.get('y'));
    if (urlParams.has('x')) startLng = parseFloat(urlParams.get('x'));
    if (urlParams.has('line')) activeRouteGroups = urlParams.getAll('line'); 
    if (urlParams.has('rt') && urlParams.get('rt') === '1') isRealtimeMode = true;
    if (urlParams.has('id')) selectedVehicleId = urlParams.get('id'); 
    if (urlParams.has('tt') && urlParams.get('tt') === '1') isTimetableOpen = true;
}

let geojsonData = null;
let allStops = [];
let tripShapes = {}; 
let trainStopsMap = {}; 

function getShortLine(text) {
    const s = String(text || '').replace(/\D/g, '').slice(-3);
    return s ? parseInt(s, 10).toString() : "??";
}

// --- 0. WIKIDATA API PRO UIC KÓDY STANIC ---
const uicCache = {};
async function getStationNameByUIC(uic) {
    if (uicCache[uic]) return uicCache[uic];
    try {
        const query = `SELECT ?itemLabel WHERE { ?item wdt:P722 "${uic}". SERVICE wikibase:label { bd:serviceParam wikibase:language "cs". } }`;
        const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}&format=json`;
        const res = await fetch(url, { headers: { 'Accept': 'application/sparql-results+json' }});
        if (res.ok) {
            const data = await res.json();
            if (data.results.bindings.length > 0) {
                uicCache[uic] = data.results.bindings[0].itemLabel.value;
                return uicCache[uic];
            }
        }
    } catch (e) { console.warn("Chyba při dotazu na Wikidata:", e); }
    uicCache[uic] = uic; 
    return uic;
}

// --- 1. INICIALIZACE MAPLIBRE (WEBGL) ---
const initialMaxZoom = isRealtimeMode ? 19 : 15;
const map = new maplibregl.Map({
    container: 'map',
    style: {
        version: 8,
        glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
        sources: {
            'carto-dark': {
                type: 'raster',
                tiles: ['https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'],
                tileSize: 256
            }
        },
        layers: [{ id: 'carto-dark-layer', type: 'raster', source: 'carto-dark' }]
    },
    center: [startLng, startLat],
    zoom: startZoom,
    maxZoom: initialMaxZoom
});

async function fetchKrajskeHtml(url) {
    // Pro Krajské API se vracíme k bleskovému corsproxy.io
    const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(url)}`;
    const res = await fetch(proxyUrl);
    if (!res.ok) throw new Error("Chyba při stahování HTML");
    return await res.text();
}

function fixCommasInHtml(htmlString) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = htmlString;
    const walker = document.createTreeWalker(tempDiv, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while ((node = walker.nextNode())) {
        if (node.nodeValue.trim() !== '') {
            node.nodeValue = node.nodeValue.replace(/,(?=[^\s])/g, ', ');
        }
    }
    return tempDiv.innerHTML;
}

function removeWheelchairInfo(tempDiv) {
    tempDiv.querySelectorAll('tr, .level, .columns, li, p').forEach(el => {
        if (el && el.textContent) {
            const txt = el.textContent.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            if (txt.includes('bezbari')) {
                el.remove();
            }
        }
    });
}

function getDistance(pt1, pt2) {
    const dx = pt1[0] - pt2[0], dy = pt1[1] - pt2[1];
    return Math.sqrt(dx*dx + dy*dy) * 111000;
}

function normalizeStopName(name) {
    let s = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    s = s.replace(/[,.\-\/]/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/\bn mor\b/g, 'na morave');
    s = s.replace(/\bn morave\b/g, 'na morave');
    s = s.replace(/\baut nadr\b/g, 'autobusovenadrazi');
    s = s.replace(/\baut nadrazi\b/g, 'autobusovenadrazi');
    s = s.replace(/\bzel st\b/g, 'zeleznicnistanice');
    s = s.replace(/\bz st\b/g, 'zeleznicnistanice');
    
    const dict = {
        'nam': 'namesti', 'rozc': 'rozcesti', 'zast': 'zastavka', 'sidl': 'sidliste',
        'nem': 'nemocnice', 'nemoc': 'nemocnice', 'vyzk': 'vyzkumny', 'ust': 'ustav',
        'n': 'nad', 'p': 'pod', 'm': 'mesto', 'saz': 'sazavou', 'osl': 'oslavou',
        'doubr': 'doubravou', 'bystr': 'bystrici', 'mor': 'morave', 'l': 'labem', 'vlt': 'vltavou',
        'odb': 'odbocka', 'st': 'stanice', 'zel': 'zeleznicni', 'aut': 'autobusove', 'nadr': 'nadrazi',
        'stred': 'stredisko', 'zs': 'zakladniskola', 'u': 'u'
    };
    return s.split(' ').map(w => dict[w] || w).join(' ');
}

function getDistanceToLines(coord, multiLineCoords) {
    if (!multiLineCoords || multiLineCoords.length === 0) return Infinity;
    let minDist = Infinity;
    for (let line of multiLineCoords) {
        for (let pt of line) {
            let d = getDistance(coord, pt);
            if (d < minDist) minDist = d;
        }
    }
    return minDist;
}

function findBestStop(normName, multiLineCoords, previousCoord) {
    let candidates = allStops.filter(s => s.normalized === normName);
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0].coords;

    let bestCandidate = null;
    let minScore = Infinity;
    for (let c of candidates) {
        let score = Infinity;
        if (multiLineCoords && multiLineCoords.length > 0) score = getDistanceToLines(c.coords, multiLineCoords);
        else if (previousCoord) score = getDistance(c.coords, previousCoord);
        if (score < minScore) { minScore = score; bestCandidate = c.coords; }
    }
    return bestCandidate || candidates[0].coords;
}

function getPathBetweenStops(coordA, coordB, multiLineCoords) {
    let bestPath = null;
    let minError = Infinity;
    for (let line of multiLineCoords) {
        let idxA = -1, idxB = -1;
        let MathMinA = Infinity, MathMinB = Infinity;
        for (let i = 0; i < line.length; i++) {
            let pt = line[i];
            let dA = getDistance(pt, coordA);
            let dB = getDistance(pt, coordB);
            if (dA < MathMinA) { MathMinA = dA; idxA = i; }
            if (dB < MathMinB) { MathMinB = dB; idxB = i; }
        }
        if (MathMinA < 500 && MathMinB < 500 && idxA !== -1 && idxB !== -1) {
            let error = MathMinA + MathMinB;
            if (error < minError) {
                minError = error;
                let path = [];
                if (idxA <= idxB) { for (let k = idxA; k <= idxB; k++) path.push(line[k]); } 
                else { for (let k = idxA; k >= idxB; k--) path.push(line[k]); }
                bestPath = path;
            }
        }
    }
    return bestPath; 
}

function updateURL() {
    const center = map.getCenter();
    const params = new URLSearchParams();
    params.set('x', center.lng.toFixed(4));
    params.set('y', center.lat.toFixed(4));
    params.set('z', map.getZoom().toFixed(1));
    if (isRealtimeMode) params.set('rt', '1');
    
    if (activeRouteGroups.length > 0) {
        activeRouteGroups.forEach(g => params.append('line', g));
    }
    
    if (selectedVehicleId) params.set('id', selectedVehicleId);
    if (isTimetableOpen) params.set('tt', '1');
    window.history.replaceState(null, '', window.location.pathname + '?' + params.toString());
}

map.on('moveend', updateURL);
map.on('zoomend', updateURL);

// --- 2. VYKRESLOVÁNÍ GRAFIKY ROVNOU DO PAMĚTI KARTY ---
const PIXEL_RATIO = 2; 

function getBadgeIcon(group, color) {
    const id = `badge-${group}-${color}`;
    if (map.hasImage(id)) return id;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 13px "Open Sans", Arial, sans-serif';
    
    const textWidth = ctx.measureText(group).width;
    const width = Math.max(textWidth + 14, 24); 
    const height = 24;

    canvas.width = width * PIXEL_RATIO; 
    canvas.height = height * PIXEL_RATIO;
    ctx.scale(PIXEL_RATIO, PIXEL_RATIO);
    
    ctx.fillStyle = 'rgba(20, 20, 20, 0.95)';
    ctx.beginPath();
    const r = 6;
    ctx.moveTo(r, 1);
    ctx.lineTo(width - r, 1);
    ctx.quadraticCurveTo(width - 1, 1, width - 1, r);
    ctx.lineTo(width - 1, height - r);
    ctx.quadraticCurveTo(width - 1, height - 1, width - r, height - 1);
    ctx.lineTo(r, height - 1);
    ctx.quadraticCurveTo(1, height - 1, 1, height - r);
    ctx.lineTo(1, r);
    ctx.quadraticCurveTo(1, 1, r, 1);
    ctx.closePath();
    ctx.fill();

    ctx.lineWidth = 2; 
    ctx.strokeStyle = color; 
    ctx.stroke();

    ctx.font = 'bold 13px "Open Sans", Arial, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(group, width / 2, height / 2 + 1.5);

    map.addImage(id, ctx.getImageData(0, 0, width * PIXEL_RATIO, height * PIXEL_RATIO), { pixelRatio: PIXEL_RATIO });
    return id;
}

function getVehicleIcon(delayClass, label, isTrain, isNonVDV = false) {
    const id = `v-${delayClass}-${label}-${isTrain ? 't' : 'b'}-${isNonVDV ? 'nvdv' : 'vdv'}`;
    if (map.hasImage(id)) return id;

    const size = 30;
    const canvas = document.createElement('canvas');
    canvas.width = size * PIXEL_RATIO; 
    canvas.height = size * PIXEL_RATIO;
    const ctx = canvas.getContext('2d');
    ctx.scale(PIXEL_RATIO, PIXEL_RATIO);

    let bgColor = '#58d68d'; let textColor = '#111'; 
    let borderColor = isNonVDV ? '#3498db' : '#fff'; 
    
    if (delayClass === 'unknown') { bgColor = '#7f8c8d'; textColor = '#fff'; }
    else if (delayClass === 'warn') bgColor = '#f39c12';
    else if (delayClass === 'alert') { bgColor = '#e74c3c'; textColor = '#fff'; }
    else if (delayClass === 'dim') { 
        bgColor = '#1a2530'; 
        borderColor = isNonVDV ? '#2980b9' : '#2c3e50'; 
        textColor = '#5dade2'; 
    }

    ctx.beginPath();
    if (isTrain) {
        const br = 6; const s = 26; const offset = 2;
        ctx.moveTo(offset + br, offset);
        ctx.lineTo(offset + s - br, offset);
        ctx.quadraticCurveTo(offset + s, offset, offset + s, offset + br);
        ctx.lineTo(offset + s, offset + s - br);
        ctx.quadraticCurveTo(offset + s, offset + s, offset + s - br, offset + s);
        ctx.lineTo(offset + br, offset + s);
        ctx.quadraticCurveTo(offset, offset + s, offset, offset + s - br);
        ctx.lineTo(offset, offset + br);
        ctx.quadraticCurveTo(offset, offset, offset + br, offset);
        ctx.closePath();
    } else {
        ctx.arc(size/2, size/2, 13, 0, Math.PI * 2);
    }
    
    ctx.fillStyle = bgColor; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = borderColor; ctx.stroke();

    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    if (isTrain) {
        ctx.font = 'bold 15px "Open Sans", Arial, sans-serif';
        ctx.fillText('V', size/2, size/2 + 1);
    } else {
        ctx.font = 'bold 12px "Open Sans", Arial, sans-serif';
        ctx.fillText(label, size/2, size/2 + 1);
    }

    map.addImage(id, ctx.getImageData(0, 0, size * PIXEL_RATIO, size * PIXEL_RATIO), { pixelRatio: PIXEL_RATIO });
    return id;
}

// --- 3. NAČÍTÁNÍ DAT A PŘÍPRAVA VRSTEV ---
map.on('load', async () => {
    
    try {
        const r = await fetch('spoje.json?t=' + new Date().getTime());
        if (r.ok) tripShapes = await r.json();
    } catch (e) {
        console.warn("spoje.json nenalezen", e);
    }

    try {
        const zRes = await fetch('zeleznice.txt?t=' + new Date().getTime());
        if (zRes.ok) {
            const zText = await zRes.text();
            try {
                const zData = JSON.parse(zText);
                if (Array.isArray(zData)) {
                    zData.forEach(item => {
                        const n = item.name || item.stop_name || item.Name || item.stanice;
                        const lat = item.lat || item.stop_lat || item.Lat;
                        const lon = item.lon || item.lng || item.stop_lon || item.Lon;
                        if (n && lat && lon) trainStopsMap[n] = [parseFloat(lon), parseFloat(lat)];
                    });
                } else {
                    for (let key in zData) {
                        let c = zData[key];
                        if (c[0] > 40) trainStopsMap[key] = [c[1], c[0]]; 
                        else trainStopsMap[key] = [c[0], c[1]];
                    }
                }
            } catch(e) {
                zText.split('\n').forEach(line => {
                    const parts = line.split(/[;,]/);
                    if (parts.length >= 3) {
                        const name = parts[0].replace(/"/g, '').trim();
                        const p1 = parseFloat(parts[1]);
                        const p2 = parseFloat(parts[2]);
                        if (!isNaN(p1) && !isNaN(p2)) {
                            if (p1 > 40) trainStopsMap[name] = [p2, p1];
                            else trainStopsMap[name] = [p1, p2];
                        }
                    }
                });
            }
        }
    } catch(e) { console.warn("zeleznice.txt pro vlaky nenalezeno", e); }

    try {
        const resZelGeo = await fetch('zeleznice.geojson?t=' + new Date().getTime());
        if (resZelGeo.ok) {
            const zelGeoData = await resZelGeo.json();
            map.addSource('zeleznice-trasy', { type: 'geojson', data: zelGeoData });
            map.addLayer({
                id: 'zeleznice-layer',
                type: 'line',
                source: 'zeleznice-trasy',
                paint: {
                    'line-color': '#ffffff',
                    'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 15, 5],
                    'line-opacity': 1 
                }
            }); 
        }
    } catch(e) { console.warn("zeleznice.geojson nenalezena", e); }

    try {
        const res = await fetch('trasy.geojson?t=' + new Date().getTime());
        geojsonData = await res.json();
        
        geojsonData.features.forEach(f => {
            if (f.geometry.type === 'Point' && f.properties.type === 'stop') {
                allStops.push({
                    coords: f.geometry.coordinates,
                    name: f.properties.name,
                    normalized: normalizeStopName(f.properties.name)
                });
            }
            if (f.geometry.type === 'Point' && f.properties.type === 'badge') {
                f.properties.group = getShortLine(f.properties.group);
                f.properties.iconId = getBadgeIcon(f.properties.group, f.properties.color);
            }
        });

        map.addSource('trasy', { type: 'geojson', data: geojsonData });

        map.addLayer({
            id: 'lines-layer',
            type: 'line',
            source: 'trasy',
            filter: ['!=', ['geometry-type'], 'Point'], 
            paint: {
                'line-color': ['get', 'color'],
                'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 15, 6],
                'line-opacity': 0.9
            }
        });

        map.addLayer({
            id: 'badges-layer',
            type: 'symbol',
            source: 'trasy',
            filter: ['==', ['get', 'type'], 'badge'],
            layout: {
                'icon-image': ['get', 'iconId'],
                'icon-allow-overlap': false, 
                'icon-ignore-placement': false 
            }
        });

        map.addLayer({
            id: 'stops-layer',
            type: 'circle',
            source: 'trasy',
            minzoom: 14,
            filter: ['==', ['get', 'type'], 'stop'],
            paint: { 'circle-radius': 4, 'circle-color': '#58d68d', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 }
        });

        map.addLayer({
            id: 'stops-text-layer',
            type: 'symbol',
            source: 'trasy',
            minzoom: 14,
            filter: ['all', ['==', ['get', 'type'], 'stop'], ['==', ['get', 'show_label'], true]],
            layout: {
                'text-field': ['get', 'name'],
                'text-size': 12,
                'text-anchor': 'bottom',
                'text-offset': [0, -0.6]
            },
            paint: { 'text-color': '#fff', 'text-halo-color': '#111', 'text-halo-width': 2 }
        });

        map.addSource('trip-route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addLayer({
            id: 'trip-route-layer',
            type: 'line',
            source: 'trip-route',
            paint: { 'line-color': '#00e5ff', 'line-width': 5, 'line-opacity': 1 }
        });

        map.addSource('vehicles', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addLayer({
            id: 'vehicles-layer',
            type: 'symbol',
            source: 'vehicles',
            layout: {
                'icon-image': ['get', 'iconId'],
                'icon-allow-overlap': true,
                'icon-ignore-placement': true
            }
        });

        if (isRealtimeMode) toggleRealtimeMode(true);
        else if (activeRouteGroups.length > 0) highlightRoute(activeRouteGroups);

    } catch(e) { 
        console.error("Kritická chyba při načítání dat mapy:", e); 
    } finally {
        const loader = document.getElementById('loading');
        if (loader) loader.style.display = 'none';
    }
});

function highlightRoute(groups) {
    activeRouteGroups = Array.isArray(groups) ? groups.map(String) : (groups ? [String(groups)] : []);
    
    if (map.getLayer('lines-layer')) {
        if (activeRouteGroups.length === 0) {
            map.setPaintProperty('lines-layer', 'line-opacity', isRealtimeMode ? 0.10 : 0.9);
            map.setPaintProperty('lines-layer', 'line-width', ['interpolate', ['linear'], ['zoom'], 10, 3, 15, 6]);
            map.setPaintProperty('badges-layer', 'icon-opacity', isRealtimeMode ? 0 : 1);
            if (map.getLayer('zeleznice-layer')) map.setPaintProperty('zeleznice-layer', 'line-color', isRealtimeMode ? '#444444' : '#ffffff');
        } else {
            const matchOpacity = ['match', ['to-string', ['get', 'group']]];
            activeRouteGroups.forEach(g => matchOpacity.push(String(g), 1));
            matchOpacity.push(0.10); 
            
            const matchWidth = ['match', ['to-string', ['get', 'group']]];
            activeRouteGroups.forEach(g => matchWidth.push(String(g), 6));
            matchWidth.push(3); 
            
            const matchBadge = ['match', ['to-string', ['get', 'group']]];
            activeRouteGroups.forEach(g => matchBadge.push(String(g), 1));
            matchBadge.push(0); 
            
            map.setPaintProperty('lines-layer', 'line-opacity', matchOpacity);
            map.setPaintProperty('lines-layer', 'line-width', matchWidth);
            map.setPaintProperty('badges-layer', 'icon-opacity', matchBadge);
            
            if (map.getLayer('zeleznice-layer')) {
                map.setPaintProperty('zeleznice-layer', 'line-color', activeRouteGroups.includes('000') ? '#ffffff' : '#444444');
            }
        }
    }
    updateURL();
}

map.on('click', (e) => {
    const vFeatures = map.queryRenderedFeatures(e.point, { layers: ['vehicles-layer'] });
    const lineFeatures = isRealtimeMode ? [] : map.queryRenderedFeatures(e.point, { layers: ['lines-layer', 'badges-layer'] });

    if (!vFeatures.length && !lineFeatures.length) {
        const hadLine = activeRouteGroups.length > 0;
        const hadVehicle = selectedVehicleId !== null;

        if (hadLine || hadVehicle) {
            if (hadLine) {
                if (isRealtimeMode) toggleRealtimeMode(false);
                else highlightRoute([]);
            } else {
                selectedVehicleId = null;
                map.getSource('trip-route').setData({ type: 'FeatureCollection', features: [] });
                document.getElementById('mobile-bottom-bar').classList.add('hidden');
                if (currentPopup) currentPopup.remove();
                updateURL();
            }
        }
    } else if (vFeatures.length) {
        handleVehicleClick(vFeatures[0].properties);
    } else if (lineFeatures.length) {
        const group = String(lineFeatures[0].properties.group);
        highlightRoute([group]); 
        toggleRealtimeMode(true); 
    }
});

map.on('mouseenter', 'vehicles-layer', () => map.getCanvas().style.cursor = 'pointer');
map.on('mouseleave', 'vehicles-layer', () => map.getCanvas().style.cursor = '');
map.on('mouseenter', 'lines-layer', () => { if(!isRealtimeMode) map.getCanvas().style.cursor = 'pointer'; });
map.on('mouseleave', 'lines-layer', () => map.getCanvas().style.cursor = '');
map.on('mouseenter', 'badges-layer', () => { if(!isRealtimeMode) map.getCanvas().style.cursor = 'pointer'; });
map.on('mouseleave', 'badges-layer', () => map.getCanvas().style.cursor = '');

// --- 5. JÍZDNÍ ŘÁDY A SPOJE ---
let cachedVehicleId = null;
let cachedInfoRaw = null;
let cachedTimetableRaw = null;

window.openTimetable = async function(vehicleId, delayInMinutes) {
    const modalContent = document.getElementById('timetable-modal-content');
    const modal = document.getElementById('timetable-modal');

    if (modal.classList.contains('hidden')) {
        modalContent.innerHTML = "<div class='has-text-centered'>Načítám jízdní řád...</div>";
        modal.classList.remove('hidden');
    }
    
    isTimetableOpen = true;
    updateURL();

    try {
        let rawHtml;
        if (cachedVehicleId === vehicleId && cachedTimetableRaw) {
            rawHtml = cachedTimetableRaw;
        } else {
            rawHtml = await fetchKrajskeHtml(`https://mapavdv.kr-vysocina.cz/Ajax/GetTimetable?vehicleNumber=${vehicleId}&currentStopId=0`);
            cachedTimetableRaw = rawHtml;
            cachedVehicleId = vehicleId;
        }

        let cleanHtml = rawHtml.replace(/inflow\.InfoWindow\.closeTimetable\(\)/g, 'closeTimetable()');
        cleanHtml = fixCommasInHtml(cleanHtml);
        
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = cleanHtml;

        removeWheelchairInfo(tempDiv);

        const legend = tempDiv.querySelector('#timetableColorsLegend');
        if (legend) {
            const bottomRow = legend.closest('.columns');
            if (bottomRow) bottomRow.remove();
        }
        
        if (delayInMinutes !== undefined && delayInMinutes !== null && delayInMinutes !== -2147483648) {
            const headerRight = tempDiv.querySelector('.level-right .level-item');
            if (headerRight) {
                let delayClass = delayInMinutes >= 10 ? '#e74c3c' : (delayInMinutes > 2 ? '#f39c12' : '#58d68d');
                let delayText = delayInMinutes > 0 ? `+${delayInMinutes} min` : (delayInMinutes < 0 ? `${Math.abs(delayInMinutes)} min náskok` : 'Na čas');
                const delaySpan = document.createElement('span');
                delaySpan.style.marginLeft = "15px";
                delaySpan.innerHTML = `Zpoždění: <b style="color:${delayClass}">${delayText}</b>`;
                headerRight.appendChild(delaySpan);
            }
            
            if (delayInMinutes !== 0) {
                const timeCells = tempDiv.querySelectorAll('td.has-text-centered');
                timeCells.forEach(cell => {
                    const timeMatch = cell.innerText.match(/^(\d{1,2}):(\d{2})$/);
                    if (timeMatch) {
                        let h = parseInt(timeMatch[1], 10), m = parseInt(timeMatch[2], 10);
                        let totalMin = h * 60 + m + delayInMinutes;
                        if (totalMin < 0) totalMin += 24 * 60; 
                        let newH = Math.floor(totalMin / 60) % 24, newM = totalMin % 60;
                        let newTimeStr = `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
                        let colorClass = delayInMinutes >= 10 ? '#e74c3c' : (delayInMinutes > 2 ? '#f39c12' : '#58d68d');
                        cell.innerHTML = `<s style="color:#666; font-size: 11px; margin-right: 4px;">${cell.innerText}</s><span style="color:${colorClass}">${newTimeStr}</span>`;
                    }
                });
            }
        }

        tempDiv.querySelectorAll('tr').forEach(tr => {
            if (tr.firstElementChild) {
                tr.firstElementChild.style.whiteSpace = 'nowrap';
            }
        });

        const currentScroll = modalContent.scrollTop;
        modalContent.innerHTML = tempDiv.innerHTML;
        modalContent.scrollTop = currentScroll;

    } catch(e) { modalContent.innerHTML = "<div class='has-text-centered'>Chyba při načítání jízdního řádu.</div>"; }
};

window.closeTimetable = function() { 
    document.getElementById('timetable-modal').classList.add('hidden'); 
    isTimetableOpen = false;
    updateURL();
};

let currentPopup = null;

async function handleVehicleClick(v) {
    selectedVehicleId = v.id;
    updateURL();

    const isJihlava = v.isJihlava === true || v.isJihlava === 'true';

    if (isJihlava) {
        map.getSource('trip-route').setData({ type: 'FeatureCollection', features: [] });
        
        let delayClass = v.delay >= 10 ? '#e74c3c' : (v.delay > 2 ? '#f39c12' : '#58d68d');
        let delayText = v.delay > 0 ? `+${v.delay} min` : (v.delay < 0 ? `${Math.abs(v.delay)} min náskok` : 'Na čas');
        if (v.delay === -2147483648) { delayClass = '#7f8c8d'; delayText = 'Neznámé'; }
        
        // Vygenerování tabulky přesně ve vizuálním stylu Kraje bez zbytečných nadpisů
        let html = `
            <div>
                <table style="width: 100%; border-spacing: 0; line-height: 1.6; text-align: left;">
                    <tbody>
                        <tr><th style="padding-right: 10px; white-space: nowrap;">Linka:</th><td><strong>${v.text}</strong></td></tr>
                        <tr><th style="padding-right: 10px; white-space: nowrap;">Směr:</th><td><strong>${v.finalStopName}</strong></td></tr>
                        <tr><th style="padding-right: 10px; white-space: nowrap;">Poslední zastávka:</th><td>${v.lastStop}</td></tr>
                        <tr><th style="padding-right: 10px; white-space: nowrap;">Zpoždění:</th><td><b style="color:${delayClass}">${delayText}</b></td></tr>
                    </tbody>
                </table>
                <div style="color: #999; font-weight: 300; font-size: 12px; text-align: center; margin-top: 10px;">Spoj MHD Jihlava</div>
            </div>
        `;

        if (window.innerWidth <= 768) {
            const bar = document.getElementById('mobile-bottom-bar');
            document.getElementById('mobile-bar-content').innerHTML = html;
            bar.classList.remove('hidden');
            bar.onclick = null;
        } else {
            if (currentPopup && currentPopup.isOpen()) {
                currentPopup.setLngLat([v.lng, v.lat]).setHTML(html);
            } else {
                if (currentPopup) currentPopup.remove();
                currentPopup = new maplibregl.Popup({ closeOnClick: false }).setLngLat([v.lng, v.lat]).setHTML(html).addTo(map);
            }
        }
        return;
    }

    const isTrain = v.traction === 'TRAIN';
    const vTextStr = String(v.text || '');
    const routeToHighlight = isTrain ? vTextStr : getShortLine(vTextStr);
    
    const isNonVDV = vTextStr.startsWith('620') || 
                     vTextStr.startsWith('35500') || 
                     vTextStr.startsWith('84500') || 
                     ['841125', '841121', '849124', '841334'].some(prefix => vTextStr.startsWith(prefix));

    try {
        let infoRaw, timetableRaw;
        if (cachedVehicleId === v.id && cachedInfoRaw && cachedTimetableRaw) {
            infoRaw = cachedInfoRaw;
            timetableRaw = cachedTimetableRaw;
        } else {
            const [iRes, tRes] = await Promise.all([
                fetchKrajskeHtml(`https://mapavdv.kr-vysocina.cz/Ajax/OpenInfoWindow?id=${v.id}`),
                fetchKrajskeHtml(`https://mapavdv.kr-vysocina.cz/Ajax/GetTimetable?vehicleNumber=${v.id}&currentStopId=0`)
            ]);
            infoRaw = iRes;
            timetableRaw = tRes;
            cachedInfoRaw = infoRaw;
            cachedTimetableRaw = timetableRaw;
            cachedVehicleId = v.id;
            
            map.getSource('trip-route').setData({ type: 'FeatureCollection', features: [] });
            if (!isNonVDV) {
                if (!isTrain && geojsonData) {
                    let multiLineCoords = [];
                    geojsonData.features.forEach(f => {
                        if ((f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString') && String(f.properties.group) === routeToHighlight) {
                            if (f.geometry.type === 'LineString') multiLineCoords.push(f.geometry.coordinates);
                            else multiLineCoords.push(...f.geometry.coordinates);
                        }
                    });

                    const parser = new DOMParser();
                    const doc = parser.parseFromString(timetableRaw, 'text/html');
                    const labelSpan = doc.getElementById('currentLineRouteLabel');
                    
                    let linka = "", spoj = "";
                    if (labelSpan) {
                        const parts = labelSpan.innerText.split('/');
                        if(parts.length >= 1) linka = parts[0].trim();
                        if(parts.length >= 2) spoj = parts[1].trim();
                    }

                    let firstTime = "";
                    const firstTimeCell = doc.querySelector('tbody tr td.has-text-centered:nth-child(3)') || doc.querySelector('tbody tr td.has-text-centered:nth-child(2)');
                    if (firstTimeCell) {
                        const timeMatch = firstTimeCell.innerText.match(/(\d{1,2}):(\d{2})/);
                        if (timeMatch) firstTime = String(timeMatch[1]).padStart(2, '0') + timeMatch[2]; 
                    }

                    const vdvKey = `${linka}/${spoj}`;
                    const pidKey = `${linka}/PID${firstTime}`;

                    const rawCoords = tripShapes[vdvKey] || tripShapes[pidKey]; 

                    if (rawCoords && rawCoords.length > 1) {
                        const geoJsonLine = { type: 'Feature', geometry: { type: 'LineString', coordinates: rawCoords.map(c => [c[1], c[0]]) } };
                        map.getSource('trip-route').setData(geoJsonLine);
                    } else {
                        const stopCells = doc.querySelectorAll('tbody tr td:first-child');
                        let stopCoords = [];
                        let previousCoord = null;

                        stopCells.forEach(cell => {
                            const normName = normalizeStopName(cell.innerText);
                            const bestCoord = findBestStop(normName, multiLineCoords, previousCoord);
                            if (bestCoord) { stopCoords.push(bestCoord); previousCoord = bestCoord; }
                        });

                        if (stopCoords.length > 1) {
                            let finalTripCoords = [stopCoords[0]];
                            for (let i = 0; i < stopCoords.length - 1; i++) {
                                let A = stopCoords[i], B = stopCoords[i+1];
                                let roadPath = getPathBetweenStops(A, B, multiLineCoords);
                                if (roadPath) finalTripCoords.push(...roadPath);
                                else finalTripCoords.push(B); 
                            }
                            map.getSource('trip-route').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: finalTripCoords }});
                        }
                    }
                } else if (isTrain) {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(timetableRaw, 'text/html');
                    const stopCells = doc.querySelectorAll('tbody tr td:first-child');
                    let stopCoords = [];

                    stopCells.forEach(cell => {
                        let rawName = cell.textContent.replace(/[\n\r\t]/g, '').trim();
                        if (trainStopsMap[rawName]) {
                            stopCoords.push(trainStopsMap[rawName]);
                        }
                    });

                    if (stopCoords.length > 1) {
                        const geoJsonLine = { type: 'Feature', geometry: { type: 'LineString', coordinates: stopCoords } };
                        map.getSource('trip-route').setData(geoJsonLine);
                    }
                }
            }
        }

        let cleanHtml = infoRaw.replace(/inflow\.InfoWindow\.loadTimetable\((-?\d+),\s*-?\d+\)/g, `openTimetable($1, ${v.delay})`);
        cleanHtml = fixCommasInHtml(cleanHtml);

        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = cleanHtml;
        removeWheelchairInfo(tempDiv);

        const walkerDelay = document.createTreeWalker(tempDiv, NodeFilter.SHOW_TEXT, null, false);
        let n;
        let toRemoveDelay = [];
        while ((n = walkerDelay.nextNode())) {
            if (n.nodeValue.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes('zpozdeni')) {
                let p = n.parentElement;
                let container = p.closest('.level') || p.closest('.columns') || p.closest('tr') || p.closest('li') || p.closest('p') || p;
                if (container && !toRemoveDelay.includes(container)) toRemoveDelay.push(container);
            }
        }
        toRemoveDelay.forEach(c => c.remove());

        if (v.finalStopName && v.finalStopName.trim() !== '' && !/n\/a/i.test(v.finalStopName)) {
            let formattedStopName = v.finalStopName.replace(/,(?=[^\s])/g, ', '); 
            
            if (isTrain) {
                let uicMatch = formattedStopName.match(/^(\d+)\s*N\/a/i);
                if (uicMatch) {
                    formattedStopName = await getStationNameByUIC(uicMatch[1]);
                }
            }

            let targetTr = null;
            tempDiv.querySelectorAll('tr').forEach(tr => {
                const txt = tr.textContent.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
                if (txt.includes('linka') || txt.includes('vlak') || txt.includes('spoj')) {
                    targetTr = tr;
                }
            });
            if (targetTr) {
                const newTr = document.createElement('tr');
                newTr.innerHTML = `<th>Směr:</th><td><strong>${formattedStopName}</strong></td>`;
                targetTr.after(newTr);
            }
        }

        if (v.delay !== -2147483648) {
            let targetTr = null;
            tempDiv.querySelectorAll('tr').forEach(tr => {
                const txt = tr.textContent.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
                if (txt.includes('linka') || txt.includes('vlak') || txt.includes('spoj') || txt.includes('smer')) {
                    targetTr = tr;
                }
            });
            if (targetTr) {
                let delayClass = v.delay >= 10 ? '#e74c3c' : (v.delay > 2 ? '#f39c12' : '#58d68d');
                let delayText = v.delay > 0 ? `+${v.delay} min` : (v.delay < 0 ? `${Math.abs(v.delay)} min náskok` : 'Na čas');
                const newTr = document.createElement('tr');
                newTr.innerHTML = `<th>Zpoždění:</th><td><b style="color:${delayClass}">${delayText}</b></td>`;
                targetTr.after(newTr);
            }
        }

        if (isTrain) {
            tempDiv.querySelectorAll('th, td, span, strong, b, div, p').forEach(el => {
                if (el && el.textContent) {
                    const txt = el.textContent.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
                    if (txt === 'spoj:' || txt === 'spoj') {
                        const container = el.closest('tr') || el.closest('.level') || el.closest('.columns') || el.closest('li') || el.closest('p');
                        if (container) container.remove();
                    }
                }
            });

            const walkerTrain = document.createTreeWalker(tempDiv, NodeFilter.SHOW_TEXT, null, false);
            let n2;
            while ((n2 = walkerTrain.nextNode())) {
                if (n2.nodeValue.includes('Linka')) {
                    n2.nodeValue = n2.nodeValue.replace('Linka', 'Vlak');
                } else if (n2.nodeValue.includes('linka')) {
                    n2.nodeValue = n2.nodeValue.replace('linka', 'vlak');
                }
            }
        }

        const hasValidTimetable = timetableRaw && timetableRaw.toLowerCase().includes('<tr');
        if (!hasValidTimetable) {
            tempDiv.querySelectorAll('*').forEach(el => {
                const onclickAttr = el.getAttribute('onclick') || '';
                const textContent = el.textContent ? el.textContent.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") : '';
                
                if (onclickAttr.includes('openTimetable') || onclickAttr.includes('loadTimetable') || ((el.tagName === 'BUTTON' || el.tagName === 'A') && textContent.includes('jizdni rad'))) {
                    el.remove();
                }
            });
        }

        tempDiv.querySelectorAll('tr').forEach(tr => {
            if (tr.firstElementChild) {
                tr.firstElementChild.style.whiteSpace = 'nowrap';
            }
        });

        if (isNonVDV) {
            const table = tempDiv.querySelector('table') || tempDiv.querySelector('tbody');
            if (table) {
                const tr = document.createElement('tr');
                const td = document.createElement('td');
                td.colSpan = 2;
                td.style.color = '#ff4d4d';
                td.style.fontWeight = '300';
                td.style.fontSize = '12px';
                td.style.textAlign = 'center';
                td.style.paddingTop = '10px';
                td.innerText = 'Na spoji neplatí doklady VDV';
                tr.appendChild(td);
                
                const tbody = table.tagName === 'TBODY' ? table : table.querySelector('tbody');
                if (tbody) tbody.appendChild(tr);
                else table.appendChild(tr);
            } else {
                const warningMsg = document.createElement('div');
                warningMsg.style.color = '#ff4d4d'; 
                warningMsg.style.fontWeight = '300';
                warningMsg.style.fontSize = '12px';
                warningMsg.style.textAlign = 'center';
                warningMsg.style.marginTop = '10px';
                warningMsg.innerText = 'Na spoji neplatí doklady VDV';
                tempDiv.appendChild(warningMsg);
            }
        }

        cleanHtml = tempDiv.innerHTML;

        if (window.innerWidth <= 768) {
            const bar = document.getElementById('mobile-bottom-bar');
            const barContent = document.getElementById('mobile-bar-content');
            
            const currentScroll = barContent.scrollTop;
            barContent.innerHTML = cleanHtml;
            barContent.scrollTop = currentScroll;
            
            bar.classList.remove('hidden');
            bar.onclick = function(e) { 
                if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'I' && !e.target.closest('button')) {
                    if (cleanHtml.includes('openTimetable')) {
                        openTimetable(v.id, v.delay); 
                    }
                } 
            };
        } else {
            if (currentPopup && currentPopup.isOpen()) {
                currentPopup.setLngLat([v.lng, v.lat]).setHTML(cleanHtml);
            } else {
                if (currentPopup) currentPopup.remove();
                currentPopup = new maplibregl.Popup({ closeOnClick: false }).setLngLat([v.lng, v.lat]).setHTML(cleanHtml).addTo(map);
            }
        }
    } catch(e) { console.error("Nelze načíst detail vozidla", e); }
}

// --- 6. ENGINE PRO ŽIVÁ VOZIDLA ---
function toggleRealtimeMode(forceState = null) {
    isRealtimeMode = forceState !== null ? forceState : !isRealtimeMode;
    const btn = document.getElementById('rt-btn');
    
    if (isRealtimeMode) {
        map.setMaxZoom(19);
        if(btn) btn.classList.add('active');
        highlightRoute(activeRouteGroups);
        
        clearInterval(rtInterval); 
        fetchLiveVehicles();
        rtInterval = setInterval(fetchLiveVehicles, 10000);
    } else {
        map.setMaxZoom(15);
        if (map.getZoom() > 15) map.setZoom(15);
        if(btn) btn.classList.remove('active');
        clearInterval(rtInterval);
        
        map.getSource('vehicles').setData({ type: 'FeatureCollection', features: [] });
        map.getSource('trip-route').setData({ type: 'FeatureCollection', features: [] });
        
        document.getElementById('mobile-bottom-bar').classList.add('hidden');
        if (currentPopup) currentPopup.remove();
        
        selectedVehicleId = null;
        highlightRoute([]); 
    }
    updateURL();
}

if(document.getElementById('rt-btn')) document.getElementById('rt-btn').addEventListener('click', () => toggleRealtimeMode());

async function fetchLiveVehicles() {
    if (!isRealtimeMode || isFetchingVehicles) return;
    
    isFetchingVehicles = true;
    try {
        const timestamp = new Date().getTime();
        
        // Jihlava zůstává na allorigins (corsproxy.io blokuje GeoJSON zadarmo)
        const jihlavaUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent('https://gis.jihlava-city.cz/server1/rest/services/verejnost/Ji_MHD_aktualni/MapServer/47/query?where=1=1&returnGeometry=true&outFields=*&f=geojson')}`;
        // Krajské body vráceny zpět na rychlé corsproxy.io
        const vdvUrl = `https://corsproxy.io/?${encodeURIComponent('https://mapavdv.kr-vysocina.cz/Ajax/GetPoints?t=' + timestamp)}`;
        
        const [vdvRes, jihRes] = await Promise.allSettled([
            fetch(vdvUrl).then(r => r.json()),
            fetch(jihlavaUrl).then(r => r.json())
        ]);
        
        let allVehicles = [];
        
        if (vdvRes.status === 'fulfilled') {
            const vdvData = vdvRes.value;
            vdvData.forEach(v => {
                if (typeof v.lng !== 'number' || typeof v.lat !== 'number' || (v.lng === 0 && v.lat === 0)) return;

                const isTrain = v.traction === 'TRAIN';
                const vTextStr = String(v.text || '');
                const shortLine = getShortLine(vTextStr);
                
                if (activeRouteGroups.length > 0) {
                    const routeOfVehicle = isTrain ? vTextStr : shortLine;
                    const trainMatch = isTrain && activeRouteGroups.includes('000');
                    const busMatch = activeRouteGroups.includes(routeOfVehicle);
                    if (!trainMatch && !busMatch) return;
                }
                
                const isUnknownDelay = v.delay === -2147483648;
                const hasNaDirection = v.finalStopName && /n\/a/i.test(v.finalStopName);
                if (isUnknownDelay && hasNaDirection && !isTrain) return;
                
                const isNonVDV = vTextStr.startsWith('620') || vTextStr.startsWith('35500') || vTextStr.startsWith('84500') || ['841125', '841121', '849124', '841334'].some(prefix => vTextStr.startsWith(prefix));
                
                let delayClass = 'ok';
                if (v.delay === -2147483648) delayClass = 'unknown';
                else if (v.delay > 2 && v.delay <= 9) delayClass = 'warn'; 
                else if (v.delay >= 10) delayClass = 'alert';

                if (!isTrain && shortLine !== "??" && shortLine.length <= 2) {
                    delayClass = 'dim'; 
                }

                allVehicles.push({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [v.lng, v.lat] },
                    properties: {
                        id: String(v.id), delay: v.delay, traction: v.traction, text: vTextStr, lng: v.lng, lat: v.lat,
                        iconId: getVehicleIcon(delayClass, shortLine, isTrain, isNonVDV), 
                        finalStopName: v.finalStopName || "", shortLine: shortLine,
                        isJihlava: false, isTrain: isTrain, isNonVDV: isNonVDV
                    }
                });
            });
        }
        
        if (jihRes.status === 'fulfilled') {
            const jihData = jihRes.value;
            if (jihData.features) {
                jihData.features.forEach(f => {
                    const p = f.properties;
                    const geom = f.geometry;
                    if (!geom || !geom.coordinates) return;
                    
                    const shortLine = String(p.linka).trim();
                    
                    if (activeRouteGroups.length > 0) {
                        if (!activeRouteGroups.includes(shortLine)) return;
                    }
                    
                    let delay = p.delayinmins != null ? p.delayinmins : -2147483648;
                    
                    let delayClass = 'ok';
                    if (delay === -2147483648) delayClass = 'unknown';
                    else if (delay > 2 && delay <= 9) delayClass = 'warn';
                    else if (delay >= 10) delayClass = 'alert';
                    
                    if (shortLine.length <= 2) delayClass = 'dim';

                    allVehicles.push({
                        type: 'Feature',
                        geometry: { type: 'Point', coordinates: [geom.coordinates[0], geom.coordinates[1]] },
                        properties: {
                            id: "J" + p.objectid,
                            delay: delay,
                            traction: p.typ === "trolejbus" ? "TROLLEYBUS" : "BUS",
                            text: p.linka,
                            lng: geom.coordinates[0],
                            lat: geom.coordinates[1],
                            iconId: getVehicleIcon(delayClass, shortLine, false, false),
                            finalStopName: p.konecna || "",
                            shortLine: shortLine,
                            isJihlava: true,
                            isTrain: false,
                            isNonVDV: false,
                            lastStop: p.posledni || ""
                        }
                    });
                });
            }
        }

        const geojson = { type: 'FeatureCollection', features: allVehicles };
        if (map.getSource('vehicles')) map.getSource('vehicles').setData(geojson);

        if (selectedVehicleId !== null) {
            const vToClick = allVehicles.find(item => String(item.properties.id) === String(selectedVehicleId));
            if (vToClick) {
                if (!initialLoadAutoClickDone) {
                    handleVehicleClick(vToClick.properties);
                    if (isTimetableOpen && !vToClick.properties.isJihlava) openTimetable(vToClick.properties.id, vToClick.properties.delay);
                    initialLoadAutoClickDone = true;
                } else {
                    handleVehicleClick(vToClick.properties);
                    if (isTimetableOpen && !vToClick.properties.isJihlava) openTimetable(vToClick.properties.id, vToClick.properties.delay);
                }
            }
        }

    } catch (e) { 
        console.error("Chyba RT dat:", e); 
    } finally {
        isFetchingVehicles = false; 
    }
}

const locateBtn = document.getElementById('locate-btn');
if(locateBtn) locateBtn.addEventListener('click', () => {
    if ("geolocation" in navigator) {
        navigator.geolocation.getCurrentPosition(position => {
            map.flyTo({ center: [position.coords.longitude, position.coords.latitude], zoom: 14 });
        });
    }
});

// --- 7. INTELIGENTNÍ KOMPAS (SEVERKA) ---
const compassBtn = document.createElement('div');
compassBtn.id = 'compass-btn';
compassBtn.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="#fff"><path d="M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71z"/></svg>`;
compassBtn.style.cssText = `
    position: absolute; right: 20px; bottom: 138px; z-index: 1000;
    background: rgba(20, 20, 20, 0.85); backdrop-filter: blur(8px);
    border: 1px solid rgba(255,255,255,0.15); border-radius: 50%;
    width: 44px; height: 44px; cursor: pointer;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    display: none; align-items: center; justify-content: center;
    transition: opacity 0.2s ease;
`;
document.body.appendChild(compassBtn);

compassBtn.addEventListener('click', () => {
    map.resetNorth({ duration: 500 });
});

function updateCompass() {
    const bearing = map.getBearing();
    if (Math.abs(bearing) < 0.5) {
        compassBtn.style.display = 'none';
    } else {
        compassBtn.style.display = 'flex';
        compassBtn.querySelector('svg').style.transform = `rotate(${-bearing}deg)`;
    }
}
map.on('rotate', updateCompass);
map.on('move', updateCompass);
