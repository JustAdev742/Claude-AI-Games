// Builds preview.html: takes the engine-agnostic scene out of attraction.ts, strips the
// TypeScript types and drops it into the three.js page, so the preview always matches the script.
//   node build-preview.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const here = (f) => new URL(f, import.meta.url);
const ts = readFileSync(here("attraction.ts"), "utf8");
const m = ts.match(/\/\/ ==== SCENE:START[^\n]*\n([\s\S]*?)\/\/ ==== SCENE:END ====/);
if (!m) throw new Error("SCENE:START / SCENE:END markers not found in attraction.ts");

const js = stripTypeScriptTypes(m[1], { mode: "strip" });
const html = readFileSync(here("preview.template.html"), "utf8").replace("/*__SCENE__*/", () => js);
writeFileSync(here("preview.html"), html);
console.log(`preview.html written (${html.length} bytes)`);
