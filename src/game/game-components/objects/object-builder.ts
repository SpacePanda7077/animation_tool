import { Scene } from "phaser";
import { rect_config } from "./configuration";
import { Rect } from "./objetcs/Rect";
import { Bone } from "./objetcs/Bone";
import { Grid } from "../grid";
import { useObjectsStore } from "../../../store/object-store";

export class ObjectBuilder {
    scene: Scene;
    grid: Grid;
    constructor(scene: Scene, grid: Grid) {
        this.scene = scene;
        this.grid = grid;
        Bone.grid = this.grid;

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

    rect(config: rect_config) {
        const rect = new Rect(this.scene, config);
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
        const objects = useObjectsStore.getState().objects;
        const new_obj = [obj, ...objects];
        useObjectsStore.getState().setObjects(new_obj);
    }
}
