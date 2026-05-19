let isRealtimeMode = false;
let selectedVehicleId = null;
let rtInterval = null;
let tripShapes = {};

const urlParams = new URLSearchParams(window.location.search);
if (urlParams.has('rt') && urlParams.get('rt') === '1') isRealtimeMode = true;
if (urlParams.has('id')) selectedVehicleId = parseInt(urlParams.get('id'), 10);

// --- 1. INICIALIZACE MAPLIBRE (WEBGL) ---
const map = new maplibregl.Map({
    container: 'map',
    style: {
        version: 8,
        // Pro fonty potřebujeme základní glyph server (Free od MapTileru/MapLibre)
        glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
        sources: {
            'carto-dark': {
                type: 'raster',
                tiles: ['https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'],
                tileSize: 256
            }
        },
        layers: [{ id: 'carto-dark-layer', type: 'raster', source: 'carto-dark' }]
    },
    center: [urlParams.get('x') || 15.6, urlParams.get('y') || 49.4],
    zoom: urlParams.get('z') || 10,
    maxZoom: 19
});

async function fetchKrajskeHtml(url) {
    const res = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`);
    if (!res.ok) throw new Error("Chyba při stahování HTML");
    return await res.text();
}

function updateURL() {
    const center = map.getCenter();
    const params = new URLSearchParams();
    params.set('x', center.lng.toFixed(4));
    params.set('y', center.lat.toFixed(4));
    params.set('z', map.getZoom().toFixed(1));
    if (isRealtimeMode) params.set('rt', '1');
    if (selectedVehicleId) params.set('id', selectedVehicleId);
    window.history.replaceState(null, '', window.location.pathname + '?' + params.toString());
}

map.on('moveend', updateURL);
map.on('zoomend', updateURL);

// --- 2. PŘÍPRAVA VRSTEV PO NAČTENÍ MAPY ---
map.on('load', () => {
    
    // Načteme náš slovník přesných tras spojů z Pythonu
    fetch('spoje.json?t=' + new Date().getTime()).then(r => r.json()).then(data => { tripShapes = data; });

    // A. ZDROJ DAT: Všechny linky a zastávky z GeoJSON
    map.addSource('trasy', { type: 'geojson', data: 'trasy.geojson?t=' + new Date().getTime() });

    // Vrstva 1: Základní tlusté čáry linek
    map.addLayer({
        id: 'lines-layer',
        type: 'line',
        source: 'trasy',
        filter: ['==', ['geometry-type'], 'MultiLineString'],
        paint: {
            'line-color': ['get', 'color'],
            'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 15, 6],
            'line-opacity': isRealtimeMode ? 0.1 : 0.9
        }
    });

    // Vrstva 2: Zastávky (kolečko + text, objeví se až při zoomu > 14)
    map.addLayer({
        id: 'stops-layer',
        type: 'circle',
        source: 'trasy',
        minzoom: 14,
        filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'type'], 'stop'], ['==', ['get', 'show_label'], true]],
        paint: { 'circle-radius': 4, 'circle-color': '#58d68d', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 }
    });

    map.addLayer({
        id: 'stops-text-layer',
        type: 'symbol',
        source: 'trasy',
        minzoom: 14,
        filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'type'], 'stop'], ['==', ['get', 'show_label'], true]],
        layout: {
            'text-field': ['get', 'name'],
            'text-font': ['Open Sans Regular'],
            'text-size': 12,
            'text-anchor': 'bottom',
            'text-offset': [0, -0.6]
        },
        paint: { 'text-color': '#fff', 'text-halo-color': '#111', 'text-halo-width': 2 }
    });

    // B. ZDROJ DAT: Zvýrazněná trasa konkrétního spoje (zatím prázdná)
    map.addSource('trip-route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
        id: 'trip-route-layer',
        type: 'line',
        source: 'trip-route',
        paint: { 'line-color': '#00e5ff', 'line-width': 5, 'line-opacity': 1 }
    });

    // C. ZDROJ DAT: Živá vozidla (zatím prázdná)
    map.addSource('vehicles', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    
    // Vrstva: Pozadí ikonky vozidla
    map.addLayer({
        id: 'vehicles-bg',
        type: 'circle',
        source: 'vehicles',
        paint: {
            'circle-radius': 14,
            'circle-color': ['get', 'colorHex'],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#fff'
        }
    });

    // Vrstva: Text v ikonce vozidla
    map.addLayer({
        id: 'vehicles-text',
        type: 'symbol',
        source: 'vehicles',
        layout: {
            'text-field': ['get', 'shortLabel'],
            'text-font': ['Open Sans Bold'],
            'text-size': 12,
            'text-allow-overlap': true
        },
        paint: { 'text-color': ['get', 'textColorHex'] }
    });

    document.getElementById('loading').style.display = 'none';

    if (isRealtimeMode) toggleRealtimeMode(true);
});

// --- 3. LOGIKA KLIKÁNÍ A JÍZDNÍCH ŘÁDŮ ---

// Resetování mapy při kliknutí do prázdna
map.on('click', (e) => {
    const features = map.queryRenderedFeatures(e.point, { layers: ['vehicles-bg', 'vehicles-text'] });
    if (!features.length && selectedVehicleId !== null) {
        selectedVehicleId = null;
        map.getSource('trip-route').setData({ type: 'FeatureCollection', features: [] }); // Vymaže modrou čáru
        document.getElementById('mobile-bottom-bar').classList.add('hidden');
        updateURL();
    }
});

// Kliknutí na vozidlo (MapLibre zachytává přímo z WebGL vrstvy)
map.on('click', 'vehicles-bg', (e) => {
    const v = e.features[0].properties; // Data, která jsme dovnitř uložili v sekci 4
    handleVehicleClick(v);
});
map.on('mouseenter', 'vehicles-bg', () => map.getCanvas().style.cursor = 'pointer');
map.on('mouseleave', 'vehicles-bg', () => map.getCanvas().style.cursor = '');


window.openTimetable = async function(vehicleId, delayInMinutes) {
    document.getElementById('timetable-modal-content').innerHTML = "<div class='has-text-centered'>Načítám jízdní řád...</div>";
    document.getElementById('timetable-modal').classList.remove('hidden');
    
    try {
        let rawHtml = await fetchKrajskeHtml(`https://mapavdv.kr-vysocina.cz/Ajax/GetTimetable?vehicleNumber=${vehicleId}&currentStopId=0`);
        let cleanHtml = rawHtml.replace(/inflow\.InfoWindow\.closeTimetable\(\)/g, 'closeTimetable()');
        
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = cleanHtml;

        const legend = tempDiv.querySelector('#timetableColorsLegend');
        if (legend) {
            const bottomRow = legend.closest('.columns');
            if (bottomRow) bottomRow.remove();
        }
        
        if (delayInMinutes !== undefined && delayInMinutes !== null && delayInMinutes !== -2147483648) {
            const headerRight = tempDiv.querySelector('.level-right .level-item');
            if (headerRight) {
                let delayClass = delayInMinutes >= 10 ? '#e74c3c' : (delayInMinutes > 0 ? '#f39c12' : '#58d68d');
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
                        let colorClass = delayInMinutes >= 10 ? '#e74c3c' : (delayInMinutes > 0 ? '#f39c12' : '#58d68d');
                        cell.innerHTML = `<s style="color:#666; font-size: 11px; margin-right: 4px;">${cell.innerText}</s><span style="color:${colorClass}">${newTimeStr}</span>`;
                    }
                });
            }
        }
        document.getElementById('timetable-modal-content').innerHTML = tempDiv.innerHTML;
    } catch(e) { document.getElementById('timetable-modal-content').innerHTML = "Chyba při načítání."; }
};

