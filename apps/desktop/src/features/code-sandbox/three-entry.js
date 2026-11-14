// The classic-script bundle of three.js the background sandbox loads: three's own exports plus a
// fixed set of addons, which a background module reaches as THREE.addons.X. Everything is bundled
// at build time; nothing in it loads from a URL or the file system.
export * from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const addons = Object.freeze({
  RoomEnvironment,
  RoundedBoxGeometry,
  EffectComposer,
  RenderPass,
  UnrealBloomPass,
  OutputPass,
});
