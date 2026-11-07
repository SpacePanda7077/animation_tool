import { Events, Scene } from "phaser";
import { EventBus } from "../EventBus";
import { ObjectBuilder } from "../game-components/objects/object-builder";
import { EventHandler } from "../game-components/EventHandler/EventHandler";
import { Grid } from "../game-components/grid";
import { history } from "../game-components/history";

export class Game extends Scene {
    objectBuilder: ObjectBuilder;
    EventHandler: EventHandler;
    grid: Grid;
    constructor() {
        super("Game");
    }

    preload() {
        this.load.setPath("assets");

        this.load.image("star", "star.png");
        this.load.image("background", "bg.png");
        this.load.image("logo", "logo.png");
    }

    create() {
        this.cameras.main.centerOn(0, 0);
        // in your scene's create()
        this.grid = new Grid(this, { backgroundColor: 0x393939 });

        // snapping, e.g. while dragging a rect or bone pivot
        // this.grid.snapPoint(pos);      // snaps { x, y } to the finest visible lines
        // this.grid.snap(value);         // snaps a single number

        this.objectBuilder = new ObjectBuilder(this, this.grid);
        this.EventHandler = new EventHandler(this.objectBuilder);
        this.EventHandler.handleEvents();
        history.init(this, this.objectBuilder);
        EventBus.emit("current-scene-ready", this);

        const cleanup = () => {
            this.EventHandler.destroy();
            history.destroy();
        };
        this.events.on("shutdown", cleanup);
        this.events.on("destroy", cleanup);
    }
}
