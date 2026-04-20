import { useState, useMemo, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  RefreshCw, X, Radio, Zap, Play, Plus, Minus,
} from "lucide-react";
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis,
  ResponsiveContainer, Tooltip,
} from "recharts";
import { DNA_GENRES, computeDNAScores, normaliseDNA } from "./shared.js";

/* ── News feed ───────────────────────────────────────────────────────────────── */
const NEWS_FEED = [
  { id: 1,  headline: "GTA VI confirmed Fall 2026",              tag: "BREAKING"  },
  { id: 2,  headline: "Microsoft acquires indie studio",          tag: "INDUSTRY"  },
  { id: 3,  headline: "Steam Deck 2 OLED variant rumoured",       tag: "HARDWARE"  },
  { id: 4,  headline: "Elden Ring DLC breaks player records",     tag: "GAMING"    },
  { id: 5,  headline: "Epic Store goes mobile-first Q3",          tag: "BUSINESS"  },
  { id: 6,  headline: "Sony PS6 dev-kit details revealed",        tag: "HARDWARE"  },
  { id: 7,  headline: "Switch 2 launch titles at Direct",         tag: "GAMING"    },
  { id: 8,  headline: "AI NPCs now standard in AAA releases",     tag: "TECH"      },
  { id: 9,  headline: "Starfield DLC Shattered Space reviewed",   tag: "GAMING"    },
  { id: 10, headline: "Unreal Engine 6 preview shown at GDC",     tag: "TECH"      },
];

const TAG_COLORS = {
  breaking: "var(--accent-red)",
  industry: "var(--accent)",
  hardware: "var(--accent-violet)",
  gaming:   "var(--accent-green)",
  business: "var(--accent-amber)",
  tech:     "var(--accent-rose)",
};

