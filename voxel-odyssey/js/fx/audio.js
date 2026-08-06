/* =========================================================================
   audio.js — fully synthesized sound (WebAudio), no audio files.

   Everything you hear in Voxel Odyssey is generated at runtime from
   oscillators and filtered noise: block break/place, footsteps, hurt grunts,
   crafting clicks, eating, level-ups, explosions, and a gentle generative
   ambient soundtrack built from a pentatonic scale.

   Design notes
   ------------
   - The AudioContext is NOT created in init() — browsers require a user
     gesture before audio can start. main.js calls resume() on the first
     click / pointer-lock; resume() lazily creates the context and unlocks it.
   - A single master GainNode sits in front of the destination. SFX and music
     each route through their own sub-gain so volumes are independent and read
     live from settings (masterVolume / sfxVolume / musicVolume).
   - Every public method must no-op safely when the context isn't ready, so
     callers never have to guard. We also bound the number of simultaneous
     voices to keep CPU sane if events spam in (e.g. fast mining).
   - No file is allowed to call Math.random() in a tight loop for world logic,
     but audio is a presentation concern; even so we use a seeded RNG for the
     music scheduler to keep it cheap and pleasant rather than truly random.
   ========================================================================= */

import { clamp, clamp01, RNG } from '../core/utils.js';

// Hard ceiling on concurrently-scheduled SFX voices. Beyond this we drop new
// requests for the current frame so a runaway event storm can't melt the CPU.
const MAX_VOICES = 24;

// A C-major / A-minor pentatonic scale (semitone offsets) used by the music.
// Pentatonic scales never clash, so random walks always sound musical.
const PENTATONIC = [0, 2, 4, 7, 9];

// Base frequency (A2) for the music; the scale is transposed up from here.
const MUSIC_ROOT = 110.0;

export class AudioSystem {
  constructor(game) {
    this.game = game;

    // WebAudio graph (created lazily in resume()).
    this.ctx = null;
    this.master = null;     // master gain -> destination
    this.sfxBus = null;     // sfx gain -> master
    this.musicBus = null;   // music gain -> master
    this.noiseBuffer = null; // shared white-noise buffer for percussive sounds

    // Bookkeeping.
    this.ready = false;       // context exists and is running
    this.activeVoices = 0;    // currently-scheduled SFX voices (approx)
    this.lastStepAt = 0;      // throttle footsteps

    // Music state.
    this.musicOn = false;
    this.musicRng = new RNG(0xC0FFEE);
    this.nextNoteAt = 0;      // ctx time of the next melody note
    this.nextPadAt = 0;       // ctx time of the next pad chord
    this.musicStep = 0;       // index into the melodic walk
    this.padNode = null;      // currently-sustaining pad (so we can stop it)

    this._bound = false;      // event handlers attached?
  }

  /* ---------------------------------------------------------------------- */
  /*  Lifecycle                                                             */
  /* ---------------------------------------------------------------------- */

  // init() intentionally does NOT create the AudioContext (no gesture yet).
  // It only wires up event subscriptions so that once audio is unlocked the
  // game's events automatically produce sound.
  init() {
    this._subscribe();
    return this;
  }

  // Lazily create / resume the AudioContext. Safe to call repeatedly; the
  // first call builds the graph, later calls just resume a suspended context
  // (browsers suspend it when the tab loses focus).
  resume() {
    try {
      if (!this.ctx) {
        const AC = (typeof window !== 'undefined') &&
          (window.AudioContext || window.webkitAudioContext);
        if (!AC) return; // headless / unsupported — stay silent forever.
        this.ctx = new AC();
        this._buildGraph();
      }
      if (this.ctx.state === 'suspended' && this.ctx.resume) {
        this.ctx.resume().catch(() => {});
      }
      this.ready = this.ctx.state === 'running' || this.ctx.state === undefined;
      // Some browsers report 'suspended' until the resume() promise lands; we
      // optimistically mark ready so the first gesture's click is audible.
      this.ready = true;
      this.setVolumes();
    } catch (_) {
      // Never let audio bring the game down.
      this.ctx = null;
      this.ready = false;
    }
  }

