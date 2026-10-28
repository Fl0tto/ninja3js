import * as THREE from 'three/webgpu';
import { slashDistanceNode } from './SlashShape';
import {
  Fn,
  If,
  abs,
  cameraFar,
  cameraNear,
  cos,
  distance,
  exp,
  float,
  hash,
  instanceIndex,
  instancedArray,
  int,
  ivec2,
  linearDepth,
  max,
  mix,
  normalize,
  pow,
  sin,
  smoothstep,
  texture,
  textureLoad,
  textureStore,
  uint,
  uniform,
  uv,
  uvec2,
  vec2,
  vec3,
  vec4,
  viewportLinearDepth,
} from 'three/tsl';

export interface FluidFireOptions {
  resolution?: number;
  particleCount?: number;
  width?: number;
  height?: number;
  /**
   * false skips the fire benchmark's own visuals (sprite particles, fog slices,
   * debug planes, decor) and their compute passes. The fields still simulate,
   * for hosts that render them through GroundMist or GroundFlowVolume.
   */
  visuals?: boolean;
  /**
   * World-space rectangle (X/Z metres) outside which ground flow is masked
   * when setRoomBounds() enables it. Defaults to the demo training room.
   */
  bounds?: FluidBounds;
}

/** Axis-aligned world-space X/Z rectangle, in metres. */
export interface FluidBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** The demo training room; kept here so FluidFire does not depend on the demo layout. */
export const DEFAULT_FLUID_BOUNDS: FluidBounds = { minX: -5.8, maxX: 5.8, minZ: -6, maxZ: 4.4 };

export type FogRenderMode = 'slices' | 'raymarch';

export interface FluidFireParameters {
  buoyancy: number;
  vorticity: number;
  dissipation: number;
  cooling: number;
  injectionRadius: number;
  injectionDensity: number;
  injectionTemperature: number;
  velocityStrength: number;
  pointerStrength: number;
  pressureIterations: number;
  particleSize: number;
  renderFraction: number;
  softDepthDistance: number;
  groundVolume: boolean;
  groundFlow: boolean;
  dynamicFog: boolean;
  fogMode: FogRenderMode;
  fogDensity: number;
  fogDepth: number;
  fogAbsorptionColor: THREE.Color;
  fogScatteringColor: THREE.Color;
  showField: boolean;
}

export interface FluidEmitterOptions {
  position?: THREE.Vector3;
  radius?: number;
  density?: number;
  temperature?: number;
  velocity?: THREE.Vector3;
}

type TSLNode = any;
type ComputeNode = any;

const SOURCE_BRUSH_COUNT = 8;
const GROUND_STAMP_COUNT = 8;
const GROUND_BLAST_COUNT = 5;
const GROUND_MOVER_COUNT = 4;
const GROUND_OBSTACLE_COUNT = 4;
const FOG_SLICE_COUNT = 8;
const FOG_RAYMARCH_STEP_COUNT = 6;

/**
 * Purpose-built 2.5D fire/smoke prototype.
 *
 * Field layout:
 * - velocity[2]: RG = velocity in cells/second
 * - scalar[2]: R = density, G = temperature
 * - pressure[2]: R = pressure
 * - divergence: R = divergence (temporarily R = curl)
 *
 * Particle layout:
 * - positionAge: XYZ = local position, W = age
 * - velocityLife: XYZ = local velocity, W = lifetime
 * - visual: X = base size, Y = seed, Z = temperature, W = density
 */
export class FluidFire {
  readonly resolution: number;
  readonly particleCount: number;
  readonly width: number;
  readonly height: number;
  readonly visuals: boolean;
  readonly group = new THREE.Group();

  readonly parameters: FluidFireParameters = {
    buoyancy: 22,
    vorticity: 18,
    dissipation: 0.995,
    cooling: 0.985,
    injectionRadius: 0.075,
    injectionDensity: 0.9,
    injectionTemperature: 1.35,
    velocityStrength: 28,
    pointerStrength: 1.35,
    pressureIterations: 20,
    particleSize: 0.13,
    renderFraction: 0.25,
    softDepthDistance: 0.32,
    groundVolume: true,
    groundFlow: false,
    dynamicFog: false,
    fogMode: 'raymarch',
    fogDensity: 0.85,
    fogDepth: 1.8,
    // Extinction is intentionally separate from the light the smoke scatters.
    // This keeps the optical thickness tunable without re-tinting the volume.
    fogAbsorptionColor: new THREE.Color(0.72, 0.8, 0.9),
    fogScatteringColor: new THREE.Color(0.07, 0.09, 0.11),
    showField: false,
  };

  private readonly scene: THREE.Scene;
  private readonly renderer: THREE.WebGPURenderer;

  private readonly velocity: [THREE.StorageTexture, THREE.StorageTexture];
  private readonly scalar: [THREE.StorageTexture, THREE.StorageTexture];
  private readonly pressure: [THREE.StorageTexture, THREE.StorageTexture];
  private readonly divergence: THREE.StorageTexture;
  private readonly particleAtlas: THREE.DataTexture;

  private velocityIndex = 0;
  private scalarIndex = 0;
  private pressureIndex = 0;

  private readonly positionAge: TSLNode;
  private readonly velocityLife: TSLNode;
  private readonly visual: TSLNode;
  private readonly sourceBrushes: TSLNode;

  private readonly uDelta = uniform(1 / 60);
  private readonly uTime = uniform(0);
  private readonly uFrame = uniform(0);
  private readonly uBuoyancy = uniform(this.parameters.buoyancy);
  private readonly uVorticity = uniform(this.parameters.vorticity);
  private readonly uDissipation = uniform(this.parameters.dissipation);
  private readonly uCooling = uniform(this.parameters.cooling);
  private readonly uInjectionRadius = uniform(this.parameters.injectionRadius);
  private readonly uInjectionDensity = uniform(this.parameters.injectionDensity);
  private readonly uInjectionTemperature = uniform(this.parameters.injectionTemperature);
  private readonly uVelocityStrength = uniform(this.parameters.velocityStrength);
  private readonly uPointerStrength = uniform(this.parameters.pointerStrength);
  private readonly uParticleSize = uniform(this.parameters.particleSize);
  private readonly uRenderFraction = uniform(this.parameters.renderFraction);
  private readonly uSoftDepthDistance = uniform(this.parameters.softDepthDistance);
  private readonly uFogDensity = uniform(this.parameters.fogDensity);
  private readonly uFogDepth = uniform(this.parameters.fogDepth);
  private readonly uFogAbsorptionColor = uniform(this.parameters.fogAbsorptionColor);
  private readonly uFogScatteringColor = uniform(this.parameters.fogScatteringColor);
  private readonly uGroundFlow = uniform(0);
  private readonly roomEnabled = uniform(0);
  private readonly roomCenter = uniform(new THREE.Vector2());
  private readonly roomMin = uniform(new THREE.Vector2(DEFAULT_FLUID_BOUNDS.minX, DEFAULT_FLUID_BOUNDS.minZ));
  private readonly roomMax = uniform(new THREE.Vector2(DEFAULT_FLUID_BOUNDS.maxX, DEFAULT_FLUID_BOUNDS.maxZ));
  // Ground-flow baseline: a density floor the field relaxes toward (ambient mist).
  private readonly uAmbientDensity = uniform(0);
  private readonly uAmbientHeat = uniform(0);
  private readonly uGroundWindVelocity = uniform(new THREE.Vector2());
  private readonly uScrollCells = uniform(new THREE.Vector2());
  private readonly uEmitterUv = uniform(new THREE.Vector2(0.5, 0.045));
  private readonly uPointerUv = uniform(new THREE.Vector2(-10, -10));
  private readonly uPointerVelocity = uniform(new THREE.Vector2());
  private readonly uPointerActive = uniform(0);
  private readonly uColliderUv = uniform(new THREE.Vector2(-10, -10));
  private readonly uColliderVelocity = uniform(new THREE.Vector2());
  private readonly uColliderRadius = uniform(0.05);
  private readonly uColliderActive = uniform(0);
  private readonly uFlowStampShape = Array.from(
    { length: GROUND_STAMP_COUNT },
    () => uniform(new THREE.Vector4(0.5, 0.5, 0.01, 0)),
  );
  // XY = velocity in cells per second, Z = heat (temperature channel) the stamp injects.
  private readonly uFlowStampVelocity = Array.from(
    { length: GROUND_STAMP_COUNT },
    () => uniform(new THREE.Vector4()),
  );
  // XYZ = centre/radius in UV, W = outward velocity in cells per second.
  // Kept separate from density stamps so a spell can first displace existing
  // fog, then begin depositing its residue without either effect overwriting
  // the other.
  private readonly uGroundBlastShape = Array.from(
    { length: GROUND_BLAST_COUNT },
    () => uniform(new THREE.Vector4(0.5, 0.5, 0.01, 0)),
  );
  private readonly uGroundSlash = Array.from({length: GROUND_BLAST_COUNT}, () => uniform(new THREE.Vector4(0,-1,0.3,0)));
  // Dynamic world objects use a dedicated velocity-only stamp list. They do
  // not consume persistent density-source slots and can be paired with a
  // static obstacle mask when the actor should also exclude fog volume.
  private readonly uGroundMoverShape = Array.from(
    { length: GROUND_MOVER_COUNT },
    () => uniform(new THREE.Vector4(0.5, 0.5, 0.01, 0)),
  );
  private readonly uGroundMoverVelocity = Array.from(
    { length: GROUND_MOVER_COUNT },
    () => uniform(new THREE.Vector2()),
  );
  private readonly uGroundObstacleShape = Array.from(
    { length: GROUND_OBSTACLE_COUNT },
    () => uniform(new THREE.Vector4(0.5, 0.5, 0.01, 0)),
  );

