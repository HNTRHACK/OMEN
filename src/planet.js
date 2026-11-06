import * as THREE from "three";
import { P, R } from "./palette.js";
import { NOISE } from "./noise.glsl.js";

// ------------------------------------------------------------------ the map → sphere projection
// Blockhaven is laid out in metres on a flat map centred on the planet's north pole, then wrapped
// onto the sphere (azimuthal equidistant), so distances along the ground stay true.

const UP = new THREE.Vector3(0, 1, 0);

export function mapDir(x, z) {
  const d = Math.hypot(x, z);
  if (d < 1e-6) return UP.clone();
  const t = d / R;
  return new THREE.Vector3((Math.sin(t) * x) / d, Math.cos(t), (Math.sin(t) * z) / d);
}

export function mapPos(x, z, lift = 0) {
  return mapDir(x, z).multiplyScalar(R + lift);
}

/** Tangent at `dir` pointing toward `target` direction. */
export function tangentToward(dir, target) {
  const t = target.clone().sub(dir.clone().multiplyScalar(target.dot(dir)));
  if (t.lengthSq() < 1e-10) return new THREE.Vector3(1, 0, 0).sub(dir.clone().multiplyScalar(dir.x)).normalize();
  return t.normalize();
}

/** Matrix standing an object on the planet at `dir`, its +Z facing tangent `fwd`. */
export function surfaceMatrix(dir, fwd, scale = 1, lift = 0) {
  const right = new THREE.Vector3().crossVectors(dir, fwd).normalize();
  const f = new THREE.Vector3().crossVectors(right, dir).normalize();
  const m = new THREE.Matrix4().makeBasis(right, dir, f);
  m.scale(new THREE.Vector3(scale, scale, scale));
  m.setPosition(dir.clone().multiplyScalar(R + lift));
  return m;
}

/** Same, from map coordinates: object at (x,z) facing map point (fx,fz). */
export function mapMatrix(x, z, fx, fz, scale = 1) {
  const dir = mapDir(x, z);
  return surfaceMatrix(dir, tangentToward(dir, mapDir(fx, fz)), scale);
}

export function placeMap(obj, x, z, fx, fz, scale = 1) {
  mapMatrix(x, z, fx, fz, scale).decompose(obj.position, obj.quaternion, obj.scale);
  return obj;
}

// ------------------------------------------------------------------ paths

/** Smooth a polyline (Catmull–Rom) and resample it every ~`step` metres. */
export function smoothPath(points, step = 1.6) {
  const curve = new THREE.CatmullRomCurve3(points.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, "centripetal");
  const n = Math.max(2, Math.ceil(curve.getLength() / step));
  return curve.getSpacedPoints(n).map((v) => [v.x, v.z]);
}

export const MAX_SEGMENTS = 120;

// ------------------------------------------------------------------ planet

const col = (h) => new THREE.Color(h);

