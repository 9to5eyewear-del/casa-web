# Builds js/service-map.data.js: the little map in the "outside the recommended
# area" notice (js/prep-location.js) — the land outline, the recommended zone
# around Ein Vered, and a point for every locality in js/service-areas.data.js.
#
#   W=/tmp/areas; mkdir -p $W      (same loc.json / places.json as build-service-areas.py)
#   curl -s https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries_isr.geojson -o $W/land.geojson
#   python3 -I scripts/build-service-map.py $W > js/service-map.data.js
#
# Coordinates are a plain equirectangular projection, 100 units per degree of
# latitude, so 1 unit ≈ 1.1 km. The zone is drawn from the localities that are
# "recommended" (≤ 75 minutes): the 75-minute line of their drive times,
# interpolated between them. The page clips it to the land.

import json
import math
import re
import statistics
import sys
from collections import defaultdict
from pathlib import Path

W = Path(sys.argv[1])
ROOT = Path(__file__).resolve().parent.parent
ORIGIN = 'עין ורד'
RECOMMENDED_MAX = 75  # ZONES.recommended.max in js/service-areas.js
N, S, WEST, E = 33.35, 29.45, 34.2, 35.95
K = 100
COS = math.cos(math.radians((N + S) / 2))


def xy(lat, lon):
    return ((lon - WEST) * K * COS, (N - lat) * K)


# --- localities: same matching as build-service-areas.py ---
clean = lambda s: re.sub(r'\s+', ' ', s or '').strip()
recs = json.loads((W / 'loc.json').read_text())['result']['records']
cbs = {clean(r['שם_ישוב']): (clean(r['שם_נפה']), clean(r['שם_מועצה'])) for r in recs if clean(r['שם_ישוב'])}
FINALS = str.maketrans('ךםןףץ', 'כמנפצ')
WRONG_MATCH = {"יאנוח-ג'ת", 'צוקים', 'גת (קיבוץ)', 'טייבה (בעמק)'}


def key(s):
    s = re.sub(r'[֑-ׇ]', '', s).translate(FINALS)
    return re.sub(r'[^א-ת]', '', s).replace('וו', 'ו').replace('יי', 'י')


RANK = {'city': 0, 'town': 0, 'village': 1, 'hamlet': 2, 'isolated_dwelling': 3, 'locality': 4, 'suburb': 5, 'neighbourhood': 6}
points = {}
for e in json.loads((W / 'places.json').read_text())['elements']:
    t = e['tags']
    for name in {t.get('name:he'), t.get('name'), t.get('official_name:he'), t.get('alt_name:he'), t.get('old_name:he')} - {None}:
        for part in name.split(';'):
            k, p = key(part), (RANK.get(t['place'], 9), e['lat'], e['lon'])
            if k and (k not in points or p[0] < points[k][0]):
                points[k] = p

coords, matched = {}, set()
for name in cbs:
    if name in WRONG_MATCH:
        continue
    tries = [name, re.sub(r'\(.*?\)', '', name)] + (name.split('-') if '-' in name else [])
    p = next((points[key(x)] for x in tries if key(x) in points), None)
    if p and S <= p[1] <= N and WEST <= p[2] <= E:
        coords[name] = xy(p[1], p[2])
        matched.add(name)

# Unmatched: the median point of its regional council, else of its sub-district.
by_council, by_sub = defaultdict(list), defaultdict(list)
for n, c in coords.items():
    sub, council = cbs[n]
    by_sub[sub].append(c)
    if council:
        by_council[council].append(c)
for n, (sub, council) in cbs.items():
    if n not in coords:
        pool = by_council.get(council) or by_sub.get(sub)
        if pool:
            coords[n] = (statistics.median(c[0] for c in pool), statistics.median(c[1] for c in pool))

minutes, estimated = {}, set()
for m in re.finditer(r'^\s*(\[.*\]),$', (ROOT / 'js/service-areas.data.js').read_text(), re.M):
    # [he, en, minutes, 1 = estimated?, …]
    row = json.loads(m.group(1))
    minutes[row[0]] = row[2]
    if len(row) > 3 and row[3]:
        estimated.add(row[0])

# --- land: Israel + the West Bank / Gaza as one silhouette, simplified ---
def simplify(pts, eps):
    if len(pts) < 3:
        return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    dx, dy = x2 - x1, y2 - y1
    norm = math.hypot(dx, dy) or 1e-9
    i, dmax = 0, -1
    for j in range(1, len(pts) - 1):
        d = abs(dy * pts[j][0] - dx * pts[j][1] + x2 * y1 - y2 * x1) / norm
        if d > dmax:
            i, dmax = j, d
    if dmax <= eps:
        return [pts[0], pts[-1]]
    return simplify(pts[:i + 1], eps)[:-1] + simplify(pts[i:], eps)


def path(rings):
    out = []
    for ring in rings:
        # A closed ring starts and ends on the same point, so simplify its two halves.
        full, mid = [xy(lat, lon) for lon, lat in ring], len(ring) // 2
        pts = simplify(full[:mid + 1], 0.15)[:-1] + simplify(full[mid:], 0.15)
        if len(pts) < 4:
            continue
        out.append('M' + 'L'.join(f'{x:.0f} {y:.0f}' for x, y in pts) + 'Z')
    return ''.join(out)


