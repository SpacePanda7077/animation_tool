/**
 * The maths behind skinned meshes, with no Phaser in it (so it can be tested on its own).
 *
 * Vertices live in the mesh's UNIT space: x, y in -0.5..0.5 across the rectangle (0, 0 = its center, +y down),
 * and u, v are the matching texture coordinates (0..1, v = 0 at the top of the image). Because the vertices are
 * relative to the rectangle, resizing the rectangle resizes the mesh with it.
 */

/** one bone's pull on a vertex (the weights of a vertex should add up to 1) */
export type Weight = { boneId: string; weight: number };

export type GridVertex = { x: number; y: number; u: number; v: number };

/** a bone as a line segment in world space (pivot -> tip) */
export type BoneSegment = {
    id: string;
    ax: number;
    ay: number;
    bx: number;
    by: number;
};

export const MAX_GRID = 30;

/** (cols + 1) x (rows + 1) vertices, two triangles per cell; `tris` holds 3 vertex indices per triangle */
export function makeGrid(
    cols: number,
    rows: number,
): { verts: GridVertex[]; tris: number[] } {
    const verts: GridVertex[] = [];
    for (let j = 0; j <= rows; j++) {
        for (let i = 0; i <= cols; i++) {
            const u = i / cols;
            const v = j / rows;
            verts.push({ x: u - 0.5, y: v - 0.5, u, v });
        }
    }
    const tris: number[] = [];
    const stride = cols + 1;
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            const a = j * stride + i;
            const b = a + 1;
            const c = a + stride;
            const d = c + 1;
            tris.push(a, b, c, b, d, c);
        }
    }
    return { verts, tris };
}

/** distance from a point to a line segment */
export function distToSegment(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
): number {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t =
        len2 < 1e-9
            ? 0
            : Math.max(
                  0,
                  Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2),
              );
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Weights for every point: the `maxBones` nearest bones (measured to the whole bone, not just its base),
 * each pulling with 1 / distance². `soft` keeps a point that lies right on a bone from ignoring all the others.
 */
export function autoWeights(
    points: { x: number; y: number }[],
    bones: BoneSegment[],
    maxBones: number,
    soft: number,
): Weight[][] {
    if (bones.length === 0) return points.map(() => []);
    return points.map((p) => {
        const near = bones
            .map((b) => ({
                id: b.id,
                d: distToSegment(p.x, p.y, b.ax, b.ay, b.bx, b.by),
            }))
            .sort((a, b) => a.d - b.d)
            .slice(0, Math.max(1, maxBones));
        const raw = near.map((n) => ({
            boneId: n.id,
            weight: 1 / (n.d * n.d + soft * soft),
        }));
        const sum = raw.reduce((s, w) => s + w.weight, 0);
        // tiny pulls are noise: drop them and share their weight out
        const kept = raw
            .map((w) => ({ ...w, weight: w.weight / sum }))
            .filter((w) => w.weight >= 0.02);
        const keptSum = kept.reduce((s, w) => s + w.weight, 0);
        return kept.map((w) => ({
            boneId: w.boneId,
            weight: w.weight / keptSum,
        }));
    });
}

