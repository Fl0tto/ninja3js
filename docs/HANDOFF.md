# Working checkpoint â€” 2026-09-08

## Target

Latest gameplay direction and timestamped references: [Interaction target](./INTERACTION_TARGET.md). Prioritize a contained encounter with shared spell impacts across materials and vegetation, tested at near-top-down and near-third-person camera angles. Unreal installation is deferred. Video timestamps are recorded but footage has not yet been visually inspected.

Client-local MMO effects following the player with camera look-ahead. FluidNinja-style Fog means shallow illuminated volumetric mist with clear stylized edges. Sand/Snow are deformable ground; Grass uses bendable blades. Reference images were supplied in conversation. Share the moving X/Z window and world-space inputs, not one fluid solver.

## Current implementation

- `FluidFire`: GPU velocity/density solver for Fog; player wake, wind, objects, pointer, spell radial blast followed by delayed residue.
- `SimulationWindow`: integer-cell scrolling and world-to-UV mapping; texture V is +world Z.
- `GroundResponseField`: independent state for Sand, Snow, Grass. R = height offset, G = compression/flatten, BA = grass bend. Inactive materials freeze, but their buffers still scroll.
- Sand: RGBA32F state pair plus outgoing flux. Contacts, repose settling, and thresholded wind redistribute material; deposits add material. Closed boundaries, 12 cm mobile layer, no post-step mass-destroying clamp.
- Snow: persistent height imprints/deposits with slowly recovering compression shading. Grass: wind/contact bend and flatten recovery; world-stable roots.
- `GroundFlowVolume`: Ray-marched Fog in Fog/encounter modes; solid Sand/Snow surfaces with slope normals; Grass blade cards. Each renderer selects its own active buffer.

## Remaining roadmap

Terrain integration and passive coverage are implemented: shared CPU/GPU world height, terrain-aware Sand transport, terrain-following fog sheets and grass roots, and continuous 140 m ground coverage. The demo uses procedural rolling terrain. Next: reference-matched Sand/Snow detail and Snow/Grass tuning. Fog now uses a terrain-following, depth-clipped 24-step ray march.

## Validation and workflow

- `node node_modules/typescript/bin/tsc --noEmit`
- `node node_modules/vite/bin/vite.js build --configLoader runner`
- `tools/material-smoke.mjs`: launches hidden Chrome, expects Vite at port 4175, switches modes, moves player, clicks and captures screenshots.
- Set `SAND_NUMERIC_TEST=1` for GPU conservation/deposit/scroll checks. Readback is diagnostic-only.
- User authorized continuing implementation without repeated approval questions. Respect tool-enforced permissions. No subagents unless explicitly requested.
- Do not equate TypeScript/Vite success with GPU shader validation. Use the browser check for shader changes.

See `ROADMAP.md` for completed vs unfinished work. Do not report the whole product as complete when only a foundation or renderer approximation is done.

## Terrain milestone

- `TerrainHeight` provides matching CPU and TSL samplers; omitted terrain remains flat. The demo supplies an unbounded procedural landscape.
- Sand/Snow use one continuous mesh: simulation-resolution centre, coarse exterior, with response height and compression fading over the outer 8% of the local window. Simulation state itself is not faded.
- Passive terrain spans 140 m and follows the quantized window; grass has 16,200 world-stable roots over 42 m. Only the 14 m response domain simulates interactions.
- Player/camera height and pointer ray intersections use base terrain. GPU deformation is not CPU collision geometry.
- Disturbances leaving the window are still discarded; passive coverage does not persist tracks. Fog follows terrain visually but retains its horizontal 2D solver.
- Browser diagnostics include downhill Sand transport with conservation and terrain pointer intersections.

## Material refinement pass

