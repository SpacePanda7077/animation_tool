# Animation export

**Timeline → ⭳ Export** opens a dialog: pick a name, optionally *Bake every frame*, then **Download** or **Copy JSON**.
The file always contains the **setup pose** + the keyframes, no matter which mode you are in or where the playhead is.

| file | what it is |
| --- | --- |
| `format.ts` | the file format, fully commented (copy into your game for the types) |
| `runtime.ts` | dependency-free player: `solve()`, `frameAtTime()`, `sampleKeys()` (copy into your game) |
| `export-animation.ts` | editor side: `buildExport()` reads the scene and writes the file |

## Quick facts
- Angles are **radians**, positions are pixels, key times are in **frames** (`time` = seconds is included too).
- Bones are listed **parents first**. Names are made unique on export (the dialog tells you if it renamed something).
- A key is a **pose offset** on top of the bone's setup transform, so you can re-tune the setup later without redoing the animation.
- `parts` are the rectangles in **draw order, back to front**. A part with a `bone` is placed relative to that bone.
- Interpolation per key: `linear`, `smooth` (smoothstep) or `step`. *Bake every frame* turns everything into `linear` keys on whole frames.

## Using it in Phaser (example)
```ts
import { solve, frameAtTime } from "./runtime";
import type { ExportData } from "./format";

const data: ExportData = await (await fetch("assets/hero.json")).json();
const anim = data.animations.walk;

// one rectangle per part (swap these for sprites later), depth = draw order
const shapes = new Map(
    data.parts.map((p, i) => [
        p.name,
        this.add.rectangle(0, 0, p.width, p.height, parseInt(p.color.slice(1), 16)).setDepth(i),
    ]),
);

// in update(time):
const pose = solve(data, "walk", frameAtTime(anim, time / 1000));
for (const p of pose.parts)
    shapes.get(p.name)!.setPosition(p.x, p.y).setRotation(p.rotation).setVisible(p.visible);
```
Use `solve(data, null, 0)` for the setup pose. `pose.bones[name]` gives every bone's world pivot / rotation / tip, handy for attaching things to a hand.
