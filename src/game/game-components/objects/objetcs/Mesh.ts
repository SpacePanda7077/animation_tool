import type { Scene, GameObjects } from "phaser";
import { Rect, type RectState } from "./Rect";
import { Bone } from "./Bone";
import type { sprite_config } from "../configuration";
import {
    MAX_GRID,
    autoWeights,
    barycentric,
    delaunay,
    isCorner,
    keepOpaqueTriangles,
    makeGrid,
    mixWeights,
    neighborLists,
    paintWeight,
    smoothWeight,
    snapUnit,
    toBoneLocal,
    type Weight,
} from "./mesh-math";

/** one bone's pull on a vertex (the weights of a vertex add up to 1) */
export type VertexWeight = Weight;

/**
 * A vertex in the mesh's UNIT space: x, y run from -0.5 to 0.5 across the rectangle (0, 0 = its center),
 * u, v are the texture coordinates. It is relative to the rectangle, so scaling the rectangle scales the mesh.
 */
export type MeshVertex = {
    x: number;
    y: number;
    u: number;
    v: number;
    weights: VertexWeight[];
};

export type MeshState = RectState & {
    texture: string;
    cols: number;
    rows: number;
    /** leave out the triangles that only cover transparent parts of the picture */
    trim: boolean;
    vertices: MeshVertex[];
    /** triangle corners (flat list of vertex indices, 3 per triangle) */
    indices: number[];
};

export type mesh_config = sprite_config & {
    /** grid subdivision (default 4x4) */
    cols?: number;
    rows?: number;
};

/** how the weight brush works */
export type PaintMode = "add" | "remove" | "smooth";

const clampGrid = (n: number) =>
    Math.max(1, Math.min(MAX_GRID, Math.round(n) || 1));

/**
 * A skinned mesh: textured triangles whose vertices follow one or more bones.
 *
 * Same pattern as Sprite: an invisible Rect does all the editing (handles, pivot, dragging, layers, the single
 * "controlled by" bone) and a Phaser Mesh2D draws the picture on top of it.
 *
 *  - setup mode: the mesh is rigid, it sits where its rectangle is.
 *  - pose mode: a vertex with weights goes to the weighted average of where each of its bones would carry it
 *    (linear blend skinning). A vertex without weights stays rigid, following the rectangle (and so its bone).
 *
 * The bind pose is not stored anywhere: it is captured from the skeleton every time pose mode is entered (the
 * rectangle and the bones are in their setup pose at that moment), so it can never be out of date, and undo /
 * redo / save / load only need the vertices and their weights.
 */
export class Mesh extends Rect {
    /** every live mesh in the scene */
    static all = new Set<Mesh>();

    /** call once per frame: re-skin every bound mesh (the bones may have moved, rotated, been animated, IK-solved...) */
    static updateAll() {
        if (Bone.mode !== "pose") return;
        for (const m of Mesh.all) if (m.alive && !m.hidden && m.bound) m.writeVertices(true);
    }

    /** the Phaser object that draws the triangles; it stays at (0, 0), its vertices are written in world space */
    mesh: GameObjects.Mesh2D;
    textureKey: string;

    cols: number;
    rows: number;
    /** leave out the triangles that only cover transparent parts of the picture */
    trim = true;
    vertices: MeshVertex[] = [];
    /** triangle corners, 3 vertex indices per triangle (the export uses this list as it is) */
    indices: number[] = [];

    /** pose mode: per vertex, per weight, the bone and the vertex in that bone's frame at bind time */
    private bound = false;
    private bindBones: (Bone | null)[][] = [];
    private bindX: number[][] = [];
    private bindY: number[][] = [];
    private neighbors: number[][] | null = null;
    /** is the picture opaque here? (unit space) undefined = not read yet, null = can't be read (everything counts as opaque) */
    private opaque: ((x: number, y: number) => boolean) | null | undefined;
    private readonly texScene: Scene;

    constructor(scene: Scene, config: mesh_config) {
        // Rect's constructor already calls updateHandles(); syncMesh() ignores that call because there is no mesh yet
        super(scene, {
            x: config.x,
            y: config.y,
            width: config.width,
            height: config.height,
            color: 0xffffff,
        });
        this.texScene = scene;
        this.textureKey = config.texture;
        this.name = config.name ?? config.texture;
        this.cols = clampGrid(config.cols ?? 4);
        this.rows = clampGrid(config.rows ?? 4);

        // invisible, but still there to be clicked
        this.rect.setFillStyle(0xffffff, 0);

        this.mesh = scene.add.mesh2d(0, 0, config.texture, [], []);
        // the vertices change every frame while posing, so let the renderer draw plain triangles
        this.mesh.setRenderAsTriangles(true);

        Mesh.all.add(this);
        this.buildGrid();
    }

