import pandas as pd
import requests
import json
import time
import os
import math
from shapely.geometry import LineString

BASE_URL = "https://hoermalmeister.github.io/gtfs-rehost/vdv/"
CACHE_FILE = "osrm_cache.json"

def get_clean_group(name):
    digits = ''.join(filter(str.isdigit, str(name)))
    if digits:
        return str(int(digits[-3:]))
    return str(name).strip()[-3:]

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

# Kanonický pár zastávek - OPRAVA: POUŽITO @@@
segments['canonical_pair'] = segments.apply(
    lambda r: f"{min(r['base_stop'], r['next_stop'])}@@@{max(r['base_stop'], r['next_stop'])}", axis=1
)

# Mapa: Které linky (skupiny) projíždí tímto konkrétním úsekem
pair_groups = segments.groupby('canonical_pair')['group'].apply(lambda x: sorted(list(set(x)))).to_dict()

osrm_cache = {}
if os.path.exists(CACHE_FILE):
    with open(CACHE_FILE, "r", encoding="utf-8") as f:
        osrm_cache = json.load(f)

print("Fáze 1: Routování mezizastávkových úseků přes OSRM...")
api_calls = 0
total_pairs = len(pair_groups)

for i, pair_id in enumerate(pair_groups.keys(), 1):
    if i % 100 == 0: print(f"Zpracováno {i}/{total_pairs} úseků...")
    if pair_id in osrm_cache: continue
    
    # OPRAVA: ZDE TAKÉ @@@
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

print("Fáze 2: Výpočet paralelních offsetů...")
group_features = {}

for pair_id, groups in pair_groups.items():
    if pair_id not in osrm_cache: continue
    
    coords = osrm_cache[pair_id]
    clean_coords = [[lon, lat] for lon, lat in coords if pd.notna(lon) and pd.notna(lat)]
    if len(clean_coords) < 2: continue
    
    # Převod geometrie na metry
    lat_mid = clean_coords[0][1]
    lon_scale = math.cos(math.radians(lat_mid))
    m_coords = [(lon * 111320 * lon_scale, lat * 111320) for lon, lat in clean_coords]
    line = LineString(m_coords)
    
    num_groups = len(groups)
    
    for idx, group in enumerate(groups):
        # Dynamický posun - linky se rozestoupí přesně podle toho, kolik jich tu reálně jede
        offset_multiplier = idx - (num_groups - 1) / 2.0
        offset_meters = offset_multiplier * 20 # 20 metrů mezera mezi linkami
        
        if offset_meters == 0:
            out_coords = m_coords
        else:
            try:
                # Aplikace posunu na tento krátký a hladký úsek. join_style=1 krásně vyhladí rohy
                off_line = line.offset_curve(offset_meters, join_style=1)
                if off_line.geom_type == 'LineString':
                    out_coords = list(off_line.coords)
                elif off_line.geom_type == 'MultiLineString':
                    out_coords = []
                    for part in off_line.geoms: out_coords.extend(list(part.coords))
                else:
                    out_coords = m_coords
            except Exception:
                out_coords = m_coords
                
        # Převod zpět z metrů na GPS
        final_coords = [[round(x / (111320 * lon_scale), 5), round(y / 111320, 5)] for x, y in out_coords]
        
        if group not in group_features:
            group_features[group] = []
        group_features[group].append(final_coords)

features = []
for group, lines in group_features.items():
    features.append({
        "type": "Feature",
        "properties": { "group": group },
        "geometry": { "type": "MultiLineString", "coordinates": lines }
    })

# Zastávky (pouze ty, co mají smysl)
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

print("Generuji čistý trasy.geojson...")
with open("trasy.geojson", "w", encoding="utf-8") as f:
    json.dump(geojson_obj, f, ensure_ascii=False, allow_nan=False)

print("VŠECHNO HOTOVO!")
