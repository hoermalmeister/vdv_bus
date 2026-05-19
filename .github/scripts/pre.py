import pandas as pd
import requests
import json
import time
import os
import math
from shapely.geometry import LineString
from collections import Counter

BASE_URL = "https://hoermalmeister.github.io/gtfs-rehost/vdv/"
CACHE_FILE = "osrm_cache.json"

NEON_COLORS = ['#ff3366', '#33ff66', '#ff9933', '#33ccff', '#cc33ff', '#ffff33', '#ff33ff', '#33ffff', '#ff6666', '#66ff66', '#ffb366', '#66b3ff', '#ff99ff', '#99ffff']
HUBS = ['jihlav', 'třebíč', 'žďár', 'nové město', 'pelhřimov', 'humpolec', 'brod']

def get_clean_group(name):
    digits = ''.join(filter(str.isdigit, str(name)))
    if digits: return str(int(digits[-3:]))
    return str(name).strip()[-3:]

def is_hub(stop_name):
    name_lower = str(stop_name).lower()
    return any(hub in name_lower for hub in HUBS)

# --- MATEMATIKA PRO OPTIMALIZACI OBRAZOVKY ---
def project(lat, lon, zoom):
    n = 2.0 ** zoom
    x = (lon + 180.0) / 360.0 * n * 256.0
    lat_rad = math.radians(lat)
    y = (1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n * 256.0
    return x, y

def haversine(lon1, lat1, lon2, lat2):
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlambda/2)**2
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1-a))

def get_point_at_fraction(coords, dists, fraction):
    target = sum(dists) * fraction
    current = 0
    for i, d in enumerate(dists):
        if current + d >= target:
            ratio = 0 if d == 0 else (target - current) / d
            lat = coords[i][1] + (coords[i+1][1] - coords[i][1]) * ratio
            lon = coords[i][0] + (coords[i+1][0] - coords[i][0]) * ratio
            return [lon, lat]
        current += d
    return coords[-1]

print("Stahuji data z GitHubu...")
routes = pd.read_csv(BASE_URL + "routes.txt")
trips = pd.read_csv(BASE_URL + "trips.txt")
stops = pd.read_csv(BASE_URL + "stops.txt")
stop_times = pd.read_csv(BASE_URL + "stop_times.txt", dtype={'stop_sequence': int})

print("Čistím data...")
stops = stops.dropna(subset=['stop_lon', 'stop_lat'])
stops['base_id'] = stops['stop_id'].astype(str).apply(lambda x: x.split('.')[0])
stops_clean = stops.drop_duplicates(subset=['base_id']).set_index('base_id')

routes['route_short_name'] = routes['route_short_name'].fillna(routes['route_long_name']).astype(str)
routes['group'] = routes['route_short_name'].apply(get_clean_group)
route_group_map = routes.set_index('route_id')['group'].to_dict()

trips['group'] = trips['route_id'].map(route_group_map)
trip_group_map = trips.set_index('trip_id')['group'].dropna().to_dict()

print("Sestavuji síť úseků...")
stop_times['group'] = stop_times['trip_id'].map(trip_group_map)
stop_times = stop_times.dropna(subset=['group', 'stop_id'])
stop_times['base_stop'] = stop_times['stop_id'].astype(str).apply(lambda x: x.split('.')[0])
stop_times.sort_values(by=['trip_id', 'stop_sequence'], inplace=True)
stop_times['next_stop'] = stop_times.groupby('trip_id')['base_stop'].shift(-1)

segments = stop_times.dropna(subset=['next_stop']).copy()
segments['canonical_pair'] = segments.apply(
    lambda r: f"{min(r['base_stop'], r['next_stop'])}@@@{max(r['base_stop'], r['next_stop'])}", axis=1
)

pair_groups = segments.groupby('canonical_pair')['group'].apply(lambda x: sorted(list(set(x)))).to_dict()

osrm_cache = {}
if os.path.exists(CACHE_FILE):
    with open(CACHE_FILE, "r", encoding="utf-8") as f:
        osrm_cache = json.load(f)