  // Build the persistent node graph and the shared noise buffer.
  _buildGraph() {
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 1.0;
    this.master.connect(ctx.destination);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 1.0;
    this.sfxBus.connect(this.master);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 1.0;
    this.musicBus.connect(this.master);

    this.noiseBuffer = this._makeNoiseBuffer(1.0);
    this.setVolumes();
  }

  // Generate ~1s of white noise we can reuse as a BufferSource for percussive
  // effects (footsteps, breaks, splashes, explosions).
  _makeNoiseBuffer(seconds) {
    const ctx = this.ctx;
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    // Deterministic noise so it's allocation-free and consistent.
    const rng = new RNG(0x9E3779B9);
    for (let i = 0; i < len; i++) data[i] = rng.float(-1, 1);
    return buf;
  }

  // Pull current volumes from settings into the gain nodes.
  setVolumes() {
    if (!this.ctx) return;
    const s = (this.game && this.game.state && this.game.state.settings) || {};
    const master = clamp01(s.masterVolume != null ? s.masterVolume : 0.8);
    const sfx = clamp01(s.sfxVolume != null ? s.sfxVolume : 0.9);
    const music = clamp01(s.musicVolume != null ? s.musicVolume : 0.5);
    const t = this.ctx.currentTime;
    // setTargetAtTime gives a tiny smoothing so slider drags don't click.
    if (this.master) this.master.gain.setTargetAtTime(master, t, 0.02);
    if (this.sfxBus) this.sfxBus.gain.setTargetAtTime(sfx, t, 0.02);
    if (this.musicBus) this.musicBus.gain.setTargetAtTime(music, t, 0.05);
  }

  /* ---------------------------------------------------------------------- */
  /*  Event wiring                                                          */
  /* ---------------------------------------------------------------------- */

  _subscribe() {
    if (this._bound) return;
    const ev = this.game && this.game.events;
    if (!ev) return;
    this._bound = true;

    ev.on('sfx', (p) => { if (p) this.play(p.name, p.opts || {}); });

    ev.on('block:break', (p) => {
      this.play('break', { blockId: p && p.blockId });
    });
    ev.on('block:place', (p) => {
      this.play('place', { blockId: p && p.blockId });
    });
    ev.on('player:hurt', () => this.play('hurt'));
    ev.on('craft', () => this.play('craft'));
    ev.on('item:pickup', () => this.play('pickup'));

    // Re-read volumes live when the player tweaks a slider.
    ev.on('settings:change', (p) => {
      if (!p) return;
      if (p.key === '*' || /Volume$/.test(p.key)) this.setVolumes();
    });
  }

  /* ---------------------------------------------------------------------- */
  /*  Per-frame update                                                      */
  /* ---------------------------------------------------------------------- */

  update(dt) {
    if (!this.ready || !this.ctx) return;
    // Drive the generative music scheduler. Look a little ahead of the audio
    // clock so notes are queued before they're needed (smooth even if frames
    // hitch). All scheduling is cheap and bounded.
    if (this.musicOn) {
      try { this._scheduleMusic(); } catch (_) { /* never throw in hot path */ }
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Public SFX entry point                                               */
  /* ---------------------------------------------------------------------- */

  /* Ambient rain bed: looping filtered noise, gain driven by the weather
     system each frame. Created lazily on first use (needs the ctx, which only
     exists after the first user gesture) and never torn down — a zero-gain
     looping source costs effectively nothing. */
  setAmbientRain(level) {
    if (!this.ctx || !this.sfxBus) { this._pendingRain = level; return; }
    if (!this._rainGain) {
      const ctx = this.ctx;
      // 2s of white noise; looped, it reads as steady rain once lowpassed.
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 900;      // hiss -> patter
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.sfxBus);
      src.start();
      this._rainGain = gain;
    }
    const target = Math.max(0, Math.min(1, level)) * 0.14;
    // Smoothed so showers fade in rather than switching on.
    this._rainGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.6);
  }

