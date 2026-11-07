import { Scene, GameObjects, Input, Math as PMath } from "phaser";
import type { Grid } from "../../grid";
import { IKConstraint } from "../../ik";

/**
 * setup = build the skeleton: bones can move, change length and change hierarchy,
 *         attached objects stay where they are (they don't follow the bones).
 * pose  = bones can only rotate and move (length is locked, no hierarchy edits),
 *         attached objects follow their bones.
 */
export type BoneMode = "setup" | "pose";

/** plain-data copy of everything that defines a bone (used by undo / redo) */
export type BoneState = {
    id: string;
    name: string;
    hidden: boolean;
    parent: string | null;
    children: string[];
    connected: boolean;
    baseX: number;
    baseY: number;
    offX: number;
    offY: number;
    rel: number;
    length: number;
    poseRel: number;
    poseX: number;
    poseY: number;
};

/** Anything that can follow a bone: Rect now, a Sprite/Image class later. */
export interface BoneAttachment {
    /** called (in pose mode only) every time the bone moves / rotates; update your world transform from the bone */
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

    /** current mode for every bone; switch it through the store's setMode so objects get prepared too */
    static mode: BoneMode = "setup";

    /** never changes (used as React key / drag identity), unlike `name` */
    readonly id = `bone-${++Bone.count}`;
    /** shown in the layers list and the inspector; rename with setName */
    name = `Bone ${Bone.count}`;
    /** things (rects, images...) that follow this bone */
    attachments: BoneAttachment[] = [];
    /** hidden bones are not drawn and can't be selected */
    hidden = false;
    /** false = removed from the scene (e.g. undo of a create), kept around so redo can bring it back */
    alive = true;

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

    /** setup position of a ROOT bone's pivot (world). Child bones get theirs from the parent. */
    baseX = 0;
    baseY = 0;

