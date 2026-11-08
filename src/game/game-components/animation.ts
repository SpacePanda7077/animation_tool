import { create } from "zustand";
import type { Scene } from "phaser";
import { Bone } from "./objects/objetcs/Bone";
import type { ObjectBuilder } from "./objects/object-builder";
import { useObjectsStore } from "../../store/object-store";
import { history } from "./history";

/** how the value moves from a key to the NEXT key */
export type Interp = "linear" | "smooth" | "step";

/** One keyframe of one bone: the bone's POSE (rotation / translation offsets on top of its setup). */
export type Key = {
    frame: number;
    rot: number; // bone.poseRel (radians)
    x: number; // bone.poseX
    y: number; // bone.poseY
    interp: Interp;
};

/** keys per bone id, always sorted by frame, at most one key per frame */
export type Tracks = Record<string, Key[]>;

/** the part of the animation that is saved / undone */
export type AnimData = {
    fps: number;
    /** last frame of the animation (frames run 0..end) */
    end: number;
    loop: boolean;
    tracks: Tracks;
};

const DEFAULT_ANIM: AnimData = {
    fps: 24,
    end: 60,
    loop: true,
    tracks: {},
};

/** every animation and which one is open (what undo / redo saves) */
export type AnimSnapshot = {
    currentName: string;
    animations: Record<string, AnimData>;
};

type AnimStore = AnimData & {
    /** playhead; fractional while playing, whole when you scrub */
    frame: number;
    playing: boolean;
    /** selected keys, see keyId() */
    selected: string[];
    /** name of the currently active animation */
    currentName: string;
    /** all named animations (working state is always mirrored into this for the current one) */
    animations: Record<string, AnimData>;
    /** copied keys / pose (see copyClip) */
    clip: Clip | null;
    /** how a flipped paste treats the values: swap = other side does the same, mirror = other side does the mirror image */
    flipMode: FlipMode;
    /** short message for the timeline header (e.g. why a flip paste did nothing) */
    notice: string;
};

export type FlipMode = "swap" | "mirror";
type ClipKey = {
    boneId: string;
    name: string;
    /** frames after the first copied frame */
    df: number;
    rot: number;
    x: number;
    y: number;
    interp: Interp;
};
export type Clip = { keys: ClipKey[]; span: number };

export const useAnimationStore = create<AnimStore>(() => ({
    ...DEFAULT_ANIM,
    frame: 0,
    playing: false,
    selected: [],
    currentName: "idle",
    animations: { idle: { ...DEFAULT_ANIM, tracks: {} } },
    clip: null,
    flipMode: "swap",
    notice: "",
}));

export const keyId = (boneId: string, frame: number) => `${boneId}|${frame}`;
const parseId = (id: string): [string, number] => {
    const i = id.lastIndexOf("|");
    return [id.slice(0, i), Number(id.slice(i + 1))];
};

const copyTracks = (t: Tracks): Tracks => {
    const out: Tracks = {};
    for (const id of Object.keys(t)) out[id] = t[id].map((k) => ({ ...k }));
    return out;
};

const copyAnimData = (d: AnimData): AnimData => ({
    fps: d.fps,
    end: d.end,
    loop: d.loop,
    tracks: copyTracks(d.tracks),
});

const matchCase = (from: string, to: string) =>
    from === from.toUpperCase() && from.length > 1
        ? to.toUpperCase()
        : from[0] === from[0].toUpperCase()
          ? to[0].toUpperCase() + to.slice(1)
          : to;

/**
 * Name of the opposite-side bone: "Arm L" -> "Arm R", "left_leg" -> "right_leg", "hand.R" -> "hand.L",
 * "LeftArm" -> "RightArm". Returns null when the name has no side marker.
 */
