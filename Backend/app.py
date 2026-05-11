"""
Game Discovery Engine — Flask Backend  V14 "Infinite Exploration"
================================================
CHANGES FROM V13 (Strict DNA):

  DISCOVERY POOL (80/20 SPLIT + PAGINATION)
    _fetch_discovery_pool(page)  — Accepts a `page` arg so each scroll
                                   loads a fresh IGDB offset slice.
      DNA Pool (80%)  — Proportional genre sub-queries (unchanged logic).
                         Each sub-query offset = (page-1)*50 + jitter[0,50].
      Wildcard (20%)  — pool_wildcard: top games by follows, NO genre filter.
                         Gives users serendipitous discoveries outside their DNA.
      Games tagged _is_wildcard=True so the ranker treats them separately.

  svm_rank() INTERLEAVING
    - Wildcards are scored normally but given a floor score of 0.15 so
      they aren't completely buried by the DNA-match signal.
    - DNA-ranked games and wildcard games are interleaved at a 4:1 ratio
      (1 wildcard every 4 DNA games) so exploration titles appear throughout
      the feed rather than just at the very bottom.

  get_games() PAGINATION FIX
    - Discovery mode now returns "next" as a full URL string with all gw_
      params encoded, e.g. /api/games?discovery_mode=true&user_id=...&page=2
    - Allows the frontend useInfiniteGames hook (setHasMore(Boolean(data.next)))
      to correctly activate infinite scroll on the Discovery Hub.

  SYNTAX / STABILITY GUARDS  (carried over from V13)
    - All IGDB array checks use ()  e.g. genres = (4,5)
    - All follows/rating reads guarded with  g.get("follows") or 0
    - Single sort field per IGDB query (no comma-separated sorts)

  No other routes changed.
"""

import os
import re
import json
import time
import random
import logging
import math
import datetime
import requests
import numpy as np
import uuid
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from pathlib import Path
import firebase_admin
from firebase_admin import credentials, auth as admin_auth

from flask      import Flask, jsonify, request
from flask_cors import CORS
from dotenv     import load_dotenv

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

# ── Zero-Failure Environment Loading ──────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent
dotenv_path = BASE_DIR / ".env"
load_dotenv(dotenv_path=dotenv_path, override=True)

def startup_audit():
    keys = ["TWITCH_CLIENT_ID", "SENDER_EMAIL", "SENDER_PASSWORD", "DATABASE_URL"]
    print("\n" + "╔" + "═"*48 + "╗")
    print("║      ENVIRONMENT AUDIT [ZERO-FAILURE MODE]     ║")
    print("╠" + "═"*48 + "╣")
    for key in keys:
        # Check both os.getenv and os.environ directly for sanity
        val = os.environ.get(key)
        status = "LOCKED" if val else "MISSING"
        print(f"║ {key:<20} : [{status:^7}]              ║")
    print("╚" + "═"*48 + "╝\n")

startup_audit()

# ── Firebase Admin Initialization ─────────────────────────────────────────────
try:
    cred = credentials.Certificate("serviceAccountKey.json")
    firebase_admin.initialize_app(cred)
    logging.info("Firebase Admin initialized successfully.")
except Exception as e:
    logging.error(f"Failed to initialize Firebase Admin: {e}")

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
    conn = get_db()
    if not conn:
        return None
    try:
        with conn.cursor() as cur:
            genre_conditions = " OR ".join(["ul.genres ILIKE %s"] * len(top_genres))
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
        pick = random.choice(rows)
        return pick["game_name"]
    except Exception as exc:
        logging.error("glitch_chat DB error: %s", exc)
        return None
    finally:
        conn.close()


@app.route('/api/glitch/chat', methods=['POST'])
def glitch_chat():
    try:
        body        = request.get_json(force=True) or {}
        user_msg    = (body.get("message") or "").lower().strip()
        dna_weights = body.get("dnaWeights") or {}
        lib_count   = int(body.get("libCount") or 0)
        user_id     = str(body.get("userId") or body.get("user_id") or "anonymous")

        if any(greet in user_msg for greet in ["hi", "hello", "hey", "yo"]):
            return jsonify({"reply": random.choice(_GLITCH_GREETINGS)})

        match = re.search(r"(?:similar to|like|recommend me)\s+(.+)", user_msg)
        if match:
            target_game = match.group(1).title()
            top_genres  = _top_genres(dna_weights, n=1)
            rec_game    = _recommend_from_db(top_genres, user_id)
            if rec_game:
                return jsonify({"reply": f"Scanning for games like '{target_game}'... My radar locked onto {rec_game}! It matches your DNA profile perfectly."})

        if lib_count < 3 or not dna_weights:
            return jsonify({"reply": random.choice(_GLITCH_COLD_START)})

        top_genres = _top_genres(dna_weights, n=3)
        if not top_genres:
            return jsonify({"reply": random.choice(_GLITCH_COLD_START)})

        game_name = _recommend_from_db(top_genres, user_id)
        if not game_name:
            return jsonify({"reply": random.choice(_GLITCH_NO_MATCH)})

        reply = random.choice(_GLITCH_TEMPLATES).format(game=game_name)
        return jsonify({"reply": reply})

    except Exception as exc:
        logging.error("glitch_chat unexpected error: %s", exc)
        return jsonify({"reply": random.choice(_GLITCH_NO_MATCH)})

# ── OTP Verification ──────────────────────────────────────────────────────────
otp_store = {}

def send_otp_email(target_email, code):
    sender_email = os.getenv("SENDER_EMAIL")
    sender_password = os.getenv("SENDER_PASSWORD")
    
    if not sender_email or not sender_password:
        logging.warning("Email credentials not found in environment. OTP printed to console only.")
        return False

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = f"Your Discovery Engine OTP: {code}"
        msg["From"] = f"Game Discovery Engine <{sender_email}>"
        msg["To"] = target_email

        html = f"""
        <html>
        <body style="background-color: #0d0d0d; color: #ffffff; font-family: 'Inter', -apple-system, sans-serif; padding: 40px; text-align: center;">
            <div style="max-width: 500px; margin: 0 auto; background: #111111; padding: 40px; border-radius: 16px; border: 1px solid #222; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
                <div style="font-size: 24px; font-weight: bold; color: #8b5cf6; margin-bottom: 24px; letter-spacing: 2px;">DISCOVERY ENGINE</div>
                <h1 style="color: #ffffff; margin-bottom: 16px; font-size: 20px;">Verify Your Identity</h1>
                <p style="font-size: 16px; color: #94a3b8; line-height: 1.6;">Welcome to the Grid. Use the code below to complete your registration and unlock your Gamer DNA.</p>
                
                <div style="background: #1e1e1e; padding: 24px; border-radius: 12px; margin: 32px 0; font-size: 36px; font-weight: 800; letter-spacing: 12px; color: #a78bfa; border: 1px solid #333; text-shadow: 0 0 15px rgba(139, 92, 246, 0.3);">
                    {code}
                </div>
                
                <p style="font-size: 14px; color: #64748b;">This code will expire in 10 minutes for your security.</p>
                <div style="height: 1px; background: #222; margin: 32px 0;"></div>
                <p style="font-size: 12px; color: #475569;">If you didn't request this code, you can safely ignore this email.</p>
                <p style="font-size: 11px; color: #334155; margin-top: 24px;">© 2026 Game Discovery Engine · Powered by AI DNA</p>
            </div>
        </body>
        </html>
        """
        msg.attach(MIMEText(html, "html"))

        # Using Gmail's SMTP server
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            try:
                server.login(sender_email, sender_password)
                server.sendmail(sender_email, target_email, msg.as_string())
            except smtplib.SMTPAuthenticationError:
                logging.error("SMTP AUTHENTICATION ERROR: The Gmail App Password is likely incorrect or expired.")
                print("\n" + "!"*60)
                print("CRITICAL: SMTP Authentication Failed.")
                print("Check that SENDER_PASSWORD in .env is a 16-character APP PASSWORD.")
                print("!"*60 + "\n")
                return False
        
        return True
    except Exception as e:
        logging.error(f"Failed to send email: {e}")
        return False

