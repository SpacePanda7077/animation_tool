import { useEffect, useRef, useState } from "react";
import { isRoot, Obj, useObjectsStore } from "../../store/object-store";
import type { Rect } from "../../game/game-components/objects/objetcs/Rect";

const fmt = (v: number) => String(Math.round(v * 100) / 100);
/** wrap degrees into -180..180 for display */
const wrapDeg = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

export default function Inspector() {
    return (
        <div className="absolute top-0 left-full w-[20vw] -translate-x-full h-full flex justify-center items-center ">
            <div className="bg-[#2e2c2c] w-full h-[99%] rounded-lg flex flex-col border-2 border-[#878080] overflow-hidden">
                <div className="flex-1 min-h-0 overflow-y-auto p-3">
                    <Layers />
                </div>
                <div className="h-0 border-t-2 border-[#878080]" />
                <div className="flex-1 min-h-0 overflow-y-auto p-3">
                    <Properties />
                </div>
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* Top: hierarchy + layers                                              */
/* ------------------------------------------------------------------ */

type Zone = "before" | "after" | "inside";

function Layers() {
    const objects = useObjectsStore((s) => s.objects);
    const selected = useObjectsStore((s) => s.selected);
    const reorderRect = useObjectsStore((s) => s.reorderRect);
    const attachRect = useObjectsStore((s) => s.attachRect);
    const unparent = useObjectsStore((s) => s.unparent);
    useObjectsStore((s) => s.version); // hierarchy / visibility changes bump the version

    const dragRef = useRef<Obj | null>(null);
    const [dragging, setDragging] = useState<Obj | null>(null);
    const [drop, setDrop] = useState<{ target: Obj; zone: Zone } | null>(null);

    const reset = () => {
        dragRef.current = null;
        setDragging(null);
        setDrop(null);
    };

    // bones first (they are always in front), then free rects in layer order
    const rootBones = objects.filter((o) => o.type === "Bone" && isRoot(o));
    const rootRects = objects.filter(
        (o) => o.type === "Rectangle" && isRoot(o),
    );

    /** things shown under a bone: child bones, then the rects it controls (front rect first) */
    const childrenOf = (o: Obj): Obj[] => {
        if (o.type !== "Bone") return [];
        const rects = (o.attachments as unknown as Rect[])
            .slice()
            .sort((a, b) => objects.indexOf(a) - objects.indexOf(b));
        return [...o.children, ...rects];
    };

    const onDragOver = (e: React.DragEvent<HTMLDivElement>, target: Obj) => {
        const d = dragRef.current;
        let zone: Zone | null = null;

        if (d && d !== target && d.type === "Rectangle") {
            if (target.type === "Bone") {
                // drop a rect ON a bone to let the bone control it
                if (d.parentBone !== target) zone = "inside";
            } else {
                // drop a rect above / below another rect to change the layer order
                const box = e.currentTarget.getBoundingClientRect();
                zone =
                    (e.clientY - box.top) / box.height < 0.5
                        ? "before"
                        : "after";
            }
        }

        if (!zone) {
            setDrop(null);
            return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (drop?.target !== target || drop.zone !== zone)
            setDrop({ target, zone });
    };

    const onDrop = (e: React.DragEvent<HTMLDivElement>, target: Obj) => {
        e.preventDefault();
        e.stopPropagation();
        const d = dragRef.current;
        if (d && d.type === "Rectangle" && drop && drop.target === target) {
            if (drop.zone === "inside" && target.type === "Bone")
                attachRect(d, target);
            else if (drop.zone !== "inside" && target.type === "Rectangle")
                reorderRect(d, target, drop.zone);
        }
        reset();
    };

    const renderNode = (o: Obj, depth: number): React.ReactNode => {
        const isDrop = drop?.target === o && dragging !== o;
        return (
            <div key={o.name}>
                <div
                    draggable
                    onClick={() => o.select()}
                    onDragStart={(e) => {
                        e.stopPropagation();
                        dragRef.current = o;
                        setDragging(o);
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", o.name); // needed by Firefox
                    }}
                    onDragOver={(e) => onDragOver(e, o)}
                    onDrop={(e) => onDrop(e, o)}
                    onDragEnd={reset}
                    style={{ marginLeft: depth * 16 }}
                    className={[
                        "px-3 py-1.5 rounded-md text-white cursor-grab select-none border-2 text-sm flex items-center gap-2",
                        selected === o ? "bg-[#4c4747]" : "bg-[#3a3737]",
                        dragging === o ? "opacity-40" : "",
                        o.visible ? "" : "text-[#878080]",
                        isDrop && drop?.zone === "inside"
                            ? "border-[#ffd54f]"
                            : "border-transparent",
                        isDrop && drop?.zone === "before"
                            ? "!border-t-[#ffd54f]"
                            : "",
                        isDrop && drop?.zone === "after"
                            ? "!border-b-[#ffd54f]"
                            : "",
                    ].join(" ")}
                >
                    <span className="text-[#878080]">
                        {o.type === "Bone" ? "🦴" : "▭"}
                    </span>
                    <span className="flex-1 truncate">{o.name}</span>
                    <button
                        title={o.visible ? "Hide" : "Show"}
                        draggable={false}
                        onClick={(e) => {
                            e.stopPropagation();
                            o.setVisible(!o.visible);
                        }}
                        className={o.visible ? "opacity-90" : "opacity-30"}
                    >
                        👁
                    </button>
                </div>
                <div className="flex flex-col gap-1 mt-1">
                    {childrenOf(o).map((c) => renderNode(c, depth + 1))}
                </div>
            </div>
        );
    };

    const dragNested = dragging !== null && !isRoot(dragging);

    return (
        <div className="flex flex-col gap-1 min-h-full">
            <div className="text-xs text-[#878080] mb-1">
                Bones are always in front. Rectangles: top = front, drag to
                reorder. Drop a rectangle onto a bone to let the bone control
                it.
            </div>
            {rootBones.map((o) => renderNode(o, 0))}
            {rootRects.map((o) => renderNode(o, 0))}

            {/* empty space at the bottom: drop here to take an item out of its hierarchy */}
            <div
                className={[
                    "flex-1 min-h-10 rounded-md text-xs flex items-center justify-center text-[#878080]",
                    dragNested ? "border-2 border-dashed border-[#878080]" : "",
                ].join(" ")}
                onDragOver={(e) => {
                    if (dragRef.current && !isRoot(dragRef.current)) {
                        e.preventDefault();
                        setDrop(null);
                    }
                }}
                onDrop={(e) => {
                    e.preventDefault();
                    const d = dragRef.current;
                    if (d && !isRoot(d)) unparent(d);
                    reset();
                }}
            >
                {dragNested ? "Drop here to unparent" : ""}
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* Bottom: properties of the selected object                            */
/* ------------------------------------------------------------------ */

function Properties() {
    const selected = useObjectsStore((s) => s.selected);
    const unparent = useObjectsStore((s) => s.unparent);
    useObjectsStore((s) => s.version); // re-render whenever the game object changes

    if (!selected) {
        return <div className="text-xs text-[#878080]">Nothing selected.</div>;
    }

    if (selected.type === "Bone") {
        const b = selected;
        return (
            <div className="flex flex-col gap-3">
                <Title>{b.name}</Title>

                <Group label="Pivot (world)">
                    <NumberField
                        label="X"
                        value={b.pivot.x}
                        disabled={!b.canMovePivot}
                        onCommit={(v) => b.setPivot(v, b.pivot.y)}
                    />
                    <NumberField
                        label="Y"
                        value={b.pivot.y}
                        disabled={!b.canMovePivot}
                        onCommit={(v) => b.setPivot(b.pivot.x, v)}
                    />
                </Group>

                <Group label="Bone">
                    <NumberField
                        label="Length"
                        value={b.length}
                        onCommit={(v) => b.setLength(v)}
                    />
                    <NumberField
                        label="Angle °"
                        value={wrapDeg(b.angleDeg)}
                        onCommit={(v) => b.setAngleDeg(v)}
                    />
                </Group>

                {b.parent && (
                    <Group label="Relative to parent">
                        <NumberField
                            label="Angle °"
                            value={wrapDeg(toDeg(b.rel))}
                            onCommit={(v) => b.setRelativeAngleDeg(v)}
                        />
                    </Group>
                )}

                <Group label="Hierarchy">
                    <Info
                        label="Parent"
                        value={b.parent ? b.parent.name : "None"}
                    />
                    <Info
                        label="Connected"
                        value={
                            b.parent
                                ? b.connected
                                    ? "Yes"
                                    : "No (offset)"
                                : "-"
                        }
                    />
                    <Info
                        label="Child bones"
                        value={String(b.children.length)}
                    />
                    <Info
                        label="Controls"
                        value={`${b.attachments.length} item(s)`}
                    />
                </Group>

                <div className="text-[11px] text-[#878080]">
                    E extrude · Shift+click multi-select · Ctrl+K parent ·
                    Ctrl+D detach
                </div>
            </div>
        );
    }

    const r = selected;
    const hex = r.rect.fillColor.toString(16).padStart(6, "0");
    return (
        <div className="flex flex-col gap-3">
            <Title>{r.name}</Title>

            {r.parentBone && (
                <Group label="Controlled by">
                    <Info label="Bone" value={r.parentBone.name} />
                    <button
                        className="self-end text-xs rounded bg-[#4c4747] hover:bg-[#5d5757] text-white px-2 py-1"
                        onClick={() => unparent(r)}
                    >
                        Detach
                    </button>
                </Group>
            )}

            <Group label="Position (center)">
                <NumberField
                    label="X"
                    value={r.rect.x}
                    onCommit={(v) => r.setPosition(v, r.rect.y)}
                />
                <NumberField
                    label="Y"
                    value={r.rect.y}
                    onCommit={(v) => r.setPosition(r.rect.x, v)}
                />
            </Group>

            <Group label="Size">
                <NumberField
                    label="Width"
                    value={r.rect.displayWidth}
                    onCommit={(v) => r.setSize(v, r.rect.displayHeight)}
                />
                <NumberField
                    label="Height"
                    value={r.rect.displayHeight}
                    onCommit={(v) => r.setSize(r.rect.displayWidth, v)}
                />
            </Group>

            <Group label="Rotation">
                <NumberField
                    label="Angle °"
                    value={wrapDeg(toDeg(r.rect.rotation))}
                    onCommit={(v) => r.setRotationDeg(v)}
                />
            </Group>

            <Group label="Pivot (world)">
                <NumberField
                    label="X"
                    value={r.pivot.x}
                    onCommit={(v) => r.setPivotWorld(v, r.pivot.y)}
                />
                <NumberField
                    label="Y"
                    value={r.pivot.y}
                    onCommit={(v) => r.setPivotWorld(r.pivot.x, v)}
                />
            </Group>

            <Group label="Color">
                <label className="flex items-center gap-2 text-xs text-[#b5b0b0]">
                    <input
                        type="color"
                        value={`#${hex}`}
                        onChange={(e) =>
                            r.setColor(parseInt(e.target.value.slice(1), 16))
                        }
                        className="w-8 h-6 bg-transparent border-0 p-0"
                    />
                    #{hex}
                </label>
            </Group>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* Small building blocks                                                */
/* ------------------------------------------------------------------ */

function Title({ children }: { children: React.ReactNode }) {
    return <div className="text-white font-semibold">{children}</div>;
}

function Group({
    label,
    children,
}: {
    label: string;
    children: React.ReactNode;
}) {
    return (
        <div className="flex flex-col gap-1">
            <div className="text-[11px] uppercase tracking-wide text-[#878080]">
                {label}
            </div>
            <div className="grid grid-cols-2 gap-2">{children}</div>
        </div>
    );
}

function Info({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex flex-col text-xs">
            <span className="text-[#b5b0b0]">{label}</span>
            <span className="text-white">{value}</span>
        </div>
    );
}

/** Number input: type a value, Enter / click away to apply, Esc to cancel. */
function NumberField({
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
    const [text, setText] = useState(fmt(value));
    const editing = useRef(false);
    const cancelled = useRef(false);

    // while you are not typing, always show the live value from the game
    useEffect(() => {
        if (!editing.current) setText(fmt(value));
    });

    const commit = () => {
        editing.current = false;
        if (cancelled.current) {
            cancelled.current = false;
            setText(fmt(value));
            return;
        }
        const n = parseFloat(text);
        if (Number.isFinite(n)) onCommit(n);
        else setText(fmt(value));
    };

    return (
        <label className="flex flex-col gap-0.5 text-xs text-[#b5b0b0]">
            {label}
            <input
                value={text}
                disabled={disabled}
                inputMode="decimal"
                onChange={(e) => setText(e.target.value)}
                onFocus={() => (editing.current = true)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") {
                        cancelled.current = true;
                        e.currentTarget.blur();
                    }
                    e.stopPropagation(); // don't let Phaser see typed keys (e.g. E extrudes a bone)
                }}
                className="bg-[#1f1d1d] text-white rounded px-2 py-1 border border-[#5a5555] focus:border-[#ffd54f] outline-none disabled:opacity-40"
            />
        </label>
    );
}
