# Script Still from an agent

Still exposes the editor through a local authenticated API, a Node SDK and CLI, and an optional MCP stdio server. Scripts can inspect the skeleton, author poses and keys, run available motion engines, change the view, undo edits, and export files. **The Electron app keeps its editor running when its window is closed to the tray.** No browser tab is needed. Choose Quit Still to stop it. The development browser version still needs its tab open.

## Start and discover

Start the desktop app, or run `npm run dev` for browser development. Desktop agent tools live at `%APPDATA%/Still Motion Studio/agent-tools/`; the connection file is in its sibling `.local/agent/` directory. The Still menu opens these folders. For the development version, The service writes `.local/agent/connection.json` with its actual loopback address and access token. The client reads this file automatically; keep it private and do not paste it into prompts or commit it. There are no cloud uploads in this control path.

```powershell
node scripts/still-agent.mjs sessions
node scripts/still-agent.mjs schema
node scripts/still-agent.mjs call scene.inspect '{}' --session SESSION_UUID
```

Choose the intended session ID from `sessions`. Without an explicit ID, the SDK selects a tab only when exactly one connected tab exists, then pins that selection for the client's lifetime. It never silently switches to another tab. Multiple tabs require selection, and a disconnected tab produces an error.

The live `schema` is authoritative: it describes every method, parameter, limit, and whether a method mutates the scene. Large or awkwardly quoted arguments can come from a JSON file: `node scripts/still-agent.mjs call keys.replace '@poses.json' --session SESSION_UUID`.

## SDK

Use Node 22.12+ as required by Still; no added package dependencies. For an ES module beside the project root:

```js
import { createClient } from './scripts/still-agent.mjs';

const still = await createClient({ sessionId: 'SESSION_UUID' });
const scene = await still.call('scene.inspect');
const skeleton = await still.call('skeleton.inspect');
const hand = skeleton.bones.find(bone => bone.name === 'RightHand');
if (!hand) throw new Error('Choose the intended hand from skeleton.bones.');

const edited = await still.call('pose.move', {
  bone: hand.index,
  time: 1.6,
  target: [0.6, 1.8, 0.2],
}, { expectedRevision: scene.revision });

await still.exportFile('glb', './edited-motion.glb', {
  expectedRevision: edited.revision,
});
```

`pose.move` targets use the editor's world coordinates: approximately meters, +Y up and +Z forward. Full poses and `pose.set` bone edits use **native local bone units**, which may differ on imported skeletons. Quaternions are `[x,y,z,w]`; `rotationDegrees` is local XYZ Euler rotation. Prefer bone indices from `skeleton.inspect`: duplicate bone names cannot identify an unambiguous joint. A pose array contains one transform per bone, in that inspection order.

Every command result includes `revision`. Pass the last observed revision as `expectedRevision` on dependent edits or exports. A concurrent user edit fails that command rather than allowing a stale script to replace newer work. Read the scene again before deciding how to continue; do not blindly retry a revision conflict.

| Client method | Behavior |
| --- | --- |
| `schema()`, `sessions()` | Discover methods and browser tabs. |
| `call(method, params, options)` | Submit, poll, and return the completed result. |
| `enqueue(method, params, options)` | Return the queued job immediately. |
| `job(id)`, `wait(id, options)`, `cancel(id)` | Read, await, or request cancellation of a job. |
| `uploadFile(path)` | Upload bytes to local staging and return a file reference. |
| `importFile(path, options)` | Upload and run `scene.import` in the selected tab. |
| `downloadFile(fileId, path, options)` | Save a staged file locally. |
| `exportFile(format, path, options)` | Export `glb`, `still`, `unreal` ZIP, or viewport `png`, then save it. |

`createClient` accepts `connectionFile`, `sessionId`, `timeoutMs`, and `requestTimeoutMs`; an explicit loopback `baseUrl`/`token` pair is also supported. `STILL_AGENT_CONNECTION` selects a different connection file. `call` options include `sessionId`, `expectedRevision`, UUID `id`, `timeoutMs`, an AbortSignal `signal`, and `onProgress(job)`. Waiting polls every 400 ms and defaults to ten minutes; a timeout or aborted wait requests cancellation. Inspect the job until terminal before assuming cancellation completed.

The client never automatically retries a mutation. An uncertain network outcome includes `error.details.jobId`; inspect that job. If resubmission is appropriate, reuse its **same UUID, session, method, and parameters**, including revision. A new UUID means a new command. Application failures use `StillError` with `code` and `details`.

Uploads are capped at 200 MiB. Paths are read or written by the local SDK/MCP process; the server receives file IDs and bytes, never arbitrary filesystem paths. Exports default to `overwrite: false` and use atomic no-replace file creation. Parent directories must exist. An explicitly authorized overwrite can use `{overwrite: true}`. Provider, license, and export prerequisites are the same as in the editor; [Unreal import details](unreal-export.md) still apply.

## Method catalogue

The full parameter schemas are in `shared/agent-schema.json` and `GET /api/agent/schema`. The currently implemented groups are:

