"""Small adapter executed *inside* a licensed, installed Cascadeur instance.

Only public csc scene/data/layer APIs and Qt UI APIs are used. No vendor code or model
weights are bundled. This module owns a temporary application scene and restores
the previous scene when finished. Importing it has no side effects.
"""
from __future__ import annotations

import json

_jobs = {}


def _transform(scene, obj, frame):
    bv = scene.model_viewer().behaviour_viewer()
    dv = scene.data_viewer()
    transform = bv.get_behaviour_by_name(obj, "Transform")
    pos = dv.get_data_value(bv.get_behaviour_data(transform, "global_position"), frame)
    quat = dv.get_data_value(bv.get_behaviour_data(transform, "global_rotation"), frame).to_quaternion()
    return {"position": pos.flatten().tolist(), "quaternion": [quat.x(), quat.y(), quat.z(), quat.w()]}


def begin(job, template):
    import csc
    app = csc.app.get_application()
    manager = app.get_scene_manager()
    previous = manager.current_scene()
    view = manager.create_application_scene()
    _jobs[job] = {"view": view, "previous": previous}
    manager.set_current_scene(view)
    try:
        csc.app.ProjectLoader.load_from(template, view.domain_scene())
        scene = view.domain_scene()
        mv = scene.model_viewer()
        bv = mv.behaviour_viewer()
        if len(bv.get_behaviours("RigInfo")) != 1 or not bv.get_behaviours("AutoPosingLink"):
            raise RuntimeError("The installed Cascadeur proxy sample has no supported AutoPosing rig.")
        objects = {bv.get_behaviour_owner(b) for b in bv.get_behaviours("Joint")}
        parents = {}
        for obj in objects:
            parent = bv.get_behaviour_object(bv.get_behaviour_by_name(obj, "Basic"), "parent")
            parents[obj] = parent if parent in objects else None
        ordered = []
        while len(ordered) < len(objects):
            pending = [obj for obj in objects if obj not in ordered and (parents[obj] is None or parents[obj] in ordered)]
            if not pending:
                raise RuntimeError("The installed proxy skeleton has a cycle.")
            ordered.extend(sorted(pending, key=mv.get_object_name))
        _jobs[job]["objects"] = ordered
        result = {"names": [mv.get_object_name(obj) for obj in ordered],
                  "parents": [ordered.index(parents[obj]) if parents[obj] is not None else -1 for obj in ordered],
                  "restWorld": [_transform(scene, obj, 0) for obj in ordered]}
        app.get_tools_manager().get_tool("AutoPhysicsTool").editor(view).turn_off()
        app.get_tools_manager().get_tool("InbetweeningTool").editor(view).set_update_parameter(False)
        return result
    except Exception:
        finish(job)
        raise


def write_anchors(job, path):
    import csc
    import numpy as np
    app = csc.app.get_application()
    state = _jobs[job]
    view = state["view"]
    app.get_scene_manager().set_current_scene(view)
    scene = view.domain_scene()
    with open(path, encoding="utf-8") as stream:
        data = json.load(stream)
    anchors = data["anchors"]
    last = data["lastFrame"]
    mv = scene.model_viewer()
    bv = mv.behaviour_viewer()
    identifiers = []
    for obj in state["objects"]:
        transform = bv.get_behaviour_by_name(obj, "Transform")
        identifiers.append((bv.get_behaviour_data(transform, "global_position"),
                            bv.get_behaviour_data(transform, "global_rotation")))

    def structure(model, update, domain):
        le = model.layers_editor()
        for layer in scene.layers_viewer().layers_map().values():
            section = csc.layers.layer.Section()
            section.interval.interpolation = csc.layers.layer.Interpolation.BEZIER
            le.set_sections({anchor["frame"]: section for anchor in anchors}, layer.header.id)
        model.fit_animation_size_by_layers()

    if not scene.modify("Still temporary inference timeline", structure):
        raise RuntimeError("Cascadeur could not create the temporary inference timeline.")
    if scene.layers_viewer().frames_count() != last + 1:
        raise RuntimeError("Cascadeur timeline length did not match the requested motion.")

    def poses(model, update, updater):
        editor = model.data_editor()
        for anchor in anchors:
            modified = set()
            for ids, pose in zip(identifiers, anchor["pose"]):
                p, q = pose["position"], pose["quaternion"]
                editor.set_data_value(ids[0], anchor["frame"], np.asarray(p, dtype=np.float32))
                editor.set_data_value(ids[1], anchor["frame"], csc.math.Rotation.from_quaternion(q[3], q[0], q[1], q[2]))
                modified.update(ids)
            updater.run_update(modified, anchor["frame"])

    if not scene.modify_update("Still transfer authored poses to inference proxy", poses):
        raise RuntimeError("Cascadeur rejected one of the transferred poses.")
    state["lastFrame"] = last
    return {"frames": last + 1, "anchors": len(anchors),
            "actualAnchors": [{"frame": a["frame"], "pose": [_transform(scene, obj, a["frame"]) for obj in state["objects"]]} for a in anchors]}


