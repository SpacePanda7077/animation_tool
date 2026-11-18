import { Display } from "phaser";
import { EventBus } from "../../EventBus";
import { type ObjectBuilder } from "../objects/object-builder";
import { duplicateSelection } from "../objects/duplicate";
import { loadImageFile } from "../objects/objetcs/sprite-texture";
import { Sprite } from "../objects/objetcs/Sprite";
import { Mesh } from "../objects/objetcs/Mesh";
import { Bone } from "../objects/objetcs/Bone";
import { useObjectsStore } from "../../../store/object-store";

export class EventHandler {
    objectBuilder: ObjectBuilder;
    constructor(objectBuilder: ObjectBuilder) {
        this.objectBuilder = objectBuilder;
    }

    // kept as fields so destroy() can remove exactly these listeners
    private onAddRect = () => this.addRect();
    private onAddSprite = (file: File) => void this.addSprite(file);
    private onAddBone = () => this.addBone();
    private onDuplicate = () => this.duplicate();
    private onConvertToMesh = () => this.convertSelectedToMesh();
    private onKey = (e: KeyboardEvent) => {
        // Shift+D = duplicate
        if (
            e.shiftKey &&
            !e.ctrlKey &&
            !e.metaKey &&
            e.key.toLowerCase() === "d"
        ) {
            e.preventDefault();
            this.duplicate();
            return;
        }
        // M = convert selected Sprite → Mesh (setup mode only)
        if (
            !e.shiftKey &&
            !e.ctrlKey &&
            !e.metaKey &&
            e.key.toLowerCase() === "m"
        ) {
            e.preventDefault();
            this.convertSelectedToMesh();
        }
    };

    handleEvents() {
        EventBus.on("add_rect", this.onAddRect);
        EventBus.on("add_sprite", this.onAddSprite);
        EventBus.on("add_bone", this.onAddBone);
        EventBus.on("duplicate", this.onDuplicate);
        EventBus.on("convert_to_mesh", this.onConvertToMesh);
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
    /** an image file picked in the toolbar -> a sprite in the middle of the scene */
    async addSprite(file: File) {
        if (useObjectsStore.getState().mode !== "setup") return;
        try {
            const img = await loadImageFile(this.objectBuilder.scene, file);
            // the mode may have changed while the file was being read
            if (useObjectsStore.getState().mode !== "setup") return;
            this.objectBuilder.sprite({
                x: 0,
                y: 0,
                width: img.width,
                height: img.height,
                texture: img.key,
                name: img.name,
            });
        } catch (err) {
            console.error("[sprite] could not add the image", err);
        }
    }
    addBone() {
        if (useObjectsStore.getState().mode !== "setup") return;
        this.objectBuilder.bone();
    }
    duplicate() {
        duplicateSelection(this.objectBuilder);
    }

    /**
     * Convert the currently selected Sprite into a skinned Mesh (4×4 grid).
     * Also runs auto-weight against all bones currently in the scene.
     */
    convertSelectedToMesh() {
        if (useObjectsStore.getState().mode !== "setup") return;
        const selected = useObjectsStore.getState().selected;
        if (!(selected instanceof Sprite)) return;

        const mesh = this.objectBuilder.spriteToMesh(selected, 4, 4);

        // Auto-weight against every bone
        const bones = [...Bone.all].filter((b) => b.alive);
        if (bones.length > 0) {
            mesh.autoWeight(bones, 2);
        }
    }

    destroy = () => {
        EventBus.off("add_rect", this.onAddRect);
        EventBus.off("add_sprite", this.onAddSprite);
        EventBus.off("add_bone", this.onAddBone);
        EventBus.off("duplicate", this.onDuplicate);
        EventBus.off("convert_to_mesh", this.onConvertToMesh);
        this.objectBuilder.scene.input?.keyboard?.off("keydown", this.onKey);
    };
}

