// Inicializace mapy s limity přiblížení
const map = L.map('map', { 
    preferCanvas: true,
    minZoom: 10,
    maxZoom: 15
}).setView([49.4, 15.6], 10); 

// Tmavé podklady mapy
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap © CARTO',
    minZoom: 10, maxZoom: 15
}).addTo(map);

// Neonová paleta barev pro tmavé pozadí
const neonColors = ['#ff3366', '#33ff66', '#ff9933', '#33ccff', '#cc33ff', '#ffff33', '#ff33ff', '#33ffff', '#ff6666', '#66ff66', '#ffb366', '#66b3ff', '#ff99ff', '#99ffff'];

function getColorForGroup(group) {
    let hash = 0;
    for (let i = 0; i < group.length; i++) hash = group.charCodeAt(i) + ((hash << 5) - hash);
    return neonColors[Math.abs(hash) % neonColors.length];
}

const linesLayer = L.layerGroup().addTo(map);
const routeBadgesLayer = L.layerGroup().addTo(map); // Samostatná vrstva pro permanentní názvy linek
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

                    // VÝPOČET GEOGRAFICKÉHO STŘEDU LINKY PRO ŠTÍTEK DO MAPY
                    const bounds = layer.getBounds();
                    if (bounds.isValid()) {
                        const center = bounds.getCenter();
                        const routeColor = getColorForGroup(feature.properties.group);

                        // Vytvoření stálého štítku na středu trasy s injektovanou barvou borderu
                        const badgeTooltip = L.tooltip(center, {
                            permanent: true,
                            direction: 'center',
                            className: 'route-map-badge',
                            interactive: false
                        }).setContent(feature.properties.group);

                        // Po přidání do mapy mu přes JS upravíme barvu rámečku podle linky
                        badgeTooltip.on('add', function(e) {
                            e.target.getElement().style.borderColor = routeColor;
                        });

                        routeBadgesLayer.addLayer(badgeTooltip);
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

// VIEWPORT RENDERING: Kreslíme pouze to, co uživatel reálně vidí na obrazovce
function updateVisibleStops() {
    stopsLayer.clearLayers(); 
    
    // Zastávky a jejich názvy aktivujeme exkluzivně na zoomu 15
    if (map.getZoom() < 15) return;

    const bounds = map.getBounds();

    allStopsData.forEach(feature => {
        const coords = feature.geometry.coordinates;
        const latlng = L.latLng(coords[1], coords[0]);

        if (bounds.contains(latlng)) {
            const rawZone = feature.properties.zone || "";
            const vZones = rawZone.split(',').map(z => z.trim()).filter(z => z.startsWith('V'));

            if (vZones.length > 0) {
                // Sestavení nového moderního HTML obsahu pilulky
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

// Eventy pro plynulé překreslování výřezu
map.on('moveend', updateVisibleStops);
map.on('zoomend', updateVisibleStops);
