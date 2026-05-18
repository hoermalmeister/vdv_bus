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

// OBŘÍ OPTIMALIZACE: Zde držíme vše připravené
let allBadges = []; 
let allStops = []; 
let placedRouteBadgesAtZoom13 = [];
let activeRouteGroup = null;

// LOGIKA FOCUS MÓDU
function highlightRoute(group) {
    activeRouteGroup = group;
    
    linesLayer.eachLayer(layer => {
        if (!activeRouteGroup) {
            layer.setStyle({ opacity: 0.9, weight: 4 });
        } else if (layer.feature.properties.group === activeRouteGroup) {
            layer.setStyle({ opacity: 1, weight: 6 });
            if (layer.bringToFront) layer.bringToFront();
        } else {
            layer.setStyle({ opacity: 0.10, weight: 3 }); // Zvednuto na 10 %
        }
    });

    updateVisibleElements(); // Bleskově překreslí štítky
}

map.on('click', function() {
    if (activeRouteGroup !== null) highlightRoute(null);
});

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
    badges.forEach(badge => adjustBadgeSize(badge, currentZoom));
}

function getPointAtFraction(coords, dists, fraction) {
    let total = dists.reduce((a, b) => a + b, 0);
    let target = total * fraction;
    let current = 0;
    for (let i = 0; i < coords.length - 1; i++) {
        let d = dists[i];
        if (current + d >= target) {
            let ratio = d === 0 ? 0 : (target - current) / d;
            return [coords[i][1] + (coords[i+1][1] - coords[i][1]) * ratio, coords[i][0] + (coords[i+1][0] - coords[i][0]) * ratio];
        }
        current += d;
    }
    return [coords[coords.length-1][1], coords[coords.length-1][0]];
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
                    
                    layer.on('click', function(e) {
                        L.DomEvent.stopPropagation(e);
                        const group = feature.properties.group;
                        highlightRoute(activeRouteGroup === group ? null : group);
                    });

                    linesLayer.addLayer(layer);

                    let totalLength = 0;
                    let segmentsData = [];

                    feature.geometry.coordinates.forEach(linePart => {
                        let partLength = 0; let dists = [];
                        for(let i=0; i<linePart.length-1; i++) {
                            let d = map.distance([linePart[i][1], linePart[i][0]], [linePart[i+1][1], linePart[i+1][0]]);
                            dists.push(d); partLength += d;
                        }
                        totalLength += partLength;
                        if (partLength > 0) segmentsData.push({ coords: linePart, dists: dists, length: partLength });
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
                            let candidateFractions = [0.5, 0.25, 0.75];
                            
                            for (let fraction of candidateFractions) {
                                let pt = getPointAtFraction(seg.coords, seg.dists, fraction);
                                let isTooClose = false;

                                for (let p of placedPoints) {
                                    if (map.distance(pt, p) < 5000) { isTooClose = true; break; }
                                }

                                if (!isTooClose) {
                                    const p13Candidate = map.project(L.latLng(pt[0], pt[1]), 13);
                                    for (let pb13 of placedRouteBadgesAtZoom13) {
                                        if (Math.abs(p13Candidate.x - pb13.x) < 38 && Math.abs(p13Candidate.y - pb13.y) < 14) {
                                            isTooClose = true; break;
                                        }
                                    }
                                }

                                if (!isTooClose) {
                                    placedPoints.push(pt);
                                    placedRouteBadgesAtZoom13.push(map.project(L.latLng(pt[0], pt[1]), 13));

                                    // VYTVOŘENÍ A ULOŽENÍ ŠTÍTKU (nevykreslujeme hned!)
                                    const html = `<div class="route-map-badge" style="border-color: ${routeColor}">${feature.properties.group}</div>`;
                                    const marker = L.marker(pt, {
                                        icon: L.divIcon({ className: '', html: html, iconSize: [0, 0] }),
                                        interactive: true
                                    });

                                    marker.on('click', function(e) {
                                        L.DomEvent.stopPropagation(e);
                                        const group = feature.properties.group;
                                        highlightRoute(activeRouteGroup === group ? null : group);
                                    });

                                    allBadges.push({ latlng: L.latLng(pt), layer: marker, group: feature.properties.group });
                                    break;
                                }
                            }
                        }
                        
                        if (placedPoints.length === 0) {
                            let pt = getPointAtFraction(segmentsData[0].coords, segmentsData[0].dists, 0.5);
                            let hash = parseInt(feature.properties.group) || 0;
                            let finalPt = [pt[0] + (((hash % 5) - 2) * 0.00015), pt[1] + ((((hash * 7) % 5) - 2) * 0.00015)];

                            const html = `<div class="route-map-badge" style="border-color: ${routeColor}">${feature.properties.group}</div>`;
                            const marker = L.marker(finalPt, {
                                icon: L.divIcon({ className: '', html: html, iconSize: [0, 0] }),
                                interactive: true
                            });

                            marker.on('click', function(e) {
                                L.DomEvent.stopPropagation(e);
                                const group = feature.properties.group;
                                highlightRoute(activeRouteGroup === group ? null : group);
                            });

                            allBadges.push({ latlng: L.latLng(finalPt), layer: marker, group: feature.properties.group });
                        }
                    }
                } else if (feature.geometry.type === "Point") {
                    // PŘEDPŘÍPRAVA ZASTÁVEK
                    const rawZone = feature.properties.zone || "";
                    const vZones = rawZone.split(',').map(z => z.trim()).filter(z => z.startsWith('V'));

                    if (vZones.length > 0) {
                        const htmlContent = `
                            <div class="modern-stop-label">
                                <span class="stop-dot"></span>
                                <span>${feature.properties.name}</span>
                                <span class="stop-zone-text">${vZones.join(',')}</span>
                            </div>
                        `;
                        
                        const marker = L.marker([feature.geometry.coordinates[1], feature.geometry.coordinates[0]], {
                            icon: L.divIcon({ className: '', html: htmlContent, iconSize: [0,0] }),
                            interactive: false
                        });

                        allStops.push({ 
                            latlng: L.latLng(feature.geometry.coordinates[1], feature.geometry.coordinates[0]), 
                            layer: marker,
                            name: feature.properties.name,
                            zones: vZones
                        });
                    }
                }
            }
        });
        
        updateVisibleElements(); 
        document.getElementById('loading').style.display = 'none';
    })
    .catch(error => {
        document.getElementById('loading').innerText = "Chyba při načítání dat.";
        console.error(error);
    });

