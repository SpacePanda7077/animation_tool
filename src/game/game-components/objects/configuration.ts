export type rect_config = {
    x: number;
    y: number;
    width: number;
    height: number;
    color: number;
    options?: {
        stroke?: boolean;
        strokeWidth?: number;
    };
};

export type sprite_config = {
    x: number;
    y: number;
    /** size it is shown at (the picture is stretched to it) */
    width: number;
    height: number;
    /** key of a texture that is already loaded (see sprite-textures.ts) */
    texture: string;
    /** layer name, defaults to the texture key */
    name?: string;
};