  // play(name, opts) — synthesize and fire a one-shot sound effect.
  // No-ops safely if the context isn't ready or the name is unknown.
  play(name, opts = {}) {
    if (!this.ready || !this.ctx) return;
    if (this.activeVoices >= MAX_VOICES) return; // bound voices
    try {
      switch (name) {
        case 'break': this._sfxBreak(opts); break;
        case 'place': this._sfxPlace(opts); break;
        case 'step': this._sfxStep(opts); break;
        case 'hurt': this._sfxHurt(opts); break;
        case 'mobHurt': this._sfxMobHurt(opts); break;
        case 'splash': this._sfxSplash(opts); break;
        case 'craft': this._sfxCraft(opts); break;
        case 'eat': this._sfxEat(opts); break;
        case 'click': this._sfxClick(opts); break;
        case 'levelup': this._sfxLevelUp(opts); break;
        case 'explode': this._sfxExplode(opts); break;
        case 'pickup': this._sfxPickup(opts); break;
        default:
          // Unknown name — a soft click so callers get feedback, not silence.
          this._sfxClick(opts);
          break;
      }
    } catch (_) {
      // Swallow — audio must never throw into game logic.
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Low-level synthesis helpers                                          */
  /* ---------------------------------------------------------------------- */

  // Track a voice's lifetime so MAX_VOICES stays meaningful. We increment on
  // start and schedule a decrement slightly after the voice ends.
  _trackVoice(durationSec) {
    this.activeVoices++;
    const ms = Math.max(20, (durationSec + 0.05) * 1000);
    setTimeout(() => { this.activeVoices = Math.max(0, this.activeVoices - 1); }, ms);
  }

  // A single oscillator with an ADSR-ish gain envelope, routed to the sfx bus.
  // Returns the oscillator so callers can add pitch sweeps.
  _tone(opts) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const type = opts.type || 'sine';
    const freq = opts.freq || 220;
    const dur = clamp(opts.dur || 0.15, 0.01, 4);
    const gain = clamp01(opts.gain != null ? opts.gain : 0.3);
    const attack = opts.attack != null ? opts.attack : 0.005;
    const release = opts.release != null ? opts.release : dur;
    const dest = opts.dest || this.sfxBus;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + release);

    // Optional low-pass to soften harsh waveforms.
    let node = osc;
    if (opts.filter) {
      const f = ctx.createBiquadFilter();
      f.type = opts.filter.type || 'lowpass';
      f.frequency.setValueAtTime(opts.filter.freq || 2000, t0);
      if (opts.filter.q != null) f.Q.value = opts.filter.q;
      osc.connect(f); f.connect(g);
      node = f;
    } else {
      osc.connect(g);
    }
    g.connect(dest);

    osc.start(t0);
    osc.stop(t0 + attack + release + 0.02);
    this._trackVoice(attack + release);
    return osc;
  }

