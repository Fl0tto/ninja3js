# Player-centred ground-flow volume

## Intent

This project’s `fog` is a localized, landscape-aligned volumetric effect driven by a 2D fluid simulation. It is not global atmospheric fog and it is not a fire-only smoke renderer.

The material selector routes a shared player-centred window and gameplay inputs to independent implementations. Fog uses fluid density and velocity. Sand and Snow use solid tessellated surfaces with height displacement and slope normals. Grass uses 16,200 blade cards sampling its own bend and flattening state. Sand/Snow/Grass no longer sample the fog textures or display its volume sheets.

## Material-state split

Fog owns a GPU velocity+density field because dispersion and advection are the point of that material. Sand, Snow and Grass no longer belong to that solver: `GroundResponseField` owns independent double-buffered GPU state with distinct channel semantics.

- Sand: height offset and contact compression. An outgoing-transfer pass moves material between four neighbours, driven by contact pressure, slopes above a 32-degree repose approximation, and wind above an entrainment threshold. A gathering pass applies equal outgoing/incoming quantities. Excavation is limited by the 12 cm mobile layer; rims form from redistributed material. No post-transfer height clamp or decay removes mass. Spell deposits explicitly add material. Domain edges are closed; scrolling intentionally drops outgoing cells and introduces undisturbed ground.
- Snow: deposited height plus compaction, preserving tracks while compression recovers gradually.
- Grass: bend vector plus flattening, allowing wind motion and local recovery independently.

All four systems share `SimulationWindow`, world-to-UV conversion and gameplay stamps. Ground buffers use R for height offset in metres, G for compression/flattening, BA for Grass bend in metres. Each material owns two textures and an independent active index. Only the selected solver advances; all response buffers scroll to preserve world placement. Newly exposed cells have zero disturbance. Inactive states remain frozen until selected again.

Player/pointer/object contacts displace Sand and stamp Snow imprints; obstacle footprints apply contact pressure; spell blasts drive outward displacement or radial grass bends, and delayed residue adds height. Environmental fog emitters do not continuously refill solid surfaces. Wind bends Grass globally and transports Sand above 0.25 m/s; Snow stays at rest under wind. Snow height imprints persist while its compression shading recovers slowly.

Sand state and flux use RGBA32F. The diagnostic in `tools/sand-validation.ts` verifies mass conservation, bounded excavation, wind direction, additive deposits and exact retained-cell scrolling on the GPU. Its readbacks run only in the test; the demo does not read simulation fields back to the CPU. This remains a height-field transport approximation, not a discrete-grain solver.

## Client-local MMO model

Each client maintains one high-detail simulation window around its locally controlled player. The fluid field is visual state, so it is not replicated. Replicated player, spell, wind and interactable state is converted into local GPU stamps on every client.

```text
replicated actors / spells / environmental inputs
                    ↓
  client-local X/Z velocity + scalar simulation window
                    ↓
  volume ray march, particles and optional surface detail
```

This keeps the effect responsive and bounds its cost independently of total MMO population. Only contributors inside or close to the local window need be stamped.

## Moving window

- The simulation is centred on the player, with a small look-ahead bias in the camera-forward direction.
- It moves in integer texel steps, never continuously each frame.
- When the anchor crosses a configurable inner threshold, the GPU scrolls velocity and scalar textures by the cell delta.
- Existing cells retain their state; only newly exposed border cells are initialized or cleared.
- Simulation-to-world conversion uses the same moving origin for rendering, capsule stamps, spell impulses, wind and obstacles.
- The camera can affect the look-ahead bias but must not be the primary anchor; camera orbiting must not make the fog slide.

## Visual target

The simulation lives on the horizontal X/Z plane. The renderer extrudes it into a shallow volume above the ground with a material-specific height-density profile. The reference look has a deliberately readable outer boundary, dense low-lying illuminated interiors and soft volumetric breakup.

The visible edge is controlled by a domain/material mask plus a stylized density threshold. It is not a global `scene.fog` transition. World-aligned noise and lighting must remain stable while the window scrolls, avoiding a player-pasted appearance.

## Interaction contract

All interactions are projected into the moving X/Z window:

- player and object capsules: broad velocity wakes, with optional static-mask density displacement;
- spells: radial/shape velocity impulses plus delayed material injection or removal;
- wind: broad directional velocity input;
- terrain/interactables: masks, static obstacles and optional moving-obstacle velocity.

The simulation window owns world-to-UV conversion. Gameplay callers provide world positions, radii and velocities; they never write texture-space coordinates directly.

