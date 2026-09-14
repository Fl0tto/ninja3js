import * as THREE from 'three/webgpu';
import { roomMaskNode } from './DungeonLayout';
import {
  attribute,
  Fn,
  Loop,
  cameraPosition,
  cameraViewMatrix,
  positionWorld,
  screenCoordinate,
  vec4,
  cameraFar,
  cameraNear,
  color,
  exp,
  float,
  fwidth,
  instanceIndex,
  linearDepth,
  mix,
  positionLocal,
  positionGeometry,
  pow,
  smoothstep,
  texture,
  transformNormalToView,
  uniform,
  uv,
  vec2,
  vec3,
  viewportLinearDepth,
} from 'three/tsl';
import { flatTerrain, type TerrainHeight } from './TerrainHeight';
import { GroundResponseField, type GroundResponseKind } from './GroundResponseField';
import { FluidFire } from './FluidFire';
import { SimulationWindow, type SimulationWindowOptions, type SimulationWindowShift } from './SimulationWindow';


const GROUND_GRASS_BLADE_COUNT = 16_200;
const COVERAGE_SIZE = 140;
const GRASS_SIZE = 42;
const GROUND_GRASS_BLADE_HEIGHT = 0.72;

export type GroundFlowMaterialPreset = 'fog' | 'sand' | 'snow' | 'grass';

/** Gameplay values paired with a renderer preset; all remain inputs to one field. */
export interface GroundFlowInteractionProfile {
  environmentalDensityScale: number;
  environmentalVelocityScale: number;
  windScale: number;
  playerWakeRadius: number;
  playerWakeVelocityScale: number;
  spellVelocity: number;
  spellResidueRadius: number;
  spellResidueDensity: number;
  spellLifetime: number;
  spellBlastDuration: number;
  spellResidueDelay: number;
  spellBlastRadiusScale: number;
  spellBlastSpeed: number;
}

interface GroundFlowPresetSettings extends GroundFlowInteractionProfile {
  densityEdge: readonly [number, number];
  heightExponent: number;
  opticalDepth: number;
  opacity: number;
  tint: THREE.Color;
  heatTint: THREE.Color;
  lightProbeDistance: number;
  surfaceOpacity: number;
  surfaceHeight: number;
  surfaceFlowScale: number;
  surfaceColor: THREE.Color;
  grassOpacity: number;
  grassBend: number;
  grassFlatten: number;
  grassColor: THREE.Color;
}

const GROUND_FLOW_PRESETS: Record<GroundFlowMaterialPreset, GroundFlowPresetSettings> = {
  fog: {
    densityEdge: [0.055, 0.2],
    heightExponent: 1.35,
    opticalDepth: 4.2,
    opacity: 1.25,
    tint: new THREE.Color(1, 1, 1),
    heatTint: new THREE.Color(0.12, 0.18, 0.24),
    lightProbeDistance: 0.045,
    surfaceOpacity: 0,
    surfaceHeight: 0,
    surfaceFlowScale: 0,
    surfaceColor: new THREE.Color(0.55, 0.72, 0.92),
    grassOpacity: 0,
    grassBend: 0,
    grassFlatten: 0,
    grassColor: new THREE.Color(0.13, 0.32, 0.08),
    environmentalDensityScale: 1,
    environmentalVelocityScale: 1,
    windScale: 1,
    playerWakeRadius: 0.62,
    playerWakeVelocityScale: 1.65,
    spellVelocity: 1.4,
    spellResidueRadius: 1.15,
    spellResidueDensity: 1.05,
    spellLifetime: 3.4,
    spellBlastDuration: 0.46,
    spellResidueDelay: 0.22,
    spellBlastRadiusScale: 2.45,
    spellBlastSpeed: 5.8,
  },
  sand: {
    densityEdge: [0.08, 0.24],
    heightExponent: 2.55,
    opticalDepth: 5.15,
    opacity: 1.62,
    tint: new THREE.Color(1.32, 0.82, 0.48),
    heatTint: new THREE.Color(0.28, 0.12, 0.035),
    lightProbeDistance: 0.032,
    surfaceOpacity: 0.76,
    surfaceHeight: 0.075,
    surfaceFlowScale: 0.0048,
    surfaceColor: new THREE.Color(0.56, 0.29, 0.095),
    grassOpacity: 0,
    grassBend: 0,
    grassFlatten: 0,
    grassColor: new THREE.Color(0.13, 0.32, 0.08),
    environmentalDensityScale: 0.86,
    environmentalVelocityScale: 1.35,
    windScale: 1.42,
    playerWakeRadius: 0.7,
    playerWakeVelocityScale: 2.05,
    spellVelocity: 1.9,
    spellResidueRadius: 1.32,
    spellResidueDensity: 1.28,
    spellLifetime: 2.65,
    spellBlastDuration: 0.34,
    spellResidueDelay: 0.13,
    spellBlastRadiusScale: 2.72,
    spellBlastSpeed: 7.4,
  },
  snow: {
    densityEdge: [0.035, 0.14],
    heightExponent: 0.82,
    opticalDepth: 3.15,
    opacity: 0.92,
    tint: new THREE.Color(0.78, 0.94, 1.32),
    heatTint: new THREE.Color(0.52, 0.75, 1),
    lightProbeDistance: 0.06,
    surfaceOpacity: 0.86,
    surfaceHeight: 0.13,
    surfaceFlowScale: 0.0034,
    surfaceColor: new THREE.Color(0.38, 0.66, 0.95),
    grassOpacity: 0,
    grassBend: 0,
    grassFlatten: 0,
    grassColor: new THREE.Color(0.13, 0.32, 0.08),
    environmentalDensityScale: 0.72,
    environmentalVelocityScale: 0.48,
    windScale: 0.58,
    playerWakeRadius: 0.52,
    playerWakeVelocityScale: 0.82,
    spellVelocity: 0.82,
    spellResidueRadius: 1.48,
    spellResidueDensity: 0.64,
    spellLifetime: 4.6,
    spellBlastDuration: 0.62,
    spellResidueDelay: 0.36,
    spellBlastRadiusScale: 1.9,
      spellBlastSpeed: 2.7,
  },
  grass: {
    densityEdge: [0.04, 0.16],
    heightExponent: 2.8,
    opticalDepth: 1,
    opacity: 0,
    tint: new THREE.Color(0.2, 0.45, 0.18),
    heatTint: new THREE.Color(0.12, 0.24, 0.08),
    lightProbeDistance: 0.04,
    surfaceOpacity: 0,
    surfaceHeight: 0,
    surfaceFlowScale: 0,
    surfaceColor: new THREE.Color(0.13, 0.32, 0.08),
    grassOpacity: 0.76,
    grassBend: 0.0068,
    grassFlatten: 0.54,
    grassColor: new THREE.Color(0.12, 0.34, 0.075),
    environmentalDensityScale: 0.58,
    environmentalVelocityScale: 1.1,
    windScale: 1.2,
    playerWakeRadius: 0.78,
    playerWakeVelocityScale: 1.85,
    spellVelocity: 1.15,
    spellResidueRadius: 1.3,
    spellResidueDensity: 0.72,
    spellLifetime: 2.9,
    spellBlastDuration: 0.42,
    spellResidueDelay: 0.18,
    spellBlastRadiusScale: 2.2,
    spellBlastSpeed: 4.8,
  },
};

