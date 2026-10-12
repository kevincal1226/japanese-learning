"""Build the flashcard data files in data/.

Sources:
- KANJIDIC2 (EDRDG): kanji meanings, on/kun readings, frequency.
- JMdict (EDRDG): example words and the main reading of each kanji.
- JLPT N5-N1 kanji lists by Jonathan Waller (tanos.co.uk), read through
  jisho.org, which uses these lists for its JLPT tags.
- Kana: standard Hepburn romanization.

Usage:
    python3 -I scripts/build_data.py --src <download cache dir> --out data
"""

import argparse
import gzip
import json
import os
import re
import time
import urllib.request
import xml.etree.ElementTree as ET

KANJIDIC_URL = "http://www.edrdg.org/kanjidic/kanjidic2.xml.gz"
JMDICT_URL = "http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz"
JISHO_URL = "https://jisho.org/search/%23jlpt-n{level}%20%23kanji?page={page}"

LEVELS = [5, 4, 3, 2, 1]
GROUP_SIZE = 50

HIRAGANA = [
    ("あ", "a"), ("い", "i"), ("う", "u"), ("え", "e"), ("お", "o"),
    ("か", "ka"), ("き", "ki"), ("く", "ku"), ("け", "ke"), ("こ", "ko"),
    ("さ", "sa"), ("し", "shi"), ("す", "su"), ("せ", "se"), ("そ", "so"),
    ("た", "ta"), ("ち", "chi"), ("つ", "tsu"), ("て", "te"), ("と", "to"),
    ("な", "na"), ("に", "ni"), ("ぬ", "nu"), ("ね", "ne"), ("の", "no"),
    ("は", "ha"), ("ひ", "hi"), ("ふ", "fu"), ("へ", "he"), ("ほ", "ho"),
    ("ま", "ma"), ("み", "mi"), ("む", "mu"), ("め", "me"), ("も", "mo"),
    ("や", "ya"), ("ゆ", "yu"), ("よ", "yo"),
    ("ら", "ra"), ("り", "ri"), ("る", "ru"), ("れ", "re"), ("ろ", "ro"),
    ("わ", "wa"), ("を", "wo"), ("ん", "n"),
    ("が", "ga"), ("ぎ", "gi"), ("ぐ", "gu"), ("げ", "ge"), ("ご", "go"),
    ("ざ", "za"), ("じ", "ji"), ("ず", "zu"), ("ぜ", "ze"), ("ぞ", "zo"),
    ("だ", "da"), ("ぢ", "ji"), ("づ", "zu"), ("で", "de"), ("ど", "do"),
    ("ば", "ba"), ("び", "bi"), ("ぶ", "bu"), ("べ", "be"), ("ぼ", "bo"),
    ("ぱ", "pa"), ("ぴ", "pi"), ("ぷ", "pu"), ("ぺ", "pe"), ("ぽ", "po"),
    ("きゃ", "kya"), ("きゅ", "kyu"), ("きょ", "kyo"),
    ("しゃ", "sha"), ("しゅ", "shu"), ("しょ", "sho"),
    ("ちゃ", "cha"), ("ちゅ", "chu"), ("ちょ", "cho"),
    ("にゃ", "nya"), ("にゅ", "nyu"), ("にょ", "nyo"),
    ("ひゃ", "hya"), ("ひゅ", "hyu"), ("ひょ", "hyo"),
    ("みゃ", "mya"), ("みゅ", "myu"), ("みょ", "myo"),
    ("りゃ", "rya"), ("りゅ", "ryu"), ("りょ", "ryo"),
    ("ぎゃ", "gya"), ("ぎゅ", "gyu"), ("ぎょ", "gyo"),
    ("じゃ", "ja"), ("じゅ", "ju"), ("じょ", "jo"),
    ("びゃ", "bya"), ("びゅ", "byu"), ("びょ", "byo"),
    ("ぴゃ", "pya"), ("ぴゅ", "pyu"), ("ぴょ", "pyo"),
]

# First kana voicing in compounds (rendaku), e.g. 社 しゃ in 神社 じんじゃ.
VOICED = dict(zip("かきくけこさしすせそたちつてとはひふへほ", "がぎぐげござじずぜぞだぢづでどばびぶべぼ"))

# JMdict tags that mark a kanji form or reading as irregular, rare or outdated.
BAD_FORM_WORDS = ("irregular", "out-dated", "outdated", "rarely", "search-only", "ateji")


def download(url, path):
    if os.path.exists(path):
        return
    print("downloading", url)
    req = urllib.request.Request(url, headers={"User-Agent": "kanji-flashcards-build/1.0"})
    with urllib.request.urlopen(req) as resp, open(path, "wb") as f:
        f.write(resp.read())


