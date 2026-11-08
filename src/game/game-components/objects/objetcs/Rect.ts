import { Scene, Math as PMath, GameObjects } from "phaser";
import { rect_config } from "../configuration";
import type { Grid } from "../../grid";
import type { Bone, BoneAttachment } from "./Bone";

/** plain-data copy of everything that defines a rect (used by undo / redo) */
export type RectState = {
    id: string;
    name: string;
    hidden: boolean;
    parentBone: string | null;
    /** setup placement (while posing: where it was placed in setup, not where the bone drives it) */
    x: number;
    y: number;
    rot: number;
    scaleX: number;
    scaleY: number;
    pivotX: number;
    pivotY: number;
    color: number;
};

type Mode = "scale" | "rotate";
type Drag =
    | { type: "scale"; hx: number; hy: number }
    | { type: "rotate"; lastAngle: number }
    | { type: "pivot" }
    | {
          type: "move";
          offX: number;
          offY: number;
          startX: number;
          startY: number;
          moved: boolean;
      }
    | null;

export class Rect implements BoneAttachment {
    scene: Scene;
    rect: Phaser.GameObjects.Rectangle;

    // Pivot is stored relative to the rect (in fractions of width/height from
    // the center, so 0,0 = center). That keeps it attached to the rect when
    // the rect is scaled, and `pivot` always holds its current world position.
    pivotNorm = new PMath.Vector2(0, 0);
    pivot = new PMath.Vector2();
    pivotIndicator: Phaser.GameObjects.Arc;

    offset = 5;
    minSize = 10;

    /** Set to a Grid to enable snapping: hold Ctrl while moving / scaling / dragging the pivot. */
    grid: Grid | null = null;
    /** true = always snap (Ctrl then does nothing) */
    snapAlways = false;

    private static count = 0;

    /** Several rects picked with the box select: outlined, and they move together. A group of one is not a group. */
    static group = new Set<Rect>();

    /** replace the group (the outlines follow) */
    static setGroup(rects: Rect[]) {
        const next = new Set(rects.length > 1 ? rects : []);
        for (const r of Rect.group) if (!next.has(r)) r.rect.setStrokeStyle();
        for (const r of next) r.rect.setStrokeStyle(2, 0xffd54f);
        Rect.group = next;
    }

    /** hidden rects are not drawn and can't be selected */
    hidden = false;
    /** false = removed from the scene (e.g. undo of a create), kept around so redo can bring it back */
    alive = true;
    /** never changes (used as React key / drag identity), unlike `name` */
    readonly id = `rect-${++Rect.count}`;
    /** shown in the layers list and the inspector; rename with setName */
    name = `Rectangle ${Rect.count}`;

    /** bone that controls this rect (null = free). Position/rotation are stored relative to it. */
    parentBone: Bone | null = null;
    private localX = 0;
    private localY = 0;
    private localRot = 0;
    /** pose mode: rects can't be edited, they only follow their bone */
    locked = false;
    /** where the rect was in setup mode, saved while posing so it can go back */
    private setupPose: { x: number; y: number; rot: number } | null = null;

    /** UI hooks: numbers changed / selected (true) or deselected (false) */
    onChange: ((r: Rect) => void) | null = null;
    onSelect: ((selected: boolean) => void) | null = null;

    scaleIndicators: GameObjects.Rectangle[] = [];
    rotateIndicators: GameObjects.Rectangle[] = [];
    private scaleDirs: [number, number][] = [
        [-1, -1],
        [0, -1],
        [1, -1],
        [-1, 0],
        [1, 0],
        [-1, 1],
        [0, 1],
        [1, 1],
    ];
    private rotateDirs: [number, number][] = [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
    ];

    clicks = -1;
    click = -1;
    mode: Mode | null = null;
    private drag: Drag = null;

