const { createReadStream, existsSync, readFileSync, statSync } = require("node:fs");
const { readFile } = require("node:fs/promises");
const { randomBytes } = require("node:crypto");
const { extname, join, normalize } = require("node:path");
const { createServer: createHttpServer } = require("node:http");
const { createServer: createHttpsServer } = require("node:https");
const { WebSocket: ProxyWebSocket, WebSocketServer } = require("ws");

const port = Number.parseInt(process.env.FRONTEND_PORT || "80", 10);
const httpsPort = Number.parseInt(process.env.FRONTEND_HTTPS_PORT || "443", 10);
const publicDir = process.env.FRONTEND_PUBLIC_DIR || join(__dirname, "public");
const tlsCertPath = process.env.FRONTEND_TLS_CERT || "/etc/certstore/fullchain.pem";
const tlsKeyPath = process.env.FRONTEND_TLS_KEY || "/etc/certstore/privkey.pem";
const tlsReloadIntervalMs = Number.parseInt(process.env.FRONTEND_TLS_RELOAD_INTERVAL_MS || "60000", 10);
const versionPath = "/usr/share/dvrtc/version.json";
const janusWsPort = process.env.JANUS_WS_PORT || "8188";
const maxMeetings = Number.parseInt(process.env.FRONTEND_MAX_MEETINGS || "500", 10);
const meetingTtlMs = Number.parseInt(process.env.FRONTEND_MEETING_TTL_MS || "14400000", 10);
const emptyRoomTtlMs = Number.parseInt(process.env.FRONTEND_EMPTY_ROOM_TTL_MS || "60000", 10);
const meetingCleanupBatchSize = Number.parseInt(process.env.FRONTEND_MEETING_CLEANUP_BATCH_SIZE || "20", 10);
const meetingCleanupScanLimit = Number.parseInt(process.env.FRONTEND_MEETING_CLEANUP_SCAN_LIMIT || "100", 10);
const appRoomMin = Number.parseInt(process.env.FRONTEND_APP_ROOM_MIN || "800000", 10);
const appRoomMax = Number.parseInt(process.env.FRONTEND_APP_ROOM_MAX || "899999", 10);
if (!Number.isSafeInteger(appRoomMin) || !Number.isSafeInteger(appRoomMax) || appRoomMin < 1 || appRoomMax < appRoomMin) {
  throw new Error("FRONTEND_APP_ROOM_MIN and FRONTEND_APP_ROOM_MAX must define a positive numeric range");
}
const meetings = new Map();
let cleanupInFlight = null;

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wav": "audio/wav",
  ".webm": "video/webm",
};

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value) + "\n", "application/json; charset=utf-8");
}

