import { useState, useEffect, useCallback, useRef } from "react";

export const API_BASE = "http://127.0.0.1:5000/api";
export const PAGE_SIZE = 100;
export const MOCK_USER_ID = "gde_user_001";

export const TIMELINE_LATEST = "__timeline_latest__";
export const TIMELINE_UPCOMING = "__timeline_upcoming__";
export const FREE_GAMES_SLUG = "__free_games__";
export const RETRO_CLASSICS_SLUG = "__retro_classics__";

/* ── Initial empty Map — used for clean logout reset ─────────────────────────── */
export const INITIAL_LIBRARY_STATE = new Map();

export const GENRES = [
  { slug: "", label: "All Games", icon: "◈" },
  { slug: "action", label: "Action", icon: "◈" },
  { slug: "strategy", label: "Strategy", icon: "♟" },
  { slug: "rpg", label: "RPG", icon: "🗡" },
  { slug: "adventure", label: "Adventure", icon: "◬" },
  { slug: "simulation", label: "Simulation", icon: "◫" },
  { slug: "sports", label: "Sports", icon: "◉" },
  { slug: "puzzle", label: "Puzzle", icon: "◧" },
  { slug: "indie", label: "Indie", icon: "◌" },
];

export const DNA_GENRES = [
  { slug: "action", label: "Action" },
  { slug: "strategy", label: "Strategy" },
  { slug: "rpg", label: "RPG" },
  { slug: "adventure", label: "Adventure" },
  { slug: "simulation", label: "Simulation" },
  { slug: "sports", label: "Sports" },
  { slug: "puzzle", label: "Puzzle" },
  { slug: "indie", label: "Indie" },
];

export const DNA_WEIGHTS = {
  favorite: 5,
  like: 2,
  playing: 3,
  played: 1,
  wishlist: 0.5,
  hour: 0.4,
};

export const LEVEL_XP = [
  0, 50, 120, 210, 320, 450, 600, 770, 960, 1170,
  1400, 1650, 1920, 2210, 2520, 2850, 3200, 3570, 3960, 4370,
];

export const GAMER_TITLES = [
  "Baby Glitch", "Curious", "Chatty", "Hyped", "Scout",
  "Analyst", "Tracker", "Watcher", "Seeker", "Radar",
  "Phantom", "Specter", "Ghost Chip", "Core Unit", "Signal",
  "Nexus", "Apex Probe", "Neural Drift", "Data Wraith", "GLITCH PRIME",
];

export function getLevel(xp) {
  let lvl = 1;
  for (let i = 1; i < LEVEL_XP.length; i++) {
    if (xp >= LEVEL_XP[i]) lvl = i + 1;
    else break;
  }
  return Math.min(lvl, 20);
}

export function getTitle(level) {
  return GAMER_TITLES[Math.max(0, level - 1)];
}

export function getXpProgress(xp) {
  const lvl = getLevel(xp);
  if (lvl >= 20) return { current: xp, next: xp, pct: 100 };
  const base = LEVEL_XP[lvl - 1];
  const next = LEVEL_XP[lvl];
  return {
    current: xp - base,
    next: next - base,
    pct: Math.round(((xp - base) / (next - base)) * 100),
  };
}

export const XP_EVENTS = {
  like: 15,
  favorite: 30,
  wishlist: 5,
  played: 20,
  playing: 10,
  hour: 3,
};

/* Max hours a single log entry may add (anti-cheese) */
export const MAX_HOURS_PER_ENTRY = 20;

/* Max hours one game contributes to XP (prevents DNA bias from grinding) */
export const MAX_HOURS_PER_GAME_XP = 200;

/**
 * Calculate the XP contribution for a playtime value, honouring the 200h cap.
 * Pass the *new total* playtime and the *previous total* playtime so we only
 * award XP for the incremental hours (not previously-awarded hours).
 */
