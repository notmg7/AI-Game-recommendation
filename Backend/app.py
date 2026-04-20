"""
Game Discovery Engine — Flask Backend  V11 "Iron Star Phase 2"
================================================
Changes from V10.1:

  HUB MULTI-QUERY BATCHING (fixes rate-limit "Nothing Found" errors)
    _hub_platforms  — fetches 50 platforms, then ONE batched /games query
                      for all platform IDs at once. Sorted generation desc.
    _hub_companies  — fetches 50 companies, then ONE batched /games query
                      for all company IDs at once. Sorted developed/published desc.
    _hub_genres     — already fast (single call), kept as-is.
    _hub_themes     — already fast (single call), kept as-is.
    _hub_years      — synthetic list, no IGDB call needed. Kept as-is.
    _hub_stores     — static, no change.

  HUB_DISPATCH PRUNED
    Removed: collections, reviews, creators
    Kept:    platforms, genres, developers, publishers, tags/themes, years, stores

  No other routes changed.
"""

import os
import re
import json
import time
import random
import logging
import datetime
import requests
import numpy as np

from flask      import Flask, jsonify, request
from flask_cors import CORS
from dotenv     import load_dotenv
from google import genai

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
    PSYCOPG2_AVAILABLE = True
except ImportError:
    PSYCOPG2_AVAILABLE = False
    logging.warning("psycopg2 not installed — library persistence disabled.")

try:
    from sklearn.svm           import SVC
    from sklearn.preprocessing import StandardScaler
    from sklearn.pipeline      import Pipeline
    SKLEARN_AVAILABLE = True
except ImportError:
    SKLEARN_AVAILABLE = False
    logging.warning("scikit-learn not installed — SVM disabled.")

load_dotenv()
logging.basicConfig(level=logging.INFO)

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": [
    "http://localhost:5173", "http://127.0.0.1:5173",
    "http://localhost:3000", "http://127.0.0.1:3000",
    "null",
]}})

TWITCH_CLIENT_ID = os.getenv("TWITCH_CLIENT_ID")
TWITCH_SECRET    = os.getenv("TWITCH_CLIENT_SECRET")
IGDB_BASE        = "https://api.igdb.com/v4"
DATABASE_URL     = os.getenv("DATABASE_URL")


# ── Glitch Chat: Deterministic Recommendation Engine ──────────────────────────
# Zero LLM calls. Zero storage. Zero rate limits. Pure logic + psycopg2.

# 10 quirky Glitch response templates — {game} is replaced at runtime.
_GLITCH_TEMPLATES = [
    "Boop! My sensors indicate you would love {game}! 📡",
    "ALERT: {game} detected in your optimal fun-zone. Proceed immediately.",
    "Calculating... calculating... ERROR: {game} is too good. Just play it.",
    "DNA MATCH FOUND: {game}. My circuits are literally vibrating rn.",
    "Neural scan complete. {game} has a 99.7% compatibility with your taste.",
    "Transmission from the Grid: {game} is calling your name. Answer it.",
    "BZZZT — my radar locked onto {game}. Trust the machine.",
    "I ran 4,000 simulations. They all said {game}. All of them.",
    "Fun fact: players with your DNA love {game}. Coincidence? Nope.",
    "System override: you WILL play {game}. This is not a suggestion.",
]

_GLITCH_GREETINGS = [
    "Boop! Systems online. How can I help you discover something new today?",
    "Hello human! My circuits are primed for game discovery. What's on your mind?",
    "Greetings! I am Glitch. I am ready to find you a game."
]

# Fallbacks when the library is too small or DB is unavailable
_GLITCH_COLD_START = [
    "Heart 3+ games first so I can read your DNA! I'm blind out here. 👾",
    "My sensors are empty... like my soul. Add games to your library!",
    "No DNA detected. Like 3 games and I'll get to work. Deal?",
]
_GLITCH_NO_MATCH = [
    "My database had a vibe check and failed. Try liking more games!",
    "Zero matches found. Either your taste is elite or the DB is napping.",
    "Scanning... scanning... nothing. Your DNA is statistically chaotic.",
]


def _top_genres(dna_weights: dict, n: int = 3) -> list:
    """Return the top-n genre slugs sorted by descending DNA weight."""
    if not dna_weights:
        return []
    sorted_genres = sorted(dna_weights.items(), key=lambda kv: kv[1], reverse=True)
    return [genre for genre, score in sorted_genres[:n] if score > 0]


def _recommend_from_db(top_genres: list, user_id: str):
    """
    Query user_library for games that:
      - have a genre slug matching one of top_genres
      - have a high rating (>= 4.0 out of 5)
      - are NOT already in the requesting user's library
    Returns a single game name string, or None if nothing found.
    """
    conn = get_db()
    if not conn:
        return None

    try:
        with conn.cursor() as cur:
            # genres column is a JSON array string e.g. '["rpg","action"]'
            # Use ILIKE so matching is case-insensitive and substring-safe.
            genre_conditions = " OR ".join(
                ["ul.genres ILIKE %s"] * len(top_genres)
            )
            like_args = [f"%{g}%" for g in top_genres]

            query = f"""
                SELECT ul.game_name, ul.rating
                FROM user_library ul
                WHERE ({genre_conditions})
                  AND ul.rating >= 4.0
                  AND ul.game_id NOT IN (
                      SELECT game_id FROM user_library WHERE user_id = %s
                  )
                ORDER BY ul.rating DESC, RANDOM()
                LIMIT 10
            """
            cur.execute(query, like_args + [user_id])
            rows = cur.fetchall()

        if not rows:
            return None

        # Pick randomly from top results so replies stay fresh
        pick = random.choice(rows)
        return pick["game_name"]

    except Exception as exc:
        logging.error("glitch_chat DB error: %s", exc)
        return None
    finally:
        conn.close()


