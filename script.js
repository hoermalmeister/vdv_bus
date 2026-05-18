const map = L.map('map', { 
    preferCanvas: true,
    minZoom: 10,
    maxZoom: 15
}).setView([49.4, 15.6], 10); 

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap © CARTO',
    minZoom: 10, maxZoom: 15
}).addTo(map);

const neonColors = ['#ff3366', '#33ff66', '#ff9933', '#33ccff', '#cc33ff', '#ffff33', '#ff33ff', '#33ffff', '#ff6666', '#66ff66', '#ffb366', '#66b3ff', '#ff99ff', '#99ffff'];

function getColorForGroup(group) {
    let hash = 0;
    for (let i = 0; i < group.length; i++) hash = group.charCodeAt(i) + ((hash << 5) - hash);
    return neonColors[Math.abs(hash) % neonColors.length];
}

const linesLayer = L.layerGroup().addTo(map);
const routeBadgesLayer = L.layerGroup().addTo(map); 
const stopsLayer = L.layerGroup().addTo(map); 

let allStopsData = []; 

fetch('trasy.geojson')
    .then(response => response.json())
    .then(data => {
        L.geoJSON(data, {
            style: function(feature) {
                if (feature.geometry.type === "MultiLineString") {
                    return {
                        color: getColorForGroup(feature.properties.group),
                        weight: 4, opacity: 0.9, lineCap: 'round', lineJoin: 'round'
                    };
                }
            },
            onEachFeature: function (feature, layer) {
                if (feature.geometry.type === "MultiLineString") {
                    linesLayer.addLayer(layer);

                    // --- NOVÁ LOGIKA PRO UMÍSTĚNÍ ŠTÍTKŮ PŘÍMO NA ČÁRU ---
                    
                    // 1. Získáme VŠECHNY reálné GPS body, kterými linka projíždí
                    let allPoints = [];
                    feature.geometry.coordinates.forEach(segment => {
                        segment.forEach(coord => {
                            // GeoJSON používá [lon, lat], Leaflet používá [lat, lon]
                            allPoints.push([coord[1], coord[0]]); 
                        });
                    });

                    if (allPoints.length > 0) {
                        // 2. Podle délky trasy určíme počet štítků (1 až 4)
                        let labelCount = 1;
                        if (allPoints.length > 600) labelCount = 4;
                        else if (allPoints.length > 300) labelCount = 3;
                        else if (allPoints.length > 100) labelCount = 2;

                        const routeColor = getColorForGroup(feature.properties.group);

                        // 3. Rozmístíme štítky rovnoměrně PŘÍMO na souřadnice čáry
                        for (let i = 1; i <= labelCount; i++) {
                            // Výpočet pozice: 1/2 pro jeden štítek, 1/3 a 2/3 pro dva štítky atd.
                            let pointIndex = Math.floor(allPoints.length * (i / (labelCount + 1)));
                            let exactPointOnLine = allPoints[pointIndex];

                            const badgeTooltip = L.tooltip(exactPointOnLine, {
                                permanent: true,
                                direction: 'center',
                                className: 'route-map-badge',
                                interactive: false
                            }).setContent(feature.properties.group);

                            // Injekce barvy linky do rámečku štítku
                            badgeTooltip.on('add', function(e) {
                                e.target.getElement().style.borderColor = routeColor;
                            });

                            routeBadgesLayer.addLayer(badgeTooltip);
                        }
                    }
                } else if (feature.geometry.type === "Point") {
                    allStopsData.push(feature);
                }
            }
        });
        
        updateVisibleStops(); 
        document.getElementById('loading').style.display = 'none';
    })
    .catch(error => {
        document.getElementById('loading').innerText = "Chyba při načítání GeoJSON dat.";
        console.error(error);
    });

function updateVisibleStops() {
    stopsLayer.clearLayers(); 
    if (map.getZoom() < 15) return;

    const bounds = map.getBounds();

    allStopsData.forEach(feature => {
        const coords = feature.geometry.coordinates;
        const latlng = L.latLng(coords[1], coords[0]);

        if (bounds.contains(latlng)) {
            const rawZone = feature.properties.zone || "";
            const vZones = rawZone.split(',').map(z => z.trim()).filter(z => z.startsWith('V'));

            if (vZones.length > 0) {
                const htmlContent = `
                    <span class="stop-dot"></span>
                    <span>${feature.properties.name}</span>
                    <span class="stop-zone-text">${vZones.join(',')}</span>
                `;

                const marker = L.circleMarker(latlng, {
                    radius: 4, color: '#fff', weight: 1.5, fillColor: '#58d68d', fillOpacity: 1
                }).bindTooltip(htmlContent, { 
                    permanent: true, 
                    direction: 'top', 
                    className: 'modern-stop-label', 
                    offset: [0, -6]
                });
                
                stopsLayer.addLayer(marker);
            }
        }
    });
}

map.on('moveend', updateVisibleStops);
map.on('zoomend', updateVisibleStops);
