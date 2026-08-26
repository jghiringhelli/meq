"""Build clean JSON catalog files under assets/ from the owner-supplied
Middle-earth Quest fulltext spreadsheets in text/*.xls.

This is the "break the cards down into clear files" deliverable (SPEC + user
request). Output provenance is marked "owner-verified": the text originates
from the owner's own reference materials for their local non-commercial port.

Run: python scripts/build-catalog.py
"""
import json, os, re, math
import pandas as pd

TEXT = "text"
OUT = "assets"
os.makedirs(OUT, exist_ok=True)

HERO_SHEETS = {
    "Th\ufffdlin": "thalin", "Argalad": "argalad", "Eleanor": "eleanor",
    "Eometh": "eometh", "Beravor": "beravor",
}
MONSTER_DECKS = ["Beremoth", "Ravager", "Zealot"]  # sheet names (deck names)

def clean(v):
    if v is None: return ""
    if isinstance(v, float) and math.isnan(v): return ""
    if isinstance(v, float) and v.is_integer(): return int(v)
    s = str(v).strip()
    return s

def slug(s):
    s = re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")
    return s or "x"

def to_int(v, default=0):
    c = clean(v)
    if isinstance(c, int): return c
    try:
        return int(str(c).strip())
    except (ValueError, TypeError):
        return default

def split_ratio(v):
    c = str(clean(v))
    m = re.match(r"\s*(\d+)\s*/\s*(\d+)", c)
    if m: return int(m.group(1)), int(m.group(2))
    return 0, 0

# The source .xls stores some proper names as Latin-1 mojibake (U+FFFD). Fix
# the few display names we can't recover from bytes.
HERO_NAME_FIX = {"thalin": "Th\u00e1lin"}

def find_header(df, label):
    """Return the row index whose first non-empty cell matches label (case-insensitive)."""
    for i in range(len(df)):
        for j in range(df.shape[1]):
            c = clean(df.iat[i, j])
            if isinstance(c, str) and c.lower() == label.lower():
                return i
    return None

def meta(schema, note):
    return {"schema": schema, "provenance": "owner-verified",
            "source": "text/*.xls (owner-supplied MEQ fulltext)", "notes": [note]}

def write(name, obj):
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    print("wrote", name)

# ---------- Combat-card effect classification (M2) ----------
# Maps each distinct combat-card ability to a stable effectKey consumed by the
# engine's effect registry (src/engine/effects.ts). The source spreadsheets
# carry a few typos ("opponet", "mus tell", "na adjacent"); we normalize them so
# variant spellings collapse to one key.
def _norm_ability(text):
    s = str(text or "").strip().lower()
    s = re.sub(r"\s+", " ", s)
    s = s.replace("opponet", "opponent").replace("mus tell", "must tell")
    s = s.replace("na adjacent", "an adjacent")
    return s

_EFFECT_MAP = {
    "gain +2 defense if your opponent plays a melee card.": "def_bonus_vs_melee_2",
    "gain +2 attack if your opponent plays a ranged card.": "atk_bonus_vs_ranged_2",
    "gain +1 attack if your opponent plays a melee card.": "atk_bonus_vs_melee_1",
    "gain +3 attack if your opponent plays a melee card.": "atk_bonus_vs_melee_3",
    "gain +5 attack if your opponent's printed defense is 0.": "atk_bonus_if_opp_def0_5",
    "gain +3 attack if your opponent's printed defense is 0.": "atk_bonus_if_opp_def0_3",
    "gain +3 attack if your opponent's card matches the type he played last round.": "atk_bonus_if_opp_repeat_3",
    "reduce your opponent's printed defense to 0.": "reduce_opp_def_0",
    "reduce your opponent's printed attack and printed defense to 1.": "reduce_opp_atk_def_1",
    "cancel your opponent's card.": "cancel_opp_any",
    "cancel your opponent's ranged card.": "cancel_opp_ranged",
    "cancel your opponent's melee card.": "cancel_opp_melee",
    "this card cannot be canceled.": "uncancelable",
    "this card cannot be canceled, and its defense cannot be reduced below 2.": "uncancelable_def_floor_2",
    "if you deal at least 1 damage this round, deal 2 additional damage.": "bonus_dmg_if_dealt_2",
    "if you are dealt at least 1 damage this round, take 2 additional damage.": "self_extra_dmg_if_hit_2",
    "you cannot be dealt more than 1 damage this round.": "dmg_cap_1",
    "draw up to 2 cards from the top of your rest pool or life pool.": "draw_2",
    "your opponent must discard 1 random card from his hand.": "opp_discard_random_1",
    "your opponent must tell you how many ranged and melee cards are in his hand.": "reveal_opp_hand",
    "next round, gain +2 defense.": "next_def_2",
    "next round, gain +2 attack and +2 defense.": "next_atk_def_2",
    "next round, gain +2 attack if you play a melee card.": "next_atk_if_melee_2",
    "next round, gain +2 attack if you play a ranged card.": "next_atk_if_ranged_2",
    "next round, gain +2 defense if you play a ranged card.": "next_def_if_ranged_2",
    "next round, if your opponent plays a melee card, it is canceled.": "next_cancel_opp_melee",
    "next round, if your opponent plays a ranged card, it is canceled.": "next_cancel_opp_ranged",
    "next round, your opponent must play his combat card first, and must place it faceup.": "next_opp_reveal_first",
}

_UNMAPPED_ABILITIES = set()

def combat_effect_key(text):
    n = _norm_ability(text)
    if not n:
        return ""
    if n in _EFFECT_MAP:
        return _EFFECT_MAP[n]
    if n.startswith("if you do not take damage this round, you may end the battle"):
        return "escape_if_unhurt"
    _UNMAPPED_ABILITIES.add(n)
    return ""

# ---------- Mission win conditions (M3) ----------
# Structured predicates evaluated by src/engine/missions.ts. Keyed by name-slug.
# The source spreadsheet duplicates the four hero mission texts into the Sauron
# columns (a transcription error); only "His Dark Throne" is a genuine Sauron
# mission, so the other Sauron rows are left condition-less (documented flavor).
MISSION_CONDITIONS = {
    "noble-blood": {"kind": "heroCorruptionAtMost", "n": 1},
    "against-the-shadow": {"kind": "monstersAtMost", "n": 2},
    "isildur-s-secret": {"kind": "heroFavorAtLeast", "n": 5},
    "minas-morgul-kept-at-bay": {"kind": "minionsAtMost", "n": 2},
    "the-spear-of-the-west": {"kind": "allQuestsComplete"},
    "his-dark-throne": {"kind": "activePlotsAtLeast", "n": 3},
}