  private readonly advectVelocity: ComputeNode[][] = [[], []];
  private readonly computeCurl: ComputeNode[] = [];
  private readonly applyVorticity: ComputeNode[] = [];
  private readonly computeDivergence: ComputeNode[] = [];
  private readonly jacobi: ComputeNode[] = [];
  private readonly project: ComputeNode[][] = [[], []];
  private readonly advectScalar: ComputeNode[][] = [[], []];
  private readonly transportSlash: ComputeNode[] = [];
  private slashDispatches = 0;
  private slashReady = false;
  private readonly slashDelta = uniform(1/60);
  private readonly updateParticles: ComputeNode[][] = [[], []];
  private readonly scrollVelocity: ComputeNode[] = [];
  private readonly scrollScalar: ComputeNode[] = [];
  private readonly scrollPressure: ComputeNode[] = [];
  private readonly updateSources: ComputeNode;
  private readonly initializeParticles: ComputeNode | null = null;

  private readonly sprite: THREE.Sprite | null = null;
  private readonly debugPlanes: [THREE.Mesh, THREE.Mesh] | null = null;
  private readonly fogSlices: [THREE.InstancedMesh, THREE.InstancedMesh] | null = null;
  private readonly fogRaymarches: [THREE.Mesh, THREE.Mesh] | null = null;
  private pointerTtl = 0;
  private readonly pendingScrollCells = new THREE.Vector2();
  private elapsed = 0;
  private frame = 0;

  constructor(scene: THREE.Scene, renderer: THREE.WebGPURenderer, options: FluidFireOptions = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.resolution = options.resolution ?? 256;
    this.particleCount = options.particleCount ?? 100_000;
    this.width = options.width ?? 4;
    this.height = options.height ?? 6;
    this.visuals = options.visuals ?? true;
    if (options.bounds) this.setBounds(options.bounds);

    this.positionAge = instancedArray(this.particleCount, 'vec4');
    this.velocityLife = instancedArray(this.particleCount, 'vec4');
    this.visual = instancedArray(this.particleCount, 'vec4');
    this.sourceBrushes = instancedArray(SOURCE_BRUSH_COUNT, 'vec4');

    this.velocity = [this.makeField(), this.makeField()];
    this.scalar = [this.makeField(), this.makeField()];
    this.pressure = [this.makeField(), this.makeField()];
    this.divergence = this.makeField();
    this.particleAtlas = this.makeParticleAtlas();
    this.updateSources = this.buildSourceUpdate();

    for (let velocityRead = 0; velocityRead < 2; velocityRead += 1) {
      this.scrollVelocity[velocityRead] = this.buildFieldScroll(
        this.velocity[velocityRead]!,
        this.velocity[1 - velocityRead]!,
        `Scroll velocity V${velocityRead}`,
      );
      for (let scalarRead = 0; scalarRead < 2; scalarRead += 1) {
        this.advectVelocity[velocityRead]![scalarRead] = this.buildVelocityAdvection(
          this.velocity[velocityRead]!,
          this.velocity[1 - velocityRead]!,
          this.scalar[scalarRead]!,
          `Advect velocity V${velocityRead} S${scalarRead}`,
        );
      }

      this.computeCurl[velocityRead] = this.buildCurl(
        this.velocity[velocityRead]!,
        `Curl V${velocityRead}`,
      );
      this.applyVorticity[velocityRead] = this.buildVorticity(
        this.velocity[velocityRead]!,
        this.velocity[1 - velocityRead]!,
        `Vorticity V${velocityRead}`,
      );
      this.computeDivergence[velocityRead] = this.buildDivergence(
        this.velocity[velocityRead]!,
        `Divergence V${velocityRead}`,
      );

      for (let pressureRead = 0; pressureRead < 2; pressureRead += 1) {
        this.project[velocityRead]![pressureRead] = this.buildProjection(
          this.velocity[velocityRead]!,
          this.pressure[pressureRead]!,
          this.velocity[1 - velocityRead]!,
          `Project V${velocityRead} P${pressureRead}`,
        );
      }
    }

    for (let pressureRead = 0; pressureRead < 2; pressureRead += 1) {
      this.scrollPressure[pressureRead] = this.buildFieldScroll(
        this.pressure[pressureRead]!,
        this.pressure[1 - pressureRead]!,
        `Scroll pressure P${pressureRead}`,
      );
      this.jacobi[pressureRead] = this.buildJacobi(
        this.pressure[pressureRead]!,
        this.pressure[1 - pressureRead]!,
        `Pressure Jacobi P${pressureRead}`,
      );
    }

    for (let scalarRead = 0; scalarRead < 2; scalarRead += 1) {
      this.transportSlash[scalarRead] = this.buildSlashTransport(this.scalar[scalarRead]!,this.scalar[1-scalarRead]!);
      this.scrollScalar[scalarRead] = this.buildFieldScroll(
        this.scalar[scalarRead]!,
        this.scalar[1 - scalarRead]!,
        `Scroll scalars S${scalarRead}`,
      );
      for (let velocityRead = 0; velocityRead < 2; velocityRead += 1) {
        this.advectScalar[scalarRead]![velocityRead] = this.buildScalarAdvection(
          this.scalar[scalarRead]!,
          this.velocity[velocityRead]!,
          this.scalar[1 - scalarRead]!,
          `Advect scalars S${scalarRead} V${velocityRead}`,
        );
        if (this.visuals) {
          this.updateParticles[velocityRead]![scalarRead] = this.buildParticleUpdate(
            this.velocity[velocityRead]!,
            this.scalar[scalarRead]!,
            `Update particles V${velocityRead} S${scalarRead}`,
          );
        }
      }
    }

    if (this.visuals) {
      this.initializeParticles = this.buildParticleInitialization();
      this.sprite = this.makeParticles();
      this.fogSlices = [this.makeFogSlices(this.scalar[0]), this.makeFogSlices(this.scalar[1])];
      this.fogRaymarches = [this.makeFogRaymarch(this.scalar[0]), this.makeFogRaymarch(this.scalar[1])];
      this.debugPlanes = [this.makeDebugPlane(this.scalar[0]), this.makeDebugPlane(this.scalar[1])];
      this.makeSceneDecor();
    }

    this.scene.add(this.group);
    this.renderer.compute(this.updateSources);
    if (this.initializeParticles) this.renderer.compute(this.initializeParticles);
  }

  get dispatchesPerFrame(): number {
    return Math.max(1, Math.round(this.parameters.pressureIterations)) + (this.visuals ? 8 : 7) + this.slashDispatches;
  }

  /** Internal field access for specialised renderers such as GroundFlowVolume. */
  get scalarFields(): readonly [THREE.StorageTexture, THREE.StorageTexture] {
    return this.scalar;
  }

  /** Internal velocity access for ground materials that deform with the flow. */
  get velocityFields(): readonly [THREE.StorageTexture, THREE.StorageTexture] {
    return this.velocity;
  }

  get currentScalarFieldIndex(): number {
    return this.scalarIndex;
  }

  /** Compute continues while the fire benchmark's scene objects are hidden. */
  setVisualsVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  setPosition(x: number, y: number, z: number): void {
    this.group.position.set(x, y, z);
  }

  addEmitter(options: FluidEmitterOptions): void {
    if (options.position) {
      this.uEmitterUv.value.set(
        THREE.MathUtils.clamp(options.position.x / this.width + 0.5, 0, 1),
        THREE.MathUtils.clamp(options.position.y / this.height, 0, 1),
      );
    }
    if (options.radius !== undefined) {
      this.parameters.injectionRadius = options.radius / Math.min(this.width, this.height);
    }
    if (options.density !== undefined) this.parameters.injectionDensity = options.density;
    if (options.temperature !== undefined) this.parameters.injectionTemperature = options.temperature;
    if (options.velocity !== undefined) {
      this.parameters.velocityStrength = options.velocity.y * this.resolution / this.height;
    }
  }

  injectPointer(uvPosition: THREE.Vector2, uvDelta: THREE.Vector2, eventDeltaSeconds: number): void {
    const safeDt = Math.max(eventDeltaSeconds, 1 / 240);
    this.uPointerUv.value.copy(uvPosition);
    this.uPointerVelocity.value
      .set(uvDelta.x * this.resolution / safeDt, uvDelta.y * this.resolution / safeDt)
      .clampLength(0, 150);
    this.uPointerActive.value = 1;
    this.pointerTtl = 0.11;
  }

  clearPointer(): void {
    this.pointerTtl = 0;
    this.uPointerActive.value = 0;
    this.uPointerVelocity.value.set(0, 0);
  }

  /**
   * Sets one moving circular ground-contact stamp. GroundFlowVolume converts
   * world-space player/capsule inputs to these field coordinates; a future
   * stamp array will extend this to spells and multiple interactables.
   */
  setColliderStamp(uvPosition: THREE.Vector2, velocityCellsPerSecond: THREE.Vector2, radiusUv: number): void {
    const inside = uvPosition.x >= 0 && uvPosition.x <= 1 && uvPosition.y >= 0 && uvPosition.y <= 1;
    this.uColliderActive.value = inside ? 1 : 0;
    if (!inside) return;
    this.uColliderUv.value.copy(uvPosition);
    this.uColliderVelocity.value.copy(velocityCellsPerSecond).clampLength(0, 120);
    this.uColliderRadius.value = THREE.MathUtils.clamp(radiusUv, 0.005, 0.25);
  }