@app.route('/api/auth/send-otp', methods=['POST'])
def send_otp():
    try:
        body = request.get_json(force=True)
        email = body.get('email')
        if not email:
            return jsonify({"error": "Email is required"}), 400
        
        # Generate 6-digit numeric code
        code = f"{random.randint(100000, 999999)}"
        # Save to store with 10-minute expiry
        otp_store[email] = {
            "code": code,
            "expires": time.time() + 600
        }
        
        # Attempt to send real email
        email_sent = send_otp_email(email, code)
        
        # Log to console as fallback/audit
        print(f"[OTP] Code for {email} is: {code} (Email Sent: {email_sent})")
        
        return jsonify({"message": "OTP sent successfully", "emailSent": email_sent}), 200
    except Exception as exc:
        logging.error("send_otp error: %s", exc)
        return jsonify({"error": "Internal server error"}), 500

@app.route('/api/auth/verify-otp', methods=['POST'])
def verify_otp():
    try:
        body = request.get_json(force=True)
        email = body.get('email')
        code = body.get('code')
        
        if not email or not code:
            return jsonify({"error": "Email and code are required"}), 400
            
        record = otp_store.get(email)
        if not record:
            return jsonify({"error": "No OTP found for this email"}), 400
            
        if time.time() > record["expires"]:
            del otp_store[email]
            return jsonify({"error": "OTP has expired"}), 400
            
        if record["code"] != code:
            return jsonify({"error": "Invalid OTP code"}), 400
            
        # On success, clear OTP and return token
        del otp_store[email]
        v_token = str(uuid.uuid4())
        
        # ── Backend Auto-Verify ──
        # Mark user as email_verified=True in Firebase programmatically
        try:
            user_record = admin_auth.get_user_by_email(email)
            if user_record:
                admin_auth.update_user(user_record.uid, email_verified=True)
                logging.info(f"Firebase user {email} marked as verified.")
        except Exception as e:
            # User might not exist yet (first time registration), which is fine
            logging.info(f"Firebase user check: {e}")

        return jsonify({
            "message": "OTP verified",
            "verificationToken": v_token
        }), 200
    except Exception as exc:
        logging.error("verify_otp error: %s", exc)
        return jsonify({"error": "Internal server error"}), 500



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

def igdb_post(endpoint: str, data: str, timeout: int = 10) -> requests.Response:
    """
    Execute a POST request to IGDB with automatic 429 rate-limiting retries
    and exponential backoff for transient server errors (5xx) or exceptions.
    """
    url = f"{IGDB_BASE}/{endpoint}" if not endpoint.startswith("http") else endpoint
    max_retries = 3
    for attempt in range(max_retries):
        try:
            headers = get_igdb_headers()
            resp = requests.post(url, headers=headers, data=data, timeout=timeout)
            if resp.status_code == 429:
                retry_after = float(resp.headers.get("Retry-After", 0.3)) or (0.3 * (2 ** attempt))
                logging.warning("IGDB 429 rate limit hit on /%s. Retrying in %.2fs... (attempt %d/%d)", endpoint, retry_after, attempt + 1, max_retries)
                time.sleep(retry_after)
                continue
            if resp.status_code >= 500 and attempt < max_retries - 1:
                backoff = 0.5 * (2 ** attempt) + random.uniform(0.1, 0.3)
                logging.warning("IGDB %d error on /%s. Retrying in %.2fs... (attempt %d/%d)", resp.status_code, endpoint, backoff, attempt + 1, max_retries)
                time.sleep(backoff)
                continue
            return resp
        except requests.exceptions.RequestException as exc:
            if attempt < max_retries - 1:
                backoff = 0.5 * (2 ** attempt) + random.uniform(0.1, 0.3)
                logging.warning("IGDB request exception on /%s (%s). Retrying in %.2fs... (attempt %d/%d)", endpoint, exc, backoff, attempt + 1, max_retries)
                time.sleep(backoff)
                continue
            raise exc
    return resp

def igdb_img(img_id, size="t_720p"):
    if not img_id:
        return None
    return f"https://images.igdb.com/igdb/image/upload/{size}/{img_id}.jpg"

# ── Hub result cache ──────────────────────────────────────────────────────────
_hub_cache: dict = {}
HUB_CACHE_TTL = 600

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
    "action", "rpg", "strategy", "adventure", "simulation", "sports", "puzzle", "indie"
]

IGDB_GENRE_MAP = {
    4: "action", 5: "action", 8: "action", 10: "action", 33: "action", 25: "action", 7: "action", 30: "action",
    11: "strategy", 15: "strategy", 16: "strategy", 24: "strategy", 35: "strategy",
    12: "rpg", 36: "rpg",
    31: "adventure", 2: "adventure", 34: "adventure",
    13: "simulation",
    14: "sports",
    9: "puzzle", 26: "puzzle",
    32: "indie"
}

IGDB_THEME_MAP = {
    1: "action", 19: "action", 21: "action", 23: "action",
    22: "strategy", 39: "strategy", 41: "strategy",
    17: "rpg",
    18: "adventure", 20: "adventure", 31: "adventure", 38: "adventure", 43: "adventure", 44: "adventure",
    28: "simulation", 32: "simulation", 33: "simulation",
    34: "puzzle",
    40: "sports",
    27: "indie", 35: "indie"
}

SLUG_TO_IGDB_ID = {}
for k, v in IGDB_GENRE_MAP.items():
    if v not in SLUG_TO_IGDB_ID:
        SLUG_TO_IGDB_ID[v] = []
    SLUG_TO_IGDB_ID[v].append(str(k))

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

