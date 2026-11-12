async function checkApiMe(page) {
  return await page.evaluate(async () => {
    try {
      const res = await fetch('/api/me', { credentials: 'include' });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) {}
      return { status: res.status, ok: res.ok, body: text.slice(0, 200), json };
    } catch (e) {
      return { status: 0, ok: false, body: String(e), json: null };
    }
  });
}

async function verifyAndRefreshAuth(page, context, state, activeCookieStr) {
  const authCheck = await checkApiMe(page);

  if (!authCheck.ok || authCheck.status === 401 || authCheck.status === 403 || authCheck.body === 'null') {
    return { ok: false, status: authCheck.status, cookieWasRefreshed: false, updatedCookie: activeCookieStr };
  }

  const browserCookies = await context.cookies('https://demongacha.com');
  const latestSidCookie = browserCookies.find(c => c.name === 'sid');
  let cookieWasRefreshed = false;
  let updatedCookie = activeCookieStr;

  if (latestSidCookie && latestSidCookie.value) {
    const newCookieStr = `sid=${latestSidCookie.value}`;
    const normalizedPrev = activeCookieStr.includes('=') ? activeCookieStr.trim() : `sid=${activeCookieStr.trim()}`;
    if (newCookieStr !== normalizedPrev) {
      cookieWasRefreshed = true;
      updatedCookie = newCookieStr;
    }
  }

  if (authCheck.json && typeof authCheck.json === 'object') {
    const userObj = authCheck.json.user || authCheck.json;
    const countVal = userObj.collectionCount ?? userObj.uniqueCards ?? userObj.cardsCount ?? userObj.totalCards;
    if (typeof countVal === 'number') {
      state.collectionTotal = `${countVal} cards`;
    }
  }

  return { ok: true, status: authCheck.status, cookieWasRefreshed, updatedCookie };
}

function classifyRank(rankNum, fallbackRarity = '') {
  if (rankNum === 1) return 'APEX';
  if (rankNum >= 2 && rankNum <= 10) return 'MYTHIC';
  if (rankNum >= 11 && rankNum <= 35) return 'LEGENDARY';
  if (rankNum >= 36 && rankNum <= 100) return 'EPIC';
  if (/^(APEX|MYTHIC|LEGENDARY|EPIC)$/i.test(fallbackRarity)) {
    return fallbackRarity.toUpperCase();
  }
  return 'BELOW_EPIC';
}