window.closeTimetable = function() { document.getElementById('timetable-modal').classList.add('hidden'); };

async function handleVehicleClick(v) {
    selectedVehicleId = v.id;
    updateURL();

    try {
        const [infoRaw, timetableRaw] = await Promise.all([
            fetchKrajskeHtml(`https://mapavdv.kr-vysocina.cz/Ajax/OpenInfoWindow?id=${v.id}`),
            fetchKrajskeHtml(`https://mapavdv.kr-vysocina.cz/Ajax/GetTimetable?vehicleNumber=${v.id}&currentStopId=0`)
        ]);

        map.getSource('trip-route').setData({ type: 'FeatureCollection', features: [] });
        
        if (v.traction !== 'TRAIN') {
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
                // Převod python formátu na GeoJSON pro bleskové vykreslení linky
                const geoJsonLine = {
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: rawCoords.map(c => [c[1], c[0]]) } // MapLibre vyžaduje [Lng, Lat]
                };
                map.getSource('trip-route').setData(geoJsonLine);
            }
        }

        let cleanHtml = infoRaw.replace(/inflow\.InfoWindow\.loadTimetable\((-?\d+),\s*-?\d+\)/g, `openTimetable($1, ${v.delay})`);

        if (window.innerWidth <= 768) {
            const bar = document.getElementById('mobile-bottom-bar');
            document.getElementById('mobile-bar-content').innerHTML = cleanHtml;
            bar.classList.remove('hidden');
            bar.onclick = function(e) { if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'I' && !e.target.closest('button')) openTimetable(v.id, v.delay); };
        } else {
            // MapLibre popup
            new maplibregl.Popup({ closeOnClick: false })
                .setLngLat([v.lng, v.lat])
                .setHTML(cleanHtml)
                .addTo(map);
        }
    } catch(e) { console.error(e); }
}