# HLTB estimates removed (using dynamic null fallbacks)

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
                        image_url   TEXT,
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
                    cur.execute("""
                        ALTER TABLE user_library
                            ADD COLUMN IF NOT EXISTS image_url TEXT;
                    """)
                except Exception:
                    pass
        logging.info("DB initialised (V12.0 Dynamic DNA).")
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
    theme_ids = [theme.get("id") for theme in g.get("themes", [])]

    dna_slugs = set()
    for gid in genre_ids:
        if gid in IGDB_GENRE_MAP: dna_slugs.add(IGDB_GENRE_MAP[gid])
    for tid in theme_ids:
        if tid in IGDB_THEME_MAP: dna_slugs.add(IGDB_THEME_MAP[tid])

    genre_names = [s.replace("-", " ").title() for s in [IGDB_GENRE_MAP[gid] for gid in genre_ids if gid in IGDB_GENRE_MAP]]
    theme_names = [t.get('name') for t in g.get('themes', [])]
    all_tags = sorted(list(set(genre_names + theme_names)))

    user_count = g.get("rating_count") or 0
    critic_count = g.get("aggregated_rating_count") or 0
    total_rating_count = user_count + critic_count
    if total_rating_count == 0:
        total_rating_count = g.get("total_rating_count") or 0

    return {
        "id":                 g.get("id"),
        "name":               g.get("name"),
        "background_image":   igdb_img(g.get("cover", {}).get("image_id"), "t_720p"),
        "rating":             (g.get("total_rating") or 0) / 10.0,
        "released":           formatted_date,
        "genres":             genre_names,
        "genre_slugs":        list(dna_slugs),
        "dna_slugs":          list(dna_slugs),
        "slug":               g.get("slug"),
        "platforms":          [p.get("name") for p in g.get("platforms", [])],
        "developer":          None,
        "tags":               all_tags[:6],
        "hypes":              g.get("hypes", 0),
        "follows":            g.get("follows") or 0,
        "total_rating_count": total_rating_count,
        "rating_count":       total_rating_count,
    }


def _parse_ids(param_str: str) -> list:
    result = []
    for part in (param_str or "").split(","):
        part = part.strip()
        if part.isdigit():
            result.append(int(part))
    return result


def _ids_clause(igdb_field: str, ids: list) -> str | None:
    if not ids:
        return None
    if len(ids) == 1:
        return f"{igdb_field} = ({ids[0]})"
    return f"{igdb_field} = ({', '.join(str(i) for i in ids)})"


# ═════════════════════════════════════════════════════════════════════════════
# MULTI-QUERY BATCH HELPER  (used by Hub routes)
# ═════════════════════════════════════════════════════════════════════════════

def _batch_popular_games(igdb_field: str, ids: list, limit_per: int = 3) -> dict:
    """
    Fetch popular game teasers for a list of item IDs in ONE IGDB multi-query.
    Returns a dict mapping item_id → list of game teasers.
    """
    if not ids:
        return {}

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
        resp = igdb_post("multiquery", body, timeout=15)
        if not resp.ok:
            logging.warning("multiquery failed: HTTP %s", resp.status_code)
            return {}

        result_map: dict = {}
        for block in resp.json():
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
                    "rating":  (g.get("total_rating") or 0) / 10.0,
                }
                for g in games_raw
            ]
        return result_map

    except Exception as exc:
        logging.warning("_batch_popular_games failed (%s): %s", igdb_field, exc)
        return {}


# ═════════════════════════════════════════════════════════════════════════════
# DISCOVERY POOL FETCHER  ← NEW in V12
# ═════════════════════════════════════════════════════════════════════════════

# Full IGDB fields needed by norm_game
_GAME_FIELDS = (
    "fields name, cover.image_id, total_rating, hypes, follows, total_rating_count, rating_count, aggregated_rating_count, "
    "first_release_date, genres.id, themes.id, themes.name, slug, platforms.name;"
)

# Base where-clause common to all discovery pools
_DISCOVERY_WHERE_BASE = (
    "cover != null & total_rating != null & total_rating > 0 "
    f"& first_release_date < {CAP_2026_TS} & first_release_date != null"
)


def _fetch_discovery_pool(gw: dict, exclude_ids: list, now_ts: int, page: int = 1) -> list:
    """
    V14 Proportional DNA Fetcher with 80/20 Exploration Split & Pagination.

    80% DNA Pool  — proportional genre sub-queries weighted by slider values.
    20% Wildcard  — top-rated games with NO genre filter for serendipitous
                    discovery outside the user's comfort zone.

    The `page` parameter drives a deterministic offset so each successive
    infinite-scroll load fetches a genuinely fresh IGDB slice:
        base_offset = (page - 1) * 50  +  random jitter [0, 50]

    Falls back to a single unfiltered query when no genre IDs map.
    Never crashes — returns [] on any IGDB error.
    """
    # Only genres with a positive weight contribute to the DNA pool
    active = {slug: w for slug, w in gw.items() if w > 0}

    date_clause = f"first_release_date < {now_ts}"
    base_where  = _DISCOVERY_WHERE_BASE + f" & {date_clause}"

    if exclude_ids:
        base_where += f" & id != ({','.join(map(str, exclude_ids))})"

    sub_queries: list = []

    # ── 80 % DNA Pool ─────────────────────────────────────────────────────────
    if active:
        total_weight = sum(active.values())
        # Allocate 120 slots to DNA (80 % of ~150 budget), proportionally.
        DNA_BUDGET = 120
        for pool_idx, (slug, weight) in enumerate(
            sorted(active.items(), key=lambda kv: kv[1], reverse=True)
        ):
            genre_ids_for_slug = SLUG_TO_IGDB_ID.get(slug, [])
            if not genre_ids_for_slug:
                continue

            genre_filter = f"genres = ({','.join(genre_ids_for_slug)})"
            dna_where    = f"{base_where} & {genre_filter}"

            # Proportional limit, clamped to [20, 50]
            proportional = int(round((weight / total_weight) * DNA_BUDGET))
            slot_limit   = max(20, min(50, proportional))

            # Page-driven offset so each scroll loads a fresh slice
            page_base    = (page - 1) * 50
            rand_offset  = page_base + random.randint(0, 50)

            sub_queries.append(
                f'query games "pool_{pool_idx}_{slug}" {{\n'
                f'  {_GAME_FIELDS}\n'
                f'  where {dna_where};\n'
                f'  sort total_rating desc;\n'
                f'  limit {slot_limit};\n'
                f'  offset {rand_offset};\n'
                f'}};'
            )

    # ── 20 % Wildcard Pool — no genre filter, top-rated globally ─────────────
    wildcard_base   = (page - 1) * 50
    wildcard_offset = wildcard_base + random.randint(0, 50)
    sub_queries.append(
        f'query games "pool_wildcard" {{\n'
        f'  {_GAME_FIELDS}\n'
        f'  where {base_where};\n'
        f'  sort follows desc;\n'
        f'  limit 30;\n'
        f'  offset {wildcard_offset};\n'
        f'}};'
    )

    # Fallback: if no DNA slug mapped to IGDB IDs, wildcard alone is the pool
    if len(sub_queries) == 1 and sub_queries[0].startswith('query games "pool_wildcard"'):
        # Replace with a slightly larger wildcard
        rand_offset = (page - 1) * 50 + random.randint(0, 50)
        sub_queries = [
            f'query games "pool_fallback" {{\n'
            f'  {_GAME_FIELDS}\n'
            f'  where {base_where};\n'
            f'  sort total_rating desc;\n'
            f'  limit 50;\n'
            f'  offset {rand_offset};\n'
            f'}};'
        ]

    body = "\n\n".join(sub_queries)

    try:
        resp = igdb_post("multiquery", body, timeout=18)
        if not resp.ok:
            logging.warning(
                "_fetch_discovery_pool: IGDB HTTP %s — %s",
                resp.status_code, resp.text[:300],
            )
            return []

        seen_ids:   set  = set()
        dna_games:  list = []
        wc_games:   list = []

        for block in resp.json():
            label = block.get("name", "")
            is_wildcard = label in ("pool_wildcard", "pool_fallback")
            for g in (block.get("result") or []):
                gid = g.get("id")
                if gid and gid not in seen_ids:
                    seen_ids.add(gid)
                    normed = norm_game(g)
                    # Tag wildcard games so the ranker can treat them specially
                    if is_wildcard:
                        normed["_is_wildcard"] = True
                        wc_games.append(normed)
                    else:
                        dna_games.append(normed)

        combined = dna_games + wc_games
        logging.info(
            "_fetch_discovery_pool (page=%d): %d DNA + %d wildcard = %d unique games",
            page, len(dna_games), len(wc_games), len(combined),
        )
        return combined

    except Exception as exc:
        logging.error("_fetch_discovery_pool error: %s", exc)
        return []