/* ── Terminal Briefing ───────────────────────────────────────────────────────── */
function IntelBriefing() {
  const [startIdx, setStartIdx] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setStartIdx(i => (i + 1) % NEWS_FEED.length), 8000);
    return () => clearInterval(t);
  }, []);

  const visible = [0, 1, 2].map(off => NEWS_FEED[(startIdx + off) % NEWS_FEED.length]);

  return (
    <div className="dna-intel-briefing dna-intel-briefing--terminal">
      <div className="dna-intel-scanlines" aria-hidden />
      <div className="dna-intel-header">
        <Radio size={10} className="dna-intel-icon" />
        <span className="dna-intel-title">// DATA STREAM</span>
        <span className="dna-intel-cursor">▌</span>
      </div>
      <div className="dna-intel-lines">
        <AnimatePresence mode="popLayout">
          {visible.map(item => (
            <motion.div
              key={item.id}
              className="dna-intel-line"
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              transition={{ duration: 0.3 }}
            >
              <span
                className="dna-intel-tag"
                style={{ color: TAG_COLORS[item.tag.toLowerCase()] ?? "var(--accent)" }}
              >
                [{item.tag}]
              </span>
              <span className="dna-intel-text">{item.headline}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

/* ── Radar Tooltip ───────────────────────────────────────────────────────────── */
function RadarTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="dna-radar-tip">
      <strong>{d.subject}</strong>
      <span>{d.value}</span>
    </div>
  );
}

/* ── Custom Radar Tick — smaller font so full labels fit ─────────────────────── */
function RadarTick({ payload, x, y, cx, cy, ...rest }) {
  const label = payload.value;
  const dx = (x - cx) * 0.45;
  const dy = (y - cy) * 0.18;
  return (
    <text
      x={x + dx}
      y={y + dy}
      textAnchor="middle"
      dominantBaseline="central"
      /* Change fill to your accent blue or a bright neon hex */
      fill="var(--accent)" 
      style={{ 
        fontSize: 10, 
        fontFamily: "'DM Mono', monospace", 
        userSelect: "none",
        fontWeight: 600,
      }}
    >
      {label}
    </text>
  );
}

/* ── DNABlade ────────────────────────────────────────────────────────────────── */
export default function DNABlade({
  library,
  dnaWeights,
  onWeightsChange,
  dnaOffsets         = {},
  onDnaOffsetsChange = () => {},
  level,
  title,
}) {
  const safeLibrary = library instanceof Map ? library : new Map();
  const [draggingSlug, setDraggingSlug] = useState(null);

  /* ── Base scores from library ──────────────────────────────────────────────── */
  const libraryBase = useMemo(
    () => normaliseDNA(computeDNAScores(safeLibrary)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [safeLibrary.size, JSON.stringify([...safeLibrary.entries()].map(([k, v]) => [k, v.isLiked, v.isFavorite, v.status]))]
  );

  /* ── Local weights = base + offsets, clamped 0–100 ────────────────────────── */
  const localWeights = useMemo(() => {
    const r = {};
    for (const { slug } of DNA_GENRES) {
      r[slug] = Math.max(0, Math.min(100, (libraryBase[slug] ?? 50) + (dnaOffsets[slug] ?? 0)));
    }
    return r;
  }, [libraryBase, dnaOffsets]);

  /* Propagate weights up to App every time they change */
  useEffect(() => {
    onWeightsChange(localWeights);
  }, [localWeights, onWeightsChange]);

  const radarData = useMemo(
    () => DNA_GENRES.map(({ slug, label }) => ({
      subject:  label,
      value:    localWeights[slug] ?? 0,
      fullMark: 100,
    })),
    [localWeights]
  );

  const hasOffsets = useMemo(
    () => Object.values(dnaOffsets).some(v => v !== 0),
    [dnaOffsets]
  );

  /* ── Slider interaction → manual mode ─────────────────────────────────────── */
  const handleSlider = useCallback((slug, newVal) => {
    const val  = Number(newVal);
    const base = libraryBase[slug] ?? 50;
    onDnaOffsetsChange(prev => ({ ...prev, [slug]: val - base }));
  }, [libraryBase, onDnaOffsetsChange]);

  /* ── +/- nudge buttons (2% step) ──────────────────────────────────────────── */
  const handleNudge = useCallback((slug, delta) => {
    const current = localWeights[slug] ?? 50;
    const newVal  = Math.max(0, Math.min(100, current + delta));
    const base    = libraryBase[slug] ?? 50;
    onDnaOffsetsChange(prev => ({ ...prev, [slug]: newVal - base }));
  }, [localWeights, libraryBase, onDnaOffsetsChange]);

  const handleResumeAutoSync = () => onDnaOffsetsChange({});
  const handleReset = useCallback(() => {
  const zeroOffsets = {};
  DNA_GENRES.forEach(({ slug }) => {
    zeroOffsets[slug] = -(libraryBase[slug] ?? 50);
  });
  onDnaOffsetsChange(zeroOffsets);
}, [libraryBase, onDnaOffsetsChange]);

  const radarColor = hasOffsets ? "#FFD700" : "var(--accent)";

  return (
    <motion.div
      className="dna-blade"
      initial={{ x: 288, opacity: 0 }}
      animate={{ x: 0,   opacity: 1 }}
      exit={{    x: 288, opacity: 0 }}
      transition={{ duration: 0.38, ease: [0.16, 1, 0.3, 1] }}
      style={{ width: 288, flexShrink: 0 }}
    >
      <div className="dna-blade-inner">
        <div className="dna-blade-scroll">

          {/* ── Chart header with Zap icon as sole manual indicator ── */}
          <div className="dna-chart-header" style={{ height: '24px', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="dna-chart-label">DNA Chart</span>
            <AnimatePresence>
              {hasOffsets && (
                <motion.span
                  className="dna-manual-label"
                  initial={{ opacity: 0, x: 5 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{    opacity: 0, x: 5 }}
                  style={{
                    fontSize: '9px',
                    fontWeight: 800,
                    color: '#FFD700',
                    letterSpacing: '1px',
                    textTransform: 'uppercase',
                    border: '1px solid #FFD700',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    background: 'rgba(255, 215, 0, 0.1)'
                  }}
                >
                  MANUAL
                </motion.span>
              )}
            </AnimatePresence>
          </div>

          {/* ── Radar ── */}
          <div className="dna-radar-wrap">
            <ResponsiveContainer width="100%" height={218}>
              <RadarChart cx="50%" cy="50%" outerRadius="60%" data={radarData} margin={{ top: 10, right: 30, bottom: 10, left: 30 }}>
                <PolarGrid stroke="rgba(255,255,255,0.05)" />
                <PolarAngleAxis
                  dataKey="subject"
                  tick={<RadarTick />}
                />
                <Radar
                  name="DNA"
                  dataKey="value"
                  stroke={radarColor}
                  fill={radarColor}
                  fillOpacity={0.15}
                  strokeWidth={1.6}
                />
                <Tooltip content={<RadarTooltip />} />
              </RadarChart>
            </ResponsiveContainer>
          </div>

          {/* ── Sliders with +/- nudge buttons ── */}
          <div className="dna-sliders">
            {DNA_GENRES.map(({ slug, label }) => {
              const val         = localWeights[slug] ?? 0;
              const isManual    = (dnaOffsets[slug] ?? 0) !== 0;
              const isThisDragging = draggingSlug === slug;

              return (
                <div key={slug} className={`dna-slider-row ${isManual ? "dna-slider-row--offset" : ""}`}>
                  <span className="dna-slider-label">{label}</span>
                  <div className="dna-slider-control">
                    {/* Minus button */}
                    <button
                      className="dna-nudge-btn"
                      onClick={() => handleNudge(slug, -2)}
                      aria-label={`Decrease ${label}`}
                      disabled={val <= 0}
                    >
                      <Minus size={9} />
                    </button>

                    <input
                      type="range" min="0" max="100" step="1"
                      value={val}
                      onChange={e => handleSlider(slug, e.target.value)}
                      onMouseDown={() => setDraggingSlug(slug)}
                      onMouseUp={() => setDraggingSlug(null)}
                      onTouchStart={() => setDraggingSlug(slug)}
                      onTouchEnd={() => setDraggingSlug(null)}
                      className={`dna-slider ${isManual ? "dna-slider--manual" : ""} ${isThisDragging ? "is-dragging" : ""}`}
                      aria-label={label}
                      style={{ "--dna-fill": `${val}%` }}
                    />

                    {/* Plus button */}
                    <button
                      className="dna-nudge-btn"
                      onClick={() => handleNudge(slug, 2)}
                      aria-label={`Increase ${label}`}
                      disabled={val >= 100}
                    >
                      <Plus size={9} />
                    </button>
                  </div>
                  <span
                    className="dna-slider-val"
                    style={isManual ? { color: "#FFD700", fontWeight: 700 } : {}}
                  >
                    {val}
                  </span>
                </div>
              );
            })}
          </div>

          <div className="dna-actions">
            <button className="dna-action-btn dna-action-btn--sync" onClick={handleResumeAutoSync}>
              <RefreshCw size={12} /><span>AUTO SYNC</span>
            </button>
            <button className="dna-action-btn dna-action-btn--reset" onClick={handleReset}>
              <X size={12} /><span>Reset</span>
            </button>
          </div>
        </div>
        <div className="dna-intel-spacer" />
        <IntelBriefing />
      </div>
    </motion.div>
  );
}