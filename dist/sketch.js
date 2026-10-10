const STATES = {
  BOTH_VISIBLE: "both-uncovered",
  LEFT_COVERED: "left-covered",
  RIGHT_COVERED: "right-covered",
  BOTH_COVERED: "both-covered"
};

const MANUAL_KEYS = {
  "1": STATES.BOTH_VISIBLE,
  "2": STATES.LEFT_COVERED,
  "3": STATES.RIGHT_COVERED,
  "4": STATES.BOTH_COVERED
};

const SCORE_PHASES = {
  ISSUE: "issue instruction",
  WAIT: "waiting",
  CONFIRM: "confirmed",
  TRANSITION: "next instruction"
};

const stateLabels = {
  [STATES.BOTH_VISIBLE]: "both uncovered",
  [STATES.LEFT_COVERED]: "left covered",
  [STATES.RIGHT_COVERED]: "right covered",
  [STATES.BOTH_COVERED]: "both covered"
};

const MEDIAPIPE_MODULE_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.mjs";
const MEDIAPIPE_WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm";
const FACE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const HAND_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const FACE_EYE_INDICES = {
  left: [362, 263, 386, 374, 380, 381, 382, 398, 466, 249, 390, 373],
  right: [33, 133, 159, 145, 153, 154, 155, 173, 246, 7, 163, 144]
};

const FACE_IRIS_INDICES = {
  left: [473, 474, 475, 476, 477],
  right: [468, 469, 470, 471, 472]
};

const COVER_DEBOUNCE_MS = 20;
const COVER_SMOOTHING = 0.72;
const MATCH_HOLD_MS = 380;
const ISSUE_MS = 420;
const CONFIRM_MS = 640;
const TRANSITION_MS = 320;

const video = document.getElementById("webcam");
const overlay = document.getElementById("tracking-overlay");
const overlayCtx = overlay.getContext("2d");
const cameraButton = document.getElementById("camera-button");
const statusEl = document.getElementById("status");
const modeReadout = document.getElementById("mode-readout");
const debugReadout = document.getElementById("debug-readout");
const diagnosticsEl = document.getElementById("diagnostics");

let FaceLandmarker;
let FilesetResolver;
let HandLandmarker;
let faceLandmarker;
let handLandmarker;
let mediaReady = false;
let cameraActive = false;
let manualMode = false;
let manualPerformedState = null;
let cameraState = STATES.BOTH_VISIBLE;
let detectedState = STATES.BOTH_VISIBLE;
let instructionState = STATES.BOTH_VISIBLE;
let scorePhase = SCORE_PHASES.ISSUE;
let phaseStartedAt = 0;
let matchStartedAt = null;
let needsFreshDeparture = false;
let lastInstructionState = null;
let lastVideoTime = -1;
let lastTrackedAt = 0;
let lastError = "none";
let trackingStatus = "not initialized";
let rawCoverage = { left: false, right: false, leftScore: 0, rightScore: 0 };
let smoothCoverage = { left: 0, right: 0 };
let stableCoverage = { left: false, right: false };
let pendingCoverage = { left: false, right: false };
let pendingSince = { left: 0, right: 0 };
let lastTrackedEyes = null;
let faceVisible = false;
let detectedHandCount = 0;

let collageLayers = {};

function setStatus(message) {
  statusEl.textContent = message;
  updateDiagnostics();
}

function updateReadout() {
  modeReadout.textContent = `Instruction: ${instructionLabel(instructionState)} / ${scorePhase}`;
  debugReadout.textContent = `Detected performer: ${stateLabels[detectedState]} | anatomical left: ${
    stableCoverage.left ? "covered" : "clear"
  } / right: ${
    stableCoverage.right ? "covered" : "clear"
  } | ${manualMode ? "manual simulation" : "camera tracking"}`;
  updateDiagnostics();
}

function cameraErrorMessage(error) {
  const name = error?.name || "Error";
  const message = error?.message ? `: ${error.message}` : "";

  if (name === "NotAllowedError") return `Camera permission was blocked${message}`;
  if (name === "NotFoundError") return `No camera device was found${message}`;
  if (name === "NotReadableError") return `Camera is busy in another app${message}`;
  if (name === "OverconstrainedError") return `Camera constraints were rejected${message}`;
  if (name === "SecurityError") return `Camera requires http://localhost or https${message}`;
  return `${name}${message}`;
}

function updateDiagnostics() {
  if (!diagnosticsEl) return;

  diagnosticsEl.textContent = [
    `secure context: ${window.isSecureContext ? "yes" : "no"}`,
    `getUserMedia: ${navigator.mediaDevices?.getUserMedia ? "yes" : "no"}`,
    `video readyState: ${video?.readyState ?? "n/a"}`,
    `mediaPipe ready: ${mediaReady ? "yes" : "no"}`,
    `mapping: screen LEFT hidden -> cover YOUR LEFT eye`,
    `mapping: screen RIGHT hidden -> cover YOUR RIGHT eye`,
    `tracking: ${trackingStatus}`,
    `current instruction: ${instructionLabel(instructionState)}`,
    `detected performer state: ${stateLabels[detectedState]}`,
    `score phase: ${scorePhase}`,
    `fresh action required: ${needsFreshDeparture ? "yes" : "no"}`,
    `match hold: ${matchStartedAt ? `${Math.min(performance.now() - matchStartedAt, MATCH_HOLD_MS).toFixed(0)}ms` : "0ms"}`,
    `face detected: ${faceVisible ? "yes" : "no"}`,
    `hands detected: ${detectedHandCount}`,
    `left eye covered: ${stableCoverage.left ? "yes" : "no"} raw ${rawCoverage.left ? "yes" : "no"} score ${rawCoverage.leftScore.toFixed(2)}`,
    `right eye covered: ${stableCoverage.right ? "yes" : "no"} raw ${rawCoverage.right ? "yes" : "no"} score ${rawCoverage.rightScore.toFixed(2)}`,
    `last error: ${lastError}`
  ].join("\n");
}

