import { Scene } from "phaser";
import { rect_config, sprite_config } from "./configuration";
import { Rect } from "./objetcs/Rect";
import { Sprite } from "./objetcs/Sprite";
import { Mesh, type mesh_config } from "./objetcs/Mesh";
import { Bone } from "./objetcs/Bone";
import { Grid } from "../grid";
import { useObjectsStore, type Obj } from "../../../store/object-store";

export class ObjectBuilder {
    scene: Scene;
    grid: Grid;
    /** every object ever made in this scene (also removed ones), so undo / redo can bring the same instance back */
    registry = new Map<string, Obj>();
    constructor(scene: Scene, grid: Grid) {
        this.scene = scene;
        this.grid = grid;
        Bone.grid = this.grid;

        // fresh start for this scene (static / store state outlives a restarted game)
        Bone.mode = "setup";
        Bone.selection.clear();
        Bone.active = null;
        useObjectsStore.setState({
            objects: [],
            selected: null,
            mode: "setup",
        });

        // keep the React inspector in sync with bone changes / selection / hierarchy
        Bone.onChange = () => useObjectsStore.getState().bump();
        Bone.onSelectionChange = (active) => {
            const s = useObjectsStore.getState();
            if (active) s.setSelected(active);
            else if (s.selected instanceof Bone) s.setSelected(null);
        };
        // every bone (also ones made with E) is registered itself
        Bone.onCreate = (bone) => this.addToObjects(bone);
        Bone.onStructureChange = () =>
            useObjectsStore.getState().refreshLayers();
    }

    rect(config: rect_config): Rect {
        const rect = new Rect(this.scene, config);
        this.register(rect);
        return rect;
    }

    /** a picture (the texture must already be loaded, see sprite-textures.ts) */
    sprite(config: sprite_config): Sprite {
        const sprite = new Sprite(this.scene, config);
        this.register(sprite);
        return sprite;
    }

    /**
     * A skinned mesh (grid of vertices that can be weighted to multiple bones).
     * Texture must already be loaded. Default subdivision is 4×4.
     */
    mesh(config: mesh_config): Mesh {
        const mesh = new Mesh(this.scene, config);
        this.register(mesh);
        return mesh;
    }

    /**
     * Convert an existing Sprite into a Mesh (same texture, size, placement).
     * The original Sprite is removed from the scene and the new Mesh takes its place.
     */
    spriteToMesh(sprite: Sprite, cols = 4, rows = 4): Mesh {
        const parent = sprite.parentBone;
        // detach first so the bone no longer drives the old sprite
        if (parent) sprite.detach();

        const mesh = this.mesh({
            x: sprite.rect.x,
            y: sprite.rect.y,
            width: sprite.rect.displayWidth,
            height: sprite.rect.displayHeight,
            texture: sprite.textureKey,
            name: sprite.name,
            cols,
            rows,
        });
        if (parent) mesh.attach(parent);

        // remove the old sprite from the scene and the object list
        sprite.kill();
        // also hide its Image
        if (sprite.image) sprite.image.setVisible(false);
        const objects = useObjectsStore
            .getState()
            .objects.filter((o) => o !== sprite);
        useObjectsStore.getState().setObjects(objects);
        useObjectsStore.getState().setSelected(mesh);
        return mesh;
    }

    /** hook a new rect / sprite / mesh up to the grid, the inspector and the object list */
    private register(rect: Rect) {
        rect.grid = this.grid;

        rect.onChange = () => useObjectsStore.getState().bump();
        rect.onSelect = (selected) => {
            const s = useObjectsStore.getState();
            if (selected) s.setSelected(rect);
            else if (s.selected === rect) s.setSelected(null);
        };

        this.addToObjects(rect);
    }

    bone() {
        new Bone(this.scene); // adds itself to the store through Bone.onCreate
    }

    addToObjects(obj: Rect | Bone) {
        this.registry.set(obj.id, obj);
        const objects = useObjectsStore.getState().objects;
        const new_obj = [obj, ...objects];
        useObjectsStore.getState().setObjects(new_obj);
    }
}
