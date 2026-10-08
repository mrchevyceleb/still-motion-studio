"""Create and bake a humanoid IK retargeter inside the destination Unreal project.

Only new assets below the import's own folder are written. Target characters are
loaded from the user's project; no Epic mesh or skeleton is distributed by Still.
"""
import math
import re
import unreal


def _clean(name):
    return re.sub(r"[^a-z0-9]", "", str(name).lower()).replace("mixamorig", "")


def resolve_target(mode, asset_path=""):
    if asset_path:
        mesh = unreal.load_asset(asset_path)
        if not isinstance(mesh, unreal.SkeletalMesh):
            raise ValueError("Target mesh is not a SkeletalMesh: " + asset_path)
        return mesh
    if mode == "manny":
        for path in ("/Game/Characters/Mannequins/Meshes/SKM_Manny", "/Game/Characters/Mannequins/Meshes/SKM_Manny_Simple"):
            mesh = unreal.load_asset(path)
            if isinstance(mesh, unreal.SkeletalMesh):
                return mesh
    registry = unreal.AssetRegistryHelpers.get_asset_registry()
    assets = registry.get_assets_by_class(unreal.TopLevelAssetPath("/Script/Engine", "SkeletalMesh"), True)
    candidates = []
    for asset in assets:
        name, package = str(asset.asset_name).lower(), str(asset.package_name)
        if mode == "manny" and name in ("skm_manny", "skm_manny_simple"):
            candidates.append(asset)
        elif mode == "metahuman" and ("/metahumans/" in package.lower()) and (name == "body" or name.endswith("_body")):
            candidates.append(asset)
    if len(candidates) == 1:
        return candidates[0].get_asset()
    if not candidates:
        raise ValueError("Add a " + ("Manny" if mode == "manny" else "MetaHuman body") + " SkeletalMesh to this Unreal project, or provide its targetMesh asset path in Still before exporting.")
    raise ValueError("Several target bodies exist. Set targetMesh to the desired SkeletalMesh asset path in Still, then export again.")


def _rig(mesh, name, destination):
    asset = unreal.AssetToolsHelpers.get_asset_tools().create_asset(name, destination, unreal.IKRigDefinition, unreal.IKRigDefinitionFactory())
    if asset is None:
        raise RuntimeError("Could not create " + name + ". Enable the IK Rig plugin and retry.")
    controller = unreal.IKRigController.get_controller(asset)
    if not controller.set_skeletal_mesh(mesh):
        raise RuntimeError("Could not initialize IK Rig for " + mesh.get_path_name())
    modifier = unreal.SkeletonModifier()
    if not modifier.set_skeletal_mesh(mesh):
        raise RuntimeError("Could not inspect target skeleton.")
    names = [str(bone) for bone in modifier.get_all_bone_names()]
    lookup = {_clean(bone): bone for bone in names}
    def pick(*alternatives):
        return next((lookup[_clean(value)] for value in alternatives if _clean(value) in lookup), None)
    pelvis = pick("hips", "pelvis")
    if pelvis is None:
        raise ValueError("Automatic humanoid retargeting needs a Hips or Pelvis bone; found no supported pelvis in " + mesh.get_path_name())
    # The canonical chain names give Mixamo, Manny and MetaHuman the same map.
    # Auto-FBIK installs Epic's physical goals when its template recognizes the mesh.
    auto_definition = controller.apply_auto_generated_retarget_definition()
    auto_ik = controller.apply_auto_fbik() if auto_definition else False
    goals = {str(controller.get_retarget_chain_end_bone(chain.chain_name)): controller.get_retarget_chain_goal(chain.chain_name)
             for chain in controller.get_retarget_chains()}
    for chain in list(controller.get_retarget_chains()):
        controller.remove_retarget_chain(chain.chain_name)
    chains = {
        "Spine": (pick("spine", "spine_01"), pick("spine_05", "spine_04", "spine_03", "spine2", "chest", "spine_02", "spine1")),
        "Head": (pick("neck", "neck_01"), pick("head")),
        "LeftArm": (pick("LeftArm", "upperarm_l"), pick("LeftHand", "hand_l")),
        "RightArm": (pick("RightArm", "upperarm_r"), pick("RightHand", "hand_r")),
        "LeftLeg": (pick("LeftUpLeg", "thigh_l"), pick("LeftFoot", "foot_l")),
        "RightLeg": (pick("RightUpLeg", "thigh_r"), pick("RightFoot", "foot_r")),
        "LeftClavicle": (pick("LeftShoulder", "clavicle_l"), pick("LeftShoulder", "clavicle_l")),
        "RightClavicle": (pick("RightShoulder", "clavicle_r"), pick("RightShoulder", "clavicle_r")),
        "LeftToe": (pick("LeftToeBase", "ball_l"), pick("LeftToeBase", "ball_l")),
        "RightToe": (pick("RightToeBase", "ball_r"), pick("RightToeBase", "ball_r")),
    }
    required = {"Spine", "Head", "LeftArm", "RightArm", "LeftLeg", "RightLeg"}
    missing = sorted(key for key in required if not all(chains[key]))
    if missing:
        raise ValueError("Automatic humanoid chain mapping could not identify " + ", ".join(missing) + " on " + mesh.get_path_name())
    for chain_name, (start, end) in chains.items():
        if start and end:
            ancestor = end
            while ancestor != start and ancestor not in ("None", ""):
                ancestor = str(modifier.get_parent_name(ancestor))
            if ancestor != start:
                raise ValueError("The " + chain_name + " end joint is not below its start joint; automatic retargeting requires a connected humanoid chain.")
            controller.add_retarget_chain(chain_name, start, end, goals.get(end, "None"))
    controller.set_retarget_root(pelvis)
    root = names[0]
    if hasattr(controller, "set_root_motion_bone"):
        controller.set_root_motion_bone(root)
    unreal.EditorAssetLibrary.save_loaded_asset(asset)
    return asset, {"pelvis": pelvis, "root": root, "chains": [key for key, bones in chains.items() if all(bones)], "autoFBIK": bool(auto_ik)}


