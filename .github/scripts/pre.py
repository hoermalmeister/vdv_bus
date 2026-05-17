import pandas as pd
import requests
import json
import time
import os
import math

BASE_URL = "https://hoermalmeister.github.io/gtfs-rehost/vdv/"
CACHE_FILE = "osrm_cache.json"

def get_clean_group(name):
    digits = ''.join(filter(str.isdigit, str(name)))
    if digits:
        return str(int(digits[-3:]))
    return str(name).strip()[-3:]

def get_offset_edge(p1, p2, offset_multiplier, spacing_meters=18):
    if offset_multiplier == 0:
        return [list(p1), list(p2)]
    offset_meters = offset_multiplier * spacing_meters
    lon1, lat1 = p1
    lon2, lat2 = p2
    lat_mid = (lat1 + lat2) / 2
    lon_scale = math.cos(math.radians(lat_mid))
    dx = (lon2 - lon1) * lon_scale * 111320
    dy = (lat2 - lat1) * 111320
    length = math.sqrt(dx*dx + dy*dy)
    if length == 0:
        return [list(p1), list(p2)]
    nx = -dy / length
    ny = dx / length
    delta_lon = (nx * offset_meters) / (111320 * lon_scale)
    delta_lat = (ny * offset_meters) / 111320
    return [
        [round(lon1 + delta_lon, 5), round(lat1 + delta_lat, 5)],
        [round(lon2 + delta_lat, 5), round(lat2 + delta_lat, 5)]
    ]

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
segments['seg_id'] = segments.apply(
    lambda r: f"{min(r['base_stop'], r['next_stop'])}|{max(r['base_stop'], r['next_stop'])}", axis=1
)

unique_segments = segments.drop_duplicates(subset=['group', 'seg_id'])[['group', 'base_stop', 'next_stop', 'seg_id']]
total_segments = len(unique_segments)

osrm_cache = {}
if os.path.exists(CACHE_FILE):
    with open(CACHE_FILE, "r", encoding="utf-8") as f:
        osrm_cache = json.load(f)

print("Fáze 1: Kontrola OSRM...")
api_calls = 0
for i, (index, row) in enumerate(unique_segments.iterrows(), 1):
    seg_id = row['seg_id']
    s1, s2 = row['base_stop'], row['next_stop']
    if seg_id in osrm_cache: continue
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
            osrm_cache[seg_id] = data['routes'][0]['geometry']['coordinates']
        else:
            osrm_cache[seg_id] = [[lon1, lat1], [lon2, lat2]]
        time.sleep(0.15)
    except Exception:
        osrm_cache[seg_id] = [[lon1, lat1], [lon2, lat2]]
        time.sleep(0.5)

if api_calls > 0:
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(osrm_cache, f, ensure_ascii=False, allow_nan=False)

print("Fáze 2: Výpočet stabilních offsetů...")
canonical_edges = {}
edge_groups = {}

for index, row in unique_segments.iterrows():
    group = row['group']
    seg_id = row['seg_id']
    if seg_id not in osrm_cache: continue
    coords = osrm_cache[seg_id]
    clean_coords = [[round(lon, 5), round(lat, 5)] for lon, lat in coords if pd.notna(lon) and pd.notna(lat)]
    
    for i in range(len(clean_coords) - 1):
        p1 = tuple(clean_coords[i])
        p2 = tuple(clean_coords[i+1])
        if p1 == p2: continue
        edge_key = tuple(sorted((p1, p2)))
        if edge_key not in canonical_edges:
            canonical_edges[edge_key] = (p1, p2)
            edge_groups[edge_key] = set()
        edge_groups[edge_key].add(group)

group_features = {}
for edge_key, groups in edge_groups.items():
    p1, p2 = canonical_edges[edge_key]
    sorted_groups = sorted(list(groups))
    num_groups = len(sorted_groups)
    for idx, group in enumerate(sorted_groups):
        offset_multiplier = idx - (num_groups - 1) / 2.0
        offset_line = get_offset_edge(p1, p2, offset_multiplier, spacing_meters=20)
        if group not in group_features: group_features[group] = []
        group_features[group].append(offset_line)

features = []
for group, lines in group_features.items():
    features.append({
        "type": "Feature",
        "properties": { "group": group },
        "geometry": { "type": "MultiLineString", "coordinates": lines }
    })

# ZDE: Přidáno ukládání zóny (zone_id) do vlastností GeoJSON prvků
for idx, row in stops_clean.iterrows():
    features.append({
        "type": "Feature",
        "properties": { 
            "type": "stop", 
            "name": row['stop_name'],
            "zone": str(row['zone_id']) if pd.notna(row['zone_id']) else ""
        },
        "geometry": { "type": "Point", "coordinates": [row['stop_lon'], row['stop_lat']] }
    })

geojson_obj = { "type": "FeatureCollection", "features": features }

print("Generuji stabilní trasy.geojson se zónami...")
with open("trasy.geojson", "w", encoding="utf-8") as f:
    json.dump(geojson_obj, f, ensure_ascii=False, allow_nan=False)

print("VŠECHNO HOTOVO!")