async function enableCamera() {
  cameraButton.disabled = true;
  setStatus("Requesting camera permission...");

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("navigator.mediaDevices.getUserMedia is not available in this browser.");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 960 },
        height: { ideal: 720 },
        facingMode: "user"
      },
      audio: false
    });

    video.srcObject = stream;
    await video.play();
    cameraActive = true;
    trackingStatus = "loading MediaPipe";
    setStatus("Camera preview is active. Loading MediaPipe models...");

    try {
      await loadMediaPipe();
      manualMode = false;
      manualPerformedState = null;
      trackingStatus = "running";
      setStatus("Camera active. Tracking is running; use 1-4 to override.");
    } catch (mediaPipeError) {
      console.error(mediaPipeError);
      lastError = `MediaPipe: ${cameraErrorMessage(mediaPipeError)}`;
      trackingStatus = "MediaPipe failed";
      setStatus("Camera preview works, but MediaPipe failed to load. See diagnostics; manual keys 1-4 still work.");
    }
  } catch (error) {
    console.error(error);
    lastError = cameraErrorMessage(error);
    trackingStatus = "camera failed";
    setStatus(`${lastError}. Manual mode remains available.`);
    manualMode = true;
  } finally {
    cameraButton.disabled = false;
    updateReadout();
  }
}

async function loadMediaPipe() {
  if (mediaReady) return;

  if (!FilesetResolver || !FaceLandmarker || !HandLandmarker) {
    const tasks = await import(MEDIAPIPE_MODULE_URL);
    FaceLandmarker = tasks.FaceLandmarker;
    FilesetResolver = tasks.FilesetResolver;
    HandLandmarker = tasks.HandLandmarker;
  }

  const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_URL);

  try {
    await createLandmarkers(vision, "GPU");
  } catch (gpuError) {
    console.warn("GPU MediaPipe initialization failed; retrying on CPU.", gpuError);
    await createLandmarkers(vision, "CPU");
  }

  mediaReady = true;
  lastError = "none";
  updateDiagnostics();
}

async function createLandmarkers(vision, delegate) {
  faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: FACE_MODEL_URL,
      delegate
    },
    runningMode: "VIDEO",
    numFaces: 1
  });

  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: HAND_MODEL_URL,
      delegate
    },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.45,
    minHandPresenceConfidence: 0.45,
    minTrackingConfidence: 0.45
  });
}

function mirroredPoint(landmark) {
  return {
    x: 1 - landmark.x,
    y: landmark.y,
    z: landmark.z || 0
  };
}

function normalizedPoint(landmark) {
  return {
    x: landmark.x,
    y: landmark.y,
    z: landmark.z || 0
  };
}

function averageLandmarks(points) {
  const sum = points.reduce(
    (acc, point) => {
      acc.x += point.x;
      acc.y += point.y;
      acc.z += point.z || 0;
      return acc;
    },
    { x: 0, y: 0, z: 0 }
  );

  return {
    x: sum.x / points.length,
    y: sum.y / points.length,
    z: sum.z / points.length
  };
}

function eyeSample(face, side) {
  const points = FACE_EYE_INDICES[side].map((index) => normalizedPoint(face[index]));
  const irisPoints = FACE_IRIS_INDICES[side]
    .map((index) => face[index])
    .filter(Boolean)
    .map(normalizedPoint);
  const center = averageLandmarks(points);
  const irisCenter = irisPoints.length ? averageLandmarks(irisPoints) : center;
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const width = Math.max(0.038, maxX - minX);
  const height = Math.max(0.026, maxY - minY);

  return {
    side,
    center,
    irisCenter,
    radiusX: width * 1.38,
    radiusY: height * 2.15,
    overlayRadiusX: width * 1.15,
    overlayRadiusY: height * 1.75,
    targetRadiusX: width * 1.15,
    targetRadiusY: height * 2.15,
    width,
    height
  };
}

function pointInEye(point, eye, scale = 1, useIris = false) {
  const center = useIris ? eye.irisCenter : eye.center;
  const radiusX = useIris ? eye.targetRadiusX : eye.radiusX;
  const radiusY = useIris ? eye.targetRadiusY : eye.radiusY;
  const dx = (point.x - center.x) / (radiusX * scale);
  const dy = (point.y - center.y) / (radiusY * scale);
  return dx * dx + dy * dy < 1;
}

