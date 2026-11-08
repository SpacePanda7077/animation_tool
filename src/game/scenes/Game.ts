import { Events, Scene } from "phaser";
import { EventBus } from "../EventBus";
import { ObjectBuilder } from "../game-components/objects/object-builder";
import { EventHandler } from "../game-components/EventHandler/EventHandler";
import { Grid } from "../game-components/grid";
import { history } from "../game-components/history";
import { animation } from "../game-components/animation";
import { IKConstraint, addIKFromSelection } from "../game-components/ik";
import { useObjectsStore } from "../../store/object-store";
import { Rect } from "../game-components/objects/objetcs/Rect";
import { BoxSelect } from "../game-components/box-select";

export class Game extends Scene {
    objectBuilder: ObjectBuilder;
    EventHandler: EventHandler;
    grid: Grid;
    private unsubMode: (() => void) | null = null;
    private boxSelect: BoxSelect | null = null;

    constructor() {
        super("Game");
    }

    preload() {
        this.load.setPath("assets");

        this.load.image("star", "star.png");
        this.load.image("background", "bg.png");
        this.load.image("logo", "logo.png");
    }

    /** Hold the middle mouse button and drag to pan the camera (the grid follows the camera by itself). */
    setupCameraPan() {
        let panning = false;
        let lastX = 0;
        let lastY = 0;

        this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
            if (((p.event as MouseEvent).button ?? 0) !== 1) return;
            panning = true;
            lastX = p.x;
            lastY = p.y;
        });
        this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
            if (!panning) return;
            // button released outside the canvas, or released while the page didn't see it
            if (!((p.event as MouseEvent).buttons & 4)) {
                panning = false;
                return;
            }
            const cam = this.cameras.main;
            cam.scrollX -= (p.x - lastX) / cam.zoom;
            cam.scrollY -= (p.y - lastY) / cam.zoom;
            lastX = p.x;
            lastY = p.y;
        });
        const stop = () => (panning = false);
        this.input.on("pointerup", stop);
        this.input.on("pointerupoutside", stop);

        // stop the browser's middle-click auto-scroll circle from appearing
        const canvas = this.game.canvas;
        const block = (e: MouseEvent) => {
            if (e.button === 1) e.preventDefault();
        };
        canvas.addEventListener("mousedown", block);
        this.events.once("shutdown", () =>
            canvas.removeEventListener("mousedown", block),
        );
    }

    create() {
        this.cameras.main.centerOn(0, 0);
        // in your scene's create()
        this.grid = new Grid(this, { backgroundColor: 0x393939 });

        // snapping, e.g. while dragging a rect or bone pivot
        // this.grid.snapPoint(pos);      // snaps { x, y } to the finest visible lines
        // this.grid.snap(value);         // snaps a single number

        this.setupCameraPan();

        this.objectBuilder = new ObjectBuilder(this, this.grid);
        this.EventHandler = new EventHandler(this.objectBuilder);
        this.EventHandler.handleEvents();
        this.boxSelect = new BoxSelect(this);
        animation.init(this, this.objectBuilder);
        history.init(this, this.objectBuilder);

        // IK: create from UI, refresh handles on mode change
        EventBus.on("add-ik", () => {
            const ik = addIKFromSelection(this);
            if (ik) {
                useObjectsStore.getState().bump();
            }
        });
        EventBus.on("delete-ik", (id: string) => {
            const c = IKConstraint.all.find((x) => x.id === id);
            c?.destroy();
            useObjectsStore.getState().bump();
        });
        this.unsubMode = useObjectsStore.subscribe((s, prev) => {
            if (s.mode !== prev.mode) IKConstraint.refreshAll();
        });

        EventBus.emit("current-scene-ready", this);

        const cleanup = () => {
            this.EventHandler.destroy();
            this.boxSelect?.destroy();
            this.boxSelect = null;
            Rect.setGroup([]);
            animation.destroy();
            history.destroy();
            IKConstraint.destroyAll();
            EventBus.off("add-ik");
            EventBus.off("delete-ik");
            this.unsubMode?.();
            this.unsubMode = null;
        };
        this.events.on("shutdown", cleanup);
        this.events.on("destroy", cleanup);
    }
}
