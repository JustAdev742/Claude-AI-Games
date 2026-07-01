/* =========================================================================
   crafting.js — the recipe system.

   Pure logic, Node-importable: this module touches no Three.js and reads
   everything it needs off the shared `game` object at call time.

   A crafting "grid" is a length-9 array (3×3, row-major) of item keys or
   `null`:

       [0] [1] [2]
       [3] [4] [5]
       [6] [7] [8]

   The 2×2 inventory grid uses the top-left subset: cells 0,1,3,4. Callers
   that only have a 2×2 grid may pass a length-4 array or a length-9 array
   with the other cells `null` — both work.

   Two kinds of recipes:

     • shaped   — the pattern matters. We position-normalize both the recipe
                  pattern and the input grid by trimming empty border rows and
                  columns, then compare cell-for-cell. This makes a recipe
                  craftable anywhere in the grid as long as the relative shape
                  matches (just like Minecraft).

     • shapeless— only the multiset of ingredients matters; position is
                  irrelevant (e.g. any log → planks, coal + stick → torches).

   Recipe definition (internal):
     {
       id        unique string
       name      display name (recipe book)
       type      'shaped' | 'shapeless'
       output    { id: itemKey, count }
       // shaped:
       pattern   array of rows, each row an array of (itemKey|null), e.g.
                 [['stick'], ['stick'], ['stick']]  (variable size up to 3×3)
       // shapeless:
       ingredients [itemKey, ...]   (with the "any log" style handled via tags)
       // either may use a tag token "#log" to accept a group of items.
     }

   Tags let one recipe accept a family of items (any log, any planks, …).
   ========================================================================= */

import Items from './items.js';

/* ---- item tags (groups) -------------------------------------------------
   A tag token starts with '#'. When a recipe cell/ingredient is a tag, any
   member item satisfies it. We resolve membership through ITEM_TAGS.
   ------------------------------------------------------------------------- */
const ITEM_TAGS = {
  log: ['log', 'birch_log', 'pine_log'],
  planks: ['planks'],
  wood_tool_mat: ['planks'],
};

// Is `itemKey` a member of tag `tag` (tag without the leading '#')?
function tagHas(tag, itemKey) {
  const members = ITEM_TAGS[tag];
  return !!members && members.indexOf(itemKey) !== -1;
}

// Does a recipe token (either a plain key or a '#tag') accept `itemKey`?
function tokenAccepts(token, itemKey) {
  if (token == null) return itemKey == null;         // empty cell ↔ empty cell
  if (itemKey == null) return false;
  if (token.charCodeAt(0) === 35 /* '#' */) return tagHas(token.slice(1), itemKey);
  return token === itemKey;
}

// First concrete item a token represents (for display only).
function tokenSample(token) {
  if (token == null) return null;
  if (token.charCodeAt(0) === 35) {
    const members = ITEM_TAGS[token.slice(1)];
    return members && members.length ? members[0] : null;
  }
  return token;
}

/* ---- grid normalization -------------------------------------------------
   Turn a length-9 (or length-4) flat grid into a trimmed 2D array of tokens
   with empty border rows/columns removed, so position is relative. Returns
   { rows, w, h, count } where `count` is the number of non-empty cells.
   ------------------------------------------------------------------------- */
function gridTo2D(grid) {
  // Accept a 2×2 (length 4) grid by expanding into the top-left of a 3×3.
  let g = grid;
  if (g.length === 4) {
    g = [g[0], g[1], null, g[2], g[3], null, null, null, null];
  } else if (g.length !== 9) {
    // Be defensive: pad/clip to 9.
    g = g.slice(0, 9);
    while (g.length < 9) g.push(null);
  }
  return [
    [g[0] || null, g[1] || null, g[2] || null],
    [g[3] || null, g[4] || null, g[5] || null],
    [g[6] || null, g[7] || null, g[8] || null],
  ];
}

// Trim empty border rows/cols. Input is a 2D array (rows of tokens).
// Returns { rows, w, h, count, offX, offY }.
function trim(rows2d) {
  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity, count = 0;
  for (let r = 0; r < rows2d.length; r++) {
    for (let c = 0; c < rows2d[r].length; c++) {
      if (rows2d[r][c] != null) {
        count++;
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
      }
    }
  }
  if (count === 0) return { rows: [], w: 0, h: 0, count: 0, offX: 0, offY: 0 };
  const out = [];
  for (let r = minR; r <= maxR; r++) {
    const row = [];
    for (let c = minC; c <= maxC; c++) row.push(rows2d[r][c] != null ? rows2d[r][c] : null);
    out.push(row);
  }
  return { rows: out, w: maxC - minC + 1, h: maxR - minR + 1, count, offX: minC, offY: minR };
}

