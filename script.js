const map = L.map('map', { 
    preferCanvas: true,
    minZoom: 10,
    maxZoom: 15
}).setView([49.4, 15.6], 10); 

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap © CARTO',
    minZoom: 10, maxZoom: 15
}).addTo(map);

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
                        color: feature.properties.color, // Barvu už nám hlídá Python!
                        weight: 4, opacity: 0.9, lineCap: 'round', lineJoin: 'round'
                    };
                }
            },
            onEachFeature: function (feature, layer) {
                if (feature.geometry.type === "MultiLineString") {
                    linesLayer.addLayer(layer);

                    // --- GEOGRAFICKÁ INTERPOLACE: Měření reálné délky silnice v metrech ---
                    let longestLine = [];
                    let maxDist = 0;
                    
                    // Linka se skládá z mnoha úseků, najdeme tu hlavní a nejdelší větev
                    feature.geometry.coordinates.forEach(linePart => {
                        let dist = 0;
                        for(let i=0; i<linePart.length-1; i++) {
                            // GeoJSON [lon, lat] -> Leaflet [lat, lon]
                            dist += map.distance([linePart[i][1], linePart[i][0]], [linePart[i+1][1], linePart[i+1][0]]);
                        }
                        if(dist > maxDist) {
                            maxDist = dist;
                            longestLine = linePart;
                        }
                    });

                    if (longestLine.length > 0) {
                        // Dynamický počet štítků podle ujetých kilometrů
                        let labelCount = 1;
                        if (maxDist > 60000) labelCount = 4;      // Nad 60 km
                        else if (maxDist > 35000) labelCount = 3; // Nad 35 km
                        else if (maxDist > 15000) labelCount = 2; // Nad 15 km

                        const routeColor = feature.properties.color;

                        // Rozestavíme štítky přesně a rovnoměrně po ujeté vzdálenosti
                        for (let i = 1; i <= labelCount; i++) {
                            let targetDist = maxDist * (i / (labelCount + 1));
                            let currentDist = 0;
                            let exactPoint = null;

                            for(let j=0; j<longestLine.length-1; j++) {
                                let p1 = longestLine[j];
                                let p2 = longestLine[j+1];
                                let d = map.distance([p1[1], p1[0]], [p2[1], p2[0]]);
                                
                                // Když překročíme cílovou vzdálenost, spočítáme přesný průsečík
                                if (currentDist + d >= targetDist) {
                                    let ratio = (targetDist - currentDist) / d;
                                    let lat = p1[1] + (p2[1] - p1[1]) * ratio;
                                    let lon = p1[0] + (p2[0] - p1[0]) * ratio;
                                    exactPoint = [lat, lon];
                                    break;
                                }
                                currentDist += d;
                            }
                            
                            // Pojistka, kdyby interpolace nevyšla
                            if (!exactPoint) exactPoint = [longestLine[longestLine.length-1][1], longestLine[longestLine.length-1][0]];

                            const badgeTooltip = L.tooltip(exactPoint, {
                                permanent: true,
                                direction: 'center',
                                className: 'route-map-badge',
                                interactive: false
                            }).setContent(feature.properties.group);

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
                    permanent: true, direction: 'top', className: 'modern-stop-label', offset: [0, -6]
                });
                
                stopsLayer.addLayer(marker);
            }
        }
    });
}

map.on('moveend', updateVisibleStops);
map.on('zoomend', updateVisibleStops);