# ---------- Non-combat effect ops (M3) ----------
# Conservative atomic-op extraction shared by encounter + event cards. Only the
# clearest, unambiguous phrasings are turned into mechanical ops; anything else
# is left for the `flavor` path (shown as verbatim text, no mechanical effect).
# Each op is {"op": <name>, "n": <int>} applied by src/engine/noncombat.ts.
def parse_ops(text):
    t = str(text or "").strip()
    if not t:
        return []
    tl = t.lower()
    ops = []
    m = re.search(r"gain (\d+) favor", tl)
    if m: ops.append({"op": "gainFavor", "n": int(m.group(1))})
    m = re.search(r"(?:lose|discard) (\d+) favor", tl)
    if m: ops.append({"op": "loseFavor", "n": int(m.group(1))})
    # "discard N of your Corruption cards" removes corruption; "gain/receive/take N Corruption" adds it
    m = re.search(r"discard (\d+) (?:of your )?corruption", tl)
    if m: ops.append({"op": "removeCorruption", "n": int(m.group(1))})
    m = re.search(r"(?:gain|receive|take) (\d+) corruption", tl)
    if m: ops.append({"op": "gainCorruption", "n": int(m.group(1))})
    m = re.search(r"(?:add|place) (\d+) influence", tl)
    if m: ops.append({"op": "addInfluence", "n": int(m.group(1))})
    m = re.search(r"remove (\d+) influence", tl)
    if m: ops.append({"op": "removeInfluence", "n": int(m.group(1))})
    m = re.search(r"(?:suffer|take|deal[s]?)(?: you)? (\d+) damage", tl)
    if m: ops.append({"op": "damage", "n": int(m.group(1))})
    return ops

def classify_row(text):
    """Return (ops, kind) where kind is mechanical|flavor|empty."""
    t = str(text or "").strip()
    if not t:
        return [], "empty"
    ops = parse_ops(t)
    return ops, ("mechanical" if ops else "flavor")

# ---------- M4: layered encounter-effect tree compiler ----------
# Compile an encounter card's rules text into a structured EffTree (schema in
# src/engine/types.ts) that the interpreter (src/engine/encounter.ts) walks,
# evaluating conditions against live state and pausing at choice/optional nodes.
# The compiler is pattern-based recursive descent; any clause it cannot model
# becomes a `raw` leaf so the card is flagged `partial` (never silently lost).

# node/atom/metric/cond constructors ------------------------------------------
def _seq(*steps):
    steps = [s for s in steps if s and s.get("k") != "none"]
    if not steps: return {"k": "none"}
    if len(steps) == 1: return steps[0]
    return {"k": "seq", "steps": steps}
def _op(atom): return {"k": "op", "atom": atom}
def _raw(t): return {"k": "raw", "text": t.strip()}
def _none(): return {"k": "none"}
def _choice(prompt, options): return {"k": "choice", "prompt": prompt, "options": options}
def _optional(prompt, cost, eff): return {"k": "optional", "prompt": prompt, "cost": cost, "eff": eff}
def _iff(cond, then, els=None):
    n = {"k": "if", "cond": cond, "then": then}
    if els and els.get("k") != "none": n["else"] = els
    return n
def _opt(label, cost, eff): return {"label": label, "cost": cost, "eff": eff}
def _num(n): return {"num": n}
def _stat(s): return {"stat": s}
def _count(c): return {"count": c}
def _cond(cmp, l, r): return {"cmp": cmp, "left": l, "right": r}

def _normalize(t):
    t = str(t or "").strip()
    reps = {
        "Gain1": "Gain 1", "poll": "pool", "Shadow Pools": "Shadow Pool",
        "Braown": "Brown", "Gones": "Gone", "Ruains": "Ruins", "Riaders": "Riders",
        "Remmants": "Remnants", "Commom": "Common", "\ufffd": "e",
    }
    for a, b in reps.items():
        t = t.replace(a, b)
    # un-glue compound tokens that appear in the fulltext without spaces
    t = re.sub(r"\s*&\s*", " and ", t)
    t = re.sub(r"(?i)\bcorruptioncard", "corruption card", t)
    t = re.sub(r"(?i)\bmonstertoken", "monster token", t)
    t = re.sub(r"(?i)\bplotcard", "plot card", t)
    t = re.sub(r"(?i)\binfluencetoken", "influence token", t)
    t = re.sub(r"(?i)\bshadowpool", "shadow pool", t)
    # normalise number words the parser expects as digits
    for word, dig in (("one", "1"), ("two", "2"), ("three", "3")):
        t = re.sub(r"(?i)\b%s\b(?=\s+(?:corruption|favor|influence|monster|level|plot|card|space|damage|item))" % word, dig, t)
    return t.strip()

_STATS = ("wisdom", "agility", "fortitude", "strength")

def _metric(phrase):
    """Parse the right-hand side of a comparison into a Metric."""
    p = phrase.strip().lower()
    if re.search(r"monster tokens", p): return _count("monstersInRegion")
    if re.search(r"influence in (?:the )?shadow pool", p): return _count("influenceShadowPool")
    if re.search(r"influence (?:in|of) .*region", p) or re.search(r"influence in your region", p): return _count("influenceInRegion")
    if re.search(r"total influence in your region", p): return _count("influenceInRegion")
    if re.search(r"total influence in the regions", p): return _count("influenceInRegion")
    if re.search(r"corruption cards?", p): return _count("corruptionOnHero")
    if re.search(r"plot cards? in play", p): return _count("plotsInPlay")
    if re.search(r"item cards?", p): return _count("itemsOnHero")
    m = re.search(r"(\d+)", p)
    if m: return _num(int(m.group(1)))
    return None

_CMP = {
    "equals or exceeds": "ge", "equal to or greater than": "ge",
    "greater than or equal to": "ge", "is greater than": "gt", "greater than": "gt",
    "is less than": "lt", "less than": "lt", "equal to or less than": "le",
    "is equal to": "eq", "equals": "eq", "exceeds": "gt",
}

def _parse_cond(text):
    """Parse 'your <stat> <cmp> <metric>' → Cond, else None."""
    t = text.strip().lower()
    m = re.search(r"(?:your (?:hero'?s? )?)?(wisdom|agility|fortitude|strength)(?:'s)?\s+(?:is\s+)?(equals or exceeds|equal to or greater than|greater than or equal to|is greater than|greater than|is less than|less than|equal to or less than|is equal to|equals|exceeds)\s+(?:the (?:number|amount|total) of\s+|the\s+)?(.+)", t)
    if m:
        stat, cmpw, rhs = m.group(1), m.group(2), m.group(3)
        met = _metric(rhs)
        if met is not None:
            return _cond(_CMP[cmpw], _stat(stat), met)
    if re.search(r"do(?:es)? not have any corruption", t):
        return {"cmp": "noCorruption"}
    return None

