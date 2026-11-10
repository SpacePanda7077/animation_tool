import type { Scene } from "phaser";
import { Bone, type BoneState } from "./objects/objetcs/Bone";
import { Rect, type RectState } from "./objects/objetcs/Rect";
import { Sprite, type SpriteState } from "./objects/objetcs/Sprite";
import type { ObjectBuilder } from "./objects/object-builder";
import { useObjectsStore, type Obj } from "../../store/object-store";
import { animation, type AnimSnapshot } from "./animation";
import { IKConstraint, addIKFromSelection, type IKState } from "./ik";
import { history } from "./history";

/**
 * Full project document — bones, parts, animations, IK, embedded sprite images.
 * Written to disk via the File System Access API (Save / Load buttons).
 */
export type ProjectDocument = {
    format: "animation_tool_project";
    version: 1;
    savedAt: string;
    mode: "setup" | "pose";
    /** object ids in store order (layer order for rects) */
    order: string[];
    bones: BoneState[];
    /** rectangles and sprites (sprites include a texture field + optional dataURL) */
    parts: Array<
        | (RectState & { kind: "rect"; width: number; height: number })
        | (SpriteState & {
              kind: "sprite";
              width: number;
              height: number;
              dataURL?: string;
          })
    >;
    anim: AnimSnapshot;
    ik: IKState[];
    /** embedded textures: Phaser key -> data URL */
    textures: Record<string, string>;
};

let builderRef: ObjectBuilder | null = null;
let sceneRef: Scene | null = null;

/** Remembered file handle so Save overwrites the same file next time. */
let fileHandle: FileSystemFileHandle | null = null;

// ---------- build ----------

function textureDataURL(scene: Scene, key: string): string | undefined {
    try {
        if (!scene.textures.exists(key)) return undefined;
        const src = scene.textures.get(key).getSourceImage() as
            | HTMLImageElement
            | HTMLCanvasElement
            | undefined;
        if (!src) return undefined;
        if (src instanceof HTMLCanvasElement) {
            return src.toDataURL("image/png");
        }
        if (src instanceof HTMLImageElement) {
            const c = document.createElement("canvas");
            c.width = src.naturalWidth || src.width;
            c.height = src.naturalHeight || src.height;
            const ctx = c.getContext("2d");
            if (!ctx) return undefined;
            ctx.drawImage(src, 0, 0);
            return c.toDataURL("image/png");
        }
    } catch {
        /* ignore */
    }
    return undefined;
}

export function buildProject(
    scene: Scene,
    builder: ObjectBuilder,
): ProjectDocument {
    const s = useObjectsStore.getState();
    const textures: Record<string, string> = {};

    const parts: ProjectDocument["parts"] = [];
    for (const o of s.objects) {
        if (o instanceof Sprite) {
            const width = o.rect.width;
            const height = o.rect.height;
            const snap = o.snapshot();
            const dataURL = textureDataURL(scene, o.textureKey);
            if (dataURL) textures[o.textureKey] = dataURL;
            parts.push({ kind: "sprite", ...snap, width, height, dataURL });
        } else if (o instanceof Rect) {
            const width = o.rect.width;
            const height = o.rect.height;
            parts.push({ kind: "rect", ...o.snapshot(), width, height });
        }
    }

    return {
        format: "animation_tool_project",
        version: 1,
        savedAt: new Date().toISOString(),
        mode: s.mode,
        order: s.objects.map((o) => o.id),
        bones: s.objects
            .filter((o): o is Bone => o instanceof Bone)
            .map((b) => b.snapshot()),
        parts,
        anim: animation.snapshot(),
        ik: IKConstraint.all.map((c) => c.snapshot()),
        textures,
    };
}

// ---------- apply / load ----------

/** Set a stable saved id on an object. Does not touch the registry. */
function setObjectId(obj: { id: string }, id: string) {
    try {
        Object.defineProperty(obj, "id", {
            value: id,
            writable: true,
            configurable: true,
            enumerable: true,
        });
    } catch {
        (obj as { id: string }).id = id;
    }
}

