import { Cameras, GameObjects, Scene, Scenes } from "phaser";

export interface GridConfig {
    /** world size of one main cell at the base level (default 100) */
    unit?: number;
    /** how many smaller cells fit in one bigger cell (default 10, like Blender) */
    subdivisions?: number;
    /** camera to follow (default: scene main camera) */
    camera?: Cameras.Scene2D.Camera;
    lineColor?: number;
    /** alpha of the faintest visible lines / the strongest lines */
    minorAlpha?: number;
    majorAlpha?: number;
    /** X axis = horizontal line at y=0 (red), Y axis = vertical line at x=0 (green) */
    showAxes?: boolean;
    axisXColor?: number;
    axisYColor?: number;
    depth?: number;
    /** optionally set the camera background (Blender-ish dark grey is 0x393939) */
    backgroundColor?: number;
}

/**
 * Blender-style infinite grid.
 *  - Lines fade in/out as you zoom, with `subdivisions` smaller cells inside each bigger cell.
 *  - Red X axis / green Y axis through the origin.
 *  - Only redraws when you zoom or pan out of the already drawn area (cheap).
 *  - snap() / snapPoint() snap to the finest grid lines that are currently visible.
 */
export class Grid {
    scene: Scene;
    camera: Cameras.Scene2D.Camera;
    graphics: GameObjects.Graphics;

    unit: number;
    subdivisions: number;
    lineColor: number;
    minorAlpha: number;
    majorAlpha: number;
    showAxes: boolean;
    axisXColor: number;
    axisYColor: number;

    /** smallest spacing (world units) that is currently drawn; used for snapping */
    snapStep: number;

    private minPx = 6; // lines closer than this (on screen) are not drawn
    private drawn = { left: 0, top: 0, right: 0, bottom: 0 };
    private lastKey = "";

    constructor(scene: Scene, config: GridConfig = {}) {
        this.scene = scene;
        this.camera = config.camera ?? scene.cameras.main;
        this.unit = config.unit ?? 100;
        this.subdivisions = Math.max(2, Math.floor(config.subdivisions ?? 10));
        this.lineColor = config.lineColor ?? 0xaaaaaa;
        this.minorAlpha = config.minorAlpha ?? 0.15;
        this.majorAlpha = config.majorAlpha ?? 0.5;
        this.showAxes = config.showAxes ?? true;
        this.axisXColor = config.axisXColor ?? 0xdd3b3b;
        this.axisYColor = config.axisYColor ?? 0x6fc03a;
        this.snapStep = this.unit / this.subdivisions;

        if (config.backgroundColor !== undefined) {
            this.camera.setBackgroundColor(config.backgroundColor);
        }

        this.graphics = scene.add.graphics().setDepth(config.depth ?? -1000);

        scene.events.on(Scenes.Events.POST_UPDATE, this.update, this);
        scene.events.once(Scenes.Events.SHUTDOWN, this.destroy, this);
        this.update();
    }

    // ---------- public helpers ----------

    setVisible(v: boolean) {
        this.graphics.setVisible(v);
        return this;
    }

    toggle() {
        return this.setVisible(!this.graphics.visible);
    }

    /** Snap one value to the finest visible grid line (or to a custom step). */
    snap(v: number, step = this.snapStep) {
        return Math.round(v / step) * step;
    }

    snapPoint<T extends { x: number; y: number }>(
        p: T,
        step = this.snapStep,
    ): T {
        p.x = this.snap(p.x, step);
        p.y = this.snap(p.y, step);
        return p;
    }

    /** Force a redraw on the next update. */
    redraw() {
        this.lastKey = "";
    }

    destroy() {
        this.scene.events.off(Scenes.Events.POST_UPDATE, this.update, this);
        this.graphics.destroy();
    }

    // ---------- drawing ----------

    private ramp(x: number, a: number, b: number) {
        return Math.min(1, Math.max(0, (x - a) / (b - a)));
    }

    /** Spacing on screen -> alpha. Bigger spacing = stronger line, so every level looks different. */
    private alphaFor(px: number) {
        return (
            this.minorAlpha * this.ramp(px, this.minPx, 20) +
            (this.majorAlpha - this.minorAlpha) * this.ramp(px, 30, 300)
        );
    }

    private update() {
        const cam = this.camera;
        const zoom = cam.zoomX;
        const vw = cam.width / zoom;
        const vh = cam.height / cam.zoomY;
        const left = cam.scrollX + cam.width / 2 - vw / 2;
        const top = cam.scrollY + cam.height / 2 - vh / 2;
        const right = left + vw;
        const bottom = top + vh;

        const key = `${zoom}|${cam.width}|${cam.height}`;
        const d = this.drawn;
        const inside =
            left >= d.left &&
            top >= d.top &&
            right <= d.right &&
            bottom <= d.bottom;
        if (key === this.lastKey && inside) return;
        this.lastKey = key;

        // draw one extra screen of margin on every side so panning doesn't redraw every frame
        d.left = left - vw;
        d.right = right + vw;
        d.top = top - vh;
        d.bottom = bottom + vh;

        this.draw(zoom);
    }

    private draw(zoom: number) {
        const g = this.graphics;
        const { left, top, right, bottom } = this.drawn;
        const sub = this.subdivisions;
        const base = this.unit / sub; // finest possible step at level 0
        const lineW = 1 / zoom; // always 1 screen pixel thick

        g.clear();

        // first level whose lines are at least minPx apart on screen
        // (can be negative when zoomed in, which just means finer than the base step)
        const level = Math.ceil(
            Math.log(this.minPx / (base * zoom)) / Math.log(sub),
        );

        const maxSpan = Math.max(right - left, bottom - top);
        this.snapStep = base * Math.pow(sub, level);

        // levels from fine to coarse; each line is drawn once, at its coarsest level
        const steps: number[] = [];
        for (let l = level; ; l++) {
            const step = base * Math.pow(sub, l);
            steps.push(step);
            if (step > maxSpan || steps.length > 8) break;
        }

        steps.forEach((step, idx) => {
            const alpha = this.alphaFor(step * zoom);
            if (alpha <= 0.001) return;
            const isTop = idx === steps.length - 1;

            g.lineStyle(lineW, this.lineColor, alpha);
            g.beginPath();

            const i0x = Math.ceil(left / step);
            const i1x = Math.floor(right / step);
            for (let i = i0x; i <= i1x; i++) {
                if (!isTop && i % sub === 0) continue; // belongs to the next, coarser level
                const x = i * step;
                g.moveTo(x, top);
                g.lineTo(x, bottom);
            }
            const i0y = Math.ceil(top / step);
            const i1y = Math.floor(bottom / step);
            for (let i = i0y; i <= i1y; i++) {
                if (!isTop && i % sub === 0) continue;
                const y = i * step;
                g.moveTo(left, y);
                g.lineTo(right, y);
            }
            g.strokePath();
        });

        if (this.showAxes) {
            g.lineStyle(2 / zoom, this.axisXColor, 0.9);
            g.beginPath();
            g.moveTo(left, 0);
            g.lineTo(right, 0);
            g.strokePath();

            g.lineStyle(2 / zoom, this.axisYColor, 0.9);
            g.beginPath();
            g.moveTo(0, top);
            g.lineTo(0, bottom);
            g.strokePath();
        }
    }
}