  clearColliderStamp(): void {
    this.uColliderActive.value = 0;
    this.uColliderVelocity.value.set(0, 0);
  }

  /**
   * Configures one world-to-UV converted density/velocity stamp for ground flow.
   * `heat` (0..2) is written to the temperature channel, which renderers can
   * use as a second colour (warm smoke over cool mist).
   */
  setGroundStamp(
    index: number,
    uvPosition: THREE.Vector2,
    radiusUv: number,
    density: number,
    velocityCellsPerSecond = new THREE.Vector2(),
    heat = 0,
  ): void {
    const shape = this.uFlowStampShape[index];
    const velocity = this.uFlowStampVelocity[index];
    if (!shape || !velocity) throw new Error(`Ground stamp index must be between 0 and ${GROUND_STAMP_COUNT - 1}.`);
    const inside = uvPosition.x >= 0 && uvPosition.x <= 1 && uvPosition.y >= 0 && uvPosition.y <= 1;
    shape.value.set(
      THREE.MathUtils.clamp(uvPosition.x, 0, 1),
      THREE.MathUtils.clamp(uvPosition.y, 0, 1),
      THREE.MathUtils.clamp(radiusUv, 0.005, 0.3),
      inside ? THREE.MathUtils.clamp(density, 0, 2) : 0,
    );
    const clamped = velocityCellsPerSecond.clone().clampLength(0, 120);
    velocity.value.set(clamped.x, clamped.y, THREE.MathUtils.clamp(heat, 0, 2), 0);
  }

  /** Baseline the ground-flow density (and temperature) relax toward: ambient mist. */
  setAmbientDensity(density: number, heat = 0): void {
    this.uAmbientDensity.value = THREE.MathUtils.clamp(density, 0, 1.5);
    this.uAmbientHeat.value = THREE.MathUtils.clamp(heat, 0, 2);
  }

  /** World-space rectangle used by the room mask (setRoomBounds enables it). */
  setBounds(bounds: FluidBounds): void {
    this.roomMin.value.set(bounds.minX, bounds.minZ);
    this.roomMax.value.set(bounds.maxX, bounds.maxZ);
  }

  clearGroundStamp(index: number): void {
    this.setGroundStamp(index, new THREE.Vector2(0.5, 0.5), 0.01, 0);
  }

  /**
   * Configures a short outward radial force for a ground spell. Unlike a
   * density stamp this only changes velocity, so it visibly pushes the smoke
   * already in the field before the spell starts leaving residue.
   */
  setGroundBlast(
    index: number,
    uvPosition: THREE.Vector2,
    radiusUv: number,
    outwardCellsPerSecond: number,
  ): void {
    const shape = this.uGroundBlastShape[index];
    if (!shape) throw new Error(`Ground blast index must be between 0 and ${GROUND_BLAST_COUNT - 1}.`);
    this.uGroundSlash[index]!.value.w = 0;
    const inside = uvPosition.x >= 0 && uvPosition.x <= 1 && uvPosition.y >= 0 && uvPosition.y <= 1;
    shape.value.set(
      THREE.MathUtils.clamp(uvPosition.x, 0, 1),
      THREE.MathUtils.clamp(uvPosition.y, 0, 1),
      THREE.MathUtils.clamp(radiusUv, 0.005, 0.35),
      inside ? THREE.MathUtils.clamp(outwardCellsPerSecond, 0, 140) : 0,
    );
  }

  clearGroundBlast(index: number): void {
    this.setGroundBlast(index, new THREE.Vector2(0.5, 0.5), 0.01, 0);
  }

  setRoomBounds(enabled:boolean, center:THREE.Vector2):void {
    this.roomEnabled.value=enabled?1:0;this.roomCenter.value.copy(center);
  }
  private roomMask(fieldUv:TSLNode):TSLNode {
    const at = fieldUv.sub(0.5).mul(vec2(this.width,this.height)).add(this.roomCenter);
    const inside = float(at.x.greaterThanEqual(this.roomMin.x).and(at.x.lessThanEqual(this.roomMax.x))
      .and(at.y.greaterThanEqual(this.roomMin.y)).and(at.y.lessThanEqual(this.roomMax.y)).select(1,0));
    return mix(float(1),inside,this.roomEnabled);
  }

  setGroundSlash(index: number, uv: THREE.Vector2, halfLength: number, width: number, forward: THREE.Vector2, speed: number): void {
    this.setGroundBlast(index, uv, halfLength / Math.min(this.width,this.height), speed);
    // Slash length is in metres and is not constrained by the circular UV radius limit.
    this.uGroundBlastShape[index]!.value.z = halfLength;
    this.uGroundSlash[index]!.value.set(forward.x,forward.y,width,1);
  }

  /** Configures one velocity-only capsule/contact stamp for a moving world object. */
  setGroundMover(
    index: number,
    uvPosition: THREE.Vector2,
    radiusUv: number,
    velocityCellsPerSecond: THREE.Vector2,
  ): void {
    const shape = this.uGroundMoverShape[index];
    const velocity = this.uGroundMoverVelocity[index];
    if (!shape || !velocity) throw new Error(`Ground mover index must be between 0 and ${GROUND_MOVER_COUNT - 1}.`);
    const inside = uvPosition.x >= 0 && uvPosition.x <= 1 && uvPosition.y >= 0 && uvPosition.y <= 1;
    shape.value.set(
      THREE.MathUtils.clamp(uvPosition.x, 0, 1),
      THREE.MathUtils.clamp(uvPosition.y, 0, 1),
      THREE.MathUtils.clamp(radiusUv, 0.005, 0.25),
      inside ? 1 : 0,
    );
    velocity.value.copy(velocityCellsPerSecond).clampLength(0, 140);
  }

  clearGroundMover(index: number): void {
    this.setGroundMover(index, new THREE.Vector2(0.5, 0.5), 0.01, new THREE.Vector2());
  }

  /** Configures one circular static obstacle in local field UV coordinates. */
  setGroundObstacle(index: number, uvPosition: THREE.Vector2, radiusUv: number, active = true): void {
    const shape = this.uGroundObstacleShape[index];
    if (!shape) throw new Error(`Ground obstacle index must be between 0 and ${GROUND_OBSTACLE_COUNT - 1}.`);
    const inside = uvPosition.x >= 0 && uvPosition.x <= 1 && uvPosition.y >= 0 && uvPosition.y <= 1;
    shape.value.set(
      THREE.MathUtils.clamp(uvPosition.x, 0, 1),
      THREE.MathUtils.clamp(uvPosition.y, 0, 1),
      THREE.MathUtils.clamp(radiusUv, 0.005, 0.3),
      active && inside ? 1 : 0,
    );
  }

  clearGroundObstacle(index: number): void {
    this.setGroundObstacle(index, new THREE.Vector2(0.5, 0.5), 0.01, false);
  }

  /** Sets a broad ground-flow target velocity in simulation cells per second. */
  setGroundWind(velocityCellsPerSecond: THREE.Vector2): void {
    this.uGroundWindVelocity.value.copy(velocityCellsPerSecond).clampLength(0, 60);
  }

  /**
   * Preserves the active fluid fields while their world-space simulation window
   * moves. Positive cells move the window in positive world X/Y, so the new
   * field samples old cells at +cells and clears only newly exposed borders.
   *
   * GroundFlowVolume will call this with SimulationWindowShift.cells after its
   * X/Z mapping is introduced. It remains opt-in while this class is still the
   * vertical fire benchmark.
   */
  scrollFields(cells: THREE.Vector2): void {
    this.pendingScrollCells.add(cells.clone().round());
  }

  update(deltaSeconds: number): void {
    const dt = Math.min(Math.max(deltaSeconds, 1 / 240), 1 / 30);
    this.elapsed += dt;
    this.frame += 1;
    this.pointerTtl = Math.max(0, this.pointerTtl - dt);
    if (this.pointerTtl === 0) this.uPointerActive.value = 0;

    this.uDelta.value = dt;
    this.uTime.value = this.elapsed;
    this.uFrame.value = this.frame;
    this.uBuoyancy.value = this.parameters.buoyancy;
    this.uVorticity.value = this.parameters.vorticity;
    this.uDissipation.value = this.parameters.dissipation;
    this.uCooling.value = this.parameters.cooling;
    this.uInjectionRadius.value = this.parameters.injectionRadius;
    this.uInjectionDensity.value = this.parameters.injectionDensity;
    this.uInjectionTemperature.value = this.parameters.injectionTemperature;
    this.uVelocityStrength.value = this.parameters.velocityStrength;
    this.uPointerStrength.value = this.parameters.pointerStrength;
    this.uParticleSize.value = this.parameters.particleSize;
    this.uRenderFraction.value = this.parameters.renderFraction;
    this.uSoftDepthDistance.value = this.parameters.softDepthDistance;
    this.uFogDensity.value = this.parameters.fogDensity;
    this.uFogDepth.value = this.parameters.fogDepth;
    this.uFogAbsorptionColor.value.copy(this.parameters.fogAbsorptionColor);
    this.uFogScatteringColor.value.copy(this.parameters.fogScatteringColor);
    this.uGroundFlow.value = this.parameters.groundFlow ? 1 : 0;

    this.applyPendingFieldScroll();

    this.renderer.compute(this.updateSources);
    this.renderer.compute(this.advectVelocity[this.velocityIndex]![this.scalarIndex]!);
    this.velocityIndex = 1 - this.velocityIndex;

    this.renderer.compute(this.computeCurl[this.velocityIndex]!);
    this.renderer.compute(this.applyVorticity[this.velocityIndex]!);
    this.velocityIndex = 1 - this.velocityIndex;

    this.renderer.compute(this.computeDivergence[this.velocityIndex]!);

    const iterations = THREE.MathUtils.clamp(Math.round(this.parameters.pressureIterations), 1, 40);
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      this.renderer.compute(this.jacobi[this.pressureIndex]!);
      this.pressureIndex = 1 - this.pressureIndex;
    }