/**
 * Re-key many objects at once so auto-ids never clobber each other in the registry.
 * Example bug this avoids: objA forced to "rect-2", then objB is created with auto-id
 * "rect-2" and overwrites objA in the map.
 */
function rekeyAll(
    pairs: { obj: { id: string }; id: string }[],
    registry: Map<string, Obj>,
) {
    // 1. Drop every one of these objects from the registry (under any key)
    for (const { obj } of pairs) {
        for (const [k, v] of [...registry.entries()]) {
            if (v === obj) registry.delete(k);
        }
    }
    // 2. Assign saved ids and register cleanly
    for (const { obj, id } of pairs) {
        setObjectId(obj, id);
        registry.set(id, obj as Obj);
    }
}

async function ensureTexture(
    scene: Scene,
    key: string,
    dataURL: string | undefined,
    textures: Record<string, string>,
): Promise<boolean> {
    if (scene.textures.exists(key)) return true;
    const url = dataURL || textures[key];
    if (!url) return false;
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                if (!scene.textures.exists(key)) {
                    scene.textures.addImage(key, img);
                }
                resolve(true);
            } catch {
                resolve(false);
            }
        };
        img.onerror = () => resolve(false);
        img.src = url;
    });
}

/**
 * Wipe the current scene and rebuild it from a project document.
 */