    // ------------------------------------------------------------------
    // Geometry
    // ------------------------------------------------------------------

    /** a fresh regular grid over the picture. This clears every weight. */
    buildGrid() {
        const { verts, tris } = makeGrid(this.cols, this.rows);
        this.vertices = verts.map((v) => ({ ...v, weights: [] }));
        this.indices = this.trimmed(tris);
        this.neighbors = null;
        this.bound = false;
        this.rebuildGeometry();
        this.syncMesh();
        this.onChange?.(this);
    }

    /** change the grid detail (setup mode only; this clears every weight) */
    setGrid(cols: number, rows: number) {
        if (this.locked) return;
        const c = clampGrid(cols);
        const r = clampGrid(rows);
        if (c === this.cols && r === this.rows) return;
        this.cols = c;
        this.rows = r;
        this.buildGrid();
    }

    /** hand the vertices (x, y, u, v) and triangles (a, b, c, page) to the Phaser object */
    private rebuildGeometry() {
        const verts: number[] = [];
        for (const v of this.vertices) verts.push(0, 0, v.u, v.v);
        const idx: number[] = [];
        for (let i = 0; i < this.indices.length; i += 3)
            idx.push(
                this.indices[i],
                this.indices[i + 1],
                this.indices[i + 2],
                0,
            );
        this.mesh.vertices = verts;
        this.mesh.indices = idx;
    }

    /** where the rectangle puts a vertex in the world (the rigid placement) */
    rigidPoint(v: { x: number; y: number }): { x: number; y: number } {
        const r = this.rect;
        const lx = v.x * r.displayWidth;
        const ly = v.y * r.displayHeight;
        const c = Math.cos(r.rotation);
        const s = Math.sin(r.rotation);
        return { x: r.x + lx * c - ly * s, y: r.y + lx * s + ly * c };
    }

    // ------------------------------------------------------------------
    // Transparency
    // ------------------------------------------------------------------

    /** reads the picture once; afterwards "is it opaque here?" is a lookup */
    private alpha(): (x: number, y: number) => boolean {
        if (this.opaque === undefined) {
            try {
                const img = this.texScene.textures
                    .get(this.textureKey)
                    .getSourceImage() as HTMLImageElement | HTMLCanvasElement;
                const w = img.width;
                const h = img.height;
                const canvas = document.createElement("canvas");
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
                ctx.drawImage(img, 0, 0);
                const data = ctx.getImageData(0, 0, w, h).data;
                this.opaque = (x, y) => {
                    const px = Math.max(0, Math.min(w - 1, Math.floor((x + 0.5) * w)));
                    const py = Math.max(0, Math.min(h - 1, Math.floor((y + 0.5) * h)));
                    return data[(py * w + px) * 4 + 3] > 10;
                };
            } catch {
                this.opaque = null; // the picture can't be read: keep everything
            }
        }
        const f = this.opaque;
        return f ?? (() => true);
    }

    /** the triangles that cover something visible (or all of them if trimming is off or nothing would be left) */
    private trimmed(tris: number[]): number[] {
        if (!this.trim) return tris;
        const kept = keepOpaqueTriangles(this.vertices, tris, this.alpha());
        return kept.length > 0 ? kept : tris;
    }

    /** turn the trimming of transparent areas on / off */
    setTrim(on: boolean) {
        if (this.locked || on === this.trim) return;
        this.trim = on;
        this.retriangulate();
    }

    // ------------------------------------------------------------------
    // Vertex editing (setup mode)
    // ------------------------------------------------------------------

    /** work out the triangles again from the vertices (after adding / removing / moving them) */
    retriangulate() {
        this.indices = this.trimmed(delaunay(this.vertices));
        this.neighbors = null;
        this.rebuildGeometry();
        this.syncMesh();
        this.onChange?.(this);
    }

    /** a world point -> unit space (the opposite of rigidPoint) */
    unitFromWorld(wx: number, wy: number): { x: number; y: number } {
        const r = this.rect;
        const dx = wx - r.x;
        const dy = wy - r.y;
        const c = Math.cos(r.rotation);
        const s = Math.sin(r.rotation);
        return {
            x: (dx * c + dy * s) / (r.displayWidth || 1),
            y: (-dx * s + dy * c) / (r.displayHeight || 1),
        };
    }

