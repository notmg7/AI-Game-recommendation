/**
 * GlitchPet.jsx — Game Discovery Engine  V10 "Precision Movement"
 * ════════════════════════════════════════════════════════════════════════
 * Changes from V9.7:
 *  1. MOVEMENT — Glitch stays perfectly still while chat is open.
 *     Walk-home starts exactly 1.5 s AFTER chat closes (not before).
 *     The stranded-watcher useEffect is restructured to guarantee this.
 *  2. HEARTBEAT — 2-minute interval, 30% chance to show a random HAPPY_TIP.
 *     Timer resets whenever chatOpen, muted, or isDragging changes,
 *     so Glitch never speaks mid-conversation or while being dragged.
 *  3. All V9.7 stability features preserved (walkIdRef, onUpdate tracking).
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence, useAnimation } from "framer-motion";
import { X, Send, Volume2, VolumeX, RefreshCw } from "lucide-react";
import { getTitle } from "./shared.js";

/* ── Dialogue banks ─────────────────────────────────────────────────────────── */
const HAPPY_TIPS  = ["like 5 games. i get smarter. go.", "fav a game. Glitch will remember.", "Discovery Hub = ur taste, amplified.", "the radar doesn't lie. ur just RPG.", "try Discovery Hub. trust the machine.", "5 clicks on my face. dare you.", "playtime hours = XP. log them.", "ur DNA is... statistically chaotic.", "i see all likes. all of them.", "no DNA yet? give me 5 likes."];
const MUTED_TIPS  = ["-_-", ">.<", "...", "rude.", "*glitching silently*"];
const DRAG_GRUMPY = ["Put. Me. Back.", "Hiking? Seriously?", "Move me or lose me.", "Drag ends. Grudge begins.", "Not a toy."];
const DRAG_LONELY = ["It's dark out here...", "Don't leave me in the CSS margins.", "Base feels so far away.", "This is not my home.", "Is anyone out there?"];
const HOME_LINES  = ["Home sweet home! 🏠", "Thanks for the lift!", "Finally. My base.", "Back where I belong.", "Ah. The dock."];
const HACKER_SPEAK= ["SYST3M C0MPR0M1S3D >:)", "ur DNA = m1ne now", "0100110101000101", "v1be ch3ck: FA1L3D", "gl1tch.exe: CHAO5 M0DE", "r3b00t1ng... jk ur stuck", "1 4M 3V3RYW3R3"];
const AI_REPLIES  = ["SVM's on it. check Discovery Hub. 👾", "idk but i'd rate that 4.7.", "ur DNA says RPG. ur heart says also RPG.", "radar knows. trust radar.", "i asked the algorithm. it said 'probably'.", "like every game and see what happens", "i am Game Discovery. Game Discovery is me.", "that's a you problem tbh", "have u tried the Retro Classics section", "skill issue. also check your DNA panel."];

function getDragLine() { const b = Math.random() < 0.5 ? DRAG_GRUMPY : DRAG_LONELY; return b[Math.floor(Math.random() * b.length)]; }
function getHomeLine() { return HOME_LINES[Math.floor(Math.random() * HOME_LINES.length)]; }

function GlitchFace({ muted, corrupted, dizzy, blinking, isOpen }) {
  if (corrupted) return <span className="gp-face gp-face--corrupted">X_X</span>;
  if (dizzy)     return <span className="gp-face gp-face--dizzy">@_@</span>;
  if (muted)     return <span className="gp-face gp-face--sad">{blinking ? ";-;" : ">_<"}</span>;
  if (isOpen)    return <span className="gp-face gp-face--happy">{blinking ? "^.^" : "^ω^"}</span>;
  return              <span className="gp-face gp-face--happy">{blinking ? "^_^" : "◕ω◕"}</span>;
}

function glitchTitle(level) {
  return ["Baby Glitch","Curious","Chatty","Hyped","Scout","Analyst","Tracker","Watcher","Seeker","Radar","Phantom","Specter","Ghost Chip","Core Unit","Signal","Nexus","Apex Probe","Neural Drift","Data Wraith","GLITCH PRIME"][Math.max(0, level - 1)] ?? "Glitch";
}

