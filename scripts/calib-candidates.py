import json, cv2, numpy as np

img = cv2.imread("public/dev-assets/MEQ_full_board.jpg")
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
H, W = gray.shape

def candidates(cx, cy, half=240):
    x0, y0 = max(0,cx-half), max(0,cy-half)
    x1, y1 = min(W,cx+half), min(H,cy+half)
    crop = cv2.medianBlur(gray[y0:y1, x0:x1], 5)
    cs = cv2.HoughCircles(crop, cv2.HOUGH_GRADIENT, dp=1, minDist=120,
                          param1=110, param2=40, minRadius=80, maxRadius=125)
    out=[]
    if cs is not None:
        for c in cs[0]:
            nx, ny, r = x0+c[0], y0+c[1], c[2]
            off = ((nx-cx)**2+(ny-cy)**2)**0.5
            out.append((int(nx),int(ny),int(r),round(off,1)))
    return sorted(out, key=lambda t:t[3])

for name,cx,cy in [("edoras",3162,2862),("emyn-muil",3889,2359)]:
    print(name, "seed", cx, cy)
    for t in candidates(cx,cy):
        print("   new=%d,%d r=%d off=%.1f" % t)
