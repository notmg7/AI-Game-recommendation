/**
 * GameDetailOverlay.jsx — Game Discovery Engine  V10 "Lightweight Modal"
 * ════════════════════════════════════════════════════════════════════════
 * REWRITE from V9.3:
 *  - Opens instantly using the `game` card object from parent (no loading state for header/hero)
 *  - Skeleton loaders for description and gallery while they fetch in background
 *  - Removed: System Requirements, HLTB estimate logic
 *  - Leaner fetch: only screenshots + stores (async, non-blocking)
 *  - Retained: Library actions, store badges, tags, meta, trailer link, ESC to close
 */

import { useState, useEffect, useCallback, memo } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, Star, Calendar, Clock, Cpu, Users, Shield, Tag,
  Bookmark, Play, Heart, ExternalLink,
  ChevronLeft, ChevronRight, ShoppingCart, Check,
  Gamepad, Gamepad2, Youtube, AlertTriangle,
} from "lucide-react";
import {
  API_BASE, truncate, ratingColor, isNewRelease,
} from "./shared.js";
import { persistLibraryItemFS } from "./firebaseLibrary.js";

/* ── Skeleton block ──────────────────────────────────────────────────────────── */
function Skeleton({ width = "100%", height = 16, radius = 6, className = "" }) {
  return (
    <div
      className={`skeleton-block ${className}`}
      style={{ width, height, borderRadius: radius }}
      aria-hidden
    />
  );
}

