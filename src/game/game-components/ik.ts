import { Scene, GameObjects, Input } from "phaser";
import { Bone } from "./objects/objetcs/Bone";
import { useObjectsStore } from "../../store/object-store";
import { history } from "./history";

/**
 * 2-bone IK constraint with target + pole handles.
 *
 * - Target & pole live in WORLD space: they do not follow the chain's parent
 *   bone. Move / rotate the body and the target stays planted (the chain just
 *   re-solves to keep reaching it); only dragging the handles moves them.
 * - The joint between the two bones (knee / elbow) bends toward the pole: it
 *   always sits on the same side of the root -> target line as the pole.
 * - Bones under an active IK cannot be rotated/moved manually in pose mode;
 *   only the handles drive them.
 * - A new IK keeps the chain exactly as it is and puts the pole on the side
 *   the chain currently bends to.
 */

export type IKState = {
    id: string;
    name: string;
    boneAId: string;
    boneBId: string;
    /** target (world) */
    targetX: number;
    targetY: number;
    /** pole (world) */
    poleX: number;
    poleY: number;
    enabled: boolean;
};

let nextId = 1;

/** Analytic 2-bone IK with pole vector. Returns world angles (radians). */
export function solve2BoneIK(
    rootX: number,
    rootY: number,
    lenA: number,
    lenB: number,
    targetX: number,
    targetY: number,
    poleX: number,
    poleY: number,
): { angleA: number; angleB: number } | null {
    const dx = targetX - rootX;
    const dy = targetY - rootY;
    let dist = Math.hypot(dx, dy);

    const maxReach = lenA + lenB - 1e-4;
    const minReach = Math.abs(lenA - lenB) + 1e-4;
    if (dist > maxReach) dist = maxReach;
    if (dist < minReach) dist = minReach;
    if (dist < 1e-6) return null;

    const cosMid =
        (lenA * lenA + dist * dist - lenB * lenB) / (2 * lenA * dist);
    const cosClamped = Math.max(-1, Math.min(1, cosMid));
    const midAngle = Math.acos(cosClamped);

    const dirToTarget = Math.atan2(dy, dx);

    // Which side of the root -> target line the pole is on (cross product).
    // The first bone is turned off the root -> target line by midAngle toward that
    // same side, so the joint (knee / elbow) bends TOWARD the pole.
    const px = poleX - rootX;
    const py = poleY - rootY;
    const cross = dx * py - dy * px;
    const sign = cross >= 0 ? 1 : -1;

    const angleA = dirToTarget + sign * midAngle;
    const midX = rootX + Math.cos(angleA) * lenA;
    const midY = rootY + Math.sin(angleA) * lenA;
    const angleB = Math.atan2(targetY - midY, targetX - midX);

    return { angleA, angleB };
}

export class IKConstraint {
    readonly id: string;
    name: string;
    boneA: Bone;
    boneB: Bone;
    enabled = true;

    /** custom names of the target / pole; null = "<IK name> target" / "<IK name> pole" */
    private customTarget: string | null = null;
    private customPole: string | null = null;

    /** target & pole in world space (they do not follow any bone) */
    targetX = 0;
    targetY = 0;
    poleX = 0;
    poleY = 0;

    private scene: Scene;
    private targetHandle: GameObjects.Arc;
    private poleHandle: GameObjects.Arc;
    private line: GameObjects.Graphics;
    private destroyed = false;
    private dragging = false;

    static all: IKConstraint[] = [];

    /** Bones that are currently driven by an active IK (cannot be edited manually). */
    static lockedBones = new Set<Bone>();

