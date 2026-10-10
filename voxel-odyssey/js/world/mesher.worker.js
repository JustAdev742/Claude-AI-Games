/* =========================================================================
   mesher.worker.js — the world worker: chunk meshing and terrain generation,
   off the main thread.

   Everything interesting lives in workerCore.js (so it can be unit-tested under
   Node); this file only connects it to the worker's message channel. Workers
   are created by MeshPool — from this module file when running from source, or
   from a Blob built out of the embedded copy in the single-file build.
   ========================================================================= */

import { createWorkerCore } from './workerCore.js';

const core = createWorkerCore((msg, transfers) => self.postMessage(msg, transfers || []));

self.onmessage = (e) => core.handle(e.data);
