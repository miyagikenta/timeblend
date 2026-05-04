import { Muxer, ArrayBufferTarget } from "https://esm.sh/mp4-muxer@5.2.2";

const VERSION = "v0.8.2-no-auto-facing";

document.getElementById("version").textContent =
  `Version: ${VERSION} / loaded: ${new Date().toLocaleString()}`;

const video = document.getElementById("camera");
const canvas = document.getElementById("output");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const windowSecSelect = document.getElementById("windowSec");
const outputPresetSelect = document.getElementById("outputPreset");
const facingModeSelect = document.getElementById("facingMode");
const consentModal = document.getElementById("consentModal");
const consentModalCheck = document.getElementById("consentModalCheck");
const consentAcceptBtn = document.getElementById("consentAcceptBtn");
const consentCloseBtn = document.getElementById("consentCloseBtn");
const consentHeaderCloseBtn = document.getElementById("consentHeaderCloseBtn");
const statusText = document.getElementById("status");
const resultVideo = document.getElementById("result");
const downloadLink = document.getElementById("download");

let gl = null;

let width = 1280;
let height = 720;

const sampleIntervalMs = 100;
const outputFps = 30;
const frameDurationUs = Math.round(1_000_000 / outputFps);

let cameraStream = null;
let sampleTimer = null;
let sampleRvfHandle = null;
let emitTimer = null;

let videoTexture = null;
let accumTextures = [];
let framebuffers = [];
let ping = 0;
let sampleCount = 0;
let encodedFrameCount = 0;

let encoder = null;
let muxer = null;
let muxerTarget = null;
let isRecording = false;
let hasConsent = false;

const CONSENT_KEY = "lumetriq-lapse.consent.v1";

/** Revoked when starting a new recording or in cleanup (blob URL leak prevention). */
let lastMp4ObjectUrl = null;

let accumulateProgram = null;
let displayProgram = null;
let quadVao = null;

let locAccumVideo = null;
let locAccumPrev = null;
let locDisplayAccum = null;
let locDisplayCount = null;

const vertexShaderSource = `#version 300 es
  in vec2 a_position;
  out vec2 v_uv;

  void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const accumulateFragmentShaderSource = `#version 300 es
  precision highp float;

  in vec2 v_uv;
  out vec4 outColor;

  uniform sampler2D u_video;
  uniform sampler2D u_prevAccum;

  void main() {
    vec2 videoUv = vec2(v_uv.x, 1.0 - v_uv.y);

    vec4 current = texture(u_video, videoUv);
    vec4 previous = texture(u_prevAccum, v_uv);

    outColor = vec4(previous.rgb + current.rgb, 1.0);
  }
`;

const displayFragmentShaderSource = `#version 300 es
  precision highp float;

  in vec2 v_uv;
  out vec4 outColor;

  uniform sampler2D u_accum;
  uniform float u_count;

  void main() {
    vec4 accumulated = texture(u_accum, v_uv);
    vec3 averageColor = accumulated.rgb / max(u_count, 1.0);
    outColor = vec4(averageColor, 1.0);
  }