# single imperative clause → atom, or None -----------------------------------
def _parse_atom(text):
    t = text.strip().rstrip(".").strip()
    tl = t.lower()
    if not tl: return None
    def num(pat, d=1):
        m = re.search(pat, tl)
        return int(m.group(1)) if m else d
    if re.search(r"receive training twice", tl): return {"op": "training", "n": 2}
    if re.search(r"(?:receive|get|gets) training", tl): return {"op": "training", "n": 1}
    if re.search(r"gain\b.*\bfavor", tl) and re.search(r"gain (\d+) favor", tl):
        return {"op": "gainFavor", "n": num(r"gain (\d+) favor")}
    if re.search(r"gets? (\d+) favor", tl): return {"op": "gainFavor", "n": num(r"gets? (\d+) favor")}
    if re.search(r"gain 1 favor", tl) or tl == "gain favor" or re.search(r"gets? 1 favor", tl): return {"op": "gainFavor", "n": 1}
    if re.search(r"place (\d+) favor in", tl): return {"op": "gainFavor", "n": num(r"place (\d+) favor in")}
    if re.search(r"place 1 favor in", tl): return {"op": "gainFavor", "n": 1}
    if re.search(r"spend (\d+) favor", tl): return {"op": "loseFavor", "n": num(r"spend (\d+) favor")}
    if re.search(r"(?:loses?|discard) (\d+) favor", tl): return {"op": "loseFavor", "n": num(r"(?:loses?|discard) (\d+) favor")}
    if re.search(r"discard all corruption", tl): return {"op": "discardAllCorruption"}
    if re.search(r"discard (\d+) (?:of your )?corruption", tl): return {"op": "discardCorruption", "n": num(r"discard (\d+) (?:of your )?corruption")}
    if re.search(r"(?:gain|receive|draw|take) (\d+) corruption", tl): return {"op": "gainCorruption", "n": num(r"(?:gain|receive|draw|take) (\d+) corruption")}
    if re.search(r"(?:gain|receive|draw|take) (?:a|1) corruption", tl): return {"op": "gainCorruption", "n": 1}
    if re.search(r"remove (\d+) influence from the shadow pool", tl): return {"op": "removeInfluence", "n": num(r"remove (\d+) influence")}
    if re.search(r"(?:discard|remove) (\d+) influence from the shadow pool", tl): return {"op": "removeInfluence", "n": num(r"(?:discard|remove) (\d+) influence")}
    if re.search(r"(?:add|place) (\d+) influence.*shadow pool", tl): return {"op": "addInfluence", "n": num(r"(?:add|place) (\d+) influence")}
    if re.search(r"place 1 influence in the shadow pool", tl): return {"op": "addInfluence", "n": 1}
    if re.search(r"discard (?:up to )?(\d+) influence.*(?:from your region|tokens from your region)", tl): return {"op": "discardRegionInfluence", "n": num(r"(\d+) influence")}
    if re.search(r"remove all influence", tl): return {"op": "discardRegionInfluence", "n": 99}
    if re.search(r"remove (?:up to )?(\d+) influence", tl): return {"op": "discardRegionInfluence", "n": num(r"remove (?:up to )?(\d+) influence")}
    if re.search(r"(?:gain|receive) (\d+) level.*(fortitude|strength|agility|wisdom)", tl):
        n = num(r"(\d+) level")
        if re.search(r"fortitude,\s*strength", tl): return {"op": "gainStat", "stat": "choice", "n": n}
        m = re.search(r"level.*?(fortitude|strength|agility|wisdom)", tl)
        return {"op": "gainStat", "stat": m.group(1), "n": n}
    if re.search(r"gain 1 level of (fortitude|strength|agility|wisdom)", tl):
        m = re.search(r"gain 1 level of (fortitude|strength|agility|wisdom)", tl); return {"op": "gainStat", "stat": m.group(1), "n": 1}
    if re.search(r"1 level of (agility|fortitude|strength|wisdom)", tl):
        m = re.search(r"1 level of (agility|fortitude|strength|wisdom)", tl); return {"op": "gainStat", "stat": m.group(1), "n": 1}
    if re.search(r"dealt (\d+) damage for each corruption", tl): return {"op": "damagePer", "n": num(r"dealt (\d+) damage"), "per": "corruptionOnHero"}
    if re.search(r"gain (?:a|an|1|the)\s*\"?[\w\s'-]*?\"?\s*item card", tl) or re.search(r'gain (?:a|the) ".+?" item card', t):
        m = re.search(r'gain (?:a|an|1|the)?\s*"([^"]+)"\s*item', t, re.I)
        return {"op": "gainItem", "item": m.group(1) if m else "Item"}
    if re.search(r'gain (?:a|an|1|the)?\s*"([^"]+)"\s*item', t, re.I):
        m = re.search(r'gain (?:a|an|1|the)?\s*"([^"]+)"\s*item', t, re.I); return {"op": "gainItem", "item": m.group(1)}
    if re.search(r"discard (\d+) (?:of your )?item", tl): return {"op": "discardItem", "n": num(r"discard (\d+) (?:of your )?item")}
    if re.search(r"move (?:your hero )?(?:immediately )?to an adjacent location", tl) or re.search(r"move to an adjacent location", tl): return {"op": "moveAdjacent"}
    m = re.search(r"move (?:immediately )?to ([\w '-]+?) and encounter that location", tl)
    if m: return {"op": "moveToEncounter", "location": m.group(1).strip()}
    m = re.search(r"(?:that character |that hero )?move to ([\w '-]+)", tl)
    if m and "adjacent" not in m.group(1) and "any location" not in m.group(1):
        return {"op": "moveToEncounter", "location": m.group(1).strip()}
    if re.search(r"(?:you are|your hero is) dealt (\d+) damage", tl): return {"op": "damage", "n": num(r"dealt (\d+) damage")}
    if re.search(r"dealt (\d+) damage", tl): return {"op": "damage", "n": num(r"dealt (\d+) damage")}
    if re.search(r"(?:force sauron to discard|sauron (?:must|player must) (?:then )?(?:choose|discard)).*?(\d+)?.*(plot|shadow) card", tl):
        m = re.search(r"(?:force sauron to discard|sauron (?:must|player must) (?:then )?(?:choose|discard)).*?(\d+)?.*(plot|shadow) card", tl)
        return {"op": "forceSauronDiscard", "n": 1, "pile": ("plot" if m.group(2) == "plot" else "shadow")}
    if re.search(r"discard an active plot", tl): return {"op": "forceSauronDiscard", "n": 1}
    if re.search(r"advance sauron'?s? (?:yellow )?marker (\d+) space", tl): return {"op": "advanceStory", "n": num(r"marker (\d+) space")}
    if re.search(r"your turn ends", tl): return {"op": "endTurn"}
    if re.search(r"discard (\d+) monster token", tl): return {"op": "discardMonsterToken", "n": num(r"discard (\d+) monster token")}
    if re.search(r"remove (?:up to )?(\d+) monster token", tl): return {"op": "discardMonsterToken", "n": num(r"remove (?:up to )?(\d+) monster token")}
    if re.search(r"remove (?:a|1|one) monster token", tl): return {"op": "discardMonsterToken", "n": 1}
    if re.search(r"discard (\d+) (?:random )?cards? from (?:your|his) hand", tl): return {"op": "discardHand", "n": num(r"discard (\d+) (?:random )?cards? from (?:your|his) hand")}
    if re.search(r"look at sauron'?s? hand", tl): return {"op": "lookSauronHand"}
    if re.search(r"allow sauron to draw a plot card", tl): return {"op": "sauronDrawPlot"}
    if re.search(r"draw a number of hero cards equal to your fortitude", tl): return {"op": "drawPer", "per": "fortitude"}
    if re.search(r"(?:examine|look at the face of).*monster tokens", tl): return {"op": "examineTokens"}
    m = re.search(r"place (gandalf|aragorn|boromir|the grey pilgrim) in ([\w '-]+)", tl)
    if m: return {"op": "placeCharacter", "who": m.group(1).title(), "location": m.group(2).strip()}
    if re.search(r"shuffle.*(?:rest pool|damage pool).*life pool", tl): return {"op": "heal"}
    if re.search(r"for each point of (?:wisdom|fortitude).*damage pool", tl): return {"op": "heal"}
    # --- M9: shadow / event / peril mechanics --------------------------------
    # forced combat vs a named monster ("must combat a Balrog", "combat a Cave Troll")
    m = re.search(r"(?:must )?(?:immediately )?(?:enter |begin )?combat(?:s|ting)?(?: with| a| an| the)+ ([\w '-]+?)(?:\.|$| at| in| that)", tl)
    if m:
        name = m.group(1).strip()
        if name and not name.startswith(("this", "that", "you", "your")):
            return {"op": "forceCombat", "monster": name}
    # ongoing combat stat modifiers (until end of combat/battle)
    m = re.search(r"(strength|agility|fortitude|wisdom) (?:is )?reduced by (\d+) (?:for each|per) corruption", tl)
    if m: return {"op": "combatStatMod", "stat": m.group(1), "n": -int(m.group(2)), "per": "corruptionOnHero"}
    m = re.search(r"(strength|agility|fortitude|wisdom) (?:is )?reduced to 0", tl)
    if m: return {"op": "combatStatMod", "stat": m.group(1), "n": -99}
    m = re.search(r"(strength|agility|fortitude|wisdom) (?:is )?reduced by (\d+)", tl)
    if m: return {"op": "combatStatMod", "stat": m.group(1), "n": -int(m.group(2))}
    m = re.search(r"-(\d+) (strength|agility|fortitude|wisdom)", tl)
    if m: return {"op": "combatStatMod", "stat": m.group(2), "n": -int(m.group(1))}
    # Sauron places monster tokens
    if re.search(r"place (?:up to )?(\d+) monster token", tl): return {"op": "spawnMonster", "n": num(r"place (?:up to )?(\d+) monster token")}
    if re.search(r"place (?:a|1|one) monster token", tl): return {"op": "spawnMonster", "n": 1}
    if re.search(r"place (?:up to )?(\d+) monster", tl): return {"op": "spawnMonster", "n": num(r"place (?:up to )?(\d+) monster")}
    if re.search(r"place (?:a|1|one) monster", tl): return {"op": "spawnMonster", "n": 1}
    # Sauron places influence somewhere other than the shadow pool
    m = re.search(r"place (\d+) influence in (?:the region of |each location of |the )?(mordor|the shire|shire|[\w '-]+)", tl)
    if m:
        n = int(m.group(1)); where = m.group(2).strip()
        if "mordor" in where: return {"op": "placeInfluence", "where": "mordor", "n": n}
        if "shire" in where: return {"op": "placeInfluence", "where": "shire", "n": n}
        return {"op": "placeInfluence", "where": "location", "n": n, "location": where}
    if re.search(r"place (\d+) influence", tl): return {"op": "placeInfluence", "where": "region", "n": num(r"place (\d+) influence")}
    # story-marker advances by colour (map onto the single dark story track)
    m = re.search(r"advance (?:the |your )?(?:hero|green)(?: story)? marker (\d+) space", tl)
    if m: return {"op": "advanceMarker", "marker": "hero", "n": int(m.group(1))}
    m = re.search(r"advance (?:the |sauron'?s? )?(?:black|red|yellow|dark)(?: story)? marker (\d+) space", tl)
    if m: return {"op": "advanceMarker", "marker": "sauron", "n": int(m.group(1))}
    if re.search(r"advance (?:the |sauron'?s? )?(?:black|red|yellow|dark)(?: story)? marker", tl): return {"op": "advanceMarker", "marker": "sauron", "n": 1}
    # movement restriction (Winter Storm)
    if re.search(r"(?:may not|cannot) move more than once", tl): return {"op": "restrictMovement", "n": 1}
    if re.search(r"(?:may not|cannot) (?:move|travel)", tl): return {"op": "restrictMovement", "n": 0}
    # location treated as perilous
    if re.search(r"treated as (?:if )?(?:a |an )?perilous", tl): return {"op": "forcePeril"}
    # corruption redistribution / plot-deck manipulation (approximate)
    if re.search(r"redistribute.*corruption|(?:each|another) hero (?:gains|receives) 1 corruption", tl): return {"op": "redistributeCorruption"}
    if re.search(r"(?:search|look through|look at|retrieve|reveal).*(?:top card of the )?plot (?:deck|card)", tl): return {"op": "plotManip", "n": 1}
    return None

