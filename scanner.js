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
    const allElements = Array.from(document.querySelectorAll('button, a, [role="button"], div'));
    const cardCandidates = allElements.filter(el => {
      const t = (el.innerText || '').trim();
      return t.length > 0 && t.length <= 350 && t.includes('#') && /Verified by|Published by/i.test(t);
    });

    const leafElements = cardCandidates.filter(
      el => !cardCandidates.some(other => other !== el && el.contains(other))
    );

    const results = [];
    const seenIds = new Set();

    for (const el of leafElements) {
      const text = (el.innerText || '').trim();
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const rankLine = lines.find(l => /^#\d+$/.test(l));
      if (!rankLine) continue;

      const rankNum = parseInt(rankLine.slice(1), 10);
      if (isNaN(rankNum)) continue;

      let rarity = 'BELOW_EPIC';
      if (rankNum === 1) rarity = 'APEX';
      else if (rankNum >= 2 && rankNum <= 10) rarity = 'MYTHIC';
      else if (rankNum >= 11 && rankNum <= 35) rarity = 'LEGENDARY';
      else if (rankNum >= 36 && rankNum <= 100) rarity = 'EPIC';

      const serialLine = lines.find(l => /^#[0-9A-F]{6,}$/i.test(l));
      const rankIndex = lines.indexOf(rankLine);

      let levelName = 'Unknown Level';
      for (let i = rankIndex + 1; i < lines.length; i++) {
        const candidate = lines[i];
        if (/^(Verified by|Published by|Created by)/i.test(candidate)) break;
        if (/^#[0-9A-F]+$/i.test(candidate)) continue;
        if (/^(COMMON|UNCOMMON|RARE|EPIC|LEGENDARY|MYTHIC|APEX|HOLO|HOLOGRAPHIC|NEW|NEW!|DUPLICATE)$/i.test(candidate)) continue;
        levelName = candidate;
        break;
      }

      const isHolo = /\bholo(graphic)?\b/i.test(text) || /holo/i.test(el.outerHTML || '');
      const hasNewBadge = lines.some(l => /^NEW!?$/i.test(l)) || /\bnew\b/i.test(el.outerHTML || '');
      const id = serialLine || `${rankLine}-${levelName}-${isHolo}`;

      if (!seenIds.has(id)) {
        seenIds.add(id);
        results.push({
          id,
          rank: rankLine,
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
  updateCollectionProgress
};