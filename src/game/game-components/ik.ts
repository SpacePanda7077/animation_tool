import { Scene, GameObjects, Input } from "phaser";
import { Bone } from "./objects/objetcs/Bone";
import { useObjectsStore } from "../../store/object-store";
import { history } from "./history";

/**
 * 2-bone IK constraint with target + pole handles.
 *
 * - Target & pole are stored in the **local space of the chain root**
 *   (boneA's parent, or world if boneA is a root), so moving the body
 *   keeps the IK pose consistent.
 * - Bones under an active IK cannot be rotated/moved manually in pose mode;
 *   only the handles drive them.
 * - Pole defaults to the "front" side of the chain (knee/elbow forward).
 */

export type IKState = {
    id: string;
    name: string;
    boneAId: string;
    boneBId: string;
    /** target in chain-root local space */
    localTargetX: number;
    localTargetY: number;
    /** pole in chain-root local space */
    localPoleX: number;
    localPoleY: number;
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

    // Cross product (target-root) × (pole-root) → bend side
    const px = poleX - rootX;
    const py = poleY - rootY;
    const cross = dx * py - dy * px;
    const sign = cross >= 0 ? 1 : -1;

    const angleA = dirToTarget - sign * midAngle;
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

    /**
     * Target & pole stored relative to the chain root's frame
     * (parent of boneA, or world if boneA has no parent).
     * This way moving the body keeps the IK attached.
     */
    localTargetX = 0;
    localTargetY = 0;
    localPoleX = 0;
    localPoleY = 0;

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

        // Initial target = current tip of boneB (convert to local)
        const tip = this.worldToLocal(boneB.poll.x, boneB.poll.y);
        this.localTargetX = tip.x;
        this.localTargetY = tip.y;

        // Initial pole = in FRONT of the chain (knee/elbow forward).
        // "Front" = opposite of the previous default: flip the perpendicular.
        const mx = (boneA.pivot.x + boneB.poll.x) / 2;
        const my = (boneA.pivot.y + boneB.poll.y) / 2;
        const dx = boneB.poll.x - boneA.pivot.x;
        const dy = boneB.poll.y - boneA.pivot.y;
        const len = Math.hypot(dx, dy) || 1;
        // Flipped perpendicular so pole sits in front of the knee/elbow
        const worldPoleX = mx + (dy / len) * 60;
        const worldPoleY = my - (dx / len) * 60;
        const poleLocal = this.worldToLocal(worldPoleX, worldPoleY);
        this.localPoleX = poleLocal.x;
        this.localPoleY = poleLocal.y;

        const worldTarget = this.localToWorld(
            this.localTargetX,
            this.localTargetY,
        );
        const worldPole = this.localToWorld(this.localPoleX, this.localPoleY);

        this.targetHandle = scene.add
            .circle(worldTarget.x, worldTarget.y, 8, 0x4caf50)
            .setDepth(Bone.DEPTH + 20)
            .setInteractive({ draggable: true })
            .setData("ik", this)
            .setData("ik-role", "target");

        this.poleHandle = scene.add
            .circle(worldPole.x, worldPole.y, 6, 0x9c27b0)
            .setDepth(Bone.DEPTH + 20)
            .setInteractive({ draggable: true })
            .setData("ik", this)
            .setData("ik-role", "pole");

        this.line = scene.add.graphics().setDepth(Bone.DEPTH + 15);

        scene.input.setDraggable([this.targetHandle, this.poleHandle]);

        this.targetHandle.on("dragstart", () => {
            this.dragging = true;
        });
        this.targetHandle.on("drag", (p: Input.Pointer) => {
            if (Bone.mode !== "pose" || !this.enabled) return;
            const local = this.worldToLocal(p.worldX, p.worldY);
            this.localTargetX = local.x;
            this.localTargetY = local.y;
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
            const local = this.worldToLocal(p.worldX, p.worldY);
            this.localPoleX = local.x;
            this.localPoleY = local.y;
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

    // ---------- chain-root frame helpers ----------

    /** The bone whose frame we treat as "local" for target/pole. */
    private chainRoot(): Bone | null {
        return this.boneA.parent; // null → world
    }

    private worldToLocal(wx: number, wy: number): { x: number; y: number } {
        const root = this.chainRoot();
        if (!root) return { x: wx, y: wy };
        // Prefer setup-ish position: use pivot of parent
        const ox = root.pivot.x;
        const oy = root.pivot.y;
        const a = root.angle;
        const c = Math.cos(a);
        const s = Math.sin(a);
        const dx = wx - ox;
        const dy = wy - oy;
        return {
            x: dx * c + dy * s,
            y: -dx * s + dy * c,
        };
    }

    private localToWorld(lx: number, ly: number): { x: number; y: number } {
        const root = this.chainRoot();
        if (!root) return { x: lx, y: ly };
        const ox = root.pivot.x;
        const oy = root.pivot.y;
        const a = root.angle;
        const c = Math.cos(a);
        const s = Math.sin(a);
        return {
            x: ox + lx * c - ly * s,
            y: oy + lx * s + ly * c,
        };
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
        const target = this.localToWorld(this.localTargetX, this.localTargetY);
        const pole = this.localToWorld(this.localPoleX, this.localPoleY);

        const result = solve2BoneIK(
            root.x,
            root.y,
            this.boneA.length,
            this.boneB.length,
            target.x,
            target.y,
            pole.x,
            pole.y,
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

        const target = this.localToWorld(this.localTargetX, this.localTargetY);
        const pole = this.localToWorld(this.localPoleX, this.localPoleY);

        this.targetHandle.setPosition(target.x, target.y);
        this.poleHandle.setPosition(pole.x, pole.y);

        const visible = Bone.mode === "pose" && this.enabled;
        this.targetHandle.setVisible(visible);
        this.poleHandle.setVisible(visible);
        this.line.setVisible(visible);

        this.line.clear();
        if (!visible) return;

        // Pole guide line (mid of chain → pole)
        const midX = (this.boneA.pivot.x + this.boneB.poll.x) / 2;
        const midY = (this.boneA.pivot.y + this.boneB.poll.y) / 2;
        this.line.lineStyle(1, 0x9c27b0, 0.6);
        this.line.beginPath();
        this.line.moveTo(midX, midY);
        this.line.lineTo(pole.x, pole.y);
        this.line.strokePath();

        // Target guide (tip → target)
        this.line.lineStyle(1, 0x4caf50, 0.4);
        this.line.beginPath();
        this.line.moveTo(this.boneB.poll.x, this.boneB.poll.y);
        this.line.lineTo(target.x, target.y);
        this.line.strokePath();
    }

    /**
     * Call after the body / chain root has moved so handles & solve stay in sync.
     * Safe to call every frame or after any layout.
     */
    sync() {
        if (this.destroyed || !this.enabled) return;
        if (Bone.mode !== "pose") {
            this.draw();
            return;
        }
        // Re-solve so bones follow the (local) target after parent moved
        if (!this.dragging) {
            this.solve();
        }
        this.draw();
    }

    snapshot(): IKState {
        return {
            id: this.id,
            name: this.name,
            boneAId: this.boneA.id,
            boneBId: this.boneB.id,
            localTargetX: this.localTargetX,
            localTargetY: this.localTargetY,
            localPoleX: this.localPoleX,
            localPoleY: this.localPoleY,
            enabled: this.enabled,
        };
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
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
        for (const c of IKConstraint.all) c.draw();
    }

    /** Re-solve every IK after hierarchy / body movement. */
    static syncAll() {
        for (const c of IKConstraint.all) c.sync();
    }
}

export function addIKFromSelection(scene: Scene): IKConstraint | null {
    return IKConstraint.createFromSelection(scene);
}
