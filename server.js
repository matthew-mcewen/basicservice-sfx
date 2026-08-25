require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const WebSocket = require('ws');

const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const PORT = parseInt(process.env.PORT || '8420', 10);
const TOKEN_PATH = path.join(__dirname, 'token.json');
const REWARDS_PATH = path.join(__dirname, 'config', 'rewards.json');
const TIMERS_PATH = path.join(__dirname, 'config', 'timers.json');
const REDIRECT_URI = `http://localhost:${PORT}/auth/callback`;
const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';
const SCOPE = 'channel:read:redemptions';
const TIMER_TICK_MS = 1000;
const TIMER_SOUND_VOLUME = 0.8;

if (!CLIENT_ID) {
  console.error('\n[!] Missing TWITCH_CLIENT_ID. Copy .env.example to .env and fill it in.\n');
  process.exit(1);
}

// ---------- token storage ----------
function loadToken() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  } catch {
    return null;
  }
}
function saveToken(data) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(data, null, 2));
}

// ---------- reward config (re-read live, no restart needed) ----------
function loadRewards() {
  try {
    const raw = JSON.parse(fs.readFileSync(REWARDS_PATH, 'utf8'));
    delete raw._comment;
    return raw;
  } catch (err) {
    console.error('[!] Could not read config/rewards.json:', err.message);
    return {};
  }
}

function loadTimers() {
  try {
    const raw = JSON.parse(fs.readFileSync(TIMERS_PATH, 'utf8'));
    delete raw._comment;
    return raw;
  } catch (err) {
    console.error('[!] Could not read config/timers.json:', err.message);
    return {};
  }
}

function findMatchKey(configObj, title) {
  return Object.keys(configObj).find(
    (k) => k.trim().toLowerCase() === title.trim().toLowerCase()
  );
}

// ---------- express app ----------
const app = express();
app.use(express.json());
app.use('/sounds', express.static(path.join(__dirname, 'sounds')));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/auth', (req, res) => {
  const url = new URL('https://id.twitch.tv/oauth2/authorize');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('scope', SCOPE);
  res.redirect(url.toString());
});

// The access token comes back in the URL fragment (#access_token=...), which
// never reaches the server directly - so this page grabs it with JS and
// posts it back to /auth/save.
app.get('/auth/callback', (req, res) => {
  res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem">
  <p id="msg">Finishing sign-in...</p>
  <script>
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const token = hash.get('access_token');
    const err = hash.get('error_description');
    if (err) {
      document.getElementById('msg').textContent = 'Twitch said: ' + err;
    } else if (!token) {
      document.getElementById('msg').textContent = 'No token in the response. Try /auth again.';
    } else {
      fetch('/auth/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: token })
      }).then(r => r.json()).then(data => {
        document.getElementById('msg').textContent = data.ok
          ? 'Connected as ' + data.login + '. You can close this tab.'
          : 'Something went wrong: ' + (data.error || 'unknown error');
      });
    }
  </script>
  </body></html>`);
});

app.post('/auth/save', async (req, res) => {
  const accessToken = req.body.access_token;
  if (!accessToken) return res.status(400).json({ ok: false, error: 'no access_token in body' });
  try {
    const userResp = await fetch('https://api.twitch.tv/helix/users', {
      headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': CLIENT_ID }
    });
    const userData = await userResp.json();
    const user = userData.data && userData.data[0];
    if (!user) return res.status(400).json({ ok: false, error: 'Could not look up user from token.' });

    saveToken({
      access_token: accessToken,
      broadcaster_id: user.id,
      login: user.login,
      saved_at: new Date().toISOString()
    });

    console.log(`[auth] Connected as ${user.login} (${user.id})`);
    startEventSub();
    res.json({ ok: true, login: user.login });
  } catch (err) {
    console.error('[auth] save failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/status', (req, res) => {
  const token = loadToken();
  res.json({
    authenticated: !!token,
    login: token ? token.login : null,
    eventsub_connected: eventSubReady
  });
});

// Local dev/test helper -- fires a synthetic redemption through the exact
// same path a real EventSub notification would take. No auth, matching the
// rest of this app's localhost-only posture. Use scripts/fire-test-redemptions.js.
app.post('/dev/fire', (req, res) => {
  const { title, user_name, user_input } = req.body || {};
  if (!title) return res.status(400).json({ ok: false, error: 'title required' });
  console.log(`[dev/fire] Synthetic redemption: "${title}"`);
  handleRedemption({ reward: { title }, user_name: user_name || 'TestUser', user_input: user_input || '' });
  res.json({ ok: true });
});

// ---------- overlay websocket bridge (OBS browser source connects here) ----------
const server = app.listen(PORT, () => {
  console.log(`\nTwitch SFX Redemptions running at http://localhost:${PORT}`);
  const existing = loadToken();
  if (!existing) {
    console.log(`\n[!] Not authenticated yet. Open this in your browser (logged in as your broadcaster account):`);
    console.log(`    http://localhost:${PORT}/auth\n`);
  } else {
    console.log(`[auth] Using saved session for ${existing.login}`);
    startEventSub();
  }
  console.log(`Add this as an OBS Browser Source: http://localhost:${PORT}/overlay.html\n`);
});

