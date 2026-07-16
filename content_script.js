// Leet2Git content script
// Only archives a solution in response to an ACTUAL submit action — not by
// scanning the whole page for the word "Accepted" on every DOM mutation
// (that caused re-archiving already-solved problems / editor keystrokes).
//
// Flow: user clicks Submit (or Ctrl/Cmd+Enter) -> we start a short-lived
// watch window -> first terminal status seen ("Accepted" or otherwise)
// resolves that window -> watch window closes. Nothing fires outside an
// active watch window, so revisiting a solved problem or idle DOM churn
// never triggers an archive.

(function () {
  const SUBMIT_BTN_SELECTOR = "[data-e2e-locator='console-submit-button']";
  const TERMINAL_TEXTS = [
    "Accepted", "Wrong Answer", "Time Limit Exceeded", "Memory Limit Exceeded",
    "Runtime Error", "Compile Error", "Output Limit Exceeded", "Internal Error",
    "Restrictions Failed"
  ];

  let awaitingResult = false;
  let resultObserver = null;
  let awaitTimeoutId = null;

  // Dedup guard: ignore an Accepted result for the same problem+code that
  // was just archived within the last few seconds, so a quick double-submit
  // (e.g. an accidental double Ctrl+Enter) doesn't append the same
  // submission twice.
  const DEDUP_WINDOW_MS = 4000;
  let lastArchived = { key: null, at: 0 };

  function shouldDedupArchive(slug, code) {
    const key = `${slug}::${code}`;
    const now = Date.now();
    if (lastArchived.key === key && now - lastArchived.at < DEDUP_WINDOW_MS) {
      return true;
    }
    lastArchived = { key, at: now };
    return false;
  }

  function slugFromUrl() {
    const match = window.location.pathname.match(/\/problems\/([^/]+)/);
    return match ? match[1] : null;
  }

  function getLanguageFromUI() {
    // No stable data-*/id attribute identifies the language-selector button
    // (LeetCode renders it via Radix UI with an auto-generated aria-controls
    // id that changes per page load), so this scans all buttons for an
    // exact language-name match. Ambiguous only if another button's text is
    // *exactly* one of these words (e.g. just "Java"), which is unlikely for
    // ordinary page chrome.
    const langWords = [
      "python3", "python", "c++", "java", "c", "c#", "javascript",
      "typescript", "php", "swift", "kotlin", "dart", "go", "golang",
      "ruby", "scala", "rust", "racket", "erlang", "elixir"
    ];
    const candidates = document.querySelectorAll("button");
    for (const btn of candidates) {
      const text = (btn.textContent || "").trim().toLowerCase();
      if (langWords.includes(text)) return text;
    }
    return "unknown";
  }

  function langToExtension(lang) {
    const map = {
      "python3": "py", "python": "py", "java": "java", "c++": "cpp",
      "c": "c", "c#": "cs", "javascript": "js", "typescript": "ts",
      "php": "php", "swift": "swift", "kotlin": "kt", "dart": "dart",
      "go": "go", "golang": "go", "ruby": "rb", "scala": "scala",
      "rust": "rs", "racket": "rkt", "erlang": "erl", "elixir": "ex"
    };
    return map[lang] || "txt";
  }

  function htmlToMarkdown(container) {
    if (!container) return "";
    const clone = container.cloneNode(true);
    clone.querySelectorAll("sup").forEach((sup) => { sup.replaceWith(`^${sup.textContent}`); });
    clone.querySelectorAll("code").forEach((code) => { code.replaceWith(`\`${code.textContent}\``); });
    clone.querySelectorAll("strong, b").forEach((el) => { el.replaceWith(`**${el.textContent}**`); });
    clone.querySelectorAll("li").forEach((li) => { li.replaceWith(`- ${li.textContent.trim()}\n`); });
    clone.querySelectorAll("pre").forEach((pre) => {
      pre.replaceWith(`\n\`\`\`\n${pre.textContent.trim()}\n\`\`\`\n`);
    });
    clone.querySelectorAll("p").forEach((p) => { p.replaceWith(`${p.textContent.trim()}\n\n`); });
    let text = clone.textContent || "";
    text = text.replace(/\n{3,}/g, "\n\n").trim();
    return text;
  }

  function scrapeProblemStatement() {
    // Title extraction is independent of the description element — e.g. on
    // the /submissions/<id>/ detail view the description panel isn't
    // rendered, but document.title still has it. Don't let a missing
    // description block a title we could otherwise find.
    let title = null;
    const rawTitle = document.title || "";
    if (rawTitle.includes(" - LeetCode")) {
      title = rawTitle.replace(" - LeetCode", "").trim();
    }
    if (!title || title.length < 2) {
      const titleEl =
        document.querySelector("[data-cy='question-title']") ||
        document.querySelector("div[class*='text-title-large']");
      title = titleEl ? titleEl.textContent.trim() : null;
    }

    const descEl =
      document.querySelector("[data-track-load='description_content']") ||
      document.querySelector(".elfjS") ||
      document.querySelector("div[class*='question-content']");

    const markdown = descEl ? htmlToMarkdown(descEl) : "";
    return { title, full: markdown };
  }

  function splitSections(fullText) {
    const exampleIdx = fullText.search(/Example\s*1\s*:/i);
    const constraintsIdx = fullText.search(/Constraints\s*:/i);
    let description, examples, constraints;
    if (exampleIdx === -1) {
      description = fullText; examples = ""; constraints = "";
    } else {
      description = fullText.slice(0, exampleIdx).trim();
      if (constraintsIdx === -1) {
        examples = fullText.slice(exampleIdx).trim();
        constraints = "";
      } else {
        examples = fullText.slice(exampleIdx, constraintsIdx).trim();
        constraints = fullText.slice(constraintsIdx).trim();
      }
    }
    return { description, examples, constraints };
  }

  function getCodeFromEditor() {
    // LeetCode's editor is CodeMirror 6 (confirmed on the live page). A
    // Monaco-based fallback is also checked in case a different surface
    // (e.g. a mobile/legacy view) renders the editor differently.
    const cmContentEl = document.querySelector(".cm-content");
    if (cmContentEl) {
      const lineEls = cmContentEl.querySelectorAll(":scope > .cm-line");
      if (lineEls && lineEls.length > 0) {
        return Array.from(lineEls).map((line) => line.textContent).join("\n");
      }
    }

    const monacoLineEls = document.querySelectorAll(".monaco-editor .view-lines .view-line");
    if (monacoLineEls && monacoLineEls.length > 0) {
      return Array.from(monacoLineEls)
        .map((line) => line.textContent.replace(/ /g, " "))
        .join("\n");
    }

    return null;
  }

  function getOwnText(el) {
    return Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent.trim())
      .join("");
  }

  // Extracts the submission ID LeetCode links to from the result panel
  // (e.g. href="/problems/x/submissions/2069394133/"), so a leftover banner
  // from a PREVIOUS submission can be told apart from a genuinely fresh one
  // even when the panel never visibly blanks out between submits.
  function getResultSubmissionId(resultEl) {
    if (!resultEl) return null;
    // The submissions-history link ("View Details") sits a couple of
    // ancestor levels up from the status span, as a sibling of its
    // containing column rather than inside it — walk up looking for it
    // rather than assuming an exact depth, since that's more resilient to
    // minor layout shifts.
    let node = resultEl.parentElement;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      const link = node.querySelector("a[href*='/submissions/']");
      if (link) {
        const match = link.getAttribute("href").match(/\/submissions\/(\d+)/);
        if (match) return match[1];
      }
    }
    return null;
  }

  // Returns { status, submissionId } for the first terminal submission
  // status found ("Accepted", "Wrong Answer", etc.), or null if the result
  // panel hasn't resolved yet.
  function findTerminalStatus() {
    // LeetCode renders the resolved status text directly on this element
    // (e.g. <span data-e2e-locator="submission-result">Accepted</span>) —
    // check it first since it's the precise, stable target. Note this is a
    // leaf element in practice, so it must be checked directly rather than
    // via querySelectorAll (which only returns descendants, never the root
    // element itself, and would silently never match).
    const resultEl = document.querySelector("[data-e2e-locator='submission-result']");
    if (resultEl) {
      const t = getOwnText(resultEl);
      if (TERMINAL_TEXTS.includes(t)) {
        return { status: t, submissionId: getResultSubmissionId(resultEl) };
      }
    }

    // Fallback: scoped scan of the console panel if the dedicated locator
    // drifts. Deliberately not a whole-document scan — that let unrelated
    // elements (e.g. a submissions-history row, or the problem's overall
    // "Accepted" stat counter) falsely resolve the watch window.
    const root = document.querySelector("[data-e2e-locator='console-result']");
    if (!root) return null;

    const candidates = root.querySelectorAll("span, div");
    for (const el of candidates) {
      const t = getOwnText(el);
      if (TERMINAL_TEXTS.includes(t)) return { status: t, submissionId: null };
    }
    return null;
  }

  function stopWaiting() {
    awaitingResult = false;
    if (resultObserver) { resultObserver.disconnect(); resultObserver = null; }
    if (awaitTimeoutId) { clearTimeout(awaitTimeoutId); awaitTimeoutId = null; }
  }

  // Opens a short-lived watch window that resolves exactly once — on the
  // first terminal status that appears after this call. Only archives on
  // "Accepted"; any other terminal status just closes the window silently
  // so the next real submit can be watched.
  function startWaitingForResult() {
    if (awaitingResult) return; // already watching an in-flight submission
    awaitingResult = true;
    console.log("[Leet2Git] Submit detected — watching for result...");

    // A leftover "Accepted" (or other terminal) banner from a PREVIOUS
    // submission can still be on screen the instant you click Submit again
    // — LeetCode doesn't always blank it out while judging, it may just
    // replace it in place once the new result is ready. So instead of
    // waiting for a gap (which may never happen), we track the submission
    // ID the banner links to at click time and only treat a result as fresh
    // once that ID changes (or, if no ID is available, once the panel
    // disappears at least once — the old best-effort fallback).
    const initialResult = findTerminalStatus();
    const initialSubmissionId = initialResult ? initialResult.submissionId : null;
    let sawClearSinceClick = initialResult === null;
    let settleTimer = null;

    function isFresh(result) {
      if (initialSubmissionId !== null) {
        return result.submissionId !== null && result.submissionId !== initialSubmissionId;
      }
      return sawClearSinceClick;
    }

    function evaluate() {
      if (!awaitingResult) return;
      const result = findTerminalStatus();

      if (result === null) {
        sawClearSinceClick = true; // judging in progress / banner cleared
        return;
      }
      if (!isFresh(result)) return; // stale leftover banner — ignore it

      // Debounce only the final read, to avoid grabbing a half-rendered node.
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (!awaitingResult) return;
        const finalResult = findTerminalStatus();
        if (!finalResult || finalResult.status !== result.status) return; // still changing
        if (finalResult.status === "Accepted") {
          stopWaiting();
          handleAcceptedSubmission();
        } else {
          console.log(`[Leet2Git] Result: ${finalResult.status} — not archived.`);
          stopWaiting();
        }
      }, 400);
    }

    resultObserver = new MutationObserver(evaluate);
    resultObserver.observe(document.body, {
      childList: true, subtree: true, characterData: true
    });

    awaitTimeoutId = setTimeout(() => {
      if (awaitingResult) {
        console.warn("[Leet2Git] Timed out waiting for a submission result.");
        stopWaiting();
      }
    }, 60000);
  }

  function reportScrapeFailure(reason) {
    console.warn(`[Leet2Git] ${reason} — aborting archive.`);
    // chrome.runtime is undefined once the extension has been reloaded/
    // updated while this content script is still injected in an old tab
    // ("Extension context invalidated") — nothing to send it to in that
    // case, so just skip rather than throwing.
    if (!chrome.runtime || !chrome.runtime.sendMessage) return;
    try {
      chrome.runtime.sendMessage({ type: "LEET2GIT_SCRAPE_FAILED", reason });
    } catch (e) {
      console.warn("[Leet2Git] Could not report scrape failure (extension context invalidated).");
    }
  }

  async function handleAcceptedSubmission() {
    const slug = slugFromUrl();
    if (!slug) {
      reportScrapeFailure("Could not determine problem slug from URL");
      return;
    }

    const { title, full } = scrapeProblemStatement();
    if (!title) {
      reportScrapeFailure("Could not scrape problem title");
      return;
    }

    const { description, examples, constraints } = splitSections(full);
    const lang = getLanguageFromUI();
    const extension = langToExtension(lang);

    const code = getCodeFromEditor();
    if (!code) {
      reportScrapeFailure("Could not read code from editor");
      return;
    }

    if (shouldDedupArchive(slug, code)) {
      console.log("[Leet2Git] Duplicate accepted result for identical code — skipping re-archive.");
      return;
    }

    console.log(`[Leet2Git] Archiving "${title}" (${lang}, ${code.length} chars)...`);

    if (!chrome.runtime || !chrome.runtime.sendMessage) {
      console.warn("[Leet2Git] Extension context invalidated — reload the LeetCode tab.");
      return;
    }

    try {
      chrome.runtime.sendMessage({
        type: "LEET2GIT_SUBMISSION",
        payload: {
          slug, title, description, examples, constraints,
          language: lang, extension, code,
          submittedAt: new Date().toISOString()
        }
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error("[Leet2Git] sendMessage error:", chrome.runtime.lastError.message);
        } else {
          console.log("[Leet2Git] Background worker response:", response);
        }
      });
    } catch (e) {
      console.warn("[Leet2Git] Could not send submission (extension context invalidated).");
    }
  }

  // Delegated listeners (survive React re-renders since they're on document,
  // not on the button itself). Only these two paths ever call
  // startWaitingForResult() — nothing else scans the page proactively.
  document.addEventListener("click", (e) => {
    if (e.target.closest(SUBMIT_BTN_SELECTOR)) {
      startWaitingForResult();
    }
  }, true);

  document.addEventListener("keydown", (e) => {
    const isSubmitShortcut = (e.metaKey || e.ctrlKey) && e.key === "Enter";
    if (isSubmitShortcut) {
      startWaitingForResult();
    }
  }, true);

  console.log("[Leet2Git] Content script loaded on:", window.location.href);
})();