`;

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${info}`);
  }

  return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);

  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.bindAttribLocation(program, 0, "a_position");
  gl.linkProgram(program);

  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link error: ${info}`);
  }

  return program;
}

function createFloatTexture(gl, width, height) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);

  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA32F,
    width,
    height,
    0,
    gl.RGBA,
    gl.FLOAT,
    null
  );

  return texture;
}

function createFramebuffer(gl, texture) {
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0
  );

  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`Framebuffer incomplete: ${status}`);
  }

  return framebuffer;
}

function createVideoTexture(gl) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);

  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 255])
  );

  return texture;
}

function setupQuad(gl) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);

  const vertices = new Float32Array([
    -1, -1,
     1, -1,
    -1,  1,
    -1,  1,
     1, -1,
     1,  1
  ]);

  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  return vao;
}

const OUTPUT_PRESET_LANDSCAPE = {
  720: [1280, 720],
  1080: [1920, 1080],
  2160: [3840, 2160]
};

function landscapeSizeForPreset(preset) {
  const pair = OUTPUT_PRESET_LANDSCAPE[preset];
  return pair ?? OUTPUT_PRESET_LANDSCAPE["720"];
}

function setupCanvasSize(sourceWidth, sourceHeight) {
  const preset = outputPresetSelect.value;
  const [lw, lh] = landscapeSizeForPreset(preset);
  const isPortrait = sourceHeight > sourceWidth;

  width = isPortrait ? lh : lw;
  height = isPortrait ? lw : lh;

  canvas.width = width;
  canvas.height = height;
}

function bitrateForOutput(w, h) {
  const pixels = w * h;
  if (pixels <= 1280 * 720) return 5_000_000;
  if (pixels <= 1920 * 1080) return 12_000_000;
  return 35_000_000;
}

function selectedFacingMode() {
  const v = facingModeSelect.value;
  return v === "environment" ? "environment" : "user";
}

function cameraConstraintsForPreset(preset) {
  const [lw, lh] = landscapeSizeForPreset(preset);
  return {
    facingMode: selectedFacingMode(),
    width: { ideal: lw },
    height: { ideal: lh },
    frameRate: { ideal: 30, max: 30 }
  };
}

function cameraProbeConstraints() {
  return {
    facingMode: selectedFacingMode(),
    width: { ideal: 3840 },
    height: { ideal: 2160 },
    frameRate: { ideal: 30, max: 30 }
  };
}

/**
 * 既定は背面。背面が使えない場合も UI を勝手に書き換えず、ユーザーに Camera facing を変更してもらう。
 */
async function acquireCameraProbeStream() {
  return navigator.mediaDevices.getUserMedia({
    video: cameraProbeConstraints(),
    audio: false
  });
}

function showCameraAcquisitionFailureStatus(error) {
  const name = error?.name ?? "";
  const backSelected = selectedFacingMode() === "environment";
  if (
    backSelected &&
    (name === "NotFoundError" || name === "OverconstrainedError")
  ) {
    statusText.textContent =
      "背面カメラを開けませんでした。Camera facing を Front (user) に変更してから再度 Start してください。";
    return;
  }
  statusText.textContent =
    `カメラを開けませんでした: ${error?.message ?? String(error)}`;
}

function maxFromCapabilityRange(range) {
  if (range == null) return null;
  const m = range.max;
  return typeof m === "number" && Number.isFinite(m) ? m : null;
}

function presetFitsCameraMax(wMax, hMax, lw, lh) {
  if (wMax == null || hMax == null) return true;
  return (wMax >= lw && hMax >= lh) || (wMax >= lh && hMax >= lw);
}

function syncOutputPresetOptionsWithCapabilities(track) {
  for (const opt of outputPresetSelect.options) {
    opt.disabled = false;
  }

  if (typeof track.getCapabilities !== "function") return;

  const caps = track.getCapabilities();
  const wMax = maxFromCapabilityRange(caps.width);
  const hMax = maxFromCapabilityRange(caps.height);
  if (wMax == null || hMax == null) return;

  for (const opt of outputPresetSelect.options) {
    const [lw, lh] = landscapeSizeForPreset(opt.value);
    opt.disabled = !presetFitsCameraMax(wMax, hMax, lw, lh);
  }

  if ([...outputPresetSelect.options].every(o => o.disabled)) {
    const o720 = outputPresetSelect.querySelector('option[value="720"]');
    if (o720) o720.disabled = false;
  }
}

function resetOutputPresetOptionsEnabled() {
  for (const opt of outputPresetSelect.options) {
    opt.disabled = false;
  }
}

function isOutputPresetSelectionAllowed() {
  const sel = outputPresetSelect;
  const cur = sel.options[sel.selectedIndex];
  return Boolean(cur && !cur.disabled);
}

async function applyPresetConstraintsToVideoTrack(videoTrack) {
  await videoTrack.applyConstraints(
    cameraConstraintsForPreset(outputPresetSelect.value)
  );
}

function releaseCameraStream() {
  if (!cameraStream) return;
  cameraStream.getTracks().forEach(track => track.stop());
  cameraStream = null;
}

function selectedFacingLabel() {
  return selectedFacingMode() === "environment"
    ? "Back (environment)"
    : "Front (user)";
}

function selectedOutputPresetLabel() {
  return (
    outputPresetSelect.selectedOptions[0]?.textContent?.trim() ??
    "選択中の解像度"
  );
}

function showOutputPresetUnavailableStatus() {
  statusText.textContent =
    `${selectedOutputPresetLabel()} はこのカメラでは使えません。` +
    "Output resolution を変更してから再度 Start してください。";
}

function showOutputPresetConstraintFailureStatus() {
  statusText.textContent =
    `選択中の解像度を ${selectedFacingLabel()} で使えません。` +
    "Output resolution を下げるか、Camera facing を変更してから再度 Start してください。";
}

function loadConsentState() {
  try {
    return localStorage.getItem(CONSENT_KEY) === "1";
  } catch {
    return false;
  }
}

function saveConsentState(checked) {
  try {
    localStorage.setItem(CONSENT_KEY, checked ? "1" : "0");
  } catch {
    // Ignore storage failures (private mode, quota, etc.)
  }
}

function updateStartButtonAvailability() {
  startBtn.disabled = isRecording || !hasConsent;
}

function updateConsentModalControls() {
  if (!consentAcceptBtn || !consentModalCheck) return;
  consentAcceptBtn.disabled = !consentModalCheck.checked;
}

function openConsentModal() {
  if (!consentModal || hasConsent) return;
  if (typeof consentModal.showModal === "function" && !consentModal.open) {
    consentModal.showModal();
  }
}

function closeConsentModal() {
  if (!consentModal || !consentModal.open) return;
  consentModal.close();
}

function showConsentRequiredStatus() {
  statusText.textContent =
    "利用前にプライバシーポリシー / 利用規約を確認し、同意チェックを入れてください。";
}

function stopSampleLoop() {
  if (sampleRvfHandle !== null && typeof video.cancelVideoFrameCallback === "function") {
    video.cancelVideoFrameCallback(sampleRvfHandle);
  }
  sampleRvfHandle = null;
  if (sampleTimer !== null) {
    clearInterval(sampleTimer);
    sampleTimer = null;
  }
}

function startSampleLoop() {
  if (typeof video.requestVideoFrameCallback === "function") {
    function onVideoFrame() {
      if (!isRecording) return;
      accumulateFrameGpu();
      sampleRvfHandle = video.requestVideoFrameCallback(onVideoFrame);
    }
    sampleRvfHandle = video.requestVideoFrameCallback(onVideoFrame);
  } else {
    sampleTimer = setInterval(accumulateFrameGpu, sampleIntervalMs);
  }
}

function teardownWebGL() {
  if (!gl) return;

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindVertexArray(null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.useProgram(null);

  if (accumulateProgram) gl.deleteProgram(accumulateProgram);
  if (displayProgram) gl.deleteProgram(displayProgram);
  accumulateProgram = null;
  displayProgram = null;

  locAccumVideo = null;
  locAccumPrev = null;
  locDisplayAccum = null;
  locDisplayCount = null;

  for (const fb of framebuffers) {
    if (fb) gl.deleteFramebuffer(fb);
  }
  framebuffers = [];

  for (const t of accumTextures) {
    if (t) gl.deleteTexture(t);
  }
  accumTextures = [];

  if (videoTexture) gl.deleteTexture(videoTexture);
  videoTexture = null;

  if (quadVao) gl.deleteVertexArray(quadVao);
  quadVao = null;

  gl = null;
  ping = 0;
  sampleCount = 0;
}

function setupWebGL() {
  gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    preserveDrawingBuffer: true
  });

  if (!gl) {
    throw new Error("WebGL2 is not supported in this browser.");
  }

  const colorBufferFloat = gl.getExtension("EXT_color_buffer_float");
  if (!colorBufferFloat) {
    throw new Error("EXT_color_buffer_float is not supported. Float accumulation cannot run.");
  }

  gl.viewport(0, 0, width, height);

  accumulateProgram = createProgram(
    gl,
    vertexShaderSource,
    accumulateFragmentShaderSource
  );

  displayProgram = createProgram(
    gl,
    vertexShaderSource,
    displayFragmentShaderSource
  );

  locAccumVideo = gl.getUniformLocation(accumulateProgram, "u_video");
  locAccumPrev = gl.getUniformLocation(accumulateProgram, "u_prevAccum");
  locDisplayAccum = gl.getUniformLocation(displayProgram, "u_accum");
  locDisplayCount = gl.getUniformLocation(displayProgram, "u_count");

  quadVao = setupQuad(gl);
  videoTexture = createVideoTexture(gl);

  accumTextures = [
    createFloatTexture(gl, width, height),
    createFloatTexture(gl, width, height)
  ];

  framebuffers = [
    createFramebuffer(gl, accumTextures[0]),
    createFramebuffer(gl, accumTextures[1])
  ];

  clearAccumulation();
}

function clearAccumulation() {
  if (!gl) return;

  for (const framebuffer of framebuffers) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  sampleCount = 0;
  ping = 0;
}

function updateVideoTexture() {
  gl.bindTexture(gl.TEXTURE_2D, videoTexture);

  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    video
  );
}

function accumulateFrameGpu() {
  if (!isRecording || !video.videoWidth || !video.videoHeight) return;

  try {
    updateVideoTexture();

    const prevIndex = ping;
    const nextIndex = 1 - ping;

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffers[nextIndex]);
    gl.viewport(0, 0, width, height);

    gl.useProgram(accumulateProgram);
    gl.bindVertexArray(quadVao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, videoTexture);
    gl.uniform1i(locAccumVideo, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, accumTextures[prevIndex]);
    gl.uniform1i(locAccumPrev, 1);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    ping = nextIndex;
    sampleCount++;
  } catch (error) {
    console.error(error);
    statusText.textContent = `GPU accumulate error: ${error.message}`;
  }
}

function renderAverageToCanvas() {
  if (sampleCount === 0) return false;

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, width, height);

  gl.useProgram(displayProgram);
  gl.bindVertexArray(quadVao);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, accumTextures[ping]);
  gl.uniform1i(locDisplayAccum, 0);
  gl.uniform1f(locDisplayCount, sampleCount);

  gl.drawArrays(gl.TRIANGLES, 0, 6);

  return true;
}

function emitAverageFrame() {
  if (!isRecording || !encoder || sampleCount === 0) return;

  const rendered = renderAverageToCanvas();
  if (!rendered) return;

  const timestamp = encodedFrameCount * frameDurationUs;

  try {
    const frame = new VideoFrame(canvas, {
      timestamp,
      duration: frameDurationUs
    });

    encoder.encode(frame, {
      keyFrame: encodedFrameCount % outputFps === 0
    });

    frame.close();
    encodedFrameCount++;

    statusText.textContent =
      `Encoding... frames: ${encodedFrameCount}, output ≒ ${(encodedFrameCount / outputFps).toFixed(2)} sec`;

    clearAccumulation();
  } catch (error) {
    console.error(error);
    statusText.textContent = `Encode error: ${error.message}`;
  }
}

async function setupEncoder() {
  if (!("VideoEncoder" in window)) {
    throw new Error("WebCodecs VideoEncoder is not supported in this browser.");
  }

  const codecCandidates = [
    "avc1.640034",
    "avc1.640033",
    "avc1.640032",
    "avc1.4d0028",
    "avc1.42001f"
  ];

  const bitrate = bitrateForOutput(width, height);
  let chosen = null;

  for (const codec of codecCandidates) {
    const config = {
      codec,
      width,
      height,
      bitrate,
      framerate: outputFps,
      hardwareAcceleration: "prefer-hardware",
      latencyMode: "quality",
      avc: { format: "avc" }
    };

    const support = await VideoEncoder.isConfigSupported(config);
    if (support.supported) {
      chosen = support.config;
      break;
    }
  }

  if (!chosen) {
    throw new Error(
      "H.264 WebCodecs encoding is not supported for this output size in this browser."
    );
  }

  muxerTarget = new ArrayBufferTarget();

  muxer = new Muxer({
    target: muxerTarget,
    video: {
      codec: "avc",
      width,
      height,
      frameRate: outputFps
    },
    fastStart: "in-memory"
  });

  encoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
    },
    error: (error) => {
      console.error(error);
      statusText.textContent = `Encoder error: ${error.message}`;
    }
  });

  encoder.configure(chosen);
}

async function start() {
  if (!hasConsent) {
    showConsentRequiredStatus();
    openConsentModal();
    return;
  }

  try {
    resultVideo.removeAttribute("src");
    resultVideo.load();
    if (lastMp4ObjectUrl) {
      URL.revokeObjectURL(lastMp4ObjectUrl);
      lastMp4ObjectUrl = null;
    }
    downloadLink.hidden = true;
    downloadLink.removeAttribute("href");

    encodedFrameCount = 0;
    isRecording = false;

    statusText.textContent = "Starting camera...";

    cameraStream = await acquireCameraProbeStream();

    const [videoTrack] = cameraStream.getVideoTracks();
    syncOutputPresetOptionsWithCapabilities(videoTrack);

    if (!isOutputPresetSelectionAllowed()) {
      releaseCameraStream();
      showOutputPresetUnavailableStatus();
      return;
    }

    try {
      await applyPresetConstraintsToVideoTrack(videoTrack);
    } catch (constraintError) {
      console.warn(constraintError);
      releaseCameraStream();
      showOutputPresetConstraintFailureStatus();
      return;
    }

    video.srcObject = cameraStream;
    await video.play();

    setupCanvasSize(video.videoWidth, video.videoHeight);
    setupWebGL();

    statusText.textContent = "Starting encoder...";
    await setupEncoder();

    isRecording = true;

    const averageWindowMs = Number(windowSecSelect.value) * 1000;

    startSampleLoop();
    emitTimer = setInterval(emitAverageFrame, averageWindowMs);

    updateStartButtonAvailability();
    stopBtn.disabled = false;
    windowSecSelect.disabled = true;
    outputPresetSelect.disabled = true;
    facingModeSelect.disabled = true;

    statusText.textContent =
      `Recording GPU frames... output: ${width}x${height} (camera ${video.videoWidth}×${video.videoHeight})`;
  } catch (error) {
    console.error(error);
    showCameraAcquisitionFailureStatus(error);
    cleanup(false);
  }
}

async function stop() {
  startBtn.disabled = true;
  stopBtn.disabled = true;

  stopSampleLoop();
  clearInterval(emitTimer);
  emitTimer = null;

  emitAverageFrame();

  isRecording = false;

  releaseCameraStream();

  video.srcObject = null;

  if (!encoder || !muxer || encodedFrameCount === 0) {
    statusText.textContent = "No frames encoded.";
    cleanup(false);
    return;
  }

  statusText.textContent = "Finalizing MP4...";

  try {
    await encoder.flush();
    encoder.close();

    muxer.finalize();

        const blob = new Blob([muxerTarget.buffer], { type: "video/mp4" });
        const url = URL.createObjectURL(blob);
        if (lastMp4ObjectUrl) {
          URL.revokeObjectURL(lastMp4ObjectUrl);
        }
        lastMp4ObjectUrl = url;

        resultVideo.src = url;

        downloadLink.href = url;
    downloadLink.download = "lumetriq-lapse.mp4";
    downloadLink.textContent = "Download MP4";
        downloadLink.hidden = false;

    statusText.textContent =
      `Done. Output: ${encodedFrameCount} frames / ${outputFps}fps ≒ ${(encodedFrameCount / outputFps).toFixed(2)} sec`;
  } catch (error) {
    console.error(error);
    statusText.textContent = `Finalize error: ${error.message}`;
  } finally {
    cleanup(false);
  }
}

function cleanup(resetStatus = true) {
  stopSampleLoop();
  clearInterval(emitTimer);
  emitTimer = null;

  teardownWebGL();

  releaseCameraStream();
  video.srcObject = null;

  encoder = null;
  muxer = null;
  muxerTarget = null;
  isRecording = false;

  updateStartButtonAvailability();
  stopBtn.disabled = true;
  windowSecSelect.disabled = false;
  outputPresetSelect.disabled = false;
  facingModeSelect.disabled = false;
  resetOutputPresetOptionsEnabled();

  if (resetStatus) {
    statusText.textContent = hasConsent
      ? "Ready"
      : "利用前にプライバシーポリシー / 利用規約を確認し、同意チェックを入れてください。";
  }
}

hasConsent = loadConsentState();
if (consentModalCheck) {
  consentModalCheck.checked = hasConsent;
  consentModalCheck.addEventListener("change", updateConsentModalControls);
}
if (consentAcceptBtn) {
  consentAcceptBtn.addEventListener("click", () => {
    if (!consentModalCheck?.checked) return;
    hasConsent = true;
    saveConsentState(true);
    updateStartButtonAvailability();
    closeConsentModal();
    if (!isRecording) {
      statusText.textContent = "Ready";
    }
  });
}
if (consentCloseBtn) {
  consentCloseBtn.addEventListener("click", () => {
    closeConsentModal();
    if (!isRecording && !hasConsent) {
      showConsentRequiredStatus();
    }
  });
}
if (consentHeaderCloseBtn) {
  consentHeaderCloseBtn.addEventListener("click", () => {
    closeConsentModal();
    if (!isRecording && !hasConsent) {
      showConsentRequiredStatus();
    }
  });
}
if (consentModal) {
  consentModal.addEventListener("close", () => {
    if (!isRecording && !hasConsent) {
      showConsentRequiredStatus();
    }
  });
}
updateStartButtonAvailability();
if (!hasConsent) {
  updateConsentModalControls();
  showConsentRequiredStatus();
  openConsentModal();
}

startBtn.addEventListener("click", start);
stopBtn.addEventListener("click", stop);