    private constructor(scene: Scene, boneA: Bone, boneB: Bone) {
        this.id = `ik-${nextId++}`;
        this.name = `IK ${nextId - 1}`;
        this.scene = scene;
        this.boneA = boneA;
        this.boneB = boneB;

        // Initial target = current tip of boneB, pole on the side the chain bends to now,
        // so creating the IK doesn't change the pose.
        this.targetX = boneB.poll.x;
        this.targetY = boneB.poll.y;
        const pole = this.defaultPole();
        this.poleX = pole.x;
        this.poleY = pole.y;

        this.targetHandle = scene.add
            .circle(this.targetX, this.targetY, 8, 0x4caf50)
            .setDepth(Bone.DEPTH + 20)
            .setInteractive({ draggable: true })
            .setData("ik", this)
            .setData("ik-role", "target");
        this.targetHandle.on("pointerdown", () => this.select("target"));

        this.poleHandle = scene.add
            .circle(this.poleX, this.poleY, 6, 0x9c27b0)
            .setDepth(Bone.DEPTH + 20)
            .setInteractive({ draggable: true })
            .setData("ik", this)
            .setData("ik-role", "pole");
        this.poleHandle.on("pointerdown", () => this.select("pole"));

        this.line = scene.add.graphics().setDepth(Bone.DEPTH + 15);

        scene.input.setDraggable([this.targetHandle, this.poleHandle]);

        this.targetHandle.on("dragstart", () => {
            this.dragging = true;
        });
        this.targetHandle.on("drag", (p: Input.Pointer) => {
            if (Bone.mode !== "pose" || !this.enabled) return;
            this.targetX = p.worldX;
            this.targetY = p.worldY;
            this.solve();
            this.draw();
        });
        this.targetHandle.on("dragend", () => {
            this.dragging = false;
        });

        this.poleHandle.on("dragstart", () => {
            this.dragging = true;
        });
        this.poleHandle.on("drag", (p: Input.Pointer) => {
            if (Bone.mode !== "pose" || !this.enabled) return;
            this.poleX = p.worldX;
            this.poleY = p.worldY;
            this.solve();
            this.draw();
        });
        this.poleHandle.on("dragend", () => {
            this.dragging = false;
        });

        this.updateLockedSet();
        this.solve();
        this.draw();
        IKConstraint.all.push(this);
    }

    // ---------- names / selection ----------

    /** name of the target object ("Left leg target" unless you renamed it) */
    get targetName(): string {
        return this.customTarget ?? `${this.name} target`;
    }
    /** name of the pole object */
    get poleName(): string {
        return this.customPole ?? `${this.name} pole`;
    }

    setName(v: string) {
        const t = v.trim();
        if (!t) return;
        this.name = t;
        useObjectsStore.getState().bump();
    }
    setTargetName(v: string) {
        const t = v.trim();
        if (!t) return;
        this.customTarget = t;
        useObjectsStore.getState().bump();
    }
    setPoleName(v: string) {
        const t = v.trim();
        if (!t) return;
        this.customPole = t;
        useObjectsStore.getState().bump();
    }

    /** type exact numbers (pose mode: the chain follows right away) */
    setTargetPos(x: number, y: number) {
        this.targetX = x;
        this.targetY = y;
        this.solve();
        this.draw();
        useObjectsStore.getState().bump();
    }
    setPolePos(x: number, y: number) {
        this.poleX = x;
        this.poleY = y;
        this.solve();
        this.draw();
        useObjectsStore.getState().bump();
    }

    select(part: "ik" | "target" | "pole" = "ik") {
        useObjectsStore.getState().setSelectedIK({ ik: this, part });
        this.draw();
    }

    private isSelected(part: "target" | "pole") {
        const s = useObjectsStore.getState().selectedIK;
        return !!s && s.ik === this && s.part === part;
    }

    // ---------- bend side ----------

    /** Cross product of (root -> tip) and (root -> knee): > 0 / < 0 = which side the chain bends to now. */
    private kneeCross(): number {
        const r = this.getChainRootWorld();
        const dx = this.boneB.poll.x - r.x;
        const dy = this.boneB.poll.y - r.y;
        const kx = this.boneA.poll.x - r.x;
        const ky = this.boneA.poll.y - r.y;
        return dx * ky - dy * kx;
    }

