import { Bone } from "../game/game-components/objects/objetcs/Bone";
import { Rect } from "../game/game-components/objects/objetcs/Rect";
import { useObjectsStore } from "../store/object-store";
import {
    sample,
    useAnimationStore,
    type AnimData,
} from "../game/game-components/animation";
import type {
    ExportAnimation,
    ExportBone,
    ExportData,
    ExportKey,
    ExportPart,
} from "./format";

export type ExportOptions = {
    /**
     * When provided, only this animation is exported (legacy single-anim mode).
     * When omitted, every named animation is exported.
     */
    name?: string;
    /** write a key on every frame (exact at whole frames) so a runtime needs no smooth / step blending */
    bake: boolean;
};

export type ExportResult = {
    data: ExportData;
    /** the file as text */
    json: string;
    /** things worth knowing before you use the file (renamed duplicates, empty animation, ...) */
    warnings: string[];
    stats: {
        bones: number;
        parts: number;
        keys: number;
        seconds: number;
        animations: number;
    };
};

/** round away float noise (1e-6 of a pixel / radian) */
const round = (_: string, v: unknown) =>
    typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v;

const hex = (n: number) => `#${(n & 0xffffff).toString(16).padStart(6, "0")}`;

/** "Arm" -> "Arm" the first time, then "Arm 2", "Arm 3" ... */
function uniqueNames(names: string[], kind: string, warnings: string[]) {
    const used = new Set<string>();
    return names.map((name) => {
        let out = name;
        for (let i = 2; used.has(out); i++) out = `${name} ${i}`;
        used.add(out);
        if (out !== name)
            warnings.push(
                `Two ${kind} were called "${name}"; the second one is exported as "${out}".`,
            );
        return out;
    });
}

function buildOneAnimation(
    anim: AnimData,
    ordered: Bone[],
    boneNames: Map<Bone, string>,
    byId: Map<string, Bone>,
    bake: boolean,
    warnings: string[],
): { animation: ExportAnimation; keyCount: number } {
    const animBones: Record<string, ExportKey[]> = {};
    let keyCount = 0;
    for (const [boneId, keys] of Object.entries(anim.tracks)) {
        const bone = byId.get(boneId);
        if (!bone || keys.length === 0) continue;
        let out: ExportKey[];
        if (bake) {
            out = [];
            for (let f = 0; f <= anim.end; f++) {
                const v = sample(keys, f)!;
                out.push({
                    frame: f,
                    time: f / anim.fps,
                    rotation: v.rot,
                    x: v.x,
                    y: v.y,
                    interp: "linear",
                });
            }
        } else {
            out = keys.map((k) => ({
                frame: k.frame,
                time: k.frame / anim.fps,
                rotation: k.rot,
                x: k.x,
                y: k.y,
                interp: k.interp,
            }));
        }
        // make the rotations continuous (each key within half a turn of the one before), so a game that
        // blends them with plain linear interpolation gets the same short-way-round motion as the editor
        let prev: number | null = null;
        for (const k of out) {
            if (prev !== null) {
                const TAU = Math.PI * 2;
                let d = (k.rotation - prev) % TAU;
                if (d > Math.PI) d -= TAU;
                else if (d < -Math.PI) d += TAU;
                k.rotation = prev + d;
            }
            prev = k.rotation;
        }
        animBones[boneNames.get(bone)!] = out;
        keyCount += out.length;
    }
    if (Object.keys(animBones).length === 0)
        warnings.push(
            "An animation has no keyframes yet, so only the skeleton is exported for it.",
        );

    return {
        animation: {
            fps: anim.fps,
            end: anim.end,
            duration: anim.end / anim.fps,
            loop: anim.loop,
            baked: bake,
            bones: animBones,
        },
        keyCount,
    };
}

/**
 * Read the scene + animations and turn them into the export format.
 * Always exports the SETUP pose plus the keyframes, whichever mode you are in and wherever the playhead is.
 * By default exports every named animation. Pass `name` to export only one.
 */