  // A burst of filtered noise — the workhorse for percussive/natural sounds.
  _noise(opts) {
    const ctx = this.ctx;
    if (!this.noiseBuffer) return;
    const t0 = ctx.currentTime;
    const dur = clamp(opts.dur || 0.12, 0.01, 2);
    const gain = clamp01(opts.gain != null ? opts.gain : 0.25);
    const dest = opts.dest || this.sfxBus;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    if (opts.playbackRate) src.playbackRate.value = opts.playbackRate;

    const filter = ctx.createBiquadFilter();
    filter.type = opts.filterType || 'lowpass';
    const fStart = opts.filterFreq || 1200;
    filter.frequency.setValueAtTime(fStart, t0);
    if (opts.filterEnd != null) {
      filter.frequency.exponentialRampToValueAtTime(
        Math.max(40, opts.filterEnd), t0 + dur);
    }
    if (opts.q != null) filter.Q.value = opts.q;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t0 + (opts.attack || 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(filter); filter.connect(g); g.connect(dest);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
    this._trackVoice(dur);
  }

  /* ---------------------------------------------------------------------- */
  /*  Concrete sound effects                                               */
  /* ---------------------------------------------------------------------- */

  // Map a block id to a rough material "family" so breaking stone sounds
  // different from breaking wood or dirt.
  _materialOf(blockId) {
    const blocks = this.game && this.game.blocks;
    if (blocks && blockId != null) {
      const def = blocks.get(blockId);
      if (def && def.walkSound) return def.walkSound;
    }
    return 'stone';
  }

  // Tunings keyed by walk-sound family: base filter frequency + pitch flavor.
  _materialTone(material) {
    switch (material) {
      case 'grass': return { freq: 520, q: 0.7, rate: 1.4 };
      case 'wood': return { freq: 760, q: 1.2, rate: 1.0 };
      case 'sand': return { freq: 900, q: 0.5, rate: 1.6 };
      case 'gravel': return { freq: 640, q: 0.8, rate: 1.2 };
      case 'snow': return { freq: 1100, q: 0.4, rate: 1.8 };
      case 'stone':
      default: return { freq: 420, q: 1.4, rate: 0.9 };
    }
  }

  _sfxBreak(opts) {
    const m = this._materialTone(this._materialOf(opts.blockId));
    // Low thud + a short noise crunch.
    this._noise({
      dur: 0.14, gain: 0.32, filterType: 'lowpass',
      filterFreq: m.freq * 2.2, filterEnd: m.freq * 0.5, q: m.q, playbackRate: m.rate,
    });
    this._tone({ type: 'square', freq: 110 * m.rate, dur: 0.1, gain: 0.12, release: 0.1,
      filter: { type: 'lowpass', freq: 600 } });
  }

  _sfxPlace(opts) {
    const m = this._materialTone(this._materialOf(opts.blockId));
    // Crisper, shorter than break — a satisfying "tock".
    this._noise({
      dur: 0.08, gain: 0.26, filterType: 'bandpass',
      filterFreq: m.freq * 1.6, q: 2.0, playbackRate: m.rate * 1.1,
    });
    this._tone({ type: 'sine', freq: 180 * m.rate, dur: 0.07, gain: 0.14, release: 0.07 });
  }

  _sfxStep(opts) {
    // Footsteps are frequent; throttle so they don't pile up.
    const now = this.ctx.currentTime;
    if (now - this.lastStepAt < 0.12) return;
    this.lastStepAt = now;
    const m = this._materialTone(this._materialOf(
      opts.blockId != null ? opts.blockId : undefined) || opts.surface);
    const tone = opts.surface ? this._materialTone(opts.surface) : m;
    this._noise({
      dur: 0.06, gain: 0.12, filterType: 'lowpass',
      filterFreq: tone.freq, filterEnd: tone.freq * 0.6, q: tone.q,
      playbackRate: tone.rate * (0.9 + 0.2 * this.musicRng.next()),
    });
  }

  _sfxHurt() {
    // A short descending grunt.
    const osc = this._tone({ type: 'sawtooth', freq: 300, dur: 0.22, gain: 0.3,
      attack: 0.004, release: 0.22, filter: { type: 'lowpass', freq: 1400 } });
    if (osc) {
      const t0 = this.ctx.currentTime;
      osc.frequency.exponentialRampToValueAtTime(120, t0 + 0.2);
    }
    this._noise({ dur: 0.1, gain: 0.1, filterType: 'highpass', filterFreq: 1200 });
  }

  _sfxMobHurt() {
    // Higher and squelchier than the player's hurt.
    const osc = this._tone({ type: 'square', freq: 440, dur: 0.16, gain: 0.24,
      release: 0.16, filter: { type: 'lowpass', freq: 1800 } });
    if (osc) {
      const t0 = this.ctx.currentTime;
      osc.frequency.exponentialRampToValueAtTime(200, t0 + 0.14);
    }
  }

  _sfxSplash() {
    // Bright noise that opens up then closes — a watery "sploosh".
    this._noise({
      dur: 0.32, gain: 0.26, filterType: 'lowpass',
      filterFreq: 800, filterEnd: 2600, q: 0.7, playbackRate: 1.2,
    });
    this._noise({
      dur: 0.22, gain: 0.16, filterType: 'bandpass',
      filterFreq: 1600, q: 1.5,
    });
  }

  _sfxCraft() {
    // Two quick wooden knocks.
    this._noise({ dur: 0.05, gain: 0.2, filterType: 'bandpass', filterFreq: 800, q: 2 });
    const ctx = this.ctx;
    // Schedule the second knock slightly later via a fresh tone.
    setTimeout(() => {
      if (!this.ready) return;
      this._noise({ dur: 0.05, gain: 0.18, filterType: 'bandpass', filterFreq: 1000, q: 2 });
    }, 80);
    this._tone({ type: 'triangle', freq: 520, dur: 0.09, gain: 0.12, release: 0.09 });
    void ctx;
  }

  _sfxEat() {
    // A couple of soft crunchy bites.
    this._noise({ dur: 0.08, gain: 0.16, filterType: 'lowpass', filterFreq: 900, q: 1.2 });
    setTimeout(() => {
      if (!this.ready) return;
      this._noise({ dur: 0.07, gain: 0.14, filterType: 'lowpass', filterFreq: 760, q: 1.2 });
    }, 130);
  }

  _sfxClick() {
    // UI tick — tiny filtered blip.
    this._tone({ type: 'square', freq: 880, dur: 0.04, gain: 0.16, release: 0.04,
      filter: { type: 'lowpass', freq: 3000 } });
  }

  _sfxLevelUp() {
    // Rising arpeggio over the pentatonic scale — celebratory.
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const notes = [0, 2, 4, 7, 12];
    for (let i = 0; i < notes.length; i++) {
      const freq = 330 * Math.pow(2, notes[i] / 12);
      const start = t0 + i * 0.08;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, start);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.22, start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
      osc.connect(g); g.connect(this.sfxBus);
      osc.start(start); osc.stop(start + 0.24);
    }
    this._trackVoice(notes.length * 0.08 + 0.24);
  }