export function getGroundFlowInteractionProfile(preset: GroundFlowMaterialPreset): GroundFlowInteractionProfile {
  return GROUND_FLOW_PRESETS[preset];
}

export interface GroundFlowVolumeOptions extends Omit<SimulationWindowOptions, 'width' | 'depth' | 'resolution'> {
  height?: number;
  baseHeight?: number;
  terrain?: TerrainHeight;
}

/**
 * Transitional landscape renderer over the proven FluidFire scalar solver.
 *
 * The solver's two field axes are interpreted as world X/Z. The existing fire
 * scene objects stay hidden; this class owns only the player-centred ground
 * volume and requests field scrolling when the SimulationWindow advances.
 */
export class GroundFlowVolume {
  readonly group = new THREE.Group();
  readonly window: SimulationWindow;

  private readonly fogVolumes: [THREE.Mesh, THREE.Mesh];
  private readonly flowSurfaces: Record<'sand' | 'snow', THREE.Mesh[]>;
  private readonly responses: Record<GroundResponseKind, GroundResponseField>;
  private preset: GroundFlowMaterialPreset = 'fog';
  private encounter = false;
  private readonly encounterWeight = uniform(0);
  private readonly terrainResponseWeight = uniform(0);
  private readonly fogSteps = uniform(48, 'int');
  private readonly fogJitter = uniform(1);
  private readonly pointLights = Array.from({length:3}, () => ({
    positionRange: uniform(new THREE.Vector4(0,0,0,1)),
    radiance: uniform(new THREE.Color(0,0,0)),
  }));
  private readonly animationTime = uniform(0);
  private readonly grassWind = uniform(new THREE.Vector2());
  private readonly worldCenter = uniform(new THREE.Vector2());
  private pointerTtl = 0;
  private readonly pointerPosition = new THREE.Vector3();
  private readonly pointerVelocity = new THREE.Vector3();
  private readonly grassBlades: [THREE.InstancedMesh, THREE.InstancedMesh];
  private readonly passiveGround: THREE.Mesh;
  private groundTextures!: Record<'sand' | 'snow', ReturnType<typeof texture>>;
  private readonly terrain: TerrainHeight;
  private readonly height: number;
  private readonly baseHeight: number;
  private readonly lightColor = uniform(new THREE.Color(0.33, 0.55, 0.9));
  private readonly ambientColor = uniform(new THREE.Color(0.018, 0.035, 0.08));
  // Projected light-to-surface direction in local field UV. It lets the
  // inexpensive layered proxy read its own density in the incoming-light
  // direction and gives a dense bank a visibly lit and shaded side.
  private readonly lightUvDirection = uniform(new THREE.Vector2(-0.42, 0.34));
  private readonly densityEdge = uniform(new THREE.Vector2(0.055, 0.2));
  private readonly heightExponent = uniform(1.35);
  private readonly opticalDepthScale = uniform(4.2);
  private readonly opacityScale = uniform(1.25);
  private readonly materialTint = uniform(new THREE.Color(1, 1, 1));
  private readonly heatTint = uniform(new THREE.Color(0.12, 0.18, 0.24));
  private readonly lightProbeDistance = uniform(0.045);
  private readonly surfaceOpacity = uniform(0);
  private readonly surfaceHeight = uniform(0);
  private readonly surfaceFlowScale = uniform(0);
  private readonly surfaceColor = uniform(new THREE.Color(0.55, 0.72, 0.92));
  private readonly grassOpacity = uniform(0);
  private readonly grassBend = uniform(0);
  private readonly grassFlatten = uniform(0);
  private readonly grassColor = uniform(new THREE.Color(0.13, 0.32, 0.08));
  private playerWakeVelocityScale = 1.65;
  private readonly colliderUv = new THREE.Vector2();
  private readonly colliderVelocity = new THREE.Vector2();
  private readonly stampUv = new THREE.Vector2();
  private readonly stampVelocity = new THREE.Vector2();
  private readonly windVelocity = new THREE.Vector2();

