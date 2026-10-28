import * as THREE from 'three/webgpu';
import {
  Fn,
  Loop,
  cameraFar,
  cameraNear,
  cameraPosition,
  cameraViewMatrix,
  exp,
  float,
  mix,
  positionWorld,
  screenCoordinate,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
  viewportLinearDepth,
} from 'three/tsl';
import { FluidFire, type FluidBounds } from './FluidFire';
import { SimulationWindow } from './SimulationWindow';
import { flatTerrain, type TerrainHeight } from './TerrainHeight';

export interface GroundMistOptions {
  /** Field texture resolution (square). 128 is plenty for a 16 m arena. */
  resolution?: number;
  /** World X extent of the simulated rectangle, metres. */
  width?: number;
  /** World Z extent of the simulated rectangle, metres. */
  depth?: number;
  /** Mist ceiling above the terrain, metres. */
  height?: number;
  /** Mist floor above the terrain, metres. */
  baseHeight?: number;
  /** Initial world centre of the window. */
  center?: THREE.Vector2 | THREE.Vector3;
  /** Matching CPU/GPU terrain samplers; flat when omitted. */
  terrain?: TerrainHeight;
  /** Hard world-space edge for the mist (a room, an arena floor); the window edge otherwise. */
  bounds?: FluidBounds;
  /** Jacobi iterations per step. Lower is cheaper and a little more compressible. */
  pressureIterations?: number;
  /** Density dissipation per 60 Hz step (0.995 = lingering, 0.98 = quick fade). */
  dissipation?: number;
  /** Vorticity confinement strength. */
  vorticity?: number;
  /** Ray-march steps per pixel. */
  steps?: 24 | 48 | 96;
  /** Scroll the window with follow(); off for a fixed arena. */
  scrolling?: boolean;
}

export interface MistEmitOptions {
  /** World velocity the stamp imparts, m/s. */
  velocity?: THREE.Vector3;
  /** 0..2 heat written to the temperature channel: renders with the hot palette colour. */
  heat?: number;
  /** Seconds the stamp stays active; omit for a persistent source you clear yourself. */
  duration?: number;
}

type Slot = { ttl: number; key: string | null };

const STAMP_SLOTS = 8;
const BLAST_SLOTS = 5;
const MOVER_SLOTS = 4;
const OBSTACLE_SLOTS = 4;

/**
 * Host-facing ground mist: a bounded, player- or arena-centred 2D fluid field rendered as a
 * shallow ray-marched volume. World units everywhere; the class owns slot allocation and
 * lifetimes, so a host only reports what happened (a blast here, an actor moving there,
 * wind from the east) and never touches texture coordinates.
 *
 * Requires a WebGPU backend: the solver is compute shaders. Check `GroundMist.isSupported`
 * before constructing one on a renderer that may have fallen back to WebGL2.
 */
export class GroundMist {
  readonly group = new THREE.Group();
  readonly solver: FluidFire;
  readonly window: SimulationWindow;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly baseHeight: number;

  private readonly terrain: TerrainHeight;
  private readonly volumes: [THREE.Mesh, THREE.Mesh];
  private readonly worldCenter = uniform(new THREE.Vector2());
  private readonly boundsMin = uniform(new THREE.Vector2(-1e6, -1e6));
  private readonly boundsMax = uniform(new THREE.Vector2(1e6, 1e6));
  private readonly fogSteps = uniform(48, 'int');
  private readonly fogJitter = uniform(1);
  private readonly lightColor = uniform(new THREE.Color(0.55, 0.65, 0.8));
  private readonly ambientColor = uniform(new THREE.Color(0.05, 0.07, 0.11));
  private readonly lightUvDirection = uniform(new THREE.Vector2(-0.42, 0.34));
  private readonly baseTint = uniform(new THREE.Color(1, 1, 1));
  private readonly hotTint = uniform(new THREE.Color(1, 0.6, 0.3));
  private readonly densityEdge = uniform(new THREE.Vector2(0.035, 0.22));
  private readonly opticalDepthScale = uniform(4.2);
  private readonly opacityScale = uniform(1);
  private readonly heightLobes = uniform(0.22);
  private readonly pointLights = Array.from({ length: 3 }, () => ({
    positionRange: uniform(new THREE.Vector4(0, 0, 0, 1)),
    radiance: uniform(new THREE.Color(0, 0, 0)),
  }));
  private readonly stamps: Slot[] = Array.from({ length: STAMP_SLOTS }, () => ({ ttl: 0, key: null }));
  private readonly blasts: Slot[] = Array.from({ length: BLAST_SLOTS }, () => ({ ttl: 0, key: null }));
  private readonly movers = new Map<string, number>();
  private readonly obstacles = new Map<string, number>();
  private readonly scrolling: boolean;
  private readonly uv = new THREE.Vector2();
  private readonly cells = new THREE.Vector2();
  private readonly scratch = new THREE.Vector3();
  private readonly sceneProxy = new THREE.Scene();
  private _visible = true;