    /** the closest vertex within `radius` (world units) of a world point, or -1 */
    vertexAt(wx: number, wy: number, radius: number): number {
        let best = -1;
        let bestD = radius;
        this.vertices.forEach((v, i) => {
            const p = this.rigidPoint(v);
            const d = Math.hypot(p.x - wx, p.y - wy);
            if (d <= bestD) {
                bestD = d;
                best = i;
            }
        });
        return best;
    }

    isCornerVertex(i: number) {
        const v = this.vertices[i];
        return !!v && isCorner(v.x, v.y);
    }

    /**
     * Drag a vertex. The picture moves with it (the texture coordinates follow the vertex), so the image is not
     * distorted. The triangles are only worked out again when you let go: call retriangulate().
     */
    moveVertex(i: number, wx: number, wy: number) {
        const v = this.vertices[i];
        if (this.locked || !v || isCorner(v.x, v.y)) return;
        const u = this.unitFromWorld(wx, wy);
        const p = snapUnit(u.x, u.y);
        v.x = p.x;
        v.y = p.y;
        v.u = p.x + 0.5;
        v.v = p.y + 0.5;
        this.mesh.vertices[i * 4 + 2] = v.u;
        this.mesh.vertices[i * 4 + 3] = v.v;
        this.syncMesh();
        this.onChange?.(this);
    }

    /** add a vertex where you click (it takes its weights from the triangle it lands in). Returns its index, or -1. */
    addVertexAt(wx: number, wy: number): number {
        if (this.locked) return -1;
        const u = this.unitFromWorld(wx, wy);
        if (Math.abs(u.x) > 0.5 + 1e-9 || Math.abs(u.y) > 0.5 + 1e-9) return -1;
        const p = snapUnit(u.x, u.y);
        const near = this.vertices.findIndex(
            (v) => Math.hypot(v.x - p.x, v.y - p.y) < 0.004,
        );
        if (near >= 0) return near;

        // weights: mix the corners of the triangle it lands in; outside every triangle, copy the nearest vertex
        let weights: VertexWeight[] = [];
        for (let t = 0; t < this.indices.length; t += 3) {
            const ia = this.indices[t];
            const ib = this.indices[t + 1];
            const ic = this.indices[t + 2];
            const b = barycentric(p, this.vertices[ia], this.vertices[ib], this.vertices[ic]);
            if (b && b.every((c) => c >= -1e-9)) {
                weights = mixWeights(
                    [ia, ib, ic].map((k) => this.vertices[k].weights),
                    b,
                );
                break;
            }
        }
        if (weights.length === 0 && this.hasWeights) {
            let best = 0;
            let bestD = Infinity;
            this.vertices.forEach((v, i) => {
                const d = Math.hypot(v.x - p.x, v.y - p.y);
                if (d < bestD) {
                    bestD = d;
                    best = i;
                }
            });
            weights = this.vertices[best].weights.map((w) => ({ ...w }));
        }

        this.vertices.push({ x: p.x, y: p.y, u: p.x + 0.5, v: p.y + 0.5, weights });
        this.retriangulate();
        return this.vertices.length - 1;
    }

    /** delete a vertex (the four corners stay, and so do at least four vertices) */
    removeVertex(i: number): boolean {
        if (this.locked || this.isCornerVertex(i) || this.vertices.length <= 4) return false;
        if (!this.vertices[i]) return false;
        this.vertices.splice(i, 1);
        this.retriangulate();
        return true;
    }

    // ------------------------------------------------------------------
    // Weight painting (setup mode)
    // ------------------------------------------------------------------

    /** how much of `boneId` a vertex has (0 if it has none) */
    weightOf(i: number, boneId: string): number {
        return this.vertices[i]?.weights.find((w) => w.boneId === boneId)?.weight ?? 0;
    }

