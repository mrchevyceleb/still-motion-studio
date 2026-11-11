# Independent physical motion correction

> Historical development notes. Local verification artifacts are not distributed. See the current README and docs for supported behavior.

## Does the physics feature itself require a trained model?

### Takeaway
No. Cascadeur describes AutoPhysics as physics-based algorithms, and exposes a nonlinear solver with Newton-force, torque, friction, geometry, and ballistic-trajectory constraints. An independent dynamics solver can honestly be named **Physics correction**; it should not be named learned AI physics without trained weights. [Cascadeur AutoPhysics](https://cascadeur.com/help/tools/physics_tools/autophysics) · [Corrector settings](https://cascadeur.com/help/category/292)

### Cited Findings
- AutoPhysics proposes a simulated correction and lets a user snap the animation to that proposal. Priority frames increase preservation of chosen poses. [AutoPhysics documentation](https://cascadeur.com/help/tools/physics_tools/autophysics)
- Cascadeur exposes force, torque, friction, jerk, and ballistic constraints, plus a nonlinear iteration/time budget and preservation weights. [Corrector settings](https://cascadeur.com/help/category/292) · [AutoPhysics settings](https://cascadeur.com/help/tools/physics_tools/autophysics/autophysics_settings)
- Cascadeur's balance explanation places the projected center of mass within support points for a stationary pose, and explicitly distinguishes moving poses from stationary balance. [Physics documentation](https://cascadeur.com/help/animation/physics)

### Inferences
- Newtonian trajectory optimization is a defensible independent implementation strategy for this part of the product. These documents do not establish mathematical equivalence to Cascadeur's implementation.
- Learned pose/motion generation and physics correction should remain separate providers with separate provenance in the UI.

### Gaps
- Cascadeur's proprietary numerical implementation, body-mass calibration, and full constraint schedule are not established by these public sources. No binary code or proprietary algorithm was copied into this prototype.

## Which real engines are practical on this Windows machine?

### Takeaway
MuJoCo is runnable here in an isolated Python environment. PHC supplies genuine trained controllers and downloadable checkpoints, but its documented stack has materially more integration requirements than a general-skeleton correction pass. PhysDiff supplies a relevant method but its project page does not establish a downloadable drop-in model. [MuJoCo Python](https://mujoco.readthedocs.io/en/stable/python.html) · [PHC](https://github.com/ZhengyiLuo/PHC) · [PhysDiff](https://nvlabs.github.io/PhysDiff/)

### Cited Findings
- MuJoCo computes articulated forward/inverse dynamics and soft unilateral frictional contacts. Its inverse dynamics supports optimizing a trajectory and deriving velocities, accelerations, required actuation, and contact forces from it. [MuJoCo computation](https://mujoco.readthedocs.io/en/stable/computation.html)
- `mj_inverse` consumes position, velocity, and acceleration and returns required generalized forces. `mj_differentiatePos` and quaternion-aware integration handle the manifold representation; body/site Jacobians are available. [MuJoCo API](https://mujoco.readthedocs.io/en/stable/APIreference/APIfunctions.html)
- MuJoCo is Apache-2.0 licensed. [Upstream license](https://raw.githubusercontent.com/google-deepmind/mujoco/main/LICENSE)
- PHC is an official learned humanoid controller implementation. Its release has pretrained checkpoint download commands, SMPL-family processing and retargeting documentation, and later Isaac Lab evaluation support. Its standard setup specifies Isaac Gym and SMPL assets. [PHC repository](https://github.com/ZhengyiLuo/PHC) · [Checkpoint download script](https://raw.githubusercontent.com/ZhengyiLuo/PHC/master/download_data.sh)
- PHC's code license is BSD 3-Clause Clear; its license directs users to separate included-asset licenses. [PHC license](https://raw.githubusercontent.com/ZhengyiLuo/PHC/master/LICENSE)
- NVIDIA's legacy Isaac Gym download requires Ubuntu 18.04/20.04 and Python 3.6–3.8; NVIDIA labels it unsupported legacy software and points to Isaac Lab. [NVIDIA download prerequisites](https://developer.nvidia.com/isaac-gym/download)
- PhysDiff uses a learned physics-based motion projection via imitation in a simulator during diffusion. The project reports reduced physical artifacts; this does not imply arbitrary FBX skeleton compatibility. [PhysDiff authors' project](https://nvlabs.github.io/PhysDiff/)

### Inferences
- Use MuJoCo now as an independent CPU physics provider, and investigate PHC/Isaac Lab later for a learned tracking option after explicit skeleton retargeting and asset/licensing checks.
- A pretrained controller trained on an SMPL body is not automatically a controller for arbitrary Mixamo proportions or quadrupeds. Preserving the original skin requires a separate retargeting layer even when pretrained physics is used.

### Gaps
- PHC's checkpoint inference was not run in this investigation. No claim is made that its controller is configured for this machine or this application's original skeletons.
- This investigation did not locate a complete runnable PhysDiff checkpoint+code distribution on the authors' project page. That is an evidence gap, not proof that none exists elsewhere.

## What was implemented and actually measured?

### Takeaway
`backend/physics.py` now provides a real MuJoCo inverse-dynamics correction, with a bounded SciPy sparse trajectory solve and full-frame acceptance checks. It is a proposal generator using approximate body inertia and foot collision proxies, not a learned model or complete production biomechanics system. Implementation (local development artifact; not distributed)

### Cited Findings
- The isolated runtime is Python 3.12 with MuJoCo 3.15.0, NumPy 2.5.3, and SciPy 1.18.1. No global package installation was used. The readiness manifest points to `.local/physics-proof/.venv/Scripts/python.exe`. Runtime manifest (local development artifact; not distributed) · Pinned dependencies (local development artifact; not distributed)
- Input is the parent's normalized meter/Y-up virtual skeleton with original local bone transforms and sampled poses. The provider outputs exactly those bone slots, preserving non-root offsets, scales, and unoptimized detail joint rotations. No mesh or skin weights enter or leave the solver. Implementation (local development artifact; not distributed)
- Every segment has explicit inferred mass/inertia, a floating unactuated root, quaternion joints, and rest-relative rotational limits. Contact feet have oriented box proxies, unilateral ground response, and friction. The objective includes root force/torque residual, contact fixation, body-pose fidelity, static support guidance, correction smoothness, and torque-limit penalties. Implementation (local development artifact; not distributed)
- **Corrupted standing proof, 25 frames:** maximum sole penetration 57.0→2.07 mm; contact sliding 0.1083→0.00732 m/s; unphysical root-force RMS 72,832→19.11 N; maximum inferred joint torque 4,835→116.64 Nm. Solve converged in 7.02 seconds on CPU. Initial deep interpenetration causes the intentionally corrupted proxy's very large contact forces. Measured contact result (local development artifact; not distributed)
- **Unsupported airborne proof, 25 frames:** root-force RMS 687.78→16.36 N; root-torque RMS 9.40→0.175 Nm; maximum internal torque 20.85→2.82 Nm; solve converged in 1.02 seconds. Root trajectory acquires the gravity-consistent arc through dynamics optimization; it is not a hand-authored gravity curve. Anchor translation drift is reported at approximately 10.8 mm. Measured flight result (local development artifact; not distributed)
- **Parent's actual 121-frame demo request:** root-force RMS 686.73→6.37 N, maximum foot compression 0→0.67 mm, root correction RMS 0.61 mm. It solved at 49 samples and audited the full 121 frames in 9.63 seconds. Demo request (local development artifact; not distributed) · Measured demo result (local development artifact; not distributed)
- **Final dense default, same 121-frame demo:** all 121 frames participated in fitting; root-force RMS was 4.31 N, root-torque RMS 1.43 Nm, maximum compression 0.658 mm, and contact sliding 0.269 mm/s. It converged in 23.97 seconds; `quality.requiresReview` was false within this proxy's declared tolerances. Final demo result (local development artifact; not distributed)
- **Real Mixamo, 119 bones / 61 frames:** dense solve reduced root-force RMS 1,316→544 N, root-torque RMS 1,165→325 Nm, and max internal torque 7,181→1,654 Nm in 11.95 seconds. It remained imperfect: sole penetration 0.66→5.47 mm and sliding 0.139→0.161 m/s. The provider reports substantial remaining force/torque requirements rather than calling this physically feasible. Measured dense Mixamo result (local development artifact; not distributed)
- A sparse Mixamo experiment improved only its sampled objective while worsening full-rate dynamics. This motivated dense fitting by default up to 241 frames, full-frame remeasurement for longer clips, and refusal to apply results with worse root-force, torque, penetration, or sliding beyond explicit acceptance thresholds. Rejected sparse experiment evidence (local development artifact; not distributed) · Acceptance implementation (local development artifact; not distributed)
- **Full 18.2-second Mixamo request:** bounded fitting plus the full-rate audit took 48.81 seconds. Root-force RMS 2,240→1,220 N, root-torque RMS 1,800→787 Nm, and maximum internal torque 18,473→4,966 Nm improved, but sole compression 3.42→7.08 mm and sliding 0.196→0.241 m/s worsened. `quality.requiresReview` is true with five specific reasons; this is explicitly an imperfect proposal, not a physically feasible result. Full-length result (local development artifact; not distributed)
- Four outputs were audited for original frame times/count, bone count, unchanged non-root offsets/scales, finite values, and normalized quaternions. The deliberately bad sparse Mixamo solve was rerun after adding the acceptance guard and correctly rejected. Structural and rejection verification (local development artifact; not distributed)

### Inferences
- The implementation is a substantive upgrade over the prior procedural gravity curve: it explicitly asks what unphysical external root force would be required to realize the proposed motion and reduces that residual using a dynamics engine.
- Results on the simple calibrated demo are strong. Results on a complex duplicate-bone Mixamo hierarchy show that production quality requires improved rigid-body reduction, mass calibration, anatomical axes, and contact inference. The solver must expose these limits.
- Stationary support distance is a diagnostic, not proof of dynamic balance. Significant anchor drift may be required when the authored pose conflicts with the floor; the result includes that drift rather than silently promising unchanged anchors.

### Gaps
- Anatomical knee/elbow hinge directions are not identified from arbitrary rigs; current limits are conservative rotational cones. Full-body self-collision, scene-object collision, muscle force limits, and learned contact inference are not implemented.
- Mass and inertia are inferred from bone names/lengths and normalized to 70 kg. Mesh shape and true body masses are not measured. Quadruped support names are accepted, but quadruped quality has not yet been benchmarked.
- The physics provider is not a guarantee that arbitrary acrobatics, impossible anchor timing, duplicate control skeletons, or long sparse solves will become feasible. Its acceptance checks can reject a correction and leave the original animation unchanged.
