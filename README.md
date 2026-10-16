# Stream SFX

This is a bot I use for my streams. It runs 100% locally and runs happily 
in the background. You will need to BYO Twitch Client ID & API token. 
It listens for channel point redemptions via Twitch's official 
EventSub WebSocket and plays a sound through an OBS Browser Source.

## 1. Register a Twitch application (one-time, ~2 min)

1. Go to https://dev.twitch.tv/console/apps and click **Register Your Application**.
2. Name: anything unique, e.g. `yourname-sfx-redemptions`.
3. OAuth Redirect URLs: `http://localhost:8420/auth/callback`
   (must match exactly — if you change the PORT in `.env`, update this too)
4. Category: `Application Integration`.
5. Client Type: **Public** (this app never needs a Client Secret).
6. Save, then copy the **Client ID**.

## 2. Install

Requires [Node.js](https://nodejs.org) 18 or newer.

```bash
cd twitch-sfx-redemptions
npm install
cp .env.example .env
```

Open `.env` and paste in your Client ID.

## 3. Run it

```bash
npm start
```

You'll see:

```
Twitch SFX Redemptions running at http://localhost:8420
[!] Not authenticated yet. Open this in your browser...
    http://localhost:8420/auth
```

Open that `/auth` link while logged into Twitch as your broadcaster account,
click Authorize. It'll bounce back and say "Connected as yourname", then
leave the terminal window running while you stream.

The token is a temporary Twitch session token (no password or secret is
ever stored). If it expires after a long time and redemptions stop firing,
just revisit `http://localhost:8420/auth` to refresh it.

## 4. Add your sounds

Drop `.mp3`/`.wav` files into `/sounds`, then edit `config/rewards.json`:

```json
{
  "Play SFX: Airhorn": { "file": "airhorn.mp3", "volume": 0.8 }
}
```

The key must match your Twitch reward **title** exactly (case doesn't matter).
This file is re-read every time someone redeems, so you can edit and save it
live without restarting the server.

## 5. Create the matching rewards on Twitch

Creator Dashboard → **Viewer Rewards → Channel Points → Manage Rewards** → **Add New Reward**:

- Title: exactly matches a key in `rewards.json`, e.g. `Play SFX: Airhorn`
- Cost: whatever feels right for its length/chaos (see the plan in chat for suggestions)
- Turn **Skip Reward Queue** ON — the sound firing *is* the fulfillment, no
  need for you to manually approve each one.

## 6. Add timer (progress bar) redemptions (optional)

For redemptions that represent a duration rather than a one-shot sound
effect (e.g. "60 seconds of X"), edit `config/timers.json`:

```json
{
  "60s of BasicSaffer": { "seconds": 60 }
}
```

The key must match the Twitch reward title exactly, same rules as
`rewards.json`. When redeemed, `tada.mp3` plays once and a countdown
progress bar appears on the overlay. Redeeming the same reward again while
its bar is still counting down **extends** it by that reward's duration
rather than restarting it. Timer state lives in memory in the running
server process — restarting the server clears any bars currently counting
down (they don't persist to disk).

## 7. Add the overlay to OBS

- **Sources → + → Browser Source**
- URL: `http://localhost:8420/overlay.html`
- Width/Height: **`1080x260`** — the timer progress bars are 1080px wide;
  the bar stack is capped at 120px of total height (bars shrink/collapse to
  fit if more than two are active at once), plus room for the toast below.
  Use this size even if you're not using timer redemptions yet. (The SFX
  toast still centers itself correctly at this size — it just centers
  within a wider viewport now, which is cosmetic.)
- Leave "Shutdown source when not visible" **unchecked** so it keeps
  listening even if the source is hidden in the current scene, and so any
  running timer bars resync correctly if the source does reload.
- Make sure this source isn't muted in the OBS Audio Mixer.

## 8. Test

Redeem the reward yourself (or ask a mod) and confirm you hear it through
OBS. Check the terminal, every redemption is logged there (matched or not)
which is the easiest way to debug a title/typo mismatch.

To test locally without waiting on real Twitch redemptions, run the server
(`npm start`) and in another terminal:

```bash
npm run fire-test
```

This fires every reward configured in `rewards.json` and `timers.json`
once, about a second apart, then exits. Pass a specific title to fire just
one: `npm run fire-test -- "60s of BasicSaffer"`. Since timer state lives in
the running server, firing the same timer title twice while it's still
running will extend it (same as a real re-redemption) rather than restart
it fresh.

## How it works (for the curious)

- `server.js` opens a WebSocket to Twitch's EventSub endpoint and subscribes
  to `channel.channel_points_custom_reward_redemption.add` for your channel.
- When a redemption comes in, it's matched against `config/rewards.json`.
- On a match, the server pushes a message over a *second*, purely local
  WebSocket to any connected browser source (`public/overlay.html`), which
  plays the audio file. This is the same trick paid overlay services use —
  yours just never leaves your machine except to talk to Twitch directly.

## Troubleshooting

- **Nothing happens on redemption**: check the terminal log. It logs every
  redemption whether or not it matched a sound. If it's not logging at all,
  re-check `/auth` and that the server says "Subscribed to channel point
  redemptions. Listening...".
- **401 / token rejected**: revisit `http://localhost:8420/auth`.
- **Sound doesn't play in OBS but the terminal shows it fired**: check the
  OBS Browser Source isn't muted, and that the filename in `rewards.json`
  exactly matches the file in `/sounds`.