def generate(job):
    import csc
    app = csc.app.get_application()
    view = _jobs[job]["view"]
    app.get_scene_manager().set_current_scene(view)
    scene = view.domain_scene()

    def change(model, update, domain):
        le = model.layers_editor()
        for layer in scene.layers_viewer().layers_map().values():
            def ai(section):
                section.interval.interpolation = csc.layers.layer.Interpolation.AI
            for frame in layer.sections:
                le.change_section(frame, layer.header.id, ai)

    if not scene.modify("Still learned inbetweening", change):
        raise RuntimeError("Cascadeur could not enable learned interpolation.")
    app.get_tools_manager().get_tool("InbetweeningTool").editor(view).set_update_parameter(True)
    return {"requested": True}


def read_frames(job, path):
    state = _jobs[job]
    scene = state["view"].domain_scene()
    frames = [[_transform(scene, obj, frame) for obj in state["objects"]] for frame in range(state["lastFrame"] + 1)]
    with open(path, "w", encoding="utf-8") as stream:
        json.dump({"frames": frames}, stream, allow_nan=False)
    return {"frames": len(frames), "joints": len(state["objects"])}


def finish(job):
    import csc
    state = _jobs.get(job)
    if not state:
        return
    # A cancelled worker can leave the native Snap choice open. Close only the
    # exact window created by this owned job, before removing its scene.
    dialog = state.get("physicsDialog")
    if dialog is not None:
        import shiboken6
        if shiboken6.isValid(dialog):
            dialog.close()
    if state.get("physicsRequested"):
        csc.app.get_application().get_tools_manager().get_tool("AutoPhysicsTool").editor(state["view"]).turn_off()
    manager = csc.app.get_application().get_scene_manager()
    current = manager.current_scene()
    manager.remove_application_scene(state["view"])
    _jobs.pop(job, None)
    restore = state["previous"] if current == state["view"] else current
    if restore in manager.scenes():
        manager.set_current_scene(restore)


def cleanup_owned_jobs():
    """Idempotent cancellation recovery; only this module's scratch scenes."""
    jobs = list(_jobs)
    for job in reversed(jobs):
        finish(job)
    return {"closedTemporaryScenes": len(jobs)}


def _physics_dialogs():
    from PySide6 import QtGui
    return [window for window in QtGui.QGuiApplication.instance().allWindows()
            if window.title() == "Apply AutoPhysics" and window.isVisible()]


def _physics_scene(job):
    import csc
    state = _jobs[job]
    if csc.app.get_application().current_scene() != state["view"]:
        raise RuntimeError("Cascadeur's active scene changed during the physics operation. Retry with Cascadeur idle.")
    return state


