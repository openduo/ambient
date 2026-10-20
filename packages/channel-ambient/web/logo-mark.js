// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/* global requestAnimationFrame, ResizeObserver, devicePixelRatio */
/**
 * The 多多 mark as 多多's live state, drawn the way the phone app draws it. Motion says what it is
 * doing (the coat dozes, cocks its head to listen, its voice bars move to think and speak); a halo
 * behind it says the same in colour, readable from across a room. Listening follows the microphone
 * and speaking aloud follows this device's playback.
 *
 * Ink displays get one still frame per mood: a ring stands in for the halo, and nothing animates.
 * Under reduced motion the frame is still and the halo keeps its colour.
 */
import { LOGO } from "./logo-geometry.js";

/** idle | listening | hearing | thinking | speaking | speaking-aloud | unavailable */
export const MOODS = [
  "idle",
  "listening",
  "hearing",
  "thinking",
  "speaking",
  "speaking-aloud",
  "unavailable"
];

const PALETTE = {
  light: {
    ink: "#1c1c1a",
    off: "#abaaa5",
    coat: "#faf9f5",
    bars: "#1c1c1a",
    accent: "#ee7fae",
    teal: "#2bb5b9",
    violet: "#8e7cf0",
    pink: "#ee7fae"
  },
  dark: {
    ink: "#faf9f5",
    off: "#8d8c86",
    coat: "#3a3835",
    bars: "#1fd9de",
    accent: "#f7a8c8",
    teal: "#1fd9de",
    violet: "#a594ff",
    pink: "#f7a8c8"
  },
  ink: { ink: "#000", off: "#8c8c8c", coat: "#fff", bars: "#000", accent: "#000" }
};

/** Colour and strength (0…1) of the halo; none while idle or unavailable. */
function halo(mood, t, lv, colors) {
  switch (mood) {
    case "listening":
      return [colors.teal, 0.35 + 0.65 * lv];
    case "hearing":
      return [colors.teal, 0.7 + 0.3 * lv];
    case "thinking":
      return [colors.violet, 0.6 + 0.25 * Math.sin(t * 2)];
    case "speaking-aloud":
      return [colors.pink, 0.45 + 0.55 * lv];
    case "speaking":
      return [colors.pink, 0.65 + 0.15 * Math.sin(t * 3)];
    default:
      return null;
  }
}

function rgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${Math.max(0, Math.min(1, alpha))})`;
}

/** Draws one frame of `mood` at time `t` (seconds) and level `lv` (0…1) into a 2D context. */
export function drawMark(ctx, size, { mood, t, lv, theme }) {
  const ink = theme === "ink";
  const colors = PALETTE[theme];
  const side = size;
  const c = side / 2;
  const r = side / 2;
  ctx.clearRect(0, 0, side, side);

  const off = mood === "unavailable";
  if (ink) {
    // A ring stands in for the halo: working or not, readable without colour or motion.
    if (!off && mood !== "idle") {
      ctx.beginPath();
      ctx.arc(c, c, r * 0.94, 0, Math.PI * 2);
      ctx.strokeStyle = colors.ink;
      ctx.lineWidth = Math.max(2, side * 0.03);
      ctx.stroke();
    }
  } else {
    const h = halo(mood, t, lv, colors);
    if (h) {
      const [color, strength] = h;
      const g = ctx.createRadialGradient(c, c, 0, c, c, r * (0.9 + 0.1 * lv));
      // Strongest at the coat's edge (about 0.62 of the radius).
      g.addColorStop(0.6, rgba(color, 0.95 * strength));
      g.addColorStop(0.78, rgba(color, 0.5 * strength));
      g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c, c, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // The mark leaves the outer ring of the frame to the halo. Display only.
  const k = (side / LOGO.side) * 0.7;
  const doze = mood === "idle" ? 1 : 0;
  const still = off ? 0 : 1;
  const breathe =
    1 + still * (0.02 + 0.03 * doze) * Math.sin((t * 2 * Math.PI) / (3.4 + 1.6 * doze));
  const tilt =
    mood === "listening"
      ? -10 + 3 * Math.sin(t * 1.3)
      : mood === "hearing"
        ? -14 + 2 * Math.sin(t * 2.1)
        : mood === "idle"
          ? -6
          : 0;

  ctx.save();
  // Logo units to pixels, then tilt and squash about the feet (512, 820).
  ctx.translate(c - (LOGO.side * k) / 2, c - (LOGO.side * k) / 2);
  ctx.scale(k, k);
  ctx.translate(-LOGO.origin.x, -LOGO.origin.y);
  ctx.translate(512, 820);
  ctx.rotate((tilt * Math.PI) / 180);
  ctx.scale(breathe, 1 / breathe);
  ctx.translate(-512, -820);

  const line = off ? colors.off : colors.ink;
  const bars = off ? line : colors.bars;
  const accent = off ? line : colors.accent;
  const o = LOGO.outline;
  ctx.beginPath();
  ctx.moveTo(o[0], o[1]);
  for (let i = 2; i < o.length; i += 2) ctx.lineTo(o[i], o[i + 1]);
  ctx.closePath();
  // Filled so the halo shows around the coat, not through it.
  ctx.fillStyle = colors.coat;
  ctx.fill();
  ctx.strokeStyle = line;
  ctx.lineWidth = LOGO.outlineWidth;
  ctx.lineJoin = "round";
  ctx.stroke();

  ctx.lineCap = "round";
  ctx.lineWidth = LOGO.barWidth;
  LOGO.bars.forEach(([x, y1, y2], i) => {
    const cy = (y1 + y2) / 2;
    const rest = (y2 - y1) / 2;
    const wave = 0.5 + 0.5 * Math.sin(t * 11 + i * 1.7);
    // The bars keep their shape and move with the voice.
    const talk =
      mood === "speaking-aloud"
        ? 70 * lv * (0.55 + 0.45 * wave)
        : mood === "speaking"
          ? 46 * wave
          : 0;
    const think = mood === "thinking" ? 14 * (0.5 + 0.5 * Math.sin(t * 4 + i * 0.9)) : 0;
    const half = (rest + talk + think) * (1 - 0.6 * doze);
    ctx.beginPath();
    ctx.moveTo(x, cy - half);
    ctx.lineTo(x, cy + half);
    ctx.strokeStyle = i === 4 ? accent : bars;
    ctx.stroke();
  });
  ctx.restore();
}

/**
 * Keeps `canvas` drawn. `mood()` and `level(mood)` are read every frame; `theme()` returns
 * light | dark | ink. On ink, or under reduced motion, nothing loops: `update()` redraws the still
 * frame when the mood or theme changed.
 */
export function createLogoMark(canvas, { mood, level, theme, reduceMotion }) {
  const ctx = canvas.getContext("2d");
  let px = 0;
  let value = 0;
  let last = 0;
  let drawn = "";
  let looping = false;

  function fit() {
    const side = Math.round(Math.min(canvas.clientWidth, canvas.clientHeight) * devicePixelRatio);
    if (side > 0 && side !== px) {
      px = side;
      canvas.width = canvas.height = side;
      drawn = "";
    }
    return px > 0;
  }

  function animated() {
    return theme() !== "ink" && !reduceMotion();
  }

  /** Eases the level between audio blocks so the halo does not step. Display only. */
  function step(target, t) {
    const dt = last === 0 ? 0 : Math.min(t - last, 0.1);
    last = t;
    value += (target - value) * (1 - Math.exp(-dt / 0.08));
    return value;
  }

  function frame(ms) {
    if (!animated()) {
      looping = false;
      update();
      return;
    }
    if (fit()) {
      const m = mood();
      const t = ms / 1000;
      drawMark(ctx, px, { mood: m, t, lv: step(level(m), t), theme: theme() });
    }
    requestAnimationFrame(frame);
  }

  function update() {
    if (animated()) {
      if (!looping) {
        looping = true;
        requestAnimationFrame(frame);
      }
      return;
    }
    if (!fit()) return;
    const key = `${mood()}|${theme()}|${px}`;
    if (key === drawn) return;
    drawn = key;
    drawMark(ctx, px, { mood: mood(), t: 0, lv: 0, theme: theme() });
  }

  new ResizeObserver(update).observe(canvas);
  update();
  return { update };
}