export function flipName(name: string): string | null {
    const flip = (w: string) => {
        const l = w.toLowerCase();
        const to =
            l === "left"
                ? "right"
                : l === "right"
                  ? "left"
                  : l === "l"
                    ? "r"
                    : "l";
        return matchCase(w, to);
    };
    // separated token: "L", "R", "left", "right"
    const sep = /(^|[\s_.\-])(left|right|l|r)(?=$|[\s_.\-])/i;
    let m = sep.exec(name);
    if (m) {
        const at = m.index + m[1].length;
        return name.slice(0, at) + flip(m[2]) + name.slice(at + m[2].length);
    }
    // camel case: LeftArm, armLeft, RightLeg
    const camel = /(Left|Right)(?=[A-Z0-9]|$)/;
    m = camel.exec(name);
    if (m) {
        return (
            name.slice(0, m.index) +
            flip(m[1]) +
            name.slice(m.index + m[1].length)
        );
    }
    return null;
}

/** insert / replace the key at key.frame, keeping the list sorted */
const putKey = (keys: Key[], key: Key): Key[] =>
    [...keys.filter((k) => k.frame !== key.frame), key].sort(
        (a, b) => a.frame - b.frame,
    );

/**
 * Blend two angles along the SHORT way round (never more than half a turn), so a key stored as -4.47 rad
 * behaves like 1.82 rad instead of making the bone spin almost a full turn the other way.
 * To turn more than half a turn between two keys, put another key in between.
 */
export function lerpAngle(a: number, b: number, t: number): number {
    const TAU = Math.PI * 2;
    let d = (b - a) % TAU;
    if (d > Math.PI) d -= TAU;
    else if (d < -Math.PI) d += TAU;
    return a + d * t;
}

/** The pose of a track at frame `f` (holds the first / last key outside the range). Null if there are no keys. */
export function sample(
    keys: Key[],
    f: number,
): { rot: number; x: number; y: number } | null {
    const n = keys.length;
    if (!n) return null;
    if (f <= keys[0].frame) return keys[0];
    if (f >= keys[n - 1].frame) return keys[n - 1];
    let i = 0;
    while (keys[i + 1].frame <= f) i++;
    const a = keys[i];
    const b = keys[i + 1];
    if (a.interp === "step") return a;
    let t = (f - a.frame) / (b.frame - a.frame);
    if (a.interp === "smooth") t = t * t * (3 - 2 * t);
    return {
        rot: lerpAngle(a.rot, b.rot, t),
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
    };
}

/**
 * Keyframe animation for the bones' POSE (so pose mode only).
 * Supports multiple named animations.
 *  - Pose a bone, press I (or the Key button): every selected bone gets a key on the current frame.
 *  - Moving the playhead (or playing) sets the pose of every animated bone; the rects follow as usual.
 *  - Frame changes / playback are not undo steps. Inserting, deleting and moving keys are.
 * The UI lives in components/timeline/Timeline.tsx and only talks to this object + useAnimationStore.
 */
class Animation {
    private scene: Scene | null = null;
    private builder: ObjectBuilder | null = null;
    private unsubscribe: (() => void) | null = null;
    private raf = 0;
    private last = 0;

    private onKey = (e: KeyboardEvent) => {
        if (e.ctrlKey || e.metaKey) {
            const t = e.target as HTMLElement | null;
            if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
            if (useObjectsStore.getState().mode !== "pose") return;
            if (e.code === "KeyC") {
                e.preventDefault();
                this.copyClip();
            } else if (e.code === "KeyV") {
                e.preventDefault();
                this.pasteClip(e.shiftKey);
            }
            return;
        }
        if (useObjectsStore.getState().mode !== "pose") return;
        const st = useAnimationStore.getState();
        if (e.code === "KeyI") {
            e.preventDefault();
            if (e.altKey) this.deleteKeysAtFrame();
            else this.insertKeys();
        } else if (e.code === "Space") {
            e.preventDefault();
            this.toggle();
        } else if (e.code === "ArrowLeft") {
            e.preventDefault();
            this.setFrame(Math.round(st.frame) - 1);
        } else if (e.code === "ArrowRight") {
            e.preventDefault();
            this.setFrame(Math.round(st.frame) + 1);
        } else if (e.code === "ArrowUp") {
            e.preventDefault();
            this.jumpKey(1);
        } else if (e.code === "ArrowDown") {
            e.preventDefault();
            this.jumpKey(-1);
        } else if (e.code === "Delete") {
            this.deleteSelected();
        }
    };

