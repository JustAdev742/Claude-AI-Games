/* =========================================================================
   remotePlayers.js — renders and animates other players.

   Each remote player is an articulated box rig in the Minecraft idiom: head,
   body, two arms, two legs, jointed at the shoulder and hip. Limbs are
   parented to pivot Groups placed AT the joint rather than at the limb's
   centre, because rotating a mesh about its own origin swings it around its
   middle — arms would rotate about the elbow instead of the shoulder.

   Animation is driven entirely by state that already crosses the wire: the
   interpolated position gives walk speed, the flags byte gives sprint,
   sneak, and arm swing. Nothing animation-specific is transmitted, so the
   cost of a fully animated remote player is zero extra bandwidth.

   Lighting deserves a note. Everything else in the world is lit by the baked
   voxel light (see world/lighting.js), so a player rendered with a plain
   material would be the one object in the scene the sun shines through walls
   onto. Instead each rig samples the light at its own position every frame
   and tints itself to match — a player standing in a cave goes dark, and one
   holding a torch is picked out by it.
   ========================================================================= */

import * as THREE from 'three';
import { FLAG } from '../../shared/protocol.js';

/* Proportions in blocks. A player is 1.8 tall, matching the collision box. */
const S = {
  headSize: 0.5,
  bodyW: 0.5, bodyH: 0.6, bodyD: 0.25,
  armW: 0.25, armH: 0.6, armD: 0.25,
  legW: 0.25, legH: 0.7, legD: 0.25,
};

/* Distinct hues per player so people are visually separable at a glance,
   chosen by id rather than randomly so a player looks the same to everyone. */
const SKINS = [
  { shirt: 0x3f7fd4, pants: 0x2b3a5c, skin: 0xe0ac7e },
  { shirt: 0xd44f3f, pants: 0x4a2b2b, skin: 0xc98d5f },
  { shirt: 0x4fb36a, pants: 0x2f4a35, skin: 0xf0c9a0 },
  { shirt: 0xd9b13f, pants: 0x5c4a2b, skin: 0x9c6b45 },
  { shirt: 0x9a5fd4, pants: 0x3d2b5c, skin: 0xe8bb92 },
  { shirt: 0xd45f9a, pants: 0x5c2b45, skin: 0xb87a52 },
];

function boxMesh(w, h, d, colour, material) {
  const geom = new THREE.BoxGeometry(w, h, d);
  const mesh = new THREE.Mesh(geom, material);
  mesh.userData.baseColour = new THREE.Color(colour);
  return mesh;
}

class RemotePlayerRig {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.group = new THREE.Group();
    this.group.name = `player_${id}`;

    const skin = SKINS[id % SKINS.length];

