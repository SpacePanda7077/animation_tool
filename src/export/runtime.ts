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

/** the pose offsets of one bone at `frame` (holds the first / last key outside the range). Null without keys. */
export function sampleKeys(keys: ExportKey[] | undefined, frame: number): PoseDelta | null {
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
        rotation: a.rotation + (b.rotation - a.rotation) * t,
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

export type SolvedPart = {
    name: string;
    x: number;
    y: number;
    rotation: number;
    width: number;
    height: number;
    color: string;
    visible: boolean;
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
export function solve(data: ExportData, animationName: string | null, frame: number): SolvedPose {
    const anim = animationName ? data.animations[animationName] : undefined;
    const bones: Record<string, SolvedBone> = {};

    for (const b of data.bones) {
        const d = sampleKeys(anim?.bones[b.name], frame) ?? { rotation: 0, x: 0, y: 0 };
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
        const base = { name: p.name, width: p.width, height: p.height, color: p.color, visible: p.visible };
        const b = p.bone ? bones[p.bone] : null;
        if (!b) return { ...base, x: p.x, y: p.y, rotation: p.rotation };
        const c = Math.cos(b.rotation);
        const s = Math.sin(b.rotation);
        return {
            ...base,
            x: b.x + p.x * c - p.y * s,
            y: b.y + p.x * s + p.y * c,
            rotation: b.rotation + p.rotation,
        };
    });

    return { bones, parts };
}