def retarget_animation(source_mesh, animation, destination, mode, asset_path="", root_motion=False):
    if not all(hasattr(unreal, name) for name in ("IKRigController", "IKRetargeterController", "IKRetargetBatchOperation")):
        raise RuntimeError("Enable the IK Rig plugin in Unreal, restart the editor, and run this import again.")
    target_mesh = resolve_target(mode, asset_path)
    source_rig, source_info = _rig(source_mesh, "IK_Still_Source", destination)
    target_rig, target_info = _rig(target_mesh, "IK_Still_Target", destination)
    retargeter = unreal.AssetToolsHelpers.get_asset_tools().create_asset("RTG_Still", destination, unreal.IKRetargeter, unreal.IKRetargetFactory())
    if retargeter is None:
        raise RuntimeError("Could not create the Unreal IK Retargeter.")
    controller = unreal.IKRetargeterController.get_controller(retargeter)
    controller.set_ik_rig(unreal.RetargetSourceOrTarget.SOURCE, source_rig)
    controller.set_ik_rig(unreal.RetargetSourceOrTarget.TARGET, target_rig)
    controller.set_preview_mesh(unreal.RetargetSourceOrTarget.SOURCE, source_mesh)
    controller.set_preview_mesh(unreal.RetargetSourceOrTarget.TARGET, target_mesh)
    controller.add_default_ops()
    controller.auto_map_chains(unreal.AutoMapChainType.EXACT, True)
    controller.auto_align_all_bones(unreal.RetargetSourceOrTarget.TARGET)
    unreal.EditorAssetLibrary.save_loaded_asset(retargeter)
    data = unreal.AssetRegistryHelpers.create_asset_data(animation)
    if hasattr(unreal.IKRetargetBatchOperation, "run_batch_retarget"):
        inputs = unreal.IKRetargetBatchOperationInputs()
        for key, value in {"assets_to_retarget": [data], "source_mesh": source_mesh, "target_mesh": target_mesh,
                           "ik_retarget_asset": retargeter, "target_path": destination + "/Retargeted", "suffix": "_" + mode,
                           "use_source_path": False, "include_referenced_assets": False, "overwrite_existing_files": False}.items():
            inputs.set_editor_property(key, value)
        outputs = unreal.IKRetargetBatchOperation.run_batch_retarget(inputs)
    else:
        outputs = unreal.IKRetargetBatchOperation.duplicate_and_retarget([data], source_mesh, target_mesh, retargeter, suffix="_" + mode, target_path=destination + "/Retargeted", include_referenced_assets=False, overwrite_existing_files=False)
    sequences = [asset.get_asset() for asset in outputs if isinstance(asset.get_asset(), unreal.AnimSequence)]
    if len(sequences) != 1 or sequences[0].get_editor_property("skeleton") != target_mesh.get_editor_property("skeleton"):
        raise RuntimeError("Unreal did not produce one animation on the selected target skeleton.")
    result = sequences[0]
    if not math.isclose(result.get_play_length(), animation.get_play_length(), abs_tol=.0001):
        raise RuntimeError("Retargeted animation duration changed unexpectedly.")
    unreal.AnimationLibrary.set_root_motion_enabled(result, root_motion)
    if root_motion:
        unreal.AnimationLibrary.set_root_motion_lock_type(result, unreal.RootMotionRootLock.ANIM_FIRST_FRAME)
    unreal.EditorAssetLibrary.save_loaded_asset(result, False)
    return {"animation": result.get_path_name(), "targetMesh": target_mesh.get_path_name(), "skeleton": target_mesh.get_editor_property("skeleton").get_path_name(),
            "retargeter": retargeter.get_path_name(), "sourceRig": source_info, "targetRig": target_info, "rootMotionEnabled": root_motion}
