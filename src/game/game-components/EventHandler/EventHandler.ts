import { Display } from "phaser";
import { EventBus } from "../../EventBus";
import { type ObjectBuilder } from "../objects/object-builder";

export class EventHandler {
    objectBuilder: ObjectBuilder;
    constructor(objectBuilder: ObjectBuilder) {
        this.objectBuilder = objectBuilder;
    }
    handleEvents() {
        EventBus.on("add_rect", () => this.addRect());
        EventBus.on("add_bone", () => this.addBone());
    }

    addRect() {
        const color = Display.Color.RandomRGB().color;
        this.objectBuilder.rect({
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            color,
        });
    }
    addBone() {
        this.objectBuilder.bone();
    }

    destroy() {
        EventBus.off("add_rect");
    }
}
