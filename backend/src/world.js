// De stad: een raster van straten (2 cellen breed) en blokken (6x6 cellen). 1 cel = 2 meter in de 3D-weergave.
export const CELL = 2;
export const NB = 5;          // blokken per zijde
export const PERIOD = 8;      // 2 straat + 6 blok
export const BLOCK = 6;
export const SIZE = NB * PERIOD + 2;

const LAYOUT = [
  ['hospital', 'farm', 'workshop', 'farm', 'farm'],
  ['homes', 'homes', 'depot', 'homes', 'homes'],
  ['workshop', 'homes', 'gov', 'homes', 'workshop'],
  ['homes', 'homes', 'park', 'homes', 'homes'],
  ['farm', 'farm', 'workshop', 'farm', 'farm'],
];

const NAMES = {
  hospital: 'Ziekenhuis', farm: 'Kassen & akkers', workshop: 'Werkplaats', depot: 'Distributiecentrum',
  gov: 'Stadhuis (AI-overheid)', park: 'Park', house: 'Woning',
};

export function buildWorld() {
  const roads = new Uint8Array(SIZE * SIZE);
  for (let z = 0; z < SIZE; z++) for (let x = 0; x < SIZE; x++) roads[z * SIZE + x] = x % PERIOD < 2 || z % PERIOD < 2 ? 1 : 0;

  const buildings = [];
  const blocks = [];
  let id = 0;
  for (let bz = 0; bz < NB; bz++) {
    for (let bx = 0; bx < NB; bx++) {
      const type = LAYOUT[bz][bx];
      const ix = bx * PERIOD + 2, iz = bz * PERIOD + 2;
      blocks.push({ bx, bz, x: ix, z: iz, w: BLOCK, d: BLOCK, type });
      if (type === 'homes') {
        for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
          const door = i === 0 ? { x: ix - 1, z: iz + 3 * j + 1 } : { x: ix + 6, z: iz + 3 * j + 1 };
          buildings.push({ id: id++, type: 'house', name: NAMES.house, x: ix + 3 * i, z: iz + 3 * j, w: 3, d: 3, door, side: i === 0 ? 'w' : 'e', bx, bz });
        }
      } else {
        buildings.push({ id: id++, type, name: NAMES[type], x: ix, z: iz, w: BLOCK, d: BLOCK, door: { x: ix - 1, z: iz + 3 }, side: 'w', bx, bz });
      }
    }
  }
  const byId = Object.fromEntries(buildings.map((b) => [b.id, b]));
  const ofType = (t) => buildings.filter((b) => b.type === t);
  return { size: SIZE, cell: CELL, roads, buildings, blocks, byId, ofType };
}

export const isRoad = (w, x, z) => x >= 0 && z >= 0 && x < SIZE && z < SIZE && w.roads[z * SIZE + x] === 1;
export const doorPoint = (b) => [b.door.x + 0.5, b.door.z + 0.5];

// Punt "binnen" een gebouw waar iemand blijft staan.
export function yardPoint(b, rng) {
  if (b.type === 'house') return [b.x + 1.5, b.z + 1.5];
  return [b.x + 0.8 + rng() * (b.w - 1.6), b.z + 0.8 + rng() * (b.d - 1.6)];
}

// BFS over straatcellen. Geeft lijst van [x,z] celmiddens.
export function roadPath(w, from, to) {
  const start = nearestRoad(w, from[0], from[1]);
  const goal = nearestRoad(w, to[0], to[1]);
  const key = (x, z) => z * SIZE + x;
  const prev = new Int32Array(SIZE * SIZE).fill(-2);
  const q = [key(start[0], start[1])];
  prev[q[0]] = -1;
  const goalK = key(goal[0], goal[1]);
  for (let qi = 0; qi < q.length && prev[goalK] === -2; qi++) {
    const k = q[qi], x = k % SIZE, z = (k / SIZE) | 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (!isRoad(w, nx, nz)) continue;
      const nk = key(nx, nz);
      if (prev[nk] !== -2) continue;
      prev[nk] = k;
      q.push(nk);
    }
  }
  const out = [];
  for (let k = goalK; k !== -1 && k !== -2; k = prev[k]) out.push([(k % SIZE) + 0.5, ((k / SIZE) | 0) + 0.5]);
  return out.reverse();
}

export function nearestRoad(w, x, z) {
  let cx = Math.floor(x), cz = Math.floor(z);
  cx = Math.max(0, Math.min(SIZE - 1, cx)); cz = Math.max(0, Math.min(SIZE - 1, cz));
  if (isRoad(w, cx, cz)) return [cx, cz];
  for (let r = 1; r < SIZE; r++) {
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      if (isRoad(w, cx + dx, cz + dz)) return [cx + dx, cz + dz];
    }
  }
  return [0, 0];
}
