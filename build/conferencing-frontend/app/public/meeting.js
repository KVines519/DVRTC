const code = window.location.pathname.split("/").pop();
const params = new URLSearchParams(window.location.search);
const botPublishOnly = params.get("botPublishOnly") === "1";

const els = {
  meetingTitle: document.getElementById("meetingTitle"),
  meetingCodeLabel: document.getElementById("meetingCodeLabel"),
  lobby: document.getElementById("lobby"),
  meetingRoom: document.getElementById("meetingRoom"),
  joinRoomForm: document.getElementById("joinRoomForm"),
  lobbyError: document.getElementById("lobbyError"),
  statusBadge: document.getElementById("statusBadge"),
  roster: document.getElementById("roster"),
  participantCount: document.getElementById("participantCount"),
  meetingLinkShare: document.getElementById("meetingLinkShare"),
  copyMeetingLinkButton: document.getElementById("copyMeetingLinkButton"),
  copyMeetingInviteButton: document.getElementById("copyMeetingInviteButton"),
  copyMeetingStatus: document.getElementById("copyMeetingStatus"),
  callError: document.getElementById("callError"),
  localVideo: document.getElementById("localVideo"),
  remoteGrid: document.getElementById("remoteGrid"),
  muteButton: document.getElementById("muteButton"),
  cameraButton: document.getElementById("cameraButton"),
  hangupButton: document.getElementById("hangupButton"),
};

let app = null;

function randomId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function setStatus(text, mode = "") {
  els.statusBadge.textContent = text;
  els.statusBadge.className = `badge ${mode}`.trim();
}

function randomName() {
  const names = [
    "Thomas Anderson",
    "Alice White",
    "Robert Grey",
    "Maya Switch",
    "Daniel Locke",
    "Evelyn Oracle",
    "Victor Keyes",
    "Nina DuJour",
    "Samuel Rhineheart",
    "Clara Bell",
    "Marcus Reed",
    "Lena Hale",
    "Julian Choi",
    "Iris Stone",
    "Owen Carter",
  ];
  return names[Math.floor(Math.random() * names.length)];
}

function renderRoster(participants) {
  const names = participants.map((item) => item.display || `Guest ${item.id}`);
  els.participantCount.textContent = names.length === 1 ? "1 participant" : `${names.length} participants`;
  // INTENTIONALLY VULNERABLE: participant display names are rendered as HTML so the scenario can demonstrate display-name XSS.
  els.roster.innerHTML = names.map((name) => (
    `<div class="participant"><span class="dot"></span><div><strong>${name}</strong><br><small>Connected</small></div></div>`
  )).join("");
}

function meetingUrl() {
  const url = new URL(`/meet/${encodeURIComponent(code)}`, window.location.origin);
  const janusOverride = params.get("janus")?.trim();
  if (janusOverride) {
    url.searchParams.set("janus", janusOverride);
  }
  return url.toString();
}

function updateInviteFields() {
  els.meetingLinkShare.value = meetingUrl();
}

function showCopyStatus(text) {
  els.copyMeetingStatus.textContent = text;
  window.setTimeout(() => {
    if (els.copyMeetingStatus.textContent === text) {
      els.copyMeetingStatus.textContent = "";
    }
  }, 1800);
}

async function copyText(value, label) {
  if (!value) {
    showCopyStatus(`${label} is empty`);
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    showCopyStatus(`${label} copied`);
  } catch {
    window.prompt(`Copy ${label.toLowerCase()}`, value);
  }
}

function setControlState(button, label, isOff, ariaLabel = label) {
  button.querySelector(".control-label").textContent = label;
  button.classList.toggle("is-off", isOff);
  button.setAttribute("aria-label", ariaLabel);
  button.title = ariaLabel;
}

