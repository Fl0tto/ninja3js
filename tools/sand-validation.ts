import * as THREE from 'three/webgpu';
import { demoTerrain, intersectTerrain } from '../src/TerrainHeight';
import { GroundResponseField } from '../src/GroundResponseField';

/** Browser-only diagnostic. Readback exists only here, never in the demo loop. */
export async function validateSand() {
  const renderer = new THREE.WebGPURenderer();
  await renderer.init();
  const n = 32;
  const field = new GroundResponseField(renderer, {kind:'sand',resolution:n,width:4,depth:4});
  const read = async () => {
    const buffer = await (renderer.backend as any).copyTextureToBuffer(field.fields[field.currentIndex],0,0,n,n);
    return new Float32Array(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, n*n*4);
  };
  const stats = (data:Float32Array) => {
    let mass=0,lowest=Infinity,highest=-Infinity,centroid=0;
    for(let i=0;i<n*n;i++) {
      const height=data[i*4]!;
      if(!Number.isFinite(height)) throw new Error('Non-finite sand height');
      mass+=height+0.12;lowest=Math.min(lowest,height);highest=Math.max(highest,height);
      centroid+=(height+0.12)*(i%n);
    }
    return {mass,lowest,highest,centroid:centroid/mass};
  };
  const step = (count:number) => {for(let i=0;i<count;i++)field.update(1/60,true);};
  const assert = (ok:boolean,message:string) => {if(!ok)throw new Error(message);};
  try {
    step(1);
    const baseline=stats(await read());
    field.setStamp(0,new THREE.Vector2(0.5,0.5),0.18,1,new THREE.Vector2(2,0));
    step(120);
    const contact=stats(await read());
    assert(Math.abs(contact.mass-baseline.mass)<0.0001,'Contact changes sand mass');
    assert(contact.lowest < -0.005 && contact.highest > 0.001,'Contact must excavate and build a rim');
    assert(contact.lowest >= -0.120001,'Excavation exceeds available layer');
    field.clearStamp(0);
    field.setWind(new THREE.Vector2(2,0));
    step(120);
    const wind=stats(await read());
    assert(Math.abs(wind.mass-baseline.mass)<0.0001,'Wind or settling changes sand mass');
    assert(wind.centroid > contact.centroid+0.001,'Positive X wind must transport sand in positive X');
    field.setWind(new THREE.Vector2());
    field.setDeposit(0,new THREE.Vector2(0.3,0.4),0.1,1);
    step(30);
    const deposited=stats(await read());
    assert(deposited.mass>wind.mass,'Deposit must add mass');
    field.clearDeposit(0);
    const before=await read();
    field.scroll(new THREE.Vector2(3,-2));
    field.update(0,false);
    const after=await read();
    for(let y=0;y<n;y++)for(let x=0;x<n;x++) {
      const sx=x+3,sy=y-2;
      const expected=sx<n&&sy>=0?before[(sy*n+sx)*4]!:0;
      assert(Math.abs(after[(y*n+x)*4]!-expected)<1e-7,'Scroll must retain exact world-space height');
    }
    const slope = new GroundResponseField(renderer, {kind:'sand',resolution:n,width:4,depth:4,
      terrain: {sample: (x) => x, node: xz => xz.x}});
    let slopeResult;
    try {
      slope.setWorldCenter(new THREE.Vector2(20, -12));
      for(let i=0;i<120;i++) slope.update(1/60,true);
      const buffer = await (renderer.backend as any).copyTextureToBuffer(slope.fields[slope.currentIndex],0,0,n,n);
      slopeResult = stats(new Float32Array(buffer.buffer ?? buffer, buffer.byteOffset ?? 0,n*n*4));
      assert(Math.abs(slopeResult.mass-baseline.mass)<0.0001,'Terrain settling changes mass');
      assert(slopeResult.centroid < 15.4,'Terrain must drive sand downhill without wind or contacts');
      assert(slopeResult.lowest >= -0.120001,'Terrain settling exceeds mobile layer');
    } finally {slope.dispose();}
    const hit = new THREE.Vector3();
    for(const [x,z] of [[0,0],[5,-8],[-22,35]]) {
      assert(intersectTerrain(new THREE.Ray(new THREE.Vector3(x!,10,z!),new THREE.Vector3(0,-1,0)),demoTerrain,hit),'Terrain ray missed');
      assert(Math.abs(hit.y-demoTerrain.sample(x!,z!))<0.00001,'Terrain pointer height mismatch');
    }
    assert(!intersectTerrain(new THREE.Ray(new THREE.Vector3(0,10,0),new THREE.Vector3(0,1,0)),demoTerrain,hit),'Upward ray must miss');
    return {baseline,contact,wind,deposited,scroll:'passed',slope:slopeResult,terrainPointer:'passed'};
  } finally {field.dispose();renderer.dispose();}
}
