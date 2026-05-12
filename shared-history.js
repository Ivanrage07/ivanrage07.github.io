(function () {
  "use strict";

  const config = window.WORDLE_SUPABASE_CONFIG || {};
  let adminSession = null;
  let playerSession = null;
  const playerSessionKey = "wordle-clone:player-session";
  const playerPkceKey = "wordle-clone:player-pkce-verifier";

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
    const session = await getValidPlayerSession();
    const accountPayload = session ? addPlayerAccountToPayload(payload, session) : payload;

    await request("wordle_attempts", {
      method: "POST",
      authToken: session ? session.access_token : undefined,
      headers: {
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify(accountPayload)
    });
  }

  async function initPlayerAuth() {
    const callbackSession = await consumePlayerAuthCallback();
    if (callbackSession) {
      setPlayerSession(callbackSession);
    }

    const session = await getValidPlayerSession();
    if (session) {
      upsertPlayerProfile(session).catch((error) => {
        console.warn("Unable to save player profile.", error);
      });
    }

    return session;
  }

  async function startGoogleSignIn() {
    if (!isEnabled()) {
      throw new Error("Supabase is not configured.");
    }

    const redirectTo = new URL(window.location.href);
    redirectTo.hash = "";

    const authUrl = new URL(`${getBaseUrl()}/auth/v1/authorize`);
    authUrl.searchParams.set("provider", "google");
    authUrl.searchParams.set("redirect_to", redirectTo.toString());

    if (window.crypto && window.crypto.subtle) {
      const verifier = createCodeVerifier();
      localStorage.setItem(playerPkceKey, verifier);
      authUrl.searchParams.set("code_challenge", await createCodeChallenge(verifier));
      authUrl.searchParams.set("code_challenge_method", "s256");
    }

    window.location.href = authUrl.toString();
  }

  async function consumePlayerAuthCallback() {
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));

    if (hashParams.get("access_token")) {
      clearAuthHash();
      return attachUserToSession(normalizeSession({
        access_token: hashParams.get("access_token"),
        refresh_token: hashParams.get("refresh_token"),
        expires_in: Number(hashParams.get("expires_in")) || 3600,
        expires_at: Number(hashParams.get("expires_at")) || null
      }));
    }

    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const verifier = localStorage.getItem(playerPkceKey);

    if (!code || !verifier) {
      return null;
    }

    localStorage.removeItem(playerPkceKey);
    const session = await exchangePlayerCode(code, verifier);
    clearAuthCodeParam(params);
    return session;
  }

  async function exchangePlayerCode(code, verifier) {
    const response = await fetch(`${getBaseUrl()}/auth/v1/token?grant_type=pkce`, {
      method: "POST",
      headers: getHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        auth_code: code,
        code_verifier: verifier
      })
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || "Could not finish Google sign in.");
    }

    return attachUserToSession(normalizeSession(await response.json()));
  }

  async function attachUserToSession(session) {
    if (!session || session.user || !session.access_token) return session;

    const response = await fetch(`${getBaseUrl()}/auth/v1/user`, {
      headers: getHeaders({}, session.access_token)
    });

    if (!response.ok) return session;
    return {
      ...session,
      user: await response.json()
    };
  }

  function clearAuthHash() {
    if (!window.history || !window.history.replaceState) return;
    const url = new URL(window.location.href);
    url.hash = "";
    window.history.replaceState({}, document.title, url.toString());
  }

  function clearAuthCodeParam(params) {
    if (!window.history || !window.history.replaceState) return;
    const url = new URL(window.location.href);
    ["code", "error", "error_code", "error_description"].forEach((key) => {
      url.searchParams.delete(key);
    });
    window.history.replaceState({}, document.title, url.toString());
  }

  function createCodeVerifier() {
    const bytes = new Uint8Array(48);
    window.crypto.getRandomValues(bytes);
    return base64Url(bytes);
  }

  async function createCodeChallenge(verifier) {
    const encoded = new TextEncoder().encode(verifier);
    const digest = await window.crypto.subtle.digest("SHA-256", encoded);
    return base64Url(new Uint8Array(digest));
  }

  function base64Url(bytes) {
    let value = "";
    bytes.forEach((byte) => {
      value += String.fromCharCode(byte);
    });

    return btoa(value)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  function getStoredPlayerSession() {
    if (playerSession && playerSession.access_token) return playerSession;

    try {
      const saved = JSON.parse(localStorage.getItem(playerSessionKey));
      if (saved && saved.access_token) {
        playerSession = saved;
        return saved;
      }
    } catch (error) {
      localStorage.removeItem(playerSessionKey);
    }

    return null;
  }

  async function getValidPlayerSession() {
    let session = getStoredPlayerSession();
    if (!session) return null;

    if (session.expires_at && session.expires_at - Date.now() < 60000) {
      session = await refreshPlayerSession(session);
    }

    return session;
  }

  async function refreshPlayerSession(session) {
    if (!session || !session.refresh_token) {
      signOutPlayer();
      return null;
    }

    const response = await fetch(`${getBaseUrl()}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: getHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ refresh_token: session.refresh_token })
    });

    if (!response.ok) {
      signOutPlayer();
      return null;
    }

    const nextSession = await attachUserToSession(normalizeSession(await response.json()));
    setPlayerSession(nextSession);
    return nextSession;
  }

  function setPlayerSession(session) {
    playerSession = session;
    localStorage.setItem(playerSessionKey, JSON.stringify(session));
  }

  async function signOutPlayer() {
    const session = getStoredPlayerSession();

    if (session && session.access_token) {
      fetch(`${getBaseUrl()}/auth/v1/logout`, {
        method: "POST",
        headers: getHeaders({}, session.access_token)
      }).catch(() => {});
    }

    playerSession = null;
    localStorage.removeItem(playerSessionKey);
  }

  function getPlayerDisplayName(session) {
    const user = session && session.user;
    const metadata = (user && user.user_metadata) || {};
    return metadata.full_name || metadata.name || metadata.preferred_username || (user && user.email) || "Player";
  }

  function addPlayerAccountToPayload(payload, session) {
    const user = session && session.user;
    if (!user || !user.id) return payload;

    return {
      ...payload,
      user_id: user.id,
      player_email: user.email || null,
      player_name: getPlayerDisplayName(session)
    };
  }

  async function upsertPlayerProfile(session) {
    const user = session && session.user;
    if (!user || !user.id) return;

    const metadata = user.user_metadata || {};
    await request("wordle_profiles", {
      method: "POST",
      authToken: session.access_token,
      headers: {
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify({
        user_id: user.id,
        email: user.email || null,
        display_name: getPlayerDisplayName(session),
        avatar_url: metadata.avatar_url || metadata.picture || null,
        last_seen: new Date().toISOString()
      })
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
    adminSession = session;
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
    adminSession = nextSession;
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
    return adminSession && adminSession.access_token ? adminSession : null;
  }

  function signOutAdmin() {
    adminSession = null;
  }

  window.WordleBackend = {
    isEnabled,
    createCustomPuzzle,
    getCustomPuzzle,
    logAttempt,
    fetchAttempts,
    initPlayerAuth,
    startGoogleSignIn,
    signOutPlayer,
    getValidPlayerSession,
    getPlayerDisplayName,
    signInAdmin,
    signOutAdmin,
    getValidAdminSession
  };
})();