function isLocalRequest(req) {
  const address = req.socket.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function randomId() {
  return randomBytes(12).toString("hex");
}

function meetingCode() {
  return [0, 1, 2].map(() => randomBytes(2).toString("hex")).join("-");
}

function roomId() {
  return appRoomMin + Math.floor(Math.random() * (appRoomMax - appRoomMin + 1));
}

function publicMeeting(meeting) {
  return {
    code: meeting.code,
    createdAt: meeting.createdAt,
  };
}

function isSecureRequest(req) {
  return Boolean(req.socket.encrypted) || req.headers["x-forwarded-proto"] === "https";
}

function janusUrls(req, meeting) {
  const host = req.headers.host || `127.0.0.1:${isSecureRequest(req) ? httpsPort : port}`;
  const scheme = isSecureRequest(req) ? "wss" : "ws";
  return {
    websocket: `${scheme}://${host}/janus/${meeting.wsSecret}`,
  };
}

function resolvePublicPath(urlPath) {
  const cleanPath = normalize(decodeURIComponent(urlPath.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  const relativePath = cleanPath === "/" ? "index.html" : cleanPath.replace(/^[/\\]/, "");
  return join(publicDir, relativePath);
}

function currentTlsMaterialSignature() {
  if (!existsSync(tlsCertPath) || !existsSync(tlsKeyPath)) {
    return null;
  }
  const certStat = statSync(tlsCertPath);
  const keyStat = statSync(tlsKeyPath);
  return `${certStat.mtimeMs}:${certStat.size}:${keyStat.mtimeMs}:${keyStat.size}`;
}

function readTlsOptions() {
  return {
    cert: readFileSync(tlsCertPath),
    key: readFileSync(tlsKeyPath),
  };
}

function ensureHttpsServer(reason = "startup") {
  if (process.env.FRONTEND_HTTPS === "0") {
    return;
  }

  const signature = currentTlsMaterialSignature();
  if (!signature) {
    if (!httpsServer && !tlsMissingLogged) {
      console.log("DVRTC Meet HTTPS disabled: certificate files not found or FRONTEND_HTTPS=0");
      tlsMissingLogged = true;
    }
    return;
  }
  tlsMissingLogged = false;
  if (signature === tlsMaterialSignature) {
    return;
  }

  try {
    const tlsOptions = readTlsOptions();
    if (httpsServer) {
      httpsServer.setSecureContext(tlsOptions);
      tlsMaterialSignature = signature;
      console.log(`DVRTC Meet HTTPS certificate reloaded (${reason})`);
      return;
    }

    httpsServer = createHttpsServer(tlsOptions, appHandler);
    httpsServer.on("upgrade", handleUpgrade);
    httpsServer.listen(httpsPort, "0.0.0.0", () => {
      tlsMaterialSignature = signature;
      console.log(`DVRTC Meet app listening on https port ${httpsPort}`);
    });
  } catch (error) {
    console.error(`Failed to enable or reload HTTPS (${reason}): ${error.message}`);
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 8192) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

class JanusControl {
  constructor() {
    this.url = `ws://127.0.0.1:${janusWsPort}`;
    this.ws = null;
    this.sessionId = null;
    this.handleId = null;
    this.transactions = new Map();
    this.waiters = [];
  }

  async connect() {
    this.ws = new WebSocket(this.url, "janus-protocol");
    this.ws.addEventListener("message", (event) => this.onMessage(JSON.parse(event.data)));
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    const created = await this.request({ janus: "create" });
    this.sessionId = created.data.id;
    const attached = await this.request({
      janus: "attach",
      plugin: "janus.plugin.videoroom",
      session_id: this.sessionId,
    });
    this.handleId = attached.data.id;
  }

  request(message) {
    const transaction = randomId();
    this.ws.send(JSON.stringify({ ...message, transaction }));
    return new Promise((resolve, reject) => {
      this.transactions.set(transaction, { resolve, reject });
      setTimeout(() => {
        if (this.transactions.has(transaction)) {
          this.transactions.delete(transaction);
          reject(new Error("Janus transaction timed out"));
        }
      }, 8000);
    });
  }

  async message(body) {
    const eventPromise = this.waitFor((message) => message.sender === this.handleId && message.plugindata);
    await this.request({
      janus: "message",
      session_id: this.sessionId,
      handle_id: this.handleId,
      body,
    });
    return eventPromise;
  }

  waitFor(predicate) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      this.waiters.push(waiter);
      setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) {
          this.waiters.splice(index, 1);
          reject(new Error("Janus event timed out"));
        }
      }, 8000);
    });
  }

  onMessage(message) {
    if (message.transaction && this.transactions.has(message.transaction)) {
      const pending = this.transactions.get(message.transaction);
      this.transactions.delete(message.transaction);
      if (message.janus === "error") {
        pending.reject(new Error(message.error?.reason || "Janus error"));
      } else {
        pending.resolve(message);
      }
    }

    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(message)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
        return;
      }
    }
  }

  async close() {
    if (this.sessionId) {
      await this.request({ janus: "destroy", session_id: this.sessionId }).catch(() => {});
    }
    if (this.ws) {
      this.ws.close();
    }
  }
}

async function createJanusRoomWithControl(control, meeting) {
  const event = await control.message({
    request: "create",
    room: meeting.room,
    description: meeting.code,
    publishers: 24,
    bitrate: 2500000,
    fir_freq: 10,
    audiocodec: "opus",
    videocodec: "vp8,h264",
    record: false,
    permanent: false,
  });
  const data = event.plugindata?.data || {};
  if (data.videoroom !== "created" && data.error_code !== 427) {
    throw new Error(data.error || "failed to create Janus room");
  }
  meeting.janusRoomActive = true;
}

async function createJanusRoom(meeting) {
  const control = new JanusControl();
  await control.connect();
  try {
    await createJanusRoomWithControl(control, meeting);
  } finally {
    await control.close();
  }
}