land = json.loads((W / 'land.geojson').read_text())
rings = []
for f in land['features']:
    if f['properties'].get('NAME') not in ('Israel', 'Palestine'):
        continue
    g = f['geometry']
    polys = [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']
    rings += [p[0] for p in polys]

# --- the recommended zone: the 75-minute line of the drive-time field ---
# Drive times are interpolated between the localities (inverse distance, the
# nearest few) on a grid, and the line is traced with marching squares. Only
# localities with their own point and their own time take part.
ox, oy = coords[ORIGIN]
known = [(coords[n], m) for n, m in minutes.items() if m is not None and n in matched and n not in estimated]
inner = [c for c, m in known if m <= RECOMMENDED_MAX]
STEP, PAD = 1.0, 15
gx0, gy0 = min(c[0] for c in inner) - PAD, min(c[1] for c in inner) - PAD
gx1, gy1 = max(c[0] for c in inner) + PAD, max(c[1] for c in inner) + PAD
near = [(c, m) for c, m in known if gx0 - 30 <= c[0] <= gx1 + 30 and gy0 - 30 <= c[1] <= gy1 + 30]
nx, ny = int((gx1 - gx0) / STEP) + 1, int((gy1 - gy0) / STEP) + 1


def field(x, y):
    d = sorted(((cx - x) ** 2 + (cy - y) ** 2, m) for (cx, cy), m in near)[:6]
    if d[0][0] < 1e-6:
        return d[0][1]
    w = [1 / d2 ** 1.5 for d2, _ in d]
    return sum(wi * m for wi, (_, m) in zip(w, d)) / sum(w)


OUT = 10 ** 6  # a frame of "outside" around the grid, so every line closes
v = [[OUT] * (nx + 2)] + [[OUT] + [field(gx0 + i * STEP, gy0 + j * STEP) for i in range(nx)] + [OUT] for j in range(ny)] + [[OUT] * (nx + 2)]
gx0, gy0 = gx0 - STEP, gy0 - STEP
T = RECOMMENDED_MAX + 0.5


def at(edge):
    kind, i, j = edge
    (i2, j2) = (i + 1, j) if kind == 'h' else (i, j + 1)
    a, b = v[j][i], v[j2][i2]
    t = (T - a) / (b - a)
    return (gx0 + (i + t * (i2 - i)) * STEP, gy0 + (j + t * (j2 - j)) * STEP)


links = defaultdict(list)
for j in range(ny + 1):
    for i in range(nx + 1):
        tl, tr, br, bl = v[j][i], v[j][i + 1], v[j + 1][i + 1], v[j + 1][i]
        case = (tl <= T) * 8 + (tr <= T) * 4 + (br <= T) * 2 + (bl <= T)
        top, right, bottom, left = ('h', i, j), ('v', i + 1, j), ('h', i, j + 1), ('v', i, j)
        centre = (tl + tr + br + bl) / 4 <= T
        segs = {1: [(left, bottom)], 2: [(bottom, right)], 3: [(left, right)], 4: [(top, right)],
                5: [(left, top), (bottom, right)] if not centre else [(left, bottom), (top, right)],
                6: [(top, bottom)], 7: [(left, top)], 8: [(left, top)], 9: [(top, bottom)],
                10: [(left, bottom), (top, right)] if not centre else [(left, top), (bottom, right)],
                11: [(top, right)], 12: [(left, right)], 13: [(bottom, right)], 14: [(left, bottom)]}.get(case, [])
        for e1, e2 in segs:
            links[e1].append(e2)
            links[e2].append(e1)

loops, seen = [], set()
for start in links:
    if start in seen:
        continue
    loop, prev, cur = [], None, start
    while cur not in seen:
        seen.add(cur)
        loop.append(at(cur))
        nxt = [e for e in links[cur] if e != prev and e not in seen]
        if not nxt:
            break
        prev, cur = cur, nxt[0]
    area = abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(loop, loop[1:] + loop[:1]))) / 2
    if area > 6:  # drop specks
        loops.append(loop)


def inside(pt, polys):
    x, y = pt
    hit = False
    for poly in polys:
        for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]):
            if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
                hit = not hit
    return hit


wrong = [n for n, m in minutes.items() if m is not None and n in matched and n not in estimated
         and inside(coords[n], loops) != (m <= RECOMMENDED_MAX)]
print(f'zone: {len(loops)} outlines; {len(wrong)} localities on the wrong side: {wrong[:12]}', file=sys.stderr)
zone = ''
for loop in loops:
    pts = simplify(loop[:len(loop) // 2 + 1], 0.25)[:-1] + simplify(loop[len(loop) // 2:], 0.25)
    zone += 'M' + 'L'.join(f'{x:.1f} {y:.1f}'.replace('.0 ', ' ') for x, y in pts) + 'Z'

w, h = xy(S, E)
print('// Generated by scripts/build-service-map.py — the map in the "outside the recommended area"')
print('// notice. Regenerate rather than edit. Units: 100 per degree of latitude (≈ 1.1 km).')
print(f'export const VIEW = [{w:.0f}, {h:.0f}];')
print(f'export const LAND = {json.dumps(path(rings))};')
print(f'export const ZONE = {json.dumps(zone)};')
print(f'export const ORIGIN_XY = [{ox:.0f}, {oy:.0f}];')
print('// locality → [x, y]')
print('export const XY = {')
for n in sorted(minutes):
    if n in coords:
        print(f'  {json.dumps(n, ensure_ascii=False)}: [{coords[n][0]:.0f}, {coords[n][1]:.0f}],')
print('};')
print(f'{sum(n in coords for n in minutes)} / {len(minutes)} localities placed', file=sys.stderr)
