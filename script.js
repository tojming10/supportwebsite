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
const tabs = document.querySelectorAll(".tab");
const draftView = document.querySelector("#draftView");
const knowledgeView = document.querySelector("#knowledgeView");
const useKnowledgeBaseInput = document.querySelector("#useKnowledgeBase");
const libraryUrlInput = document.querySelector("#libraryUrl");
const sourceTypeInput = document.querySelector("#sourceType");
const referenceTagsInput = document.querySelector("#referenceTags");
const crawlLinkedPagesInput = document.querySelector("#crawlLinkedPages");
const saveReferenceButton = document.querySelector("#saveReference");
const refreshLibraryButton = document.querySelector("#refreshLibrary");
const libraryStatus = document.querySelector("#libraryStatus");
const libraryList = document.querySelector("#libraryList");

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
    useKnowledgeBase: useKnowledgeBaseInput.checked,
  };

  setLoading(true);
  setStatus(useKnowledgeBaseInput.checked ? "Searching saved knowledge and reading one-time references..." : "Reading one-time references...");
  outputTitle.textContent = "Working on your draft";
  draftOutput.textContent = "Fetching the reference page, opening links found inside it, extracting readable content, and preparing a support-ready reply.";

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

    outputTitle.textContent = currentMode === "chat" ? "Chat response draft" : "Email response draft";
    draftOutput.textContent = result.draft;

    const fetched = result.sources.filter((source) => source.status === "fetched").length;
    const total = result.sources.length;
    const included = result.diagnostics?.includedPages || fetched;
    setStatus(`Read ${fetched} of ${total} discovered same-site source ${total === 1 ? "page" : "pages"} and used ${included} in the draft.`, "success");
    if (result.warning) {
      setStatus(`Read ${fetched} of ${total} discovered same-site source ${total === 1 ? "page" : "pages"}. AI fallback was used: ${result.warning}`, "success");
    }
  } catch (error) {
    outputTitle.textContent = "Draft failed";
    draftOutput.classList.add("empty-warning");
    draftOutput.textContent = error.message;
    setStatus("Could not read the references. Check the links and try again.", "error");
  } finally {
    setLoading(false);
  }
}

function setLibraryStatus(message, type = "") {
  libraryStatus.textContent = message;
  libraryStatus.className = `source-status ${type}`.trim();
}

function setSaving(isSaving) {
  saveReferenceButton.disabled = isSaving;
  saveReferenceButton.textContent = isSaving ? "Saving..." : "Save or update";
}

function renderLibrary(references) {
  if (!references.length) {
    libraryList.innerHTML = `<div class="empty-state">No saved references yet. Add a URL above to build your support library.</div>`;
    return;
  }

  libraryList.innerHTML = references
    .map((reference) => {
      const updated = reference.updated_at ? new Date(reference.updated_at).toLocaleString() : "Not synced yet";
      const statusClass = reference.status === "fetched" ? "good" : "bad";
      return `<article class="library-item">
        <div>
          <div class="library-item-title">${escapeHtml(reference.title || reference.url)}</div>
          <a href="${escapeAttribute(reference.url)}" target="_blank" rel="noreferrer">${escapeHtml(reference.url)}</a>
          <div class="library-meta">
            <span class="${statusClass}">${escapeHtml(reference.status || "unknown")}</span>
            <span>${escapeHtml(reference.source_type || "article")}</span>
            <span>${escapeHtml(reference.tags || "No tags")}</span>
            <span>${updated}</span>
          </div>
        </div>
        <button class="secondary-button delete-reference" type="button" data-id="${escapeAttribute(reference.id)}">Delete</button>
      </article>`;
    })
    .join("");

  libraryList.querySelectorAll(".delete-reference").forEach((button) => {
    button.addEventListener("click", () => deleteSavedReference(button.dataset.id));
  });
}

async function loadLibrary() {
  setLibraryStatus("Loading saved references...");

  try {
    const response = await fetch("/api/references");
    const result = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(result.error || "Unable to load saved references.");
    }

    renderLibrary(result.references || []);
    setLibraryStatus(`Loaded ${(result.references || []).length} saved reference ${(result.references || []).length === 1 ? "item" : "items"}.`, "success");
  } catch (error) {
    renderLibrary([]);
    setLibraryStatus(error.message, "error");
  }
}

async function saveReference() {
  const url = libraryUrlInput.value.trim();
  if (!url) {
    setLibraryStatus("Add a reference URL first.", "error");
    return;
  }

  setSaving(true);
  setLibraryStatus("Saving reference and reading linked pages...");

  try {
    const response = await fetch("/api/references", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        sourceType: sourceTypeInput.value,
        tags: referenceTagsInput.value.trim(),
        crawlLinkedPages: crawlLinkedPagesInput.checked,
      }),
    });
    const result = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(result.error || "Unable to save reference.");
    }

    libraryUrlInput.value = "";
    setLibraryStatus(result.message || "Reference saved.", "success");
    await loadLibrary();
  } catch (error) {
    setLibraryStatus(error.message, "error");
  } finally {
    setSaving(false);
  }
}

async function deleteSavedReference(id) {
  setLibraryStatus("Deleting reference...");

  try {
    const response = await fetch(`/api/references?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    const result = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(result.error || "Unable to delete reference.");
    }

    setLibraryStatus(result.message || "Reference deleted.", "success");
    await loadLibrary();
  } catch (error) {
    setLibraryStatus(error.message, "error");
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

starterReferences.forEach(createReference);
updateCharCount();

addReferenceButton.addEventListener("click", () => createReference());
messageInput.addEventListener("input", updateCharCount);
draftButton.addEventListener("click", draftResponse);
copyButton.addEventListener("click", copyDraft);
saveReferenceButton.addEventListener("click", saveReference);
refreshLibraryButton.addEventListener("click", loadLibrary);

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

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((item) => item.classList.remove("active"));
    tab.classList.add("active");
    const showingKnowledge = tab.dataset.view === "knowledgeView";
    knowledgeView.classList.toggle("hidden", !showingKnowledge);
    draftView.classList.toggle("hidden", showingKnowledge);
    if (showingKnowledge) {
      loadLibrary();
    }
  });
});