// Flatten a grid to a list of non-null item keys (for shapeless matching).
function flatItems(grid) {
  const list = [];
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i];
    if (v != null) list.push(v);
  }
  return list;
}

/* =========================================================================
   The Crafting system.
   ========================================================================= */
export class Crafting {
  constructor(game) {
    this.game = game;
    this.recipes = [];          // all recipe defs
    this._byId = new Map();     // id -> recipe
  }

  init() {
    this.recipes = buildRecipes();
    this._byId.clear();
    for (const r of this.recipes) this._byId.set(r.id, r);
    return this;
  }

  /* ---- matching --------------------------------------------------------- */

  // Match a grid against every recipe. Returns { output, recipe } or null.
  match(grid) {
    if (!grid) return null;
    if (!this.recipes.length) this.init();

    const flat = this._normalizeFlat(grid);
    const items = flatItems(flat);
    if (items.length === 0) return null;

    // Pre-trim once for shaped comparison.
    const trimmedInput = trim(gridTo2D(flat));

    for (let i = 0; i < this.recipes.length; i++) {
      const recipe = this.recipes[i];
      const ok = recipe.type === 'shapeless'
        ? this._matchShapeless(recipe, items)
        : this._matchShaped(recipe, trimmedInput);
      if (ok) {
        return { output: { id: recipe.output.id, count: recipe.output.count }, recipe };
      }
    }
    return null;
  }

  // Normalize any accepted grid form to a length-9 flat array of keys|null.
  _normalizeFlat(grid) {
    if (grid.length === 9) return grid;
    const two = gridTo2D(grid);            // handles length 4 / odd sizes
    return [
      two[0][0], two[0][1], two[0][2],
      two[1][0], two[1][1], two[1][2],
      two[2][0], two[2][1], two[2][2],
    ];
  }

  _matchShapeless(recipe, items) {
    const need = recipe.ingredients;
    if (need.length !== items.length) return false;
    // Greedy multiset match: each input item must be consumed by exactly one
    // recipe token, and every token must be satisfied.
    const used = new Array(items.length).fill(false);
    for (let t = 0; t < need.length; t++) {
      let found = -1;
      for (let k = 0; k < items.length; k++) {
        if (!used[k] && tokenAccepts(need[t], items[k])) { found = k; break; }
      }
      if (found === -1) return false;
      used[found] = true;
    }
    return true;
  }

  _matchShaped(recipe, trimmedInput) {
    // Compare trimmed recipe pattern with trimmed input dimensions & cells.
    const rp = recipe._trimmed || (recipe._trimmed = trim(recipe.pattern.map((row) => row.slice())));
    if (rp.w !== trimmedInput.w || rp.h !== trimmedInput.h) return false;
    if (rp.count !== trimmedInput.count) return false;
    for (let r = 0; r < rp.h; r++) {
      for (let c = 0; c < rp.w; c++) {
        const token = rp.rows[r][c];
        const cell = trimmedInput.rows[r][c];
        if (!tokenAccepts(token, cell)) return false;
      }
    }
    return true;
  }

  /* ---- crafting from a grid -------------------------------------------- */

  // Match the grid; if it produces something, remove 1 of each used cell from
  // the grid (mutating it in place) and return the produced output.
  craftOnce(grid) {
    if (!grid) return null;
    const result = this.match(grid);
    if (!result) return null;

    // Remove one item from every non-empty cell that participated. For both
    // shaped and shapeless recipes every non-null cell is consumed once
    // (recipes never use the same cell twice). We operate on the live grid
    // array the caller passed, supporting length 4 and 9.
    for (let i = 0; i < grid.length; i++) {
      if (grid[i] != null) {
        // Caller stores either plain keys or {id,count}? The contract uses
        // length-9 itemKey|null, so cells are keys; clearing means set null.
        grid[i] = null;
      }
    }

    // Fire a craft event (defensive — bus may be absent in unit tests).
    const bus = this.game && this.game.events;
    if (bus && typeof bus.emit === 'function') {
      bus.emit('craft', { recipeId: result.recipe.id, output: result.output });
    }
    return result.output;
  }

