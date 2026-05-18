// --- 1. ČTENÍ URL PŘI STARTU (Query Parametry: ?x=...&y=...&z=...&line=...) ---
let startZoom = 10;
let startLat = 49.4;
let startLng = 15.6;
let initialRoute = null;

const urlParams = new URLSearchParams(window.location.search);
if (urlParams.has('z')) startZoom = parseInt(urlParams.get('z'), 10);
if (urlParams.has('y')) startLat = parseFloat(urlParams.get('y'));
if (urlParams.has('x')) startLng = parseFloat(urlParams.get('x'));
if (urlParams.has('line')) initialRoute = urlParams.get('line');

// Inicializace mapy s hodnotami z URL
const map = L.map('map', { 
    preferCanvas: true,
    minZoom: 10,
    maxZoom: 15
}).setView([startLat, startLng], startZoom); 

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

// --- 2. ZAPISOVÁNÍ DO URL PŘI POHYBU ---
function updateURL() {
    const center = map.getCenter();
    const zoom = map.getZoom();
    
    const params = new URLSearchParams();
    params.set('x', center.lng.toFixed(4));
    params.set('y', center.lat.toFixed(4));
    params.set('z', zoom);
    
    if (activeRouteGroup) {
        params.set('line', activeRouteGroup);
    }
    
    // Změní URL bez znovunačtení stránky (zachová cestu, např. /vdv_bus/)
    const newUrl = window.location.pathname + '?' + params.toString();
    window.history.replaceState(null, '', newUrl);
}

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
    updateURL(); // Aktualizujeme URL při změně linky
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

// NAČÍTÁNÍ PŘEDŽVÝKANÝCH DAT Z PYTHONU
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
                    layer.on('click', function(e) {
                        L.DomEvent.stopPropagation(e);
                        highlightRoute(activeRouteGroup === props.group ? null : props.group);
                    });
                    linesLayer.addLayer(layer);

                } else if (props.type === "badge") {
                    const latlng = L.latLng(feature.geometry.coordinates[1], feature.geometry.coordinates[0]);

                    const badgeTooltip = L.tooltip(latlng, {
                        permanent: true, direction: 'center', className: 'route-map-badge', interactive: true
                    }).setContent(props.group);

                    badgeTooltip.on('add', function(e) {
                        const el = e.target.getElement();
                        el.style.borderColor = props.color;
                        el.style.cursor = 'pointer';
                        el.style.pointerEvents = 'auto';
                        
                        el.onclick = function(domEvent) {
                            domEvent.stopPropagation();
                            highlightRoute(activeRouteGroup === props.group ? null : props.group);
                        };

                        adjustBadgeSize(el, map.getZoom());
                    });

                    allBadges.push({ layer: badgeTooltip, latlng: latlng, group: props.group });

                } else if (props.type === "stop" && props.show_label) {
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

        // --- 3. APLIKOVÁNÍ VÝCHOZÍ LINKY Z URL ---
        if (initialRoute) {
            highlightRoute(initialRoute);
        }
    })
    .catch(error => {
        document.getElementById('loading').innerText = "Chyba při načítání dat.";
        console.error(error);
    });

// RENDEROVACÍ LOOP
function renderVisibleElements() {
    const bounds = map.getBounds().pad(0.1);
    const currentZoom = map.getZoom();

    allBadges.forEach(badge => {
        const isFocused = !activeRouteGroup || activeRouteGroup === badge.group;
        const isVisible = bounds.contains(badge.latlng);

        if (isFocused && isVisible) {
            if (!routeBadgesLayer.hasLayer(badge.layer)) routeBadgesLayer.addLayer(badge.layer);
        } else {
            if (routeBadgesLayer.hasLayer(badge.layer)) routeBadgesLayer.removeLayer(badge.layer);
        }
    });

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

// Aktualizace URL při posunu mapy
map.on('moveend', function() {
    renderVisibleElements();
    updateURL();
});

map.on('zoomend', function() {
    renderVisibleElements();
    updateAllBadgeSizes();
    updateURL();
});

// --- 4. GPS LOKALIZACE UŽIVATELE ---
let userMarker = null;

document.getElementById('locate-btn').addEventListener('click', () => {
    map.locate({ setView: true, maxZoom: 14 });
});

map.on('locationfound', function(e) {
    if (!userMarker) {
        userMarker = L.circleMarker(e.latlng, {
            radius: 7,
            color: '#fff',
            weight: 2,
            fillColor: '#3388ff',
            fillOpacity: 1
        }).addTo(map);
    } else {
        userMarker.setLatLng(e.latlng);
    }
});

map.on('locationerror', function(e) {
    alert("Nepodařilo se zjistit vaši polohu. Zkontrolujte prosím oprávnění ve vašem prohlížeči.");
});