function eyeCoverScore(hand, eye) {
  const palm = averageLandmarks([0, 5, 9, 13, 17].map((index) => normalizedPoint(hand[index])));
  const wrist = normalizedPoint(hand[0]);
  const points = [0, 5, 8, 9, 12, 13, 16, 17, 20].map((index) => normalizedPoint(hand[index]));
  const allPoints = hand.map(normalizedPoint);
  const insideTight = points.filter((point) => pointInEye(point, eye, 1.15, true)).length;
  const insideLoose = allPoints.filter((point) => pointInEye(point, eye, 1.65, true)).length;
  const palmNear = pointInEye(palm, eye, 1.95, true);
  const wristNear = pointInEye(wrist, eye, 2.25, true);
  const dx = Math.abs(palm.x - eye.irisCenter.x);
  const dy = Math.abs(palm.y - eye.irisCenter.y);
  const normalizedDistance = Math.hypot(dx / (eye.targetRadiusX * 2.05), dy / (eye.targetRadiusY * 2.05));
  const palmDistanceScore = Math.max(0, 1 - normalizedDistance);

  return {
    score: insideTight * 0.42 + insideLoose * 0.08 + (palmNear ? 0.78 : 0) + (wristNear ? 0.12 : 0) + palmDistanceScore * 0.5,
    distance: normalizedDistance,
    palm
  };
}

function detectCoveredEyes(faceLandmarks, handLandmarks, fallbackEyes = null) {
  if (!handLandmarks) {
    return { leftCovered: false, rightCovered: false, leftScore: 0, rightScore: 0, eyes: [] };
  }

  const eyes = faceLandmarks
    ? [eyeSample(faceLandmarks, "left"), eyeSample(faceLandmarks, "right")]
    : fallbackEyes;

  if (!eyes) {
    return { leftCovered: false, rightCovered: false, leftScore: 0, rightScore: 0, eyes: [] };
  }

  const leftEye = eyes.find((eye) => eye.side === "left");
  const rightEye = eyes.find((eye) => eye.side === "right");
  let leftScore = 0;
  let rightScore = 0;

  for (const hand of handLandmarks) {
    const left = eyeCoverScore(hand, leftEye);
    const right = eyeCoverScore(hand, rightEye);
    const leftWins = left.score > right.score + 0.18 || left.distance < right.distance * 0.82;
    const rightWins = right.score > left.score + 0.18 || right.distance < left.distance * 0.82;

    if (leftWins && !rightWins) {
      leftScore = Math.max(leftScore, left.score);
      rightScore = Math.max(rightScore, right.score * 0.18);
    } else if (rightWins && !leftWins) {
      rightScore = Math.max(rightScore, right.score);
      leftScore = Math.max(leftScore, left.score * 0.18);
    } else {
      leftScore = Math.max(leftScore, left.score);
      rightScore = Math.max(rightScore, right.score);
    }
  }

  return {
    leftCovered: leftScore >= 0.48,
    rightCovered: rightScore >= 0.48,
    leftScore,
    rightScore,
    eyes: [leftEye, rightEye]
  };
}

function updateStableCoverage(coverage, now) {
  rawCoverage = {
    left: coverage.leftCovered,
    right: coverage.rightCovered,
    leftScore: coverage.leftScore,
    rightScore: coverage.rightScore
  };

  smoothCoverage.left = lerp(smoothCoverage.left, Math.min(1, coverage.leftScore / 0.58), COVER_SMOOTHING);
  smoothCoverage.right = lerp(smoothCoverage.right, Math.min(1, coverage.rightScore / 0.58), COVER_SMOOTHING);

  const smoothed = {
    left: stableCoverage.left ? smoothCoverage.left > 0.18 : smoothCoverage.left > 0.24,
    right: stableCoverage.right ? smoothCoverage.right > 0.18 : smoothCoverage.right > 0.24
  };

  for (const side of ["left", "right"]) {
    if (smoothed[side] === stableCoverage[side]) {
      pendingCoverage[side] = smoothed[side];
      pendingSince[side] = now;
      continue;
    }

    if (pendingCoverage[side] !== smoothed[side]) {
      pendingCoverage[side] = smoothed[side];
      pendingSince[side] = now;
      continue;
    }

    if (now - pendingSince[side] >= COVER_DEBOUNCE_MS) {
      stableCoverage[side] = smoothed[side];
    }
  }
}

function stateFromCoverage(leftCovered, rightCovered) {
  if (leftCovered && rightCovered) return STATES.BOTH_COVERED;
  if (leftCovered) return STATES.LEFT_COVERED;
  if (rightCovered) return STATES.RIGHT_COVERED;
  return STATES.BOTH_VISIBLE;
}

function coverageFromState(state) {
  return {
    left: state === STATES.LEFT_COVERED || state === STATES.BOTH_COVERED,
    right: state === STATES.RIGHT_COVERED || state === STATES.BOTH_COVERED
  };
}

function instructionLabel(state) {
  if (state === STATES.BOTH_VISIBLE) return "BOTH UNCOVERED";
  if (state === STATES.LEFT_COVERED) return "COVER LEFT EYE";
  if (state === STATES.RIGHT_COVERED) return "COVER RIGHT EYE";
  return "COVER BOTH EYES";
}

