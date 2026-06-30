/* =========================================================================
   utils.js — math, RNG, and small helpers shared across the whole game.
   Pure JS, no Three.js dependency, so it is unit-testable in Node.
   ========================================================================= */

export const TAU = Math.PI * 2;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const EPSILON = 1e-6;

/* ---- scalar math ------------------------------------------------------- */

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function invLerp(a, b, v) { return (v - a) / (b - a); }
export function remap(v, inMin, inMax, outMin, outMax) {
  return lerp(outMin, outMax, clamp01(invLerp(inMin, inMax, v)));
}
export function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
export function smootherstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * t * (t * (t * 6 - 15) + 10);
}
export function sign(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }
export function mod(n, m) { return ((n % m) + m) % m; }     // always-positive modulo
export function floorDiv(n, m) { return Math.floor(n / m); }
export function fract(x) { return x - Math.floor(x); }
export function approach(current, target, delta) {
  if (current < target) return Math.min(current + delta, target);
  if (current > target) return Math.max(current - delta, target);
  return target;
}
export function damp(current, target, lambda, dt) {
  // Frame-rate independent exponential smoothing.
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}
export function wrapAngle(a) {
  a = mod(a + Math.PI, TAU) - Math.PI;
  return a;
}
export function angleLerp(a, b, t) {
  return a + wrapAngle(b - a) * t;
}
export function roundTo(v, step) { return Math.round(v / step) * step; }

/* ---- deterministic RNG ------------------------------------------------- */

// 32-bit hash of an integer. Good enough for procedural seeding.
export function hashInt(x) {
  x |= 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = x ^ (x >>> 16);
  return x >>> 0;
}

// Combine several integers into one 32-bit seed (order matters).
export function hashCombine(...nums) {
  let h = 0x811c9dc5;
  for (let i = 0; i < nums.length; i++) {
    h ^= (nums[i] | 0);
    h = Math.imul(h, 0x01000193);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

// Hash a string to a 32-bit unsigned int (FNV-1a). Used for world seeds.
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Mulberry32 PRNG factory — returns a function producing floats in [0,1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic value in [0,1) from coordinates + seed (no allocation).
export function valueNoise2(x, y, seed) {
  return hashCombine(seed, x | 0, y | 0) / 4294967296;
}
export function valueNoise3(x, y, z, seed) {
  return hashCombine(seed, x | 0, y | 0, z | 0) / 4294967296;
}

// A tiny RNG object with conveniences, seeded once.
export class RNG {
  constructor(seed = 1) {
    this.seed = (typeof seed === 'string' ? hashString(seed) : seed) >>> 0;
    this.next = mulberry32(this.seed);
  }
  float(min = 0, max = 1) { return min + (max - min) * this.next(); }
  int(min, max) { return Math.floor(this.float(min, max + 1)); } // inclusive
  bool(p = 0.5) { return this.next() < p; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  weighted(items) {
    // items: [{ value, weight }]
    let total = 0;
    for (const it of items) total += it.weight;
    let r = this.next() * total;
    for (const it of items) { r -= it.weight; if (r <= 0) return it.value; }
    return items[items.length - 1].value;
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  // Gaussian via Box-Muller.
  gaussian(mean = 0, std = 1) {
    let u = 0, v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
  }
}

/* ---- vector helpers (plain {x,y,z} objects) ---------------------------- */

export const Vec = {
  create(x = 0, y = 0, z = 0) { return { x, y, z }; },
  set(o, x, y, z) { o.x = x; o.y = y; o.z = z; return o; },
  copy(o, a) { o.x = a.x; o.y = a.y; o.z = a.z; return o; },
  add(o, a, b) { o.x = a.x + b.x; o.y = a.y + b.y; o.z = a.z + b.z; return o; },
  sub(o, a, b) { o.x = a.x - b.x; o.y = a.y - b.y; o.z = a.z - b.z; return o; },
  scale(o, a, s) { o.x = a.x * s; o.y = a.y * s; o.z = a.z * s; return o; },
  dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; },
  lenSq(a) { return a.x * a.x + a.y * a.y + a.z * a.z; },
  len(a) { return Math.sqrt(Vec.lenSq(a)); },
  distSq(a, b) { const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; return dx * dx + dy * dy + dz * dz; },
  dist(a, b) { return Math.sqrt(Vec.distSq(a, b)); },
  normalize(o, a) {
    const l = Vec.len(a) || 1;
    o.x = a.x / l; o.y = a.y / l; o.z = a.z / l; return o;
  },
};

export function dist2D(ax, az, bx, bz) {
  const dx = ax - bx, dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}
export function manhattan(ax, ay, bx, by) { return Math.abs(ax - bx) + Math.abs(ay - by); }

/* ---- color helpers ----------------------------------------------------- */

// All colors are [r,g,b] in 0..1 unless noted.
export function rgb(r, g, b) { return [r / 255, g / 255, b / 255]; }
export function mixColor(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}
export function scaleColor(c, s) { return [clamp01(c[0] * s), clamp01(c[1] * s), clamp01(c[2] * s)]; }
export function hexToRgb(hex) {
  hex = hex.replace('#', '');
  const n = parseInt(hex, 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}
export function rgbToHex(c) {
  const f = (v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
  return '#' + f(c[0]) + f(c[1]) + f(c[2]);
}
export function rgbToCss(c, a = 1) {
  return `rgba(${Math.round(clamp01(c[0]) * 255)},${Math.round(clamp01(c[1]) * 255)},${Math.round(clamp01(c[2]) * 255)},${a})`;
}
export function hslToRgb(h, s, l) {
  h = mod(h, 1);
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}
// Add a small deterministic tint variation to a base color (per-voxel flavor).
export function tintVariation(color, x, y, z, seed, amount = 0.06) {
  const n = (valueNoise3(x, y, z, seed) - 0.5) * 2 * amount;
  return [clamp01(color[0] + n), clamp01(color[1] + n), clamp01(color[2] + n)];
}

/* ---- misc -------------------------------------------------------------- */

export function formatTimeOfDay(t01) {
  // t01 in [0,1) → "HH:MM" on a 24h clock (0 = midnight).
  const minutes = Math.floor(t01 * 24 * 60);
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function clam019(v) { return clamp(v | 0, 0, 8); }

export function nowSeconds(perf) {
  // Caller passes a performance.now()-like value (ms); we avoid Date here.
  return (perf || 0) / 1000;
}

export function once(fn) {
  let called = false, result;
  return function (...args) {
    if (!called) { called = true; result = fn.apply(this, args); }
    return result;
  };
}

export function throttle(fn, intervalMs) {
  let last = -Infinity;
  return function (tMs, ...args) {
    if (tMs - last >= intervalMs) { last = tMs; return fn.call(this, tMs, ...args); }
  };
}

// Stable string key for a voxel coordinate (used in edit maps / sets).
export function voxelKey(x, y, z) { return `${x},${y},${z}`; }
export function chunkKey(cx, cz) { return `${cx},${cz}`; }
export function parseKey(k) { return k.split(',').map(Number); }

export function arrayRemove(arr, item) {
  const i = arr.indexOf(item);
  if (i >= 0) arr.splice(i, 1);
  return i >= 0;
}

export function clampedArrayPush(arr, item, max) {
  arr.push(item);
  while (arr.length > max) arr.shift();
  return arr;
}

// Detect touch devices (best-effort; safe to call in Node where it returns false).
export function isTouchDevice() {
  return typeof window !== 'undefined' &&
    ('ontouchstart' in window || (navigator && navigator.maxTouchPoints > 0));
}