print("Fáze 1: Routování přes OSRM...")
api_calls = 0
for pair_id in pair_groups.keys():
    if pair_id in osrm_cache: continue
    s1, s2 = pair_id.split('@@@')
    if s1 not in stops_clean.index or s2 not in stops_clean.index: continue
    
    lon1, lat1 = stops_clean.loc[s1, 'stop_lon'], stops_clean.loc[s1, 'stop_lat']
    lon2, lat2 = stops_clean.loc[s2, 'stop_lon'], stops_clean.loc[s2, 'stop_lat']
    
    if pd.isna(lon1) or pd.isna(lat1) or pd.isna(lon2) or pd.isna(lat2): continue
    if abs(lon1 - lon2) > 0.8 or abs(lat1 - lat2) > 0.8: continue

    api_calls += 1
    try:
        url = f"http://router.project-osrm.org/route/v1/driving/{lon1},{lat1};{lon2},{lat2}?overview=full&geometries=geojson"
        res = requests.get(url, timeout=5)
        data = res.json()
        if data.get('code') == 'Ok':
            osrm_cache[pair_id] = data['routes'][0]['geometry']['coordinates']
        else:
            osrm_cache[pair_id] = [[lon1, lat1], [lon2, lat2]]
        time.sleep(0.15)
    except Exception:
        osrm_cache[pair_id] = [[lon1, lat1], [lon2, lat2]]
        time.sleep(0.5)

if api_calls > 0:
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(osrm_cache, f, ensure_ascii=False, allow_nan=False)

print("Fáze 2: Inteligentní barvení sítě...")
group_to_stops = {}
for _, row in stop_times.iterrows():
    grp = row['group']
    st_id = row['base_stop']
    if st_id in stops_clean.index:
        st_name = stops_clean.loc[st_id, 'stop_name']
        if not is_hub(st_name):
            if grp not in group_to_stops: group_to_stops[grp] = set()
            group_to_stops[grp].add(st_id)

groups_list = list(group_to_stops.keys())
graph = {g: set() for g in groups_list}

for i in range(len(groups_list)):
    for j in range(i + 1, len(groups_list)):
        if group_to_stops[groups_list[i]].intersection(group_to_stops[groups_list[j]]):
            graph[groups_list[i]].add(groups_list[j])
            graph[groups_list[j]].add(groups_list[i])

group_colors = {}
sorted_groups = sorted(groups_list, key=lambda x: len(graph[x]), reverse=True)

for g in sorted_groups:
    used_colors = {group_colors[n] for n in graph[g] if n in group_colors}
    available_colors = [c for c in NEON_COLORS if c not in used_colors]
    if available_colors:
        group_colors[g] = available_colors[0]
    else:
        counts = Counter([group_colors[n] for n in graph[g] if n in group_colors])
        group_colors[g] = min(NEON_COLORS, key=lambda c: counts.get(c, 0))

for grp in route_group_map.values():
    if grp not in group_colors:
        group_colors[grp] = NEON_COLORS[sum(ord(c) for c in str(grp)) % len(NEON_COLORS)]

print("Fáze 3: Výpočet paralelních offsetů...")
raw_features = []
group_features = {}
for pair_id, groups in pair_groups.items():
    if pair_id not in osrm_cache: continue
    coords = osrm_cache[pair_id]
    clean_coords = [[lon, lat] for lon, lat in coords if pd.notna(lon) and pd.notna(lat)]
    if len(clean_coords) < 2: continue
    
    lat_mid = clean_coords[0][1]
    lon_scale = math.cos(math.radians(lat_mid))
    m_coords = [(lon * 111320 * lon_scale, lat * 111320) for lon, lat in clean_coords]
    line = LineString(m_coords)
    num_groups = len(groups)
    
    for idx, group in enumerate(groups):
        offset_multiplier = idx - (num_groups - 1) / 2.0
        offset_meters = offset_multiplier * 20 
        if offset_meters == 0: out_coords = m_coords
        else:
            try:
                off_line = line.offset_curve(offset_meters, join_style=1)
                if off_line.geom_type == 'LineString': out_coords = list(off_line.coords)
                elif off_line.geom_type == 'MultiLineString':
                    out_coords = []
                    for part in off_line.geoms: out_coords.extend(list(part.coords))
                else: out_coords = m_coords
            except: out_coords = m_coords
                
        final_coords = [[round(x / (111320 * lon_scale), 5), round(y / 111320, 5)] for x, y in out_coords]
        if group not in group_features: group_features[group] = []
        group_features[group].append(final_coords)

