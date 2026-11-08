import {
  BoxGeometry, CanvasTexture, Group, LinearFilter, Matrix4, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, Vector3, sRGBEncoding,
} from "three";
import { resolvePreviewSku } from "./previewTrace.js";

// Generated display geometry uses MuJoCo's base-local, z-up coordinates. The
// preview GLB and its animated base node use (x, z, -y), so only positions and
// the basis need converting; attaching to `base` makes the face follow flips.
const SCREEN_CENTRES = {
  sku_1: [0.077938, 0.0094525, -0.0000105],
  sku_2: [0.1021055, 0.0202295, -0.0000105],
};
const RIGHT = new Vector3(0, 0, -1);
const UP = new Vector3(-0.573577, 0.819152, 0);
const NORMAL = new Vector3(0.819152, 0.573577, 0);

function roundedPath(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function faceTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  const context = canvas.getContext("2d");
  context.fillStyle = "#000";
  context.fillRect(0, 0, 320, 240);
  context.fillStyle = "#ffe631";
  // The firmware's neutral face: two 59×114 rounded eyes, centred ±77 px.
  for (const centreX of [83, 237]) {
    roundedPath(context, centreX - 29.5, 63, 59, 114, 8);
    context.fill();
  }
  const texture = new CanvasTexture(canvas);
  texture.encoding = sRGBEncoding;
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  return texture;
}

/** Add the Mini Pupper's resting face and display housing to a preview GLB. */
export function addPreviewScreen(model, sku) {
  const base = model.getObjectByName("base");
  if (!base) return null;

  const group = new Group();
  group.name = "preview_screen";
  group.position.fromArray(SCREEN_CENTRES[resolvePreviewSku(sku)]);
  group.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(RIGHT, UP, NORMAL));

  const bezel = new Mesh(
    new BoxGeometry(0.054, 0.042, 0.006),
    new MeshStandardMaterial({ color: 0xf5c20d, roughness: 0.48, metalness: 0.18 }),
  );
  bezel.name = "preview_screen_bezel";
  bezel.position.z = -0.003;
  group.add(bezel);

  const panel = new Mesh(
    new BoxGeometry(0.049, 0.035, 0.001),
    new MeshStandardMaterial({ color: 0x121214, roughness: 0.55, metalness: 0.15 }),
  );
  panel.name = "preview_screen_panel";
  panel.position.z = -0.0005;
  group.add(panel);

  const material = new MeshBasicMaterial({
    map: faceTexture(),
    color: 0xcccccc, // firmware's resting-face backlight: 80%
    toneMapped: false,
  });
  const display = new Mesh(new PlaneGeometry(0.041398, 0.031048), material);
  display.name = "preview_screen_face";
  display.position.z = 0.0003;
  group.add(display);
  base.add(group);
  return group;
}