export function makePlanet(segments, areas, gradientMap) {
  const A = [];
  const B = [];
  for (const [a, b] of segments.slice(0, MAX_SEGMENTS)) {
    A.push(mapDir(a[0], a[1]));
    B.push(mapDir(b[0], b[1]));
  }
  while (A.length < MAX_SEGMENTS) {
    A.push(new THREE.Vector3(0, -1, 0));
    B.push(new THREE.Vector3(0, -1, 0));
  }
  const areaDirs = areas.map((a) => mapDir(a[0], a[1]));
  const areaRad = areas.map((a) => a[2] / R);
  while (areaDirs.length < 12) {
    areaDirs.push(new THREE.Vector3(0, -1, 0));
    areaRad.push(0);
  }

  // A normal toon material (so lights + shadows just work) with the ground pattern injected.
  const mat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap });
  const uniforms = {
    uA: { value: A },
    uB: { value: B },
    uAreas: { value: areaDirs },
    uAreaR: { value: areaRad },
    uHalf: { value: 1.45 / R },
    uGrass: { value: col(P.grass) },
    uGrassDark: { value: col(P.grassDark) },
    uMeadow: { value: col(P.meadow) },
    uCobble: { value: col(P.cobble) },
    uCobbleDark: { value: col(P.cobbleDark) },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vDirP;\nvarying vec3 vWorldP;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvDirP = normalize(position);\nvWorldP = (modelMatrix * vec4(position, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        ${NOISE}
        varying vec3 vDirP;
        varying vec3 vWorldP;
        uniform vec3 uA[${MAX_SEGMENTS}];
        uniform vec3 uB[${MAX_SEGMENTS}];
        uniform vec3 uAreas[12];
        uniform float uAreaR[12];
        uniform float uHalf;
        uniform vec3 uGrass, uGrassDark, uMeadow, uCobble, uCobbleDark;
        float segDist(vec3 p, vec3 a, vec3 b){
          vec3 ab = b - a;
          float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0);
          return length(p - (a + ab * t));
        }
        vec2 cells(vec3 p){
          vec3 i = floor(p); vec3 f = fract(p);
          float d1 = 8.0, d2 = 8.0;
          for (int x=-1;x<=1;x++) for (int y=-1;y<=1;y++) for (int z=-1;z<=1;z++){
            vec3 g = vec3(float(x),float(y),float(z));
            vec3 o = fract(sin(vec3(dot(i+g,vec3(127.1,311.7,74.7)),dot(i+g,vec3(269.5,183.3,246.1)),dot(i+g,vec3(113.5,271.9,124.6))))*43758.5453);
            float d = length(g + o - f);
            if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
          }
          return vec2(d1, d2);
        }
        vec3 groundColor(){
          vec3 d = normalize(vDirP);
          float n1 = snoise(d*4.0) + 0.5*snoise(d*9.0);
          float n2 = snoise(d*6.0 + 7.0);
          vec3 c = uGrass;
          if (n1 > 0.3) c = uGrassDark;
          if (n2 > 0.55) c = uMeadow;
          float dist = 10.0;
          for (int i=0;i<${MAX_SEGMENTS};i++){
            if (uA[i].y < -0.99) break;
            dist = min(dist, segDist(d, uA[i], uB[i]));
          }
          float edge = uHalf + 0.004*snoise(d*40.0);
          bool paved = dist < edge;
          for (int i=0;i<12;i++){
            if (uAreaR[i] <= 0.0) continue;
            float a = acos(clamp(dot(d, uAreas[i]), -1.0, 1.0));
            if (a < uAreaR[i] + 0.003*snoise(d*40.0)) paved = true;
          }
          if (paved) {
            // smaller, rounder setts with soft light mortar and a little colour variety
            vec2 v = cells(vWorldP * 3.4);
            float mortar = smoothstep(0.04, 0.16, v.y - v.x);
            float tone = fract(sin(dot(floor(vWorldP*3.4 + 0.5), vec3(12.9898,78.233,37.719)))*43758.5453);
            vec3 stone = mix(uCobble, uCobbleDark, step(0.7, tone) * 0.55);
            stone = mix(stone, stone * 1.06, step(0.85, 1.0 - v.x));
            c = mix(mix(uCobble, uCobbleDark, 0.45), stone, mortar);
          } else if (dist < edge + 0.012) {
            c = mix(c, uCobbleDark, 0.55);
          }
          return c;
        }`,
      )
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb = groundColor();");
  };
  const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(R, 48), mat);
  mesh.receiveShadow = true;
  mesh.name = "planet";
  return mesh;
}

export function makeSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uLow: { value: col(P.skyLow) },
      uHigh: { value: col(P.skyHigh) },
      uCloud: { value: col(P.cloud) },
      uUp: { value: new THREE.Vector3(0, 1, 0) },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      ${NOISE}
      uniform vec3 uLow, uHigh, uCloud, uUp; uniform float uTime;
      varying vec3 vDir;
      void main(){
        vec3 d = normalize(vDir);
        float h = dot(d, normalize(uUp));
        // banded gradient (a few flat steps, like painted sky) rather than a smooth ramp
        float b = floor(clamp(h * 0.5 + 0.55, 0.0, 1.0) * 5.0) / 5.0;
        vec3 c = mix(uLow, uHigh, b);
        vec3 p = d * vec3(1.6, 2.6, 1.6) + vec3(uTime * 0.003, 0.0, 0.0);
        float n = snoise(p*1.3) + 0.55*snoise(p*3.4) + 0.25*snoise(p*8.0);
        if (n > 0.62) c = uCloud;
        else if (n > 0.55) c = mix(c, uCloud, 0.45);
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(900, 48, 24), mat);
  m.name = "sky";
  return m;
}