for group, lines in group_features.items():
    raw_features.append({
        "type": "Feature",
        "properties": { "group": group, "color": group_colors[group] },
        "geometry": { "type": "MultiLineString", "coordinates": lines }
    })

for idx, row in stops_clean.iterrows():
    raw_features.append({
        "type": "Feature",
        "properties": { 
            "type": "stop", "name": row['stop_name'],
            "zone": str(row['zone_id']) if pd.notna(row['zone_id']) else ""
        },
        "geometry": { "type": "Point", "coordinates": [row['stop_lon'], row['stop_lat']] }
    })


print("Fáze 4: Pixelový decluttering (Zoom 13 a 15)...")
placed_stops_boxes = []
optimized_features = []

# Zastávky
for feature in raw_features:
    if feature["geometry"]["type"] == "Point" and feature["properties"].get("type") == "stop":
        props = feature["properties"]
        lon, lat = feature["geometry"]["coordinates"]
        
        zone = str(props.get("zone", ""))
        v_zones = [z.strip() for z in zone.split(',') if z.strip().startswith('V')]
        
        if not v_zones:
            continue
            
        px, py = project(lat, lon, 15)
        total_chars = len(props.get("name", "")) + len(",".join(v_zones))
        est_width = total_chars * 6.2 + 45
        
        cand_box = {
            "minX": px - est_width / 2, "maxX": px + est_width / 2,
            "minY": py - 28, "maxY": py - 6
        }
        
        overlaps = False
        for box in placed_stops_boxes:
            if not (cand_box["maxX"] < box["minX"] or cand_box["minX"] > box["maxX"] or 
                    cand_box["maxY"] < box["minY"] or cand_box["minY"] > box["maxY"]):
                overlaps = True
                break
                
        if not overlaps:
            placed_stops_boxes.append(cand_box)
            props["show_label"] = True
            props["zones_formatted"] = ",".join(v_zones)
            optimized_features.append(feature)

# Linky
placed_badge_pixels = []
for feature in raw_features:
    if feature["geometry"]["type"] == "MultiLineString":
        optimized_features.append(feature) # Vždy zachovat silnici
        
        group = feature["properties"]["group"]
        color = feature["properties"]["color"]
        coords_list = feature["geometry"]["coordinates"]
        
        total_length = 0
        segments_data = []
        
        for part in coords_list:
            part_length = 0
            dists = []
            for i in range(len(part) - 1):
                d = haversine(part[i][0], part[i][1], part[i+1][0], part[i+1][1])
                dists.append(d)
                part_length += d
            total_length += part_length
            if part_length > 0:
                segments_data.append({"coords": part, "dists": dists, "length": part_length})
                
        if not segments_data: continue
        segments_data.sort(key=lambda x: x["length"], reverse=True)
        
        label_count = 1
        if total_length > 60000: label_count = 5
        elif total_length > 40000: label_count = 4
        elif total_length > 20000: label_count = 3
        elif total_length > 10000: label_count = 2
        
        placed_points = []
        
        for seg in segments_data:
            if len(placed_points) >= label_count: break
            
            for fraction in [0.5, 0.25, 0.75]:
                pt_lon, pt_lat = get_point_at_fraction(seg["coords"], seg["dists"], fraction)
                is_too_close = False
                
                for p in placed_points:
                    if haversine(pt_lon, pt_lat, p[0], p[1]) < 5000:
                        is_too_close = True; break
                        
                if not is_too_close:
                    px, py = project(pt_lat, pt_lon, 13)
                    for pb in placed_badge_pixels:
                        if abs(px - pb[0]) < 38 and abs(py - pb[1]) < 14:
                            is_too_close = True; break
                            
                if not is_too_close:
                    placed_points.append((pt_lon, pt_lat))
                    placed_badge_pixels.append((project(pt_lat, pt_lon, 13)))
                    
                    optimized_features.append({
                        "type": "Feature",
                        "properties": { "type": "badge", "group": group, "color": color },
                        "geometry": { "type": "Point", "coordinates": [pt_lon, pt_lat] }
                    })
                    break
                    
        # Záchranný štítek
        if not placed_points:
            seg = segments_data[0]
            pt_lon, pt_lat = get_point_at_fraction(seg["coords"], seg["dists"], 0.5)
            hash_val = sum(ord(c) for c in str(group))
            pt_lat += (((hash_val % 5) - 2) * 0.00015)
            pt_lon += ((((hash_val * 7) % 5) - 2) * 0.00015)
            optimized_features.append({
                "type": "Feature",
                "properties": { "type": "badge", "group": group, "color": color },
                "geometry": { "type": "Point", "coordinates": [pt_lon, pt_lat] }
            })