  /* ---- recipe book ------------------------------------------------------ */

  // The list for the recipe-book UI. Each entry carries enough to render an
  // icon and one-click craft: { id, name, output, type, sample, recipe }.
  list() {
    if (!this.recipes.length) this.init();
    return this.recipes.map((r) => ({
      id: r.id,
      name: r.name,
      output: { id: r.output.id, count: r.output.count },
      type: r.type,
      // The materials needed, resolved to concrete sample items for display.
      ingredients: this._recipeIngredients(r),
      recipe: r,
    }));
  }

  // Flatten a recipe's required ingredients into {key, count} groups (sample
  // items for tags). Used by canCraft/autoCraft and the recipe-book tooltip.
  _recipeIngredients(recipe) {
    const counts = new Map();    // sampleKey -> { token, count }
    const addToken = (token) => {
      const sample = tokenSample(token);
      if (sample == null) return;
      const key = token;         // group by token so tags stay distinct
      const e = counts.get(key) || { token, sample, count: 0 };
      e.count++;
      counts.set(key, e);
    };
    if (recipe.type === 'shapeless') {
      for (const ing of recipe.ingredients) addToken(ing);
    } else {
      for (const row of recipe.pattern) for (const cell of row) if (cell != null) addToken(cell);
    }
    return [...counts.values()];
  }

  // Find the recipe object for a recipe-book entry (entry may be the recipe,
  // a list() item, or a bare id string).
  _resolveRecipe(entry) {
    if (!entry) return null;
    if (typeof entry === 'string') return this._byId.get(entry) || null;
    if (entry.type && (entry.pattern || entry.ingredients)) return entry;       // a raw recipe
    if (entry.recipe) return entry.recipe;                                       // a list() item
    if (entry.id && this._byId.has(entry.id)) return this._byId.get(entry.id);
    return null;
  }

  /* ---- inventory-driven crafting (recipe book one-click) ---------------- */

  // Does `inventory` (defaults to game.inventory) hold enough materials to
  // craft `recipe` once? Tags require a member to be present somewhere.
  canCraft(recipe, inventory) {
    const r = this._resolveRecipe(recipe);
    if (!r) return false;
    const inv = inventory || (this.game && this.game.inventory);
    if (!inv || typeof inv.count !== 'function') return false;

    const groups = this._recipeIngredients(r);
    // Track items already earmarked so two tags don't both claim the same
    // limited stack (rare here, but keep it correct).
    const claimed = new Map();   // itemKey -> amount reserved
    for (const g of groups) {
      const need = g.count;
      const got = this._availableFor(inv, g.token, claimed);
      if (got.total < need) return false;
      // Reserve from the cheapest matching item key.
      this._reserve(inv, g.token, need, claimed);
    }
    return true;
  }

  // Total count available for a token (plain key or tag), minus what's
  // already claimed by earlier ingredients in this craft.
  _availableFor(inv, token, claimed) {
    let total = 0;
    const keys = this._tokenKeys(token);
    for (const k of keys) {
      const c = inv.count(k) - (claimed.get(k) || 0);
      if (c > 0) total += c;
    }
    return { total, keys };
  }

  // Reserve `need` units across the token's member keys (mutating `claimed`).
  _reserve(inv, token, need, claimed) {
    let left = need;
    for (const k of this._tokenKeys(token)) {
      if (left <= 0) break;
      const avail = inv.count(k) - (claimed.get(k) || 0);
      if (avail <= 0) continue;
      const take = Math.min(avail, left);
      claimed.set(k, (claimed.get(k) || 0) + take);
      left -= take;
    }
    return left <= 0;
  }

  // Resolve a token to its concrete item keys (single key, or tag members).
  _tokenKeys(token) {
    if (token == null) return [];
    if (token.charCodeAt(0) === 35) return (ITEM_TAGS[token.slice(1)] || []).slice();
    return [token];
  }

