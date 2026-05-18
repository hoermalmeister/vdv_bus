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
                    // ČÁRY
                    layer.on('click', function(e) {
                        L.DomEvent.stopPropagation(e);
                        highlightRoute(activeRouteGroup === props.group ? null : props.group);
                    });
                    linesLayer.addLayer(layer);

                } else if (props.type === "badge") {
                    // ŠTÍTKY (Předpočítané v Pythonu)
                    const html = `<div class="route-map-badge" style="border-color: ${props.color}">${props.group}</div>`;
                    const marker = L.marker([feature.geometry.coordinates[1], feature.geometry.coordinates[0]], {
                        icon: L.divIcon({ className: '', html: html, iconSize: [0, 0] }),
                        interactive: true
                    });

                    marker.on('click', function(e) {
                        L.DomEvent.stopPropagation(e);
                        highlightRoute(activeRouteGroup === props.group ? null : props.group);
                    });

                    allBadges.push({ layer: marker, group: props.group });

                } else if (props.type === "stop" && props.show_label) {
                    // ZASTÁVKY (Zůstaly jen ty, co přežily Python filtr!)
                    const htmlContent = `
                        <div class="modern-stop-label">
                            <span class="stop-dot"></span>
                            <span>${props.name}</span>
                            <span class="stop-zone-text">${props.zones_formatted}</span>
                        </div>
                    `;
                    const marker = L.marker([feature.geometry.coordinates[1], feature.geometry.coordinates[0]], {
                        icon: L.divIcon({ className: '', html: htmlContent, iconSize: [0,0] }),
                        interactive: false
                    });
                    
                    allStops.push(marker);
                }
            }
        });
        
        renderMapElements(); 
        document.getElementById('loading').style.display = 'none';
    });

// JEDINÁ RENDEROVACÍ FUNKCE (Žádná matematika, jen on/off switch)
function renderMapElements() {
    routeBadgesLayer.clearLayers();
    stopsLayer.clearLayers();
    
    const currentZoom = map.getZoom();

    // Vyrendrujeme všechny připravené štítky linek (pokud nejsou filtrované)
    allBadges.forEach(badge => {
        if (!activeRouteGroup || activeRouteGroup === badge.group) {
            routeBadgesLayer.addLayer(badge.layer);
            
            // Pojistka pro nahození správného CSS při prvním vložení do DOMu
            setTimeout(() => {
                const el = badge.layer.getElement();
                if (el) adjustBadgeSize(el.querySelector('.route-map-badge'), currentZoom);
            }, 0);
        }
    });

    // Zastávky prostě plácneme do mapy, jakmile jsme na zoomu 15
    if (currentZoom >= 15) {
        allStops.forEach(stop => stopsLayer.addLayer(stop));
    }
}

map.on('zoomend', function() {
    renderMapElements();
    updateAllBadgeSizes();
});
