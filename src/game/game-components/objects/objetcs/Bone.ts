import { Scene, GameObjects, Input, Math as PMath } from "phaser";
import type { Grid } from "../../grid";

/** Anything that can follow a bone: Rect now, a Sprite/Image class later. */
export interface BoneAttachment {
    /** called every time the bone moves / rotates; update your world transform from the bone */
    followBone(): void;
}

export class Bone {
    /** All selected bones (Shift+click to add more). Edits apply to bones in here. */
    static selection = new Set<Bone>();
    /** The active bone = the last one you selected. Ctrl+K parents the others to it. */
    static active: Bone | null = null;
    private static readyScenes = new WeakSet<Scene>();

    /** Set this to a Grid to enable snapping: hold Ctrl while dragging a pivot or pole. */
    static grid: Grid | null = null;
    /** true = always snap (Ctrl then does nothing) */
    static snapAlways = false;

    /** UI hooks: called when the active bone changes / when any bone's numbers change */
    static onSelectionChange: ((active: Bone | null) => void) | null = null;
    static onChange: ((bone: Bone) => void) | null = null;
    /** a bone was created (root bones and extruded ones) */
    static onCreate: ((bone: Bone) => void) | null = null;
    /** the hierarchy changed (Ctrl+K / Ctrl+D) */
    static onStructureChange: (() => void) | null = null;
    private static count = 0;
    /** bones are always drawn in front of everything (they don't take part in layering) */
    static readonly DEPTH = 100000;

    readonly type = "Bone";
    readonly name = `Bone ${++Bone.count}`;
    /** things (rects, images...) that follow this bone */
    attachments: BoneAttachment[] = [];
    /** hidden bones are not drawn and can't be selected */
    hidden = false;

    private static snapPoint(x: number, y: number, p: Input.Pointer) {
        const ctrl = (p.event as MouseEvent | undefined)?.ctrlKey ?? false;
        if (!Bone.grid || !(ctrl || Bone.snapAlways)) return { x, y };
        return { x: Bone.grid.snap(x), y: Bone.grid.snap(y) };
    }

    scene: Scene;
    graphics: GameObjects.Graphics;
    body: GameObjects.Rectangle; // invisible hit area so the bone can be clicked
    pivot: GameObjects.Arc; // base of the bone
    poll: GameObjects.Arc; // tip of the bone (rotate + length handle)

    parent: Bone | null;
    children: Bone[] = [];

    /**
     * true  = pivot is glued to the parent's tip (what E creates)
     * false = pivot keeps an offset from the parent (Ctrl+K "keep offset", or after Ctrl+D)
     */
    connected = true;
    /** pivot offset in the parent's frame (origin = parent pivot, rotated with the parent) */
    offX = 0;
    offY = 0;

    length: number;
    minLength = 10;

    /** angle relative to the parent (or the world angle for a root bone) */
    rel = 0;

    constructor(
        scene: Scene,
        x = 0,
        y = 0,
        length = 100,
        parent: Bone | null = null,
    ) {
        this.scene = scene;
        this.length = length;
        this.parent = parent;
        if (parent) parent.children.push(this);

        this.graphics = scene.add.graphics().setDepth(Bone.DEPTH);

        this.body = scene.add
            .rectangle(x, y, 100, 14, 0xffffff)
            .setDepth(Bone.DEPTH + 1)
            .setAlpha(0.001)
            .setInteractive()
            .setData("bone", this)
            .on("pointerdown", (p: Input.Pointer) =>
                Bone.click(this, (p.event as MouseEvent).shiftKey),
            );

        this.pivot = scene.add
            .circle(x, y, 6, 0xfff000)
            .setDepth(Bone.DEPTH + 5)
            .setInteractive()
            .setData("bone", this);

        this.poll = scene.add
            .circle(x + length, y, 4, 0xff0000)
            .setDepth(Bone.DEPTH + 5)
            .setInteractive()
            .setData("bone", this);

        scene.input.setDraggable([this.pivot, this.poll]);

        this.pivot.on(
            "drag",
            (p: Input.Pointer, rawX: number, rawY: number) => {
                if (!this.isSelected) return;
                const { x: dragX, y: dragY } = Bone.snapPoint(rawX, rawY, p);
                if (!this.parent) {
                    // root: move the whole chain
                    this.pivot.setPosition(dragX, dragY);
                } else if (!this.connected) {
                    // offset child: change its offset from the parent
                    const pa = this.parent.angle;
                    const dx = dragX - this.parent.pivot.x;
                    const dy = dragY - this.parent.pivot.y;
                    this.offX = dx * Math.cos(pa) + dy * Math.sin(pa);
                    this.offY = -dx * Math.sin(pa) + dy * Math.cos(pa);
                } else {
                    return; // connected pivots are glued to the parent's tip
                }
                this.layout();
            },
        );

        // dragging the pole controls BOTH the angle and the length
        this.poll.on("drag", (p: Input.Pointer) => {
            if (!this.isSelected) return;
            const t = Bone.snapPoint(p.worldX, p.worldY, p);
            const dx = t.x - this.pivot.x;
            const dy = t.y - this.pivot.y;
            this.length = Math.max(this.minLength, Math.hypot(dx, dy));
            this.angle = Math.atan2(dy, dx);
            this.layout();
        });

        Bone.initScene(scene);
        this.layout();
        if (!parent) Bone.setSelection([this]);
        Bone.onCreate?.(this);
    }

