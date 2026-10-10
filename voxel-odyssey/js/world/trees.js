/* =========================================================================
   trees.js — the shape of each tree species, as a list of blocks.

   One definition shared by world generation (which writes the blocks into a
   chunk, clipping at its edges) and by saplings growing in a live world
   (which writes them with World.setBlock). Pure and deterministic: all
   randomness comes from the `r` function passed in, and it is consumed in a
   fixed order, so the same stream always builds the same tree.
   ========================================================================= */

import { ID } from './blocks.js';

export const TREE_KINDS = ['oak', 'birch', 'pine'];

const SPECIES = {
  oak: { log: ID.LOG, leaf: ID.LEAVES, sapling: ID.SAPLING_OAK },
  birch: { log: ID.BIRCH_LOG, leaf: ID.BIRCH_LEAVES, sapling: ID.SAPLING_BIRCH },
  pine: { log: ID.PINE_LOG, leaf: ID.PINE_LEAVES, sapling: ID.SAPLING_PINE },
};

export function treeSpecies(kind) { return SPECIES[kind] || SPECIES.oak; }

// Which species a sapling block grows into (null for anything else).
export function kindOfSapling(blockId) {
  for (const k of TREE_KINDS) if (SPECIES[k].sapling === blockId) return k;
  return null;
}

/**
 * The blocks of one tree, relative to the trunk base.
 *
 * @param {'oak'|'birch'|'pine'} kind
 * @param {() => number} r   uniform [0,1) source
 * @param {number} headroom  how many blocks of vertical space there are above
 *                           the base (the world ceiling, for generation)
 * @returns {{ trunkH:number, blocks: Array<{dx:number,dy:number,dz:number,id:number,leaf:boolean}> }}
 *          Trunks are never shorter than 3; callers clip against the world
 *          ceiling themselves.
 */
export function treeBlocks(kind, r, headroom = 64) {
  const sp = treeSpecies(kind);
  let trunkH, shape;
  if (kind === 'birch') { trunkH = 5 + Math.floor(r() * 2); shape = 'round'; }
  else if (kind === 'pine') { trunkH = 6 + Math.floor(r() * 3); shape = 'cone'; }
  else { trunkH = 4 + Math.floor(r() * 2); shape = 'round'; }
  const radius = 2;

  const topY = trunkH - 1;
  // Not enough vertical room: shorten (to a floor of 3) rather than clip the
  // canopy oddly.
  if (topY + radius > headroom) trunkH = Math.max(3, headroom - radius);

  const blocks = [];
  for (let i = 0; i < trunkH; i++) blocks.push({ dx: 0, dy: i, dz: 0, id: sp.log, leaf: false });

  if (shape === 'cone') {
    // Wide at the bottom, narrowing upward, with chamfered corners.
    const top = trunkH - 1;
    for (let y = 1; y <= top + 1; y++) {
      const ring = top + 1 - y;
      const rad = ring >= 4 ? 2 : ring >= 2 ? 1 : 0;
      if (rad === 0) {
        // The single leaf on the axis: only above the trunk, never inside it.
        if (y > top) blocks.push({ dx: 0, dy: y, dz: 0, id: sp.leaf, leaf: true });
        continue;
      }
      for (let dx = -rad; dx <= rad; dx++) {
        for (let dz = -rad; dz <= rad; dz++) {
          if (Math.abs(dx) === rad && Math.abs(dz) === rad) continue;
          if (dx === 0 && dz === 0 && y <= top) continue;           // keep the trunk
          blocks.push({ dx, dy: y, dz, id: sp.leaf, leaf: true });
        }
      }
    }
  } else {
    // Rounded canopy centred near the trunk top: two wide layers and a cap.
    const topLogY = trunkH - 1;
    const layers = [{ dy: -1, rad: 2 }, { dy: 0, rad: 2 }, { dy: 1, rad: 1 }, { dy: 2, rad: 1 }];
    for (const layer of layers) {
      const y = topLogY + layer.dy;
      if (y < 0) continue;
      const rad = layer.rad;
      for (let dx = -rad; dx <= rad; dx++) {
        for (let dz = -rad; dz <= rad; dz++) {
          if (dx === 0 && dz === 0 && layer.dy <= 0) continue;      // let the log show through
          if (rad === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;   // round the corners
          blocks.push({ dx, dy: y, dz, id: sp.leaf, leaf: true });
        }
      }
    }
  }
  return { trunkH, blocks };
}
