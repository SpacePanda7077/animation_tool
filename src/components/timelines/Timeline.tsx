import { useEffect, useRef, useState } from "react";
import { Bone } from "../../game/game-components/objects/objetcs/Bone";
import { useObjectsStore } from "../../store/object-store";
import {
    animation,
    keyId,
    useAnimationStore,
    type Interp,
} from "../../game/game-components/animation";
import ExportDialog from "./ExportDialog";

const NAME_W = 150; // width of the bone names column
const PAD = 14; // space left / right of the frame range
const ROW_H = 26;
const RULER_H = 26;

/** vertical tick for every frame, drawn with a gradient so 2000 frames cost nothing */
const ticks = (ppf: number, color: string) => ({
    backgroundImage: `repeating-linear-gradient(to right, ${color} 0 1px, transparent 1px ${ppf}px)`,
    backgroundPosition: `${PAD}px 0`,
});

export default function Timeline() {
    const mode = useObjectsStore((s) => s.mode);
    const objects = useObjectsStore((s) => s.objects);
    useObjectsStore((s) => s.version); // selection / names / hierarchy changes
    const { fps, end, frame, playing, loop, tracks, selected } =
        useAnimationStore();

    const [ppf, setPpf] = useState(14); // pixels per frame (Ctrl + wheel to zoom)
    const [dragDelta, setDragDelta] = useState(0);
    const [collapsed, setCollapsed] = useState(false);
    const [exporting, setExporting] = useState(false);

    const posing = mode === "pose";
    const cur = Math.round(frame);
    const scrollRef = useRef<HTMLDivElement>(null);
    const rulerRef = useRef<HTMLDivElement>(null);
    const scrubbing = useRef(false);
    const keyDrag = useRef<{ startX: number } | null>(null);

    // Ctrl + wheel = zoom (needs a non-passive listener to stop the page from zooming)
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            setPpf((p) =>
                Math.min(40, Math.max(4, p * (e.deltaY < 0 ? 1.1 : 0.9))),
            );
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, [collapsed]);

    // keep the playhead in view while playing
    useEffect(() => {
        const el = scrollRef.current;
        if (!el || !playing) return;
        const x = NAME_W + PAD + frame * ppf;
        if (x < el.scrollLeft + NAME_W || x > el.scrollLeft + el.clientWidth)
            el.scrollLeft = Math.max(0, x - NAME_W - 40);
    }, [frame, playing, ppf]);

    // one row per live bone, parents first
    const bones = objects.filter(
        (o): o is Bone => o instanceof Bone && o.alive,
    );
    const rows: { bone: Bone; depth: number }[] = [];
    const walk = (b: Bone, depth: number) => {
        rows.push({ bone: b, depth });
        b.children.filter((c) => c.alive).forEach((c) => walk(c, depth + 1));
    };
    [...bones]
        .reverse()
        .filter((b) => !b.parent)
        .forEach((b) => walk(b, 0));

    const selectedSet = new Set(selected);
    const firstSel = selected.length ? parseSel(selected[0]) : null;
    const selInterp: Interp =
        (firstSel &&
            tracks[firstSel.bone]?.find((k) => k.frame === firstSel.frame)
                ?.interp) ||
        "linear";

    const frameAt = (clientX: number, el: HTMLElement) =>
        Math.round((clientX - el.getBoundingClientRect().left - PAD) / ppf);

    const labelStep =
        [1, 2, 5, 10, 20, 50, 100, 200, 500].find((s) => s * ppf >= 44) ?? 500;
    const labels: number[] = [];
    for (let f = 0; f <= end; f += labelStep) labels.push(f);

    const areaW = PAD * 2 + end * ppf;

    return (
        <div
            className="absolute bottom-2 z-10"
            style={{ left: "8.5rem", right: "calc(20vw + 0.5rem)" }}
        >
            <div
                className="bg-[#2e2c2c] rounded-lg border-2 border-[#878080] flex flex-col overflow-hidden"
                style={{ height: collapsed ? "auto" : 250 }}
            >
                {/* ---------- controls ---------- */}
                <div className="flex flex-wrap items-center gap-2 px-2 py-1.5 border-b border-[#5a5555] text-sm">
                    <Btn
                        title="Collapse / expand"
                        onClick={() => setCollapsed((c) => !c)}
                    >
                        {collapsed ? "▸" : "▾"}
                    </Btn>
                    <span className="text-white font-semibold">Timeline</span>

                    <Btn
                        title="First frame"
                        disabled={!posing}
                        onClick={() => {
                            animation.stop();
                            animation.setFrame(0);
                        }}
                    >
                        ⏮
                    </Btn>
                    <Btn
                        title="Previous key (Down)"
                        disabled={!posing}
                        onClick={() => animation.jumpKey(-1)}
                    >
                        ◀◆
                    </Btn>
                    <Btn
                        title="Play / pause (Space)"
                        disabled={!posing}
                        active={playing}
                        onClick={() => animation.toggle()}
                    >
                        {playing ? "⏸" : "▶"}
                    </Btn>
                    <Btn
                        title="Next key (Up)"
                        disabled={!posing}
                        onClick={() => animation.jumpKey(1)}
                    >
                        ◆▶
                    </Btn>
                    <Btn
                        title="Last frame"
                        disabled={!posing}
                        onClick={() => {
                            animation.stop();
                            animation.setFrame(end);
                        }}
                    >
                        ⏭
                    </Btn>

                    <IntField
                        label="Frame"
                        value={cur}
                        disabled={!posing}
                        onCommit={(v) => {
                            animation.stop();
                            animation.setFrame(v);
                        }}
                    />
                    <IntField
                        label="End"
                        value={end}
                        onCommit={(v) => animation.setEnd(v)}
                    />
                    <IntField
                        label="FPS"
                        value={fps}
                        onCommit={(v) => animation.setFps(v)}
                    />
                    <span className="text-xs text-[#878080] w-12">
                        {(cur / fps).toFixed(2)}s
                    </span>
                    <label className="flex items-center gap-1 text-xs text-[#b5b0b0] cursor-pointer">
                        <input
                            type="checkbox"
                            checked={loop}
                            onChange={(e) =>
                                animation.setLoop(e.target.checked)
                            }
                        />
                        Loop
                    </label>

                    <span className="w-px h-5 bg-[#5a5555]" />

                    <Btn
                        title="Key the pose of the selected bones on this frame (I)"
                        disabled={!posing || Bone.selection.size === 0}
                        onClick={() => animation.insertKeys()}
                    >
                        ◆ Key
                    </Btn>
                    <Btn
                        title="Delete the selected keys (Delete)"
                        disabled={!posing || selected.length === 0}
                        onClick={() => animation.deleteSelected()}
                    >
                        ✕ Delete
                    </Btn>
                    <select
                        title="How the selected keys blend into the next key"
                        disabled={!posing || selected.length === 0}
                        value={selInterp}
                        onChange={(e) =>
                            animation.setInterp(e.target.value as Interp)
                        }
                        onKeyDown={(e) => e.stopPropagation()}
                        className="bg-[#1f1d1d] text-white text-xs rounded px-1 py-1 border border-[#5a5555] disabled:opacity-40"
                    >
                        <option value="linear">Linear</option>
                        <option value="smooth">Smooth</option>
                        <option value="step">Step</option>
                    </select>

                    <span className="w-px h-5 bg-[#5a5555]" />

                    <Btn
                        title="Export the skeleton and the animation as a JSON file for your game"
                        onClick={() => setExporting(true)}
                    >
                        ⭳ Export
                    </Btn>

                    {!posing && (
                        <span className="text-xs text-[#ffd54f]">
                            Switch to Pose mode to animate
                        </span>
                    )}
                </div>

                {/* ---------- tracks ---------- */}
                {!collapsed && (
                    <div
                        ref={scrollRef}
                        className={[
                            "flex-1 min-h-0 overflow-auto",
                            posing ? "" : "opacity-60",
                        ].join(" ")}
                    >
                        <div
                            className="relative"
                            style={{
                                width: NAME_W + areaW,
                                minWidth: "100%",
                            }}
                        >
                            {/* ruler */}
                            <div
                                className="sticky top-0 z-20 flex"
                                style={{ height: RULER_H }}
                            >
                                <div
                                    className="sticky left-0 z-30 bg-[#262424] border-b border-r border-[#5a5555] text-[11px] text-[#878080] flex items-center px-2"
                                    style={{ width: NAME_W }}
                                >
                                    Bones
                                </div>
                                <div
                                    ref={rulerRef}
                                    className="relative bg-[#262424] border-b border-[#5a5555] cursor-pointer select-none"
                                    style={{
                                        width: areaW,
                                        ...(ppf >= 6
                                            ? ticks(ppf, "#4a4646")
                                            : {}),
                                    }}
                                    onPointerDown={(e) => {
                                        if (!posing || e.button !== 0) return;
                                        animation.stop();
                                        e.currentTarget.setPointerCapture(
                                            e.pointerId,
                                        );
                                        scrubbing.current = true;
                                        animation.setFrame(
                                            frameAt(e.clientX, e.currentTarget),
                                        );
                                    }}
                                    onPointerMove={(e) => {
                                        if (!scrubbing.current) return;
                                        animation.setFrame(
                                            frameAt(e.clientX, e.currentTarget),
                                        );
                                    }}
                                    onPointerUp={() => {
                                        scrubbing.current = false;
                                    }}
                                >
                                    {labels.map((f) => (
                                        <span
                                            key={f}
                                            className="absolute top-0 text-[10px] text-[#b5b0b0] pointer-events-none"
                                            style={{
                                                left: PAD + f * ppf + 3,
                                            }}
                                        >
                                            {f}
                                        </span>
                                    ))}
                                    {/* playhead handle */}
                                    <div
                                        className="absolute bottom-0 -translate-x-1/2 bg-[#ff5252] text-white text-[10px] leading-none px-1 py-0.5 rounded-sm pointer-events-none"
                                        style={{ left: PAD + frame * ppf }}
                                    >
                                        {cur}
                                    </div>
                                </div>
                            </div>

                            {/* one row per bone */}
                            {rows.length === 0 && (
                                <div
                                    className="sticky left-0 p-3 text-xs text-[#878080]"
                                    style={{ width: 360 }}
                                >
                                    Add a bone, switch to Pose mode, pose it and
                                    press I.
                                </div>
                            )}
                            {rows.map(({ bone, depth }) => {
                                const keys = tracks[bone.id] ?? [];
                                const isSel = bone.isSelected;
                                return (
                                    <div
                                        key={bone.id}
                                        className="flex border-b border-[#3a3737]"
                                        style={{ height: ROW_H }}
                                    >
                                        <div
                                            className={[
                                                "sticky left-0 z-10 border-r border-[#5a5555] text-xs flex items-center truncate cursor-pointer",
                                                bone.isActive
                                                    ? "bg-[#4c4747] text-white"
                                                    : isSel
                                                      ? "bg-[#403c3c] text-white"
                                                      : "bg-[#2e2c2c] text-[#d0c9c9]",
                                            ].join(" ")}
                                            style={{
                                                width: NAME_W,
                                                paddingLeft: 8 + depth * 10,
                                            }}
                                            onClick={() => bone.select()}
                                        >
                                            <span className="mr-1 text-[#878080]">
                                                🦴
                                            </span>
                                            <span className="truncate">
                                                {bone.name}
                                            </span>
                                        </div>
                                        <div
                                            className="relative"
                                            style={{
                                                width: areaW,
                                                ...(ppf >= 6
                                                    ? ticks(ppf, "#363333")
                                                    : {}),
                                            }}
                                            onPointerDown={() => {
                                                bone.select();
                                                animation.clearSelection();
                                            }}
                                            onDoubleClick={(e) => {
                                                if (!posing) return;
                                                animation.insertKeyAt(
                                                    bone.id,
                                                    frameAt(
                                                        e.clientX,
                                                        e.currentTarget,
                                                    ),
                                                );
                                            }}
                                        >
                                            {keys.map((k) => {
                                                const id = keyId(
                                                    bone.id,
                                                    k.frame,
                                                );
                                                const sel = selectedSet.has(id);
                                                const f =
                                                    k.frame +
                                                    (sel ? dragDelta : 0);
                                                return (
                                                    <div
                                                        key={k.frame}
                                                        title={`${bone.name} · frame ${k.frame} · ${k.interp}`}
                                                        className={[
                                                            "absolute top-1/2 rotate-45 -translate-y-1/2 z-[7] border",
                                                            posing
                                                                ? "cursor-grab"
                                                                : "",
                                                            sel
                                                                ? "bg-[#ffd54f] border-white"
                                                                : "bg-[#d0c9c9] border-[#2e2c2c]",
                                                            k.interp === "step"
                                                                ? "rounded-none"
                                                                : "rounded-[2px]",
                                                        ].join(" ")}
                                                        style={{
                                                            width: 10,
                                                            height: 10,
                                                            left:
                                                                PAD +
                                                                f * ppf -
                                                                5,
                                                        }}
                                                        onPointerDown={(e) => {
                                                            if (
                                                                !posing ||
                                                                e.button !== 0
                                                            )
                                                                return;
                                                            e.stopPropagation();
                                                            if (e.shiftKey)
                                                                animation.selectKey(
                                                                    id,
                                                                    true,
                                                                );
                                                            else if (!sel)
                                                                animation.selectKey(
                                                                    id,
                                                                    false,
                                                                );
                                                            e.currentTarget.setPointerCapture(
                                                                e.pointerId,
                                                            );
                                                            keyDrag.current = {
                                                                startX: e.clientX,
                                                            };
                                                            setDragDelta(0);
                                                        }}
                                                        onPointerMove={(e) => {
                                                            if (
                                                                !keyDrag.current
                                                            )
                                                                return;
                                                            setDragDelta(
                                                                Math.round(
                                                                    (e.clientX -
                                                                        keyDrag
                                                                            .current
                                                                            .startX) /
                                                                        ppf,
                                                                ),
                                                            );
                                                        }}
                                                        onPointerUp={() => {
                                                            if (
                                                                !keyDrag.current
                                                            )
                                                                return;
                                                            keyDrag.current =
                                                                null;
                                                            const d = dragDelta;
                                                            setDragDelta(0);
                                                            if (d)
                                                                animation.moveSelected(
                                                                    d,
                                                                );
                                                        }}
                                                        onDoubleClick={(e) => {
                                                            e.stopPropagation();
                                                            animation.stop();
                                                            animation.setFrame(
                                                                k.frame,
                                                            );
                                                        }}
                                                    />
                                                );
                                            })}
                                        </div>
                                    </div>
                                );
                            })}

                            {/* playhead line */}
                            <div
                                className="absolute w-px bg-[#ff5252] pointer-events-none z-[6]"
                                style={{
                                    left: NAME_W + PAD + frame * ppf,
                                    top: RULER_H,
                                    bottom: 0,
                                }}
                            />
                        </div>
                    </div>
                )}
            </div>

            {exporting && <ExportDialog onClose={() => setExporting(false)} />}
        </div>
    );
}

