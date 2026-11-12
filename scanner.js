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

async function scanCardsOnPage(page) {
  return await page.evaluate(() => {
    const allElements = Array.from(document.querySelectorAll('button, a, [role="button"], div, article, li'));

    const cardCandidates = allElements.filter(el => {
      const text = (el.innerText || '').trim();
      if (text.length < 10 || text.length > 400) return false;
      if (!/#\d+/.test(text)) return false;
      if (!/Verified by|Published by|Created by/i.test(text)) return false;
      return true;
    });

    const leafElements = cardCandidates.filter(
      el => !cardCandidates.some(other => other !== el && el.contains(other))
    );

    const results = [];
    const seenKeys = new Set();

    for (const el of leafElements) {
      const text = (el.innerText || '').trim();
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

      const rarityMatch = text.match(/\b(APEX|MYTHIC|LEGENDARY|EPIC|RARE|UNCOMMON|COMMON)\b/i);
      const explicitRarity = rarityMatch ? rarityMatch[1].toUpperCase() : '';

      if (/^(COMMON|UNCOMMON|RARE)$/.test(explicitRarity)) {
        const allNums = [];
        for (const line of lines) {
          const matches = line.matchAll(/(?:^|\s)#(\d{1,4})(?=\s|$)/g);
          for (const m of matches) {
            const n = parseInt(m[1], 10);
            if (!isNaN(n) && n >= 1 && n <= 2500) allNums.push(n);
          }
        }
        const rankNum = allNums.find(n => n > 100) || allNums[allNums.length - 1] || 999;
        const hasNewBadge = lines.some(l => /^NEW!?$/i.test(l));
        const dedupeKey = `${rankNum}-${explicitRarity}-${ text.slice(0, 40) }`;
        if (!seenKeys.has(dedupeKey)) {
          seenKeys.add(dedupeKey);
          results.push({
            id: dedupeKey,
            rank: `#${rankNum}`,
            rankNum,
            rarity: explicitRarity,
            levelName: 'Common/Rare Card',
            isHolo: false,
            hasNewBadge,
            isTop100: false
          });
        }
        continue;
      }

      const candidateNums = [];
      for (const line of lines) {
        if (/^#[0-9A-F]{5,}$/i.test(line)) continue;
        const matches = line.matchAll(/(?:^|\s)#(\d{1,4})(?=\s|$)/g);
        for (const m of matches) {
          const n = parseInt(m[1], 10);
          if (!isNaN(n) && n >= 1 && n <= 2500) {
            candidateNums.push(n);
          }
        }
      }

      if (candidateNums.length === 0) continue;

      let rankNum = NaN;
      if (explicitRarity === 'APEX') {
        rankNum = candidateNums.find(n => n === 1) ?? NaN;
      } else if (explicitRarity === 'MYTHIC') {
        rankNum = candidateNums.find(n => n >= 2 && n <= 10) ?? NaN;
      } else if (explicitRarity === 'LEGENDARY') {
        rankNum = candidateNums.find(n => n >= 11 && n <= 35) ?? NaN;
      } else if (explicitRarity === 'EPIC') {
        rankNum = candidateNums.find(n => n >= 36 && n <= 100) ?? NaN;
      } else {
        const standaloneRankLine = lines.find(l => /^#\d{1,4}$/.test(l));
        if (standaloneRankLine) {
          rankNum = parseInt(standaloneRankLine.slice(1), 10);
        }
      }

      if (isNaN(rankNum) || rankNum < 1 || rankNum > 100) continue;

      let rarity = 'BELOW_EPIC';
      if (rankNum === 1) rarity = 'APEX';
      else if (rankNum >= 2 && rankNum <= 10) rarity = 'MYTHIC';
      else if (rankNum >= 11 && rankNum <= 35) rarity = 'LEGENDARY';
      else if (rankNum >= 36 && rankNum <= 100) rarity = 'EPIC';

      if (explicitRarity && explicitRarity !== rarity) continue;

      let levelName = 'Unknown Level';
      for (const line of lines) {
        if (/^(Verified by|Published by|Created by)/i.test(line)) break;
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

      const isHolo = /\bholo(graphic)?\b/i.test(text);
      const hasNewBadge = lines.some(l => /^NEW!?$/i.test(l));
      const serialLine = lines.find(l => /^#[0-9A-F]{5,}$/i.test(l));
      const dedupeKey = `${rankNum}-${levelName.toLowerCase()}-${isHolo}`;

      if (!seenKeys.has(dedupeKey)) {
        seenKeys.add(dedupeKey);
        results.push({
          id: serialLine || dedupeKey,
          rank: `#${rankNum}`,
          rankNum,
          rarity,
          levelName,
          isHolo,
          hasNewBadge,
          isTop100: true
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
  updateCollectionProgress
};