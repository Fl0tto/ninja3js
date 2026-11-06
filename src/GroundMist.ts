import * as THREE from 'three/webgpu';
import { Fn, cameraFar, cameraNear, cameraPosition, cameraViewMatrix, positionWorld, texture, vec4, viewportLinearDepth } from 'three/tsl';
import { FluidFire, GROUND_VORTEX_COUNT, type FluidBounds } from './FluidFire';
import { createMistFrame, mistMarch, setMistFrameWindow, type MistFrame } from './MistMarch';
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
  /**
   * false builds no volume meshes: the host draws the fields itself through `frame`,
   * `densityNode` and `mistMarch` (a renderer with its own depth buffer, a deferred look pass).
   * `group` stays empty and `visible` has no effect.
   */
  render?: boolean;
  /** Wake slots for moving actors (1..12, default 4). Each costs a little shader time whether used or not. */
  movers?: number;
  /** Static obstacle slots (1..12, default 4). */
  obstacles?: number;
  /**
   * A host-owned frame to write into instead of a new one, so a program the host compiled against
   * it keeps serving when windows are rebuilt (a dungeon's room, then the overworld's scrolling window).
   * Its terrain is used in place of `terrain`.
   */
  frame?: MistFrame;
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
  /** The march's live uniforms: a host compositing the mist itself reads them (see MistMarch). */
  readonly frame: MistFrame;
  /** The current density/heat field as a texture node; re-pointed every update(), never rebuilt. */
  readonly densityNode: ReturnType<typeof texture>;
  /** The current velocity field (RG cells per second, V = +Z) as a texture node, re-pointed every update(). */
  readonly velocityNode: ReturnType<typeof texture>;

  private readonly volumes: [THREE.Mesh, THREE.Mesh] | null;
  private readonly stamps: Slot[] = Array.from({ length: STAMP_SLOTS }, () => ({ ttl: 0, key: null }));
  private readonly blasts: Slot[] = Array.from({ length: BLAST_SLOTS }, () => ({ ttl: 0, key: null }));
  private readonly vortices: Slot[] = Array.from({ length: GROUND_VORTEX_COUNT }, () => ({ ttl: 0, key: null }));
  private readonly movers = new Map<string, number>();
  private readonly obstacles = new Map<string, number>();
  private readonly scrolling: boolean;
  private readonly uv = new THREE.Vector2();
  private readonly cells = new THREE.Vector2();
  private readonly forward = new THREE.Vector2();
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
      moverSlots: options.movers,
      obstacleSlots: options.obstacles,
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
    this.frame = options.frame ?? createMistFrame({ terrain: options.terrain ?? flatTerrain });
    setMistFrameWindow(this.frame, { width: this.width, depth: this.depth, resolution, baseHeight: this.baseHeight, height: this.height });
    if (options.bounds) {
      this.frame.boundsMin.value.set(options.bounds.minX, options.bounds.minZ);
      this.frame.boundsMax.value.set(options.bounds.maxX, options.bounds.maxZ);
      this.solver.setRoomBounds(true, this.window.getCenter());
    } else {
      this.frame.boundsMin.value.set(-1e6, -1e6);
      this.frame.boundsMax.value.set(1e6, 1e6);
    }
    this.frame.steps.value = options.steps ?? 48;
    const [s0, s1] = this.solver.scalarFields;
    const [v0] = this.solver.velocityFields;
    this.densityNode = texture(s0);
    this.velocityNode = texture(v0);
    this.volumes = (options.render ?? true) ? [this.makeVolume(s0), this.makeVolume(s1)] : null;
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

  /** How many wake slots the solver was built with. */
  get moverSlots(): number {
    return this.solver.moverSlots;
  }

  /** How many obstacle slots the solver was built with. */
  get obstacleSlots(): number {
    return this.solver.obstacleSlots;
  }

  /** World centre of the simulated rectangle. */
  get center(): THREE.Vector2 {
    return this.window.getCenter();
  }

  /** The current density/heat field texture (R density, G heat); changes every update(). */
  get densityTexture(): THREE.StorageTexture {
    return this.solver.scalarFields[this.solver.currentScalarFieldIndex]!;
  }

  /** The current velocity field texture (RG cells per second, V = +Z); changes every update(). */
  get velocityTexture(): THREE.StorageTexture {
    return this.solver.velocityFields[this.solver.currentVelocityFieldIndex]!;
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
    this.frame.baseTint.value.set(base);
    this.frame.hotTint.value.set(hot);
  }

  /** Overall thickness and the density threshold that shapes the visible edge. */
  setLook(opts: { opacity?: number; opticalDepth?: number; edge?: [number, number]; lobes?: number; dither?: boolean; steps?: 24 | 48 | 96 }): void {
    if (opts.opacity !== undefined) this.frame.opacityScale.value = opts.opacity;
    if (opts.opticalDepth !== undefined) this.frame.opticalDepthScale.value = opts.opticalDepth;
    if (opts.edge) this.frame.densityEdge.value.set(opts.edge[0], opts.edge[1]);
    if (opts.lobes !== undefined) this.frame.heightLobes.value = opts.lobes;
    if (opts.dither !== undefined) this.frame.jitter.value = opts.dither ? 1 : 0;
    if (opts.steps !== undefined) this.frame.steps.value = opts.steps;
  }

  setLighting(ambient: THREE.ColorRepresentation, directional: THREE.ColorRepresentation, worldDirection?: THREE.Vector3): void {
    this.frame.ambientColor.value.set(ambient);
    this.frame.lightColor.value.set(directional);
    if (worldDirection && worldDirection.lengthSq() > 1e-6) {
      this.frame.lightUvDirection.value.set(worldDirection.x / this.width, worldDirection.z / this.depth).normalize();
    }
  }

  /** Up to three local scattering lights (an impact flash, a glowing attacker). */
  setPointLight(index: number, position: THREE.Vector3, tint: THREE.ColorRepresentation, intensity: number, range: number): void {
    const light = this.frame.pointLights[index];
    if (!light) throw new Error('GroundMist supports three local lights.');
    light.positionRange.value.set(position.x, position.y, position.z, Math.max(range, 0.01));
    light.radiance.value.set(tint).multiplyScalar(Math.max(0, intensity));
  }

  clearPointLight(index: number): void {
    this.frame.pointLights[index]?.radiance.value.setRGB(0, 0, 0);
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

  /**
   * A blade stroke: a curved band `halfLength` metres long and `width` metres wide, centred at
   * `position`, pushing the mist along `yaw` (radians, the actor's facing: +Z at 0, +X at π/2)
   * at `speed` m/s for `duration` seconds. Shares the five blast slots. Conservative transport
   * carves a visible gap through uniform mist, which a plain velocity push cannot.
   */
  slash(position: THREE.Vector3, yaw: number, halfLength: number, width: number, speed: number, duration = 0.2): number {
    const slot = this.allocate(this.blasts, null);
    this.blasts[slot]!.ttl = duration;
    this.forward.set(Math.sin(yaw), Math.cos(yaw));
    this.solver.setGroundSlash(slot, this.window.worldToUv(position, this.uv), halfLength, width, this.forward, (speed * this.solver.resolution) / Math.min(this.width, this.depth));
    return slot;
  }

  /**
   * A swirl of `radius` metres: the mist inside turns at `rimSpeed` m/s at the rim (negative for
   * the other direction) and is drawn in at `inwardSpeed` m/s (negative pushes out). Keyed swirls
   * (a channelled skill) refresh their slot each call; the slot frees itself after `duration`.
   */
  vortex(position: THREE.Vector3, radius: number, rimSpeed: number, inwardSpeed = 0, duration = 0.5, key: string | null = null): number {
    const slot = this.allocate(this.vortices, key);
    const v = this.vortices[slot]!;
    v.ttl = duration;
    v.key = key;
    const scale = this.solver.resolution / Math.min(this.width, this.depth);
    this.solver.setGroundVortex(slot, this.window.worldToUv(position, this.uv), radius / Math.min(this.width, this.depth), rimSpeed * scale, inwardSpeed * scale);
    return slot;
  }

  clearVortex(slot: number): void {
    const v = this.vortices[slot];
    if (!v) return;
    v.ttl = 0;
    v.key = null;
    this.solver.clearGroundVortex(slot);
  }

  /**
   * The wake of something moving through the mist; call every frame while it moves. Returns
   * false when every wake slot is taken by other keys, so the host can choose which actors matter.
   */
  mover(key: string, position: THREE.Vector3, velocity: THREE.Vector3, radius: number): boolean {
    let slot = this.movers.get(key);
    if (slot === undefined) {
      if (this.movers.size >= this.solver.moverSlots) return false;
      slot = this.freeSlot(this.movers, this.solver.moverSlots);
      this.movers.set(key, slot);
    }
    this.solver.setGroundMover(slot, this.window.worldToUv(position, this.uv), radius / Math.min(this.width, this.depth), this.cellsPerSecond(velocity.x, velocity.z));
    return true;
  }

  clearMover(key: string): void {
    const slot = this.movers.get(key);
    if (slot === undefined) return;
    this.movers.delete(key);
    this.solver.clearGroundMover(slot);
  }

  /** A static footprint the mist flows around and never enters. Returns false when the slots are full. */
  setObstacle(key: string, position: THREE.Vector3, radius: number): boolean {
    let slot = this.obstacles.get(key);
    if (slot === undefined) {
      if (this.obstacles.size >= this.solver.obstacleSlots) return false;
      slot = this.freeSlot(this.obstacles, this.solver.obstacleSlots);
      this.obstacles.set(key, slot);
    }
    this.solver.setGroundObstacle(slot, this.window.worldToUv(position, this.uv), radius / Math.min(this.width, this.depth));
    return true;
  }

  clearObstacle(key: string): void {
    const slot = this.obstacles.get(key);
    if (slot === undefined) return;
    this.obstacles.delete(key);
    this.solver.clearGroundObstacle(slot);
  }

  /** Releases every stamp, blast, vortex, mover and obstacle and lets the field dissipate. */
  clearAll(): void {
    this.stamps.forEach((_, i) => this.clearEmit(i));
    this.blasts.forEach((s, i) => {
      s.ttl = 0;
      this.solver.clearGroundBlast(i);
    });
    this.vortices.forEach((_, i) => this.clearVortex(i));
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
    for (const [i, v] of this.vortices.entries()) {
      if (v.ttl === Infinity || v.ttl <= 0) continue;
      v.ttl -= dt;
      if (v.ttl <= 0) this.clearVortex(i);
    }
    this.solver.update(dt);
    this.sync();
  }

  dispose(): void {
    this.solver.dispose();
    this.group.removeFromParent();
    for (const v of this.volumes ?? []) {
      v.geometry.dispose();
      (v.material as THREE.Material).dispose();
    }
  }

  private sync(): void {
    const index = this.solver.currentScalarFieldIndex;
    this.volumes?.forEach((mesh, i) => (mesh.visible = this._visible && i === index));
    this.densityNode.value = this.densityTexture;
    this.velocityNode.value = this.velocityTexture;
  }

  private placeGroup(): void {
    const c = this.window.getCenter();
    this.frame.worldCenter.value.copy(c);
    this.solver.setRoomBounds(this.frame.boundsMin.value.x > -1e5, c);
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

  private freeSlot(used: Map<string, number>, count: number): number {
    const taken = new Set(used.values());
    for (let i = 0; i < count; i++) if (!taken.has(i)) return i;
    throw new Error('No free slot');
  }

  /** The ray-marched volume over one scalar field: a back-face box proxy running the shared march. */
  private makeVolume(fieldTexture: THREE.StorageTexture): THREE.Mesh {
    const [terrainMin, terrainMax] = this.frame.terrain.bounds ?? [-4, 4];
    const bottom = terrainMin + this.baseHeight;
    const top = terrainMax + this.baseHeight + this.height;
    const material = new THREE.MeshBasicNodeMaterial();
    material.fragmentNode = Fn(() => {
      const direction: any = positionWorld.sub(cameraPosition).normalize();
      const viewDirection = cameraViewMatrix.mul(vec4(direction, 0)).xyz;
      const opaqueDistance = viewportLinearDepth.mul(cameraFar.sub(cameraNear)).add(cameraNear).div(viewDirection.z.negate().max(0.0001));
      return mistMarch(this.frame, { field: fieldTexture, opaqueDistance, direction });
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