def _split_top(text, sep):
    """Split on sep only at top level (not inside quotes)."""
    parts, depth, cur = [], 0, ""
    i = 0
    low = text.lower(); sl = sep.lower()
    while i < len(text):
        if text[i] == '"': depth ^= 1
        if depth == 0 and low[i:i+len(sep)] == sl:
            parts.append(cur); cur = ""; i += len(sep); continue
        cur += text[i]; i += 1
    parts.append(cur)
    return [p.strip() for p in parts if p.strip()]

def _parse_effect(text):
    """Compile a (sub)clause into an EffTree node."""
    t = _normalize(text).strip().rstrip(".").strip()
    if not t: return _none()

    # reusable-card marker: "Then shuffle this card and the matching discard pile into ... Encounter deck"
    m = re.search(r"(.*?)\.?\s*then shuffle this card.*encounter deck", t, re.I)
    if m:
        return _seq(_parse_effect(m.group(1)), _op({"op": "reusable"}))

    # quest: "[Place C in L.] [Sauron places ...] Explore X. Reward: EFF"
    m = re.search(r"^(.*?)explore ([\w '-]+?)\.\s*reward:\s*(.+)$", t, re.I)
    if m:
        pre, loc, reward = m.group(1).strip(), m.group(2).strip(), m.group(3).strip()
        steps = []
        pm = re.search(r"place (gandalf|aragorn|boromir) in ([\w '-]+)", pre, re.I)
        if pm: steps.append(_op({"op": "placeCharacter", "who": pm.group(1).title(), "location": pm.group(2).strip()}))
        sm = re.search(r"(?:sauron )?places? (\d+) influence in.*?(region of [\w ]+|shadow pool|any location[\w ]*)", pre, re.I)
        if sm:
            if "shadow pool" in sm.group(2).lower(): steps.append(_op({"op": "addInfluence", "n": int(sm.group(1))}))
            else: steps.append(_op({"op": "addInfluence", "n": int(sm.group(1))}))
        steps.append(_op({"op": "explore", "location": loc}))
        steps.append(_parse_effect(reward))
        return _seq(*steps)

    # damage-with-shields template
    m = re.search(r"your hero is dealt (\d+) damage\.\s*you may discard any number of cards.*?reduce the damage.*?(?:if you are dealt 0 damage|if you reduce the damage to 0),?\s*(.+)$", t, re.I)
    if m:
        n = int(m.group(1)); reward = _parse_effect(m.group(2))
        return _choice("A blow lands — discard cards to block it?", [
            _opt("Discard %d card(s) to negate the damage" % n, {"op": "discardHand", "n": n}, reward),
            _opt("Take %d damage" % n, None, _op({"op": "damage", "n": n})),
        ])

    # "You must choose to either A or B"
    m = re.search(r"you must choose to either (.+)$", t, re.I)
    if m:
        opts = _split_top(m.group(1), " or ")
        if len(opts) >= 2:
            return _choice("Choose one", [_opt(o.strip().capitalize(), None, _parse_effect(o)) for o in opts])

    # "You may [COST] to EFF[. Otherwise EFF2]" / "You may EFF"
    m = re.search(r"^you may (.+)$", t, re.I)
    if m:
        body = m.group(1)
        otherwise = None
        om = re.search(r"(.*?)\.\s*otherwise[, ]+(.+)$", body, re.I)
        if om: body, otherwise = om.group(1), om.group(2)
        cost = None; eff_text = body
        cm = re.search(r"^(spend \d+ favor|receive \d+ corruption card|receive 1 corruption card|gain \d+ corruption card|gain 1 corruption card|discard \d+ cards? from your hand|discard \d+ item cards?)\s+to\s+(.+)$", body, re.I)
        if cm:
            cost = _parse_atom(cm.group(1)); eff_text = cm.group(2)
        cm2 = re.search(r"^choose to (receive \d+ corruption card|receive 1 corruption card)\.?\s*(?:if you do,?\s*)?(.+)$", body, re.I)
        if cm2 and not cm:
            cost = _parse_atom(cm2.group(1)); eff_text = cm2.group(2)
        eff = _parse_effect(eff_text)
        if otherwise is not None:
            return _choice("Optional", [
                _opt("Accept", cost, eff),
                _opt("Otherwise", None, _parse_effect(otherwise)),
            ])
        return _optional("You may " + eff_text.strip(), cost, eff)

    # "If COND, EFF[. Otherwise EFF2]" / "EFF if COND"
    m = re.search(r"^if (.+?),\s*(.+)$", t, re.I)
    if m:
        cond = _parse_cond(m.group(1)); rest = m.group(2)
        els = None
        om = re.search(r"(.*?)\.\s*otherwise[, ]+(.+)$", rest, re.I)
        if om: rest, els = om.group(1), _parse_effect(om.group(2))
        if cond:
            return _iff(cond, _parse_effect(rest), els)

    # "HEAD. Then[,] TAIL"  (sequence; TAIL may itself be conditional). Must run
    # before the reversed "EFF if COND" handler so "Then, if X, reward" splits.
    m = re.search(r"^(.+?)\.\s*then[,]?\s*(.+)$", t, re.I)
    if m:
        return _seq(_parse_effect(m.group(1)), _parse_effect(m.group(2)))

    m = re.search(r"^(.+?) if (your.+)$", t, re.I)
    if m:
        cond = _parse_cond(m.group(2))
        if cond: return _iff(cond, _parse_effect(m.group(1)))

    # top-level "A or B" choice between two imperative effects
    ors = _split_top(t, " or ")
    if len(ors) == 2 and all(_parse_atom(o) or re.search(r"\bif\b|\bshuffle\b|\bspend\b|\bmove\b", o, re.I) for o in ors):
        return _choice("Choose one", [_opt(o.strip().capitalize(), None, _parse_effect(o)) for o in ors])

    # sequence of ". "-separated imperatives
    sents = _split_top(t, ". ")
    if len(sents) > 1:
        return _seq(*[_parse_effect(s) for s in sents])

    # "spend N favor to EFF" (bare)
    m = re.search(r"^spend (\d+) favor to (.+)$", t, re.I)
    if m:
        return _seq(_op({"op": "loseFavor", "n": int(m.group(1))}), _parse_effect(m.group(2)))

    # multi-op single sentence joined by " and "
    ands = _split_top(t, " and ")
    if len(ands) > 1:
        atoms = [_parse_atom(a) for a in ands]
        if all(atoms):
            return _seq(*[_op(a) for a in atoms])

    atom = _parse_atom(t)
    if atom: return _op(atom)
    return _raw(t)