async function janusListRooms(control) {
  const event = await control.message({ request: "list" });
  const data = event.plugindata?.data || {};
  if (!Array.isArray(data.list)) {
    throw new Error(data.error || "Janus did not return a room list");
  }
  return data.list;
}

async function janusRoomParticipantCount(control, meeting) {
  const event = await control.message({
    request: "listparticipants",
    room: meeting.room,
  });
  const data = event.plugindata?.data || {};
  if (data.error_code === 426 || /no such room/i.test(data.error || "")) {
    return null;
  }
  if (!Array.isArray(data.participants)) {
    throw new Error(data.error || "Janus did not return a participant list");
  }
  return data.participants.length;
}

async function destroyJanusRoom(control, meeting) {
  await control.message({
    request: "destroy",
    room: meeting.room,
    permanent: false,
  }).catch(() => {});
  meeting.janusRoomActive = false;
}

async function removeMeetingIfInactive(control, code, meeting) {
  const participantCount = meeting.janusRoomActive === false ? null : await janusRoomParticipantCount(control, meeting);
  if (participantCount > 0) {
    meeting.lastActiveAtMs = Date.now();
    return false;
  }

  if (code) {
    meetings.delete(code);
  }
  if (participantCount !== null) {
    await destroyJanusRoom(control, meeting);
  }
  return true;
}

async function removeEmptyRoomIfInactive(control, meeting) {
  if (meeting.janusRoomActive === false) {
    return false;
  }

  const participantCount = await janusRoomParticipantCount(control, meeting);
  if (participantCount > 0) {
    meeting.lastActiveAtMs = Date.now();
    return false;
  }

  if (participantCount === null) {
    meeting.janusRoomActive = false;
    return false;
  }

  await destroyJanusRoom(control, meeting);
  return true;
}

function meetingIdleMs(meeting) {
  const lastActiveAt = meeting.lastActiveAtMs || meeting.createdAtMs || Date.parse(meeting.createdAt);
  return Number.isFinite(lastActiveAt) ? Date.now() - lastActiveAt : 0;
}

function roomNumber(room) {
  const id = Number(room.room || room.id || room);
  return Number.isFinite(id) ? id : null;
}

function isAppOwnedRoom(room) {
  const id = roomNumber(room);
  return id !== null && id >= appRoomMin && id <= appRoomMax;
}

function isKnownMeetingRoom(id) {
  return [...meetings.values()].some((meeting) => meeting.room === id);
}

async function pruneMeetings() {
  if (cleanupInFlight) {
    return cleanupInFlight;
  }

  cleanupInFlight = (async () => {
    const candidates = [];
    const seen = new Set();

    if (Number.isFinite(meetingTtlMs) && meetingTtlMs > 0) {
      for (const [code, meeting] of meetings) {
        if (meetingIdleMs(meeting) > meetingTtlMs) {
          candidates.push({ code, meeting, action: "remove-meeting" });
          seen.add(code);
        }
      }
    }

    if (Number.isFinite(maxMeetings) && maxMeetings > 0 && meetings.size - seen.size > maxMeetings) {
      const overflow = meetings.size - seen.size - maxMeetings;
      let added = 0;
      for (const [code, meeting] of meetings) {
        if (seen.has(code)) {
          continue;
        }
        candidates.push({ code, meeting, action: "remove-meeting" });
        seen.add(code);
        added += 1;
        if (added >= overflow) {
          break;
        }
      }
    }

    if (Number.isFinite(emptyRoomTtlMs) && emptyRoomTtlMs > 0) {
      for (const [code, meeting] of meetings) {
        if (seen.has(code) || meeting.janusRoomActive === false) {
          continue;
        }
        if (meetingIdleMs(meeting) > emptyRoomTtlMs) {
          candidates.push({ code, meeting, action: "remove-empty-room" });
          seen.add(code);
        }
      }
    }

    const batchSize = Number.isFinite(meetingCleanupBatchSize) && meetingCleanupBatchSize > 0 ? meetingCleanupBatchSize : 20;
    const scanLimit = Number.isFinite(meetingCleanupScanLimit) && meetingCleanupScanLimit > 0 ? meetingCleanupScanLimit : batchSize;
    const control = new JanusControl();
    await control.connect();
    try {
      let checked = 0;
      let removed = 0;
      for (const candidate of candidates) {
        if (checked >= scanLimit || removed >= batchSize) {
          break;
        }
        checked += 1;
        const didRemove = await (candidate.action === "remove-empty-room"
          ? removeEmptyRoomIfInactive(control, candidate.meeting)
          : removeMeetingIfInactive(control, candidate.code, candidate.meeting)
        ).catch((error) => {
          console.error(`Failed to prune Janus room ${candidate.meeting.room}: ${error.message}`);
          return false;
        });
        if (didRemove) {
          removed += 1;
        }
      }

      if (checked < scanLimit && removed < batchSize) {
        const orphanRooms = await janusListRooms(control).catch((error) => {
          console.error(`Failed to list Janus rooms for orphan cleanup: ${error.message}`);
          return [];
        });
        for (const room of orphanRooms) {
          if (checked >= scanLimit || removed >= batchSize) {
            break;
          }
          const id = roomNumber(room);
          if (!isAppOwnedRoom(room) || isKnownMeetingRoom(id)) {
            continue;
          }
          checked += 1;
          const didRemove = await removeMeetingIfInactive(control, null, { room: id }).catch((error) => {
            console.error(`Failed to prune orphan Janus room ${id}: ${error.message}`);
            return false;
          });
          if (didRemove) {
            removed += 1;
          }
        }
      }
    } finally {
      await control.close();
    }
  })();

  try {
    return await cleanupInFlight;
  } finally {
    cleanupInFlight = null;
  }
}