    constructor(scene: Scene, config: rect_config) {
        this.scene = scene;
        this.rect = this.scene.add
            .rectangle(
                config.x,
                config.y,
                config.width,
                config.height,
                config.color,
            )
            .setInteractive()
            .on("pointerdown", (p: Phaser.Input.Pointer) => {
                this.drag = {
                    type: "move",
                    offX: this.rect.x - p.worldX,
                    offY: this.rect.y - p.worldY,
                    startX: p.worldX,
                    startY: p.worldY,
                    moved: false,
                };
            });

        this.pivotIndicator = this.scene.add
            .circle(0, 0, 4, 0xfff000)
            .setDepth(11)
            .setInteractive()
            .setVisible(false)
            .on("pointerdown", () => {
                this.drag = { type: "pivot" };
            });

        this.addScaleIndicator();
        this.addRotateIndicator();
        this.updateHandles();

        this.scene.input.on("pointermove", (p: Phaser.Input.Pointer) =>
            this.onMove(p),
        );
        this.scene.input.on("pointerup", () => this.onUp());
        // click on empty space -> deselect
        this.scene.input.on(
            "pointerdown",
            (
                _p: Phaser.Input.Pointer,
                over: Phaser.GameObjects.GameObject[],
            ) => {
                if (this.mode === null) return;
                const mine: Phaser.GameObjects.GameObject[] = [
                    this.rect,
                    this.pivotIndicator,
                    ...this.scaleIndicators,
                    ...this.rotateIndicators,
                ];
                if (!over.some((o) => mine.includes(o))) this.deselect();
            },
        );
    }

    private onUp() {
        const d = this.drag;
        this.drag = null;
        // a press on the rect without dragging counts as a click
        if (d && d.type === "move" && !d.moved) this.handleClicks();
    }

    deselect() {
        if (Rect.group.has(this))
            Rect.setGroup([...Rect.group].filter((r) => r !== this));
        this.mode = null;
        this.clicks = -1;
        this.click = -1;
        this.drag = null;
        this.hideAll();
        this.onSelect?.(false);
    }

    // ---------- coordinate helpers ----------

    /** local (rect space, display units, relative to center) -> world */
    private localToWorld(lx: number, ly: number) {
        const r = this.rect.rotation;
        const c = Math.cos(r);
        const s = Math.sin(r);
        return new PMath.Vector2(
            this.rect.x + lx * c - ly * s,
            this.rect.y + lx * s + ly * c,
        );
    }

    /** world -> local (rect space, display units, relative to center) */
    private worldToLocal(wx: number, wy: number) {
        const r = this.rect.rotation;
        const c = Math.cos(r);
        const s = Math.sin(r);
        const dx = wx - this.rect.x;
        const dy = wy - this.rect.y;
        return new PMath.Vector2(dx * c + dy * s, -dx * s + dy * c);
    }

    // ---------- handle creation ----------

    addScaleIndicator() {
        for (const [hx, hy] of this.scaleDirs) {
            const i = this.scene.add
                .rectangle(0, 0, 6, 6, 0xfff000)
                .setDepth(10)
                .setInteractive()
                .setVisible(false)
                .on("pointerdown", () => {
                    this.drag = { type: "scale", hx, hy };
                });
            this.scaleIndicators.push(i);
        }
    }

    addRotateIndicator() {
        for (const [hx, hy] of this.rotateDirs) {
            const i = this.scene.add
                .rectangle(0, 0, 8, 8, 0xff0000)
                .setDepth(10)
                .setInteractive()
                .setVisible(false)
                .on("pointerdown", (p: Phaser.Input.Pointer) => {
                    this.drag = {
                        type: "rotate",
                        lastAngle: Math.atan2(
                            p.worldY - this.pivot.y,
                            p.worldX - this.pivot.x,
                        ),
                    };
                });
            this.rotateIndicators.push(i);
        }
    }

    // ---------- layout ----------