def _tree_partial(node):
    if node["k"] == "raw": return True
    if node["k"] == "seq": return any(_tree_partial(s) for s in node["steps"])
    if node["k"] == "if": return _tree_partial(node["then"]) or (("else" in node) and _tree_partial(node["else"]))
    if node["k"] == "optional": return _tree_partial(node["eff"]) or (node.get("cost") is None and False)
    if node["k"] == "choice": return any(_tree_partial(o["eff"]) for o in node["options"])
    return False

def compile_tree(text):
    """Return (tree, partial) for an encounter's effect text."""
    t = _normalize(text)
    if not t: return _none(), False
    key = slug(t[:40])
    for pat, builder in _OVERRIDES.items():
        if pat in t.lower():
            tree = builder()
            return tree, _tree_partial(tree)
    tree = _parse_effect(t)
    return tree, _tree_partial(tree)

# Hand-authored trees for the few cards whose wording resists the generic
# grammar (variable amounts, pool micro-management). Keyed by a distinctive
# substring of the (normalized) effect text.
_OVERRIDES = {
    "or spend any number of favor to discard an equal number of corruption": lambda: _choice("Choose one", [
        _opt("Gain 1 favor", None, _op({"op": "gainFavor", "n": 1})),
        _opt("Spend 1 favor to discard 1 Corruption card", {"op": "loseFavor", "n": 1}, _op({"op": "discardCorruption", "n": 1})),
    ]),
    "place the top 5 cards from your life pool on top of your rest pool": lambda: _iff(
        _cond("lt", _stat("fortitude"), _count("influenceInRegion")),
        _op({"op": "damage", "n": 5})),
    "you must shuffle your hand into your life pool": lambda: _seq(
        _op({"op": "discardHand", "n": 99}),
        _op({"op": "damagePer", "n": 2, "per": "corruptionOnHero"})),
    "draw a number of hero cards equal to your fortitude": lambda: _optional(
        "Gain 1 Corruption to draw Hero cards equal to your fortitude (else gain 1 favor)",
        {"op": "gainCorruption", "n": 1},
        _op({"op": "drawPer", "per": "fortitude"})),
}

