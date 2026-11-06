// Selfie → avatar mapping (src/selfie-map.js) and the face schema (shared/face.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { measure, mapFace, mapColours, quality, report, bucket, LM } from "../src/selfie-map.js";
import { FACE_OPTIONS, FACE_KEYS, DEFAULT_FACE, cleanFace } from "../shared/face.js";

/** A synthetic 478-point face: a symmetric frontal layout with a few features we can vary. */
function face({ cheek = 0.3, top = 0.27, chin = 0.65, jaw = 0.25, chinW = 0.135, alar = 0.075, mouth = 0.14, eyeGap = 0.07 } = {}) {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.45, z: 0 }));
  const set = (i, x, y, z = 0) => (lm[i] = { x, y, z });
  set(LM.top, 0.5, top);
  set(LM.chin, 0.5, chin);
  set(LM.cheekL, 0.5 - cheek / 2, 0.42);
  set(LM.cheekR, 0.5 + cheek / 2, 0.42);
  set(LM.jawL, 0.5 - jaw / 2, 0.56);
  set(LM.jawR, 0.5 + jaw / 2, 0.56);
  set(LM.chinL, 0.5 - chinW / 2, 0.62);
  set(LM.chinR, 0.5 + chinW / 2, 0.62);
  set(LM.eyeLi, 0.5 - eyeGap / 2, 0.38);
  set(LM.eyeRi, 0.5 + eyeGap / 2, 0.38);
  set(LM.eyeLo, 0.5 - eyeGap / 2 - 0.06, 0.38);
  set(LM.eyeRo, 0.5 + eyeGap / 2 + 0.06, 0.38);
  set(LM.eyeLt, 0.42, 0.37);
  set(LM.eyeLb, 0.42, 0.39);
  set(LM.eyeRt, 0.58, 0.37);
  set(LM.eyeRb, 0.58, 0.39);
  LM.browL.forEach((i, k) => set(i, 0.36 + k * 0.025, 0.33 - Math.sin((k / 4) * Math.PI) * 0.006));
  LM.browR.forEach((i, k) => set(i, 0.54 + k * 0.025, 0.33 - Math.sin((k / 4) * Math.PI) * 0.006));
  set(LM.noseTop, 0.5, 0.38);
  set(LM.noseTip, 0.5, 0.47, -0.05);
  set(LM.noseBottom, 0.5, 0.5);
  set(LM.alarL, 0.5 - alar / 2, 0.49);
  set(LM.alarR, 0.5 + alar / 2, 0.49);
  set(LM.mouthL, 0.5 - mouth / 2, 0.55);
  set(LM.mouthR, 0.5 + mouth / 2, 0.55);
  set(LM.lipTop, 0.5, 0.545);
  set(LM.lipTopIn, 0.5, 0.555);
  set(LM.lipBotIn, 0.5, 0.56);
  set(LM.lipBot, 0.5, 0.575);
  return lm;
}
const map = (o) => mapFace(measure(face(o), 640, 640));

test("the face schema: in-range integers only; the default face is the original courier", () => {
  assert.equal(cleanFace(null), null);
  const f = cleanFace({ jaw: 99, nose: -1, eyeSize: "2", extra: "x", hairStyle: 3.7 });
  assert.deepEqual(Object.keys(f), FACE_KEYS, "nothing extra survives");
  assert.equal(f.jaw, DEFAULT_FACE.jaw, "out of range → default");
  assert.equal(f.nose, DEFAULT_FACE.nose);
  assert.equal(f.eyeSize, 2);
  assert.equal(f.hairStyle, 3);
  assert.equal(FACE_OPTIONS.headWidth[DEFAULT_FACE.headWidth].v, 1);
  assert.equal(FACE_OPTIONS.eyeSize[DEFAULT_FACE.eyeSize].v, 1);
  assert.deepEqual(FACE_OPTIONS.nose[DEFAULT_FACE.nose].s, [1, 1, 1]);
  assert.equal(FACE_OPTIONS.mouth[DEFAULT_FACE.mouth].name, "None", "the original courier has no mouth");
});

test("mapping follows the photo: wider nose, wider mouth, narrower jaw and longer face all move their options", () => {
  const base = map();
  assert.ok(map({ alar: 0.105 }).nose === 4, "a wide nose maps to Wide");
  assert.ok(map({ mouth: 0.165 }).mouth > base.mouth, "a wider mouth maps to a wider smile");
  assert.ok([3, 4].includes(map({ jaw: 0.21, chinW: 0.1 }).jaw), "a narrow jaw maps to tapered/pointed");
  assert.equal(map({ jaw: 0.28 }).jaw, 2, "a wide jaw maps to square");
  assert.ok(map({ top: 0.2 }).headLength > base.headLength, "a longer face maps to a longer head");
  assert.ok(map({ eyeGap: 0.095 }).eyeSpacing > base.eyeSpacing, "wider-set eyes map apart");
  for (const k of FACE_KEYS) assert.ok(base[k] >= 0 && base[k] < FACE_OPTIONS[k].length, `${k} in range`);
  assert.equal(base.facialHair, 0, "facial hair is never inferred");
  assert.equal(base.glasses, 0, "glasses are never inferred");
});

test("colours: nearest swatch; no hair suggestion when the sample is skin; long hair only when the jaw-side sample is hair", () => {
  const a = mapColours({ skin: [216, 154, 115], hair: [112, 79, 57], iris: [41, 25, 21], besideJaw: [40, 29, 23] });
  assert.deepEqual(a, { skin: 1, hair: 1, eyeColor: 0, longHair: true });
  const bald = mapColours({ skin: [195, 133, 101], hair: [201, 136, 101], iris: [48, 40, 38], besideJaw: [230, 230, 230] });
  assert.equal(bald.hair, undefined, "a forehead that reads as skin suggests no hair colour");
  assert.equal(bald.longHair, undefined);
  const shortDark = mapColours({ skin: [216, 154, 115], hair: [40, 30, 28], besideJaw: [235, 235, 235] });
  assert.equal(shortDark.longHair, undefined, "a light background beside the jaw is not long hair");
});

test("quality: no face, many faces, small, turned, dark, blurry are reported plainly", () => {
  assert.equal(quality({ faces: 0 }).ok, false);
  assert.match(quality({ faces: 2 }).issues[0], /More than one face/);
  const q = quality({ faces: 1, faceW: 100, imageW: 640, yaw: 0.4, brightness: 30, sharpness: 5 });
  assert.equal(q.ok, true);
  assert.equal(q.issues.length, 4);
  assert.deepEqual(quality({ faces: 1, faceW: 300, imageW: 640, yaw: 0.05, brightness: 140, sharpness: 300 }).issues, []);
});

test("the report never claims what a single photo can't show", () => {
  const r = report(map(), {});
  assert.ok(r.notDetected.some((x) => /ears/.test(x)));
  assert.ok(r.notDetected.includes("facial hair") && r.notDetected.includes("glasses"));
  assert.ok(r.notDetected.includes("hair colour"));
  assert.equal(bucket(5, [1, 2, 3]), 3);
  assert.equal(bucket(0, [1, 2, 3]), 0);
});