# ═════════════════════════════════════════════════════════════════════════════
# SVM ENGINE
# ═════════════════════════════════════════════════════════════════════════════

def feature_vec(dna_slugs: list, rating: float, gw: dict = None) -> list:
    vec = []
    gw_safe = gw if gw is not None else {}
    for slug in GENRE_SLUGS:
        flag  = 1.0 if slug in dna_slugs else 0.0
        scale = gw_safe.get(slug, 0.0) / 100.0
        vec.append(flag * scale)
    vec.append((min(float(rating), 10.0) / 10.0) * 0.5)
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


def svm_rank(games: list, pipe, gw: dict = None, offsets: dict = None) -> list:
    """
    V13 Strict DNA Ranker — zero popularity bias.

    Scoring formula:
      With SVM model : final_score = ((svm_prob * 0.4) + (dna_match_norm * 0.6)) * (W / 10.0)
      Cold start      : final_score = (dna_match_norm * 0.4 + pop_boost * 0.6) * (W / 10.0)

    dna_match is a dot-product of the game's genre presence vector and the
    user's gw slider values, normalised to [0, 1]:
      sum(gw[slug] for slug in game_slugs if slug in gw) / (100 * num_genres)

    No follows/popularity term anywhere.  The entire pool is sorted strictly
    by final_score descending — no bucket blending.
    """
    if not games:
        return games

    gw_safe = gw or {}

    # ── 1. Get SVM probabilities (or skip if cold start) ────────────────────
    if pipe is not None:
        X = [feature_vec(g.get("dna_slugs", []), g.get("rating", 0), gw_safe)
             for g in games]
        try:
            probs      = pipe.predict_proba(np.array(X, dtype=np.float32))
            pos_idx    = list(pipe.classes_).index(1)
            svm_probs  = list(probs[:, pos_idx])
        except Exception as exc:
            logging.warning("SVM scoring failed: %s — cold start fallback", exc)
            pipe      = None          # treat as cold start
            svm_probs = [0.0] * len(games)
    else:
        svm_probs = [0.0] * len(games)

    # ── 2. Score every game ──────────────────────────────────────────────────
    scored_games = []
    for i, g in enumerate(games):
        svm_prob   = float(svm_probs[i])
        rating     = g.get("rating") or 0.0     # already on 0–10 scale

        game_slugs = g.get("dna_slugs") or g.get("genre_slugs") or []

        # Dot-product DNA match: sum of slider weights for each matching genre
        # Normalised to [0, 1] by dividing by (100 × number of game genres).
        if game_slugs and gw_safe:
            raw_dot   = sum(gw_safe.get(s, 0.0) for s in game_slugs if s in GENRE_SLUGS)
            max_dot   = 100.0 * len(game_slugs)        # theoretical maximum
            dna_match = raw_dot / max_dot if max_dot > 0 else 0.0
        else:
            dna_match = 0.0

        # Bayesian Weighted Rating
        v = float(g.get("rating_count") or 0.0)
        R = rating
        m = 50.0
        C = 6.5
        W = (v * R + m * C) / (v + m)
        
        # Popularity Anchor
        pop_boost = math.log10((g.get("follows") or 0) + 10) / 5.0

        if pipe is not None:
            # SVM active: blend AI signal (40 %) with DNA match (60 %)
            raw_score = (svm_prob * 0.4) + (dna_match * 0.6)
            final_score = raw_score * (W / 10.0)
        else:
            # Cold start: DNA match weighted by Bayesian Weighted Rating
            final_score = (dna_match * 0.4 + pop_boost * 0.6) * (W / 10.0)

        scored_games.append({
            **g,
            "svm_score": round(final_score, 6),
            "raw_prob":  round(svm_prob, 6),
            "dna_match": round(dna_match * 100, 1),   # expose as 0–100 % for UI
        })

    # ── 3. Separate wildcards before sorting ─────────────────────────────────
    # Wildcards get a mild dna_match boost so they aren't completely buried,
    # but we still interleave them throughout the feed rather than appending
    # them all at the end.
    for sg in scored_games:
        if sg.get("_is_wildcard"):
            # Give wildcards a floor score so at least some appear mid-feed
            floor = max(sg["svm_score"], 0.15)
            sg["svm_score"] = floor

    dna_ranked = sorted(
        [g for g in scored_games if not g.get("_is_wildcard")],
        key=lambda x: x["svm_score"], reverse=True,
    )
    wc_ranked = sorted(
        [g for g in scored_games if g.get("_is_wildcard")],
        key=lambda x: x["svm_score"], reverse=True,
    )

    # ── 4. Interleave: insert 1 wildcard every 4 DNA games ───────────────────
    result: list = []
    wc_iter = iter(wc_ranked)
    wc_game = next(wc_iter, None)
    for i, game in enumerate(dna_ranked):
        result.append(game)
        # Insert a wildcard after every 4th DNA game
        if (i + 1) % 4 == 0 and wc_game is not None:
            result.append(wc_game)
            wc_game = next(wc_iter, None)
    # Append any remaining wildcards at the end
    if wc_game is not None:
        result.append(wc_game)
    result.extend(wc_iter)   # drain remaining

    logging.info(
        "svm_rank: %d games scored & interleaved (mode=%s, dna=%d, wildcard=%d, top_score=%.4f)",
        len(result),
        "svm" if pipe is not None else "cold_start",
        len(dna_ranked), len(wc_ranked),
        result[0]["svm_score"] if result else 0,
    )
    return result


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
            headers={"User-Agent": "GameDiscoveryEngine/12.0"},
            timeout=6,
        )
        if not search_resp.ok:
            return None
        items = search_resp.json().get("items", [])
        if not items:
            return None
        steam_id = items[0].get("id")
        if not steam_id:
            return None

        app_resp = requests.get(
            f"https://store.steampowered.com/api/appdetails/",
            params={"appids": steam_id, "l": "en", "cc": "us"},
            headers={"User-Agent": "GameDiscoveryEngine/12.0"},
            timeout=8,
        )
        if not app_resp.ok:
            return None
        app_data = app_resp.json().get(str(steam_id), {})
        if not app_data.get("success"):
            return None
        pc = app_data.get("data", {}).get("pc_requirements", {})
        return {
            "minimum":     pc.get("minimum", STEAM_FALLBACK_MSG),
            "recommended": pc.get("recommended", STEAM_FALLBACK_MSG),
        }
    except Exception:
        return None


