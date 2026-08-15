// Least-cost path over passable ground.
//
// The candidate sampler in route.js perturbs a straight line and keeps the
// best result. That is the right tool for "avoid the exposed area", where a
// direct route exists and only needs nudging. It is the wrong tool for "get
// a vehicle through a mountain range", where the direct route is blocked by
// terrain it cannot cross and the answer is a valley thirty degrees off the
// bearing. Sampling reported every settlement as unreachable when a perfectly
// good route existed.
//
// So this is Dijkstra, with the binary heap that JavaScript does not provide.

class MinHeap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(node, priority) {
    this.items.push({ node: node, priority: priority });
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].priority <= this.items[i].priority) {
        break;
      }
      const swap = this.items[parent];
      this.items[parent] = this.items[i];
      this.items[i] = swap;
      i = parent;
    }
  }

  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.items.length && this.items[left].priority < this.items[smallest].priority) {
          smallest = left;
        }
        if (right < this.items.length && this.items[right].priority < this.items[smallest].priority) {
          smallest = right;
        }
        if (smallest === i) {
          break;
        }
        const swap = this.items[smallest];
        this.items[smallest] = this.items[i];
        this.items[i] = swap;
        i = smallest;
      }
    }
    return top.node;
  }
}

const NEIGHBOURS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

// Cost of stepping between two adjacent cells: distance travelled, plus the
// energy of any climb, plus a penalty for exposure if one is supplied.
export function findPath(dem, start, goal, grids, options) {
  const opts = options || {};
  const vehicle = opts.vehicle || null;
  const climbPenalty = opts.climbPenalty !== undefined
    ? opts.climbPenalty
    : vehicle ? vehicle.climbPenalty : 3;
  const exposurePenalty = opts.exposurePenalty === undefined ? 0 : opts.exposurePenalty;
  const speed = vehicle ? vehicle.speed : 5;

  const width = dem.width;
  const height = dem.height;
  const cellCount = width * height;

  const dist = new Float64Array(cellCount).fill(Infinity);
  const cameFrom = new Int32Array(cellCount).fill(-1);
  const settled = new Uint8Array(cellCount);

  const startIndex = start.y * width + start.x;
  const goalIndex = goal.y * width + goal.x;

  if (grids.passable && grids.passable[startIndex] === 0) {
    return { found: false, reason: "start is on ground this vehicle cannot cross" };
  }
  if (grids.passable && grids.passable[goalIndex] === 0) {
    return { found: false, reason: "destination is on ground this vehicle cannot cross" };
  }

  dist[startIndex] = 0;
  const heap = new MinHeap();
  heap.push(startIndex, 0);

  while (heap.size > 0) {
    const current = heap.pop();
    if (settled[current] === 1) {
      continue;
    }
    settled[current] = 1;
    if (current === goalIndex) {
      break;
    }

    const cx = current % width;
    const cy = (current - cx) / width;

    for (const [dx, dy] of NEIGHBOURS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
        continue;
      }
      const next = ny * width + nx;
      if (settled[next] === 1) {
        continue;
      }
      if (grids.passable && grids.passable[next] === 0) {
        continue;
      }

      const stepMetres = dem.cellSize * (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1);
      let stepCost = stepMetres;

      const rise = dem.elev[next] - dem.elev[current];
      if (rise > 0) {
        stepCost = stepCost + rise * climbPenalty;
      }
      if (exposurePenalty > 0 && grids.exposure && grids.exposure[next] > 0) {
        stepCost = stepCost + (exposurePenalty * stepMetres * grids.exposure[next]) / speed;
      }

      const candidate = dist[current] + stepCost;
      if (candidate < dist[next]) {
        dist[next] = candidate;
        cameFrom[next] = current;
        heap.push(next, candidate);
      }
    }
  }

  if (dist[goalIndex] === Infinity) {
    return { found: false, reason: "no passable route exists between these points" };
  }

  // Walk the path back and total it up the same way route.js does, so the two
  // produce comparable numbers.
  const trace = [];
  let node = goalIndex;
  while (node !== -1) {
    trace.push(node);
    node = cameFrom[node];
  }
  trace.reverse();

  const ASCENT_THRESHOLD = 8;
  let metres = 0;
  let ascentMetres = 0;
  let descentMetres = 0;
  let exposedSeconds = 0;
  let climbReference = dem.elev[trace[0]];
  let highest = dem.elev[trace[0]];

  for (let i = 1; i < trace.length; i++) {
    const previous = trace[i - 1];
    const current = trace[i];
    const px = previous % width;
    const py = (previous - px) / width;
    const cx = current % width;
    const cy = (current - cx) / width;
    const stepMetres = dem.cellSize * (px !== cx && py !== cy ? Math.SQRT2 : 1);
    metres = metres + stepMetres;

    const here = dem.elev[current];
    if (here > highest) {
      highest = here;
    }
    if (!(vehicle && vehicle.airborne)) {
      if (here > climbReference + ASCENT_THRESHOLD) {
        ascentMetres = ascentMetres + (here - climbReference);
        climbReference = here;
      } else if (here < climbReference - ASCENT_THRESHOLD) {
        descentMetres = descentMetres + (climbReference - here);
        climbReference = here;
      }
    }
    if (grids.exposure && grids.exposure[current] > 0) {
      exposedSeconds = exposedSeconds + stepMetres / speed;
    }
  }

  if (vehicle && vehicle.airborne) {
    ascentMetres = Math.max(0, highest - dem.elev[trace[0]]);
    descentMetres = ascentMetres;
  }

  return {
    found: true,
    trace: trace,
    metres: metres,
    seconds: metres / speed,
    ascentMetres: ascentMetres,
    descentMetres: descentMetres,
    exposedSeconds: exposedSeconds,
    blockedCells: 0,
    cost: dist[goalIndex],
  };
}