# ---------- Heroes + hero combat cards ----------
def build_heroes():
    f = os.path.join(TEXT, "MEQ_Monster_Hero_combat_cards_Fulltext.xls")
    xl = pd.ExcelFile(f)
    heroes, cards = [], []
    for sheet, hid in HERO_SHEETS.items():
        if sheet not in xl.sheet_names:
            cand = [s for s in xl.sheet_names if slug(s).startswith(slug(sheet)[:4])]
            sheet = cand[0] if cand else None
        if not sheet: continue
        df = xl.parse(sheet, header=None)
        srow = find_header(df, "FORTITUDE")
        stats = df.iloc[srow + 1]
        ability_name = clean(df.iat[srow, 6])
        rr, rm = split_ratio(stats[4])
        heroes.append({
            "id": hid,
            "name": HERO_NAME_FIX.get(hid, clean(df.iat[0, 0])),
            "fortitude": to_int(stats[0]), "strength": to_int(stats[1]),
            "agility": to_int(stats[2]), "wisdom": to_int(stats[3]),
            "ratioRanged": rr, "ratioMelee": rm,
            "startLocation": slug(clean(stats[5])),
            "startLocationName": clean(stats[5]),
            "abilityName": ability_name, "abilityText": clean(stats[6]),
            "deck": f"hero-{hid}", "image": "", "copies": 1,
        })
        crow = find_header(df, "CARD NAME")
        for i in range(crow + 1, len(df)):
            nm = clean(df.iat[i, 0])
            if not isinstance(nm, str) or not nm: continue
            qty = clean(df.iat[i, 7])
            cards.append({
                "id": f"cmb-{hid}-{slug(nm)}",
                "deck": f"hero-{hid}", "owner": "hero", "name": nm,
                "type": slug(clean(df.iat[i, 1])),
                "attack": to_int(df.iat[i, 2]), "defense": to_int(df.iat[i, 3]),
                "strengthCost": to_int(df.iat[i, 4]), "terrain": slug(clean(df.iat[i, 5])),
                "ability": clean(df.iat[i, 6]), "effectKey": combat_effect_key(df.iat[i, 6]),
                "copies": qty if isinstance(qty, int) else 1,
            })
    write("heroes.json", {"_meta": meta("heroes-v2", "5 base heroes with stats + named ability."), "heroes": heroes})
    return cards

# ---------- Monsters + monster combat decks ----------
def build_monsters(hero_cards):
    f = os.path.join(TEXT, "MEQ_Monster_Minion_combat_cards_Monster_Reference_Fulltext.xls")
    xl = pd.ExcelFile(f)
    cards = list(hero_cards)
    monsters = []
    df = xl.parse("Monster Reference", header=None)
    hrow = find_header(df, "NAME")
    for i in range(hrow + 1, len(df)):
        nm = clean(df.iat[i, 1])
        if not isinstance(nm, str) or not nm: continue
        rr, rm = split_ratio(df.iat[i, 6])
        monsters.append({
            "id": f"mon-{slug(nm)}", "name": nm,
            "fortitude": to_int(df.iat[i, 2]), "strength": to_int(df.iat[i, 3]),
            "wisdom": to_int(df.iat[i, 4]), "deck": f"monster-{slug(clean(df.iat[i,5]))}",
            "ratioRanged": rr, "ratioMelee": rm, "ability": clean(df.iat[i, 7]),
            "effectKey": "", "image": "",
        })
    for deck in MONSTER_DECKS:
        cand = [s for s in xl.sheet_names if slug(s) == slug(deck)]
        sheet = cand[0] if cand else (deck if deck in xl.sheet_names else None)
        if not sheet: continue
        df = xl.parse(sheet, header=None)
        crow = find_header(df, "CARD NAME")
        did = f"monster-{slug(clean(df.iat[0,0]))}"
        for i in range(crow + 1, len(df)):
            nm = clean(df.iat[i, 0])
            if not isinstance(nm, str) or not nm: continue
            qty = clean(df.iat[i, 6])
            cards.append({
                "id": f"cmb-{did}-{slug(nm)}", "deck": did, "owner": "monster", "name": nm,
                "type": slug(clean(df.iat[i, 1])), "attack": to_int(df.iat[i, 2]),
                "defense": to_int(df.iat[i, 3]), "strengthCost": to_int(df.iat[i, 4]),
                "terrain": "", "ability": clean(df.iat[i, 5]), "effectKey": combat_effect_key(df.iat[i, 5]),
                "copies": qty if isinstance(qty, int) else 1,
            })
    write("monsters.json", {"_meta": meta("monsters-v1", "Monster reference stats + deck assignment."), "monsters": monsters})
    write("combat-cards.json", {"_meta": meta("combat-cards-v2", "Hero + monster-deck combat cards (attack/defense/type/cost/ability)."), "cards": cards})

# ---------- Encounters ----------
def build_encounters():
    f = os.path.join(TEXT, "MEQ_Encounter_Cards_Fulltext.xls")
    xl = pd.ExcelFile(f)
    out = []
    for sheet in xl.sheet_names:
        df = xl.parse(sheet, header=None)
        hrow = find_header(df, "Effect")
        if hrow is None: continue
        # column layout varies per sheet: locate columns by their header labels.
        hdr = [str(clean(df.iat[hrow, j])).strip().lower() for j in range(df.shape[1])]
        def col(label, default):
            return hdr.index(label) if label in hdr else default
        c_pri, c_name, c_loc = col("priority", 0), col("name", 1), col("location", 2)
        c_color, c_eff = col("region color", 3), col("effect", 4)
        for i in range(hrow + 1, len(df)):
            nm = clean(df.iat[i, c_name])
            if not isinstance(nm, str) or not nm: continue
            eff = clean(df.iat[i, c_eff])
            ops, kind = classify_row(eff)
            tree, partial = compile_tree(eff)
            out.append({
                "id": f"enc-{slug(sheet)}-{slug(nm)}", "regionGroup": sheet,
                "priority": clean(df.iat[i, c_pri]), "name": nm,
                "location": clean(df.iat[i, c_loc]), "regionColor": clean(df.iat[i, c_color]),
                "effect": eff, "effectKey": "", "ops": ops, "effectKind": kind,
                "tree": tree, "partial": partial,
            })
    npart = sum(1 for e in out if e["partial"])
    print(f"  encounters: {len(out)} cards, {npart} partial (contain raw remainder)")
    write("encounters.json", {"_meta": meta("encounters-v2", "Encounter cards grouped by region board."), "cards": out})

# ---------- Sauron: Shadow / Peril / Corruption / Mission ----------
def _to_2p(text):
    """The generic effect grammar was tuned for the second-person wording used on
    hero encounter cards ("you gain", "your turn ends"). Sauron peril/shadow cards
    are written in the third person ("the hero gains", "he loses 1 favor", "his
    turn ends"), so their text otherwise falls through to inert `raw`. Rewrite the
    third-person forms to the second person the parser expects (word-boundary only,
    so unrelated words are untouched)."""
    t = str(text or "")
    subs = [
        (r"\bthe hero's\b", "your"), (r"\bhero's\b", "your"),
        (r"\bthe hero\b", "you"), (r"\bthe character\b", "you"),
        (r"\bhe\b", "you"), (r"\bhim\b", "you"), (r"\bhis\b", "your"),
        # third-person singular verbs → base form
        (r"\bgains\b", "gain"), (r"\breceives\b", "receive"), (r"\bloses\b", "lose"),
        (r"\bdiscards\b", "discard"), (r"\btakes\b", "take"), (r"\bdraws\b", "draw"),
        (r"\bsuffers\b", "suffer"), (r"\bmoves\b", "move"), (r"\bcombats\b", "combat"),
        (r"\bspends\b", "spend"), (r"\bplaces\b", "place"), (r"\bexplores\b", "explore"),
        (r"\bmust immediately\b", "immediately"), (r"\bmust\b", ""),
    ]
    for pat, rep in subs:
        t = re.sub(pat, rep, t, flags=re.I)
    return re.sub(r"\s{2,}", " ", t).strip()

