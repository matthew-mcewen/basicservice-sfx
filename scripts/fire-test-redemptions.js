require('dotenv').config();
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8420', 10);
const BASE = `http://localhost:${PORT}`;
const DELAY_MS = 800;

function loadConfig(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', file), 'utf8'));
    delete raw._comment;
    return raw;
  } catch {
    return {};
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  try {
    await fetch(`${BASE}/status`);
  } catch {
    console.error(`Server doesn't seem to be running on port ${PORT}. Start it with 'npm start' first.`);
    process.exit(1);
  }

  const rewards = loadConfig('rewards.json');
  const timers = loadConfig('timers.json');
  let titles = [...Object.keys(rewards), ...Object.keys(timers)];

  const only = process.argv[2];
  if (only) {
    titles = titles.filter((t) => t.trim().toLowerCase() === only.trim().toLowerCase());
    if (titles.length === 0) {
      console.error(`No configured reward/timer title matches "${only}".`);
      process.exit(1);
    }
  }

  for (const title of titles) {
    console.log(`Firing: "${title}"`);
    try {
      const res = await fetch(`${BASE}/dev/fire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, user_name: 'TestUser', user_input: '' })
      });
      if (!res.ok) console.error(`  -> HTTP ${res.status}`);
    } catch (err) {
      console.error(`  -> request failed: ${err.message}`);
    }
    await sleep(DELAY_MS);
  }

  process.exit(0);
}

main();
