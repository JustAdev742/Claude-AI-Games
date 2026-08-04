/* build-single-file.mjs — bundle the whole game into one portable .html file.
 *
 * The game normally runs straight from source (ES modules + an import map, no
 * build step). This script is only for producing a single file you can email,
 * drop on a static host, or open from disk — it inlines the CSS, bundles every
 * module with esbuild, and embeds Three.js alongside it.
 *
 *   node tools/build-single-file.mjs [outfile] [--fragment]
 *
 * --fragment emits just the style + markup + script, with no <html>/<head>/
 * <body> wrapper, for hosts that supply their own document skeleton. The
 * viewport meta is then injected at runtime since there's no <head> to put it in.
 *
 * esbuild is the only dependency and is resolved from wherever it happens to be
 * installed (`npm i esbuild` locally, or a global install).
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const FRAGMENT = argv.includes('--fragment');
const outArg = argv.find((a) => !a.startsWith('--'));
const OUT = outArg
  ? path.resolve(process.cwd(), outArg)
  : path.join(ROOT, 'dist', FRAGMENT ? 'voxel-odyssey.fragment.html' : 'voxel-odyssey.html');

async function loadEsbuild() {
  const candidates = [
    'esbuild',
    path.join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js'),
    '/opt/node22/lib/node_modules/esbuild/lib/main.js',
  ];
  for (const c of candidates) {
    try {
      return await import(c.startsWith('/') ? pathToFileURL(c).href : c);
    } catch (e) { /* try the next one */ }
  }
  throw new Error('esbuild not found — run `npm install esbuild` first.');
}

// An inline <script> ends at the first literal `</script`, so neutralise any
// that appear inside the bundled source (none today, but cheap insurance).
const escapeForInlineScript = (s) => s.replace(/<\/(script)/gi, '<\\/$1');

async function main() {
  const esbuild = await loadEsbuild();

  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, 'js', 'main.js')],
    bundle: true,
    format: 'esm',
    target: 'es2020',
    write: false,
    legalComments: 'none',
    // `three` is a bare specifier served by the import map at runtime; point it
    // at the vendored copy so the bundle is self-contained.
    alias: { three: path.join(ROOT, 'vendor', 'three.module.js') },
  });

  const bundled = result.outputFiles[0].text;
  const css = await readFile(path.join(ROOT, 'styles.css'), 'utf8');
  let html = await readFile(path.join(ROOT, 'index.html'), 'utf8');

  // 1. stylesheet link -> inline <style>
  html = html.replace(
    /\s*<link rel="stylesheet" href="styles\.css"\s*\/?>/,
    `\n  <style>\n${css}\n  </style>`,
  );

  // 2. the import map is meaningless once everything is bundled
  html = html.replace(/\s*<!--[^]*?-->\s*<script type="importmap">[^]*?<\/script>/, '');

  // 3. the bootstrap's dynamic import -> the bundle itself, spliced in at the
  // top level of the same module script. The window 'error' handler declared
  // just above it still surfaces anything that throws during startup.
  const before = html;
  html = html.replace(
    /\s*import\('\.\/js\/main\.js'\)\.catch\(\(err\) => \{[^]*?\n    \}\);/,
    '\n' + escapeForInlineScript(bundled),
  );
  if (html === before) throw new Error('inlining failed: bootstrap import not matched');

  if (!html.includes('<style>')) throw new Error('inlining failed: no stylesheet in output');
  if (html.includes('importmap')) throw new Error('inlining failed: import map survived');
  if (html.includes('./js/main.js')) throw new Error('inlining failed: bootstrap survived');
  if (html.length < 500_000) throw new Error('inlining failed: output suspiciously small');

  if (FRAGMENT) {
    const style = html.match(/<style>[^]*?<\/style>/);
    const body = html.match(/<body>([^]*)<\/body>/);
    if (!style || !body) throw new Error('fragment build: could not split head/body');
    // No <head> to hold the viewport meta, so add it once at runtime — the
    // game is fixed-position fullscreen and needs it to behave on phones.
    const viewport = `<script>
  if (!document.querySelector('meta[name="viewport"]')) {
    const m = document.createElement('meta');
    m.name = 'viewport';
    m.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no';
    document.head.appendChild(m);
  }
</script>`;
    html = `${style[0]}\n${viewport}\n${body[1].trim()}\n`;
    if (/<\/?(html|head|body)[\s>]/i.test(html)) throw new Error('fragment build: skeleton tags leaked');
  }

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, html, 'utf8');
  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(`wrote ${path.relative(ROOT, OUT) || OUT} (${kb} KB)`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
