import type { Scene, GameObjects, Input } from "phaser";
import { Bone } from "./objects/objetcs/Bone";
import { Rect } from "./objects/objetcs/Rect";
import { useMeshEditStore, type MeshTool } from "../../store/mesh-edit-store";
import { useObjectsStore } from "../../store/object-store";
import { BoxSelect } from "./box-select";
import type { Mesh } from "./objects/objetcs/Mesh";

/** blue (0) -> cyan -> green -> yellow -> red (1) */
function heat(t: number): number {
    const h = (1 - Math.max(0, Math.min(1, t))) * 4; // 0..4
    const seg = Math.floor(h);
    const f = h - seg;
    const [r, g, b] =
        seg === 0 ? [1, f, 0] : seg === 1 ? [1 - f, 1, 0] : seg === 2 ? [0, 1, f] : [0, 1 - f, 1];
    return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

/**
 * Edits a mesh on the canvas (see mesh-edit-store for what is being edited):
 *
 *  vertices tool: drag a vertex to move it, click an empty spot to add one, Shift + click a vertex to delete it.
 *  weights tool:  paint with the brush. It paints the active bone (pick it in the layers list). Alt flips
 *                 add / remove while you hold it.
 *
 * While it runs, bones, IK handles and every rectangle stop catching the mouse (so you can't drag them by accident)
 * and box select is off. Esc, pose mode or deleting the mesh ends it.
 */
export class MeshEditor {
    private scene: Scene;
    private gfx: GameObjects.Graphics;
    private mesh: Mesh | null = null;
    private tool: MeshTool = "vertices";
    private painting = false;
    private dragging = -1;
    private moved = false;
    private pointer: { x: number; y: number } | null = null;
    private prevGhost = false;
    private disabled: Rect[] = [];
    private unsub: () => void;

    constructor(
        scene: Scene,
        private setGhost: (on: boolean) => void,
    ) {
        this.scene = scene;
        this.gfx = scene.add.graphics().setDepth(Bone.DEPTH + 40);
        scene.input.on("pointerdown", this.onDown, this);
        scene.input.on("pointermove", this.onMove, this);
        scene.input.on("pointerup", this.onUp, this);
        scene.input.on("pointerupoutside", this.onUp, this);
        window.addEventListener("keydown", this.onKey);
        this.unsub = useMeshEditStore.subscribe(() => this.sync());
    }

    destroy() {
        this.unsub();
        window.removeEventListener("keydown", this.onKey);
        const input = this.scene.input;
        input?.off("pointerdown", this.onDown, this);
        input?.off("pointermove", this.onMove, this);
        input?.off("pointerup", this.onUp, this);
        input?.off("pointerupoutside", this.onUp, this);
        this.exit();
        this.gfx.destroy();
    }

    /** every frame: redraw the overlay, and stop if editing no longer makes sense */
    update() {
        if (!this.mesh) return;
        if (useObjectsStore.getState().mode !== "setup" || !this.mesh.alive) {
            useMeshEditStore.getState().end();
            return;
        }
        this.draw();
    }

    private sync() {
        const { target, tool } = useMeshEditStore.getState();
        this.tool = tool;
        if (target !== this.mesh) {
            this.exit();
            if (target) this.enter(target);
        }
    }

    private enter(mesh: Mesh) {
        this.mesh = mesh;
        BoxSelect.suspended = true;
        this.prevGhost = Bone.ghost;
        this.setGhost(true);
        // nothing else may be picked or dragged while editing
        this.disabled = [];
        for (const o of useObjectsStore.getState().objects) {
            if (!(o instanceof Rect)) continue;
            o.deselect();
            const input = o.rect.input;
            if (input?.enabled) {
                input.enabled = false;
                this.disabled.push(o);
            }
        }
    }

    private exit() {
        if (!this.mesh) return;
        for (const r of this.disabled) if (r.rect.input) r.rect.input.enabled = true;
        this.disabled = [];
        BoxSelect.suspended = false;
        this.setGhost(this.prevGhost);
        this.mesh = null;
        this.painting = false;
        this.dragging = -1;
        this.gfx.clear();
    }

    private onKey = (e: KeyboardEvent) => {
        if (!this.mesh || e.key !== "Escape") return;
        const t = e.target as HTMLElement | null;
        if (t && /^(input|textarea|select)$/i.test(t.tagName)) return;
        useMeshEditStore.getState().end();
    };

    // ------------------------------------------------------------------ pointer

    private onDown(p: Input.Pointer) {
        const mesh = this.mesh;
        if (!mesh || ((p.event as MouseEvent).button ?? 0) !== 0) return;
        this.pointer = { x: p.worldX, y: p.worldY };

        if (this.tool === "weights") {
            this.painting = true;
            this.dab(p);
            return;
        }

        const hit = mesh.vertexAt(p.worldX, p.worldY, 10 * Rect.ui);
        if (hit >= 0) {
            if ((p.event as MouseEvent).shiftKey) mesh.removeVertex(hit);
            else {
                this.dragging = hit;
                this.moved = false;
            }
            return;
        }
        // an empty spot: new vertex, and you can keep dragging it
        const added = mesh.addVertexAt(p.worldX, p.worldY);
        if (added >= 0) {
            this.dragging = added;
            this.moved = false;
        }
    }

    private onMove(p: Input.Pointer) {
        const mesh = this.mesh;
        if (!mesh) return;
        this.pointer = { x: p.worldX, y: p.worldY };
        const held = ((p.event as MouseEvent).buttons & 1) !== 0;
        if (!held) {
            this.onUp();
            return;
        }
        if (this.dragging >= 0) {
            mesh.moveVertex(this.dragging, p.worldX, p.worldY);
            this.moved = true;
        } else if (this.painting) this.dab(p);
    }

    private onUp() {
        if (this.dragging >= 0 && this.moved) this.mesh?.retriangulate();
        this.dragging = -1;
        this.moved = false;
        this.painting = false;
    }

    private dab(p: Input.Pointer) {
        const bone = Bone.active;
        const mesh = this.mesh;
        if (!mesh || !bone || !bone.alive) return;
        const { brush, strength, paint } = useMeshEditStore.getState();
        const alt = (p.event as MouseEvent).altKey;
        const mode = alt ? (paint === "add" ? "remove" : paint === "remove" ? "add" : paint) : paint;
        mesh.paintAt(p.worldX, p.worldY, brush * Rect.ui, bone.id, mode, strength);
    }

    // ------------------------------------------------------------------ overlay

    private draw() {
        const mesh = this.mesh;
        const g = this.gfx;
        g.clear();
        if (!mesh) return;
        const ui = Rect.ui;
        const pts = mesh.vertices.map((v) => mesh.rigidPoint(v));

        // triangles
        g.lineStyle(1 * ui, 0xffffff, 0.4);
        for (let t = 0; t < mesh.indices.length; t += 3) {
            const a = pts[mesh.indices[t]];
            const b = pts[mesh.indices[t + 1]];
            const c = pts[mesh.indices[t + 2]];
            g.beginPath();
            g.moveTo(a.x, a.y);
            g.lineTo(b.x, b.y);
            g.lineTo(c.x, c.y);
            g.closePath();
            g.strokePath();
        }

        // vertices
        const bone = Bone.active && Bone.active.alive ? Bone.active : null;
        const hover =
            this.tool === "vertices" && this.pointer
                ? mesh.vertexAt(this.pointer.x, this.pointer.y, 10 * ui)
                : -1;
        pts.forEach((p, i) => {
            let color: number;
            if (this.tool === "weights") {
                const v = mesh.vertices[i];
                color = !bone || v.weights.length === 0 ? 0x555555 : heat(mesh.weightOf(i, bone.id));
            } else color = mesh.isCornerVertex(i) ? 0xffb300 : i === hover ? 0xffffff : 0x4fc3f7;
            g.fillStyle(color, 1);
            g.fillCircle(p.x, p.y, (i === hover ? 6 : 4.5) * ui);
            g.lineStyle(1 * ui, 0x000000, 0.8);
            g.strokeCircle(p.x, p.y, (i === hover ? 6 : 4.5) * ui);
        });

        // brush
        if (this.tool === "weights" && this.pointer) {
            g.lineStyle(1.5 * ui, 0xffd54f, 1);
            g.strokeCircle(this.pointer.x, this.pointer.y, useMeshEditStore.getState().brush * ui);
        }
    }
}