export async function applyProject(
    scene: Scene,
    builder: ObjectBuilder,
    doc: ProjectDocument,
): Promise<{ ok: boolean; warnings: string[] }> {
    const warnings: string[] = [];
    if (doc.format !== "animation_tool_project") {
        return { ok: false, warnings: ["Not an animation_tool project file."] };
    }

    history.hold();
    try {
        IKConstraint.destroyAll();

        // Destroy everything from the previous scene and start with an empty registry
        for (const [, o] of builder.registry) {
            o.kill();
        }
        builder.registry.clear();
        Bone.selection.clear();
        Bone.active = null;
        useObjectsStore.setState({
            objects: [],
            selected: null,
            mode: "setup",
        });
        useObjectsStore.getState().setMode("setup");

        for (const p of doc.parts) {
            if (p.kind === "sprite") {
                const ok = await ensureTexture(
                    scene,
                    p.texture,
                    p.dataURL,
                    doc.textures || {},
                );
                if (!ok) {
                    warnings.push(
                        `Missing texture “${p.texture}” for sprite “${p.name}” — placed as a grey rectangle.`,
                    );
                }
            }
        }

        const reg = builder.registry;

        // Create bones with temporary auto-ids, then re-key all at once
        const bonePairs: { obj: Bone; id: string }[] = [];
        for (const bs of doc.bones) {
            const created = new Bone(
                scene,
                bs.baseX,
                bs.baseY,
                bs.length,
                null,
            );
            bonePairs.push({ obj: created, id: bs.id });
        }
        rekeyAll(bonePairs, reg);

        // Create parts with temporary auto-ids, then re-key all at once
        // (avoids auto-id "rect-2" overwriting a previous object forced to "rect-2")
        const partPairs: { obj: Rect; id: string }[] = [];
        for (const p of doc.parts) {
            const w = Math.max(10, p.width || 100);
            const h = Math.max(10, p.height || 100);
            let part: Rect;
            if (p.kind === "sprite" && scene.textures.exists(p.texture)) {
                part = builder.sprite({
                    x: p.x,
                    y: p.y,
                    width: w,
                    height: h,
                    texture: p.texture,
                    name: p.name,
                });
            } else {
                part = builder.rect({
                    x: p.x,
                    y: p.y,
                    width: w,
                    height: h,
                    color: p.kind === "rect" ? p.color : 0x888888,
                });
                if (p.kind === "sprite") {
                    warnings.push(
                        `Sprite “${p.name}” image missing — grey rect used.`,
                    );
                }
            }
            partPairs.push({ obj: part, id: p.id });
        }
        rekeyAll(partPairs, reg);

        const createdPartIds = partPairs.map((p) => p.obj.id);

        const bone = (id: string) => {
            const o = reg.get(id);
            return o instanceof Bone ? o : undefined;
        };
        const bones: Bone[] = [];
        for (const bs of doc.bones) {
            const b = bone(bs.id);
            if (!b) {
                warnings.push(`Bone “${bs.id}” missing after create.`);
                continue;
            }
            b.restore(bs, bone);
            b.attachments = [];
            bones.push(b);
        }

        for (const p of doc.parts) {
            const r = reg.get(p.id);
            if (!(r instanceof Rect)) {
                warnings.push(
                    `Part “${p.name}” (${p.id}) missing after create.`,
                );
                continue;
            }
            r.restore(p);
            const pb = p.parentBone ? bone(p.parentBone) : undefined;
            r.parentBone = pb ?? null;
            pb?.addAttachment(r);
        }

        // Kill anything that isn't in the project (stray auto-created objects)
        const want = new Set<string>([
            ...doc.bones.map((b) => b.id),
            ...doc.parts.map((p) => p.id),
        ]);
        for (const [id, o] of [...reg.entries()]) {
            if (!want.has(id)) {
                o.kill();
                reg.delete(id);
            }
        }

        bones.filter((b) => !b.parent).forEach((b) => b.layout());
        bones.forEach((b) => b.refresh());

        // Build the store list from the file order so the inspector shows every object
        const order: Obj[] = [];
        const seen = new Set<string>();
        for (const id of doc.order) {
            const o = reg.get(id);
            if (o && o.alive && !seen.has(id)) {
                order.push(o);
                seen.add(id);
            }
        }
        // Anything in the file but missing from order
        for (const id of want) {
            if (seen.has(id)) continue;
            const o = reg.get(id);
            if (o && o.alive) {
                order.push(o);
                seen.add(id);
            }
        }
        useObjectsStore.getState().setObjects(order);

        console.info(
            `[project] loaded ${doc.parts.length} part(s), ${doc.bones.length} bone(s); store has ${order.length} object(s)`,
            { partIds: createdPartIds, orderIds: order.map((o) => o.id) },
        );

        animation.load(doc.anim);

        if (doc.mode === "pose") {
            useObjectsStore.getState().setMode("pose");
        } else {
            useObjectsStore.getState().setMode("setup");
        }

        for (const ik of doc.ik || []) {
            const a = bone(ik.boneAId);
            const b = bone(ik.boneBId);
            if (!a || !b) {
                warnings.push(
                    `Could not restore IK “${ik.name}” (bones missing).`,
                );
                continue;
            }
            Bone.setSelection([a, b]);
            const c = addIKFromSelection(scene);
            if (!c) {
                warnings.push(`Could not restore IK “${ik.name}”.`);
                continue;
            }
            c.name = ik.name;
            c.targetX = ik.targetX;
            c.targetY = ik.targetY;
            c.poleX = ik.poleX;
            c.poleY = ik.poleY;
            c.enabled = ik.enabled;
            if (doc.mode === "pose") c.solve();
            c.draw();
        }
        Bone.setSelection([]);

        useObjectsStore.getState().bump();
    } finally {
        history.release();
    }

    return { ok: true, warnings };
}

// ---------- scene refs + file save / load ----------

/** Call once from the Game scene so Save / Load know which scene to use. */
export function initProjectPersistence(scene: Scene, builder: ObjectBuilder) {
    sceneRef = scene;
    builderRef = builder;
    fileHandle = null;

    scene.events.once("shutdown", () => {
        sceneRef = null;
        builderRef = null;
        fileHandle = null;
    });
}

function supportsFilePicker(): boolean {
    return typeof window !== "undefined" && "showSaveFilePicker" in window;
}

/**
 * Save project to disk.
 * - First time: opens a "Save As" dialog so you pick the file in Explorer.
 * - Next times: overwrites that same file (no dialog).
 * Returns a short status message for the UI.
 */
