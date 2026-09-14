import * as THREE from 'three/webgpu';
import { demoTerrain } from './TerrainHeight';
import { ROOM } from './DungeonLayout';

/** Resettable sentinel body and damage response; TrainingCombat owns attacks. */
export class TrainingEnemy {
  readonly group=new THREE.Group();
  readonly home=new THREE.Vector3(0,0,-2.9);
  health=100;
  hits=0;
  lastDamage=0;
  private respawn=0;
  private flash=0;
  private readonly velocity=new THREE.Vector2();
  private readonly armor=new THREE.MeshStandardMaterial({color:0x7d4945,roughness:0.52,metalness:0.4});
  private readonly body=new THREE.Group();
  constructor(parent:THREE.Group) {
    this.group.name='Training sentinel';
    this.group.add(this.body);
    const torso=new THREE.Mesh(new THREE.CylinderGeometry(0.28,0.38,0.85,6),this.armor);
    torso.position.y=0.95;
    const head=new THREE.Mesh(new THREE.IcosahedronGeometry(0.25,1),this.armor);
    head.position.y=1.6;
    const visor=new THREE.Mesh(new THREE.BoxGeometry(0.32,0.06,0.12),new THREE.MeshBasicMaterial({color:0xffc877}));
    visor.position.set(0,1.62,0.2);
    this.body.add(torso,head,visor);
    for(const x of [-0.19,0.19]) {
      const leg=new THREE.Mesh(new THREE.CylinderGeometry(0.09,0.12,0.55,6),this.armor);
      leg.position.set(x,0.32,0);this.body.add(leg);
      const shoulder=new THREE.Mesh(new THREE.IcosahedronGeometry(0.2,0),this.armor);
      shoulder.position.set(x*2,1.3,0);this.body.add(shoulder);
    }
    const base=new THREE.Mesh(new THREE.CylinderGeometry(0.65,0.7,0.06,32),new THREE.MeshStandardMaterial({color:0x414852,roughness:0.9}));
    base.position.y=0.02;this.group.add(base);
    parent.add(this.group);this.reset();
  }
  reset():void {
    this.health=100;this.hits=0;this.lastDamage=0;this.respawn=0;this.flash=0;
    this.velocity.set(0,0);this.group.position.copy(this.home);
    this.group.position.y=demoTerrain.sample(this.home.x,this.home.z);
    this.body.rotation.set(0,0,0);this.body.scale.setScalar(1);this.armor.emissive.set(0);
  }
  hit(impulse:number,direction:THREE.Vector2):void {
    if(this.health<=0) return;
    this.lastDamage=impulse>4?42:18;
    this.health=Math.max(0,this.health-this.lastDamage);this.hits++;this.flash=0.22;
    this.velocity.addScaledVector(direction,impulse>4?2.4:0.9).clampLength(0,3);
    if(this.health===0) this.respawn=3;
  }
  update(dt:number):void {
    this.flash=Math.max(0,this.flash-dt);
    this.armor.emissive.setRGB(this.flash*3,this.flash*1.1,this.flash*0.3);
    const steps=Math.max(1,Math.ceil(dt/(1/120))),h=dt/steps;
    for(let i=0;i<steps;i++) {
      this.velocity.x+=(this.home.x-this.group.position.x)*12*h;
      this.velocity.y+=(this.home.z-this.group.position.z)*12*h;
      this.velocity.multiplyScalar(Math.exp(-5*h));
      this.group.position.x=THREE.MathUtils.clamp(this.group.position.x+this.velocity.x*h,ROOM.left+0.7,ROOM.right-0.7);
      this.group.position.z=THREE.MathUtils.clamp(this.group.position.z+this.velocity.y*h,ROOM.back+0.7,ROOM.front-0.7);
    }
    this.group.position.y=demoTerrain.sample(this.group.position.x,this.group.position.z);
    this.body.rotation.x=this.health===0?1.15:THREE.MathUtils.clamp(this.velocity.y*0.16,-0.3,0.3);
    this.body.rotation.z=THREE.MathUtils.clamp(-this.velocity.x*0.16,-0.3,0.3);
    if(this.health===0) {this.respawn-=dt;if(this.respawn<=0)this.reset();}
  }
}
