import { Scene, GameObjects, Geom, Math as PMath } from "phaser";
import { Rect, type RectState } from "./Rect";
import type { Bone } from "./Bone";
import type { sprite_config } from "../configuration";

/** one bone influence on a vertex (weights should sum to ~1) */
export type VertexWeight = {
    boneId: string;
    weight: number;
};

/** bind-pose vertex in the mesh's local space */
export type MeshVertex = {
    /** local position at bind time (relative to mesh pivot / center) */
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
    vertices: MeshVertex[];
    /** triangle indices (flat list of vertex indices, 3 per triangle) */
    indices: number[];
};

export type mesh_config = sprite_config & {
    /** grid subdivision (default 4x4) */
    cols?: number;
    rows?: number;
};

/**
 * A skinned mesh: textured triangles whose vertices can be influenced by multiple bones.
 *
 * Architecture (same pattern as Sprite):
 * - An invisible Rect does all the editing (handles, pivot, drag, layers, single-bone hierarchy).
 * - A Phaser Mesh renders the deformed geometry.
 * - In setup mode the mesh sits rigidly under its optional parent bone (like a Sprite).
 * - In pose mode vertices are skinned with Linear Blend Skinning using the bind pose
 *   captured when the mesh was created / last rebound.
 */
export class Mesh extends Rect {
    /** every live mesh in the scene (for the global skin pass) */
    static all = new Set<Mesh>();

    /**
     * After bones have laid out, skin every mesh that has weights.
     * Call from Bone.layout() when in pose mode.
     */
    static skinAll(boneById: Map<string, Bone>) {
        for (const m of Mesh.all) {
            if (m.alive) m.skinWithBones(boneById);
        }
    }

    /** Phaser Mesh used for rendering (WebGL only) */
    mesh: GameObjects.Mesh2D;
    textureKey: string;

    cols: number;
    rows: number;
    vertices: MeshVertex[] = [];
    indices: number[] = [];

    /**
     * Bind-pose bone data: boneId -> pivot + angle at bind time.
     * Used together with per-vertex local offsets for LBS.
     */
    private bindBones = new Map<
        string,
        { x: number; y: number; angle: number }
    >();

    /**
     * For each vertex, for each weight, the position of that vertex in the
     * bone's local space at bind time. Parallel to vertices[i].weights.
     * Computed in captureBindPose / autoWeight.
     */
    private bindLocals: { x: number; y: number }[][] = [];

    /** true after we have a valid bind pose */
    private bound = false;

    constructor(scene: Scene, config: mesh_config) {
        super(scene, {
            x: config.x,
            y: config.y,
            width: config.width,
            height: config.height,
            color: 0xffffff,
        });

        Mesh.all.add(this);

        this.textureKey = config.texture;
        this.name = config.name ?? config.texture;
        this.cols = Math.max(1, config.cols ?? 4);
        this.rows = Math.max(1, config.rows ?? 4);

        // invisible hit rectangle (same as Sprite)
        this.rect.setFillStyle(0xffffff, 0);

        // create empty Phaser Mesh; we will fill vertices after grid generation
        this.mesh = scene.add.mesh(config.x, config.y, config.texture);
        this.mesh.setOrtho(
            scene.scale.width / scene.scale.height,
            1,
        );
        // keep everything in the XY plane
        this.mesh.hideCCW = false;

        this.buildGrid();
        this.captureBindPose();
        this.syncMesh();
    }

    // ------------------------------------------------------------------
    // Grid generation
    // ------------------------------------------------------------------

    /** rebuild vertices + indices as a regular grid covering the current rect size */
    buildGrid() {
        const cols = this.cols;
        const rows = this.rows;
        const hw = this.rect.displayWidth / 2;
        const hh = this.rect.displayHeight / 2;

        const verts: MeshVertex[] = [];
        for (let j = 0; j <= rows; j++) {
            for (let i = 0; i <= cols; i++) {
                const u = i / cols;
                const v = j / rows;
                // local space: origin at center, +x right, +y down (Phaser convention)
                verts.push({
                    x: -hw + u * this.rect.displayWidth,
                    y: -hh + v * this.rect.displayHeight,
                    u,
                    v,
                    weights: [],
                });
            }
        }

        const indices: number[] = [];
        const stride = cols + 1;
        for (let j = 0; j < rows; j++) {
            for (let i = 0; i < cols; i++) {
                const a = j * stride + i;
                const b = a + 1;
                const c = a + stride;
                const d = c + 1;
                // two triangles per cell
                indices.push(a, b, c, b, d, c);
            }
        }

        this.vertices = verts;
        this.indices = indices;
        this.rebuildPhaserMesh();
    }

