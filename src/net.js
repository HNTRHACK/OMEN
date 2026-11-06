// Multiplayer client. Other couriers appear as real characters in the same Blockhaven, smoothly
// interpolated ~120 ms behind real time, with name tags and a small activity feed.
// Only movement, outfit, name and whitelisted interactions are shared. Never wallets or payments.
import * as THREE from "three";
import { io } from "socket.io-client";
import { R } from "./palette.js";
import { Character } from "./character.js";
import { applyLook, syncPet } from "./avatar.js";
import { guestToken } from "./identity.js";

const SEND_HZ = 12;
// Avatar level of detail, for rooms with many players. Near: full animation. Mid: animation at a
// third of the rate, no pet. Far: the character is hidden and drawn as one shared instanced
// stand-in (one draw call for every far player together).
export const LOD = { near: 28, far: 60 };
const MAX_PROXIES = 128;

/** Default placement: on the planet's surface. Other worlds (the expo hall) pass their own. */
export function planetPlace(group, d, f, h) {
  group.position.copy(d).multiplyScalar(R + h);
  group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(d, f), d, f));
}
const DELAY_MS = 120; // render remotes this far in the past, between two received snapshots
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const roomFromUrl = () => {
  const r = new URLSearchParams(location.search).get("room");
  return r && /^[a-z0-9][a-z0-9-]{2,23}$/.test(r.toLowerCase()) ? r.toLowerCase() : null;
};
export function newRoomCode() {
  const words = ["chai", "relay", "lantern", "courier", "kettle", "plaza", "lookout", "festival"];
  const w = words[crypto.getRandomValues(new Uint32Array(1))[0] % words.length];
  return `${w}-${Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => (b % 36).toString(36)).join("")}`;
}
export const inviteUrl = (room) => `${location.origin}${location.pathname}?room=${room}`;

class Remote {
  constructor(scene, p, place = planetPlace) {
    this.place = place;
    this.tier = "near";
    this.skip = 0;
    this.id = p.id;
    this.name = p.name;
    this.scene = scene;
    this.c = new Character("kai", { unique: true });
    scene.add(this.c.group);
    this.buf = []; // { t (local receive time), d, f, h, sp, air, talk, hold }
    this.frame = 0;
    this.tag = document.createElement("div");
    this.tag.className = "nametag";
    this.verified = p.verifiedHuman === true; // server-issued only (CONTRACT-WORLD-ID.md)
    document.body.append(this.tag);
    this.setLook(p.name, p.look);
    this.c.group.visible = false;
    if (p.s) this.push(p.s);
  }
  setLook(name, look) {
    this.name = name;
    applyLook(this.c, look);
    this.c.rig.traverse((m) => m.isMesh && m.material?.name === "teal" && (this.jacketHex = m.material.color.getHex()));
    syncPet(this.scene, this, this.c.look.pet);
    this.tag.innerHTML = `<span class="sw o${this.c.look.jacket}"></span>${esc(name)}${this.verified ? `<span class="vh" title="Verified human (World ID)" aria-label="verified human">✓</span>` : ""}`;
  }
  push(s) {
    this.buf.push({ ...s, t: performance.now() });
    if (this.buf.length > 30) this.buf.shift();
  }
  update(dt, t, camera) {
    const now = performance.now() - DELAY_MS;
    const b = this.buf;
    if (!b.length) return;
    let i = b.length - 1;
    while (i > 0 && b[i - 1].t > now) i--;
    const a = b[Math.max(0, i - 1)];
    const c = b[i];
    const k = c.t === a.t ? 1 : THREE.MathUtils.clamp((now - a.t) / (c.t - a.t), 0, 1);
    const d = new THREE.Vector3().fromArray(a.d).lerp(new THREE.Vector3().fromArray(c.d), k).normalize();
    const f = new THREE.Vector3().fromArray(a.f).lerp(new THREE.Vector3().fromArray(c.f), k);
    f.sub(d.clone().multiplyScalar(f.dot(d))).normalize();
    const h = a.h + (c.h - a.h) * k;
    const g = this.c.group;
    this.place(g, d, f, h);
    const dist = g.position.distanceTo(camera.position);
    this.tier = dist < LOD.near ? "near" : dist < LOD.far ? "mid" : "far";
    g.visible = this.tier !== "far";
    if (this.pet) this.pet.group.visible = this.tier === "near";
    this.c.speed = c.sp;
    this.c.air = c.air;
    this.c.talk = c.talk ? 1 : 0;
    this.c.holding = c.hold;
    if (this.tier === "near") this.c.update(dt, t);
    else if (this.tier === "mid") {
      this.skip += dt;
      if (++this.frame % 3 === 0) (this.c.update(this.skip, t), (this.skip = 0));
    }
    if (this.tier === "near") this.pet?.update(dt, g, c.sp);
    // name tag over the head, hidden behind the camera or far away
    const head = g.localToWorld(new THREE.Vector3(0, 2.25, 0));
    const v = head.clone().project(camera);
    const far = head.distanceTo(camera.position) > 45;
    if (v.z > 1 || far) this.tag.hidden = true;
    else {
      this.tag.hidden = false;
      this.tag.style.transform = `translate(${((v.x + 1) / 2) * innerWidth}px, ${((1 - v.y) / 2) * innerHeight}px) translate(-50%, -100%)`;
    }
  }
  remove(scene) {
    scene.remove(this.c.group);
    this.pet?.dispose();
    this.tag.remove();
  }
}

