import pandas as pd
import requests
import json
import time
import os

BASE_URL = "https://hoermalmeister.github.io/gtfs-rehost/vdv/"
CACHE_FILE = "osrm_cache.json"

print("Stahuji data z GitHubu...")
routes = pd.read_csv(BASE_URL + "routes.txt")
trips = pd.read_csv(BASE_URL + "trips.txt")
stops = pd.read_csv(BASE_URL + "stops.txt")
stop_times = pd.read_csv(BASE_URL + "stop_times.txt", dtype={'stop_sequence': int})

print("Čistím data zastávek...")
stops['base_id'] = stops['stop_id'].astype(str).apply(lambda x: x.split('.')[0])
stops_clean = stops.drop_duplicates(subset=['base_id']).set_index('base_id')

routes['route_short_name'] = routes['route_short_name'].fillna(routes['route_long_name']).astype(str)
routes['group'] = routes['route_short_name'].apply(lambda x: x.strip()[-3:])
route_group_map = routes.set_index('route_id')['group'].to_dict()

trips['group'] = trips['route_id'].map(route_group_map)
trip_group_map = trips.set_index('trip_id')['group'].dropna().to_dict()

print("Sestavuji síť úseků...")
stop_times['group'] = stop_times['trip_id'].map(trip_group_map)
stop_times = stop_times.dropna(subset=['group', 'stop_id'])
stop_times['base_stop'] = stop_times['stop_id'].astype(str).apply(lambda x: x.split('.')[0])

stop_times.sort_values(by=['trip_id', 'stop_sequence'], inplace=True)
stop_times['next_stop'] = stop_times.groupby('trip_id')['base_stop'].shift(-1)

# .copy() opravilo to varování Pandas!
segments = stop_times.dropna(subset=['next_stop']).copy()
segments['seg_id'] = segments.apply(
    lambda r: f"{min(r['base_stop'], r['next_stop'])}|{max(r['base_stop'], r['next_stop'])}", axis=1
)

unique_segments = segments.drop_duplicates(subset=['group', 'seg_id'])[['group', 'base_stop', 'next_stop', 'seg_id']]
total_segments = len(unique_segments)
print(f"Nalezeno {total_segments} unikátních úseků pro routování.")

# Načtení CACHE paměti (pokud už jsme to někdy routovali)
osrm_cache = {}
if os.path.exists(CACHE_FILE):
    with open(CACHE_FILE, "r", encoding="utf-8") as f:
        osrm_cache = json.load(f)
    print(f"Načteno {len(osrm_cache)} již zroutovaných silnic z mezipaměti.")

features = []
api_calls = 0

print("Zahajuji routování...")
# Přidáno enumerate pro počítání průběhu
for i, (index, row) in enumerate(unique_segments.iterrows(), 1):
    group = row['group']
    seg_id = row['seg_id']
    s1, s2 = row['base_stop'], row['next_stop']
    
    # Výpis do konzole každých 100 úseků (ať GitHub Actions nevypadá, že zamrzl)
    if i % 100 == 0 or i == total_segments:
        print(f"Zpracováno {i} / {total_segments} úseků... (Z toho {api_calls} volání API)")

    if s1 not in stops_clean.index or s2 not in stops_clean.index:
        continue
    
    lon1, lat1 = stops_clean.loc[s1, 'stop_lon'], stops_clean.loc[s1, 'stop_lat']
    lon2, lat2 = stops_clean.loc[s2, 'stop_lon'], stops_clean.loc[s2, 'stop_lat']
    
    if abs(lon1 - lon2) > 0.8 or abs(lat1 - lat2) > 0.8:
        continue

    # Pokud cestu ještě neznáme, zeptáme se API
    if seg_id not in osrm_cache:
        api_calls += 1
        try:
            url = f"http://router.project-osrm.org/route/v1/driving/{lon1},{lat1};{lon2},{lat2}?overview=full&geometries=geojson"
            res = requests.get(url, timeout=5)
            data = res.json()
            
            if data.get('code') == 'Ok':
                osrm_cache[seg_id] = data['routes'][0]['geometry']['coordinates']
            else:
                osrm_cache[seg_id] = [[lon1, lat1], [lon2, lat2]]
                
            time.sleep(0.15) # Pauza pro OSRM API
            
        except Exception:
            osrm_cache[seg_id] = [[lon1, lat1], [lon2, lat2]]
            time.sleep(0.5)

    features.append({
        "type": "Feature",
        "properties": { "group": group },
        "geometry": {
            "type": "LineString",
            "coordinates": osrm_cache[seg_id]
        }
    })

# Uložení CACHE paměti pro zítřek
print("Ukládám mezipaměť tras...")
with open(CACHE_FILE, "w", encoding="utf-8") as f:
    json.dump(osrm_cache, f, ensure_ascii=False)

# Zastávky
for idx, row in stops_clean.iterrows():
    if pd.notna(row['stop_lon']) and pd.notna(row['stop_lat']):
        features.append({
            "type": "Feature",
            "properties": { "type": "stop", "name": row['stop_name'] },
            "geometry": { "type": "Point", "coordinates": [row['stop_lon'], row['stop_lat']] }
        })

geojson_obj = {
    "type": "FeatureCollection",
    "features": features
}

print("Generuji trasy.geojson...")
with open("trasy.geojson", "w", encoding="utf-8") as f:
    json.dump(geojson_obj, f, ensure_ascii=False)

print("HOTOVO! Vše proběhlo v pořádku.")
