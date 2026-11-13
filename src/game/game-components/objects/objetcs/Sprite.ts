import { Scene, GameObjects, Geom } from "phaser";
import { Rect, type RectState } from "./Rect";
import type { sprite_config } from "../configuration";

/** everything a rect remembers, plus which image it shows (used by undo / redo and duplicate) */
export type SpriteState = RectState & { texture: string };

/**
 * A picture you can place, scale, rotate and attach to a bone, exactly like a Rect.
 *
 * It IS a Rect: an invisible rectangle does all the editing (handles, pivot, dragging, bone following, box select,
 * layers, undo / redo) and the image is simply kept on top of it. Every change to the rectangle goes through
 * updateHandles(), which is where the image catches up.
 */
export class Sprite extends Rect {
    /** the picture; it copies the position / rotation / size / depth / visibility of the invisible rectangle */
    image: GameObjects.Image;
    /** key of the Phaser texture (= the image's file name); this is also the name written to the export */
    textureKey: string;

    /** true = clicks pass through the see-through parts of an image (to whatever is below it) */
    static pixelPicking = true;

    constructor(scene: Scene, config: sprite_config) {
        // Rect's constructor already calls updateHandles(); syncImage() ignores that call because there is no image yet
        super(scene, {
            x: config.x,
            y: config.y,
            width: config.width,
            height: config.height,
            color: 0xffffff,
        });
        this.textureKey = config.texture;
        this.name = config.name ?? config.texture;

        // invisible, but still there to be clicked
        this.rect.setFillStyle(0xffffff, 0);

        this.image = scene.add.image(config.x, config.y, config.texture);
        this.syncImage();

        // pixel-perfect picking: only the visible part of the picture can be clicked
        const input = this.rect.input;
        if (input) {
            input.hitAreaCallback = (
                area: Geom.Rectangle,
                x: number,
                y: number,
            ) =>
                Geom.Rectangle.Contains(area, x, y) &&
                (!Sprite.pixelPicking || this.opaqueAt(x, y));
        }
    }

    /** x, y are in the rectangle's own (unscaled) space; a few pixels of slack so tiny images stay easy to grab */
    private opaqueAt(x: number, y: number): boolean {
        try {
            const tex = this.scene.textures;
            const frame = tex.getFrame(this.textureKey);
            if (!frame) return true;
            const sx = frame.width / this.rect.width;
            const sy = frame.height / this.rect.height;
            const tx = Math.floor(x * sx);
            const ty = Math.floor(y * sy);
            const d = 2;
            for (const [ox, oy] of [
                [0, 0],
                [d, 0],
                [-d, 0],
                [0, d],
                [0, -d],
            ]) {
                const a = tex.getPixelAlpha(tx + ox, ty + oy, this.textureKey);
                if (a === null) return true; // can't read pixels: behave like a plain rectangle
                if (a > 10) return true;
            }
            return false;
        } catch {
            return true;
        }
    }

    /** put the image where the rectangle is */
    private syncImage() {
        const img = this.image;
        if (!img) return;
        const r = this.rect;
        img.setPosition(r.x, r.y)
            .setRotation(r.rotation)
            .setDisplaySize(r.displayWidth, r.displayHeight)
            .setDepth(r.depth)
            .setVisible(this.alive && !this.hidden);
    }

    /** change the image (the size stays as it is) */
    setTexture(key: string) {
        if (key === this.textureKey) return;
        this.textureKey = key;
        this.image.setTexture(key);
        this.syncImage();
        this.onChange?.(this);
    }

    // ---------- keep the image in step with the rectangle ----------

    updateHandles() {
        super.updateHandles();
        this.syncImage();
    }

    setLayer(depth: number) {
        super.setLayer(depth);
        this.syncImage();
    }

    setVisible(v: boolean) {
        super.setVisible(v);
        this.syncImage();
    }

    kill() {
        super.kill();
        this.syncImage();
    }

    revive() {
        super.revive();
        this.syncImage();
    }

    /** sprites have no fill color (the rectangle must stay invisible) */
    setColor(_color: number) {
        void _color;
    }

    // ---------- undo / redo support ----------

    snapshot(): SpriteState {
        return { ...super.snapshot(), texture: this.textureKey };
    }

    restore(s: Omit<RectState, "id" | "parentBone"> & { texture?: string }) {
        super.restore(s); // this also gives the rectangle a fill again...
        this.rect.setFillStyle(0xffffff, 0); // ...so take it away
        if (s.texture && s.texture !== this.textureKey) {
            this.textureKey = s.texture;
            this.image.setTexture(s.texture);
        }
        this.syncImage();
    }
}