/* ── Gallery ─────────────────────────────────────────────────────────────────── */
function Gallery({ screenshots, heroImage, gameName, loading }) {
  const images = [
    ...(heroImage ? [{ id: "hero", image: heroImage }] : []),
    ...(screenshots ?? []),
  ];
  const [idx, setIdx] = useState(0);

  if (loading) {
    return (
      <div className="ov-gallery ov-gallery--skeleton">
        <Skeleton width="100%" height={220} radius={10} />
      </div>
    );
  }
  if (!images.length) return null;

  const prev = e => { e.stopPropagation(); setIdx(i => (i - 1 + images.length) % images.length); };
  const next = e => { e.stopPropagation(); setIdx(i => (i + 1) % images.length); };

  return (
    <div className="ov-gallery" onClick={e => e.stopPropagation()}>
      <AnimatePresence mode="wait">
        <motion.img
          key={idx}
          src={images[idx].image}
          alt={`${gameName} screenshot ${idx + 1}`}
          className="ov-gallery-img"
          initial={{ opacity: 0, x: 12, filter: "brightness(1.5) saturate(0)" }}
          animate={{ opacity: 1, x: 0,  filter: "brightness(1) saturate(1)"  }}
          exit={{    opacity: 0        }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
        />
      </AnimatePresence>
      {images.length > 1 && (
        <>
          <button className="ov-gal-btn ov-gal-btn--prev" onClick={prev}><ChevronLeft size={18} /></button>
          <button className="ov-gal-btn ov-gal-btn--next" onClick={next}><ChevronRight size={18} /></button>
          <div className="ov-gal-counter">{idx + 1}/{images.length}</div>
          <div className="ov-gal-thumbs">
            {images.map((img, i) => (
              <button key={i}
                className={`ov-gal-thumb ${i === idx ? "ov-gal-thumb--active" : ""}`}
                onClick={e => { e.stopPropagation(); setIdx(i); }}>
                <img src={img.image} alt="" />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ── Description block ───────────────────────────────────────────────────────── */
function DescriptionBlock({ text, loading }) {
  if (loading) {
    return (
      <div className="ov-section">
        <h3 className="ov-section-title">About</h3>
        <div className="ov-desc-skeleton">
          <Skeleton width="100%" height={13} radius={4} />
          <Skeleton width="92%"  height={13} radius={4} />
          <Skeleton width="97%"  height={13} radius={4} />
          <Skeleton width="76%"  height={13} radius={4} />
        </div>
      </div>
    );
  }
  if (!text) return null;
  const clean = text.replace(/<[^>]+>/g, "");
  return (
    <section className="ov-section">
      <h3 className="ov-section-title">About</h3>
      <p className="ov-description">
        {clean.slice(0, 800)}{clean.length > 800 ? "…" : ""}
      </p>
    </section>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Main component
   ════════════════════════════════════════════════════════════════════════════ */
const GameDetailOverlay = memo(function GameDetailOverlay({
  gameId,
  game: cardGame,   // The card's game object — used immediately for instant render
  library,
  dispatch,
  addToast,
  onClose,
  user,
}) {
  /* --- Immediately available from the card --- */
  const [detailGame,   setDetailGame]   = useState(cardGame ?? null);
  const [screenshots,  setScreenshots]  = useState([]);
  const [stores,       setStores]       = useState([]);
  const [bgLoading,    setBgLoading]    = useState(true); // background fetch in progress
  const [error,        setError]        = useState(null);

  /* Background fetch: detail + screenshots + stores */
  useEffect(() => {
    if (!gameId) return;
    let cancelled = false;
    setBgLoading(true);
    setError(null);

    (async () => {
      try {
        const [gRes, ssRes, stRes] = await Promise.allSettled([
          fetch(`${API_BASE}/games/${gameId}`),
          fetch(`${API_BASE}/games/${gameId}/screenshots`),
          fetch(`${API_BASE}/games/${gameId}/stores`),
        ]);
        if (cancelled) return;

        const fullGame = (gRes.status === "fulfilled" && gRes.value.ok)
          ? await gRes.value.json() : null;
        const newSS    = (ssRes.status === "fulfilled" && ssRes.value.ok)
          ? ((await ssRes.value.json()).results ?? []) : [];
        const newSt    = (stRes.status === "fulfilled" && stRes.value.ok)
          ? ((await stRes.value.json()).results ?? []) : [];

        if (!cancelled) {
          if (fullGame) setDetailGame(fullGame);
          else if (!cardGame) setError("Game not found");
          setScreenshots(newSS);
          setStores(newSt);
        }
      } catch (e) {
        if (!cancelled) {
          /* non-fatal — we already have cardGame shown */
          console.warn("GameDetailOverlay bg fetch error:", e);
        }
      } finally {
        if (!cancelled) setBgLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [gameId]);

  /* ESC to close */
  useEffect(() => {
    const h = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  /* Use best available game object — cardGame instantly, then fullGame when ready */
  const game = detailGame ?? cardGame;

  /* Library state */
  const entry        = game ? library.get(game.id) : null;
  const isPlaying    = entry?.status === "playing";
  const isWishlisted = entry?.status === "wishlist";
  const isPlayed     = entry?.status === "played";
  const isLiked      = entry?.isLiked    ?? false;
  const isFavorite   = entry?.isFavorite ?? false;

  const buildGameObj = g => ({
    id: g.id, name: g.name,
    genre_slugs:      g.genre_slugs      ?? [],
    rating:           g.rating           ?? 0,
    background_image: g.background_image ?? null,
  });

  const persist = (g, e) => persistLibraryItemFS(user?.uid, {
    game_id: g.id, game_name: g.name,
    genres: g.genre_slugs ?? [], rating: g.rating ?? 0,
    status: e.status ?? null, is_liked: e.isLiked ?? false, is_favorite: e.isFavorite ?? false,
  });

  const toggle = useCallback(statusKey => {
    if (!game) return;
    const cur       = library.get(game.id) ?? { game: buildGameObj(game), status: null, isLiked: false, isFavorite: false, playtime: 0 };
    const newStatus = cur.status === statusKey ? null : statusKey;
    dispatch({ type: "SET_STATUS", gameId: game.id, game: buildGameObj(game), status: newStatus });
    persist(game, { ...cur, status: newStatus });
    if      (newStatus === "playing")  addToast(`🎮 Playing: ${truncate(game.name, 18)}`, "playing");
    else if (newStatus === "wishlist") addToast("Wishlisted", "wishlist");
    else if (newStatus === "played")   addToast("Marked as Played", "played");
    else                               addToast("Removed", "info");
  }, [game, library, dispatch, addToast]); // eslint-disable-line

  const toggleLike = useCallback(() => {
    if (!game) return;
    const cur      = library.get(game.id) ?? { game: buildGameObj(game), status: null, isLiked: false, isFavorite: false, playtime: 0 };
    const nowLiked = !cur.isLiked;
    dispatch({ type: "TOGGLE_LIKE", gameId: game.id, game: buildGameObj(game) });
    persist(game, { ...cur, isLiked: nowLiked, isFavorite: nowLiked ? cur.isFavorite : false });
    addToast(nowLiked ? `Liked "${truncate(game.name, 20)}"` : "Unliked", nowLiked ? "liked" : "info");
  }, [game, library, dispatch, addToast]); // eslint-disable-line

  const toggleFav = useCallback(() => {
    if (!game) return;
    const cur    = library.get(game.id) ?? { game: buildGameObj(game), status: null, isLiked: true, isFavorite: false, playtime: 0 };
    const nowFav = !cur.isFavorite;
    dispatch({ type: "TOGGLE_FAVORITE", gameId: game.id, game: buildGameObj(game) });
    persist(game, { ...cur, isFavorite: nowFav, isLiked: nowFav ? true : cur.isLiked });
    addToast(nowFav ? "⭐ Favorited — 3× SVM weight" : "Removed from favorites", nowFav ? "liked" : "info");
  }, [game, library, dispatch, addToast]); // eslint-disable-line

  const trailerUrl = game?.clip?.clip
    ? game.clip.clip
    : game?.name
      ? `https://www.youtube.com/results?search_query=${encodeURIComponent(game.name + " official trailer")}`
      : null;

  /* No game at all — show error state */
  if (!game && error) {
    return createPortal(
      <motion.div className="cyber-portal-backdrop"
        style={{ backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" }}
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={onClose}>
        <motion.div className="cyber-portal-modal"
          initial={{ opacity: 0, scale: 0.9, y: 24 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: 24 }}
          transition={{ type: "spring", stiffness: 340, damping: 28 }}
          onClick={e => e.stopPropagation()}>
          <div className="cyber-portal-neon-border" aria-hidden />
          <div className="ov-header">
            <div className="ov-header-left"><Gamepad2 size={16} /><span className="ov-header-title">Game Details</span></div>
            <button className="ov-close" onClick={onClose}><X size={20} /></button>
          </div>
          <div className="ov-state ov-state--error">
            <AlertTriangle size={36} />
            <p>Could not load game data.</p>
          </div>
        </motion.div>
      </motion.div>,
      document.body
    );
  }

  return createPortal(
    <motion.div
      className="cyber-portal-backdrop"
      style={{ backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={onClose}>

      <motion.div
        className="cyber-portal-modal"
        initial={{ opacity: 0, scale: 0.9, y: 24 }}
        animate={{ opacity: 1, scale: 1,   y: 0  }}
        exit={{    opacity: 0, scale: 0.9, y: 24  }}
        transition={{ type: "spring", stiffness: 340, damping: 28 }}
        onClick={e => e.stopPropagation()}>

        <div className="cyber-portal-neon-border" aria-hidden />
        <div className="cyber-portal-scanlines"   aria-hidden />

        {/* ── Header — instant, no loading state ── */}
        <div className="ov-header">
          <div className="ov-header-left">
            <Gamepad2 size={16} className="ov-header-icon" />
            <span className="ov-header-title">
              {game?.name ?? "Game Details"}
            </span>
            {game && isNewRelease(game.released) && <span className="ov-new-chip">NEW</span>}
          </div>
          <div className="ov-header-right">
            {trailerUrl && game && (
              <a href={trailerUrl} target="_blank" rel="noopener noreferrer"
                className="ov-trailer-btn" onClick={e => e.stopPropagation()}>
                <Youtube size={14} /><span>Watch Trailer</span>
              </a>
            )}
            <button className="ov-close" onClick={e => { e.stopPropagation(); onClose(); }} aria-label="Close">
              <X size={20} />
            </button>
          </div>
        </div>

        {/* ── Body ── */}
        <div className="ov-body">
          {game ? (
            <div className="ov-layout">

              {/* LEFT COLUMN */}
              <div className="ov-left">

                {/* Gallery — skeleton until bg fetch resolves */}
                <Gallery
                  screenshots={screenshots}
                  heroImage={game.background_image_additional || game.background_image}
                  gameName={game.name}
                  loading={bgLoading && screenshots.length === 0}
                />

                {/* Description — skeleton until detail fetch resolves */}
                <DescriptionBlock
                  text={game.description_raw}
                  loading={bgLoading && !game.description_raw}
                />

                {/* Tags */}
                {game.tags?.length > 0 && (
                  <section className="ov-section">
                    <h3 className="ov-section-title">Tags</h3>
                    <div className="ov-tags">
                      <Tag size={12} />
                      {game.tags.map(t => <span key={t} className="ov-tag">{t}</span>)}
                    </div>
                  </section>
                )}

              </div>

              {/* RIGHT COLUMN */}
              <aside className="ov-right">

                <div className="ov-title-block">
                  <h1 className="ov-game-title">{game.name}</h1>
                  <div className="ov-genres">
                    {game.genres?.map(g => <span key={g} className="ov-genre-chip">{g}</span>)}
                  </div>
                </div>

                {game.rating != null && (
                  <div className="ov-rating">
                    <Star size={20} fill="currentColor" style={{ color: ratingColor(game.rating) }} />
                    <span className="ov-rating-val" style={{ color: ratingColor(game.rating) }}>
                      {game.rating.toFixed(1)}
                    </span>
                    <span className="ov-rating-top">/ {game.rating_top ?? 5}</span>
                  </div>
                )}

                <ul className="ov-meta-list">
                  {[
                    { Icon: Calendar, label: "Released",  value: game.released                              ?? "Unknown"   },
                    { Icon: Clock,    label: "Playtime",  value: game.playtime ? `~${game.playtime}h`       : "Unknown"    },
                    { Icon: Cpu,      label: "Platforms", value: game.platforms?.slice(0, 3).join(", ")      ?? "—"         },
                    { Icon: Users,    label: "Developer", value: game.developers?.slice(0, 2).join(", ")     ?? "—"         },
                    { Icon: Shield,   label: "ESRB",      value: game.esrb_rating                           ?? "Not Rated" },
                  ].map(({ Icon, label, value }) => (
                    <li key={label} className="ov-meta-row">
                      <Icon size={13} className="ov-meta-icon" />
                      <span className="ov-meta-label">{label}</span>
                      <span className="ov-meta-value">{value}</span>
                    </li>
                  ))}
                </ul>

                <div className="ov-actions">
                  <button
                    className={`ov-action-btn ov-action-btn--playing ${isPlaying ? "ov-action-btn--on" : ""}`}
                    onClick={e => { e.stopPropagation(); toggle("playing"); }}>
                    <Gamepad size={14} fill={isPlaying ? "currentColor" : "none"} />
                    <span>{isPlaying ? "Playing Now ✓" : "Mark as Playing"}</span>
                    {isPlaying && <Check size={12} />}
                  </button>
                  <button
                    className={`ov-action-btn ${isWishlisted ? "ov-action-btn--on" : ""}`}
                    onClick={e => { e.stopPropagation(); toggle("wishlist"); }}>
                    <Bookmark size={14} fill={isWishlisted ? "currentColor" : "none"} />
                    <span>{isWishlisted ? "Wishlisted" : "Wishlist"}</span>
                  </button>
                  <button
                    className={`ov-action-btn ov-action-btn--played ${isPlayed ? "ov-action-btn--on" : ""}`}
                    onClick={e => { e.stopPropagation(); toggle("played"); }}>
                    <Play size={14} fill={isPlayed ? "currentColor" : "none"} />
                    <span>{isPlayed ? "Played ✓" : "Mark as Played"}</span>
                  </button>
                  <button
                    className={`ov-action-btn ov-action-btn--like ${isLiked ? "ov-action-btn--liked" : ""}`}
                    onClick={e => { e.stopPropagation(); toggleLike(); }}>
                    <Heart size={14} fill={isLiked ? "currentColor" : "none"} />
                    <span>{isLiked ? "Liked ♥" : "Like"}</span>
                  </button>
                  {isLiked && (
                    <button
                      className={`ov-action-btn ov-action-btn--fav ${isFavorite ? "ov-action-btn--fav-on" : ""}`}
                      onClick={e => { e.stopPropagation(); toggleFav(); }}>
                      <Star size={14} fill={isFavorite ? "currentColor" : "none"} />
                      <span>{isFavorite ? "Fav (3×)" : "Favorite for AI"}</span>
                    </button>
                  )}
                </div>

                {/* Stores — appear when bg fetch resolves */}
                {!bgLoading && stores.length > 0 && (
                  <div className="ov-stores">
                    <p className="ov-stores-label">Available On</p>
                    <div className="ov-store-badges">
                      {stores.map(s => (
                        <a key={s.store_id} href={s.url || "#"} target="_blank" rel="noopener noreferrer"
                          className="ov-store-badge" style={{ "--sc": s.color }}
                          onClick={e => e.stopPropagation()}>
                          <ShoppingCart size={11} /><span>{s.name}</span>
                          {s.url && <ExternalLink size={9} />}
                        </a>
                      ))}
                    </div>
                  </div>
                )}
                {bgLoading && (
                  <div className="ov-stores-skeleton">
                    <Skeleton width={80} height={11} radius={4} />
                    <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                      <Skeleton width={72} height={28} radius={6} />
                      <Skeleton width={64} height={28} radius={6} />
                    </div>
                  </div>
                )}

                {game.website && (
                  <a href={game.website} target="_blank" rel="noopener noreferrer"
                    className="ov-website-btn"
                    onClick={e => e.stopPropagation()}>
                    <span>Official Website</span><ExternalLink size={13} />
                  </a>
                )}

                {game.publishers?.length > 0 && (
                  <div className="ov-publishers">
                    <span className="ov-pub-label">Published by</span>
                    <span className="ov-pub-value">{game.publishers.slice(0, 2).join(", ")}</span>
                  </div>
                )}

              </aside>
            </div>
          ) : (
            /* Rare case: cardGame was null and detail fetch is still in flight */
            <div className="ov-state">
              <div className="ov-scan-loader">
                <div className="ov-scan-bar" />
                <p className="ov-scan-label">SCANNING GAME DATA…</p>
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>,
    document.body
  );
});

export default GameDetailOverlay;