function pickNextInstruction(previous) {
  const options = Object.values(STATES).filter((state) => state !== previous);
  return random(options);
}

function issueInstruction(nextState = pickNextInstruction(instructionState)) {
  lastInstructionState = instructionState;
  instructionState = nextState;
  scorePhase = SCORE_PHASES.ISSUE;
  phaseStartedAt = performance.now();
  matchStartedAt = null;
  detectedState = performerState();
  needsFreshDeparture = false;
  manualPerformedState = null;
  setStatus(`New instruction: ${instructionLabel(instructionState)}.`);
  updateReadout();
}

function performerState() {
  return manualMode && manualPerformedState ? manualPerformedState : cameraState;
}

function performerMatchesInstruction() {
  if (manualMode && manualPerformedState) return manualPerformedState === instructionState;

  const intended = coverageFromState(instructionState);
  if (intended.left !== stableCoverage.left) return false;
  if (intended.right !== stableCoverage.right) return false;
  return true;
}

function advanceScoreState() {
  const now = performance.now();
  detectedState = performerState();

  if (scorePhase === SCORE_PHASES.ISSUE && now - phaseStartedAt >= ISSUE_MS) {
    scorePhase = SCORE_PHASES.WAIT;
    phaseStartedAt = now;
    matchStartedAt = null;
    setStatus(`Waiting: ${instructionLabel(instructionState)}.`);
  }

  if (scorePhase === SCORE_PHASES.WAIT) {
    const matches = performerMatchesInstruction();

    if (needsFreshDeparture && !matches) {
      needsFreshDeparture = false;
    }

    if (!matches) {
      matchStartedAt = null;
    } else if (needsFreshDeparture) {
      matchStartedAt = null;
    } else if (!matchStartedAt) {
      matchStartedAt = now;
    } else if (now - matchStartedAt >= MATCH_HOLD_MS) {
      scorePhase = SCORE_PHASES.CONFIRM;
      phaseStartedAt = now;
      setStatus(`Confirmed: ${instructionLabel(instructionState)}.`);
    }
  }

  if (scorePhase === SCORE_PHASES.CONFIRM && now - phaseStartedAt >= CONFIRM_MS) {
    scorePhase = SCORE_PHASES.TRANSITION;
    phaseStartedAt = now;
    matchStartedAt = null;
    setStatus("Preparing next instruction...");
  }

  if (scorePhase === SCORE_PHASES.TRANSITION && now - phaseStartedAt >= TRANSITION_MS) {
    issueInstruction(pickNextInstruction(instructionState));
  }

  updateReadout();
}

function predictCameraState() {
  if (!mediaReady || !cameraActive || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return;
  }

  const now = performance.now();
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  let faceResult;
  let handResult;

  try {
    faceResult = faceLandmarker.detectForVideo(video, now);
    handResult = handLandmarker.detectForVideo(video, now);
  } catch (error) {
    console.error(error);
    lastError = `Tracking: ${cameraErrorMessage(error)}`;
    trackingStatus = "frame error";
    setStatus("Tracking failed during a video frame. See diagnostics; manual keys 1-4 still work.");
    return;
  }

  const face = faceResult.faceLandmarks?.[0];
  const hands = handResult.landmarks || [];
  detectedHandCount = hands.length;

  if (!face) {
    faceVisible = false;
    if (lastTrackedEyes && hands.length) {
      const fallbackCoverage = detectCoveredEyes(null, hands, lastTrackedEyes);
      updateStableCoverage(fallbackCoverage, now);
      cameraState = stateFromCoverage(stableCoverage.left, stableCoverage.right);
      drawTrackingOverlay(lastTrackedEyes, hands);
      trackingStatus = "hands + last face";
      if (scorePhase === SCORE_PHASES.WAIT) {
        setStatus(`Waiting: ${instructionLabel(instructionState)}.`);
      }
      updateReadout();
      return;
    }

    if (now - lastTrackedAt > 450) {
      updateStableCoverage({ leftCovered: false, rightCovered: false, leftScore: 0, rightScore: 0 }, now);
      cameraState = stateFromCoverage(stableCoverage.left, stableCoverage.right);
      drawTrackingOverlay(lastTrackedEyes, hands);
    }
    trackingStatus = "looking for face";
    setStatus("Looking for a face. Manual keys 1-4 are ready.");
    updateReadout();
    return;
  }

  faceVisible = true;
  lastTrackedAt = now;
  const coverage = detectCoveredEyes(face, hands);
  lastTrackedEyes = coverage.eyes;
  updateStableCoverage(coverage, now);
  cameraState = stateFromCoverage(stableCoverage.left, stableCoverage.right);
  drawTrackingOverlay(coverage.eyes, hands);
  trackingStatus = hands.length ? "face + hands" : "face only";
  if (scorePhase === SCORE_PHASES.WAIT) {
    setStatus(hands.length ? `Waiting: ${instructionLabel(instructionState)}.` : "Face detected. Move hands near the eyes.");
  }
  updateReadout();
}

