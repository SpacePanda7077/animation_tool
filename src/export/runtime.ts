/**
 * Tiny runtime for the exported file. No dependencies (not even Phaser): copy this file and format.ts into your game.
 *
 *   const pose = solve(data, "walk", frameAtTime(data.animations.walk, seconds));
 *   for (const p of pose.parts) sprite[p.name].setPosition(p.x, p.y).setRotation(p.rotation);
 *
 * It follows the editor exactly: same blending, same hierarchy maths.
 */
import type { ExportAnimation, ExportData, ExportKey } from "./format";

export type PoseDelta = { rotation: number; x: number; y: number };

/** Blend two angles along the SHORT way round (never more than half a turn). Same as the editor. */
function lerpAngle(a: number, b: number, t: number): number {
    const TAU = Math.PI * 2;
    let d = (b - a) % TAU;
    if (d > Math.PI) d -= TAU;
    else if (d < -Math.PI) d += TAU;
    return a + d * t;
}

/** the pose offsets of one bone at `frame` (holds the first / last key outside the range). Null without keys. */
export function sampleKeys(
    keys: ExportKey[] | undefined,
    frame: number,
): PoseDelta | null {
    const n = keys?.length ?? 0;
    if (!keys || n === 0) return null;
    if (frame <= keys[0].frame) return keys[0];
    if (frame >= keys[n - 1].frame) return keys[n - 1];
    let i = 0;
    while (keys[i + 1].frame <= frame) i++;
    const a = keys[i];
    const b = keys[i + 1];
    if (a.interp === "step") return a;
    let t = (frame - a.frame) / (b.frame - a.frame);
    if (a.interp === "smooth") t = t * t * (3 - 2 * t);
    return {
        rotation: lerpAngle(a.rotation, b.rotation, t),
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
    };
}

/** which frame to show `seconds` after the animation started (wraps when it loops, holds the last frame when not) */
export function frameAtTime(anim: ExportAnimation, seconds: number): number {
    const f = Math.max(0, seconds) * anim.fps;
    if (anim.end <= 0) return 0;
    return anim.loop ? f % anim.end : Math.min(f, anim.end);
}

export type SolvedBone = {
    /** world position of the bone's pivot */
    x: number;
    y: number;
    /** world rotation */
    rotation: number;
    /** world position of the bone's tip */
    tipX: number;
    tipY: number;
};

export type SolvedVertex = {
    /** world position after skinning */
    x: number;
    y: number;
    u: number;
    v: number;
};

export type SolvedPart = {
    name: string;
    type: "rect" | "sprite" | "mesh";
    /** sprites and meshes: the image file name to draw */
    image?: string;
    x: number;
    y: number;
    rotation: number;
    width: number;
    height: number;
    color: string;
    visible: boolean;
    /** meshes only: skinned vertex positions in world space + UVs */
    vertices?: SolvedVertex[];
    /** meshes only: triangle indices (same as export) */
    indices?: number[];
};

export type SolvedPose = {
    bones: Record<string, SolvedBone>;
    /** same order as data.parts (back to front) */
    parts: SolvedPart[];
};

/**
 * World transforms of every bone and part at `frame`.
 * Pass animationName = null for the setup pose.
 */