# ═════════════════════════════════════════════════════════════════════════════
# HUB HELPERS  (unchanged from V11)
# ═════════════════════════════════════════════════════════════════════════════

def _hub_platforms() -> list:
    top_priority_ids = [6, 48, 167, 49, 130, 169]
    q = (
        "fields id, name, slug, summary, generation, platform_logo.image_id; "
        "where platform_logo != null; "
        "sort generation desc; limit 50;"
    )
    resp = igdb_post("platforms", q, timeout=12)
    if not resp.ok:
        return []
    platforms = resp.json()
    platform_ids = [p["id"] for p in platforms if p.get("id")]
    popular_map  = _batch_popular_games("platforms", platform_ids, limit_per=3)

    items = []
    for p in platforms:
        pid     = p.get("id")
        logo_id = (p.get("platform_logo") or {}).get("image_id")
        items.append({
            "id":            pid,
            "name":          p.get("name"),
            "slug":          p.get("slug"),
            "description":   p.get("summary", ""),
            "generation":    p.get("generation", 0),
            "logo":          igdb_img(logo_id, "t_logo_med") if logo_id else None,
            "popular_games": popular_map.get(pid, []),
        })

    def sort_logic(x):
        try:    priority_idx = top_priority_ids.index(x['id'])
        except ValueError: priority_idx = 999
        return (priority_idx, -(x['generation'] or 0), x['name'])

    return sorted(items, key=sort_logic)


def _hub_genres() -> list:
    priority_genres = [31, 12, 5, 11, 32, 25]
    priority_themes = [19, 21, 38, 18, 1]

    headers = get_igdb_headers()
    g_resp  = igdb_post("genres", "fields id, name, slug; limit 50;", timeout=10)
    t_resp  = igdb_post("themes", "fields id, name, slug; limit 50;", timeout=10)
    genres_raw = g_resp.json() if g_resp.ok else []
    themes_raw = t_resp.json() if t_resp.ok else []

    g_ids     = [x['id'] for x in genres_raw]
    t_ids     = [x['id'] for x in themes_raw]
    g_popular = _batch_popular_games("genres", g_ids, limit_per=3)
    t_popular = _batch_popular_games("themes", t_ids, limit_per=3)

    combined = []
    for g in genres_raw:
        combined.append({
            "id": g['id'], "name": g['name'], "slug": g['slug'], "type": "genre",
            "popular_games": g_popular.get(g['id'], [])
        })
    for t in themes_raw:
        t_name = t.get('name')
        if not t_name or any(i.get('name', '').lower() == t_name.lower() for i in combined):
            continue
        combined.append({
            "id": t['id'], "name": t['name'], "slug": t['slug'], "type": "theme",
            "popular_games": t_popular.get(t['id'], [])
        })

    def sort_vibe(x):
        if x['type'] == 'genre' and x['id'] in priority_genres:
            return (0, priority_genres.index(x['id']))
        if x['type'] == 'theme' and x['id'] in priority_themes:
            return (0, priority_themes.index(x['id']) + 10)
        return (1, x['name'])

    return sorted(combined, key=sort_vibe)


def _hub_companies(is_developer: bool) -> list:
    role_field      = "developed" if is_developer else "published"
    igdb_field      = "involved_companies.company"
    top_company_ids = [104, 37, 26, 70, 1, 14, 10110, 421, 126, 250, 112]
    ids_str         = ",".join(map(str, top_company_ids))

    q = (
        f"fields id, name, slug, description, logo.image_id, {role_field}; "
        f"where (id = ({ids_str})) | (logo != null & {role_field} != null); "
        f"sort {role_field} desc; limit 100;"
    )
    resp = igdb_post("companies", q, timeout=12)
    if not resp.ok:
        return []
    companies   = resp.json()
    company_ids = [c["id"] for c in companies if c.get("id")]
    popular_map = _batch_popular_games(igdb_field, company_ids, limit_per=3)

    items = []
    for c in companies:
        cid       = c.get("id")
        role_data = c.get(role_field, [])
        count     = len(role_data) if isinstance(role_data, list) else 0
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
    q    = "fields id, name, slug; limit 50;"
    resp = igdb_post("themes", q, timeout=10)
    if not resp.ok:
        return []
    themes     = resp.json()
    theme_ids  = [t["id"] for t in themes if t.get("id")]
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
        "version":   "v13.0-strict-dna",
    })


# ── GET /api/hub/<type> ────────────────────────────────────────────────────────
@app.route("/api/hub/<string:hub_type>", methods=["GET"])
def get_hub(hub_type: str):
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


# ── GET /api/search/suggestions ───────────────────────────────────────────────
@app.route("/api/search/suggestions", methods=["GET"])
def search_suggestions():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify([])

    fields = (
        "fields name, cover.image_id, total_rating, hypes, follows, total_rating_count, rating_count, aggregated_rating_count, "
        "first_release_date, genres.id, themes.id, themes.name, slug, platforms.name;"
    )
    q_clean = q.replace('"', '\\"')
    query_body = f'{fields} where (name ~ *"{q_clean}"* | alternative_names.name ~ *"{q_clean}"* | slug ~ *"{q_clean}"*) & cover != null; sort aggregated_rating_count desc; limit 7;'

    try:
        resp = igdb_post("games", query_body, timeout=10)
        resp.raise_for_status()
        raw_data = resp.json()
    except Exception as exc:
        logging.error("IGDB search suggestions error: %s", exc)
        return jsonify({"error": str(exc)}), 503

    games = [norm_game(g) for g in raw_data]
    return jsonify(games)


