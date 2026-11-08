import { GameObjects, Input, Scene } from "phaser";
import { Bone } from "./objects/objetcs/Bone";
import { Rect } from "./objects/objetcs/Rect";
import { useObjectsStore } from "../../store/object-store";

/** the mouse must travel this far (screen pixels) before a press on empty space becomes a box */
const DRAG_THRESHOLD = 4;

type Box = { minX: number; minY: number; maxX: number; maxY: number };

/**
 * Box select: press on empty space, drag, release.
 *  - bones touched by the box become the bone selection (Shift = add to it)
 *  - one rect touched: it is selected like a click would (with its handles)
 *  - several rects touched: they form a group (outline) that moves together; click one to pick it alone
 * Anything the box touches counts, it doesn't have to be fully inside. Hidden objects are ignored.
 * Left mouse button only (middle button pans the camera).
 */
export class BoxSelect {
    private scene: Scene;
    private gfx: GameObjects.Graphics;
    private start: { x: number; y: number; sx: number; sy: number } | null =
        null;
    private active = false;

    constructor(scene: Scene) {
        this.scene = scene;
        this.gfx = scene.add.graphics().setDepth(Bone.DEPTH + 50);
        scene.input.on("pointerdown", this.onDown, this);
        scene.input.on("pointermove", this.onMove, this);
        scene.input.on("pointerup", this.onUp, this);
        scene.input.on("pointerupoutside", this.onUp, this);
    }

    destroy() {
        const input = this.scene.input;
        input?.off("pointerdown", this.onDown, this);
        input?.off("pointermove", this.onMove, this);
        input?.off("pointerup", this.onUp, this);
        input?.off("pointerupoutside", this.onUp, this);
        this.gfx.destroy();
        this.start = null;
        this.active = false;
    }

    private onDown(p: Input.Pointer, over: GameObjects.GameObject[]) {
        if (((p.event as MouseEvent).button ?? 0) !== 0) return;
        // pressing on a bone, rect, handle... is not a box
        if (over.length > 0) return;
        const shift = (p.event as MouseEvent).shiftKey;
        // a plain click on empty space clears the rect group too (bones / single rects clear themselves)
        if (!shift) Rect.setGroup([]);
        this.start = { x: p.worldX, y: p.worldY, sx: p.x, sy: p.y };
        this.active = false;
    }

    private onMove(p: Input.Pointer) {
        if (!this.start) return;
        if (!((p.event as MouseEvent).buttons & 1)) {
            this.cancel();
            return;
        }
        if (
            !this.active &&
            Math.hypot(p.x - this.start.sx, p.y - this.start.sy) <
                DRAG_THRESHOLD
        )
            return;
        this.active = true;
        this.draw(this.boxOf(p));
    }

    private onUp(p: Input.Pointer) {
        if (!this.start) return;
        const wasBox = this.active;
        const box = wasBox ? this.boxOf(p) : null;
        const shift = (p.event as MouseEvent | undefined)?.shiftKey ?? false;
        this.cancel();
        if (box) this.select(box, shift);
    }

    private cancel() {
        this.start = null;
        this.active = false;
        this.gfx.clear();
    }

    private boxOf(p: Input.Pointer): Box {
        const s = this.start!;
        return {
            minX: Math.min(s.x, p.worldX),
            minY: Math.min(s.y, p.worldY),
            maxX: Math.max(s.x, p.worldX),
            maxY: Math.max(s.y, p.worldY),
        };
    }

    private draw(b: Box) {
        const zoom = this.scene.cameras.main.zoom || 1;
        this.gfx.clear();
        this.gfx.fillStyle(0xffd54f, 0.12);
        this.gfx.fillRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
        this.gfx.lineStyle(1 / zoom, 0xffd54f, 0.9);
        this.gfx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
    }

    // ---------- picking ----------

    private select(box: Box, shift: boolean) {
        const objects = useObjectsStore.getState().objects;

        const bones = objects.filter(
            (o): o is Bone =>
                o instanceof Bone &&
                o.alive &&
                !o.hidden &&
                segmentHitsBox(o.pivot.x, o.pivot.y, o.poll.x, o.poll.y, box),
        );
        const rects = objects.filter(
            (o): o is Rect =>
                o instanceof Rect &&
                o.alive &&
                !o.hidden &&
                rectHitsBox(o, box),
        );

        // bones
        if (bones.length) {
            const keep = shift ? [...Bone.selection] : [];
            const merged = [...keep, ...bones.filter((b) => !keep.includes(b))];
            Bone.setSelection(merged, bones[bones.length - 1]);
        } else if (!shift) {
            Bone.setSelection([]);
        }

        // rects
        const picked = shift
            ? [...Rect.group, ...rects.filter((r) => !Rect.group.has(r))]
            : rects;
        if (picked.length > 1) {
            Rect.setGroup(picked);
        } else {
            Rect.setGroup([]);
            if (picked.length === 1) picked[0].select();
        }
    }
}

// ---------- geometry ----------

/** does the segment (x1,y1)-(x2,y2) touch the box? (Liang–Barsky clipping) */
function segmentHitsBox(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    b: Box,
): boolean {
    let t0 = 0;
    let t1 = 1;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const clip = (p: number, q: number) => {
        if (p === 0) return q >= 0; // parallel to this edge: inside or outside
        const r = q / p;
        if (p < 0) {
            if (r > t1) return false;
            if (r > t0) t0 = r;
        } else {
            if (r < t0) return false;
            if (r < t1) t1 = r;
        }
        return true;
    };
    return (
        clip(-dx, x1 - b.minX) &&
        clip(dx, b.maxX - x1) &&
        clip(-dy, y1 - b.minY) &&
        clip(dy, b.maxY - y1)
    );
}

/** does the (rotated) rect touch the box? Separating-axis test. */
function rectHitsBox(r: Rect, b: Box): boolean {
    const hw = r.rect.displayWidth / 2;
    const hh = r.rect.displayHeight / 2;
    const rot = r.rect.rotation;
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const cx = r.rect.x;
    const cy = r.rect.y;

    const corners: [number, number][] = [
        [-hw, -hh],
        [hw, -hh],
        [hw, hh],
        [-hw, hh],
    ].map(([lx, ly]): [number, number] => [
        cx + lx * c - ly * s,
        cy + lx * s + ly * c,
    ]);
    const boxCorners: [number, number][] = [
        [b.minX, b.minY],
        [b.maxX, b.minY],
        [b.maxX, b.maxY],
        [b.minX, b.maxY],
    ];

    // axes: the box's (x, y) and the rect's (rotated x, y)
    const axes: [number, number][] = [
        [1, 0],
        [0, 1],
        [c, s],
        [-s, c],
    ];
    for (const [ax, ay] of axes) {
        let aMin = Infinity;
        let aMax = -Infinity;
        for (const [x, y] of corners) {
            const d = x * ax + y * ay;
            aMin = Math.min(aMin, d);
            aMax = Math.max(aMax, d);
        }
        let bMin = Infinity;
        let bMax = -Infinity;
        for (const [x, y] of boxCorners) {
            const d = x * ax + y * ay;
            bMin = Math.min(bMin, d);
            bMax = Math.max(bMax, d);
        }
        if (aMax < bMin || bMax < aMin) return false; // a gap on this axis: no overlap
    }
    return true;
}
