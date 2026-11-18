import { Rect } from "./objetcs/Rect";
import { Bone } from "./objetcs/Bone";
import { IKConstraint } from "../ik";
import { useObjectsStore, type Obj } from "../../../store/object-store";

/** a bone and every living bone below it */
function boneTree(root: Bone): Bone[] {
    const out: Bone[] = [];
    const walk = (b: Bone) => {
        out.push(b);
        b.children.filter((c) => c.alive).forEach(walk);
    };
    walk(root);
    return out;
}

/**
 * Delete a rect, a sprite or a bone (setup mode only, like every other structure edit).
 *  - rect / sprite: it is taken out of the scene.
 *  - bone: the bone AND the bones below it are taken out. Rects / sprites they controlled
 *    are NOT deleted: they become free and stay where they are.
 *  - IKs that use a deleted bone are removed with it.
 *
 * Objects are killed, not destroyed, so undo (Ctrl+Z) brings the very same instances back
 * (see history.ts). Returns true if something was deleted.
 */
export function deleteObject(obj: Obj): boolean {
    const store = useObjectsStore.getState();
    if (store.mode !== "setup" || !obj.alive) return false;

    const removed = new Set<Obj>();

    if (obj instanceof Rect) {
        obj.detach(); // so the bone doesn't keep a dead rect in its attachments
        obj.kill();
        removed.add(obj);
    } else {
        const bones = boneTree(obj);

        // rects the deleted bones controlled stay in the scene, free
        for (const b of bones) {
            for (const a of [...b.attachments]) {
                if (a instanceof Rect) a.detach();
            }
        }

        // an IK can't work without its bones
        for (const c of [...IKConstraint.all]) {
            if (bones.includes(c.boneA) || bones.includes(c.boneB)) c.destroy();
        }

        // the parent forgets the deleted branch (undo gets it back from the snapshot)
        const parent = obj.parent;
        if (parent) parent.children = parent.children.filter((c) => c !== obj);

        for (const b of bones) {
            b.kill();
            removed.add(b);
        }
        parent?.refresh();
    }

    const st = useObjectsStore.getState();
    st.setObjects(st.objects.filter((o) => !removed.has(o)));
    if (st.selected && removed.has(st.selected)) st.setSelected(null);
    st.refreshLayers(); // re-applies layer depths and bumps the version
    return true;
}
