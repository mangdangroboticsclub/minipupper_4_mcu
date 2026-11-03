// Preview trace codec — vendored from mpx-skill-tester/app/src/preview/trace.js.
// Keep decodePreviewTrace and playbackStride identical to the reference so fixes
// can be copied between the baker and this browser viewer.
// Format and timing: mpx-skill-tester/docs/preview-contract.md §4 and §5.

export const PREVIEW_TRACE_VERSION = 2;
export const PREVIEW_TRACE_MAGIC = 0x5458504d; // "MPXT" little-endian
export const PREVIEW_HEADER_BYTES = 32;

/**
 * @param {ArrayBuffer} buffer uncompressed preview trace
 * @returns {{header:object, frames:Float32Array, width:number, count:number}}
 */
export function decodePreviewTrace(buffer) {
  if (!(buffer instanceof ArrayBuffer)) throw new TypeError("trace must be an ArrayBuffer");
  if (buffer.byteLength < PREVIEW_HEADER_BYTES) throw new RangeError("trace shorter than its header");
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== PREVIEW_TRACE_MAGIC) {
    throw new RangeError('not a preview trace: missing "MPXT" magic');
  }
  const version = view.getUint16(4, true);
  if (version !== PREVIEW_TRACE_VERSION) {
    throw new RangeError(`preview trace version ${version}, this reader understands ${PREVIEW_TRACE_VERSION}`);
  }
  const width = view.getUint16(6, true);
  if (width < 7 || width > 256) throw new RangeError(`trace width ${width} is implausible`);
  const count = view.getUint32(8, true);
  const fps = view.getUint32(12, true);
  const expected = PREVIEW_HEADER_BYTES + count * width * 2;
  if (buffer.byteLength < expected) {
    throw new RangeError(`trace is truncated: ${buffer.byteLength} bytes, header promises ${expected}`);
  }
  const body = new Int16Array(buffer, PREVIEW_HEADER_BYTES, count * width);
  const frames = new Float32Array(count * width);
  for (let i = 0; i < count; i += 1) {
    const o = i * width;
    frames[o] = body[o] / 1000;
    frames[o + 1] = body[o + 1] / 1000;
    frames[o + 2] = body[o + 2] / 1000;
    let norm = 0;
    for (let c = 3; c < 7; c += 1) {
      const v = body[o + c] / 32767;
      frames[o + c] = v;
      norm += v * v;
    }
    norm = Math.sqrt(norm) || 1;
    for (let c = 3; c < 7; c += 1) frames[o + c] /= norm;
    for (let c = 7; c < width; c += 1) frames[o + c] = body[o + c] / 1000;
  }
  return {
    header: {
      version,
      width,
      count,
      fps,
      durationMs: view.getUint32(16, true),
      speed: view.getUint32(20, true) / 1000,
    },
    frames,
    width,
    count,
  };
}

/**
 * Playback stride for a selected rate, per contract §5. `1` means every stored
 * frame — the default, reached when `rate === speed`. Real time (`rate = 1`)
 * strides `speed` frames: on a skill sped up 8.55× that is 25/9 ≈ 2.8 fps,
 * which is exactly the trade-off the user chose for long skills.
 *
 * Derivation: consecutive stored frames are `speed / traceFps` seconds of
 * *skill* time apart, so consuming `traceFps / stride` frames per wall second
 * plays the skill at `speed / stride`. Set that equal to `rate`.
 *
 * @param {number} rate selected skill-time multiplier (0.5 … speed)
 * @param {number} speed the trace's baked speed-up factor
 * @param {number} traceFps stored frames per preview wall second
 * @returns {{stride:number, effectiveFps:number}}
 */
export function playbackStride(rate, speed, traceFps) {
  if (!(rate > 0)) throw new RangeError(`rate must be positive, got ${rate}`);
  const stride = Math.max(1, Math.round(speed / rate));
  return { stride, effectiveFps: traceFps / stride };
}

/**
 * Resolve a cloud-relative preview base ("/v1/preview/...") to an absolute
 * URL on the gateway itself, so the browser fetches previews directly instead
 * of streaming them through the ESP32. Returns "" when the gateway config is
 * unavailable (AP-only mode) — callers then fall back to the on-device relay.
 */
