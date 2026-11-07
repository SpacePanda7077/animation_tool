import { create } from "zustand";
import { Rect } from "../game/game-components/objects/objetcs/Rect";
import { Bone } from "../game/game-components/objects/objetcs/Bone";

export type Obj = Rect | Bone;

/** a root = not inside any hierarchy (a bone without a parent, a rect not attached to a bone) */
export const isRoot = (o: Obj) =>
    o.type === "Bone" ? !o.parent : !o.parentBone;

type object_store_type = {
    /**
     * Every object in the scene (all bones too, also extruded ones).
     * The order of the RECTS in here is the layer order: first = front.
     * Bones don't have layers: they are always drawn in front of everything.
     */
    objects: Obj[];
    setObjects: (objects: Obj[]) => void;

    /** put rect `dragged` before/after rect `target` in the layer order (hierarchy is untouched) */
    reorderRect: (
        dragged: Rect,
        target: Rect,
        position: "before" | "after",
    ) => void;
    /** make `bone` control `rect` (rect stays where it is, then follows the bone) */
    attachRect: (rect: Rect, bone: Bone) => void;
    /** take an object out of its hierarchy (it stays where it is) */
    unparent: (obj: Obj) => void;
    /** re-apply layer depths after something changed */
    refreshLayers: () => void;

    /** the object shown in the properties panel (for bones: the active bone) */
    selected: Obj | null;
    setSelected: (obj: Obj | null) => void;

    /** bumped whenever a game object's numbers change, so the panel re-reads them */
    version: number;
    bump: () => void;
};

/** Push the layer order into the rects: first rect = highest depth. Bones keep their own top depth. */
const applyLayers = (objects: Obj[]) => {
    const rects = objects.filter((o): o is Rect => o.type === "Rectangle");
    rects.forEach((r, i) => r.setLayer((rects.length - i) * 10));
};

export const useObjectsStore = create<object_store_type>((set, get) => ({
    objects: [],
    setObjects: (objects) => {
        applyLayers(objects);
        set({ objects });
    },

    reorderRect: (dragged, target, position) => {
        if (dragged === target) return;
        const next = get().objects.filter((o) => o !== dragged);
        let i = next.indexOf(target);
        if (i < 0) return;
        if (position === "after") i++;
        next.splice(i, 0, dragged);
        applyLayers(next);
        set((s) => ({ objects: next, version: s.version + 1 }));
    },

    attachRect: (rect, bone) => {
        rect.attach(bone);
        const next = [...get().objects];
        applyLayers(next);
        set((s) => ({ objects: next, version: s.version + 1 }));
    },

    unparent: (obj) => {
        if (obj.type === "Bone") obj.disconnect();
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

    selected: null,
    setSelected: (obj) =>
        set((s) => ({ selected: obj, version: s.version + 1 })),

    version: 0,
    bump: () => set((s) => ({ version: s.version + 1 })),
}));