@app.route('/api/glitch/chat', methods=['POST'])
def glitch_chat():
    """
    Deterministic Glitch recommendation engine.
    - No LLM, no Ollama, no PyTorch, 0 GB extra storage.
    - Reads dnaWeights to find top genres, queries the DB,
      filters out games already in the user's library,
      and wraps the result in a quirky robot-style template.
    - Always returns HTTP 200 with {"reply": "..."} — never 500 or 429.
    """
    try:
        body        = request.get_json(force=True) or {}
        user_msg = (body.get("message") or "").lower().strip()
        dna_weights = body.get("dnaWeights") or {}
        lib_count   = int(body.get("libCount") or 0)
        # App.jsx sends MOCK_USER_ID; fall back gracefully if omitted
        user_id     = str(body.get("userId") or body.get("user_id") or "anonymous")

        if any(greet in user_msg for greet in ["hi", "hello", "hey", "yo"]):
            return jsonify({"reply": random.choice(_GLITCH_GREETINGS)})
        
        match = re.search(r"(?:similar to|like|recommend me)\s+(.+)", user_msg)
        if match:
            target_game = match.group(1).title()
            # Still get a DNA recommendation to back it up
            top_genres = _top_genres(dna_weights, n=1)
            rec_game = _recommend_from_db(top_genres, user_id)
            
            if rec_game:
                return jsonify({"reply": f"Scanning for games like '{target_game}'... My radar locked onto {rec_game}! It matches your DNA profile perfectly."})

        # ── Cold-start guard ──────────────────────────────────────────────────
        # Need at least 3 library games before DNA is meaningful
        if lib_count < 3 or not dna_weights:
            return jsonify({"reply": random.choice(_GLITCH_COLD_START)})

        # ── Identify top 2-3 genres from DNA weights ──────────────────────────
        top_genres = _top_genres(dna_weights, n=3)
        if not top_genres:
            return jsonify({"reply": random.choice(_GLITCH_COLD_START)})

        # ── Query the DB for a matching, un-owned, high-rated game ────────────
        game_name = _recommend_from_db(top_genres, user_id)

        if not game_name:
            return jsonify({"reply": random.choice(_GLITCH_NO_MATCH)})

        # ── Inject game name into a random personality template ───────────────
        reply = random.choice(_GLITCH_TEMPLATES).format(game=game_name)
        return jsonify({"reply": reply})

    except Exception as exc:
        logging.error("glitch_chat unexpected error: %s", exc)
        # Guaranteed non-500 fallback
        return jsonify({"reply": random.choice(_GLITCH_NO_MATCH)})

# ── Token cache ───────────────────────────────────────────────────────────────
_igdb_token_cache = {"token": None, "expires": 0}

def get_igdb_headers():
    now = time.time()
    if not _igdb_token_cache["token"] or now >= _igdb_token_cache["expires"]:
        r = requests.post(
            "https://id.twitch.tv/oauth2/token",
            params={
                "client_id":     TWITCH_CLIENT_ID,
                "client_secret": TWITCH_SECRET,
                "grant_type":    "client_credentials",
            },
            timeout=10,
        )
        r.raise_for_status()
        d = r.json()
        _igdb_token_cache["token"]   = d["access_token"]
        _igdb_token_cache["expires"] = now + d["expires_in"] - 60
    return {
        "Client-ID":     TWITCH_CLIENT_ID,
        "Authorization": f"Bearer {_igdb_token_cache['token']}",
        "Accept":        "application/json",
    }

def igdb_img(img_id, size="t_720p"):
    if not img_id:
        return None
    return f"https://images.igdb.com/igdb/image/upload/{size}/{img_id}.jpg"

# ── Hub result cache ──────────────────────────────────────────────────────────
_hub_cache: dict = {}
HUB_CACHE_TTL = 600  # 10 minutes

def _hub_cache_get(key):
    entry = _hub_cache.get(key)
    if entry and (time.time() - entry[0]) < HUB_CACHE_TTL:
        return entry[1]
    return None

def _hub_cache_set(key, data):
    if len(_hub_cache) > 128:
        oldest = min(_hub_cache, key=lambda k: _hub_cache[k][0])
        del _hub_cache[oldest]
    _hub_cache[key] = (time.time(), data)

# ── Constants ─────────────────────────────────────────────────────────────────
GENRE_SLUGS = [
    "action","indie","adventure","rpg","strategy","shooter",
    "casual","simulation","puzzle","arcade","platformer","racing",
    "sports","massively-multiplayer","family","fighting","board-games",
    "educational","card",
]

IGDB_GENRE_MAP = {
    4:  "fighting",   5:  "shooter",    8:  "platformer",  9:  "puzzle",
    10: "racing",     11: "strategy",   12: "rpg",         13: "simulation",
    14: "sports",     15: "strategy",   16: "strategy",    31: "adventure",
    32: "indie",      33: "arcade",     35: "card",        36: "massively-multiplayer",
}
SLUG_TO_IGDB_ID = {v: k for k, v in IGDB_GENRE_MAP.items()}

STORE_META = {
    1:  {"name": "Steam",             "color": "#1b2838", "logo": "steam"},
    2:  {"name": "Microsoft Store",   "color": "#0078d4", "logo": "xbox"},
    3:  {"name": "PlayStation Store", "color": "#003087", "logo": "playstation"},
    4:  {"name": "App Store",         "color": "#0a84ff", "logo": "apple"},
    5:  {"name": "GOG",               "color": "#86328a", "logo": "gog"},
    6:  {"name": "Nintendo eShop",    "color": "#e4000f", "logo": "nintendo"},
    7:  {"name": "Xbox 360 Store",    "color": "#107c10", "logo": "xbox"},
    8:  {"name": "Google Play",       "color": "#34a853", "logo": "google"},
    9:  {"name": "itch.io",           "color": "#fa5c5c", "logo": "itch"},
    11: {"name": "Epic Games Store",  "color": "#2a2a2a", "logo": "epic"},
}

HLTB_GENRE_ESTIMATES = {
    "rpg":        {"main_story": 40,  "completionist": 100},
    "action":     {"main_story": 12,  "completionist": 30 },
    "adventure":  {"main_story": 10,  "completionist": 20 },
    "strategy":   {"main_story": 20,  "completionist": 60 },
    "shooter":    {"main_story": 8,   "completionist": 20 },
    "puzzle":     {"main_story": 5,   "completionist": 12 },
    "simulation": {"main_story": 30,  "completionist": 80 },
    "indie":      {"main_story": 6,   "completionist": 15 },
    "racing":     {"main_story": 4,   "completionist": 25 },
    "sports":     {"main_story": 5,   "completionist": 40 },
}
HLTB_DEFAULT = {"main_story": 12, "completionist": 30}

STEAM_FALLBACK_MSG = "Analyzing requirements... Check Steam Store for official data."

IGDB_PAGE_LIMIT  = 100
IGDB_TOTAL_COUNT = 450000

# Unix timestamp for 2027-01-01 00:00:00 UTC
CAP_2026_TS = 1798761600


# ═════════════════════════════════════════════════════════════════════════════
# DATABASE
# ═════════════════════════════════════════════════════════════════════════════

def get_db():
    if not PSYCOPG2_AVAILABLE or not DATABASE_URL:
        return None
    try:
        return psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
    except Exception as exc:
        logging.error("DB connection failed: %s", exc)
        return None


