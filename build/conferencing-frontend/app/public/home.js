const params = new URLSearchParams(window.location.search);
const janusOverride = params.get("janus")?.trim() || "";

const createForm = document.getElementById("createForm");
const joinForm = document.getElementById("joinForm");
const createPanel = document.getElementById("createPanel");
const showCreateButton = document.getElementById("showCreateButton");
const hideCreateButton = document.getElementById("hideCreateButton");
const homeDate = document.getElementById("homeDate");
const createdPanel = document.getElementById("createdPanel");
const createdTitle = document.getElementById("createdTitle");
const createdLink = document.getElementById("createdLink");
const createdCode = document.getElementById("createdCode");
const enterCreatedRoom = document.getElementById("enterCreatedRoom");

function normalizeCode(value) {
  return value.trim().toLowerCase();
}

function meetingPath(code) {
  const path = `/meet/${encodeURIComponent(code)}`;
  if (!janusOverride) {
    return path;
  }
  const url = new URL(path, window.location.origin);
  url.searchParams.set("janus", janusOverride);
  return `${url.pathname}${url.search}`;
}

function meetingLink(code) {
  return new URL(meetingPath(code), window.location.origin).toString();
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

const createNameInput = createForm.elements.displayName;
const joinNameInput = joinForm.elements.displayName;

if (homeDate) {
  homeDate.textContent = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date());
}

if (createNameInput && !createNameInput.value) {
  createNameInput.value = randomName();
}
if (joinNameInput && !joinNameInput.value) {
  joinNameInput.value = randomName();
}

createNameInput?.addEventListener("focus", () => createNameInput.select());
joinNameInput?.addEventListener("focus", () => joinNameInput.select());

showCreateButton?.addEventListener("click", () => {
  createPanel.hidden = false;
  createdPanel.hidden = true;
  createNameInput?.focus();
});

hideCreateButton?.addEventListener("click", () => {
  createPanel.hidden = true;
});

createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(createForm);
  const displayName = String(form.get("displayName") || "").trim();

  const response = await fetch("/api/meetings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const body = await response.json();
  if (!response.ok) {
    alert(body.error || "Could not create room");
    return;
  }

  const joinPath = meetingPath(body.meeting.code);
  sessionStorage.setItem(`meeting-name:${body.meeting.code}`, displayName);
  createdTitle.textContent = body.meeting.code;
  createdLink.value = meetingLink(body.meeting.code);
  createdCode.value = body.meeting.code;
  enterCreatedRoom.href = joinPath;
  createdPanel.hidden = false;
  window.location.href = joinPath;
});

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(joinForm);
  const code = normalizeCode(String(form.get("code") || ""));
  const displayName = String(form.get("displayName") || "").trim();
  if (code) {
    sessionStorage.setItem(`meeting-name:${code}`, displayName);
    window.location.href = meetingPath(code);
  }
});