def build_sauron():
    f = os.path.join(TEXT, "MEQ_Mission_Corruption_Peril_Shadow_Cards_Fulltext.xls")
    xl = pd.ExcelFile(f)
    df = xl.parse("Shadow", header=None); h = find_header(df, "Name")
    shadow = []
    for i in range(h + 1, len(df)):
        nm = clean(df.iat[i, 1])
        if not isinstance(nm, str) or not nm: continue
        eff = clean(df.iat[i, 3])
        tree, partial = compile_tree(_to_2p(eff))
        shadow.append({"id": f"shadow-{slug(nm)}", "name": nm, "poolRequirement": clean(df.iat[i, 0]),
                       "timing": clean(df.iat[i, 2]), "effect": eff, "effectKey": "",
                       "tree": tree, "partial": partial})
    npart = sum(1 for e in shadow if e["partial"])
    print(f"  shadow: {len(shadow)} cards, {npart} partial")
    write("shadow.json", {"_meta": meta("shadow-v1", "Sauron Shadow cards."), "cards": shadow})
    df = xl.parse("Peril", header=None); h = find_header(df, "NAME")
    peril = []
    for i in range(h + 1, len(df)):
        nm = clean(df.iat[i, 0])
        if not isinstance(nm, str) or not nm: continue
        eff = clean(df.iat[i, 2])
        tree, partial = compile_tree(_to_2p(eff))
        peril.append({"id": f"peril-{slug(nm)}", "name": nm, "location": clean(df.iat[i, 1]),
                      "effect": eff, "region": clean(df.iat[i, 3]), "effectKey": "",
                      "tree": tree, "partial": partial})
    npart = sum(1 for e in peril if e["partial"])
    print(f"  peril: {len(peril)} cards, {npart} partial")
    write("peril.json", {"_meta": meta("peril-v1", "Sauron Peril cards."), "cards": peril})
    df = xl.parse("Corruption", header=None); h = find_header(df, "Name")
    corr = []
    for i in range(h + 1, len(df)):
        nm = clean(df.iat[i, 0])
        if not isinstance(nm, str) or not nm: continue
        corr.append({"id": f"corr-{slug(nm)}", "name": nm, "ability": clean(df.iat[i, 1]),
                     "cost": clean(df.iat[i, 2]), "effectKey": ""})
    write("corruption.json", {"_meta": meta("corruption-v1", "Corruption cards."), "cards": corr})
    df = xl.parse("Mission", header=None); h = find_header(df, "Name")
    hero_m, sauron_m = [], []
    for i in range(h + 1, len(df)):
        hn = clean(df.iat[i, 0])
        if isinstance(hn, str) and hn:
            hero_m.append({"id": f"mission-hero-{slug(hn)}", "name": hn, "text": clean(df.iat[i, 1]),
                           "effectKey": "", "condition": MISSION_CONDITIONS.get(slug(hn))})
        sn = clean(df.iat[i, 4])
        if isinstance(sn, str) and sn:
            sauron_m.append({"id": f"mission-sauron-{slug(sn)}", "name": sn, "text": clean(df.iat[i, 5]),
                             "effectKey": "", "condition": MISSION_CONDITIONS.get(slug(sn))})
    write("missions.json", {"_meta": meta("missions-v1", "Hero + Sauron mission win conditions."),
                            "heroMissions": hero_m, "sauronMissions": sauron_m})

# ---------- Quests ----------
def build_quests():
    df = pd.read_excel(os.path.join(TEXT, "MEQ_Quests_Fulltext.xls"), sheet_name="Quests", header=None)
    h = find_header(df, "Name")
    out = []
    for i in range(h + 1, len(df)):
        nm = clean(df.iat[i, 1])
        if not isinstance(nm, str) or not nm: continue
        out.append({"id": f"quest-{slug(clean(df.iat[i,0]))}-{slug(nm)}", "hero": slug(clean(df.iat[i, 0])),
                    "name": nm, "type": clean(df.iat[i, 2]), "setup": clean(df.iat[i, 3]),
                    "task": clean(df.iat[i, 4]), "reward": clean(df.iat[i, 5]),
                    "region": clean(df.iat[i, 6]), "effectKey": ""})
    write("quests.json", {"_meta": meta("quests-v1", "Hero starting + advanced quests."), "quests": out})

# ---------- Events (Sauron story deck by turn) ----------
def build_events():
    df = pd.read_excel(os.path.join(TEXT, "MEQ_Eventcards_Fulltext.xls"), sheet_name=0, header=None)
    h = find_header(df, "CARDNAME")
    out = []
    for i in range(h + 1, len(df)):
        nm = clean(df.iat[i, 2])
        if not isinstance(nm, str) or not nm: continue
        txt = clean(df.iat[i, 8])
        ops, kind = classify_row(txt)
        tree, partial = compile_tree(_to_2p(txt)) if isinstance(txt, str) and txt else ({"k": "none"}, False)
        out.append({"id": f"event-t{clean(df.iat[i,0])}-{slug(nm)}", "turn": clean(df.iat[i, 0]),
                    "cardNo": clean(df.iat[i, 1]), "name": nm, "favor1": clean(df.iat[i, 3]),
                    "favor2": clean(df.iat[i, 4]), "character": clean(df.iat[i, 5]),
                    "characterLocation": clean(df.iat[i, 6]), "questLocation": clean(df.iat[i, 7]),
                    "text": txt, "effectKey": "", "ops": ops, "effectKind": kind,
                    "tree": tree, "partial": partial})
    write("events.json", {"_meta": meta("events-v1", "Sauron event/plot deck, organized by turn."), "events": out})