    this.renderer.compute(this.project[this.velocityIndex]![this.pressureIndex]!);
    this.velocityIndex = 1 - this.velocityIndex;

    this.renderer.compute(this.advectScalar[this.scalarIndex]![this.velocityIndex]!);
    this.scalarIndex = 1 - this.scalarIndex;

    this.slashDispatches = 0;
    const slashSpeed=this.uGroundSlash.reduce((sum,slash,i)=>sum+(slash.value.w>0?this.uGroundBlastShape[i]!.value.w*(Math.abs(slash.value.x)+Math.abs(slash.value.y)):0),0);
    if(this.parameters.groundFlow && (slashSpeed>0 || !this.slashReady)) {
      // Compile both directions during startup, so the first swing does not stall.
      // Substep larger grid-space velocities instead of slowing cuts at higher resolution.
      this.slashDispatches=slashSpeed>0?Math.min(12,Math.max(1,Math.ceil(slashSpeed*dt/0.8))):2;
      this.slashDelta.value=dt/this.slashDispatches;
      for(let pass=0;pass<this.slashDispatches;pass++) {
        this.renderer.compute(this.transportSlash[this.scalarIndex]!);
        this.scalarIndex = 1 - this.scalarIndex;
      }
      this.slashReady=true;
    }

    if (!this.visuals || !this.debugPlanes || !this.fogSlices || !this.fogRaymarches) return;
    this.renderer.compute(this.updateParticles[this.velocityIndex]![this.scalarIndex]!);

    this.debugPlanes[0].visible = this.parameters.showField && this.scalarIndex === 0;
    this.debugPlanes[1].visible = this.parameters.showField && this.scalarIndex === 1;
    for (let index = 0; index < this.fogSlices.length; index += 1) {
      const isCurrentField = this.parameters.dynamicFog && this.scalarIndex === index;
      const fogSlices = this.fogSlices[index]!;
      fogSlices.visible = isCurrentField && this.parameters.fogMode === 'slices';
      fogSlices.scale.z = this.parameters.fogDepth;
      this.fogRaymarches[index]!.visible = isCurrentField && this.parameters.fogMode === 'raymarch';
    }
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (const field of [
      ...this.velocity,
      ...this.scalar,
      ...this.pressure,
      this.divergence,
    ]) {
      field.dispose();
    }

