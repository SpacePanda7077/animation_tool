/**
 * The exported file ("animation_tool" JSON, version 1).
 *
 *  - Angles are RADIANS, positions are world units (pixels), time is in FRAMES (see `fps` for seconds).
 *  - Bones are listed parents first, so one pass in order is enough to compute every world transform.
 *  - Everything refers to bones by NAME (names are made unique on export).
 *  - A bone's setup transform is relative to its parent (world for a root bone).
 *  - Animation keys are POSE OFFSETS added on top of the bone's setup transform:
 *        local.x        = bone.x + key.x
 *        local.y        = bone.y + key.y
 *        local.rotation = bone.rotation + key.rotation
 *    A bone without keys keeps its setup transform.
 *  - Parts (rectangles and sprites) are listed in draw order, BACK to FRONT.
 *    A part with a bone is placed relative to that bone (x/y in the bone's rotated frame), a free part is in world space.
 *    The size is the final size (scale already applied); the part is centred on its x/y.
 *    A sprite is its image stretched to that size, so draw it with that display size, not its natural size.
 */
export type ExportInterp = "linear" | "smooth" | "step";

export type ExportBone = {
    name: string;
    /** name of the parent bone, null for a root bone */
    parent: string | null;
    length: number;
    /** setup position: relative to the parent's pivot, in the parent's rotated frame (world for a root).
     *  A connected bone sits on its parent's tip: x = parent.length, y = 0. */
    x: number;
    y: number;
    /** setup rotation relative to the parent (world for a root) */
    rotation: number;
    /** true = the bone starts at its parent's tip (informational, x / y already say it) */
    connected: boolean;
};

/** one bone influence on a mesh vertex (weights should sum to ~1) */
export type ExportVertexWeight = {
    /** bone name (same names as in `bones`) */
    bone: string;
    weight: number;
};

/** one vertex of a skinned mesh, in pixels relative to the mesh center at the setup pose */
export type ExportMeshVertex = {
    x: number;
    y: number;
    u: number;
    v: number;
    weights: ExportVertexWeight[];
};

export type ExportPart = {
    name: string;
    /** "rect" = coloured rectangle, "sprite" = picture, "mesh" = skinned mesh */
    type: "rect" | "sprite" | "mesh";
    /** sprites and meshes: the image file name as it was imported */
    image?: string;
    /** name of the controlling bone (hierarchy parent), null = free (world space).
     *  For meshes this is only the overall transform parent; deformation uses `vertices[].weights`. */
    bone: string | null;
    x: number;
    y: number;
    rotation: number;
    width: number;
    height: number;
    /** "#rrggbb" (sprites/meshes have no fill, they always say "#ffffff") */
    color: string;
    visible: boolean;
    /** meshes only: vertices in pixels, relative to the part's center (x right, y down), at the setup pose */
    vertices?: ExportMeshVertex[];
    /** meshes only: triangle indices (flat list, 3 per triangle) */
    indices?: number[];
};

/**
 * A 2-bone IK constraint (a leg, an arm). Animations do NOT key it: they play as ordinary bone keys.
 * In the game you drive it from code (target position, optional pole, weight), and it overrides the two bones.
 */
export type ExportIK = {
    name: string;
    /** the upper bone (thigh / upper arm) */
    boneA: string;
    /** the lower bone (shin / forearm); its parent is boneA */
    boneB: string;
    /** which way the middle joint (knee / elbow) bends: the side of the root -> target line the pole was on, 1 or -1 */
    bend: 1 | -1;
    /** name of the target object in the editor ("Left leg target"); older files don't have it, then it is "<name> target" */
    target?: string;
    /** name of the pole object in the editor ("Left leg pole") */
    pole?: string;
};

export type ExportKey = {
    frame: number;
    /** frame / fps */
    time: number;
    /** pose offsets on top of the bone's setup transform */
    rotation: number;
    x: number;
    y: number;
    /** how the value moves from this key to the next one */
    interp: ExportInterp;
};

export type ExportAnimation = {
    fps: number;
    /** last frame (frames run 0..end) */
    end: number;
    /** end / fps */
    duration: number;
    loop: boolean;
    /** true = a key on every frame, so only linear blending is needed to play it back */
    baked: boolean;
    /** keys per bone name, sorted by frame */
    bones: Record<string, ExportKey[]>;
};

export type ExportData = {
    format: "animation_tool";
    version: 1;
    units: { angle: "radians"; position: "pixels"; time: "frames" };
    bones: ExportBone[];
    /** draw order, back to front */
    parts: ExportPart[];
    animations: Record<string, ExportAnimation>;
    /** IK constraints (missing when the scene has none) */
    ik?: ExportIK[];
};