const wss = new WebSocket.Server({ server, path: '/ws-overlay' });
const overlayClients = new Set();
wss.on('connection', (ws) => {
  overlayClients.add(ws);
  sendTimerSyncTo(ws);
  ws.on('close', () => overlayClients.delete(ws));
});
function broadcastToOverlay(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of overlayClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// ---------- timer (progress bar) redemptions ----------
// key: matched timers.json title -> { label, startTs, endTs } (epoch ms).
// Map preserves insertion order, and re-set()-ing an existing key doesn't
// move it -- so "oldest on top" ordering falls out for free even when a
// running timer is extended.
const activeTimers = new Map();

function timerSyncPayload() {
  return {
    type: 'timer-sync',
    timers: [...activeTimers.entries()].map(([key, t]) => ({
      key, label: t.label, startTs: t.startTs, endTs: t.endTs
    }))
  };
}
function broadcastTimerSync() {
  broadcastToOverlay(timerSyncPayload());
}
function sendTimerSyncTo(ws) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(timerSyncPayload()));
}
setInterval(() => {
  const now = Date.now();
  for (const [key, t] of activeTimers) {
    if (t.endTs <= now) activeTimers.delete(key);
  }
  broadcastTimerSync();
}, TIMER_TICK_MS);

// ---------- Twitch EventSub (WebSocket) ----------
let eventSubSocket = null;
let eventSubReady = false;
let keepaliveTimer = null;
let reconnecting = false;

function startEventSub(url = EVENTSUB_URL) {
  const token = loadToken();
  if (!token) {
    console.log('[eventsub] No token saved yet, waiting for /auth.');
    return;
  }

  const ws = new WebSocket(url);
  eventSubSocket = ws;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const type = msg.metadata && msg.metadata.message_type;

    if (type === 'session_welcome') {
      const sessionId = msg.payload.session.id;
      const keepaliveSecs = msg.payload.session.keepalive_timeout_seconds || 30;
      armKeepaliveWatchdog(keepaliveSecs);
      eventSubReady = true;
      console.log(`[eventsub] Session established (${sessionId}). Creating subscription...`);
      await subscribeToRedemptions(sessionId, token);
    }

    else if (type === 'session_keepalive') {
      armKeepaliveWatchdog(30);
    }

    else if (type === 'notification') {
      armKeepaliveWatchdog(30);
      const subType = msg.metadata.subscription_type;
      if (subType === 'channel.channel_points_custom_reward_redemption.add') {
        handleRedemption(msg.payload.event);
      }
    }

    else if (type === 'session_reconnect') {
      const newUrl = msg.payload.session.reconnect_url;
      console.log('[eventsub] Twitch asked us to reconnect...');
      reconnecting = true;
      const oldSocket = eventSubSocket;
      startEventSub(newUrl);
      setTimeout(() => { try { oldSocket.close(); } catch {} }, 5000);
    }

    else if (type === 'revocation') {
      console.warn('[eventsub] Subscription revoked:', msg.payload.subscription.status);
      console.warn('  -> If this says "authorization_revoked" or "user_removed", re-run /auth.');
    }
  });

  ws.on('close', () => {
    eventSubReady = false;
    if (reconnecting) { reconnecting = false; return; }
    clearTimeout(keepaliveTimer);
    console.log('[eventsub] Connection closed. Reconnecting in 5s...');
    setTimeout(() => startEventSub(), 5000);
  });

  ws.on('error', (err) => {
    console.error('[eventsub] Socket error:', err.message);
  });
}

