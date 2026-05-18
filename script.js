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

// DYNAMICKÉ ŠKÁLOVÁNÍ: Pomocná funkce pro nastavení rozměrů podle aktuálního zoomu
function adjustBadgeSize(element, zoom) {
    // Zoom 10 -> písmno 6px, Zoom 11 -> 7px ... až Zoom 15 -> 11px
    const fontSize = 6 + (zoom - 10); 
    element.style.fontSize = fontSize + 'px';
    
    // Extrémně miniaturní okraje pro nízké zoomy, aby štítky nepřetékaly přes čáru
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

// Projde všechny štítky aktuálně vyrenderované v DOMu a změní jim styl
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
                        color: feature.properties.color,
                        weight: 4, opacity: 0.9, lineCap: 'round', lineJoin: 'round'
                    };
                }
            },
            onEachFeature: function (feature, layer) {
                if (feature.geometry.type === "MultiLineString") {
                    linesLayer.addLayer(layer);

                    let longestLine = [];
                    let maxDist = 0;
                    
                    feature.geometry.coordinates.forEach(linePart => {
                        let dist = 0;
                        for(let i=0; i<linePart.length-1; i++) {
                            dist += map.distance([linePart[i][1], linePart[i][0]], [linePart[i+1][1], linePart[i+1][0]]);
                        }
                        if(dist > maxDist) {
                            maxDist = dist;
                            longestLine = linePart;
                        }
                    });

                    if (longestLine.length > 0) {
                        // --- HUSTŠÍ ROZMÍSTĚNÍ: Štítek automaticky každých 6 km trasy ---
                        const stepDist = 6000; 
                        const labelCount = Math.max(1, Math.floor(maxDist / stepDist));

                        const routeColor = feature.properties.color;

                        for (let i = 1; i <= labelCount; i++) {
                            let targetDist = maxDist * (i / (labelCount + 1));
                            let currentDist = 0;
                            let exactPoint = null;

                            for(let j=0; j<longestLine.length-1; j++) {
                                let p1 = longestLine[j];
                                let p2 = longestLine[j+1];
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
                            
                            if (!exactPoint) exactPoint = [longestLine[longestLine.length-1][1], longestLine[longestLine.length-1][0]];

                            const badgeTooltip = L.tooltip(exactPoint, {
                                permanent: true,
                                direction: 'center',
                                className: 'route-map-badge',
                                interactive: false
                            }).setContent(feature.properties.group);

                            // Při vykreslení štítku mu nastavíme barvu a okamžitě aplikujeme správný zoom styl
                            badgeTooltip.on('add', function(e) {
                                const el = e.target.getElement();
                                el.style.borderColor = routeColor;
                                adjustBadgeSize(el, map.getZoom());
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

// Při jakémkoliv dokončení pohybu/zoomu aktualizujeme zastávky i velikosti všech textů
map.on('moveend', updateVisibleStops);
map.on('zoomend', function() {
    updateVisibleStops();
    updateAllBadgeSizes();
});