  constructor(
    private readonly flow: FluidFire,
    renderer: THREE.WebGPURenderer,
    options: GroundFlowVolumeOptions = {},
  ) {
    this.terrain = options.terrain ?? flatTerrain;
    this.height = options.height ?? 1.15;
    this.baseHeight = options.baseHeight ?? 0.025;
    this.window = new SimulationWindow({
      width: flow.width,
      depth: flow.height,
      resolution: flow.resolution,
      lookAhead: options.lookAhead ?? 1.25,
      recenterFraction: options.recenterFraction ?? 0.22,
    });

    const [scalar0, scalar1] = flow.scalarFields;
    this.responses = Object.fromEntries(['sand', 'snow', 'grass'].map(kind => [kind,
      new GroundResponseField(renderer, {kind: kind as GroundResponseKind, resolution: flow.resolution, width: flow.width, depth: flow.height, terrain: this.terrain})
    ])) as Record<GroundResponseKind, GroundResponseField>;
    this.fogVolumes = [this.makeFogVolume(scalar0), this.makeFogVolume(scalar1)];
    this.flowSurfaces = {
      sand: this.responses.sand.fields.map(f => this.makeDeformedSurface(f, 'sand')),
      snow: this.responses.snow.fields.map(f => this.makeDeformedSurface(f, 'snow')),
    };
    this.grassBlades = this.responses.grass.fields.map(f => this.makeGrassBlades(f)) as [THREE.InstancedMesh, THREE.InstancedMesh];
    this.passiveGround = this.makePassiveGround();
    this.group.name = 'Player-centred ground flow volume';
    this.group.position.y = this.baseHeight;
    this.sync();
  }

  /** Queues a field scroll before FluidFire.update() and moves the render proxy. */
  follow(playerPosition: THREE.Vector3, cameraForward?: THREE.Vector3): SimulationWindowShift | null {
    const shift = this.window.update(playerPosition, cameraForward);
    if (shift) {
      this.flow.scrollFields(shift.cells);
      Object.values(this.responses).forEach(field => field.scroll(shift.cells));
    }

    const center = this.window.getCenter();
    this.worldCenter.value.copy(center);
    this.flow.setRoomBounds(this.encounter,center);
    Object.values(this.responses).forEach(field => field.setWorldCenter(center));
    this.group.position.set(center.x, this.baseHeight, center.y);
    return shift;
  }

  /** Call after FluidFire.update() to select the newly active ping-pong texture. */
  sync(): void {
    const index = this.flow.currentScalarFieldIndex;
    const visible = this.flow.parameters.groundVolume;
    this.terrainResponseWeight.value = this.encounter && visible ? 1 : 0;
    for (const kind of ['sand', 'snow'] as const) {
      this.groundTextures[kind].value = this.responses[kind].fields[this.responses[kind].currentIndex]!;
    }
    this.passiveGround.visible = this.encounter || !visible || this.preset === 'fog' || this.preset === 'grass';
    this.fogVolumes.forEach((mesh, i) => mesh.visible = visible && (this.encounter || this.preset === 'fog') && i === index);
    for (const kind of ['sand', 'snow'] as const) {
      this.flowSurfaces[kind].forEach((mesh, i) => mesh.visible = visible && !this.encounter && this.preset === kind && i === this.responses[kind].currentIndex);
    }
    this.grassBlades.forEach((mesh, i) => mesh.visible = visible && (this.encounter || this.preset === 'grass') && i === this.responses.grass.currentIndex);
  }

  updateResponses(seconds: number): void {
    this.animationTime.value += Math.min(Math.max(seconds, 0), 0.05);
    this.pointerTtl = Math.max(0, this.pointerTtl - seconds);
    if (this.pointerTtl > 0) this.contact(14, this.pointerPosition, 0.55, this.pointerVelocity);
    else this.activeResponses.forEach(field => field.clearStamp(14));
    Object.entries(this.responses).forEach(([kind, field]) => field.update(seconds, this.encounter || this.preset === kind));
  }
  injectSurfacePointer(position: THREE.Vector3, delta: THREE.Vector2, seconds: number): void {
    this.pointerPosition.copy(position);
    this.pointerVelocity.set(delta.x * this.flow.width, 0, delta.y * this.flow.height).divideScalar(Math.max(seconds, 1 / 240));
    this.pointerTtl = 0.1;
  }
  get responseDispatches(): number {
    return Object.values(this.responses).reduce((sum, field) => sum + field.dispatches, 0);
  }
  setEncounterMode(enabled: boolean): void {
    this.encounter = enabled;
    if(enabled) this.setMaterialPreset('fog');
    this.encounterWeight.value = enabled ? 1 : 0;
    this.flow.setRoomBounds(enabled,this.worldCenter.value);
    Object.values(this.responses).forEach(field=>field.setRoomEnabled(enabled));
    this.sync();
  }
  private get activeResponses(): GroundResponseField[] {
    return this.encounter ? Object.values(this.responses) : this.preset === 'fog' ? [] : [this.responses[this.preset]];
  }
  private contact(slot: number, position: THREE.Vector3, radius: number, velocity = new THREE.Vector3(), strength = 1): void {
    this.worldToUv(position, this.stampUv);
    this.activeResponses.forEach(field => field.setStamp(slot, this.stampUv, radius / Math.min(this.flow.width, this.flow.height), strength, new THREE.Vector2(velocity.x, velocity.z)));
  }

  worldToUv(worldPosition: THREE.Vector3, target = new THREE.Vector2()): THREE.Vector2 {
    return this.window.worldToUv(worldPosition, target);
  }

  setFogSampling(steps: 24 | 48 | 96, dither: boolean): void {
    this.fogSteps.value = steps;
    this.fogJitter.value = dither ? 1 : 0;
  }

  /** Local fog scattering lights; callers also own any matching scene lights. */
  setPointLight(index: number, position: THREE.Vector3, tint: THREE.Color, intensity: number, range: number): void {
    const light = this.pointLights[index];
    if(!light) throw new Error('Ground mist supports three local lights.');
    light.positionRange.value.set(position.x,position.y,position.z,Math.max(range,0.01));
    light.radiance.value.copy(tint).multiplyScalar(Math.max(0,intensity));
  }

