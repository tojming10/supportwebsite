const messageInput = document.querySelector("#customerMessage");
const charCount = document.querySelector("#charCount");
const draftButton = document.querySelector("#draftButton");
const copyButton = document.querySelector("#copyButton");
const draftOutput = document.querySelector("#draftOutput");
const outputTitle = document.querySelector("#outputTitle");
const sourceStatus = document.querySelector("#sourceStatus");
const detectedLanguage = document.querySelector("#detectedLanguage");
const translatedMessage = document.querySelector("#translatedMessage");
const translateToggleWrap = document.querySelector("#translateToggleWrap");
const translateDraftToggle = document.querySelector("#translateDraftToggle");
const toneSelect = document.querySelector("#tone");
const prioritySelect = document.querySelector("#priority");
const agentNameInput = document.querySelector("#agentName");
const companyNameInput = document.querySelector("#companyName");

let latestDrafts = {
  english: "",
  originalLanguage: "",
  originalLanguageName: "English",
};

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

function setLoading(isLoading) {
  draftButton.disabled = isLoading;
  draftButton.textContent = isLoading ? "Preparing draft..." : "Draft response";
}

function setStatus(message, type = "") {
  sourceStatus.textContent = message;
  sourceStatus.className = `source-status ${type}`.trim();
}

async function updateDraftDisplay() {
  if (translateDraftToggle.checked && !latestDrafts.originalLanguage && latestDrafts.originalLanguageName !== "English") {
    draftOutput.textContent = "Translating the email draft to the customer's original language...";

    try {
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          draft: latestDrafts.english,
          languageName: latestDrafts.originalLanguageName,
        }),
      });
      const result = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(result.error || "Unable to translate the draft.");
      }
      latestDrafts.originalLanguage = result.translatedDraft;
    } catch (error) {
      translateDraftToggle.checked = false;
      setStatus(error.message, "error");
    }
  }

  const useOriginalLanguage = translateDraftToggle.checked && latestDrafts.originalLanguage;
  draftOutput.textContent = useOriginalLanguage ? latestDrafts.originalLanguage : latestDrafts.english;
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
    references: [],
    tone: toneSelect.value,
    priority: prioritySelect.value,
    agentName: agentNameInput.value.trim() || "Support Team",
    companyName: companyNameInput.value.trim() || "Your Company",
    mode: "email",
    useKnowledgeBase: false,
  };

  setLoading(true);
  setStatus("Detecting language, translating to English, and preparing a support-ready email...");
  outputTitle.textContent = "Working on your draft";
  draftOutput.textContent = "Detecting the customer language, translating the message to English, and preparing a support-ready email.";
  translateDraftToggle.checked = false;
  translateToggleWrap.classList.add("hidden");

  try {
    const response = await fetch("/api/draft", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      throw new Error("The drafting service did not return a valid response. It may have timed out while reading the linked pages.");
    }

    if (!response.ok) {
      throw new Error(result.error || "Unable to create the draft.");
    }

    if (!result.draft) {
      throw new Error("The drafting service finished, but no draft was returned.");
    }

    outputTitle.textContent = "Email response draft";
    latestDrafts = {
      english: result.draft,
      originalLanguage: result.localizedDraft || "",
      originalLanguageName: result.language?.name || "English",
    };
    updateDraftDisplay();

    detectedLanguage.textContent = result.language?.name || "Unknown";
    translatedMessage.textContent = result.translatedMessage || message;

    const canTranslateDraft = Boolean(result.language && result.language.code !== "en");
    translateToggleWrap.classList.toggle("hidden", !canTranslateDraft);

    const fetched = result.sources.filter((source) => source.status === "fetched").length;
    const total = result.sources.length;
    const included = result.diagnostics?.includedPages || fetched;
    setStatus(`Read ${fetched} of ${total} discovered source ${total === 1 ? "item" : "items"} and used ${included} in the draft.`, "success");
    if (result.warning) {
      setStatus(`Read ${fetched} of ${total} discovered source ${total === 1 ? "item" : "items"}. AI fallback was used: ${result.warning}`, "success");
    }
  } catch (error) {
    outputTitle.textContent = "Draft failed";
    draftOutput.classList.add("empty-warning");
    draftOutput.textContent = error.message;
    setStatus("Could not create the draft. Check the message and try again.", "error");
  } finally {
    setLoading(false);
  }
}

async function readJsonResponse(response) {
  const responseText = await response.text();
  try {
    return responseText ? JSON.parse(responseText) : {};
  } catch {
    return { error: "The server did not return a valid response." };
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
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

updateCharCount();

messageInput.addEventListener("input", updateCharCount);
draftButton.addEventListener("click", draftResponse);
copyButton.addEventListener("click", copyDraft);
translateDraftToggle.addEventListener("change", updateDraftDisplay);
