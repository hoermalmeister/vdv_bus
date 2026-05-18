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

// ŠUPLÍKY PRO ULOŽENÍ VŠECH PRVKŮ MIMO OBRAZOVKU
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

    renderVisibleElements(); 
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
                    // ŠTÍTKY 
                    const latlng = L.latLng(feature.geometry.coordinates[1], feature.geometry.coordinates[0]);

                    const badgeTooltip = L.tooltip(latlng, {
                        permanent: true, direction: 'center', className: 'route-map-badge', interactive: true
                    }).setContent(props.group);

                    badgeTooltip.on('add', function(e) {
                        const el = e.target.getElement();
                        el.style.borderColor = props.color;
                        el.style.cursor = 'pointer';
                        el.style.pointerEvents = 'auto';
                        
                        // ZDE JE TA SLÍBENÁ OPRAVA (onclick místo addEventListener)
                        el.onclick = function(domEvent) {
                            domEvent.stopPropagation();
                            highlightRoute(activeRouteGroup === props.group ? null : props.group);
                        };

                        adjustBadgeSize(el, map.getZoom());
                    });

                    allBadges.push({ layer: badgeTooltip, latlng: latlng, group: props.group });

                } else if (props.type === "stop" && props.show_label) {
                    // ZASTÁVKY 
                    const latlng = L.latLng(feature.geometry.coordinates[1], feature.geometry.coordinates[0]);

                    const htmlContent = `
                        <span class="stop-dot"></span>
                        <span>${props.name}</span>
                        <span class="stop-zone-text">${props.zones_formatted}</span>
                    `;

                    const marker = L.circleMarker(latlng, {
                        radius: 4, color: '#fff', weight: 1.5, fillColor: '#58d68d', fillOpacity: 1
                    }).bindTooltip(htmlContent, { 
                        permanent: true, direction: 'top', className: 'modern-stop-label', offset: [0, -6]
                    });
                    
                    allStops.push({ layer: marker, latlng: latlng });
                }
            }
        });
        
        renderVisibleElements(); 
        document.getElementById('loading').style.display = 'none';
    })
    .catch(error => {
        document.getElementById('loading').innerText = "Chyba při načítání dat.";
        console.error(error);
    });

function renderVisibleElements() {
    const bounds = map.getBounds().pad(0.1);
    const currentZoom = map.getZoom();

    // 1. ŠTÍTKY LINEK
    allBadges.forEach(badge => {
        const isFocused = !activeRouteGroup || activeRouteGroup === badge.group;
        const isVisible = bounds.contains(badge.latlng);

        if (isFocused && isVisible) {
            if (!routeBadgesLayer.hasLayer(badge.layer)) routeBadgesLayer.addLayer(badge.layer);
        } else {
            if (routeBadgesLayer.hasLayer(badge.layer)) routeBadgesLayer.removeLayer(badge.layer);
        }
    });

    // 2. ZASTÁVKY
    if (currentZoom >= 15) {
        allStops.forEach(stop => {
            if (bounds.contains(stop.latlng)) {
                if (!stopsLayer.hasLayer(stop.layer)) stopsLayer.addLayer(stop.layer);
            } else {
                if (stopsLayer.hasLayer(stop.layer)) stopsLayer.removeLayer(stop.layer);
            }
        });
    } else {
        stopsLayer.clearLayers();
    }
}

// Během tahání mapy je Leaflet plynulý. Jakmile zvedneš prst z displeje (moveend), vymažeme skryté prvky.
map.on('moveend', renderVisibleElements);

map.on('zoomend', function() {
    renderVisibleElements();
    updateAllBadgeSizes();
});