function armKeepaliveWatchdog(seconds) {
  clearTimeout(keepaliveTimer);
  // If we hear nothing (no keepalive, no notification) for well beyond the
  // negotiated window, assume the connection is dead and force a reconnect.
  keepaliveTimer = setTimeout(() => {
    console.log('[eventsub] No signal from Twitch in a while, forcing reconnect...');
    try { eventSubSocket.close(); } catch {}
  }, (seconds + 15) * 1000);
}

async function subscribeToRedemptions(sessionId, token) {
  const resp = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Client-Id': CLIENT_ID,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      type: 'channel.channel_points_custom_reward_redemption.add',
      version: '1',
      condition: { broadcaster_user_id: token.broadcaster_id },
      transport: { method: 'websocket', session_id: sessionId }
    })
  });

  if (resp.status === 401) {
    console.error('[eventsub] Token rejected (401). Visit /auth again to get a fresh token.');
    return;
  }
  if (!resp.ok) {
    const body = await resp.text();
    console.error(`[eventsub] Subscription failed (${resp.status}):`, body);
    return;
  }
  console.log('[eventsub] Subscribed to channel point redemptions. Listening...');
}

function handleRedemption(event) {
  const title = (event.reward && event.reward.title) || '';
  console.log(`[redeem] ${event.user_name} redeemed "${title}"${event.user_input ? ` (input: ${event.user_input})` : ''}`);

  const rewards = loadRewards();
  const rewardKey = findMatchKey(rewards, title);
  if (rewardKey) {
    const { file, volume } = rewards[rewardKey];
    const soundPath = path.join(__dirname, 'sounds', file);
    if (!fs.existsSync(soundPath)) {
      console.warn(`[redeem] Configured file "${file}" not found in /sounds. Skipping playback.`);
      return;
    }
    broadcastToOverlay({
      type: 'play',
      src: `/sounds/${encodeURIComponent(file)}`,
      volume: typeof volume === 'number' ? volume : 0.8,
      label: title,
      user: event.user_name
    });
    return;
  }

  const timers = loadTimers();
  const timerKey = findMatchKey(timers, title);
  if (timerKey) {
    handleTimerRedemption(timerKey, timers[timerKey], event);
    return;
  }

  // no match in either config -- ignore (e.g. your impression rewards)
}

function handleTimerRedemption(key, cfg, event) {
  const seconds = typeof cfg.seconds === 'number' && cfg.seconds > 0 ? cfg.seconds : null;
  if (seconds === null) {
    console.warn(`[timer] "${key}" has invalid/missing "seconds" in timers.json. Skipping.`);
    return;
  }

  const now = Date.now();
  const existing = activeTimers.get(key);
  const remainingMs = existing ? Math.max(0, existing.endTs - now) : 0;
  activeTimers.set(key, { label: key, startTs: now, endTs: now + remainingMs + seconds * 1000 });
  broadcastTimerSync();

  const soundPath = path.join(__dirname, 'sounds', 'tada.mp3');
  if (!fs.existsSync(soundPath)) {
    console.warn('[timer] sounds/tada.mp3 missing, skipping sound (bar still updates).');
    return;
  }
  broadcastToOverlay({
    type: 'play',
    src: '/sounds/tada.mp3',
    volume: TIMER_SOUND_VOLUME,
    label: key,
    user: event.user_name
  });
}