async function createMeeting(req, res) {
  pruneMeetings().catch((error) => {
    console.error(`Meeting cleanup failed: ${error.message}`);
  });

  await readJson(req);

  let code;
  do {
    code = meetingCode();
  } while (meetings.has(code));

  let janusRoom;
  do {
    janusRoom = roomId();
  } while ([...meetings.values()].some((meeting) => meeting.room === janusRoom));

  const meeting = {
    code,
    room: janusRoom,
    wsSecret: randomBytes(24).toString("hex"),
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now(),
    lastActiveAtMs: Date.now(),
    janusRoomActive: false,
  };

  await createJanusRoom(meeting);
  meetings.set(code, meeting);

  sendJson(res, 201, {
    meeting: publicMeeting(meeting),
    joinPath: `/meet/${code}`,
  });
}

async function joinMeeting(req, res, code) {
  const meeting = meetings.get(code);
  if (!meeting) {
    sendJson(res, 404, { error: "meeting not found" });
    return;
  }

  const body = await readJson(req);
  const displayName = String(body.displayName || "Guest").trim().slice(0, 48) || "Guest";

  if (meeting.janusRoomActive === false) {
    await createJanusRoom(meeting);
  }
  meeting.lastActiveAtMs = Date.now();

  sendJson(res, 200, {
    meeting: {
      ...publicMeeting(meeting),
      room: meeting.room,
    },
    participant: {
      displayName,
    },
    janus: janusUrls(req, meeting),
    iceServers: [],
  });
}

async function cleanupMeeting(req, res, code) {
  if (!isLocalRequest(req)) {
    sendJson(res, 403, { error: "cleanup is only available locally" });
    return;
  }

  const meeting = meetings.get(code);
  if (!meeting) {
    sendJson(res, 404, { error: "meeting not found" });
    return;
  }

  const control = new JanusControl();
  await control.connect();
  try {
    const removed = await removeMeetingIfInactive(control, code, meeting);
    sendJson(res, 200, { removed });
  } finally {
    await control.close();
  }
}

