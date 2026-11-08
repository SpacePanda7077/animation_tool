import { create } from "zustand";
import type { Scene } from "phaser";
import { Bone, type BoneState } from "./objects/objetcs/Bone";
import { Rect, type RectState } from "./objects/objetcs/Rect";
import type { ObjectBuilder } from "./objects/object-builder";
import { useObjectsStore, type Obj } from "../../store/object-store";
import type { BoneMode } from "./objects/objetcs/Bone";
import { animation, type AnimData } from "./animation";

/** the whole document as plain data */
type Snapshot = {
    mode: BoneMode;
    /** ids in the store's order (= layer order of the rects) */
    order: string[];
    bones: BoneState[];
    rects: RectState[];
    /** keyframes, fps, length (the playhead is not part of it) */
    anim: AnimData;
};

/** for the undo / redo buttons */
export const useHistoryStore = create<{ canUndo: boolean; canRedo: boolean }>(
    () => ({ canUndo: false, canRedo: false }),
);

const MAX_STEPS = 100;
/** a change becomes an undo step once nothing has changed for this long (and no mouse button is held) */
const SETTLE_MS = 250;

/**
 * Undo / redo by snapshots.
 *  - Anything that changes the store (every edit bumps it) schedules a checkpoint; once things settle,
 *    the new state is compared to the last one and pushed as a step if it differs. So a whole drag = one step.
 *  - Undo / redo put a snapshot back onto the existing objects. Objects that didn't exist then are hidden
 *    (kill), objects that did are brought back (revive), so redo gets the very same instances.
 *  - Selection is not part of history.
 */
class History {
    private scene: Scene | null = null;
    private builder: ObjectBuilder | null = null;
    private undoStack: Snapshot[] = [];
    private redoStack: Snapshot[] = [];
    private head: Snapshot | null = null;
    private headKey = "";
    private timer: ReturnType<typeof setTimeout> | null = null;
    private restoring = false;
    /** > 0 while something changes the document without wanting undo steps (scrubbing, playback) */
    private holds = 0;
    private unsubscribe: (() => void) | null = null;

