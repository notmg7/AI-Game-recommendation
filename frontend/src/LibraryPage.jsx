/**
 * LibraryPage.jsx — Game Discovery Engine  V9 "Production"
 * ════════════════════════════════════════════════════════════════════════
 * V9 fixes:
 *  #4  Year Navigation — library entries are grouped by release year.
 *      A "BROWSE BY YEAR" section appears in the left sidebar when the
 *      active tab has games with known release years.  Clicking a year
 *      calls scrollToYear(year) which scrolls .library-main to that
 *      year-group heading using a yearRefs dict + offsetTop.
 *      A year-filter dropdown also lets the user show only one year at a
 *      time.  Year groups follow the same Top Hits → Rest ordering as
 *      the Dashboard grid.
 *  #5  DNA Offset system — `dnaOffsets` / `onDnaOffsetsChange` props are
 *      forwarded to DNABlade (V9 signature).  When the user removes a
 *      game or clears a tab, we recompute the base scores while
 *      preserving any manual offsets on top (same as Dashboard logic).
 *      The Library no longer calls normaliseDNA(computeDNAScores())
 *      directly on DNA weight state — it delegates to applyDnaOffsets so
 *      the offset system stays consistent across views.
 *  #8  background_image — LibGameCard reads game.background_image which
 *      is now correctly populated by the HYDRATE action in shared.js.
 *      No extra fallback fetch needed — the image is already in state.
 *
 * All V8.1 features preserved:
 *  • LibGameCard click opens GameDetailOverlay (Cyber-Portal)
 *  • Library search bar 40px height
 *  • Clear All confirmation widget
 *  • Stats section
 *  • Playtime logging + XP
 *  • DNABlade with V9 fixed-right 100vh layout
 */

import {
  useState, useEffect, useMemo, useCallback, useRef, memo,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft, Bookmark, Play, Heart, Star, Search, X,
  Trash2, Sparkles, Library, TrendingUp, Gamepad2, Award,
  Gamepad, Plus, Clock, AlertTriangle, ChevronDown, CheckCircle2,
} from "lucide-react";
import {
  truncate, ratingColor, XP_EVENTS,
  getLevel, getTitle, getXpProgress,
  computeDNAScores, normaliseDNA, DNA_GENRES,
  MAX_HOURS_PER_ENTRY, MAX_HOURS_PER_GAME_XP, calcHoursXp,
} from "./shared.js";
import { persistLibraryItemFS } from "./firebaseLibrary.js";
import DNABlade from "./DNABlade.jsx";

/* ── DNA offset helper (mirrors App.jsx) ────────────────────────────────────── */
function applyDnaOffsets(library, offsets) {
  const base = normaliseDNA(computeDNAScores(library));
  const result = {};
  for (const { slug } of DNA_GENRES) {
    result[slug] = Math.max(0, Math.min(100, (base[slug] ?? 50) + (offsets[slug] ?? 0)));
  }
  return result;
}

/* ── Year grouping (same logic as Dashboard) ────────────────────────────────── */
function groupEntriesByYear(entries) {
  const byYear = {};
  for (const e of entries) {
    const y = e.game?.released ? new Date(e.game.released).getFullYear() : "Unknown";
    (byYear[y] = byYear[y] || []).push(e);
  }

  return Object.keys(byYear)
    .sort((a, b) => (a === "Unknown" ? 1 : b === "Unknown" ? -1 : b - a))
    .map(year => {
      const list = byYear[year];

      // 1. Sort the entire list by rating first
      const sorted = [...list].sort((a, b) => (b.game?.rating ?? 0) - (a.game?.rating ?? 0));

      // 2. Take top 4
      const topHits = sorted.slice(0, 4);

      // 3. THE CRITICAL FIX: Ensure ID comparison is type-agnostic (force to String)
      const topIds = new Set(topHits.map(e => String(e.game.id)));
      const rest = list.filter(e => !topIds.has(String(e.game.id)));

      // 4. Sort the 'rest' by rating as well
      rest.sort((a, b) => (b.game?.rating ?? 0) - (a.game?.rating ?? 0));

      return { year, topHits, rest };
    });
}

/* ── Tab config ──────────────────────────────────────────────────────────────── */
const TABS = [
  { id: "playing", label: "Playing Now", Icon: Gamepad },
  { id: "wishlist", label: "Wishlist", Icon: Bookmark },
  { id: "played", label: "Played", Icon: Play },
  { id: "liked", label: "Liked", Icon: Heart },
  { id: "favorites", label: "Favorites", Icon: Star },
];
const TAB_ACCENT = {
  playing: "var(--accent-violet)",
  wishlist: "var(--accent)",
  played: "var(--accent-green)",
  liked: "var(--accent-rose)",
  favorites: "var(--accent-amber)",
};

