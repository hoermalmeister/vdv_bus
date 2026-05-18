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

// Záložní barvy
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
    // Miniaturní na oddálení, krásně čitelné na přiblížení
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

                    // --- NOVÁ, MATEMATICKY PŘESNÁ LOGIKA ROZMÍSTĚNÍ ŠTÍTKŮ ---
                    let totalLength = 0;
                    let segmentsData = [];

                    // 1. Změříme absolutně celou linku (všechny její rozsekané kousky)
                    feature.geometry.coordinates.forEach(linePart => {
                        let partLength = 0;
                        let dists = [];
                        for(let i=0; i<linePart.length-1; i++) {
                            let p1 = linePart[i];
                            let p2 = linePart[i+1];
                            let d = map.distance([p1[1], p1[0]], [p2[1], p2[0]]);
                            dists.push(d);
                            partLength += d;
                        }
                        totalLength += partLength;
                        segmentsData.push({ coords: linePart, dists: dists, length: partLength });
                    });

                    if (totalLength > 0) {
                        // 2. Chceme štítek každé 3,5 kilometry. Vždy ale alespoň jeden.
                        const labelSpacing = 3500; 
                        const labelCount = Math.max(1, Math.round(totalLength / labelSpacing));
                        const routeColor = feature.properties.color || getColorForGroup(feature.properties.group);

                        // Určíme si přesné vzdálenosti (např. při 2 štítcích to bude na 25% a 75% trasy)
                        let targets = [];
                        for (let i = 1; i <= labelCount; i++) {
                            targets.push(totalLength * (i - 0.5) / labelCount);
                        }

                        let currentCumDist = 0;
                        let targetIndex = 0;

                        // 3. Projdeme celou trasu znovu a zapíchneme štítky na správná místa
                        for (let s = 0; s < segmentsData.length; s++) {
                            let seg = segmentsData[s];
                            for (let i = 0; i < seg.coords.length - 1; i++) {
                                let d = seg.dists[i];

                                while (targetIndex < targets.length && currentCumDist + d >= targets[targetIndex]) {
                                    let targetDist = targets[targetIndex];
                                    let localDist = targetDist - currentCumDist;
                                    let ratio = d === 0 ? 0 : localDist / d;

                                    let p1 = seg.coords[i];
                                    let p2 = seg.coords[i+1];
                                    
                                    // Geografická interpolace přesně doprostřed silnice
                                    let lat = p1[1] + (p2[1] - p1[1]) * ratio;
                                    let lon = p1[0] + (p2[0] - p1[0]) * ratio;

                                    const badgeTooltip = L.tooltip([lat, lon], {
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
                                    targetIndex++;
                                }
                                currentCumDist += d;
                            }
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