// --- 4. ENGINE PRO ŽIVÁ VOZIDLA (BLESKOVÝ WEBGL) ---
function toggleRealtimeMode(forceState = null) {
    isRealtimeMode = forceState !== null ? forceState : !isRealtimeMode;
    const btn = document.getElementById('rt-btn');
    
    if (isRealtimeMode) {
        if(btn) btn.classList.add('active');
        if (map.getLayer('lines-layer')) map.setPaintProperty('lines-layer', 'line-opacity', 0.1);
        fetchLiveVehicles();
        rtInterval = setInterval(fetchLiveVehicles, 10000);
    } else {
        if(btn) btn.classList.remove('active');
        clearInterval(rtInterval);
        
        // Vyčištění WebGL vrstev
        map.getSource('vehicles').setData({ type: 'FeatureCollection', features: [] });
        map.getSource('trip-route').setData({ type: 'FeatureCollection', features: [] });
        if (map.getLayer('lines-layer')) map.setPaintProperty('lines-layer', 'line-opacity', 0.9);
        
        document.getElementById('mobile-bottom-bar').classList.add('hidden');
        selectedVehicleId = null;
    }
    updateURL();
}

if(document.getElementById('rt-btn')) document.getElementById('rt-btn').addEventListener('click', () => toggleRealtimeMode());

async function fetchLiveVehicles() {
    if (!isRealtimeMode) return;
    try {
        const timestamp = new Date().getTime();
        const response = await fetch(`https://corsproxy.io/?${encodeURIComponent('https://mapavdv.kr-vysocina.cz/Ajax/GetPoints?t=' + timestamp)}`);
        const data = await response.json();

        // Místo vytváření HTML elementů vytvoříme jeden GeoJSON balíček
        const geojson = {
            type: 'FeatureCollection',
            features: data.map(v => {
                const isTrain = v.traction === 'TRAIN';
                const shortLine = v.text.replace(/\D/g, '').slice(-3) || "??";
                
                let bgColor = '#58d68d'; // OK
                let textColor = '#111';
                
                if (v.delay === -2147483648) bgColor = '#7f8c8d';
                else if (v.delay > 0 && v.delay <= 9) bgColor = '#f39c12';
                else if (v.delay >= 10) bgColor = '#e74c3c';

                if (!isTrain && shortLine !== "??" && shortLine.length <= 2) {
                    bgColor = '#1a2530'; // Dim blue
                    textColor = '#5dade2';
                }

                return {
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [v.lng, v.lat] },
                    properties: {
                        id: v.id,
                        delay: v.delay,
                        traction: v.traction,
                        shortLabel: isTrain ? 'V' : shortLine, // MapLibre neumí SVG tak snadno, použijeme písmeno V jako Vlak
                        colorHex: bgColor,
                        textColorHex: textColor
                    }
                };
            })
        };

        // BAM! Odesláno do grafické karty
        if (map.getSource('vehicles')) {
            map.getSource('vehicles').setData(geojson);
        }

    } catch (e) {
        console.error("Chyba RT dat:", e);
    }
}
