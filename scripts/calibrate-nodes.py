import json, cv2, numpy as np, sys

IMG = "public/dev-assets/MEQ_full_board.jpg"
LOC = "assets/locations.json"

img = cv2.imread(IMG)
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
H, W = gray.shape

data = json.load(open(LOC, encoding="utf-8"))
locs = data["locations"] if isinstance(data, dict) and "locations" in data else data

def detect(cx, cy, half=150):
    x0, y0 = max(0, cx-half), max(0, cy-half)
    x1, y1 = min(W, cx+half), min(H, cy+half)
    crop = gray[y0:y1, x0:x1]
    crop = cv2.medianBlur(crop, 5)
    circles = cv2.HoughCircles(crop, cv2.HOUGH_GRADIENT, dp=1, minDist=200,
                               param1=110, param2=45, minRadius=80, maxRadius=125)
    if circles is None:
        return None
    circles = circles[0]
    # nearest to crop centre
    ccx, ccy = cx - x0, cy - y0
    best = min(circles, key=lambda c: (c[0]-ccx)**2 + (c[1]-ccy)**2)
    nx, ny, r = x0 + best[0], y0 + best[1], best[2]
    return (nx, ny, r)

rows = []
for l in locs:
    c = l.get("coords") or {}
    cx, cy = int(c.get("x", 0)), int(c.get("y", 0))
    d = detect(cx, cy)
    if d is None:
        rows.append((l["id"], cx, cy, None, None, None, None, None))
        continue
    nx, ny, r = d
    off = ((nx-cx)**2 + (ny-cy)**2) ** 0.5
    rows.append((l["id"], cx, cy, int(nx), int(ny), int(r), round(off,1), None))

rows.sort(key=lambda r: (r[6] is None, -(r[6] or 0)))
print(f"{'id':28} {'old':>12} {'new':>12} {'r':>4} {'off':>6}")
for id, cx, cy, nx, ny, r, off, _ in rows:
    if nx is None:
        print(f"{id:28} {f'{cx},{cy}':>12} {'MISS':>12}")
    else:
        print(f"{id:28} {f'{cx},{cy}':>12} {f'{nx},{ny}':>12} {r:>4} {off:>6}")
