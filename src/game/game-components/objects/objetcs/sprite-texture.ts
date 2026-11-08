import type { Scene } from "phaser";

/** the longest side (world units) of a freshly imported image; it keeps its proportions, resize it afterwards */
const MAX_START_SIZE = 300;

/** file (name + size + date) -> texture key, so importing the same file twice shares one texture */
const known = new Map<string, string>();

export type LoadedImage = {
    /** Phaser texture key = the file name (made unique if two different files share a name) */
    key: string;
    /** file name without the extension, used as the sprite's layer name */
    name: string;
    /** size to start at */
    width: number;
    height: number;
};

/** Read an image file the user picked and add it to the scene's textures. */
export function loadImageFile(scene: Scene, file: File): Promise<LoadedImage> {
    const sig = `${file.name}|${file.size}|${file.lastModified}`;

    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () =>
                reject(
                    new Error(
                        `${file.name} is not an image the browser can open`,
                    ),
                );
            img.onload = () => {
                if (!scene.textures) {
                    reject(
                        new Error(
                            "The scene was closed before the image finished loading",
                        ),
                    );
                    return;
                }

                let key = known.get(sig);
                if (!key || !scene.textures.exists(key)) {
                    key = file.name;
                    for (let i = 2; scene.textures.exists(key); i++)
                        key = `${file.name} ${i}`;
                    scene.textures.addImage(key, img);
                    known.set(sig, key);
                }

                const w = img.naturalWidth;
                const h = img.naturalHeight;
                const fit = Math.min(1, MAX_START_SIZE / Math.max(w, h));
                resolve({
                    key,
                    name: file.name.replace(/\.[^.]+$/, "") || file.name,
                    width: Math.max(10, Math.round(w * fit)),
                    height: Math.max(10, Math.round(h * fit)),
                });
            };
            img.src = reader.result as string;
        };
        reader.readAsDataURL(file);
    });
}