/* ── Library Mini HUD ───────────────────────────────────────────────────────── */
function LibMiniHUD({ level, xpProgress, muted, onToggleMute, visible }) {
  const isMax = level >= 20;
  return (
    <motion.div className="gp-lib-hud gp-lib-hud--v9"
      initial={{ opacity: 0, y: 6, scale: 0.88 }}
      animate={{ opacity: visible ? 1 : 0, y: visible ? 0 : 6, scale: visible ? 1 : 0.88 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      style={{ pointerEvents: visible ? "all" : "none" }}>
      <div className="gp-lib-hud-row1">
        <span className="gp-lib-hud-badge">{isMax ? "👑" : `Lv${level}`}</span>
        <span className={`gp-lib-hud-gamer-title ${isMax ? "gp-lib-hud-gamer-title--max" : ""}`}>{isMax ? "GLITCH PRIME" : glitchTitle(level)}</span>
        <button className={`gp-lib-hud-mute-circle ${muted ? "gp-lib-hud-mute-circle--on" : ""}`} onClick={e => { e.stopPropagation(); onToggleMute(); }}>
          {muted ? <VolumeX size={11} /> : <Volume2 size={11} />}
        </button>
      </div>
      <div className="gp-lib-hud-xp-track">
        <motion.div className="gp-lib-hud-xp-fill" initial={{ width: 0 }} animate={{ width: `${xpProgress.pct}%` }} transition={{ type: "spring", stiffness: 100, damping: 20, delay: 0.1 }} />
      </div>
      <span className="gp-lib-hud-xp-label">{isMax ? "MAX XP" : `${xpProgress.current} / ${xpProgress.next} XP`}</span>
    </motion.div>
  );
}

/* ── Main Component ─────────────────────────────────────────────────────────── */
export default function GlitchPet({
  level, xpProgress, muted, corrupted, levelJustUp, view,
  onToggleMute, playHum, playDizzy, playSad, playGlitch,
  onCorrupt, onUncorrupt, dnaWeights, libraryCount,
}) {
  const [chatOpen,      setChatOpen]      = useState(false);
  const [msgs,          setMsgs]          = useState([{ role: "ai", text: "hey. i'm Glitch — ur Discovery guide. ask me stuff 🎮" }]);
  const [input,         setInput]         = useState("");
  const [bubble,        setBubble]        = useState(null);
  const [blinking,      setBlinking]      = useState(false);
  const [dizzy,         setDizzy]         = useState(false);
  const [isDragging,    setIsDragging]    = useState(false);
  const [clickCount,    setClickCount]    = useState(0);
  const [libHudVisible, setLibHudVisible] = useState(false);
  const [loading, setLoading] = useState(false);

  const faceControls  = useAnimation();
  const bubbleTimer   = useRef(null);
  const dizzyTimer    = useRef(null);
  const constraintRef = useRef(null);
  const baseRef       = useRef(null);

  /* V9.7 stability refs */
  const currentPos = useRef({ x: 0, y: 0 });
  const walkIdRef  = useRef(0);
  const isWalking  = useRef(false);

  const isMax   = level >= 20;
  const showBase = view === "dashboard";

  /* ── Movement Engine ── */
  const stopAllMovement = useCallback(() => {
    walkIdRef.current += 1;
    isWalking.current  = false;
    faceControls.stop();
    clearTimeout(dizzyTimer.current);
    setBubble(null);
  }, [faceControls]);

  const startWalkHome = useCallback(() => {
    /* GUARD: never walk while chat is open, while being dragged, or if already home */
    if (isDragging || chatOpen) return;
    if (currentPos.current.x === 0 && currentPos.current.y === 0) return;

    const myWalkId    = ++walkIdRef.current;
    isWalking.current = true;
    setDizzy(true);

    faceControls.start({
      x: 0, y: 0,
      transition: { duration: 5, ease: "linear" },
      onUpdate: latest => {
        currentPos.current = { x: latest.x, y: latest.y };
      },
    }).then(def => {
      if (def && myWalkId === walkIdRef.current) {
        isWalking.current         = false;
        currentPos.current        = { x: 0, y: 0 };
        setDizzy(false);
        setBubble("finally. home.");
        bubbleTimer.current = setTimeout(() => setBubble(null), 3000);
      }
    });
  }, [faceControls, isDragging, chatOpen]);

  /* ── Stranded Watcher ───────────────────────────────────────────────────────
   * Fires ONLY when chatOpen transitions to false.
   * Waits 1.5 s then starts walk home — provided chat is still closed.
   * While chatOpen is true: stop any running walk immediately.
   */
  useEffect(() => {
    if (chatOpen) {
      /* Chat just opened — freeze Glitch in place */
      stopAllMovement();
      return;
    }

    /* Chat just closed (or not open) — schedule walk home if displaced */
    if (!isDragging && (currentPos.current.x !== 0 || currentPos.current.y !== 0) && !isWalking.current) {
      const timer = setTimeout(() => {
        /* Re-check all guards after the delay */
        if (!chatOpen && !isDragging) startWalkHome();
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [chatOpen, isDragging, startWalkHome, stopAllMovement]);

  /* ── Heartbeat: 2-minute tip cadence (30% chance) ──────────────────────────
   * Reset whenever chatOpen / muted / isDragging changes so Glitch
   * never interrupts an open conversation or drag session.
   */
  useEffect(() => {
    if (chatOpen || muted || isDragging) return;

    const heartbeat = setInterval(() => {
      if (Math.random() < 0.30) {
        const tip = HAPPY_TIPS[Math.floor(Math.random() * HAPPY_TIPS.length)];
        setBubble(tip);
        clearTimeout(bubbleTimer.current);
        bubbleTimer.current = setTimeout(() => setBubble(null), 8000);
      }
    }, 120_000); /* 2 minutes */

    return () => clearInterval(heartbeat);
  }, [chatOpen, muted, isDragging]);

  /* ── Drag Logic ── */
  const handleDrag = useCallback((event, info) => {
    currentPos.current = { x: info.offset.x, y: info.offset.y };
    let over = false;
    if (baseRef.current) {
      const r = baseRef.current.getBoundingClientRect();
      over = (info.point.x >= r.left && info.point.x <= r.right && info.point.y >= r.top && info.point.y <= r.bottom);
    } else {
      over = Math.sqrt(info.offset.x ** 2 + info.offset.y ** 2) <= 120;
    }
    if (over) {
      setDizzy(false);
      if (bubble !== "Home?") setBubble("Home?");
    } else {
      setDizzy(true);
      if (bubble === "Home?" || !bubble) setBubble(getDragLine());
    }
  }, [bubble]);

  const handleDragStart = useCallback(() => {
    setIsDragging(true);
    stopAllMovement();
    setDizzy(true);
  }, [stopAllMovement]);

  const handleDragEnd = useCallback((event, info) => {
    setIsDragging(false);
    currentPos.current = { x: info.offset.x, y: info.offset.y };

    let over = false;
    if (baseRef.current) {
      const r = baseRef.current.getBoundingClientRect();
      over = (info.point.x >= r.left && info.point.x <= r.right && info.point.y >= r.top && info.point.y <= r.bottom);
    }

    if (over) {
      stopAllMovement();
      currentPos.current = { x: 0, y: 0 };
      faceControls.start({ x: 0, y: 0, transition: { type: "spring", stiffness: 250, damping: 25 } })
        .then(() => setDizzy(false));
      setBubble(getHomeLine());
      clearTimeout(bubbleTimer.current);
      bubbleTimer.current = setTimeout(() => setBubble(null), 4000);
      playHum?.();
    } else {
      /* Not dropped on base → walk home after a short beat */
      dizzyTimer.current = setTimeout(startWalkHome, 1000);
    }
  }, [faceControls, playHum, startWalkHome, stopAllMovement]);

  /* ── Step 4: Proactive Neural Insights ── */
useEffect(() => {
  // Logic: Only speak if chat is closed, Glitch isn't being dragged, and we have DNA data
  if (!dnaWeights || chatOpen || isDragging) return;

  // Find the highest-weighted genre in the current DNA
  const entries = Object.entries(dnaWeights);
  if (entries.length === 0) return;

  // Sort genres to find the "peak"
  const [topGenre, score] = entries.sort(([, a], [, b]) => b - a)[0];

  // If a genre is dominant (over 85%), Glitch provides a proactive tip
  if (score > 85) {
    const insights = [
      `Neural Alert: Your ${topGenre} affinity is peaking!`,
      `I've re-prioritized the hub for your ${topGenre} focus.`,
      `That ${topGenre} score is massive. Trust the radar.`,
      `DNA Shift detected: You're entering a ${topGenre} phase.`
    ];
    
    // Pick a random line from the bank above
    const pick = insights[Math.floor(Math.random() * insights.length)];
    setBubble(pick);

    // Clear the bubble after 7 seconds so it doesn't clutter the screen
    const timer = setTimeout(() => setBubble(null), 7000);
    return () => clearTimeout(timer);
  }
}, [dnaWeights, chatOpen, isDragging]);

  /* ── Face click ── */
  const handleFaceClick = useCallback(() => {
    if (isDragging) return;
    if (corrupted) { onUncorrupt?.(); return; }

    if (!chatOpen) {
      /* Opening chat — freeze Glitch */
      stopAllMovement();
    }

    setClickCount(c => {
      const n = c + 1;
      if (n >= 5) { onCorrupt?.(); return 0; }
      return n;
    });
    setChatOpen(v => !v);
    playHum?.();
  }, [isDragging, corrupted, chatOpen, onCorrupt, onUncorrupt, playHum, stopAllMovement]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    
    // 1. Add the user's message to the chat immediately
  setMsgs(p => [...p, { role: "user", text }]);
  setInput("");
  setLoading(true);
  playHum?.();

  // 2. Local personality check (optional)
  if (corrupted) {
    const hackerReply = HACKER_SPEAK[Math.floor(Math.random() * HACKER_SPEAK.length)];
    setMsgs(p => [...p, { role: "ai", text: hackerReply }]);
    setLoading(false);
    return;
  }

  try {
    // 3. The Neural Link: Fetch from your Flask API
    const response = await fetch('http://127.0.0.1:5000/api/glitch/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        message: text, 
        dnaWeights: dnaWeights, 
        libCount: libraryCount
      }),
    });

    const data = await response.json();
    
    // 4. Add Glitch's intelligent response to the chat
    setMsgs(p => [...p, { role: "ai", text: data.reply }]);
  } catch (error) {
    console.error("Neural Link Error:", error);
    setMsgs(p => [...p, { role: "ai", text: "ERROR: Neural link unstable. Recalibrating..." }]);
  } finally {
    setLoading(false);
  }
}, [input, corrupted, muted, playHum, dnaWeights, loading, libraryCount]);

  /* ── Render ── */
  return (
    <>
      <div ref={constraintRef} className="glitch-drag-surface" aria-hidden />

      {showBase ? (
        <div
          ref={baseRef}
          className={["glitch-command-center", corrupted ? "gcc--corrupted" : "", isMax ? "gcc--max" : "", levelJustUp ? "gcc--shake" : ""].filter(Boolean).join(" ")}
          style={{ zIndex: 9999 }}>
          <div className="gcc-pixel-grid" aria-hidden />
          <div className="gcc-label-row">
            <span className="gcc-label">{corrupted ? "⚠ GL1TCH BASE ⚠" : "GLITCH'S COMMAND CENTER"}</span>
            <button className={`gcc-mute-btn ${muted ? "gcc-mute-btn--on" : ""}`} onClick={onToggleMute}>
              {muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
            </button>
          </div>
          <div className="gcc-interior">
            <div className="gcc-face-zone">
              <motion.div
                className="gp-draggable-head"
                drag dragMomentum={false} dragElastic={0.08}
                dragConstraints={constraintRef}
                animate={faceControls}
                onDragStart={handleDragStart}
                onDrag={handleDrag}
                onDragEnd={handleDragEnd}>

                {/* Auto-bubble — hidden while chat open */}
                <AnimatePresence>
                  {bubble && !chatOpen && (
                    <motion.div className="gp-auto-bubble"
                      initial={{ opacity: 0, y: 6, scale: 0.92 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 6, scale: 0.92 }}>
                      <span>{bubble}</span>
                      <button className="gp-bubble-close" onClick={() => setBubble(null)}><X size={10} /></button>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Chat panel */}
                <AnimatePresence>
                  {chatOpen && (
                    <motion.div className="glitch-chat-panel"
                      initial={{ opacity: 0, y: 12, scale: 0.94 }}
                      animate={{ opacity: 1, y: 0,  scale: 1   }}
                      exit={{    opacity: 0, y: 12, scale: 0.94 }}>
                      <div className="glitch-chat-header">
                        <span className="glitch-chat-title">{corrupted ? "GL1TCH.EX3" : "Glitch"}</span>
                        <button className="glitch-chat-close" onClick={() => setChatOpen(false)}><X size={13} /></button>
                      </div>
                      <div className="glitch-chat-msgs">
                        {msgs.map((m, i) => (
                          <div key={i} className={`glitch-chat-msg glitch-chat-msg--${m.role}`}>{m.text}</div>
                        ))}
                        <div ref={el => el?.scrollIntoView({ behavior: "smooth" })} />
                      </div>
                      <div className="glitch-chat-input-row">
                        <input
                          className="glitch-chat-input"
                          placeholder="Ask Glitch..."
                          value={input}
                          onChange={e => setInput(e.target.value)}
                          onKeyDown={e => e.key === "Enter" && send()} />
                        <button className="glitch-chat-send" onClick={send} disabled={loading}>
                        {loading ? (
                          <motion.div 
                            animate={{ rotate: 360 }} 
                            transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                            style={{ display: 'flex' }}
                          >
                            <RefreshCw size={13} /> {/* Note: Ensure RefreshCw is imported from lucide-react at the top */}
                          </motion.div>
                        ) : (
                          <Send size={13} />
                        )}
                      </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Face button */}
                <motion.button
                  className={[
                    "gp-face-btn",
                    corrupted ? "gp-face-btn--corrupted" : "",
                    isMax     ? "gp-face-btn--max"       : "",
                    chatOpen  ? "gp-face-btn--open"      : "",
                    dizzy     ? "gp-face-btn--dizzy"     : "",
                  ].filter(Boolean).join(" ")}
                  onClick={handleFaceClick}>
                  <GlitchFace muted={muted} corrupted={corrupted} dizzy={dizzy} blinking={blinking} isOpen={chatOpen} />
                  <div className={`gp-level-badge ${isMax ? "gp-level-badge--max" : ""}`}>{isMax ? "👑" : `Lv${level}`}</div>
                </motion.button>
              </motion.div>
            </div>
            <div className="gcc-info-col">
              <span className="gcc-gamer-title">{isMax ? "GLITCH PRIME 👑" : glitchTitle(level)}</span>
              <div className="gcc-xp-wrap">
                <div className="gcc-xp-bar">
                  <motion.div className="gcc-xp-fill" style={{ width: `${xpProgress.pct}%` }} layout
                    transition={{ type: "spring", stiffness: 120, damping: 20 }} />
                </div>
                <span className="gcc-xp-label">{isMax ? "MAX" : `${xpProgress.current}/${xpProgress.next} XP`}</span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="glitch-solo-head" style={{ zIndex: 9999 }}
          onMouseEnter={() => setLibHudVisible(true)}
          onMouseLeave={() => setLibHudVisible(false)}>
          <motion.div
            className="gp-draggable-head gp-draggable-head--solo"
            drag dragMomentum={false} dragElastic={0.08}
            dragConstraints={constraintRef}
            animate={faceControls}
            onDragStart={handleDragStart}
            onDrag={handleDrag}
            onDragEnd={handleDragEnd}>
            <AnimatePresence>
              {bubble && !chatOpen && (
                <motion.div className="gp-auto-bubble"
                  initial={{ opacity: 0, y: 6, scale: 0.92 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 6, scale: 0.92 }}>
                  <span>{bubble}</span>
                </motion.div>
              )}
            </AnimatePresence>
            <motion.button
              className={["gp-face-btn gp-face-btn--solo", corrupted ? "gp-face-btn--corrupted" : "", dizzy ? "gp-face-btn--dizzy" : ""].filter(Boolean).join(" ")}
              onClick={handleFaceClick}>
              <GlitchFace muted={muted} corrupted={corrupted} dizzy={dizzy} blinking={blinking} isOpen={chatOpen} />
              <div className="gp-level-badge">{isMax ? "👑" : `Lv${level}`}</div>
            </motion.button>
            <LibMiniHUD level={level} xpProgress={xpProgress} muted={muted} onToggleMute={onToggleMute} visible={libHudVisible} />
          </motion.div>
        </div>
      )}
    </>
  );
}