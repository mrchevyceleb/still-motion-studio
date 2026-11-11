# Cascadeur integration removed

Still 0.2.23 removes the Cascadeur AI and AutoPhysics adapters, installation detection, bridge calls, setup script and native recovery jobs. Still no longer connects to or controls Cascadeur.

Use pose interpolation or imported clips for human animation, the validated animal prior for supported quadrupeds, and MuJoCo for physics correction. See [motion tools](motion.md).

Saved projects and previously generated animation remain usable. Old local Cascadeur manifests and recovery journals are ignored; they do not block startup or updates. If an older Still session left a temporary scene open in Cascadeur, close that scene in Cascadeur itself.

Earlier release notes and research notes describe historical experiments, not available features.
