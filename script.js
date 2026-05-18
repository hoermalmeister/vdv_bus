// Inicializace mapy
const map = L.map('map', { 
    preferCanvas: true,
    minZoom: 10,
    maxZoom: 15
}).setView([49.4, 15.6], 10); 

// Tmavé podklady
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

// DYNAMICKÉ ŠKÁLOVÁNÍ
function adjustBadgeSize(element, zoom) {
    const fontSize = 6 + (zoom - 10); 
    element.style.fontSize = fontSize + 'px';
    
    if (zoom <= 11) {
        element.style.padding = '0px 2px';
        element.style.borderWidth = '1px';
    } else if (zoom <= 13) {
        element.style.padding = '1px 3px';
        element.style.borderWidth = '1.5px';
    } else {
        element.style.padding = '2px 5px';
        element.style.borderWidth = '2px';
    }
}

function updateAllBadgeSizes() {
    const currentZoom = map.getZoom();
    const badges = document.querySelectorAll('.route-map-badge');
    badges.forEach(badge => {
        adjustBadgeSize(badge, currentZoom);
    });
}

fetch('trasy.geojson?t=' + new Date().getTime())
    .then(response => response.json())
    .then(data => {
        L.geoJSON(data, {
            style: function(feature) {
                if (feature.geometry.type === "MultiLineString") {
                    return {
                        color: feature.properties.color || getColorForGroup(feature.properties.group),
                        weight: 4, opacity: 0.9, lineCap: 'round', lineJoin: 'round'
                    };
                }
            },
            onEachFeature: function (feature, layer) {
                if (feature.geometry.type === "MultiLineString") {
                    linesLayer.addLayer(layer);

                    let totalLength = 0;
                    let segmentsData = [];

                    // 1. Změříme všechny nesouvislé úseky trasy a najdeme jejich geometrický střed
                    feature.geometry.coordinates.forEach(linePart => {
                        let partLength = 0;
                        for(let i=0; i<linePart.length-1; i++) {
                            partLength += map.distance([linePart[i][1], linePart[i][0]], [linePart[i+1][1], linePart[i+1][0]]);
                        }
                        totalLength += partLength;
                        
                        if (partLength > 0) {
                            let targetDist = partLength / 2;
                            let currentDist = 0;
                            let exactPoint = null;

                            // Hledání přesného středu na tomto kousku silnice
                            for(let j=0; j<linePart.length-1; j++) {
                                let p1 = linePart[j];
                                let p2 = linePart[j+1];
                                let d = map.distance([p1[1], p1[0]], [p2[1], p2[0]]);
                                if (currentDist + d >= targetDist) {
                                    let ratio = (targetDist - currentDist) / d;
                                    let lat = p1[1] + (p2[1] - p1[1]) * ratio;
                                    let lon = p1[0] + (p2[0] - p1[0]) * ratio;
                                    exactPoint = [lat, lon];
                                    break;
                                }
                                currentDist += d;
                            }
                            if (!exactPoint) exactPoint = [linePart[linePart.length-1][1], linePart[linePart.length-1][0]];
                            
                            segmentsData.push({ coords: linePart, length: partLength, midpoint: exactPoint });
                        }
                    });

                    if (segmentsData.length > 0) {
                        // 2. Seřadíme úseky podle délky (chceme štítky primárně na dlouhých rovných úsecích)
                        segmentsData.sort((a, b) => b.length - a.length);

                        // 3. Omezíme maximální počet štítků podle celkové délky linky
                        let labelCount = 1;
                        if (totalLength > 60000) labelCount = 5;      // Extrémně dlouhé linky (5 štítků)
                        else if (totalLength > 40000) labelCount = 4; // Dlouhé (4 štítky)
                        else if (totalLength > 20000) labelCount = 3; // Střední (3 štítky)
                        else if (totalLength > 10000) labelCount = 2; // Krátké (2 štítky)

                        const routeColor = feature.properties.color || getColorForGroup(feature.properties.group);
                        let placedPoints = [];

                        // 4. Projdeme středy nejdelších úseků a zkusíme tam dát štítek
                        for (let i = 0; i < segmentsData.length; i++) {
                            if (placedPoints.length >= labelCount) break;

                            let candidatePoint = segmentsData[i].midpoint;
                            let isTooClose = false;

                            // PROSTOROVÝ FILTR: Štítek nesmí být blíž než 6 km od jiného štítku této linky
                            for (let pt of placedPoints) {
                                if (map.distance(candidatePoint, pt) < 6000) { 
                                    isTooClose = true;
                                    break;
                                }
                            }

                            if (!isTooClose) {
                                placedPoints.push(candidatePoint);

                                const badgeTooltip = L.tooltip(candidatePoint, {
                                    permanent: true,
                                    direction: 'center',
                                    className: 'route-map-badge',
                                    interactive: false
                                }).setContent(feature.properties.group);

                                badgeTooltip.on('add', function(e) {
                                    const el = e.target.getElement();
                                    el.style.borderColor = routeColor;
                                    adjustBadgeSize(el, map.getZoom());
                                });

                                routeBadgesLayer.addLayer(badgeTooltip);
                            }
                        }
                        
                        // Záchranná brzda: Kdyby byla linka tak divná, že jsme neprošli filtrem, dáme prostě jeden štítek na nejdelší část
                        if (placedPoints.length === 0) {
                            const badgeTooltip = L.tooltip(segmentsData[0].midpoint, {
                                permanent: true, direction: 'center', className: 'route-map-badge', interactive: false
                            }).setContent(feature.properties.group);
                            badgeTooltip.on('add', function(e) {
                                e.target.getElement().style.borderColor = routeColor;
                                adjustBadgeSize(e.target.getElement(), map.getZoom());
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
map.on('zoomend', function() {
    updateVisibleStops();
    updateAllBadgeSizes();
});