    // One material per rig (not per part) so a light change is a single
    // uniform write, and so the whole player tints together.
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });

    this.parts = {};
    this._buildBody(skin);

    // Walk cycle phase, advanced by distance travelled rather than by time,
    // so the stride matches the speed instead of sliding.
    this.phase = 0;
    this.swingTimer = 0;
    this._lastPos = new THREE.Vector3();
    this._tint = new THREE.Color(1, 1, 1);
  }

  _buildBody(skin) {
    const g = this.group;

    // Body sits so the rig's origin is at the player's feet.
    const legTop = S.legH;
    const bodyMid = legTop + S.bodyH / 2;

    this.parts.body = coloured(boxMesh(S.bodyW, S.bodyH, S.bodyD, skin.shirt, this.material), skin.shirt);
    this.parts.body.position.y = bodyMid;
    g.add(this.parts.body);

    // Head pivots at the neck so looking up/down rotates it, not translates it.
    this.parts.neck = new THREE.Group();
    this.parts.neck.position.y = legTop + S.bodyH;
    g.add(this.parts.neck);
    this.parts.head = coloured(boxMesh(S.headSize, S.headSize, S.headSize, skin.skin, this.material), skin.skin);
    this.parts.head.position.y = S.headSize / 2;
    this.parts.neck.add(this.parts.head);

    // Arms and legs hang from pivots at shoulder/hip height. The mesh is
    // offset DOWN by half its length inside the pivot, so rotating the pivot
    // swings the limb from its top end.
    const mkLimb = (name, w, h, d, colour, x, y) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, 0);
      const mesh = coloured(boxMesh(w, h, d, colour, this.material), colour);
      mesh.position.y = -h / 2;
      pivot.add(mesh);
      g.add(pivot);
      this.parts[name] = pivot;
      return pivot;
    };

    const shoulderY = legTop + S.bodyH;
    mkLimb('armL', S.armW, S.armH, S.armD, skin.shirt, -(S.bodyW / 2 + S.armW / 2), shoulderY);
    mkLimb('armR', S.armW, S.armH, S.armD, skin.shirt, (S.bodyW / 2 + S.armW / 2), shoulderY);
    mkLimb('legL', S.legW, S.legH, S.legD, skin.pants, -S.legW / 2, legTop);
    mkLimb('legR', S.legW, S.legH, S.legD, skin.pants, S.legW / 2, legTop);

    this.nameSprite = makeNameTag(this.name);
    this.nameSprite.position.y = legTop + S.bodyH + S.headSize + 0.35;
    g.add(this.nameSprite);
  }

  /**
   * @param {object} r   interpolated render state from NetClient
   * @param {number} dt  seconds
   * @param {number} sky 0..1 skylight at the player, already scaled by daylight
   * @param {number} blk 0..1 blocklight at the player
   */
  update(r, dt, sky, blk) {
    const g = this.group;
    g.position.set(r.x, r.y, r.z);
    // The rig models a player facing -Z at yaw 0, matching the camera.
    g.rotation.y = r.yaw;

    const sneaking = (r.flags & FLAG.SNEAKING) !== 0;
    const sprinting = (r.flags & FLAG.SPRINTING) !== 0;
    const swinging = (r.flags & FLAG.SWINGING) !== 0;

    // Head pitch, clamped so the head can't invert through the body.
    this.parts.neck.rotation.x = Math.max(-1.4, Math.min(1.4, r.pitch));

    // --- walk cycle -----------------------------------------------------
    const moved = Math.hypot(g.position.x - this._lastPos.x, g.position.z - this._lastPos.z);
    this._lastPos.copy(g.position);

    // Phase advances with distance, so limbs keep pace with actual travel and
    // never skate. Cap the per-frame advance so a teleport (or a long stall
    // followed by a big interpolation step) doesn't spin the legs.
    this.phase += Math.min(moved, 0.5) * 6.5;
    const amplitude = Math.min(1, moved / (dt || 0.016) / 4) * (sprinting ? 1.25 : 1.0);
    const swing = Math.sin(this.phase) * 0.9 * amplitude;

    this.parts.legL.rotation.x = swing;
    this.parts.legR.rotation.x = -swing;
    // Arms counter-swing to the legs, which is what makes a walk read as a
    // walk rather than a shuffle.
    this.parts.armL.rotation.x = -swing * 0.8;
    this.parts.armR.rotation.x = swing * 0.8;

    // --- arm swing (mining / attacking) ---------------------------------
    if (swinging) this.swingTimer = Math.min(1, this.swingTimer + dt * 5);
    else this.swingTimer = Math.max(0, this.swingTimer - dt * 5);
    if (this.swingTimer > 0) {
      // A quick over-the-shoulder chop layered on top of the walk swing.
      const t = Math.sin(this.swingTimer * Math.PI);
      this.parts.armR.rotation.x -= t * 1.9;
      this.parts.armR.rotation.z = -t * 0.35;
    } else {
      this.parts.armR.rotation.z = 0;
    }

    // --- sneak ----------------------------------------------------------
    const targetCrouch = sneaking ? 0.28 : 0;
    this.parts.body.rotation.x = lerp(this.parts.body.rotation.x, sneaking ? 0.5 : 0, dt * 10);
    g.position.y -= lerp(0, targetCrouch, 1);

    // --- lighting -------------------------------------------------------
    // Match the terrain's own light model so a player in a cave is dark.
    const level = Math.max(sky, blk);
    const warm = blk > sky ? 1 : 0;
    this._tint.setRGB(
      0.06 + level * (0.94 + warm * 0.06),
      0.06 + level * 0.94,
      0.07 + level * (0.94 - warm * 0.2),
    );
    applyTint(this.group, this._tint);

    this.nameSprite.rotation.y = -r.yaw;  // keep the tag facing outward
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material.map) o.material.map.dispose();
      if (o.material && o.material !== this.material) o.material.dispose();
    });
    this.material.dispose();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}