    /**
     * One dab of the brush at a world point. Vertices closer than `radius` are changed, most in the middle.
     *  add: more of the bone, remove: less of it, smooth: blend towards the neighbouring vertices.
     */
    paintAt(wx: number, wy: number, radius: number, boneId: string, mode: PaintMode, strength: number) {
        if (this.locked || Bone.mode !== "setup" || radius <= 0) return;
        if (mode === "smooth" && !this.neighbors)
            this.neighbors = neighborLists(this.vertices.length, this.indices);
        const nb = this.neighbors;

        const next = new Map<number, VertexWeight[]>();
        this.vertices.forEach((v, i) => {
            const p = this.rigidPoint(v);
            const d = Math.hypot(p.x - wx, p.y - wy);
            if (d > radius) return;
            const amount = strength * (1 - (d / radius) ** 2);
            if (mode === "add") next.set(i, paintWeight(v.weights, boneId, amount));
            else if (mode === "remove") next.set(i, paintWeight(v.weights, boneId, -amount));
            else
                next.set(
                    i,
                    smoothWeight(
                        v.weights,
                        (nb?.[i] ?? []).map((j) => this.vertices[j].weights),
                        Math.min(1, amount),
                    ),
                );
        });
        if (next.size === 0) return;
        // applied after the loop so "smooth" reads the weights from before this dab
        for (const [i, w] of next) this.vertices[i].weights = w;
        this.syncMesh();
        this.onChange?.(this);
    }

    // ------------------------------------------------------------------
    // Weights
    // ------------------------------------------------------------------

    /** true if at least one vertex follows a bone directly */
    get hasWeights() {
        return this.vertices.some((v) => v.weights.length > 0);
    }

    /**
     * Give every vertex weights from the bones that are nearest to it (setup mode only).
     * Distance is measured to the whole bone, from its base to its tip.
     */
    autoWeight(bones: Bone[], maxBones = 2) {
        if (this.locked || Bone.mode !== "setup") return;
        const live = bones.filter((b) => b.alive);
        if (live.length === 0) return;

        const segs = live.map((b) => ({
            id: b.id,
            ax: b.pivot.x,
            ay: b.pivot.y,
            bx: b.poll.x,
            by: b.poll.y,
        }));
        const size = Math.max(this.rect.displayWidth, this.rect.displayHeight);
        const w = autoWeights(
            this.vertices.map((v) => this.rigidPoint(v)),
            segs,
            maxBones,
            size * 0.02,
        );
        this.vertices.forEach((v, i) => (v.weights = w[i]));
        this.syncMesh();
        this.onChange?.(this);
    }

    /** back to a rigid mesh (setup mode only) */
    clearWeights() {
        if (this.locked) return;
        for (const v of this.vertices) v.weights = [];
        this.syncMesh();
        this.onChange?.(this);
    }

    /** point weights at other bones (used when a bone chain is duplicated); bones that are not in the map stay as they are */
    remapBones(map: Map<string, string>) {
        for (const v of this.vertices)
            v.weights = v.weights.map((w) => ({
                boneId: map.get(w.boneId) ?? w.boneId,
                weight: w.weight,
            }));
        this.syncMesh();
    }

    // ------------------------------------------------------------------
    // Binding & skinning
    // ------------------------------------------------------------------

    /**
     * Remember every vertex in the frame of each bone that pulls on it. Must run while the rectangle and the bones
     * are in their setup pose (that is exactly when enterPose() runs).
     */
    private bindPose() {
        this.bound = false;
        this.bindBones = [];
        this.bindX = [];
        this.bindY = [];
        if (!this.hasWeights) return;

        const byId = new Map<string, Bone>();
        for (const b of Bone.all) if (b.alive) byId.set(b.id, b);

        for (const v of this.vertices) {
            const p = this.rigidPoint(v);
            const bones: (Bone | null)[] = [];
            const xs: number[] = [];
            const ys: number[] = [];
            for (const w of v.weights) {
                const b = byId.get(w.boneId) ?? null;
                bones.push(b);
                const l = b
                    ? toBoneLocal(p.x, p.y, b.pivot.x, b.pivot.y, b.angle)
                    : { x: 0, y: 0 };
                xs.push(l.x);
                ys.push(l.y);
            }
            this.bindBones.push(bones);
            this.bindX.push(xs);
            this.bindY.push(ys);
        }
        this.bound = true;
    }