    /**
     * Pose offsets, only applied in pose mode (setup values are never touched by posing):
     * poseRel = extra rotation, poseX/poseY = extra translation (parent's frame, world for a root).
     */
    poseRel = 0;
    poseX = 0;
    poseY = 0;

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
        this.baseX = x;
        this.baseY = y;
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
                if (!this.isSelected || !this.canMovePivot) return;
                // IK-driven bones cannot be moved manually in pose mode
                if (this.posing && IKConstraint.isLocked(this)) return;
                const { x, y } = Bone.snapPoint(rawX, rawY, p);
                this.movePivotTo(x, y);
                // After moving a bone that is an IK chain root / parent, re-sync IKs
                if (this.posing) IKConstraint.syncAll();
            },
        );

        // dragging the pole controls the angle, and the length too (setup mode only)
        this.poll.on("drag", (p: Input.Pointer) => {
            if (!this.isSelected) return;
            // IK-driven bones cannot be rotated manually in pose mode
            if (this.posing && IKConstraint.isLocked(this)) return;
            const t = Bone.snapPoint(p.worldX, p.worldY, p);
            const dx = t.x - this.pivot.x;
            const dy = t.y - this.pivot.y;
            if (!this.posing)
                this.length = Math.max(this.minLength, Math.hypot(dx, dy));
            this.angle = Math.atan2(dy, dx);
            this.layout();
            if (this.posing) IKConstraint.syncAll();
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
        const base = this.parent ? this.parent.angle : 0;
        return base + this.relEff;
    }
    /** in setup mode this edits the setup angle, in pose mode only the pose offset */
    set angle(v: number) {
        const r = v - (this.parent ? this.parent.angle : 0);
        if (this.posing) this.poseRel = r - this.rel;
        else this.rel = r;
    }

    get posing() {
        return Bone.mode === "pose";
    }

    /** angle relative to the parent as it is right now (setup + pose offset when posing) */
    get relEff(): number {
        return this.rel + (this.posing ? this.poseRel : 0);
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

    // ---------- undo / redo support ----------

    snapshot(): BoneState {
        return {
            id: this.id,
            name: this.name,
            hidden: this.hidden,
            parent: this.parent ? this.parent.id : null,
            children: this.children.filter((c) => c.alive).map((c) => c.id),
            connected: this.connected,
            baseX: this.baseX,
            baseY: this.baseY,
            offX: this.offX,
            offY: this.offY,
            rel: this.rel,
            length: this.length,
            poseRel: this.poseRel,
            poseX: this.poseX,
            poseY: this.poseY,
        };
    }

    /** put the saved numbers + hierarchy back (call layout() on the roots afterwards) */
    restore(s: BoneState, get: (id: string) => Bone | undefined) {
        this.name = s.name;
        this.hidden = s.hidden;
        this.connected = s.connected;
        this.baseX = s.baseX;
        this.baseY = s.baseY;
        this.offX = s.offX;
        this.offY = s.offY;
        this.rel = s.rel;
        this.length = s.length;
        this.poseRel = s.poseRel;
        this.poseX = s.poseX;
        this.poseY = s.poseY;
        this.parent = s.parent ? (get(s.parent) ?? null) : null;
        this.children = s.children
            .map(get)
            .filter((c): c is Bone => c !== undefined);
        if (this.alive) {
            this.graphics.setVisible(!this.hidden);
            this.body.setVisible(!this.hidden);
        }
    }

    /** take the bone out of the scene (it can be revived later) */
    kill() {
        if (!this.alive) return;
        this.alive = false;
        if (this.isSelected) {
            const rest = [...Bone.selection].filter((b) => b !== this);
            Bone.setSelection(
                rest,
                Bone.active === this
                    ? (rest[rest.length - 1] ?? null)
                    : Bone.active,
            );
        }
        this.graphics.setVisible(false);
        this.body.setVisible(false);
        this.pivot.setVisible(false);
        this.poll.setVisible(false);
    }

    revive() {
        if (this.alive) return;
        this.alive = true;
        this.graphics.setVisible(!this.hidden);
        this.body.setVisible(!this.hidden);
        this.refresh();
    }

    /** rename (empty names are ignored) */
    setName(v: string) {
        const n = v.trim();
        if (!n || n === this.name) return;
        this.name = n;
        Bone.onChange?.(this);
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

    /** setup: root bones and offset children can be moved. pose: every bone can be moved (except IK-locked). */
    get canMovePivot() {
        if (this.posing && IKConstraint.isLocked(this)) return false;
        return this.posing || !this.parent || !this.connected;
    }

    /** length can only change in setup mode */
    setLength(v: number) {
        if (this.posing) return;
        this.length = Math.max(this.minLength, v);
        this.layout();
    }

    /** world angle in degrees */
    setAngleDeg(deg: number) {
        if (this.posing && IKConstraint.isLocked(this)) return;
        this.angle = PMath.DegToRad(deg);
        this.layout();
        if (this.posing) IKConstraint.syncAll();
    }

    /** angle relative to the parent in degrees (same as world angle for a root bone) */
    setRelativeAngleDeg(deg: number) {
        if (this.posing && IKConstraint.isLocked(this)) return;
        const r = PMath.DegToRad(deg);
        if (this.posing) this.poseRel = r - this.rel;
        else this.rel = r;
        this.layout();
        if (this.posing) IKConstraint.syncAll();
    }

    /** world position of the pivot */
    setPivot(x: number, y: number) {
        if (!this.canMovePivot) return;
        this.movePivotTo(x, y);
    }

    /**
     * Move the pivot to a world position.
     * setup: changes the setup pose (root: base position, offset child: offset from the parent).
     * pose:  changes only the pose translation, the setup pose stays as it was.
     */
    private movePivotTo(wx: number, wy: number) {
        const p = this.parent;
        if (this.posing) {
            if (!p) {
                this.poseX = wx - this.baseX;
                this.poseY = wy - this.baseY;
            } else {
                const pa = p.angle;
                const c = Math.cos(pa);
                const s = Math.sin(pa);
                const ax = this.connected ? p.poll.x : p.pivot.x;
                const ay = this.connected ? p.poll.y : p.pivot.y;
                const dx = wx - ax;
                const dy = wy - ay;
                const lx = dx * c + dy * s;
                const ly = -dx * s + dy * c;
                this.poseX = lx - (this.connected ? 0 : this.offX);
                this.poseY = ly - (this.connected ? 0 : this.offY);
            }
        } else if (!p) {
            this.baseX = wx;
            this.baseY = wy;
        } else if (!this.connected) {
            const pa = p.angle;
            const dx = wx - p.pivot.x;
            const dy = wy - p.pivot.y;
            this.offX = dx * Math.cos(pa) + dy * Math.sin(pa);
            this.offY = -dx * Math.sin(pa) + dy * Math.cos(pa);
        } else {
            return; // connected pivots are glued to the parent's tip
        }
        this.layout();
    }

    /** forget the pose of this bone (back to the setup pose) */
    resetPose() {
        this.poseRel = 0;
        this.poseX = 0;
        this.poseY = 0;
    }

    /** Create a connected child at this bone's tip (continuing in the same direction) and select it. */
    extrude() {
        if (Bone.mode !== "setup") return null;
        const child = this.createChild();
        Bone.setSelection([child]);
        return child;
    }

    /** E: extrude from every selected bone; the new bones become the selection. */
    static extrudeSelected() {
        if (Bone.mode !== "setup") return;
        const kids = [...Bone.selection].map((b) => b.createChild());
        if (kids.length) Bone.setSelection(kids);
    }

    /**
     * Ctrl+K: parent every other selected bone to the active bone, KEEPING OFFSET:
     * they stay exactly where they are, but from now on follow the active bone.
     */
    static parentSelectedToActive() {
        if (Bone.mode !== "setup") return;
        const target = Bone.active;
        if (!target) return;
        for (const b of Bone.selection) b.parentTo(target);
        Bone.onStructureChange?.();
    }

    /**
     * Make this bone a child of `target`, KEEPING OFFSET (it stays where it is and follows `target` from now on).
     * Returns false when nothing changed (not in setup mode, onto itself, or it would make a cycle).
     */
    parentTo(target: Bone): boolean {
        if (Bone.mode !== "setup") return false;
        if (this === target || target.isDescendantOf(this)) return false; // no cycles

        const worldAngle = this.angle;
        const pa = target.angle;
        const dx = this.pivot.x - target.pivot.x;
        const dy = this.pivot.y - target.pivot.y;

        if (this.parent)
            this.parent.children = this.parent.children.filter(
                (c) => c !== this,
            );
        this.parent = target;
        target.children.push(this);

        this.connected = false;
        this.resetPose();
        this.offX = dx * Math.cos(pa) + dy * Math.sin(pa);
        this.offY = -dx * Math.sin(pa) + dy * Math.cos(pa);
        this.angle = worldAngle; // keep the same world angle
        this.layout();
        return true;
    }

    /** Ctrl+D: detach selected bones from their parent. They stay put and start their own hierarchy. */
    static disconnectSelected() {
        for (const b of Bone.selection) b.disconnect();
    }

    /** Cut this bone (and its own children) out of the hierarchy so it becomes the root of its own. */
    disconnect() {
        const p = this.parent;
        if (!p || this.posing) return;
        const worldAngle = this.angle; // read while the parent still exists
        p.children = p.children.filter((c) => c !== this);
        this.parent = null;
        this.connected = true;
        this.offX = 0;
        this.offY = 0;
        this.baseX = this.pivot.x; // a root's position is stored in base, so keep where it is now
        this.baseY = this.pivot.y;
        this.resetPose();
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
        const pose = this.posing;
        const p = this.parent;
        if (p) {
            // anchor = parent's tip (connected) or parent's pivot (offset); then add offset + pose translation
            const pa = p.angle;
            const c = Math.cos(pa);
            const s = Math.sin(pa);
            const ax = this.connected ? p.poll.x : p.pivot.x;
            const ay = this.connected ? p.poll.y : p.pivot.y;
            const lx =
                (this.connected ? 0 : this.offX) + (pose ? this.poseX : 0);
            const ly =
                (this.connected ? 0 : this.offY) + (pose ? this.poseY : 0);
            this.pivot.setPosition(ax + lx * c - ly * s, ay + lx * s + ly * c);
        } else {
            this.pivot.setPosition(
                this.baseX + (pose ? this.poseX : 0),
                this.baseY + (pose ? this.poseY : 0),
            );
        }
        const a = this.angle;
        this.poll.setPosition(
            this.pivot.x + Math.cos(a) * this.length,
            this.pivot.y + Math.sin(a) * this.length,
        );
        this.drawBone();
        // attached objects only follow the bone in pose mode
        if (pose) for (const a of this.attachments) a.followBone();
        for (const c of this.children) c.layoutTree();
    }

    /** Show handles only while selected. */
    refresh() {
        const s = this.isSelected && !this.hidden && this.alive;
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

