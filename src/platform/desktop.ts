/**
 * Desktop (Tauri) file access.
 *
 * Inside the Tauri app, files are saved and opened through native dialogs and the Rust-side
 * file plugin. In a plain browser none of this is used: the callers fall back to the browser's
 * own file APIs. The Tauri packages are imported lazily so the web build never loads them.
 */

/** true when running inside the Tauri desktop shell */
export const isDesktop = (): boolean =>
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type DesktopFile = {
    /** absolute path on disk */
    path: string;
    /** file name without the folder */
    name: string;
};

const JSON_FILTER = [{ name: "JSON", extensions: ["json"] }];

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * Write text to disk. With `path` it overwrites that file; without it, it shows a native
 * "Save As" dialog first. Returns the file written, or null if the user cancelled.
 */
export async function desktopSaveText(
    text: string,
    suggestedName: string,
    path?: string | null,
): Promise<DesktopFile | null> {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");

    const target =
        path ??
        (await save({
            defaultPath: suggestedName,
            filters: JSON_FILTER,
        }));
    if (!target) return null;

    await writeTextFile(target, text);
    return { path: target, name: baseName(target) };
}

/** Show a native "Open" dialog and read the chosen JSON file. null = cancelled. */
export async function desktopOpenText(): Promise<
    (DesktopFile & { text: string }) | null
> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readTextFile } = await import("@tauri-apps/plugin-fs");

    const picked = await open({
        multiple: false,
        directory: false,
        filters: JSON_FILTER,
    });
    if (!picked || Array.isArray(picked)) return null;

    const text = await readTextFile(picked);
    return { path: picked, name: baseName(picked), text };
}
