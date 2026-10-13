"""Blender-only development fixture. Does not require or launch Unreal.

/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
  --python scripts/morph-fixture.py -- [--without-morphs] [--output /tmp/fixture.glb]
"""
import argparse
import json
from pathlib import Path
import sys

import bpy
from mathutils import Euler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--without-morphs", action="store_true")
    parser.add_argument("--output", default="/tmp/still-morph-fixture.glb")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene.render.fps = 30
    scene.frame_start, scene.frame_end = 0, 60
    arm = bpy.data.objects.new("FixtureRig", bpy.data.armatures.new("FixtureRig"))
    scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    root = arm.data.edit_bones.new("Root")
    root.head, root.tail = (0, 0, 0), (0, 0, 1)
    face = arm.data.edit_bones.new("Face")
    face.head, face.tail, face.parent = (0, 0, 1), (0, 0, 2), root
    bpy.ops.object.mode_set(mode="OBJECT")
    vertices = [(x, y, z) for z in (0, 1, 2) for x, y in ((-.4, -.2), (.4, -.2), (.4, .2), (-.4, .2))]
    faces = [(3, 2, 1, 0), (8, 9, 10, 11)]
    faces += [(ring + i, ring + (i + 1) % 4, ring + (i + 1) % 4 + 4, ring + i + 4) for ring in (0, 4) for i in range(4)]
    data = bpy.data.meshes.new("FaceMesh")
    data.from_pydata(vertices, [], faces)
    data.update()
    mesh = bpy.data.objects.new("FaceMesh", data)
    scene.collection.objects.link(mesh)
    mesh.parent = arm
    # Exercise shape-key transforms as well as the export's axis/centimeter bake.
    mesh.location = (.12, -.08, .2)
    mesh.rotation_euler.z = .15
    mesh.scale = (1.1, 1.1, 1.1)
    for polygon in data.polygons:
        polygon.use_smooth = True
    for name in ("Root", "Face"):
        mesh.vertex_groups.new(name=name)
    for index, (_, _, z) in enumerate(vertices):
        weight = z / 2
        if weight < 1:
            mesh.vertex_groups["Root"].add([index], 1 - weight, "REPLACE")
        if weight > 0:
            mesh.vertex_groups["Face"].add([index], weight, "REPLACE")
    modifier = mesh.modifiers.new("Skin", "ARMATURE")
    modifier.object = arm
    curves = {"Blink": [.15, .85, .25], "Smile": [.8, .2, 1.]}
    if not args.without_morphs:
        mesh.shape_key_add(name="Basis")
        for name in curves:
            shape = mesh.shape_key_add(name=name)
            for index, (x, y, z) in enumerate(vertices):
                if z == 2:
                    if name == "Blink":
                        shape.data[index].co.z -= .3
                    else:
                        shape.data[index].co.x += .15 if x > 0 else -.15
                        shape.data[index].co.y += .1
            for frame, value in zip((0, 30, 60), curves[name]):
                shape.value = value
                shape.keyframe_insert("value", frame=frame)
    for frame, travel, angle in ((0, 0, 0), (30, .25, .3), (60, .5, -.2)):
        arm.pose.bones["Root"].location.x = travel
        arm.pose.bones["Root"].keyframe_insert("location", frame=frame)
        bone = arm.pose.bones["Face"]
        bone.rotation_mode = "QUATERNION"
        bone.rotation_quaternion = Euler((0, angle, 0)).to_quaternion()
        bone.keyframe_insert("rotation_quaternion", frame=frame)
    for action in bpy.data.actions:
        for layer in action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    for curve in bag.fcurves:
                        for point in curve.keyframe_points:
                            point.interpolation = "LINEAR"
    scene.frame_set(0)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=str(output), export_format="GLB", export_animation_mode="ACTIVE_ACTIONS",
                              export_force_sampling=True, export_frame_range=True, export_morph=not args.without_morphs)
    reference = {"morphTargets": [] if args.without_morphs else list(curves), "morphCurves": {} if args.without_morphs else curves,
                 "sampleTimes": [0, 1, 2], "fps": 30, "duration": 2, "names": ["Root", "Face"]}
    output.with_suffix(".json").write_text(json.dumps(reference, indent=2))
    print("STILL_MORPH_FIXTURE:" + json.dumps({"file": str(output), **reference}))


if __name__ == "__main__":
    main()