    /** push current vertices/indices into the Phaser Mesh object */
    private rebuildPhaserMesh() {
        const verts = this.vertices;
        const indices = this.indices;

        // Phaser Mesh expects interleaved data or separate arrays.
        // We use clear + addVertices for simplicity.
        this.mesh.clear();

        // Build flat arrays for addVertices
        const positions: number[] = [];
        const uvs: number[] = [];
        const colors: number[] = [];
        const alphas: number[] = [];

        for (const v of verts) {
            positions.push(v.x, v.y, 0); // z = 0
            uvs.push(v.u, v.v);
            colors.push(0xffffff);
            alphas.push(1);
        }

        this.mesh.addVertices(
            positions,
            uvs,
            indices,
            false, // containsZ? we pass z already
            null as any, // normals
            colors,
            alphas,
        );
    }

    // ------------------------------------------------------------------
    // Binding & skinning
    // ------------------------------------------------------------------

    /**
     * Capture bind pose for the bones that currently influence the mesh.
     * Must be called while bones are in the pose that should be the rest pose
     * (normally setup mode). Also builds bindLocals for LBS.
     */
    captureBindPose(bones: Bone[]) {
        this.bindBones.clear();
        for (const bone of bones) {
            this.bindBones.set(bone.id, {
                x: bone.pivot.x,
                y: bone.pivot.y,
                angle: bone.angle,
            });
        }
        this.recomputeBindLocals(bones);
        this.bound = true;
    }

    /**
     * For every vertex / weight, store the vertex position in that bone's
     * local space at the current (bind) pose.
     */
    private recomputeBindLocals(_bones: Bone[]) {
        // mesh world transform right now (should be the bind placement)
        const mx = this.rect.x;
        const my = this.rect.y;
        const mrot = this.rect.rotation;
        const mcos = Math.cos(mrot);
        const msin = Math.sin(mrot);

        this.bindLocals = this.vertices.map((v) => {
            // vertex in world space at bind
            const wx = mx + v.x * mcos - v.y * msin;
            const wy = my + v.x * msin + v.y * mcos;

            return v.weights.map(({ boneId }) => {
                const bind = this.bindBones.get(boneId);
                if (!bind) return { x: 0, y: 0 };
                // into bone local: translate by -pivot, rotate by -angle
                const dx = wx - bind.x;
                const dy = wy - bind.y;
                const ca = Math.cos(-bind.angle);
                const sa = Math.sin(-bind.angle);
                return {
                    x: dx * ca - dy * sa,
                    y: dx * sa + dy * ca,
                };
            });
        });
    }

    /**
     * Distance-based auto-weighting.
     * Each vertex gets weights to the nearest `maxBones` bones.
     * Call while bones are in their bind (setup) pose.
     */
    autoWeight(bones: Bone[], maxBones = 2, influenceRadius?: number) {
        if (bones.length === 0) return;

        const radius =
            influenceRadius ??
            Math.max(this.rect.displayWidth, this.rect.displayHeight) * 0.75;

        const mx = this.rect.x;
        const my = this.rect.y;
        const rot = this.rect.rotation;
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);

        for (const v of this.vertices) {
            const wx = mx + v.x * cos - v.y * sin;
            const wy = my + v.x * sin + v.y * cos;

            const dists = bones.map((b) => ({
                bone: b,
                d: PMath.Distance.Between(wx, wy, b.pivot.x, b.pivot.y),
            }));
            dists.sort((a, b) => a.d - b.d);

            const chosen = dists
                .slice(0, maxBones)
                .filter((d) => d.d < radius * 2);

            if (chosen.length === 0) {
                v.weights = [{ boneId: dists[0].bone.id, weight: 1 }];
                continue;
            }

            let sum = 0;
            const raw = chosen.map(({ bone, d }) => {
                const w = 1 / (d * d + 1e-4);
                sum += w;
                return { boneId: bone.id, weight: w };
            });
            v.weights = raw.map((r) => ({
                boneId: r.boneId,
                weight: r.weight / sum,
            }));
        }

