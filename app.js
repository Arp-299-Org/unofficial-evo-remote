const CTRL_SERVICE = "8903136c-5f13-4548-a885-c58779136801";
const CTRL_CHARACTERISTIC = "8903136c-5f13-4548-a885-c58779136802";
const MAX_SPEED = 1000;
const OZOBOT_MAX_SPEED_MPS = 0.3;
const OZOBOT_WHEEL_TRACK_M = 0.023;
const COMMAND_DURATION_MS = 320;
const STOP_DURATION_MS = 120;
const STREAM_INTERVAL_MS = 100;
const ALL_ROBOT_LIGHTS = 0xff;

const MESSAGE_VELOCITY_REQUEST = 104;
const MESSAGE_VELOCITY_RESPONSE = 105;
const MESSAGE_SET_LED_REQUEST = 110;
const MESSAGE_SET_LED_RESPONSE = 111;
const COLORS = {
  red: { label: "Red", rgb: [255, 0, 0] },
  orange: { label: "Orange", rgb: [255, 110, 0] },
  yellow: { label: "Yellow", rgb: [255, 220, 0] },
  green: { label: "Green", rgb: [0, 255, 80] },
  blue: { label: "Blue", rgb: [0, 90, 255] },
  purple: { label: "Purple", rgb: [170, 80, 255] },
  pink: { label: "Pink", rgb: [255, 80, 180] },
  white: { label: "White", rgb: [255, 255, 255] },
};

const statusEl = document.querySelector("#status");
const connectEl = document.querySelector("#connect");
const disconnectEl = document.querySelector("#disconnect");
const connectedToEl = document.querySelector("#connectedTo");
const flashColorEl = document.querySelector("#flashColor");
const setColorEl = document.querySelector("#setColor");
const lightsOffEl = document.querySelector("#lightsOff");
const speedEl = document.querySelector("#speed");
const speedValueEl = document.querySelector("#speedValue");
const robotNameEl = document.querySelector("#robotName");
const streamStateEl = document.querySelector("#streamState");
const lastCommandEl = document.querySelector("#lastCommand");
const stopEl = document.querySelector("#stop");
const driveButtons = Array.from(document.querySelectorAll("[data-dir]"));
const colorSwatches = Array.from(document.querySelectorAll("[data-color]"));
const controlButtons = [...driveButtons, stopEl, flashColorEl, setColorEl, lightsOffEl];

let device = null;
let server = null;
let characteristic = null;
let requestId = 100;
let isConnected = false;
let driveTimer = null;
let driveInFlight = false;
let writeQueue = Promise.resolve();
let sentIdleStop = true;
let isFlashing = false;
let selectedColor = "red";
const active = new Set();
const pendingResponses = [];

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.classList.toggle("good", kind === "good");
  statusEl.classList.toggle("warn", kind === "warn");
}

function setConnectionState(connected, name = "") {
  isConnected = connected;
  connectedToEl.textContent = connected ? `Connected to: ${name}` : "Not connected";
  connectedToEl.classList.toggle("connected", connected);
  robotNameEl.textContent = connected ? name : "None";
  connectEl.disabled = connected || !browserCanUseBluetooth();
  disconnectEl.disabled = !connected;

  for (const control of controlButtons) {
    control.disabled = !connected || isFlashing;
  }

  if (!connected) {
    active.clear();
    sentIdleStop = true;
    streamStateEl.textContent = "Idle";
    lastCommandEl.textContent = "none";
  }
}

function selectedColorConfig() {
  return COLORS[selectedColor] || COLORS.red;
}

function updateColorSelection(nextColor, announce = true) {
  if (!COLORS[nextColor]) return;

  selectedColor = nextColor;

  for (const swatch of colorSwatches) {
    const isSelected = swatch.dataset.color === selectedColor;
    swatch.classList.toggle("selected", isSelected);
    swatch.setAttribute("aria-pressed", String(isSelected));
  }

  const { label } = selectedColorConfig();
  setColorEl.textContent = `Set ${label}`;
  if (announce) setStatus(`${label} selected`);
}