    /** Reposition all handles + pivot to match the rect's transform. */
    updateHandles() {
        const w = this.rect.displayWidth;
        const h = this.rect.displayHeight;

        const place = (obj: GameObjects.Rectangle, hx: number, hy: number) => {
            const p = this.localToWorld(
                hx * (w / 2 + this.offset),
                hy * (h / 2 + this.offset),
            );
            obj.setPosition(p.x, p.y).setRotation(this.rect.rotation);
        };

        this.scaleIndicators.forEach((o, i) => place(o, ...this.scaleDirs[i]));
        this.rotateIndicators.forEach((o, i) =>
            place(o, ...this.rotateDirs[i]),
        );

        const pw = this.localToWorld(
            this.pivotNorm.x * w,
            this.pivotNorm.y * h,
        );
        this.pivot.copy(pw);
        this.pivotIndicator.setPosition(pw.x, pw.y);
        this.onChange?.(this);
    }

    // ---------- setters used by the inspector ----------

    // ---------- bone attachment ----------

    /** Make `bone` control this rect. The rect stays where it is; it follows the bone in pose mode. */
    attach(bone: Bone) {
        if (this.parentBone) this.parentBone.removeAttachment(this);
        this.parentBone = bone;
        bone.addAttachment(this);
        this.syncLocal();
    }

    /** Stop following the bone; the rect stays where it is. */
    detach() {
        if (!this.parentBone) return;
        this.parentBone.removeAttachment(this);
        this.parentBone = null;
        this.onChange?.(this);
    }

    /** entering pose mode: remember the setup placement and bind to the bone's setup transform */
    enterPose() {
        if (!this.parentBone) return;
        this.setupPose = {
            x: this.rect.x,
            y: this.rect.y,
            rot: this.rect.rotation,
        };
        this.syncLocal(); // the bone is still in its setup pose here
    }

    /** back to setup mode: put the rect back where it was placed in setup */
    exitPose() {
        const sp = this.setupPose;
        if (!sp) return;
        this.setupPose = null;
        this.rect.setPosition(sp.x, sp.y);
        this.rect.setRotation(sp.rot);
        this.updateHandles();
    }

    /** lock / unlock editing (locked while posing) */
    setLocked(v: boolean) {
        this.locked = v;
        this.drag = null;
        if (this.mode === null) return;
        this.hideAll();
        if (!v) {
            if (this.click === 0) this.unhideScaleIndicator();
            else this.unhideRotateIndicator();
        }
    }

    /** store position/rotation relative to the bone's pivot + angle */
    private syncLocal() {
        const b = this.parentBone;
        if (!b) return;
        const a = b.angle;
        const c = Math.cos(a);
        const s = Math.sin(a);
        const dx = this.rect.x - b.pivot.x;
        const dy = this.rect.y - b.pivot.y;
        this.localX = dx * c + dy * s;
        this.localY = -dx * s + dy * c;
        this.localRot = this.rect.rotation - a;
    }

    /** called by the bone (pose mode only) whenever it moves or rotates */
    followBone() {
        const b = this.parentBone;
        if (!b) return;
        const a = b.angle;
        const c = Math.cos(a);
        const s = Math.sin(a);
        this.rect.setPosition(
            b.pivot.x + this.localX * c - this.localY * s,
            b.pivot.y + this.localX * s + this.localY * c,
        );
        this.rect.setRotation(a + this.localRot);
        this.updateHandles();
    }

    get visible() {
        return !this.hidden;
    }

    // ---------- undo / redo support ----------

    snapshot(): RectState {
        const sp = this.setupPose;
        return {
            id: this.id,
            name: this.name,
            hidden: this.hidden,
            parentBone: this.parentBone ? this.parentBone.id : null,
            x: sp ? sp.x : this.rect.x,
            y: sp ? sp.y : this.rect.y,
            rot: sp ? sp.rot : this.rect.rotation,
            scaleX: this.rect.scaleX,
            scaleY: this.rect.scaleY,
            pivotX: this.pivotNorm.x,
            pivotY: this.pivotNorm.y,
            color: this.rect.fillColor,
        };
    }

    /** put saved numbers back (hierarchy is handled by the caller; call in setup mode) */
    restore(s: Omit<RectState, "id" | "parentBone">) {
        this.name = s.name;
        this.rect
            .setPosition(s.x, s.y)
            .setRotation(s.rot)
            .setScale(s.scaleX, s.scaleY)
            .setFillStyle(s.color);
        this.pivotNorm.set(s.pivotX, s.pivotY);
        this.hidden = s.hidden;
        this.rect.setVisible(this.alive && !s.hidden);
        if (s.hidden) this.deselect();
        this.updateHandles();
    }

