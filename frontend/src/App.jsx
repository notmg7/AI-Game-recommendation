/**
 * App.jsx — Game Discovery Engine  V13 "Clean Architecture"
 * ════════════════════════════════════════════════════════════════════════
 * Changes from V12:
 *
 *  1. GAME DETAIL MODAL — GameDetailOverlay removed entirely.
 *     New lightweight <GameDetailModal> built inline with:
 *     - Instant open using game data from parent card (zero loading flash)
 *     - React Portal (document.body) for correct stacking
 *     - Skeleton loaders for gallery + description (fetched async)
 *     - No Steam / HLTB logic
 *
 *  2. QUICK MENU PORTAL — QuickMenu now renders via createPortal at
 *     position:fixed so it never clips under cards below it.
 *
 *  3. TRENDING ROW PROPS — TrendingRow accepts title, subtitle, endpoint.
 *     "Most Awaited" section uses endpoint="/api/games?awaited=true".
 *
 *  4. GlitchPet heartbeat + freeze confirmed wired correctly (no changes
 *     needed — already in GlitchPet.jsx V10).
 *
 *  5. DNABlade label font-size set to 10px, +/- buttons, no Manual text
 *     banner (already in DNABlade.jsx — CSS ensures 10px label size).
 */

import {
  useState, useEffect, useCallback, useRef, useReducer, useMemo,
  createPortal,
} from "react";
import { createPortal as reactDomPortal } from "react-dom";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import {
  Search, X, Star, Gamepad2, ChevronRight, LogIn, UserPlus, User,
  Loader2, AlertTriangle, Plus, Check, Sparkles,
  BookmarkCheck, CheckCircle2, Heart, Library,
  LogOut, Play, Bookmark,
  TrendingUp, Zap, Flame,
  Compass, Gamepad, Award, Clock, CalendarClock,
  ChevronLeft, ChevronDown, Gift, History, RefreshCw,
  Monitor, ShoppingCart, Tag, LayoutGrid, Layers,
  Users, Building2, Calendar, Trophy,
  ExternalLink, ChevronUp, Image as ImageIcon,
} from "lucide-react";
import useSound from "use-sound";

import {
  API_BASE, MOCK_USER_ID, GENRES,
  TIMELINE_LATEST, TIMELINE_UPCOMING, FREE_GAMES_SLUG,
  RETRO_CLASSICS_SLUG,
  truncate, ratingColor, isNewRelease, persistLibraryItem,
  libraryReducer, useToast, useInfiniteGames, useHubData,
  computeDNAScores, normaliseDNA,
  getLevel, getTitle, getXpProgress, XP_EVENTS,
  DNA_GENRES,
} from "./shared.js";

import DNABlade     from "./DNABlade.jsx";
import GlitchPet    from "./GlitchPet.jsx";
import HeroCarousel from "./HeroCarousel.jsx";
import LibraryPage  from "./LibraryPage.jsx";

/* ── Sound paths ─────────────────────────────────────────────────────────────── */
const SFX = {
  hum1:   "/sounds/hum1.mp3",
  hum2:   "/sounds/hum2.mp3",
  hum3:   "/sounds/hum3.mp3",
  chime:  "/sounds/chime.mp3",
  dizzy:  "/sounds/dizzy.mp3",
  sad:    "/sounds/sad.mp3",
  glitch: "/sounds/glitch.mp3",
};

/* ── Boot stagger variants ───────────────────────────────────────────────────── */
const bootContainer = { hidden: {}, visible: { transition: { staggerChildren: 0.08, delayChildren: 0.1 } } };
const bootSidebar   = { hidden: { x: -60, opacity: 0 }, visible: { x: 0, opacity: 1, transition: { duration: 0.35, ease: [0.16,1,0.3,1] } } };
const bootMain      = { hidden: { opacity: 0, y: 20 },  visible: { opacity: 1, y: 0,  transition: { duration: 0.35, ease: [0.16,1,0.3,1] } } };
const bootBlade     = { hidden: { x: 60, opacity: 0 },  visible: { x: 0, opacity: 1,  transition: { duration: 0.35, ease: [0.16,1,0.3,1] } } };
const bootCard      = { hidden: { scale: 0.88, opacity: 0 }, visible: { scale: 1, opacity: 1, transition: { duration: 0.25, ease: [0.16,1,0.3,1] } } };
const bootGrid      = { hidden: {}, visible: { transition: { staggerChildren: 0.04, delayChildren: 0.3 } } };

/* ── DNA offset helper ───────────────────────────────────────────────────────── */
function applyDnaOffsets(library, offsets) {
  const base = normaliseDNA(computeDNAScores(library));
  const result = {};
  for (const { slug } of DNA_GENRES) {
    result[slug] = Math.max(0, Math.min(100, (base[slug] ?? 50) + (offsets[slug] ?? 0)));
  }
  return result;
}

/* ── Date helpers ────────────────────────────────────────────────────────────── */
function getTodayStr()    { return new Date().toISOString().split("T")[0]; }
function getTomorrowStr() { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().split("T")[0]; }

/* ── Section slugs ───────────────────────────────────────────────────────────── */
const DISCOVERY_SLUG    = "__discovery__";
const TOP_2026_SLUG     = "__top_2026__";
const POPULAR_2025_SLUG = "__popular_2025__";
const ALL_TIME_SLUG     = "__all_time__";

/* ── Browse targets ─────────────────────────────────────────────────────────── */
const BROWSE_ITEMS = [
  { id: "platforms", label: "Platforms",      Icon: Monitor      },
  { id: "stores",    label: "Stores",         Icon: ShoppingCart },
  { id: "genres",    label: "Genres & Vibes", Icon: Layers       },
  { id: "years",     label: "Years",          Icon: Calendar     },
];

/* ── Advanced Filter → IGDB filter-key mapping ─────────────────────────────── */
const PORTAL_FILTER_MAP = {
  platforms: "platforms",
  genres:    "genres",
  tags:      "themes",
  themes:    "themes",
  years:     "years",
  stores:    "stores",
};

/* Factory: fresh empty filter state */
function emptyFilters() {
  return {
    platforms: new Map(),
    genres:    new Map(),
    themes:    new Map(),
    years:     new Map(),
    stores:    new Map(),
  };
}

/* ── sectionToApiParams ──────────────────────────────────────────────────────── */
function sectionToApiParams(section) {
  if (section === TIMELINE_LATEST)     return { ordering: "-hypes,-released",          metacritic: "50,100", dates: `2024-01-01,${getTodayStr()}` };
  if (section === TIMELINE_UPCOMING)   return { ordering: "-hypes",                    metacritic: "",        dates: `${getTomorrowStr()},2027-12-31` };
  if (section === FREE_GAMES_SLUG)     return { ordering: "-follows",                  metacritic: "",        tags:  "free-to-play" };
  if (section === RETRO_CLASSICS_SLUG) return { ordering: "-total_rating",             metacritic: "80,100",  dates: "1980-01-01,2005-12-31" };
  if (section === TOP_2026_SLUG)       return { ordering: "-hypes,-total_rating",      metacritic: "70,100",  dates: `2026-01-01,${getTodayStr()}` };
  if (section === POPULAR_2025_SLUG)   return { ordering: "-follows,-total_rating",    metacritic: "60,100",  dates: "2025-01-01,2025-12-31" };
  if (section === ALL_TIME_SLUG)       return { ordering: "-total_rating",             metacritic: "90,100"   };
  if (section && section !== DISCOVERY_SLUG) return { ordering: "-released,-total_rating", metacritic: "50,100" };
  return { ordering: "", metacritic: "" };
}

/* ════════════════════════════════════════════════════════════════════════════
   GAME DETAIL MODAL  V14 "Marketplace Edition"
   ════════════════════════════════════════════════════════════════════════════
   • Hero banner locked to 16:9 with gradient overlay
   • Two-column body: left = media + description, right = metadata sidebar
   • CompatibilityMeter — DNA match progress bar
   • HltbBoxes — 3 playtime estimate cards
   • TechGrid — PC specs (OS, RAM, Storage, GPU)
   • "View on Steam" button with official Steam blue
   • All data hydrated from the upgraded /api/games/<id> endpoint
   ════════════════════════════════════════════════════════════════════════════ */

/* ── Sub-components ───────────────────────────────────────────────────────── */
function CompatibilityMeter({ match, label, loading }) {
  const color =
    match >= 90 ? "var(--accent-green)"  :
    match >= 75 ? "var(--accent)"        :
    match >= 55 ? "var(--accent-violet)" :
    match >= 35 ? "var(--accent-amber)"  : "var(--text-muted)";

  if (loading) {
    return (
      <div className="gdm-compat">
        <div className="gdm-compat-header">
          <span className="gdm-compat-label">DNA COMPATIBILITY</span>
          <div className="gdm-compat-pct-skel" />
        </div>
        <div className="gdm-compat-track"><div className="gdm-compat-fill-skel" /></div>
      </div>
    );
  }

  return (
    <div className="gdm-compat">
      <div className="gdm-compat-header">
        <span className="gdm-compat-label">DNA COMPATIBILITY</span>
        <span className="gdm-compat-pct" style={{ color }}>{match}%</span>
      </div>
      <div className="gdm-compat-track">
        <motion.div
          className="gdm-compat-fill"
          style={{ background: color }}
          initial={{ width: 0 }}
          animate={{ width: `${match}%` }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1], delay: 0.1 }}
        />
      </div>
      <span className="gdm-compat-badge" style={{ color, borderColor: color + "44" }}>
        {label}
      </span>
    </div>
  );
}

