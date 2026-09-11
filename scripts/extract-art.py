#!/usr/bin/env python3
"""Extract ALL art from the VASSAL module into public/dev-assets/art and emit
assets/art-manifest.json mapping our catalog ids -> art files.

FFG-owned art is never committed (see .gitignore public/dev-assets/). This just
unpacks the owner's local .vmod so the dev UI can render real art. The manifest
IS committed (it is only filename references, no art).

Run:  python scripts/extract-art.py
"""
import zipfile, re, os, json, shutil, unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VMOD = os.path.join(ROOT, "Middle_Earth_Quest_1.6.vmod")
OUT_DIR = os.path.join(ROOT, "public", "dev-assets", "art")
MANIFEST = os.path.join(ROOT, "assets", "art-manifest.json")
ART_URL = "/dev-assets/art/"  # served by vite from public/


def norm(s):
    if s is None:
        return ""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def load_catalog():
    cat = {}
    for f in ["heroes", "monsters", "minions", "shadow", "plots", "encounters",
              "peril", "events", "corruption", "missions", "combat-cards"]:
        p = os.path.join(ROOT, "assets", f + ".json")
        if os.path.exists(p):
            cat[f] = json.load(open(p, encoding="utf-8"))
    return cat


def extract_images(z):
    os.makedirs(OUT_DIR, exist_ok=True)
    names = []
    for e in z.namelist():
        if e in ("buildFile", "moduledata") or e.endswith("/"):
            continue
        base = os.path.basename(e)
        if not re.search(r"\.(jpe?g|png|gif)$", base, re.I):
            continue
        with z.open(e) as src, open(os.path.join(OUT_DIR, base), "wb") as dst:
            shutil.copyfileobj(src, dst)
        names.append(base)
    return names


def parse_slots(bf):
    """Return list of (entryName, image, label) for every CardSlot/PieceSlot."""
    # Excludes commas: some board pieces (e.g. the Shadow Pool track marker,
    # which has 13 layered states) embed a comma-separated list of ALL their
    # state images in one VASSAL trait field. Without excluding commas here,
    # the whole list gets swallowed as a single bogus "filename" ending in
    # .jpg, which then falsely matches the shadow-card title-map prefix
    # ("shadow...") and pollutes the manifest with an unmatchable multi-name
    # entry. We only want the piece's own single (first) image here.
    imgre = re.compile(r"([^;\t,]+\.(?:jpg|jpeg|png|gif|PNG|JPG|JPEG))")
    out = []
    for m in re.finditer(
        r'<VASSAL\.build\.widget\.(?:Card|Piece)Slot entryName="([^"]*)"[^>]*>(.*?)'
        r'</VASSAL\.build\.widget\.(?:Card|Piece)Slot>', bf, re.S):
        entry = m.group(1)
        inner = m.group(2)
        im = imgre.search(inner)
        img = im.group(1) if im else None
        lab = ""
        if img:
            lm = re.search(re.escape(img) + r";([^/\t]*)/", inner)
            lab = lm.group(1) if lm else ""
        out.append((entry, img, lab))
    return out


def url(img):
    return ART_URL + img if img else ""