function drawTrackingOverlay(trackedEyes, handLandmarks) {
  const width = overlay.width;
  const height = overlay.height;
  overlayCtx.clearRect(0, 0, width, height);
  overlayCtx.save();
  overlayCtx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  overlayCtx.fillStyle = "rgba(255, 255, 255, 0.85)";
  overlayCtx.lineWidth = 1;

  if (trackedEyes) {
    for (const eye of trackedEyes) {
      const center = mirroredPoint(eye.center);
      const iris = mirroredPoint(eye.irisCenter);
      overlayCtx.beginPath();
      overlayCtx.ellipse(
        center.x * width,
        center.y * height,
        eye.overlayRadiusX * width,
        eye.overlayRadiusY * height,
        0,
        0,
        Math.PI * 2
      );
      overlayCtx.stroke();
      overlayCtx.beginPath();
      overlayCtx.arc(iris.x * width, iris.y * height, 3.2, 0, Math.PI * 2);
      overlayCtx.fill();
      overlayCtx.fillText(eye.side.toUpperCase(), center.x * width + 4, center.y * height - 4);
    }
  }

  for (const hand of handLandmarks || []) {
    for (const landmark of hand) {
      const point = mirroredPoint(landmark);
      overlayCtx.beginPath();
      overlayCtx.arc(point.x * width, point.y * height, 1.8, 0, Math.PI * 2);
      overlayCtx.fill();
    }
  }

  overlayCtx.restore();
}

function visibleForSide(side) {
  const state = instructionState;
  if (state === STATES.BOTH_COVERED) return 0;
  if (side === "left" && state === STATES.LEFT_COVERED) return 0;
  if (side === "right" && state === STATES.RIGHT_COVERED) return 0;
  return 1;
}

function instructionVisibilityForSide(side) {
  return visibleForSide(side);
}

function resetComposition() {
  collageLayers = {};
  for (const state of Object.values(STATES)) {
    collageLayers[state] = createCollageLayer(state);
  }
}

function createCollageLayer(state) {
  const layer = createGraphics(windowWidth, windowHeight);
  layer.pixelDensity(1);
  layer.randomSeed(1977 + Object.values(STATES).indexOf(state) * 31);
  layer.noiseSeed(441 + Object.values(STATES).indexOf(state) * 47);
  drawPaperBackground(layer);
  drawQuietFragments(layer, state);

  if (state === STATES.BOTH_VISIBLE) {
    drawVintageEye(layer, "left", { variant: "magazine-left" });
    drawVintageEye(layer, "right", { variant: "magazine-right" });
  } else if (state === STATES.LEFT_COVERED) {
    drawVoid(layer, "left", 0.78);
    drawVintageEye(layer, "right", { variant: "vertical-pupil" });
  } else if (state === STATES.RIGHT_COVERED) {
    drawVintageEye(layer, "left", { variant: "pale" });
    drawVoid(layer, "right", 0.78);
  } else {
    drawVoid(layer, "left", 1);
    drawVoid(layer, "right", 1);
  }

  drawAging(layer);
  return layer;
}

function eyePosition(side) {
  return {
    x: side === "left" ? width * 0.34 : width * 0.66,
    y: height * 0.56,
    w: min(width, height) * 0.29,
    h: min(width, height) * 0.14
  };
}

function drawPaperBackground(g) {
  g.background(216, 199, 163);
  g.noStroke();

  for (let i = 0; i < 2600; i += 1) {
    const tone = g.random(142, 232);
    g.fill(tone, tone * 0.91, tone * 0.72, g.random(5, 18));
    g.circle(g.random(g.width), g.random(g.height), g.random(0.35, 1.8));
  }

  g.fill(169, 143, 102, 24);
  g.rect(0, 0, g.width, g.height);
}

function drawQuietFragments(g, state) {
  g.noStroke();
  const fragments = state === STATES.BOTH_COVERED ? 4 : 3;
  for (let i = 0; i < fragments; i += 1) {
    const x = g.random(g.width * 0.12, g.width * 0.88);
    const y = g.random(g.height * 0.18, g.height * 0.82);
    const w = g.random(g.width * 0.05, g.width * 0.13);
    const h = g.random(g.height * 0.025, g.height * 0.075);
    g.push();
    g.translate(x, y);
    g.rotate(g.random(-0.1, 0.1));
    g.fill(g.random([148, 167, 188]), g.random([133, 148, 164]), g.random([112, 103, 90]), g.random(18, 34));
    tornRect(g, 0, 0, w, h, 0.08);
    g.pop();
  }
}