    init(scene: Scene, builder: ObjectBuilder) {
        this.destroy();
        this.scene = scene;
        this.builder = builder;
        // a fresh scene starts with a single empty "idle" animation
        const empty = copyAnimData(DEFAULT_ANIM);
        useAnimationStore.setState({
            ...empty,
            frame: 0,
            playing: false,
            selected: [],
            currentName: "idle",
            animations: { idle: empty },
        });
        this.unsubscribe = useObjectsStore.subscribe((s, prev) => {
            if (s.mode === prev.mode) return;
            if (s.mode === "pose") this.apply();
            else this.stop();
        });
        scene.input.keyboard?.on("keydown", this.onKey);
    }

    destroy() {
        this.stop();
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.scene?.input?.keyboard?.off("keydown", this.onKey);
        this.scene = null;
        this.builder = null;
    }

    // ---------- multi-animation management ----------

    /** Persist the current working state into the animations map. */
    private saveCurrent() {
        const st = useAnimationStore.getState();
        const data: AnimData = {
            fps: st.fps,
            end: st.end,
            loop: st.loop,
            tracks: copyTracks(st.tracks),
        };
        useAnimationStore.setState({
            animations: { ...st.animations, [st.currentName]: data },
        });
    }

    /** Load a named animation into the working state (does not change currentName). */
    private loadIntoWorking(name: string) {
        const st = useAnimationStore.getState();
        const data = st.animations[name] ?? copyAnimData(DEFAULT_ANIM);
        useAnimationStore.setState({
            fps: data.fps,
            end: data.end,
            loop: data.loop,
            tracks: copyTracks(data.tracks),
            frame: 0,
            playing: false,
            selected: [],
        });
        this.apply();
    }

    /** Switch to another animation (saves the current one first). */
    switchTo(name: string) {
        const st = useAnimationStore.getState();
        if (name === st.currentName || !st.animations[name]) return;
        this.stop();
        // choosing which animation to look at is not an edit (like moving the playhead): no undo step
        history.silent(() => {
            this.saveCurrent();
            useAnimationStore.setState({ currentName: name });
            this.loadIntoWorking(name);
        });
    }

    /** Create a new empty animation and switch to it. */
    create(name?: string) {
        this.stop();
        history.checkpoint(); // an edit made a moment ago stays its own undo step
        this.saveCurrent();
        const st = useAnimationStore.getState();
        let base = (name?.trim() || "anim").replace(/\s+/g, " ");
        if (!base) base = "anim";
        let finalName = base;
        let i = 2;
        while (st.animations[finalName]) {
            finalName = `${base} ${i++}`;
        }
        const empty = copyAnimData(DEFAULT_ANIM);
        useAnimationStore.setState({
            animations: { ...st.animations, [finalName]: empty },
            currentName: finalName,
            ...empty,
            frame: 0,
            playing: false,
            selected: [],
        });
        this.apply();
        this.touch();
        return finalName;
    }

    /** Duplicate the current animation under a new name and switch to the copy. */
    duplicate(name?: string) {
        this.stop();
        history.checkpoint();
        this.saveCurrent();
        const st = useAnimationStore.getState();
        const src = st.animations[st.currentName] ?? copyAnimData(DEFAULT_ANIM);
        let base = (name?.trim() || `${st.currentName} copy`).replace(
            /\s+/g,
            " ",
        );
        if (!base) base = `${st.currentName} copy`;
        let finalName = base;
        let i = 2;
        while (st.animations[finalName]) {
            finalName = `${base} ${i++}`;
        }
        const copy = copyAnimData(src);
        useAnimationStore.setState({
            animations: { ...st.animations, [finalName]: copy },
            currentName: finalName,
            ...copy,
            frame: 0,
            playing: false,
            selected: [],
        });
        this.apply();
        this.touch();
        return finalName;
    }

    /** Rename the current animation. Returns the final name (or null on failure). */
    rename(newName: string): string | null {
        const st = useAnimationStore.getState();
        const name = newName.trim().replace(/\s+/g, " ");
        if (!name || name === st.currentName) return st.currentName;
        if (st.animations[name]) return null; // name already taken
        history.checkpoint();
        this.saveCurrent();
        const { [st.currentName]: data, ...rest } = st.animations;
        useAnimationStore.setState({
            animations: { ...rest, [name]: data },
            currentName: name,
        });
        this.touch();
        return name;
    }

