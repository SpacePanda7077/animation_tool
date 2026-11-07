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

type AnimStore = AnimData & {
    /** playhead; fractional while playing, whole when you scrub */
    frame: number;
    playing: boolean;
    /** selected keys, see keyId() */
    selected: string[];
};

export const useAnimationStore = create<AnimStore>(() => ({
    fps: 24,
    end: 60,
    loop: true,
    tracks: {},
    frame: 0,
    playing: false,
    selected: [],
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

/** insert / replace the key at key.frame, keeping the list sorted */
const putKey = (keys: Key[], key: Key): Key[] =>
    [...keys.filter((k) => k.frame !== key.frame), key].sort(
        (a, b) => a.frame - b.frame,
    );

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
        rot: a.rot + (b.rot - a.rot) * t,
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
    };
}

/**
 * Keyframe animation for the bones' POSE (so pose mode only).
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
        if (e.ctrlKey || e.metaKey) return;
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
        // a fresh scene starts with an empty animation
        useAnimationStore.setState({
            fps: 24,
            end: 60,
            loop: true,
            tracks: {},
            frame: 0,
            playing: false,
            selected: [],
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
        this.touch();
    }

    setEnd(v: number) {
        const end = Math.min(2000, Math.max(1, Math.round(v)));
        useAnimationStore.setState((s) => ({
            end,
            frame: Math.min(s.frame, end),
        }));
        this.touch();
    }

    setLoop(v: boolean) {
        useAnimationStore.setState({ loop: v });
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

    /** change how the selected keys blend into the next key */
    setInterp(interp: Interp) {
        const st = useAnimationStore.getState();
        if (!st.selected.length) return;
        const sel = new Set(st.selected);
        const tracks = copyTracks(st.tracks);
        for (const bid of Object.keys(tracks)) {
            for (const k of tracks[bid]) {
                if (sel.has(keyId(bid, k.frame))) k.interp = interp;
            }
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

    snapshot(): AnimData {
        const { fps, end, loop, tracks } = useAnimationStore.getState();
        return { fps, end, loop, tracks: copyTracks(tracks) };
    }

    load(d: AnimData) {
        const st = useAnimationStore.getState();
        const tracks = copyTracks(d.tracks);
        const selected = st.selected.filter((id) => {
            const [bid, f] = parseId(id);
            return tracks[bid]?.some((k) => k.frame === f);
        });
        useAnimationStore.setState({
            fps: d.fps,
            end: d.end,
            loop: d.loop,
            tracks,
            selected,
            frame: Math.min(st.frame, d.end),
        });
        this.apply();
    }

    // ---------- helpers ----------

    private commit(tracks: Tracks, selected: string[]) {
        useAnimationStore.setState({ tracks, selected });
        this.touch();
        this.apply();
    }

    /** tell the history (it listens to the object store) that something worth an undo step changed */
    private touch() {
        useObjectsStore.getState().bump();
    }
}

export const animation = new Animation();