def begin_physics(job, template):
    """Load an owned proxy with learned interpolation and AutoPosing disabled."""
    import csc
    if _physics_dialogs():
        raise RuntimeError("Finish or dismiss the existing AutoPhysics dialog in Cascadeur before retrying.")
    result = begin(job, template)
    state = _jobs[job]
    view = state["view"]
    scene = view.domain_scene()
    app = csc.app.get_application()

    def disable(model, update, updater, session):
        app.get_tools_manager().get_tool("AutoPosingTool").editor(view).deactivate(
            session, set(scene.model_viewer().get_objects()))

    if not scene.modify_update_with_session("Still disable learned AutoPosing for physics-only correction", disable):
        raise RuntimeError("Cascadeur could not disable AutoPosing for the physics-only operation.")
    result["gravityMetersPerSecondSquared"] = float(view.gravity_per_frame()) * 30 * 30 / 100
    return result


def start_physics(job):
    import csc
    state = _physics_scene(job)
    if _physics_dialogs():
        raise RuntimeError("An existing AutoPhysics dialog prevents an isolated physics operation.")
    app = csc.app.get_application()
    app.get_tools_manager().get_tool("AutoPhysicsTool").editor(state["view"]).turn_off()
    state["physicsRequested"] = True
    app.get_action_manager().call_action("AutoPhysicsTool.Switch Auto Physics")
    return {"requested": True}


def request_physics_bake(job):
    """Own the fresh native choice dialog; never select a pre-existing prompt."""
    import csc
    state = _physics_scene(job)
    if not state.get("physicsRequested") or _physics_dialogs():
        raise RuntimeError("AutoPhysics is not ready for a new isolated bake.")
    csc.app.get_application().get_action_manager().call_action("AutoPhysicsTool.Snap to Auto Physics")
    dialogs = _physics_dialogs()
    if len(dialogs) != 1:
        raise RuntimeError("Cascadeur did not open the expected AutoPhysics bake choice.")
    state["physicsDialog"] = dialogs[0]
    return {"dialogCreated": True}


def apply_physics_bake(job):
    """Invoke the public Qt signal of the exact owned All Frames choice.

    Cascadeur 2026.2 exposes PySide6 for extensions. Its numeric AutoPhysics API
    does not expose the bake choice, so use Qt's documented meta-object API.
    Exact labels and ownership are deliberately checked to fail closed if the
    installed application's UI contract changes.
    """
    from PySide6 import QtCore
    state = _physics_scene(job)
    dialog = state.get("physicsDialog")
    if dialog is None or dialog not in _physics_dialogs():
        raise RuntimeError("The owned AutoPhysics bake dialog is no longer available.")
    stack = [dialog.contentItem()]
    held, buttons, bodies = [], [], []
    while stack:
        item = stack.pop()
        # Keep Qt wrappers alive during traversal: recycled Python ids cannot
        # reliably identify native objects once their wrappers are collected.
        held.append(item)
        stack.extend(item.childItems())
        name = item.metaObject().className()
        if "DialogButton_" in name:
            buttons.append(item)
        if "BaseButtonsDialog_" in name:
            bodies.append(item.property("text"))
    if bodies != ["Which frames should AutoPhysics results be applied to?"] or sorted(button.property("text") for button in buttons) != ["All Frames", "Only keys"]:
        raise RuntimeError("This Cascadeur version has an unsupported AutoPhysics bake dialog.")
    button = next(button for button in buttons if button.property("text") == "All Frames")
    if not button.isVisible() or not button.isEnabled() or not QtCore.QMetaObject.invokeMethod(button, "clicked", QtCore.Qt.DirectConnection):
        raise RuntimeError("Cascadeur could not apply AutoPhysics to all animation frames.")
    state["physicsBakeRequested"] = True
    return {"invoked": True, "choice": "All Frames"}


def read_physics_frames(job, path):
    import shiboken6
    state = _physics_scene(job)
    dialog = state.get("physicsDialog")
    if not state.get("physicsBakeRequested") or (dialog is not None and shiboken6.isValid(dialog) and dialog.isVisible()):
        raise RuntimeError("Cascadeur has not completed the owned AutoPhysics bake.")
    return read_frames(job, path)