    /** Delete an animation. Cannot delete the last one. Switches to another if deleting current. */
    delete(name?: string) {
        const st = useAnimationStore.getState();
        const target = name ?? st.currentName;
        const names = Object.keys(st.animations);
        if (names.length <= 1 || !st.animations[target]) return false;
        this.stop();
        history.checkpoint();
        const { [target]: _, ...rest } = st.animations;
        const nextName =
            target === st.currentName ? Object.keys(rest)[0] : st.currentName;
        useAnimationStore.setState({
            animations: rest,
            currentName: nextName,
        });
        if (target === st.currentName) {
            this.loadIntoWorking(nextName);
        }
        this.touch();
        return true;
    }

    /** List of animation names (stable order). */
    list(): string[] {
        return Object.keys(useAnimationStore.getState().animations);
    }

    // ---------- playhead / playback ----------

    /** move the playhead and pose every animated bone (pose mode) */
    setFrame(f: number) {
        const { end } = useAnimationStore.getState();
        useAnimationStore.setState({ frame: Math.min(end, Math.max(0, f)) });
        this.apply();
    }

    /** Set the pose of every animated bone from its keys at the playhead, then lay everything out. */
    apply() {
        if (!this.builder || useObjectsStore.getState().mode !== "pose") return;
        const { tracks, frame } = useAnimationStore.getState();
        const registry = this.builder.registry;
        // scrubbing / playing must not become undo steps
        history.silent(() => {
            for (const id of Object.keys(tracks)) {
                const b = registry.get(id);
                if (!(b instanceof Bone) || !b.alive) continue;
                const s = sample(tracks[id], frame);
                if (!s) continue;
                b.poseRel = s.rot;
                b.poseX = s.x;
                b.poseY = s.y;
            }
            for (const o of useObjectsStore.getState().objects) {
                if (o instanceof Bone && o.alive && !o.parent) o.layout();
            }
        });
    }

    toggle() {
        if (useAnimationStore.getState().playing) this.stop();
        else this.play();
    }

    play() {
        const st = useAnimationStore.getState();
        if (st.playing || useObjectsStore.getState().mode !== "pose") return;
        const start = !st.loop && st.frame >= st.end ? 0 : st.frame;
        useAnimationStore.setState({ playing: true, frame: start });
        history.hold();
        this.last = performance.now();

        const tick = (now: number) => {
            const s = useAnimationStore.getState();
            if (!s.playing) return;
            let f = s.frame + ((now - this.last) / 1000) * s.fps;
            this.last = now;
            let finished = false;
            if (f >= s.end) {
                if (s.loop) f = s.end > 0 ? f % s.end : 0;
                else {
                    f = s.end;
                    finished = true;
                }
            }
            useAnimationStore.setState({ frame: f });
            this.apply();
            if (finished) this.stop();
            else this.raf = requestAnimationFrame(tick);
        };
        this.raf = requestAnimationFrame(tick);
    }

    stop() {
        if (!useAnimationStore.getState().playing) return;
        cancelAnimationFrame(this.raf);
        useAnimationStore.setState((s) => ({
            playing: false,
            frame: Math.round(s.frame),
        }));
        this.apply();
        history.release();
    }

    // ---------- settings ----------

    setFps(v: number) {
        useAnimationStore.setState({
            fps: Math.min(240, Math.max(1, Math.round(v))),
        });
        this.saveCurrent();
        this.touch();
    }

    setEnd(v: number) {
        const end = Math.min(2000, Math.max(1, Math.round(v)));
        useAnimationStore.setState((s) => ({
            end,
            frame: Math.min(s.frame, end),
        }));
        this.saveCurrent();
        this.touch();
    }

    setLoop(v: boolean) {
        useAnimationStore.setState({ loop: v });
        this.saveCurrent();
        this.touch();
    }

    // ---------- keyframes ----------

