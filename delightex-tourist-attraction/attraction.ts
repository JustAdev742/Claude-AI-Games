// SKY BEACON PLAZA - a tourist attraction for Delightex Edu (CoSpaces) scripting.
//
// How to use: open an EMPTY space, click "Code" -> "Script", paste this whole file, press Play.
// Scripting needs Delightex Edu PRO. Delightex's Z axis is "up".
//
// What you get: a landmark tower with a glowing beacon, a fountain with jumping droplets,
// a rotating Ferris wheel, a gift shop, an entrance gate, trees, lamps, benches and
// visitors who stroll about. Everything is built from code, so tweak the numbers freely.

// ---- Settings ---------------------------------------------------------------------------
const SCALE = 1; // multiplies every position and size. Try 0.5 or 2 if the world looks too big/small.

// ==== SCENE:START ==== (engine-agnostic: only talks to `g`, also used by the browser preview)

// A thing you can move around or recolour after it is created.
interface Part {
  move(x: number, y: number, z: number): void; // moves the part's CENTRE
  paint(hex: string): void;
}

// Creation helpers. x,y = middle of the part on the ground, z = height of its bottom edge.
interface Gfx {
  cuboid(x: number, y: number, z: number, w: number, d: number, h: number, hex: string): Part;
  cylinder(x: number, y: number, z: number, r: number, h: number, hex: string): Part;
  cone(x: number, y: number, z: number, r: number, h: number, hex: string): Part;
  ball(x: number, y: number, z: number, r: number, hex: string): Part; // here z is the CENTRE
  label(x: number, y: number, z: number, text: string): void;
  every(fn: (t: number) => void, period: number): void; // t = seconds since start
}

