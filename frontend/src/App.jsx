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
  Eye, EyeOff, BookOpen,
} from "lucide-react";
import useSound from "use-sound";

import {
  API_BASE, GENRES,
  TIMELINE_LATEST, TIMELINE_UPCOMING, FREE_GAMES_SLUG,
  RETRO_CLASSICS_SLUG,
  truncate, ratingColor, isNewRelease,
  libraryReducer, useToast, useInfiniteGames, useHubData,
  computeDNAScores, normaliseDNA, calculateMatchPercentage,
  getLevel, getTitle, getXpProgress, XP_EVENTS,
  DNA_GENRES,
} from "./shared.js";

import DNABlade from "./DNABlade.jsx";
import GlitchPet from "./GlitchPet.jsx";
import HeroCarousel from "./HeroCarousel.jsx";
import LibraryPage from "./LibraryPage.jsx";
import {
  useFirebaseUser, logoutUser, loginAsGuest, loginWithGoogle,
  loginWithEmail, registerUser, useOTP, linkAccounts
} from "./useAuth.js";
import { fetchLibraryFS, persistLibraryItemFS, saveDNAWeightsFS } from "./firebaseLibrary.js";
import { signOut } from "firebase/auth";
import { auth } from "./firebase.js";

/* ── Sound paths ─────────────────────────────────────────────────────────────── */
const SFX = {
  hum1: "/sounds/hum1.mp3",
  hum2: "/sounds/hum2.mp3",
  hum3: "/sounds/hum3.mp3",
  chime: "/sounds/chime.mp3",
  dizzy: "/sounds/dizzy.mp3",
  sad: "/sounds/sad.mp3",
  glitch: "/sounds/glitch.mp3",
};

/* ── Boot stagger variants ───────────────────────────────────────────────────── */
const bootContainer = { hidden: {}, visible: { transition: { staggerChildren: 0.08, delayChildren: 0.1 } } };
const bootSidebar = { hidden: { x: -60, opacity: 0 }, visible: { x: 0, opacity: 1, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] } } };
const bootMain = { hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] } } };
const bootBlade = { hidden: { x: 60, opacity: 0 }, visible: { x: 0, opacity: 1, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] } } };
const bootCard = { hidden: { scale: 0.88, opacity: 0 }, visible: { scale: 1, opacity: 1, transition: { duration: 0.25, ease: [0.16, 1, 0.3, 1] } } };
const bootGrid = { hidden: {}, visible: { transition: { staggerChildren: 0.05, delayChildren: 0.1 } } };

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
function getTodayStr() { return new Date().toISOString().split("T")[0]; }
function getTomorrowStr() { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().split("T")[0]; }

/* ── Section slugs ───────────────────────────────────────────────────────────── */
const DISCOVERY_SLUG = "__discovery__";
const TOP_2026_SLUG = "__top_2026__";
const POPULAR_2025_SLUG = "__popular_2025__";
const ALL_TIME_SLUG = "__all_time__";

/* ── Browse targets ─────────────────────────────────────────────────────────── */
const BROWSE_ITEMS = [
  { id: "platforms", label: "Platforms", Icon: Monitor },
  { id: "stores", label: "Stores", Icon: ShoppingCart },
  { id: "genres", label: "Genres & Vibes", Icon: Layers },
  { id: "years", label: "Years", Icon: Calendar },
];

/* ── Advanced Filter → IGDB filter-key mapping ─────────────────────────────── */
const PORTAL_FILTER_MAP = {
  platforms: "platforms",
  genres: "genres",
  tags: "themes",
  themes: "themes",
  years: "years",
  stores: "stores",
};

/* Factory: fresh empty filter state */
function emptyFilters() {
  return {
    platforms: new Map(),
    genres: new Map(),
    themes: new Map(),
    years: new Map(),
    stores: new Map(),
  };
}

/* ── sectionToApiParams ──────────────────────────────────────────────────────── */
function sectionToApiParams(section) {
  if (section === TIMELINE_LATEST) return { ordering: "-hypes,-released", metacritic: "50,100", dates: `2024-01-01,${getTodayStr()}` };
  if (section === TIMELINE_UPCOMING) return { ordering: "-hypes", metacritic: "", dates: `${getTomorrowStr()},2027-12-31` };
  if (section === FREE_GAMES_SLUG) return { ordering: "-follows", metacritic: "", tags: "free-to-play" };
  if (section === RETRO_CLASSICS_SLUG) return { ordering: "-total_rating", metacritic: "80,100", dates: "1980-01-01,2005-12-31" };
  if (section === TOP_2026_SLUG) return { ordering: "-hypes,-total_rating", metacritic: "70,100", dates: `2026-01-01,${getTodayStr()}` };
  if (section === POPULAR_2025_SLUG) return { ordering: "-follows,-total_rating", metacritic: "60,100", dates: "2025-01-01,2025-12-31" };
  if (section === ALL_TIME_SLUG) return { ordering: "-total_rating", metacritic: "90,100" };
  if (section && section !== DISCOVERY_SLUG) return { ordering: "-released,-total_rating", metacritic: "50,100" };
  return { ordering: "", metacritic: "" };
}

/* ── formatNumber ───────────────────────────────────────────────────────────── */
function formatNumber(num) {
  if (!num) return "0";
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + "k";
  }
  return num.toString();
}

/* ════════════════════════════════════════════════════════════════════════════
   GAME DETAIL MODAL  V15 "Pro-Tier Marketplace"
   ════════════════════════════════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════════════════════════════════
   GAME DETAIL MODAL  V16 "Immersive Bento" — Sub-components
   ════════════════════════════════════════════════════════════════════════════ */

