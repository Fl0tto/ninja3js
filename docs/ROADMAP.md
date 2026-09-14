# Fluid Fire / ground-flow implementation roadmap

This roadmap keeps the prototype purpose-built. It does not expand into a general VFX graph or Niagara-compatible runtime. The active product direction is now the player-centred, landscape-aligned volume described in [Ground-flow volume](./GROUND_FLOW_VOLUME.md).

## Completed foundation

- 256² WebGPU fluid with velocity, density, temperature, pressure and divergence
- GPU visualization particles with a continuous fire-to-smoke transition
- animated GPU source brushes and pointer velocity injection
- live controls, resolution/particle presets and GPU timestamp metrics
- heat-aware smoke render thinning and procedural cloud sprites

## Completed: depth-aware rendering

- fade smoke and flame particles as they approach opaque scene depth
- prevent hard billboard intersections with the ground, props and future characters
- expose the fade distance as a live parameter and include its cost in the benchmark

## Current requirement: dynamic fog

Dynamic fog will be a spatial output of the transported density field, not a global `scene.fog` color change.

Acceptance criteria:

- [x] smoke density contributes localized view attenuation
- [x] pointer impulses and emitters visibly advect the fog
- [x] world-to-simulation mapping is shared with the particle system
- [x] implementation stays on the GPU with no density readback
- [x] density, volume depth and enable state are configurable
- [x] the fog pass has a clear enabled/disabled GPU benchmark
- [x] expose absorption and scattering color independently
- [x] compare the slice prototype with a short ray march or froxel/half-resolution approximation
- [ ] validate later wind/collider coupling without adding a separate fog simulation

This stage follows soft-particle depth support because it reuses scene depth and the same coordinate transforms. It precedes final game integration so its render cost can influence effect budgets and quality presets.

The volume preview offers two paths over the same live density/temperature field: the original eight depth-aware transparent slices, and a six-step ray march over one proxy plane. Both use Beer-Lambert-style opacity, soft scene-depth intersections, and independent absorption (extinction/coverage) and scattering (lit smoke tint) controls. The ray march samples a slight depth-parallax offset from the same field, so it remains a 2.5D renderer rather than a second fog simulation.

At 256², 100,000 simulated particles, 25% smoke render fraction and a 764 × 429 headless Chrome surface, the local WebGPU smoke test measured 6.84 ms GPU render time for the eight slices and 5.72 ms for the six-step ray march (about 16% lower). The ray-march mode is consequently the default; the slice path remains selectable as a baseline. This is a single-machine comparison, not a production-wide performance claim.

## Active ground-flow implementation

### Architecture correction: material-specific state

- [x] independent double-buffered GPU `GroundResponseField` foundation for Sand, Snow and Grass
- [x] route player, pointer, object, obstacle, spell blast and deposit inputs into independent material buffers
- [x] replace Sand/Snow/Grass fog-field render bindings; use each response field's own ping-pong index
- [x] scroll all material buffers with the shared window; preserve inactive material state
- [x] initial Sand repose-threshold settling, Snow persistent imprints/deposits, Grass wind/bend/flatten recovery
- [x] conservative Sand excavation, repose settling and thresholded wind transport (outgoing transfers plus neighbour gathering, bounded by available material)
- [x] shared terrain height integration and passive surface outside the window
- [x] world-anchored Sand ripple and Snow powder/packed shading with distance filtering
- [x] tapered, varied Grass geometry and continuous passive/local wind motion
- [x] Snow fresh accumulation covers compression; numeric retention/refill and Grass recovery checks
- [ ] reference-matched surface detail
- [ ] tune Snow accumulation/track recovery and Grass geometry against the supplied references

- [x] player-centred, texel-aligned moving X/Z simulation window policy (`SimulationWindow`)
- [x] GPU scrolling that retains active velocity, scalar and pressure fields when the window moves
- [x] transitional X/Z landscape-volume renderer (`GroundFlowVolume`) driven by the active scalar field
- [x] world-space player/object capsule and spell impulse API (player wake, four moving-object wake slots, fixed world sources, radial click-spell blasts and delayed residue stamps)
- [x] wind, static masks and moving-obstacle velocity inputs (broad wind, circular static masks and four moving-object wake slots)
- [x] shallow terrain-aligned transitional volume with stylized density edge and height profile
- [x] local light-response approximation for the ground volume (one light-direction density probe per layer)
- [x] material selection: Fog fluid, Sand height response, Snow compression response, Grass bend response
- [x] grass blade output using independent bend/flatten state (16,200 cards over 42 m; world-stable roots during window scrolling)

The demo now runs the selected material's solver. Fog retains FluidFire; Sand, Snow and Grass each own two response textures. Sand also owns an outgoing-transfer texture and uses RGBA32F to limit mass drift. Solid surfaces have full coverage, vertex height displacement and slope normals. These are initial material implementations, not finished terrain systems. Terrain height and passive coverage now extend beyond the moving window. Next: reference-detail and Snow/Grass tuning.

## Shared encounter

- [x] Contained clearing with simultaneous mist, Grass, Sand/Snow patches and reactive trees
- [x] Overworld/Dungeon camera selection and wheel zoom
- [x] Modest/powerful shared world attacks, bounded lifetimes, delayed residue and tree recoil
- [x] Preserve individual material diagnostics and reset/pause controls
- [x] Replace transitional fog sheets with a terrain/depth-clipped camera-ray march
- [x] Initial cohesive woodland palette and softened material detail
- [x] Single training chamber boundaries, wall collision, contained GPU effects and resettable sentinel
- [x] Sentinel ground-strike telegraph, timed Shift dodge and practice hit counters
- [x] Player health, four-hit defeat, gameplay input lock and explicit retry
- [ ] Additional enemy attack patterns and impact animation
- [ ] Generalized dungeon room/height masks and occlusion-aware propagation
- [ ] Reference comparison and target-hardware performance budget