    /** take the rect out of the scene (it can be revived later) */
    kill() {
        if (!this.alive) return;
        this.alive = false;
        this.deselect();
        this.rect.setVisible(false);
    }

    revive() {
        if (this.alive) return;
        this.alive = true;
        this.rect.setVisible(!this.hidden);
    }

    /** rename (empty names are ignored) */
    setName(v: string) {
        const n = v.trim();
        if (!n || n === this.name) return;
        this.name = n;
        this.onChange?.(this);
    }

    /** show / hide the rect (a hidden rect is deselected and can't be clicked) */
    setVisible(v: boolean) {
        this.hidden = !v;
        this.rect.setVisible(v);
        if (!v) this.deselect();
        this.onChange?.(this);
    }

    get selected() {
        return this.mode !== null;
    }

    select() {
        if (this.mode === null) this.handleClicks();
    }

    /** move the rect's center */
    setPosition(x: number, y: number) {
        if (this.locked) return;
        this.rect.setPosition(x, y);
        this.updateHandles();
    }

    setSize(w: number, h: number) {
        if (this.locked) return;
        this.rect.setScale(
            Math.max(this.minSize, w) / this.rect.width,
            Math.max(this.minSize, h) / this.rect.height,
        );
        this.updateHandles();
    }

    /** rotate to an absolute angle (degrees), turning around the pivot */
    setRotationDeg(deg: number) {
        if (this.locked) return;
        const delta = PMath.DegToRad(deg) - this.rect.rotation;
        const pv = this.pivot.clone();
        const dx = this.rect.x - pv.x;
        const dy = this.rect.y - pv.y;
        const cos = Math.cos(delta);
        const sin = Math.sin(delta);
        this.rect.setPosition(
            pv.x + dx * cos - dy * sin,
            pv.y + dx * sin + dy * cos,
        );
        this.rect.rotation += delta;
        this.updateHandles();
    }

    /** world position of the pivot */
    setPivotWorld(x: number, y: number) {
        if (this.locked) return;
        const local = this.worldToLocal(x, y);
        this.pivotNorm.set(
            local.x / this.rect.displayWidth,
            local.y / this.rect.displayHeight,
        );
        this.updateHandles();
    }

    setColor(color: number) {
        this.rect.setFillStyle(color);
        this.onChange?.(this);
    }

    /** layer depth (used by the layers list); handles stay just above their own layer */
    setLayer(depth: number) {
        this.rect.setDepth(depth);
        this.scaleIndicators.forEach((o) => o.setDepth(depth + 5));
        this.rotateIndicators.forEach((o) => o.setDepth(depth + 5));
        this.pivotIndicator.setDepth(depth + 6);
    }

    // ---------- interaction ----------

    handleClicks() {
        if (this.hidden || !this.alive) return;
        if (Rect.group.size) Rect.setGroup([]); // picking one rect leaves the group
        this.clicks++;
        const click = this.clicks % 2;
        this.click = click;
        this.hideAll();
        // locked (pose mode): still selectable, but no handles to edit with
        if (click === 0) {
            this.mode = "scale";
            if (!this.locked) this.unhideScaleIndicator();
        } else {
            this.mode = "rotate";
            if (!this.locked) this.unhideRotateIndicator();
        }
        this.onSelect?.(true);
    }

    private onMove(p: Phaser.Input.Pointer) {
        if (!this.drag || this.locked) return;
        if (this.drag.type === "move") this.doMove(this.drag, p);
        else if (this.drag.type === "scale")
            this.doScale(this.drag.hx, this.drag.hy, p);
        else if (this.drag.type === "rotate") this.doRotate(p);
        else if (this.drag.type === "pivot") this.doPivot(p);
        this.updateHandles();
    }

