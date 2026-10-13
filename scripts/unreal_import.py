"""Optional one-click import for an extracted Still Unreal export package.

Enable Python Editor Script Plugin and Editor Scripting Utilities, then choose
Tools > Execute Python Script and select this file beside manifest.json.
Only new assets are created; the temporary importer setting is restored.
"""
import json
from pathlib import Path
import re
import sys

import unreal


def import_fbx(filename, destination, skeleton=None, fps=30, conversion=None):
    options = unreal.FbxImportUI()
    options.set_editor_property("automated_import_should_detect_type", False)
    options.set_editor_property("import_as_skeletal", True)
    options.set_editor_property("import_mesh", skeleton is None)
    options.set_editor_property("import_animations", skeleton is not None)
    options.set_editor_property("import_materials", skeleton is None)
    options.set_editor_property("import_textures", skeleton is None)
    options.set_editor_property("create_physics_asset", False)
    options.set_editor_property("mesh_type_to_import", unreal.FBXImportType.FBXIT_SKELETAL_MESH if skeleton is None else unreal.FBXImportType.FBXIT_ANIMATION)
    if skeleton is not None:
        options.set_editor_property("skeleton", skeleton)
    for data in [options.skeletal_mesh_import_data, options.anim_sequence_import_data]:
        data.set_editor_property("convert_scene", True)
        data.set_editor_property("convert_scene_unit", True)
        data.set_editor_property("force_front_x_axis", False)
        data.set_editor_property("import_uniform_scale", 1.)
    # An existing character's clip must be converted exactly like that character was.
    for key, value in (conversion or {}).items():
        options.anim_sequence_import_data.set_editor_property(key, value)
    mesh_data = options.skeletal_mesh_import_data
    mesh_data.set_editor_property("update_skeleton_reference_pose", False)
    mesh_data.set_editor_property("use_t0_as_ref_pose", False)
    mesh_data.set_editor_property("import_meshes_in_bone_hierarchy", False)
    mesh_data.set_editor_property("import_morph_targets", True)
    mesh_data.set_editor_property("normal_import_method", unreal.FBXNormalImportMethod.FBXNIM_IMPORT_NORMALS)
    anim_data = options.anim_sequence_import_data
    anim_data.set_editor_property("animation_length", unreal.FBXAnimationLengthImportType.FBXALIT_EXPORTED_TIME)
    anim_data.set_editor_property("use_default_sample_rate", False)
    anim_data.set_editor_property("custom_sample_rate", int(fps))
    anim_data.set_editor_property("snap_to_closest_frame_boundary", True)
    anim_data.set_editor_property("import_bone_tracks", True)
    anim_data.set_editor_property("preserve_local_transform", True)
    anim_data.set_editor_property("remove_redundant_keys", False)
    anim_data.set_editor_property("import_custom_attribute", True)
    anim_data.set_editor_property("do_not_import_curve_with_zero", False)
    anim_data.set_editor_property("delete_existing_morph_target_curves", False)
    task = unreal.AssetImportTask()
    task.set_editor_property("filename", str(Path(filename).resolve()))
    task.set_editor_property("destination_path", destination)
    task.set_editor_property("destination_name", "SK_Character" if skeleton is None else "A_Motion")
    task.set_editor_property("automated", True)
    task.set_editor_property("replace_existing", False)
    task.set_editor_property("save", True)
    task.set_editor_property("options", options)
    task.set_editor_property("factory", unreal.FbxFactory())
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    paths = list(task.get_editor_property("imported_object_paths"))
    assets = [unreal.load_asset(path) for path in paths]
    if not assets:
        raise RuntimeError("Unreal imported no assets from " + str(filename))
    # Automated FBX import may leave the generated Skeleton unsaved even when
    # AssetImportTask.save is true. Persist dependencies before saving animations
    # so the package also works after the editor is closed and reopened.
    for asset in assets:
        if isinstance(asset, unreal.SkeletalMesh):
            unreal.EditorAssetLibrary.save_loaded_asset(asset.get_editor_property("skeleton"), False)
        unreal.EditorAssetLibrary.save_loaded_asset(asset, False)
    unreal.EditorAssetLibrary.save_directory(destination, False, True)
    return assets, paths



def animation_curve_names(animation):
    library = unreal.AnimationLibrary
    if not hasattr(library, "get_animation_curve_names"):
        raise RuntimeError("UE 5.8 AnimationLibrary.get_animation_curve_names is required to inspect imported morph curves.")
    return [str(name) for name in library.get_animation_curve_names(animation, unreal.RawCurveTrackTypes.RCT_FLOAT)]


def existing_skeleton(asset_path, bones):
    target = unreal.load_asset(asset_path)
    skeleton = target.get_editor_property("skeleton") if isinstance(target, unreal.SkeletalMesh) else target
    if not isinstance(skeleton, unreal.Skeleton):
        raise ValueError("Choose an existing Unreal Skeleton or SkeletalMesh: " + asset_path)
    names = [str(name) for name in skeleton.get_reference_pose().get_bone_names()]
    lookup = {name.lower() for name in names}
    missing = [bone["name"] for bone in bones if bone["name"].lower() not in lookup]
    roots = [bone["name"] for bone in bones if bone.get("parent") is None]
    if not bones or missing or len(roots) != 1 or not names or roots[0].lower() != names[0].lower():
        detail = ", ".join(missing[:8]) if missing else "the root bone differs"
        raise ValueError("The exported rig does not match the target skeleton (" + detail + "). Use the same source rig and Original movement, or retarget to a different character.")
    if isinstance(target, unreal.SkeletalMesh):
        for bone in bones:
            parent = str(target.get_bone_parent(bone["name"]))
            if parent.lower() != (bone.get("parent") or "None").lower():
                raise ValueError("The target bone hierarchy differs at " + bone["name"] + ". Use the same source rig or retarget the animation.")
    return skeleton


