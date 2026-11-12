const fs = require('fs');
const { execSync } = require('child_process');
const config = require('./config');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getOverrideMinutes() {
  const val = config.OVERRIDE_MINUTES;
  if (val === '' || val === null || val === undefined) return null;
  const num = Number(val);
  return !isNaN(num) && num > 0 ? num : null;
}

function loadState() {
  try {
    if (fs.existsSync(config.STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(config.STATE_FILE, 'utf8'));
      return {
        totalPacksOpened: parsed.totalPacksOpened || 0,
        nextOpenTimestamp: parsed.nextOpenTimestamp || null,
        lastOpenedAt: parsed.lastOpenedAt || null,
        discoveredRanks: Array.isArray(parsed.discoveredRanks) ? parsed.discoveredRanks : [],
        collectionTotal: parsed.collectionTotal || null
      };
    }
  } catch (e) {}
  return {
    totalPacksOpened: 0,
    nextOpenTimestamp: null,
    lastOpenedAt: null,
    discoveredRanks: [],
    collectionTotal: null
  };
}

function saveState(state, pushToGit = true) {
  const cleanState = {
    totalPacksOpened: state.totalPacksOpened || 0,
    nextOpenTimestamp: state.nextOpenTimestamp || null,
    lastOpenedAt: state.lastOpenedAt || null,
    discoveredRanks: Array.isArray(state.discoveredRanks) ? state.discoveredRanks : [],
    collectionTotal: state.collectionTotal || null
  };
  fs.writeFileSync(config.STATE_FILE, JSON.stringify(cleanState, null, 2));

  if (!pushToGit || !process.env.GITHUB_ACTIONS) return;

  try {
    execSync('cp state.json /tmp/state.json', { stdio: 'ignore' });
    execSync('git config user.name "github-actions[bot]"', { stdio: 'ignore' });
    execSync('git config user.email "github-actions[bot]@users.noreply.github.com"', { stdio: 'ignore' });
    execSync('git fetch origin main && git reset --hard origin/main', { stdio: 'ignore' });
    execSync('cp /tmp/state.json state.json', { stdio: 'ignore' });
    execSync('git add state.json', { stdio: 'ignore' });
    const diff = execSync('git status --porcelain state.json').toString().trim();
    if (diff) {
      execSync('git commit -m "Update bot state [skip ci]"', { stdio: 'ignore' });
      execSync('git push origin HEAD:main', { stdio: 'ignore' });
    }
  } catch (e) {}
}

function computeNextSchedule() {
  const overrideMins = getOverrideMinutes();
  if (overrideMins !== null) {
    return Date.now() + Math.round(overrideMins * 60 * 1000);
  }
  const minMs = config.MIN_INTERVAL_MINUTES * 60 * 1000;
  const maxMs = config.MAX_INTERVAL_MINUTES * 60 * 1000;
  const randomDelayMs = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
  return Date.now() + randomDelayMs;
}

function formatRemaining(targetMs) {
  if (!targetMs) return 'Not scheduled yet';
  const diffMs = targetMs - Date.now();
  const unixSec = Math.floor(targetMs / 1000);
  if (diffMs <= 0) {
    return `**Opening right now!** (Target: <t:${unixSec}:t>)`;
  }
  const totalSec = Math.floor(diffMs / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `**${mins}m ${secs}s** (<t:${unixSec}:t> — <t:${unixSec}:R>)`;
}

async function sendDiscordAlert(message, screenshotPath = null) {
  const webhookUrl = process.env.DISCORD_WEBHOOK;
  if (!webhookUrl) return;

  if (screenshotPath && fs.existsSync(screenshotPath)) {
    const formData = new FormData();
    formData.append('payload_json', JSON.stringify({ content: message }));
    const fileBuffer = fs.readFileSync(screenshotPath);
    const blob = new Blob([fileBuffer], { type: 'image/png' });
    formData.append('files[0]', blob, 'top10_pull.png');

    await fetch(webhookUrl, {
      method: 'POST',
      body: formData
    });
  } else {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message })
    });
  }
}

function parseCookieList(rawCookieStr) {
  const cleaned = (rawCookieStr || '')
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/^cookie:\s*/i, '')
    .trim();

  if (!cleaned) return [];

  const sidMatch = cleaned.match(/(?:^|;\s*)sid=([^;\s'"]+)/i);
  if (sidMatch && sidMatch[1]) {
    return [{
      name: 'sid',
      value: sidMatch[1].trim(),
      url: 'https://demongacha.com'
    }];
  }

  if (!cleaned.includes('=')) {
    return [{
      name: 'sid',
      value: cleaned,
      url: 'https://demongacha.com'
    }];
  }

  return cleaned.split(';').map(pair => {
    const index = pair.indexOf('=');
    if (index === -1) return null;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (/^(path|domain|expires|max-age|samesite|secure|httponly)$/i.test(name)) return null;
    return {
      name,
      value,
      url: 'https://demongacha.com'
    };
  }).filter(c => c && c.name && c.value);
}

module.exports = {
  sleep,
  getOverrideMinutes,
  loadState,
  saveState,
  computeNextSchedule,
  formatRemaining,
  sendDiscordAlert,
  parseCookieList
};