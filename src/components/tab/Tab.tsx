import { useRef } from "react";
import { EventBus } from "../../game/EventBus";
import { useObjectsStore } from "../../store/object-store";
import { history, useHistoryStore } from "../../game/game-components/history";

export default function Tab() {
    const mode = useObjectsStore((s) => s.mode);
    const setMode = useObjectsStore((s) => s.setMode);
    const resetPose = useObjectsStore((s) => s.resetPose);
    const setup = mode === "setup";
    const canUndo = useHistoryStore((s) => s.canUndo);
    const canRedo = useHistoryStore((s) => s.canRedo);
    const hasSelection = useObjectsStore((s) => s.selected) !== null;

    const handle_add_rect = () => {
        EventBus.emit("add_rect");
    };
    const fileInput = useRef<HTMLInputElement>(null);
    const handle_add_sprite = () => fileInput.current?.click();
    const handle_sprite_files = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? []);
        e.target.value = ""; // so picking the same file again still fires
        files.forEach((f) => EventBus.emit("add_sprite", f));
    };
    const handle_add_bone = () => {
        EventBus.emit("add_bone");
    };
    const handle_duplicate = () => {
        EventBus.emit("duplicate");
    };

    const modeButton = (m: "setup" | "pose", label: string) => (
        <button
            onClick={() => setMode(m)}
            className={[
                "px-2 py-1 rounded text-sm cursor-pointer",
                mode === m
                    ? "bg-[#ffd54f] text-black"
                    : "bg-[#4c4747] text-white hover:bg-[#5d5757]",
            ].join(" ")}
        >
            {label}
        </button>
    );

    const small = (enabled: boolean) =>
        [
            "px-2 py-1 rounded text-sm bg-[#4c4747] text-white",
            enabled ? "cursor-pointer hover:bg-[#5d5757]" : "opacity-40",
        ].join(" ");

    const addClass = (enabled: boolean) =>
        enabled ? "cursor-pointer text-left" : "text-left opacity-40";

    return (
        <>
            <div className="absolute top-0 left-0 h-full ml-2 flex justify-center items-center ">
                <div className="bg-[#2e2c2c] w-full p-3 h-[99%] rounded-lg flex flex-col border-2 border-[#878080] gap-5">
                    <div className="flex flex-col gap-1">
                        {modeButton("setup", "Setup")}
                        {modeButton("pose", "Pose")}
                    </div>
                    <div className="flex flex-col gap-1">
                        <button
                            title="Ctrl+Z"
                            disabled={!canUndo}
                            onClick={() => history.undo()}
                            className={small(canUndo)}
                        >
                            undo
                        </button>
                        <button
                            title="Ctrl+Shift+Z / Ctrl+Y"
                            disabled={!canRedo}
                            onClick={() => history.redo()}
                            className={small(canRedo)}
                        >
                            redo
                        </button>
                    </div>
                    <button
                        onClick={handle_add_rect}
                        disabled={!setup}
                        className={addClass(setup)}
                    >
                        square
                    </button>
                    <button
                        title="Add one or more images as sprites"
                        onClick={handle_add_sprite}
                        disabled={!setup}
                        className={addClass(setup)}
                    >
                        sprite
                    </button>
                    <input
                        ref={fileInput}
                        type="file"
                        accept="image/*"
                        multiple
                        hidden
                        onChange={handle_sprite_files}
                    />
                    <button
                        onClick={handle_add_bone}
                        disabled={!setup}
                        className={addClass(setup)}
                    >
                        bone
                    </button>
                    <button
                        title="Shift+D: copies the selected rectangle or sprite, or the selected bones with their children and attached rectangles / sprites"
                        onClick={handle_duplicate}
                        disabled={!setup || !hasSelection}
                        className={addClass(setup && hasSelection)}
                    >
                        duplicate
                    </button>
                    {!setup && (
                        <button
                            onClick={resetPose}
                            className="text-left cursor-pointer text-sm"
                        >
                            reset pose
                        </button>
                    )}
                </div>
            </div>
        </>
    );
}
