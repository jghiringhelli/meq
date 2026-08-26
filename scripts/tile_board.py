import json, math, os
from PIL import Image, ImageDraw, ImageFont

BOARD = r'public\dev-assets\MEQ_full_board.jpg'
OUT = r'C:\Users\JC\.copilot\session-state\60abe338-5836-4f14-b36f-34b8a0381908\files\tiles'
os.makedirs(OUT, exist_ok=True)

COLS, ROWS = 4, 3
OVERLAP = 180        # px added to each side so edges crossing a seam stay whole
QUALITY = 62
MAXSIDE = 1280       # downscale long side to keep each tile small enough to send

img = Image.open(BOARD).convert('RGB')
W, H = img.size
loc = json.load(open('assets/locations.json'))['locations']
try: font = ImageFont.truetype('arialbd.ttf', 26)
except: font = ImageFont.load_default()

tw, th = W / COLS, H / ROWS
manifest = {'board': {'w': W, 'h': H}, 'grid': {'cols': COLS, 'rows': ROWS},
            'overlap': OVERLAP, 'tiles': []}

for r in range(ROWS):
    for c in range(COLS):
        x0 = max(0, int(c * tw - OVERLAP)); y0 = max(0, int(r * th - OVERLAP))
        x1 = min(W, int((c + 1) * tw + OVERLAP)); y1 = min(H, int((r + 1) * th + OVERLAP))
        crop = img.crop((x0, y0, x1, y1)).copy()
        d = ImageDraw.Draw(crop)
        inside = []
        for l in loc:
            gx, gy = l['coords']['x'], l['coords']['y']
            if x0 <= gx <= x1 and y0 <= gy <= y1:
                lx, ly = gx - x0, gy - y0
                d.ellipse([lx-18, ly-18, lx+18, ly+18], outline=(0, 240, 255), width=5)
                d.text((lx+20, ly-14), l['id'], fill=(0, 240, 255), font=font,
                       stroke_width=4, stroke_fill=(0, 0, 0))
                inside.append(l['id'])
        name = f'r{r}c{c}.jpg'
        scale = min(1.0, MAXSIDE / max(crop.size))
        outimg = crop if scale >= 1.0 else crop.resize((int(crop.size[0]*scale), int(crop.size[1]*scale)))
        outimg.save(os.path.join(OUT, name), quality=QUALITY)
        kb = os.path.getsize(os.path.join(OUT, name)) // 1024
        manifest['tiles'].append({'name': name, 'row': r, 'col': c,
                                  'x0': x0, 'y0': y0, 'x1': x1, 'y1': y1,
                                  'scale': round(scale, 5),
                                  'nodes': inside, 'kb': kb})
        print(f'{name}: {outimg.size} {kb}KB  nodes={len(inside)}')

json.dump(manifest, open(os.path.join(OUT, 'manifest.json'), 'w'), indent=2)
print('\nwrote manifest with', len(manifest['tiles']), 'tiles')