export function buildExport(options: ExportOptions): ExportResult {
    const warnings: string[] = [];
    const objects = useObjectsStore.getState().objects;
    const store = useAnimationStore.getState();

    // Make sure the current working state is saved into the map
    const currentData: AnimData = {
        fps: store.fps,
        end: store.end,
        loop: store.loop,
        tracks: store.tracks,
    };
    const allAnims = {
        ...store.animations,
        [store.currentName]: currentData,
    };

    // ---------- bones (parents first) ----------
    const allBones = objects.filter(
        (o): o is Bone => o instanceof Bone && o.alive,
    );
    const ordered: Bone[] = [];
    const walk = (b: Bone) => {
        ordered.push(b);
        b.children.filter((c) => c.alive).forEach(walk);
    };
    allBones.filter((b) => !b.parent).forEach(walk);

    const boneNames = new Map<Bone, string>();
    uniqueNames(
        ordered.map((b) => b.name),
        "bones",
        warnings,
    ).forEach((n, i) => boneNames.set(ordered[i], n));

    // setup world transform of every bone, from the stored numbers (not from the Phaser objects, which may be posed)
    const world = new Map<Bone, { x: number; y: number; rot: number }>();
    const bones: ExportBone[] = ordered.map((b) => {
        const p = b.parent;
        const connected = !!p && b.connected;
        const x = !p ? b.baseX : connected ? p.length : b.offX;
        const y = !p ? b.baseY : connected ? 0 : b.offY;
        const pw = p ? world.get(p)! : null;
        if (pw) {
            const c = Math.cos(pw.rot);
            const s = Math.sin(pw.rot);
            world.set(b, {
                x: pw.x + x * c - y * s,
                y: pw.y + x * s + y * c,
                rot: pw.rot + b.rel,
            });
        } else {
            world.set(b, { x, y, rot: b.rel });
        }
        return {
            name: boneNames.get(b)!,
            parent: p ? boneNames.get(p)! : null,
            length: b.length,
            x,
            y,
            rotation: b.rel,
            connected,
        };
    });

    // ---------- parts (the store lists the front rect first, the file lists the back one first) ----------
    const rects = objects
        .filter((o): o is Rect => o instanceof Rect && o.alive)
        .reverse();
    const partNames = uniqueNames(
        rects.map((r) => r.name),
        "rectangles",
        warnings,
    );
    const parts: ExportPart[] = rects.map((r, i) => {
        const s = r.snapshot(); // setup placement, also while posing
        const width = r.rect.width * s.scaleX;
        const height = r.rect.height * s.scaleY;
        const b = r.parentBone && r.parentBone.alive ? r.parentBone : null;
        let x = s.x;
        let y = s.y;
        let rotation = s.rot;
        if (b) {
            const w = world.get(b)!;
            const dx = s.x - w.x;
            const dy = s.y - w.y;
            const c = Math.cos(w.rot);
            const sn = Math.sin(w.rot);
            x = dx * c + dy * sn;
            y = -dx * sn + dy * c;
            rotation = s.rot - w.rot;
        }
        return {
            name: partNames[i],
            type: "rect",
            bone: b ? boneNames.get(b)! : null,
            x,
            y,
            rotation,
            width,
            height,
            color: hex(s.color),
            visible: !r.hidden,
        };
    });

    // ---------- animations ----------
    const byId = new Map<string, Bone>();
    for (const b of ordered) byId.set(b.id, b);

    const namesToExport = options.name
        ? [options.name.trim() || store.currentName]
        : Object.keys(allAnims);

    const animations: Record<string, ExportAnimation> = {};
    let totalKeys = 0;
    let totalSeconds = 0;

    for (const animName of namesToExport) {
        const animData = allAnims[animName] ?? currentData;
        const { animation, keyCount } = buildOneAnimation(
            animData,
            ordered,
            boneNames,
            byId,
            options.bake,
            warnings,
        );
        animations[animName] = animation;
        totalKeys += keyCount;
        totalSeconds += animation.duration;
    }

    if (bones.length === 0) warnings.push("There are no bones in the scene.");

    const data: ExportData = {
        format: "animation_tool",
        version: 1,
        units: { angle: "radians", position: "pixels", time: "frames" },
        bones,
        parts,
        animations,
    };

    return {
        data,
        json: JSON.stringify(data, round, 2),
        warnings,
        stats: {
            bones: bones.length,
            parts: parts.length,
            keys: totalKeys,
            seconds: totalSeconds,
            animations: Object.keys(animations).length,
        },
    };
}

/** a safe file name for the animation / project */
export const fileNameFor = (name: string) =>
    `${name.trim().replace(/[^\w\- ]+/g, "_") || "animation"}.json`;

/** save text as a file through the browser */
export function downloadText(text: string, fileName: string) {
    const url = URL.createObjectURL(
        new Blob([text], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