  setLighting(ambient: THREE.Color, directional: THREE.Color, worldDirection?: THREE.Vector3): void {
    this.ambientColor.value.copy(ambient);
    this.lightColor.value.copy(directional);
    if (worldDirection && worldDirection.lengthSq() > 0.000001) {
      this.lightUvDirection.value.set(
        worldDirection.x / this.flow.width,
        worldDirection.z / this.flow.height,
      ).normalize();
    }
  }

  /** Selects a material solver and its render output while retaining other states. */
  setMaterialPreset(preset: GroundFlowMaterialPreset): void {
    this.preset = preset;
    const settings = GROUND_FLOW_PRESETS[preset];
    this.densityEdge.value.set(...settings.densityEdge);
    this.heightExponent.value = settings.heightExponent;
    this.opticalDepthScale.value = settings.opticalDepth;
    this.opacityScale.value = settings.opacity;
    this.materialTint.value.copy(settings.tint);
    this.heatTint.value.copy(settings.heatTint);
    this.lightProbeDistance.value = settings.lightProbeDistance;
    this.surfaceOpacity.value = settings.surfaceOpacity;
    this.surfaceHeight.value = settings.surfaceHeight;
    this.surfaceFlowScale.value = settings.surfaceFlowScale;
    this.surfaceColor.value.copy(settings.surfaceColor);
    this.grassOpacity.value = settings.grassOpacity;
    this.grassBend.value = settings.grassBend;
    this.grassFlatten.value = settings.grassFlatten;
    this.grassColor.value.copy(settings.grassColor);
    this.playerWakeVelocityScale = settings.playerWakeVelocityScale;
    this.sync();
  }

  /** Projects a gameplay capsule's ground contact into the local flow window. */
  setPlayerCapsule(worldPosition: THREE.Vector3, worldVelocity: THREE.Vector3, radius: number): void {
    this.contact(0, worldPosition, radius, worldVelocity);
    // A velocity stamp is a moving wake, not a stationary obstacle. Keeping it
    // active at rest forced the field to zero under the player and produced an
    // artificial vortex. Static collision will use a separate mask pass.
    if (worldVelocity.lengthSq() < 0.0001) {
      this.flow.clearColliderStamp();
      return;
    }
    this.worldToUv(worldPosition, this.colliderUv);
    this.colliderVelocity.set(
      worldVelocity.x * this.flow.resolution / this.flow.width,
      worldVelocity.z * this.flow.resolution / this.flow.height,
    ).multiplyScalar(this.playerWakeVelocityScale);
    this.flow.setColliderStamp(
      this.colliderUv,
      this.colliderVelocity,
      radius / Math.min(this.flow.width, this.flow.height),
    );
  }

  /**
   * Defines a persistent world-space density source, spell residue or wind
   * contribution. Sources outside the moving window automatically stop
   * writing, so callers only deal in world units.
   */
  setFlowStamp(
    index: number,
    worldPosition: THREE.Vector3,
    radius: number,
    density: number,
    worldVelocity = new THREE.Vector3(),
  ): void {
    this.worldToUv(worldPosition, this.stampUv);
    this.stampVelocity.set(
      worldVelocity.x * this.flow.resolution / this.flow.width,
      worldVelocity.z * this.flow.resolution / this.flow.height,
    );
    // Environmental fog emitters do not continuously refill solid ground.
    if (index >= 3) this.activeResponses.forEach(field => field.setDeposit(index - 3, this.stampUv, radius / Math.min(this.flow.width, this.flow.height), density));
    this.flow.setGroundStamp(
      index,
      this.stampUv,
      radius / Math.min(this.flow.width, this.flow.height),
      density,
      this.stampVelocity,
    );
  }

  clearFlowStamp(index: number): void {
    this.flow.clearGroundStamp(index);
    if (index >= 3) this.activeResponses.forEach(field => field.clearDeposit(index - 3));
  }

  /**
   * Writes the wake of a moving gameplay object. Pair this with setObstacle()
   * at the same position when the object should also displace fog from its
   * footprint; a stopped object intentionally stops adding velocity.
   */
  setObjectCapsule(
    index: number,
    worldPosition: THREE.Vector3,
    worldVelocity: THREE.Vector3,
    radius: number,
  ): void {
    this.contact(index + 1, worldPosition, radius, worldVelocity);
    if (worldVelocity.lengthSq() < 0.0001) {
      this.flow.clearGroundMover(index);
      return;
    }
    this.worldToUv(worldPosition, this.stampUv);
    this.stampVelocity.set(
      worldVelocity.x * this.flow.resolution / this.flow.width,
      worldVelocity.z * this.flow.resolution / this.flow.height,
    );
    this.flow.setGroundMover(
      index,
      this.stampUv,
      radius / Math.min(this.flow.width, this.flow.height),
      this.stampVelocity,
    );
  }

  clearObjectCapsule(index: number): void {
    this.flow.clearGroundMover(index);
    this.activeResponses.forEach(field => field.clearStamp(index + 1));
  }

  /** Adds a world-space radial displacement force without adding density. */
  setBlast(index: number, worldPosition: THREE.Vector3, radius: number, outwardSpeed: number): void {
    this.worldToUv(worldPosition, this.stampUv);
    this.contact(index + 5, worldPosition, radius, new THREE.Vector3(), outwardSpeed / 5.8);
    this.flow.setGroundBlast(
      index,
      this.stampUv,
      radius / Math.min(this.flow.width, this.flow.height),
      outwardSpeed * this.flow.resolution / Math.min(this.flow.width, this.flow.height),
    );
  }

  clearBlast(index: number): void {
    this.flow.clearGroundBlast(index);
    this.activeResponses.forEach(field => field.clearStamp(index + 5));
  }

