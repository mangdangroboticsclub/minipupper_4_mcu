/**
 * Lazy-loaded skill-preview renderer. The GLB is already Y-up; the trace stays
 * in MuJoCo coordinates, so base poses are converted here on every frame.
 * No animation or WebGL work begins until the detail view creates this module.
 */
import {
  WebGLRenderer, Scene, PerspectiveCamera, AmbientLight, DirectionalLight,
  Mesh, PlaneGeometry, GridHelper, MeshBasicMaterial, Vector3, Quaternion,
  Color, Fog, ColorManagement, ACESFilmicToneMapping, sRGBEncoding,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { playbackStride } from "./previewTrace.js";
import { addPreviewScreen } from "./previewScreen.js";

const UP = new Vector3(0, 1, 0);
const FLOOR_SIZE = 4;
const SCENE = {
  background: 0x0a1e3a,
  // Unlit drafting-floor equivalent of the tester's lit floor under three r181.
  floor: 0x1b2840,
  cell: 0x7f9dc0,
  section: 0xc7e6ff,
};
const DEFAULT_HERO = [0.42, 0.34, 0.22];
const EASE_S = 0.12;
const SNAP_M = 0.6;
const SNAP_RAD = Math.PI / 3;
const wrapAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));

// three 0.149 converts hex colors at construction time. Scope the modern
// behavior to synchronous setup so opening this lazy view cannot affect other
// Three scenes, and restore it before the asynchronous GLTF parse.
function withModernColors(build) {
  const previous = ColorManagement.legacyMode;
  ColorManagement.legacyMode = false;
  try {
    return build();
  } finally {
    ColorManagement.legacyMode = previous;
  }
}

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

function disposeObject(root) {
  const textures = new Set();
  const geometries = new Set();
  const materials = new Set();
  root.traverse((node) => {
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
}

/**
 * @param {HTMLElement} container
 * @param {{glbArrayBuffer:ArrayBuffer, trace:object, manifest:object,
 *   onTime?:(ms:number)=>void, onEnd?:()=>void}} options
 */
export async function init(container, { glbArrayBuffer, trace, manifest, onTime, onEnd }) {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none";
  canvas.setAttribute("aria-label", "Orbitable 3D skill preview; Space plays, arrows step frames");
  canvas.tabIndex = 0;
  container.appendChild(canvas);

  let renderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false });
  } catch (error) {
    canvas.remove();
    throw error;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputEncoding = sRGBEncoding;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.8;

  // Match the skill tester's blueprint workbench: a large matte floor, two
  // drafting grids and fog at the horizon. A finite circular floor made the
  // marketplace preview look like a robot floating over an olive-green dome.
  const scene = new Scene();
  const camera = new PerspectiveCamera(32, 1, 0.01, 14);
  camera.up.copy(UP);
  const { ground, cells, sections } = withModernColors(() => {
    renderer.setClearColor(SCENE.background);
    scene.background = new Color(SCENE.background);
    scene.fog = new Fog(SCENE.background, 2.4, 6.0);
    scene.add(new AmbientLight(0xffffff, 0.6));
    const key = new DirectionalLight(0xffffff, 1.6);
    key.position.set(1.6, 2.4, 1.2);
    const fill = new DirectionalLight(0xffffff, 0.4);
    fill.position.set(-1.8, 1.2, -0.8);
    const rim = new DirectionalLight(0x7fe3ff, 0.55);
    rim.position.set(-0.6, 0.9, -2.0);
    scene.add(key, fill, rim);

    const ground = new Mesh(
      new PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE),
      new MeshBasicMaterial({ color: SCENE.floor, toneMapped: false }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.0005;
    scene.add(ground);

    const cells = new GridHelper(FLOOR_SIZE, FLOOR_SIZE / 0.1, SCENE.cell, SCENE.cell);
    const sections = new GridHelper(FLOOR_SIZE, FLOOR_SIZE / 0.5, SCENE.section, SCENE.section);
    for (const grid of [cells, sections]) {
      grid.material.transparent = true;
      grid.material.opacity = grid === cells ? 0.28 : 0.55;
      grid.material.depthWrite = false;
      grid.material.toneMapped = false;
      grid.position.y = 0.0005;
      scene.add(grid);
    }
    return { ground, cells, sections };
  });

  let model;
  try {
    const gltf = await new Promise((resolve, reject) => {
      new GLTFLoader().parse(glbArrayBuffer, "", resolve, reject);
    });
    model = gltf.scene;
    withModernColors(() => addPreviewScreen(model, manifest.sku));
    scene.add(model);
  } catch (error) {
    if (model) disposeObject(model);
    disposeObject(ground);
    disposeObject(cells);
    disposeObject(sections);
    renderer.dispose();
    canvas.remove();
    throw error;
  }

  const base = model.getObjectByName(manifest.rig?.base_node || "base");
  if (!base) {
    disposeObject(model);
    disposeObject(ground);
    disposeObject(cells);
    disposeObject(sections);
    renderer.dispose();
    canvas.remove();
    throw new Error(`Preview rig has no ${manifest.rig?.base_node || "base"} node`);
  }

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
  let followedYaw = 0;
  let baseYaw = 0;
  let follow = true;
  let heading = true;
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
    // Swing-twist heading: pitch, roll and backflips must not swing the camera
    // 180 degrees. The orbit catches up in updateCamera, once per render.
    baseYaw = 2 * Math.atan2(f[o + 6], f[o + 3]);
    if (!Number.isFinite(baseYaw)) baseYaw = 0;
  }

  function setPreset(name) {
    const presets = manifest.camera_presets || {};
    const presetName = presets[name] ? name : "hero";
    const offset = presets[presetName]?.offset_m || DEFAULT_HERO;
    controls.target.copy(baseWorld);
    camera.position.copy(baseWorld).add(cameraOffset(offset, baseYaw));
    followedBase.copy(baseWorld);
    followedYaw = baseYaw;
    controls.update();
  }

  function updateCamera(dt) {
    if (!follow) return;
    const distance = followedBase.distanceTo(baseWorld);
    const turn = wrapAngle(baseYaw - followedYaw);
    const k = distance > SNAP_M || Math.abs(turn) > SNAP_RAD
      ? 1
      : 1 - Math.exp(-dt / EASE_S);
    const move = baseWorld.clone().sub(followedBase).multiplyScalar(k);
    followedBase.add(move);
    controls.target.add(move);
    camera.position.add(move);
    if (heading) {
      const dYaw = turn * k;
      followedYaw = wrapAngle(followedYaw + dYaw);
      if (dYaw) {
        const arm = camera.position.clone().sub(controls.target).applyAxisAngle(UP, dYaw);
        camera.position.copy(controls.target).add(arm);
      }
    } else {
      followedYaw = baseYaw;
    }
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
    updateCamera(dt);
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
    step(direction) {
      pause();
      const next = Math.max(0, Math.min(trace.count - 1, frameIndex() + Math.sign(direction || 1) * stride));
      tSkill = next * 1000 * speed / fps;
      applyFrame();
      reportTime(true);
    },
    setPreset,
    setFollow(nextFollow, nextHeading = heading) {
      follow = Boolean(nextFollow);
      heading = Boolean(nextHeading);
    },
    dispose() {
      if (dead) return;
      dead = true;
      playing = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      disposeObject(model);
      disposeObject(ground);
      disposeObject(cells);
      disposeObject(sections);
      renderer.renderLists.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
