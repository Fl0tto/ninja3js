import * as THREE from 'three/webgpu';
import { roomContains } from './DungeonLayout';
import { demoTerrain } from './TerrainHeight';

/** Stationary sentinel practice: locked ground target, one impact, then recovery. */
export class TrainingCombat {
  phase: 'ready' | 'warning' | 'recovery' = 'ready';
  hits = 0;
  health = 100;
  hurtTime = 0;
  get defeated(): boolean { return this.health === 0; }
  dodges = 0;
  dodgeTime = 0;
  cooldown = 0;
  readonly direction = new THREE.Vector3(0, 0, 1);
  readonly target = new THREE.Vector3();
  readonly cue = new THREE.Mesh(new THREE.RingGeometry(1.05, 1.2, 64).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide }));
  private timer = 1.5;

  constructor(parent: THREE.Group) {
    this.cue.name = 'Sentinel attack warning';
    parent.add(this.cue);
    this.cue.visible = false;
  }
  reset(): void {
    this.cancel(); this.hits = 0; this.dodges = 0; this.health = 100; this.hurtTime = 0;
  }
  cancel(): void {
    this.phase = 'ready'; this.timer = 1.5;
    this.dodgeTime = 0; this.cooldown = 0; this.cue.visible = false;
  }
  dodge(motion: THREE.Vector3): boolean {
    if (this.defeated || this.cooldown > 0) return false;
    this.direction.copy(motion); this.direction.y = 0;
    if (this.direction.lengthSq() < 0.001) this.direction.set(0, 0, 1);
    this.direction.normalize(); this.dodgeTime = 0.28; this.cooldown = 0.9;
    return true;
  }
  update(dt: number, player: THREE.Vector3, enemy: THREE.Vector3, alive: boolean): void {
    // Substeps keep the dodge window and impact ordering independent of frame length.
    let remaining = dt;
    while (remaining > 0) {
      const h = Math.min(remaining, 1 / 120); remaining -= h;
      this.dodgeTime = Math.max(0, this.dodgeTime - h);
      this.cooldown = Math.max(0, this.cooldown - h);
      this.hurtTime = Math.max(0, this.hurtTime - h);
      if (this.defeated || !alive || !roomContains(player.x, player.z)) {
        this.phase = 'ready'; this.timer = 1.5; this.cue.visible = false; continue;
      }
      if (this.phase === 'ready' && Math.hypot(player.x - enemy.x, player.z - enemy.z) > 4.5) continue;
      this.timer -= h;
      if (this.timer > 0) continue;
      if (this.phase === 'ready') {
        this.target.copy(player); this.phase = 'warning'; this.timer = 0.85;
        const vertices = this.cue.geometry.attributes.position!;
        for (let i = 0; i < vertices.count; i++) {
          const x = vertices.getX(i), z = vertices.getZ(i);
          vertices.setY(i, demoTerrain.sample(this.target.x + x, this.target.z + z) + 0.08);
        }
        vertices.needsUpdate = true; this.cue.geometry.computeBoundingSphere();
        this.cue.position.set(this.target.x, 0, this.target.z);
      } else if (this.phase === 'warning') {
        if (Math.hypot(player.x - this.target.x, player.z - this.target.z) <= 1.42) {
          if (this.dodgeTime > 0) this.dodges++;
          else {
            this.hits++; this.health = Math.max(0, this.health - 25); this.hurtTime = 0.3;
            if (this.defeated) { this.cancel(); continue; }
          }
        }
        this.phase = 'recovery'; this.timer = 1.4;
      } else { this.phase = 'ready'; this.timer = 0.75; }
    }
    this.cue.visible = this.phase === 'warning' || (this.phase === 'recovery' && this.timer > 1.2);
    this.cue.material.color.set(this.phase === 'warning' ? 0xffb347 : 0xff5544);
    this.cue.material.opacity = this.phase === 'warning' ? 0.35 + 0.55 * (1 - this.timer / 0.85) : 0.8;
  }
}