  // Pull materials from game.inventory and add the output. Returns true on
  // success. No-ops safely if anything is missing.
  autoCraft(recipe) {
    const r = this._resolveRecipe(recipe);
    if (!r) return false;
    const inv = this.game && this.game.inventory;
    if (!inv || typeof inv.consume !== 'function' || typeof inv.add !== 'function') return false;
    if (!this.canCraft(r, inv)) return false;
    // Don't consume ingredients if the output has nowhere to go (would be lost).
    if (typeof inv.hasSpaceFor === 'function' && !inv.hasSpaceFor(r.output.id, r.output.count)) {
      const bus = this.game && this.game.events;
      if (bus && typeof bus.emit === 'function') bus.emit('toast', { text: 'Inventory full', kind: 'warn' });
      return false;
    }

    // Determine exactly which keys/amounts to consume (respecting tags).
    const groups = this._recipeIngredients(r);
    const plan = [];             // [{ key, amount }]
    const claimed = new Map();
    for (const g of groups) {
      let left = g.count;
      for (const k of this._tokenKeys(g.token)) {
        if (left <= 0) break;
        const avail = inv.count(k) - (claimed.get(k) || 0);
        if (avail <= 0) continue;
        const take = Math.min(avail, left);
        claimed.set(k, (claimed.get(k) || 0) + take);
        plan.push({ key: k, amount: take });
        left -= take;
      }
      if (left > 0) return false;   // shouldn't happen after canCraft
    }

    // Consume everything, then add the output.
    for (const p of plan) {
      if (!inv.consume(p.key, p.amount)) {
        // Extremely defensive: a concurrent change broke our plan. Bail.
        return false;
      }
    }
    inv.add(r.output.id, r.output.count);

    const bus = this.game && this.game.events;
    if (bus && typeof bus.emit === 'function') {
      bus.emit('craft', { recipeId: r.id, output: { id: r.output.id, count: r.output.count } });
    }
    return true;
  }

  // Convenience: look a recipe up by id.
  get(id) { return this._byId.get(id) || null; }
}

/* =========================================================================
   The recipe set.

   Tokens may be a plain item key or a '#tag'. Patterns are arrays of rows
   (1..3 rows, each 1..3 wide); they are position-normalized at match time so
   they can be placed anywhere in the grid.
   ========================================================================= */

// Small builders to keep the table terse and readable.
function shaped(id, name, pattern, outId, outCount = 1) {
  return { id, name, type: 'shaped', pattern, output: { id: outId, count: outCount } };
}
function shapeless(id, name, ingredients, outId, outCount = 1) {
  return { id, name, type: 'shapeless', ingredients, output: { id: outId, count: outCount } };
}

// Tool/equipment pattern helpers. `m` is the head-material token.
const P = {
  // pickaxe: full top row of material, stick column down the middle
  pickaxe: (m) => [[m, m, m], [null, 'stick', null], [null, 'stick', null]],
  // axe: 2×2-ish L of material on the left/top, sticks below
  axe: (m) => [[m, m], [m, 'stick'], [null, 'stick']],
  // shovel: single material on top, two sticks below
  shovel: (m) => [[m], ['stick'], ['stick']],
  // sword: two material stacked, stick handle
  sword: (m) => [[m], [m], ['stick']],
};

const TOOL_MATERIALS = [
  { tier: 'wooden', head: '#planks' },
  { tier: 'stone', head: 'cobblestone' },
  { tier: 'iron', head: 'iron_ingot' },
  { tier: 'gold', head: 'gold_ingot' },
  { tier: 'diamond', head: 'diamond' },
];

// Map our tool name prefix ("wooden") to the Items key prefix ("wood").
const TOOL_KEY_PREFIX = { wooden: 'wood', stone: 'stone', iron: 'iron', gold: 'gold', diamond: 'diamond' };
const TOOL_KINDS = ['pickaxe', 'axe', 'shovel', 'sword'];
const KIND_LABEL = { pickaxe: 'Pickaxe', axe: 'Axe', shovel: 'Shovel', sword: 'Sword' };