    private onKey = (e: KeyboardEvent) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        const key = e.key.toLowerCase();
        if (key === "z") {
            e.preventDefault();
            if (e.shiftKey) this.redo();
            else this.undo();
        } else if (key === "y") {
            e.preventDefault();
            this.redo();
        }
    };

    init(scene: Scene, builder: ObjectBuilder) {
        this.destroy();
        this.scene = scene;
        this.builder = builder;
        this.head = this.snapshot();
        this.headKey = JSON.stringify(this.head);
        this.unsubscribe = useObjectsStore.subscribe(() => this.schedule());
        scene.input.keyboard?.on("keydown", this.onKey);
        this.updateFlags();
    }

    destroy() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.scene?.input?.keyboard?.off("keydown", this.onKey);
        this.scene = null;
        this.builder = null;
        this.undoStack = [];
        this.redoStack = [];
        this.head = null;
        this.headKey = "";
        this.holds = 0;
        this.updateFlags();
    }

    // ---------- recording ----------

    private schedule() {
        if (this.restoring || this.holds > 0 || !this.head) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            // still dragging? wait for the mouse button to go up
            if (this.scene?.input.activePointer.isDown) this.schedule();
            else this.checkpoint();
        }, SETTLE_MS);
    }

    /** Record the current state as a step if it differs from the last recorded one. */
    checkpoint() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (this.restoring || !this.head) return;
        const cur = this.snapshot();
        const key = JSON.stringify(cur);
        if (key === this.headKey) return;
        this.undoStack.push(this.head);
        if (this.undoStack.length > MAX_STEPS) this.undoStack.shift();
        this.head = cur;
        this.headKey = key;
        this.redoStack = []; // a new edit ends the redo branch
        this.updateFlags();
    }

    // ---------- changes that are not undo steps (frame scrubbing, playback) ----------

    /** Stop recording. Whatever was edited before is recorded first, so nothing is lost. */
    hold() {
        if (this.holds === 0) this.checkpoint();
        this.holds++;
    }

    /** Resume recording; the current state becomes the new baseline (the changes made while held are not a step). */
    release() {
        this.holds = Math.max(0, this.holds - 1);
        if (this.holds === 0 && !this.restoring && this.head) {
            this.head = this.snapshot();
            this.headKey = JSON.stringify(this.head);
        }
    }

    silent<T>(fn: () => T): T {
        this.hold();
        try {
            return fn();
        } finally {
            this.release();
        }
    }

    private updateFlags() {
        useHistoryStore.setState({
            canUndo: this.undoStack.length > 0,
            canRedo: this.redoStack.length > 0,
        });
    }

    // ---------- undo / redo ----------

    undo() {
        this.checkpoint(); // don't lose an edit that hasn't settled yet
        const prev = this.undoStack.pop();
        if (!prev || !this.head) return;
        this.redoStack.push(this.head);
        // DEBUG: remove once the "undo wipes everything" bug is understood
        console.log(
            `[history] undo: going back to a state with ${prev.bones.length} bones, ${prev.rects.length} rects, mode ${prev.mode}; steps left ${this.undoStack.length}; holds ${this.holds}`,
        );
        this.apply(prev);
    }

    redo() {
        this.checkpoint();
        const next = this.redoStack.pop();
        if (!next || !this.head) return;
        this.undoStack.push(this.head);
        this.apply(next);
    }

    private apply(snap: Snapshot) {
        this.restoring = true;
        try {
            this.restore(snap);
        } catch (err) {
            console.error("[history] restore failed", err);
        } finally {
            this.restoring = false;
        }
        // re-read the live state so later comparisons are apples to apples
        this.head = this.snapshot();
        this.headKey = JSON.stringify(this.head);
        this.updateFlags();
    }

    // ---------- snapshot / restore ----------

    private snapshot(): Snapshot {
        const s = useObjectsStore.getState();
        return {
            mode: s.mode,
            order: s.objects.map((o) => o.id),
            bones: s.objects
                .filter((o): o is Bone => o instanceof Bone)
                .map((b) => b.snapshot()),
            rects: s.objects
                .filter((o): o is Rect => o instanceof Rect)
                .map((r) => r.snapshot()),
            anim: animation.snapshot(),
        };
    }

    private restore(snap: Snapshot) {
        const reg = this.builder!.registry;
        const store = useObjectsStore.getState();

        // every object back to its setup pose first (leaves pose mode, rects return to their setup place)
        store.setMode("setup");

        // which objects exist
        const want = new Set<string>([
            ...snap.bones.map((b) => b.id),
            ...snap.rects.map((r) => r.id),
        ]);
        for (const [id, o] of reg) {
            if (want.has(id)) o.revive();
            else o.kill();
        }

        // bones: numbers + hierarchy
        const bone = (id: string) => {
            const o = reg.get(id);
            return o instanceof Bone ? o : undefined;
        };
        const bones = snap.bones.map((s) => {
            const b = bone(s.id)!;
            b.restore(s, bone);
            b.attachments = [];
            return b;
        });

        // rects: numbers + which bone controls them
        for (const s of snap.rects) {
            const r = reg.get(s.id) as Rect;
            r.restore(s);
            const pb = s.parentBone ? bone(s.parentBone) : undefined;
            r.parentBone = pb ?? null;
            pb?.addAttachment(r);
        }

        // positions (setup mode: rects stay where restore put them)
        bones.filter((b) => !b.parent).forEach((b) => b.layout());
        bones.forEach((b) => b.refresh());

        const order = snap.order
            .map((id) => reg.get(id))
            .filter((o): o is Obj => o !== undefined);
        useObjectsStore.getState().setObjects(order);

        if (snap.mode === "pose") useObjectsStore.getState().setMode("pose");
        animation.load(snap.anim); // keys back, and animated bones take the pose of the playhead
        useObjectsStore.getState().bump();
    }
}

export const history = new History();