  /** Curved sword stroke with directional push, shared by all active responders. */
  setSlash(index: number, position: THREE.Vector3, halfLength: number, width: number, forward: THREE.Vector2, speed: number): void {
    this.worldToUv(position, this.stampUv);
    this.activeResponses.forEach(field => field.setSlashStamp(index+5,this.stampUv,halfLength,width,forward,speed/5.8));
    this.flow.setGroundSlash(index,this.stampUv,halfLength,width,forward,speed*this.flow.resolution/Math.min(this.flow.width,this.flow.height));
  }

  /** Applies a world-space horizontal wind velocity to the whole local field. */
  setWind(worldVelocity: THREE.Vector3): void {
    this.grassWind.value.set(worldVelocity.x, worldVelocity.z);
    this.windVelocity.set(
      worldVelocity.x * this.flow.resolution / this.flow.width,
      worldVelocity.z * this.flow.resolution / this.flow.height,
    );
    this.flow.setGroundWind(this.windVelocity);
    this.activeResponses.forEach(field => field.setWind(new THREE.Vector2(worldVelocity.x, worldVelocity.z)));
  }

  /** Projects a static world-space circular obstacle into the local field. */
  setObstacle(index: number, worldPosition: THREE.Vector3, radius: number): void {
    this.worldToUv(worldPosition, this.stampUv);
    this.contact(index + 10, worldPosition, radius);
    this.flow.setGroundObstacle(
      index,
      this.stampUv,
      radius / Math.min(this.flow.width, this.flow.height),
    );
  }

  clearObstacle(index: number): void {
    this.flow.clearGroundObstacle(index);
    this.activeResponses.forEach(field => field.clearStamp(index + 10));
  }