/** a world point -> the bone's own frame (origin = its pivot, x axis along the bone) */
export function toBoneLocal(
    wx: number,
    wy: number,
    pivotX: number,
    pivotY: number,
    angle: number,
): { x: number; y: number } {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const dx = wx - pivotX;
    const dy = wy - pivotY;
    return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

/** a point in the bone's own frame -> world */
export function fromBoneLocal(
    lx: number,
    ly: number,
    pivotX: number,
    pivotY: number,
    angle: number,
): { x: number; y: number } {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return { x: pivotX + lx * c - ly * s, y: pivotY + lx * s + ly * c };
}

// ---------------------------------------------------------------------------
// Triangulation
// ---------------------------------------------------------------------------

/** a vertex this close to the picture's outline (in unit space) is moved onto it, so the outline never gets slivers */
export const SNAP = 0.005;

/** keep a vertex inside the picture (-0.5..0.5) and snap it onto the outline when it is nearly there */
export function snapUnit(x: number, y: number): { x: number; y: number } {
    const f = (v: number) => {
        const c = Math.max(-0.5, Math.min(0.5, v));
        if (0.5 - Math.abs(c) < SNAP) return Math.sign(c || 1) * 0.5;
        return c;
    };
    return { x: f(x), y: f(y) };
}

/** the four corners of the picture hold the outline: they can be neither moved nor deleted */
export const isCorner = (x: number, y: number) =>
    Math.abs(Math.abs(x) - 0.5) < 1e-9 && Math.abs(Math.abs(y) - 0.5) < 1e-9;

type P2 = { x: number; y: number };

/**
 * Delaunay triangulation of a point set (Bowyer-Watson). Returns 3 point indices per triangle covering the convex
 * hull of the points. Points on top of an earlier point are skipped (they end up in no triangle).
 */
export function delaunay(pts: P2[]): number[] {
    const n = pts.length;
    if (n < 3) return [];

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
    }
    const d = Math.max(maxX - minX, maxY - minY, 1e-6);
    const mx = (minX + maxX) / 2;
    const my = (minY + maxY) / 2;
    // The super triangle stands in for "infinity". It has to be much bigger than any hull sliver's circumcircle:
    // a vertex that is 0.5% of the image from the outline needs k > 50 (see snapUnit, which keeps vertices out of that zone).
    const k = 200;
    const P: P2[] = [
        ...pts,
        { x: mx - k * d, y: my - d },
        { x: mx, y: my + k * d },
        { x: mx + k * d, y: my - d },
    ];

    // Triangles are kept counter-clockwise so the in-circle test below has a known sign.
    // (A determinant test instead of a stored circumcircle: slivers have enormous circumcircles that lose precision.)
    type Tri = { a: number; b: number; c: number; flat: boolean };
    const orient = (a: number, b: number, c: number) =>
        (P[b].x - P[a].x) * (P[c].y - P[a].y) -
        (P[b].y - P[a].y) * (P[c].x - P[a].x);
    const make = (a: number, b: number, c: number): Tri => {
        const o = orient(a, b, c);
        return o < 0
            ? { a, b: c, c: b, flat: false }
            : { a, b, c, flat: o < 1e-14 };
    };
    const inCircle = (t: Tri, p: P2) => {
        const A = P[t.a];
        const B = P[t.b];
        const C = P[t.c];
        const ax = A.x - p.x;
        const ay = A.y - p.y;
        const bx = B.x - p.x;
        const by = B.y - p.y;
        const cx = C.x - p.x;
        const cy = C.y - p.y;
        const det =
            (ax * ax + ay * ay) * (bx * cy - cx * by) -
            (bx * bx + by * by) * (ax * cy - cx * ay) +
            (cx * cx + cy * cy) * (ax * by - bx * ay);
        return det > 1e-14;
    };

    let tris: Tri[] = [make(n, n + 1, n + 2)];
    const seen: P2[] = [];

    for (let i = 0; i < n; i++) {
        const p = P[i];
        if (seen.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1e-9)) continue;
        seen.push(p);

        const keep: Tri[] = [];
        const edges = new Map<string, [number, number, number]>(); // key -> [u, v, count]
        for (const t of tris) {
            if (!t.flat && !inCircle(t, p)) {
                keep.push(t);
                continue;
            }
            for (const [u, v] of [
                [t.a, t.b],
                [t.b, t.c],
                [t.c, t.a],
            ]) {
                const key = u < v ? `${u}_${v}` : `${v}_${u}`;
                const e = edges.get(key);
                if (e) e[2]++;
                else edges.set(key, [u, v, 1]);
            }
        }
        tris = keep;
        for (const [u, v, count] of edges.values())
            if (count === 1) tris.push(make(u, v, i));
    }

    const out: number[] = [];
    for (const t of tris) {
        if (t.a >= n || t.b >= n || t.c >= n) continue;
        const A = P[t.a];
        const B = P[t.b];
        const C = P[t.c];
        const area =
            Math.abs((B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y)) / 2;
        if (area < 1e-12) continue;
        out.push(t.a, t.b, t.c);
    }
    return out;
}

/**
 * Drop the triangles that only cover see-through parts of the picture.
 * A triangle stays if any of a small lattice of sample points inside it is opaque (`opaque` gets unit-space x, y).
 */
export function keepOpaqueTriangles(
    verts: P2[],
    tris: number[],
    opaque: (x: number, y: number) => boolean,
    steps = 4,
): number[] {
    const out: number[] = [];
    for (let t = 0; t < tris.length; t += 3) {
        const A = verts[tris[t]];
        const B = verts[tris[t + 1]];
        const C = verts[tris[t + 2]];
        let hit = false;
        for (let i = 0; i <= steps && !hit; i++) {
            for (let j = 0; i + j <= steps && !hit; j++) {
                const a = steps - i - j;
                const x = (A.x * a + B.x * i + C.x * j) / steps;
                const y = (A.y * a + B.y * i + C.y * j) / steps;
                if (opaque(x, y)) hit = true;
            }
        }
        if (hit) out.push(tris[t], tris[t + 1], tris[t + 2]);
    }
    return out;
}

