/**
 * Lazy-loaded skill-preview renderer. The GLB is already Y-up; the trace stays
 * in MuJoCo coordinates, so base poses are converted here on every frame.
 * No animation or WebGL work begins until the detail view creates this module.
 */
import {
  WebGLRenderer, Scene, PerspectiveCamera, HemisphereLight, DirectionalLight,
  Mesh, CircleGeometry, MeshStandardMaterial, Vector3, Quaternion,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { playbackStride } from "./previewTrace.js";

const UP = new Vector3(0, 1, 0);
const DEFAULT_HERO = [0.42, 0.34, 0.22];

/** [forward, left, up] in robot-heading coordinates -> three world space. */
function cameraOffset(offset, yaw) {
  const [forward, left, up] = offset;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return new Vector3(forward * c - left * s, up, -(forward * s + left * c));
}

function disposeMaterial(material, textures) {
  for (const value of Object.values(material)) {
    if (value?.isTexture && !textures.has(value)) {
      textures.add(value);
      value.dispose();
    }
  }
  material.dispose();
}

/**
 * @param {HTMLElement} container
 * @param {{glbArrayBuffer:ArrayBuffer, trace:object, manifest:object,
 *   onTime?:(ms:number)=>void, onEnd?:()=>void}} options
 */
export async function init(container, { glbArrayBuffer, trace, manifest, onTime, onEnd }) {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none";
  canvas.setAttribute("aria-label", "Orbitable 3D skill preview");
  container.appendChild(canvas);

  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setClearColor(0xf5f3ee);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputEncoding = 1501; // THREE.sRGBEncoding (three 0.149)

  const scene = new Scene();
  const camera = new PerspectiveCamera(40, 1, 0.01, 14);
  camera.up.copy(UP);
  scene.add(new HemisphereLight(0xffffff, 0x827b70, 1.0));
  const key = new DirectionalLight(0xffffff, 0.85);
  key.position.set(0.5, 1.2, 0.7);
  scene.add(key);

  const groundGeometry = new CircleGeometry(1.4, 64);
  const groundMaterial = new MeshStandardMaterial({ color: 0xe9e5dc, roughness: 1 });
  const ground = new Mesh(groundGeometry, groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.001;
  scene.add(ground);

  let model;
  try {
    const gltf = await new Promise((resolve, reject) => {
      new GLTFLoader().parse(glbArrayBuffer, "", resolve, reject);
    });
    model = gltf.scene;
    scene.add(model);
  } catch (error) {
    groundGeometry.dispose();
    groundMaterial.dispose();
    renderer.dispose();
    canvas.remove();
    throw error;
  }

  const base = model.getObjectByName(manifest.rig?.base_node || "base");
  if (!base) throw new Error(`Preview rig has no ${manifest.rig?.base_node || "base"} node`);

  const joints = [];
  model.traverse((node) => {
    const axis = node.userData?.joint_axis;
    const column = node.userData?.trace_column;
    if (!Array.isArray(axis) || !Number.isInteger(column)) return;
    if (column < 7 || column >= trace.width) return;
    joints.push({
      node,
      column,
      axis: new Vector3(...axis).normalize(),
      rest: node.quaternion.clone(),
    });
  });

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.enablePan = true;
  controls.enableZoom = true;
  controls.autoRotate = false;
  controls.minDistance = 0.12;
  controls.maxDistance = 4;
  controls.maxPolarAngle = Math.PI * 0.495;

  const speed = manifest.preview.speed;
  const fps = trace.header.fps;
  // Clamp to the last STORED frame: truncated previews must stop there, not
  // freeze-frame through the rest of the source duration.
  const spannedMs = (trace.count - 1) * 1000 * speed / fps;
  const durationMs = Math.min(trace.header.durationMs || Infinity, spannedMs);
  const jointRotation = new Quaternion();
  const baseWorld = new Vector3();
  const followedBase = new Vector3();
  let hasFollowedBase = false;
  let tSkill = 0;
  let rate = speed;
  let stride = playbackStride(rate, speed, fps);
  let playing = false;
  let dead = false;
  let raf = 0;
  let previousMs = 0;
  let lastReported = -Infinity;

  function frameIndex() {
    // Advancing tSkill at `rate` naturally consumes fps/stride stored frames
    // per wall second. Do not multiply this index by stride a second time.
    return Math.min(trace.count - 1, Math.max(0, Math.floor(tSkill * fps / (1000 * speed))));
  }

  function applyFrame() {
    const o = frameIndex() * trace.width;
    const f = trace.frames;
    // MuJoCo (x,y,z) -> three (x,z,-y); trace wxyz -> three xyzw.
    base.position.set(f[o], f[o + 2], -f[o + 1]);
    base.quaternion.set(f[o + 4], f[o + 6], -f[o + 5], f[o + 3]).normalize();
    for (const joint of joints) {
      jointRotation.setFromAxisAngle(joint.axis, f[o + joint.column]);
      joint.node.quaternion.copy(joint.rest).multiply(jointRotation);
    }
    model.updateMatrixWorld(true);
    base.getWorldPosition(baseWorld);

    // Follow translation so a walking robot stays framed; leave the customer's
    // orbit angle alone. Presets explicitly re-apply heading when requested.
    if (hasFollowedBase) {
      const dx = baseWorld.x - followedBase.x;
      const dy = baseWorld.y - followedBase.y;
      const dz = baseWorld.z - followedBase.z;
      camera.position.x += dx; camera.position.y += dy; camera.position.z += dz;
      controls.target.x += dx; controls.target.y += dy; controls.target.z += dz;
    } else {
      hasFollowedBase = true;
    }
    followedBase.copy(baseWorld);
  }

  function setPreset(name) {
    const presets = manifest.camera_presets || {};
    const presetName = presets[name] ? name : "hero";
    const offset = presets[presetName]?.offset_m || DEFAULT_HERO;
    const o = frameIndex() * trace.width;
    const yaw = 2 * Math.atan2(trace.frames[o + 6], trace.frames[o + 3]);
    controls.target.copy(baseWorld);
    camera.position.copy(baseWorld).add(cameraOffset(offset, yaw));
    followedBase.copy(baseWorld);
    controls.update();
  }

  function reportTime(force = false) {
    const now = performance.now();
    if (force || now - lastReported >= 80) {
      onTime?.(tSkill);
      lastReported = now;
    }
  }

  function pause() {
    playing = false;
    reportTime(true);
  }

  applyFrame();
  setPreset("hero");

  function resize() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  const loop = (now) => {
    if (dead) return;
    raf = requestAnimationFrame(loop);
    const dt = previousMs ? Math.min((now - previousMs) / 1000, 0.1) : 0;
    previousMs = now;
    if (document.visibilityState !== "visible") return;
    if (playing) {
      tSkill = Math.min(durationMs, tSkill + dt * 1000 * rate);
      applyFrame();
      reportTime();
      if (tSkill >= durationMs) {
        pause();
        onEnd?.();
      }
    }
    controls.update();
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(loop);

  return {
    play() {
      if (dead) return;
      if (tSkill >= durationMs) { tSkill = 0; applyFrame(); }
      playing = true;
      previousMs = 0;
      reportTime(true);
    },
    pause,
    setRate(next) {
      if (!(next > 0)) return;
      rate = next;
      stride = playbackStride(rate, speed, fps);
      // Reading the stride here keeps the timing contract explicit; frameIndex
      // derives the same sampling rate from the virtual skill clock.
      void stride;
    },
    seek(next) {
      tSkill = Math.max(0, Math.min(durationMs, Number(next) || 0));
      applyFrame();
      reportTime(true);
    },
    setPreset,
    dispose() {
      if (dead) return;
      dead = true;
      playing = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      const textures = new Set();
      const geometries = new Set();
      const materials = new Set();
      model.traverse((node) => {
        if (node.geometry && !geometries.has(node.geometry)) {
          geometries.add(node.geometry);
          node.geometry.dispose();
        }
        if (node.material) {
          for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
            if (!materials.has(material)) {
              materials.add(material);
              disposeMaterial(material, textures);
            }
          }
        }
      });
      groundGeometry.dispose();
      groundMaterial.dispose();
      renderer.renderLists.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