// JEDEN SPOLEČNÝ BLESKOVÝ RENDER LOOP PRO ŠTÍTKY I ZASTÁVKY
function updateVisibleElements() {
    const bounds = map.getBounds().pad(0.1); // 10% přesah, aby štítky neuskakovaly na hraně obrazovky
    const currentZoom = map.getZoom();

    // 1. Zpracování štítků linek
    allBadges.forEach(badge => {
        const isFocused = !activeRouteGroup || activeRouteGroup === badge.group;
        
        // Zobrazí se jen pokud je v obrazovce a není skrytý Focus Módem
        if (isFocused && bounds.contains(badge.latlng)) {
            if (!routeBadgesLayer.hasLayer(badge.layer)) routeBadgesLayer.addLayer(badge.layer);
        } else {
            if (routeBadgesLayer.hasLayer(badge.layer)) routeBadgesLayer.removeLayer(badge.layer);
        }
    });

    // 2. Zpracování zastávek
    if (currentZoom >= 15) {
        let placedStopsBoxes = [];
        
        allStops.forEach(stop => {
            if (bounds.contains(stop.latlng)) {
                const pCurrent = map.project(stop.latlng, currentZoom);
                const estimatedWidth = (stop.name.length + stop.zones.join(',').length) * 6.2 + 45; 

                const candBox = {
                    minX: pCurrent.x - estimatedWidth / 2, maxX: pCurrent.x + estimatedWidth / 2,
                    minY: pCurrent.y - 28, maxY: pCurrent.y - 6
                };

                let overlaps = false;
                for (let box of placedStopsBoxes) {
                    if (!(candBox.maxX < box.minX || candBox.minX > box.maxX || candBox.maxY < box.minY || candBox.minY > box.maxY)) {
                        overlaps = true; break;
                    }
                }

                if (!overlaps) {
                    placedStopsBoxes.push(candBox);
                    if (!stopsLayer.hasLayer(stop.layer)) stopsLayer.addLayer(stop.layer);
                } else {
                    if (stopsLayer.hasLayer(stop.layer)) stopsLayer.removeLayer(stop.layer);
                }
            } else {
                if (stopsLayer.hasLayer(stop.layer)) stopsLayer.removeLayer(stop.layer);
            }
        });
    } else {
        stopsLayer.clearLayers();
    }
}

map.on('moveend', updateVisibleElements);
map.on('zoomend', function() {
    updateVisibleElements();
    updateAllBadgeSizes();
});