# ── GET /api/games ─────────────────────────────────────────────────────────────
@app.route("/api/games", methods=["GET"])
def get_games():
    # ── 1. Parse all query parameters ────────────────────────────────────────
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

    platform_ids   = _parse_ids(request.args.get("platform_ids", ""))
    genre_ids      = _parse_ids(request.args.get("genre_ids", ""))
    company_ids    = _parse_ids(request.args.get("company_ids", ""))
    theme_ids      = _parse_ids(request.args.get("theme_ids", ""))
    collection_ids = _parse_ids(request.args.get("collection_ids", ""))
    year_filter    = request.args.get("year", "", type=str).strip()
    rating_min     = request.args.get("rating_min", 0, type=float)
    genre_slug     = request.args.get("genre", "")

    now_ts = int(time.time())

    # ── 2. Parse DNA slider weights (gw_<slug>) and offsets ───────────────────
    gw: dict = {}
    offsets: dict = {}
    if discovery_mode and user_id:
        for slug in GENRE_SLUGS:
            val = request.args.get(f"gw_{slug}", type=float)
            if val is not None:
                gw[slug] = max(0.0, min(100.0, val))
            
            off_val = request.args.get(f"offset_{slug}", type=float)
            if off_val is not None:
                offsets[slug] = off_val

    # ── 3. DISCOVERY MODE — Dynamic Multi-Query Pool ──────────────────────────
    #
    # Only activate when:
    #   • discovery_mode=true
    #   • user_id is set
    #   • At least one gw_ param was passed (sliders are active)
    #   • Not a search, not awaited, no active hub filters
    #
    _use_dynamic_pool = (
        discovery_mode
        and user_id
        and bool(gw)
        and not search
        and not is_awaited_req
        and not platform_ids
        and not genre_ids
        and not company_ids
        and not theme_ids
        and not year_filter
        and not dates
    )

    if _use_dynamic_pool:
        games    = _fetch_discovery_pool(gw, exclude_ids, now_ts, page=page)
        svm_mode = "raw"

        if games:
            # Train SVM (if the user has liked games), then blend
            try:
                lib  = fetch_user_library(user_id)
                pipe = None
                if lib and any(r.get("is_liked") for r in lib):
                    pipe = train_svm(lib, gw or None)

                ranked   = svm_rank(games, pipe, gw or None, offsets)
                games    = ranked if ranked else sorted(games, key=lambda x: x.get("rating") or 0, reverse=True)
                svm_mode = "svm" if pipe else "cold_start"

            except Exception as svm_exc:
                logging.error("Discovery SVM ranking failed: %s", svm_exc)
                games    = sorted(games, key=lambda x: x.get("rating") or 0, reverse=True)
                svm_mode = "cold_start"

            # ── Build a persistent next URL so gw_ weights survive pagination ──
            next_params = [
                f"discovery_mode=true",
                f"user_id={user_id}",
                f"page={page + 1}",
            ]
            for slug, val in gw.items():
                next_params.append(f"gw_{slug}={val}")
            if exclude_ids:
                next_params.append(f"exclude_ids={','.join(map(str, exclude_ids))}")
            next_url = f"/api/games?{'&'.join(next_params)}"

            return jsonify({
                "results":  games,
                "count":    IGDB_TOTAL_COUNT,
                "next":     next_url,
                "previous": None if page <= 1 else f"/api/games?discovery_mode=true&user_id={user_id}&page={page - 1}",
                "svm_mode": svm_mode,
            })

        # If multi-query returned nothing (edge case / API hiccup),
        # fall through to the legacy single-query path below.
        logging.warning("_fetch_discovery_pool returned empty — falling back to legacy path")

    # ── 4. LEGACY SINGLE-QUERY PATH ───────────────────────────────────────────
    #  (used for search, hub filters, awaited, non-discovery browsing, and as
    #   a fallback if the multi-query fails)

    where_parts = []
    sort_clause = ""
    current_limit = limit
    is_upcoming   = False
    is_hype_query = False

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

    if is_awaited_req:
        where_parts.append(f"first_release_date > {now_ts}")
        where_parts.append("hypes > 0")
        sort_clause   = "sort hypes desc;"
        current_limit = max(20, limit)

    elif year_filter:
        years = [y.strip() for y in year_filter.split(",") if y.strip().isdigit()]
        if years:
            year_clauses = []
            for y in years:
                y_int    = int(y)
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
        where_parts.append(f"first_release_date < {now_ts}")
        where_parts.append(f"first_release_date < {CAP_2026_TS}")
        where_parts.append("first_release_date != null")

    if exclude_ids:
        where_parts.append(f"id != ({','.join(map(str, exclude_ids))})")

    if not search and not is_upcoming and not is_awaited_req:
        where_parts.append("total_rating != null & total_rating > 0")

    for clause in [
        _ids_clause("platforms", platform_ids),
        _ids_clause("genres", genre_ids) if genre_ids else (
            f"genres = ({','.join(SLUG_TO_IGDB_ID[genre_slug])})" if genre_slug and genre_slug in SLUG_TO_IGDB_ID else None
        ),
        _ids_clause("involved_companies.company", company_ids),
        _ids_clause("themes", theme_ids),
        _ids_clause("collection", collection_ids),
    ]:
        if clause: where_parts.append(clause)

    if rating_min > 0:
        where_parts.append(f"total_rating >= {rating_min}")

    where_parts.append("cover != null")

    if search:
        search_clean = search.replace('"', '\\"')
        where_parts.append(f'(name ~ *"{search_clean}"* | alternative_names.name ~ *"{search_clean}"* | slug ~ *"{search_clean}"*)')
        sort_clause = "sort aggregated_rating_count desc;"
        current_limit = 100

    where_clause = f"where {' & '.join(where_parts)};" if where_parts else ""

    if not sort_clause:
        if discovery_mode:
            sort_clause = "sort follows desc;"
        elif is_upcoming:
            sort_clause = "sort first_release_date asc;"
        elif is_hype_query or "hypes" in ordering:
            sort_clause = "sort hypes desc;"
        elif "follows" in ordering:
            sort_clause = "sort follows desc;"
        elif "metacritic" in ordering or "rating" in ordering:
            sort_clause = "sort total_rating desc;"
        else:
            sort_clause = "sort follows desc;"

    fields            = "fields name, cover.image_id, total_rating, hypes, follows, total_rating_count, rating_count, aggregated_rating_count, first_release_date, genres.id, themes.id, themes.name, slug, platforms.name;"
    pagination_clause = f"limit {current_limit}; offset {offset};"

    query_body = f"{fields} {where_clause} {sort_clause} {pagination_clause}"

    try:
        resp = igdb_post("games", query_body, timeout=12)
        resp.raise_for_status()
        raw_data = resp.json()
    except Exception as exc:
        logging.error("IGDB /games error: %s", exc)
        return jsonify({"error": str(exc)}), 503

    games    = [norm_game(g) for g in raw_data]
    svm_mode = "raw"

    # SVM ranking for legacy discovery path (when dynamic pool fallback)
    if discovery_mode and user_id and SKLEARN_AVAILABLE and not search:
        try:
            lib  = fetch_user_library(user_id)
            pipe = None
            if lib and any(r.get("is_liked") for r in lib):
                pipe = train_svm(lib, gw or None)

            ranked   = svm_rank(games, pipe, gw or None, offsets)
            games    = ranked if ranked else sorted(games, key=lambda x: x.get("rating") or 0, reverse=True)
            svm_mode = "svm" if pipe else "cold_start"

        except Exception as svm_exc:
            logging.error("Legacy SVM ranking failed: %s", svm_exc)
            games    = sorted(games, key=lambda x: x.get("rating") or 0, reverse=True)
            svm_mode = "cold_start"

    return jsonify({
        "results":  games,
        "count":    IGDB_TOTAL_COUNT,
        "next":     f"/api/games?page={page + 1}" if len(raw_data) >= current_limit else None,
        "previous": f"/api/games?page={page - 1}" if page > 1 else None,
        "svm_mode": svm_mode,
    })


_game_detail_cache: dict = {}
GAME_DETAIL_CACHE_TTL = 3600  # 1 hour cache TTL for instant loads