    /** A pole position next to the knee, on the side the chain currently bends to. */
    private defaultPole(): { x: number; y: number } {
        const r = this.getChainRootWorld();
        const dx = this.boneB.poll.x - r.x;
        const dy = this.boneB.poll.y - r.y;
        const len = Math.hypot(dx, dy) || 1;
        const side = this.kneeCross() >= 0 ? 1 : -1;
        // (-dy, dx) is the perpendicular on the positive-cross side
        return {
            x: this.boneA.poll.x + side * (-dy / len) * 60,
            y: this.boneA.poll.y + side * (dx / len) * 60,
        };
    }

    /**
     * Put the target on the chain's current tip (and fix the pole if it is on the wrong side of a bent chain).
     * Called when entering pose mode, so changes made in setup mode don't make the chain jump to an old target.
     */
    private anchor() {
        if (this.destroyed || !this.enabled) return;
        this.targetX = this.boneB.poll.x;
        this.targetY = this.boneB.poll.y;
        const knee = this.kneeCross();
        if (Math.abs(knee) < 1) return; // straight chain: keep the pole where it is
        const r = this.getChainRootWorld();
        const pc =
            (this.targetX - r.x) * (this.poleY - r.y) -
            (this.targetY - r.y) * (this.poleX - r.x);
        if (pc >= 0 !== knee > 0) {
            const pole = this.defaultPole();
            this.poleX = pole.x;
            this.poleY = pole.y;
        }
    }

    /** World position of boneA's pivot using only parent transforms (pose of A/B ignored). */
    private getChainRootWorld(): { x: number; y: number } {
        // boneA's pivot after parent layout, but we need the attachment point
        // before boneA's own pose rotation. Using live pivot of boneA is wrong
        // if boneA has pose translation; for connected bones the pivot is the
        // parent's tip.
        if (this.boneA.parent) {
            const p = this.boneA.parent;
            if (this.boneA.connected) {
                return { x: p.poll.x, y: p.poll.y };
            }
            // offset child: parent pivot + rotated offset (setup off, ignore pose of A)
            const a = p.angle;
            const c = Math.cos(a);
            const s = Math.sin(a);
            return {
                x: p.pivot.x + this.boneA.offX * c - this.boneA.offY * s,
                y: p.pivot.y + this.boneA.offX * s + this.boneA.offY * c,
            };
        }
        return {
            x: this.boneA.baseX + (Bone.mode === "pose" ? this.boneA.poseX : 0),
            y: this.boneA.baseY + (Bone.mode === "pose" ? this.boneA.poseY : 0),
        };
    }

    // ---------- public API ----------

    static createFromSelection(scene: Scene): IKConstraint | null {
        const sel = [...Bone.selection].filter((b) => b.alive);
        if (sel.length !== 2) return null;

        let upper = sel[0];
        let lower = sel[1];

        if (lower.parent === upper) {
            // good
        } else if (upper.parent === lower) {
            [upper, lower] = [lower, upper];
        } else {
            return null;
        }

        if (
            IKConstraint.all.some(
                (c) => !c.destroyed && c.boneA === upper && c.boneB === lower,
            )
        ) {
            return null;
        }

        return new IKConstraint(scene, upper, lower);
    }

    /** Is this bone driven by any active IK? */
    static isLocked(bone: Bone): boolean {
        return IKConstraint.lockedBones.has(bone);
    }

    private updateLockedSet() {
        IKConstraint.lockedBones.clear();
        for (const c of IKConstraint.all) {
            if (c.destroyed || !c.enabled) continue;
            IKConstraint.lockedBones.add(c.boneA);
            IKConstraint.lockedBones.add(c.boneB);
        }
    }

    solve() {
        if (!this.enabled || this.destroyed) return;
        if (Bone.mode !== "pose") return;
        if (!this.boneA.alive || !this.boneB.alive) return;

        const root = this.getChainRootWorld();

        const result = solve2BoneIK(
            root.x,
            root.y,
            this.boneA.length,
            this.boneB.length,
            this.targetX,
            this.targetY,
            this.poleX,
            this.poleY,
        );
        if (!result) return;

        history.silent(() => {
            const parentAngle = this.boneA.parent ? this.boneA.parent.angle : 0;
            this.boneA.poseRel = result.angleA - parentAngle - this.boneA.rel;
            // Keep IK bones from carrying extra translation
            this.boneA.poseX = 0;
            this.boneA.poseY = 0;
            this.boneA.layout();

            const aWorld = this.boneA.angle;
            this.boneB.poseRel = result.angleB - aWorld - this.boneB.rel;
            this.boneB.poseX = 0;
            this.boneB.poseY = 0;

            const chainRoot = this.boneA.parent
                ? this.findRoot(this.boneA)
                : this.boneA;
            chainRoot.layout();
        });

        useObjectsStore.getState().bump();
    }