def init_db():
    conn = get_db()
    if conn is None:
        return
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS user_library (
                        id          SERIAL PRIMARY KEY,
                        user_id     TEXT        NOT NULL,
                        game_id     INTEGER     NOT NULL,
                        game_name   TEXT        NOT NULL DEFAULT '',
                        genres      TEXT        NOT NULL DEFAULT '[]',
                        rating      REAL        NOT NULL DEFAULT 0,
                        status      TEXT        CHECK (status IN ('wishlist','played','playing')),
                        is_liked    BOOLEAN     NOT NULL DEFAULT FALSE,
                        is_favorite BOOLEAN     NOT NULL DEFAULT FALSE,
                        playtime    REAL        NOT NULL DEFAULT 0,
                        added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        UNIQUE (user_id, game_id)
                    );
                    CREATE INDEX IF NOT EXISTS idx_ul_user  ON user_library (user_id);
                    CREATE INDEX IF NOT EXISTS idx_ul_liked ON user_library (user_id, is_liked);
                """)
                try:
                    cur.execute("""
                        DO $$
                        BEGIN
                            ALTER TABLE user_library
                                DROP CONSTRAINT IF EXISTS user_library_status_check;
                            ALTER TABLE user_library
                                ADD CONSTRAINT user_library_status_check
                                CHECK (status IN ('wishlist','played','playing'));
                        EXCEPTION WHEN others THEN NULL;
                        END $$;
                    """)
                    cur.execute("""
                        ALTER TABLE user_library
                            ADD COLUMN IF NOT EXISTS playtime REAL NOT NULL DEFAULT 0;
                    """)
                except Exception:
                    pass
        logging.info("DB initialised (V11.0 Iron Star Phase 2).")
    except Exception as exc:
        logging.error("init_db error: %s", exc)
    finally:
        conn.close()


def fetch_user_library(user_id: str) -> list:
    if not user_id:
        return []
    conn = get_db()
    if not conn:
        return []
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM user_library WHERE user_id = %s", (user_id,))
            rows = [dict(r) for r in cur.fetchall()]
        for row in rows:
            if isinstance(row.get("genres"), str):
                try:    row["genres"] = json.loads(row["genres"])
                except: row["genres"] = []
        return rows
    except Exception as exc:
        logging.error("fetch_user_library error: %s", exc)
        return []
    finally:
        conn.close()


init_db()


# ═════════════════════════════════════════════════════════════════════════════
# IGDB HELPERS
# ═════════════════════════════════════════════════════════════════════════════

def norm_game(g: dict) -> dict:
    rel_date = g.get("first_release_date")
    formatted_date = (
        datetime.datetime.fromtimestamp(rel_date).strftime("%Y-%m-%d")
        if rel_date else None
    )
    genre_ids = [genre.get("id") for genre in g.get("genres", [])]
    slugs = [IGDB_GENRE_MAP[gid] for gid in genre_ids if gid in IGDB_GENRE_MAP]
    names = [s.replace("-", " ").title() for s in slugs]
    return {
        "id":               g.get("id"),
        "name":             g.get("name"),
        "background_image": igdb_img(g.get("cover", {}).get("image_id"), "t_720p"),
        "rating":           (g.get("total_rating") or 0) / 20.0,
        "released":         formatted_date,
        "genres":           names,
        "genre_slugs":      slugs,
        "slug":             g.get("slug"),
        "platforms":        [p.get("name") for p in g.get("platforms", [])],
        "developer":        None,
        "tags":             [],
        "hypes":            g.get("hypes", 0),
    }


def _parse_ids(param_str: str) -> list[int]:
    result = []
    for part in (param_str or "").split(","):
        part = part.strip()
        if part.isdigit():
            result.append(int(part))
    return result


def _ids_clause(igdb_field: str, ids: list[int]) -> str | None:
    if not ids:
        return None
    if len(ids) == 1:
        return f"{igdb_field} = ({ids[0]})"
    return f"{igdb_field} = ({', '.join(str(i) for i in ids)})"


# ═════════════════════════════════════════════════════════════════════════════
# MULTI-QUERY BATCH HELPER
# ═════════════════════════════════════════════════════════════════════════════

def _batch_popular_games(igdb_field: str, ids: list[int], limit_per: int = 3) -> dict[int, list]:
    """
    Fetch popular game teasers for a list of item IDs in ONE single IGDB
    request using the multi-query `query` syntax.

    IGDB multi-query packs multiple named sub-queries into one POST body
    separated by blank lines. Each sub-query is:

        query games "label" {
          fields name, cover.image_id, total_rating;
          where <field> = (<id>) & cover != null & total_rating != null;
          sort total_rating desc;
          limit <n>;
        };

    Returns a dict mapping item_id → list of game teasers.
    Falls back to an empty dict on any error (never crashes the hub call).
    """
    if not ids:
        return {}

    # Build a sub-query for each item ID
    sub_queries = []
    for item_id in ids:
        sub_queries.append(
            f'query games "g{item_id}" {{\n'
            f'  fields name, cover.image_id, total_rating;\n'
            f'  where {igdb_field} = ({item_id}) & cover != null & total_rating != null;\n'
            f'  sort total_rating desc;\n'
            f'  limit {limit_per};\n'
            f'}};'
        )

    body = "\n\n".join(sub_queries)

    try:
        resp = requests.post(
            f"{IGDB_BASE}/multiquery",
            headers=get_igdb_headers(),
            data=body,
            timeout=15,
        )
        if not resp.ok:
            logging.warning("multiquery failed: HTTP %s", resp.status_code)
            return {}

        result_map: dict[int, list] = {}
        for block in resp.json():
            # Each block has "name" = "g<id>" and "result" = [...]
            label = block.get("name", "")
            if not label.startswith("g"):
                continue
            try:
                item_id = int(label[1:])
            except ValueError:
                continue
            games_raw = block.get("result", [])
            result_map[item_id] = [
                {
                    "id":     g.get("id"),
                    "name":   g.get("name"),
                    "image":  igdb_img(g.get("cover", {}).get("image_id"), "t_thumb"),
                    "rating": round((g.get("total_rating") or 0) / 20.0, 1),
                }
                for g in games_raw
            ]
        return result_map

    except Exception as exc:
        logging.warning("_batch_popular_games failed (%s): %s", igdb_field, exc)
        return {}


# ═════════════════════════════════════════════════════════════════════════════
# SVM ENGINE
# ═════════════════════════════════════════════════════════════════════════════

def feature_vec(genre_slugs: list, rating: float, gw: dict = None) -> list:
    vec = []
    for slug in GENRE_SLUGS:
        flag  = 1.0 if slug in genre_slugs else 0.0
        scale = (gw or {}).get(slug, 100.0) / 100.0
        vec.append(flag * scale)
    vec.append(min(float(rating), 5.0) / 5.0)
    return vec


def train_svm(lib_rows: list, gw: dict = None):
    if not SKLEARN_AVAILABLE:
        return None
    X, y, w = [], [], []
    for row in lib_rows:
        slugs  = row.get("genres") or []
        rating = float(row.get("rating", 0))
        vec    = feature_vec(slugs, rating, gw)
        if row.get("is_liked"):
            X.append(vec); y.append(1)
            w.append(3.0 if row.get("is_favorite") else 1.0)
        elif row.get("status") in ("wishlist", "played", "playing"):
            wt = 0.9 if row.get("status") == "playing" else 0.5
            X.append(vec); y.append(-1); w.append(wt)
    if len(X) < 2 or len(set(y)) < 2:
        return None
    try:
        pipe = Pipeline([
            ("sc",  StandardScaler()),
            ("svm", SVC(kernel="rbf", C=1.0, gamma="scale", probability=True)),
        ])
        pipe.fit(
            np.array(X, dtype=np.float32),
            np.array(y, dtype=np.int32),
            svm__sample_weight=np.array(w, dtype=np.float32),
        )
        return pipe
    except Exception as exc:
        logging.warning("train_svm failed: %s", exc)
        return None


def svm_rank(games: list, pipe, gw: dict = None) -> list:
    if not pipe or not games:
        return games
    X = [feature_vec(g.get("genre_slugs", []), g.get("rating", 0), gw) for g in games]
    try:
        probs   = pipe.predict_proba(np.array(X, dtype=np.float32))
        pos_idx = list(pipe.classes_).index(1)
        scores  = probs[:, pos_idx]
    except Exception as exc:
        logging.warning("SVM scoring failed: %s", exc)
        return games
    ranked = [{**g, "svm_score": float(s)} for g, s in zip(games, scores) if s >= 0.3]
    ranked.sort(key=lambda x: x["svm_score"], reverse=True)
    return ranked


# ═════════════════════════════════════════════════════════════════════════════
# STEAM SPECS
# ═════════════════════════════════════════════════════════════════════════════

def steam_pc_requirements(game_name: str) -> dict | None:
    if not game_name:
        return None
    try:
        search_resp = requests.get(
            "https://store.steampowered.com/api/storesearch/",
            params={"term": game_name, "l": "en", "cc": "us"},
            headers={"User-Agent": "GameDiscoveryEngine/11.0"},
            timeout=6,
        )
        if not search_resp.ok:
            return None
        items = search_resp.json().get("items", [])
        if not items:
            return None
        app_id = None
        name_lower = game_name.lower()
        for item in items[:5]:
            if item.get("name", "").lower() == name_lower:
                app_id = item.get("id")
                break
        if not app_id:
            app_id = items[0].get("id")
        if not app_id:
            return None
        detail_resp = requests.get(
            "https://store.steampowered.com/api/appdetails",
            params={"appids": app_id, "l": "en", "filters": "pc_requirements"},
            headers={"User-Agent": "GameDiscoveryEngine/11.0"},
            timeout=8,
        )
        if not detail_resp.ok:
            return None
        data = detail_resp.json().get(str(app_id), {})
        if not data.get("success"):
            return None
        reqs    = data.get("data", {}).get("pc_requirements", {})
        minimum = reqs.get("minimum", "")
        recc    = reqs.get("recommended", "")
        if not minimum and not recc:
            return None
        def strip_html(s):
            return re.sub(r"<[^>]+>", "\n", s or "").strip()
        result = {}
        if minimum: result["minimum"]     = strip_html(minimum)
        if recc:    result["recommended"] = strip_html(recc)
        return result if result else None
    except Exception as exc:
        logging.warning("steam_pc_requirements failed: %s", exc)
        return None


# ═════════════════════════════════════════════════════════════════════════════
# HUB DATA FETCHERS  — V11: Multi-Query batching for platforms + companies
# Each returns a list of dicts:
#   {id, name, slug?, description?, logo?, game_count?, popular_games[]}
# ═════════════════════════════════════════════════════════════════════════════

def _hub_platforms() -> list:
    """
    Top platforms with RAWG-style prioritization.
    Ensures PC and modern consoles appear first.
    """
    # 1. Define the 'Power List' (Priority IDs)
    # 6: PC, 167: PS5, 130: Switch, 169: Xbox Series, 48: PS4, 49: Xbox One
    top_priority_ids = [6, 167, 130, 169, 48, 49]
    ids_str = ",".join(map(str, top_priority_ids))

    # 2. Query IGDB
    # We include our priority list OR any platform from Generation 7 and up
    q = (
        f"fields id, name, slug, summary, generation, "
        f"versions.platform_logo.image_id; "
        f"where id = ({ids_str}) | (generation != null & generation > 6); "
        f"limit 80;" 
    )
    
    resp = requests.post(
        f"{IGDB_BASE}/platforms", headers=get_igdb_headers(), data=q, timeout=12
    )
    if not resp.ok:
        return []

    platforms = resp.json()
    if not platforms:
        return []

    # 3. Batch fetch popular games for the UI teasers
    platform_ids = [p["id"] for p in platforms if p.get("id")]
    popular_map = _batch_popular_games("platforms", platform_ids, limit_per=3)

    # 4. Build the items list
    items = []
    for p in platforms:
        pid = p.get("id")
        
        # Logo extraction
        logo_id = None
        for v in (p.get("versions") or []):
            lid = (v.get("platform_logo") or {}).get("image_id")
            if lid:
                logo_id = lid
                break
        
        items.append({
            "id":            pid,
            "name":          p.get("name"),
            "slug":          p.get("slug"),
            "generation":    p.get("generation", 0),
            "description":   p.get("summary", ""),
            "logo":          igdb_img(logo_id, "t_logo_med") if logo_id else None,
            "popular_games": popular_map.get(pid, []),
        })

    # 5. Intelligent Sorting
    # Sort Key Priority: 
    #   A) Is it in our top_priority_ids list? (Index 0 to 5)
    #   B) Modernity (Generation desc)
    #   C) Alphabetical
    def sort_logic(x):
        try:
            # If in top list, get its position (0, 1, 2...)
            priority_idx = top_priority_ids.index(x['id'])
        except ValueError:
            # If not in top list, put it after (999)
            priority_idx = 999
        
        return (priority_idx, -(x['generation'] or 0), x['name'])

    return sorted(items, key=sort_logic)


def _hub_genres() -> list:
    """
    Merges IGDB Genres and Themes into one 'Vibe' filter.
    Prioritizes popular categories like Action, RPG, and Horror.
    """
    # 1. Define Priority Lists (The ones users want most)
    # Genres: 31=Adventure, 12=RPG, 5=Shooter, 11=Strategy, 32=Indie, 4=Fighting, 25=Hack and slash
    # Themes: 19=Horror, 21=Survival, 38=Open World, 18=Sci-Fi, 1=Action
    priority_genres = [31, 12, 5, 11, 32, 25]
    priority_themes = [19, 21, 38, 18, 1]

    # 2. Fetch both from IGDB
    headers = get_igdb_headers()
    g_resp = requests.post(f"{IGDB_BASE}/genres", headers=headers, data="fields id, name, slug; limit 50;", timeout=10)
    t_resp = requests.post(f"{IGDB_BASE}/themes", headers=headers, data="fields id, name, slug; limit 50;", timeout=10)
    
    genres_raw = g_resp.json() if g_resp.ok else []
    themes_raw = t_resp.json() if t_resp.ok else []

    # 3. Batch Popular Game Teasers
    g_ids = [x['id'] for x in genres_raw]
    t_ids = [x['id'] for x in themes_raw]
    g_popular = _batch_popular_games("genres", g_ids, limit_per=3)
    t_popular = _batch_popular_games("themes", t_ids, limit_per=3)

    combined = []
    
    # Process Genres
    for g in genres_raw:
        combined.append({
            "id": g['id'], "name": g['name'], "slug": g['slug'], "type": "genre",
            "popular_games": g_popular.get(g['id'], [])
        })
    
    # Process Themes
    for t in themes_raw:
        # Avoid duplicate names (e.g. if 'Action' exists in both)
        if any(i['name'].lower() == t['name'].lower() for i in combined): continue
        combined.append({
            "id": t['id'], "name": t['name'], "slug": t['slug'], "type": "theme",
            "popular_games": t_popular.get(t['id'], [])
        })

    # 4. Smart Priority Sorting
    def sort_vibe(x):
        # Top Priority (Specific Big Genres/Themes)
        if x['type'] == 'genre' and x['id'] in priority_genres:
            return (0, priority_genres.index(x['id']))
        if x['type'] == 'theme' and x['id'] in priority_themes:
            return (0, priority_themes.index(x['id']) + 10) # Offset themes slightly
        # Regular Priority (Alphabetical)
        return (1, x['name'])

    return sorted(combined, key=sort_vibe)


def _hub_companies(is_developer: bool) -> list:
    role_field = "developed" if is_developer else "published"
    igdb_field = "involved_companies.company"

    # Priority IDs (Ensuring we get the 'Parent' entities)
    top_company_ids = [104, 37, 26, 70, 1, 14, 10110, 421, 126, 250, 112]
    ids_str = ",".join(map(str, top_company_ids))

    # We remove the 'role_field != null' requirement for priority IDs
    # This ensures Square Enix (ID 26) shows up even in the Dev list
    q = (
        f"fields id, name, slug, description, logo.image_id, {role_field}; "
        f"where (id = ({ids_str})) | (logo != null & {role_field} != null); "
        f"sort {role_field} desc; limit 100;" 
    )
    
    resp = requests.post(f"{IGDB_BASE}/companies", headers=get_igdb_headers(), data=q, timeout=12)
    if not resp.ok: return []
    companies = resp.json()

    company_ids = [c["id"] for c in companies if c.get("id")]
    popular_map = _batch_popular_games(igdb_field, company_ids, limit_per=3)

    items = []
    for c in companies:
        cid = c.get("id")
        role_data = c.get(role_field, [])
        # Fallback to 0 if the field is missing or not a list
        count = len(role_data) if isinstance(role_data, list) else 0
        
        items.append({
            "id":            cid,
            "name":          c.get("name"),
            "slug":          c.get("slug"),
            "description":   (c.get("description") or "")[:150],
            "logo":          igdb_img((c.get("logo") or {}).get("image_id"), "t_logo_med"),
            "game_count":    count,
            "popular_games": popular_map.get(cid, []),
        })

    def sort_studios(x):
        try: priority_idx = top_company_ids.index(x['id'])
        except ValueError: priority_idx = 999
        return (priority_idx, -x['game_count'], x['name'])

    return sorted(items, key=sort_studios)


def _hub_themes() -> list:
    """IGDB themes (Horror, Sci-fi, etc.). Popular games via multi-query batch."""
    q = "fields id, name, slug; limit 50;"
    resp = requests.post(
        f"{IGDB_BASE}/themes", headers=get_igdb_headers(), data=q, timeout=10
    )
    if not resp.ok:
        return []

    themes = resp.json()
    theme_ids = [t["id"] for t in themes if t.get("id")]
    popular_map = _batch_popular_games("themes", theme_ids, limit_per=3)

    items = []
    for t in themes:
        tid = t.get("id")
        items.append({
            "id":            tid,
            "name":          t.get("name"),
            "slug":          t.get("slug"),
            "description":   "",
            "logo":          None,
            "popular_games": popular_map.get(tid, []),
        })
    return sorted(items, key=lambda x: x["name"])


def _hub_years() -> list:
    """Synthetic year buckets 1980 → current+1. No IGDB call needed."""
    current_year = datetime.datetime.now().year
    years = list(range(current_year + 1, 1979, -1))
    return [
        {
            "id":            year,
            "name":          str(year),
            "slug":          str(year),
            "description":   f"Games released in {year}",
            "logo":          None,
            "popular_games": [],
        }
        for year in years[:46]
    ]


def _hub_stores() -> list:
    """Static list from STORE_META — no IGDB call needed."""
    return [
        {
            "id":            sid,
            "name":          meta["name"],
            "slug":          meta["name"].lower().replace(" ", "-"),
            "description":   "",
            "logo":          None,
            "popular_games": [],
            "color":         meta["color"],
        }
        for sid, meta in STORE_META.items()
    ]


# ── HUB TYPE DISPATCH — V11: Collections, Reviews, Creators removed ───────────
HUB_DISPATCH = {
    "platforms":  (lambda: _hub_platforms()),
    "genres":     (lambda: _hub_genres()),
    "developers": (lambda: _hub_companies(is_developer=True)),
    "publishers": (lambda: _hub_companies(is_developer=False)),
    "tags":       (lambda: _hub_themes()),
    "themes":     (lambda: _hub_themes()),
    "years":      (lambda: _hub_years()),
    "stores":     (lambda: _hub_stores()),
}


# ═════════════════════════════════════════════════════════════════════════════
# API ROUTES
# ═════════════════════════════════════════════════════════════════════════════

@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({
        "status":    "ok",
        "igdb_auth": bool(TWITCH_CLIENT_ID and TWITCH_SECRET),
        "db":        PSYCOPG2_AVAILABLE and bool(DATABASE_URL),
        "svm":       SKLEARN_AVAILABLE,
        "version":   "v11.0-iron-star-phase2",
    })


# ── GET /api/hub/<type> ────────────────────────────────────────────────────────
@app.route("/api/hub/<string:hub_type>", methods=["GET"])
def get_hub(hub_type: str):
    """
    Generic Selection Hub endpoint.
    Returns top 50 items for the given category type.
    Results cached in-process for 10 minutes.
    Supported types (V11): platforms, genres, developers, publishers,
                           tags, themes, years, stores.
    """
    hub_type = hub_type.lower().strip()
    if hub_type not in HUB_DISPATCH:
        return jsonify({"error": f"Unknown hub type: {hub_type}"}), 404

    cached = _hub_cache_get(hub_type)
    if cached is not None:
        return jsonify({"type": hub_type, "results": cached, "cached": True})

    try:
        results = HUB_DISPATCH[hub_type]()
        _hub_cache_set(hub_type, results)
        return jsonify({"type": hub_type, "results": results, "cached": False})
    except Exception as exc:
        logging.error("hub/%s error: %s", hub_type, exc)
        return jsonify({"error": str(exc)}), 503


# ── GET /api/games ─────────────────────────────────────────────────────────────
@app.route("/api/games", methods=["GET"])
# ── GET /api/games ─────────────────────────────────────────────────────────────
@app.route("/api/games", methods=["GET"])
def get_games():
    # 1. Capture all parameters
    exclude_ids    = _parse_ids(request.args.get("exclude_ids", ""))
    search         = request.args.get("search", "")
    page           = max(1, request.args.get("page", 1, type=int))
    req_page_size  = request.args.get("page_size", IGDB_PAGE_LIMIT, type=int)
    limit          = min(req_page_size, IGDB_PAGE_LIMIT)
    offset         = (page - 1) * limit
    user_id        = request.args.get("user_id", "")
    discovery_mode = request.args.get("discovery_mode", "false").lower() == "true"
    ordering       = request.args.get("ordering", "")
    dates          = request.args.get("dates", "")
    is_awaited_req = request.args.get("awaited", "false").lower() == "true"

    # Multi-filter params
    platform_ids   = _parse_ids(request.args.get("platform_ids", ""))
    genre_ids      = _parse_ids(request.args.get("genre_ids", ""))
    company_ids    = _parse_ids(request.args.get("company_ids", ""))
    theme_ids      = _parse_ids(request.args.get("theme_ids", ""))
    collection_ids = _parse_ids(request.args.get("collection_ids", ""))
    year_filter    = request.args.get("year", "", type=str).strip()
    rating_min     = request.args.get("rating_min", 0, type=float)
    genre_slug     = request.args.get("genre", "")

    # 2. Initialize Core Variables
    now_ts = int(time.time())
    where_parts = []
    sort_clause = ""
    current_limit = limit
    is_upcoming = False
    is_hype_query = False

    # 3. Mode Detection (Hype/Upcoming)
    if dates:
        _d = dates.split(",")
        if len(_d) == 2:
            try:
                _start_ts = int(datetime.datetime.strptime(_d[0].strip(), "%Y-%m-%d").timestamp())
                if _start_ts > now_ts: is_upcoming = True
                if _d[1].strip().startswith(("2026", "2027")): is_hype_query = True
            except ValueError: pass
    
    if any(y in ("2026", "2027") for y in (year_filter or "").split(",")):
        is_hype_query = True

    # 4. Integrated Date Filtering (The "Where" Clause)
    if is_awaited_req:
        # Dynamic Most Awaited: No hardcoded dates, strictly future + hyped
        where_parts.append(f"first_release_date > {now_ts}")
        where_parts.append("hypes > 0")
        sort_clause = "sort hypes desc;"
        current_limit = max(20, limit)
        
    elif year_filter:
        years = [y.strip() for y in year_filter.split(",") if y.strip().isdigit()]
        if years:
            year_clauses = []
            for y in years:
                y_int = int(y)
                ts_start = int(datetime.datetime(y_int, 1, 1).timestamp())
                ts_end   = int(datetime.datetime(y_int, 12, 31, 23, 59, 59).timestamp())
                year_clauses.append(f"(first_release_date >= {ts_start} & first_release_date <= {ts_end})")
            where_parts.append(f"({' | '.join(year_clauses)})")
            
    elif dates:
        parts = dates.split(",")
        if len(parts) == 2:
            try:
                ts_from = int(datetime.datetime.strptime(parts[0].strip(), "%Y-%m-%d").timestamp())
                ts_to   = int(datetime.datetime.strptime(parts[1].strip(), "%Y-%m-%d").timestamp())
                where_parts.append(f"first_release_date >= {ts_from} & first_release_date <= {ts_to}")
            except ValueError: pass
    else:
        # Browse Feed default: Only released games
        where_parts.append(f"first_release_date < {now_ts}")
        where_parts.append(f"first_release_date < {CAP_2026_TS}")
        where_parts.append("first_release_date != null")

    # 5. Global Exclusion & Quality Filters
    if exclude_ids:
        where_parts.append(f"id != ({','.join(map(str, exclude_ids))})")

    if not search and not is_upcoming and not is_awaited_req:
        where_parts.append("total_rating != null & total_rating > 0")

    # 6. Multi-filter Logic
    for clause in [
        _ids_clause("platforms", platform_ids),
        _ids_clause("genres", genre_ids) if genre_ids else (
            f"genres = [{SLUG_TO_IGDB_ID[genre_slug]}]" if genre_slug and genre_slug in SLUG_TO_IGDB_ID else None
        ),
        _ids_clause("involved_companies.company", company_ids),
        _ids_clause("themes", theme_ids),
        _ids_clause("collection", collection_ids),
    ]:
        if clause: where_parts.append(clause)

    if rating_min > 0:
        where_parts.append(f"total_rating >= {rating_min}")

    where_parts.append("cover != null")
    where_clause = f"where {' & '.join(where_parts)};" if where_parts else ""

    # 7. Final Sort Determination
    # If a specific sort wasn't set by "Awaited" logic, determine it here
    if not sort_clause:
        if search:
            sort_clause = ""
        elif discovery_mode:
            sort_clause = "sort total_rating desc;"
        elif is_upcoming:
            sort_clause = "sort first_release_date asc;"
        elif is_hype_query or "hypes" in ordering:
            sort_clause = "sort hypes desc;"
        elif "follows" in ordering:
            sort_clause = "sort follows desc;"
        elif "metacritic" in ordering or "rating" in ordering:
            sort_clause = "sort total_rating desc;"
        else:
            sort_clause = "sort first_release_date desc;"

    # 8. IGDB Request Execution
    fields = "fields name, cover.image_id, total_rating, hypes, follows, first_release_date, genres.id, slug, platforms.name;"
    pagination_clause = f"limit {current_limit}; offset {offset};"
    
    if search:
        query_body = f"{fields} search \"{search}\"; {where_clause} {pagination_clause}"
    else:
        query_body = f"{fields} {where_clause} {sort_clause} {pagination_clause}"

    try:
        resp = requests.post(f"{IGDB_BASE}/games", headers=get_igdb_headers(), data=query_body, timeout=12)
        resp.raise_for_status()
        raw_data = resp.json()
    except Exception as exc:
        logging.error("IGDB /games error: %s", exc)
        return jsonify({"error": str(exc)}), 503

    games = [norm_game(g) for g in raw_data]
    svm_mode = "raw"

    # 9. SVM Discovery Ranking
    if discovery_mode and user_id and SKLEARN_AVAILABLE and not search:
        gw = {}
        for slug in GENRE_SLUGS:
            val = request.args.get(f"gw_{slug}", type=float)
            if val is not None: gw[slug] = max(0.0, min(100.0, val))
        
        lib = fetch_user_library(user_id)
        if any(r.get("is_liked") for r in lib):
            pipe = train_svm(lib, gw or None)
            if pipe:
                ranked = svm_rank(games, pipe, gw or None)
                games = ranked if ranked else sorted(games, key=lambda x: x["rating"], reverse=True)
                svm_mode = "svm" if ranked else "cold_start"
            else:
                games = sorted(games, key=lambda x: x["rating"], reverse=True)
                svm_mode = "cold_start"
        else:
            svm_mode = "cold_start"

    return jsonify({
        "results":  games,
        "count":    IGDB_TOTAL_COUNT,
        "next":     f"/api/games?page={page + 1}" if len(raw_data) >= current_limit else None,
        "previous": f"/api/games?page={page - 1}" if page > 1 else None,
        "svm_mode": svm_mode,
    })


# ── GET /api/games/<id> ────────────────────────────────────────────────────────
@app.route("/api/games/<int:game_id>", methods=["GET"])
def get_game(game_id: int):
    # Expanded IGDB fields: age_ratings, videos, full company roles, Steam website
    query = (
        f"fields name, summary, cover.image_id, total_rating, first_release_date, "
        f"genres.id, slug, platforms.name, screenshots.image_id, "
        f"websites.url, websites.category, "
        f"involved_companies.company.name, involved_companies.developer, involved_companies.publisher, "
        f"age_ratings.category, age_ratings.rating, "
        f"videos.video_id, videos.name; "
        f"where id = {game_id};"
    )
    try:
        resp = requests.post(
            f"{IGDB_BASE}/games", headers=get_igdb_headers(), data=query, timeout=10
        )
        resp.raise_for_status()
        data = resp.json()
        if not data:
            return jsonify({"error": "Game not found"}), 404
        d = data[0]
    except Exception as exc:
        return jsonify({"error": str(exc)}), 503

    # Developers and Publishers (separate lists from involved_companies)
    developers = []
    publishers = []
    for ic in d.get("involved_companies", []):
        cname = ic.get("company", {}).get("name")
        if not cname:
            continue
        if ic.get("developer"):
            developers.append(cname)
        if ic.get("publisher"):
            publishers.append(cname)

    # ESRB rating — category=1 is ESRB in IGDB
    ESRB_MAP = {1: "RP", 2: "EC", 3: "E", 4: "E10+", 5: "T", 6: "M", 7: "AO"}
    esrb_rating = "Not Rated"
    for ar in d.get("age_ratings", []):
        if ar.get("category") == 1:
            esrb_rating = ESRB_MAP.get(ar.get("rating"), "Not Rated")
            break

    # First YouTube trailer from IGDB videos
    trailer_url = None
    for v in d.get("videos", []):
        vid = v.get("video_id")
        if vid:
            trailer_url = f"https://www.youtube.com/watch?v={vid}"
            break

    # Steam store URL (website category 13 = Steam)
    steam_url = None
    for w in d.get("websites", []):
        if w.get("category") == 13:
            steam_url = w.get("url")
            break

    # Genres
    genre_ids = [g.get("id") for g in d.get("genres", [])]
    slugs     = [IGDB_GENRE_MAP[gid] for gid in genre_ids if gid in IGDB_GENRE_MAP]
    names     = [s.replace("-", " ").title() for s in slugs]

    # HLTB — genre-based estimate, instant, zero network cost
    hltb = HLTB_DEFAULT.copy()
    for s in slugs:
        if s in HLTB_GENRE_ESTIMATES:
            hltb = HLTB_GENRE_ESTIMATES[s].copy()
            break

    # Steam PC requirements (falls back to None on any failure, overlay shows N/A)
    pc_reqs = steam_pc_requirements(d.get("name", ""))

    rel = d.get("first_release_date")
    released = datetime.datetime.fromtimestamp(rel).strftime("%Y-%m-%d") if rel else None

    return jsonify({
        "id":                          d.get("id"),
        "name":                        d.get("name"),
        "background_image":            igdb_img(d.get("cover", {}).get("image_id"), "t_720p"),
        "background_image_additional": (
            igdb_img(d.get("screenshots", [{}])[0].get("image_id"), "t_720p")
            if d.get("screenshots") else None
        ),
        "description_raw":  d.get("summary"),
        "rating":           (d.get("total_rating") or 0) / 20.0,
        "rating_top":       5,
        "released":         released,
        "playtime":         None,
        "website":          d.get("websites", [{}])[0].get("url") if d.get("websites") else None,
        "steam_url":        steam_url,
        "trailer_url":      trailer_url,
        "clip":             {"clip": trailer_url} if trailer_url else None,
        "genres":           names,
        "genre_slugs":      slugs,
        "platforms":        [p.get("name") for p in d.get("platforms", [])],
        "developers":       developers,
        "publishers":       publishers,
        "tags":             [],
        "esrb_rating":      esrb_rating,
        "pc_requirements":  pc_reqs,
        "mac_requirements": None,
        "hltb": {
            "main_story":    hltb.get("main_story"),
            "completionist": hltb.get("completionist"),
            "source":        "genre-estimate",
        },
    })


# ── POST /api/games/<id>/dna-match ────────────────────────────────────────────
@app.route("/api/games/<int:game_id>/dna-match", methods=["POST"])
def dna_match(game_id: int):
    """
    Pure-math DNA compatibility score. No LLM, no external API.
    Receives { dnaWeights: {slug: 0-100}, genreSlugs: [str] }.
    Returns { match: int, label: str }.

    Algorithm: average the user's DNA weight for each genre the game
    has → clamp to [0,100]. Default 50 when no overlap found.
    """
    body        = request.get_json(force=True) or {}
    dna_weights = body.get("dnaWeights") or {}
    genre_slugs = body.get("genreSlugs") or []

    if not dna_weights or not genre_slugs:
        return jsonify({"match": 50, "label": "Uncharted"})

    scores = [dna_weights[g] for g in genre_slugs if g in dna_weights]
    if not scores:
        return jsonify({"match": 50, "label": "Uncharted"})

    pct = round(sum(scores) / len(scores))
    pct = max(0, min(100, pct))

    if   pct >= 90: label = "Perfect Match"
    elif pct >= 75: label = "Strong Match"
    elif pct >= 55: label = "Good Match"
    elif pct >= 35: label = "Partial Match"
    else:           label = "Outside DNA"

    return jsonify({"match": pct, "label": label})


# ── GET /api/games/<id>/screenshots ───────────────────────────────────────────
@app.route("/api/games/<int:game_id>/screenshots", methods=["GET"])
def get_screenshots(game_id: int):
    query = f"fields image_id; where game = {game_id}; limit 8;"
    try:
        resp = requests.post(
            f"{IGDB_BASE}/screenshots", headers=get_igdb_headers(), data=query, timeout=10
        )
        resp.raise_for_status()
        return jsonify({
            "results": [
                {"id": s.get("id"), "image": igdb_img(s.get("image_id"), "t_720p")}
                for s in resp.json()
            ]
        })
    except Exception:
        return jsonify({"results": []})


# ── GET /api/games/<id>/stores ─────────────────────────────────────────────────
@app.route("/api/games/<int:game_id>/stores", methods=["GET"])
def get_stores(game_id: int):
    query = f"fields category, url; where game = {game_id} & category = (1, 5, 13, 16, 17);"
    try:
        resp = requests.post(
            f"{IGDB_BASE}/websites", headers=get_igdb_headers(), data=query, timeout=10
        )
        resp.raise_for_status()
        cat_map = {13: 1, 16: 11, 17: 5}
        stores  = []
        for s in resp.json():
            sid = cat_map.get(s.get("category"))
            if sid:
                meta = STORE_META.get(sid, {"name": "Store", "color": "#444"})
                stores.append({
                    "store_id": sid, "name": meta["name"],
                    "color": meta["color"], "url": s.get("url"),
                })
        return jsonify({"results": stores})
    except Exception:
        return jsonify({"results": []})


# ── GET /api/hltb/<id> ─────────────────────────────────────────────────────────
@app.route("/api/hltb/<int:game_id>", methods=["GET"])
def get_hltb(game_id: int):
    query = f"fields genres.id; where id = {game_id};"
    try:
        resp = requests.post(
            f"{IGDB_BASE}/games", headers=get_igdb_headers(), data=query, timeout=8
        )
        if not resp.ok or not resp.json():
            return jsonify(HLTB_DEFAULT)
        genre_ids = [g.get("id") for g in resp.json()[0].get("genres", [])]
        slugs     = [IGDB_GENRE_MAP[gid] for gid in genre_ids if gid in IGDB_GENRE_MAP]
        est       = HLTB_DEFAULT.copy()
        for s in slugs:
            if s in HLTB_GENRE_ESTIMATES:
                est = HLTB_GENRE_ESTIMATES[s].copy()
                break
        return jsonify({"game_id": game_id, **est, "source": "igdb+estimate"})
    except Exception:
        return jsonify(HLTB_DEFAULT)


# ── GET /api/library/<user_id> ─────────────────────────────────────────────────
@app.route("/api/library/<user_id>", methods=["GET"])
def get_library(user_id: str):
    conn = get_db()
    if not conn:
        return jsonify({"error": "DB unavailable"}), 503
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT * FROM user_library WHERE user_id=%s ORDER BY added_at DESC",
                (user_id,)
            )
            return jsonify([dict(r) for r in cur.fetchall()])
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500
    finally:
        conn.close()


# ── POST /api/library/<user_id> ────────────────────────────────────────────────
@app.route("/api/library/<user_id>", methods=["POST"])
def upsert_library(user_id: str):
    body = request.get_json(force=True)
    if not body or "game_id" not in body:
        return jsonify({"error": "game_id required"}), 400
    status   = body.get("status")
    playtime = float(body.get("playtime", 0))
    if status not in ("wishlist", "played", "playing", None):
        return jsonify({"error": f"Invalid status: {status}"}), 400
    conn = get_db()
    if not conn:
        return jsonify({"ok": True, "persisted": False})
    try:
        genres_raw = body.get("genres", [])
        with conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO user_library
                        (user_id,game_id,game_name,genres,rating,status,is_liked,is_favorite,playtime)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (user_id,game_id) DO UPDATE SET
                        game_name   = EXCLUDED.game_name,
                        genres      = EXCLUDED.genres,
                        rating      = EXCLUDED.rating,
                        status      = EXCLUDED.status,
                        is_liked    = EXCLUDED.is_liked,
                        is_favorite = EXCLUDED.is_favorite,
                        playtime    = EXCLUDED.playtime
                """, (
                    user_id, int(body["game_id"]), str(body.get("game_name", "")),
                    json.dumps(genres_raw if isinstance(genres_raw, list) else []),
                    float(body.get("rating", 0)), status,
                    bool(body.get("is_liked", False)), bool(body.get("is_favorite", False)),
                    playtime,
                ))
        return jsonify({"ok": True, "persisted": True})
    except Exception as exc:
        logging.error("upsert_library error: %s", exc)
        return jsonify({"error": str(exc)}), 500
    finally:
        conn.close()