- Corrected Sand/Snow and passive-ground triangle orientation for lighting from above.
- Sand has world-anchored ripple shading; Snow has finer powder variation, blue packed regions and lower roughness under compression. Pixel-footprint filtering fades subpixel detail; these are shading changes, not added material mass.
- Grass uses opaque tapered blades, varied height/orientation, root-to-tip color and continuous wind motion across the passive/local transition. Flattening scales blade height so shorter blades cannot be pushed below terrain.
- Snow deposits fill height and cover old compression shading. Released imprints remain persistent.
- Validation: strict TypeScript and production bundle passed; Chrome WebGPU passed all modes with no reported errors. Sand conservation/downhill/scroll checks passed, plus Snow retention/refill and Grass bend/freeze/recovery checks. Use RESPONSE_NUMERIC_TEST=1 for tools/response-validation.ts through material-smoke.mjs.
- Smoke runner now allocates its own debugging port and fails on missing UI or evaluation exceptions. Restricted Chrome inspection timed out; the unrestricted hidden-browser check succeeded.
- Original reference images were unavailable for this pass. Visual refinement is implemented, but reference matching remains open.

## Shared encounter milestone

- Default scene is The Clearing: simultaneous Fog, Sand/Snow islands and Grass plus three recoiling trees and a stone perimeter. Isolated-material selection retains the diagnostic views.
- EncounterScene owns authored props, terrain-conforming impact rings, damped tree recoil and smoothly following Overworld/Dungeon cameras. Wheel zoom is clamped.
- Click terrain or press Space/use Cast ahead. Modest: 2.5 m radius, impulse 4; Powerful: 5.2 m radius, impulse 10. Attacks capture their parameters at creation and drive fog blasts, all response fields, delayed deposits and tree recoil. Attack slots and rings are bounded to five.
- All material responses advance in encounter mode. World-anchored render masks place two material islands and grass around them. The solver remains a single terrain layer; these masks do not implement room occlusion or stacked-floor isolation.
- Tree trunks also contribute local obstacle stamps. Recoil uses a damped spring with substeps and a bend limit. Reset clears spell history and tree/ring responses as well as GPU state.
- ENCOUNTER_TEST=1 adds camera/strength, live responder, pause, zoom and reset checks to tools/material-smoke.mjs. Development-only window.__encounter() exposes state for diagnostics.
- Next: further art-direction review and spatial masks for actual dungeon geometry. This is a test clearing, not a finished dungeon or reference-matched renderer.

## Close-view mist and palette pass

- GroundFlowVolume replaces six horizontal fog sheets with one back-face box proxy per ping-pong field. A fixed 24-step GPU loop integrates along the camera ray, clips against scene depth and evaluates density above the shared terrain height. Only one proxy renders each frame.
- TerrainHeight.bounds supplies conservative height bounds (demo: -1.15 to +1.15 m). Custom samplers without bounds fall back to -4 to +4 m; provide bounds for other elevation ranges to prevent clipping.
- Fluid render sampling is linear filtered. The compute solver still uses textureLoad and its explicit interpolation, so this does not change simulation transport.
- World-space breakup, edge fades and local density-based lighting shape the mist. This remains 2.5D density extruded above terrain, not a full 3D solver or volumetric shadow system.
- Muted woodland palette: softer soil/powder detail, less saturated foliage, cooler mist and warm attack cues. Material-island borders have mild world-space variation and blend toward the underlying ground color. Geometry remains prototype art.
- Verified strict TypeScript and production build; WebGPU checks passed both cameras/strengths, minimum dungeon zoom, pause, reset, movement and all isolated materials. Captures: encounter-dungeon-close.png and encounter-dungeon-powerful.png. Smoke startup now waits for LIVE before interaction assertions.

## Continuous encounter ground — 2026-09-09

- Recovered and validated the previously unfinished FogLightingLab: 24/48/96 ray samples, deterministic dither, amber/blue local scattering and surface lights, freeze controls and attack flash. Default remains 48 samples.
- Mist upper contour now varies in world space. Material borders blend over 60 cm with a 3.5 cm raised layer; isolated-surface normals match their rendered displacement.
- Fixed encounter ground intersections by replacing overlapping soil/Sand/Snow meshes with one continuous terrain mesh. It samples both independent response fields, blends height/color/roughness, and uses the same combined height for normals. Isolated-material views retain their separate surfaces.
- Ground textures bind each response field's current ping-pong buffer in sync(), including after scrolling. The Ground effects toggle also disables the combined material response visually.
- Strict TypeScript, production build, and existing encounter/material WebGPU smoke checks passed. No browser errors reported.
- tools/ground-intersection-smoke.mjs and tools/ground-intersection-validation.ts provide an isolated regression: sustained contacts excavate snow to approximately -0.0995 m, confirm no separate encounter surface overlaps, check current buffers and scrolling, and capture low/top-down views without fog, props or attack rings. Both captures visually inspected with continuous borders and no underlying-soil cuts.
- The regression runner expects Vite explicitly bound to 127.0.0.1:4175 and launches hidden Chrome. Run from dist to keep screenshots there: node ../tools/ground-intersection-smoke.mjs.
- Next gameplay work: sharper attack onset and coordinated mist/vegetation recoil, then dungeon spatial boundaries. CPU actor/pointer collision still uses base terrain; deformation remains visual.