function drawVintageEye(g, side, options) {
  const pos = eyePosition(side);
  const tilt = side === "left" ? -0.055 : 0.042;
  g.push();
  g.translate(pos.x, pos.y);
  g.rotate(tilt + g.random(-0.025, 0.025));

  g.noStroke();
  g.fill(128, 105, 76, 46);
  tornRect(g, pos.w * 0.03, pos.h * 0.08, pos.w * 1.08, pos.h * 1.68, 0.17);
  g.fill(224, 214, 188, 244);
  tornRect(g, 0, 0, pos.w, pos.h * 1.25, 0.2);

  g.stroke(72, 62, 49, 54);
  g.strokeWeight(0.7);
  for (let i = 0; i < 18; i += 1) {
    const y = g.random(-pos.h * 0.46, pos.h * 0.46);
    g.line(-pos.w * 0.44 + g.random(-3, 3), y, pos.w * 0.44 + g.random(-3, 3), y + g.random(-1.4, 1.4));
  }

  g.stroke(30, 27, 23, 220);
  g.strokeWeight(1.15);
  g.noFill();
  g.beginShape();
  for (let i = 0; i <= 44; i += 1) {
    const t = i / 44;
    const x = lerp(-pos.w * 0.45, pos.w * 0.45, t);
    const y = -sin(t * PI) * pos.h * (0.34 + g.random(-0.025, 0.025)) + g.random(-1.6, 1.6);
    g.curveVertex(x, y);
  }
  g.endShape();
  g.beginShape();
  for (let i = 0; i <= 44; i += 1) {
    const t = i / 44;
    const x = lerp(-pos.w * 0.45, pos.w * 0.45, t);
    const y = sin(t * PI) * pos.h * (0.25 + g.random(-0.02, 0.02)) + g.random(-1.4, 1.4);
    g.curveVertex(x, y);
  }
  g.endShape();

  g.stroke(35, 31, 27, 86);
  g.strokeWeight(0.55);
  for (let i = 0; i < 24; i += 1) {
    const x = lerp(-pos.w * 0.36, pos.w * 0.36, i / 23);
    g.line(x, -pos.h * 0.22 + g.random(-1, 1), x + g.random(-4, 4), pos.h * 0.2 + g.random(-1, 1));
  }

  if (options.variant === "pale") {
    g.noStroke();
    g.fill(220, 218, 201, 232);
    g.ellipse(0, 1, pos.h * 0.68, pos.h * 0.58);
    g.stroke(93, 89, 78, 104);
    g.strokeWeight(0.75);
    for (let i = 0; i < 7; i += 1) {
      g.ellipse(g.random(-2, 2), g.random(-1, 1), pos.h * g.random(0.44, 0.7), pos.h * g.random(0.32, 0.58));
    }
  } else {
    g.noStroke();
    g.fill(options.variant === "magazine-left" ? [91, 83, 67, 225] : [54, 52, 48, 226]);
    g.ellipse(0, 0, pos.h * 0.7, pos.h * 0.75);
    g.stroke(20, 18, 16, 92);
    g.strokeWeight(0.55);
    for (let i = 0; i < 18; i += 1) {
      const a = (i / 18) * TAU;
      g.line(0, 0, cos(a) * pos.h * 0.33, sin(a) * pos.h * 0.34);
    }
    g.noStroke();
    g.fill(12, 11, 10, 235);
    if (options.variant === "vertical-pupil") {
      g.ellipse(0, 0, pos.h * 0.12, pos.h * 0.84);
    } else {
      g.ellipse(g.random(-2, 2), g.random(-1, 1), pos.h * 0.26, pos.h * 0.32);
    }
    g.fill(239, 229, 199, 130);
    g.ellipse(-pos.h * 0.12, -pos.h * 0.14, pos.h * 0.075, pos.h * 0.05);
  }

  g.pop();
}

function drawVoid(g, side, intensity) {
  const pos = eyePosition(side);
  g.push();
  g.translate(pos.x, pos.y);
  g.rotate((side === "left" ? -0.03 : 0.04) + g.random(-0.02, 0.02));
  g.noStroke();
  g.fill(232, 220, 190, 180);
  tornAlmond(g, 0, 0, pos.w * 0.96, pos.h * 1.35, 0.23);
  g.fill(17, 15, 13, 230 * intensity);
  tornAlmond(g, 0, 0, pos.w * 0.74, pos.h * 0.9, 0.18);
  g.fill(58, 45, 34, 62);
  tornAlmond(g, g.random(-4, 4), g.random(-2, 2), pos.w * 0.56, pos.h * 0.62, 0.24);
  g.stroke(30, 24, 19, 90);
  g.strokeWeight(0.8);
  for (let i = 0; i < 12; i += 1) {
    const x = lerp(-pos.w * 0.34, pos.w * 0.34, i / 11);
    g.line(x, -pos.h * 0.34 + g.random(-2, 2), x + g.random(-5, 5), pos.h * 0.32 + g.random(-2, 2));
  }
  g.pop();
}

function drawAging(g) {
  g.noFill();
  g.stroke(58, 45, 31, 34);
  g.strokeWeight(1);
  g.rect(18, 18, g.width - 36, g.height - 36);
  g.noStroke();
  g.fill(40, 31, 22, 18);
  g.rect(0, 0, g.width, 12);
  g.rect(0, g.height - 12, g.width, 12);
}

function irregularPatch(g, cx, cy, w, h, roughness) {
  g.beginShape();
  const count = 28;
  for (let i = 0; i < count; i += 1) {
    const a = (i / count) * TAU;
    const wobble = 1 + g.random(-roughness, roughness);
    const x = cx + cos(a) * w * 0.5 * wobble;
    const y = cy + sin(a) * h * 0.5 * wobble;
    g.curveVertex(x, y);
  }
  g.endShape(CLOSE);
}