# ---------- Map: locations + adjacency (real named nodes, derived terrain) ----------
# Board image (VASSAL MEQ_full_board.jpg) native pixel size; node coords live in this space.
BOARD_W, BOARD_H = 6112, 4203
# Real location centres read off the board art, in board-pixel space (⟨owner⟩ fine-tune).
MAP_LAYOUT = {
    "blue-mountains": (1130, 970), "the-grey-havens": (1390, 1345), "harlindon": (1010, 1420),
    "the-shire": (1804, 1285), "hills-of-evendim": (1900, 940), "old-forest": (2112, 1230),
    "fornost": (2200, 980), "bree": (2335, 1440), "weathertop": (2601, 1265),
    "the-trollshaws": (2941, 1277), "the-north-downs": (2340, 660), "ruins-of-angmar": (2500, 520),
    "the-northern-waste": (3525, 405), "mount-gundabad": (2870, 640), "ettenmoors": (2760, 940),
    "ered-mithrin": (3814, 634), "the-withered-heath": (4130, 550), "erebor": (4370, 790),
    "the-iron-hills": (4840, 835), "the-woodland-realm": (4087, 945), "lake-esgaroth": (4367, 1073),
    "the-forest-trail": (3801, 1043), "the-forest-road": (4090, 1180), "high-pass": (3544, 1177),
    "rivendell": (3256, 1295), "gladden-fields": (3689, 1594), "rhosgobel": (3974, 1656),
    "eregion": (2900, 1550), "the-redhorn-gate": (3090, 1680), "moria": (3060, 2030),
    "dol-guldur": (3970, 1940), "tharbad": (2525, 1912), "dunland": (2040, 2120),
    "enedwaith-plains": (2458, 2419), "mouth-of-the-greyflood": (2040, 2280), "isengard": (2950, 2423),
    "fangorn": (3173, 2449), "gap-of-rohan": (2820, 2720), "helms-deep": (3120, 2690),
    "plains-of-rohan": (3360, 2540), "lothl-rien": (3430, 2275), "amon-hen": (3715, 2299),
    "emyn-muil": (3889, 2359), "edoras": (3162, 2862), "dunharrow": (3550, 3160),
    "minas-tirith": (4089, 3155), "morthond": (3090, 3160), "anfalas": (2650, 3300),
    "belfalas": (3324, 3706), "osgiliath": (4225, 3391), "pelargir": (4010, 3620),
    "near-harad": (4130, 3960), "the-dead-marshes": (4173, 2770), "dagorlad": (4270, 2440),
    "sea-of-nurn": (4410, 2760), "minas-morgul": (4230, 3140), "mount-doom": (4661, 3092),
    "plains-of-gorgoroth": (4410, 3260), "barad-dur": (5290, 2900),
}
TERRAINS = ["woods", "swamp", "mountain", "desert", "hill"]
REGION_ORDER = ["Eriador and Enedwaith", "Rhudaur and Grey Mountains",
                "Mist Mountains and Mirkwood", "Rohan and Gondor",
                "Mordor and Brown Lands"]  # west->east spine; Haven cities merged in
HAVEN_NAMES = {"Edoras", "Erebor", "Fornost", "Lothl\ufffdrien", "Minas Tirith",
               "Rivendell", "The Woodland Realm"}

def build_map():
    enc = json.load(open(os.path.join(OUT, "encounters.json"), encoding="utf-8"))["cards"]
    # collect real named nodes per region (drop "Any Location..." wildcards)
    per_region = {}
    seen = {}
    for e in enc:
        loc, reg, col = e["location"], e["regionGroup"], e.get("regionColor", "")
        if not loc or loc.lower().startswith("any location"): continue
        lid = slug(loc)
        if lid in seen: continue
        seen[lid] = True
        per_region.setdefault(reg, []).append({"id": lid, "name": loc, "regionColor": col,
                                               "kind": "haven" if loc in HAVEN_NAMES else "wild"})
    # order regions along a west->east spine; unknown regions appended
    regions = [r for r in REGION_ORDER if r in per_region] + \
              [r for r in per_region if r not in REGION_ORDER]
    locations, edges = [], []
    col_x = 0
    prev_region_last = None
    ti = 0
    for reg in regions:
        nodes = per_region[reg]
        for row, n in enumerate(nodes):
            n2 = dict(n)
            n2["regionId"] = slug(reg)
            n2["regionName"] = reg
            n2["plotSlot"] = True
            n2["encounterDeck"] = []
            if n["id"] in MAP_LAYOUT:
                mx, my = MAP_LAYOUT[n["id"]]
                n2["coords"] = {"x": mx, "y": my}
            else:
                n2["coords"] = {"x": 120 + col_x * 150, "y": 90 + row * 85}
            n2["image"] = ""
            locations.append(n2)
        # chain nodes within the region (terrain cycles)
        for a, b in zip(nodes, nodes[1:]):
            edges.append({"a": a["id"], "b": b["id"], "terrain": TERRAINS[ti % len(TERRAINS)], "cost": 1}); ti += 1
        # bridge to previous region
        if prev_region_last is not None and nodes:
            edges.append({"a": prev_region_last, "b": nodes[0]["id"],
                          "terrain": TERRAINS[ti % len(TERRAINS)], "cost": 1}); ti += 1
        prev_region_last = nodes[-1]["id"] if nodes else prev_region_last
        col_x += 1
    # attach each encounter card to its location's deck when it names a real node
    loc_ids = {l["id"] for l in locations}
    for e in enc:
        lid = slug(e["location"])
        if lid in loc_ids:
            next(l for l in locations if l["id"] == lid)["encounterDeck"].append(e["id"])
    write("locations.json", {"_meta": {**meta("locations-v2",
        "Real named board nodes with true board-pixel coords read off the VASSAL map art."),
        "boardWidth": BOARD_W, "boardHeight": BOARD_H, "boardImage": "/dev-assets/MEQ_full_board.jpg"},
        "locations": locations})
    write("adjacency.json", {"_meta": meta("adjacency-v2",
        "Derived region-spine edges with cycled terrain so every hero terrain card is usable. ⟨owner⟩ replace with true board adjacency."),
        "edges": edges})
    reconcile_hero_starts(loc_ids)
    return locations

def reconcile_hero_starts(loc_ids):
    """Map each hero's startLocation to a real board node id (names differ,
    e.g. 'Woodland Realm' vs board node 'The Woodland Realm')."""
    path = os.path.join(OUT, "heroes.json")
    data = json.load(open(path, encoding="utf-8"))
    ids = sorted(loc_ids)
    for h in data["heroes"]:
        s = h["startLocation"]
        if s in loc_ids:
            continue
        match = None
        for lid in ids:
            if lid == "the-" + s or lid == s.replace("the-", "") or s in lid or lid.endswith("-" + s):
                match = lid; break
        h["startLocation"] = match or (ids[0] if ids else s)
    json.dump(data, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print("reconciled hero start locations")

def build_scenario(locations):
    # default scenario: first hero mission vs first sauron mission; story track = 10 turns
    missions = json.load(open(os.path.join(OUT, "missions.json"), encoding="utf-8"))
    scenario = {
        "storyTrackLength": 10,
        "heroMission": missions["heroMissions"][0]["id"] if missions["heroMissions"] else "",
        "sauronMission": missions["sauronMissions"][0]["id"] if missions["sauronMissions"] else "",
        "setup": {"sauronInfluence": 2,
                  "sauronStartLocation": locations[-1]["id"] if locations else ""},
    }
    write("scenario.json", {"_meta": meta("scenario-v2", "Default base-box scenario wiring."), "scenario": scenario})

if __name__ == "__main__":
    hero_cards = build_heroes()
    build_monsters(hero_cards)
    build_encounters()
    build_sauron()
    build_quests()
    build_events()
    locs = build_map()
    build_scenario(locs)
    if _UNMAPPED_ABILITIES:
        print("WARNING: unmapped combat abilities:")
        for a in sorted(_UNMAPPED_ABILITIES):
            print("   ", a)
    else:
        print("combat effect coverage: all abilities mapped")
    print("catalog build complete")