def existing_conversion(asset_path):
    """The FBX conversion settings an existing SkeletalMesh was imported with, if Unreal kept them."""
    target = unreal.load_asset(asset_path)
    data = target.get_editor_property("asset_import_data") if isinstance(target, unreal.SkeletalMesh) else None
    if not isinstance(data, unreal.FbxAssetImportData):
        return None
    return {key: data.get_editor_property(key) for key in
            ("convert_scene", "convert_scene_unit", "force_front_x_axis", "import_uniform_scale", "import_rotation", "import_translation")}


def import_package(directory=None):
    directory = Path(directory or Path(__file__).resolve().parent)
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8-sig"))
    fps = int(manifest["fps"])
    if not 1 <= fps <= 240:
        raise ValueError("The package sample rate is unsupported.")
    for filename in ("character.fbx", "animation.fbx"):
        if not (directory / filename).is_file():
            raise FileNotFoundError("Extract the entire Still ZIP before importing: " + filename)
    retarget = manifest.get("retarget", {})
    target_path = retarget.get("targetMesh", "") if retarget.get("mode", "none") == "none" else ""
    skeleton = existing_skeleton(target_path, manifest.get("bones", [])) if target_path else None
    name = re.sub(r"[^a-zA-Z0-9_]", "_", manifest.get("name", "Character")).strip("_") or "Character"
    base = "/Game/Still/" + name
    destination, index = base, 1
    while unreal.EditorAssetLibrary.does_directory_exist(destination):
        destination = base + "_" + str(index)
        index += 1
    cvar = "Interchange.FeatureFlags.Import.FBX"
    previous = unreal.SystemLibrary.get_console_variable_int_value(cvar)
    try:
        # FbxImportUI is the documented legacy options object. Select that
        # importer for this operation instead of letting Interchange ignore it.
        unreal.SystemLibrary.execute_console_command(None, cvar + " 0")
        paths, meshes = [], []
        if skeleton is None:
            assets, paths = import_fbx(directory / "character.fbx", destination, fps=fps)
            meshes = [asset for asset in assets if isinstance(asset, unreal.SkeletalMesh)]
            if len(meshes) != 1:
                raise RuntimeError("Expected one imported skeletal mesh. See Unreal's Output Log.")
            skeleton = meshes[0].get_editor_property("skeleton")
        conversion = existing_conversion(target_path) if target_path and manifest.get("mode") == "existing-skeleton" else None
        assets, animation_paths = import_fbx(directory / "animation.fbx", destination, skeleton, fps, conversion)
        sequences = [asset for asset in assets if isinstance(asset, unreal.AnimSequence)]
        if len(sequences) != 1 or sequences[0].get_editor_property("skeleton") != skeleton:
            raise RuntimeError("The animation could not be assigned to the selected skeleton.")
        root_motion = manifest.get("rootMotion", "preserve") == "extract"
        unreal.AnimationLibrary.set_root_motion_enabled(sequences[0], root_motion)
        if root_motion:
            unreal.AnimationLibrary.set_root_motion_lock_type(sequences[0], unreal.RootMotionRootLock.ANIM_FIRST_FRAME)
        unreal.EditorAssetLibrary.save_loaded_asset(sequences[0], False)
        result = {"destination": destination, "assets": paths + animation_paths,
                  "skeleton": skeleton.get_path_name(), "fps": fps,
                  "duration": sequences[0].get_play_length(), "rootMotionEnabled": root_motion}
        if manifest.get("morphTargets"):
            curves = animation_curve_names(sequences[0])
            result["morphCurves"] = [name for name in curves if name in manifest["morphTargets"]]
            unreal.log("Still imported morph curves: " + json.dumps(result["morphCurves"]))
            missing = sorted(set(manifest.get("morphCurves", {})) - set(curves))
            if missing:
                raise RuntimeError("Unreal did not import the expected morph curves: " + ", ".join(missing))
        if retarget.get("mode", "none") != "none":
            helper = str(directory.resolve())
            sys.path.insert(0, helper)
            try:
                # Reload so two extracted packages cannot accidentally use a cached helper.
                import importlib.util
                spec = importlib.util.spec_from_file_location("still_package_retarget", directory / "unreal_retarget.py")
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                result["retarget"] = module.retarget_animation(meshes[0], sequences[0], destination, retarget["mode"], retarget.get("targetMesh", ""), root_motion)
            finally:
                sys.path.remove(helper)
        unreal.log("Still import complete: " + json.dumps(result))
        for warning in manifest.get("warnings", []):
            unreal.log_warning("Still export: " + str(warning))
        return result
    except Exception:
        # The destination was absent before this operation and is restricted to
        # our own namespace. Remove partial imports without touching older work.
        if destination.startswith("/Game/Still/") and unreal.EditorAssetLibrary.does_directory_exist(destination):
            try:
                if not unreal.EditorAssetLibrary.delete_directory(destination):
                    unreal.log_warning("Still could not remove the incomplete import at " + destination)
            except Exception as cleanup_error:
                unreal.log_warning("Still incomplete import needs cleanup at " + destination + ": " + str(cleanup_error))
        raise
    finally:
        unreal.SystemLibrary.execute_console_command(None, cvar + " " + str(previous))


if __name__ == "__main__":
    STILL_IMPORT_RESULT = import_package()