export function calcHoursXp(prevTotal, newTotal) {
  const cappedPrev = Math.min(prevTotal, MAX_HOURS_PER_GAME_XP);
  const cappedNew = Math.min(newTotal, MAX_HOURS_PER_GAME_XP);
  return Math.round(Math.max(0, cappedNew - cappedPrev) * XP_EVENTS.hour);
}

export const truncate = (str = "", n) =>
  str.length > n ? str.slice(0, n).trimEnd() + "…" : str;

export const ratingColor = (r) => {
  if (r >= 8.4) return "var(--accent-green)";
  if (r >= 7.0) return "var(--accent-amber)";
  return "var(--accent-red)";
};

export const isNewRelease = (d) => {
  if (!d) return false;
  const ms = Date.now() - new Date(d).getTime();
  return ms >= 0 && ms < 30 * 24 * 60 * 60 * 1000;
};

export async function persistLibraryItem(userId, payload) {
  try {
    await fetch(`${API_BASE}/library/${userId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch { }
}

/**
 * computeDNAScores — V9.5 Multi-Genre Logic
 */
export function computeDNAScores(library) {
  const scores = {};
  DNA_GENRES.forEach(({ slug }) => { scores[slug] = 0; });

  if (!(library instanceof Map) || library.size === 0) return scores;

  const slugMap = {
    "action": "action",
    "rpg": "rpg",
    "strategy": "strategy",
    "sports": "sports",
    "adventure": "adventure",
    "puzzle": "puzzle",
    "simulation": "simulation",
    "indie": "indie",
    "platformer": "action",
    "shooter": "sports",
    "role-playing-games-rpg": "rpg",
  };

  for (const entry of library.values()) {
    const slugs = entry?.game?.genre_slugs ?? [];
    if (!Array.isArray(slugs) || slugs.length === 0) continue;

    let gameWeight = 0;
    if (entry.isFavorite) gameWeight += DNA_WEIGHTS.favorite;
    if (entry.isLiked) gameWeight += DNA_WEIGHTS.like;
    if (entry.status === "playing") gameWeight += DNA_WEIGHTS.playing;
    if (entry.status === "played") gameWeight += DNA_WEIGHTS.played;
    if (entry.status === "wishlist") gameWeight += DNA_WEIGHTS.wishlist;
    if ((entry.playtime ?? 0) > 0) gameWeight += entry.playtime * DNA_WEIGHTS.hour;

    for (const rawSlug of slugs) {
      const dnaSlug = slugMap[rawSlug];
      if (dnaSlug && dnaSlug in scores) {
        scores[dnaSlug] += gameWeight;
      }
    }
  }
  return scores;
}

export function normaliseDNA(rawScores) {
  const values = Object.values(rawScores);
  const max = Math.max(...values, 1);
  const out = {};
  for (const [k, v] of Object.entries(rawScores)) {
    const baseline = v > 0 ? 10 : 0;
    out[k] = Math.round(baseline + (v / max) * (100 - baseline));
  }
  return out;
}

export function libraryToDNA(library) {
  return normaliseDNA(computeDNAScores(library));
}

export function calculateMatchPercentage(game, dnaWeights) {
  if (!game || !game.genre_slugs || !dnaWeights) return null;
  const slugs = Array.isArray(game.genre_slugs) ? game.genre_slugs : (typeof game.genres === 'string' ? JSON.parse(game.genres || "[]").map(g => g.slug) : []);
  if (slugs.length === 0) return null;

  const slugMap = {
    "action": "action",
    "rpg": "rpg",
    "strategy": "strategy",
    "sports": "sports",
    "adventure": "adventure",
    "puzzle": "puzzle",
    "simulation": "simulation",
    "indie": "indie",
    "platformer": "action",
    "shooter": "sports",
    "role-playing-games-rpg": "rpg",
  };

  let maxWeight = 0;
  for (const rawSlug of slugs) {
    const dnaSlug = slugMap[rawSlug] || rawSlug;
    if (dnaWeights[dnaSlug] && dnaWeights[dnaSlug] > maxWeight) {
      maxWeight = dnaWeights[dnaSlug];
    }
  }

  if (maxWeight > 0) return Math.round(maxWeight);
  return null;
}

/* ─── Library Reducer ────────────────────────────────────────────────────────── */
export const libraryReducer = (state, action) => {
  // CRITICAL: Always create a fresh Map copy so React detects the reference change.
  const next = new Map(state);
  const { gameId } = action;
  const current = next.get(gameId) ?? {
    game: action.game, status: null, isLiked: false, isFavorite: false, playtime: 0,
  };

  switch (action.type) {
    case "SET_STATUS":
      next.set(gameId, {
        ...current,
        game: action.game ?? current.game,
        status: action.status,
        // Reset playtime when moving back to wishlist
        playtime: action.status === "wishlist" ? 0 : current.playtime,
      });
      break;

    case "ADD_PLAYTIME": {
      // Clamp the incoming hours to the per-entry maximum (anti-cheese)
      const clampedHours = Math.min(Math.max(0, action.hours ?? 0), MAX_HOURS_PER_ENTRY);
      const newPlaytime = Math.max(0, (current.playtime ?? 0) + clampedHours);

      // If game was on wishlist, logging hours moves it to "playing"
      const newStatus =
        current.status === "wishlist" ? "playing" :
          current.status ?? "playing";

      next.set(gameId, {
        ...current,
        game: action.game ?? current.game,
        playtime: newPlaytime,
        status: newStatus,
      });
      break;
    }

    // SET_HOURS: overwrite (edit) existing playtime rather than adding to it
    case "SET_HOURS": {
      const clampedHours = Math.min(Math.max(0, action.hours ?? 0), MAX_HOURS_PER_ENTRY);
      const newStatus =
        current.status === "wishlist" ? "playing" :
          current.status ?? "playing";
      next.set(gameId, {
        ...current,
        game: action.game ?? current.game,
        playtime: clampedHours,
        status: newStatus,
      });
      break;
    }

    case "REMOVE":
      next.delete(gameId);
      break;

    case "TOGGLE_LIKE": {
      const nowLiked = !current.isLiked;
      // Liked games always move to "played" — any existing status is upgraded.
      // Un-liking preserves the current status.
      const newStatus = nowLiked ? "played" : current.status;
      next.set(gameId, {
        ...current,
        game: action.game ?? current.game,
        isLiked: nowLiked,
        isFavorite: nowLiked ? current.isFavorite : false,
        status: newStatus,
      });
      break;
    }

    case "TOGGLE_FAVORITE": {
      const nowFav = !current.isFavorite;
      // Favorited games are always liked and always move to "played".
      // Un-favoriting preserves the current status.
      const newStatus = nowFav ? "played" : current.status;
      next.set(gameId, {
        ...current,
        game: action.game ?? current.game,
        isFavorite: nowFav,
        isLiked: nowFav ? true : current.isLiked,
        status: newStatus,
      });
      break;
    }

    case "FINISH_GAME": {
      // Move a "playing" game to "played"
      next.set(gameId, {
        ...current,
        game: action.game ?? current.game,
        status: "played",
      });
      break;
    }

    case "CLEAR_TAB": {
      const tab = action.tab;
      for (const [id, entry] of next.entries()) {
        if (tab === "liked" && entry.isLiked) next.set(id, { ...entry, isLiked: false, isFavorite: false });
        if (tab === "favorites" && entry.isFavorite) next.set(id, { ...entry, isFavorite: false });
        if (tab === "wishlist" && entry.status === "wishlist") next.set(id, { ...entry, status: null, playtime: 0 });
        if (tab === "played" && entry.status === "played") next.set(id, { ...entry, status: null });
        if (tab === "playing" && entry.status === "playing") next.set(id, { ...entry, status: null });
      }
      break;
    }

    case "HYDRATE": {
      next.clear();
      for (const row of (action.rows ?? [])) {
        let slugs = [];
        try {
          slugs = typeof row.genres === "string"
            ? JSON.parse(row.genres || "[]")
            : (Array.isArray(row.genres) ? row.genres : []);
        } catch { slugs = []; }
        next.set(row.game_id, {
          game: {
            id: row.game_id,
            name: row.game_name,
            genre_slugs: slugs,
            rating: row.rating ?? null,
            image_url: row.image_url ?? null,
            background_image: row.image_url ?? row.background_image ?? null,
            released: row.released ?? null,
          },
          status: row.status ?? null,
          isLiked: Boolean(row.is_liked),
          isFavorite: Boolean(row.is_favorite),
          playtime: row.playtime ?? 0,
        });
      }
      break;
    }
    default: return state;
  }
  return next;
};

/* ─── useToast ───────────────────────────────────────────────────────────────── */
export function useToast() {
  const [toasts, setToasts] = useState([]);
  const pending = useRef(new Set());

  const addToast = useCallback((message, type = "success", key = null) => {
    const k = key ?? `${message}::${type}`;
    if (pending.current.has(k)) return;
    pending.current.add(k);
    const id = Date.now() + Math.random();
    setToasts(p => [...p, { id, message, type }]);
    setTimeout(() => {
      setToasts(p => p.filter(t => t.id !== id));
      pending.current.delete(k);
    }, 3200);
  }, []);

  return { toasts, addToast };
}

/* ─── useInfiniteGames — V10 multi-filter extension ──────────────────────────── */

export function useInfiniteGames({
  searchQuery = "",
  genre = "",
  userId = "",
  dnaWeights = null,
  dnaOffsets = null,
  discoveryMode = false,
  ordering = "",
  metacritic = "",
  dates = "",
  tags = "",
  platformIds = [],
  genreIds = [],
  companyIds = [],
  themeIds = [],
  collectionIds = [],
  year = "",
  ratingMin = 0,
  excludeIds = [],
  salt = 0,
}) {
  const [games, setGames] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [svmMode, setSvmMode] = useState("raw");
  const fetchKeyRef = useRef(0);
  const [retryTick, setRetryTick] = useState(0);

  // ── FIX: Use Ref for Exclusions so likes don't trigger a reset (unless manual) ──
  const excludeRef = useRef(excludeIds);
  useEffect(() => { excludeRef.current = excludeIds; }, [excludeIds]);

  // ── FIX: Use Ref for DNA Weights so likes don't trigger a reset (unless manual) ──
  const dnaRef = useRef(dnaWeights);
  useEffect(() => { dnaRef.current = dnaWeights; }, [dnaWeights]);

  const offsetRef = useRef(dnaOffsets);
  useEffect(() => { offsetRef.current = dnaOffsets; }, [dnaOffsets]);

  const fetchPage = useCallback(async (pageNum, isReset) => {
    const myKey = ++fetchKeyRef.current;
    isReset ? setLoading(true) : setLoadingMore(true);
    setError(null);

    try {
      const params = new URLSearchParams({ page: pageNum, page_size: PAGE_SIZE });
      if (searchQuery) params.set("search", searchQuery);
      if (genre) params.set("genre", genre);
      if (ordering) params.set("ordering", ordering);
      if (metacritic) params.set("metacritic", metacritic);
      if (dates) params.set("dates", dates);
      if (tags) params.set("tags", tags);

      if (platformIds?.length) params.set("platform_ids", platformIds.join(","));
      if (genreIds?.length) params.set("genre_ids", genreIds.join(","));
      if (companyIds?.length) params.set("company_ids", companyIds.join(","));
      if (themeIds?.length) params.set("theme_ids", themeIds.join(","));
      if (collectionIds?.length) params.set("collection_ids", collectionIds.join(","));
      if (year) params.set("year", year);
      if (ratingMin > 0) params.set("rating_min", String(ratingMin));

      // Pass exclusions to API
      const currentExclusions = excludeRef.current;
      if (currentExclusions?.length) params.set("exclude_ids", currentExclusions.join(","));

      if (discoveryMode && userId) {
        params.set("user_id", userId);
        params.set("discovery_mode", "true");
        const currentDna = dnaRef.current;
        if (currentDna) {
          for (const [s, v] of Object.entries(currentDna)) {
            if (typeof v === "number") params.set(`gw_${s}`, String(v));
          }
        }
        const currentOffsets = offsetRef.current;
        if (currentOffsets) {
          for (const [s, v] of Object.entries(currentOffsets)) {
            if (v !== 0) params.set(`offset_${s}`, String(v));
          }
        }
      }

      const res = await fetch(`${API_BASE}/games?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (myKey !== fetchKeyRef.current) return;

      setTotalCount(data.count ?? 0);
      setHasMore(Boolean(data.next));
      setSvmMode(data.svm_mode ?? "raw");
      setGames(prev => isReset ? data.results : [...prev, ...data.results]);
    } catch (e) {
      if (myKey !== fetchKeyRef.current) return;
      setError(e.message);
      setGames(prev => isReset ? [] : prev);
    } finally {
      if (myKey === fetchKeyRef.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [
    searchQuery, genre, userId, discoveryMode, ordering, metacritic, dates, tags, retryTick, salt,
    JSON.stringify(platformIds), JSON.stringify(genreIds),
    JSON.stringify(companyIds), JSON.stringify(themeIds),
    JSON.stringify(collectionIds), year, ratingMin,
    // Removed dnaWeights from here to prevent auto-reset
  ]);

  // ── Manual Refresh Function ──
  const refresh = useCallback(() => {
    setPage(1);
    setGames([]);
    fetchPage(1, true);
  }, [fetchPage]);

  useEffect(() => {
    setPage(1);
    setGames([]);
    fetchPage(1, true);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (loading || loadingMore || !hasMore) return;
    const next = page + 1;
    setPage(next);
    fetchPage(next, false);
  }, [loading, loadingMore, hasMore, page, fetchPage]);

  const retry = useCallback(() => { setRetryTick(t => t + 1); }, []);

  // ADDED refresh to return object
  return { games, totalCount, loading, loadingMore, error, hasMore, loadMore, svmMode, retry, refresh };
}

/* ─── Hub result module-level cache ─────────────────────────────────────────── */
const _hubCache = new Map(); // type → {ts, data}
const HUB_TTL = 300_000;  // 5 minutes in ms (backend caches for 10 min)

/* ─── useHubData — NEW in V10 ────────────────────────────────────────────────── */
/**
 * Fetches Selection Hub data from /api/hub/<type>.
 *
 * Returns:
 *   items   — array of hub card objects from the backend
 *   loading — true while fetching
 *   error   — error message string or null
 *   refetch — force a fresh fetch (bypasses cache)
 *
 * Results are cached for 5 minutes in module memory so switching between
 * hub types and back doesn't trigger a redundant network request.
 */
export function useHubData(hubType) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!hubType) return;

    const cached = _hubCache.get(hubType);
    if (cached && (Date.now() - cached.ts) < HUB_TTL) {
      setItems(cached.data);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`${API_BASE}/hub/${encodeURIComponent(hubType)}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(d => {
        if (cancelled) return;
        const results = Array.isArray(d.results) ? d.results : [];
        _hubCache.set(hubType, { ts: Date.now(), data: results });
        setItems(results);
        setLoading(false);
      })
      .catch(e => {
        if (cancelled) return;
        setError(e.message);
        setLoading(false);
      });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hubType, tick]);

  const refetch = useCallback(() => {
    _hubCache.delete(hubType);
    setTick(t => t + 1);
  }, [hubType]);

  return { items, loading, error, refetch };
}

/* ─── useSingleGame ──────────────────────────────────────────────────────────── */
export function useSingleGame(gameId) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!gameId) return;
    let cancelled = false;
    setLoading(true); setData(null); setError(null);
    fetch(`${API_BASE}/games/${gameId}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [gameId]);

  return { data, loading, error };
}