    /**
     * Write the world position of every vertex into the Phaser object.
     * skinned = vertices with weights follow their bones; otherwise (or without weights) they follow the rectangle.
     */
    private writeVertices(skinned: boolean) {
        const out = this.mesh.vertices;
        // a bone's cosine / sine are the same for all of its vertices: work them out once per call
        const frames = new Map<Bone, { c: number; s: number }>();

        for (let i = 0; i < this.vertices.length; i++) {
            const v = this.vertices[i];
            let pos: { x: number; y: number } | null = null;

            if (skinned && v.weights.length > 0) {
                let sx = 0;
                let sy = 0;
                let total = 0;
                const bones = this.bindBones[i];
                for (let k = 0; k < v.weights.length; k++) {
                    const b = bones[k];
                    const w = v.weights[k].weight;
                    if (!b || !b.alive || w <= 0) continue;
                    let f = frames.get(b);
                    if (!f) {
                        const a = b.angle;
                        f = { c: Math.cos(a), s: Math.sin(a) };
                        frames.set(b, f);
                    }
                    const lx = this.bindX[i][k];
                    const ly = this.bindY[i][k];
                    sx += (b.pivot.x + lx * f.c - ly * f.s) * w;
                    sy += (b.pivot.y + lx * f.s + ly * f.c) * w;
                    total += w;
                }
                // weights may add up to less than 1: the leftover share stays rigid under the rectangle
                let declared = 0;
                for (const w of v.weights) declared += w.weight;
                const rest = Math.max(0, 1 - declared);
                if (total > 1e-6) {
                    const r = rest > 1e-6 ? this.rigidPoint(v) : null;
                    const den = total + rest;
                    pos = r
                        ? { x: (sx + r.x * rest) / den, y: (sy + r.y * rest) / den }
                        : { x: sx / total, y: sy / total };
                }
            }

            // no weights (or no bone left to follow): rigid under the rectangle
            if (!pos) pos = this.rigidPoint(v);
            out[i * 4] = pos.x;
            out[i * 4 + 1] = pos.y;
        }
    }

    /** put the Phaser object in step with the rectangle (visibility, layer, vertices) */
    private syncMesh() {
        const m = this.mesh;
        if (!m) return;
        const visible = this.alive && !this.hidden;
        m.setVisible(visible).setDepth(this.rect.depth);
        if (visible) this.writeVertices(this.bound && Bone.mode === "pose");
    }

    // ------------------------------------------------------------------
    // Keep the mesh in step with the rectangle (same pattern as Sprite)
    // ------------------------------------------------------------------

    updateHandles() {
        super.updateHandles();
        this.syncMesh();
    }

    setLayer(depth: number) {
        super.setLayer(depth);
        this.syncMesh();
    }

    setVisible(v: boolean) {
        super.setVisible(v);
        this.syncMesh();
    }

    kill() {
        super.kill();
        Mesh.all.delete(this);
        this.syncMesh();
    }

    revive() {
        super.revive();
        Mesh.all.add(this);
        this.syncMesh();
    }

    /** meshes have no fill color (the rectangle must stay invisible) */
    setColor(_color: number) {
        void _color;
    }

    /** entering pose mode: the skeleton and the rectangle are in setup pose right now, so bind to them */
    enterPose() {
        super.enterPose();
        this.bindPose();
        this.syncMesh();
    }

    /** back to setup mode: rigid again */
    exitPose() {
        super.exitPose();
        this.bound = false;
        this.syncMesh();
    }

    // ------------------------------------------------------------------
    // Undo / redo / save
    // ------------------------------------------------------------------

    snapshot(): MeshState {
        return {
            ...super.snapshot(),
            texture: this.textureKey,
            cols: this.cols,
            rows: this.rows,
            trim: this.trim,
            vertices: this.vertices.map((v) => ({
                x: v.x,
                y: v.y,
                u: v.u,
                v: v.v,
                weights: v.weights.map((w) => ({ ...w })),
            })),
            indices: [...this.indices],
        };
    }

    restore(
        s: Omit<RectState, "id" | "parentBone"> & {
            texture?: string;
            cols?: number;
            rows?: number;
            trim?: boolean;
            vertices?: MeshVertex[];
            indices?: number[];
        },
    ) {
        super.restore(s); // this also gives the rectangle a fill again...
        this.rect.setFillStyle(0xffffff, 0); // ...so take it away
        if (s.texture && s.texture !== this.textureKey) {
            this.textureKey = s.texture;
            this.mesh.setTexture(s.texture);
            this.opaque = undefined; // another picture: read it again when needed
        }
        if (s.trim !== undefined) this.trim = s.trim;
        if (s.cols !== undefined) this.cols = clampGrid(s.cols);
        if (s.rows !== undefined) this.rows = clampGrid(s.rows);
        if (s.vertices && s.indices) {
            this.vertices = s.vertices.map((v) => ({
                ...v,
                weights: v.weights.map((w) => ({ ...w })),
            }));
            this.indices = [...s.indices];
            this.neighbors = null;
            this.rebuildGeometry();
        }
        this.bound = false;
        this.syncMesh();
    }
}
