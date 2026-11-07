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
 *  - Parts (the rectangles) are listed in draw order, BACK to FRONT.
 *    A part with a bone is placed relative to that bone (x/y in the bone's rotated frame), a free part is in world space.
 *    The size is the final size (scale already applied); the rectangle is centred on its x/y.
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

export type ExportPart = {
    name: string;
    type: "rect";
    /** name of the controlling bone, null = free (world space) */
    bone: string | null;
    x: number;
    y: number;
    rotation: number;
    width: number;
    height: number;
    /** "#rrggbb" */
    color: string;
    visible: boolean;
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
};