# ── POST /api/recommend ────────────────────────────────────────────────────────
@app.route("/api/recommend", methods=["POST"])
def recommend():
    if not SKLEARN_AVAILABLE:
        return jsonify({"error": "scikit-learn not installed"}), 501
    body  = request.get_json(force=True) or {}
    games = body.get("games", [])
    lib   = body.get("library", [])
    gw    = body.get("genre_weights", {})
    for row in lib:
        if isinstance(row.get("genres"), str):
            try:    row["genres"] = json.loads(row["genres"])
            except: row["genres"] = []
    liked = [r for r in lib if r.get("is_liked")]
    if not liked:
        return jsonify({
            "mode":  "cold_start",
            "games": sorted(games, key=lambda g: g.get("rating", 0), reverse=True),
        })
    pipe = train_svm(lib, gw or None)
    if not pipe:
        return jsonify({
            "mode":  "cold_start",
            "games": sorted(games, key=lambda g: g.get("rating", 0), reverse=True),
        })
    ranked = svm_rank(games, pipe, gw or None)
    return jsonify({
        "mode":  "svm" if ranked else "cold_start",
        "games": ranked if ranked else sorted(games, key=lambda g: g.get("rating", 0), reverse=True),
    })


if __name__ == "__main__":
    app.run(debug=True, port=5000)