## Shared attack timing — 2026-09-09

- AttackEnvelope supplies the same expanding world radius to mist/material blasts, the visible ring and tree arrival checks. Radius starts at 18%, reaches full size halfway through the burst, and the impulse releases smoothly at the end.
- Modest retains 2.5 m / impulse 4 / 0.24 s; Powerful retains 5.2 m / impulse 10 / 0.42 s. The force is front-loaded. Residue waits until burst duration + 0.12 s, avoiding overlap with the initial shove.
- Trees receive one outward impulse when reached, then use the existing damped recovery. Captured attack parameters determine cue width/color; later selector changes do not alter active cues. Reset discards pending arrivals. Five-cue limit remains.
- TypeScript and browser regression passed. Deterministic 0.2 s comparison measured maximum tree bend 0.01252 rad modest / 0.16245 rad powerful in the test layout. This is a timing/strength check, not a general visual-quality metric.
- Both cameras and strengths, pause, zoom, reset, and all isolated materials passed with no reported browser errors. tools/attack-smoke.mjs runs these checks plus tools/attack-validation.ts (ENCOUNTER_TEST=1 enables gameplay checks).
- Next: visual review of impact readability and contained-dungeon spatial boundaries. No camera shake or full room/floor isolation added in this pass.

## Sword-slash demo — 2026-09-09

- Default demo attacks now use an aimed, curved, tapered slash. Aim is captured from player to clicked point; Space uses forward aim. Width is 0.3 m Modest / 0.48 m Powerful, with the existing 2.5/5.2 m half-length and burst timing.
- SlashShape shares a curved-band metric between CPU tree tests and GPU mist/Sand/Snow/Grass stamps. Push follows the aim direction. Circular APIs remain available for existing callers and tests.
- Encounter cue uses a tapered ribbon matching the simulation profile. Trees outside the stroke do not recoil. The default modest slash legitimately misses the authored trees; smoke assertions now require tree recoil only for the powerful default cast. Dedicated tests cover on/off-stroke trees.
- Slash attacks leave transported mist and material imprints instead of adding a circular residue emitter. The UI reads Slash / Slash ahead.
- Strict TypeScript passed. WebGPU checks passed both camera modes/strengths, movement, pause/reset and all isolated materials without reported browser errors.
- tools/slash-validation.ts checks 0/90-degree GPU snow/grass responses against the CPU shape, directional bend and on/off-stroke tree recoil. Measured on-stroke snow depression about 0.09985 m, grass bend about 0.2334 m; tested off-stroke response was zero. tools/slash-smoke.mjs runs this plus gameplay checks with ENCOUNTER_TEST=1.
- Inspected the powerful overworld capture: tapered crescent cue replaces the ring. Dungeon spatial boundaries remain future work.

## Training chamber, boundaries and sentinel — 2026-09-09

