import { Rect } from "./objetcs/Rect";
import { Sprite } from "./objetcs/Sprite";
import { Bone } from "./objetcs/Bone";
import type { ObjectBuilder } from "./object-builder";
import { useObjectsStore } from "../../../store/object-store";

/** how far (world units) a copy is shifted so it doesn't hide the original */
const SHIFT = 20;

/** Copy one rect or sprite: same look, shifted, right in front of the original and in the same bone group. */
function duplicateRect(builder: ObjectBuilder, src: Rect): Rect {
    const s = src.snapshot();
    const base = {
        x: s.x,
        y: s.y,
        width: src.rect.width,
        height: src.rect.height,
    };
    const copy =
        src instanceof Sprite
            ? builder.sprite({ ...base, texture: src.textureKey })
            : builder.rect({ ...base, color: s.color });
    copy.restore({
        ...s,
        name: `${src.name} copy`,
        x: s.x + SHIFT,
        y: s.y + SHIFT,
    });
    // joins the original's bone (or stays free) and sits just in front of it
    useObjectsStore.getState().reorderRect(copy, src, "before");
    return copy;
}

/** Copy a bone and everything below it (child bones, and the rects they control). */
function duplicateBoneTree(builder: ObjectBuilder, root: Bone): Bone {
    const map = new Map<Bone, Bone>();

    const copyBone = (src: Bone, parent: Bone | null): Bone => {
        const nb = new Bone(
            builder.scene,
            src.baseX,
            src.baseY,
            src.length,
            parent,
        );
        nb.name = `${src.name} copy`;
        nb.connected = src.connected;
        nb.offX = src.offX;
        nb.offY = src.offY;
        nb.rel = src.rel;
        nb.poseRel = src.poseRel;
        nb.poseX = src.poseX;
        nb.poseY = src.poseY;
        if (src.hidden) nb.setVisible(false);
        map.set(src, nb);
        for (const c of src.children) copyBone(c, nb);
        return nb;
    };

    const top = copyBone(root, root.parent);

    // shift the whole copy by SHIFT, keeping its world angle
    const p = root.parent;
    if (p) {
        const pa = p.angle;
        const dx = root.pivot.x + SHIFT - p.pivot.x;
        const dy = root.pivot.y + SHIFT - p.pivot.y;
        top.connected = false; // a connected bone can't be shifted off its parent's tip
        top.offX = dx * Math.cos(pa) + dy * Math.sin(pa);
        top.offY = -dx * Math.sin(pa) + dy * Math.cos(pa);
        top.angle = root.angle;
    } else {
        top.baseX = root.baseX + SHIFT;
        top.baseY = root.baseY + SHIFT;
    }
    top.layout();

    // the rects the original bones control get copies controlled by the new bones
    for (const [srcBone, newBone] of map) {
        for (const a of [...srcBone.attachments]) {
            if (a instanceof Rect) duplicateRect(builder, a).attach(newBone);
        }
    }
    return top;
}

/**
 * Duplicate what is selected (setup mode only): a rect, or the selected bones with all their children + rects.
 * The copies become the selection. Returns them.
 */
export function duplicateSelection(builder: ObjectBuilder) {
    const state = useObjectsStore.getState();
    if (state.mode !== "setup" || !state.selected) return [];

    if (state.selected instanceof Rect) {
        const copy = duplicateRect(builder, state.selected);
        copy.select();
        return [copy];
    }

    // a selected bone whose ancestor is selected too is already covered by the ancestor's copy
    const picked = [...Bone.selection];
    const roots = picked.filter(
        (b) => !picked.some((o) => o !== b && b.isDescendantOf(o)),
    );
    const copies = roots.map((b) => duplicateBoneTree(builder, b));
    if (copies.length) Bone.setSelection(copies);
    state.bump();
    return copies;
}
