// Isolation forest (Liu, Ting & Zhou, ICDM 2008): anomalies are few and different, so
// random splits isolate them in fewer steps than normal points. Pure and seeded, so a
// model trained from the same rows is the same model, and replays are reproducible.

export interface Tree {
  // A node is either a split [feature, threshold, left, right] or a leaf [-1, size].
  nodes: number[][];
}

export interface Forest {
  trees: Tree[];
  sample: number; // rows per tree, which sets the expected path length
}

// Average path length of an unsuccessful search in a binary search tree of n points.
function c(n: number): number {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  return 2 * (Math.log(n - 1) + 0.5772156649) - (2 * (n - 1)) / n;
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

export function train(rows: number[][], options: { trees?: number; sample?: number; seed?: number } = {}): Forest {
  const random = rng(options.seed ?? 1);
  const sample = Math.min(options.sample ?? 256, rows.length);
  const limit = Math.ceil(Math.log2(Math.max(sample, 2)));
  const trees: Tree[] = [];
  for (let t = 0; t < (options.trees ?? 100); t++) {
    const picked: number[][] = [];
    for (let i = 0; i < sample; i++) picked.push(rows[Math.floor(random() * rows.length)]);
    const nodes: number[][] = [];
    const grow = (part: number[][], depth: number): number => {
      const id = nodes.length;
      nodes.push([]);
      const width = part[0]?.length ?? 0;
      // Features that still vary in this part; a constant one cannot split.
      const varying: number[] = [];
      for (let f = 0; f < width; f++) {
        if (part.some((r) => r[f] !== part[0][f])) varying.push(f);
      }
      if (depth >= limit || part.length <= 1 || varying.length === 0) {
        nodes[id] = [-1, part.length];
        return id;
      }
      const f = varying[Math.floor(random() * varying.length)];
      let lo = Infinity;
      let hi = -Infinity;
      for (const r of part) {
        lo = Math.min(lo, r[f]);
        hi = Math.max(hi, r[f]);
      }
      const threshold = lo + random() * (hi - lo);
      const left = grow(part.filter((r) => r[f] < threshold), depth + 1);
      const right = grow(part.filter((r) => r[f] >= threshold), depth + 1);
      nodes[id] = [f, threshold, left, right];
      return id;
    };
    grow(picked, 0);
    trees.push({ nodes });
  }
  return { trees, sample };
}

// Anomaly score in (0, 1): about 0.5 for ordinary points, towards 1 for anomalies.
export function score(forest: Forest, x: number[]): number {
  let total = 0;
  for (const tree of forest.trees) {
    let id = 0;
    let depth = 0;
    for (;;) {
      const node = tree.nodes[id];
      if (node[0] === -1) {
        total += depth + c(node[1]);
        break;
      }
      id = x[node[0]] < node[1] ? node[2] : node[3];
      depth += 1;
    }
  }
  return 2 ** (-(total / forest.trees.length) / c(forest.sample));
}