/* ── Animated Score Ring ── */
function ScoreRing({ value, max = 10, label, count, color, size = 72 }) {
  const pct = Math.min(value / max, 1);
  const r = (size - 10) / 2;
  const circ = 2 * Math.PI * r;
  const dash = circ * pct;
  if (!value || value <= 0) return null;
  return (
    <div className="gdm-score-container">
      <div className="gdm-score-label-above">{label}</div>
      <div className="gdm-score-ring" style={{ width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: "rotate(-90deg)", position: "absolute", inset: 0 }}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke="rgba(255,255,255,0.05)" strokeWidth={6} />
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={6}
            strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 6px ${color}88)` }} />
        </svg>
        <div className="gdm-score-inner">
          <span className="gdm-score-val" style={{ color, fontWeight: "900" }}>{value.toFixed(1)}</span>
        </div>
      </div>
      {count > 0 && (
        <div className="gdm-score-count-below">
          {formatNumber(count)} reviews
        </div>
      )}
    </div>
  );
}

/* ── DNA Progress Ring ── */
function DnaProgressRing({ match, label, loading, size = 96 }) {
  const color =
    match >= 90 ? "var(--accent-green)" :
      match >= 75 ? "var(--accent)" :
        match >= 55 ? "var(--accent-violet)" :
          match >= 35 ? "var(--accent-amber)" : "var(--text-muted)";

  const r = (size - 12) / 2;
  const circ = 2 * Math.PI * r;
  const dash = circ * (match / 100);

  if (loading) {
    return (
      <div className="gdm-dna-ring-wrap">
        <div className="gdm-dna-ring-skel" style={{ width: size, height: size }} />
        <div className="gdm-dna-ring-info">
          <div className="gdm-compat-pct-skel" style={{ width: 56, height: 18 }} />
          <div className="gdm-compat-pct-skel" style={{ width: 80, height: 12, marginTop: 4 }} />
        </div>
      </div>
    );
  }

  return (
    <div className="gdm-dna-ring-wrap">
      <div className="gdm-dna-ring" style={{ width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: "rotate(-90deg)", position: "absolute", inset: 0 }}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke="rgba(255,255,255,0.05)" strokeWidth={8} />
          <motion.circle cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke={color} strokeWidth={8} strokeLinecap="round"
            strokeDasharray={`${circ}`}
            initial={{ strokeDashoffset: circ }}
            animate={{ strokeDashoffset: circ - dash }}
            transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1], delay: 0.15 }}
            style={{ filter: `drop-shadow(0 0 8px ${color}99)` }} />
        </svg>
        <div className="gdm-dna-ring-inner">
          <span className="gdm-dna-ring-pct" style={{ color }}>{match}%</span>
        </div>
      </div>
      <div className="gdm-dna-ring-info">
        <span className="gdm-dna-ring-label">DNA MATCH</span>
        <span className="gdm-compat-badge" style={{ color, borderColor: color + "44" }}>{label}</span>
      </div>
    </div>
  );
}

/* ── Bento Chips tile — hidden if no items ── */
function BentoChips({ label, items, icon, accentClass }) {
  if (!items?.length) return null;
  return (
    <div className={`gdm-bento-cell ${accentClass ?? ""}`}>
      <span className="gdm-bento-label">{icon} {label}</span>
      <div className="gdm-bento-chips">
        {items.map(i => <span key={i} className="gdm-bento-chip">{i}</span>)}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   GAME DETAIL MODAL  V16 "Immersive Bento"
   ════════════════════════════════════════════════════════════════════════════ */
function GameDetailModal({ game: cardGame, library, dispatch, addToast, onClose, dnaWeights, user }) {
  const [activeGame, setActiveGame] = useState(cardGame);
  const [fullGame, setFullGame] = useState(null);
  const [screenshots, setScreenshots] = useState([]);
  const [activeImg, setActiveImg] = useState(0);
  const [dataLoading, setDataLoading] = useState(true);
  const [dnaMatch, setDnaMatch] = useState(null);
  const [hltb, setHltb] = useState(null);
  const [isDataReady, setIsDataReady] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isSecondaryDataLoading, setIsSecondaryDataLoading] = useState(true);

  useEffect(() => {
    setIsDataReady(false);
    setIsExpanded(false);
    setIsSecondaryDataLoading(true);
  }, [activeGame?.id]);

  useEffect(() => {
    if (!dataLoading) {
      setIsDataReady(true);
    }
  }, [dataLoading]);

  const game = fullGame ?? activeGame;
  const entry = library?.get(game?.id);
  const status = entry?.status;
  const isLiked = entry?.isLiked ?? false;
  const isFavorite = entry?.isFavorite ?? false;

  useEffect(() => {
    setActiveGame(cardGame);
    setFullGame(null);
    setScreenshots([]);
    setActiveImg(0);
    setHltb(null);

    // Initial DNA Match calculation for instant 0ms build-in!
    const slugs = cardGame?.genre_slugs;
    if (slugs?.length && dnaWeights) {
      const scores = slugs.map(g => dnaWeights[g]).filter(v => v !== undefined);
      if (scores.length > 0) {
        const pct = Math.max(0, Math.min(100, Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)));
        let label = "Outside DNA";
        if (pct >= 90) label = "Perfect Match";
        else if (pct >= 75) label = "Strong Match";
        else if (pct >= 55) label = "Good Match";
        else if (pct >= 35) label = "Partial Match";
        setDnaMatch({ match: pct, label });
      } else {
        setDnaMatch({ match: 50, label: "Uncharted" });
      }
    } else {
      setDnaMatch({ match: 50, label: "Uncharted" });
    }
  }, [cardGame, dnaWeights]);

  useEffect(() => {
    const h = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  useEffect(() => {
    if (!activeGame?.id) return;
    let cancelled = false;
    setDataLoading(true);
    setIsSecondaryDataLoading(true);
    fetch(`${API_BASE}/games/${activeGame.id}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!cancelled && d) {
          setFullGame(d);
          // Set screenshots instantly from the unified response!
          setScreenshots((d.screenshots ?? []).slice(0, 8).map(s => s.image).filter(Boolean));
          // Set HLTB instantly from the unified response!
          setHltb(d.hltb);

          // Calculate DNA Match instantly client-side!
          const slugs = d.genre_slugs;
          if (slugs?.length && dnaWeights) {
            const scores = slugs.map(g => dnaWeights[g]).filter(v => v !== undefined);
            if (scores.length > 0) {
              const pct = Math.max(0, Math.min(100, Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)));
              let label = "Outside DNA";
              if (pct >= 90) label = "Perfect Match";
              else if (pct >= 75) label = "Strong Match";
              else if (pct >= 55) label = "Good Match";
              else if (pct >= 35) label = "Partial Match";
              setDnaMatch({ match: pct, label });
            } else {
              setDnaMatch({ match: 50, label: "Uncharted" });
            }
          } else {
            setDnaMatch({ match: 50, label: "Uncharted" });
          }
        }
      })
      .catch(() => { })
      .finally(() => {
        if (!cancelled) {
          setDataLoading(false);
          setIsSecondaryDataLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [activeGame?.id, dnaWeights]);

  const handleLibraryAction = useCallback((action) => {
    if (!game) return;
    const current = library?.get(game.id);
    const newStatus = current?.status === action ? null : action;
    dispatch({ type: "SET_STATUS", gameId: game.id, game, status: newStatus });
    persistLibraryItemFS(user.uid, {
      game_id: game.id, game_name: game.name,
      genres: game.genre_slugs ?? [], rating: game.rating ?? 0,
      status: newStatus, is_liked: current?.isLiked ?? false,
      is_favorite: current?.isFavorite ?? false, image_url: game.background_image,
    });
    if (newStatus === "playing") addToast(`🎮 Now playing: ${truncate(game.name, 18)}`, "playing");
    if (newStatus === "wishlist") addToast("Added to Wishlist!", "wishlist");
    if (newStatus === "played") addToast("Nice! Marked as Played.", "played");
    if (!newStatus) addToast("Removed from library", "info");
  }, [game, library, dispatch, addToast]);

  const allImages = screenshots.length > 0 ? screenshots : (game?.background_image ? [game.background_image] : []);

  if (!game) return null;

  const userRating = fullGame?.rating ?? 0;
  const criticRating = fullGame?.critic_rating ?? 0;
  const userCount = fullGame?.rating_count ?? 0;
  const criticCount = fullGame?.critic_rating_count ?? 0;
  const hasRatings = !!fullGame && (userRating > 0 || criticRating > 0);

  const hasModes = (game.game_modes?.length ?? 0) > 0;
  const hasPerspectives = (game.player_perspectives?.length ?? 0) > 0;
  const hasKeywords = (game.keywords?.length ?? 0) > 0;
  const hasPlatforms = (game.platforms?.length ?? 0) > 0;
  const hasSteam = typeof game.steam_url === "string" && game.steam_url.length > 0;
  const hasTrailer = !!(game.trailer_url || game.clip?.clip);
  const hasPublishers = (game.publishers?.length ?? 0) > 0;
  const hasTags = (game.tags?.length ?? 0) > 0;

  const storyText = game?.storyline || game?.summary || game?.description_raw;

  const modalContent = (
    <motion.div className="gdm-backdrop"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }}
      exit={{ opacity: 0 }} transition={{ duration: 0.22 }}
      onClick={onClose}>

      <motion.div className="gdm-panel"
        initial={{ opacity: 0, y: 32, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 20, scale: 0.98 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
        onClick={e => e.stopPropagation()}>

        {/* Subtle blurred cover backdrop for immersive premium visual theme */}
        {game?.background_image && (
          <div className="gdm-panel-bg" style={{ backgroundImage: `url(${game.background_image})` }} />
        )}
        <div className="gdm-panel-veil" />

        {/* ════ HEADER ════ */}
        <div className="gdm-header gdm-animate-build gdm-delay-instant" style={{ zIndex: 10 }}>
          <div className="gdm-header-content">
            {game.developers?.length > 0 && (
              <span className="gdm-header-dev">{game.developers[0]}</span>
            )}
            <h2 className="gdm-header-title">{game.name}</h2>
            <div className="gdm-header-meta">
              {(game.released_formatted || game.released) && (
                <span className="gdm-meta-chip">
                  <Calendar size={11} /> {game.released_formatted || game.released}
                </span>
              )}
              {game.esrb_rating && (
                <span className="gdm-meta-chip gdm-meta-chip--esrb">{game.esrb_rating}</span>
              )}
              {game.genres?.slice(0, 3).map(g => (
                <span key={g} className="gdm-meta-chip gdm-meta-chip--genre">{g}</span>
              ))}
            </div>
          </div>

          <button className="gdm-close-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {/* ════ BODY ════ */}
        <div className="gdm-body" style={{ zIndex: 5 }}>

          {/* ── LEFT COLUMN ── */}
          <div className="gdm-col-left">

            {/* Main gallery viewer */}
            <div className="gdm-gallery-section gdm-animate-build gdm-delay-instant">
              {!isDataReady ? (
                <div className="gdm-gallery-skeleton">
                  <div className="gdm-skel-main" />
                  <div className="gdm-skel-thumbs">
                    {[...Array(4)].map((_, i) => <div key={i} className="gdm-skel-thumb" />)}
                  </div>
                </div>
              ) : allImages.length > 0 ? (
                <div className="gdm-gallery">
                  <div className="gdm-gallery-main-container">
                    {/* Blurred background copy for aspect ratio blending (no letterboxing) */}
                    <div className="gdm-gallery-main-blur" style={{ backgroundImage: `url(${allImages[activeImg]})` }} />
                    <AnimatePresence mode="wait">
                      <motion.img key={allImages[activeImg]} src={allImages[activeImg]}
                        alt={`${game.name} screenshot ${activeImg + 1}`}
                        className="gdm-gallery-main"
                        initial={{ opacity: 0, scale: 1.02 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2 }} />
                    </AnimatePresence>
                  </div>

                  {/* High-res picture thumbnail strip underneath main image */}
                  {allImages.length > 1 && (
                    <div className="gdm-gallery-thumbs">
                      {allImages.slice(0, 8).map((img, i) => (
                        <button key={i}
                          className={`gdm-gallery-thumb ${i === activeImg ? "gdm-gallery-thumb--active" : ""}`}
                          onClick={() => setActiveImg(i)}>
                          <img src={img} alt="" />
                        </button>
                      ))}
                    </div>
                  )}

                  {allImages.length > 1 && (
                    <div className="gdm-gallery-nav">
                      <button className="gdm-nav-btn"
                        onClick={() => setActiveImg(i => (i - 1 + allImages.length) % allImages.length)}>
                        <ChevronLeft size={15} />
                      </button>
                      <span className="gdm-nav-count">{activeImg + 1} / {allImages.length}</span>
                      <button className="gdm-nav-btn"
                        onClick={() => setActiveImg(i => (i + 1) % allImages.length)}>
                        <ChevronRight size={15} />
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="gdm-no-images">
                  <ImageIcon size={28} opacity={0.18} />
                  <span>No screenshots available</span>
                </div>
              )}
            </div>

            {/* ── Center Platforms Bento Tile — hidden if empty ── */}
            {/* ── Center Platforms Bento Tile ── */}
            {isSecondaryDataLoading ? (
              <div className="gdm-center-platforms-tile gdm-animate-build gdm-delay-secondary" style={{
                marginTop: "16px",
                marginBottom: "8px",
                background: "rgba(255, 255, 255, 0.015)",
                border: "1px dashed rgba(255, 255, 255, 0.06)",
                borderRadius: "20px",
                padding: "20px 24px",
                boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.02)"
              }}>
                <span style={{
                  fontSize: "11px",
                  fontFamily: "var(--font-mono)",
                  fontWeight: "900",
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  color: "#FFFFFF",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px"
                }}>
                  <Monitor size={12} style={{ color: "var(--accent)" }} /> Supported Platforms
                </span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "10px" }}>
                  <div style={{ width: "80px", height: "24px", borderRadius: "12px", background: "var(--skel-base)", animation: "skel-pulse 1.5s ease-in-out infinite" }} />
                  <div style={{ width: "100px", height: "24px", borderRadius: "12px", background: "var(--skel-base)", animation: "skel-pulse 1.5s ease-in-out infinite" }} />
                  <div style={{ width: "70px", height: "24px", borderRadius: "12px", background: "var(--skel-base)", animation: "skel-pulse 1.5s ease-in-out infinite" }} />
                </div>
              </div>
            ) : hasPlatforms ? (
              <div className="gdm-center-platforms-tile gdm-animate-build gdm-delay-secondary" style={{
                marginTop: "16px",
                marginBottom: "8px",
                background: "rgba(255, 255, 255, 0.03)",
                border: "1px solid rgba(255, 255, 255, 0.08)",
                borderRadius: "20px",
                padding: "20px 24px",
                display: "flex",
                flexDirection: "column",
                gap: "10px",
                boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.02)"
              }}>
                <span style={{
                  fontSize: "11px",
                  fontFamily: "var(--font-mono)",
                  fontWeight: "900",
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  color: "#FFFFFF",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px"
                }}>
                  <Monitor size={12} style={{ color: "var(--accent)" }} /> Supported Platforms
                </span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "4px" }}>
                  {game.platforms.slice(0, 10).map(p => (
                    <span key={p} style={{
                      fontSize: "12px",
                      fontWeight: "700",
                      padding: "6px 14px",
                      borderRadius: "20px",
                      background: "rgba(255, 255, 255, 0.06)",
                      border: "1px solid rgba(255, 255, 255, 0.12)",
                      color: "#FFFFFF",
                      boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
                      backdropFilter: "blur(5px)"
                    }}>
                      {p}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Description - only shown if both description_raw AND a separate storyline exist to prevent duplicated text */}
            {isSecondaryDataLoading ? (
              <div className="gdm-desc-skeleton gdm-animate-build gdm-delay-secondary" style={{ marginTop: "16px" }}>
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="gdm-skel-line" style={{ width: i === 2 ? "65%" : "100%" }} />
                ))}
              </div>
            ) : (game.description_raw && game.storyline && game.description_raw !== game.storyline) ? (
              <p className="gdm-description gdm-animate-build gdm-delay-secondary">
                {game.description_raw.slice(0, 820)}
                {game.description_raw.length > 820 ? "…" : ""}
              </p>
            ) : null}

            {/* Story Section */}
            {isSecondaryDataLoading ? (
              <div className="gdm-story-section gdm-animate-build gdm-delay-final" style={{ background: "rgba(255, 255, 255, 0.015)", border: "1px dashed rgba(255, 255, 255, 0.06)" }}>
                <h4 className="gdm-section-title">
                  <BookOpen size={14} /> The Story
                </h4>
                <div className="gdm-desc-skeleton">
                  <div className="gdm-skel-line" style={{ width: "100%" }} />
                  <div className="gdm-skel-line" style={{ width: "95%" }} />
                  <div className="gdm-skel-line" style={{ width: "98%" }} />
                  <div className="gdm-skel-line" style={{ width: "55%" }} />
                </div>
              </div>
            ) : storyText ? (
              <div className="gdm-story-section gdm-animate-build gdm-delay-final">
                <h4 className="gdm-section-title">
                  <BookOpen size={14} /> The Story
                </h4>
                <div className={`gdm-story-content-wrapper ${isExpanded ? "gdm-story-expanded" : ""}`}>
                  <p className="gdm-story-text">
                    {!isExpanded && storyText.length > 450
                      ? `${storyText.slice(0, 450)}...`
                      : storyText}
                  </p>
                </div>
                {storyText.length > 450 && (
                  <button className="gdm-story-toggle-btn" onClick={() => setIsExpanded(!isExpanded)}>
                    <span>{isExpanded ? "Show Less" : "Show More"}</span>
                  </button>
                )}
              </div>
            ) : null}

            {/* HLTB Section */}
            {isSecondaryDataLoading ? (
              <div className="gdm-hltb-section gdm-animate-build gdm-delay-secondary">
                <h4 className="gdm-section-title">
                  <Clock size={14} /> Time to Beat
                </h4>
                <div className="gdm-hltb-grid">
                  {[...Array(3)].map((_, i) => (
                    <div key={i} className="gdm-hltb-card" style={{ height: "80px", background: "rgba(255, 255, 255, 0.015)", border: "1px dashed rgba(255, 255, 255, 0.06)" }}>
                      <div className="gdm-skel-line" style={{ width: "50%", height: "10px", marginTop: "10px" }} />
                      <div className="gdm-skel-line" style={{ width: "80%", height: "18px", marginTop: "14px" }} />
                    </div>
                  ))}
                </div>
              </div>
            ) : (hltb && (hltb.hastily || hltb.normally || hltb.completely)) ? (
              <div className="gdm-hltb-section gdm-animate-build gdm-delay-secondary">
                <h4 className="gdm-section-title">
                  <Clock size={14} /> Time to Beat
                </h4>
                <div className="gdm-hltb-grid">
                  {hltb.hastily && (
                    <div className="gdm-hltb-card gdm-hltb-card--hastily">
                      <span className="gdm-hltb-label">Hastily</span>
                      <span className="gdm-hltb-hours">{hltb.hastily}</span>
                      <span className="gdm-hltb-desc">Main Story</span>
                    </div>
                  )}
                  {hltb.normally && (
                    <div className="gdm-hltb-card gdm-hltb-card--normally">
                      <span className="gdm-hltb-label">Normally</span>
                      <span className="gdm-hltb-hours">{hltb.normally}</span>
                      <span className="gdm-hltb-desc">Main + Extra</span>
                    </div>
                  )}
                  {hltb.completely && (
                    <div className="gdm-hltb-card gdm-hltb-card--completely">
                      <span className="gdm-hltb-label">Completely</span>
                      <span className="gdm-hltb-hours">{hltb.completely}</span>
                      <span className="gdm-hltb-desc">Completionist</span>
                    </div>
                  )}
                </div>
              </div>
            ) : null}

            {/* ════ BENTO GRID ════ */}
            {isSecondaryDataLoading ? (
              <div className="gdm-bento-grid gdm-animate-build gdm-delay-final">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="gdm-bento-cell" style={{ height: "80px", background: "rgba(255, 255, 255, 0.015)", border: "1px solid rgba(255, 255, 255, 0.04)", position: "relative" }}>
                    <div className="gdm-skel-line" style={{ width: "40%", height: "10px", marginTop: "12px", background: "var(--skel-base)", animation: "skel-pulse 1.5s ease-in-out infinite" }} />
                    <div className="gdm-skel-line" style={{ width: "80%", height: "14px", marginTop: "14px", background: "var(--skel-base)", animation: "skel-pulse 1.5s ease-in-out infinite" }} />
                  </div>
                ))}
              </div>
            ) : (
              <div className="gdm-bento-grid gdm-animate-build gdm-delay-final">

                {/* ── Main Developer — hidden if empty ── */}
                {game.developers?.length > 0 && (
                  <div className="gdm-bento-cell gdm-bento-cell--high-contrast">
                    <span className="gdm-bento-label">
                      <Building2 size={11} className="gdm-bento-icon" /> Developer
                    </span>
                    <div className="gdm-bento-value">{game.developers.join(", ")}</div>
                  </div>
                )}

                {/* ── Published By — hidden if empty ── */}
                {game.publishers?.length > 0 && (
                  <div className="gdm-bento-cell gdm-bento-cell--high-contrast">
                    <span className="gdm-bento-label">
                      <Users size={11} className="gdm-bento-icon" /> Published By
                    </span>
                    <div className="gdm-bento-value">{game.publishers.join(", ")}</div>
                  </div>
                )}

                {/* ── Game Engine — hidden if empty ── */}
                {game.game_engines?.length > 0 && (
                  <div className="gdm-bento-cell">
                    <span className="gdm-bento-label">
                      <Layers size={11} className="gdm-bento-icon" /> Game Engine
                    </span>
                    <div className="gdm-bento-value">{game.game_engines.join(", ")}</div>
                  </div>
                )}

                {/* ── Franchise & Series — hidden if empty ── */}
                {(game.franchises?.length > 0 || game.series) && (
                  <div className="gdm-bento-cell gdm-bento-cell--wide">
                    <span className="gdm-bento-label">
                      <Compass size={11} className="gdm-bento-icon" /> Franchise & Series
                    </span>
                    <div className="gdm-bento-series-row">
                      {game.series && (
                        <div className="gdm-bento-series-badge">
                          <span>Series:</span> {game.series}
                        </div>
                      )}
                      {game.franchises?.length > 0 && (
                        <div className="gdm-bento-franchise-text">
                          <span>Franchise:</span> {game.franchises.join(", ")}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* ── Game Modes — hidden if empty ── */}
                {hasModes && (
                  <BentoChips label="Game Modes" items={game.game_modes}
                    icon={<Gamepad size={11} className="gdm-bento-icon" />} />
                )}

                {/* ── Player Perspectives — hidden if empty ── */}
                {hasPerspectives && (
                  <BentoChips label="Perspectives" items={game.player_perspectives}
                    icon={<Eye size={11} className="gdm-bento-icon" />} />
                )}

                {/* ── Keywords — hidden if empty ── */}
                {hasKeywords && (
                  <BentoChips label="Keywords" items={game.keywords.slice(0, 10)}
                    icon={<Tag size={11} className="gdm-bento-icon" />}
                    accentClass="gdm-bento-cell--wide" />
                )}

              </div>
            )}

            {/* Similar Games Section */}
            {isSecondaryDataLoading ? (
              <div className="gdm-similar-section gdm-animate-build gdm-delay-final" style={{ marginTop: "24px" }}>
                <h4 className="gdm-section-title">
                  <Layers size={14} /> Similar Games
                </h4>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "14px", marginTop: "10px" }}>
                  {[...Array(3)].map((_, i) => (
                    <div key={i} style={{ width: "100%", aspectRatio: "3/4", borderRadius: "10px", background: "var(--skel-base)", animation: "skel-pulse 1.5s ease-in-out infinite" }} />
                  ))}
                </div>
              </div>
            ) : (game.similar_games?.length > 0) ? (
              <div className="gdm-similar-section gdm-animate-build gdm-delay-final">
                <h4 className="gdm-section-title">
                  <Layers size={14} /> Similar Games
                </h4>
                <div className="gdm-similar-list">
                  {game.similar_games.map(sg => (
                    <div key={sg.id} className="gdm-similar-card" onClick={() => {
                      setFullGame(null);
                      setScreenshots([]);
                      setActiveImg(0);
                      setHltb(null);
                      setActiveGame(sg);
                    }}>
                      {sg.cover_url ? (
                        <img src={sg.cover_url} alt={sg.name} className="gdm-similar-cover" />
                      ) : (
                        <div className="gdm-similar-cover-fallback">
                          <ImageIcon size={18} />
                        </div>
                      )}
                      <span className="gdm-similar-name">{sg.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

          </div>

          {/* ── RIGHT COLUMN ── */}
          {/* ── RIGHT COLUMN ── */}
          <aside className="gdm-col-right">

            {/* ── Scores (User / Critic) ── */}
            {isSecondaryDataLoading ? (
              <div className="gdm-sidebar-card gdm-animate-build gdm-delay-final">
                <span className="gdm-sidebar-label">
                  <Star size={11} className="gdm-bento-icon" /> Scores
                </span>
                <div className="gdm-scores-skeleton-row" style={{ marginTop: "14px", display: "flex", gap: "24px", justifyContent: "center" }}>
                  <div className="gdm-skel-circle" style={{ width: "64px", height: "64px", borderRadius: "50%", background: "var(--skel-base)", animation: "skel-pulse 1.5s ease-in-out infinite" }} />
                  <div className="gdm-skel-circle" style={{ width: "64px", height: "64px", borderRadius: "50%", background: "var(--skel-base)", animation: "skel-pulse 1.5s ease-in-out infinite" }} />
                </div>
              </div>
            ) : hasRatings ? (
              <div className="gdm-sidebar-card gdm-animate-build gdm-delay-final">
                <span className="gdm-sidebar-label">
                  <Star size={11} className="gdm-bento-icon" /> Scores
                </span>
                <div className="gdm-scores-row" style={{ marginTop: "10px", display: "flex", gap: "16px", justifyContent: "center" }}>
                  {userRating > 0 && (
                    <ScoreRing value={userRating} label="User" count={userCount}
                      color="var(--accent)" size={72} />
                  )}
                  {criticRating > 0 && (
                    <ScoreRing value={criticRating} label="Critic" count={criticCount}
                      color="var(--accent-violet)" size={72} />
                  )}
                </div>
              </div>
            ) : null}

            {/* ── DNA Compatibility ── */}
            {dnaWeights && (
              <div className="gdm-sidebar-card gdm-animate-build gdm-delay-high" style={{ background: "rgba(0, 212, 255, 0.04)", borderColor: "rgba(0, 212, 255, 0.15)" }}>
                <span className="gdm-sidebar-label" style={{ color: "var(--accent)" }}>
                  <Sparkles size={11} className="gdm-bento-icon gdm-bento-icon--pulse" /> DNA Compatibility
                </span>
                <div style={{ marginTop: "10px", display: "flex", justifyContent: "center" }}>
                  <DnaProgressRing
                    match={dnaMatch?.match ?? 0}
                    label={dnaMatch?.label ?? "Scanning…"}
                    loading={false}
                    size={84}
                  />
                </div>
              </div>
            )}

            {/* Library Actions */}
            <div className="gdm-actions gdm-animate-build gdm-delay-high">
              {[
                { key: "playing", Icon: Gamepad, label: "Playing", activeLabel: "Playing ✓" },
                { key: "wishlist", Icon: Bookmark, label: "Wishlist", activeLabel: "Wishlisted" },
                { key: "played", Icon: Play, label: "Played", activeLabel: "Played ✓" },
              ].map(({ key, Icon, label, activeLabel }) => (
                <button key={key}
                  className={`gdm-action-btn ${status === key ? "gdm-action-btn--active" : ""}`}
                  onClick={() => handleLibraryAction(key)}>
                  <Icon size={13} />
                  <span>{status === key ? activeLabel : label}</span>
                  {status === key && <Check size={11} className="gdm-action-check" />}
                </button>
              ))}
            </div>

            {/* Like / Favorite */}
            <div className="gdm-social-btns gdm-animate-build gdm-delay-high">
              <button className={`gdm-icon-btn ${isLiked ? "gdm-icon-btn--liked" : ""}`}
                onClick={() => {
                  if (!game) return;
                  const c = library?.get(game.id);
                  dispatch({ type: "TOGGLE_LIKE", gameId: game.id, game });
                  const nowLiked = !(c?.isLiked ?? false);
                  persistLibraryItemFS(user.uid, {
                    game_id: game.id, game_name: game.name,
                    genres: game.genre_slugs ?? [], rating: game.rating ?? 0,
                    status: c?.status ?? null, is_liked: nowLiked,
                    is_favorite: c?.isFavorite ?? false, image_url: game.background_image,
                  });
                  addToast(nowLiked ? "DNA Pattern Updated! 🧬" : "Unliked", nowLiked ? "liked" : "info");
                }} aria-label="Like">
                <Heart size={14} fill={isLiked ? "currentColor" : "none"} />
                <span>{isLiked ? "Liked" : "Like"}</span>
              </button>
              <button className={`gdm-icon-btn ${isFavorite ? "gdm-icon-btn--fav" : ""}`}
                onClick={() => {
                  if (!game) return;
                  const c = library?.get(game.id);
                  dispatch({ type: "TOGGLE_FAVORITE", gameId: game.id, game });
                  const nowFav = !(c?.isFavorite ?? false);
                  persistLibraryItemFS(user.uid, {
                    game_id: game.id, game_name: game.name,
                    genres: game.genre_slugs ?? [], rating: game.rating ?? 0,
                    status: c?.status ?? null,
                    is_liked: nowFav ? true : (c?.isLiked ?? false),
                    is_favorite: nowFav, image_url: game.background_image,
                  });
                  addToast(nowFav ? "Glitch noted your favorite! ⭐" : "Removed from favorites", nowFav ? "liked" : "info");
                }} aria-label="Favorite">
                <Star size={14} fill={isFavorite ? "currentColor" : "none"} />
                <span>{isFavorite ? "Favorited" : "Favorite"}</span>
              </button>
            </div>

            {/* ── Steam Button ── */}
            {hasSteam && !isSecondaryDataLoading && (
              <a href={game.steam_url} target="_blank" rel="noopener noreferrer"
                className="gdm-steam-btn gdm-animate-build gdm-delay-secondary" onClick={e => e.stopPropagation()}>
                <div className="gdm-steam-btn-icon">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                    <path d="M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.718L.22 15.996C1.785 20.558 6.504 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.29-.249-1.878-.03l1.523.63c.956.4 1.409 1.5 1.009 2.455-.397.957-1.497 1.41-2.455 1.012H7.54zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.663 0-3.015 1.353-3.015 3.015 0 1.663 1.352 3.015 3.015 3.015 1.663 0 3.015-1.352 3.015-3.015zm-5.273.012c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.252 0-2.265-1.014-2.265-2.265z" />
                  </svg>
                </div>
                <div className="gdm-steam-btn-text">
                  <span className="gdm-steam-btn-label">Available on</span>
                  <span className="gdm-steam-btn-name">Steam</span>
                </div>
                <ExternalLink size={13} className="gdm-steam-ext" />
              </a>
            )}

            {/* Trailer — hidden if no url */}
            {hasTrailer && !isSecondaryDataLoading && (
              <a href={game.trailer_url || game.clip?.clip} target="_blank"
                rel="noopener noreferrer" className="gdm-trailer-btn gdm-animate-build gdm-delay-secondary"
                onClick={e => e.stopPropagation()}>
                <Play size={13} />
                <span>Watch Trailer</span>
                <ExternalLink size={12} />
              </a>
            )}

            {/* Tags — hidden if empty */}
            {hasTags && !isSecondaryDataLoading && (
              <div className="gdm-tags-section gdm-animate-build gdm-delay-final" style={{ marginTop: "8px" }}>
                <span className="gdm-sidebar-label">TAGS</span>
                <div className="gdm-tags">
                  {game.tags.slice(0, 8).map(t => (
                    <span key={t} className="gdm-tag">{t}</span>
                  ))}
                </div>
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
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.96 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}>
            {t.type === "success" && <CheckCircle2 size={15} />}
            {t.type === "wishlist" && <BookmarkCheck size={15} />}
            {t.type === "liked" && <Heart size={15} />}
            {t.type === "info" && <Sparkles size={15} />}
            {t.type === "played" && <Play size={15} />}
            {t.type === "playing" && <Gamepad size={15} />}
            {t.type === "xp" && <Award size={15} />}
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
      const list = byYear[year];
      const byRat = [...list].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
      const topHits = byRat.slice(0, 4);
      const topIds = new Set(topHits.map(g => String(g.id)));
      const rest = list
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
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}>
          <ChevronDown size={12} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="sb-accordion-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
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
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}>
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
  const [phase, setPhase] = useState("landing"); // landing, login, register
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [regStep, setRegStep] = useState(1);
  const [otpCode, setOtpCode] = useState("");
  const [resendTimer, setResendTimer] = useState(0);
  const otpRefs = useRef([]);

  const [linkRequired, setLinkRequired] = useState(false);
  const [googleCred, setGoogleCred] = useState(null);

  const { isVerified, requestOTP, confirmOTP, setIsVerified } = useOTP();

  const tags = ["DISCOVER.", "EXPLORE.", "CONQUER."];
  const [ti, setTi] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setTi(i => (i + 1) % tags.length), 2200);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let interval;
    if (resendTimer > 0) {
      interval = setInterval(() => setResendTimer(prev => prev - 1), 1000);
    }
    return () => clearInterval(interval);
  }, [resendTimer]);

  const switchToPhase = (newPhase) => {
    setPhase(newPhase);
    setError("");
    if (newPhase === "register") {
      setRegStep(1);
      setOtpCode("");
      setIsVerified(false);
      setPassword("");
      setConfirmPassword("");
    }
    setLinkRequired(false);
    setGoogleCred(null);
  };

  const handleRequestOTP = async () => {
    if (!email) { setError("Email is required."); return; }
    setLoading(true); setError("");
    try {
      await requestOTP(email);
      setRegStep(2);
      setResendTimer(60);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleOtpChange = (e, index) => {
    const val = e.target.value;
    if (!/^\d*$/.test(val)) return;

    const currentOtp = otpCode.padEnd(6, " ").split("");
    currentOtp[index] = val.slice(-1);
    const finalOtp = currentOtp.join("").trim();
    setOtpCode(finalOtp);

    if (val && index < 5) {
      otpRefs.current[index + 1]?.focus();
    }
  };

  const handleOtpKeyDown = (e, index) => {
    if (e.key === "Backspace" && !otpCode[index] && index > 0) {
      otpRefs.current[index - 1]?.focus();
    }
  };

  const handleVerifyOTP = async () => {
    if (!otpCode) { setError("OTP is required."); return; }
    setLoading(true); setError("");
    try {
      await confirmOTP(email, otpCode);
      setRegStep(3);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    if (phase === "register") {
      if (regStep < 3) {
        setLoading(false);
        return;
      }
      if (password !== confirmPassword) {
        setError("Passwords do not match.");
        setLoading(false);
        return;
      }
    }

    try {
      if (phase === "login" && linkRequired) {
        await onEnter("link", email, password, googleCred);
      } else {
        await onEnter(phase, email, password);
      }
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        setError("This account does not exist. Please register first.");
      } else if (err.code === 'auth/wrong-password') {
        setError("Incorrect password. Please try again.");
      } else if (err.code === 'auth/invalid-credential') {
        setError("Invalid login credentials. Please check your email and password.");
      } else {
        setError(err.message.replace("Firebase: ", ""));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleAuth = async () => {
    setError("");
    try {
      const result = await onEnter("google");
      if (result?.linkRequired) {
        setLinkRequired(true);
        setGoogleCred(result.googleCred);
      }
    } catch (err) {
      const msg = err.message.replace("Firebase: ", "");
      setError(msg);
      if (msg.includes("Register first")) {
        switchToPhase("register");
        if (err.email) setEmail(err.email);
      }
    }
  };

  const fadeUp = {
    hidden: { opacity: 0, y: 20 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] } },
    exit: { opacity: 0, y: -20, transition: { duration: 0.3 } }
  };

  return (
    <div className="entry-page">
      <div className="entry-grid-bg" /><div className="entry-scanline" />

      <AnimatePresence mode="wait">
        {phase === "landing" ? (
          <motion.div key="landing" className="entry-content"
            variants={fadeUp} initial="hidden" animate="visible" exit="exit">
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
              <motion.button className="entry-btn entry-btn--primary" onClick={() => switchToPhase("login")}
                whileHover={{ scale: 1.03, x: 6 }} whileTap={{ scale: 0.97 }}>
                <LogIn size={18} /><span>Sign In</span><ChevronRight size={16} className="btn-arrow" />
              </motion.button>

              <motion.button className="entry-btn entry-btn--secondary" onClick={() => switchToPhase("register")}
                whileHover={{ scale: 1.03, x: 6 }} whileTap={{ scale: 0.97 }}>
                <UserPlus size={18} /><span>Register</span><ChevronRight size={16} className="btn-arrow" />
              </motion.button>

              <motion.button className="entry-btn entry-btn--ghost" onClick={() => onEnter("guest")}
                whileHover={{ scale: 1.03, x: 6 }} whileTap={{ scale: 0.97 }}>
                <User size={18} /><span>Continue as Guest</span><ChevronRight size={16} className="btn-arrow" />
              </motion.button>
            </div>
          </motion.div>
        ) : (
          <motion.div key="auth" className="entry-content auth-form-wrap"
            variants={fadeUp} initial="hidden" animate="visible" exit="exit">
            <button className="auth-back-btn" onClick={() => switchToPhase("landing")}>
              <ChevronLeft size={16} /> Landing
            </button>

            <h2 className="auth-headline">{phase === "login" ? "SIGN IN" : "CREATE ACCOUNT"}</h2>
            <p className="auth-sub">Access your personal Gamer DNA and library.</p>

            <form className="auth-form" onSubmit={handleSubmit}>
              {phase === "login" ? (
                <>
                  {linkRequired && (
                    <div className="auth-error" style={{ borderColor: 'var(--accent)', background: 'rgba(0,212,255,0.1)', color: 'var(--accent)' }}>
                      <AlertTriangle size={14} /> An account already exists with this email. Please enter your password to link your Google account.
                    </div>
                  )}
                  <div className="auth-field">
                    <label>EMAIL ADDRESS</label>
                    <input type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="name@domain.com" />
                  </div>
                  <div className="auth-field">
                    <label>PASSWORD</label>
                    <div className="auth-input-wrap">
                      <input
                        type={showPassword ? "text" : "password"}
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        required
                        placeholder="••••••••"
                      />
                      <button
                        type="button"
                        className="auth-password-toggle"
                        onClick={() => setShowPassword(!showPassword)}
                        tabIndex="-1"
                      >
                        {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>

                  {error && <div className="auth-error"><AlertTriangle size={14} /> {error}</div>}

                  <button type="submit" className="auth-submit-btn" disabled={loading}>
                    {loading ? <Loader2 size={18} className="spin" /> : (linkRequired ? "Link & Login" : "Login")}
                  </button>

                  <div className="auth-divider">
                    <span>OR</span>
                  </div>

                  <button type="button" className="google-auth-btn" onClick={handleGoogleAuth}>
                    <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="G" />
                    <span>Sign in with Google</span>
                  </button>

                  <div className="auth-toggle-link" onClick={() => switchToPhase("register")}>
                    Don't have an account? <span>Register</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="auth-field">
                    <label>EMAIL ADDRESS</label>
                    <input
                      type="email"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      required
                      placeholder="name@domain.com"
                      disabled={regStep > 1}
                    />
                  </div>

                  {regStep === 1 && (
                    <>
                      {error && <div className="auth-error"><AlertTriangle size={14} /> {error}</div>}
                      <button type="button" className="auth-submit-btn" onClick={handleRequestOTP} disabled={loading} style={{ marginBottom: "10px" }}>
                        {loading ? <Loader2 size={18} className="spin" /> : "Send OTP"}
                      </button>
                    </>
                  )}

                  {regStep === 2 && (
                    <>
                      <div className="auth-field">
                        <label>6-DIGIT VERIFICATION CODE</label>
                        <div className="otp-input-group">
                          {[...Array(6)].map((_, i) => (
                            <input
                              key={i}
                              ref={el => otpRefs.current[i] = el}
                              type="text"
                              className="otp-box"
                              maxLength={1}
                              value={otpCode[i] || ""}
                              onChange={e => handleOtpChange(e, i)}
                              onKeyDown={e => handleOtpKeyDown(e, i)}
                              autoFocus={i === 0}
                            />
                          ))}
                        </div>
                      </div>

                      <div className="otp-resend-row">
                        <button
                          type="button"
                          className="otp-resend-btn"
                          disabled={resendTimer > 0 || loading}
                          onClick={handleRequestOTP}
                        >
                          {resendTimer > 0 ? `Resend Code in ${resendTimer}s` : "Resend Verification Code"}
                        </button>
                      </div>

                      {error && <div className="auth-error"><AlertTriangle size={14} /> {error}</div>}

                      <button
                        type="button"
                        className="auth-submit-btn"
                        onClick={handleVerifyOTP}
                        disabled={loading || otpCode.length < 6}
                      >
                        {loading ? <Loader2 size={18} className="spin" /> : "Verify Identity"}
                      </button>
                    </>
                  )}

                  {regStep === 3 && (
                    <>
                      <div className="auth-field">
                        <label>PASSWORD</label>
                        <div className="auth-input-wrap">
                          <input
                            type={showPassword ? "text" : "password"}
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            required
                            placeholder="••••••••"
                          />
                          <button
                            type="button"
                            className="auth-password-toggle"
                            onClick={() => setShowPassword(!showPassword)}
                            tabIndex="-1"
                          >
                            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                          </button>
                        </div>
                        {password.length > 0 && (
                          <div className="password-strength-bar" style={{
                            height: '3px', marginTop: '6px', borderRadius: '2px', transition: 'all 0.3s',
                            background: password.length >= 8 ? 'var(--accent-green)' : password.length >= 5 ? 'var(--accent-amber)' : 'var(--accent-red)',
                            width: `${Math.min(100, (password.length / 8) * 100)}%`
                          }} />
                        )}
                      </div>
                      <div className="auth-field">
                        <label>CONFIRM PASSWORD</label>
                        <div className="auth-input-wrap">
                          <input
                            type={showPassword ? "text" : "password"}
                            value={confirmPassword}
                            onChange={e => setConfirmPassword(e.target.value)}
                            required
                            placeholder="••••••••"
                          />
                          <button
                            type="button"
                            className="auth-password-toggle"
                            onClick={() => setShowPassword(!showPassword)}
                            tabIndex="-1"
                          >
                            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                          </button>
                        </div>
                      </div>

                      {error && <div className="auth-error"><AlertTriangle size={14} /> {error}</div>}

                      <button type="submit" className="auth-submit-btn" disabled={loading}>
                        {loading ? <Loader2 size={18} className="spin" /> : "Register"}
                      </button>
                    </>
                  )}

                  <div className="auth-toggle-link" onClick={() => switchToPhase("login")}>
                    Already have an account? <span>Sign In</span>
                  </div>
                </>
              )}
            </form>
          </motion.div>
        )}
      </AnimatePresence>

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
    <motion.div ref={ref} className="quick-menu"
      style={{ ...style, overflow: 'hidden' }}
      initial={{ opacity: 0, scale: 0.88, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.88, y: 6 }}
      transition={{ type: "spring", stiffness: 420, damping: 28 }}>
      {[
        { action: "playing", Icon: Gamepad, label: status === "playing" ? "Stop Playing" : "Mark as Playing", active: status === "playing" },
        { action: "wishlist", Icon: Bookmark, label: status === "wishlist" ? "Remove from Wishlist" : "Add to Wishlist", active: status === "wishlist" },
        { action: "played", Icon: Play, label: status === "played" ? "Unmark Played" : "Mark as Played", active: status === "played" },
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
  isTopHit = false, bootAnim = false, suppressRating = false, dnaWeights,
  isDiscovery = false,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState(null);
  const [hoverIdx, setHoverIdx] = useState(0);
  const [hoverImgs, setHoverImgs] = useState([]);
  const [isHovering, setIsHovering] = useState(false);
  const fetchedRef = useRef(false);

  const status = entry?.status;
  const isWishlisted = status === "wishlist";
  const isPlayed = status === "played";
  const isPlaying = status === "playing";
  const isLiked = entry?.isLiked ?? false;
  const isFavorite = entry?.isFavorite ?? false;
  const showNew = isNewRelease(game.released);

  const handleMouseEnter = useCallback(async () => {
    setIsHovering(true);
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    try {
      const res = await fetch(`${API_BASE}/games/${game.id}/screenshots`);
      if (!res.ok) return;
      const data = await res.json();
      const imgs = (data.results ?? []).slice(0, 5).map(s => s.image).filter(Boolean);
      if (imgs.length > 0) setHoverImgs(imgs);
    } catch { }
  }, [game.id]);

  const handleMouseLeave = useCallback(() => { setIsHovering(false); setHoverIdx(0); }, []);
  const handleMouseMove = e => {
    if (!hoverImgs.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    setHoverIdx(Math.max(0, Math.min(Math.floor(x / (rect.width / (hoverImgs.length + 1))), hoverImgs.length)));
  };

  const displayImg = (isHovering && hoverIdx > 0 && hoverImgs[hoverIdx - 1])
    ? hoverImgs[hoverIdx - 1] : game.background_image;
  const topTags = game.tags?.slice(0, 5) ?? [];
  const hasMeta = game.developer || game.released || topTags.length > 0;

  const matchPct = useMemo(() => calculateMatchPercentage(game, dnaWeights), [game, dnaWeights]);

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
      {matchPct && matchPct >= 20 && !suppressRating && (
        <div className="card-top-hit-badge" style={{ left: isTopHit ? '70px' : '7px', background: 'rgba(0,0,0,0.6)', color: 'var(--accent)', borderColor: 'var(--border-muted)', backdropFilter: 'blur(4px)' }}>
          <Sparkles size={9} /> {matchPct}% Match
        </div>
      )}
      {isDiscovery && game.hypes > 50 && (
        <div className="card-top-hit-badge card-trending-badge" style={{ left: (isTopHit || (matchPct && matchPct >= 20)) ? 'auto' : '7px', right: (isTopHit || (matchPct && matchPct >= 20)) ? '7px' : 'auto', background: 'rgba(255,100,0,0.15)', color: '#ff8800', borderColor: 'rgba(255,136,0,0.3)', backdropFilter: 'blur(8px)' }}>
          <Zap size={9} fill="currentColor" /> Trending
        </div>
      )}

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
        {isPlaying && <div className="card-status-badge card-status-badge--playing"><Gamepad size={9} /> Playing</div>}
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
                  ? <motion.span key="c" initial={{ rotate: -45, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} exit={{ rotate: 45, opacity: 0 }} transition={{ duration: 0.16 }}><Check size={13} strokeWidth={3} /></motion.span>
                  : <motion.span key="p" initial={{ rotate: 45, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} exit={{ rotate: -45, opacity: 0 }} transition={{ duration: 0.16 }}><Plus size={13} strokeWidth={2.5} /></motion.span>
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
          {game.tags?.slice(0, 4).map(g => <span key={g} className="card-genre-tag">{g}</span>)}
        </div>
        <div className="card-footer">
          {!suppressRating && (
            <div className="card-rating-group" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div className="card-rating" style={{ color: ratingColor(game.rating) }}>
                <Star size={13} fill="currentColor" /><span>{game.rating?.toFixed(1) ?? "—"}</span>
              </div>
              {((game.total_rating_count ?? game.rating_count ?? 0) > 0) && (
                <div
                  className="card-rating-count"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    fontSize: '0.75rem',
                    color: ((game.total_rating_count ?? game.rating_count ?? 0) < 50 && (game.follows || 0) < 100) ? '#fbbf24' : 'var(--text-muted, #9ca3af)',
                    fontWeight: 500
                  }}
                  title={`Consensus Score (based on ${game.total_rating_count ?? game.rating_count ?? 0} sources)`}
                >
                  <Users size={11} opacity={0.7} />
                  <span>{formatNumber(game.total_rating_count ?? game.rating_count ?? 0)}</span>
                </div>
              )}
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
            {game.released && <p className="cme-row"><span className="cme-key">Released</span><span className="cme-val">{game.released}</span></p>}
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
  const safeLib = library instanceof Map ? library : new Map();
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
  title = "Trending Now",
  subtitle = "Most Anticipated",
  endpoint = "/api/games?page_size=16&ordering=-hypes",
  onOpenOverlay, library, onLibraryAction, onLike, onFavorite, dnaWeights,
}) {
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const listRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setGames([]);
    // Normalise endpoint — strip leading /api if API_BASE already ends with /api
    const url = (endpoint && endpoint.startsWith("http"))
      ? endpoint
      : `${API_BASE}${(endpoint || "").replace(/^\/api/, "")}`;
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
            <GameCard key={game.id} game={game} onOpenOverlay={onOpenOverlay}
              entry={library?.get(game.id)}
              onLibraryAction={onLibraryAction}
              onLike={onLike} onFavorite={onFavorite}
              dnaWeights={dnaWeights} />
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
  onOverlayOpen,
}) {
  const isLibrary = view === "library";
  const isMax = level >= 20;

  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selIndex, setSelIndex] = useState(-1);
  const formRef = useRef(null);

  // 1. Debounced fetching of search suggestions
  useEffect(() => {
    const query = searchInput.trim();
    if (query.length < 2) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    const handler = setTimeout(() => {
      let active = true;
      fetch(`${API_BASE}/search/suggestions?q=${encodeURIComponent(query)}`)
        .then(res => res.ok ? res.json() : [])
        .then(data => {
          if (active && Array.isArray(data)) {
            setSuggestions(data);
            if (document.activeElement === searchRef.current && data.length > 0) {
              setShowSuggestions(true);
            }
          }
        })
        .catch(() => { });
      return () => { active = false; };
    }, 300);

    return () => clearTimeout(handler);
  }, [searchInput, searchRef]);

  // 2. Click Outside logic to dismiss suggestion dropdown
  useEffect(() => {
    const handleOutsideClick = (e) => {
      if (formRef.current && !formRef.current.contains(e.target)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  // Keyboard navigation & interaction handlers
  const handleKeyDown = (e) => {
    if (e.key === "Escape") {
      setShowSuggestions(false);
      searchRef.current?.blur();
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      setShowSuggestions(false);
      setSuggestions([]);
      searchRef.current?.blur();
      if (showSuggestions && selIndex >= 0 && selIndex < suggestions.length) {
        const selectedGame = suggestions[selIndex];
        setSearchInput(selectedGame.name);
        setSelIndex(-1);
        setTimeout(() => {
          onSearch();
        }, 50);
      } else {
        onSearch();
      }
      return;
    }

    if (!showSuggestions || suggestions.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelIndex(prev => (prev + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelIndex(prev => (prev - 1 + suggestions.length) % suggestions.length);
    }
  };

  const handleSuggestionClick = (game) => {
    setSearchInput(game.name);
    setShowSuggestions(false);
    setSelIndex(-1);
    setTimeout(() => {
      onSearch();
    }, 50);
  };

  const handleDetailsClick = (e, game) => {
    e.stopPropagation(); // Prevent trigger of standard row click
    setShowSuggestions(false);
    if (onOverlayOpen) {
      onOverlayOpen(game);
    }
  };

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

      <motion.form
        ref={formRef}
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          setShowSuggestions(false);
          setSuggestions([]);
          searchRef.current?.blur();
          onSearch(e);
        }}
        animate={isLibrary ? { opacity: 0, y: -8, pointerEvents: "none" } : { opacity: 1, y: 0, pointerEvents: "auto" }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        aria-hidden={isLibrary}>
        <Search size={16} className="search-icon" />
        <input
          ref={searchRef}
          type="text"
          placeholder='Search games… ("/" to focus)'
          value={searchInput}
          onFocus={() => { if (searchInput.trim().length > 0) setShowSuggestions(true); }}
          onKeyDown={handleKeyDown}
          onChange={e => {
            const val = e.target.value;
            setSearchInput(val);
            if (val.trim().length > 0) {
              setShowSuggestions(true);
            } else {
              setShowSuggestions(false);
              setSuggestions([]);
            }
          }}
          className="search-input" />
        {searchInput && (
          <button
            type="button"
            className="search-clear"
            onClick={() => { onClearSearch(); setSuggestions([]); setShowSuggestions(false); }}
            style={{ marginRight: "4px" }}>
            <X size={14} />
          </button>
        )}
        <button type="submit" className="search-submit">Search</button>

        {/* Suggestion Dropdown */}
        <AnimatePresence>
          {showSuggestions && suggestions.length > 0 && (
            <motion.div
              className="search-suggestions"
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.15, ease: "easeOut" }}>
              {suggestions.map((game, index) => {
                const isSelected = index === selIndex;
                const releaseYear = game.released ? new Date(game.released).getFullYear() : "N/A";
                const rating = game.rating ? game.rating.toFixed(1) : null;

                return (
                  <div
                    key={game.id}
                    className={`search-suggestion-item ${isSelected ? "search-suggestion-item--selected" : ""}`}
                    onClick={() => handleSuggestionClick(game)}
                    onMouseEnter={() => setSelIndex(index)}>
                    {game.background_image ? (
                      <img
                        src={game.background_image}
                        alt={game.name}
                        className="search-suggestion-thumb" />
                    ) : (
                      <div className="search-suggestion-thumb" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <Gamepad size={14} opacity={0.3} />
                      </div>
                    )}
                    <div className="search-suggestion-info">
                      <div className="search-suggestion-name">{game.name}</div>
                      <div className="search-suggestion-meta">
                        <span>{releaseYear}</span>
                        {rating && (
                          <span className="search-suggestion-rating">
                            <Star size={10} fill="currentColor" />
                            {rating}
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="search-suggestion-btn"
                      onClick={(e) => handleDetailsClick(e, game)}>
                      Details
                    </button>
                  </div>
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>
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
  view,
  userMode, isLoggedIn, user,
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

  const [portalTarget, setPortalTarget] = useState(null);
  const [activeSection, setActiveSection] = useState("");
  const [appliedDnaWeights, setAppliedDnaWeights] = useState(dnaWeights);
  const [syncPulse, setSyncPulse] = useState(false);
  const [recalibrateTick, setRecalibrateTick] = useState(0);
  const [yearFilter, setYearFilter] = useState("all");
  const scrollRef = useRef(null);
  const sentinelRef = useRef(null);
  const yearRefs = useRef({});

  const [activeFilters, setActiveFilters] = useState(emptyFilters());

  const isDiscovery = activeSection === DISCOVERY_SLUG;
  const isTimeline = activeSection === TIMELINE_LATEST || activeSection === TIMELINE_UPCOMING;
  const isFreeGames = activeSection === FREE_GAMES_SLUG;
  const isRetro = activeSection === RETRO_CLASSICS_SLUG;
  const isTop = activeSection === TOP_2026_SLUG || activeSection === POPULAR_2025_SLUG || activeSection === ALL_TIME_SLUG;
  const canGroup = !isDiscovery && !isFreeGames && !searchQuery && !isTop;
  const showGrouped = canGroup && yearFilter === "all";

  const activeGenre = (isDiscovery || isTimeline || isFreeGames || isRetro || isTop) ? "" : activeSection;
  const apiParams = sectionToApiParams(activeSection);
  const userId = user?.uid || "";
  const level = getLevel(xp);

  const platformIds = useMemo(() => Array.from(activeFilters.platforms?.keys() ?? []), [activeFilters]);
  const genreIds = useMemo(() => Array.from(activeFilters.genres?.keys() ?? []), [activeFilters]);
  const companyIds = useMemo(() => [], []);
  const themeIds = useMemo(() => Array.from(activeFilters.themes?.keys() ?? []), [activeFilters]);
  const yearParam = useMemo(() => Array.from(activeFilters.years?.keys() ?? []).join(","), [activeFilters]);

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
    dnaOffsets: isDiscovery ? dnaOffsets : null,
    discoveryMode: isDiscovery && isLoggedIn,
    salt: recalibrateTick,
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

  const entries = useMemo(() => Array.from(safeLibrary.values()), [safeLibrary]);
  const wishlistCount = useMemo(() => entries.filter(e => e.status === "wishlist").length, [entries]);
  const playedCount = useMemo(() => entries.filter(e => e.status === "played").length, [entries]);
  const playingCount = useMemo(() => entries.filter(e => e.status === "playing").length, [entries]);
  const likedCount = useMemo(() => entries.filter(e => e.isLiked).length, [entries]);

  /* Reset scroll on section / filter change */
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTo({ top: 0, behavior: "instant" });
  }, [activeSection, searchQuery, activeFilters]);

  /* Infinite scroll */
  useEffect(() => {
    if (view !== "dashboard") return;
    const s = sentinelRef.current, r = scrollRef.current;
    if (!s || !r) return;
    const obs = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting && hasMore && !loading && !loadingMore) {
          if (isDiscovery) {
            if (JSON.stringify(dnaWeights) !== JSON.stringify(appliedDnaWeights)) {
              setSyncPulse(true);
              setTimeout(() => setSyncPulse(false), 2500);
              setAppliedDnaWeights(dnaWeights);
            }
          }
          loadMore();
        }
      },
      { root: r, rootMargin: "0px 0px 140px 0px", threshold: 0 }
    );
    obs.observe(s);
    return () => obs.disconnect();
  }, [view, hasMore, loading, loadingMore, loadMore, isDiscovery, dnaWeights, appliedDnaWeights]);

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

  const clearSearch = () => { setSearchInput(""); setSearchQuery(""); };
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
    const current = safeLibrary.get(game.id);
    const newStatus = current?.status === action ? null : action;
    dispatch({ type: "SET_STATUS", gameId: game.id, game, status: newStatus });
    const next = new Map(safeLibrary);
    next.set(game.id, { ...(current ?? { game, isLiked: false, isFavorite: false, playtime: 0 }), status: newStatus });
    syncDNA(next);
    persistLibraryItemFS(user.uid, { game_id: game.id, game_name: game.name, genres: game.genre_slugs ?? [], rating: game.rating ?? 0, status: newStatus, is_liked: current?.isLiked ?? false, is_favorite: current?.isFavorite ?? false, image_url: game.background_image });
    if (newStatus === "playing") { addToast(`🎮 Now playing: ${truncate(game.name, 18)}`, "playing", `play:${game.id}`); onXpGain(XP_EVENTS.playing, game.id, "playing"); }
    if (newStatus === "wishlist") { addToast("Added to Wishlist!", "wishlist", `wl:${game.id}`); onXpGain(XP_EVENTS.wishlist, game.id, "wishlist"); }
    if (newStatus === "played") { addToast("Nice! Marked as Played.", "played", `pl:${game.id}`); onXpGain(XP_EVENTS.played, game.id, "played"); }
    if (!newStatus) addToast("Removed from library", "info", `rm:${game.id}:${Date.now()}`);
  }, [safeLibrary, dispatch, addToast, onXpGain, syncDNA]);

  const handleLike = useCallback(game => {
    const c = safeLibrary.get(game.id);
    const nowLiked = !(c?.isLiked ?? false);
    dispatch({ type: "TOGGLE_LIKE", gameId: game.id, game });
    const n = new Map(safeLibrary);
    n.set(game.id, { ...(c ?? { game, status: null, isFavorite: false, playtime: 0 }), isLiked: nowLiked, isFavorite: nowLiked ? (c?.isFavorite ?? false) : false });
    syncDNA(n);
    persistLibraryItemFS(user.uid, { game_id: game.id, game_name: game.name, genres: game.genre_slugs ?? [], rating: game.rating ?? 0, status: c?.status ?? null, is_liked: nowLiked, is_favorite: nowLiked ? (c?.isFavorite ?? false) : false, image_url: game.background_image });
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
    persistLibraryItemFS(user.uid, { game_id: game.id, game_name: game.name, genres: game.genre_slugs ?? [], rating: game.rating ?? 0, status: c?.status ?? null, is_liked: nowFav ? true : (c?.isLiked ?? false), is_favorite: nowFav, image_url: game.background_image });
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
      dnaWeights,
      isDiscovery,
    }),
    [handleLibraryAction, handleLike, handleFavorite, isUpcomingSection, dnaWeights, isDiscovery]
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
    if (loading && !games.length) return "INITIALIZING…";
    if (totalFilterCount > 0) return `Filtered · ${totalFilterCount} active`;
    if (isDiscovery) {
      if (dnaWeights) {
        const topGenre = Object.entries(dnaWeights).sort((a, b) => b[1] - a[1])[0];
        if (topGenre && topGenre[1] > 20) {
          const genreName = DNA_GENRES.find(g => g.slug === topGenre[0])?.label || topGenre[0];
          return `Based on your love for ${genreName}`;
        }
      }
      return "Neural Discovery Active";
    }
    if (activeSection === TIMELINE_LATEST) return "Current Era (2024–2026)";
    if (activeSection === TIMELINE_UPCOMING) return "Future Projects";
    if (isRetro) return "Retro Archive (1980–2005)";
    if (isFreeGames) return "Free-to-Play";
    if (activeSection === TOP_2026_SLUG) return "Best of 2026";
    if (activeSection === POPULAR_2025_SLUG) return "Popular of 2025";
    if (activeSection === ALL_TIME_SLUG) return "All-time Classics";
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
                  { s: TIMELINE_LATEST, label: "Latest 2026", Icon: Clock, active: activeSection === TIMELINE_LATEST },
                  { s: TIMELINE_UPCOMING, label: "Upcoming", Icon: CalendarClock, active: activeSection === TIMELINE_UPCOMING },
                  { s: RETRO_CLASSICS_SLUG, label: "Retro Classics", Icon: History, active: isRetro },
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
                  { s: TOP_2026_SLUG, label: "Best of 2026", Icon: Trophy, active: activeSection === TOP_2026_SLUG },
                  { s: POPULAR_2025_SLUG, label: "Popular of 2025", Icon: TrendingUp, active: activeSection === POPULAR_2025_SLUG },
                  { s: ALL_TIME_SLUG, label: "All-time Top Games", Icon: Star, active: activeSection === ALL_TIME_SLUG },
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
                  const fkey = PORTAL_FILTER_MAP[id] ?? id;
                  const selCount = activeFilters[fkey]?.size ?? 0;
                  const isOpen = portalTarget === id;
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
                    {fetchedSvmMode === "svm" ? "DNA Active"
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
              onFavorite={handleFavorite}
              dnaWeights={dnaWeights} />
          )}

          {/* Status bar */}
          <div className="content-statusbar">
            <span className="status-label">{statusLabel}</span>

            {isDiscovery && (
              <motion.button
                className={`recalibrate-btn ${syncPulse ? "sync-pulse" : ""}`}
                onClick={() => {
                  const freshWeights = { ...dnaWeights };
                  setAppliedDnaWeights(freshWeights);
                  setRecalibrateTick(prev => prev + 1);
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
                  dnaWeights={dnaWeights}
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
  const { user, loading: authLoading } = useFirebaseUser();
  const [view, setView] = useState("entry");
  const [userMode, setUserMode] = useState("guest");
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [dnaWeights, setDnaWeights] = useState(null);
  const [dnaOffsets, setDnaOffsets] = useState({});
  const [xp, setXp] = useState(0);
  const [muted, setMuted] = useState(false);
  const [corrupted, setCorrupted] = useState(false);
  const [dashKey, setDashKey] = useState(0);
  const [siteTint, setSiteTint] = useState(null);
  const [levelJustUp, setLevelJustUp] = useState(false);
  const [isFirstLoad, setIsFirstLoad] = useState(false);

  /* overlayGame holds the full game object (from card) for instant open */
  const [overlayGame, setOverlayGame] = useState(null);

  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [svmMode, setSvmMode] = useState("raw");
  const [isDiscoveryActive, setIsDiscoveryActive] = useState(false);
  const searchRef = useRef(null);

  const firstLoadFired = useRef(false);
  const [library, dispatch] = useReducer(libraryReducer, new Map());
  const { toasts, addToast } = useToast();
  const prevLevel = useRef(1);
  const xpGranted = useRef(new Set());

  const [playHum1] = useSound(SFX.hum1, { volume: 0.35, soundEnabled: !muted });
  const [playHum2] = useSound(SFX.hum2, { volume: 0.35, soundEnabled: !muted });
  const [playHum3] = useSound(SFX.hum3, { volume: 0.35, soundEnabled: !muted });
  const [playChime] = useSound(SFX.chime, { volume: 0.55, soundEnabled: !muted });
  const [playDizzy] = useSound(SFX.dizzy, { volume: 0.40, soundEnabled: !muted });
  const [playSad] = useSound(SFX.sad, { volume: 0.40, soundEnabled: !muted });
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

  /* Reset scroll position of any view on navigation transition */
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
    // Delayed call to ensure DOM has rendered new layout structures completely
    const timer = setTimeout(() => {
      document.querySelectorAll(".full-page-scroll, .main-content").forEach(el => {
        el.scrollTo({ top: 0, behavior: "instant" });
      });
    }, 50);
    return () => clearTimeout(timer);
  }, [view]);

  useEffect(() => {
    if (authLoading) return;
    if (user) {
      setIsLoggedIn(true);
      setUserMode(user.isAnonymous ? "guest" : "user");
      // Load library from Firestore
      fetchLibraryFS(user.uid).then(rows => {
        if (rows?.length) dispatch({ type: "HYDRATE", rows });
      });
      // If we're on entry page and just logged in, auto-enter
      // Auto-redirect disabled for UI testing:
      // if (view === "entry") setView("dashboard");
    } else {
      setIsLoggedIn(false);
      setUserMode("guest");
    }
  }, [user, authLoading, view]);

  useEffect(() => {
    if (!(library instanceof Map) || library.size === 0) return;
    const weights = applyDnaOffsets(library, dnaOffsets);
    setDnaWeights(weights);
    if (user?.uid) saveDNAWeightsFS(user.uid, weights);
  }, [library, dnaOffsets, user?.uid]);

  useEffect(() => {
    if (!corrupted) return;
    const t = setTimeout(() => setCorrupted(false), 30000);
    return () => clearTimeout(t);
  }, [corrupted]);

  const handleToggleMute = useCallback(() => setMuted(v => { if (!v) playSad?.(); return !v; }), [playSad]);
  const handleSiteTintChange = useCallback(t => setSiteTint(t), []);
  const handleSearch = e => { e?.preventDefault(); setSearchQuery(searchInput.trim()); };
  const handleClearSearch = () => { setSearchInput(""); setSearchQuery(""); };

  const handleEnter = async (action, email, password, extra) => {
    try {
      if (action === "guest") {
        await loginAsGuest();
      } else if (action === "google") {
        const result = await loginWithGoogle();
        if (result?.linkRequired) return result;
      } else if (action === "link") {
        const googleCred = extra;
        await linkAccounts(email, password, googleCred);
      } else if (action === "login") {
        await loginWithEmail(email, password);
      } else if (action === "register") {
        await registerUser(email, password);
        addToast('Registration successful! Your email is verified via OTP.', 'success');
      }

      // Explicitly set view for manual auth actions
      setView("dashboard");
      setDashKey(k => k + 1);
      if (!firstLoadFired.current) {
        firstLoadFired.current = true;
        setIsFirstLoad(true);
        setTimeout(() => setIsFirstLoad(false), 1800);
      }
    } catch (error) {
      if (error.message === 'ACCOUNT_NOT_FOUND') {
        const customErr = new Error("No account linked to this Google profile. Please Register first to set a master password.");
        if (error.email) customErr.email = error.email;
        addToast(customErr.message, "error", "auth-err");
        throw customErr;
      }

      const visualErrors = ['auth/user-not-found', 'auth/wrong-password', 'auth/invalid-credential'];
      if (!visualErrors.includes(error.code)) {
        addToast("Authentication failed", "error", "auth-err");
      }
      throw error;
    }
  };

  const handleLogout = useCallback(async () => {
    try {
      await logoutUser();
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
    } catch (error) {
      addToast("Logout failed", "error", "logout-err");
    }
  }, [addToast]);

  const level = getLevel(xp);
  const title = getTitle(level);
  const xpProgress = getXpProgress(xp);

  const libEntries = useMemo(() => Array.from((library instanceof Map ? library : new Map()).values()), [library]);
  const wishlistCount = useMemo(() => libEntries.filter(e => e.status === "wishlist").length, [libEntries]);
  const playedCount = useMemo(() => libEntries.filter(e => e.status === "played").length, [libEntries]);
  const playingCount = useMemo(() => libEntries.filter(e => e.status === "playing").length, [libEntries]);
  const likedCount = useMemo(() => libEntries.filter(e => e.isLiked).length, [libEntries]);

  const sharedLib = { library, dispatch, addToast };

  // ── Auth Loading Guard ───────────────────────────────────────────────────
  if (authLoading) {
    return (
      <div className="view-guard">
        <div className="view-guard-inner">
          <div className="view-guard-scan" />
          <div className="view-guard-dots">
            {[0, 1, 2].map(i => <div key={i} className="view-guard-dot" style={{ animationDelay: `${i * 0.18}s` }} />)}
          </div>
          <span className="view-guard-label">INITIALISING SYSTEMS…</span>
        </div>
      </div>
    );
  }

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
              isFirstLoad={isFirstLoad} searchRef={searchRef}
              onOverlayOpen={setOverlayGame} />

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
                        view={view}
                        userMode={userMode} isLoggedIn={isLoggedIn} user={user}
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
                          user={user}
                          dnaWeights={dnaWeights} onDnaWeightsChange={setDnaWeights}
                          dnaOffsets={dnaOffsets} onDnaOffsetsChange={setDnaOffsets}
                          xp={xp} onXpGain={handleXpGain}
                          onBack={() => { setDashKey(k => k + 1); setView("dashboard"); }}
                          onGameClick={game => setOverlayGame(game)} />
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
                  user={user}
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