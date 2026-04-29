(function () {
  "use strict";

  const config = window.WORDLE_SUPABASE_CONFIG || {};
  const adminSessionKey = "wordle-clone:admin-session";

  function hasRealValue(value) {
    return typeof value === "string" && value.trim() && !value.includes("YOUR_");
  }

  function isEnabled() {
    return hasRealValue(config.url) && hasRealValue(config.anonKey);
  }

  function getBaseUrl() {
    return config.url.replace(/\/+$/g, "");
  }

  function getHeaders(extraHeaders, authToken) {
    return {
      apikey: config.anonKey,
      Authorization: `Bearer ${authToken || config.anonKey}`,
      ...extraHeaders
    };
  }

  async function request(path, options = {}) {
    if (!isEnabled()) {
      throw new Error("Supabase is not configured.");
    }

    const { authToken, ...fetchOptions } = options;

    const response = await fetch(`${getBaseUrl()}/rest/v1/${path}`, {
      ...fetchOptions,
      headers: getHeaders(fetchOptions.headers || {}, authToken)
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
    const session = await getValidAdminSession();
    if (!session) {
      throw new Error("Please sign in.");
    }

    return request(
      `wordle_attempts?select=*&order=created_at.desc&limit=${encodeURIComponent(String(limit))}`,
      { authToken: session.access_token }
    );
  }

  async function signInAdmin(email, password) {
    if (!isEnabled()) {
      throw new Error("Supabase is not configured.");
    }

    const response = await fetch(`${getBaseUrl()}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: getHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ email, password })
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || "Could not sign in.");
    }

    const session = normalizeSession(await response.json());
    localStorage.setItem(adminSessionKey, JSON.stringify(session));
    return session;
  }

  async function refreshAdminSession(session) {
    if (!session || !session.refresh_token) return null;

    const response = await fetch(`${getBaseUrl()}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: getHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ refresh_token: session.refresh_token })
    });

    if (!response.ok) {
      signOutAdmin();
      return null;
    }

    const nextSession = normalizeSession(await response.json());
    localStorage.setItem(adminSessionKey, JSON.stringify(nextSession));
    return nextSession;
  }

  function normalizeSession(session) {
    return {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at
        ? session.expires_at * 1000
        : Date.now() + ((session.expires_in || 3600) * 1000),
      user: session.user || null
    };
  }

  async function getValidAdminSession() {
    let session = getStoredAdminSession();
    if (!session) return null;

    if (session.expires_at && session.expires_at - Date.now() < 60000) {
      session = await refreshAdminSession(session);
    }

    return session;
  }

  function getStoredAdminSession() {
    try {
      const session = JSON.parse(localStorage.getItem(adminSessionKey));
      return session && session.access_token ? session : null;
    } catch (error) {
      return null;
    }
  }

  function signOutAdmin() {
    localStorage.removeItem(adminSessionKey);
  }

  window.WordleBackend = {
    isEnabled,
    createCustomPuzzle,
    getCustomPuzzle,
    logAttempt,
    fetchAttempts,
    signInAdmin,
    signOutAdmin,
    getValidAdminSession
  };
})();
