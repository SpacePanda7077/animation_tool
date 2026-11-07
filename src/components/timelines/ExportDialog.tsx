import { useMemo, useState } from "react";
import {
    buildExport,
    downloadText,
    fileNameFor,
} from "../../export/export-animation";
import { useAnimationStore } from "../../game/game-components/animation";

/**
 * Export dialog: export all animations (or just the current one), with optional bake.
 * The editor is locked behind the backdrop, so the preview can't go stale while this is open.
 */
export default function ExportDialog({ onClose }: { onClose: () => void }) {
    const currentName = useAnimationStore((s) => s.currentName);
    const animations = useAnimationStore((s) => s.animations);
    const animNames = Object.keys(animations);
    const [mode, setMode] = useState<"all" | "current">("all");
    const [bake, setBake] = useState(false);
    const [copied, setCopied] = useState(false);

    const result = useMemo(
        () =>
            buildExport({
                name: mode === "current" ? currentName : undefined,
                bake,
            }),
        [mode, currentName, bake],
    );
    const { json, warnings, stats } = result;
    const fileName = fileNameFor(
        mode === "current" ? currentName : "animations",
    );

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(json);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            setCopied(false);
        }
    };

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            onMouseDown={onClose}
            // keys typed here must not reach Phaser (I, E, Space ...)
            onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") onClose();
            }}
        >
            <div
                className="w-[520px] max-w-[92vw] bg-[#2e2c2c] border-2 border-[#878080] rounded-lg p-4 flex flex-col gap-3 text-sm text-white"
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between">
                    <span className="font-semibold">Export animation</span>
                    <button
                        className="px-2 rounded bg-[#4c4747] hover:bg-[#5d5757] cursor-pointer"
                        onClick={onClose}
                    >
                        ✕
                    </button>
                </div>

                <div className="flex flex-col gap-1.5 text-xs text-[#b5b0b0]">
                    <label className="flex items-center gap-2 cursor-pointer">
                        <input
                            type="radio"
                            name="export-mode"
                            checked={mode === "all"}
                            onChange={() => setMode("all")}
                        />
                        <span>
                            All animations ({animNames.length})
                            <span className="text-[#878080]">
                                {" "}
                                — {animNames.join(", ")}
                            </span>
                        </span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                        <input
                            type="radio"
                            name="export-mode"
                            checked={mode === "current"}
                            onChange={() => setMode("current")}
                        />
                        <span>
                            Current only
                            <span className="text-[#878080]">
                                {" "}
                                — “{currentName}”
                            </span>
                        </span>
                    </label>
                </div>

                <label
                    className="flex items-start gap-2 text-xs text-[#b5b0b0] cursor-pointer"
                    title="Writes a key on every frame, so your game only needs linear blending"
                >
                    <input
                        type="checkbox"
                        checked={bake}
                        onChange={(e) => setBake(e.target.checked)}
                        className="mt-0.5"
                    />
                    <span>
                        Bake every frame
                        <span className="text-[#878080]">
                            {" "}
                            (a key on each frame; Smooth and Step then need no
                            support in your game, bigger file)
                        </span>
                    </span>
                </label>

                <div className="text-xs text-[#b5b0b0]">
                    {stats.animations} animation
                    {stats.animations !== 1 ? "s" : ""} · {stats.bones} bones ·{" "}
                    {stats.parts} rectangles · {stats.keys} keys ·{" "}
                    {stats.seconds.toFixed(2)}s total
                </div>

                {warnings.length > 0 && (
                    <ul className="text-xs text-[#ffd54f] list-disc pl-4 flex flex-col gap-0.5">
                        {warnings.map((w, i) => (
                            <li key={i}>{w}</li>
                        ))}
                    </ul>
                )}

                <pre className="max-h-44 overflow-auto bg-[#1f1d1d] rounded p-2 text-[11px] leading-snug text-[#b5b0b0] border border-[#5a5555]">
                    {json.length > 4000 ? json.slice(0, 4000) + "\n…" : json}
                </pre>

                <div className="flex items-center justify-end gap-2">
                    <button
                        className="px-3 py-1 rounded bg-[#4c4747] hover:bg-[#5d5757] cursor-pointer"
                        onClick={copy}
                    >
                        {copied ? "Copied" : "Copy JSON"}
                    </button>
                    <button
                        className="px-3 py-1 rounded bg-[#ffd54f] text-black cursor-pointer hover:brightness-110"
                        onClick={() => downloadText(json, fileName)}
                    >
                        Download {fileName}
                    </button>
                </div>
            </div>
        </div>
    );
}
