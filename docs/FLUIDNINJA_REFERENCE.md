# FluidNinja bonfire reference analysis

## Scope and confidence

The supplied project is an Unreal Engine 5.6 content-only project. Its implementation is packaged as `.uasset` and `.umap` files; no plugin C++ or standalone shader source is present, and Unreal Editor is not installed in this workspace. UE assets do retain dependency names, Niagara module metadata, generated shader symbols/comments and material parameter names, which is enough to establish the architecture below. Exact serialized preset numbers, render-target formats and curve keys are not claimed where they could not be verified safely.

Statements labelled **observed** come directly from asset names/metadata. Statements labelled **inference** connect those observations without pretending the packaged assets exposed more than they did.

## Chosen trail: the bonfire examples

The simplest coherent fire/smoke path is in `Content/FluidNinjaLive/Levels/Fire_Smoke_Explosive.umap`:

```text
Fire_Smoke_Explosive level
  -> BonfireSim / BonfireSmoke actors using NinjaLive
  -> NS_WriteDataCh_GPU_Bonfire + NS_WriteDataCh_GPU_BonfireSmoke
  -> NinjaDataChannel1_Global
  -> Ninja Grid2D simulation stages
  -> velocity+density and pressure+divergence outputs
  -> MI_Bonfire / MI_Bonfire_HeavySmoke surface materials
     or MI_HVOL_SIM_BonfireSmoke1 / SVOL volume variants
  -> optional NS_PASSIVE_Sparks decoration
```

The level also references `RT_Bonfire`, multiple bonfire meshes/materials, buffer-visualization materials, and named `BonfireSim`/`BonfireSmoke` actors. **Inference:** the level demonstrates several output renderers fed by the same simulation rather than one monolithic fire system.

## Source particles and data-channel input

`NS_WriteDataCh_GPU_Bonfire` and `NS_WriteDataCh_GPU_BonfireSmoke` are GPU Niagara systems. Their retained module stacks show:

- sphere location and spawn-rate modules
- randomized lifetime and uniform sprite size
- acceleration, drag, point attraction and force/velocity solving
- curl-noise force; the smoke source also has explicit add-velocity and size-over-life behavior
- optional visible sprite rendering for debugging
- a custom `WriteToDataChannel` module targeting `NinjaDataChannel1_Global`

The data-channel append signature contains current position, previous position, and a packed velocity-and-size vector. The custom module exposes a particle-size multiplier. **Inference:** FluidNinja reconstructs brush motion/velocity from moving Niagara source particles while sprite size becomes the deposition radius. This makes an emitter spatially rich without requiring a dense CPU-authored list of fluid splats.

The source's own curl noise, attraction, drag and randomized lifetime matter visually: they vary where density and momentum enter the field before the fluid solver has done any work. The WebGPU prototype now evaluates eight animated GPU source brushes, including per-brush position and velocity, before depositing density, heat and momentum. This is a compact clean-room counterpart to the observed moving data-channel brushes rather than an implementation of the Niagara module.

## Simulation stages and packed buffers

The core assets explicitly include:

- `Ninja_Advection`
- `Ninja_Divergence`
- `Ninja_Pressure`
- `Ninja_CompositeAndGradient`
- `Ninja_Painter`
- Grid2D initialization, world/unit transforms and render-target export modules

All four main stages reference Niagara `Grid2DCollection` interfaces and previous-grid sampling/lookup functions.

The metadata describes these logical packings:

- an advection/composite grid with `RG` velocity and density in another channel (described as `B density` in the composite stage)
- a pressure grid with pressure and divergence packed together (metadata describes pressure on `R` and divergence on `G`)
- exported textures named/treated as `VelocityDensity` and `PressureDivergence`

Notable observed behaviors:

- Advection samples the previous execution-stage grid and applies configurable feedback damping. One retained note says the original damping had been hardcoded to `0.99` before becoming a parameter.
- Divergence uses direct neighbor lookup, includes the central half-scale internally, supports world-offset compensation, and can limit divergence for a cheaper pressure mode.
- Pressure is an iterative simulation stage with current/max iteration inputs, an optional one-step solver, pressure/divergence feedback, and procedural edge masking.
- Composite/gradient performs pressure-gradient application and combines brush/bitmap density and velocity. It exposes density accumulation, density noise, directional and amplitude velocity noise, velocity clamping, collision-density killing, moving-simulation offsets, and edge bounce/masking.
- Edge masks are first-class controls in both pressure and composite stages, so the rectangular simulation boundary is intentionally faded/managed rather than left to undefined sampling.

