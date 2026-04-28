(function () {
  "use strict";

  const config = window.WORDLE_SUPABASE_CONFIG || {};

  function hasRealValue(value) {
    return typeof value === "string" && value.trim() && !value.includes("YOUR_");
  }

  function isEnabled() {
    return hasRealValue(config.url) && hasRealValue(config.anonKey);
  }

  function getBaseUrl() {
    return config.url.replace(/\/+$/g, "");
  }

  function getHeaders(extraHeaders) {
    return {
      apikey: config.anonKey,
      Authorization: `Bearer ${config.anonKey}`,
      ...extraHeaders
    };
  }

  async function request(path, options = {}) {
    if (!isEnabled()) {
      throw new Error("Supabase is not configured.");
    }

    const response = await fetch(`${getBaseUrl()}/rest/v1/${path}`, {
      ...options,
      headers: getHeaders(options.headers || {})
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `Supabase request failed with ${response.status}.`);
    }

    if (response.status === 204) {
      return null;
    }

    return response.json();
  }

  async function createCustomPuzzle({ answer, answerCode }) {
    const rows = await request("wordle_puzzles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        kind: "custom",
        answer,
        answer_code: answerCode
      })
    });

    return rows && rows[0] ? rows[0] : null;
  }

  async function getCustomPuzzle(id) {
    const rows = await request(
      `wordle_puzzles?id=eq.${encodeURIComponent(id)}&select=id,kind,answer,answer_code,created_at&limit=1`
    );

    return rows && rows[0] ? rows[0] : null;
  }

  async function logAttempt(payload) {
    await request("wordle_attempts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify(payload)
    });
  }

  async function fetchAttempts(limit = 1000) {
    return request(
      `wordle_attempts?select=*&order=created_at.desc&limit=${encodeURIComponent(String(limit))}`
    );
  }

  window.WordleBackend = {
    isEnabled,
    createCustomPuzzle,
    getCustomPuzzle,
    logAttempt,
    fetchAttempts
  };
})();
