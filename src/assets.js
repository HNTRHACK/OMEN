import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

// Loads the Blender-made GLBs and swaps their materials for two-tone toon shading.

const base = import.meta.env.BASE_URL;
const draco = new DRACOLoader().setDecoderPath(`${base}draco/`);
const loader = new GLTFLoader().setDRACOLoader(draco);

export const grad = new THREE.DataTexture(new Uint8Array([140, 140, 140, 255, 255, 255, 255, 255]), 2, 1, THREE.RGBAFormat);
grad.minFilter = grad.magFilter = THREE.NearestFilter;
grad.generateMipmaps = false;
grad.needsUpdate = true;

const toonCache = new Map();
export function toon(color, emissive = 0x000000, emissiveIntensity = 0) {
  const key = `${color}|${emissive}|${emissiveIntensity}`;
  if (!toonCache.has(key)) {
    toonCache.set(key, new THREE.MeshToonMaterial({ color, gradientMap: grad, emissive, emissiveIntensity }));
  }
  return toonCache.get(key);
}

function toToon(m) {
  const glow = m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b > 0.05);
  const mat = new THREE.MeshToonMaterial({
    color: m.color.clone(),
    gradientMap: grad,
    emissive: glow ? m.emissive.clone() : new THREE.Color(0),
    emissiveIntensity: glow ? 1.15 : 0,
  });
  mat.name = m.name;
  return mat;
}

const scenes = new Map();

export async function loadAll(names, onProgress) {
  let done = 0;
  await Promise.all(
    names.map(async (n) => {
      const gltf = await loader.loadAsync(`${base}models/${n}.glb`);
      const matMap = new Map();
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        const swap = (m) => {
          if (!matMap.has(m)) matMap.set(m, toToon(m));
          return matMap.get(m);
        };
        o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
        o.castShadow = true;
        o.receiveShadow = true;
      });
      scenes.set(n, gltf.scene);
      onProgress?.(++done / names.length);
    }),
  );
}

/** A fresh copy of a model (materials are shared unless `uniqueMaterials`). */
export function model(name, { uniqueMaterials = false } = {}) {
  const src = scenes.get(name);
  if (!src) throw new Error(`model ${name} not loaded`);
  const o = src.clone(true);
  if (uniqueMaterials) o.traverse((m) => m.isMesh && (m.material = Array.isArray(m.material) ? m.material.map((x) => x.clone()) : m.material.clone()));
  return o;
}

/**
 * Many copies of the same static model as InstancedMeshes (one per material primitive),
 * so a street of houses or a forest costs a handful of draw calls.
 */
export function instanced(name, matrices, { shadows = true } = {}) {
  const src = scenes.get(name);
  const group = new THREE.Group();
  group.name = `${name}×${matrices.length}`;
  src.updateMatrixWorld(true);
  src.traverse((o) => {
    if (!o.isMesh) return;
    const local = o.matrixWorld;
    const im = new THREE.InstancedMesh(o.geometry, o.material, matrices.length);
    matrices.forEach((m, i) => im.setMatrixAt(i, new THREE.Matrix4().multiplyMatrices(m, local)));
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = shadows;
    im.receiveShadow = true;
    im.computeBoundingSphere();
    group.add(im);
  });
  return group;
}
