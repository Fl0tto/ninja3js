# Active checkpoint: 2026-10-28

FN resumed as a package for a different host than planned: the arena 3D battle client
(Fl0tto/arena-showdown, M4). The MMO return milestone below still stands for the MMO.

## Package boundary, realised

- `src/index.ts` is the library entry; `package.json` is `ninja3js@0.2.0` with `three` as a peer
  (`>=0.185 <0.190`, developed on 0.185.1, consumed on 0.186) and TypeScript source in `exports`.
- `GroundMist` (new) is the host contract from the 14 Sep review: fluid field, volume rendering and
  window placement inside; the host supplies renderer, scene, timing, actor positions and events in
  world units. Fixed or scrolling window; slot allocation and lifetimes are the library's problem.
- `FluidFire` gained `visuals: false` (no particles, slices, decor or their compute), uniform
  `bounds` instead of the DungeonLayout import (the demo passes the room), an ambient density floor
  with a world-anchored ripple, and per-stamp heat so renderers get a second colour. The demo's
  behaviour is unchanged.
- WebGL2 degraded behaviour is decided: no fluid at all. The host checks `GroundMist.isSupported`.
- Headless verification now exists on Linux: `tools/mist-smoke.mjs` runs the full Chromium on
  SwiftShader's Vulkan ICD with real WebGPU compute. Flags that keep Dawn's instance alive:
  `--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader --use-angle=swiftshader
  --use-gl=angle --enable-unsafe-swiftshader`. Expect about one frame per second.
- Known upstream quirk (three r186, MSAA): the first frame of a `viewportLinearDepth` material binds
  a 1x1 placeholder depth texture and Dawn logs one validation error per volume; later frames are
  clean.
- Surface/room identity and multi-floor isolation remain open; `bounds` is one rectangle.

## Previous checkpoint: 2026-09-14

FN development is paused by user decision while the MMO reaches a minimal connected browser experience. This supersedes the next-feature suggestions in HANDOFF.md; that file retains demo implementation and validation history.

## Return milestone

Two browser clients can connect to one server, see each other and move around a simple shared space with server-authoritative positions, a usable camera, consistent ground/collision and working reconnect. Combat, inventory, progression and finished art are not prerequisites.

## Architecture review

The MMO at `../../GDC/cmmo` uses an authoritative Go server, Three.js client, binary WebSocket snapshots and interpolation. Rendering is WebGPU-primary with WebGL2 fallback. Its design documents describe more vertical-world functionality than currently implemented; current snapshot ingestion sets rendered Y to zero. Establish progress through runnable browser behavior.

No saved FN package extraction or MMO dependency was found in the reviewed files. FN remains a standalone application. Package extraction is deferred until the MMO host interfaces are concrete.

## Future package boundary

- Library owns fluid/ground response fields, volume rendering, scrolling window and GPU lifecycle.
- Host supplies its renderer, scene/camera, timing, actor positions, terrain/surface boundaries and visual interaction events.
- Keep training combat, sentinel, keyboard controls, benchmark UI and demo terrain outside the library. Gameplay authority stays in the MMO.
- Align FN Three.js 0.185.1 with MMO ^0.184.0 through a compatible host-provided peer dependency and one Three.js instance.
- Replace demo DungeonLayout coupling with configurable boundaries.
- Define WebGL2 degraded behavior; renderer fallback does not establish compute-effect compatibility.
- Include surface/room identity in the interface. One X/Z height field does not support overlapping floors; actual multi-floor support requires further implementation.

First integration: one shared bounded ground-mist window driven by relevant actor positions. Verify host depth/render-loop integration, scrolling, cleanup/recreation, fallback and incremental frame cost before adding other materials and spell effects.

No runtime changes or new runtime validation occurred during this review. Previous demo checks are recorded in HANDOFF.md. After a laptop restart, use `npm run dev` and the printed URL; old handoff server-running statements are historical.
