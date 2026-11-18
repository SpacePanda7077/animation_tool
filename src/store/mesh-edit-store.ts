import { create } from "zustand";
import type {
    Mesh,
    PaintMode,
} from "../game/game-components/objects/objetcs/Mesh";

export type MeshTool = "vertices" | "weights";

/** the mesh that is being edited on the canvas, and the settings of the tools */
type mesh_edit_store_type = {
    /** null = not editing a mesh */
    target: Mesh | null;
    tool: MeshTool;
    /** brush radius, in screen pixels (it keeps its size when you zoom) */
    brush: number;
    /** how much one dab changes a weight, 0..1 */
    strength: number;
    paint: PaintMode;

    begin: (mesh: Mesh, tool: MeshTool) => void;
    end: () => void;
    setTool: (tool: MeshTool) => void;
    setBrush: (px: number) => void;
    setStrength: (s: number) => void;
    setPaint: (p: PaintMode) => void;
};

export const useMeshEditStore = create<mesh_edit_store_type>()((set) => ({
    target: null,
    tool: "weights",
    brush: 40,
    strength: 0.15,
    paint: "add",

    begin: (mesh, tool) => set({ target: mesh, tool }),
    end: () => set({ target: null }),
    setTool: (tool) => set({ tool }),
    setBrush: (px) => set({ brush: Math.max(5, Math.min(300, px)) }),
    setStrength: (s) => set({ strength: Math.max(0.01, Math.min(1, s)) }),
    setPaint: (paint) => set({ paint }),
}));