    private findRoot(b: Bone): Bone {
        let r = b;
        while (r.parent) r = r.parent;
        return r;
    }

    draw() {
        if (this.destroyed) return;

        this.targetHandle.setPosition(this.targetX, this.targetY);
        this.poleHandle.setPosition(this.poleX, this.poleY);
        // the picked one gets a white ring
        this.targetHandle.setStrokeStyle(
            this.isSelected("target") ? 3 : 0,
            0xffffff,
        );
        this.poleHandle.setStrokeStyle(
            this.isSelected("pole") ? 3 : 0,
            0xffffff,
        );

        const visible = Bone.mode === "pose" && this.enabled;
        this.targetHandle.setVisible(visible);
        this.poleHandle.setVisible(visible);
        this.line.setVisible(visible);

        this.line.clear();
        if (!visible) return;

        // Pole guide line (knee / elbow → pole): the joint bends toward this
        this.line.lineStyle(1, 0x9c27b0, 0.6);
        this.line.beginPath();
        this.line.moveTo(this.boneA.poll.x, this.boneA.poll.y);
        this.line.lineTo(this.poleX, this.poleY);
        this.line.strokePath();

        // Target guide (tip → target)
        this.line.lineStyle(1, 0x4caf50, 0.4);
        this.line.beginPath();
        this.line.moveTo(this.boneB.poll.x, this.boneB.poll.y);
        this.line.lineTo(this.targetX, this.targetY);
        this.line.strokePath();
    }

    /**
     * Call after the body / chain root has moved so the chain re-solves toward its (world) target.
     * Safe to call every frame or after any layout.
     */
    sync() {
        if (this.destroyed || !this.enabled) return;
        if (Bone.mode !== "pose") {
            this.draw();
            return;
        }
        // Re-solve so the chain keeps reaching its world target after the parent moved
        if (!this.dragging) {
            this.solve();
        }
        this.draw();
    }

    /**
     * Which side of the root -> target line the pole is on: +1 / -1. This is the same test the solver uses to
     * pick the bend direction, and it is what gets exported as `bend`.
     */
    bendSign(): 1 | -1 {
        const r = this.getChainRootWorld();
        const cross =
            (this.targetX - r.x) * (this.poleY - r.y) -
            (this.targetY - r.y) * (this.poleX - r.x);
        return cross >= 0 ? 1 : -1;
    }

    snapshot(): IKState {
        return {
            id: this.id,
            name: this.name,
            boneAId: this.boneA.id,
            boneBId: this.boneB.id,
            targetX: this.targetX,
            targetY: this.targetY,
            poleX: this.poleX,
            poleY: this.poleY,
            enabled: this.enabled,
        };
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        const st = useObjectsStore.getState();
        if (st.selectedIK?.ik === this) st.setSelectedIK(null);
        this.targetHandle.destroy();
        this.poleHandle.destroy();
        this.line.destroy();
        IKConstraint.all = IKConstraint.all.filter((c) => c !== this);
        this.updateLockedSet();
    }

    static destroyAll() {
        [...IKConstraint.all].forEach((c) => c.destroy());
        IKConstraint.lockedBones.clear();
    }

    static refreshAll() {
        for (const c of IKConstraint.all) {
            if (Bone.mode === "pose") c.anchor();
            c.draw();
        }
    }

    /** Re-solve every IK after hierarchy / body movement. */
    static syncAll() {
        for (const c of IKConstraint.all) c.sync();
    }
}

export function addIKFromSelection(scene: Scene): IKConstraint | null {
    return IKConstraint.createFromSelection(scene);
}
