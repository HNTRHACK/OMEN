import * as THREE from "three";
import { P } from "./palette.js";

// Ink outlines: render colour + depth, then normals, and run a Sobel filter over both.
// A tiny stepped noise offset on the sample position makes lines wobble like hand drawing.
export class InkPass {
  constructor(renderer) {
    this.renderer = renderer;
    const opts = { type: THREE.HalfFloatType };
    this.color = new THREE.WebGLRenderTarget(1, 1, opts);
    this.color.depthTexture = new THREE.DepthTexture(1, 1);
    this.normals = new THREE.WebGLRenderTarget(1, 1, opts);
    this.normalMat = new THREE.MeshNormalMaterial();

    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: this.color.texture },
        tDepth: { value: this.color.depthTexture },
        tNormal: { value: this.normals.texture },
        uRes: { value: new THREE.Vector2(1, 1) },
        uInk: { value: new THREE.Color(P.ink) },
        uNear: { value: 0.1 },
        uFar: { value: 2000 },
        uTime: { value: 0 },
        uThick: { value: 1.25 },
      },
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tColor, tDepth, tNormal;
        uniform vec2 uRes; uniform vec3 uInk; uniform float uNear, uFar, uTime, uThick;
        varying vec2 vUv;
        float lin(float z){ float n=uNear, f=uFar; return (2.0*n*f)/(f+n-(z*2.0-1.0)*(f-n)); }
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
        float depthAt(vec2 uv){ return lin(texture2D(tDepth, uv).r); }
        vec3 normAt(vec2 uv){ return texture2D(tNormal, uv).rgb; }
        void main(){
          // wobble: offset changes in steps (~6x per second), like redrawn frames
          float t = floor(uTime*6.0);
          vec2 cell = floor(vUv*uRes/24.0);
          vec2 wob = (vec2(hash(cell+t), hash(cell+t+7.3))-0.5) * 1.6 / uRes;
          vec2 uv = vUv + wob;
          vec2 px = uThick / uRes;
          float d = depthAt(uv);
          float dx = 0.0, dy = 0.0;
          vec3 nx = vec3(0.0), ny = vec3(0.0);
          for (int i=-1;i<=1;i++) for (int j=-1;j<=1;j++){
            vec2 o = vec2(float(i),float(j))*px;
            float kx = float(i) * (j==0 ? 2.0 : 1.0);
            float ky = float(j) * (i==0 ? 2.0 : 1.0);
            float s = depthAt(uv+o);
            vec3 n = normAt(uv+o);
            dx += s*kx; dy += s*ky; nx += n*kx; ny += n*ky;
          }
          float depthEdge = sqrt(dx*dx+dy*dy) / max(d, 1.0);
          float normalEdge = sqrt(dot(nx,nx)+dot(ny,ny));
          float edge = max(step(0.22, depthEdge), step(0.9, normalEdge));
          if (d > uFar*0.8) edge = 0.0; // never outline the sky
          vec3 col = texture2D(tColor, vUv).rgb;
          gl_FragColor = vec4(mix(col, uInk, edge*0.88), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
  }

  setSize(w, h, pr) {
    const W = Math.floor(w * pr);
    const H = Math.floor(h * pr);
    this.color.setSize(W, H);
    this.normals.setSize(W, H);
    this.material.uniforms.uRes.value.set(W, H);
    this.material.uniforms.uThick.value = Math.max(1, pr * 0.9);
  }

  render(scene, camera, time, hidden = []) {
    const r = this.renderer;
    this.material.uniforms.uNear.value = camera.near;
    this.material.uniforms.uFar.value = camera.far;
    this.material.uniforms.uTime.value = time;

    r.setRenderTarget(this.color);
    r.render(scene, camera);

    // Normal pass: hide the sky and anything that shouldn't be outlined.
    const bg = scene.background;
    scene.background = null;
    for (const o of hidden) o.visible = false;
    scene.overrideMaterial = this.normalMat;
    r.setRenderTarget(this.normals);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.render(scene, camera);
    scene.overrideMaterial = null;
    for (const o of hidden) o.visible = true;
    scene.background = bg;

    r.setRenderTarget(null);
    r.render(this.quadScene, this.quadCam);
  }
}