function HltbBoxes({ hltb }) {
  if (!hltb) return null;
  const boxes = [
    { label: "Main Story",    value: hltb.main_story,    icon: "🎯", cls: "" },
    { label: "Completionist", value: hltb.completionist, icon: "🏆", cls: "gdm-hltb-box--gold" },
    { label: "Source",        value: hltb.source === "genre-estimate" ? "Est." : "HLTB", icon: "📊", cls: "gdm-hltb-box--dim" },
  ];
  return (
    <div className="gdm-hltb">
      <span className="gdm-sidebar-label">HOW LONG TO BEAT</span>
      <div className="gdm-hltb-row">
        {boxes.map(b => (
          <div key={b.label} className={`gdm-hltb-box ${b.cls}`}>
            <span className="gdm-hltb-icon">{b.icon}</span>
            <span className="gdm-hltb-val">
              {b.label === "Source" ? b.value : b.value != null ? `${b.value}h` : "—"}
            </span>
            <span className="gdm-hltb-key">{b.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TechGrid({ pcReqs, developer, esrb, platforms }) {
  /* Parse out key specs from the Steam HTML-stripped text blob */
  const parse = (text, key) => {
    if (!text) return null;
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.toLowerCase().includes(key.toLowerCase())) {
        const colon = line.indexOf(":");
        if (colon !== -1) return line.slice(colon + 1).trim().slice(0, 60);
      }
    }
    return null;
  };

  const minText = pcReqs?.minimum || "";
  const rows = [
    { icon: "🖥",  label: "OS",       value: parse(minText, "OS") || (platforms?.includes("PC (Microsoft Windows)") ? "Windows" : "—") },
    { icon: "💾",  label: "Storage",  value: parse(minText, "Storage") || parse(minText, "HDD") || "—" },
    { icon: "🧠",  label: "RAM",      value: parse(minText, "Memory") || parse(minText, "RAM") || "—" },
    { icon: "⚙️",  label: "GPU",      value: parse(minText, "Graphics") || "—" },
    { icon: "🏢",  label: "Dev",      value: developer?.[0] || "—" },
    { icon: "🔞",  label: "Rating",   value: esrb || "Not Rated" },
  ];

  const hasAnySpec = rows.some(r => r.value !== "—");
  if (!hasAnySpec) return null;

  return (
    <div className="gdm-techgrid">
      <span className="gdm-sidebar-label">TECH SPECS</span>
      <div className="gdm-techgrid-rows">
        {rows.map(r => (
          <div key={r.label} className="gdm-techgrid-row">
            <span className="gdm-techgrid-icon">{r.icon}</span>
            <span className="gdm-techgrid-key">{r.label}</span>
            <span className="gdm-techgrid-val" title={r.value}>{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function GameDetailModal({ game: cardGame, library, dispatch, addToast, onClose, dnaWeights }) {
  const [fullGame,    setFullGame]    = useState(null);
  const [screenshots, setScreenshots] = useState([]);
  const [activeImg,   setActiveImg]   = useState(0);
  const [dataLoading, setDataLoading] = useState(true);
  const [imgLoading,  setImgLoading]  = useState(true);
  const [dnaMatch,    setDnaMatch]    = useState(null);   // { match, label }
  const [dnaLoading,  setDnaLoading]  = useState(true);

  /* Use hydrated data when available, card data instantly for title/hero */
  const game = fullGame ?? cardGame;

  const entry      = library?.get(game?.id);
  const status     = entry?.status;
  const isLiked    = entry?.isLiked    ?? false;
  const isFavorite = entry?.isFavorite ?? false;

  /* ESC to close */
  useEffect(() => {
    const h = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  /* Lock body scroll */
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  /* Async: full game detail (hydrates hltb, steam_url, esrb, pc_requirements) */
  useEffect(() => {
    if (!cardGame?.id) return;
    let cancelled = false;
    setDataLoading(true);
    fetch(`${API_BASE}/games/${cardGame.id}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d) setFullGame(d); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setDataLoading(false); });
    return () => { cancelled = true; };
  }, [cardGame?.id]);

  /* Async: screenshots */
  useEffect(() => {
    if (!cardGame?.id) return;
    let cancelled = false;
    fetch(`${API_BASE}/games/${cardGame.id}/screenshots`)
      .then(r => r.ok ? r.json() : { results: [] })
      .then(d => {
        if (!cancelled) {
          const imgs = (d.results ?? []).slice(0, 8).map(s => s.image).filter(Boolean);
          setScreenshots(imgs);
          setImgLoading(false);
        }
      })
      .catch(() => { if (!cancelled) setImgLoading(false); });
    return () => { cancelled = true; };
  }, [cardGame?.id]);

  /* Async: DNA match — fires once we have genre_slugs */
  useEffect(() => {
    const slugs = game?.genre_slugs;
    if (!slugs?.length || !dnaWeights) { setDnaLoading(false); return; }
    let cancelled = false;
    fetch(`${API_BASE}/games/${game.id}/dna-match`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ dnaWeights, genreSlugs: slugs }),
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d) setDnaMatch(d); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setDnaLoading(false); });
    return () => { cancelled = true; };
  }, [game?.genre_slugs, dnaWeights]);

  const handleLibraryAction = useCallback((action) => {
    if (!game) return;
    const current   = library?.get(game.id);
    const newStatus = current?.status === action ? null : action;
    dispatch({ type: "SET_STATUS", gameId: game.id, game, status: newStatus });
    persistLibraryItem(MOCK_USER_ID, {
      game_id: game.id, game_name: game.name,
      genres: game.genre_slugs ?? [], rating: game.rating ?? 0,
      status: newStatus,
      is_liked: current?.isLiked ?? false,
      is_favorite: current?.isFavorite ?? false,
    });
    if (newStatus === "playing")  addToast(`🎮 Now playing: ${truncate(game.name, 18)}`, "playing");
    if (newStatus === "wishlist") addToast("Added to Wishlist!", "wishlist");
    if (newStatus === "played")   addToast("Nice! Marked as Played.", "played");
    if (!newStatus) addToast("Removed from library", "info");
  }, [game, library, dispatch, addToast]);

  const allImages = [
    ...(game?.background_image ? [game.background_image] : []),
    ...screenshots,
  ];

  if (!game) return null;

  const modalContent = (
    <motion.div
      className="gdm-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={onClose}
    >
      <motion.div
        className="gdm-panel"
        initial={{ opacity: 0, y: 32, scale: 0.96 }}
        animate={{ opacity: 1, y: 0,  scale: 1    }}
        exit={{    opacity: 0, y: 24, scale: 0.97  }}
        transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
        onClick={e => e.stopPropagation()}
      >
        {/* ── Hero Banner (16:9, gradient overlay, title inside) ── */}
        <div className="gdm-header">
          <div className="gdm-hero-wrap">
            {game.background_image && (
              <img src={game.background_image} alt={game.name} className="gdm-hero-img" />
            )}
            <div className="gdm-hero-overlay" />
            <div className="gdm-hero-content">
              <h2 className="gdm-title">{game.name}</h2>
              <div className="gdm-meta-row">
                {game.rating != null && (
                  <span className="gdm-rating" style={{ color: ratingColor(game.rating) }}>
                    <Star size={13} fill="currentColor" /> {game.rating.toFixed(1)}
                  </span>
                )}
                {game.released && (
                  <span className="gdm-released">
                    <Calendar size={12} /> {new Date(game.released).getFullYear()}
                  </span>
                )}
                {game.genres?.slice(0, 3).map(g => (
                  <span key={g} className="gdm-genre-tag">{g}</span>
                ))}
                {game.esrb_rating && game.esrb_rating !== "Not Rated" && (
                  <span className="gdm-esrb-chip">{game.esrb_rating}</span>
                )}
              </div>
            </div>
          </div>
          <button className="gdm-close-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {/* ── Two-column body ── */}
        <div className="gdm-body">

          {/* LEFT: Media + Description */}
          <div className="gdm-col-left">

            {/* Gallery */}
            <div className="gdm-gallery-section">
              {imgLoading ? (
                <div className="gdm-gallery-skeleton">
                  <div className="gdm-skel-main" />
                  <div className="gdm-skel-thumbs">
                    {[...Array(4)].map((_, i) => <div key={i} className="gdm-skel-thumb" />)}
                  </div>
                </div>
              ) : allImages.length > 0 ? (
                <div className="gdm-gallery">
                  <AnimatePresence mode="wait">
                    <motion.img
                      key={allImages[activeImg]}
                      src={allImages[activeImg]}
                      alt={`${game.name} screenshot ${activeImg + 1}`}
                      className="gdm-gallery-main"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.18 }}
                    />
                  </AnimatePresence>
                  {allImages.length > 1 && (
                    <>
                      <div className="gdm-gallery-thumbs">
                        {allImages.map((img, i) => (
                          <button
                            key={i}
                            className={`gdm-thumb-btn ${i === activeImg ? "gdm-thumb-btn--active" : ""}`}
                            onClick={() => setActiveImg(i)}
                          >
                            <img src={img} alt="" />
                          </button>
                        ))}
                      </div>
                      <div className="gdm-gallery-nav">
                        <button className="gdm-nav-btn" onClick={() => setActiveImg(i => (i - 1 + allImages.length) % allImages.length)}>
                          <ChevronLeft size={16} />
                        </button>
                        <span className="gdm-nav-count">{activeImg + 1} / {allImages.length}</span>
                        <button className="gdm-nav-btn" onClick={() => setActiveImg(i => (i + 1) % allImages.length)}>
                          <ChevronRight size={16} />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="gdm-no-images">
                  <ImageIcon size={28} opacity={0.2} />
                  <span>No screenshots available</span>
                </div>
              )}
            </div>

            {/* Description */}
            <div className="gdm-desc-section">
              {dataLoading && !game.description_raw ? (
                <div className="gdm-desc-skeleton">
                  {[...Array(4)].map((_, i) => (
                    <div key={i} className="gdm-skel-line" style={{ width: i === 3 ? "60%" : "100%" }} />
                  ))}
                </div>
              ) : game.description_raw ? (
                <p className="gdm-description">
                  {game.description_raw.slice(0, 700)}
                  {game.description_raw.length > 700 ? "…" : ""}
                </p>
              ) : (
                <p className="gdm-no-desc">No description available.</p>
              )}
            </div>

            {/* Tags */}
            {game.tags?.length > 0 && (
              <div className="gdm-tags-section">
                <span className="gdm-section-label">TAGS</span>
                <div className="gdm-tags">
                  {game.tags.slice(0, 10).map(t => (
                    <span key={t} className="gdm-tag">{t}</span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* RIGHT: Metadata sidebar */}
          <aside className="gdm-col-right">

            {/* DNA Compatibility Meter */}
            {dnaWeights && (
              <CompatibilityMeter
                match={dnaMatch?.match ?? 50}
                label={dnaMatch?.label ?? "Scanning…"}
                loading={dnaLoading}
              />
            )}

            {/* Library Actions */}
            <div className="gdm-actions">
              {[
                { key: "playing", Icon: Gamepad,  label: "Playing",  activeLabel: "Playing ✓" },
                { key: "wishlist", Icon: Bookmark, label: "Wishlist", activeLabel: "Wishlisted" },
                { key: "played",   Icon: Play,     label: "Played",   activeLabel: "Played ✓"  },
              ].map(({ key, Icon, label, activeLabel }) => (
                <button
                  key={key}
                  className={`gdm-action-btn ${status === key ? "gdm-action-btn--active" : ""}`}
                  onClick={() => handleLibraryAction(key)}
                >
                  <Icon size={13} />
                  <span>{status === key ? activeLabel : label}</span>
                  {status === key && <Check size={11} className="gdm-action-check" />}
                </button>
              ))}
            </div>

            {/* Like / Favorite */}
            <div className="gdm-social-btns">
              <button
                className={`gdm-icon-btn ${isLiked ? "gdm-icon-btn--liked" : ""}`}
                onClick={() => {
                  if (!game) return;
                  const c = library?.get(game.id);
                  dispatch({ type: "TOGGLE_LIKE", gameId: game.id, game });
                  const nowLiked = !(c?.isLiked ?? false);
                  persistLibraryItem(MOCK_USER_ID, {
                    game_id: game.id, game_name: game.name,
                    genres: game.genre_slugs ?? [], rating: game.rating ?? 0,
                    status: c?.status ?? null, is_liked: nowLiked,
                    is_favorite: c?.isFavorite ?? false,
                  });
                  addToast(nowLiked ? "DNA Pattern Updated! 🧬" : "Unliked", nowLiked ? "liked" : "info");
                }}
                aria-label="Like"
              >
                <Heart size={14} fill={isLiked ? "currentColor" : "none"} />
                <span>{isLiked ? "Liked" : "Like"}</span>
              </button>
              <button
                className={`gdm-icon-btn ${isFavorite ? "gdm-icon-btn--fav" : ""}`}
                onClick={() => {
                  if (!game) return;
                  const c = library?.get(game.id);
                  dispatch({ type: "TOGGLE_FAVORITE", gameId: game.id, game });
                  const nowFav = !(c?.isFavorite ?? false);
                  persistLibraryItem(MOCK_USER_ID, {
                    game_id: game.id, game_name: game.name,
                    genres: game.genre_slugs ?? [], rating: game.rating ?? 0,
                    status: c?.status ?? null,
                    is_liked: nowFav ? true : (c?.isLiked ?? false),
                    is_favorite: nowFav,
                  });
                  addToast(nowFav ? "Glitch noted your favorite! ⭐" : "Removed from favorites", nowFav ? "liked" : "info");
                }}
                aria-label="Favorite"
              >
                <Star size={14} fill={isFavorite ? "currentColor" : "none"} />
                <span>{isFavorite ? "Favorited" : "Favorite"}</span>
              </button>
            </div>

            {/* HLTB playtime boxes */}
            <HltbBoxes hltb={game.hltb} />

            {/* Tech Specs grid */}
            <TechGrid
              pcReqs={game.pc_requirements}
              developer={game.developers}
              esrb={game.esrb_rating}
              platforms={game.platforms}
            />

            {/* View on Steam */}
            {(game.steam_url || game.website) && (
              <a
                href={game.steam_url || game.website}
                target="_blank"
                rel="noopener noreferrer"
                className="gdm-steam-btn"
                onClick={e => e.stopPropagation()}
              >
                <ShoppingCart size={14} />
                <span>View on Steam</span>
                <ExternalLink size={12} className="gdm-steam-ext" />
              </a>
            )}

            {/* Trailer link */}
            {(game.trailer_url || game.clip?.clip) && (
              <a
                href={game.trailer_url || game.clip?.clip}
                target="_blank"
                rel="noopener noreferrer"
                className="gdm-trailer-btn"
                onClick={e => e.stopPropagation()}
              >
                <Play size={13} />
                <span>Watch Trailer</span>
                <ExternalLink size={12} />
              </a>
            )}

            {/* Publishers */}
            {game.publishers?.length > 0 && (
              <div className="gdm-publishers">
                <span className="gdm-sidebar-label">PUBLISHED BY</span>
                <span className="gdm-pub-name">{game.publishers.slice(0, 2).join(", ")}</span>
              </div>
            )}

          </aside>
        </div>
      </motion.div>
    </motion.div>
  );

  return reactDomPortal(modalContent, document.body);
}

/* ── Toast ───────────────────────────────────────────────────────────────────── */
function ToastContainer({ toasts }) {
  return (
    <div className="toast-container" aria-live="polite">
      <AnimatePresence>
        {toasts.map(t => (
          <motion.div key={t.id} className={`toast toast--${t.type}`}
            initial={{ opacity: 0, y: 20, scale: 0.92 }}
            animate={{ opacity: 1, y: 0,  scale: 1    }}
            exit={{    opacity: 0, y: -8, scale: 0.96  }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}>
            {t.type === "success"  && <CheckCircle2  size={15} />}
            {t.type === "wishlist" && <BookmarkCheck size={15} />}
            {t.type === "liked"    && <Heart         size={15} />}
            {t.type === "info"     && <Sparkles      size={15} />}
            {t.type === "played"   && <Play          size={15} />}
            {t.type === "playing"  && <Gamepad       size={15} />}
            {t.type === "xp"       && <Award         size={15} />}
            <span>{t.message}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/* ── Mesh gradient ───────────────────────────────────────────────────────────── */
function MeshGradient({ siteTint }) {
  const hue = siteTint ? parseInt(siteTint) || 220 : 220;
  return (
    <div className="mesh-gradient-bg" aria-hidden>
      <div className="mesh-orb mesh-orb--1" style={{ "--orb-hue": `${hue}deg` }} />
      <div className="mesh-orb mesh-orb--2" style={{ "--orb-hue": `${(hue + 60) % 360}deg` }} />
      <div className="mesh-orb mesh-orb--3" style={{ "--orb-hue": `${(hue + 180) % 360}deg` }} />
    </div>
  );
}

/* ── Year grouping ───────────────────────────────────────────────────────────── */
function groupGamesByYear(games) {
  const safe = Array.isArray(games) ? games : [];
  const byYear = {};
  for (const g of safe) {
    const y = g.released ? new Date(g.released).getFullYear() : "Unknown";
    (byYear[y] = byYear[y] || []).push(g);
  }
  return Object.keys(byYear)
    .sort((a, b) => (a === "Unknown" ? 1 : b === "Unknown" ? -1 : b - a))
    .map(year => {
      const list    = byYear[year];
      const byRat   = [...list].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
      const topHits = byRat.slice(0, 4);
      const topIds  = new Set(topHits.map(g => String(g.id)));
      const rest    = list
        .filter(g => !topIds.has(String(g.id)))
        .sort((a, b) => new Date(b.released || 0) - new Date(a.released || 0));
      return { year, topHits, rest };
    });
}

/* ════════════════════════════════════════════════════════════════════════════
   ACCORDION SECTION
   ════════════════════════════════════════════════════════════════════════════ */
function AccordionSection({ label, defaultOpen = true, children, badge, className = "" }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`sb-accordion ${className}`}>
      <button
        className={`sb-accordion-header ${open ? "sb-accordion-header--open" : ""}`}
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}>
        <span className="sb-accordion-label">{label}</span>
        {badge && <span className="sb-accordion-badge">{badge}</span>}
        <motion.span className="sb-accordion-chevron"
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.22, ease: [0.16,1,0.3,1] }}>
          <ChevronDown size={12} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="sb-accordion-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{    height: 0, opacity: 0 }}
            transition={{ duration: 0.26, ease: [0.16,1,0.3,1] }}
            style={{ overflow: "hidden" }}>
            <div className="sb-accordion-content">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   NESTED FILTER TAG
   ════════════════════════════════════════════════════════════════════════════ */
function FilterTag({ label, subTags = [], colorClass = "", onRemoveAll, onRemoveSub }) {
  const [expanded, setExpanded] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!expanded) return;
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setExpanded(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [expanded]);
  const handleKeyDown = e => {
    if (e.key === "Escape") setExpanded(false);
    if ((e.key === "Enter" || e.key === " ") && !expanded) { e.preventDefault(); setExpanded(true); }
  };
  return (
    <div ref={ref} className={`filter-tag-wrap ${colorClass}`}>
      <div className="filter-tag">
        <button className="filter-tag__label"
          onClick={() => setExpanded(v => !v)} onKeyDown={handleKeyDown}
          aria-expanded={expanded}>
          <span>{label}</span>
          {subTags.length > 1 && <span className="filter-tag__count">{subTags.length}</span>}
          <motion.span animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.15 }}>
            <ChevronDown size={10} />
          </motion.span>
        </button>
        <button className="filter-tag__remove" onClick={onRemoveAll} aria-label={`Remove all ${label} filters`}>
          <X size={9} />
        </button>
      </div>
      <AnimatePresence>
        {expanded && subTags.length > 0 && (
          <motion.div className="filter-subtags"
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0,  scale: 1    }}
            exit={{    opacity: 0, y: -4, scale: 0.97  }}
            transition={{ duration: 0.18, ease: [0.16,1,0.3,1] }}>
            {subTags.map(st => (
              <span key={st.id} className="filter-subtag">
                <span className="filter-subtag__label">{st.label}</span>
                <button className="filter-subtag__remove" onClick={() => onRemoveSub(st.id)}
                  aria-label={`Remove ${st.label} filter`}><X size={8} /></button>
              </span>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   HUB CARD — selectable item inside the filter drawer
   ════════════════════════════════════════════════════════════════════════════ */
function HubCard({ item, isSelected, onSelect }) {
  const games = item.popular_games ?? [];
  return (
    <motion.button
      className={`hub-card ${isSelected ? "hub-card--selected" : ""}`}
      onClick={() => onSelect(item)}
      whileHover={{ y: -2, scale: 1.012 }}
      whileTap={{ scale: 0.97 }}
      layout
      transition={{ duration: 0.14 }}>

      {isSelected && (
        <motion.div className="hub-card__selected-badge"
          initial={{ scale: 0 }} animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 500, damping: 22 }}>
          <Check size={10} strokeWidth={3} />
        </motion.div>
      )}

      <div className="hub-card__header">
        {item.logo ? (
          <img src={item.logo} alt={item.name} className="hub-card__logo" loading="lazy" />
        ) : (
          <div className="hub-card__logo-fallback">{item.name.slice(0, 2).toUpperCase()}</div>
        )}
        <div className="hub-card__meta">
          <h3 className="hub-card__name">{truncate(item.name, 26)}</h3>
          {item.game_count != null && (
            <span className="hub-card__count">{item.game_count.toLocaleString()} games</span>
          )}
          {item.rating != null && (
            <span className="hub-card__rating" style={{ color: ratingColor(item.rating) }}>
              <Star size={10} fill="currentColor" /> {item.rating.toFixed(1)}
            </span>
          )}
        </div>
      </div>

      {item.description && <p className="hub-card__desc">{truncate(item.description, 72)}</p>}

      {games.length > 0 && (
        <div className="hub-card__games">
          {games.map(g => (
            <div key={g.id} className="hub-card__game-teaser" title={g.name}>
              {g.image ? (
                <img src={g.image} alt={g.name} className="hub-card__game-thumb" loading="lazy" />
              ) : (
                <div className="hub-card__game-thumb hub-card__game-thumb--fallback">
                  <Gamepad2 size={11} opacity={0.4} />
                </div>
              )}
              <span className="hub-card__game-name">{truncate(g.name, 14)}</span>
            </div>
          ))}
        </div>
      )}
    </motion.button>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   FILTER DRAWER
   ════════════════════════════════════════════════════════════════════════════ */
function FilterDrawer({ portalTarget, activeFilters, onApplySelections, onClose }) {
  const { items, loading, error, refetch } = useHubData(portalTarget);
  const [searchLocal, setSearchLocal] = useState("");
  const searchInputRef = useRef(null);

  const filterKey = PORTAL_FILTER_MAP[portalTarget] ?? portalTarget;

  const [staged, setStaged] = useState(() => {
    if (filterKey === "genres") {
      const merged = new Map([...(activeFilters.genres || []), ...(activeFilters.themes || [])]);
      return merged;
    }
    return new Map(activeFilters[filterKey] ?? new Map());
  });

  useEffect(() => { setTimeout(() => searchInputRef.current?.focus(), 80); }, [portalTarget]);

  const visible = useMemo(() => {
    const q = searchLocal.toLowerCase().trim();
    if (!q) return items;
    return items.filter(i => i.name?.toLowerCase().includes(q) || i.description?.toLowerCase().includes(q));
  }, [items, searchLocal]);

  const handleToggle = (item) => {
    setStaged(prev => {
      const next = new Map(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, { id: item.id, name: item.name, type: item.type });
      return next;
    });
  };

  const filterItem = BROWSE_ITEMS.find(f => f.id === portalTarget);
  const Icon = filterItem?.Icon ?? Layers;

  return (
    <>
      <motion.div className="filter-drawer-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div className="filter-drawer-panel" initial={{ x: -40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -40, opacity: 0 }} transition={{ type: "spring", stiffness: 360, damping: 34 }}>

        <div className="fp-header">
          <div className="fp-header-left">
            <div className="fp-icon-wrap"><Icon size={18} /></div>
            <div>
              <h2 className="fp-title">{filterItem?.label} <span className="fp-active-count">{staged.size} selected</span></h2>
              <p className="fp-subtitle">Select multiple items then hit Apply</p>
            </div>
          </div>
          <button className="fp-close-btn" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="fp-search-wrap">
          <Search size={13} className="fp-search-icon" />
          <input ref={searchInputRef} type="text" value={searchLocal} onChange={e => setSearchLocal(e.target.value)}
            placeholder={`Search ${filterItem?.label}…`} className="fp-search-input" />
        </div>

        <div className="fp-body">
          {loading ? <div className="fp-state"><Loader2 size={28} className="spin" /></div> : (
            <motion.div className="fp-grid" variants={bootGrid} initial="hidden" animate="visible">
              {visible.map(item => (
                <motion.div key={item.id} variants={bootCard}>
                  <HubCard item={item} isSelected={staged.has(item.id)} onSelect={() => handleToggle(item)} />
                </motion.div>
              ))}
            </motion.div>
          )}
        </div>

        <div className="fp-footer">
          <button className="fp-cancel-btn" onClick={onClose}>Cancel</button>
          <button className="fp-apply-btn" onClick={() => { onApplySelections(filterKey, staged); onClose(); }}>
            <Check size={16} strokeWidth={3} />
            Apply Filters
          </button>
        </div>
      </motion.div>
    </>
  );
}

/* ── Entry Page ──────────────────────────────────────────────────────────────── */
function EntryPage({ onEnter }) {
  const tags = ["DISCOVER.", "EXPLORE.", "CONQUER."];
  const [ti, setTi] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTi(i => (i + 1) % tags.length), 2200);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="entry-page">
      <div className="entry-grid-bg" /><div className="entry-scanline" />
      <motion.div className="entry-content"
        initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}>
        <div className="entry-logo-mark"><Gamepad2 size={28} /></div>
        <h1 className="entry-headline">
          GAME<br /><span className="entry-headline-accent">DISCOVERY</span><br />ENGINE
        </h1>
        <div className="entry-tagline-wrap">
          <AnimatePresence mode="wait">
            <motion.span key={ti} className="entry-tagline"
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.4 }}>
              {tags[ti]}
            </motion.span>
          </AnimatePresence>
        </div>
        <p className="entry-sub">AI-Personalised · <strong>Gamer DNA</strong> · Meet <strong>Glitch</strong></p>
        <div className="entry-actions">
          {[
            { label: "Login",             Icon: LogIn,    v: "primary",   a: "login"    },
            { label: "Register",          Icon: UserPlus, v: "secondary", a: "register" },
            { label: "Continue as Guest", Icon: User,     v: "ghost",     a: "guest"    },
          ].map(({ label, Icon, v, a }, i) => (
            <motion.button key={a} className={`entry-btn entry-btn--${v}`} onClick={() => onEnter(a)}
              initial={{ opacity: 0, x: -24 }} animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.5 + i * 0.12, duration: 0.5, ease: [0.16,1,0.3,1] }}
              whileHover={{ scale: 1.03, x: 6 }} whileTap={{ scale: 0.97 }}>
              <Icon size={18} /><span>{label}</span><ChevronRight size={16} className="btn-arrow" />
            </motion.button>
          ))}
        </div>
        <p className="entry-footer-note">Powered by <span className="accent-text">IGDB API</span> · SVM AI · Glitch ™</p>
      </motion.div>
      <div className="entry-deco">
        {[...Array(3)].map((_, i) => (
          <motion.div key={i} className={`deco-card deco-card--${i}`}
            animate={{ y: [0, -12, 0] }}
            transition={{ duration: 4 + i, repeat: Infinity, ease: "easeInOut", delay: i * 1.1 }} />
        ))}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   QUICK MENU — portal-based so it never clips under cards
   ════════════════════════════════════════════════════════════════════════════ */
function QuickMenu({ game, entry, onAction, onClose, anchorRect }) {
  const ref = useRef(null);

  useEffect(() => {
    const handleScroll = () => {
      onClose();
    };
    window.addEventListener("scroll", handleScroll, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [onClose]);

  useEffect(() => {
    const h = e => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [onClose]);

  /* Position above the anchor button, fixed to viewport */
  const style = anchorRect ? {
    position: "fixed",
    top: anchorRect.bottom + 8,
    left: Math.min(anchorRect.left, window.innerWidth - 180), 
    zIndex: 10000,
    width: "160px", 
  } : { position: "fixed", top: "50%", left: "50%", zIndex: 10000, width: "160px" };

  const status = entry?.status;

  const menuContent = (
    <motion.div ref={ref} className="quick-menu" style={style}
      style={{ ...style, overflow: 'hidden' }}
      initial={{ opacity: 0, scale: 0.88, y: 6 }}
      animate={{ opacity: 1, scale: 1,    y: 0  }}
      exit={{    opacity: 0, scale: 0.88, y: 6  }}
      transition={{ type: "spring", stiffness: 420, damping: 28 }}>
      {[
        { action: "playing",  Icon: Gamepad,  label: status === "playing"  ? "Stop Playing"        : "Mark as Playing", active: status === "playing"  },
        { action: "wishlist", Icon: Bookmark, label: status === "wishlist" ? "Remove from Wishlist" : "Add to Wishlist", active: status === "wishlist" },
        { action: "played",   Icon: Play,     label: status === "played"   ? "Unmark Played"        : "Mark as Played",  active: status === "played"   },
      ].map(({ action, Icon, label, active }) => (
        <button key={action}
          className={`quick-menu-item ${active ? "quick-menu-item--active" : ""}`}
          onClick={e => { e.stopPropagation(); onAction(game, action); onClose(); }}>
          <Icon size={13} /><span>{label}</span>
          {active && <Check size={11} className="qm-check" />}
        </button>
      ))}
    </motion.div>
  );

  return reactDomPortal(menuContent, document.body);
}

/* ── Game Card ───────────────────────────────────────────────────────────────── */
function GameCard({
  game, onOpenOverlay, entry, onLibraryAction, onLike, onFavorite,
  isTopHit = false, bootAnim = false, suppressRating = false,
}) {
  const [menuOpen,   setMenuOpen]   = useState(false);
  const [anchorRect, setAnchorRect] = useState(null);
  const [hoverIdx,   setHoverIdx]   = useState(0);
  const [hoverImgs,  setHoverImgs]  = useState([]);
  const [isHovering, setIsHovering] = useState(false);
  const fetchedRef = useRef(false);

  const status       = entry?.status;
  const isWishlisted = status === "wishlist";
  const isPlayed     = status === "played";
  const isPlaying    = status === "playing";
  const isLiked      = entry?.isLiked    ?? false;
  const isFavorite   = entry?.isFavorite ?? false;
  const showNew      = isNewRelease(game.released);

  const handleMouseEnter = useCallback(async () => {
    setIsHovering(true);
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    try {
      const res  = await fetch(`${API_BASE}/games/${game.id}/screenshots`);
      if (!res.ok) return;
      const data = await res.json();
      const imgs = (data.results ?? []).slice(0, 5).map(s => s.image).filter(Boolean);
      if (imgs.length > 0) setHoverImgs(imgs);
    } catch {}
  }, [game.id]);

  const handleMouseLeave  = useCallback(() => { setIsHovering(false); setHoverIdx(0); }, []);
  const handleMouseMove   = e => {
    if (!hoverImgs.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x    = e.clientX - rect.left;
    setHoverIdx(Math.max(0, Math.min(Math.floor(x / (rect.width / (hoverImgs.length + 1))), hoverImgs.length)));
  };

  const displayImg = (isHovering && hoverIdx > 0 && hoverImgs[hoverIdx - 1])
    ? hoverImgs[hoverIdx - 1] : game.background_image;
  const topTags = game.tags?.slice(0, 5) ?? [];
  const hasMeta = game.developer || game.released || topTags.length > 0;

  const handlePlusClick = e => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setAnchorRect(rect);
    setMenuOpen(v => !v);
  };

  const cardContent = (
    <motion.article
      className={`game-card${isTopHit ? " game-card--top-hit" : ""}${isHovering ? " game-card--expanded" : ""}`}
      layout
      whileHover={{ y: -4, scale: 1.015 }}
      whileTap={{ scale: 0.98 }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={() => onOpenOverlay(game)}
      style={{ cursor: "pointer" }}
      transition={{ layout: { duration: 0.2 }, default: { duration: 0.15 } }}>

      {game.svm_score != null && <div className="card-svm-dot" title={`SVM ${(game.svm_score * 100).toFixed(0)}%`} />}
      {isTopHit && !suppressRating && <div className="card-top-hit-badge"><Star size={9} fill="currentColor" /> Top Hit</div>}

      <div className="card-image-wrap">
        {isHovering && hoverImgs.length > 0 && (
          <div className="card-hover-hotzone" onMouseMove={handleMouseMove} onMouseLeave={() => setHoverIdx(0)} />
        )}
        {isHovering && hoverImgs.length > 0 && (
          <div className="card-hover-bar">
            {[...Array(hoverImgs.length + 1)].map((_, i) => (
              <div key={i} className={`card-hover-segment ${i === hoverIdx ? "active" : ""}`} />
            ))}
          </div>
        )}
        <AnimatePresence mode="wait">
          <motion.img key={displayImg} src={displayImg} alt={game.name} className="card-image" loading="lazy"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} />
        </AnimatePresence>
        {!displayImg && <div className="card-image card-image--fallback"><Gamepad2 size={40} opacity={0.3} /></div>}
        <div className="card-image-overlay" />
        {showNew && <div className="card-new-badge">NEW</div>}
        {isPlaying    && <div className="card-status-badge card-status-badge--playing"><Gamepad size={9} /> Playing</div>}
        {isWishlisted && !isPlaying && <div className="card-status-badge"><Bookmark size={9} /> Wishlist</div>}
        {isPlayed && !isPlaying && !isWishlisted && <div className="card-status-badge card-status-badge--played"><Play size={9} /> Played</div>}

        <div className="card-actions">
          <motion.button className={`card-action-btn card-star-btn ${isFavorite ? "card-star-btn--active" : ""}`}
            onClick={e => { e.stopPropagation(); onFavorite(game); }}
            whileHover={{ scale: 1.18 }} whileTap={{ scale: 0.88 }}>
            <Star size={12} fill={isFavorite ? "currentColor" : "none"} strokeWidth={2} />
          </motion.button>
          <motion.button className={`card-action-btn card-like-btn ${isLiked ? "card-like-btn--active" : ""}`}
            onClick={e => { e.stopPropagation(); onLike(game); }}
            whileHover={{ scale: 1.18 }} whileTap={{ scale: 0.88 }}>
            <Heart size={13} fill={isLiked ? "currentColor" : "none"} strokeWidth={2} />
          </motion.button>
          <div className="card-quick-add-wrap">
            <motion.button
              className={`card-action-btn card-plus-btn ${(isWishlisted || isPlayed || isPlaying) ? "card-plus-btn--active" : ""}`}
              onClick={handlePlusClick}
              whileHover={{ scale: 1.18 }} whileTap={{ scale: 0.88 }}>
              <AnimatePresence mode="wait" initial={false}>
                {(isWishlisted || isPlayed || isPlaying)
                  ? <motion.span key="c" initial={{ rotate:-45,opacity:0 }} animate={{ rotate:0,opacity:1 }} exit={{ rotate:45,opacity:0 }} transition={{ duration:0.16 }}><Check size={13} strokeWidth={3} /></motion.span>
                  : <motion.span key="p" initial={{ rotate:45,opacity:0 }} animate={{ rotate:0,opacity:1 }} exit={{ rotate:-45,opacity:0 }} transition={{ duration:0.16 }}><Plus size={13} strokeWidth={2.5} /></motion.span>
                }
              </AnimatePresence>
            </motion.button>
            <AnimatePresence>
              {menuOpen && (
                <QuickMenu
                  game={game}
                  entry={entry}
                  onAction={onLibraryAction}
                  onClose={() => setMenuOpen(false)}
                  anchorRect={anchorRect}
                />
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      <div className="card-body">
        <h3 className="card-title">{truncate(game.name, 42)}</h3>
        <div className="card-meta">
          {game.genres?.slice(0, 2).map(g => <span key={g} className="card-genre-tag">{g}</span>)}
        </div>
        <div className="card-footer">
          {!suppressRating && (
            <div className="card-rating" style={{ color: ratingColor(game.rating) }}>
              <Star size={13} fill="currentColor" /><span>{game.rating?.toFixed(1) ?? "—"}</span>
            </div>
          )}
          {game.released && <span className="card-released">{new Date(game.released).getFullYear()}</span>}
        </div>
      </div>

      <AnimatePresence>
        {isHovering && hasMeta && (
          <motion.div className="card-meta-expand"
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.18 }}>
            {game.developer && <p className="cme-row"><span className="cme-key">Dev</span><span className="cme-val">{truncate(game.developer, 22)}</span></p>}
            {game.released  && <p className="cme-row"><span className="cme-key">Released</span><span className="cme-val">{game.released}</span></p>}
            {topTags.length > 0 && <div className="cme-tags">{topTags.map(t => <span key={t} className="cme-tag">{t}</span>)}</div>}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.article>
  );

  return bootAnim
    ? <motion.div variants={bootCard} style={{ display: "contents" }}>{cardContent}</motion.div>
    : cardContent;
}

/* ── Year-Grouped Grid ───────────────────────────────────────────────────────── */
function YearGroupedGrid({ games, library, onOpenOverlay, sharedCard, showGrouped, isFirstLoad, yearRefs }) {
  const safeLib   = library instanceof Map ? library : new Map();
  const safeGames = Array.isArray(games) ? games : [];
  if (!showGrouped) {
    return (
      <motion.div className="game-grid"
        variants={isFirstLoad ? bootGrid : undefined}
        initial={isFirstLoad ? "hidden" : false}
        animate={isFirstLoad ? "visible" : false}>
        {safeGames.map(game => (
          <GameCard key={game.id} game={game} onOpenOverlay={onOpenOverlay}
            entry={safeLib.get(game.id)} {...sharedCard} bootAnim={isFirstLoad} />
        ))}
      </motion.div>
    );
  }
  const groups = groupGamesByYear(safeGames);
  if (!groups.length) return null;
  return (
    <div className="year-grouped-grid">
      {groups.map(({ year, topHits, rest }) => (
        <div key={year} className="year-group"
          ref={el => { if (yearRefs) yearRefs.current[year] = el; }}>
          <div className="year-group-header">
            <span className="year-group-label">{year} RELEASES</span>
            <div className="year-group-line" />
          </div>
          {topHits.length > 0 && (
            <>
              <div className="year-subheader"><Star size={10} className="year-subheader-icon" /><span>TOP HITS</span></div>
              <motion.div className="game-grid game-grid--top-hits"
                variants={isFirstLoad ? bootGrid : undefined}
                initial={isFirstLoad ? "hidden" : false}
                animate={isFirstLoad ? "visible" : false}>
                {topHits.map(game => (
                  <GameCard key={game.id} game={game} onOpenOverlay={onOpenOverlay}
                    entry={safeLib.get(game.id)} {...sharedCard} isTopHit bootAnim={isFirstLoad} />
                ))}
              </motion.div>
            </>
          )}
          {rest.length > 0 && (
            <motion.div className="game-grid"
              variants={isFirstLoad ? bootGrid : undefined}
              initial={isFirstLoad ? "hidden" : false}
              animate={isFirstLoad ? "visible" : false}>
              {rest.map(game => (
                <GameCard key={game.id} game={game} onOpenOverlay={onOpenOverlay}
                  entry={safeLib.get(game.id)} {...sharedCard} bootAnim={isFirstLoad} />
              ))}
            </motion.div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   TRENDING ROW
   Props:
     title     — row heading (default "Trending Now")
     subtitle  — secondary label (default "Most Anticipated")
     endpoint  — API path, e.g. "/api/games?awaited=true" (default hypes)
   ════════════════════════════════════════════════════════════════════════════ */
function TrendingRow({
  title    = "Trending Now",
  subtitle = "Most Anticipated",
  endpoint = "/api/games?page_size=16&ordering=-hypes",
  onOpenOverlay, library, onLibraryAction, onLike, onFavorite,
}) {
  const [games,   setGames]   = useState([]);
  const [loading, setLoading] = useState(true);
  const listRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setGames([]);
    // Normalise endpoint — strip leading /api if API_BASE already ends with /api
    const url = endpoint.startsWith("http")
      ? endpoint
      : `${API_BASE}${endpoint.replace(/^\/api/, "")}`;
    fetch(url)
      .then(r => r.ok ? r.json() : { results: [] })
      .then(d => { if (!cancelled) { setGames(Array.isArray(d.results) ? d.results : []); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [endpoint]);

  const scroll = dir => listRef.current?.scrollBy({ left: dir * 480, behavior: "smooth" });
  if (loading || !games.length) return null;

  return (
    <div className="trending-row">
      <div className="trending-header">
        <Flame size={14} className="trending-icon" />
        <span className="trending-title">{title}</span>
        <span className="trending-sub">{subtitle}</span>
        <div className="trending-nav">
          <button className="trending-nav-btn" onClick={() => scroll(-1)}><ChevronLeft size={15} /></button>
          <button className="trending-nav-btn" onClick={() => scroll(1)}><ChevronRight size={15} /></button>
        </div>
      </div>
      <div className="trending-list" ref={listRef}>
        {games.map(game => (
          <div key={game.id} className="trending-card-wrapper">
            <GameCard game={game} onOpenOverlay={onOpenOverlay}
              entry={library?.get(game.id)}
              onLibraryAction={onLibraryAction}
              onLike={onLike} onFavorite={onFavorite} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Persistent Header ───────────────────────────────────────────────────────── */
function PersistentHeader({
  view, corrupted, isLoggedIn, userMode, level, title,
  searchInput, setSearchInput,
  onSearch, onClearSearch,
  onNavigateLibrary, onNavigateDashboard, onLogout,
  wishlistCount, likedCount, playedCount, playingCount,
  svmMode, isDiscoveryActive, isFirstLoad, searchRef,
}) {
  const isLibrary = view === "library";
  const isMax     = level >= 20;
  return (
    <motion.header className="dash-header"
      variants={isFirstLoad ? bootMain : undefined}
      initial={isFirstLoad ? "hidden" : false}
      animate={isFirstLoad ? "visible" : false}>
      <div className="dash-header-left">
        <button className="header-logo-btn" onClick={onNavigateDashboard}>
          <Gamepad2 size={22} className="header-icon" />
          <span className="header-title">
            {corrupted ? "GL1TCH_ENGINE" : isLibrary ? "My Library" : "Game Discovery"}
          </span>
        </button>
        {isLoggedIn && (
          <span className={`header-badge ${isMax ? "header-badge--max" : ""}`}>
            {isMax ? "👑 Glitch Prime" : `Glitch ${title}`}
          </span>
        )}
        <AnimatePresence>
          {isDiscoveryActive && svmMode !== "raw" && (
            <motion.span
              className={`header-badge ${svmMode === "svm" ? "header-badge--svm" : "header-badge--cold"}`}
              initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.7, opacity: 0 }}>
              <Sparkles size={10} /> {svmMode === "svm" ? "DNA Ranked" : "Top Rated"}
            </motion.span>
          )}
        </AnimatePresence>
      </div>
      <motion.form className="search-form" onSubmit={onSearch}
        animate={isLibrary ? { opacity: 0, y: -8, pointerEvents: "none" } : { opacity: 1, y: 0, pointerEvents: "auto" }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        aria-hidden={isLibrary}>
        <Search size={16} className="search-icon" />
        <input ref={searchRef} type="text"
          placeholder='Search games… ("/" to focus)'
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          className="search-input" />
        {searchInput && <button type="button" className="search-clear" onClick={onClearSearch}><X size={14} /></button>}
        <button type="submit" className="search-submit">Search</button>
      </motion.form>
      <div className="dash-header-right">
        <span className="header-user-mode"><User size={14} />{isLoggedIn ? userMode : "Guest"}</span>
        <button className="header-icon-btn" onClick={onNavigateLibrary} aria-label="Library">
          <Library size={17} />
          {(wishlistCount + likedCount + playedCount + playingCount) > 0 && (
            <motion.span className="header-count-badge"
              key={wishlistCount + likedCount + playedCount + playingCount}
              initial={{ scale: 1.4 }} animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 400, damping: 18 }}>
              {wishlistCount + likedCount + playedCount + playingCount}
            </motion.span>
          )}
        </button>
        <button className="header-icon-btn" onClick={onLogout} title="Logout"><LogOut size={17} /></button>
      </div>
    </motion.header>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   DASHBOARD
   ════════════════════════════════════════════════════════════════════════════ */
function Dashboard({
  userMode, isLoggedIn,
  library, dispatch, addToast,
  onLogout, onNavigateLibrary,
  dnaWeights, onDnaWeightsChange,
  dnaOffsets,
  xp, onXpGain,
  muted, corrupted, siteTint, onSiteTintChange,
  isFirstLoad,
  searchInput, setSearchInput,
  searchQuery, setSearchQuery,
  searchRef,
  svmMode, setSvmMode,
  onOverlayOpen,
}) {
  const safeLibrary = useMemo(
    () => (library instanceof Map ? library : new Map()),
    [library]
  );

  const [portalTarget,  setPortalTarget]  = useState(null);
  const [activeSection, setActiveSection] = useState("");
  const [yearFilter,    setYearFilter]    = useState("all");
  const scrollRef   = useRef(null);
  const sentinelRef = useRef(null);
  const yearRefs    = useRef({});

  const [activeFilters, setActiveFilters] = useState(emptyFilters());

  const isDiscovery = activeSection === DISCOVERY_SLUG;
  const isTimeline  = activeSection === TIMELINE_LATEST || activeSection === TIMELINE_UPCOMING;
  const isFreeGames = activeSection === FREE_GAMES_SLUG;
  const isRetro     = activeSection === RETRO_CLASSICS_SLUG;
  const isTop       = activeSection === TOP_2026_SLUG || activeSection === POPULAR_2025_SLUG || activeSection === ALL_TIME_SLUG;
  const canGroup    = !isDiscovery && !isFreeGames && !searchQuery && !isTop;
  const showGrouped = canGroup && yearFilter === "all";

  const activeGenre = (isDiscovery || isTimeline || isFreeGames || isRetro || isTop) ? "" : activeSection;
  const apiParams   = sectionToApiParams(activeSection);
  const userId      = isLoggedIn ? MOCK_USER_ID : "";
  const level       = getLevel(xp);

  const platformIds = useMemo(() => Array.from(activeFilters.platforms?.keys() ?? []), [activeFilters]);
  const genreIds    = useMemo(() => Array.from(activeFilters.genres?.keys()    ?? []), [activeFilters]);
  const companyIds  = useMemo(() => [], []);
  const themeIds    = useMemo(() => Array.from(activeFilters.themes?.keys()    ?? []), [activeFilters]);
  const yearParam   = useMemo(() => Array.from(activeFilters.years?.keys() ?? []).join(","), [activeFilters]);

  const totalFilterCount = useMemo(() =>
    Object.values(activeFilters).reduce((acc, m) => acc + (m?.size ?? 0), 0),
    [activeFilters]
  );

  const {
    games: rawGames, loading, loadingMore, error,
    hasMore, loadMore, svmMode: fetchedSvmMode, retry, refresh,
  } = useInfiniteGames({
    searchQuery,
    genre: activeGenre,
    userId,
    dnaWeights: isDiscovery ? dnaWeights : null,
    discoveryMode: isDiscovery && isLoggedIn,
    ordering: apiParams.ordering,
    metacritic: apiParams.metacritic,
    dates: apiParams.dates ?? "",
    tags: apiParams.tags ?? "",
    platformIds,
    genreIds,
    companyIds,
    themeIds,
    collectionIds: [],
    year: yearParam,
    excludeIds: isDiscovery ? Array.from(safeLibrary.keys()) : [],
  });

  useEffect(() => { setSvmMode(fetchedSvmMode); }, [fetchedSvmMode, setSvmMode]);

  const allGames = Array.isArray(rawGames) ? rawGames : [];
  const games = useMemo(() => {
    if (yearFilter === "all") return allGames;
    return allGames.filter(g => g.released && new Date(g.released).getFullYear() === Number(yearFilter));
  }, [allGames, yearFilter]);

  const availableYears = useMemo(() => {
    const y = new Set(allGames.map(g => g.released ? new Date(g.released).getFullYear() : null).filter(Boolean));
    return [...y].sort((a, b) => b - a);
  }, [allGames]);

  const entries       = useMemo(() => Array.from(safeLibrary.values()), [safeLibrary]);
  const wishlistCount = useMemo(() => entries.filter(e => e.status === "wishlist").length, [entries]);
  const playedCount   = useMemo(() => entries.filter(e => e.status === "played").length, [entries]);
  const playingCount  = useMemo(() => entries.filter(e => e.status === "playing").length, [entries]);
  const likedCount    = useMemo(() => entries.filter(e => e.isLiked).length, [entries]);

  /* Reset scroll on section / filter change */
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTo({ top: 0, behavior: "instant" });
  }, [activeSection, searchQuery, activeFilters]);

  /* Infinite scroll */
  useEffect(() => {
    const s = sentinelRef.current, r = scrollRef.current;
    if (!s || !r) return;
    const obs = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting && hasMore && !loading && !loadingMore) loadMore(); },
      { root: r, rootMargin: "0px 0px 140px 0px", threshold: 0 }
    );
    obs.observe(s);
    return () => obs.disconnect();
  }, [hasMore, loading, loadingMore, loadMore]);

  /* "/" shortcut */
  useEffect(() => {
    const h = e => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault(); searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [searchRef]);

  const clearSearch  = () => { setSearchInput(""); setSearchQuery(""); };
  const clearFilters = useCallback(() => setActiveFilters(emptyFilters()), []);

  const handleBrowseFeed = useCallback(() => {
    setActiveSection("");
    setSearchInput("");
    setSearchQuery("");
    setActiveFilters(emptyFilters());
    setPortalTarget(null);
    setYearFilter("all");
    if (scrollRef.current) scrollRef.current.scrollTo({ top: 0, behavior: "instant" });
  }, [setSearchInput, setSearchQuery]);

  const handleSection = useCallback(slug => {
    setActiveSection(slug);
    setSearchInput("");
    setSearchQuery("");
    setYearFilter("all");
    setPortalTarget(null);
    if (scrollRef.current) scrollRef.current.scrollTo({ top: 0, behavior: "instant" });
  }, [setSearchInput, setSearchQuery]);

  const handleFilterPortal = useCallback(targetId => {
    setPortalTarget(prev => prev === targetId ? null : targetId);
  }, []);

  const scrollToYear = useCallback(year => {
    const el = yearRefs.current[year];
    if (el && scrollRef.current) scrollRef.current.scrollTo({ top: el.offsetTop - 20, behavior: "smooth" });
  }, []);

  const syncDNA = useCallback(lib => {
    onDnaWeightsChange(applyDnaOffsets(lib, dnaOffsets));
  }, [onDnaWeightsChange, dnaOffsets]);

  /* Library handlers */
  const handleLibraryAction = useCallback((game, action) => {
    const current   = safeLibrary.get(game.id);
    const newStatus = current?.status === action ? null : action;
    dispatch({ type: "SET_STATUS", gameId: game.id, game, status: newStatus });
    const next = new Map(safeLibrary);
    next.set(game.id, { ...(current ?? { game, isLiked: false, isFavorite: false, playtime: 0 }), status: newStatus });
    syncDNA(next);
    persistLibraryItem(MOCK_USER_ID, { game_id: game.id, game_name: game.name, genres: game.genre_slugs ?? [], rating: game.rating ?? 0, status: newStatus, is_liked: current?.isLiked ?? false, is_favorite: current?.isFavorite ?? false });
    if (newStatus === "playing")  { addToast(`🎮 Now playing: ${truncate(game.name, 18)}`, "playing", `play:${game.id}`); onXpGain(XP_EVENTS.playing, game.id, "playing"); }
    if (newStatus === "wishlist") { addToast("Added to Wishlist!", "wishlist", `wl:${game.id}`); onXpGain(XP_EVENTS.wishlist, game.id, "wishlist"); }
    if (newStatus === "played")   { addToast("Nice! Marked as Played.", "played", `pl:${game.id}`); onXpGain(XP_EVENTS.played, game.id, "played"); }
    if (!newStatus) addToast("Removed from library", "info", `rm:${game.id}:${Date.now()}`);
  }, [safeLibrary, dispatch, addToast, onXpGain, syncDNA]);

  const handleLike = useCallback(game => {
    const c = safeLibrary.get(game.id);
    const nowLiked = !(c?.isLiked ?? false);
    dispatch({ type: "TOGGLE_LIKE", gameId: game.id, game });
    const n = new Map(safeLibrary);
    n.set(game.id, { ...(c ?? { game, status: null, isFavorite: false, playtime: 0 }), isLiked: nowLiked, isFavorite: nowLiked ? (c?.isFavorite ?? false) : false });
    syncDNA(n);
    persistLibraryItem(MOCK_USER_ID, { game_id: game.id, game_name: game.name, genres: game.genre_slugs ?? [], rating: game.rating ?? 0, status: c?.status ?? null, is_liked: nowLiked, is_favorite: nowLiked ? (c?.isFavorite ?? false) : false });
    if (nowLiked) { addToast("DNA Pattern Updated! 🧬", "liked", `like:${game.id}`); onXpGain(XP_EVENTS.like, game.id, "like"); }
    else addToast("Unliked", "info", `unlike:${game.id}`);
  }, [safeLibrary, dispatch, addToast, onXpGain, syncDNA]);

  const handleFavorite = useCallback(game => {
    const c = safeLibrary.get(game.id);
    const nowFav = !(c?.isFavorite ?? false);
    dispatch({ type: "TOGGLE_FAVORITE", gameId: game.id, game });
    const n = new Map(safeLibrary);
    n.set(game.id, { ...(c ?? { game, status: null, playtime: 0 }), isFavorite: nowFav, isLiked: nowFav ? true : (c?.isLiked ?? false) });
    syncDNA(n);
    persistLibraryItem(MOCK_USER_ID, { game_id: game.id, game_name: game.name, genres: game.genre_slugs ?? [], rating: game.rating ?? 0, status: c?.status ?? null, is_liked: nowFav ? true : (c?.isLiked ?? false), is_favorite: nowFav });
    if (nowFav) { addToast("Glitch noted your favorite! ⭐", "liked", `fav:${game.id}`); onXpGain(XP_EVENTS.favorite, game.id, "favorite"); }
    else addToast("Removed from favorites", "info", `unfav:${game.id}`);
  }, [safeLibrary, dispatch, addToast, onXpGain, syncDNA]);

  const isUpcomingSection = activeSection === TIMELINE_UPCOMING;

  const sharedCard = useMemo(
    () => ({
      onLibraryAction: handleLibraryAction,
      onLike: handleLike,
      onFavorite: handleFavorite,
      suppressRating: isUpcomingSection,
    }),
    [handleLibraryAction, handleLike, handleFavorite, isUpcomingSection]
  );

  const handleSelectFilterItem = useCallback((item, filterKey, mode) => {
    setActiveFilters(prev => {
      const next = { ...prev };
      if (mode === "applyBatch") {
        if (filterKey === "genres") {
          const selectedList = Array.from(item.values());
          next.genres = new Map(selectedList.filter(i => i.type === "genre").map(i => [i.id, i]));
          next.themes = new Map(selectedList.filter(i => i.type === "theme").map(i => [i.id, i]));
        } else {
          next[filterKey] = item;
        }
      } else if (mode === "clearAll") {
        next[filterKey] = new Map();
      } else if (mode === "remove") {
        const map = new Map(prev[filterKey] ?? new Map());
        map.delete(item?.id);
        next[filterKey] = map;
      } else {
        const map = new Map(prev[filterKey] ?? new Map());
        if (map.has(item.id)) map.delete(item.id);
        else map.set(item.id, { id: item.id, name: item.name });
        next[filterKey] = map;
      }
      return next;
    });
  }, []);

  const handleRemoveFilterCategory = useCallback(filterKey => {
    setActiveFilters(prev => ({ ...prev, [filterKey]: new Map() }));
    if (filterKey === "search") clearSearch();
  }, []);

  const handleRemoveFilterSub = useCallback((filterKey, itemId) => {
    setActiveFilters(prev => {
      const map = new Map(prev[filterKey] ?? new Map());
      map.delete(itemId);
      return { ...prev, [filterKey]: map };
    });
  }, []);

  const statusLabel = useMemo(() => {
    if (loading && !games.length)                return "INITIALIZING…";
    if (totalFilterCount > 0)                    return `Filtered · ${totalFilterCount} active`;
    if (isDiscovery)                             return "Neural Discovery Active";
    if (activeSection === TIMELINE_LATEST)       return "Current Era (2024–2026)";
    if (activeSection === TIMELINE_UPCOMING)     return "Future Projects";
    if (isRetro)                                 return "Retro Archive (1980–2005)";
    if (isFreeGames)                             return "Free-to-Play";
    if (activeSection === TOP_2026_SLUG)         return "Best of 2026";
    if (activeSection === POPULAR_2025_SLUG)     return "Popular of 2025";
    if (activeSection === ALL_TIME_SLUG)         return "All-time Classics";
    if (activeGenre) return `Genre · ${GENRES.find(g => g.slug === activeGenre)?.label ?? activeGenre}`;
    return "Full Database";
  }, [loading, games.length, totalFilterCount, isDiscovery, activeSection, isRetro, isFreeGames, activeGenre]);

  const filterTagRows = useMemo(() => {
    const LABELS = { platforms: "Platform", genres: "Genre", themes: "Vibe", years: "Year", stores: "Store" };
    const COLORS = { platforms: "filter-tag-wrap--platform", genres: "filter-tag-wrap--genre", themes: "filter-tag-wrap--theme", years: "filter-tag-wrap--year" };
    const rows = [];
    if (searchQuery) rows.push({ key: "search", label: "Search", subItems: [{ id: searchQuery, name: searchQuery }], color: "filter-tag-wrap--search" });
    for (const [key, map] of Object.entries(activeFilters)) {
      if (!map || map.size === 0) continue;
      rows.push({ key, label: LABELS[key] ?? key, subItems: Array.from(map.values()), color: COLORS[key] ?? "" });
    }
    if (isDiscovery && fetchedSvmMode !== "raw") {
      rows.push({ key: "ai", label: "AI", subItems: [{ id: fetchedSvmMode, name: fetchedSvmMode === "svm" ? "DNA Ranked" : "Learning" }], color: "filter-tag-wrap--ai" });
    }
    return rows;
  }, [activeFilters, searchQuery, isDiscovery, fetchedSvmMode]);

  const isHomeFeed = !activeSection && !searchQuery && totalFilterCount === 0;

  return (
    <div className={`dashboard ${corrupted ? "dashboard--corrupted" : ""}`}
      style={siteTint ? { "--site-tint": siteTint } : {}}>
      <MeshGradient siteTint={siteTint} />

      <AnimatePresence>
        {portalTarget && (
          <FilterDrawer
            key={portalTarget}
            portalTarget={portalTarget}
            activeFilters={activeFilters}
            onApplySelections={(key, stagedMap) => handleSelectFilterItem(stagedMap, key, "applyBatch")}
            onClose={() => setPortalTarget(null)}
          />
        )}
      </AnimatePresence>

      <motion.div className="dash-body"
        variants={isFirstLoad ? bootContainer : undefined}
        initial={isFirstLoad ? "hidden" : false}
        animate={isFirstLoad ? "visible" : false}>

        {/* ════ SIDEBAR ════ */}
        <motion.nav className="sidebar" variants={isFirstLoad ? bootSidebar : undefined}>
          <div className="sidebar-scroll-zone">

            <button
              className={`sidebar-browse-feed ${isHomeFeed && !isDiscovery ? "sidebar-browse-feed--active" : ""}`}
              onClick={handleBrowseFeed}
              title="Return to main discovery feed">
              <LayoutGrid size={14} className="sd-icon" />
              <span className="sd-label">Browse Feed</span>
              {isHomeFeed && !isDiscovery && <motion.div className="sidebar-active-indicator" layoutId="si" />}
            </button>

            <button
              className={`sidebar-discovery ${isDiscovery ? "sidebar-discovery--active" : ""}`}
              onClick={() => handleSection(DISCOVERY_SLUG)}>
              <Compass size={14} className="sd-icon" />
              <span className="sd-label">Discovery Hub</span>
              <span className="sd-badge">AI</span>
              {isDiscovery && <motion.div className="sidebar-active-indicator" layoutId="si" />}
            </button>

            <div className="sidebar-divider" />

            <AccordionSection label="TIMELINE" defaultOpen={true}>
              <ul className="sidebar-list">
                {[
                  { s: TIMELINE_LATEST,     label: "Latest 2026",   Icon: Clock,         active: activeSection === TIMELINE_LATEST     },
                  { s: TIMELINE_UPCOMING,   label: "Upcoming",       Icon: CalendarClock, active: activeSection === TIMELINE_UPCOMING   },
                  { s: RETRO_CLASSICS_SLUG, label: "Retro Classics", Icon: History,       active: isRetro },
                ].map(({ s, label, Icon, active }) => (
                  <li key={s}>
                    <button className={`sidebar-item ${active ? "sidebar-item--active" : ""}`}
                      onClick={() => handleSection(s)}>
                      <span className="sidebar-icon"><Icon size={13} /></span>
                      <span>{label}</span>
                      {s === RETRO_CLASSICS_SLUG && <span className="sidebar-retro-badge">1980–2005</span>}
                      {active && <motion.div className="sidebar-active-indicator" layoutId="si" />}
                    </button>
                  </li>
                ))}
              </ul>
            </AccordionSection>

            <AccordionSection label="TOP" defaultOpen={true}>
              <ul className="sidebar-list">
                {[
                  { s: TOP_2026_SLUG,     label: "Best of 2026",      Icon: Trophy,     active: activeSection === TOP_2026_SLUG     },
                  { s: POPULAR_2025_SLUG, label: "Popular of 2025",    Icon: TrendingUp, active: activeSection === POPULAR_2025_SLUG },
                  { s: ALL_TIME_SLUG,     label: "All-time Top Games", Icon: Star,       active: activeSection === ALL_TIME_SLUG     },
                ].map(({ s, label, Icon, active }) => (
                  <li key={s}>
                    <button className={`sidebar-item ${active ? "sidebar-item--active" : ""}`}
                      onClick={() => handleSection(s)}>
                      <span className="sidebar-icon"><Icon size={13} /></span>
                      <span>{label}</span>
                      {active && <motion.div className="sidebar-active-indicator" layoutId="si" />}
                    </button>
                  </li>
                ))}
              </ul>
            </AccordionSection>

            <AccordionSection
              label="ADVANCED FILTERS"
              className="sb-accordion--featured"
              defaultOpen={false}
              badge={totalFilterCount > 0 ? String(totalFilterCount) : undefined}>
              <div className="sb-browse-grid">
                {BROWSE_ITEMS.map(({ id, label, Icon }) => {
                  const fkey     = PORTAL_FILTER_MAP[id] ?? id;
                  const selCount = activeFilters[fkey]?.size ?? 0;
                  const isOpen   = portalTarget === id;
                  return (
                    <button key={id}
                      className={`sb-browse-btn ${isOpen ? "sb-browse-btn--active" : ""} ${selCount > 0 ? "sb-browse-btn--has-sel" : ""}`}
                      onClick={() => handleFilterPortal(id)}>
                      <Icon size={14} className="sb-browse-icon" />
                      <span>{label}</span>
                      {selCount > 0 && <span className="sb-browse-count">{selCount}</span>}
                    </button>
                  );
                })}
              </div>
              {totalFilterCount > 0 && (
                <button className="adv-filters-clear-all" onClick={clearFilters}>
                  <X size={11} /><span>Clear all filters</span>
                </button>
              )}
            </AccordionSection>

            <div className="sidebar-divider" />
            <ul className="sidebar-list">
              <li>
                <button className={`sidebar-item ${isFreeGames ? "sidebar-item--active" : ""}`}
                  onClick={() => handleSection(FREE_GAMES_SLUG)}>
                  <span className="sidebar-icon"><Gift size={13} /></span>
                  <span>Free Games</span>
                  <span className="sidebar-free-badge">FREE</span>
                  {isFreeGames && <motion.div className="sidebar-active-indicator" layoutId="si" />}
                </button>
              </li>
            </ul>

            {showGrouped && availableYears.length > 1 && (
              <>
                <div className="sidebar-divider" />
                <p className="sidebar-label">JUMP TO YEAR</p>
                <div className="sidebar-year-jump">
                  <ChevronDown size={11} className="sidebar-year-jump-icon" />
                  <select className="sidebar-year-jump-select" defaultValue=""
                    onChange={e => { const y = e.target.value; if (y) scrollToYear(Number(y)); e.target.value = ""; }}>
                    <option value="" disabled>Jump to Year…</option>
                    {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
                  </select>
                </div>
              </>
            )}

            {isDiscovery && (
              <>
                <div className="sidebar-divider" />
                <p className="sidebar-label">AI ENGINE</p>
                <div className={`svm-status-pill svm-status-pill--${fetchedSvmMode}`}>
                  <Zap size={11} />
                  <span>
                    {fetchedSvmMode === "svm"        ? "DNA Active"
                    : fetchedSvmMode === "cold_start" ? "Learning Mode"
                    : "Awaiting login"}
                  </span>
                </div>
              </>
            )}

            <div className="sidebar-divider" />
            <p className="sidebar-label">MY LIBRARY</p>
            {playingCount > 0 && (
              <button className="sidebar-lib-row sidebar-lib-row--playing" onClick={onNavigateLibrary}>
                <Gamepad size={12} /><span>Playing Now</span>
                <span className="lib-sidebar-count lib-sidebar-count--playing">{playingCount}</span>
              </button>
            )}
            <button className="sidebar-lib-row" onClick={onNavigateLibrary}>
              <Bookmark size={12} /><span>Wishlist</span>
              <span className="lib-sidebar-count">{wishlistCount}</span>
            </button>
            <button className="sidebar-lib-row" onClick={onNavigateLibrary}>
              <Play size={12} /><span>Played</span>
              <span className="lib-sidebar-count">{playedCount}</span>
            </button>
            {likedCount > 0 && (
              <div className="sidebar-svm-hint">
                <Sparkles size={10} /><span>{likedCount} liked · DNA updated</span>
              </div>
            )}

          </div>
        </motion.nav>

        {/* ════ MAIN CONTENT ════ */}
        <motion.main className="main-content" ref={scrollRef}
          variants={isFirstLoad ? bootMain : undefined}>

          {!isDiscovery && !isTimeline && !isFreeGames && !isRetro && !isTop && !searchQuery && !activeGenre && totalFilterCount === 0 && (
            <HeroCarousel onCardClick={g => onOverlayOpen(g)} onColorChange={onSiteTintChange} />
          )}
          {!isDiscovery && !isTimeline && !isFreeGames && !isRetro && !isTop && !searchQuery && !activeGenre && totalFilterCount === 0 && (
            <TrendingRow
              title="Trending Now"
              subtitle="Most Anticipated"
              endpoint="/api/games?page_size=16&ordering=-hypes"
              onOpenOverlay={onOverlayOpen}
              library={safeLibrary}
              onLibraryAction={handleLibraryAction}
              onLike={handleLike}
              onFavorite={handleFavorite} />
          )}

          {/* Status bar */}
          <div className="content-statusbar">
            <span className="status-label">{statusLabel}</span>

            {isDiscovery && (
              <motion.button
                className="recalibrate-btn"
                onClick={() => {
                  refresh();
                  if (scrollRef.current) scrollRef.current.scrollTo({ top: 0, behavior: "instant" });
                }}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}>
                <RefreshCw size={12} className={loading ? "spin" : ""} />
                <span>Recalibrate DNA Feed</span>
              </motion.button>
            )}

            <div className="active-filter-tags">
              {filterTagRows.map(row => (
                <FilterTag
                  key={row.key}
                  label={row.label}
                  subTags={row.subItems.map(i => ({ id: i.id, label: i.name }))}
                  colorClass={row.color}
                  onRemoveAll={() => handleRemoveFilterCategory(row.key)}
                  onRemoveSub={subId => handleRemoveFilterSub(row.key, subId)} />
              ))}
            </div>

            {canGroup && availableYears.length > 1 && (
              <div className="year-filter-wrap">
                <ChevronDown size={11} className="year-filter-icon" />
                <select className="year-filter-select" value={yearFilter}
                  onChange={e => setYearFilter(e.target.value)}>
                  <option value="all">All Years</option>
                  {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            )}
            {hasMore && !loading && <span className="status-scroll-hint">SCROLL FOR MORE</span>}
          </div>

          {/* Game grid */}
          {loading && !games.length && (
            <div className="game-grid">
              {[...Array(12)].map((_, i) => (
                <div key={i} className="game-card game-card--skeleton">
                  <div className="skeleton-img" />
                  <div className="skeleton-body">
                    <div className="skeleton-line skeleton-line--title" />
                    <div className="skeleton-line skeleton-line--sub" />
                  </div>
                </div>
              ))}
            </div>
          )}
          {error && !games.length && (
            <motion.div className="error-state" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <AlertTriangle size={40} /><h3>Connection Error</h3>
              <p>Make sure Flask is running on <code>http://127.0.0.1:5000</code></p>
              <code className="error-detail">{error}</code>
              {retry && <button className="retry-btn" onClick={retry}><RefreshCw size={14} /><span>Try Again</span></button>}
            </motion.div>
          )}
          {games.length > 0 && (
            <>
              {/* Most Awaited row — shown inside timeline sections */}
              {(activeSection === TIMELINE_LATEST || activeSection === TIMELINE_UPCOMING) && (
                <TrendingRow
                  title="MOST AWAITED"
                  subtitle="Global Anticipation"
                  endpoint="/api/games?awaited=true"
                  onOpenOverlay={onOverlayOpen}
                  library={safeLibrary}
                  onLibraryAction={handleLibraryAction}
                  onLike={handleLike}
                  onFavorite={handleFavorite}
                />
              )}
              <YearGroupedGrid
                games={games} library={safeLibrary}
                onOpenOverlay={onOverlayOpen}
                sharedCard={sharedCard}
                showGrouped={showGrouped}
                isFirstLoad={isFirstLoad}
                yearRefs={yearRefs} />
              <div ref={sentinelRef} className="scroll-sentinel">
                {loadingMore && (
                  <motion.div className="infinite-spinner" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                    <Loader2 size={22} className="spin" /><span>Loading more…</span>
                  </motion.div>
                )}
                {!hasMore && !loading && <p className="end-of-list">✦ You've seen them all ✦</p>}
              </div>
            </>
          )}
          {!loading && !games.length && !error && (
            <motion.div className="empty-state" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <Gamepad2 size={48} opacity={0.3} />
              <p>{yearFilter !== "all" ? `No games found for ${yearFilter}.` : "No games found."}</p>
              {yearFilter !== "all" && (
                <button className="retry-btn" onClick={() => setYearFilter("all")}>
                  <X size={13} /><span>Clear Year Filter</span>
                </button>
              )}
            </motion.div>
          )}

        </motion.main>
      </motion.div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   ROOT APP
   ════════════════════════════════════════════════════════════════════════════ */
export default function App() {
  const [view,          setView]          = useState("entry");
  const [userMode,      setUserMode]      = useState("guest");
  const [isLoggedIn,    setIsLoggedIn]    = useState(false);
  const [dnaWeights,    setDnaWeights]    = useState(null);
  const [dnaOffsets,    setDnaOffsets]    = useState({});
  const [xp,            setXp]            = useState(0);
  const [muted,         setMuted]         = useState(false);
  const [corrupted,     setCorrupted]     = useState(false);
  const [dashKey,       setDashKey]       = useState(0);
  const [siteTint,      setSiteTint]      = useState(null);
  const [levelJustUp,   setLevelJustUp]   = useState(false);
  const [isFirstLoad,   setIsFirstLoad]   = useState(false);

  /* overlayGame holds the full game object (from card) for instant open */
  const [overlayGame,   setOverlayGame]   = useState(null);

  const [searchInput,       setSearchInput]      = useState("");
  const [searchQuery,       setSearchQuery]       = useState("");
  const [svmMode,           setSvmMode]           = useState("raw");
  const [isDiscoveryActive, setIsDiscoveryActive] = useState(false);
  const searchRef = useRef(null);

  const firstLoadFired = useRef(false);
  const [library, dispatch] = useReducer(libraryReducer, new Map());
  const { toasts, addToast } = useToast();
  const prevLevel  = useRef(1);
  const xpGranted  = useRef(new Set());

  const [playHum1]   = useSound(SFX.hum1,   { volume: 0.35, soundEnabled: !muted });
  const [playHum2]   = useSound(SFX.hum2,   { volume: 0.35, soundEnabled: !muted });
  const [playHum3]   = useSound(SFX.hum3,   { volume: 0.35, soundEnabled: !muted });
  const [playChime]  = useSound(SFX.chime,  { volume: 0.55, soundEnabled: !muted });
  const [playDizzy]  = useSound(SFX.dizzy,  { volume: 0.40, soundEnabled: !muted });
  const [playSad]    = useSound(SFX.sad,    { volume: 0.40, soundEnabled: !muted });
  const [playGlitch] = useSound(SFX.glitch, { volume: 0.50, soundEnabled: !muted });
  const playHum = useCallback(() => [playHum1, playHum2, playHum3][Math.floor(Math.random() * 3)]?.(), [playHum1, playHum2, playHum3]);

  const handleXpGain = useCallback((amount, gameId = null, eventType = null) => {
    if (gameId != null && eventType != null) {
      const k = `${gameId}::${eventType}`;
      if (xpGranted.current.has(k)) return;
      xpGranted.current.add(k);
    }
    setXp(prev => {
      const next = prev + amount, newLv = getLevel(next), oldLv = getLevel(prev);
      if (newLv > oldLv && newLv > prevLevel.current) {
        prevLevel.current = newLv;
        setTimeout(() => {
          playChime?.(); setLevelJustUp(true);
          setTimeout(() => setLevelJustUp(false), 100);
          addToast(newLv >= 20 ? "👑 MAX — GLITCH PRIME unlocked!" : `⚡ Level Up! Glitch is now ${getTitle(newLv)} (Lv ${newLv})`, "xp", `lvl:${newLv}`);
        }, 200);
      }
      return next;
    });
  }, [addToast, playChime]);

  useEffect(() => {
    if (!isLoggedIn) return;
    fetch(`${API_BASE}/library/${MOCK_USER_ID}`)
      .then(r => r.ok ? r.json() : [])
      .then(rows => { if (Array.isArray(rows) && rows.length) dispatch({ type: "HYDRATE", rows }); })
      .catch(() => {});
  }, [isLoggedIn]);

  useEffect(() => {
    if (!(library instanceof Map) || library.size === 0) return;
    setDnaWeights(applyDnaOffsets(library, dnaOffsets));
  }, [library, dnaOffsets]);

  useEffect(() => {
    if (!corrupted) return;
    const t = setTimeout(() => setCorrupted(false), 30000);
    return () => clearTimeout(t);
  }, [corrupted]);

  const handleToggleMute     = useCallback(() => setMuted(v => { if (!v) playSad?.(); return !v; }), [playSad]);
  const handleSiteTintChange = useCallback(t => setSiteTint(t), []);
  const handleSearch         = e => { e?.preventDefault(); setSearchQuery(searchInput.trim()); };
  const handleClearSearch    = () => { setSearchInput(""); setSearchQuery(""); };

  const handleEnter = action => {
    const auth = action === "login" || action === "register";
    setIsLoggedIn(auth);
    setUserMode(auth ? (action === "register" ? "new user" : "user") : "guest");
    setSearchInput(""); setSearchQuery(""); setSvmMode("raw");
    setDashKey(k => k + 1);
    if (!firstLoadFired.current) { firstLoadFired.current = true; setIsFirstLoad(true); setTimeout(() => setIsFirstLoad(false), 1800); }
    setView("dashboard");
    if (auth) setTimeout(() => { addToast(action === "register" ? "Account created 🎮" : "Welcome back 👾", "success", `auth:${action}`); setXp(p => p + 50); }, 480);
  };

  const handleLogout = useCallback(() => {
    setOverlayGame(null);
    xpGranted.current.clear();
    firstLoadFired.current = false;
    prevLevel.current = 1;
    dispatch({ type: "HYDRATE", rows: [] });
    setIsLoggedIn(false); setUserMode("guest"); setDnaWeights(null);
    setDnaOffsets({}); setXp(0); setCorrupted(false); setSiteTint(null);
    setLevelJustUp(false); setIsFirstLoad(false);
    setSearchInput(""); setSearchQuery(""); setSvmMode("raw");
    setIsDiscoveryActive(false);
    setDashKey(k => k + 1);
    setView("entry");
    addToast("Logged out", "info", "logout");
  }, [addToast]);

  const level      = getLevel(xp);
  const title      = getTitle(level);
  const xpProgress = getXpProgress(xp);

  const libEntries    = useMemo(() => Array.from((library instanceof Map ? library : new Map()).values()), [library]);
  const wishlistCount = useMemo(() => libEntries.filter(e => e.status === "wishlist").length, [libEntries]);
  const playedCount   = useMemo(() => libEntries.filter(e => e.status === "played").length, [libEntries]);
  const playingCount  = useMemo(() => libEntries.filter(e => e.status === "playing").length, [libEntries]);
  const likedCount    = useMemo(() => libEntries.filter(e => e.isLiked).length, [libEntries]);

  const sharedLib  = { library, dispatch, addToast };
  const showChrome = view !== "entry";

  return (
    <LayoutGroup>
      <div className={corrupted ? "app--corrupted" : ""}>

        <AnimatePresence mode="popLayout">
          {view === "entry" && (
            <motion.div key="entry" style={{ position: "fixed", inset: 0 }}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.28 }}>
              <EntryPage onEnter={handleEnter} />
            </motion.div>
          )}
        </AnimatePresence>

        {showChrome && (
          <>
            <PersistentHeader
              view={view} corrupted={corrupted}
              isLoggedIn={isLoggedIn} userMode={userMode}
              level={level} title={title}
              searchInput={searchInput} setSearchInput={setSearchInput}
              searchQuery={searchQuery}
              onSearch={handleSearch} onClearSearch={handleClearSearch}
              onNavigateLibrary={() => setView("library")}
              onNavigateDashboard={() => { setDashKey(k => k + 1); setView("dashboard"); }}
              onLogout={handleLogout}
              wishlistCount={wishlistCount} likedCount={likedCount}
              playedCount={playedCount} playingCount={playingCount}
              svmMode={svmMode} isDiscoveryActive={isDiscoveryActive}
              isFirstLoad={isFirstLoad} searchRef={searchRef} />

            <div style={{
              position: "fixed", inset: 0,
              paddingTop: "var(--header-h)",
              overflow: "hidden", display: "flex",
            }}>
              <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
                <AnimatePresence mode="popLayout" initial={false}>
                  {view === "dashboard" && (
                    <motion.div key={`dashboard-${dashKey}`}
                      style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}
                      initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -20 }}
                      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}>
                      <Dashboard
                        userMode={userMode} isLoggedIn={isLoggedIn}
                        {...sharedLib}
                        onLogout={handleLogout}
                        onNavigateLibrary={() => setView("library")}
                        dnaWeights={dnaWeights} onDnaWeightsChange={setDnaWeights}
                        dnaOffsets={dnaOffsets}
                        xp={xp} onXpGain={handleXpGain}
                        muted={muted} corrupted={corrupted}
                        siteTint={siteTint} onSiteTintChange={handleSiteTintChange}
                        isFirstLoad={isFirstLoad}
                        searchInput={searchInput} setSearchInput={setSearchInput}
                        searchQuery={searchQuery} setSearchQuery={setSearchQuery}
                        searchRef={searchRef}
                        svmMode={svmMode} setSvmMode={setSvmMode}
                        /* Pass full game object so modal opens instantly */
                        onOverlayOpen={game => setOverlayGame(game)} />
                    </motion.div>
                  )}
                  {view === "library" && (
                    <motion.div key="library"
                      style={{ width: "100%", height: "100%", overflow: "hidden" }}
                      initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 20 }}
                      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}>
                      <div className="full-page-scroll">
                        <LibraryPage
                          {...sharedLib}
                          dnaWeights={dnaWeights} onDnaWeightsChange={setDnaWeights}
                          dnaOffsets={dnaOffsets} onDnaOffsetsChange={setDnaOffsets}
                          xp={xp} onXpGain={handleXpGain}
                          onBack={() => { setDashKey(k => k + 1); setView("dashboard"); }} />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              <motion.div
                variants={bootBlade}
                initial={isFirstLoad ? "hidden" : false}
                animate={isFirstLoad ? "visible" : false}
                style={{ flexShrink: 0 }}>
                <DNABlade
                  library={library}
                  dnaWeights={dnaWeights}
                  onWeightsChange={setDnaWeights}
                  dnaOffsets={dnaOffsets}
                  onDnaOffsetsChange={setDnaOffsets}
                  level={level} title={title} />
              </motion.div>
            </div>

            <GlitchPet
              level={level} 
              xpProgress={xpProgress}
              muted={muted} 
              corrupted={corrupted} 
              levelJustUp={levelJustUp}
              view={view} 
              onToggleMute={handleToggleMute}
              playHum={playHum} 
              playDizzy={playDizzy} 
              playSad={playSad} 
              playGlitch={playGlitch}
              dnaWeights={dnaWeights}
              libraryCount={library.size}
              onCorrupt={() => { setCorrupted(true); playGlitch?.(); addToast("🔴 CORRUPTED MODE ACTIVATED", "xp", "corrupt"); }}
              onUncorrupt={() => setCorrupted(false)} 
            />

            {/* New lightweight Game Detail Modal — portal to document.body */}
            <AnimatePresence>
              {overlayGame && (
                <GameDetailModal
                  key={overlayGame.id}
                  game={overlayGame}
                  library={library instanceof Map ? library : new Map()}
                  dispatch={dispatch}
                  addToast={addToast}
                  onClose={() => setOverlayGame(null)}
                  dnaWeights={dnaWeights}
                />
              )}
            </AnimatePresence>
          </>
        )}

        <ToastContainer toasts={toasts} />
      </div>
    </LayoutGroup>
  );
}