/**
 * @param o.scene, o.camera
 * @param o.local()  → { d, f, h, sp, air, talk, hold } for the local courier
 * @param o.feed(text) shows an activity line
 */
export function createNet({ scene, camera, local, feed, onCount = () => {}, place = planetPlace, worldName = "Blockhaven", onIdentityExpired = () => {} }) {
  // The far-LOD stand-ins: a capsule per far player, all in one InstancedMesh.
  const proxy = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.42, 1.1, 3, 8), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAX_PROXIES);
  proxy.count = 0;
  proxy.frustumCulled = false;
  proxy.name = "remote-proxies";
  scene.add(proxy);
  const pm = new THREE.Matrix4();
  const pc = new THREE.Color();
  let sock = null;
  let room = null;
  let me = null;
  const remotes = new Map();
  const handlers = [];
  let last = "";
  let sendT = 0;
  let beat = 0;
  const resumeKey = () => `omen.player.${room}`;

  const count = () => onCount({ room, online: remotes.size + 1, connected: !!sock?.connected });
  const add = (p) => {
    if (remotes.has(p.id) || p.id === me) return;
    remotes.set(p.id, new Remote(scene, p, place));
  };

  function join({ room: r, name, look }) {
    room = r;
    sock?.close();
    sock = io("/world", { transports: ["websocket", "polling"], reconnectionDelayMax: 4000 });
    const hello = () =>
      sock.emit("join", { room, name, look, token: guestToken() }, (res) => {
        if (res?.error) return feed(res.error);
        const resumed = res.id === me;
        me = res.id;
        try {
          sessionStorage.setItem(resumeKey(), me);
        } catch {
          /* ignore */
        }
        // after a reconnect, the server's list is the truth: drop anyone who left meanwhile
        const ids = new Set(res.players.map((p) => p.id));
        for (const [id, rm] of remotes) if (!ids.has(id)) (rm.remove(scene), remotes.delete(id));
        res.players.forEach(add);
        if (!resumed) feed(res.players.length ? `You joined ${res.players.length} other courier${res.players.length > 1 ? "s" : ""} in room ${room}` : room === "blockhaven" ? "You're the first courier in the public world right now." : `Room ${room} is open. Share the invite link!`);
        last = "";
        count();
      });
    sock.on("connect", hello);
    sock.on("disconnect", () => {
      feed("Connection lost, reconnecting…");
      count();
    });
    sock.on("joined", (p) => {
      add(p);
      feed(`${p.name} joined ${worldName}`);
      count();
    });
    sock.on("left", (p) => {
      remotes.get(p.id)?.remove(scene);
      remotes.delete(p.id);
      feed(`${p.name} left`);
      count();
    });
    sock.on("state", (s) => remotes.get(s.id)?.push(s));
    for (const [ev, fn] of handlers) sock.on(ev, fn); // app-level events (shops, forum, billboards)
    sock.on("look", (l) => remotes.get(l.id)?.setLook(l.name, l.look));
    // World ID accounts: saved profile changes and badge state come from the server
    sock.on("profile:update", (p) => {
      const rm = remotes.get(p.id);
      if (!rm) return;
      rm.verified = p.verifiedHuman === true;
      rm.setLook(p.name ?? rm.name, p.look ?? rm.c.look);
    });
    sock.on("identity:expired", () => {
      feed("Your World ID session expired. Sign in again from the avatar screen to keep your badge.");
      onIdentityExpired();
    });
    sock.on("replaced", () => {
      feed("You opened OMEN in another tab, so this one went quiet.");
      sock.io.opts.reconnection = false;
      sock.close();
      count();
    });
    sock.on("act", (a) => {
      const rm = remotes.get(a.id);
      if (!rm) return;
      const who = rm.name;
      const text = {
        talk: { maya: "is talking to Maya", orin: "is talking to Orin", echo: "is talking to the stranger", relay: "is examining Relay 03", board: "is reading the notice board", alfred: "is asking Alfred for advice" },
        scan: { "maya-chai": "is scanning Maya's QR", "orin-relay": "is scanning Orin's QR" },
        paid: { "maya-chai": "paid Maya", "orin-relay": "paid Orin" },
        coin: { btc: "found Bitcoin", eth: "found Ethereum", sol: "found Solana", usdt: "found Tether", usdc: "found USD Coin", wbt: "found WhiteBIT Coin" },
      }[a.kind]?.[a.target];
      if (a.kind === "paid" || a.kind === "cheer") rm.c.cheer = 1.2;
      if (a.kind === "wave") rm.c.wave = 1.2;
      if (text) feed(`${who} ${text}`);
    });
  }

  return {
    join,
    get room() {
      return room;
    },
    get online() {
      return remotes.size + 1;
    },
    remotes,
    /** How many remote players are drawn at each level of detail (for the perf overlay and tests). */
    lodStats() {
      const s = { near: 0, mid: 0, far: 0 };
      for (const r of remotes.values()) s[r.tier]++;
      return s;
    },
    /** Tell the room about a new look (avatar edits). */
    setLook(look) {
      if (sock?.connected) sock.emit("look", look);
    },
    /** Listen for a server event; survives reconnects and rejoins. */
    on(ev, fn) {
      handlers.push([ev, fn]);
      sock?.on(ev, fn);
    },
    emit(ev, data, ack) {
      if (sock?.connected) sock.emit(ev, data, ack);
      else ack?.({ error: "Not connected." });
    },
    get id() {
      return me;
    },
    get connected() {
      return !!sock?.connected;
    },
    act(kind, target = "") {
      if (sock?.connected) sock.emit("act", { kind, target });
    },
    update(dt, t) {
      let n = 0;
      for (const r of remotes.values()) {
        r.update(dt, t, camera);
        if (r.tier === "far" && r.buf.length && n < MAX_PROXIES) {
          const g = r.c.group;
          pm.compose(g.localToWorld(new THREE.Vector3(0, 0.98, 0)), g.quaternion, g.scale);
          proxy.setMatrixAt(n, pm);
          proxy.setColorAt(n, pc.setHex(r.jacketHex ?? 0x3e8e8a));
          n++;
        }
      }
      proxy.count = n;
      proxy.instanceMatrix.needsUpdate = true;
      if (proxy.instanceColor) proxy.instanceColor.needsUpdate = true;
      if (!sock?.connected) return;
      sendT += dt;
      beat += dt;
      if (sendT < 1 / SEND_HZ) return;
      sendT = 0;
      const s = local();
      const key = JSON.stringify([s.d.map((x) => x.toFixed(4)), s.f.map((x) => x.toFixed(3)), s.h.toFixed(2), s.sp.toFixed(1), s.air, s.talk, s.hold]);
      if (key === last && beat < 1) return; // nothing changed: stay quiet (heartbeat each second)
      last = key;
      beat = 0;
      sock.volatile.emit("state", s);
    },
    leave() {
      sock?.close();
      for (const r of remotes.values()) r.remove(scene);
      remotes.clear();
    },
  };
}