    private snapPt(x: number, y: number, p: Phaser.Input.Pointer) {
        const ctrl = (p.event as MouseEvent | undefined)?.ctrlKey ?? false;
        if (!this.grid || !(ctrl || this.snapAlways)) return { x, y };
        return { x: this.grid.snap(x), y: this.grid.snap(y) };
    }

    /** Drag the whole rect (after a small threshold so clicks still register). */
    private doMove(
        d: Extract<Drag, { type: "move" }>,
        p: Phaser.Input.Pointer,
    ) {
        // only movable while selected (or while in a box-selected group)
        if (this.mode === null && !Rect.group.has(this)) return;
        if (!d.moved) {
            if (Math.hypot(p.worldX - d.startX, p.worldY - d.startY) < 4)
                return;
            d.moved = true;
        }
        const s = this.snapPt(p.worldX + d.offX, p.worldY + d.offY, p);
        const dx = s.x - this.rect.x;
        const dy = s.y - this.rect.y;
        this.rect.setPosition(s.x, s.y); // snaps the rect's center
        // the rest of the group moves by the same amount
        if (Rect.group.has(this))
            for (const o of Rect.group)
                if (o !== this) o.setPosition(o.rect.x + dx, o.rect.y + dy);
    }

    /** Scale from a handle; the opposite edge/corner stays fixed. */
    private doScale(hx: number, hy: number, p: Phaser.Input.Pointer) {
        const w = this.rect.displayWidth;
        const h = this.rect.displayHeight;
        const t = this.snapPt(p.worldX, p.worldY, p);
        const local = this.worldToLocal(t.x, t.y);

        let newW = w;
        let newH = h;
        let shiftX = 0;
        let shiftY = 0;

        if (hx !== 0) {
            // anchor (fixed side) is at -hx * w/2 in local space
            newW = Math.max(this.minSize, (local.x + (hx * w) / 2) * hx);
            shiftX = (hx * (newW - w)) / 2;
        }
        if (hy !== 0) {
            newH = Math.max(this.minSize, (local.y + (hy * h) / 2) * hy);
            shiftY = (hy * (newH - h)) / 2;
        }

        // move center (using the OLD size/transform), then apply new scale
        const c = this.localToWorld(shiftX, shiftY);
        this.rect.setPosition(c.x, c.y);
        this.rect.setScale(newW / this.rect.width, newH / this.rect.height);
    }

    /** Rotate the rect around the pivot's world position. */
    private doRotate(p: Phaser.Input.Pointer) {
        if (!this.drag || this.drag.type !== "rotate") return;
        const pv = this.pivot.clone(); // pivot stays fixed in world space
        const angle = Math.atan2(p.worldY - pv.y, p.worldX - pv.x);
        const delta = angle - this.drag.lastAngle;
        this.drag.lastAngle = angle;

        const dx = this.rect.x - pv.x;
        const dy = this.rect.y - pv.y;
        const cos = Math.cos(delta);
        const sin = Math.sin(delta);
        this.rect.setPosition(
            pv.x + dx * cos - dy * sin,
            pv.y + dx * sin + dy * cos,
        );
        this.rect.rotation += delta;
    }

    /** Drag the pivot anywhere (inside or outside the rect). */
    private doPivot(p: Phaser.Input.Pointer) {
        const t = this.snapPt(p.worldX, p.worldY, p);
        const local = this.worldToLocal(t.x, t.y);
        this.pivotNorm.set(
            local.x / this.rect.displayWidth,
            local.y / this.rect.displayHeight,
        );
    }

    // ---------- visibility ----------

    hideAll() {
        for (const s of this.scaleIndicators) s.setVisible(false);
        for (const r of this.rotateIndicators) r.setVisible(false);
        this.pivotIndicator.setVisible(false);
    }
    unhideScaleIndicator() {
        this.updateHandles();
        for (const s of this.scaleIndicators) s.setVisible(true);
        this.pivotIndicator.setVisible(true);
    }
    unhideRotateIndicator() {
        this.updateHandles();
        for (const r of this.rotateIndicators) r.setVisible(true);
        this.pivotIndicator.setVisible(true);
    }
}

