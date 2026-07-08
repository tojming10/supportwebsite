const referenceList = document.querySelector("#referenceList");
const addReferenceButton = document.querySelector("#addReference");
const messageInput = document.querySelector("#customerMessage");
const charCount = document.querySelector("#charCount");
const draftButton = document.querySelector("#draftButton");
const copyButton = document.querySelector("#copyButton");
const draftOutput = document.querySelector("#draftOutput");
const outputTitle = document.querySelector("#outputTitle");
const sourceStatus = document.querySelector("#sourceStatus");
const modeButtons = document.querySelectorAll(".mode");
const toneSelect = document.querySelector("#tone");
const prioritySelect = document.querySelector("#priority");
const agentNameInput = document.querySelector("#agentName");
const companyNameInput = document.querySelector("#companyName");

let currentMode = "chat";

const starterReferences = [
  "",
];

function createReference(value = "") {
  const row = document.createElement("div");
  row.className = "reference-item";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Link or reference note";
  input.value = value;

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove-reference";
  remove.setAttribute("aria-label", "Remove reference");
  remove.textContent = "x";
  remove.addEventListener("click", () => {
    row.remove();
    if (!referenceList.children.length) {
      createReference();
    }
  });

  row.append(input, remove);
  referenceList.append(row);
}

function getReferences() {
  return [...referenceList.querySelectorAll("input")]
    .map((input) => input.value.trim())
    .filter(Boolean);
}

function summarizeIssue(message) {
  const trimmed = message.replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  return trimmed.length > 180 ? `${trimmed.slice(0, 180)}...` : trimmed;
}

function detectNeeds(message) {
  const lower = message.toLowerCase();
  const needs = [];

  if (lower.includes("error") || lower.includes("bug") || lower.includes("failed")) {
    needs.push("error message or screenshot");
  }
  if (lower.includes("login") || lower.includes("password") || lower.includes("account")) {
    needs.push("account email or user ID");
  }
  if (lower.includes("billing") || lower.includes("invoice") || lower.includes("refund")) {
    needs.push("invoice number or billing date");
  }
  if (lower.includes("slow") || lower.includes("loading") || lower.includes("browser")) {
    needs.push("browser, device, and approximate time of issue");
  }

  return needs.length ? needs : ["affected account, exact steps taken, and any screenshot or error text"];
}

function buildReferenceText(references) {
  if (!references.length) {
    return "I do not have confirmed reference material yet, so I will avoid guessing and ask for the right details.";
  }

  return references.map((reference, index) => `${index + 1}. ${reference}`).join("\n");
}

function setLoading(isLoading) {
  draftButton.disabled = isLoading;
  draftButton.textContent = isLoading ? "Reading links..." : "Draft response";
}

function setStatus(message, type = "") {
  sourceStatus.textContent = message;
  sourceStatus.className = `source-status ${type}`.trim();
}

async function draftResponse() {
  const message = messageInput.value.trim();
  draftOutput.classList.remove("empty-warning");

  if (!message) {
    outputTitle.textContent = "Add a customer message";
    draftOutput.classList.add("empty-warning");
    draftOutput.textContent = "Paste the customer question or email first, then draft the response.";
    return;
  }

  const payload = {
    message,
    references: getReferences(),
    tone: toneSelect.value,
    priority: prioritySelect.value,
    agentName: agentNameInput.value.trim() || "Support Team",
    companyName: companyNameInput.value.trim() || "Your Company",
    mode: currentMode,
  };

  setLoading(true);
  setStatus("Reading linked pages and finding relevant article content...");
  outputTitle.textContent = "Working on your draft";
  draftOutput.textContent = "Fetching the references, extracting page content, and matching it to the customer message.";

  try {
    const response = await fetch("/api/draft", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "Unable to create the draft.");
    }

    outputTitle.textContent = currentMode === "chat" ? "Chat response draft" : "Email response draft";
    draftOutput.textContent = result.draft;

    const fetched = result.sources.filter((source) => source.status === "fetched").length;
    const total = result.sources.length;
    setStatus(`Used ${fetched} of ${total} discovered source ${total === 1 ? "page" : "pages"} for this draft.`, "success");
  } catch (error) {
    outputTitle.textContent = "Draft failed";
    draftOutput.classList.add("empty-warning");
    draftOutput.textContent = error.message;
    setStatus("Could not read the references. Check the links and try again.", "error");
  } finally {
    setLoading(false);
  }
}

function updateCharCount() {
  const count = messageInput.value.length;
  charCount.textContent = `${count.toLocaleString()} ${count === 1 ? "character" : "characters"}`;
}

async function copyDraft() {
  const text = draftOutput.textContent.trim();
  if (!text) return;

  await navigator.clipboard.writeText(text);
  copyButton.textContent = "Copied";
  setTimeout(() => {
    copyButton.textContent = "Copy";
  }, 1500);
}

starterReferences.forEach(createReference);
updateCharCount();

addReferenceButton.addEventListener("click", () => createReference());
messageInput.addEventListener("input", updateCharCount);
draftButton.addEventListener("click", draftResponse);
copyButton.addEventListener("click", copyDraft);

modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    modeButtons.forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    currentMode = button.dataset.mode;
    if (messageInput.value.trim()) {
      draftResponse();
    }
  });
});