function tornAlmond(g, cx, cy, w, h, roughness) {
  g.beginShape();
  for (let i = 0; i <= 22; i += 1) {
    const t = i / 22;
    const x = lerp(-w * 0.5, w * 0.5, t);
    const y = -sin(t * PI) * h * 0.5;
    g.curveVertex(cx + x + g.random(-w, w) * 0.018 * roughness * 8, cy + y + g.random(-h, h) * 0.025 * roughness * 8);
  }
  for (let i = 22; i >= 0; i -= 1) {
    const t = i / 22;
    const x = lerp(-w * 0.5, w * 0.5, t);
    const y = sin(t * PI) * h * 0.42;
    g.curveVertex(cx + x + g.random(-w, w) * 0.018 * roughness * 8, cy + y + g.random(-h, h) * 0.025 * roughness * 8);
  }
  g.endShape(CLOSE);
}

function tornRect(g, cx, cy, w, h, roughness) {
  g.beginShape();
  const corners = [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5]
  ];
  for (const [sx, sy] of corners) {
    for (let i = 0; i < 7; i += 1) {
      const jitterX = g.random(-w, w) * roughness;
      const jitterY = g.random(-h, h) * roughness;
      g.vertex(cx + sx * w + jitterX, cy + sy * h + jitterY);
    }
  }
  g.endShape(CLOSE);
}

class GenerativeEye {
  constructor(side, x, y) {
    this.side = side;
    this.center = createVector(x, y);
    this.phase = random(TAU);
    this.seed = random(1000);
    this.scale = min(width, height) * 0.23;
    this.samples = Array.from({ length: 120 }, (_, i) => i / 120);
  }

  updateLayout() {
    this.center.x = this.side === "left" ? width * 0.33 : width * 0.67;
    this.center.y = height * 0.5;
    this.scale = min(width, height) * 0.23;
  }

  drawToTrace(visibility) {
    if (visibility <= 0.02) return;

    traceLayer.push();
    traceLayer.noFill();
    traceLayer.stroke(7, 7, 7, 18 + visibility * 42);
    traceLayer.strokeWeight(0.45 + visibility * 0.55);
    traceLayer.beginShape();

    for (const t of this.samples) {
      const angle = t * TAU;
      const waviness = noise(this.seed, t * 3.2, frameCount * 0.005) - 0.5;
      const rx = this.scale * (0.93 + waviness * 0.18);
      const ry = this.scale * (0.29 + sin(angle * 2 + this.phase) * 0.025);
      const blink = map(sin(frameCount * 0.028 + this.phase), -1, 1, 0.82, 1.08);
      const x = this.center.x + cos(angle) * rx;
      const y = this.center.y + sin(angle) * ry * blink;
      traceLayer.curveVertex(x, y);
    }

    traceLayer.endShape(CLOSE);

    for (let i = 0; i < 3; i += 1) {
      const a = noise(this.seed + i, frameCount * 0.009) * TAU;
      const r = this.scale * random(0.1, 0.52);
      const from = createVector(this.center.x + cos(a) * r, this.center.y + sin(a) * r * 0.34);
      const to = createVector(
        this.center.x + cos(a + noise(frameCount * 0.005, i) * 1.5) * this.scale * random(0.48, 0.94),
        this.center.y + sin(a + this.phase) * this.scale * random(0.08, 0.38)
      );

      traceLayer.stroke(7, 7, 7, 9 + visibility * 24);
      traceLayer.bezier(
        from.x,
        from.y,
        lerp(from.x, to.x, 0.32),
        from.y + random(-18, 18),
        lerp(from.x, to.x, 0.7),
        to.y + random(-18, 18),
        to.x,
        to.y
      );
    }

    traceLayer.pop();
  }

  drawLiving(visibility) {
    if (visibility <= 0.01) return;

    push();
    translate(this.center.x, this.center.y);
    noFill();
    stroke(0, 230 * visibility);
    strokeWeight(1.1);

    for (let layer = 0; layer < 8; layer += 1) {
      beginShape();
      for (let i = 0; i <= 120; i += 1) {
        const t = i / 120;
        const angle = t * TAU;
        const n = noise(this.seed + layer * 0.07, t * 2.4, frameCount * 0.012);
        const rx = this.scale * (0.86 - layer * 0.025 + n * 0.09);
        const ry = this.scale * (0.25 - layer * 0.011 + n * 0.035);
        curveVertex(cos(angle) * rx, sin(angle) * ry);
      }
      endShape(CLOSE);
    }

    const pupilDrift = createVector(
      map(noise(this.seed, frameCount * 0.01), 0, 1, -this.scale * 0.12, this.scale * 0.12),
      map(noise(this.seed + 10, frameCount * 0.01), 0, 1, -this.scale * 0.035, this.scale * 0.035)
    );

    stroke(0, 180 * visibility);
    for (let i = 0; i < 22; i += 1) {
      const a = (i / 22) * TAU + this.phase + frameCount * 0.006;
      line(
        pupilDrift.x + cos(a) * this.scale * 0.08,
        pupilDrift.y + sin(a) * this.scale * 0.04,
        pupilDrift.x + cos(a) * this.scale * random(0.2, 0.38),
        pupilDrift.y + sin(a) * this.scale * random(0.08, 0.18)
      );
    }

    pop();
  }
}