/* ── Stat card ───────────────────────────────────────────────────────────────── */
function StatCard({ icon: Icon, label, value, accent }) {
  return (
    <motion.div className="stat-card" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
      <div className="stat-icon" style={{ color: accent, background: `${accent}18` }}>
        <Icon size={16} />
      </div>
      <div className="stat-info">
        <span className="stat-value">{value}</span>
        <span className="stat-label">{label}</span>
      </div>
    </motion.div>
  );
}

/* ── Library Game Card ───────────────────────────────────────────────────────── */
const LibGameCard = memo(function LibGameCard({
  entry, activeTab, onRemove, onFavorite, onAddHours, onSetHours, onFinish, onOpenOverlay,
}) {
  const { game, status, isFavorite, playtime = 0 } = entry;
  const showFavBtn = activeTab === "liked" || activeTab === "favorites";

  // Panel state
  const [panelOpen, setPanelOpen] = useState(false);
  const [editMode, setEditMode] = useState(false); // false = add, true = overwrite
  const [hrInput, setHrInput] = useState("1");

  const openPanel = (isEdit) => {
    if (panelOpen && editMode === isEdit) {
      // Same button pressed again — close the panel
      setPanelOpen(false);
      return;
    }
    setEditMode(isEdit);
    setHrInput(isEdit ? String(playtime) : "1");
    setPanelOpen(true);
  };

  const handleConfirm = () => {
    const h = parseFloat(hrInput);
    if (isNaN(h) || h < 0) return;
    // UI-side enforcement of the 20h per-entry cap
    const clamped = Math.min(h, MAX_HOURS_PER_ENTRY);
    if (editMode) {
      onSetHours(entry, clamped);
    } else {
      onAddHours(entry, clamped);
    }
    setPanelOpen(false);
    setHrInput("1");
  };

  const inputOverCap = parseFloat(hrInput) > MAX_HOURS_PER_ENTRY;

  return (
    <motion.div className="lib-game-card" layout
      initial={{ opacity: 0, scale: 0.93 }} animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.93 }} transition={{ duration: 0.22 }}
    >
      {/* Cover image */}
      <div
        className="lib-card-image"
        style={{ cursor: "pointer" }}
        onClick={() => onOpenOverlay?.({ id: game.id, name: game.name, background_image: game.background_image })}
      >
        {game.background_image
          ? <img src={game.background_image} alt={game.name} loading="lazy" />
          : <div className="lib-card-image--fallback"><Gamepad2 size={28} opacity={0.3} /></div>
        }
        <div className="lib-card-image-overlay" />
        {isFavorite && (
          <div className="lib-card-fav-badge">
            <Star size={9} fill="currentColor" /> 3×
          </div>
        )}
        {activeTab === "playing" && (
          <div className="lib-card-playing-badge">
            <Gamepad size={9} /> Playing
          </div>
        )}
        <div className="lib-card-view-hint">View Details</div>
      </div>

      <div className="lib-card-body">
        <h3
          className="lib-card-title"
          onClick={() => onOpenOverlay?.({ id: game.id, name: game.name, background_image: game.background_image })}
          style={{ cursor: "pointer" }}
        >
          {truncate(game.name, 30)}
        </h3>
        <div className="lib-card-meta">
          {game.rating != null && (
            <span className="lib-card-rating" style={{ color: ratingColor(game.rating) }}>
              <Star size={10} fill="currentColor" />{Number(game.rating).toFixed(1)}
            </span>
          )}
          {game.genre_slugs?.slice(0, 2).map(s => (
            <span key={s} className="lib-card-genre">{s}</span>
          ))}
        </div>
        {game.released && (
          <p className="lib-card-released">{game.released}</p>
        )}

        {/* ── Playtime / action row ── */}
        <div className="lib-card-playtime-row">
          <Clock size={11} className="lcp-icon" />

          {status !== "wishlist" ? (
            <>
              <span className="lcp-hours">{playtime > 0 ? `${playtime}h logged` : "No hours"}</span>

              {/* Add hours */}
              <button
                className={`lcp-add-btn ${panelOpen && !editMode ? "lcp-add-btn--active" : ""}`}
                onClick={() => openPanel(false)}
                title="Log additional hours"
              >
                <Plus size={11} />
              </button>

              {/* Edit / overwrite existing hours — only shown when hours > 0 */}
              {playtime > 0 && (
                <button
                  className={`lcp-add-btn lcp-edit-btn ${panelOpen && editMode ? "lcp-add-btn--active" : ""}`}
                  onClick={() => openPanel(true)}
                  title="Edit total hours (overwrite)"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
              )}

              {/* Finish → Played (only for "playing" status) */}
              {status === "playing" && (
                <button
                  className="lcp-add-btn lcp-finish-btn"
                  onClick={() => onFinish(entry)}
                  title="Mark as Finished → Played"
                >
                  <CheckCircle2 size={12} />
                </button>
              )}
            </>
          ) : (
            /* Wishlist: "Log Hours" opens the hours panel AND moves to playing */
            <button
              className={`lcp-start-btn ${panelOpen ? "lcp-start-btn--active" : ""}`}
              onClick={() => openPanel(false)}
              title="Log hours — moves to Playing"
            >
              Log Hours
            </button>
          )}
        </div>

        {/* ── Expandable hours input panel ── */}
        <AnimatePresence>
          {panelOpen && (
            <motion.div className="lib-card-add-hours"
              initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }}
              style={{ overflow: "hidden" }}
            >
              <span className="lcp-panel-label">
                {editMode
                  ? `Set total hours (max ${MAX_HOURS_PER_ENTRY}):`
                  : `Add hours (max ${MAX_HOURS_PER_ENTRY} per entry):`}
              </span>
              <input
                type="number"
                min="0"
                max={MAX_HOURS_PER_ENTRY}
                step="0.5"
                className={`lcp-hr-input ${inputOverCap ? "lcp-hr-input--warn" : ""}`}
                value={hrInput}
                onChange={e => setHrInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleConfirm()}
                autoFocus
              />
              <button className="lcp-hr-confirm" onClick={handleConfirm}>
                {editMode ? "Save" : "+ Log"}
              </button>
              {inputOverCap && (
                <span className="lcp-hours-warn">Max {MAX_HOURS_PER_ENTRY}h — will be capped</span>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="lib-card-actions">
        {showFavBtn && (
          <button
            className={`lib-card-btn ${isFavorite ? "lib-card-btn--fav-active" : ""}`}
            onClick={() => onFavorite(entry)}
            title={isFavorite ? "Remove 3×" : "Favorite (3×)"}
          >
            <Star size={13} fill={isFavorite ? "currentColor" : "none"} />
          </button>
        )}
        <button className="lib-card-btn lib-card-btn--remove" onClick={() => onRemove(game.id)}>
          <Trash2 size={13} />
        </button>
      </div>
    </motion.div>
  );
});