export async function uiSaveProject(): Promise<string> {
    if (!sceneRef || !builderRef) return "Scene not ready";

    const doc = buildProject(sceneRef, builderRef);
    const json = JSON.stringify(doc, null, 2);

    if (!supportsFilePicker()) {
        // Fallback for browsers without the File System Access API
        const url = URL.createObjectURL(
            new Blob([json], { type: "application/json" }),
        );
        const a = document.createElement("a");
        a.href = url;
        a.download = "project.json";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return "Downloaded (browser has no file picker)";
    }

    try {
        if (!fileHandle) {
            fileHandle = await window.showSaveFilePicker({
                suggestedName: "project.json",
                types: [
                    {
                        description: "Animation Tool project",
                        accept: { "application/json": [".json"] },
                    },
                ],
            });
        }

        const writable = await fileHandle.createWritable();
        await writable.write(json);
        await writable.close();
        return fileHandle.name ? `Saved ${fileHandle.name}` : "Saved";
    } catch (e) {
        const err = e as { name?: string; message?: string };
        if (err?.name === "AbortError") return "Cancelled";
        // Permission may have been lost — clear handle so next save asks again
        fileHandle = null;
        console.error("[project] save failed", e);
        return "Save failed";
    }
}

/** Force a new "Save As" dialog (forget the previous file). */
export async function uiSaveProjectAs(): Promise<string> {
    fileHandle = null;
    return uiSaveProject();
}

/**
 * Load a project from disk (open-file dialog).
 * Also remembers the file so the next Save overwrites it.
 */
export async function uiLoadProject(): Promise<{
    ok: boolean;
    message: string;
    warnings: string[];
}> {
    if (!sceneRef || !builderRef) {
        return { ok: false, message: "Scene not ready", warnings: [] };
    }

    try {
        let doc: ProjectDocument;

        if ("showOpenFilePicker" in window) {
            const [handle] = await window.showOpenFilePicker({
                types: [
                    {
                        description: "Animation Tool project",
                        accept: { "application/json": [".json"] },
                    },
                ],
                multiple: false,
            });
            const file = await handle.getFile();
            const text = await file.text();
            doc = JSON.parse(text) as ProjectDocument;
            // Remember so Save overwrites this file
            fileHandle = handle;
        } else {
            return {
                ok: false,
                message: "Open file picker not supported",
                warnings: [],
            };
        }

        if (doc.format !== "animation_tool_project") {
            return {
                ok: false,
                message: "Not a project file",
                warnings: [],
            };
        }

        const result = await applyProject(sceneRef, builderRef, doc);
        return {
            ok: result.ok,
            message: result.ok ? "Loaded" : "Load failed",
            warnings: result.warnings,
        };
    } catch (e) {
        const err = e as { name?: string };
        if (err?.name === "AbortError") {
            return { ok: false, message: "Cancelled", warnings: [] };
        }
        console.error("[project] load failed", e);
        return { ok: false, message: "Load failed", warnings: [] };
    }
}

/** Load from a File (e.g. hidden <input type="file"> fallback). */
export async function uiLoadProjectFile(file: File): Promise<{
    ok: boolean;
    message: string;
    warnings: string[];
}> {
    if (!sceneRef || !builderRef) {
        return { ok: false, message: "Scene not ready", warnings: [] };
    }
    try {
        const text = await file.text();
        const doc = JSON.parse(text) as ProjectDocument;
        if (doc.format !== "animation_tool_project") {
            return {
                ok: false,
                message: "Not a project file",
                warnings: [],
            };
        }
        // Can't get a FileSystemFileHandle from <input>, so next Save will ask again
        fileHandle = null;
        const result = await applyProject(sceneRef, builderRef, doc);
        return {
            ok: result.ok,
            message: result.ok ? "Loaded" : "Load failed",
            warnings: result.warnings,
        };
    } catch (e) {
        console.error(e);
        return { ok: false, message: "Load failed", warnings: [] };
    }
}