function janusDisconnectReason(message) {
  const data = message.plugindata?.data || {};
  if (data.destroyed === "ok" || data.destroyed || data.videoroom === "destroyed") {
    return "This meeting has ended.";
  }
  if (data.kicked === "ok" || data.kicked) {
    return "You have been removed from the meeting.";
  }
  if (data.error_code === 426 || /no such room/i.test(data.error || "")) {
    return "This meeting is no longer available.";
  }
  if (message.janus === "hangup") {
    const reason = String(message.reason || "").toLowerCase();
    if (reason.includes("destroy") || reason.includes("room")) {
      return "This meeting has ended.";
    }
    return "You have been removed from the meeting.";
  }
  if (message.janus === "detached") {
    return "You are no longer connected to this meeting. Try joining again.";
  }
  return "You are no longer connected to the meeting.";
}

class JanusSocket {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.sessionId = null;
    this.transactions = new Map();
    this.handleCallbacks = new Map();
    this.waiters = [];
    this.keepaliveTimer = null;
  }

  async connect() {
    this.ws = new WebSocket(this.url, "janus-protocol");
    this.ws.addEventListener("message", (event) => this.onMessage(JSON.parse(event.data)));
    this.ws.addEventListener("close", () => {
      if (app && app.started && !app.stopping) {
        app.showDisconnected("Connection lost. Try joining again.");
      }
    });
    this.ws.addEventListener("error", () => {
      if (app && app.started && !app.stopping) {
        app.showDisconnected("Connection failed. Try joining again.");
      }
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    const created = await this.request({ janus: "create" });
    this.sessionId = created.data.id;
    this.keepaliveTimer = window.setInterval(() => {
      this.request({ janus: "keepalive", session_id: this.sessionId }).catch(() => {});
    }, 25000);
  }

  async attach(plugin, callback) {
    const response = await this.request({
      janus: "attach",
      plugin,
      session_id: this.sessionId,
    });
    const handleId = response.data.id;
    if (callback) {
      this.handleCallbacks.set(handleId, callback);
    }
    return handleId;
  }

  request(message) {
    const transaction = randomId();
    this.ws.send(JSON.stringify({ ...message, transaction }));
    return new Promise((resolve, reject) => {
      this.transactions.set(transaction, { resolve, reject });
      window.setTimeout(() => {
        if (this.transactions.has(transaction)) {
          this.transactions.delete(transaction);
          reject(new Error("Janus transaction timed out"));
        }
      }, 10000);
    });
  }

  message(handleId, body, jsep) {
    const payload = {
      janus: "message",
      session_id: this.sessionId,
      handle_id: handleId,
      body,
    };
    if (jsep) {
      payload.jsep = jsep;
    }
    return this.request(payload);
  }

  trickle(handleId, candidate) {
    return this.request({
      janus: "trickle",
      session_id: this.sessionId,
      handle_id: handleId,
      candidate: candidate || { completed: true },
    }).catch(() => {});
  }

  waitFor(handleId, predicate, timeout = 12000) {
    return new Promise((resolve, reject) => {
      const waiter = { handleId, predicate, resolve, reject };
      this.waiters.push(waiter);
      window.setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) {
          this.waiters.splice(index, 1);
          reject(new Error("Janus event timed out"));
        }
      }, timeout);
    });
  }

  onMessage(message) {
    if (app) {
      app.onJanusEvent(message);
    }

    if (message.transaction && this.transactions.has(message.transaction)) {
      const pending = this.transactions.get(message.transaction);
      this.transactions.delete(message.transaction);
      if (message.janus === "error") {
        pending.reject(new Error(message.error?.reason || "Janus error"));
      } else {
        pending.resolve(message);
      }
    }

    if (!message.sender) {
      return;
    }

    for (const waiter of [...this.waiters]) {
      if (waiter.handleId === message.sender && waiter.predicate(message)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
        return;
      }
    }

    const callback = this.handleCallbacks.get(message.sender);
    if (callback) {
      callback(message);
    }
  }

  async destroy() {
    if (this.keepaliveTimer) {
      window.clearInterval(this.keepaliveTimer);
    }
    if (this.sessionId) {
      await this.request({ janus: "destroy", session_id: this.sessionId }).catch(() => {});
    }
    if (this.ws) {
      this.ws.close();
    }
  }
}

