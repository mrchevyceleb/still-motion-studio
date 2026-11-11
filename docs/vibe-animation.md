# Vibe animation: animating from a description

This is the playbook for an AI agent (through the MCP server or the SDK) that turns a request like *"heavy overhead slam, slow wind-up, hits hard"* into a finished clip. The agent never writes quaternions. It poses the body by intent, reads numbers back, looks at a contact sheet, and fixes what the review flags.

## The loop

1. **Learn the body.** `still_inspect`, then `pose.describe` at time 0. The result lists the body parts this rig resolved (`bodyParts`) and where they sit at rest. Use the head and hip heights as your scale: a hand "overhead" is about head height + 0.4 m on a 1.8 m character.
2. **Choose a start.** Either begin with a blank scene (`scene.new {kind, blank:true}`, then `timeline.set {duration}`) or start from a similar motion (`clips.select` on an imported library file, then `keys.simplify {count: 6}`) and edit it. Editing a near match is faster and looks more natural than building from nothing.
3. **Block the story poses** with `pose.intent`, one key per beat: *ready → anticipation → strike/contact → follow-through → settle*. Start each beat with `{do:"reset", part:"all"}` unless you are building on the previous pose, then add actions. Read the returned `results` and `parts` each time. If an action reports `ok:false` (out of reach), move the target or the hips.
4. **Time it.** Anticipation takes about a third of the action. The strike is fast, usually 2–5 frames. Holds need a slight drift, never a dead stop. Move keys with `keys.move`, or stretch the clip with `timeline.set {duration}`.
5. **Fill the in-betweens.** Smooth interpolation is the default. For humanoids, `motion.run {provider:"motionbricks"}` generates natural transitions between your poses, and `motion.quickGround` pins planted feet.
6. **Look.** Call `still_review` (MCP) or `review.sheet` plus `review.metrics`. Fix **high** issues first: sliding feet, floor penetration, pops and backward knees. Then judge silhouette, arcs and weight on the sheet. Use `atKeys:true` to check the poses themselves, and evenly spaced frames to check spacing.
7. **Take notes and repeat.** Turn feedback into concrete edits (see the table below), then review again. Export only when the review shows no high-severity issues.

## Character space

Every position is `[right, up, forward]` in meters, measured from the floor point under the hips. The axes turn with the hips' heading, so "forward" always means the way the character faces. Named directions are `forward, back, up, down, left, right` (the character's own left and right). `out` and `in` are relative to the limb's side. Combinations also work, such as `"forward-up"` or `"out-down"`.

## `pose.intent` actions

| Action | What it does | Example |
| --- | --- | --- |
| `turn` | Rotates a part about body axes. `pitch` + tips the top forward, `yaw` + turns toward the character's right, `roll` + tips toward the right. `torso` spreads the turn over the spine. Turning the `hips` keeps the feet planted. | `{do:"turn", part:"torso", pitch:30}` |
| `aim` | Points a segment in a direction (upper arm, forearm, thigh, shin, spine…). | `{do:"aim", part:"leftUpperArm", direction:"out-up"}` |
| `bend` | Sets the elbow or knee angle (0 = straight). Knees fold backward, elbows forward. | `{do:"bend", part:"rightKnee", degrees:70}` |
| `reach` | Two-bone IK for hands and feet. Use `to` (absolute, or relative to `relativeTo`) or `by` (offset). `pole` sets where the elbow or knee points. Feet keep their orientation. | `{do:"reach", part:"rightHand", to:[0.1,0.3,0.2], relativeTo:"head"}` |
| `move` | Moves the hips. Feet stay pinned unless `plantFeet:false`, so this is how you crouch and shift weight. | `{do:"move", part:"hips", by:[0,-0.35,0.05]}` |
| `lookAt` | Aims the head (60% head, 40% neck) at a point or a part. | `{do:"lookAt", part:"head", at:"rightHand"}` |
| `mirror` | Copies one side's arms and/or legs to the other side, in the body's own frame (works on a turned body). | `{do:"mirror", from:"left", limbs:"arms"}` |
| `grip` | Wraps a hand around a carried prop. On the hand that carries it, rolls the hand about the shaft so the wrist is straight; `along` slides the prop through the hand (negative chokes down toward the butt). On the other hand, `along` (required) is meters down the shaft from the holding hand, and the grip is mirrored from it. With no `pole`, it tries the natural elbow directions and keeps the straightest wrist. The note reports the wrist bend, the forearm twist, and how much shaft sits behind the hand. | `{do:"grip", part:"rightHand", on:"Pitchfork", along:-0.26}` |
| `reset` | Returns one part, or `"all"`, to the rest pose (rotation and position). | `{do:"reset", part:"all"}` |