def kata_to_hira(text):
    out = []
    for ch in text:
        code = ord(ch)
        if 0x30A1 <= code <= 0x30F6:
            out.append(chr(code - 0x60))
        else:
            out.append(ch)
    return "".join(out)


def is_kanji(ch):
    code = ord(ch)
    return 0x4E00 <= code <= 0x9FFF or 0x3400 <= code <= 0x4DBF or ch == "々"


def capitalize(text):
    return text[:1].upper() + text[1:] if text else text


def join_limited(items, max_len, max_items):
    """Join items with ", " while the result stays within max_len (always keeps the first)."""
    out = []
    for item in items:
        candidate = ", ".join(out + [item])
        if out and (len(candidate) > max_len or len(out) >= max_items):
            break
        out.append(item)
    return ", ".join(out)


# ---------- JLPT lists (Waller, via jisho.org) ----------

def fetch_jlpt_lists(src):
    cache = os.path.join(src, "jisho")
    os.makedirs(cache, exist_ok=True)
    lists = {}
    for level in LEVELS:
        kanji = []
        expected = None
        page = 1
        while True:
            path = os.path.join(cache, "n%d_p%d.html" % (level, page))
            if not os.path.exists(path):
                download(JISHO_URL.format(level=level, page=page), path)
                time.sleep(1)
            with open(path, encoding="utf-8") as f:
                text = f.read()
            if expected is None:
                m = re.search(r"result_count\">\s*\W*\s*(\d+) found", text)
                expected = int(m.group(1))
            entries = re.findall(
                r'<span class="character literal japanese_gothic" lang="ja"><a [^>]*>(.)</a></span>', text)
            for ch in entries:
                if ch not in kanji:
                    kanji.append(ch)
            if len(kanji) >= expected or not entries:
                break
            page += 1
        if len(kanji) != expected:
            raise SystemExit("N%d: expected %d kanji, got %d" % (level, expected, len(kanji)))
        print("JLPT N%d: %d kanji" % (level, len(kanji)))
        lists[level] = kanji
    return lists


# ---------- KANJIDIC2 ----------

def load_kanjidic(path):
    data = {}
    with gzip.open(path) as f:
        for _, el in ET.iterparse(f):
            if el.tag != "character":
                continue
            literal = el.findtext("literal")
            freq = el.findtext("misc/freq")
            grade = el.findtext("misc/grade")
            strokes = el.findtext("misc/stroke_count")
            on, kun, meanings = [], [], []
            for r in el.iterfind("reading_meaning/rmgroup/reading"):
                if r.get("r_type") == "ja_on":
                    on.append(r.text)
                elif r.get("r_type") == "ja_kun":
                    kun.append(r.text)
            for m in el.iterfind("reading_meaning/rmgroup/meaning"):
                if m.get("m_lang") in (None, "en"):
                    meanings.append(m.text)
            data[literal] = {
                "freq": int(freq) if freq else 99999,
                "grade": int(grade) if grade else 99,
                "strokes": int(strokes) if strokes else 99,
                "on": on,
                "kun": kun,
                "meanings": meanings,
            }
            el.clear()
    return data


# ---------- JMdict ----------

def pri_score(pris):
    """Lower is more common. None if the form has no priority tags."""
    if not pris:
        return None
    nf = [int(p[2:]) for p in pris if p.startswith("nf")]
    score = min(nf) if nf else 30
    if "ichi1" in pris:
        score -= 5
    if "spec1" in pris:
        score -= 2
    return score