No dedicated vorticity-confinement module was found in this trail. Turbulence is visibly supplied by Niagara source curl noise and by directional/amplitude velocity-field noise in the composite stage. The WebGPU prototype adds conventional curl/vorticity confinement independently because it is cheap at 256² and was an explicit target requirement.

A separate physical temperature grid was not evident in the inspected FluidNinja packing. **Inference:** these bonfire materials derive much of the fire/smoke distinction from density/flow remapping and output-material choices. The WebGPU version intentionally keeps temperature as a real transported scalar because it gives direct buoyancy, cooling, emissive and fire-to-smoke controls.

## Simulation-to-render mapping

`NinjaSampleSimBuffers` exposes texture sampling for the velocity-density and pressure-divergence outputs. Supporting modules include world-to-unit and simulation-position transforms, which confirms a normalized simulation-space UV boundary between world actors, Niagara particles and rendered textures.

The WebGPU mapping is deliberately explicit:

```text
local world position (x, y)
  -> uv = (x / width + 0.5, y / height)
  -> bilinear field sample
  -> cell velocity converted back to local world units/second
```

Particle `z` is independent depth variation. It produces a camera-facing 3D cloud while keeping the fluid solve two-dimensional.

## Output material behavior

The bonfire surface material instances inherit from `M_NinjaOutput_BaseMaterial_SURFACE`. Retained parameter names include:

- two colors with gradient/tone-map switches
- color multiply and power
- flow-density mask multiply/power
- flow-map texture and velocity-masked-by-density behavior
- gradient radius
- emissive toggle/multiplier
- density-driven refraction
- shadow density on the heavy-smoke instance
- `T_Crumple_MultiLevel` or its inverse as detail texture

The project also provides separate surface, sparse-volume and heterogeneous-volume bonfire/smoke material instances, plus point/directional lighting variants. **Inference:** the polished result is not just solver fidelity. A low-frequency coherent field establishes silhouette and motion, while detail textures restore high-frequency breakup after advection; aggressive nonlinear color/density remapping creates a bright compact core and a broader low-opacity smoke body; volume variants add depth and lighting where the budget permits.

The current WebGPU milestone reproduces the behavioral skeleton with transported temperature/density, lifetime-carried particle heat/density, nonlinear hot-core color and a procedural per-sprite breakup term. It does not yet reproduce the supplied crumple texture, volumetric self-shadowing, refraction or soft depth intersection.

## Why this preset family looks good

1. The source is animated before injection. Curl-noisy, dragged, randomized GPU source particles deposit a changing brush instead of a static circle.
2. Motion and appearance share one field. Density and velocity are packed, advected and sampled together, keeping wisps attached to the motion that formed them.
3. The solver has art-directable loss and boundaries. Feedback damping, accumulation, edge masks, velocity clamp and pressure feedback prevent an otherwise generic fluid solve from washing out or ringing.
4. Turbulence exists at multiple scales. Source curl motion controls the broad silhouette; velocity/density noise and the crumple detail texture restore smaller structure.
5. Rendering is strongly remapped. Color powers, density masks, gradients, emissive multipliers and separate heavy-smoke variants create much more contrast than a linear density-to-alpha display.
6. Secondary layers stay cheap and specialized. Sparks are a passive Niagara system; surface and volume outputs are selectable rather than forcing every effect through one renderer.

## Clean-room implementation choices

The prototype follows the observed architecture, not its generated Unreal code:

| Reference concept | Independent WebGPU implementation |
|---|---|
| Niagara Grid2D stages | Three.js TSL compute kernels |
| Packed velocity/density grid | Separate `RGBA16F` velocity and scalar ping-pong textures |
| Packed pressure/divergence grid | Separate pressure ping-pong plus reused curl/divergence texture |
| Data-channel brush particles | Eight animated GPU brush records plus pointer velocity splats |
| Feedback advection | Semi-Lagrangian backtrace plus configurable retention |
| Iterative pressure stage | Configurable Jacobi iterations, default 20 |
| Edge masks/bounds | Clamped sampling and zero-velocity/scalar border |
| Flow/density material remap | Temperature/density-driven sprite color, size and opacity |
| Surface/volume output choices | One 3D billboard layer for the benchmark |

## Still unknown from the packaged files

- exact bonfire render-target dimensions and pixel format
- exact simulation tick/substep policy
- exact pressure iteration count for each placed level actor
- numeric source spawn rates, lifetimes, force strengths and curves
- exact material-instance scalar/color values and curve keys
- the exact renderer selected by each placed bonfire actor without loading the level in UE 5.6

Those details should be exported from Unreal as JSON/text or inspected in the editor before visual matching. They are not blockers for the performance-first architecture milestone.