    for (const buffer of [this.positionAge, this.velocityLife, this.visual, this.sourceBrushes]) {
      buffer.value.dispose();
    }
    this.particleAtlas.dispose();

    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      // THREE.Sprite instances share an internal singleton quad geometry.
      // Disposing it here invalidates every subsequently created sprite.
      if (!(object as THREE.Sprite).isSprite) mesh.geometry?.dispose();
      if (Array.isArray(mesh.material)) mesh.material.forEach((material) => material.dispose());
      else mesh.material?.dispose();
    });
  }

  private makeField(): THREE.StorageTexture {
    const field = new THREE.StorageTexture(this.resolution, this.resolution);
    field.name = `Fluid field ${this.resolution}`;
    field.format = THREE.RGBAFormat;
    field.type = THREE.HalfFloatType;
    // Compute uses textureLoad and explicit interpolation; filtering affects render sampling only.
    field.minFilter = THREE.LinearFilter;
    field.magFilter = THREE.LinearFilter;
    field.wrapS = THREE.ClampToEdgeWrapping;
    field.wrapT = THREE.ClampToEdgeWrapping;
    field.generateMipmaps = false;
    (field as THREE.StorageTexture & { mipmapsAutoUpdate: boolean }).mipmapsAutoUpdate = false;
    return field;
  }

  private makeParticleAtlas(): THREE.DataTexture {
    const tiles = 4;
    const tileSize = 64;
    const size = tiles * tileSize;
    const data = new Uint8Array(size * size * 4);

    const random = (x: number, y: number, seed: number): number => {
      let value = Math.imul(x + seed * 131, 374_761_393) + Math.imul(y + seed * 269, 668_265_263);
      value = Math.imul(value ^ (value >>> 13), 1_274_126_177);
      return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_295;
    };
    const smooth = (value: number): number => value * value * (3 - 2 * value);
    const valueNoise = (x: number, y: number, seed: number): number => {
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const tx = smooth(x - x0);
      const ty = smooth(y - y0);
      const bottom = THREE.MathUtils.lerp(random(x0, y0, seed), random(x0 + 1, y0, seed), tx);
      const top = THREE.MathUtils.lerp(random(x0, y0 + 1, seed), random(x0 + 1, y0 + 1, seed), tx);
      return THREE.MathUtils.lerp(bottom, top, ty);
    };

    for (let tileY = 0; tileY < tiles; tileY += 1) {
      for (let tileX = 0; tileX < tiles; tileX += 1) {
        const seed = tileY * tiles + tileX + 1;
        for (let pixelY = 0; pixelY < tileSize; pixelY += 1) {
          for (let pixelX = 0; pixelX < tileSize; pixelX += 1) {
            const u = (pixelX + 0.5) / tileSize;
            const v = (pixelY + 0.5) / tileSize;
            const centeredX = (u - 0.5) * 2;
            const centeredY = (v - 0.5) * 2;
            const radius = Math.hypot(centeredX, centeredY);
            let noise = 0;
            let amplitude = 0.57;
            let frequency = 2.1;
            for (let octave = 0; octave < 4; octave += 1) {
              noise += valueNoise(
                u * frequency + seed * 3.17,
                v * frequency - seed * 2.41,
                seed * 17 + octave,
              ) * amplitude;
              frequency *= 2.07;
              amplitude *= 0.48;
            }
            const warpedRadius = radius + (noise - 0.55) * 0.3;
            const edge = 1 - THREE.MathUtils.smoothstep(warpedRadius, 0.62, 0.98);
            const interior = THREE.MathUtils.clamp(0.58 + noise * 0.56 - radius * 0.18, 0, 1);
            const alpha = THREE.MathUtils.clamp(edge * interior, 0, 1);
            const outputX = tileX * tileSize + pixelX;
            const outputY = tileY * tileSize + pixelY;
            const offset = (outputY * size + outputX) * 4;
            const encoded = Math.round(alpha * 255);
            data[offset] = encoded;
            data[offset + 1] = encoded;
            data[offset + 2] = encoded;
            data[offset + 3] = 255;
          }
        }
      }
    }

    const atlas = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    atlas.name = 'Procedural smoke sprite atlas';
    atlas.colorSpace = THREE.NoColorSpace;
    atlas.minFilter = THREE.LinearFilter;
    atlas.magFilter = THREE.LinearFilter;
    atlas.wrapS = THREE.ClampToEdgeWrapping;
    atlas.wrapT = THREE.ClampToEdgeWrapping;
    atlas.generateMipmaps = false;
    atlas.needsUpdate = true;
    return atlas;
  }

  private coordinates(): { x: TSLNode; y: TSLNode; indexUv: TSLNode; fieldUv: TSLNode } {
    const x = instanceIndex.mod(this.resolution);
    const y = instanceIndex.div(this.resolution);
    return {
      x,
      y,
      indexUv: uvec2(x, y),
      fieldUv: vec2(float(x).add(0.5), float(y).add(0.5)).div(this.resolution),
    };
  }

  private sampleBilinear(field: THREE.StorageTexture, sampleUv: TSLNode): TSLNode {
    const position = sampleUv.clamp(0, 1).mul(this.resolution).sub(0.5);
    const x0: TSLNode = (int(position.x.floor()) as TSLNode).max(0).min(this.resolution - 1);
    const y0: TSLNode = (int(position.y.floor()) as TSLNode).max(0).min(this.resolution - 1);
    const x1 = x0.add(1).min(this.resolution - 1);
    const y1 = y0.add(1).min(this.resolution - 1);
    const fraction = position.fract();
    const bottom = mix(
      textureLoad(field, ivec2(x0, y0)),
      textureLoad(field, ivec2(x1, y0)),
      fraction.x,
    );
    const top = mix(
      textureLoad(field, ivec2(x0, y1)),
      textureLoad(field, ivec2(x1, y1)),
      fraction.x,
    );
    return mix(bottom, top, fraction.y);
  }

  private applyPendingFieldScroll(): void {
    if (this.pendingScrollCells.lengthSq() === 0) return;
    this.uScrollCells.value.copy(this.pendingScrollCells);

    this.renderer.compute(this.scrollVelocity[this.velocityIndex]!);
    this.velocityIndex = 1 - this.velocityIndex;
    this.renderer.compute(this.scrollScalar[this.scalarIndex]!);
    this.scalarIndex = 1 - this.scalarIndex;
    this.renderer.compute(this.scrollPressure[this.pressureIndex]!);
    this.pressureIndex = 1 - this.pressureIndex;
    this.pendingScrollCells.set(0, 0);
  }

  private buildFieldScroll(
    fieldRead: THREE.StorageTexture,
    fieldWrite: THREE.StorageTexture,
    name: string,
  ): ComputeNode {
    const kernel = Fn(() => {
      const { x, y, indexUv } = this.coordinates();
      const sourceX = int(x).add(int(this.uScrollCells.x));
      const sourceY = int(y).add(int(this.uScrollCells.y));
      const inside = sourceX
        .greaterThanEqual(0)
        .and(sourceX.lessThan(this.resolution))
        .and(sourceY.greaterThanEqual(0))
        .and(sourceY.lessThan(this.resolution));
      const shifted = vec4(0).toVar('shiftedField');

      If(inside, () => {
        shifted.assign(textureLoad(
          fieldRead,
          ivec2(
            (sourceX as TSLNode).max(0).min(this.resolution - 1),
            (sourceY as TSLNode).max(0).min(this.resolution - 1),
          ),
        ));
      });
      textureStore(fieldWrite, indexUv, shifted).toWriteOnly();
    });
    return kernel().compute(this.resolution * this.resolution).setName(name);
  }

  private texel(field: THREE.StorageTexture, x: TSLNode, y: TSLNode, dx = 0, dy = 0): TSLNode {
    return textureLoad(
      field,
      ivec2(
        (int(x).add(dx) as TSLNode).max(0).min(this.resolution - 1),
        (int(y).add(dy) as TSLNode).max(0).min(this.resolution - 1),
      ),
    );
  }

  private isBoundary(x: TSLNode, y: TSLNode): TSLNode {
    return x
      .lessThanEqual(0)
      .or(x.greaterThanEqual(this.resolution - 1))
      .or(y.lessThanEqual(0))
      .or(y.greaterThanEqual(this.resolution - 1));
  }

  private emitterMask(fieldUv: TSLNode): TSLNode {
    const radialDistance = distance(fieldUv, this.uEmitterUv);
    const core = smoothstep(this.uInjectionRadius, float(0), radialDistance);
    const flicker = sin(
      fieldUv.x.mul(91).add(fieldUv.y.mul(37)).add(this.uTime.mul(7.3)),
    )
      .mul(0.12)
      .add(0.88);
    return core.mul(flicker);
  }

  private sourceBrushSample(fieldUv: TSLNode): TSLNode {
    const strongestMask = float(0).toVar('sourceMask');
    const weightSum = float(0).toVar('sourceWeight');
    const brushVelocity = vec2(0).toVar('sourceBrushVelocity');

    for (let index = 0; index < SOURCE_BRUSH_COUNT; index += 1) {
      const brush = this.sourceBrushes.element(uint(index));
      const radiusVariation = hash(uint(index).add(uint(211))).mul(0.24).add(0.3);
      const influence = smoothstep(
        this.uInjectionRadius.mul(radiusVariation),
        float(0),
        distance(fieldUv, brush.xy),
      );
      strongestMask.assign(max(strongestMask, influence));
      weightSum.addAssign(influence);
      brushVelocity.addAssign(brush.zw.mul(influence));
    }

    return vec3(
      strongestMask,
      brushVelocity.div(weightSum.add(0.0001)),
    );
  }

  /** Fixed-size, GPU-unrolled source list for the player-centred ground window. */
  private groundStampSample(fieldUv: TSLNode): TSLNode {
    const density = float(0).toVar('groundStampDensity');
    const velocity = vec2(0).toVar('groundStampVelocity');
    const heat = float(0).toVar('groundStampHeat');

    for (let index = 0; index < GROUND_STAMP_COUNT; index += 1) {
      const shape = this.uFlowStampShape[index]!;
      const stampVelocity = this.uFlowStampVelocity[index]!;
      const influence = smoothstep(shape.z, float(0), distance(fieldUv, shape.xy)).mul(shape.w);
      density.addAssign(influence);
      velocity.addAssign(stampVelocity.xy.mul(influence));
      heat.assign(max(heat, stampVelocity.z.mul(influence)));
    }

    return vec4(density.min(1), velocity, heat);
  }

  private groundBlastForce(fieldUv: TSLNode, slashOnly = false): TSLNode {
    const force = vec2(0).toVar('groundBlastForce');
    for (let index = 0; index < GROUND_BLAST_COUNT; index += 1) {
      const shape = this.uGroundBlastShape[index]!;
      const offset = fieldUv.sub(shape.xy);
      const slash = this.uGroundSlash[index]!;
      const metric = slash.w.greaterThan(0).select(
        slashDistanceNode(offset.mul(vec2(this.width,this.height)),slash.xy,shape.z,slash.z),
        offset.length().div(shape.z.max(0.001)));
      const influence = float(1).sub(smoothstep(0,1,metric)).mul(shape.w).mul(slashOnly ? slash.w : 1);
      const direction = slash.w.greaterThan(0).select(slash.xy,offset.div(offset.length().add(0.0001)));
      force.addAssign(direction.mul(influence));
    }
    return force;
  }

  private groundMoverSample(fieldUv: TSLNode): TSLNode {
    const influenceTotal = float(0).toVar('groundMoverInfluence');
    const velocity = vec2(0).toVar('groundMoverVelocity');
    for (let index = 0; index < GROUND_MOVER_COUNT; index += 1) {
      const shape = this.uGroundMoverShape[index]!;
      const moverVelocity = this.uGroundMoverVelocity[index]!;
      const influence = smoothstep(shape.z, float(0), distance(fieldUv, shape.xy)).mul(shape.w);
      influenceTotal.addAssign(influence);
      velocity.addAssign(moverVelocity.mul(influence));
    }
    return vec3(influenceTotal.min(1), velocity);
  }

  private groundObstacleMask(fieldUv: TSLNode): TSLNode {
    const mask = float(0).toVar('groundObstacleMask');
    for (let index = 0; index < GROUND_OBSTACLE_COUNT; index += 1) {
      const shape = this.uGroundObstacleShape[index]!;
      const influence = smoothstep(shape.z, shape.z.mul(0.78), distance(fieldUv, shape.xy)).mul(shape.w);
      mask.assign(max(mask, influence));
    }
    return mask.max(float(1).sub(this.roomMask(fieldUv)));
  }

  private buildSourceUpdate(): ComputeNode {
    const kernel = Fn(() => {
      const brush = this.sourceBrushes.element(instanceIndex);
      const seedA = hash(instanceIndex.add(uint(17)));
      const seedB = hash(instanceIndex.add(uint(71)));
      const frequency = seedA.mul(1.4).add(1.2);
      const phase = this.uTime.mul(frequency).add(seedB.mul(6.28318));
      const cycle = this.uTime.mul(seedA.mul(0.34).add(0.28)).add(seedB).fract();
      const amplitude = this.uInjectionRadius.mul(seedB.mul(0.44).add(0.18));
      const position = vec2(
        this.uEmitterUv.x.add(sin(phase).mul(amplitude)),
        this.uEmitterUv.y.add(cycle.mul(this.uInjectionRadius).mul(1.1)),
      );
      const velocity = vec2(
        cos(phase).mul(amplitude).mul(frequency).mul(this.resolution),
        this.uInjectionRadius.mul(seedA.mul(0.34).add(0.28)).mul(1.1).mul(this.resolution),
      );
      brush.assign(vec4(position, velocity));
    });
    return kernel().compute(SOURCE_BRUSH_COUNT).setName('Update source brushes');
  }

  private buildVelocityAdvection(
    velocityRead: THREE.StorageTexture,
    velocityWrite: THREE.StorageTexture,
    scalarRead: THREE.StorageTexture,
    name: string,
  ): ComputeNode {
    const kernel = Fn(() => {
      const { x, y, indexUv, fieldUv } = this.coordinates();
      const currentVelocity = this.texel(velocityRead, x, y).xy;
      const backtraceUv = fieldUv.sub(
        currentVelocity.mul(this.uDelta).div(this.resolution),
      );
      const velocity = this.sampleBilinear(velocityRead, backtraceUv).xy.toVar('velocity');
      const scalar = this.sampleBilinear(scalarRead, fieldUv);
      const retention = pow(this.uDissipation, this.uDelta.mul(60));
      velocity.mulAssign(retention);

      // Wind is a broad target velocity, approached over time instead of a
      // one-frame impulse. Fire mode keeps uGroundFlow at zero.
      const windBlend = this.uGroundFlow.mul(this.uDelta).mul(0.85).clamp(0, 1);
      velocity.assign(mix(velocity, this.uGroundWindVelocity, windBlend));

      const lift = scalar.g.mul(this.uBuoyancy).sub(scalar.r.mul(2.2));
      velocity.y.addAssign(lift.mul(this.uDelta));

      const sourceBrush = this.sourceBrushSample(fieldUv);
      const fireSource = max(this.emitterMask(fieldUv).mul(0.36), sourceBrush.x);
      const fireSourceVelocity = vec2(
        fieldUv.x.sub(this.uEmitterUv.x).mul(34),
        this.uVelocityStrength,
      ).add(sourceBrush.yz.mul(vec2(0.85, 0.28)));
      const groundSource = this.groundStampSample(fieldUv);
      const source = mix(fireSource, groundSource.x, this.uGroundFlow);
      const sourceVelocity = mix(fireSourceVelocity, groundSource.yz, this.uGroundFlow);
      const sourceBlend = source.mul(this.uDelta).mul(18).clamp(0, 1);
      velocity.assign(mix(velocity, sourceVelocity, sourceBlend));
      // Ambient source relaxation must not overwrite the current swing impulse.
      velocity.addAssign(this.groundBlastForce(fieldUv).mul(this.uGroundFlow).mul(this.uDelta));

      const pointerDistance = distance(fieldUv, this.uPointerUv);
      const pointerMask = smoothstep(this.uInjectionRadius.mul(1.7), float(0), pointerDistance)
        .mul(this.uPointerActive);
      const pointerBlend = pointerMask.mul(this.uPointerStrength).mul(this.uDelta).mul(12).clamp(0, 1);
      velocity.assign(mix(velocity, this.uPointerVelocity, pointerBlend));

      const colliderDistance = distance(fieldUv, this.uColliderUv);
      const colliderMask = smoothstep(this.uColliderRadius, float(0), colliderDistance)
        .mul(this.uColliderActive);
      const colliderBlend = colliderMask.mul(this.uDelta).mul(18).clamp(0, 1);
      velocity.assign(mix(velocity, this.uColliderVelocity, colliderBlend));

      const mover = this.groundMoverSample(fieldUv);
      const moverBlend = mover.x.mul(this.uDelta).mul(18).clamp(0, 1);
      velocity.assign(mix(velocity, mover.yz, moverBlend));

      If(this.groundObstacleMask(fieldUv).greaterThan(0.5), () => {
        velocity.assign(vec2(0));
      });

      If(this.isBoundary(x, y), () => {
        velocity.assign(vec2(0));
      });

      textureStore(velocityWrite, indexUv, vec4(velocity.mul(this.roomMask(vec2(float(x).add(0.5),float(y).add(0.5)).div(this.resolution))), 0, 1)).toWriteOnly();
    });
    return kernel().compute(this.resolution * this.resolution).setName(name);
  }

  private buildCurl(velocityRead: THREE.StorageTexture, name: string): ComputeNode {
    const kernel = Fn(() => {
      const { x, y, indexUv } = this.coordinates();
      const left = this.texel(velocityRead, x, y, -1, 0).y;
      const right = this.texel(velocityRead, x, y, 1, 0).y;
      const bottom = this.texel(velocityRead, x, y, 0, -1).x;
      const top = this.texel(velocityRead, x, y, 0, 1).x;
      const curl = right.sub(left).sub(top.sub(bottom)).mul(0.5);
      textureStore(this.divergence, indexUv, vec4(curl, 0, 0, 1)).toWriteOnly();
    });
    return kernel().compute(this.resolution * this.resolution).setName(name);
  }

  private buildVorticity(
    velocityRead: THREE.StorageTexture,
    velocityWrite: THREE.StorageTexture,
    name: string,
  ): ComputeNode {
    const kernel = Fn(() => {
      const { x, y, indexUv } = this.coordinates();
      const left = abs(this.texel(this.divergence, x, y, -1, 0).r);
      const right = abs(this.texel(this.divergence, x, y, 1, 0).r);
      const bottom = abs(this.texel(this.divergence, x, y, 0, -1).r);
      const top = abs(this.texel(this.divergence, x, y, 0, 1).r);
      const centerCurl = this.texel(this.divergence, x, y).r;
      const gradient = vec2(right.sub(left), top.sub(bottom)).mul(0.5).toVar('curlGradient');
      const normal = gradient.div(gradient.length().add(0.0001));
      const force = vec2(normal.y, normal.x.negate())
        .mul(centerCurl)
        .mul(this.uVorticity)
        .mul(this.uDelta);
      const velocity = this.texel(velocityRead, x, y).xy.add(force).toVar('confinedVelocity');

      If(this.isBoundary(x, y), () => {
        velocity.assign(vec2(0));
      });

      textureStore(velocityWrite, indexUv, vec4(velocity.mul(this.roomMask(vec2(float(x).add(0.5),float(y).add(0.5)).div(this.resolution))), 0, 1)).toWriteOnly();
    });
    return kernel().compute(this.resolution * this.resolution).setName(name);
  }

  private buildDivergence(velocityRead: THREE.StorageTexture, name: string): ComputeNode {
    const kernel = Fn(() => {
      const { x, y, indexUv } = this.coordinates();
      const left = this.texel(velocityRead, x, y, -1, 0).x;
      const right = this.texel(velocityRead, x, y, 1, 0).x;
      const bottom = this.texel(velocityRead, x, y, 0, -1).y;
      const top = this.texel(velocityRead, x, y, 0, 1).y;
      const divergence = right.sub(left).add(top.sub(bottom)).mul(0.5);
      textureStore(this.divergence, indexUv, vec4(divergence, 0, 0, 1)).toWriteOnly();
    });
    return kernel().compute(this.resolution * this.resolution).setName(name);
  }

  private buildJacobi(
    pressureRead: THREE.StorageTexture,
    pressureWrite: THREE.StorageTexture,
    name: string,
  ): ComputeNode {
    const kernel = Fn(() => {
      const { x, y, indexUv } = this.coordinates();
      const left = this.texel(pressureRead, x, y, -1, 0).r;
      const right = this.texel(pressureRead, x, y, 1, 0).r;
      const bottom = this.texel(pressureRead, x, y, 0, -1).r;
      const top = this.texel(pressureRead, x, y, 0, 1).r;
      const divergence = this.texel(this.divergence, x, y).r;
      const pressure = left.add(right).add(bottom).add(top).sub(divergence).mul(0.25);
      textureStore(pressureWrite, indexUv, vec4(pressure, 0, 0, 1)).toWriteOnly();
    });
    return kernel().compute(this.resolution * this.resolution).setName(name);
  }

  private buildProjection(
    velocityRead: THREE.StorageTexture,
    pressureRead: THREE.StorageTexture,
    velocityWrite: THREE.StorageTexture,
    name: string,
  ): ComputeNode {
    const kernel = Fn(() => {
      const { x, y, indexUv } = this.coordinates();
      const left = this.texel(pressureRead, x, y, -1, 0).r;
      const right = this.texel(pressureRead, x, y, 1, 0).r;
      const bottom = this.texel(pressureRead, x, y, 0, -1).r;
      const top = this.texel(pressureRead, x, y, 0, 1).r;
      const gradient = vec2(right.sub(left), top.sub(bottom)).mul(0.5);
      const velocity = this.texel(velocityRead, x, y).xy.sub(gradient).toVar('projectedVelocity');

      If(this.isBoundary(x, y), () => {
        velocity.assign(vec2(0));
      });

      textureStore(velocityWrite, indexUv, vec4(velocity.mul(this.roomMask(vec2(float(x).add(0.5),float(y).add(0.5)).div(this.resolution))), 0, 1)).toWriteOnly();
    });
    return kernel().compute(this.resolution * this.resolution).setName(name);
  }

  private buildScalarAdvection(
    scalarRead: THREE.StorageTexture,
    velocityRead: THREE.StorageTexture,
    scalarWrite: THREE.StorageTexture,
    name: string,
  ): ComputeNode {
    const kernel = Fn(() => {
      const { x, y, indexUv, fieldUv } = this.coordinates();
      const velocity = this.sampleBilinear(velocityRead, fieldUv).xy;
      const backtraceUv = fieldUv.sub(velocity.mul(this.uDelta).div(this.resolution));
      const advected = this.sampleBilinear(scalarRead, backtraceUv).rg.toVar('advectedScalars');
      const densityRetention = pow(this.uDissipation, this.uDelta.mul(60));
      const temperatureRetention = pow(this.uCooling, this.uDelta.mul(60));
      advected.x.mulAssign(densityRetention);
      advected.y.mulAssign(temperatureRetention);

      const sourceBrush = this.sourceBrushSample(fieldUv);
      const fireSource = max(this.emitterMask(fieldUv).mul(0.3), sourceBrush.x);
      const groundSource = this.groundStampSample(fieldUv);
      const source = mix(fireSource, groundSource.x, this.uGroundFlow);
      // Ground sources replenish gradually: a per-frame minimum instantly erases cuts.
      // The original fire source keeps its immediate injection behavior.
      const refill = mix(float(1),float(1).sub(exp(this.uDelta.mul(-1.4))),this.uGroundFlow);
      // Ambient mist is a slow floor with a world-anchored ripple, so a bare field reads as
      // drifting banks rather than a flat sheet.
      const ambientRipple = fieldUv.x.mul(23).add(fieldUv.y.mul(17)).add(this.uTime.mul(0.21)).sin()
        .mul(fieldUv.y.mul(29).sub(fieldUv.x.mul(11)).sub(this.uTime.mul(0.17)).sin()).mul(0.3).add(0.7);
      const ambient = this.uAmbientDensity.mul(ambientRipple).mul(this.uGroundFlow);
      // ~0.8 s time constant: weather mist should read within a couple of seconds of the change.
      const ambientBlend = float(1).sub(exp(this.uDelta.mul(-1.2)));
      const densityTarget = max(source.mul(this.uInjectionDensity), ambient);
      advected.x.assign(mix(advected.x,max(advected.x, densityTarget),refill));
      advected.x.assign(mix(advected.x, max(advected.x, ambient), ambientBlend.mul(this.uGroundFlow)));
      const groundHeat = max(groundSource.w, this.uAmbientHeat.mul(ambientRipple));
      const heatTarget = mix(source.mul(this.uInjectionTemperature), max(source.mul(this.uInjectionTemperature), groundHeat.mul(source.add(ambient).min(1))), this.uGroundFlow);
      advected.y.assign(mix(advected.y,max(advected.y, heatTarget),refill));

      If(this.groundObstacleMask(fieldUv).greaterThan(0.5), () => {
        advected.assign(vec2(0));
      });

      If(this.isBoundary(x, y), () => {
        advected.assign(vec2(0));
      });

      textureStore(scalarWrite, indexUv, vec4(advected, 0, 1)).toWriteOnly();
    });
    return kernel().compute(this.resolution * this.resolution).setName(name);
  }

  /** Move existing mist out of a blade stroke with conservative donor-cell transfers.
   * A divergence-free velocity alone cannot carve a gap through uniform density.
   * No density is deleted; each outgoing amount is gathered by its neighbour. */
  private buildSlashTransport(read:THREE.StorageTexture,write:THREE.StorageTexture):ComputeNode {
    return Fn(()=>{
      const {x,y,indexUv,fieldUv}=this.coordinates();
      const open=(at:TSLNode):TSLNode=>at.x.greaterThan(0).and(at.x.lessThan(1)).and(at.y.greaterThan(0)).and(at.y.lessThan(1))
        .and(this.groundObstacleMask(at).lessThanEqual(0.5)).select(float(1),float(0));
      const fractions=(at:TSLNode):TSLNode=>{
        const velocity=this.groundBlastForce(at,true).toVar();
        const transfer=vec4(velocity.x.max(0),velocity.x.negate().max(0),velocity.y.max(0),velocity.y.negate().max(0))
          .mul(this.slashDelta).mul(open(at))
          .mul(vec4(open(at.add(vec2(1/this.resolution,0))),open(at.sub(vec2(1/this.resolution,0))),open(at.add(vec2(0,1/this.resolution))),open(at.sub(vec2(0,1/this.resolution))))).toVar();
        return transfer.div(transfer.x.add(transfer.y).add(transfer.z).add(transfer.w).div(0.8).max(1));
      };
      const outgoing=fractions(fieldUv).toVar();
      const remaining=float(1).sub(outgoing.x.add(outgoing.y).add(outgoing.z).add(outgoing.w));
      const result=this.texel(read,x,y).rg.mul(remaining).toVar();
      for(const [dx,dy,channel] of [[-1,0,'x'],[1,0,'y'],[0,-1,'z'],[0,1,'w']] as const) {
        const incoming=fractions(fieldUv.add(vec2(dx/this.resolution,dy/this.resolution)));
        result.addAssign(this.texel(read,x,y,dx,dy).rg.mul(incoming[channel]));
      }
      textureStore(write,indexUv,vec4(result,0,1)).toWriteOnly();
    })().compute(this.resolution*this.resolution).setName('Conservative sword mist displacement');
  }

  private buildParticleInitialization(): ComputeNode {
    const kernel = Fn(() => {
      const positionAge = this.positionAge.element(instanceIndex);
      const velocityLife = this.velocityLife.element(instanceIndex);
      const visual = this.visual.element(instanceIndex);
      const randomA = hash(instanceIndex.add(uint(11)));
      const randomB = hash(instanceIndex.add(uint(29)));
      const randomC = hash(instanceIndex.add(uint(53)));
      const randomD = hash(instanceIndex.add(uint(97)));
      const life = randomD.mul(5).add(6);
      const heightFraction = pow(randomB, 0.72).mul(0.82);
      const spread = float(0.14).add(heightFraction.mul(1.25));
      const brushIndex = uint(randomD.mul(SOURCE_BRUSH_COUNT));
      const sourceBrush = this.sourceBrushes.element(brushIndex);
      const emitterX = sourceBrush.x.sub(0.5).mul(this.width);
      const emitterY = sourceBrush.y.mul(this.height);

      positionAge.assign(
        vec4(
          emitterX.add(randomA.sub(0.5).mul(spread)),
          emitterY.add(heightFraction.mul(this.height)),
          randomC.sub(0.5).mul(1.4),
          randomB.mul(life),
        ),
      );
      velocityLife.assign(vec4(randomA.sub(0.5).mul(0.18), 0.45, randomC.sub(0.5).mul(0.08), life));
      visual.assign(
        vec4(
          randomA.mul(0.085).add(0.075),
          randomC,
          float(1).sub(heightFraction),
          float(1).sub(heightFraction).mul(0.8),
        ),
      );
    });
    return kernel().compute(this.particleCount).setName('Initialize particles');
  }

  private buildParticleUpdate(
    velocityField: THREE.StorageTexture,
    scalarField: THREE.StorageTexture,
    name: string,
  ): ComputeNode {
    const kernel = Fn(() => {
      const positionAge = this.positionAge.element(instanceIndex);
      const velocityLife = this.velocityLife.element(instanceIndex);
      const visual = this.visual.element(instanceIndex);
      const fieldUv = vec2(
        positionAge.x.div(this.width).add(0.5),
        positionAge.y.div(this.height),
      );
      const fluidVelocity = this.sampleBilinear(velocityField, fieldUv).xy;
      const scalar = this.sampleBilinear(scalarField, fieldUv);
      const carriedHeat = max(scalar.g, visual.z.mul(exp(this.uDelta.mul(-1.05))));
      const carriedDensity = max(scalar.r, visual.w.mul(exp(this.uDelta.mul(-0.09))));
      const turbulencePhase = visual.y
        .mul(47)
        .add(this.uTime.mul(1.25))
        .add(positionAge.y.mul(2.2));
      const smokeTurbulence = float(0.35).add(
        float(1).sub(smoothstep(0.45, 1, carriedHeat)).mul(0.65),
      );
      const lateralVelocity = sin(turbulencePhase)
        .mul(carriedDensity)
        .mul(smokeTurbulence)
        .mul(0.24);
      const zVelocity: TSLNode = sin(turbulencePhase.mul(1.37).add(2.1))
        .mul(carriedDensity)
        .mul(0.14);
      const targetVelocity = vec3(
        fluidVelocity.x
          .mul(this.width / this.resolution)
          .add(lateralVelocity),
        fluidVelocity.y
          .mul(this.height / this.resolution)
          .add(carriedHeat.mul(0.58))
          .add(carriedDensity.mul(0.62)),
        zVelocity,
      );
      const coupling = float(1).sub(exp(this.uDelta.mul(-7.5)));
      velocityLife.xyz.assign(mix(velocityLife.xyz, targetVelocity, coupling));
      positionAge.xyz.addAssign(velocityLife.xyz.mul(this.uDelta));
      positionAge.w.addAssign(this.uDelta);
      visual.z.assign(carriedHeat);
      visual.w.assign(carriedDensity);

      const normalizedAge = positionAge.w.div(velocityLife.w);
      const outside = fieldUv.x
        .lessThan(-0.05)
        .or(fieldUv.x.greaterThan(1.05))
        .or(fieldUv.y.lessThan(-0.02))
        .or(fieldUv.y.greaterThan(1.08));
      const dead = normalizedAge.greaterThanEqual(1).or(outside);

      If(dead, () => {
        const cycle = uint(this.uFrame).mul(uint(131));
        const randomA = hash(instanceIndex.add(cycle).add(uint(7)));
        const randomB = hash(instanceIndex.add(cycle).add(uint(43)));
        const randomC = hash(instanceIndex.add(cycle).add(uint(89)));
        const randomD = hash(instanceIndex.add(cycle).add(uint(149)));
        const brushIndex = uint(randomD.mul(SOURCE_BRUSH_COUNT));
        const sourceBrush = this.sourceBrushes.element(brushIndex);
        const emitterX = sourceBrush.x.sub(0.5).mul(this.width);
        const emitterY = sourceBrush.y.mul(this.height);
        const radius = this.uInjectionRadius.mul(this.width).mul(0.72);
        const life = randomD.mul(5).add(6);

        positionAge.assign(
          vec4(
            emitterX.add(randomA.sub(0.5).mul(radius)),
            emitterY.add(randomB.mul(radius).mul(0.35)),
            randomC.sub(0.5).mul(1.25),
            0,
          ),
        );
        velocityLife.assign(
          vec4(
            randomA.sub(0.5).mul(0.14),
            randomB.mul(0.28).add(0.32),
            randomC.sub(0.5).mul(0.08),
            life,
          ),
        );
        visual.assign(vec4(randomA.mul(0.085).add(0.075), randomC, 1, 1));
      });
    });
    return kernel().compute(this.particleCount).setName(name);
  }

  private makeParticles(): THREE.Sprite {
    const position = this.positionAge.toAttribute();
    const positionState = this.positionAge.element(instanceIndex);
    const velocityState = this.velocityLife.element(instanceIndex);
    const visualState = this.visual.element(instanceIndex);
    const normalizedAge = positionState.w.div(velocityState.w).clamp(0, 1);
    const heat = visualState.z.clamp(0, 1.4);
    const density = visualState.w.clamp(0, 1);
    const fire = smoothstep(0.68, 0.98, heat).mul(float(1).sub(smoothstep(0.12, 0.38, normalizedAge)));
    const renderFraction = this.uRenderFraction.clamp(0.15, 1);
    const keepChance = mix(renderFraction, float(1), fire);
    const renderGate = visualState.y.lessThan(keepChance).select(1, 0);
    const smokeColor = mix(vec3(0.055, 0.065, 0.075), vec3(0.1, 0.065, 0.04), heat.mul(0.12));
    const smokeShade = visualState.y.mul(0.38).add(0.72);
    const flameColor = mix(vec3(1.8, 0.12, 0.015), vec3(4.5, 1.3, 0.12), smoothstep(0.45, 1.15, heat));
    const fadeIn = smoothstep(0, 0.055, normalizedAge);
    const fadeOut = float(1).sub(smoothstep(0.88, 1, normalizedAge));
    const spriteUv = uv();
    const tileIndex = visualState.y.mul(15.999).floor();
    const atlasUv = spriteUv
      .mul(0.92)
      .add(0.04)
      .add(vec2(tileIndex.mod(4), tileIndex.div(4).floor()))
      .div(4);
    const cloudShape = texture(this.particleAtlas, atlasUv).r;
    const opacityCompensation = pow(keepChance, -0.12);
    const smokeOpacity = density.mul(0.035).add(fire.mul(0.18)).mul(opacityCompensation);
    const depthSeparation = viewportLinearDepth
      .sub(linearDepth())
      .mul(cameraFar.sub(cameraNear))
      .max(0);
    const softIntersection = smoothstep(0, this.uSoftDepthDistance.max(0.001), depthSeparation);
    const size = visualState.x
      .mul(this.uParticleSize.div(0.115))
      .mul(float(0.7).add(normalizedAge.mul(2.1)));

    const material = new THREE.SpriteNodeMaterial();
    material.positionNode = position.xyz;
    material.scaleNode = vec2(
      size.mul(0.82).mul(renderGate),
      size.mul(float(1).add(normalizedAge.mul(0.75))).mul(renderGate),
    );
    material.colorNode = mix(smokeColor.mul(smokeShade), flameColor, fire);
    material.opacityNode = cloudShape
      .mul(smokeOpacity)
      .mul(fadeIn)
      .mul(fadeOut)
      .mul(softIntersection);
    material.alphaTestNode = float(0.004);
    material.transparent = true;
    material.depthWrite = false;
    material.depthTest = true;
    material.alphaToCoverage = true;
    material.blending = THREE.NormalBlending;

    const sprite = new THREE.Sprite(material);
    (sprite as THREE.Sprite & { count: number }).count = this.particleCount;
    sprite.name = `${this.particleCount.toLocaleString()} GPU particles`;
    sprite.frustumCulled = false;
    sprite.renderOrder = 2;
    this.group.add(sprite);
    return sprite;
  }

  private makeDebugPlane(fieldTexture: THREE.StorageTexture): THREE.Mesh {
    const sampled = texture(fieldTexture);
    const densityColor = vec3(0.13, 0.17, 0.2).mul(sampled.r.mul(1.6));
    const heatColor = vec3(2.2, 0.28, 0.015).mul(sampled.g.mul(0.75));
    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = densityColor.add(heatColor);
    material.opacityNode = sampled.r.max(sampled.g).mul(0.88).add(0.08);
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;

    const plane = new THREE.Mesh(new THREE.PlaneGeometry(this.width * 0.36, this.height * 0.36), material);
    plane.name = 'Density / temperature debug field';
    plane.position.set(-this.width * 0.78, this.height * 0.7, -0.65);
    plane.visible = false;
    plane.renderOrder = 1;
    this.group.add(plane);
    return plane;
  }

  private makeFogSlices(fieldTexture: THREE.StorageTexture): THREE.InstancedMesh {
    const sampled = texture(fieldTexture);
    const density = sampled.r.clamp(0, 2);
    const temperature = sampled.g.clamp(0, 1.4);
    // Beer-Lambert extinction is reduced to scalar coverage for alpha blending.
    // The RGB extinction coefficients still make a colored absorber visibly
    // denser while the scattering tint remains an independent control.
    const extinction = this.uFogAbsorptionColor
      .r.add(this.uFogAbsorptionColor.g)
      .add(this.uFogAbsorptionColor.b)
      .mul(1 / 3)
      .mul(density)
      .mul(this.uFogDensity)
      .mul(this.uFogDepth)
      .mul(-1 / FOG_SLICE_COUNT);
    const sliceOpacity = float(1).sub(exp(extinction));
    const depthSeparation = viewportLinearDepth
      .sub(linearDepth())
      .mul(cameraFar.sub(cameraNear))
      .max(0);
    const softIntersection = smoothstep(0, this.uSoftDepthDistance.max(0.001), depthSeparation);
    const fogColor = mix(
      this.uFogScatteringColor.mul(0.55),
      vec3(0.12, 0.055, 0.022),
      smoothstep(0.3, 1.15, temperature).mul(0.24),
    );

    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = fogColor;
    material.opacityNode = sliceOpacity.mul(softIntersection);
    material.alphaTestNode = float(0.001);
    material.transparent = true;
    material.depthWrite = false;
    material.depthTest = true;
    material.side = THREE.DoubleSide;
    material.blending = THREE.NormalBlending;

    const geometry = new THREE.PlaneGeometry(this.width, this.height);
    const volume = new THREE.InstancedMesh(geometry, material, FOG_SLICE_COUNT);
    const transform = new THREE.Matrix4();
    for (let index = 0; index < FOG_SLICE_COUNT; index += 1) {
      const depth = (index + 0.5) / FOG_SLICE_COUNT - 0.5;
      transform.makeTranslation(0, this.height * 0.5, depth);
      volume.setMatrixAt(index, transform);
    }
    volume.instanceMatrix.needsUpdate = true;
    volume.scale.z = this.parameters.fogDepth;
    volume.name = `${FOG_SLICE_COUNT}-slice density fog`;
    volume.visible = false;
    volume.frustumCulled = false;
    volume.renderOrder = 1;
    this.group.add(volume);
    return volume;
  }

  /**
   * A single proxy plane with an unrolled, short ray march. The source field is
   * 2D, so depth offsets deliberately introduce only a small plume-scale
   * parallax; this is a quality/cost comparison, not a second volume solver.
   */
  private makeFogRaymarch(fieldTexture: THREE.StorageTexture): THREE.Mesh {
    const fieldUv = uv();
    let integratedDensity: TSLNode = float(0);
    let integratedTemperature: TSLNode = float(0);

    for (let index = 0; index < FOG_RAYMARCH_STEP_COUNT; index += 1) {
      const depth = (index + 0.5) / FOG_RAYMARCH_STEP_COUNT - 0.5;
      const parallaxUv = fieldUv.add(vec2(depth * 0.028, depth * -0.014)).clamp(0, 1);
      const sample = texture(fieldTexture, parallaxUv);
      integratedDensity = integratedDensity.add(sample.r.clamp(0, 2));
      integratedTemperature = integratedTemperature.add(sample.g.clamp(0, 1.4));
    }

    const averageDensity = integratedDensity.div(FOG_RAYMARCH_STEP_COUNT);
    const averageTemperature = integratedTemperature.div(FOG_RAYMARCH_STEP_COUNT);
    const extinction = this.uFogAbsorptionColor
      .r.add(this.uFogAbsorptionColor.g)
      .add(this.uFogAbsorptionColor.b)
      .mul(1 / 3)
      .mul(averageDensity)
      .mul(this.uFogDensity)
      .mul(this.uFogDepth)
      .negate();
    const opacity = float(1).sub(exp(extinction));
    const depthSeparation = viewportLinearDepth
      .sub(linearDepth())
      .mul(cameraFar.sub(cameraNear))
      .max(0);
    const softIntersection = smoothstep(0, this.uSoftDepthDistance.max(0.001), depthSeparation);
    const fogColor = mix(
      this.uFogScatteringColor.mul(0.55),
      vec3(0.12, 0.055, 0.022),
      smoothstep(0.3, 1.15, averageTemperature).mul(0.24),
    );

    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = fogColor;
    material.opacityNode = opacity.mul(softIntersection);
    material.alphaTestNode = float(0.001);
    material.transparent = true;
    material.depthWrite = false;
    material.depthTest = true;
    material.side = THREE.DoubleSide;
    material.blending = THREE.NormalBlending;

    const raymarch = new THREE.Mesh(new THREE.PlaneGeometry(this.width, this.height), material);
    raymarch.position.set(0, this.height * 0.5, 0);
    raymarch.name = `${FOG_RAYMARCH_STEP_COUNT}-step density fog ray march`;
    raymarch.visible = false;
    raymarch.frustumCulled = false;
    raymarch.renderOrder = 1;
    this.group.add(raymarch);
    return raymarch;
  }

  private makeSceneDecor(): void {
    const baseMaterial = new THREE.MeshBasicMaterial({ color: 0x1b110d });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.46, 0.12, 32), baseMaterial);
    base.position.set(0, 0.02, -0.12);
    this.group.add(base);

    const outlineMaterial = new THREE.LineBasicMaterial({ color: 0x28323b, transparent: true, opacity: 0.32 });
    const points = [
      new THREE.Vector3(-this.width / 2, 0, -0.5),
      new THREE.Vector3(this.width / 2, 0, -0.5),
      new THREE.Vector3(this.width / 2, this.height, -0.5),
      new THREE.Vector3(-this.width / 2, this.height, -0.5),
      new THREE.Vector3(-this.width / 2, 0, -0.5),
    ];
    const outline = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), outlineMaterial);
    outline.name = '2D simulation bounds';
    this.group.add(outline);
  }
}

