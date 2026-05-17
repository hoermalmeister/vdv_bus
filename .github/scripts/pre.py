import pandas as pd
import requests
import json
import time
import os

# Nastavení URL k tvým datům (můžeš použít i lokální cesty, pokud máš soubory stažené)
BASE_URL = "https://hoermalmeister.github.io/gtfs-rehost/vdv/"

print("Stahuji data...")
routes = pd.read_csv(BASE_URL + "routes.txt")
trips = pd.read_csv(BASE_URL + "trips.txt")
stops = pd.read_csv(BASE_URL + "stops.txt")
stop_times = pd.read_csv(BASE_URL + "stop_times.txt", dtype={'stop_sequence': int})

# 1. Vyčištění zastávek (odstraníme .P1 apod., abychom měli čistá ID uzlů)
print("Čistím data...")
stops['base_id'] = stops['stop_id'].astype(str).apply(lambda x: x.split('.')[0])
# Ponecháme jen první výskyt každého base_id pro souřadnice
stops_clean = stops.drop_duplicates(subset=['base_id']).set_index('base_id')

# 2. Mapování linek na 3místné skupiny
routes['route_short_name'] = routes['route_short_name'].fillna(routes['route_long_name']).astype(str)
routes['group'] = routes['route_short_name'].apply(lambda x: x.strip()[-3:])
route_group_map = routes.set_index('route_id')['group'].to_dict()

# 3. Mapování spojů na skupiny
trips['group'] = trips['route_id'].map(route_group_map)
trip_group_map = trips.set_index('trip_id')['group'].dropna().to_dict()

# 4. Skládání úseků ze stop_times
print("Hledám unikátní úseky...")
stop_times['group'] = stop_times['trip_id'].map(trip_group_map)
stop_times = stop_times.dropna(subset=['group', 'stop_id'])
stop_times['base_stop'] = stop_times['stop_id'].astype(str).apply(lambda x: x.split('.')[0])

# Seřazení a posun pro získání dvojic (Zastávka A -> Zastávka B)
stop_times.sort_values(by=['trip_id', 'stop_sequence'], inplace=True)
stop_times['next_stop'] = stop_times.groupby('trip_id')['base_stop'].shift(-1)

# Filtrování na unikátní páry
segments = stop_times.dropna(subset=['next_stop'])
# Uspořádání AB / BA deduplikace
segments['seg_id'] = segments.apply(
    lambda r: f"{min(r['base_stop'], r['next_stop'])}|{max(r['base_stop'], r['next_stop'])}", axis=1
)

unique_segments = segments.drop_duplicates(subset=['group', 'seg_id'])[['group', 'base_stop', 'next_stop', 'seg_id']]

print(f"Nalezeno {len(unique_segments)} unikátních úseků pro routování.")

# 5. OSRM Routování a tvorba GeoJSONu
features = []
osrm_cache = {} # Cache, ať se neptáme OSRM na stejnou silnici vícekrát

print("Zahajuji routování po silnicích přes OSRM API...")
for index, row in unique_segments.iterrows():
    group = row['group']
    seg_id = row['seg_id']
    s1, s2 = row['base_stop'], row['next_stop']
    
    # Získání souřadnic
    if s1 not in stops_clean.index or s2 not in stops_clean.index:
        continue
    
    lon1, lat1 = stops_clean.loc[s1, 'stop_lon'], stops_clean.loc[s1, 'stop_lat']
    lon2, lat2 = stops_clean.loc[s2, 'stop_lon'], stops_clean.loc[s2, 'stop_lat']
    
    # Přeskočíme nesmyslné skoky (delší než cca 0.8 stupně = ~80km)
    if abs(lon1 - lon2) > 0.8 or abs(lat1 - lat2) > 0.8:
        continue

    # Zjistíme tvar silnice z OSRM
    if seg_id not in osrm_cache:
        try:
            # Volání veřejného OSRM (nastaveno na 'driving' = auta/busy)
            url = f"http://router.project-osrm.org/route/v1/driving/{lon1},{lat1};{lon2},{lat2}?overview=full&geometries=geojson"
            res = requests.get(url)
            data = res.json()
            
            if data['code'] == 'Ok':
                # Získáme přesnou silniční křivku
                osrm_cache[seg_id] = data['routes'][0]['geometry']['coordinates']
            else:
                # Fallback na rovnou čáru, pokud OSRM nenajde cestu
                osrm_cache[seg_id] = [[lon1, lat1], [lon2, lat2]]
                
            time.sleep(0.1) # Ohleduplnost k bezplatnému API, aby nás nezablokovali
            
        except Exception as e:
            osrm_cache[seg_id] = [[lon1, lat1], [lon2, lat2]]
            time.sleep(0.5)

    # Přidání do GeoJSONu
    feature = {
        "type": "Feature",
        "properties": { "group": group },
        "geometry": {
            "type": "LineString",
            "coordinates": osrm_cache[seg_id]
        }
    }
    features.append(feature)

# Přidání zastávek do GeoJSONu jako body
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

with open("trasy.geojson", "w", encoding="utf-8") as f:
    json.dump(geojson_obj, f, ensure_ascii=False)

print("HOTOVO! Soubor trasy.geojson byl úspěšně vytvořen.")
