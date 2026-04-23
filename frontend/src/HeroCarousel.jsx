/**
 * HeroCarousel.jsx — Vanguard Edition
 * ════════════════════════════════════════════════════════════════════════
 * Auto-scrolling hero banner showing top recently-released games.
 * Extracts a dominant hue from each slide's image via a hidden canvas
 * and emits onColorChange(hsl) so the parent can tint the whole page.
 *
 * Props:
 *   onCardClick   – (game) => void
 *   onColorChange – (hslString) => void  e.g. "210deg, 80%, 40%"
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, ChevronRight, Star, Flame, Gamepad2 } from "lucide-react";
import { API_BASE, ratingColor, isNewRelease } from "./shared.js";

// Extract dominant colour from an image URL via canvas sampling
function extractDominantHSL(imgUrl, callback) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    try {
      const canvas  = document.createElement("canvas");
      canvas.width  = 32; canvas.height = 18;
      const ctx     = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, 32, 18);
      const pixels = ctx.getImageData(0, 0, 32, 18).data;
      let r = 0, g = 0, b = 0, cnt = 0;
      for (let i = 0; i < pixels.length; i += 16) {
        r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2]; cnt++;
      }
      r = Math.round(r / cnt); g = Math.round(g / cnt); b = Math.round(b / cnt);
      // Convert RGB → HSL
      const rn = r / 255, gn = g / 255, bn = b / 255;
      const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
      const l   = (max + min) / 2;
      const d   = max - min;
      let h = 0, s = 0;
      if (d > 0.01) {
        s = d / (l < 0.5 ? max + min : 2 - max - min);
        if (max === rn) h = ((gn - bn) / d) % 6;
        else if (max === gn) h = (bn - rn) / d + 2;
        else h = (rn - gn) / d + 4;
        h = Math.round(h * 60);
        if (h < 0) h += 360;
      }
      callback(`${h}deg, ${Math.round(s * 100)}%, ${Math.round(l * 35 + 10)}%`);
    } catch { callback(null); }
  };
  img.onerror = () => callback(null);
  img.src = imgUrl;
}

export default function HeroCarousel({ onCardClick, onColorChange }) {
  const [games,   setGames]   = useState([]);
  const [idx,     setIdx]     = useState(0);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef(null);
  const prevColor = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/games?page_size=8&ordering=-released&metacritic=70,100`)
      .then((r) => r.ok ? r.json() : { results: [] })
      .then((d) => {
        if (!cancelled) {
          setGames(d.results?.slice(0, 6) ?? []);
          setLoading(false);
        }
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const goTo = useCallback((i) => {
    clearInterval(timerRef.current);
    setIdx(i);
  }, []);

  // Auto-advance
  useEffect(() => {
    if (games.length < 2) return;
    timerRef.current = setInterval(() => setIdx((i) => (i + 1) % games.length), 5500);
    return () => clearInterval(timerRef.current);
  }, [games.length]);

  // Colour extraction for site tint
  useEffect(() => {
    const game = games[idx];
    if (!game?.background_image) return;
    extractDominantHSL(game.background_image, (hsl) => {
      if (hsl && hsl !== prevColor.current) {
        prevColor.current = hsl;
        onColorChange?.(hsl);
      }
    });
  }, [idx, games, onColorChange]);

  if (loading) {
    return (
      <div className="hero-carousel hero-carousel--loading">
        <div className="hero-skeleton" />
      </div>
    );
  }
  if (!games.length) return null;

  const game = games[idx];

  return (
    <div className="hero-carousel">
      <AnimatePresence mode="wait">
        <motion.div key={game.id} className="hero-slide"
          initial={{ opacity: 0, scale: 1.04 }}
          animate={{ opacity: 1,  scale: 1    }}
          exit={{    opacity: 0,  scale: 0.97  }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        >
          {game.background_image && (
            <img src={game.background_image} alt={game.name} className="hero-bg" />
          )}
          <div className="hero-gradient" />
          <div className="hero-gradient hero-gradient--bottom" />

          <div className="hero-content">
            <div className="hero-pills">
              <span className="hero-pill hero-pill--featured"><Flame size={11} />Vanguard Hit</span>
              {isNewRelease(game.released) && <span className="hero-pill hero-pill--new">NEW</span>}
            </div>
            <h2 className="hero-title">{game.name}</h2>
            <div className="hero-meta">
              {game.tags?.slice(0, 3).map((g) => <span key={g} className="hero-genre-chip">{g}</span>)}
              <span className="hero-rating" style={{ color: ratingColor(game.rating) }}>
                <Star size={13} fill="currentColor" />{game.rating?.toFixed(1)}
              </span>
              {game.released && <span className="hero-released">{game.released}</span>}
            </div>
            <button className="hero-cta" onClick={() => onCardClick(game)}>
              <Gamepad2 size={15} /><span>View Details</span>
              <ChevronRight size={14} />
            </button>
          </div>

          {/* Arrows */}
          <button className="hero-arrow hero-arrow--prev" onClick={(e) => { e.stopPropagation(); goTo((idx - 1 + games.length) % games.length); }}><ChevronLeft  size={22} /></button>
          <button className="hero-arrow hero-arrow--next" onClick={(e) => { e.stopPropagation(); goTo((idx + 1) % games.length); }}><ChevronRight size={22} /></button>

          {/* Dot indicators */}
          <div className="hero-dots">
            {games.map((_, i) => (
              <button key={i}
                className={`hero-dot ${i === idx ? "hero-dot--active" : ""}`}
                onClick={(e) => { e.stopPropagation(); goTo(i); }}
              />
            ))}
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}