    addAttachment(a: BoneAttachment) {
        if (!this.attachments.includes(a)) this.attachments.push(a);
    }

    removeAttachment(a: BoneAttachment) {
        this.attachments = this.attachments.filter((x) => x !== a);
    }

    // ---------- angle (world) ----------

    /** World angle in radians (0 = pointing right). Children inherit their parent's rotation. */
    get angle(): number {
        return this.parent ? this.parent.angle + this.rel : this.rel;
    }
    set angle(v: number) {
        this.rel = this.parent ? v - this.parent.angle : v;
    }

    get angleDeg() {
        return PMath.RadToDeg(this.angle);
    }

    get isSelected() {
        return Bone.selection.has(this);
    }

    get isActive() {
        return Bone.active === this;
    }

    isDescendantOf(other: Bone) {
        for (let p = this.parent; p; p = p.parent) if (p === other) return true;
        return false;
    }

    // ---------- selection ----------

    static setSelection(
        bones: Bone[],
        active: Bone | null = bones[bones.length - 1] ?? null,
    ) {
        const touched = new Set<Bone>([...Bone.selection, ...bones]);
        Bone.selection = new Set(bones);
        Bone.active = active;
        touched.forEach((b) => b.refresh());
        Bone.onSelectionChange?.(Bone.active);
    }

    /** Click on a bone. Plain click = select only it, Shift+click = add / make active / remove. */
    static click(bone: Bone, shift: boolean) {
        if (!shift) {
            Bone.setSelection([bone]);
            return;
        }
        const list = [...Bone.selection];
        if (!Bone.selection.has(bone)) {
            Bone.setSelection([...list, bone], bone);
        } else if (Bone.active === bone) {
            const rest = list.filter((b) => b !== bone);
            Bone.setSelection(rest, rest[rest.length - 1] ?? null);
        } else {
            Bone.setSelection(list, bone);
        }
    }

    /** One-time (per scene) key + click-away handlers shared by all bones. */
    private static initScene(scene: Scene) {
        if (Bone.readyScenes.has(scene)) return;
        Bone.readyScenes.add(scene);

        scene.input.keyboard?.on("keydown", (e: KeyboardEvent) => {
            const ctrl = e.ctrlKey || e.metaKey;
            const key = e.key.toLowerCase();
            if (ctrl && key === "k") {
                e.preventDefault();
                Bone.parentSelectedToActive();
            } else if (ctrl && key === "d") {
                e.preventDefault();
                Bone.disconnectSelected();
            } else if (!ctrl && key === "e") {
                Bone.extrudeSelected();
            }
        });

        // clicking anything that isn't part of a bone deselects (unless Shift is held)
        scene.input.on(
            "pointerdown",
            (p: Input.Pointer, over: GameObjects.GameObject[]) => {
                if ((p.event as MouseEvent).shiftKey) return;
                if (!over.some((o) => o.getData("bone"))) Bone.setSelection([]);
            },
        );
    }

    // ---------- hierarchy operations ----------

    private createChild() {
        return new Bone(
            this.scene,
            this.poll.x,
            this.poll.y,
            this.length,
            this,
        );
    }

    // ---------- setters used by the inspector ----------

    select() {
        if (this.hidden) return;
        Bone.setSelection([this]);
    }

    get visible() {
        return !this.hidden;
    }

    /** show / hide the bone (a hidden bone is deselected and can't be clicked) */
    setVisible(v: boolean) {
        this.hidden = !v;
        this.graphics.setVisible(v);
        this.body.setVisible(v);
        if (!v && this.isSelected) {
            Bone.setSelection([...Bone.selection].filter((b) => b !== this));
        } else {
            this.refresh();
        }
        Bone.onChange?.(this);
    }

    /** root bones and offset children can be moved; a connected child is glued to its parent's tip */
    get canMovePivot() {
        return !this.parent || !this.connected;
    }

    setLength(v: number) {
        this.length = Math.max(this.minLength, v);
        this.layout();
    }

    /** world angle in degrees */
    setAngleDeg(deg: number) {
        this.angle = PMath.DegToRad(deg);
        this.layout();
    }

    /** angle relative to the parent in degrees (same as world angle for a root bone) */
    setRelativeAngleDeg(deg: number) {
        this.rel = PMath.DegToRad(deg);
        this.layout();
    }

