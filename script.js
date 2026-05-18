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

const linesLayer = L.layerGroup().addTo(map);
const routeBadgesLayer = L.layerGroup().addTo(map); 
const stopsLayer = L.layerGroup().addTo(map); 

let allBadges = [];
let allStops = [];
let activeRouteGroup = null;

// FOCUS MÓD
function highlightRoute(group) {
    activeRouteGroup = group;
    
    linesLayer.eachLayer(layer => {
        if (!activeRouteGroup) {
            layer.setStyle({ opacity: 0.9, weight: 4 });
        } else if (layer.feature.properties.group === activeRouteGroup) {
            layer.setStyle({ opacity: 1, weight: 6 });
            if (layer.bringToFront) layer.bringToFront();
        } else {
            layer.setStyle({ opacity: 0.10, weight: 3 }); 
        }
    });

    renderMapElements(); 
}

map.on('click', function() {
    if (activeRouteGroup !== null) highlightRoute(null);
});

// Změna velikosti štítků podle zoomu
function adjustBadgeSize(element, zoom) {
    const fontSize = 6 + (zoom - 10); 
    element.style.fontSize = fontSize + 'px';
    if (zoom <= 11) {
        element.style.padding = '0px 2px'; element.style.borderWidth = '1px';
    } else if (zoom <= 13) {
        element.style.padding = '1px 3px'; element.style.borderWidth = '1.5px';
    } else {
        element.style.padding = '2px 5px'; element.style.borderWidth = '2px';
    }
}

function updateAllBadgeSizes() {
    const currentZoom = map.getZoom();
    document.querySelectorAll('.route-map-badge').forEach(badge => adjustBadgeSize(badge, currentZoom));
}

// NAČÍTÁME PŘEDŽVÝKANÁ DATA Z PYTHONU
fetch('trasy.geojson?t=' + new Date().getTime())
    .then(response => response.json())
    .then(data => {
        L.geoJSON(data, {
            style: function(feature) {
                if (feature.geometry.type === "MultiLineString") {
                    return { color: feature.properties.color, weight: 4, opacity: 0.9, lineCap: 'round', lineJoin: 'round' };
                }
            },
            onEachFeature: function (feature, layer) {
                const props = feature.properties;

                if (feature.geometry.type === "MultiLineString") {
                    // 1. ČÁRY LINEK
                    layer.on('click', function(e) {
                        L.DomEvent.stopPropagation(e);
                        highlightRoute(activeRouteGroup === props.group ? null : props.group);
                    });
                    linesLayer.addLayer(layer);

                } else if (props.type === "badge") {
                    // 2. ŠTÍTKY LINEK (Vytvořeny už v Pythonu)
                    const lat = feature.geometry.coordinates[1];
                    const lon = feature.geometry.coordinates[0];

                    const badgeTooltip = L.tooltip([lat, lon], {
                        permanent: true, direction: 'center', className: 'route-map-badge', interactive: true
                    }).setContent(props.group);

                    badgeTooltip.on('add', function(e) {
                        const el = e.target.getElement();
                        el.style.borderColor = props.color;
                        el.style.cursor = 'pointer';
                        el.style.pointerEvents = 'auto';
                        
                        el.addEventListener('click', function(domEvent) {
                            domEvent.stopPropagation();
                            highlightRoute(activeRouteGroup === props.group ? null : props.group);
                        });
                        adjustBadgeSize(el, map.getZoom());
                    });

                    allBadges.push({ layer: badgeTooltip, group: props.group });

                } else if (props.type === "stop" && props.show_label) {
                    // 3. ZASTÁVKY (Zůstaly jen ty, co přežily Python filtr!)
                    const lat = feature.geometry.coordinates[1];
                    const lon = feature.geometry.coordinates[0];

                    const htmlContent = `
                        <span class="stop-dot"></span>
                        <span>${props.name}</span>
                        <span class="stop-zone-text">${props.zones_formatted}</span>
                    `;

                    // Původní dokonalý formát: Tečka (CircleMarker) s obdélníkem nahoře (Tooltip)
                    const marker = L.circleMarker([lat, lon], {
                        radius: 4, color: '#fff', weight: 1.5, fillColor: '#58d68d', fillOpacity: 1
                    }).bindTooltip(htmlContent, { 
                        permanent: true, direction: 'top', className: 'modern-stop-label', offset: [0, -6]
                    });
                    
                    allStops.push(marker);
                }
            }
        });
        
        renderMapElements(); 
        document.getElementById('loading').style.display = 'none';
    })
    .catch(error => {
        document.getElementById('loading').innerText = "Chyba při načítání dat z Pythonu.";
        console.error(error);
    });

// JEDINÁ RENDEROVACÍ FUNKCE BEZ MATEMATIKY
function renderMapElements() {
    routeBadgesLayer.clearLayers();
    stopsLayer.clearLayers();
    const currentZoom = map.getZoom();

    allBadges.forEach(badge => {
        if (!activeRouteGroup || activeRouteGroup === badge.group) {
            routeBadgesLayer.addLayer(badge.layer);
        }
    });

    // Zastávky se nahodí až při zoomu 15
    if (currentZoom >= 15) {
        allStops.forEach(stop => stopsLayer.addLayer(stop));
    }
}

// ZMĚNY OPĚT ŘEŠÍME JEN PŘI ZMĚNĚ ZOOMU
map.on('zoomend', function() {
    renderMapElements();
    updateAllBadgeSizes();
});