/* ── Clear All confirmation ──────────────────────────────────────────────────── */
function ClearAllButton({ count, onClear }) {
  const [confirming, setConfirming] = useState(false);
  if (count === 0) return null;
  if (confirming) {
    return (
      <div className="lib-clearall-confirm">
        <AlertTriangle size={13} className="lib-clearall-warn-icon" />
        <span>Clear all {count} item{count !== 1 ? "s" : ""}?</span>
        <button className="lib-clearall-yes" onClick={() => { onClear(); setConfirming(false); }}>
          Yes, clear
        </button>
        <button className="lib-clearall-no" onClick={() => setConfirming(false)}>Cancel</button>
      </div>
    );
  }
  return (
    <button className="lib-clearall-btn" onClick={() => setConfirming(true)}>
      <Trash2 size={12} /><span>Clear All</span>
    </button>
  );
}

/* ── Year-grouped library grid ───────────────────────────────────────────────── */
function LibYearGrid({ entries, yearRefs, activeTab, onRemove, onFavorite, onAddHours, onSetHours, onFinish, onOpenOverlay }) {
  const groups = useMemo(() => groupEntriesByYear(entries), [entries]);
  if (!groups.length) return null;

  return (
    <div className="year-grouped-grid">
      {groups.map(({ year, topHits, rest }) => (
        <div key={year} className="year-group"
          ref={el => {
            if (yearRefs && yearRefs.current) yearRefs.current[year] = el;
          }}>
          <div className="year-group-header">
            <span className="year-group-label">{year}{year !== "Unknown" ? " RELEASES" : ""}</span>
            <div className="year-group-line" />
          </div>

          {topHits.length > 0 && (
            <div className="year-hits-section">
              <div className="year-subheader">
                <Star size={10} className="year-subheader-icon" /><span>TOP HITS</span>
              </div>
              <motion.div className="lib-game-grid" layout>
                <AnimatePresence mode="popLayout">
                  {topHits.map(entry => (
                    <LibGameCard key={entry.game.id} entry={entry} activeTab={activeTab}
                      onRemove={onRemove} onFavorite={onFavorite}
                      onAddHours={onAddHours} onSetHours={onSetHours}
                      onFinish={onFinish} onOpenOverlay={onOpenOverlay}
                    />
                  ))}
                </AnimatePresence>
              </motion.div>
            </div>
          )}

          {rest.length > 0 && (
            <div className="year-rest-section" style={{ marginTop: topHits.length > 0 ? '24px' : '0' }}>
              {topHits.length > 0 && (
                <div className="year-subheader" style={{ opacity: 0.5 }}>
                  <span>OTHER RELEASES</span>
                </div>
              )}
              <motion.div className="lib-game-grid" layout>
                <AnimatePresence mode="popLayout">
                  {rest.map(entry => (
                    <LibGameCard key={entry.game.id} entry={entry} activeTab={activeTab}
                      onRemove={onRemove} onFavorite={onFavorite}
                      onAddHours={onAddHours} onSetHours={onSetHours}
                      onFinish={onFinish} onOpenOverlay={onOpenOverlay}
                    />
                  ))}
                </AnimatePresence>
              </motion.div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Library Page
   ════════════════════════════════════════════════════════════════════════════ */
export default function LibraryPage({
  library, dispatch, addToast,
  dnaWeights, onDnaWeightsChange,
  dnaOffsets = {}, onDnaOffsetsChange = () => { },
  xp, onXpGain,
  onBack,
  onGameClick, // New prop
  user,
}) {
  const [activeTab, setActiveTab] = useState("playing");
  const [tabSearch, setTabSearch] = useState({
    playing: "", wishlist: "", played: "", liked: "", favorites: "",
  });
  const [bladeCollapsed, setBladeCollapsed] = useState(false);
  /* Fix #4: year filter and scroll refs */
  const [yearFilter, setYearFilter] = useState("all");
  const yearRefs = useRef({});
  const mainRef = useRef(null);   /* scrollable .library-main element */

  const level = getLevel(xp);
  const title = getTitle(level);

  /* ── Derived data ────────────────────────────────────────────────────────── */
  const entries = useMemo(() => Array.from(library.values()), [library]);

  const tabItems = useMemo(() => ({
    playing: entries.filter(e => e.status === "playing"),
    wishlist: entries.filter(e => e.status === "wishlist"),
    played: entries.filter(e => e.status === "played"),
    liked: entries.filter(e => e.isLiked),
    favorites: entries.filter(e => e.isFavorite),
  }), [entries]);

  const effectiveTab = activeTab;

  /* Items for the active tab, filtered by search */
  const allTabItems = useMemo(() => tabItems[effectiveTab] ?? [], [tabItems, effectiveTab]);

  const yearFilteredItems = useMemo(() => {
    if (yearFilter === "all") return allTabItems;
    return allTabItems.filter(e =>
      e.game?.released &&
      new Date(e.game.released).getFullYear() === Number(yearFilter)
    );
  }, [allTabItems, yearFilter]);

  const visibleItems = useMemo(() => {
    const q = tabSearch[effectiveTab].toLowerCase().trim();
    if (!q) return yearFilteredItems;
    return yearFilteredItems.filter(e =>
      e.game.name?.toLowerCase().includes(q) ||
      e.game.genre_slugs?.some(s => s.includes(q))
    );
  }, [yearFilteredItems, effectiveTab, tabSearch]);

  /* Fix #4: years available in the active tab */
  const availableYears = useMemo(() => {
    const y = new Set(
      allTabItems
        .map(e => e.game?.released ? new Date(e.game.released).getFullYear() : null)
        .filter(Boolean)
    );
    return [...y].sort((a, b) => b - a);
  }, [allTabItems]);

  /* Stats */
  const totalSaved = new Set([
    ...tabItems.wishlist.map(e => e.game.id),
    ...tabItems.played.map(e => e.game.id),
    ...tabItems.playing.map(e => e.game.id),
  ]).size;
  const avgRating = entries.length
    ? (entries.reduce((s, e) => s + (e.game.rating ?? 0), 0) / entries.length).toFixed(1)
    : "—";
  const totalHours = entries.reduce((s, e) => s + (e.playtime ?? 0), 0).toFixed(1);

  /* Fix #4: scroll main pane to a year group */
  const scrollToYear = useCallback((year) => {
    const el = yearRefs.current[year];
    if (el && mainRef.current) {
      const offset = el.offsetTop - 16;
      mainRef.current.scrollTo({ top: offset, behavior: "smooth" });
    }
    /* Also clear the year dropdown filter so the group is visible */
    setYearFilter("all");
  }, []);

  /* When tab changes, reset year filter */
  const handleTabChange = useCallback((id) => {
    setActiveTab(id);
    setYearFilter("all");
  }, []);

  /* ── Library mutations — Fix #5: preserve offsets on DNA update ─────────── */
  const syncDna = useCallback((nextLib) => {
    const w = applyDnaOffsets(nextLib, dnaOffsets);
    onDnaWeightsChange(w);
  }, [onDnaWeightsChange, dnaOffsets]);

  const handleStatusChange = useCallback((gameId, newStatus) => {
    const entry = library.get(gameId);
    if (!entry) return;

    // 1. Update Reducer
    dispatch({ type: "SET_STATUS", gameId, status: newStatus });

    // 2. Sync DNA (wipes playtime if wishlist)
    const next = new Map(library);
    next.set(gameId, { ...entry, status: newStatus, playtime: newStatus === "wishlist" ? 0 : entry.playtime });
    onDnaWeightsChange(applyDnaOffsets(next, dnaOffsets));

    // 3. Persist to DB
    persistLibraryItemFS(user?.uid, {
      ...entry.game,
      game_id: entry.game.id,
      game_name: entry.game.name,
      status: newStatus,
      playtime: newStatus === "wishlist" ? 0 : entry.playtime,
    });

    addToast(newStatus === "playing" ? "Started Playing! 🎮" : "Game Completed! 🏆", "success", `st:${gameId}`);
  }, [dispatch, library, dnaOffsets, onDnaWeightsChange, addToast]);

  const handleRemove = useCallback((gameId) => {
    dispatch({ type: "REMOVE", gameId });
    const next = new Map(library);
    next.delete(gameId);
    syncDna(next);
    addToast("Removed from library", "info", `rm:${gameId}:${Date.now()}`);
  }, [dispatch, library, addToast, syncDna]);

  const handleFavorite = useCallback((entry) => {
    dispatch({ type: "TOGGLE_FAVORITE", gameId: entry.game.id, game: entry.game });
    const was = entry.isFavorite;
    const next = new Map(library);
    next.set(entry.game.id, { ...entry, isFavorite: !was, isLiked: !was ? true : entry.isLiked });
    syncDna(next);
    addToast(
      was ? "Removed from favorites" : "Glitch noted your favorite! ⭐",
      "liked",
      `fav:${entry.game.id}:${was}`,
    );
  }, [dispatch, library, addToast, syncDna]);

  const handleAddHours = useCallback((entry, hours) => {
    // Clamp to per-entry max before dispatching
    const clamped = Math.min(Math.max(0, hours), MAX_HOURS_PER_ENTRY);

    const prevPlaytime = entry.playtime ?? 0;
    const newPlaytime = prevPlaytime + clamped;

    // Status: wishlist → playing on first log; otherwise preserve current
    const newStatus =
      entry.status === "wishlist" ? "playing" :
        entry.status ?? "playing";

    dispatch({ type: "ADD_PLAYTIME", gameId: entry.game.id, game: entry.game, hours: clamped });

    persistLibraryItemFS(user?.uid, {
      game_id: entry.game.id,
      game_name: entry.game.name,
      genres: entry.game.genre_slugs ?? [],
      rating: entry.game.rating ?? 0,
      status: newStatus,               // persist the resolved status
      is_liked: entry.isLiked ?? false,
      is_favorite: entry.isFavorite ?? false,
      playtime: newPlaytime,
      image_url: entry.game.background_image ?? entry.game.image_url ?? "",
    });

    // XP respects the 200h-per-game cap — only award XP for hours under the cap
    const xpGained = calcHoursXp(prevPlaytime, newPlaytime);
    if (xpGained > 0) onXpGain(xpGained);

    addToast(
      `+${clamped}h logged${newStatus === "playing" && entry.status === "wishlist" ? " → Now Playing!" : ""}`,
      "xp",
      `pt:${entry.game.id}:${Date.now()}`,
    );
  }, [dispatch, addToast, onXpGain, user]);

  /**
   * handleSetHours — overwrites the existing playtime (edit/correction).
   * XP delta is calculated relative to the previous total, capped at 200h.
   */
  const handleSetHours = useCallback((entry, hours) => {
    const clamped = Math.min(Math.max(0, hours), MAX_HOURS_PER_ENTRY);

    const prevPlaytime = entry.playtime ?? 0;
    const newPlaytime = clamped; // overwrite, not accumulate

    const newStatus =
      entry.status === "wishlist" ? "playing" :
        entry.status ?? "playing";

    dispatch({ type: "SET_HOURS", gameId: entry.game.id, game: entry.game, hours: clamped });

    persistLibraryItemFS(user?.uid, {
      game_id: entry.game.id,
      game_name: entry.game.name,
      genres: entry.game.genre_slugs ?? [],
      rating: entry.game.rating ?? 0,
      status: newStatus,
      is_liked: entry.isLiked ?? false,
      is_favorite: entry.isFavorite ?? false,
      playtime: newPlaytime,
      image_url: entry.game.background_image ?? entry.game.image_url ?? "",
    });

    // Award (or effectively recalculate) XP based on the new total vs old total
    const xpGained = calcHoursXp(prevPlaytime, newPlaytime);
    if (xpGained > 0) onXpGain(xpGained);

    addToast(`Hours updated to ${clamped}h`, "xp", `seth:${entry.game.id}:${Date.now()}`);
  }, [dispatch, addToast, onXpGain, user]);

  /**
   * handleFinish — moves a "playing" game to "played".
   */
  const handleFinish = useCallback((entry) => {
    dispatch({ type: "FINISH_GAME", gameId: entry.game.id, game: entry.game });

    const next = new Map(library);
    next.set(entry.game.id, { ...entry, status: "played" });
    syncDna(next);

    persistLibraryItemFS(user?.uid, {
      game_id: entry.game.id,
      game_name: entry.game.name,
      genres: entry.game.genre_slugs ?? [],
      rating: entry.game.rating ?? 0,
      status: "played",
      is_liked: entry.isLiked ?? false,
      is_favorite: entry.isFavorite ?? false,
      playtime: entry.playtime ?? 0,
      image_url: entry.game.background_image ?? entry.game.image_url ?? "",
    });

    onXpGain(XP_EVENTS.played);
    addToast(`🏆 ${truncate(entry.game.name, 20)} finished!`, "played", `fin:${entry.game.id}`);
  }, [dispatch, library, syncDna, addToast, onXpGain, user]);

  const handleClearTab = useCallback((tab) => {
    dispatch({ type: "CLEAR_TAB", tab });
    const next = new Map(library);
    for (const [id, e] of next.entries()) {
      if (tab === "liked" && e.isLiked) next.set(id, { ...e, isLiked: false, isFavorite: false });
      if (tab === "favorites" && e.isFavorite) next.set(id, { ...e, isFavorite: false });
      if (tab === "wishlist" && e.status === "wishlist") next.set(id, { ...e, status: null });
      if (tab === "played" && e.status === "played") next.set(id, { ...e, status: null });
      if (tab === "playing" && e.status === "playing") next.set(id, { ...e, status: null });
    }
    syncDna(next);
    addToast(`Cleared all ${tab} items`, "info", `clear:${tab}:${Date.now()}`);
  }, [dispatch, addToast, library, syncDna]);

  /* Show grouped view when no search text and year filter is "all" */
  const showGrouped = !tabSearch[effectiveTab] && yearFilter === "all";

  /* ── Render ──────────────────────────────────────────────────────────────── */
  return (
    <div className="library-page">
      <div className="library-layout">

        {/* ── Sidebar ── */}
        <nav className="lib-sidebar">
          <div className="lib-sidebar-scroll">

            {/* Back button */}
            <button className="lib-back-btn lib-back-btn--sidebar" onClick={onBack}>
              <ArrowLeft size={16} /><span>Dashboard</span>
            </button>

            <div className="sidebar-divider" style={{ margin: "8px 4px" }} />
            <p className="sidebar-label">TABS</p>
            <ul className="sidebar-list">
              {TABS.map(({ id, label, Icon }) => (
                <li key={id}>
                  <button
                    className={`sidebar-item ${effectiveTab === id ? "sidebar-item--active" : ""}`}
                    onClick={() => handleTabChange(id)}
                  >
                    <span className="sidebar-icon"><Icon size={13} /></span>
                    <span>{label}</span>
                    <span className="lib-sidebar-count">{tabItems[id]?.length ?? 0}</span>
                    {effectiveTab === id && (
                      <motion.div className="sidebar-active-indicator" layoutId="lib-si"
                        style={{ background: TAB_ACCENT[id] }} />
                    )}
                  </button>
                </li>
              ))}
            </ul>

            {/* Fix #4: Browse by Year — only shown when the tab has multiple years */}
            {availableYears.length > 1 && (
              <>
                <div className="sidebar-divider" style={{ margin: "8px 4px" }} />
                <p className="sidebar-label">BROWSE BY YEAR</p>
                <ul className="sidebar-list">
                  {availableYears.map(y => (
                    <li key={y}>
                      <button
                        className="sidebar-item sidebar-item--year"
                        onClick={() => scrollToYear(y)}
                      >
                        <span className="sidebar-icon">◈</span>
                        <span>{y}</span>
                        <span className="lib-sidebar-count">
                          {allTabItems.filter(e =>
                            e.game?.released &&
                            new Date(e.game.released).getFullYear() === y
                          ).length}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <div className="sidebar-divider" style={{ margin: "8px 4px" }} />
            <p className="sidebar-label">STATS</p>
            <div className="lib-sidebar-stats">
              <div className="lib-sidebar-stat"><span className="lib-sidebar-stat-val">{totalSaved}</span><span className="lib-sidebar-stat-label">Saved</span></div>
              <div className="lib-sidebar-stat"><span className="lib-sidebar-stat-val">{totalHours}h</span><span className="lib-sidebar-stat-label">Logged</span></div>
              <div className="lib-sidebar-stat"><span className="lib-sidebar-stat-val">{avgRating}</span><span className="lib-sidebar-stat-label">Avg ★</span></div>
            </div>

          </div>
        </nav>

        {/* ── Main content ── */}
        <div className="library-main" ref={mainRef}>

          {/* Header */}
          <header className="library-page-header">
            <button className="lib-back-btn" onClick={onBack}>
              <ArrowLeft size={18} /><span>Back</span>
            </button>
            <div className="library-page-title">
              <Library size={20} /><span>Game Discovery Library</span>
            </div>
          </header>

          {/* Stats row */}
          <section className="library-stats">
            <StatCard icon={Library} label="Total Saved" value={totalSaved} accent="var(--accent)" />
            <StatCard icon={Gamepad} label="Playing Now" value={tabItems.playing.length} accent="var(--accent-violet)" />
            <StatCard icon={Bookmark} label="Wishlist" value={tabItems.wishlist.length} accent="var(--accent)" />
            <StatCard icon={Play} label="Played" value={tabItems.played.length} accent="var(--accent-green)" />
            <StatCard icon={Heart} label="Liked" value={tabItems.liked.length} accent="var(--accent-rose)" />
            <StatCard icon={Award} label="Favorited" value={tabItems.favorites.length} accent="var(--accent-amber)" />
            <StatCard icon={Clock} label="Hours Logged" value={`${totalHours}h`} accent="var(--accent-violet)" />
            <StatCard icon={TrendingUp} label="Avg. Rating" value={avgRating} accent="var(--accent-violet)" />
          </section>

          {/* SVM banner */}
          {tabItems.liked.length > 0 && (
            <motion.div className="lib-svm-banner" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
              <Sparkles size={14} />
              <span>
                Discovery SVM trained on <strong>{tabItems.liked.length}</strong> games
                {tabItems.playing.length > 0 && ` · ${tabItems.playing.length} playing`}
                {tabItems.favorites.length > 0 && ` · ${tabItems.favorites.length} favorited`}
              </span>
            </motion.div>
          )}

          {/* Tabs */}
          <div className="library-page-tabs">
            {TABS.map(({ id, label, Icon }) => (
              <button key={id}
                className={`lib-page-tab ${effectiveTab === id ? "lib-page-tab--active" : ""}`}
                onClick={() => handleTabChange(id)}
              >
                <Icon size={14} /><span>{label}</span>
                <span className="lib-page-tab-count">{tabItems[id]?.length ?? 0}</span>
                {effectiveTab === id && (
                  <motion.div className="lib-page-tab-indicator" layoutId="lib-indicator"
                    style={{ background: TAB_ACCENT[id] }} />
                )}
              </button>
            ))}
          </div>

          {/* Search + year filter + Clear All */}
          <div className="lib-tab-toolbar">
            <div className="lib-tab-search-wrap">
              <Search size={14} className="lib-tab-search-icon" />
              <input
                className="lib-tab-search-input"
                type="text"
                placeholder={`Search ${TABS.find(t => t.id === effectiveTab)?.label ?? effectiveTab}…`}
                value={tabSearch[effectiveTab]}
                onChange={e => setTabSearch(p => ({ ...p, [effectiveTab]: e.target.value }))}
              />
              {tabSearch[effectiveTab] && (
                <button className="lib-tab-search-clear"
                  onClick={() => setTabSearch(p => ({ ...p, [effectiveTab]: "" }))}>
                  <X size={13} />
                </button>
              )}
            </div>

            {/* Fix #4: year dropdown filter */}
            {availableYears.length > 1 && (
              <div className="year-filter-wrap">
                <ChevronDown size={11} className="year-filter-icon" />
                <select
                  className="year-filter-select"
                  value={yearFilter}
                  onChange={e => setYearFilter(e.target.value)}
                >
                  <option value="all">All Years</option>
                  {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            )}

            <ClearAllButton
              count={tabItems[effectiveTab]?.length ?? 0}
              onClear={() => handleClearTab(effectiveTab)}
            />
          </div>

          {/* Game grid */}
          <div className="library-page-content">
            <AnimatePresence mode="wait">
              <motion.div key={`${effectiveTab}-${yearFilter}`}
                initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.18 }}
              >
                {visibleItems.length === 0 ? (
                  <div className="lib-page-empty">
                    {tabSearch[effectiveTab] ? (
                      <><Search size={40} opacity={0.3} /><p>No results for "{tabSearch[effectiveTab]}"</p></>
                    ) : yearFilter !== "all" ? (
                      <>
                        <Gamepad2 size={40} opacity={0.3} />
                        <p>No games from {yearFilter} in this tab.</p>
                        <button className="retry-btn" onClick={() => setYearFilter("all")}>
                          <X size={13} /><span>Clear Year Filter</span>
                        </button>
                      </>
                    ) : (
                      <>
                        {effectiveTab === "playing" && <><Gamepad size={40} opacity={0.3} /><p>Nothing playing right now.</p><span>Mark a game as Playing from the + menu.</span></>}
                        {effectiveTab === "wishlist" && <><Bookmark size={40} opacity={0.3} /><p>Wishlist is empty.</p><span>Hit + on any card.</span></>}
                        {effectiveTab === "played" && <><Play size={40} opacity={0.3} /><p>No played games yet.</p></>}
                        {effectiveTab === "liked" && <><Heart size={40} opacity={0.3} /><p>No liked games.</p><span>♥ a card to train the AI.</span></>}
                        {effectiveTab === "favorites" && <><Star size={40} opacity={0.3} /><p>No favorites.</p><span>★ a liked game for 3× weight.</span></>}
                      </>
                    )}
                  </div>
                ) : showGrouped ? (
                  /* Fix #4: year-grouped layout when no search/filter active */
                  <LibYearGrid
                    entries={visibleItems}
                    yearRefs={yearRefs}
                    activeTab={effectiveTab}
                    onRemove={handleRemove}
                    onFavorite={handleFavorite}
                    onAddHours={handleAddHours}
                    onSetHours={handleSetHours}
                    onFinish={handleFinish}
                    onOpenOverlay={onGameClick}
                  />
                ) : (
                  /* Flat grid when search/year-filter is active */
                  <motion.div className="lib-game-grid" layout>
                    <AnimatePresence mode="popLayout">
                      {visibleItems.map(entry => (
                        <LibGameCard
                          key={entry.game.id}
                          entry={entry}
                          activeTab={effectiveTab}
                          onRemove={handleRemove}
                          onFavorite={handleFavorite}
                          onAddHours={handleAddHours}
                          onSetHours={handleSetHours}
                          onFinish={handleFinish}
                          onOpenOverlay={onGameClick}
                        />
                      ))}
                    </AnimatePresence>
                  </motion.div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>

        </div>{/* end library-main */}

        {/*
         * Fix #5: DNABlade receives dnaOffsets + onDnaOffsetsChange (V9 signature).
         * The blade is position:fixed right-0 via CSS so it doesn't take layout
         * space here — this wrapper just participates in the flex row visually.
         */}
        <div style={{ width: 0, flexShrink: 0 }}>
          <DNABlade
            library={library}
            dnaWeights={dnaWeights}
            onWeightsChange={onDnaWeightsChange}
            dnaOffsets={dnaOffsets}
            onDnaOffsetsChange={onDnaOffsetsChange}
            level={level}
            title={title}
            collapsed={bladeCollapsed}
            onToggle={() => setBladeCollapsed(v => !v)}
          />
        </div>

      </div>{/* end library-layout */}

    </div>
  );
}