/** barycentric coordinates of p in triangle abc (null for a degenerate triangle) */
export function barycentric(
    p: P2,
    a: P2,
    b: P2,
    c: P2,
): [number, number, number] | null {
    const d = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(d) < 1e-14) return null;
    const wa = ((b.y - c.y) * (p.x - c.x) + (c.x - b.x) * (p.y - c.y)) / d;
    const wb = ((c.y - a.y) * (p.x - c.x) + (a.x - c.x) * (p.y - c.y)) / d;
    return [wa, wb, 1 - wa - wb];
}

/** for every vertex, the vertices it shares a triangle edge with */
export function neighborLists(vertexCount: number, tris: number[]): number[][] {
    const sets: Set<number>[] = Array.from(
        { length: vertexCount },
        () => new Set(),
    );
    for (let t = 0; t < tris.length; t += 3) {
        const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
        sets[a].add(b).add(c);
        sets[b].add(a).add(c);
        sets[c].add(a).add(b);
    }
    return sets.map((s) => [...s]);
}

// ---------------------------------------------------------------------------
// Weight editing
// ---------------------------------------------------------------------------

/** a vertex can be pulled by at most this many bones */
export const MAX_INFLUENCES = 4;

/** clean up a weight list: biggest first, at most `max` bones, tiny ones dropped, adding up to exactly 1 (or empty) */
export function normalizeWeights(ws: Weight[], max = MAX_INFLUENCES): Weight[] {
    const sorted = ws
        .filter((w) => w.weight > 1e-4)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, max);
    const sum = sorted.reduce((s, w) => s + w.weight, 0);
    if (sum < 1e-9) return [];
    const scaled = sorted.map((w) => ({
        boneId: w.boneId,
        weight: w.weight / sum,
    }));
    // a leftover sliver is not worth an influence
    const kept = scaled.filter((w) => w.weight >= 0.01);
    const keptSum = kept.reduce((s, w) => s + w.weight, 0);
    return kept.map((w) => ({ boneId: w.boneId, weight: w.weight / keptSum }));
}

/**
 * Paint: push one bone's weight up (amount > 0) or down (amount < 0) and share the difference with the other bones,
 * so the weights keep adding up to 1. A vertex that has no weights yet goes straight to full weight on that bone.
 */
export function paintWeight(
    ws: Weight[],
    boneId: string,
    amount: number,
): Weight[] {
    const cur = ws.find((w) => w.boneId === boneId)?.weight ?? 0;
    const next = Math.max(0, Math.min(1, cur + amount));
    const others = ws.filter((w) => w.boneId !== boneId);
    const osum = others.reduce((s, w) => s + w.weight, 0);

    if (next <= 1e-4) return normalizeWeights(others);
    if (osum < 1e-9) {
        // no other bone: a fresh vertex goes straight to full weight, but a vertex that already has this bone
        // keeps the partial value so Remove can lower it step by step (the rest follows the rectangle, rigid)
        return cur > 0 ? [{ boneId, weight: next }] : [{ boneId, weight: 1 }];
    }
    const scale = (1 - next) / osum;
    return normalizeWeights([
        { boneId, weight: next },
        ...others.map((w) => ({ boneId: w.boneId, weight: w.weight * scale })),
    ]);
}

/** blend a vertex's weights towards the average of its neighbours' weights (t = 0..1) */
export function smoothWeight(
    own: Weight[],
    neighbours: Weight[][],
    t: number,
): Weight[] {
    if (neighbours.length === 0) return own;
    const acc = new Map<string, number>();
    for (const w of own)
        acc.set(w.boneId, (acc.get(w.boneId) ?? 0) + w.weight * (1 - t));
    const share = t / neighbours.length;
    for (const ws of neighbours)
        for (const w of ws)
            acc.set(w.boneId, (acc.get(w.boneId) ?? 0) + w.weight * share);
    // a neighbour without weights pulls towards "no bone" and removes some of the total: normalising puts it back
    return normalizeWeights(
        [...acc].map(([boneId, weight]) => ({ boneId, weight })),
    );
}

/** the weights of a new vertex placed inside a triangle: its three corners' weights mixed by barycentric coordinates */
export function mixWeights(corners: Weight[][], coords: number[]): Weight[] {
    const acc = new Map<string, number>();
    corners.forEach((ws, i) => {
        const c = Math.max(0, coords[i]);
        for (const w of ws)
            acc.set(w.boneId, (acc.get(w.boneId) ?? 0) + w.weight * c);
    });
    return normalizeWeights(
        [...acc].map(([boneId, weight]) => ({ boneId, weight })),
    );
}