function browserCanUseBluetooth() {
  return Boolean(navigator.bluetooth && window.isSecureContext);
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function nextRequestId() {
  const id = requestId;
  requestId += 1;
  return id;
}

function floatToS24(value) {
  const encoded = Math.round(value * 16777216);
  if (encoded < -2147483648 || encoded >= 2147483648) {
    throw new RangeError(`Speed value out of range: ${value}`);
  }
  return encoded;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

function makeVelocityPacket(left, right, durationMs = COMMAND_DURATION_MS) {
  const cleanLeft = clamp(Math.round(left), -MAX_SPEED, MAX_SPEED);
  const cleanRight = clamp(Math.round(right), -MAX_SPEED, MAX_SPEED);
  const leftMps = cleanLeft / MAX_SPEED * OZOBOT_MAX_SPEED_MPS;
  const rightMps = cleanRight / MAX_SPEED * OZOBOT_MAX_SPEED_MPS;
  const linearMps = (rightMps + leftMps) / 2;
  const angularRadps = (rightMps - leftMps) / OZOBOT_WHEEL_TRACK_M;
  const id = nextRequestId();

  const buffer = new ArrayBuffer(18);
  const view = new DataView(buffer);
  view.setUint16(0, MESSAGE_VELOCITY_REQUEST, true);
  view.setUint32(2, id, true);
  view.setInt32(6, floatToS24(linearMps), true);
  view.setInt32(10, floatToS24(angularRadps), true);
  view.setInt32(14, durationMs, true);

  return { id, bytes: new Uint8Array(buffer) };
}

function makeSetLedPacket(red, green, blue, alpha = 255) {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setUint16(0, MESSAGE_SET_LED_REQUEST, true);
  view.setUint16(2, ALL_ROBOT_LIGHTS, true);
  view.setUint8(4, clamp(red, 0, 255));
  view.setUint8(5, clamp(green, 0, 255));
  view.setUint8(6, clamp(blue, 0, 255));
  view.setUint8(7, clamp(alpha, 0, 255));
  return new Uint8Array(buffer);
}

function waitForResponse(expectedMessageId, expectedRequestId = null, timeoutMs = 1200) {
  return new Promise((resolve, reject) => {
    const pending = {
      expectedMessageId,
      expectedRequestId,
      resolve,
      reject,
      timeout: window.setTimeout(() => {
        const index = pendingResponses.indexOf(pending);
        if (index >= 0) pendingResponses.splice(index, 1);
        reject(new Error("Ozobot did not answer in time"));
      }, timeoutMs),
    };
    pendingResponses.push(pending);
  });
}

async function sendRequest(bytes, expectedMessageId, expectedRequestId = null) {
  const response = waitForResponse(expectedMessageId, expectedRequestId);
  try {
    await writePacket(bytes);
  } catch (error) {
    removePendingResponse(expectedMessageId, expectedRequestId);
    throw error;
  }
  return response;
}

function removePendingResponse(expectedMessageId, expectedRequestId = null) {
  const index = pendingResponses.findIndex((pending) => {
    const messageMatches = pending.expectedMessageId === expectedMessageId;
    const requestMatches = pending.expectedRequestId === expectedRequestId;
    return messageMatches && requestMatches;
  });

  if (index < 0) return;

  const [pending] = pendingResponses.splice(index, 1);
  window.clearTimeout(pending.timeout);
}

function handleNotification(event) {
  const value = event.target.value;
  const messageId = value.getUint16(0, true);
  const responseRequestId = value.byteLength >= 6 ? value.getUint32(2, true) : null;

  const index = pendingResponses.findIndex((pending) => {
    const messageMatches = pending.expectedMessageId === messageId;
    const requestMatches = pending.expectedRequestId === null || pending.expectedRequestId === responseRequestId;
    return messageMatches && requestMatches;
  });

  if (index < 0) return;

  const [pending] = pendingResponses.splice(index, 1);
  window.clearTimeout(pending.timeout);

  if (messageId === MESSAGE_SET_LED_RESPONSE && value.byteLength >= 3) {
    const callStatus = value.getUint8(2);
    if (callStatus !== 0) {
      pending.reject(new Error(`Ozobot LED command failed (${callStatus})`));
      return;
    }
  }

  pending.resolve({ messageId, requestId: responseRequestId });
}

function writePacket(bytes) {
  const run = writeQueue.then(
    () => writePacketNow(bytes),
    () => writePacketNow(bytes),
  );
  writeQueue = run.catch(() => {});
  return run;
}

async function writePacketNow(bytes) {
  if (!characteristic) throw new Error("Ozobot is not connected");

  if (characteristic.properties.writeWithoutResponse && characteristic.writeValueWithoutResponse) {
    await characteristic.writeValueWithoutResponse(bytes);
    return;
  }

  if (characteristic.properties.write && characteristic.writeValueWithResponse) {
    await characteristic.writeValueWithResponse(bytes);
    return;
  }

  await characteristic.writeValue(bytes);
}

async function sendVelocity(left, right, durationMs = COMMAND_DURATION_MS, waitForAck = false) {
  const packet = makeVelocityPacket(left, right, durationMs);
  const response = waitForAck ? sendRequest(packet.bytes, MESSAGE_VELOCITY_RESPONSE, packet.id) : null;
  if (!waitForAck) await writePacket(packet.bytes);
  lastCommandEl.textContent = bytesToHex(packet.bytes);
  if (response) await response;
}

async function sendLed(red, green, blue, alpha = 255) {
  const bytes = makeSetLedPacket(red, green, blue, alpha);
  await sendRequest(bytes, MESSAGE_SET_LED_RESPONSE);
}

async function setSelectedColor() {
  if (!isConnected || isFlashing) return;

  active.clear();
  const { label, rgb } = selectedColorConfig();
  setStatus(`Setting ${label.toLowerCase()}...`);
  streamStateEl.textContent = `Lights: ${label}`;

  try {
    await sendVelocity(0, 0, STOP_DURATION_MS);
    await sendLed(rgb[0], rgb[1], rgb[2], 255);
    setStatus(`${label} light set`, "good");
  } catch (error) {
    setStatus(error.message, "warn");
  }
}

async function turnLightsOff() {
  if (!isConnected || isFlashing) return;

  active.clear();
  setStatus("Turning lights off...");

  try {
    await sendLed(0, 0, 0, 0);
    setStatus("Lights off", "good");
    streamStateEl.textContent = "Idle";
  } catch (error) {
    setStatus(error.message, "warn");
  }
}

function driveVector() {
  const speed = Number(speedEl.value);
  let y = 0;
  let x = 0;

  if (active.has("forward")) y += 1;
  if (active.has("reverse")) y -= 1;
  if (active.has("left")) x -= 1;
  if (active.has("right")) x += 1;

  return {
    left: clamp(y * speed + x * speed, -MAX_SPEED, MAX_SPEED),
    right: clamp(y * speed - x * speed, -MAX_SPEED, MAX_SPEED),
  };
}

function directionName() {
  if (active.has("forward") && active.has("left")) return "Forward left";
  if (active.has("forward") && active.has("right")) return "Forward right";
  if (active.has("reverse") && active.has("left")) return "Backward left";
  if (active.has("reverse") && active.has("right")) return "Backward right";
  if (active.has("forward")) return "Forward";
  if (active.has("reverse")) return "Backward";
  if (active.has("left")) return "Left";
  if (active.has("right")) return "Right";
  return "Idle";
}

async function sendDrive(vector) {
  if (!isConnected || driveInFlight || isFlashing) return;
  driveInFlight = true;
  try {
    await sendVelocity(vector.left, vector.right);
    streamStateEl.textContent = directionName();
  } catch (error) {
    setStatus(error.message, "warn");
  } finally {
    driveInFlight = false;
  }
}

async function stop() {
  active.clear();
  sentIdleStop = true;
  streamStateEl.textContent = "Stopped";
  if (!isConnected) return;
  await sendVelocity(0, 0, STOP_DURATION_MS);
}

function driveTick() {
  if (!isConnected || isFlashing) return;
  const vector = driveVector();
  if (vector.left !== 0 || vector.right !== 0) {
    sentIdleStop = false;
    sendDrive(vector);
  } else if (!sentIdleStop) {
    sentIdleStop = true;
    stop().catch((error) => setStatus(error.message, "warn"));
  }
}

function ensureDriveTimer() {
  if (!driveTimer) driveTimer = window.setInterval(driveTick, STREAM_INTERVAL_MS);
}

function setDirection(direction, enabled) {
  if (!isConnected) {
    setStatus("Connect an Evo first", "warn");
    return;
  }

  if (enabled) active.add(direction);
  else active.delete(direction);

  ensureDriveTimer();
  driveTick();
}

async function connect() {
  if (!browserCanUseBluetooth()) {
    setStatus("Use Chrome on HTTPS or localhost", "warn");
    return;
  }

  setStatus("Choosing Ozobot...");

  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "OzoEvo" }],
      optionalServices: [CTRL_SERVICE],
    });

    device.addEventListener("gattserverdisconnected", handleDisconnected);
    setStatus("Connecting...");

    server = await device.gatt.connect();
    const service = await server.getPrimaryService(CTRL_SERVICE);
    characteristic = await service.getCharacteristic(CTRL_CHARACTERISTIC);
    characteristic.addEventListener("characteristicvaluechanged", handleNotification);
    await characteristic.startNotifications();

    setConnectionState(true, device.name || "Ozobot Evo");
    await sendVelocity(0, 0, STOP_DURATION_MS, true);
    setStatus("Connected", "good");
  } catch (error) {
    setConnectionState(false);
    setStatus(error.message || "Connection canceled", "warn");
  }
}