def load_jmdict(path, wanted):
    """Return common JMdict word forms that contain any kanji in `wanted`.

    Each item is a dict:
      keb, reading, gloss, score
      first: the form is the entry's main spelling
      ichi1: the form is in the Ichimango basic vocabulary list
      affix: the main sense is a prefix, suffix or counter (e.g. 前 as ぜん)
      pos: parts of speech of the main sense
    """
    words = []
    with gzip.open(path) as f:
        for _, el in ET.iterparse(f):
            if el.tag != "entry":
                continue
            kebs = []
            for index, k in enumerate(el.iterfind("k_ele")):
                keb = k.findtext("keb")
                infs = [i.text or "" for i in k.iterfind("ke_inf")]
                if any(w in inf for inf in infs for w in BAD_FORM_WORDS):
                    continue
                pris = [p.text for p in k.iterfind("ke_pri")]
                score = pri_score(pris)
                if score is None:
                    continue
                if not any(ch in wanted for ch in keb):
                    continue
                kebs.append((keb, score, index == 0, "ichi1" in pris))
            if not kebs:
                el.clear()
                continue
            rebs = []
            for r in el.iterfind("r_ele"):
                if r.find("re_nokanji") is not None:
                    continue
                infs = [i.text or "" for i in r.iterfind("re_inf")]
                if any(w in inf for inf in infs for w in BAD_FORM_WORDS):
                    continue
                restr = [x.text for x in r.iterfind("re_restr")]
                rebs.append((r.findtext("reb"), restr))
            senses = []
            for s in el.iterfind("sense"):
                stagk = [x.text for x in s.iterfind("stagk")]
                glosses = [g.text for g in s.iterfind("gloss") if g.text]
                pos = [p.text or "" for p in s.iterfind("pos")]
                senses.append((stagk, glosses, pos))
            first_pos = senses[0][2] if senses else []
            affix = bool(first_pos) and all(
                ("suffix" in p or "prefix" in p or "counter" in p) for p in first_pos)
            for keb, score, first, ichi1 in kebs:
                reading = next((reb for reb, restr in rebs if not restr or keb in restr), None)
                if reading is None:
                    continue
                # Short English gloss for the examples list. None if too long to fit.
                gloss = None
                for stagk, glosses, _ in senses:
                    if (not stagk or keb in stagk) and glosses:
                        cleaned = [re.sub(r"\s*\([^)]*\)", "", g).strip() for g in glosses]
                        cleaned = [g for g in cleaned if g]
                        if cleaned and len(cleaned[0]) <= 26:
                            gloss = capitalize(join_limited(cleaned, 26, 2))
                        break
                words.append({
                    "keb": keb, "reading": reading, "gloss": gloss, "score": score,
                    "first": first, "ichi1": ichi1, "affix": affix, "pos": first_pos,
                })
            el.clear()
    return words


# ---------- cards ----------

def is_verb_or_adjective(pos):
    return any(("verb" in p and "adverb" not in p) or "adjective (keiyoushi)" in p for p in pos)


def main_reading(kanji, info, by_kanji):
    """Pick one kana reading to show for the kanji."""
    words = by_kanji.get(kanji, [])
    kun_stems = {r.strip("-").split(".")[0] for r in info["kun"]}
    alone = [w for w in words
             if w["keb"] == kanji and w["first"] and w["ichi1"] and not w["affix"]]
    by_score = lambda w: w["score"]
    # 1. Numbers use the reading of the number word (一 いち, 六 ろく).
    for w in alone:
        if any("numeric" in p for p in w["pos"]):
            return w["reading"]
    # 2. The kanji alone as a basic word read with a kun reading (名 な, 下 した).
    kun_alone = [w for w in alone if w["reading"] in kun_stems]
    if kun_alone:
        return min(kun_alone, key=by_score)["reading"]
    # 3. First kun reading that forms a common verb or adjective (行く いく, 大きい おおきい).
    for kun in info["kun"]:
        if kun.startswith("-") or kun.endswith("-") or "." not in kun:
            continue
        stem, okuri = kun.split(".", 1)
        for w in words:
            if w["keb"] == kanji + okuri and w["reading"] == stem + okuri and is_verb_or_adjective(w["pos"]):
                return w["reading"]
    # 4. The kanji alone as a basic word read with an on reading (本 ほん).
    if alone:
        return min(alone, key=by_score)["reading"]
    # 5. The on reading or plain kun reading found in the most common words (社 しゃ, 磯 いそ).
    on_readings = [kata_to_hira(r.strip("-")) for r in info["on"]]
    plain_kun = [r for r in info["kun"] if "." not in r and "-" not in r]
    candidates = on_readings + plain_kun
    if not candidates:
        return info["kun"][0].strip("-").replace(".", "") if info["kun"] else ""
    compounds = [w for w in words if w["keb"] != kanji]
    if not compounds and plain_kun:
        return plain_kun[0]

    forms = {}
    for r in on_readings:
        # On readings can shorten to っ (学 がく in 学校 がっこう).
        forms[r] = {r, r[:-1] + "っ"} if len(r) > 1 and r[-1] in "つちくき" else {r}
    for r in plain_kun:
        # Kun readings can take a voiced first kana (川 かわ in 小川 おがわ).
        forms.setdefault(r, set()).update({r, VOICED.get(r[0], r[0]) + r[1:]})

    def matches(reading, w):
        keb, text = w["keb"], w["reading"]
        index = keb.index(kanji)
        for f in forms[reading]:
            if index == 0 and text.startswith(f):
                return True
            if index == len(keb) - 1 and text.endswith(f):
                return True
            if 0 < index < len(keb) - 1 and f in text:
                return True
        return False

    # Each word counts once, for the longest reading that fits it.
    counts = dict.fromkeys(candidates, 0)
    for w in compounds:
        fits = [r for r in candidates if matches(r, w)]
        if fits:
            counts[max(fits, key=len)] += 1
    return max(candidates, key=lambda r: counts[r])


