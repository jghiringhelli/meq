import json, cv2

IMG = "public/dev-assets/MEQ_full_board.jpg"
LOC = "assets/locations.json"

img = cv2.imread(IMG)
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
H, W = gray.shape

with open(LOC, encoding="utf-8") as f:
    data = json.load(f)
locs = data["locations"]

MANUAL = {"edoras": (3156, 2895), "emyn-muil": (3954, 2569)}

def detect(cx, cy, half=150):
    x0, y0 = max(0, cx-half), max(0, cy-half)
    x1, y1 = min(W, cx+half), min(H, cy+half)
    crop = cv2.medianBlur(gray[y0:y1, x0:x1], 5)
    cs = cv2.HoughCircles(crop, cv2.HOUGH_GRADIENT, dp=1, minDist=200,
                          param1=110, param2=45, minRadius=80, maxRadius=125)
    if cs is None:
        return None
    ccx, ccy = cx-x0, cy-y0
    b = min(cs[0], key=lambda c: (c[0]-ccx)**2 + (c[1]-ccy)**2)
    return (x0+b[0], y0+b[1], b[2])

changed = []
for l in locs:
    c = l.get("coords")
    if not c:
        continue
    cx, cy = int(c["x"]), int(c["y"])
    if l["id"] in MANUAL:
        nx, ny = MANUAL[l["id"]]
    else:
        d = detect(cx, cy)
        if d is None:
            continue
        dx, dy, r = int(d[0]), int(d[1]), d[2]
        off = ((dx-cx)**2 + (dy-cy)**2) ** 0.5
        if off > 40 or not (100 <= r <= 120):
            continue
        nx, ny = dx, dy
    if (nx, ny) != (cx, cy):
        c["x"], c["y"] = nx, ny
        changed.append((l["id"], cx, cy, nx, ny))

with open(LOC, "w", encoding="utf-8", newline="\n") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")

print(f"changed {len(changed)} nodes:")
for id, ox, oy, nx, ny in changed:
    print(f"  {id:26} {ox},{oy} -> {nx},{ny}")
