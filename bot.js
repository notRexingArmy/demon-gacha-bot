const { execSync } = require('child_process');
const { chromium } = require('playwright');
const config = require('./config');
const {
  sleep,
  getOverrideMinutes,
  loadState,
  saveState,
  computeNextSchedule,
  formatRemaining,
  sendDiscordAlert,
  parseCookieList
} = require('./helpers');
const {
  verifyAndRefreshAuth,
  scanCardsOnPage,
  updateCollectionProgress
} = require('./scanner');

let activeCookie = (process.env.RAW_COOKIES || '').trim();

async function openPacksCycle(state) {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
  });

  if (activeCookie) {
    const cookies = parseCookieList(activeCookie);
    if (cookies.length) await context.addCookies(cookies);
  }

  const page = await context.newPage();
  await page.goto(config.TARGET_URL, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(5000);

  const auth = await verifyAndRefreshAuth(page, context, state, activeCookie);
  if (!auth.ok) {
    await sendDiscordAlert(`⚠️ **Demon Gacha Alert:** Cookie rejected by \`/api/me\` (HTTP ${auth.status}). Please update your \`RAW_COOKIES\` GitHub Secret.`);
    await browser.close();
    process.exit(1);
  }

  activeCookie = auth.updatedCookie;

  const knownRanks = new Set(state.discoveredRanks || []);
  const initialCards = await scanCardsOnPage(page);
  for (const c of initialCards) knownRanks.add(c.rankNum);
  const existingCardIds = new Set(initialCards.map(c => c.id));

  const openAllButton = page.locator(config.OPEN_ALL_SELECTOR).first();
  const openSingleButton = page.locator(config.OPEN_SINGLE_SELECTOR).first();
  const continueButton = page.locator(config.CONTINUE_BUTTON_SELECTOR).first();

  await Promise.race([
    openAllButton.waitFor({ state: 'visible', timeout: 15000 }),
    openSingleButton.waitFor({ state: 'visible', timeout: 15000 })
  ]).catch(() => {});

  const hasOpenAll = (await openAllButton.isVisible().catch(() => false)) && (await openAllButton.isEnabled().catch(() => false));
  const targetOpenButton = hasOpenAll ? openAllButton : openSingleButton;
  const isButtonVisible = await targetOpenButton.isVisible().catch(() => false);
  const buttonText = isButtonVisible ? (await targetOpenButton.innerText().catch(() => 'Open')).trim() : 'Open';
  const canClick = isButtonVisible && (await targetOpenButton.isEnabled().catch(() => false));

  if (!isButtonVisible || !canClick) {
    state.nextOpenTimestamp = computeNextSchedule();
    state.discoveredRanks = Array.from(knownRanks);
    saveState(state, true);

    await sendDiscordAlert(
      `ℹ️ **Run Complete:** Logged in, but 0 packs were ready to open.\n` +
      `• **Total Packs Opened:** \`${state.totalPacksOpened}\`\n` +
      `• **Next Opening In:** ${formatRemaining(state.nextOpenTimestamp)}`
    );
    await browser.close();
    return;
  }

  const countMatch = buttonText.match(/\((\d+)\)/);
  const packsOpenedNow = countMatch ? parseInt(countMatch[1], 10) : 1;

  await targetOpenButton.click();

  const rarePulls = new Map();
  let newCardsThisRun = 0;
  let top10ScreenshotPath = null;

  try {
    await continueButton.waitFor({ state: 'visible', timeout: 30000 });

    for (let step = 0; step < 25; step++) {
      await page.waitForTimeout(1800);

      const currentCards = await scanCardsOnPage(page);
      let sawTop10OnThisScreen = false;

      for (const card of currentCards) {
        if (existingCardIds.has(card.id)) continue;
        existingCardIds.add(card.id);

        const isFirstTimeSeen = card.hasNewBadge || !knownRanks.has(card.rankNum);
        card.isNew = isFirstTimeSeen;
        if (isFirstTimeSeen) {
          newCardsThisRun++;
          knownRanks.add(card.rankNum);
        }

        if (card.isTop100 && card.rankNum >= 1 && card.rankNum <= 100) {
          rarePulls.set(`${card.rankNum}-${card.isHolo}`, card);
          if (card.rankNum >= 1 && card.rankNum <= 10) {
            sawTop10OnThisScreen = true;
          }
        }
      }

      if (sawTop10OnThisScreen && !top10ScreenshotPath) {
        top10ScreenshotPath = 'top10_pull.png';
        await page.screenshot({ path: top10ScreenshotPath, fullPage: true }).catch(() => {
          top10ScreenshotPath = null;
        });
      }

      if (!(await continueButton.isVisible().catch(() => false))) break;
      await continueButton.click();
      await page.waitForTimeout(1500);

      const nextAppeared = await continueButton
        .waitFor({ state: 'visible', timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      if (!nextAppeared) break;
    }
  } catch (err) {}

  await updateCollectionProgress(page, state);

  state.totalPacksOpened = (state.totalPacksOpened || 0) + packsOpenedNow;
  state.lastOpenedAt = new Date().toISOString();
  state.nextOpenTimestamp = computeNextSchedule();
  state.discoveredRanks = Array.from(knownRanks);
  saveState(state, true);

  const sortedPulls = Array.from(rarePulls.values()).sort((a, b) => a.rankNum - b.rankNum);
  const rareList = sortedPulls.map(
    c => `• ${c.isNew ? '🆕 **[NEW!]** ' : ''}**${c.levelName}** (${c.rank}) — **${c.rarity}**${c.isHolo ? ' ✨ **[HOLO]**' : ''}`
  );

  const collectionStatus = state.collectionTotal
    ? `\n• **Collection Progress:** \`${state.collectionTotal}\` (\`+${newCardsThisRun}\` new this run)`
    : `\n• **New Cards This Run:** \`${newCardsThisRun}\``;

  const cookieStatus = auth.cookieWasRefreshed ? `\n• 🔄 *Session cookie refreshed in memory!*` : '';

  const report =
    `🎉 **Opened ${packsOpenedNow} Pack(s)!** (\`${buttonText}\`)\n` +
    `• **Total Packs Opened by Bot:** \`${state.totalPacksOpened}\`${collectionStatus}\n` +
    `• **Next Opening In:** ${formatRemaining(state.nextOpenTimestamp)}${cookieStatus}`;

  await sendDiscordAlert(report);

  if (rareList.length > 0) {
    const rareAlert = `🔥 **TOP 100 / EPIC+ PULL ALERT!** 🔥\n${rareList.join('\n')}`;
    await sendDiscordAlert(rareAlert, top10ScreenshotPath);
  }

  await browser.close();
}

(async () => {
  const action = process.env.BOT_ACTION || 'open_packs';
  const eventName = process.env.GITHUB_EVENT_NAME || '';
  const isPushRun = eventName === 'push';
  const isManualOpen = eventName === 'workflow_dispatch' && action === 'open_packs';
  const state = loadState();

  if (action === 'check_time') {
    const target = state.nextOpenTimestamp || computeNextSchedule();
    const collectionLine = state.collectionTotal
      ? `\n• **Collection Progress:** \`${state.collectionTotal}\``
      : `\n• **Unique Demons Seen by Bot:** \`${state.discoveredRanks.length}\``;

    await sendDiscordAlert(
      `⏳ **Demon Gacha Timer & Stats**\n` +
      `• **Next Opening In:** ${formatRemaining(target)}\n` +
      `• **Total Packs Opened by Bot:** \`${state.totalPacksOpened}\`${collectionLine}`
    );
    process.exit(0);
  }

  if (action === 'reset_stats') {
    state.totalPacksOpened = 0;
    if (!state.nextOpenTimestamp || state.nextOpenTimestamp <= Date.now()) {
      state.nextOpenTimestamp = computeNextSchedule();
    }
    saveState(state, true);
    await sendDiscordAlert(
      `🔄 **Stats Reset:** Total packs opened counter has been reset to \`0\`.\n` +
      `• **Next Opening In:** ${formatRemaining(state.nextOpenTimestamp)}`
    );
    process.exit(0);
  }

  if (action === 'check_packs') {
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    });
    if (activeCookie) {
      const cookies = parseCookieList(activeCookie);
      if (cookies.length) await context.addCookies(cookies);
    }
    const page = await context.newPage();
    await page.goto(config.TARGET_URL, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(5000);
    const pageText = await page.locator('body').innerText().catch(() => '');
    const packCounterMatch = pageText.match(/\b(\d+)\s*\/\s*10\b/);
    const currentPacks = packCounterMatch ? `${packCounterMatch[1]} / 10` : 'Unknown';
    const target = state.nextOpenTimestamp || computeNextSchedule();

    await sendDiscordAlert(
      `📊 **Demon Gacha Status Check**\n` +
      `• **Packs Currently Ready:** \`${currentPacks}\`\n` +
      `• **Total Packs Opened by Bot:** \`${state.totalPacksOpened}\`\n` +
      `• **Next Opening In:** ${formatRemaining(target)}`
    );
    await browser.close();
    process.exit(0);
  }

  if (isPushRun) {
    state.nextOpenTimestamp = computeNextSchedule();
    saveState(state, true);
    const overrideMins = getOverrideMinutes();
    const modeLabel = overrideMins !== null ? `Override: ${overrideMins} min` : `${config.MIN_INTERVAL_MINUTES}–${config.MAX_INTERVAL_MINUTES} min`;
    await sendDiscordAlert(
      `⚙️ **Config Updated (${modeLabel})!**\n` +
      `• **Next Opening In:** ${formatRemaining(state.nextOpenTimestamp)}`
    );
  } else if (!state.nextOpenTimestamp) {
    state.nextOpenTimestamp = computeNextSchedule();
    saveState(state, true);
  }

  const loopStartMs = Date.now();
  const shiftDurationMs = 3.5 * 60 * 60 * 1000;
  const hardSafetyLimitMs = 5.3 * 60 * 60 * 1000;
  let forceImmediateFirstRun = isManualOpen;

  while (true) {
    if (!forceImmediateFirstRun) {
      while (state.nextOpenTimestamp && Date.now() < state.nextOpenTimestamp) {
        if (Date.now() - loopStartMs >= hardSafetyLimitMs) break;
        const remainingMs = state.nextOpenTimestamp - Date.now();
        await sleep(Math.min(remainingMs, 10000));
      }
      if (Date.now() - loopStartMs >= hardSafetyLimitMs) break;
    }

    forceImmediateFirstRun = false;
    await openPacksCycle(state);

    if (Date.now() - loopStartMs >= shiftDurationMs) {
      break;
    }
  }

  if (process.env.GITHUB_ACTIONS) {
    try {
      execSync('gh workflow enable "Open Demon Gacha Packs"', { stdio: 'ignore' });
    } catch (e) {}
  }
})();