  _sfxExplode() {
    // Big low-passed noise boom with a sub thump.
    this._noise({
      dur: 0.6, gain: 0.5, filterType: 'lowpass',
      filterFreq: 1800, filterEnd: 80, q: 0.6, playbackRate: 0.8,
    });
    const osc = this._tone({ type: 'sine', freq: 90, dur: 0.5, gain: 0.4,
      attack: 0.005, release: 0.5 });
    if (osc) {
      const t0 = this.ctx.currentTime;
      osc.frequency.exponentialRampToValueAtTime(38, t0 + 0.45);
    }
  }

  _sfxPickup() {
    // Two-note "blip-bloop" upward — classic collect sound.
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const freqs = [660, 990];
    for (let i = 0; i < freqs.length; i++) {
      const start = t0 + i * 0.06;
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freqs[i], start);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.16, start + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.1);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 3000;
      osc.connect(f); f.connect(g); g.connect(this.sfxBus);
      osc.start(start); osc.stop(start + 0.12);
    }
    this._trackVoice(freqs.length * 0.06 + 0.12);
  }

  /* ---------------------------------------------------------------------- */
  /*  Generative ambient music                                             */
  /* ---------------------------------------------------------------------- */

  startMusic() {
    if (!this.musicOn) {
      this.musicOn = true;
      if (this.ctx) {
        this.nextNoteAt = this.ctx.currentTime + 0.2;
        this.nextPadAt = this.ctx.currentTime + 0.2;
      }
    }
  }

  stopMusic() {
    this.musicOn = false;
    // Fade out any sustaining pad gracefully.
    if (this.padNode && this.ctx) {
      try {
        const t = this.ctx.currentTime;
        this.padNode.gain.cancelScheduledValues(t);
        this.padNode.gain.setTargetAtTime(0.0001, t, 0.5);
      } catch (_) {}
      this.padNode = null;
    }
  }

  // Convert a pentatonic step index into a frequency, transposed across
  // octaves so the melody wanders pleasantly.
  _pentaFreq(step, octave = 0) {
    const idx = ((step % PENTATONIC.length) + PENTATONIC.length) % PENTATONIC.length;
    const oct = octave + Math.floor(step / PENTATONIC.length);
    const semi = PENTATONIC[idx] + 12 * oct;
    return MUSIC_ROOT * Math.pow(2, semi / 12);
  }

  // The scheduler runs every frame from update(). It queues melody notes and
  // sustained pad chords a short distance ahead of the audio clock so the
  // music stays smooth regardless of frame rate. All work is bounded: at most
  // a few notes are scheduled per call.
  _scheduleMusic() {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const lookahead = 1.0; // seconds we're willing to schedule into the future

    let guard = 0; // safety cap so a long stall can't queue hundreds of notes
    while (this.nextNoteAt < now + lookahead && guard++ < 8) {
      this._scheduleNote(this.nextNoteAt);
      // Note spacing varies a little for a relaxed, organic feel.
      const spacing = this.musicRng.bool(0.25) ? 0.9 : 0.45;
      this.nextNoteAt += spacing;
    }

    if (this.nextPadAt < now + lookahead) {
      this._schedulePad(this.nextPadAt);
      this.nextPadAt += 6.0; // a new gentle chord every ~6s
    }
  }

  // One soft melody note, plucked on a triangle/sine with a slow envelope.
  _scheduleNote(when) {
    const ctx = this.ctx;
    // Random walk over the scale, kept within a comfortable range.
    const move = this.musicRng.int(-1, 1);
    this.musicStep = clamp(this.musicStep + move, -4, 9);
    // Occasionally rest (skip a note) for breathing room.
    if (this.musicRng.bool(0.18)) return;

    const freq = this._pentaFreq(this.musicStep, 1);
    const dur = 0.9 + this.musicRng.float(0, 0.6);

    const osc = ctx.createOscillator();
    osc.type = this.musicRng.bool(0.5) ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(freq, when);

    const g = ctx.createGain();
    const peak = 0.10 + this.musicRng.float(0, 0.05);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(peak, when + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);

    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 2200;

    osc.connect(f); f.connect(g); g.connect(this.musicBus);
    osc.start(when);
    osc.stop(when + dur + 0.05);
  }

  // A slow sustained pad: a small stack of detuned oscillators forming a chord
  // rooted on a scale tone, fading in and out over several seconds.
  _schedulePad(when) {
    const ctx = this.ctx;
    const rootStep = this.musicRng.pick([0, 2, 4]);
    const chordOffsets = [0, 2, 4]; // root + two pentatonic steps = open chord

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.05, when + 2.0);   // slow swell
    g.gain.linearRampToValueAtTime(0.0001, when + 6.0); // slow release
    g.connect(this.musicBus);
    this.padNode = g;

    for (let i = 0; i < chordOffsets.length; i++) {
      const freq = this._pentaFreq(rootStep + chordOffsets[i], 0);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      // Slight detune per voice for a warm, chorused pad.
      osc.frequency.setValueAtTime(freq, when);
      osc.detune.setValueAtTime((i - 1) * 4, when);
      osc.connect(g);
      osc.start(when);
      osc.stop(when + 6.2);
    }
  }
}

export default AudioSystem;