    /** I: key the pose of every selected bone on the current frame */
    insertKeys() {
        if (useObjectsStore.getState().mode !== "pose") return;
        const st = useAnimationStore.getState();
        const frame = Math.round(st.frame);
        const tracks = copyTracks(st.tracks);
        const ids: string[] = [];
        for (const b of Bone.selection) {
            if (!b.alive) continue;
            const old = tracks[b.id] ?? [];
            const same = old.find((k) => k.frame === frame);
            const interp: Interp =
                same?.interp ?? old[old.length - 1]?.interp ?? "linear";
            tracks[b.id] = putKey(old, {
                frame,
                rot: b.poseRel,
                x: b.poseX,
                y: b.poseY,
                interp,
            });
            ids.push(keyId(b.id, frame));
        }
        if (ids.length) this.commit(tracks, ids);
    }

    /** key one bone on any frame (double click in the timeline): keeps what the track already says there */
    insertKeyAt(boneId: string, frame: number) {
        if (useObjectsStore.getState().mode !== "pose" || !this.builder) return;
        const b = this.builder.registry.get(boneId);
        if (!(b instanceof Bone) || !b.alive) return;
        const st = useAnimationStore.getState();
        const f = Math.min(st.end, Math.max(0, Math.round(frame)));
        const tracks = copyTracks(st.tracks);
        const old = tracks[boneId] ?? [];
        const s = sample(old, f) ?? { rot: b.poseRel, x: b.poseX, y: b.poseY };
        tracks[boneId] = putKey(old, {
            frame: f,
            rot: s.rot,
            x: s.x,
            y: s.y,
            interp: old.find((k) => k.frame === f)?.interp ?? "linear",
        });
        this.commit(tracks, [keyId(boneId, f)]);
    }

    /** Alt+I: remove the keys of the selected bones on the current frame */
    deleteKeysAtFrame() {
        const st = useAnimationStore.getState();
        const frame = Math.round(st.frame);
        const ids = [...Bone.selection].map((b) => keyId(b.id, frame));
        this.removeKeys(new Set(ids));
    }

    deleteSelected() {
        this.removeKeys(new Set(useAnimationStore.getState().selected));
    }

    private removeKeys(ids: Set<string>) {
        const st = useAnimationStore.getState();
        const tracks: Tracks = {};
        let removed = false;
        for (const bid of Object.keys(st.tracks)) {
            const keep = st.tracks[bid].filter(
                (k) => !ids.has(keyId(bid, k.frame)),
            );
            if (keep.length !== st.tracks[bid].length) removed = true;
            if (keep.length) tracks[bid] = keep.map((k) => ({ ...k }));
        }
        if (!removed) return;
        this.commit(tracks, []);
    }

    /** move the selected keys by `delta` frames (clamped to 0..end, they replace keys they land on) */
    moveSelected(delta: number) {
        const st = useAnimationStore.getState();
        if (!st.selected.length || !delta) return;
        const frames = st.selected.map((id) => parseId(id)[1]);
        const d = Math.max(
            -Math.min(...frames),
            Math.min(st.end - Math.max(...frames), delta),
        );
        if (!d) return;
        const sel = new Set(st.selected);
        const tracks: Tracks = {};
        const newSel: string[] = [];
        for (const bid of Object.keys(st.tracks)) {
            const keys = st.tracks[bid];
            const moved = keys
                .filter((k) => sel.has(keyId(bid, k.frame)))
                .map((k) => ({ ...k, frame: k.frame + d }));
            const landing = new Set(moved.map((k) => k.frame));
            const stay = keys
                .filter(
                    (k) =>
                        !sel.has(keyId(bid, k.frame)) && !landing.has(k.frame),
                )
                .map((k) => ({ ...k }));
            tracks[bid] = [...stay, ...moved].sort((a, b) => a.frame - b.frame);
            for (const k of moved) newSel.push(keyId(bid, k.frame));
        }
        this.commit(tracks, newSel);
    }

    // ---------- copy / paste / flip ----------

    selectKeys(ids: string[], additive: boolean) {
        const cur = useAnimationStore.getState().selected;
        const next = additive ? [...new Set([...cur, ...ids])] : ids;
        useAnimationStore.setState({ selected: next });
    }

