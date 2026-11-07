import { Display } from "phaser";
import { EventBus } from "../../EventBus";
import { type ObjectBuilder } from "../objects/object-builder";
import { duplicateSelection } from "../objects/duplicate";
import { useObjectsStore } from "../../../store/object-store";

export class EventHandler {
    objectBuilder: ObjectBuilder;
    constructor(objectBuilder: ObjectBuilder) {
        this.objectBuilder = objectBuilder;
    }

    // kept as fields so destroy() can remove exactly these listeners
    private onAddRect = () => this.addRect();
    private onAddBone = () => this.addBone();
    private onDuplicate = () => this.duplicate();
    private onKey = (e: KeyboardEvent) => {
        // Shift+D = duplicate
        if (e.shiftKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "d") {
            e.preventDefault();
            this.duplicate();
        }
    };

    handleEvents() {
        EventBus.on("add_rect", this.onAddRect);
        EventBus.on("add_bone", this.onAddBone);
        EventBus.on("duplicate", this.onDuplicate);
        this.objectBuilder.scene.input.keyboard?.on("keydown", this.onKey);
    }

    addRect() {
        if (useObjectsStore.getState().mode !== "setup") return;
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
        if (useObjectsStore.getState().mode !== "setup") return;
        this.objectBuilder.bone();
    }
    duplicate() {
        duplicateSelection(this.objectBuilder);
    }

    destroy = () => {
        EventBus.off("add_rect", this.onAddRect);
        EventBus.off("add_bone", this.onAddBone);
        EventBus.off("duplicate", this.onDuplicate);
        this.objectBuilder.scene.input?.keyboard?.off("keydown", this.onKey);
    };
}