Every action accepts `weight` (0–1) for partial changes. `dryRun:true` previews the result without keying. `pose.describe` reports elbow and knee bends, `torsoPitch`/`torsoLean` (the chest's tilt), chest and head yaw, head pitch, foot heights, and warnings for backward knees, limbs under the floor, and props cutting into the head or torso (with where on the prop the deepest point is).

## Reading the review

`review.metrics` checks the motion the way an animator would:

- `foot-slide`: a planted foot (ankle and toe down) drifts, a toe pivot moves, or the body skates along with a flat foot on the floor. Touch-down and lift-off frames are ignored.
- `floor-penetration`: a foot sinks below its standing height, or any joint goes under the floor.
- `floating` / `floaty-jump`: the feet leave the floor without the hips rising, or the air time is far longer than gravity allows for that height.
- `pop`: one joint jumps far more in a single frame than in the frames around it, or jumps out and straight back (usually a flipped key).
- `hyperextension`: a supporting knee bends backward.
- `off-balance`: during a slow moment, the body's mass sits outside every low support point (feet, toes, knees, hands).
- `dead-hold`: nothing moves for half a second or more.
- `prop-clip`: a weapon, tool, hat or pet cuts into the head or torso (measured against the rig's real torso shape, beyond any contact it already has at rest). Props strapped to the body are not checked against the part they are strapped to.
- `wrist`: a hand folds more than 55° past its rest angle against the forearm, which reads as broken.
- `grip-slip`: the second hand holds a carried prop at two keys but drifts off it in between. Add a key or keep the grip closer between them.

The summary also includes foot contact spans, hips travel and speed, top hand speed, and the loop seam. On the bundled Quaternius library the checks pass jog, jump landing, punch, crouch and kneel clips cleanly. A few fast clips (sprint, sword swing, the fox run and jump) show genuine single-frame jumps in the source data.

## Props and weapons

- **Hold long weapons near the butt.** A two-handed swing puts the back hand on the end of the shaft (`grip` with `along` on the carrying hand). Every grip note says how much shaft sits behind the hand. More than about 5 cm behind the back hand will stab into the body as he turns.
- **Place the back hand, then let the shaft radiate out.** Put the back hand near the body on the weapon's side and the front hand further along the shaft. If you place the front hand first, the butt goes wherever the angle sends it, often into the belly.
- **Short arms change the layout, not the idea.** When `reach` or `grip` reports out of reach, or an elbow is locked at 0–5°, bring the hands closer together and toward the shoulders. A straight arm also leaves the solver no elbow choice.
- **Watch the forearm twist across keys.** The grip note reports the signed forearm twist. Neighbouring keys more than about 120° apart mean the hand rolls over between them. Give that roll at least three frames, or pick a `pole` that keeps the twist on the same side.
- **Turn strapped props before the body.** A scythe on the back or a hat on the head moves with its bone. Tip it clear (`turn` on the prop) before turning the torso, so it stays strapped.
- **Search instead of guessing.** For a hard beat, dry-run a small grid of hand layouts (`dryRun:true`) and keep the one with no misses, no `prop-clip` warning and the straightest wrists.

## Turning notes into edits

| Note | Edit |
| --- | --- |
| "heavier" | Deeper anticipation crouch, a longer wind-up, a faster strike, and a longer, lower hold after impact. |
| "snappier" | Shorten the gap between anticipation and strike. Keep the hold. |
| "more weight shift" | `move` the hips over the support foot before the other foot lifts. |
| "more sway" / "looser" | Alternate small torso `roll` and head `turn` across keys, with the head lagging the chest by a key. |
| "stiff" | Offset the arms by a frame or two. Add a slight `bend` to elbows and knees. Add follow-through after the main move. |
| "floaty" | Cut the air time to match the jump height (the metrics give the gravity time). Ease into the landing crouch. |
| "more violent" | A deeper coil (hips and torso turned well past the target), a strike two or three frames after the coil, a longer follow-through past the target, and the hips leading the torso. |
| "the other arm is doing weird stuff" | Pose every limb at every key: start from `reset all` and give the free hand a job (`grip` on the weapon, or a counter-swing). Unposed limbs interpolate on their own. |
| "the prop goes through him" | Read the `prop-clip` warning: the deepest point says which end. Turn that end away, slide the grip, or turn the strapped prop before the torso. |
| "the hands look wrong" | `grip` instead of `reach` on a held prop, then check the wrist bend in the note (keep it under about 30°). |
| feet slide | Finish with `motion.quickGround`, after the beats are approved: it bakes keys that pin planted feet. |

The same commands drive quadrupeds and creatures. Quadruped limbs are named `frontLeftUpper/Lower/Foot`, `hindRightUpper/Lower/Foot`, plus `tail` and `tailTip`. Any exact bone name or index also works as a part.