| Area | Methods |
| --- | --- |
| Scene and recovery | `scene.inspect`, `scene.new`, `scene.import`, `scene.rename`, `scene.project`, `scene.restore`, `scene.save`, `scene.archives`, `scene.restoreArchive` |
| Skeleton and clips | `skeleton.inspect`, `skeleton.rig`, `skeleton.kind`, `clips.list`, `clips.select` |
| Pose editing | `pose.get`, `pose.set`, `pose.move`, `pose.reset` |
| Authored keys | `keys.list`, `keys.put`, `keys.replace`, `keys.delete`, `keys.move`, `keys.simplify` |
| Playback and view | `timeline.set`, `playback.set`, `settings.set`, `view.set` |
| History | `history.undo`, `history.redo` |
| Motion and physics | `motion.run`, `motion.clear`, `motion.quickGround`, `motion.recover` |
| Deliverables | `export` |

`keys.replace` validates an entire set of poses before one history change, making it useful for six-pose authoring. `scene.new` and import/restore operations replace the selected tab's scene; the editor archives previous work. Starter rigging remains heuristic, and procedural interpolation/ground assistance is distinct from learned motion providers. Scripts do not bypass those existing limits.

## Complete example and CLI

The example creates a **new humanoid scene in the selected tab**, replacing that tab's current scene through the normal archive behavior. It inspects the rig, writes six poses, demonstrates an edit and undo/redo, and exports an editable project and GLB under a fresh `.local/agent-example/wave-*` directory.

```powershell
node scripts/still-agent.mjs run examples/agent-wave.mjs --session SESSION_UUID
node examples/agent-wave.mjs --session SESSION_UUID --unreal
```

Add `--provider PROVIDER_ID` only when you want to run an available motion engine; discover availability with `scene.inspect`. Add `--unreal` to request an Unreal ZIP. The example's default interpolation is procedural smoothing. Every dependent command uses the preceding result's revision.

The CLI also supports `import INPUT`, `export FORMAT OUTPUT`, `enqueue METHOD JSON`, `job UUID`, and `cancel UUID`. Global flags are `--connection FILE`, `--session UUID`, `--revision NUMBER`, `--timeout MILLISECONDS`, and `--id UUID`. `run` loads a trusted local ES module exporting `default async (client, args, options)`. Ctrl+C requests cancellation of the active awaited command. Output is JSON, with errors on stderr.

## MCP

Configure an MCP client to launch Node with an absolute script path. A typical stdio configuration is:

```json
{
  "mcpServers": {
    "still": {
      "command": "node",
      "args": ["C:/path/to/still-motion-studio/scripts/still-mcp.mjs"]
    }
  }
}
```

Optional arguments are `--connection FILE` and `--session UUID`. The server exposes `still_discover`, `still_sessions`, `still_inspect`, `still_command`, `still_job`, `still_cancel`, `still_import_file`, and `still_export_file`. Begin with discovery and session selection. `still_command` accepts any method in the live catalogue with its parameter object; use `wait: false` and `still_job` for clients with short tool-call time limits. This is not a generic shell or browser JavaScript evaluator.

The dependency-free transport implements newline-delimited JSON-RPC, initialization, tool listing/calls, ping, progress notifications, request cancellation, and clean stdin shutdown. It advertises protocol version 2025-11-25, with compatible older version negotiation, following the official [stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), and [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) specifications. Only MCP messages go to stdout; connection tokens are never printed.

Focused local transport checks cover session ambiguity and pinning, stable command IDs, revision failures, timeout cancellation, upload/import, export overwrite protection, and a real MCP subprocess handshake, discovery, command execution, cancellation, and shutdown. Their development report is `.local/agent-sdk-smoke.json`.

The live editor check also passed: the CLI example authored six keys with distinct wave poses between matching rest endpoints, exercised undo/redo, and downloaded valid `.still`, GLB, and Unreal ZIP outputs. The ZIP contained both FBXs, manifest, instructions, and the Unreal import script. A separate MCP subprocess discovered all 35 live methods and inspected that scene's 21-bone skeleton. Evidence is `.local/agent-live-verify.json`; broader editor coverage is tracked in `docs/verification.md`.

## Camera and Unreal options

`scene.inspect` includes camera limits. `view.set` accepts coordinates between -10000 and 10000, a 10–100 degree field of view, and a position-to-target distance of 1.2–15 world units.

For Unreal exports, `client.call("export", {format:"unreal", fps:30, rootMotion:"extract", retarget:"manny"})` adds a gameplay root and prepares automatic target retargeting during Unreal import. `targetMesh` is an optional `/Game/...` SkeletalMesh object path; use it to select a particular MetaHuman body. With `retarget:"none"`, pass a matching Skeleton or SkeletalMesh path in `targetMesh` to import animation directly onto an existing character. Use `rootMotion:"preserve"` unless the target has the same added root bone. The same fields can be passed in SDK `exportFile` settings.

For the existing character's own bone names and rest pose, import its original binary FBX in the current session, then use `client.call("export", {format:"unreal", fps:30, rootMotion:"extract", retarget:"skeleton", targetSkeleton:"/Game/KarateBear/SKEL_KarateBear.SKEL_KarateBear"})`. The reference FBX defaults to the imported asset's bytes; `scene.inspect` reports availability as `hasReferenceFbx`; saved `.still` projects do not retain them. `targetSkeleton` also works in SDK `exportFile` settings and the `still_export_file` MCP tool.