  dispose(): void {
    Object.values(this.responses).forEach(field => field.dispose());
    this.group.removeFromParent();
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      if (Array.isArray(mesh.material)) mesh.material.forEach((material) => material.dispose());
      else mesh.material?.dispose();
    });
  }

  private makeCoverageGeometry(): THREE.PlaneGeometry {
    const n = this.flow.resolution;
    const geometry = new THREE.PlaneGeometry(1, 1, n + 32, n + 32);
    const positions = geometry.attributes.position!;
    const axis = (i: number, size: number): number => i < 16
      ? -COVERAGE_SIZE / 2 + i / 16 * (COVERAGE_SIZE - size) / 2
      : i <= n + 16 ? (i - 16) / n * size - size / 2
      : size / 2 + (i - n - 16) / 16 * (COVERAGE_SIZE - size) / 2;
    for (let j = 0; j <= n + 32; j++) for (let i = 0; i <= n + 32; i++) {
      positions.setXYZ(j * (n + 33) + i, axis(i, this.flow.width), -axis(j, this.flow.height), 0);
    }
    return geometry;
  }

  private patchWeightAt(at: any, kind: 'sand' | 'snow'): any {
    const distance = at.sub(vec2(kind === 'sand' ? -2.1 : 2.1, -1.4)).length()
      .add(at.x.mul(3.1).sin().mul(at.y.mul(2.7).cos()).mul(0.11));
    return float(1).sub(smoothstep(1.45, 2.05, distance));
  }

  private makePassiveGround(): THREE.Mesh {
    // One continuous opaque surface: depressions replace soil instead of crossing it.
    const geometry = this.makeCoverageGeometry().rotateX(-Math.PI / 2);
    const material = new THREE.MeshStandardNodeMaterial({ color: 0x39453b, roughness: 0.95, side: THREE.DoubleSide });
    this.groundTextures = {
      sand: texture(this.responses.sand.fields[0]),
      snow: texture(this.responses.snow.fields[0]),
    };
    const world = positionLocal.xz.add(this.worldCenter);
    const responseAt = (at: any, kind: 'sand' | 'snow'): any => {
      const fieldUv = at.sub(this.worldCenter).div(vec2(this.flow.width, this.flow.height)).add(0.5);
      const edge = fieldUv.min(float(1).sub(fieldUv));
      return this.groundTextures[kind].sample(fieldUv.clamp(0, 1))
        .mul(smoothstep(0, 0.08, edge.x.min(edge.y)));
    };
    const weightAt = (at: any, kind: 'sand' | 'snow'): any => this.patchWeightAt(at, kind).mul(this.terrainResponseWeight);
    const heightAt = (at: any): any => this.terrain.node(at).sub(0.01)
      .add(responseAt(at, 'sand').r.add(0.045).mul(weightAt(at, 'sand')))
      .add(responseAt(at, 'snow').r.add(0.045).mul(weightAt(at, 'snow')));
    material.positionNode = positionLocal.add(vec3(0, heightAt(world), 0));
    const dx = this.flow.width / this.flow.resolution, dz = this.flow.height / this.flow.resolution;
    const slopeX = heightAt(world.add(vec2(dx, 0))).sub(heightAt(world.sub(vec2(dx, 0)))).div(2 * dx);
    const slopeZ = heightAt(world.add(vec2(0, dz))).sub(heightAt(world.sub(vec2(0, dz)))).div(2 * dz);
    const tile=world.mul(1.25).fract().min(float(1).sub(world.mul(1.25).fract()));
    const grout=smoothstep(0.008,0.025,tile.x.min(tile.y));
    const stone = mix(color(0x222a2d),color(0x454c4d),grout);
    const floorWeight = float(this.encounterWeight.mul(roomMaskNode(world)));
    let tint: any = mix(color(0x39453b),stone,floorWeight);
    let roughness: any = float(0.95);
    let relief: any = float(0);
    for (const kind of ['sand', 'snow'] as const) {
      const weight = weightAt(world, kind);
      const state = responseAt(world, kind).mul(weight);
      const phase = world.x.mul(kind === 'sand' ? 23 : 39).add(world.y.mul(kind === 'sand' ? 8 : 31))
        .add(world.y.mul(1.7).sin().mul(1.2));
      const detailFade = float(1).sub(smoothstep(0.5, 2.5, fwidth(phase)));
      const undisturbed = float(1).sub(state.g.clamp(0, 1));
      relief = relief.add(phase.cos().mul(detailFade).mul(undisturbed).mul(kind === 'sand' ? 0.045 : 0.025).mul(weight));
      const broad = world.x.mul(0.73).add(world.y.mul(0.48)).sin()
        .mul(world.y.mul(1.13).sub(world.x.mul(0.24)).sin());
      const grain = kind === 'snow' ? world.x.mul(29).sub(world.y.mul(43)).sin() : float(1);
      const fine = phase.sin().mul(grain).mul(detailFade).mul(undisturbed);
      const variation = broad.mul(0.035).add(fine.mul(kind === 'sand' ? 0.025 : 0.012)).add(1);
      const looseColor = color(kind === 'sand' ? new THREE.Color(0.38, 0.30, 0.19) : new THREE.Color(0.67, 0.74, 0.77));
      const packedColor = color(kind === 'sand' ? new THREE.Color(0.25, 0.22, 0.16) : new THREE.Color(0.45, 0.63, 0.78));
      tint = mix(tint, mix(looseColor, packedColor, state.g.clamp(0, 1).mul(0.65)).mul(variation), weight);
      roughness = mix(roughness, mix(float(kind === 'sand' ? 0.96 : 0.88), float(kind === 'sand' ? 0.88 : 0.5), state.g.clamp(0, 1)), weight);
    }
    material.colorNode = tint;
    material.roughnessNode = roughness;
    material.normalNode = transformNormalToView(vec3(slopeX.add(relief).negate(), 1, slopeZ.add(relief.mul(0.35)).negate()).normalize());
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.name = 'Continuous terrain and material coverage';
    this.group.add(mesh);
    return mesh;
  }

  /** Integrate along the camera ray, clipped to opaque scene depth and terrain. */
  private makeFogVolume(fieldTexture: THREE.StorageTexture): THREE.Mesh {
    const [terrainMin, terrainMax] = this.terrain.bounds ?? [-4, 4];
    const bottom = terrainMin + this.baseHeight;
    const top = terrainMax + this.baseHeight + this.height;
    const material = new THREE.MeshBasicNodeMaterial();
    material.fragmentNode = Fn(() => {
      const direction: any = positionWorld.sub(cameraPosition).normalize();
      const safe = (value: any): any => value.greaterThanEqual(0).select(value.max(0.00001), value.min(-0.00001));
      const inverse = vec3(1).div(vec3(safe(direction.x), safe(direction.y), safe(direction.z)));
      const boundsMin = vec3(this.worldCenter.x.sub(this.flow.width/2), bottom, this.worldCenter.y.sub(this.flow.height/2));
      const boundsMax = vec3(this.worldCenter.x.add(this.flow.width/2), top, this.worldCenter.y.add(this.flow.height/2));
      const slabA = boundsMin.sub(cameraPosition).mul(inverse);
      const slabB = boundsMax.sub(cameraPosition).mul(inverse);
      const near = slabA.min(slabB), far = slabA.max(slabB);
      const start = near.x.max(near.y).max(near.z).max(0);
      const viewDirection = cameraViewMatrix.mul(vec4(direction, 0)).xyz;
      const opaqueDistance = viewportLinearDepth.mul(cameraFar.sub(cameraNear)).add(cameraNear)
        .div(viewDirection.z.negate().max(0.0001));
      const end = far.x.min(far.y).min(far.z).min(opaqueDistance);
      const step = end.sub(start).max(0).div(float(this.fogSteps));
      const transmittance = float(1).toVar();
      const radiance = vec3(0).toVar();
      // Stable per-pixel stratification breaks coherent ray-step bands.
      // No frame-time seed: paused lighting comparisons remain deterministic.
      const noise = screenCoordinate.xy.dot(vec2(0.06711056,0.00583715)).fract().mul(52.9829189).fract();
      const offset = mix(float(0.5),noise.mul(0.9).add(0.05),this.fogJitter);
      Loop({start:0,end:this.fogSteps,type:'int'}, ({i}) => {
        const point = cameraPosition.add(direction.mul(start.add(step.mul(float(i).add(offset)))));
        const fieldUv = point.xz.sub(this.worldCenter).div(vec2(this.flow.width,this.flow.height)).add(0.5);
        const sample = texture(fieldTexture,fieldUv.clamp(0,1)).level(float(0));
        const height = point.y.sub(this.terrain.node(point.xz)).sub(this.baseHeight);
        // Broad world-anchored lobes soften the otherwise level volume ceiling.
        const lobe = point.x.mul(0.83).add(point.z.mul(0.37)).sin()
          .mul(point.z.mul(1.07).sub(point.x.mul(0.21)).sin());
        const localHeight = lobe.mul(0.22).add(0.78).mul(this.height);
        const heightProfile = smoothstep(0,0.09,height)
          .mul(float(1).sub(smoothstep(0.08,localHeight,height)));
        const edge = fieldUv.min(float(1).sub(fieldUv));
        const domain = smoothstep(0,0.07,edge.x.min(edge.y)).mul(mix(float(1),roomMaskNode(point.xz),this.encounterWeight));
        const breakup = point.x.mul(2.3).add(point.y.mul(4.1)).sin()
          .mul(point.z.mul(2.7).sub(point.y.mul(2.2)).sin()).mul(0.18).add(0.82);
        const density = sample.r.clamp(0,1.6).mul(smoothstep(this.densityEdge.x,this.densityEdge.y,sample.r))
          .mul(heightProfile).mul(domain).mul(breakup);
        const alpha = float(1).sub(exp(density.mul(step).mul(this.opticalDepthScale).mul(-0.62)));
        const blocker = texture(fieldTexture,fieldUv.add(this.lightUvDirection.mul(this.lightProbeDistance)).clamp(0,1)).level(float(0)).r;
        const lighting = mix(this.ambientColor, this.lightColor, exp(blocker.mul(-1.1)).mul(0.65).add(0.2)).toVar();
        for(const light of this.pointLights) {
          const delta = light.positionRange.xyz.sub(point);
          const distance = delta.length();
          const rangeFalloff = float(1).sub(smoothstep(0,light.positionRange.w,distance));
          const attenuation = rangeFalloff.mul(rangeFalloff).div(distance.mul(distance).add(0.35));
          const towardEye = delta.div(distance.max(0.001)).dot(direction.negate()).max(0);
          const phase = towardEye.mul(towardEye).mul(0.35).add(0.65);
          // Unshadowed single scattering, with softened inverse-square falloff.
          lighting.addAssign(light.radiance.mul(attenuation).mul(phase));
        }
        radiance.addAssign(lighting.mul(alpha).mul(transmittance));
        transmittance.mulAssign(float(1).sub(alpha));
      });
      const opacity = float(1).sub(transmittance);
      return vec4(radiance.div(opacity.max(0.0001)),opacity);
    })();
    material.transparent = true;
    material.depthWrite = false;
    // The exit face may be behind terrain; clipping happens along the ray.
    material.depthTest = false;
    material.side = THREE.BackSide;
    const volume = new THREE.Mesh(new THREE.BoxGeometry(this.flow.width, top-bottom, this.flow.height),material);
    volume.position.y = (top+bottom)/2-this.baseHeight;
    volume.frustumCulled = false;
    volume.renderOrder = 4;
    volume.name = 'Dithered terrain-clipped ground mist';
    this.group.add(volume);
    return volume;
  }

  /**
   * Sand and snow sample independent height/compaction buffers. Vertex height
   * and slope normals retain visible imprints while the window scrolls.
   */
  private makeDeformedSurface(
    scalarTexture: THREE.StorageTexture,
    kind: 'sand' | 'snow',
  ): THREE.Mesh {
    const world = positionLocal.xz.add(this.worldCenter);
    const fieldUv = positionLocal.xz.div(vec2(this.flow.width, this.flow.height)).add(0.5);
    const response = (at: any): any => {
      const edge = at.min(float(1).sub(at));
      const weight = smoothstep(0, 0.08, edge.x.min(edge.y));
      return texture(scalarTexture, at.clamp(0, 1)).mul(weight);
    };
    const patchAt = (at: any): any => mix(float(1), this.patchWeightAt(at, kind), this.encounterWeight);
    const patchWeight = patchAt(world);
    const state = response(fieldUv).mul(patchWeight);
    const material = new THREE.MeshStandardNodeMaterial();
    const texel = 1 / this.flow.resolution;
    // Use the same masked displacement and shallow border for geometry and normals.
    const heightAt = (offset: any): any => this.terrain.node(world.add(offset))
      .add(response(fieldUv.add(offset.div(vec2(this.flow.width, this.flow.height)))).r
        .add(0.035).mul(patchAt(world.add(offset))));
    const dx = this.flow.width * texel, dz = this.flow.height * texel;
    const slopeX = heightAt(vec2(dx, 0)).sub(heightAt(vec2(-dx, 0))).div(2 * dx);
    const slopeZ = heightAt(vec2(0, dz)).sub(heightAt(vec2(0, -dz))).div(2 * dz);
    // Detail is shading only: it never adds or removes simulated material.
    // Pixel footprint suppresses subpixel waves in the passive distance.
    const phase = world.x.mul(kind === 'sand' ? 23 : 39).add(world.y.mul(kind === 'sand' ? 8 : 31))
      .add(world.y.mul(1.7).sin().mul(1.2));
    const detailFade = float(1).sub(smoothstep(0.5, 2.5, fwidth(phase)));
    const undisturbed = float(1).sub(state.g.clamp(0, 1));
    const relief = phase.cos().mul(detailFade).mul(undisturbed).mul(kind === 'sand' ? 0.045 : 0.025);
    material.normalNode = transformNormalToView(vec3(slopeX.add(relief).negate(), 1, slopeZ.add(relief.mul(0.35)).negate()).normalize());
    material.positionNode = positionLocal.add(vec3(0, heightAt(vec2(0)), 0));
    const broad = world.x.mul(0.73).add(world.y.mul(0.48)).sin()
      .mul(world.y.mul(1.13).sub(world.x.mul(0.24)).sin());
    const grain = kind === 'snow' ? world.x.mul(29).sub(world.y.mul(43)).sin() : float(1);
    const fine = phase.sin().mul(grain).mul(detailFade).mul(undisturbed);
    const variation = broad.mul(0.035).add(fine.mul(kind === 'sand' ? 0.025 : 0.012)).add(1);
    const looseColor = color(kind === 'sand' ? new THREE.Color(0.38, 0.30, 0.19) : new THREE.Color(0.67, 0.74, 0.77));
    const packedColor = color(kind === 'sand' ? new THREE.Color(0.25, 0.22, 0.16) : new THREE.Color(0.45, 0.63, 0.78));
    material.colorNode = mix(color(0x39453b), mix(looseColor, packedColor, state.g.clamp(0, 1).mul(0.65)).mul(variation), patchWeight);
    material.roughnessNode = mix(float(kind === 'sand' ? 0.96 : 0.88), float(kind === 'sand' ? 0.88 : 0.5), state.g.clamp(0, 1));
    material.side = THREE.DoubleSide;
    material.opacityNode = patchWeight;
    material.alphaTestNode = float(0.01);
    // Solid terrain coverage; no fog-density opacity or horizontal drift.
    const geometry = this.makeCoverageGeometry().rotateX(-Math.PI / 2);
    const surface = new THREE.Mesh(geometry, material);
    surface.name = 'Independent height and compaction surface';
    surface.frustumCulled = false;
    surface.renderOrder = 2;
    this.group.add(surface);
    return surface;
  }

  /**
   * Grass samples its own bend/flatten response texture. Roots wrap at the
   * window border while interior roots remain fixed in world space.
   */
  private makeGrassBlades(
    scalarTexture: THREE.StorageTexture,
  ): THREE.InstancedMesh {
    const geometry = new THREE.PlaneGeometry(0.065, GROUND_GRASS_BLADE_HEIGHT, 1, 5)
      .translate(0, GROUND_GRASS_BLADE_HEIGHT * 0.5, 0);
    const bladeData = new Float32Array(GROUND_GRASS_BLADE_COUNT * 3);
    const random = (seed: number): number => {
      const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
      return value - Math.floor(value);
    };
    for (let index = 0; index < GROUND_GRASS_BLADE_COUNT; index += 1) {
      bladeData[index * 3] = random(index * 3 + 1);
      bladeData[index * 3 + 1] = random(index * 3 + 2);
      bladeData[index * 3 + 2] = random(index * 3 + 3);
    }
    geometry.setAttribute('groundGrassData', new THREE.InstancedBufferAttribute(bladeData, 3));

    const blade: any = attribute('groundGrassData', 'vec3');
    // Wrap roots at the domain border while keeping interior roots fixed in world space.
    const bladeUv = blade.xy.sub(this.worldCenter.div(vec2(GRASS_SIZE, GRASS_SIZE))).fract();
    const rootOffset = bladeUv.sub(blade.xy).mul(GRASS_SIZE);
    const root = bladeUv.sub(0.5).mul(GRASS_SIZE);
    const fieldUv = root.div(vec2(this.flow.width, this.flow.height)).add(0.5);
    const edge = fieldUv.min(float(1).sub(fieldUv));
    const weight = smoothstep(0, 0.08, edge.x.min(edge.y));
    const state = texture(scalarTexture, fieldUv.clamp(0, 1)).mul(weight);
    const worldGrassRoot = root.add(this.worldCenter);
    const sandDistance = worldGrassRoot.sub(vec2(-2.1, -1.4)).length();
    const snowDistance = worldGrassRoot.sub(vec2(2.1, -1.4)).length();
    const clearing = smoothstep(1.8, 2.15, sandDistance).mul(smoothstep(1.8, 2.15, snowDistance))
      .mul(float(1).sub(smoothstep(5.4, 6.3, worldGrassRoot.sub(vec2(0,-1)).length())));
    const coverage = mix(float(1), clearing.mul(roomMaskNode(worldGrassRoot)), this.encounterWeight);
    const rootHeight = this.terrain.node(worldGrassRoot);
    const density = state.g;
    const velocity = state.ba;
    const tip = positionLocal.y.div(GROUND_GRASS_BLADE_HEIGHT).clamp(0, 1);
    const bendWeight = tip.mul(tip);
    const worldRoot = root.add(this.worldCenter);
    const heightScale = blade.z.mul(0.55).add(0.55);
    const angle = blade.z.mul(43.7);
    const width: any = positionGeometry.x.mul(float(1).sub(tip).pow(0.65)).mul(coverage);
    const restCurve = bendWeight.mul(blade.z.sub(0.5)).mul(0.18).mul(coverage);
    const wave = worldRoot.x.mul(0.8).add(worldRoot.y.mul(0.55)).sub(this.animationTime.mul(2.1)).sin();
    const ambientBend = this.grassWind.mul(wave.mul(0.06).add(0.18));
    // Match the solver's wind target across the local/passive transition.
    const bend = velocity.add(ambientBend.mul(float(1).sub(weight)))
      .add(this.grassWind.mul(wave.mul(0.06)).mul(weight))
      .clamp(-0.55, 0.55).mul(bendWeight).mul(coverage);
    const flatten = density.clamp(0, 1).mul(0.78);
    const bladeHeight: any = positionGeometry.y.mul(heightScale).mul(float(1).sub(flatten)).mul(coverage);
    const material = new THREE.MeshBasicNodeMaterial();
    material.positionNode = positionLocal.add(vec3(
      width.mul(angle.cos()).sub(positionGeometry.x).add(restCurve.mul(angle.sin())).add(bend.x).add(rootOffset.x),
      bladeHeight.sub(positionGeometry.y).add(rootHeight),
      width.mul(angle.sin()).add(restCurve.mul(angle.cos())).add(bend.y).add(rootOffset.y),
    ));
    const rootColor = color(new THREE.Color(0.025, 0.055, 0.035));
    const tipColor = color(new THREE.Color(0.14, 0.24, 0.115));
    material.colorNode = mix(rootColor, tipColor, tip.mul(0.8).add(0.15))
      .mul(blade.z.mul(0.35).add(0.8)).mul(float(1).sub(density.mul(0.12)));
    // Opaque tapered geometry avoids per-instance transparency sorting artifacts.
    material.depthWrite = true;
    material.depthTest = true;
    material.side = THREE.DoubleSide;

    const grass = new THREE.InstancedMesh(geometry, material, GROUND_GRASS_BLADE_COUNT);
    const transform = new THREE.Matrix4();
    for (let index = 0; index < GROUND_GRASS_BLADE_COUNT; index += 1) {
      const u = bladeData[index * 3]!;
      const v = bladeData[index * 3 + 1]!;
      transform.makeTranslation((u - 0.5) * GRASS_SIZE, 0, (v - 0.5) * GRASS_SIZE);
      grass.setMatrixAt(index, transform);
    }
    grass.instanceMatrix.needsUpdate = true;
    grass.name = `${GROUND_GRASS_BLADE_COUNT} shared-field grass blade cards`;
    grass.frustumCulled = false;
    grass.renderOrder = 3;
    this.group.add(grass);
    return grass;
  }
}