    /** world position of the pivot */
    setPivot(x: number, y: number) {
        if (!this.parent) {
            this.pivot.setPosition(x, y);
        } else if (!this.connected) {
            const pa = this.parent.angle;
            const dx = x - this.parent.pivot.x;
            const dy = y - this.parent.pivot.y;
            this.offX = dx * Math.cos(pa) + dy * Math.sin(pa);
            this.offY = -dx * Math.sin(pa) + dy * Math.cos(pa);
        } else {
            return;
        }
        this.layout();
    }

    /** Create a connected child at this bone's tip (continuing in the same direction) and select it. */
    extrude() {
        const child = this.createChild();
        Bone.setSelection([child]);
        return child;
    }

    /** E: extrude from every selected bone; the new bones become the selection. */
    static extrudeSelected() {
        const kids = [...Bone.selection].map((b) => b.createChild());
        if (kids.length) Bone.setSelection(kids);
    }

    /**
     * Ctrl+K: parent every other selected bone to the active bone, KEEPING OFFSET:
     * they stay exactly where they are, but from now on follow the active bone.
     */
    static parentSelectedToActive() {
        const target = Bone.active;
        if (!target) return;
        for (const b of Bone.selection) {
            if (b === target || target.isDescendantOf(b)) continue; // no cycles

            const worldAngle = b.angle;
            const pa = target.angle;
            const dx = b.pivot.x - target.pivot.x;
            const dy = b.pivot.y - target.pivot.y;

            if (b.parent)
                b.parent.children = b.parent.children.filter((c) => c !== b);
            b.parent = target;
            target.children.push(b);

            b.connected = false;
            b.offX = dx * Math.cos(pa) + dy * Math.sin(pa);
            b.offY = -dx * Math.sin(pa) + dy * Math.cos(pa);
            b.angle = worldAngle; // keep the same world angle
            b.layout();
        }
        Bone.onStructureChange?.();
    }

    /** Ctrl+D: detach selected bones from their parent. They stay put and start their own hierarchy. */
    static disconnectSelected() {
        for (const b of Bone.selection) b.disconnect();
    }

    /** Cut this bone (and its own children) out of the hierarchy so it becomes the root of its own. */
    disconnect() {
        const p = this.parent;
        if (!p) return;
        const worldAngle = this.angle; // read while the parent still exists
        p.children = p.children.filter((c) => c !== this);
        this.parent = null;
        this.connected = true;
        this.offX = 0;
        this.offY = 0;
        this.angle = worldAngle; // no parent now, so rel becomes the world angle
        this.layout(); // pivot stays where it is; children follow
        Bone.onStructureChange?.();
    }

    // ---------- layout / drawing ----------

    /** Recompute positions from pivot + angle + length, lay out all children, tell the UI. */
    layout() {
        this.layoutTree();
        Bone.onChange?.(this);
    }

    private layoutTree() {
        const p = this.parent;
        if (p) {
            if (this.connected) {
                this.pivot.setPosition(p.poll.x, p.poll.y);
            } else {
                const pa = p.angle;
                const c = Math.cos(pa);
                const s = Math.sin(pa);
                this.pivot.setPosition(
                    p.pivot.x + this.offX * c - this.offY * s,
                    p.pivot.y + this.offX * s + this.offY * c,
                );
            }
        }
        const a = this.angle;
        this.poll.setPosition(
            this.pivot.x + Math.cos(a) * this.length,
            this.pivot.y + Math.sin(a) * this.length,
        );
        this.drawBone();
        for (const a of this.attachments) a.followBone();
        for (const c of this.children) c.layoutTree();
    }

    /** Show handles only while selected. */
    refresh() {
        const s = this.isSelected && !this.hidden;
        this.pivot.setVisible(s);
        this.poll.setVisible(s);
        this.drawBone();
    }

    drawBone() {
        const color = this.isActive
            ? 0xffd54f
            : this.isSelected
              ? 0xff9800
              : 0xffffff;
        this.graphics.clear();

        // relationship line for children that are not glued to the parent's tip
        if (this.parent && !this.connected) {
            this.graphics.lineStyle(1, 0x888888);
            this.graphics.beginPath();
            this.graphics.moveTo(this.pivot.x, this.pivot.y);
            this.graphics.lineTo(this.parent.pivot.x, this.parent.pivot.y);
            this.graphics.strokePath();
        }

        this.graphics.lineStyle(5, color);
        this.graphics.beginPath();
        this.graphics.moveTo(this.pivot.x, this.pivot.y);
        this.graphics.lineTo(this.poll.x, this.poll.y);
        this.graphics.strokePath();

        // keep the click area on top of the line
        this.body
            .setPosition(
                (this.pivot.x + this.poll.x) / 2,
                (this.pivot.y + this.poll.y) / 2,
            )
            .setRotation(this.angle)
            .setScale(this.length / 100, 1);
    }
}