    setFlipMode(m: FlipMode) {
        useAnimationStore.setState({ flipMode: m });
    }

    /**
     * Ctrl+C. With keys selected in the timeline: copies those keys (keeping their spacing).
     * Otherwise copies the CURRENT POSE of the selected bones (all bones when none is selected) as one frame.
     */
    copyClip(): boolean {
        if (!this.builder) return false;
        const st = useAnimationStore.getState();
        const reg = this.builder.registry;
        const out: ClipKey[] = [];
        let base = 0;
        if (st.selected.length) {
            const items = st.selected
                .map((id) => parseId(id))
                .filter(([bid]) => reg.get(bid) instanceof Bone);
            if (!items.length) return false;
            base = Math.min(...items.map(([, f]) => f));
            let last = base;
            for (const [bid, f] of items) {
                const k = st.tracks[bid]?.find((x) => x.frame === f);
                const b = reg.get(bid) as Bone;
                if (!k) continue;
                last = Math.max(last, f);
                out.push({
                    boneId: bid,
                    name: b.name,
                    df: f - base,
                    rot: k.rot,
                    x: k.x,
                    y: k.y,
                    interp: k.interp,
                });
            }
            if (!out.length) return false;
            useAnimationStore.setState({
                clip: { keys: out, span: last - base },
            });
            return true;
        }
        const bones = Bone.selection.size
            ? [...Bone.selection]
            : useObjectsStore
                  .getState()
                  .objects.filter((o): o is Bone => o instanceof Bone);
        for (const b of bones) {
            if (!b.alive) continue;
            out.push({
                boneId: b.id,
                name: b.name,
                df: 0,
                rot: b.poseRel,
                x: b.poseX,
                y: b.poseY,
                interp: "linear",
            });
        }
        if (!out.length) return false;
        useAnimationStore.setState({ clip: { keys: out, span: 0 } });
        return true;
    }

    /** the bone a flipped paste puts `name` on: the opposite-side bone, or the bone itself when it has none */
    private counterpart(boneId: string, name: string): Bone | null {
        const reg = this.builder?.registry;
        const self = reg?.get(boneId);
        const other = flipName(name);
        if (other) {
            const found = useObjectsStore
                .getState()
                .objects.find(
                    (o): o is Bone =>
                        o instanceof Bone && o.alive && o.name === other,
                );
            if (found) return found;
        }
        return self instanceof Bone && self.alive ? self : null;
    }

    /** Ctrl+V pastes at the playhead; Ctrl+Shift+V pastes flipped onto the opposite-side bones */
    pasteClip(flip: boolean) {
        if (useObjectsStore.getState().mode !== "pose" || !this.builder) return;
        const st = useAnimationStore.getState();
        const clip = st.clip;
        if (!clip) return;
        const at = Math.max(0, Math.round(st.frame));
        const tracks = copyTracks(st.tracks);
        const ids: string[] = [];
        let end = st.end;
        let moved = 0;
        const unpaired: string[] = [];
        for (const c of clip.keys) {
            const reg = this.builder.registry.get(c.boneId);
            const target = flip
                ? this.counterpart(c.boneId, c.name)
                : reg instanceof Bone && reg.alive
                  ? reg
                  : null;
            if (!target) continue;
            if (flip) {
                if (target.id !== c.boneId) moved++;
                else if (!unpaired.includes(c.name)) unpaired.push(c.name);
            }
            let { rot, x, y } = c;
            // mirror: the target does the mirror image (turns the other way). A child's x runs along its parent,
            // so only y flips; a root's x is across the world, so x flips.
            if (flip && st.flipMode === "mirror") {
                rot = -rot;
                if (target.parent) y = -y;
                else x = -x;
            }
            const frame = at + c.df;
            end = Math.max(end, frame);
            tracks[target.id] = putKey(tracks[target.id] ?? [], {
                frame,
                rot,
                x,
                y,
                interp: c.interp,
            });
            ids.push(keyId(target.id, frame));
        }
        if (!ids.length) return;
        if (flip) {
            const msg =
                moved === 0
                    ? `Flip paste: no opposite-side bones found. Name bones with L/R or Left/Right (e.g. "Arm L" / "Arm R").`
                    : unpaired.length
                      ? `Flip paste: ${unpaired.join(", ")} has no opposite bone, pasted onto itself.`
                      : "";
            useAnimationStore.setState({ notice: msg });
            if (msg)
                setTimeout(
                    () => useAnimationStore.setState({ notice: "" }),
                    6000,
                );
        }
        if (end !== st.end) useAnimationStore.setState({ end });
        this.commit(tracks, ids);
    }

