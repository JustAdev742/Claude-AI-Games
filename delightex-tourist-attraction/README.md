# Sky Beacon Plaza (Delightex Edu tourist attraction)

A landmark tower with a blinking beacon, fountain, rotating Ferris wheel, gift shop, entrance gate,
trees, lamps, benches and strolling visitors, all built from one script.

## Use it in Delightex Edu

1. Open an **empty** space and click **Code** then **Script** (scripting needs Delightex Edu PRO).
2. Paste all of [`attraction.ts`](attraction.ts) and press **Play**.
3. Change `SCALE` at the top if the world looks too big or small.

The script only creates items; it never deletes anything already in your space.

## Preview in a browser

Open [`preview.html`](preview.html) (needs internet for three.js). It is generated from the same scene
code, so it matches the script:

```bash
node build-preview.mjs
```

## Not yet tried in the Delightex editor

`Scene.create*`, `Vector3` and `Time.scheduleRepeating` match the Delightex API docs. The item
properties `.transform.position`, `.size`, `.color` and `new Color(r, g, b)` could not be checked
(the docs pages for them were not reachable). They are all in the "Delightex adapter" section at the
bottom of `attraction.ts`; if the editor flags one, fix it there and the whole scene follows.
The script has been run against a mock of the API (213 items, 600 animation ticks, no errors).