/* Bake a part's colour into vertex colours so one shared material can still
   give each part its own hue — cheaper than a material per part. */
function coloured(mesh, hex) {
  const c = new THREE.Color(hex);
  const count = mesh.geometry.attributes.position.count;
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  mesh.geometry.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  mesh.userData.base = c.clone();
  return mesh;
}

/* Multiply every part's baked colour by the ambient tint. */
function applyTint(root, tint) {
  root.traverse((o) => {
    if (!o.isMesh || !o.userData.base) return;
    const attr = o.geometry.attributes.color;
    if (!attr) return;
    const b = o.userData.base;
    const r = b.r * tint.r, g = b.g * tint.g, bl = b.b * tint.b;
    const a = attr.array;
    // Only rewrite when the tint actually moved: this runs per player per
    // frame, and rewriting 24 vertices' worth of floats for an unchanged
    // value is pure waste.
    if (Math.abs(a[0] - r) < 0.004 && Math.abs(a[1] - g) < 0.004 && Math.abs(a[2] - bl) < 0.004) return;
    for (let i = 0; i < a.length; i += 3) { a[i] = r; a[i + 1] = g; a[i + 2] = bl; }
    attr.needsUpdate = true;
  });
}

function makeNameTag(name) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(10,14,24,0.7)';
  ctx.roundRect ? (ctx.beginPath(), ctx.roundRect(8, 12, 240, 40, 8), ctx.fill())
    : ctx.fillRect(8, 12, 240, 40);
  ctx.font = 'bold 26px "Trebuchet MS", system-ui, sans-serif';
  ctx.fillStyle = '#e7ecff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name.slice(0, 16), 128, 33);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex,
    // Name tags stay readable through terrain, as in Minecraft — losing track
    // of a teammate behind a hill is worse than the slight cheat.
    depthTest: false,
    transparent: true,
  }));
  sprite.scale.set(1.6, 0.4, 1);
  sprite.renderOrder = 999;
  return sprite;
}

const lerp = (a, b, t) => a + (b - a) * Math.min(1, Math.max(0, t));

/* ---------------------------------------------------------------------- */

export class RemotePlayers {
  constructor(game, net) {
    this.game = game;
    this.net = net;
    this.rigs = new Map();
  }

  update(dt) {
    const scene = this.game.scene;
    const world = this.game.world;
    if (!scene) return;

    // Retire rigs for players who left.
    for (const [id, rig] of this.rigs) {
      if (!this.net.players.has(id)) { rig.dispose(); this.rigs.delete(id); }
    }

    if (!this.net.connected) {
      if (this.rigs.size) { for (const r of this.rigs.values()) r.dispose(); this.rigs.clear(); }
      return;
    }

    const daylight = (world && world.uniforms) ? world.uniforms.uDaylight.value : 1;

    for (const p of this.net.players.values()) {
      if (!p.render.valid) continue;
      let rig = this.rigs.get(p.id);
      if (!rig) {
        rig = new RemotePlayerRig(p.id, p.name);
        this.rigs.set(p.id, rig);
        scene.add(rig.group);
      }

      // Sample voxel light at head height so a player standing in a doorway
      // isn't lit by the floor they're above.
      let sky = 1, blk = 0;
      if (world && typeof world.getLightByte === 'function') {
        const packed = world.getLightByte(
          Math.floor(p.render.x), Math.floor(p.render.y + 1.5), Math.floor(p.render.z),
        );
        sky = ((packed >> 4) & 0x0f) / 15 * daylight;
        blk = (packed & 0x0f) / 15;
      }
      rig.update(p.render, dt, sky, blk);
    }
  }

  dispose() {
    for (const rig of this.rigs.values()) rig.dispose();
    this.rigs.clear();
  }
}

export default RemotePlayers;