def build_manifest(z, files):
    bf = z.read("buildFile").decode("utf-8", "replace")
    slots = parse_slots(bf)
    have = set(files)
    cat = load_catalog()

    # index available files by normalized stem for fuzzy lookups
    by_norm = {}
    for f in files:
        by_norm.setdefault(norm(os.path.splitext(f)[0]), f)

    def find_file(*cands):
        for c in cands:
            if c in have:
                return c
        for c in cands:
            n = norm(os.path.splitext(c)[0])
            if n in by_norm:
                return by_norm[n]
        return None

    man = {"_meta": {"schema": "art-manifest-v1",
                     "note": "maps catalog ids -> /dev-assets/art files from the owner's vmod",
                     "urlBase": ART_URL},
           "board": url(find_file("MEQ_full_board.jpg")),
           "battleBoard": url(find_file("battle_board.jpg")),
           "heroes": {}, "monsters": {}, "characters": {}, "items": {},
           "shadow": {}, "plots": {}, "startingPlots": {}, "corruption": {},
           "encounters": {}, "perils": {}, "events": {}, "combatCards": {},
           "heroMissions": {}, "sauronMissions": {},
           "tokens": {}, "backs": {}}

    # ---- tokens / backs ----
    man["tokens"] = {k: url(v) for k, v in {
        "favor": find_file("favor.png", "favor_PNG.png"),
        "influence": find_file("influence_small.png"),
        "heroStoryMarker": find_file("Heroes story marker.PNG"),
        "sauronStoryMarker": find_file("Sauron story marker .PNG", "Sauron story marker.PNG"),
        "sauronAction": find_file("Sauron action token.PNG"),
        "plotMarker": find_file("plot marker .PNG", "plot marker.PNG"),
        "encounterMarker": find_file("encounter marker.PNG"),
        "shadowPool": find_file("shadow pool.jpg", "shadow pool .jpg"),
    }.items() if v}
    man["backs"] = {k: url(v) for k, v in {
        "shadow": find_file("shadow_mask.jpg"),
        "peril": find_file("peril_mask.jpg"),
        "plot": find_file("plot_mask.jpg"),
        "corruption": find_file("corruption_mask.jpg"),
        "item": find_file("item_mask.jpg"),
        "monster": find_file("monster_mask.jpg"),
        "heroMission": find_file("hero_mission_mask.jpg"),
        "sauronMission": find_file("sauron_mission_mask.jpg"),
        "startingPlot": find_file("starting plot_mask.jpg"),
        "heroFight": find_file("hero fight card back.jpg"),
    }.items() if v}

    # ---- heroes ----
    for h in cat.get("heroes", {}).get("heroes", []):
        hid = h["id"]
        n = norm(h["id"])  # e.g. thalin, argalad
        man["heroes"][hid] = {k: url(v) for k, v in {
            "figure": find_file(f"figure_{n}.png"),
            "sheet": find_file(f"Player_sheet_{h['id'].capitalize()}.jpg", f"Player_sheet_{h['name']}.jpg"),
            "advanced": find_file(f"{n}_advanced.jpg"),
            "startingMask": find_file(f"{n}_starting_mask.jpg"),
            "starting1": find_file(f"{n}_starting1.jpg"),
            "starting2": find_file(f"{n}_starting2.jpg"),
        }.items() if v}

    # ---- monsters (monster_<name>.jpg) ----
    for m in cat.get("monsters", {}).get("monsters", []):
        nm = norm(m["name"])
        cand = None
        for f in files:
            if f.startswith("monster_") and norm(f[len("monster_"):].rsplit(".", 1)[0]) == nm:
                cand = f
                break
        if cand:
            man["monsters"][m["id"]] = url(cand)

    # ---- characters (character-<name>.jpg) ----
    for f in files:
        m = re.match(r"character-(.+)\.jpg$", f, re.I)
        if m:
            man["characters"][norm(m.group(1))] = url(f)

    # ---- items (item_<name> ().jpg) ----
    for f in files:
        m = re.match(r"item_(.+?)\s*\(\d*\)\.jpg$", f, re.I)
        if m:
            man["items"][norm(m.group(1))] = url(f)

    # ---- named decks by title: shadow / plots / corruption / startingPlots ----
    def title_map(prefix, target_key, catlist, id_key="id", name_key="name"):
        # entryName->image for slots whose image starts with prefix
        art = {}
        for entry, img, lab in slots:
            if img and img.startswith(prefix):
                title = entry or lab
                if title:
                    art[norm(title)] = url(img)
        # join to catalog by normalized name
        for c in catlist:
            k = norm(c.get(name_key, ""))
            if k in art:
                man[target_key][c[id_key]] = art[k]
        man[target_key + "_byTitle"] = art
        return art

    title_map("shadow", "shadow", cat.get("shadow", {}).get("cards", []))
    title_map("corruption", "corruption", cat.get("corruption", {}).get("cards", []) if cat.get("corruption") else [])
    title_map("plot0", "plots", cat.get("plots", {}).get("plots", []))
    # starting plots (no catalog yet) — expose by title
    sp = {}
    for entry, img, lab in slots:
        if img and img.startswith("starting plot"):
            sp[norm(entry or lab)] = url(img)
    man["startingPlots"] = sp

    # ---- ordered anonymous decks: encounters(enA..enH), perils, events, missions ----
    def ordered(prefix):
        seq = []
        for entry, img, lab in slots:
            if img and re.match(prefix, img):
                seq.append(img)
        # sort by trailing number
        def num(x):
            m = re.search(r"(\d+)\.", x)
            return int(m.group(1)) if m else 0
        return sorted(set(seq), key=lambda x: (re.sub(r"\d+\..*", "", x), num(x)))

    # encounters: our ids carry regionColor; vmod deck letters map to colors.
    # Map deterministically by our encounter list order onto enA..enH pool order.
    enc_imgs = []
    for L in "ABCDEFGH":
        enc_imgs += ordered(rf"en{L}\d")
    for i, c in enumerate(cat.get("encounters", {}).get("cards", [])):
        if i < len(enc_imgs):
            man["encounters"][c["id"]] = url(enc_imgs[i])

    peril_imgs = ordered(r"peril\d")
    for i, c in enumerate(cat.get("peril", {}).get("cards", [])):
        if i < len(peril_imgs):
            man["perils"][c["id"]] = url(peril_imgs[i])

    ev_imgs = ordered(r"eventI\d") + ordered(r"eventII\d") + ordered(r"eventIII\d")
    for i, c in enumerate(cat.get("events", {}).get("events", cat.get("events", {}).get("cards", []) if cat.get("events") else [])):
        if i < len(ev_imgs):
            man["events"][c["id"]] = url(ev_imgs[i])

    hm = ordered(r"hero_mission\d")
    for i, c in enumerate(cat.get("missions", {}).get("heroMissions", [])):
        if i < len(hm):
            man["heroMissions"][c["id"]] = url(hm[i])
    sm = ordered(r"sauron_mission\d")
    for i, c in enumerate(cat.get("missions", {}).get("sauronMissions", [])):
        if i < len(sm):
            man["sauronMissions"][c["id"]] = url(sm[i])

    # ---- combat cards: "<hero|deck> <ability> xN.jpg" ----
    # index by (owner, ability) -> image
    cc = {}
    for f in files:
        m = re.match(r"([a-z]+)\s+(.+?)(?:\s+x\d+)?\.jpg$", f, re.I)
        if not m:
            continue
        owner = norm(m.group(1))
        ability = norm(m.group(2))
        if owner in ("argalad", "beravor", "eleanor", "eometh", "thalin",
                     "zealot", "ravager", "behemoth"):
            cc.setdefault(owner, {})[ability] = url(f)
    man["combatCardsByOwner"] = cc
    # attach to our combat cards by ability name where a hero context is unknown;
    # store an ability->image fallback pooled across heroes
    pooled = {}
    for owner, d in cc.items():
        for ab, u in d.items():
            pooled.setdefault(ab, u)
    for c in cat.get("combat-cards", {}).get("cards", []):
        k = norm(c.get("name", "").replace("Training", ""))
        # combat card names may differ from ability art names; best-effort
        if k in pooled:
            man["combatCards"][c["id"]] = pooled[k]

    return man


def main():
    z = zipfile.ZipFile(VMOD)
    files = extract_images(z)
    man = build_manifest(z, files)
    json.dump(man, open(MANIFEST, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    counts = {k: len(v) for k, v in man.items() if isinstance(v, dict)}
    print(f"extracted {len(files)} images -> {OUT_DIR}")
    print("manifest counts:", json.dumps(counts))
    print("wrote", MANIFEST)


if __name__ == "__main__":
    main()