  /** True when the renderer runs on the WebGPU backend, which the compute solver needs. */
  static isSupported(renderer: THREE.WebGPURenderer): boolean {
    const backend = (renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend;
    return !!backend?.isWebGPUBackend;
  }

  constructor(renderer: THREE.WebGPURenderer, options: GroundMistOptions = {}) {
    this.width = options.width ?? 16;
    this.depth = options.depth ?? 16;
    this.height = options.height ?? 0.9;
    this.baseHeight = options.baseHeight ?? 0.02;
    this.terrain = options.terrain ?? flatTerrain;
    this.scrolling = options.scrolling ?? false;
    const resolution = options.resolution ?? 128;
    // The solver keeps its own group in a throwaway scene: its benchmark visuals are off and
    // this class renders the fields itself.
    this.solver = new FluidFire(this.sceneProxy, renderer, {
      resolution,
      particleCount: 1,
      width: this.width,
      height: this.depth,
      visuals: false,
      bounds: options.bounds,
    });
    const p = this.solver.parameters;
    p.buoyancy = 0;
    p.vorticity = options.vorticity ?? 6;
    p.dissipation = options.dissipation ?? 0.995;
    p.cooling = 0.99;
    p.injectionRadius = 0.08;
    p.injectionDensity = 1.2;
    p.injectionTemperature = 0;
    p.velocityStrength = 0;
    p.pressureIterations = options.pressureIterations ?? 12;
    p.groundFlow = true;
    p.dynamicFog = false;
    p.groundVolume = true;
    const center = options.center ? new THREE.Vector2(options.center.x, 'z' in options.center ? options.center.z : options.center.y) : new THREE.Vector2();
    this.window = new SimulationWindow({ width: this.width, depth: this.depth, resolution, lookAhead: 0, recenterFraction: 0.2 }, center);
    if (options.bounds) {
      this.boundsMin.value.set(options.bounds.minX, options.bounds.minZ);
      this.boundsMax.value.set(options.bounds.maxX, options.bounds.maxZ);
      this.solver.setRoomBounds(true, this.window.getCenter());
    }
    this.fogSteps.value = options.steps ?? 48;
    const [s0, s1] = this.solver.scalarFields;
    this.volumes = [this.makeVolume(s0), this.makeVolume(s1)];
    this.group.name = 'ninja3js ground mist';
    this.placeGroup();
    this.sync();
  }

  get visible(): boolean {
    return this._visible;
  }

  set visible(on: boolean) {
    this._visible = on;
    this.sync();
  }

  /** World centre of the simulated rectangle. */
  get center(): THREE.Vector2 {
    return this.window.getCenter();
  }

  /**
   * Moves the window to follow a position (a player, the camera focus). With `scrolling` on,
   * the fields scroll in whole cells and keep their contents; off, the call is ignored.
   */
  follow(position: THREE.Vector3): void {
    if (!this.scrolling) return;
    const shift = this.window.update(position);
    if (shift) this.solver.scrollFields(shift.cells);
    this.placeGroup();
  }

  /** Baseline mist the whole field relaxes toward (0 = none, 0.5 = a soft blanket, 1 = thick). */
  setAmbient(density: number, heat = 0): void {
    this.solver.setAmbientDensity(density, heat);
  }

  /** Cool and hot mist colours; the temperature channel blends between them. */
  setPalette(base: THREE.ColorRepresentation, hot: THREE.ColorRepresentation = base): void {
    this.baseTint.value.set(base);
    this.hotTint.value.set(hot);
  }

  /** Overall thickness and the density threshold that shapes the visible edge. */
  setLook(opts: { opacity?: number; opticalDepth?: number; edge?: [number, number]; lobes?: number; dither?: boolean; steps?: 24 | 48 | 96 }): void {
    if (opts.opacity !== undefined) this.opacityScale.value = opts.opacity;
    if (opts.opticalDepth !== undefined) this.opticalDepthScale.value = opts.opticalDepth;
    if (opts.edge) this.densityEdge.value.set(opts.edge[0], opts.edge[1]);
    if (opts.lobes !== undefined) this.heightLobes.value = opts.lobes;
    if (opts.dither !== undefined) this.fogJitter.value = opts.dither ? 1 : 0;
    if (opts.steps !== undefined) this.fogSteps.value = opts.steps;
  }

  setLighting(ambient: THREE.ColorRepresentation, directional: THREE.ColorRepresentation, worldDirection?: THREE.Vector3): void {
    this.ambientColor.value.set(ambient);
    this.lightColor.value.set(directional);
    if (worldDirection && worldDirection.lengthSq() > 1e-6) {
      this.lightUvDirection.value.set(worldDirection.x / this.width, worldDirection.z / this.depth).normalize();
    }
  }

  /** Up to three local scattering lights (an impact flash, a glowing attacker). */
  setPointLight(index: number, position: THREE.Vector3, tint: THREE.ColorRepresentation, intensity: number, range: number): void {
    const light = this.pointLights[index];
    if (!light) throw new Error('GroundMist supports three local lights.');
    light.positionRange.value.set(position.x, position.y, position.z, Math.max(range, 0.01));
    light.radiance.value.set(tint).multiplyScalar(Math.max(0, intensity));
  }

  clearPointLight(index: number): void {
    this.pointLights[index]?.radiance.value.setRGB(0, 0, 0);
  }

  /** Broad world-space wind the whole field drifts toward, m/s. */
  setWind(worldVelocity: THREE.Vector3): void {
    this.solver.setGroundWind(this.cellsPerSecond(worldVelocity.x, worldVelocity.z));
  }

  /**
   * A density source at a world position. Returns the slot, which `clearEmit` releases early;
   * with `duration` the slot frees itself. Keyed emits (same key) reuse their slot.
   */
  emit(position: THREE.Vector3, radius: number, density: number, opts: MistEmitOptions = {}, key: string | null = null): number {
    const slot = this.allocate(this.stamps, key);
    const s = this.stamps[slot]!;
    s.ttl = opts.duration ?? Infinity;
    s.key = key;
    const v = opts.velocity ?? this.scratch.set(0, 0, 0);
    this.solver.setGroundStamp(slot, this.window.worldToUv(position, this.uv), radius / Math.min(this.width, this.depth), density, this.cellsPerSecond(v.x, v.z), opts.heat ?? 0);
    return slot;
  }

  clearEmit(slot: number): void {
    const s = this.stamps[slot];
    if (!s) return;
    s.ttl = 0;
    s.key = null;
    this.solver.clearGroundStamp(slot);
  }

  /** A short outward shove that displaces mist without adding any. */
  blast(position: THREE.Vector3, radius: number, outwardSpeed: number, duration = 0.25): number {
    const slot = this.allocate(this.blasts, null);
    this.blasts[slot]!.ttl = duration;
    this.solver.setGroundBlast(slot, this.window.worldToUv(position, this.uv), radius / Math.min(this.width, this.depth), (outwardSpeed * this.solver.resolution) / Math.min(this.width, this.depth));
    return slot;
  }

  /** The wake of something moving through the mist; call every frame while it moves. */
  mover(key: string, position: THREE.Vector3, velocity: THREE.Vector3, radius: number): void {
    let slot = this.movers.get(key);
    if (slot === undefined) {
      if (this.movers.size >= MOVER_SLOTS) return;
      slot = [...Array(MOVER_SLOTS).keys()].find((i) => ![...this.movers.values()].includes(i))!;
      this.movers.set(key, slot);
    }
    this.solver.setGroundMover(slot, this.window.worldToUv(position, this.uv), radius / Math.min(this.width, this.depth), this.cellsPerSecond(velocity.x, velocity.z));
  }

  clearMover(key: string): void {
    const slot = this.movers.get(key);
    if (slot === undefined) return;
    this.movers.delete(key);
    this.solver.clearGroundMover(slot);
  }

  /** A static footprint the mist flows around and never enters. */
  setObstacle(key: string, position: THREE.Vector3, radius: number): void {
    let slot = this.obstacles.get(key);
    if (slot === undefined) {
      if (this.obstacles.size >= OBSTACLE_SLOTS) return;
      slot = [...Array(OBSTACLE_SLOTS).keys()].find((i) => ![...this.obstacles.values()].includes(i))!;
      this.obstacles.set(key, slot);
    }
    this.solver.setGroundObstacle(slot, this.window.worldToUv(position, this.uv), radius / Math.min(this.width, this.depth));
  }

  clearObstacle(key: string): void {
    const slot = this.obstacles.get(key);
    if (slot === undefined) return;
    this.obstacles.delete(key);
    this.solver.clearGroundObstacle(slot);
  }

  /** Releases every stamp, blast, mover and obstacle and lets the field dissipate. */
  clearAll(): void {
    this.stamps.forEach((_, i) => this.clearEmit(i));
    this.blasts.forEach((s, i) => {
      s.ttl = 0;
      this.solver.clearGroundBlast(i);
    });
    for (const key of [...this.movers.keys()]) this.clearMover(key);
    for (const key of [...this.obstacles.keys()]) this.clearObstacle(key);
    this.setWind(this.scratch.set(0, 0, 0));
    this.setAmbient(0);
  }

  /** Advances the solver one step and selects the current field for rendering. */
  update(dt: number): void {
    for (const [i, s] of this.stamps.entries()) {
      if (s.ttl === Infinity || s.ttl <= 0) continue;
      s.ttl -= dt;
      if (s.ttl <= 0) this.clearEmit(i);
    }
    for (const [i, b] of this.blasts.entries()) {
      if (b.ttl <= 0) continue;
      b.ttl -= dt;
      if (b.ttl <= 0) this.solver.clearGroundBlast(i);
    }
    this.solver.update(dt);
    this.sync();
  }

  dispose(): void {
    this.solver.dispose();
    this.group.removeFromParent();
    for (const v of this.volumes) {
      v.geometry.dispose();
      (v.material as THREE.Material).dispose();
    }
  }

  private sync(): void {
    const index = this.solver.currentScalarFieldIndex;
    this.volumes.forEach((mesh, i) => (mesh.visible = this._visible && i === index));
  }

  private placeGroup(): void {
    const c = this.window.getCenter();
    this.worldCenter.value.copy(c);
    this.solver.setRoomBounds(this.boundsMin.value.x > -1e5, c);
    this.group.position.set(c.x, this.baseHeight, c.y);
  }

  private cellsPerSecond(x: number, z: number): THREE.Vector2 {
    return this.cells.set((x * this.solver.resolution) / this.width, (z * this.solver.resolution) / this.depth);
  }

  private allocate(slots: Slot[], key: string | null): number {
    if (key) {
      const existing = slots.findIndex((s) => s.key === key);
      if (existing >= 0) return existing;
    }
    const free = slots.findIndex((s) => s.ttl <= 0);
    if (free >= 0) return free;
    // Everything busy: evict the one closest to expiring.
    let best = 0;
    for (let i = 1; i < slots.length; i++) if (slots[i]!.ttl < slots[best]!.ttl) best = i;
    return best;
  }

  /** The ray-marched volume over one scalar field (ported from GroundFlowVolume's fog). */
  private makeVolume(fieldTexture: THREE.StorageTexture): THREE.Mesh {
    const [terrainMin, terrainMax] = this.terrain.bounds ?? [-4, 4];
    const bottom = terrainMin + this.baseHeight;
    const top = terrainMax + this.baseHeight + this.height;
    const material = new THREE.MeshBasicNodeMaterial();
    material.fragmentNode = Fn(() => {
      const direction: any = positionWorld.sub(cameraPosition).normalize();
      const safe = (value: any): any => value.greaterThanEqual(0).select(value.max(0.00001), value.min(-0.00001));
      const inverse = vec3(1).div(vec3(safe(direction.x), safe(direction.y), safe(direction.z)));
      const boundsMin = vec3(this.worldCenter.x.sub(this.width / 2), bottom, this.worldCenter.y.sub(this.depth / 2));
      const boundsMax = vec3(this.worldCenter.x.add(this.width / 2), top, this.worldCenter.y.add(this.depth / 2));
      const slabA = boundsMin.sub(cameraPosition).mul(inverse);
      const slabB = boundsMax.sub(cameraPosition).mul(inverse);
      const near = slabA.min(slabB);
      const far = slabA.max(slabB);
      const start = near.x.max(near.y).max(near.z).max(0);
      const viewDirection = cameraViewMatrix.mul(vec4(direction, 0)).xyz;
      const opaqueDistance = viewportLinearDepth.mul(cameraFar.sub(cameraNear)).add(cameraNear).div(viewDirection.z.negate().max(0.0001));
      const end = far.x.min(far.y).min(far.z).min(opaqueDistance);
      const step = end.sub(start).max(0).div(float(this.fogSteps));
      const transmittance = float(1).toVar();
      const radiance = vec3(0).toVar();
      const noise = screenCoordinate.xy.dot(vec2(0.06711056, 0.00583715)).fract().mul(52.9829189).fract();
      const offset = mix(float(0.5), noise.mul(0.9).add(0.05), this.fogJitter);
      Loop({ start: 0, end: this.fogSteps, type: 'int' }, ({ i }: any) => {
        const point = cameraPosition.add(direction.mul(start.add(step.mul(float(i).add(offset)))));
        const fieldUv = point.xz.sub(this.worldCenter).div(vec2(this.width, this.depth)).add(0.5);
        const sample = texture(fieldTexture, fieldUv.clamp(0, 1)).level(float(0));
        const height = point.y.sub(this.terrain.node(point.xz)).sub(this.baseHeight);
        const lobe = point.x.mul(0.83).add(point.z.mul(0.37)).sin().mul(point.z.mul(1.07).sub(point.x.mul(0.21)).sin());
        const localHeight = lobe.mul(this.heightLobes).add(float(1).sub(this.heightLobes)).mul(this.height);
        const heightProfile = smoothstep(0, 0.06, height).mul(float(1).sub(smoothstep(0.05, localHeight, height)));
        const edge = fieldUv.min(float(1).sub(fieldUv));
        const insideBounds = point.x.greaterThanEqual(this.boundsMin.x).and(point.x.lessThanEqual(this.boundsMax.x)).and(point.z.greaterThanEqual(this.boundsMin.y)).and(point.z.lessThanEqual(this.boundsMax.y)).select(float(1), float(0));
        const domain = smoothstep(0, 0.07, edge.x.min(edge.y)).mul(insideBounds);
        const breakup = point.x.mul(2.3).add(point.y.mul(4.1)).sin().mul(point.z.mul(2.7).sub(point.y.mul(2.2)).sin()).mul(0.18).add(0.82);
        const density = sample.r.clamp(0, 1.6).mul(smoothstep(this.densityEdge.x, this.densityEdge.y, sample.r)).mul(heightProfile).mul(domain).mul(breakup);
        const alpha = float(1).sub(exp(density.mul(step).mul(this.opticalDepthScale).mul(-0.62))).mul(this.opacityScale).clamp(0, 1);
        const blocker = texture(fieldTexture, fieldUv.add(this.lightUvDirection.mul(0.045)).clamp(0, 1)).level(float(0)).r;
        const tint = mix(this.baseTint, this.hotTint, smoothstep(0.04, 0.5, sample.g));
        const lighting = mix(this.ambientColor, this.lightColor, exp(blocker.mul(-1.1)).mul(0.65).add(0.2)).mul(tint).toVar();
        for (const light of this.pointLights) {
          const delta = light.positionRange.xyz.sub(point);
          const dist = delta.length();
          const rangeFalloff = float(1).sub(smoothstep(0, light.positionRange.w, dist));
          const attenuation = rangeFalloff.mul(rangeFalloff).div(dist.mul(dist).add(0.35));
          const towardEye = delta.div(dist.max(0.001)).dot(direction.negate()).max(0);
          const phase = towardEye.mul(towardEye).mul(0.35).add(0.65);
          lighting.addAssign(light.radiance.mul(attenuation).mul(phase));
        }
        radiance.addAssign(lighting.mul(alpha).mul(transmittance));
        transmittance.mulAssign(float(1).sub(alpha));
      });
      const opacity = float(1).sub(transmittance);
      return vec4(radiance.div(opacity.max(0.0001)), opacity);
    })();
    material.transparent = true;
    material.depthWrite = false;
    material.depthTest = false;
    material.side = THREE.BackSide;
    const volume = new THREE.Mesh(new THREE.BoxGeometry(this.width, top - bottom, this.depth), material);
    volume.position.y = (top + bottom) / 2 - this.baseHeight;
    volume.frustumCulled = false;
    volume.renderOrder = 4;
    volume.name = 'Ground mist volume';
    this.group.add(volume);
    return volume;
  }
}
