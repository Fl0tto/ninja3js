import * as THREE from 'three/webgpu';
import { GroundFlowVolume } from './GroundFlowVolume';
import { demoTerrain } from './TerrainHeight';

/** Matching scene lights and explicit fog-scattering inputs for controlled A/B. */
export class FogLightingLab {
  freeze = false;
  private mode = 'both';
  private intensity = 2;
  private shift = 0;
  private affectFog = true;
  private affectSurfaces = true;
  private steps: 24 | 48 | 96 = 48;
  private dither = true;
  private readonly lamps: Array<{light:THREE.PointLight; orb:THREE.Mesh; tint:THREE.Color}> = [];
  private readonly flash = new THREE.PointLight(0xffbc79,0,7,2);
  private flashRemaining = 0;
  private flashStrength = 0;
  readonly root = document.createElement('details');

  constructor(scene:THREE.Scene) {
    for(const hex of [0xff7e39,0x55adff]) {
      const tint = new THREE.Color(hex);
      const light = new THREE.PointLight(hex,0,6,2);
      const orb = new THREE.Mesh(new THREE.SphereGeometry(0.075,12,8),new THREE.MeshBasicMaterial({color:tint}));
      scene.add(light,orb);
      this.lamps.push({light,orb,tint});
    }
    scene.add(this.flash);
    this.root.className='fog-light-lab';
    this.root.open=true;
    this.root.innerHTML=`<summary>Fog &amp; colored lights</summary>
      <label>Sampling<select data-fog="quality"><option value="24">Fast · 24</option><option value="48" selected>Balanced · 48</option><option value="96">Reference · 96</option></select></label>
      <label><input data-fog="dither" type="checkbox" checked> Break up sample bands</label>
      <label>Local lights<select data-fog="lights"><option value="off">Off</option><option value="warm">Amber</option><option value="cool">Blue</option><option value="both" selected>Amber + blue</option></select></label>
      <label>Brightness<input data-fog="brightness" type="range" min="0" max="4" step="0.1" value="2"></label>
      <label>Move lights<input data-fog="position" type="range" min="-3" max="3" step="0.1" value="0"></label>
      <label><input data-fog="scatter" type="checkbox" checked> Illuminate mist</label>
      <label><input data-fog="surfaces" type="checkbox" checked> Illuminate surfaces</label>
      <label><input data-fog="freeze" type="checkbox"> Freeze scene for light comparison</label>`;
    document.querySelector('[data-controls="simulation"]')!.before(this.root);
    const bind = (name:string, callback:(input:HTMLInputElement)=>void) => {
      this.root.querySelector(`[data-fog="${name}"]`)!.addEventListener('input',event=>callback(event.target as HTMLInputElement));
    };
    bind('quality',input=>this.steps=Number(input.value) as 24|48|96);
    bind('dither',input=>this.dither=input.checked);
    bind('lights',input=>this.mode=input.value);
    bind('brightness',input=>this.intensity=Number(input.value));
    bind('position',input=>this.shift=Number(input.value));
    bind('scatter',input=>this.affectFog=input.checked);
    bind('surfaces',input=>this.affectSurfaces=input.checked);
    bind('freeze',input=>this.freeze=input.checked);
  }

  attack(position:THREE.Vector3, powerful:boolean):void {
    this.flash.position.copy(position).y+=0.7;
    this.flashRemaining=0.45;
    this.flashStrength=powerful?5:1.8;
  }
  reset():void {this.flashRemaining=0;}

  sync(volume:GroundFlowVolume,dt:number,advance:boolean):void {
    volume.setFogSampling(this.steps,this.dither);
    this.lamps.forEach((lamp,index)=>{
      const enabled=this.mode==='both'||this.mode===(index===0?'warm':'cool');
      const x=(index===0?-2.5:2.5)+this.shift;
      const z=index===0?-1.5:-2.5;
      lamp.light.position.set(x,demoTerrain.sample(x,z)+0.65,z);
      lamp.orb.position.copy(lamp.light.position);
      lamp.orb.visible=enabled&&this.intensity>0;
      lamp.light.intensity=enabled&&this.affectSurfaces?this.intensity*12:0;
      volume.setPointLight(index,lamp.light.position,lamp.tint,enabled&&this.affectFog?this.intensity*0.85:0,6);
    });
    if(advance) this.flashRemaining=Math.max(0,this.flashRemaining-dt);
    const strength=this.flashStrength*(this.flashRemaining/0.45)**2;
    this.flash.intensity=this.affectSurfaces?strength*12:0;
    volume.setPointLight(2,this.flash.position,this.flash.color,this.affectFog?strength:0,7);
  }
}
