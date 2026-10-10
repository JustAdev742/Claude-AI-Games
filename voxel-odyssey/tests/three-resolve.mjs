/* Lets Node tests import modules that `import * as THREE from 'three'`, the way
   the browser's import map does: point the bare specifier at the vendored build.
   Use with:  node --import ./tests/three-resolve.mjs tests/some.test.mjs */
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`
  import { pathToFileURL, fileURLToPath } from 'node:url';
  const vendor = pathToFileURL(${JSON.stringify(new URL('../vendor/three.module.js', import.meta.url).pathname)}).href;
  export async function resolve(specifier, context, next) {
    if (specifier === 'three') return { url: vendor, shortCircuit: true };
    return next(specifier, context);
  }
`));