function buildAttraction(g: Gfx): void {
  const C = {
    lawn: "#5fae5b", stone: "#d8d0c0", stone2: "#bfb5a0", path: "#b9a88a",
    wall: "#efe6d2", dark: "#3c3a44", glass: "#8fd3f4", roof: "#c8452f",
    gold: "#f6c945", water: "#4aa8e0", wood: "#7a5230", leaf: "#2f8f4a",
    leaf2: "#3fae5c", lamp: "#fff2b0", skin: "#f1c9a5",
  };
  const PARTY = ["#d94b4b", "#3b7dd8", "#f2c230", "#43b36b", "#9b59d0", "#ef8a3c"];

  // ---- Ground ---------------------------------------------------------------------------
  g.cuboid(0, 0, -1, 140, 140, 1, C.lawn);
  g.cuboid(0, 0, 0, 64, 64, 0.5, C.stone);
  g.cylinder(0, 0, 0.5, 22, 0.15, C.stone2);
  g.cuboid(0, -47, 0, 9, 30, 0.3, C.path); // entrance path

  // ---- The tower --------------------------------------------------------------------------
  g.cuboid(0, 0, 0.5, 20, 20, 1.5, C.stone2);
  g.cuboid(0, 0, 2, 15, 15, 2, C.stone);
  g.cuboid(0, 0, 4, 12, 12, 14, C.wall);
  g.cuboid(0, 0, 18, 13, 13, 1, C.dark);
  g.cuboid(0, 0, 19, 9, 9, 10, C.wall);
  g.cuboid(0, 0, 29, 10, 10, 1, C.dark);
  g.cuboid(0, 0, 30, 6, 6, 6, C.wall);
  g.cylinder(0, 0, 36, 9, 1.5, C.dark); // observation deck
  g.cylinder(0, 0, 37.5, 7.5, 4, C.glass);
  g.cylinder(0, 0, 41.5, 9, 1, C.dark);
  g.cone(0, 0, 42.5, 7, 6, C.roof);
  g.cylinder(0, 0, 48.5, 0.4, 8, C.gold); // spire
  const beacon = g.ball(0, 0, 58, 1.6, C.gold);
  for (const s of [-1, 1]) {
    g.cuboid(0, s * 6.05, 4, 4, 0.4, 6, C.dark); // doors
    g.cuboid(s * 6.05, 0, 4, 0.4, 4, 6, C.dark);
    g.cuboid(0, s * 4.55, 22, 2.5, 0.4, 3.5, C.glass); // windows
    g.cuboid(s * 4.55, 0, 22, 0.4, 2.5, 3.5, C.glass);
  }
  g.label(0, 0, 63, "SKY BEACON TOWER");

  // ---- Fountain ---------------------------------------------------------------------------
  const FX = 0, FY = -24;
  g.cylinder(FX, FY, 0.5, 5.5, 1.2, C.stone2);
  g.cylinder(FX, FY, 0.6, 5, 1.1, C.water);
  g.cylinder(FX, FY, 0.5, 0.9, 3.5, C.stone);
  g.cylinder(FX, FY, 3.8, 2.4, 0.6, C.stone2);
  const jet = g.ball(FX, FY, 5.6, 0.7, C.water);
  const drops: Part[] = [];
  for (let i = 0; i < 6; i++) drops.push(g.ball(FX, FY, 4.5, 0.35, C.water));

  // ---- Ferris wheel (the wheel plane faces +y; no rotation needed, parts just orbit) -------
  const WX = 50, WY = 6, WZ = 17, WR = 14;
  g.cuboid(WX, WY, 0, 8, 12, 0.8, C.dark); // footing
  g.cuboid(WX, WY - 3, 0.8, 1.6, 1.6, WZ - 0.8, C.stone2); // legs
  g.cuboid(WX, WY + 3, 0.8, 1.6, 1.6, WZ - 0.8, C.stone2);
  g.cuboid(WX, WY, WZ - 1.2, 2.4, 7, 2.4, C.gold); // hub
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    g.cuboid(WX + WR * Math.cos(a), WY, WZ + WR * Math.sin(a) - 0.6, 1.2, 1.2, 1.2, C.stone);
  }
  const spokes: { p: Part; k: number; i: number }[] = [];
  for (let i = 0; i < 8; i++)
    for (let k = 1; k <= 6; k++) spokes.push({ p: g.cuboid(WX, WY, 0, 0.6, 0.6, 0.6, C.stone2), k, i });
  const gondolas: { p: Part; i: number }[] = [];
  for (let i = 0; i < 12; i++) gondolas.push({ p: g.cuboid(WX, WY, 0, 2.2, 2.2, 2.2, PARTY[i % PARTY.length]), i });

  // ---- Gift shop --------------------------------------------------------------------------
  g.cuboid(-44, 6, 0, 14, 10, 7, C.wall);
  g.cuboid(-44, 6, 7, 16, 12, 1.2, C.roof);
  g.cuboid(-36.9, 6, 0, 0.4, 3, 4.6, C.wood); // door
  g.cuboid(-36.9, 1.8, 2, 0.4, 2.4, 2.4, C.glass); // windows
  g.cuboid(-36.9, 10.2, 2, 0.4, 2.4, 2.4, C.glass);
  for (let i = 0; i < 4; i++) // striped awning
    g.cuboid(-35.6, 6 + (i - 1.5) * 2.5, 4.8, 2.6, 2.5, 0.35, i % 2 ? "#ffffff" : "#d94b4b");
  g.label(-44, 6, 10.5, "GIFT SHOP");

  // ---- Entrance gate ----------------------------------------------------------------------
  g.cuboid(-7, -60, 0, 2.4, 2.4, 9, C.stone);
  g.cuboid(7, -60, 0, 2.4, 2.4, 9, C.stone);
  g.cuboid(0, -60, 9, 16.4, 2.6, 1.8, C.roof);
  g.label(0, -60, 13, "WELCOME");

  // ---- Trees, lamps, benches --------------------------------------------------------------
  const trees = [[-60, -50], [-62, -20], [-58, 30], [-30, 50], [0, 58], [28, 52], [60, 40], [62, -30], [44, -48], [-20, -56]];
  for (const [x, y] of trees) {
    g.cylinder(x, y, 0, 0.8, 5, C.wood);
    g.ball(x, y, 7.5, 3.6, C.leaf);
    g.ball(x, y, 10, 2.6, C.leaf2);
  }
  const lamps = [[-28, -28], [28, -28], [-28, 28], [28, 28], [-28, 0], [28, 0], [0, 28]];
  for (const [x, y] of lamps) {
    g.cylinder(x, y, 0.5, 0.25, 6, C.dark);
    g.ball(x, y, 7.1, 0.8, C.lamp);
  }
  for (const [x, y] of [[-22, 14], [22, 14], [-22, -6], [22, -6]]) {
    g.cuboid(x, y, 0.5, 4.4, 1.2, 0.9, C.dark);
    g.cuboid(x, y, 1.4, 5, 1.8, 0.3, C.wood);
    g.cuboid(x, y + 0.8, 1.7, 5, 0.3, 1.4, C.wood);
  }

  // ---- Visitors ---------------------------------------------------------------------------
  const walkers: { body: Part; head: Part; kind: number; n: number }[] = [];
  for (let n = 0; n < 4; n++) // stroll up and down the entrance path
    walkers.push({ body: g.cylinder(0, 0, 0, 0.6, 2.2, PARTY[n]), head: g.ball(0, 0, 0, 0.55, C.skin), kind: 0, n });
  for (let n = 0; n < 5; n++) // walk round the tower
    walkers.push({ body: g.cylinder(0, 0, 0, 0.6, 2.2, PARTY[(n + 2) % PARTY.length]), head: g.ball(0, 0, 0, 0.55, C.skin), kind: 1, n });

  // ---- Animation --------------------------------------------------------------------------
  g.every((t) => {
    const wheel = t * 0.2;
    for (const s of spokes) {
      const a = wheel + (s.i / 8) * Math.PI * 2;
      s.p.move(WX + s.k * 2.2 * Math.cos(a), WY, WZ + s.k * 2.2 * Math.sin(a));
    }
    for (const gd of gondolas) {
      const a = wheel + (gd.i / 12) * Math.PI * 2;
      gd.p.move(WX + WR * Math.cos(a), WY, WZ + WR * Math.sin(a) - 1.9); // hangs below the rim
    }
    jet.move(FX, FY, 5.8 + Math.sin(t * 3) * 0.5);
    drops.forEach((d, i) => {
      const a = t * 1.5 + (i * Math.PI) / 3;
      d.move(FX + Math.cos(a) * 3.2, FY + Math.sin(a) * 3.2, 4.6 + Math.abs(Math.sin(t * 3 + i)) * 1.8);
    });
    for (const w of walkers) {
      let x: number, y: number;
      if (w.kind === 0) {
        x = -3 + w.n * 2;
        y = -47 + 12 * Math.sin(t * (0.25 + w.n * 0.05) + w.n * 1.7);
      } else {
        const a = t * (0.12 + w.n * 0.015) * (w.n % 2 ? -1 : 1) + (w.n / 5) * Math.PI * 2;
        x = 15.5 * Math.cos(a);
        y = 15.5 * Math.sin(a);
      }
      w.body.move(x, y, 0.5 + 1.1);
      w.head.move(x, y, 0.5 + 2.2 + 0.55);
    }
  }, 0.05);

  g.every((t) => beacon.paint(Math.floor(t * 2.5) % 2 ? "#fff6c0" : "#ff9b2f"), 0.2); // blinking beacon
}
// ==== SCENE:END ====