class FlowParticle {
  constructor(x, y) {
    this.pos = createVector(x, y);
    this.prev = this.pos.copy();
    this.seed = random(1000);
    this.speed = random(0.55, 1.7);
  }

  step(intensity) {
    this.prev.set(this.pos);
    const angle =
      noise(this.pos.x * 0.0024, this.pos.y * 0.0024, frameCount * 0.004 + this.seed) * TAU * 3.4;
    this.pos.x += cos(angle) * this.speed * intensity;
    this.pos.y += sin(angle) * this.speed * intensity;

    if (this.pos.x < -20 || this.pos.x > width + 20 || this.pos.y < -20 || this.pos.y > height + 20) {
      this.pos.set(random(width), random(height));
      this.prev.set(this.pos);
    }

    traceLayer.stroke(7, 7, 7, 4 + intensity * 12);
    traceLayer.strokeWeight(0.35);
    traceLayer.line(this.prev.x, this.prev.y, this.pos.x, this.pos.y);
  }
}

class AutonomousThread {
  constructor() {
    this.reset();
  }

  reset() {
    this.pos = createVector(random(width), random(height));
    this.vel = p5.Vector.random2D().mult(random(0.4, 1.4));
    this.life = random(70, 190);
    this.seed = random(1000);
  }

  step(active) {
    if (!active) return;

    const previous = this.pos.copy();
    const turn = noise(this.seed, frameCount * 0.02) - 0.5;
    this.vel.rotate(turn * 0.9);
    this.vel.mult(0.993);
    this.vel.add(p5.Vector.random2D().mult(0.04));
    this.pos.add(this.vel);
    this.life -= 1;

    traceLayer.stroke(0, random(10, 34));
    traceLayer.strokeWeight(random(0.2, 0.9));
    traceLayer.line(previous.x, previous.y, this.pos.x, this.pos.y);

    if (
      this.life <= 0 ||
      this.pos.x < -40 ||
      this.pos.x > width + 40 ||
      this.pos.y < -40 ||
      this.pos.y > height + 40
    ) {
      this.reset();
    }
  }
}

window.setup = () => {
  const canvas = createCanvas(windowWidth, windowHeight);
  canvas.parent("stage");
  pixelDensity(1);
  noiseDetail(4, 0.52);
  resetComposition();
  issueInstruction(pickNextInstruction(null));
  updateReadout();
};

window.draw = () => {
  predictCameraState();
  advanceScoreState();

  image(collageLayers[instructionState], 0, 0, width, height);
  drawStageLabels();
};

function drawStageLabels() {
  push();
  noStroke();
  fill(0, scorePhase === SCORE_PHASES.CONFIRM ? 220 : 168);
  textFont("ui-monospace, SFMono-Regular, Menlo, Consolas, monospace");
  textSize(11);
  textAlign(LEFT, BOTTOM);
  text(`instruction: ${instructionLabel(instructionState)}`, 18, height - 34);
  text(`performer: ${stateLabels[detectedState]}`, 18, height - 18);

  if (scorePhase === SCORE_PHASES.WAIT) {
    const progress = matchStartedAt ? constrain((performance.now() - matchStartedAt) / MATCH_HOLD_MS, 0, 1) : 0;
    noFill();
    stroke(0, 140);
    rect(18, height - 58, 118, 6);
    noStroke();
    fill(0, 180);
    rect(18, height - 58, 118 * progress, 6);
    textAlign(LEFT, BOTTOM);
    text("waiting", 144, height - 52);
  }

  if (scorePhase === SCORE_PHASES.CONFIRM) {
    textAlign(CENTER, CENTER);
    textSize(13);
    text("confirmed", width * 0.5, height * 0.16);
  }
  pop();
}

window.windowResized = () => {
  resizeCanvas(windowWidth, windowHeight);
  resetComposition();
};

window.keyPressed = () => {
  const mapped = MANUAL_KEYS[key];
  if (mapped) {
    manualMode = true;
    manualPerformedState = mapped;
    needsFreshDeparture = false;
    const simulated = coverageFromState(mapped);
    stableCoverage.left = simulated.left;
    stableCoverage.right = simulated.right;
    cameraState = mapped;
    detectedState = mapped;
    updateReadout();
    return false;
  }

  if (key === "m" || key === "M") {
    manualMode = !manualMode;
    if (!manualMode) manualPerformedState = null;
    updateReadout();
    return false;
  }

  return true;
};

cameraButton.addEventListener("click", enableCamera);

if (!navigator.mediaDevices?.getUserMedia) {
  setStatus("This browser cannot access a camera here. Manual mode is available.");
  trackingStatus = "unsupported browser";
  manualMode = true;
  updateReadout();
}

window.addEventListener("error", (event) => {
  lastError = event.message || "unknown script error";
  updateDiagnostics();
});

window.addEventListener("unhandledrejection", (event) => {
  lastError = cameraErrorMessage(event.reason);
  updateDiagnostics();
});

window.blindSpotsDebug = {
  loadMediaPipe,
  state: () => ({
    instructionState,
    detectedState,
    scorePhase,
    mediaReady,
    trackingStatus,
    stableCoverage,
    rawCoverage,
    lastError
  })
};

updateDiagnostics();