    /** change how the selected keys blend into the next key */
    setInterp(interp: Interp) {
        const st = useAnimationStore.getState();
        if (!st.selected.length) return;
        const sel = new Set(st.selected);
        const tracks: Tracks = {};
        for (const bid of Object.keys(st.tracks)) {
            tracks[bid] = st.tracks[bid].map((k) =>
                sel.has(keyId(bid, k.frame)) ? { ...k, interp } : { ...k },
            );
        }
        this.commit(tracks, st.selected);
    }

    /** jump to the next (1) / previous (-1) key of the selected bones (of all bones when none is selected) */
    jumpKey(dir: 1 | -1) {
        const st = useAnimationStore.getState();
        const picked = [...Bone.selection].map((b) => b.id);
        const ids = picked.length ? picked : Object.keys(st.tracks);
        const cur = Math.round(st.frame);
        const frames: number[] = [];
        for (const id of ids)
            for (const k of st.tracks[id] ?? []) frames.push(k.frame);
        const pool = frames.filter((f) => (dir > 0 ? f > cur : f < cur));
        if (!pool.length) return;
        this.setFrame(dir > 0 ? Math.min(...pool) : Math.max(...pool));
    }

    // ---------- key selection (not part of undo) ----------

    selectKey(id: string, additive: boolean) {
        const cur = useAnimationStore.getState().selected;
        if (!additive) useAnimationStore.setState({ selected: [id] });
        else if (cur.includes(id))
            useAnimationStore.setState({
                selected: cur.filter((x) => x !== id),
            });
        else useAnimationStore.setState({ selected: [...cur, id] });
    }

    clearSelection() {
        if (useAnimationStore.getState().selected.length)
            useAnimationStore.setState({ selected: [] });
    }

    // ---------- undo / redo support ----------

    /** a copy of every animation (the open one is read from the working fields) and which one is open */
    snapshot(): AnimSnapshot {
        const st = useAnimationStore.getState();
        const animations: Record<string, AnimData> = {};
        for (const [name, d] of Object.entries(st.animations))
            animations[name] = copyAnimData(d);
        animations[st.currentName] = copyAnimData({
            fps: st.fps,
            end: st.end,
            loop: st.loop,
            tracks: st.tracks,
        });
        return { currentName: st.currentName, animations };
    }

    load(snap: AnimSnapshot) {
        this.stop();
        const st = useAnimationStore.getState();
        const animations: Record<string, AnimData> = {};
        for (const [name, d] of Object.entries(snap.animations))
            animations[name] = copyAnimData(d);
        const currentName = animations[snap.currentName]
            ? snap.currentName
            : Object.keys(animations)[0];
        const cur = animations[currentName] ?? copyAnimData(DEFAULT_ANIM);
        const tracks = copyTracks(cur.tracks);
        const selected = st.selected.filter((id) => {
            const [bid, f] = parseId(id);
            return tracks[bid]?.some((k) => k.frame === f);
        });
        useAnimationStore.setState({
            animations,
            currentName,
            fps: cur.fps,
            end: cur.end,
            loop: cur.loop,
            tracks,
            selected,
            frame: Math.min(st.frame, cur.end),
        });
        this.apply();
    }

    // ---------- helpers ----------

    private commit(tracks: Tracks, selected: string[]) {
        useAnimationStore.setState({ tracks, selected });
        this.saveCurrent();
        this.touch();
        this.apply();
    }

    /** tell the history (it listens to the object store) that something worth an undo step changed */
    private touch() {
        useObjectsStore.getState().bump();
    }
}

export const animation = new Animation();