function extractCardsFromApiPayload(payload) {
  const found = [];
  const visited = new Set();

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const rawRank = node.rank ?? node.placement ?? node.position ?? node.aredlRank ?? (node.demon && (node.demon.rank ?? node.demon.position ?? node.demon.placement));
    const rawName = node.levelName ?? node.name ?? node.demonName ?? (node.demon && (node.demon.name ?? node.demon.levelName));
    const rawRarity = String(node.rarity ?? (node.demon && node.demon.rarity) ?? '').toUpperCase();

    const rankNum = typeof rawRank === 'number' ? rawRank : parseInt(String(rawRank || '').replace(/^#/, ''), 10);

    if (!isNaN(rankNum) && rankNum >= 1 && rankNum <= 2500 && typeof rawName === 'string' && rawName.trim()) {
      const isHolo = Boolean(node.isHolo || node.holo || node.holographic || node.isHolographic || /holo/i.test(String(node.variant || '')));
      const hasNewBadge = Boolean(node.isNew || node.new || node.firstPull);
      const rarity = classifyRank(rankNum, rawRarity);
      const serial = node.serial || node.serialNumber || node.cardId || node.id || '';

      found.push({
        id: serial ? String(serial) : `#${rankNum}-${rawName.trim()}-${isHolo}`,
        rank: `#${rankNum}`,
        rankNum,
        rarity,
        levelName: rawName.trim(),
        isHolo,
        hasNewBadge
      });
    }

    for (const key of Object.keys(node)) {
      walk(node[key]);
    }
  }

  walk(payload);
  return found;
}

async function scanCardsOnPage(page) {
  return await page.evaluate(() => {
    const allElements = Array.from(document.querySelectorAll('button, a, [role="button"], div, article, li'));
    const candidates = [];

    for (const el of allElements) {
      const text = (el.innerText || '').trim();
      if (text.length < 6 || text.length > 400) continue;
      if (!text.includes('#')) continue;

      const hasVerifier = /Verified by|Published by|Created by/i.test(text);
      const hasRarityWord = /\b(APEX|MYTHIC|LEGENDARY|EPIC|RARE|UNCOMMON|COMMON)\b/i.test(text);
      if (!hasVerifier && !hasRarityWord) continue;

      candidates.push({ el, text });
    }

    candidates.sort((a, b) => a.text.length - b.text.length);

    const results = [];
    const seenRankKeys = new Set();

    for (const { el, text } of candidates) {
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

      let rankNum = NaN;
      for (const line of lines) {
        if (/^#[0-9A-F]{5,}$/i.test(line)) continue;
        const m = line.match(/(?:^|\s)#(\d{1,4})(?:\b|$)/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n >= 1 && n <= 2500) {
            rankNum = n;
            break;
          }
        }
      }

      if (isNaN(rankNum)) continue;

      const rarityMatch = text.match(/\b(APEX|MYTHIC|LEGENDARY|EPIC|RARE|UNCOMMON|COMMON)\b/i);
      const explicitRarity = rarityMatch ? rarityMatch[1].toUpperCase() : '';

      let rarity = 'BELOW_EPIC';
      if (rankNum === 1) rarity = 'APEX';
      else if (rankNum >= 2 && rankNum <= 10) rarity = 'MYTHIC';
      else if (rankNum >= 11 && rankNum <= 35) rarity = 'LEGENDARY';
      else if (rankNum >= 36 && rankNum <= 100) rarity = 'EPIC';
      else if (/^(APEX|MYTHIC|LEGENDARY|EPIC)$/.test(explicitRarity)) rarity = explicitRarity;

      let levelName = 'Unknown Level';
      for (const line of lines) {
        if (/^(Verified by|Published by|Created by)/i.test(line)) continue;
        if (/^#\d+$/.test(line)) continue;
        if (/^#[0-9A-F]{4,}$/i.test(line)) continue;
        if (/^(COMMON|UNCOMMON|RARE|EPIC|LEGENDARY|MYTHIC|APEX|HOLO|HOLOGRAPHIC|NEW|NEW!|DUPLICATE)$/i.test(line)) continue;

        const cleaned = line
          .replace(/^(COMMON|UNCOMMON|RARE|EPIC|LEGENDARY|MYTHIC|APEX|NEW!?|HOLO(GRAPHIC)?)\s+/i, '')
          .replace(/\s+(COMMON|UNCOMMON|RARE|EPIC|LEGENDARY|MYTHIC|APEX|NEW!?|HOLO(GRAPHIC)?)$/i, '')
          .replace(/^#\d+\s*/, '')
          .trim();

        if (cleaned && cleaned.length >= 2 && !/^\d+\s*\/\s*\d+$/.test(cleaned)) {
          levelName = cleaned;
          break;
        }
      }

      if (levelName === 'Unknown Level') continue;

      const isHolo = /\bholo(graphic)?\b/i.test(text) || /holo/i.test(el.outerHTML || '');
      const hasNewBadge = lines.some(l => /\bNEW!?\b/i.test(l)) || /\bnew\b/i.test(el.outerHTML || '');
      const serialLine = lines.find(l => /^#[0-9A-F]{5,}$/i.test(l));
      const dedupeKey = `${rankNum}-${levelName.toLowerCase()}`;

      if (!seenRankKeys.has(dedupeKey)) {
        seenRankKeys.add(dedupeKey);
        results.push({
          id: serialLine || `#${rankNum}-${levelName}-${isHolo}`,
          rank: `#${rankNum}`,
          rankNum,
          rarity,
          levelName,
          isHolo,
          hasNewBadge
        });
      }
    }

    return results;
  }).catch(() => []);
}

async function updateCollectionProgress(page, state) {
  try {
    const collectionLink = page.locator('a:has-text("Collection"), button:has-text("Collection")').first();
    if (await collectionLink.isVisible().catch(() => false)) {
      await collectionLink.click();
      await page.waitForTimeout(2000);
      const colText = await page.locator('body').innerText().catch(() => '');
      const colMatch = colText.match(/\b(\d+)\s*\/\s*(\d{3,4})\b/);
      if (colMatch) {
        state.collectionTotal = `${colMatch[1]} / ${colMatch[2]}`;
      }
    }
  } catch (e) {}
}

module.exports = {
  verifyAndRefreshAuth,
  scanCardsOnPage,
  extractCardsFromApiPayload,
  updateCollectionProgress
};