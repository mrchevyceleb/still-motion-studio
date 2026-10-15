"""Re-import a Still FBX package in Blender and compare it to its source GLB.

Blender -b --factory-startup --python scripts/check-morph-export.py -- \
  --input /tmp/still-morph-fixture.glb --package /tmp/still-morph-out/Morph.zip
"""
import argparse
import importlib.util
import json
import math
from pathlib import Path
import sys
import tempfile
import zipfile

import bpy
from mathutils import Matrix
import numpy as np


def clear_scene():
    for obj in list(bpy.context.scene.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.context.scene.unit_settings.scale_length = .01
    bpy.context.scene.render.fps = 30


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--package", required=True)
    parser.add_argument("--output")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    spec = importlib.util.spec_from_file_location("still_export", Path(__file__).resolve().parents[1] / "backend" / "unreal_export.py")
    exporter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(exporter)
    reference = json.loads(Path(args.input).with_suffix(".json").read_text())
    with tempfile.TemporaryDirectory(prefix="still-morph-check-") as temporary:
        with zipfile.ZipFile(args.package) as archive:
            archive.extractall(temporary)
        directory = Path(temporary)
        manifest = json.loads((directory / "manifest.json").read_text())
        assert manifest["skinConversionMaxErrorCm"] < .001, manifest["skinConversionMaxErrorCm"]
        assert manifest["boneCount"] == len(reference["names"])
        assert manifest.get("morphTargets", []) == reference["morphTargets"]
        fps, intervals = manifest["fps"], manifest["frameCount"] - 1
        samples = sorted({0, intervals // 2, intervals})
        clear_scene()
        bpy.context.scene.unit_settings.scale_length = 1.
        bpy.ops.import_scene.gltf(filepath=str(Path(args.input).resolve()), guess_original_bind_pose=False)
        arm = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
        meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and not any(collection.hide_render for collection in obj.users_collection)]
        assert len(meshes) == 1, "This development check expects one fixture mesh"
        mesh = meshes[0]
        conversion = Matrix.Scale(100, 4) @ Matrix.Rotation(math.pi / 2, 4, "Z")
        matrix = np.array(conversion)
        convert = lambda vertices: vertices @ matrix[:3, :3].T + matrix[:3, 3]
        expected_vertices, expected_joints, expected_curves = {}, {}, {}
        for frame in range(intervals + 1):
            exporter.set_frame(frame)
            expected_curves[frame] = {key.name: float(key.value) for key in mesh.data.shape_keys.key_blocks[1:]} if mesh.data.shape_keys else {}
            if frame in samples:
                expected_vertices[frame] = convert(exporter.vertices_world(mesh, True))
                expected_joints[frame] = {bone.name: np.array((conversion @ arm.matrix_world @ bone.matrix).translation) for bone in arm.pose.bones}
        for name, values in reference["morphCurves"].items():
            assert max(abs(expected_curves[frame][name] - value) for frame, value in zip(samples, values)) < 1e-3
            assert max(abs(expected_curves[frame][name] - manifest["morphCurves"][name][frame]) for frame in expected_curves) < 1e-6
        arm.data.pose_position = "REST"
        exporter.reset_morph_weights(meshes)
        bpy.context.view_layer.update()
        rest_vertices = convert(exporter.vertices_world(mesh, True))
        report = {"blender": bpy.app.version_string, "frames": intervals + 1, "fps": fps, "duration": manifest["duration"],
                  "bones": manifest["boneCount"], "vertices": len(rest_vertices), "morphTargets": reference["morphTargets"],
                  "skinConversionMaxErrorCm": manifest["skinConversionMaxErrorCm"], "files": {}}
        for filename in ("character.fbx", "animation.fbx"):
            clear_scene()
            bpy.ops.import_scene.fbx(filepath=str(directory / filename), use_anim=filename == "animation.fbx", anim_offset=0.)
            arm = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
            assert set(arm.data.bones.keys()) == set(reference["names"]), arm.data.bones.keys()
            assert arm.data.bones["Face"].parent.name == "Root"
            meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
            mesh_included = bool(meshes)
            driving_arm = None
            if not meshes:
                assert filename == "animation.fbx" and not reference["morphTargets"]
                # Apply the skeleton-only animation to the separately imported character.
                driving_arm = arm
                bpy.ops.import_scene.fbx(filepath=str(directory / "character.fbx"), use_anim=False)
                meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
                arm = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE" and obj != driving_arm)
            if meshes:
                assert len(meshes) == 1
                mesh = meshes[0]
                names = [key.name for key in mesh.data.shape_keys.key_blocks[1:]] if mesh.data.shape_keys else []
                assert sorted(names) == sorted(reference["morphTargets"]), names
                arm.data.pose_position = "REST"
                exporter.reset_morph_weights(meshes)
                bpy.context.view_layer.update()
                imported_rest = exporter.vertices_world(mesh, True)
                distances = np.linalg.norm(rest_vertices[:, None, :] - imported_rest[None, :, :], axis=2)
                order = distances.argmin(axis=1)
                assert len(set(order)) == len(rest_vertices) == len(imported_rest), "FBX vertex correspondence changed"
                assert distances[np.arange(len(order)), order].max() < .001, distances.min(axis=1)
            if filename == "character.fbx":
                report["files"][filename] = {"shapeKeys": reference["morphTargets"], "restVertexMaxErrorCm": float(distances.min(axis=1).max())}
                continue
            arm.data.pose_position = "POSE"
            curve_error, vertex_error, joint_error, measured = 0., 0., 0., {}
            for frame in range(intervals + 1):
                exporter.set_frame(frame)
                if driving_arm:
                    for bone in arm.pose.bones:
                        bone.matrix = arm.matrix_world.inverted() @ driving_arm.matrix_world @ driving_arm.pose.bones[bone.name].matrix
                        bpy.context.view_layer.update()
                values = {key.name: float(key.value) for key in mesh.data.shape_keys.key_blocks[1:]} if mesh and mesh.data.shape_keys else {}
                for name, value in expected_curves[frame].items():
                    curve_error = max(curve_error, abs(values[name] - value))
                if frame in samples:
                    measured[frame] = values
                    for name, expected in expected_joints[frame].items():
                        joint_error = max(joint_error, float(np.linalg.norm(np.array((arm.matrix_world @ arm.pose.bones[name].matrix).translation) - expected)))
                    if mesh:
                        actual = exporter.vertices_world(mesh, True)[order]
                        vertex_error = max(vertex_error, float(np.linalg.norm(actual - expected_vertices[frame], axis=1).max()))
            assert curve_error < 1e-3, curve_error
            assert joint_error < .001, joint_error
            assert vertex_error < .001, vertex_error
            report["files"][filename] = {"morphSamples": measured, "morphWeightMaxError": curve_error,
                                         "jointMaxErrorCm": joint_error, "vertexMaxErrorCm": vertex_error, "meshIncluded": mesh_included}
        report["passed"] = True
        if args.output:
            Path(args.output).write_text(json.dumps(report, indent=2))
        print("STILL_MORPH_PROOF:" + json.dumps(report))


if __name__ == "__main__":
    main()
