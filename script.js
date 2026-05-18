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
let placedRouteBadgesAtZoom13 = [];

// Pomocná funkce pro výpočet GPS bodu v určité procentuální části [0.0 - 1.0] úseku
function getPointAtFraction(coords, dists, fraction) {
    let total = dists.reduce((a, b) => a + b, 0);
    let target = total * fraction;
    let current = 0;
    for (let i = 0; i < coords.length - 1; i++) {
        let d = dists[i];
        if (current + d >= target) {
            let ratio = d === 0 ? 0 : (target - current) / d;
            let lat = coords[i][1] + (coords[i+1][1] - coords[i][1]) * ratio;
            let lon = coords[i][0] + (coords[i+1][0] - coords[i][0]) * ratio;
            return [lat, lon];
        }
        current += d;
    }
    return [coords[coords.length-1][1], coords[coords.length-1][0]];
}

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
                        let dists = [];
                        for(let i=0; i<linePart.length-1; i++) {
                            let d = map.distance([linePart[i][1], linePart[i][0]], [linePart[i+1][1], linePart[i+1][0]]);
                            dists.push(d);
                            partLength += d;
                        }
                        totalLength += partLength;
                        if (partLength > 0) {
                            segmentsData.push({ coords: linePart, dists: dists, length: partLength });
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
                            let seg = segmentsData[i];
                            
                            // ROZESAZOVÁNÍ (STAGGERING): Pokud střed (0.5) koliduje, zkusíme kraje (0.25 a 0.75)
                            let candidateFractions = [0.5, 0.25, 0.75];
                            
                            for (let fraction of candidateFractions) {
                                let candidatePoint = getPointAtFraction(seg.coords, seg.dists, fraction);
                                let isTooClose = false;

                                // 1. Geografický filtr (rozestup v rámci stejné linky)
                                for (let pt of placedPoints) {
                                    if (map.distance(candidatePoint, pt) < 5000) { 
                                        isTooClose = true;
                                        break;
                                    }
                                }

                                // 2. Globální pixelový filtr na zoomu 13 (mezi všemi linkami navzájem)
                                if (!isTooClose) {
                                    const p13Candidate = map.project(L.latLng(candidatePoint[0], candidatePoint[1]), 13);
                                    for (let pb13 of placedRouteBadgesAtZoom13) {
                                        if (Math.abs(p13Candidate.x - pb13.x) < 38 && Math.abs(p13Candidate.y - pb13.y) < 14) {
                                            isTooClose = true;
                                            break;
                                        }
                                    }
                                }

                                if (!isTooClose) {
                                    placedPoints.push(candidatePoint);
                                    placedRouteBadgesAtZoom13.push(map.project(L.latLng(candidatePoint[0], candidatePoint[1]), 13));

                                    const badgeTooltip = L.tooltip(candidatePoint, {
                                        permanent: true, direction: 'center', className: 'route-map-badge', interactive: false
                                    }).setContent(feature.properties.group);

                                    badgeTooltip.on('add', function(e) {
                                        const el = e.target.getElement();
                                        el.style.borderColor = routeColor;
                                        adjustBadgeSize(el, map.getZoom());
                                    });

                                    routeBadgesLayer.addLayer(badgeTooltip);
                                    break; // Úspěšně umístěno, ukončíme testování frakcí pro tento úsek
                                }
                            }
                        }
                        
                        // Záchranná pojistka pro 1 povinný štítek s jemným rozptylem (Jitter)
                        if (placedPoints.length === 0) {
                            let seg = segmentsData[0];
                            let pt = getPointAtFraction(seg.coords, seg.dists, 0.5);
                            
                            let hash = parseInt(feature.properties.group) || 0;
                            let jitterLat = ((hash % 5) - 2) * 0.00015;
                            let jitterLon = (((hash * 7) % 5) - 2) * 0.00015;
                            let finalPt = [pt[0] + jitterLat, pt[1] + jitterLon];

                            const badgeTooltip = L.tooltip(finalPt, {
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

// VIEWPORT RENDERING + PROFESIONÁLNÍ DETEKCE PRŮNIKU OBDÉLNÍKŮ (AABB)
function updateVisibleStops() {
    stopsLayer.clearLayers(); 
    if (map.getZoom() < 15) return;

    const bounds = map.getBounds();
    const currentZoom = map.getZoom();
    
    // Pole pro ukládání přesných 2D rozměrů vyrenderovaných textů zastávek
    let placedStopsBoxes = [];

    allStopsData.forEach(feature => {
        const coords = feature.geometry.coordinates;
        const latlng = L.latLng(coords[1], coords[0]);

        if (bounds.contains(latlng)) {
            const rawZone = feature.properties.zone || "";
            const vZones = rawZone.split(',').map(z => z.trim()).filter(z => z.startsWith('V'));

            if (vZones.length > 0) {
                const pCurrent = map.project(latlng, currentZoom);
                
                // DYNAMICKÝ VÝPOČET ROZMĚRU: šířka se odvíjí od reálného počtu písmen názvu + zóny
                const totalChars = feature.properties.name.length + vZones.join(',').length;
                const estimatedWidth = totalChars * 6.2 + 45; 
                const estimatedHeight = 22; 

                // Matematický box textu, který se vznáší NAD bodem zastávky
                const candBox = {
                    minX: pCurrent.x - estimatedWidth / 2,
                    maxX: pCurrent.x + estimatedWidth / 2,
                    minY: pCurrent.y - estimatedHeight - 6, 
                    maxY: pCurrent.y + 2
                };

                // Detekce kolizí: Test, zda se obdélník kandidáta překrývá s jakýmkoliv už položeným obdélníkem
                let overlaps = false;
                for (let box of placedStopsBoxes) {
                    if (!(candBox.maxX < box.minX || candBox.minX > box.maxX || candBox.maxY < box.minY || candBox.minY > box.maxY)) {
                        overlaps = true;
                        break;
                    }
                }

                if (overlaps) return; // Pokud detekujeme překryv textu, zastávku zahodíme

                // Pokud prošla čistě, zapamatujeme si její obdélník pro další porovnávání
                placedStopsBoxes.push(candBox);

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