let gatewayOriginPromise = null;
export function cloudPreviewBase(base) {
  if (!base || !base.startsWith("/")) return Promise.resolve(base || "");
  gatewayOriginPromise ||= (async () => {
    try {
      const res = await fetch("/v1/gateway/config");
      if (!res.ok) return "";
      const cfg = await res.json();
      if (!cfg.host || !cfg.port) return "";
      // The gateway is plain HTTP on the mesh/LAN; the PWA itself is served
      // over HTTP from the robot, so there is no mixed-content upgrade.
      return `http://${cfg.host}:${cfg.port}`;
    } catch {
      return "";
    }
  })();
  return gatewayOriginPromise.then((origin) => (origin ? origin + base : ""));
}

/** Root URL for one skill version's preview files. */
export function previewBaseUrl(skillId, version, base) {
  return (base || `/api/preview/${encodeURIComponent(skillId)}/${encodeURIComponent(version)}`).replace(/\/+$/, "");
}

export function previewFileUrl(skillId, version, file, base) {
  return `${previewBaseUrl(skillId, version, base)}/${file}`;
}

async function fetchWithRetry(url, read, { signal, allowNotFound = false } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let retryAfter = 350;
    try {
      const timeout = AbortSignal.timeout(30000);
      const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (allowNotFound && res.status === 404) return res;
      if (!res.ok) {
        const error = new Error(`Preview file failed: ${url} → ${res.status}`);
        error.retryable = [408, 429, 500, 502, 503, 504].includes(res.status);
        const advertised = Number(res.headers.get("Retry-After"));
        if (Number.isFinite(advertised) && advertised > 0) retryAfter = advertised * 1000;
        throw error;
      }
      return await read(res);
    } catch (error) {
      const retryable = error.retryable || error instanceof TypeError || error.name === "TimeoutError";
      if (signal?.aborted || !retryable || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryAfter));
    }
  }
  throw new Error(`Preview file failed: ${url}`);
}

function fetchBytes(url, signal) {
  return fetchWithRetry(url, (res) => res.arrayBuffer(), { signal });
}

/** Fetch only the manifest; a 404 is the normal "no preview" result. */
export async function fetchPreviewManifest(skillId, version, { base, signal } = {}) {
  const url = previewFileUrl(skillId, version, "manifest.json", base);
  const res = await fetchWithRetry(url, async (response) => response, { signal, allowNotFound: true });
  if (res.status === 404) return null;
  const manifest = await res.json();
  if (manifest.preview_format !== 2) throw new Error(`Unsupported preview format: ${manifest.preview_format}`);
  return manifest;
}

/**
 * Fetch geometry and motion for the lazy viewer. Direct gateway failures fall
 * back to the robot relay, which may already have a warm artifact cache.
 */
export async function fetchPreview(skillId, version, { base, manifest, signal } = {}) {
  const load = async (requestBase) => {
    const currentManifest = manifest || await fetchPreviewManifest(skillId, version, { base: requestBase, signal });
    if (!currentManifest) return null;
    const glb = currentManifest.files?.find((f) => f.mime === "model/gltf-binary")?.name || `${currentManifest.sku}.glb`;
    const traceFile = currentManifest.trace?.file || "trace.bin.gz";
    // The relay has one uncached-download slot. Serial requests avoid a cold
    // cache 429; the retry helper honors Retry-After for external contention.
    const storedTrace = await fetchBytes(previewFileUrl(skillId, version, traceFile, requestBase), signal);
    const glbArrayBuffer = await fetchBytes(previewFileUrl(skillId, version, glb, requestBase), signal);

    // fetch() may already have inflated Content-Encoding:gzip.
    const magic = new DataView(storedTrace).getUint32(0, true);
    const traceBuffer = magic === PREVIEW_TRACE_MAGIC
      ? storedTrace
      : await new Response(
          new Blob([storedTrace]).stream().pipeThrough(new DecompressionStream("gzip")),
        ).arrayBuffer();
    return { manifest: currentManifest, glbArrayBuffer, trace: decodePreviewTrace(traceBuffer) };
  };

  try {
    const result = await load(base || "");
    if (result || !base) return result;
  } catch (error) {
    if (!base || signal?.aborted) throw error;
  }
  return load("");
}
