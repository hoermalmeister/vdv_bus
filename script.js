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

// Globální mezipaměť pixelových pozic štítků pro detekci kolizí na zoomu 13
let placedRouteBadgesAtZoom13 = [];

// DYNAMICKÉ ŠKÁLOVÁNÍ VELIKOSTÍ
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
        // Reset paměti kolizí před novým načtením
        placedRouteBadgesAtZoom13 = [];

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
                        segmentsData.sort((a, b) => b.length - a.length);

                        let labelCount = 1;
                        if (totalLength > 60000) labelCount = 5;
                        else if (totalLength > 40000) labelCount = 4;
                        else if (totalLength > 20000) labelCount = 3;
                        else if (totalLength > 10000) labelCount = 2;

                        const routeColor = feature.properties.color || getColorForGroup(feature.properties.group);
                        let placedPoints = [];

                        for (let i = 0; i < segmentsData.length; i++) {
                            if (placedPoints.length >= labelCount) break;

                            let candidatePoint = segmentsData[i].midpoint;
                            let isTooClose = false;

                            // 1. Geografický filtr v rámci STEJNÉ linky (min 6 km rozestup)
                            for (let pt of placedPoints) {
                                if (map.distance(candidatePoint, pt) < 6000) { 
                                    isTooClose = true;
                                    break;
                                }
                            }

                            // 2. NOVÉ: Pixelový filtr vůči VŠEM LINKÁM na základě simulace Zoomu 13
                            if (!isTooClose) {
                                const latlngCandidate = L.latLng(candidatePoint[0], candidatePoint[1]);
                                // Převedeme GPS na pixely obrazovky specificky pro zoom 13
                                const p13Candidate = map.project(latlngCandidate, 13);

                                for (let pb13 of placedRouteBadgesAtZoom13) {
                                    // Detekujeme kolizi obdélníků (šířka štítku cca 35px, výška cca 14px)
                                    if (Math.abs(p13Candidate.x - pb13.x) < 35 && Math.abs(p13Candidate.y - pb13.y) < 14) {
                                        isTooClose = true;
                                        break;
                                    }
                                }
                            }

                            if (!isTooClose) {
                                placedPoints.push(candidatePoint);
                                
                                // Uložíme pixelovou simulaci do globálního pole kolizí
                                const finalLatLng = L.latLng(candidatePoint[0], candidatePoint[1]);
                                placedRouteBadgesAtZoom13.push(map.project(finalLatLng, 13));

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
                        
                        // Záchranná brzda pro 1 povinný štítek (ignoruje globální kolize, aby linka nezůstala anonymní)
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

// VIEWPORT RENDERING + DETEKCE KOLIZÍ PRO ZASTÁVKY
function updateVisibleStops() {
    stopsLayer.clearLayers(); 
    if (map.getZoom() < 15) return;

    const bounds = map.getBounds();
    const currentZoom = map.getZoom();
    
    // Lokální pole pro hlídání textových překryvů zastávek na aktuální obrazovce
    let placedStopsPixels = [];

    allStopsData.forEach(feature => {
        const coords = feature.geometry.coordinates;
        const latlng = L.latLng(coords[1], coords[0]);

        if (bounds.contains(latlng)) {
            const rawZone = feature.properties.zone || "";
            const vZones = rawZone.split(',').map(z => z.trim()).filter(z => z.startsWith('V'));

            if (vZones.length > 0) {
                // Převod aktuální pozice zastávky na pixely obrazovky (zoom 15)
                const pCurrent = map.project(latlng, currentZoom);
                let stopOverlaps = false;

                for (let ps of placedStopsPixels) {
                    // Pilulky s názvy měst jsou široké. Bezpečný box: 100px na šířku, 18px na výšku.
                    if (Math.abs(pCurrent.x - ps.x) < 100 && Math.abs(pCurrent.y - ps.y) < 18) {
                        stopOverlaps = true;
                        break;
                    }
                }

                // Pokud by popisek narazil do jiného, už ho nevykreslíme
                if (stopOverlaps) return;

                // Pokud prošel filtrem, zapíšeme si jeho pixely a vyrenderujeme ho
                placedStopsPixels.push(pCurrent);

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
