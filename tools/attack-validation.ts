import * as THREE from 'three/webgpu';
import { EncounterScene } from '../src/EncounterScene';
import { attackEnvelope } from '../src/AttackEnvelope';

export function validateAttacks() {
  const assert = (ok: boolean, message: string) => {if (!ok) throw new Error(message);};
  for (const [radius, duration] of [[2.5, 0.24], [5.2, 0.42]]) {
    let previous = 0;
    for (let i = 0; i <= 100; i++) {
      const sample = attackEnvelope(radius!, duration!, duration! * i / 100);
      assert(sample.radius >= previous && sample.radius <= radius!, 'Burst radius must expand without overshooting');
      assert(sample.strength >= 0, 'Burst strength cannot reverse');
      previous = sample.radius;
    }
    assert(attackEnvelope(radius!, duration!, duration!).strength === 0, 'Burst must release completely');
  }
  const encounter = new EncounterScene(new THREE.Scene(), () => {}, () => {});
  encounter.controls.remove();
  const position = new THREE.Vector3(0, 0, -2.3);
  const step = (count: number) => {for (let i = 0; i < count; i++) encounter.update(1 / 120);};
  try {
    encounter.attack({position, radius: 2.5, impulse: 4, duration: 0.24});
    step(1);
    assert(encounter.maxTreeBend === 0, 'Distant trees must wait for the travelling burst');
    step(23);
    const modest = encounter.maxTreeBend;
    assert(modest > 0, 'Trees must react when reached');
    encounter.reset();
    encounter.attack({position, radius: 5.2, impulse: 10, duration: 0.42});
    encounter.powerful = false;
    step(24);
    const powerful = encounter.maxTreeBend;
    assert(powerful > modest * 2, 'Powerful recoil must be clearly stronger');
    step(600);
    assert(encounter.maxTreeBend < 0.001, 'Trees must recover instead of accumulating repeated impulses');
    for (let i = 0; i < 9; i++) encounter.attack({position, radius: 5.2, impulse: 10, duration: 0.42});
    assert((encounter as any).rings.length === 5, 'Attack cues must remain bounded');
    encounter.reset();
    step(60);
    assert(encounter.maxTreeBend === 0 && (encounter as any).rings.length === 0, 'Reset must discard pending recoil');
    return {modest, powerful, timing: 'arrival, recovery, radius bounds and reset passed'};
  } finally {
    encounter.reset();
    encounter.group.traverse(object => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      if (Array.isArray(mesh.material)) mesh.material.forEach(material => material.dispose());
      else mesh.material?.dispose();
    });
    encounter.group.removeFromParent();
  }
}