geojson_obj = { "type": "FeatureCollection", "features": optimized_features }

print("Fáze 5: Generování přesných tras spojů (GTFS Match)...")
try:
    import re
    import json

    # Předpočítáme si plná čísla linek (route_short_name)
    route_full_map = routes.set_index('route_id')['route_short_name'].astype(str).to_dict()
    trips['full_linka'] = trips['route_id'].map(route_full_map)

    # Seřadíme stop_times, abychom měli jistotu, že první zastávka je opravdu první
    stop_times_sorted = stop_times.sort_values(['trip_id', 'stop_sequence'])
    
    # Vytvoříme slovník prvních odjezdů pro každý trip_id
    first_stops = stop_times_sorted.drop_duplicates('trip_id')
    first_dep_times = first_stops.set_index('trip_id')['departure_time'].astype(str).to_dict()

    def extrahuj_klic(row):
        trip_id = str(row['trip_id'])
        linka = str(row['full_linka'])

        if 'PID:' in trip_id:
            # Logika pro PID: linka/PIDčas
            dep_time = first_dep_times.get(trip_id, "")
            if len(dep_time) >= 5: # Čas je ve formátu "08:35:00" nebo "8:35:00"
                parts = dep_time.split(':')
                hh = parts[0].zfill(2) # Přidá nulu na začátek, pokud chybí (8 -> 08)
                mm = parts[1]
                return f"{linka}/PID{hh}{mm}"
            return None
        else:
            # Logika pro VDV: linka/spoj
            cisjr_matches = re.findall(r'CISJR:(\d+)', trip_id)
            if cisjr_matches:
                spoj = cisjr_matches[-1] # Vždy vezmeme to úplně poslední číslo
                return f"{linka}/{spoj}"
            return None

    trips['linka_spoj'] = trips.apply(extrahuj_klic, axis=1)
    trips_valid = trips.dropna(subset=['linka_spoj'])
    trip_key_map = trips_valid.set_index('trip_id')['linka_spoj'].to_dict()

    trip_shapes = {}
    for trip_id, group in stop_times_sorted.groupby('trip_id'):
        if trip_id not in trip_key_map:
            continue
        linka_spoj = trip_key_map[trip_id]

        coords = []
        for _, row in group.iterrows():
            base_stop = str(row['stop_id']).split('.')[0]
            if base_stop in stops_clean.index:
                lat = stops_clean.loc[base_stop, 'stop_lat']
                lon = stops_clean.loc[base_stop, 'stop_lon']
                coords.append([lat, lon])

        if len(coords) > 1:
            trip_shapes[linka_spoj] = coords

    with open("spoje.json", "w", encoding="utf-8") as f:
        json.dump(trip_shapes, f, separators=(',', ':'))
        
    print(f"Soubor spoje.json úspěšně vytvořen! (Uloženo {len(trip_shapes)} tras spojů)")

except Exception as e:
    print("Chyba při generování spoje.json:", e)
    import traceback
    traceback.print_exc()

print("Ukládám plně optimalizovaný trasy.geojson...")
with open("trasy.geojson", "w", encoding="utf-8") as f:
    json.dump(geojson_obj, f, ensure_ascii=False, allow_nan=False)

print("VŠECHNO HOTOVO!")