export function solve(
    data: ExportData,
    animationName: string | null,
    frame: number,
): SolvedPose {
    const anim = animationName ? data.animations[animationName] : undefined;
    const bones: Record<string, SolvedBone> = {};

    for (const b of data.bones) {
        const d = sampleKeys(anim?.bones[b.name], frame) ?? {
            rotation: 0,
            x: 0,
            y: 0,
        };
        const lx = b.x + d.x;
        const ly = b.y + d.y;
        const lr = b.rotation + d.rotation;
        const p = b.parent ? bones[b.parent] : null;
        let x = lx;
        let y = ly;
        let rotation = lr;
        if (p) {
            const c = Math.cos(p.rotation);
            const s = Math.sin(p.rotation);
            x = p.x + lx * c - ly * s;
            y = p.y + lx * s + ly * c;
            rotation = p.rotation + lr;
        }
        bones[b.name] = {
            x,
            y,
            rotation,
            tipX: x + Math.cos(rotation) * b.length,
            tipY: y + Math.sin(rotation) * b.length,
        };
    }

    const parts = data.parts.map((p): SolvedPart => {
        const base = {
            name: p.name,
            type: p.type,
            image: p.image,
            width: p.width,
            height: p.height,
            color: p.color,
            visible: p.visible,
        };
        const b = p.bone ? bones[p.bone] : null;

        // mesh world center / rotation (from hierarchy parent, same as rect/sprite)
        let mx = p.x;
        let my = p.y;
        let mrot = p.rotation;
        if (b) {
            const c = Math.cos(b.rotation);
            const s = Math.sin(b.rotation);
            mx = b.x + p.x * c - p.y * s;
            my = b.y + p.x * s + p.y * c;
            mrot = b.rotation + p.rotation;
        }

        if (p.type !== "mesh" || !p.vertices || !p.indices) {
            return { ...base, x: mx, y: my, rotation: mrot };
        }

        // Linear Blend Skinning
        // Bind pose = setup pose of the skeleton (keys = 0).
        // Vertex local coords are relative to the mesh center at bind.
        const mcos = Math.cos(mrot);
        const msin = Math.sin(mrot);

        // Build bind bone poses (setup only — keys are already applied in `bones`)
        // For LBS we need the bind (setup) bone world transforms.
        // We reconstruct them the same way solve does, but with zero deltas.
        const bindBones: Record<string, SolvedBone> = {};
        for (const eb of data.bones) {
            const lx = eb.x;
            const ly = eb.y;
            const lr = eb.rotation;
            const parent = eb.parent ? bindBones[eb.parent] : null;
            let x = lx;
            let y = ly;
            let rotation = lr;
            if (parent) {
                const c = Math.cos(parent.rotation);
                const s = Math.sin(parent.rotation);
                x = parent.x + lx * c - ly * s;
                y = parent.y + lx * s + ly * c;
                rotation = parent.rotation + lr;
            }
            bindBones[eb.name] = {
                x,
                y,
                rotation,
                tipX: x + Math.cos(rotation) * eb.length,
                tipY: y + Math.sin(rotation) * eb.length,
            };
        }

        // Mesh bind center (setup placement)
        let bindMx = p.x;
        let bindMy = p.y;
        let bindMrot = p.rotation;
        if (p.bone && bindBones[p.bone]) {
            const bb = bindBones[p.bone];
            const c = Math.cos(bb.rotation);
            const s = Math.sin(bb.rotation);
            bindMx = bb.x + p.x * c - p.y * s;
            bindMy = bb.y + p.x * s + p.y * c;
            bindMrot = bb.rotation + p.rotation;
        }
        const bmcos = Math.cos(bindMrot);
        const bmsin = Math.sin(bindMrot);

        const skinned: SolvedVertex[] = p.vertices.map((v) => {
            // vertex world position at bind
            const bindWx = bindMx + v.x * bmcos - v.y * bmsin;
            const bindWy = bindMy + v.x * bmsin + v.y * bmcos;

            if (!v.weights.length) {
                // rigid under current mesh transform
                return {
                    x: mx + v.x * mcos - v.y * msin,
                    y: my + v.x * msin + v.y * mcos,
                    u: v.u,
                    v: v.v,
                };
            }

            let sx = 0;
            let sy = 0;
            let totalW = 0;
            for (const w of v.weights) {
                if (w.weight <= 0) continue;
                const cur = bones[w.bone];
                const bind = bindBones[w.bone];
                if (!cur || !bind) continue;

                // into bind-bone local
                const dx = bindWx - bind.x;
                const dy = bindWy - bind.y;
                const bca = Math.cos(-bind.rotation);
                const bsa = Math.sin(-bind.rotation);
                const lx = dx * bca - dy * bsa;
                const ly = dx * bsa + dy * bca;

                // out through current bone
                const cca = Math.cos(cur.rotation);
                const csa = Math.sin(cur.rotation);
                const wx = cur.x + lx * cca - ly * csa;
                const wy = cur.y + lx * csa + ly * cca;

                sx += wx * w.weight;
                sy += wy * w.weight;
                totalW += w.weight;
            }

            if (totalW < 1e-6) {
                return {
                    x: mx + v.x * mcos - v.y * msin,
                    y: my + v.x * msin + v.y * mcos,
                    u: v.u,
                    v: v.v,
                };
            }
            return {
                x: sx / totalW,
                y: sy / totalW,
                u: v.u,
                v: v.v,
            };
        });

        return {
            ...base,
            x: mx,
            y: my,
            rotation: mrot,
            vertices: skinned,
            indices: p.indices,
        };
    });

    return { bones, parts };
}
