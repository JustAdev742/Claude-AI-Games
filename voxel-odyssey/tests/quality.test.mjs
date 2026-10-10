/* Quality presets, hardware classification and the adaptive governor. */
import { classify, scaleForPixels, settingsForPreset, PRESETS, PRESET_KEYS, Governor } from '../js/core/quality.js';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) pass++;
  else { fail++; console.error('  FAIL', n, extra === undefined ? '' : '— ' + extra); }
};
const hw = (gpu, cores = 4, memory = 8, mobile = false) => ({ gpu, cores, memory, mobile, dpr: 1, pixels: 1366 * 768 });

/* ---- classification ---- */
{
  ok('classify: a software rasteriser is Low', classify(hw('Google SwiftShader')) === 'low' && classify(hw('llvmpipe (LLVM 15)')) === 'low');
  ok('classify: old Intel HD graphics is Low', classify(hw('ANGLE (Intel, Intel(R) HD Graphics 4000 Direct3D11 vs_5_0 ps_5_0)')) === 'low');
  ok('classify: Intel UHD is Medium', classify(hw('ANGLE (Intel, Intel(R) UHD Graphics 620)')) === 'medium');
  ok('classify: a discrete NVIDIA card is High', classify(hw('NVIDIA GeForce GTX 1060', 8)) === 'high');
  ok('classify: Apple silicon is High', classify(hw('Apple M1', 8)) === 'high');
  ok('classify: a dual-core CPU caps even a good GPU at Low', classify(hw('NVIDIA GeForce GTX 1050', 2)) === 'low');
  ok('classify: 2 GB of memory is Low', classify(hw('Intel(R) UHD Graphics', 4, 2)) === 'low');
  ok('classify: a quad-core with a strong GPU is held at Medium', classify(hw('NVIDIA GeForce RTX 3060', 4)) === 'medium');
  ok('classify: phones are Low unless very strong', classify(hw('Adreno (TM) 610', 8, 4, true)) === 'medium' && classify(hw('Mali-G52', 6, 4, true)) === 'low');
  ok('classify: an unknown GPU gets the middle road', classify(hw('Totally New GPU 9000')) === 'medium');
  ok('classify: a hidden GPU name still gives an answer', ['low', 'medium', 'high'].includes(classify(hw(''))));
}

/* ---- presets ---- */
{
  const keysOk = ['low', 'medium', 'high'].every((n) => PRESET_KEYS.every((k) => PRESETS[n][k] !== undefined));
  ok('presets: all three define every knob', keysOk);
  ok('presets: Low is cheaper than Medium than High on every axis',
    PRESETS.low.renderDistance < PRESETS.medium.renderDistance && PRESETS.medium.renderDistance < PRESETS.high.renderDistance
    && PRESETS.low.shaderTier < PRESETS.medium.shaderTier && PRESETS.medium.shaderTier < PRESETS.high.shaderTier
    && PRESETS.low.renderScale <= PRESETS.medium.renderScale && PRESETS.low.particleScale < PRESETS.high.particleScale
    && PRESETS.low.mobScale < PRESETS.high.mobScale && !PRESETS.low.fancyGraphics && PRESETS.high.fancyGraphics);

  ok('scale: a small screen needs no reduction', scaleForPixels(1366 * 768, 'low') === 1);
  const big = scaleForPixels(3840 * 2160, 'low');
  ok('scale: a 4K screen is rendered at reduced scale, not below the floor', big < 0.6 && big >= 0.5, `${big}`);
  ok('scale: a stronger preset tolerates more pixels', scaleForPixels(2560 * 1440, 'high') > scaleForPixels(2560 * 1440, 'low'));
  const s = settingsForPreset('low', { pixels: 3840 * 2160 });
  ok('settingsForPreset: Low on a 4K screen lowers the scale below the preset', s.renderScale < PRESETS.low.renderScale && s.renderScale >= 0.5);
  ok('settingsForPreset: renders in clean 5% steps', Math.abs(s.renderScale * 20 - Math.round(s.renderScale * 20)) < 1e-9);
}

