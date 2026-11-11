# Motion engine

The editor now separates authored poses from generated motion. Pretrained learned engines and a real inverse-dynamics solver run locally; the original curve and ground tools remain available.

## Learned in-betweening

The shipped animal prior retains authored poses and leaves mesh/skin bindings intact. The research-only `backend/inbetween.py` CondMDI provider is disabled by default and its weights are not distributed because rights remain unresolved.

`src/engine/assistance.ts` converts bone transforms into a virtual Y-up skeleton in meters, retaining non-bone ancestors and source display transforms when mapping results back. Unmapped detail such as fingers follows the baseline motion. A generated take has its own dense frame sequence; authored poses remain the simple editing interface. Editing, deleting, or retiming a pose invalidates the generated take. Undo, project saves, archives, and exports include the generated frames.

The fresh `backend/quadruped.py` provider supports four-legged starter rigs and recognized Quaternius animal names. Its original neural network is trained from random weights on authored CC0 animal clips; no CondMDI checkpoint is used. `backend/owned_humanoid.py` provides a separately trained CC0 humanoid model with experimental quality: it does not yet beat interpolation on held-out clips. Models can need cleanup on unusual proportions or actions outside their training set. See [animal model and validation](learned-quadruped.md) and [permission evidence](motion-model-rights.md).

## Articulated dynamics

`backend/physics.py` builds an approximate articulated inertial model with ball joints and frictional foot/floor contacts. MuJoCo evaluates gravity, inertia, contact forces, and inverse dynamics; SciPy optimizes floating-root and support-chain corrections. The objective penalizes residual external root force/torque, contact error, penetration, excessive internal torque, and deviation from the authored motion. Authored poses may change.

Every result is audited at the full returned frame rate, even when fitting used fewer samples. Regressions in force/torque are rejected, preserving the original animation. Remaining large forces, sliding, penetration, joint-limit violations, and anchor drift produce an explicit review flag. The downloadable generation report includes before/after measurements. These are measurements of inferred masses and proxy contacts, not a certification of realistic anatomy. Full-body collision and rig-calibrated joint axes remain unimplemented.

With **Keep feet planted**, low, slow-moving source feet define stance intervals. Isolated detections are filtered; each stance uses a median horizontal foot-center target. A damped Jacobian solve removes drift at the full output rate, with 150 ms transitions into neighboring swing frames. It retains the dynamics solver's foot orientations and vertical compression and caps excess proxy penetration at 4 mm where reachable. The final full-rate dynamics audit still decides acceptance. This stabilizes measured foot centers; it does not model every heel/toe pivot or arbitrary terrain.


## Curve and posing tools

- **Smooth** preserves authored poses exactly. Translation and scale use shape-preserving cubic Hermite interpolation; rotation uses shortest-path quaternion interpolation with easing. This avoids Euler flips and translation overshoot, but it does not infer the intended action from six poses.
- **Linear** interpolates translation/scale and uses quaternion slerp. **Stepped** holds each pose until the next key.
- Joint dragging uses cyclic-coordinate-descent inverse kinematics. It rotates up to four ancestors, preserves bone lengths, and keeps limb chains from moving the torso. Hips/root dragging translates the root in its parent's coordinate system. There are no anatomical joint limits or self-collision constraints yet.
- The six-pose reducer preserves endpoints and repeatedly keeps the pose with the largest reconstruction error. It approximates the original animation; users should keep the original before reducing.
- FBX/glTF clip sampling evaluates the original Three.js animation at 30 fps, including the exact final time. It does not retarget the skeleton or rewrite the bind pose. Animated channels other than bone position, quaternion, and scale are explicitly rejected so mesh transforms and morph animation are never silently lost. Unanimated source transforms stay on their original hierarchy.
- Export bakes the selected interpolation at 30 fps, including exact authored times and the endpoint, into ordinary bone tracks. Physics assistance is an explicit edit to poses; exporting never applies it a second time.

## Ground and gravity assistance

The optional assist samples poses at 30 fps. It identifies feet by common foot/ankle/hoof/paw names (toes are the fallback) and derives their ground clearance from the rest pose. Floor contact lifts a penetrating character and softly holds nearby feet in place with IK. Gravity adds bounded parabolic height between authored poses that include an airborne endpoint. Authored times remain present, though floor correction can change an authored pose.

This is a useful starting point for a grounded pose or a simple jump. It does not calculate center of mass, momentum, contact forces, balance, collisions, or an optimal flight trajectory. It can require manual correction on moving platforms, unusual bone names, extreme poses, or complex acrobatics. Grounding considers foot markers rather than mesh collisions. Foot holds are released when the animation lifts or travels too far from the contact point. The operation restores the viewport pose after calculating the result.