class MeetingApp {
  constructor(config) {
    this.config = config;
    this.display = config.participant.displayName;
    this.janus = new JanusSocket(config.janus.websocket);
    this.publisherHandle = null;
    this.publisherPc = null;
    this.localStream = null;
    this.remoteFeeds = new Map();
    this.participants = new Map();
    this.started = false;
    this.stopping = false;
    this.connectionLossTimer = null;
  }

  async start() {
    setStatus("Joining", "warn");
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      const httpsUrl = `https://${window.location.host}${window.location.pathname}${window.location.search}`;
      const isInsecure = window.location.protocol === "http:" && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1";
      const detail = isInsecure
        ? `Camera and microphone access requires a secure (HTTPS) page. Open ${httpsUrl} instead.`
        : "This browser does not expose navigator.mediaDevices.getUserMedia.";
      const err = new Error(detail);
      err.code = "INSECURE_CONTEXT";
      throw err;
    }
    await this.janus.connect();
    this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    els.localVideo.srcObject = this.localStream;
    this.publisherHandle = await this.janus.attach("janus.plugin.videoroom", (message) => this.onPublisherEvent(message));
    await this.joinAndPublish();
    this.participants.set("self", { id: "self", display: this.display });
    renderRoster([...this.participants.values()]);
    setStatus("Live", "live");
  }

  async joinAndPublish() {
    await this.janus.message(this.publisherHandle, {
      request: "join",
      ptype: "publisher",
      room: this.config.meeting.room,
      display: this.display,
    });

    const joined = await this.janus.waitFor(this.publisherHandle, (message) => {
      return message.plugindata?.data?.videoroom === "joined";
    });

    this.privateId = joined.plugindata.data.private_id;
    this.updatePublishers(joined.plugindata.data.publishers || []);

    this.publisherPc = new RTCPeerConnection({ iceServers: this.config.iceServers });
    this.publisherPc.onicecandidate = (event) => this.janus.trickle(this.publisherHandle, event.candidate);
    this.publisherPc.onconnectionstatechange = () => this.onPublisherConnectionState();
    this.publisherPc.oniceconnectionstatechange = () => this.onPublisherConnectionState();
    this.localStream.getTracks().forEach((track) => this.publisherPc.addTrack(track, this.localStream));

    const offer = await this.publisherPc.createOffer();
    await this.publisherPc.setLocalDescription(offer);
    await this.janus.message(this.publisherHandle, {
      request: "publish",
      audio: true,
      video: true,
      data: false,
    }, this.publisherPc.localDescription);

    const published = await this.janus.waitFor(this.publisherHandle, (message) => Boolean(message.jsep));
    await this.publisherPc.setRemoteDescription(published.jsep);
    this.started = true;
  }

  onPublisherConnectionState() {
    if (!this.publisherPc || this.stopping) {
      return;
    }
    const state = this.publisherPc.connectionState;
    const iceState = this.publisherPc.iceConnectionState;
    if (["failed", "closed"].includes(state) || ["failed", "closed"].includes(iceState)) {
      this.showDisconnected("Your call connection was lost. Try joining again.");
      return;
    }
    if (state === "disconnected" || iceState === "disconnected") {
      if (!this.connectionLossTimer) {
        this.connectionLossTimer = window.setTimeout(() => {
          this.connectionLossTimer = null;
          if (!this.stopping && this.publisherPc && (this.publisherPc.connectionState === "disconnected" || this.publisherPc.iceConnectionState === "disconnected")) {
            this.showDisconnected("Your call connection was interrupted. Try joining again.");
          }
        }, 4000);
      }
    } else if (this.connectionLossTimer) {
      window.clearTimeout(this.connectionLossTimer);
      this.connectionLossTimer = null;
    }
  }

  onPublisherEvent(message) {
    const data = message.plugindata?.data;
    if (!data) {
      return;
    }
    if (data.kicked === "ok" || data.kicked || data.destroyed === "ok" || data.destroyed || data.error_code === 426) {
      this.showDisconnected(janusDisconnectReason(message));
      return;
    }
    if (data.publishers) {
      this.updatePublishers(data.publishers);
    }
    if (data.leaving || data.unpublished) {
      this.removeRemote(data.leaving || data.unpublished);
    }
  }

  updatePublishers(publishers) {
    for (const publisher of publishers) {
      if (!publisher.id || this.remoteFeeds.has(publisher.id)) {
        continue;
      }
      this.participants.set(publisher.id, publisher);
      if (!botPublishOnly) {
        this.subscribe(publisher).catch((error) => console.error(error));
      }
    }
    renderRoster([...this.participants.values()]);
  }

  async subscribe(publisher) {
    const handleId = await this.janus.attach("janus.plugin.videoroom");
    const pc = new RTCPeerConnection({ iceServers: this.config.iceServers });
    const remoteStream = new MediaStream();

    pc.onicecandidate = (event) => this.janus.trickle(handleId, event.candidate);
    pc.ontrack = (event) => {
      event.streams[0].getTracks().forEach((track) => remoteStream.addTrack(track));
    };

    this.remoteFeeds.set(publisher.id, { handleId, pc, stream: remoteStream });
    this.addRemoteVideo(publisher, remoteStream);

    await this.janus.message(handleId, {
      request: "join",
      ptype: "subscriber",
      room: this.config.meeting.room,
      feed: publisher.id,
      private_id: this.privateId,
    });

    const offerEvent = await this.janus.waitFor(handleId, (message) => Boolean(message.jsep));
    await pc.setRemoteDescription(offerEvent.jsep);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.janus.message(handleId, { request: "start", room: this.config.meeting.room }, pc.localDescription);
  }

  addRemoteVideo(publisher, stream) {
    const wrap = document.createElement("div");
    wrap.className = "video-wrap";
    wrap.dataset.feed = publisher.id;
    // INTENTIONALLY VULNERABLE: remote publisher display names are rendered as HTML so the scenario can demonstrate display-name XSS.
    wrap.innerHTML = `<video autoplay playsinline></video><span>${publisher.display || "Guest"}</span>`;
    wrap.querySelector("video").srcObject = stream;
    els.remoteGrid.appendChild(wrap);
  }

  removeRemote(feedId) {
    const feed = this.remoteFeeds.get(feedId);
    if (feed) {
      feed.pc.close();
      this.remoteFeeds.delete(feedId);
    }
    this.participants.delete(feedId);
    const element = els.remoteGrid.querySelector(`[data-feed="${feedId}"]`);
    if (element) {
      element.remove();
    }
    renderRoster([...this.participants.values()]);
  }

  showDisconnected(reason) {
    if (this.stopping) {
      return;
    }
    setStatus("Disconnected", "warn");
    els.callError.textContent = reason;
    els.callError.hidden = false;
    els.lobby.hidden = false;
    els.meetingRoom.hidden = true;
    els.lobbyError.textContent = reason;
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }
    if (this.publisherPc) {
      this.publisherPc.close();
      this.publisherPc = null;
    }
    for (const feed of this.remoteFeeds.values()) {
      feed.pc.close();
    }
    this.remoteFeeds.clear();
  }

  onJanusEvent(message) {
    if (message.janus === "hangup" || message.janus === "detached") {
      if (!message.sender || message.sender === this.publisherHandle) {
        this.showDisconnected(janusDisconnectReason(message));
      }
      return;
    }
    const data = message.plugindata?.data;
    if (!data || data.videoroom !== "event") {
      return;
    }
    if (data.kicked === "ok" || data.kicked || data.destroyed === "ok" || data.destroyed || data.error_code === 426) {
      this.showDisconnected(janusDisconnectReason(message));
    }
  }

  async stop() {
    this.stopping = true;
    setStatus("Leaving", "warn");
    for (const feed of this.remoteFeeds.values()) {
      feed.pc.close();
    }
    if (this.publisherPc) {
      this.publisherPc.close();
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
    }
    await this.janus.destroy();
    window.location.href = "/";
  }
}