// ---- Delightex adapter ----------------------------------------------------------------------
// The Scene.create* calls and Time.* below match the Delightex API docs. The item properties
// (.transform.position, .size, .color) and `new Color(r, g, b)` are the bits to check if the editor
// underlines something: fix them here and the whole scene follows.

function toColor(hex: string): any {
  const n = parseInt(hex.slice(1), 16);
  return new Color((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

function wrap(item: any, w: number, d: number, h: number, hex: string): Part {
  item.size = new Vector3(w * SCALE, d * SCALE, h * SCALE);
  item.color = toColor(hex);
  return {
    move(x, y, z) { item.transform.position = new Vector3(x * SCALE, y * SCALE, z * SCALE); },
    paint(c) { item.color = toColor(c); },
  };
}

const delightex: Gfx = {
  cuboid(x, y, z, w, d, h, hex) {
    const p = wrap(Scene.createCuboid(0, 0, 0), w, d, h, hex);
    p.move(x, y, z + h / 2);
    return p;
  },
  cylinder(x, y, z, r, h, hex) {
    const p = wrap(Scene.createCylinder(new Vector3(0, 0, 0)), 2 * r, 2 * r, h, hex);
    p.move(x, y, z + h / 2);
    return p;
  },
  cone(x, y, z, r, h, hex) {
    const p = wrap(Scene.createCone(new Vector3(0, 0, 0)), 2 * r, 2 * r, h, hex);
    p.move(x, y, z + h / 2);
    return p;
  },
  ball(x, y, z, r, hex) {
    const p = wrap(Scene.createEllipsoid(0, 0, 0), 2 * r, 2 * r, 2 * r, hex);
    p.move(x, y, z);
    return p;
  },
  label(x, y, z, text) {
    Scene.createText(new Vector3(x * SCALE, y * SCALE, z * SCALE), text);
  },
  every(fn, period) {
    Time.scheduleRepeating(() => fn(Time.currentTime), period);
  },
};

buildAttraction(delightex);