function buildRecipes() {
  const out = [];

  /* ---- wood basics ---------------------------------------------------- */
  // Any log → 4 planks (shapeless). One recipe accepts every log via the tag.
  out.push(shapeless('planks_from_log', 'Oak Planks', ['#log'], 'planks', 4));
  // Explicit per-log recipes too, so the recipe book shows each wood type.
  out.push(shapeless('planks_from_oak', 'Oak Planks', ['log'], 'planks', 4));
  out.push(shapeless('planks_from_birch', 'Oak Planks (Birch)', ['birch_log'], 'planks', 4));
  out.push(shapeless('planks_from_pine', 'Oak Planks (Pine)', ['pine_log'], 'planks', 4));

  // 2 planks stacked → 4 sticks.
  out.push(shaped('sticks', 'Sticks', [['planks'], ['planks']], 'stick', 4));

  // 4 planks (2×2) → crafting table.
  out.push(shaped('crafting_table', 'Crafting Table',
    [['planks', 'planks'], ['planks', 'planks']], 'crafting_table', 1));

  /* ---- utility blocks -------------------------------------------------- */
  // 8 cobblestone ring (hollow center) → furnace.
  out.push(shaped('furnace', 'Furnace',
    [['cobblestone', 'cobblestone', 'cobblestone'],
     ['cobblestone', null, 'cobblestone'],
     ['cobblestone', 'cobblestone', 'cobblestone']], 'furnace', 1));

  // Torch: coal over a stick → 4 torches.
  out.push(shaped('torch', 'Torch', [['coal'], ['stick']], 'torch', 4));
  // Charcoal works too.
  out.push(shaped('torch_charcoal', 'Torch (Charcoal)', [['charcoal'], ['stick']], 'torch', 4));

  // 4 brick (2×2) → bricks block.
  out.push(shaped('bricks', 'Bricks',
    [['brick', 'brick'], ['brick', 'brick']], 'bricks', 1));

  // Glowstone block: 4 redstone in a 2×2 (a friendly stand-in recipe so the
  // glowing block is craftable underground).
  out.push(shaped('glowstone', 'Glowstone',
    [['redstone', 'redstone'], ['redstone', 'redstone']], 'glowstone', 1));

  // Lantern: torch wrapped in iron (ring of iron around a torch) — bright.
  out.push(shaped('lantern', 'Lantern',
    [['iron_ingot', 'iron_ingot', 'iron_ingot'],
     ['iron_ingot', 'torch', 'iron_ingot'],
     ['iron_ingot', 'iron_ingot', 'iron_ingot']], 'lantern', 1));

  // Sandstone: 4 sand (2×2).
  out.push(shaped('sandstone', 'Sandstone',
    [['sand', 'sand'], ['sand', 'sand']], 'sandstone', 1));

  // Glass-ish: not smeltable here, skip (smelting lives in furnace later).

  // Mossy cobblestone: cobble + a tall-grass tuft (whimsical, craftable).
  out.push(shapeless('mossy_cobble', 'Mossy Cobblestone', ['cobblestone', 'tall_grass'], 'mossy_cobble', 1));

  /* ---- containers / misc utensils ------------------------------------- */
  // Bucket: 3 iron in a V.
  out.push(shaped('bucket', 'Bucket',
    [['iron_ingot', null, 'iron_ingot'], [null, 'iron_ingot', null]], 'bucket', 1));

  // Bowl: 3 planks in a V → 4 bowls.
  out.push(shaped('bowl', 'Bowl',
    [['planks', null, 'planks'], [null, 'planks', null]], 'bowl', 4));

  /* ---- food ----------------------------------------------------------- */
  // 3 wheat in a row → bread.
  out.push(shaped('bread', 'Bread', [['wheat', 'wheat', 'wheat']], 'bread', 1));

  // Mushroom stew: bowl + red mushroom (shapeless).
  out.push(shapeless('mushroom_stew', 'Mushroom Stew', ['bowl', 'mushroom_red'], 'mushroom_stew', 1));

  /* ---- decorative / conversion ---------------------------------------- */
  // 9 iron ingots compacting is out of scope; instead, a simple "raw → ?"
  // is left to the furnace. We add a couple of friendly conversions:

  // 4 planks → ... already crafting table; provide cobblestone "polishing":
  // (none — keep block set minimal and intuitive.)

  /* ---- the full tool/weapon matrix ------------------------------------ */
  for (const mat of TOOL_MATERIALS) {
    const prefix = TOOL_KEY_PREFIX[mat.tier];
    for (const kind of TOOL_KINDS) {
      const outKey = `${prefix}_${kind}`;
      // Only register if the item actually exists in the registry.
      if (!Items.has(outKey)) continue;
      const matLabel = cap(mat.tier === 'wooden' ? 'wooden' : mat.tier);
      out.push(shaped(
        `${outKey}`,
        `${matLabel} ${KIND_LABEL[kind]}`,
        P[kind](mat.head),
        outKey,
        1,
      ));
    }
  }

  // Drop any recipe whose output item is somehow missing (defensive).
  return out.filter((r) => Items.has(r.output.id));
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

export default Crafting;
