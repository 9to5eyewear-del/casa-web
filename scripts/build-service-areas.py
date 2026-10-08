# Builds js/service-areas.data.js: every Israeli locality (CBS list) with its
# English name and the estimated driving time from Casa Mancini in Ein Vered
# (עין ורד), in minutes.
#
#   W=/tmp/areas; mkdir -p $W
#   curl -s "https://data.gov.il/api/3/action/datastore_search?resource_id=5c78e9fa-c2e2-4771-93ff-7f400a12f7ba&limit=2000" -o $W/loc.json
#   curl -s -A casa-web-build -X POST https://overpass-api.de/api/interpreter --data-urlencode \
#     'data=[out:json][timeout:150];node["place"~"^(city|town|village|hamlet|isolated_dwelling|suburb|neighbourhood|locality)$"](29.4,34.2,33.4,35.95);out;' -o $W/places.json
#   python3 -I scripts/build-service-areas.py $W > js/service-areas.data.js
#
# How a time is estimated:
#   1. The locality's point from OpenStreetMap, matched by its Hebrew name.
#   2. The fastest drive from Ein Vered by the public OSRM router (cached in
#      $W/minutes.json; delete it to fetch again). OSRM assumes empty roads,
#      so it's multiplied by TRAFFIC — set so the places Casa Mancini calls
#      its recommended area (up to Ashdod / Gedera / Gan Yavne) come out at
#      ≤ 75 minutes, and Ashkelon, Haifa and Jerusalem don't.
#   3. A locality with no (or a wrong) match takes the median time of its
#      regional council, else of its CBS sub-district — marked as estimated.

import json
import re
import statistics
import sys
import time
import urllib.request
from collections import defaultdict
from pathlib import Path

W = Path(sys.argv[1])
TRAFFIC = 1.3
ORIGIN = 'עין ורד'
# Matched to a different place with the same name; they fall back to the median.
WRONG_MATCH = {"יאנוח-ג'ת", 'צוקים', 'גת (קיבוץ)', 'טייבה (בעמק)'}

clean = lambda s: re.sub(r'\s+', ' ', s or '').strip()
recs = json.loads((W / 'loc.json').read_text())['result']['records']
cbs = {clean(r['שם_ישוב']): (clean(r['שם_נפה']), clean(r['שם_מועצה'])) for r in recs if clean(r['שם_ישוב'])}
# CBS spells in transliteration capitals ("QIRYAT ONO"); title-cased it's the fallback English name.
cbs_en = {clean(r['שם_ישוב']): re.sub(r"(^|[\s\-(])([a-z])", lambda m: m.group(1) + m.group(2).upper(), clean(r['שם_ישוב_לועזי']).lower())
          for r in recs if clean(r['שם_ישוב'])}

FINALS = str.maketrans('ךםןףץ', 'כמנפצ')


def key(s):
    s = re.sub(r'[֑-ׇ]', '', s).translate(FINALS)
    return re.sub(r'[^א-ת]', '', s).replace('וו', 'ו').replace('יי', 'י')


# OSM points by name; a town beats a neighbourhood of the same name.
RANK = {'city': 0, 'town': 0, 'village': 1, 'hamlet': 2, 'isolated_dwelling': 3, 'locality': 4, 'suburb': 5, 'neighbourhood': 6}
points = {}
for e in json.loads((W / 'places.json').read_text())['elements']:
    t = e['tags']
    for name in {t.get('name:he'), t.get('name'), t.get('official_name:he'), t.get('alt_name:he'), t.get('old_name:he')} - {None}:
        for part in name.split(';'):
            k, p = key(part), (RANK.get(t['place'], 9), e['lat'], e['lon'], clean(t.get('name:en')))
            if k and (k not in points or p[0] < points[k][0]):
                points[k] = p

coords, osm_en = {}, {}
for name in cbs:
    if name in WRONG_MATCH:
        continue
    tries = [name, re.sub(r'\(.*?\)', '', name)] + (name.split('-') if '-' in name else [])
    p = next((points[key(x)] for x in tries if key(x) in points), None)
    if p:
        coords[name] = (p[1], p[2])
        if p[3]:
            osm_en[name] = p[3]

cache = W / 'minutes.json'
free = json.loads(cache.read_text()) if cache.exists() else {}
todo = [n for n in coords if n not in free]
src = coords[ORIGIN]
for i in range(0, len(todo), 90):
    chunk = todo[i:i + 90]
    pts = ';'.join(f'{lon},{lat}' for lat, lon in [src] + [coords[n] for n in chunk])
    req = urllib.request.Request(f'https://router.project-osrm.org/table/v1/driving/{pts}?sources=0&annotations=duration',
                                 headers={'User-Agent': 'casa-web-build/1.0'})
    durations = json.load(urllib.request.urlopen(req, timeout=60))['durations'][0][1:]
    free.update({n: round(s / 60, 1) for n, s in zip(chunk, durations) if s is not None})
    time.sleep(1.2)
cache.write_text(json.dumps(free, ensure_ascii=False))

minutes = {n: round(free[n] * TRAFFIC) for n in coords if n in free}
by_council, by_sub = defaultdict(list), defaultdict(list)
for n, m in minutes.items():
    sub, council = cbs[n]
    by_sub[sub].append(m)
    if council:
        by_council[council].append(m)

ekey = lambda s: re.sub(r'[^a-z]', '', s.lower())
rows = []
for name in sorted(cbs):
    sub, council = cbs[name]
    # The common English name (OpenStreetMap) to show; CBS's spelling kept as a second name to search by.
    en = osm_en.get(name) or cbs_en[name] or None
    alt = cbs_en[name] if cbs_en[name] and en and ekey(cbs_en[name]) != ekey(en) else 0
    if name in minutes:
        m, est = minutes[name], 0
    else:
        pool = by_council.get(council) or by_sub.get(sub)
        m, est = (round(statistics.median(pool)), 1) if pool else (None, 0)
    row = [name, en, m, est, alt]
    while row[-1] == 0:
        row.pop()
    rows.append(row)

print('// Generated by scripts/build-service-areas.py: [locality, English name, minutes from Ein Vered,')
print('// 1 = time estimated from its regional council / sub-district, another English spelling to search by].')
print('// Regenerate rather than edit; a one-off fix by hand is fine.')
print('export const PLACES = [')
for r in rows:
    print(f'  {json.dumps(r, ensure_ascii=False)},')
print('];')
est = sum(len(r) > 3 and r[3] == 1 for r in rows)
print(f'{len(rows)} localities, {est} estimated, {sum(r[2] is None for r in rows)} without a time, {len(osm_en)} English names from OSM', file=sys.stderr)