        this.captureBindPose(bones);
        this.syncMeshRigid();
    }

    /**
     * Linear Blend Skinning using an explicit bone lookup.
     * Call every frame in pose mode (and from the runtime player).
     */
    skinWithBones(boneById: Map<string, Bone>) {
        if (this.vertices.length === 0) return;

        const hasWeights = this.vertices.some((v) => v.weights.length > 0);
        if (!hasWeights || !this.bound) {
            this.syncMeshRigid();
            return;
        }

        // Mesh GameObject stays at origin of the deformed mesh's bounding box
        // for simplicity we leave it at the rect center and put deformed verts in its local space.
        const mx = this.rect.x;
        const my = this.rect.y;

        const positions: number[] = [];
        const uvs: number[] = [];

        for (let vi = 0; vi < this.vertices.length; vi++) {
            const v = this.vertices[vi];
            const locals = this.bindLocals[vi] ?? [];

            let sx = 0;
            let sy = 0;
            let totalW = 0;

            for (let wi = 0; wi < v.weights.length; wi++) {
                const { boneId, weight } = v.weights[wi];
                if (weight <= 0) continue;
                const bone = boneById.get(boneId);
                const local = locals[wi];
                if (!bone || !local) continue;

                // current bone world matrix * bind local offset
                const ca = Math.cos(bone.angle);
                const sa = Math.sin(bone.angle);
                const wx = bone.pivot.x + local.x * ca - local.y * sa;
                const wy = bone.pivot.y + local.x * sa + local.y * ca;

                sx += wx * weight;
                sy += wy * weight;
                totalW += weight;
            }

            if (totalW < 1e-6) {
                // should not happen if weights were assigned
                sx = mx + v.x;
                sy = my + v.y;
            } else {
                sx /= totalW;
                sy /= totalW;
            }

            // store in Mesh GO local space (Mesh GO will be placed at 0,0 rotation 0
            // so we can just use world positions directly by moving the GO)
            positions.push(sx, sy, 0);
            uvs.push(v.u, v.v);
        }

        this.updatePhaserVertices(positions, uvs);
        // place the Mesh GO at world origin so its vertex positions are world
        this.mesh.setPosition(0, 0).setRotation(0);
        this.mesh.setDepth(this.rect.depth);
        this.mesh.setVisible(this.alive && !this.hidden);
    }

    /** rigid placement (no skinning) – used in setup mode and when unbound */
    private syncMeshRigid() {
        const r = this.rect;
        const positions: number[] = [];
        const uvs: number[] = [];
        for (const v of this.vertices) {
            positions.push(v.x, v.y, 0);
            uvs.push(v.u, v.v);
        }
        this.updatePhaserVertices(positions, uvs);
        this.mesh
            .setPosition(r.x, r.y)
            .setRotation(r.rotation)
            .setDepth(r.depth)
            .setVisible(this.alive && !this.hidden);
    }

    private updatePhaserVertices(positions: number[], uvs: number[]) {
        // Robust path: clear + re-add. Can be optimized later to mutate buffers.
        this.mesh.clear();
        const n = this.vertices.length;
        const colors = new Array(n).fill(0xffffff);
        const alphas = new Array(n).fill(1);
        this.mesh.addVertices(
            positions,
            uvs,
            this.indices,
            false,
            null as any,
            colors,
            alphas,
        );
    }

    // ------------------------------------------------------------------
    // Keep mesh in sync with the Rect (same pattern as Sprite)
    // ------------------------------------------------------------------

    private syncMesh() {
        this.syncMeshRigid();
    }

    updateHandles() {
        super.updateHandles();
        // In setup mode, if the user scales the rect and we have no weights yet,
        // rebuild the grid so local verts match the new size.
        if (!this.bound) {
            this.buildGrid();
        }
        this.syncMesh();
    }

    setLayer(depth: number) {
        super.setLayer(depth);
        this.mesh.setDepth(depth);
    }

    setVisible(v: boolean) {
        super.setVisible(v);
        this.mesh.setVisible(this.alive && !this.hidden);
    }

    kill() {
        super.kill();
        this.mesh.setVisible(false);
        Mesh.all.delete(this);
    }

    revive() {
        super.revive();
        Mesh.all.add(this);
        this.mesh.setVisible(this.alive && !this.hidden);
    }

    setColor(_color: number) {
        void _color;
    }

    /** called by the bone in pose mode (rigid part of the hierarchy) */
    followBone() {
        super.followBone();
        // Actual vertex skinning is done from the scene tick via skinWithBones()
        // so we have a complete bone map. Until weights exist we stay rigid.
        if (!this.bound) this.syncMesh();
    }

    enterPose() {
        super.enterPose();
        if (!this.bound) this.syncMesh();
    }

    exitPose() {
        super.exitPose();
        this.syncMesh();
    }

    // ------------------------------------------------------------------
    // Undo / redo
    // ------------------------------------------------------------------

    snapshot(): MeshState {
        return {
            ...super.snapshot(),
            texture: this.textureKey,
            cols: this.cols,
            rows: this.rows,
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
            vertices?: MeshVertex[];
            indices?: number[];
        },
    ) {
        super.restore(s);
        this.rect.setFillStyle(0xffffff, 0);
        if (s.texture && s.texture !== this.textureKey) {
            this.textureKey = s.texture;
            this.mesh.setTexture(s.texture);
        }
        if (s.cols !== undefined) this.cols = s.cols;
        if (s.rows !== undefined) this.rows = s.rows;
        if (s.vertices) {
            this.vertices = s.vertices.map((v) => ({
                ...v,
                weights: v.weights.map((w) => ({ ...w })),
            }));
        }
        if (s.indices) this.indices = [...s.indices];
        this.rebuildPhaserMesh();
        this.syncMesh();
    }
}