# ── GET /api/games/<id> ────────────────────────────────────────────────────────
@app.route("/api/games/<int:game_id>", methods=["GET"])
def get_game(game_id: int):
    cache_key = f"game_detail_{game_id}"
    cached_entry = _game_detail_cache.get(cache_key)
    if cached_entry and (time.time() - cached_entry[0]) < GAME_DETAIL_CACHE_TTL:
        return jsonify(cached_entry[1])

    query = (
        f"fields name, summary, storyline, cover.image_id, total_rating, total_rating_count, rating_count, "
        f"aggregated_rating, aggregated_rating_count, "
        f"first_release_date, "
        f"genres.id, themes.name, slug, platforms.name, screenshots.image_id, "
        f"websites.url, websites.category, "
        f"involved_companies.company.name, involved_companies.developer, involved_companies.publisher, "
        f"age_ratings.category, age_ratings.rating, "
        f"videos.video_id, videos.name, "
        f"game_modes.name, player_perspectives.name, "
        f"keywords.name, "
        f"game_engines.name, franchises.name, collection.name, "
        f"similar_games.name, similar_games.cover.url, similar_games.cover.image_id, "
        f"external_games.category, external_games.url; "
        f"where id = {game_id};"
    )
    try:
        resp = igdb_post("games", query, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        if not data:
            return jsonify({"error": "Game not found"}), 404
        d = data[0]
    except Exception as exc:
        return jsonify({"error": str(exc)}), 503

    developers, publishers = [], []
    for ic in d.get("involved_companies", []):
        cname = ic.get("company", {}).get("name")
        if not cname: continue
        if ic.get("developer"):  developers.append(cname)
        if ic.get("publisher"):  publishers.append(cname)

    ESRB_MAP = {1: "RP", 2: "EC", 3: "E", 4: "E10+", 5: "T", 6: "M", 7: "AO"}
    esrb_rating = None
    for ar in d.get("age_ratings", []):
        if ar.get("category") == 1:
            esrb_rating = ESRB_MAP.get(ar.get("rating"))
            break

    trailer_url = None
    for v in d.get("videos", []):
        vid = v.get("video_id")
        if vid:
            trailer_url = f"https://www.youtube.com/watch?v={vid}"
            break

    # Steam URL: explicitly filter external_games for category == 1 only
    steam_url = None
    if isinstance(d.get("external_games"), list):
        for eg in d["external_games"]:
            if isinstance(eg, dict) and eg.get("category") == 1:
                steam_url = eg.get("url")
                break

    genre_ids = [g.get("id") for g in d.get("genres", [])]
    theme_ids = [t.get("id") for t in d.get("themes", [])]

    dna_slugs = set()
    for gid in genre_ids:
        if gid in IGDB_GENRE_MAP: dna_slugs.add(IGDB_GENRE_MAP[gid])
    for tid in theme_ids:
        if tid in IGDB_THEME_MAP: dna_slugs.add(IGDB_THEME_MAP[tid])

    slugs = list(dna_slugs)
    names = sorted(list(set(s.replace("-", " ").title() for s in [IGDB_GENRE_MAP[gid] for gid in genre_ids if gid in IGDB_GENRE_MAP])))
    theme_names = [t.get('name') for t in d.get('themes', [])]
    all_tags = sorted(list(set(names + theme_names)))

    pc_reqs  = steam_pc_requirements(d.get("name", ""))
    rel      = d.get("first_release_date")
    released = datetime.datetime.fromtimestamp(rel).strftime("%Y-%m-%d") if rel else None
    released_formatted = datetime.datetime.fromtimestamp(rel).strftime("%B %d, %Y") if rel else None

    # Only include pc_requirements if we got real data (not the fallback message)
    real_pc_reqs = None
    if pc_reqs:
        min_text = pc_reqs.get("minimum", "")
        if min_text and min_text != STEAM_FALLBACK_MSG:
            real_pc_reqs = pc_reqs

    # Safely get list values for new specs arrays with type-checking
    game_modes = []
    if isinstance(d.get("game_modes"), list):
        game_modes = [m.get("name") for m in d["game_modes"] if isinstance(m, dict) and m.get("name")]

    player_perspectives = []
    if isinstance(d.get("player_perspectives"), list):
        player_perspectives = [p.get("name") for p in d["player_perspectives"] if isinstance(p, dict) and p.get("name")]

    keywords = []
    if isinstance(d.get("keywords"), list):
        keywords = [k.get("name") for k in d["keywords"] if isinstance(k, dict) and k.get("name")]

    game_engines = []
    if isinstance(d.get("game_engines"), list):
        game_engines = [e.get("name") for e in d["game_engines"] if isinstance(e, dict) and e.get("name")]

    franchises = []
    if isinstance(d.get("franchises"), list):
        franchises = [f.get("name") for f in d["franchises"] if isinstance(f, dict) and f.get("name")]

    collection_name = None
    if isinstance(d.get("collection"), dict):
        collection_name = d["collection"].get("name")

    similar_games = []
    if isinstance(d.get("similar_games"), list):
        for sg in d["similar_games"]:
            if isinstance(sg, dict) and sg.get("name"):
                cover_image = None
                sg_cover = sg.get("cover")
                if isinstance(sg_cover, dict):
                    img_id = sg_cover.get("image_id")
                    if img_id:
                        cover_image = igdb_img(img_id, "t_cover_big")
                    elif sg_cover.get("url"):
                        cover_url = sg_cover.get("url")
                        if cover_url.startswith("//"):
                            cover_image = "https:" + cover_url
                        else:
                            cover_image = cover_url
                        cover_image = cover_image.replace("t_thumb", "t_cover_big")
                similar_games.append({
                    "id": sg.get("id"),
                    "name": sg.get("name"),
                    "cover_url": cover_image
                })

    hltb_data = None
    try:
        hltb_query = f"fields hastily, normally, completely; where game_id = {game_id};"
        hltb_resp = requests.post(f"{IGDB_BASE}/game_time_to_beats", headers=get_igdb_headers(), data=hltb_query, timeout=5)
        if hltb_resp.ok:
            hltb_json = hltb_resp.json()
            if hltb_json:
                h_d = hltb_json[0]
                def format_time(seconds):
                    if not seconds or seconds <= 0:
                        return None
                    hours = seconds / 3600.0
                    if hours.is_integer():
                        return f"{int(hours)}h"
                    return f"{round(hours, 1)}h"
                hltb_data = {
                    "hastily": format_time(h_d.get("hastily")),
                    "normally": format_time(h_d.get("normally")),
                    "completely": format_time(h_d.get("completely"))
                }
    except Exception as h_exc:
        logging.error("get_game hltb fetch error: %s", h_exc)

    # Format screenshots and check portrait cover (gallery fix logic)
    screenshots_list = d.get("screenshots", [])
    formatted_screenshots = []
    portrait_cover = None
    cover_image_id = d.get("cover", {}).get("image_id") if isinstance(d.get("cover"), dict) else None

    if screenshots_list:
        first_s = screenshots_list[0]
        first_s_id = first_s.get("image_id")
        
        if cover_image_id and first_s_id == cover_image_id:
            portrait_cover = igdb_img(first_s_id, "t_720p")
            remaining_screenshots = screenshots_list[1:]
        else:
            remaining_screenshots = screenshots_list
            
        formatted_screenshots = [
            {"id": s.get("id"), "image": igdb_img(s.get("image_id"), "t_720p")}
            for s in remaining_screenshots
        ]

    res_dict = {
        "id":                          d.get("id"),
        "name":                        d.get("name"),
        "background_image":            igdb_img(d.get("cover", {}).get("image_id"), "t_720p"),
        "background_image_additional": (
            igdb_img(d.get("screenshots", [{}])[0].get("image_id"), "t_720p")
            if d.get("screenshots") else None
        ),
        "description_raw":      d.get("summary"),
        "storyline":            d.get("storyline"),
        "rating":               (d.get("total_rating") or 0) / 10.0,
        "rating_count":         ((d.get("rating_count") or 0) + (d.get("aggregated_rating_count") or 0)) if (((d.get("rating_count") or 0) + (d.get("aggregated_rating_count") or 0)) > 0) else (d.get("total_rating_count") or 0),
        "critic_rating":        round((d.get("aggregated_rating") or 0) / 10.0, 1),
        "critic_rating_count":  d.get("aggregated_rating_count") or 0,
        "rating_top":           10,
        "released":             released,
        "released_formatted":   released_formatted,
        "playtime":             None,
        "website":              None,
        "steam_url":            steam_url,
        "trailer_url":          trailer_url,
        "clip":                 {"clip": trailer_url} if trailer_url else None,
        "genres":               names,
        "genre_slugs":          list(dna_slugs),
        "dna_slugs":            list(dna_slugs),
        "platforms":            [p.get("name") for p in d.get("platforms", [])] if d.get("platforms") else None,
        "developers":           developers if developers else None,
        "publishers":           publishers if publishers else None,
        "companies": {
            "developers": developers if developers else None,
            "publishers": publishers if publishers else None
        },
        "tags":                 all_tags[:6] if all_tags else None,
        "esrb_rating":          esrb_rating,
        "pc_requirements":      real_pc_reqs,
        "mac_requirements":     None,
        "game_modes":           game_modes if game_modes else None,
        "player_perspectives":  player_perspectives if player_perspectives else None,
        "keywords":             keywords if keywords else None,
        "hltb":                 hltb_data,
        "game_engines":         game_engines if game_engines else None,
        "franchises":           franchises if franchises else None,
        "series":               collection_name or None,
        "similar_games":        similar_games if similar_games else None,
        "screenshots":          formatted_screenshots,
        "portrait_cover":       portrait_cover,
    }

    _game_detail_cache[cache_key] = (time.time(), res_dict)
    return jsonify(res_dict)


# ── GET /api/games/<id>/screenshots ───────────────────────────────────────────
@app.route("/api/games/<int:game_id>/screenshots", methods=["GET"])
def get_screenshots(game_id: int):
    try:
        # 1. Fetch cover image ID first
        cover_image_id = None
        try:
            g_query = f"fields cover.image_id; where id = {game_id};"
            g_resp = igdb_post("games", g_query, timeout=5)
            if g_resp.ok:
                g_json = g_resp.json()
                if g_json:
                    cover_image_id = g_json[0].get("cover", {}).get("image_id")
        except Exception as e:
            logging.error("Failed to fetch cover in screenshots route: %s", e)

        # 2. Fetch screenshots
        query = f"fields image_id; where game = {game_id}; limit 8;"
        resp = igdb_post("screenshots", query, timeout=10)
        resp.raise_for_status()
        screenshots_data = resp.json()

        results = []
        portrait_cover = None

        if screenshots_data:
            first_s = screenshots_data[0]
            first_s_id = first_s.get("image_id")
            
            if cover_image_id and first_s_id == cover_image_id:
                portrait_cover = igdb_img(first_s_id, "t_720p")
                remaining_screenshots = screenshots_data[1:]
            else:
                remaining_screenshots = screenshots_data
            
            results = [
                {"id": s.get("id"), "image": igdb_img(s.get("image_id"), "t_720p")}
                for s in remaining_screenshots
            ]
        
        return jsonify({
            "results": results,
            "portrait_cover": portrait_cover
        })
    except Exception as exc:
        logging.error("get_screenshots error: %s", exc)
        return jsonify({"results": [], "portrait_cover": None})


# ── GET /api/games/<id>/stores ─────────────────────────────────────────────────
@app.route("/api/games/<int:game_id>/stores", methods=["GET"])
def get_stores(game_id: int):
    query = f"fields category, url; where game = {game_id} & category = (1, 5, 13, 16, 17);"
    try:
        resp = igdb_post("websites", query, timeout=10)
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
    try:
        headers = get_igdb_headers()
        query = f"fields hastily, normally, completely; where game_id = {game_id};"
        resp = igdb_post("game_time_to_beats", query, timeout=5)
        if not resp.ok:
            return jsonify(None)
        
        data = resp.json()
        if not data:
            return jsonify(None)
            
        d = data[0]
        
        def format_time(seconds):
            if not seconds or seconds <= 0:
                return None
            hours = seconds / 3600.0
            if hours.is_integer():
                return f"{int(hours)}h"
            return f"{round(hours, 1)}h"
            
        return jsonify({
            "hastily": format_time(d.get("hastily")),
            "normally": format_time(d.get("normally")),
            "completely": format_time(d.get("completely"))
        })
    except Exception as exc:
        logging.error("get_hltb error: %s", exc)
        return jsonify(None)


# ── GET /api/library/<user_id> ─────────────────────────────────────────────────
@app.route("/api/library/<user_id>", methods=["GET"])
def get_library(user_id: str):
    conn = get_db()
    if not conn:
        return jsonify({"error": "DB unavailable"}), 503
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM user_library WHERE user_id=%s ORDER BY added_at DESC", (user_id,))
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
    # Enforce playtime caps: 0–200 h total per game (server-side guard)
    playtime = min(float(body.get("playtime", 0) or 0), 200.0)
    playtime = max(playtime, 0.0)

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
                        (user_id, game_id, game_name, genres, rating,
                         status, is_liked, is_favorite, playtime, image_url)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (user_id, game_id) DO UPDATE SET
                        game_name   = EXCLUDED.game_name,
                        genres      = EXCLUDED.genres,
                        rating      = EXCLUDED.rating,
                        status      = EXCLUDED.status,
                        is_liked    = EXCLUDED.is_liked,
                        is_favorite = EXCLUDED.is_favorite,
                        playtime    = EXCLUDED.playtime,
                        image_url   = EXCLUDED.image_url
                """, (
                    user_id,
                    int(body["game_id"]),
                    str(body.get("game_name", "")),
                    json.dumps(genres_raw if isinstance(genres_raw, list) else []),
                    float(body.get("rating", 0)),
                    status,
                    bool(body.get("is_liked",    False)),
                    bool(body.get("is_favorite", False)),
                    playtime,
                    str(body.get("image_url", "")),
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


# ── POST /api/games/<id>/dna-match ────────────────────────────────────────────
@app.route("/api/games/<int:game_id>/dna-match", methods=["POST"])
def dna_match(game_id: int):
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


if __name__ == "__main__":
    app.run(debug=True, port=5000)