- Default encounter is a roofless stone training chamber with tiled ground and a south doorway/entry. Existing vegetation and independent material patches remain as environmental responders.
- DungeonLayout defines shared world bounds (X -5.8..5.8, Z -6..4.4). CPU movement substeps and slides against walls; the 2.4 m doorway opens into a short entry. Switching back from an outside diagnostic position returns the player inside.
- Effects are confined to the training room, including its doorway threshold; the entry is navigable but not an active combat/effect zone. This is one convex room, not a generalized multi-floor portal system. Casts from/to outside are rejected.
- GPU fog source/density and velocity outputs respect room bounds; ground fields reject outside state. Sand outgoing flux blocks wall crossings and retains conservation. Sand transport pressure now also uses the slash profile (a previously circular path found during this pass).
- Fog/grass render masks use the same bounds. Slash geometry is clipped with the WebGPU ClippingGroup; CPU tree/target hits stay inside the room.
- Close camera uses a shoulder offset and ray/box collision against walls/lintel. Both camera modes retained. Inspected close capture: target remains visible beside player.
- TrainingEnemy is an armored sentinel at (0,-2.9). Modest/Powerful deal 18/42 damage once per stroke; directional stagger, hit flash, health meter, last-hit text, defeat and 3 s auto-reset. Reset target button and full reset both supported. Clicking the sentinel aims the slash curve at its body. It is a passive training target, not an attacking AI enemy.
- Strict TypeScript and production build passed. Existing slash/encounter checks passed cameras/strengths/pause/reset/movement and all materials without reported browser errors. One final cold-start test timed out without errors; retry with longer startup allowance passed.
- tools/dungeon-validation.ts covers no-tunnelling wall movement, usable doorway, enemy one-hit damage/defeat/reset, camera collision, and GPU room containment for Fog/Sand/Snow/Grass. Tested outside responses were zero; Sand summed-height conservation error about 3.1e-7. tools/dungeon-smoke.mjs runs it plus ENCOUNTER_TEST=1 gameplay checks.
- Next options: enemy telegraphs/attacks and dodge timing, then more authored room art. CPU contacts still use base terrain rather than GPU deformation; generic stacked-floor isolation remains future work.

## Sentinel telegraph and dodge practice — 2026-09-14

- TrainingCombat adds a stationary sentinel ground strike: acquire within 4.5 m, lock the player's position, warn for 0.85 s with a terrain-following amber ring, resolve one impact, then recover. The ring flashes red on impact and respects the existing room clipping group.
- Shift dodges in the held WASD direction (default +Z), with 0.28 s movement/invulnerability and a 0.9 s cooldown. Movement uses existing substepped wall collision. The player glows blue during the dodge.
- HUD counts hits taken and successful invulnerable dodges. Walking out of the marked radius also avoids impact. This is practice without player health/death; there is no sentinel locomotion or attack animation yet.
- Enemy defeat or leaving the room cancels a pending strike. Switching diagnostic modes cancels combat; pause/freeze stops timing. Reset target/full reset clears practice counters.
- Strict TypeScript and production build passed. Expanded dungeon validation passed telegraph, one-hit impact, late dodge, cooldown, moving clear and defeat cancellation. Hidden Chrome also passed the actual Shift input/movement check, both cameras/strengths and all material views with zero reported errors. GPU containment/conservation checks passed.
- Visually inspected dist/sentinel-warning.png: amber warning clearly surrounds the player. Development server runs at http://127.0.0.1:4175/.
- Upcoming: player health/defeat loop and richer enemy attack animation/patterns; then authored room art, reference comparison and target-hardware performance tuning. Multi-room/stacked-floor isolation remains separate future work.

## Player health and retry — 2026-09-14

- Player starts at 100 health and takes 25 damage per sentinel impact. Timed dodges and moving clear preserve health. Four hits cause defeat, cancel enemy warning and stop further damage.
- Defeat blocks movement, slashes and dodge, with a terrain-level fallen pose, brief red hit flash, disabled slash button and explicit Retry encounter button. Health and defeat feedback appear in the encounter controls.
- Retry restores both characters, clears attack cues, pending spell sources and counters, clears held movement, and returns the player to (0,0). Existing transported environmental disturbances remain. Reset target only resets the sentinel; diagnostic mode switching does not revive the player.
- Strict TypeScript and production build passed. Expanded dungeon checks passed health, invulnerability, four-hit defeat, reset isolation and retry. Hidden Chrome verified actual defeated input rejection, retry restoration and resumed movement, plus both cameras/strengths and all material views with zero reported errors. GPU containment/conservation checks still pass.
- Inspected dist/player-defeated.png and corrected the initial floating defeat pose. Development server remains at http://127.0.0.1:4175/.
- Next: enemy wind-up/impact animation and a second attack pattern, then room art, reference matching and performance tuning.