/* ---- governor: simulated machines ---- */
// Run a governor against a machine whose frame time follows `cost(scale, rd)`.
function simulate(cost, seconds, limits, cpuShare = 0.1) {
  const g = new Governor(limits);
  let t = 0, last = 0, changes = 0, lastChangeAt = 0;
  while (t < seconds) {
    const ms = cost(g.scale, g.renderDistance);
    const r = g.frame(ms, ms * cpuShare);
    if (r.changed) { changes++; lastChangeAt = t; }
    t += ms / 1000;
    last = ms;
  }
  return { g, changes, lastChangeAt, ms: last, fps: 1000 / last };
}
{
  const fast = simulate(() => 11, 40, { renderScale: 1, renderDistance: 8 });
  ok('governor: a fast machine is left alone', fast.changes === 0 && fast.g.scale === 1 && fast.g.renderDistance === 8);

  const gpuBound = simulate((sc, rd) => 12 + 30 * sc * sc + rd * 0.4, 90, { renderScale: 1, renderDistance: 8 });
  ok('governor: a GPU-bound machine is brought to a playable frame rate', gpuBound.fps >= 40, `${gpuBound.fps.toFixed(1)} fps`);
  ok('governor: ...mostly by lowering resolution, which is what GPU-bound frames respond to', gpuBound.g.scale <= 0.6, `scale ${gpuBound.g.scale}`);
  ok('governor: ...and it settles instead of oscillating', gpuBound.lastChangeAt < 70, `last change at ${gpuBound.lastChangeAt.toFixed(0)}s`);
  ok('governor: it never goes below the resolution floor', gpuBound.g.scale >= 0.5);

  const cpuBound = simulate((sc, rd) => 10 + rd * 4.5, 60, { renderScale: 1, renderDistance: 8 }, 0.85);
  ok('governor: a CPU-bound machine sheds view distance, not pixels', cpuBound.g.renderDistance < 8 && cpuBound.g.scale === 1, `rd ${cpuBound.g.renderDistance} scale ${cpuBound.g.scale}`);

  const floor = simulate(() => 80, 80, { renderScale: 1, renderDistance: 8 });
  ok('governor: even a hopeless machine stops at the floors', floor.g.scale === 0.5 && floor.g.renderDistance === 3);

  // A stall (tab switch, GC) is not evidence of a slow machine.
  const g = new Governor({ renderScale: 1, renderDistance: 8 });
  for (let i = 0; i < 400; i++) g.frame(i % 40 === 0 ? 900 : 12, 3);
  ok('governor: occasional long stalls are ignored', g.scale === 1 && g.renderDistance === 8);

  // Limits: it must not exceed what the player chose.
  const limited = simulate(() => 8, 120, { renderScale: 0.75, renderDistance: 5 });
  ok('governor: never raises above the chosen limits', limited.g.scale <= 0.75 && limited.g.renderDistance <= 5);

  // Recovery: after load drops, detail comes back — but slowly.
  const g2 = new Governor({ renderScale: 1, renderDistance: 8 });
  let t = 0;
  for (; t < 40; t += 0.04) g2.frame(40, 5);                  // a slow patch: it sheds
  const shed = g2.scale < 1 || g2.renderDistance < 8;
  const downAt = g2.scale + g2.renderDistance;
  for (t = 0; t < 8; t += 0.01) g2.frame(9, 2);               // a short fast patch: too soon to give it back
  const early = g2.scale + g2.renderDistance;
  for (t = 0; t < 90; t += 0.01) g2.frame(9, 2);              // a long fast patch: it recovers
  ok('governor: sheds under load', shed);
  ok('governor: does not hand detail back immediately', early <= downAt + 0.001, `${downAt} -> ${early}`);
  ok('governor: but does recover given sustained headroom', g2.scale + g2.renderDistance > downAt, `${downAt} -> ${g2.scale + g2.renderDistance}`);
}

console.log(`\n==== quality: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