async function handleApi(req, res) {
  if (req.method === "GET" && req.url === "/healthz") {
    send(res, 200, "ok");
    return true;
  }

  if (req.method === "GET" && req.url === "/__version") {
    try {
      const body = await readFile(versionPath, "utf8");
      send(res, 200, body, "application/json; charset=utf-8");
    } catch {
      sendJson(res, 404, {});
    }
    return true;
  }

  if (req.method === "GET" && req.url === "/api/status") {
    sendJson(res, 200, { ok: true, meetings: meetings.size });
    return true;
  }

  if (req.method === "POST" && req.url === "/api/meetings") {
    await createMeeting(req, res);
    return true;
  }

  const joinMatch = req.url?.match(/^\/api\/meetings\/([a-f0-9-]+)\/join$/);
  if (req.method === "POST" && joinMatch) {
    await joinMeeting(req, res, joinMatch[1]);
    return true;
  }

  const cleanupMatch = req.url?.match(/^\/api\/meetings\/([a-f0-9-]+)\/cleanup$/);
  if (req.method === "POST" && cleanupMatch) {
    await cleanupMeeting(req, res, cleanupMatch[1]);
    return true;
  }

  const getMatch = req.url?.match(/^\/api\/meetings\/([a-f0-9-]+)$/);
  if (req.method === "GET" && getMatch) {
    const meeting = meetings.get(getMatch[1]);
    if (!meeting) {
      sendJson(res, 404, { error: "meeting not found" });
    } else {
      sendJson(res, 200, { meeting: publicMeeting(meeting) });
    }
    return true;
  }

  return false;
}

const appHandler = async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      send(res, 204, "");
      return;
    }

    if (await handleApi(req, res)) {
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, "method not allowed\n");
      return;
    }

    const requestPath = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname;
    if (requestPath === "/new") {
      req.url = "/";
    } else if (requestPath.match(/^\/meet\/[a-f0-9-]+$/)) {
      req.url = "/meeting.html";
    }

    const filePath = resolvePublicPath(req.url || "/");
    if (!filePath.startsWith(publicDir) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      send(res, 404, "not found\n");
      return;
    }

    const contentType = contentTypes[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
      "content-type": contentType,
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    createReadStream(filePath).pipe(res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "server error" });
  }
};

const httpServer = createHttpServer(appHandler);
let httpsServer = null;
let tlsMaterialSignature = null;
let tlsMissingLogged = false;

const janusProxyServer = new WebSocketServer({ noServer: true });

function rejectUpgrade(socket) {
  socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
  socket.destroy();
}

function meetingForSecret(secret) {
  for (const meeting of meetings.values()) {
    if (meeting.wsSecret === secret) {
      return meeting;
    }
  }
  return null;
}

function handleUpgrade(req, socket, head) {
  const match = req.url?.match(/^\/janus\/([a-f0-9]{48})$/);
  if (!match || !meetingForSecret(match[1])) {
    rejectUpgrade(socket);
    return;
  }

  janusProxyServer.handleUpgrade(req, socket, head, (client) => {
    janusProxyServer.emit("connection", client, req);
  });
}

httpServer.on("upgrade", handleUpgrade);

janusProxyServer.on("connection", (client, req) => {
  const secret = req.url.match(/^\/janus\/([a-f0-9]{48})$/)[1];
  const meeting = meetingForSecret(secret);
  if (!meeting) {
    client.close(1008, "unknown meeting");
    return;
  }

  const janus = new ProxyWebSocket(`ws://127.0.0.1:${janusWsPort}`, "janus-protocol");
  const queued = [];

  // INTENTIONALLY VULNERABLE: after a valid application room secret, this proxy forwards arbitrary Janus messages so the attacker demo can show missing room-level authorization.
  client.on("message", (message) => {
    if (janus.readyState === ProxyWebSocket.OPEN) {
      janus.send(message);
    } else {
      queued.push(message);
    }
  });

  janus.on("open", () => {
    while (queued.length > 0) {
      janus.send(queued.shift());
    }
  });

  janus.on("message", (message) => {
    if (client.readyState === ProxyWebSocket.OPEN) {
      client.send(message.toString());
    }
  });

  janus.on("error", () => {
    client.close(1011, "janus unavailable");
  });

  janus.on("close", () => {
    client.close();
  });

  client.on("close", () => {
    janus.close();
  });
});

const cleanupTimer = setInterval(() => {
  pruneMeetings().catch((error) => {
    console.error(`Meeting cleanup failed: ${error.message}`);
  });
}, 60000);
cleanupTimer.unref?.();

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`DVRTC Meet app listening on http port ${port}`);
});

ensureHttpsServer();

if (process.env.FRONTEND_HTTPS !== "0" && Number.isFinite(tlsReloadIntervalMs) && tlsReloadIntervalMs > 0) {
  const tlsReloadTimer = setInterval(() => ensureHttpsServer("periodic check"), tlsReloadIntervalMs);
  tlsReloadTimer.unref?.();
}
