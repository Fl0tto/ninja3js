import * as THREE from 'three';

export interface SimulationWindowOptions {
  /** Horizontal X extent represented by the square simulation texture. */
  width: number;
  /** Horizontal Z extent represented by the square simulation texture. */
  depth: number;
  /** Texture resolution; one cell is width/resolution by depth/resolution metres. */
  resolution: number;
  /** Forward camera bias, in world metres, applied only to the target window centre. */
  lookAhead?: number;
  /** Fraction of a half-window the player may travel before the field scrolls. */
  recenterFraction?: number;
}

export interface SimulationWindowShift {
  /** Old and new world-space centres of the simulated X/Z rectangle. */
  previousCenter: THREE.Vector2;
  center: THREE.Vector2;
  /** Integer cell displacement, suitable for a GPU texture scroll pass. */
  cells: THREE.Vector2;
}

/**
 * Owns the world-space placement of one client-local ground-flow field.
 *
 * It intentionally does not know about the renderer or GPU textures. Callers
 * perform the returned integer-cell scroll, then use worldToUv() for all
 * gameplay stamps and rendering. Keeping this policy separate makes the
 * simulation behaviour deterministic and independently testable.
 */
export class SimulationWindow {
  readonly width: number;
  readonly depth: number;
  readonly resolution: number;
  readonly lookAhead: number;
  readonly recenterFraction: number;

  private readonly cellSize = new THREE.Vector2();
  private readonly center = new THREE.Vector2();
  private readonly origin = new THREE.Vector2();

  constructor(options: SimulationWindowOptions, initialCenter = new THREE.Vector2()) {
    if (options.width <= 0 || options.depth <= 0 || options.resolution <= 0) {
      throw new Error('SimulationWindow requires positive dimensions and resolution.');
    }

    this.width = options.width;
    this.depth = options.depth;
    this.resolution = options.resolution;
    this.lookAhead = options.lookAhead ?? 0;
    this.recenterFraction = THREE.MathUtils.clamp(options.recenterFraction ?? 0.2, 0.05, 0.45);
    this.cellSize.set(this.width / this.resolution, this.depth / this.resolution);
    this.center.copy(this.quantize(initialCenter));
    this.updateOrigin();
  }

  getCenter(target = new THREE.Vector2()): THREE.Vector2 {
    return target.copy(this.center);
  }

  getOrigin(target = new THREE.Vector2()): THREE.Vector2 {
    return target.copy(this.origin);
  }

  worldToUv(worldPosition: THREE.Vector3, target = new THREE.Vector2()): THREE.Vector2 {
    return target.set(
      (worldPosition.x - this.origin.x) / this.width,
      (worldPosition.z - this.origin.y) / this.depth,
    );
  }

  containsWorldPosition(worldPosition: THREE.Vector3, margin = 0): boolean {
    const uv = this.worldToUv(worldPosition);
    return uv.x >= margin && uv.x <= 1 - margin && uv.y >= margin && uv.y <= 1 - margin;
  }

  /**
   * Advances the window only after its player anchor crosses the inner region.
   * A camera direction can shift the desired centre forward, but never becomes
   * the anchor itself; orbiting a stationary player therefore does not scroll.
   */
  update(playerPosition: THREE.Vector3, cameraForward?: THREE.Vector3): SimulationWindowShift | null {
    const desired = new THREE.Vector2(playerPosition.x, playerPosition.z);
    if (cameraForward && this.lookAhead > 0) {
      const forward = new THREE.Vector2(cameraForward.x, cameraForward.z);
      if (forward.lengthSq() > 0.000001) desired.addScaledVector(forward.normalize(), this.lookAhead);
    }

    const displacement = desired.clone().sub(this.center);
    const threshold = new THREE.Vector2(
      this.width * 0.5 * this.recenterFraction,
      this.depth * 0.5 * this.recenterFraction,
    );
    if (Math.abs(displacement.x) < threshold.x && Math.abs(displacement.y) < threshold.y) return null;

    const nextCenter = this.quantize(desired);
    const cells = nextCenter.clone().sub(this.center).divide(this.cellSize).round();
    if (cells.lengthSq() === 0) return null;

    const previousCenter = this.center.clone();
    this.center.add(new THREE.Vector2(cells.x * this.cellSize.x, cells.y * this.cellSize.y));
    this.updateOrigin();
    return { previousCenter, center: this.center.clone(), cells };
  }

  private quantize(position: THREE.Vector2): THREE.Vector2 {
    return new THREE.Vector2(
      Math.round(position.x / this.cellSize.x) * this.cellSize.x,
      Math.round(position.y / this.cellSize.y) * this.cellSize.y,
    );
  }

  private updateOrigin(): void {
    this.origin.set(this.center.x - this.width * 0.5, this.center.y - this.depth * 0.5);
  }
}