function parseSel(id: string) {
    const i = id.lastIndexOf("|");
    return { bone: id.slice(0, i), frame: Number(id.slice(i + 1)) };
}

function Btn({
    children,
    onClick,
    disabled,
    active,
    title,
}: {
    children: React.ReactNode;
    onClick: () => void;
    disabled?: boolean;
    active?: boolean;
    title?: string;
}) {
    return (
        <button
            title={title}
            disabled={disabled}
            // keep focus off the button so Space (play / pause) doesn't also "click" it
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClick}
            className={[
                "px-2 py-0.5 rounded text-xs text-white",
                active ? "bg-[#ffd54f] !text-black" : "bg-[#4c4747]",
                disabled ? "opacity-40" : "cursor-pointer hover:bg-[#5d5757]",
            ].join(" ")}
        >
            {children}
        </button>
    );
}

/** Whole-number input: type, Enter / click away applies, Esc cancels. */
function IntField({
    label,
    value,
    onCommit,
    disabled,
}: {
    label: string;
    value: number;
    onCommit: (v: number) => void;
    disabled?: boolean;
}) {
    const [text, setText] = useState(String(value));
    const editing = useRef(false);
    const cancelled = useRef(false);

    useEffect(() => {
        if (!editing.current) setText(String(value));
    });

    const commit = () => {
        editing.current = false;
        if (cancelled.current) {
            cancelled.current = false;
            setText(String(value));
            return;
        }
        const n = parseInt(text, 10);
        if (Number.isFinite(n)) onCommit(n);
        else setText(String(value));
    };

    return (
        <label className="flex items-center gap-1 text-xs text-[#b5b0b0]">
            {label}
            <input
                value={text}
                disabled={disabled}
                inputMode="numeric"
                onChange={(e) => setText(e.target.value)}
                onFocus={() => (editing.current = true)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") {
                        cancelled.current = true;
                        e.currentTarget.blur();
                    }
                    e.stopPropagation(); // typed keys must not reach Phaser (I, E, Space ...)
                }}
                className="w-12 bg-[#1f1d1d] text-white rounded px-1.5 py-0.5 border border-[#5a5555] focus:border-[#ffd54f] outline-none disabled:opacity-40"
            />
        </label>
    );
}