async function disconnect() {
  try {
    if (isConnected) await stop();
  } catch (error) {
    setStatus(error.message, "warn");
  }

  if (device?.gatt?.connected) {
    device.gatt.disconnect();
  } else {
    handleDisconnected();
  }
}

function handleDisconnected() {
  characteristic = null;
  server = null;
  device = null;
  pendingResponses.splice(0).forEach((pending) => {
    window.clearTimeout(pending.timeout);
    pending.reject(new Error("Ozobot disconnected"));
  });
  setConnectionState(false);
  setStatus("Disconnected");
}

async function flashColor() {
  if (!isConnected || isFlashing) return;

  isFlashing = true;
  active.clear();
  setConnectionState(true, device?.name || "Ozobot Evo");
  const { label, rgb } = selectedColorConfig();
  setStatus(`Flashing ${label.toLowerCase()}...`);
  streamStateEl.textContent = "Identifying";

  try {
    await sendVelocity(0, 0, STOP_DURATION_MS);
    for (let i = 0; i < 3; i += 1) {
      await sendLed(rgb[0], rgb[1], rgb[2], 255);
      await sleep(220);
      await sendLed(0, 0, 0, 0);
      await sleep(160);
    }
    setStatus("Flash sent", "good");
    streamStateEl.textContent = "Idle";
  } catch (error) {
    setStatus(error.message, "warn");
  } finally {
    isFlashing = false;
    setConnectionState(Boolean(characteristic), device?.name || "Ozobot Evo");
  }
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function releasePointer(event) {
  const dir = event.currentTarget.dataset.dir;
  try {
    event.currentTarget.releasePointerCapture(event.pointerId);
  } catch {
    // Some browsers release pointer capture automatically.
  }
  setDirection(dir, false);
}

connectEl.addEventListener("click", connect);
disconnectEl.addEventListener("click", disconnect);
flashColorEl.addEventListener("click", flashColor);
setColorEl.addEventListener("click", setSelectedColor);
lightsOffEl.addEventListener("click", turnLightsOff);
stopEl.addEventListener("click", () => stop().catch((error) => setStatus(error.message, "warn")));

for (const swatch of colorSwatches) {
  swatch.addEventListener("click", () => updateColorSelection(swatch.dataset.color));
}

for (const button of driveButtons) {
  const dir = button.dataset.dir;
  button.addEventListener("pointerdown", (event) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDirection(dir, true);
  });
  button.addEventListener("pointerup", releasePointer);
  button.addEventListener("pointercancel", releasePointer);
  button.addEventListener("lostpointercapture", () => setDirection(dir, false));
}

const keyMap = {
  w: "forward",
  ArrowUp: "forward",
  s: "reverse",
  ArrowDown: "reverse",
  a: "left",
  ArrowLeft: "left",
  d: "right",
  ArrowRight: "right",
};

document.addEventListener("keydown", (event) => {
  if (event.key === " " || event.key === "Escape") {
    event.preventDefault();
    stop().catch((error) => setStatus(error.message, "warn"));
    return;
  }

  const dir = keyMap[event.key];
  if (dir) {
    event.preventDefault();
    setDirection(dir, true);
  }
});

document.addEventListener("keyup", (event) => {
  const dir = keyMap[event.key];
  if (dir) {
    event.preventDefault();
    setDirection(dir, false);
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && isConnected) {
    stop().catch((error) => setStatus(error.message, "warn"));
  }
});

window.addEventListener("blur", () => {
  if (isConnected) {
    stop().catch((error) => setStatus(error.message, "warn"));
  }
});

speedEl.addEventListener("input", () => {
  speedValueEl.textContent = speedEl.value;
});

if (!browserCanUseBluetooth()) {
  setStatus("Use Chrome on HTTPS or localhost", "warn");
}

updateColorSelection(selectedColor, false);
setConnectionState(false);