async function loadMeeting() {
  const response = await fetch(`/api/meetings/${encodeURIComponent(code)}`);
  if (!response.ok) {
    els.meetingTitle.textContent = "Room not found";
    els.meetingCodeLabel.textContent = code;
    return;
  }
  await response.json();
  els.meetingTitle.textContent = code;
  els.meetingCodeLabel.textContent = code;
  updateInviteFields();
  const savedName = sessionStorage.getItem(`meeting-name:${code}`);
  const overrideName = params.get("name")?.trim();
  const autojoin = params.has("autojoin");
  const preferredName = overrideName || savedName;
  if (preferredName) {
    els.joinRoomForm.displayName.value = preferredName;
  } else if (!els.joinRoomForm.displayName.value) {
    els.joinRoomForm.displayName.value = randomName();
  }
  if (preferredName || autojoin) {
    els.joinRoomForm.requestSubmit();
  }
}

els.joinRoomForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.lobbyError.textContent = "";
  els.callError.textContent = "";
  els.callError.hidden = true;
  const form = new FormData(els.joinRoomForm);
  const displayName = String(form.get("displayName") || "").trim();

  const response = await fetch(`/api/meetings/${encodeURIComponent(code)}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  const config = await response.json();
  if (!response.ok) {
    els.lobbyError.textContent = config.error || "Unable to join";
    return;
  }

  const janusOverride = params.get("janus")?.trim();
  if (janusOverride) {
    config.janus = { ...config.janus, websocket: janusOverride };
  }

  sessionStorage.setItem(`meeting-name:${code}`, displayName);
  updateInviteFields();
  els.lobby.hidden = true;
  els.meetingRoom.hidden = false;
  els.meetingTitle.textContent = config.meeting.code;
  app = new MeetingApp(config);
  try {
    await app.start();
  } catch (error) {
    console.error(error);
    els.lobby.hidden = false;
    els.meetingRoom.hidden = true;
    els.lobbyError.textContent = error?.code === "INSECURE_CONTEXT"
      ? error.message
      : "Could not join the meeting. Try again.";
  }
});

els.muteButton.addEventListener("click", () => {
  const audio = app?.localStream?.getAudioTracks()[0];
  if (!audio) return;
  audio.enabled = !audio.enabled;
  setControlState(
    els.muteButton,
    audio.enabled ? "Mute" : "Unmute",
    !audio.enabled,
    audio.enabled ? "Mute microphone" : "Unmute microphone",
  );
});

els.cameraButton.addEventListener("click", () => {
  const video = app?.localStream?.getVideoTracks()[0];
  if (!video) return;
  video.enabled = !video.enabled;
  setControlState(
    els.cameraButton,
    video.enabled ? "Camera" : "Camera on",
    !video.enabled,
    video.enabled ? "Turn camera off" : "Turn camera on",
  );
});

els.copyMeetingLinkButton.addEventListener("click", () => copyText(els.meetingLinkShare.value, "Link"));
els.copyMeetingInviteButton.addEventListener("click", () => {
  const invite = `Join my BluePill Meetings room:\n${els.meetingLinkShare.value}`;
  copyText(invite, "Invite");
});

els.hangupButton.addEventListener("click", () => {
  if (app) {
    app.stop();
  }
});

loadMeeting();
