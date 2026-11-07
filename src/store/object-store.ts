import { create } from "zustand";
import { Rect } from "../game/game-components/objects/objetcs/Rect";
import { Bone, type BoneMode } from "../game/game-components/objects/objetcs/Bone";

export type Obj = Rect | Bone;

/** a root = not inside any hierarchy (a bone without a parent, a rect not attached to a bone) */
export const isRoot = (o: Obj) =>
    o instanceof Bone ? !o.parent : !o.parentBone;

type object_store_type = {
    /**
     * Every object in the scene (all bones too, also extruded ones).
     * The order of the RECTS in here is the layer order: first = front.
     * Bones don't have layers: they are always drawn in front of everything.
     */
    objects: Obj[];
    setObjects: (objects: Obj[]) => void;

    /**
     * put rect `dragged` before/after rect `target` in the layer order.
     * In setup mode it also joins `target`'s hierarchy: under the same bone, or free if target is free.
     */
    reorderRect: (
        dragged: Rect,
        target: Rect,
        position: "before" | "after",
    ) => void;
    /** make `bone` control `rect` (rect stays where it is, then follows the bone) */
    attachRect: (rect: Rect, bone: Bone) => void;
    /** make `bone` a child of `parent` (keeps its place, setup mode only) */
    reparentBone: (bone: Bone, parent: Bone) => void;
    /** take an object out of its hierarchy (it stays where it is) */
    unparent: (obj: Obj) => void;
    /** re-apply layer depths after something changed */
    refreshLayers: () => void;

    /**
     * setup: build the skeleton, objects don't follow the bones.
     * pose: bones can only rotate / move (no length change), objects follow.
     */
    mode: BoneMode;
    setMode: (mode: BoneMode) => void;
    /** clear the pose of every bone (pose mode) */
    resetPose: () => void;

    /** the object shown in the properties panel (for bones: the active bone) */
    selected: Obj | null;
    setSelected: (obj: Obj | null) => void;

    /** bumped whenever a game object's numbers change, so the panel re-reads them */
    version: number;
    bump: () => void;
};

/** Push the layer order into the rects: first rect = highest depth. Bones keep their own top depth. */
const applyLayers = (objects: Obj[]) => {
    const rects = objects.filter((o): o is Rect => o instanceof Rect);
    rects.forEach((r, i) => r.setLayer((rects.length - i) * 10));
};

/** Switch every bone / rect over to `mode`. Order matters: rects bind to the bones' SETUP pose first. */
const applyMode = (objects: Obj[], mode: BoneMode) => {
    const rects = objects.filter((o): o is Rect => o instanceof Rect);
    const bones = objects.filter((o): o is Bone => o instanceof Bone);

    if (mode === "pose") {
        rects.forEach((r) => r.enterPose()); // bones are still in setup here
        Bone.mode = "pose";
    } else {
        Bone.mode = "setup";
    }
    bones.filter((b) => !b.parent).forEach((b) => b.layout()); // re-layout every chain (+ rects follow in pose)
    if (mode === "setup") rects.forEach((r) => r.exitPose());
    rects.forEach((r) => r.setLocked(mode === "pose"));
};

export const useObjectsStore = create<object_store_type>((set, get) => ({
    objects: [],
    setObjects: (objects) => {
        applyLayers(objects);
        set({ objects });
    },

    reorderRect: (dragged, target, position) => {
        if (dragged === target) return;
        if (get().mode === "setup" && dragged.parentBone !== target.parentBone) {
            if (target.parentBone) dragged.attach(target.parentBone);
            else dragged.detach();
        }
        const next = get().objects.filter((o) => o !== dragged);
        let i = next.indexOf(target);
        if (i < 0) return;
        if (position === "after") i++;
        next.splice(i, 0, dragged);
        applyLayers(next);
        set((s) => ({ objects: next, version: s.version + 1 }));
    },

    attachRect: (rect, bone) => {
        if (get().mode !== "setup") return;
        rect.attach(bone);
        const next = [...get().objects];
        applyLayers(next);
        set((s) => ({ objects: next, version: s.version + 1 }));
    },

    reparentBone: (bone, parent) => {
        if (get().mode !== "setup") return;
        if (!bone.parentTo(parent)) return;
        const next = [...get().objects];
        applyLayers(next);
        set((s) => ({ objects: next, version: s.version + 1 }));
    },

    unparent: (obj) => {
        if (get().mode !== "setup") return;
        if (obj instanceof Bone) obj.disconnect();
        else obj.detach();
        const next = [...get().objects];
        applyLayers(next);
        set((s) => ({ objects: next, version: s.version + 1 }));
    },

    refreshLayers: () => {
        const next = [...get().objects];
        applyLayers(next);
        set((s) => ({ objects: next, version: s.version + 1 }));
    },

    mode: "setup",
    setMode: (mode) => {
        if (get().mode === mode) return;
        applyMode(get().objects, mode);
        set((s) => ({ mode, version: s.version + 1 }));
    },
    resetPose: () => {
        const bones = get().objects.filter((o): o is Bone => o instanceof Bone);
        bones.forEach((b) => b.resetPose());
        bones.filter((b) => !b.parent).forEach((b) => b.layout());
        set((s) => ({ version: s.version + 1 }));
    },

    selected: null,
    setSelected: (obj) =>
        set((s) => ({ selected: obj, version: s.version + 1 })),

    version: 0,
    bump: () => set((s) => ({ version: s.version + 1 })),
}));