Texture V maps to positive world Z. This convention is shared by the volume geometry, pointer projection, capsule wake and world-to-UV conversion; preserving it prevents screen/world direction inversions.

## Current prototype integration

`GroundFlowVolume` currently exposes eight fixed-cost, GPU-unrolled source slots and five fixed-cost radial blast slots. World-space sources are projected into the current window every frame; sources outside the window automatically stop stamping. The browser demo uses three fixed environmental fog sources, up to five click-spell sequences and one player wake/collider stamp. A spell begins with a broad, short radial velocity burst that displaces density already present, then deposits its moving residue after a brief delay. This is the intentionally small first API surface before a GPU-buffer-backed dynamic stamp list is warranted.

The current renderer also takes one density probe in the incoming-light direction for every transparent layer. This is not a full volumetric shadow solution; it is a stable, fixed-cost local-light approximation that makes a dense fog bank show a brighter light-facing rim and a darker occluded side.

`setWind(worldVelocity)` applies a broad world-space target velocity to the entire local field. It is approached gradually each frame, so wind changes do not read as discrete impulses. This is separate from stamped local velocities such as spells and moving players.

`setObstacle(index, worldPosition, radius)` is the first static-mask input. It clears density and velocity under a circular projected footprint; pressure projection then redirects nearby flow. `setObjectCapsule(index, worldPosition, worldVelocity, radius)` adds one of four velocity-only moving-object wakes, and can be paired with the mask at the same world position. This fixed-cost shape list is suitable for the first interactable/rock/capsule test and will evolve into terrain and collider mask textures.

## Implementation sequence

1. **Window controller:** quantized world origin, world-to-UV conversion and pending texel shifts.
2. **Ground orientation:** move the active fluid domain from the vertical X/Y plume plane to horizontal X/Z.
3. **GPU scrolling:** preserve fields during a window shift and clear only exposed strips.
4. **Interaction stamps:** player capsule, spell impulse, wind and obstacle-mask inputs in world space.
5. **Volume material:** shallow ray-marched volume, stylized edge/mask, height profile and local lighting response.
6. **Material implementations:** independent Fog, Sand, Snow and Grass buffers share window placement and interaction routing.

The existing `FluidFire` benchmark remains a useful GPU-fluid and rendering reference, but it is not the final gameplay-facing architecture.

## Terrain and passive coverage

`GroundFlowVolumeOptions.terrain` accepts matching CPU `sample(x, z)` and GPU `node(xz)` height samplers in world metres. Flat terrain is the default. The demo uses rolling procedural terrain, including for actor grounding and ray/terrain pointer intersections. Sand transport includes base terrain elevation in neighbour potentials while the available mobile layer remains relative to terrain. Fog sheets and grass roots follow the same GPU sampler.

Sand/Snow coverage is a continuous 140 m mesh with a dense 14 m centre and coarse exterior. Height offsets and compression fade over the outer 8% of the response domain, preventing clamped texture borders from extending tracks into passive ground. Grass covers 42 m with world-stable wrapped roots and local response sampling. Base terrain covers 140 m in Fog/Grass modes, beyond the demo camera far plane. Geometry follows the window while its heights remain world anchored.

This does not persist discarded tracks or add terrain collision to the fog solver. Pointer hits and actor grounding use base terrain, not GPU surface deformation. Imported terrain needs matching CPU/GPU samplers; cliffs, overhangs and production terrain LOD are outside this height-field milestone.

## Material detail

Sand ripple shading and Snow powder variation use world coordinates and fade below pixel resolution. Compression flattens the detail and changes albedo/roughness without modifying transport state. Fresh snow deposits fill imprints and cover their packed shading. Grass blades use tapered opaque geometry, varied height and orientation, root-to-tip color and wind motion that continues outside the active field. The response diagnostic checks Snow imprint persistence/refill and Grass bending, inactive-state freezing and recovery. Reference comparison remains pending.

## Current ground mist renderer

Ground mist now renders through one back-face box proxy per active field, replacing the six horizontal sheets. A fixed 24-step loop integrates density along the camera ray through the local X/Z domain. Ray entry/exit bounds, opaque scene depth, terrain-relative height falloff and domain-edge fading limit the visible mist. Density and light probes use linear filtering; compute transport still uses explicit texture loads. A world-anchored modulation breaks up the vertical profile.

Terrain samplers can specify conservative `bounds: [minHeight, maxHeight]`. The demo bounds are [-1.15, 1.15]; the fallback is [-4, 4]. The mesh bounds include fog height. Camera positions inside the proxy use a zero entry distance. This is a shallow rendering approximation of a 2D fluid field, with local density-based lighting, not full volumetric shadows or multi-floor simulation.