def examples(kanji, level, by_kanji, level_of):
    scored = []
    seen = set()
    for w in by_kanji.get(kanji, []):
        keb, reading, gloss, score = w["keb"], w["reading"], w["gloss"], w["score"]
        if keb == kanji or len(keb) > 4 or gloss is None or (keb, reading) in seen:
            continue
        seen.add((keb, reading))
        penalty = 2 * (len(keb) - 2)
        for ch in keb:
            if ch == kanji or not is_kanji(ch):
                continue
            other = level_of.get(ch)
            if other is None:
                penalty += 25
            elif other < level:
                penalty += 6 * (level - other)
        scored.append((score + penalty, keb, reading, gloss))
    scored.sort()
    out = []
    used_glosses = set()
    for _, keb, reading, gloss in scored:
        if gloss.lower() in used_glosses:
            continue
        used_glosses.add(gloss.lower())
        out.append([keb, reading, gloss])
        if len(out) == 3:
            break
    return out


def kun_display(kun):
    if "." in kun:
        stem, okuri = kun.split(".", 1)
        return "%s(%s)" % (stem, okuri)
    return kun


def kun_list(kuns):
    """Kun readings for display, skipping repeats of the same kana (ゆ.き and -ゆき)."""
    seen, out = set(), []
    for kun in kuns:
        key = kun.strip("-").replace(".", "")
        if key in seen:
            continue
        seen.add(key)
        out.append(kun_display(kun))
    return out


def split_groups(cards):
    count = max(1, round(len(cards) / GROUP_SIZE))
    base, extra = divmod(len(cards), count)
    groups, start = [], 0
    for i in range(count):
        size = base + (1 if i < extra else 0)
        groups.append(cards[start:start + size])
        start += size
    return groups


def kana_cards(katakana):
    cards = []
    for hira, romaji in HIRAGANA:
        kata = "".join(chr(ord(c) + 0x60) for c in hira)
        if katakana:
            cards.append({"k": kata, "r": hira, "m": romaji})
        else:
            cards.append({"k": hira, "r": kata, "m": romaji})
    return cards


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    os.makedirs(args.src, exist_ok=True)
    os.makedirs(args.out, exist_ok=True)

    kanjidic_path = os.path.join(args.src, "kanjidic2.xml.gz")
    jmdict_path = os.path.join(args.src, "JMdict_e.gz")
    download(KANJIDIC_URL, kanjidic_path)
    download(JMDICT_URL, jmdict_path)

    lists = fetch_jlpt_lists(args.src)
    level_of = {k: level for level in LEVELS for k in lists[level]}

    print("parsing KANJIDIC2")
    kanjidic = load_kanjidic(kanjidic_path)
    print("parsing JMdict")
    words = load_jmdict(jmdict_path, set(level_of))
    by_kanji = {}
    for w in words:
        for ch in set(w["keb"]):
            if ch in level_of:
                by_kanji.setdefault(ch, []).append(w)

    decks = []
    for deck_id, label, katakana in (("hiragana", "Hiragana", False), ("katakana", "Katakana", True)):
        groups = split_groups(kana_cards(katakana))
        with open(os.path.join(args.out, deck_id + ".json"), "w", encoding="utf-8") as f:
            json.dump({"id": deck_id, "type": "kana", "groups": groups}, f, ensure_ascii=False, separators=(",", ":"))
        decks.append({"id": deck_id, "label": label, "type": "kana", "groups": len(groups)})

    for level in LEVELS:
        chars = sorted(lists[level], key=lambda k: (kanjidic[k]["freq"], kanjidic[k]["grade"], kanjidic[k]["strokes"]))
        cards = []
        for k in chars:
            info = kanjidic[k]
            cards.append({
                "k": k,
                "r": main_reading(k, info, by_kanji),
                "m": capitalize(join_limited(info["meanings"], 18, 2)),
                "e": capitalize(join_limited(info["meanings"], 60, 5)),
                "kun": kun_list(info["kun"]),
                "on": info["on"],
                "x": examples(k, level, by_kanji, level_of),
            })
        groups = split_groups(cards)
        deck_id = "n%d" % level
        with open(os.path.join(args.out, deck_id + ".json"), "w", encoding="utf-8") as f:
            json.dump({"id": deck_id, "type": "kanji", "groups": groups}, f, ensure_ascii=False, separators=(",", ":"))
        decks.append({"id": deck_id, "label": "JLPT N%d" % level, "type": "kanji", "groups": len(groups)})
        print("%s: %d cards in %d groups" % (deck_id, len(cards), len(groups)))

    with open(os.path.join(args.out, "decks.json"), "w", encoding="utf-8") as f:
        json.dump(decks, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
