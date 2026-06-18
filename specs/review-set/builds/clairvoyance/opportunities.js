function americanToDecimal(odds) {
  if (typeof odds !== 'number' || !Number.isFinite(odds)) {
    return NaN;
  }

  if (odds > 1) {
    return odds;
  }

  if (odds > 0) {
    return 1 + odds / 100;
  }

  if (odds < 0) {
    return 1 + 100 / Math.abs(odds);
  }

  return NaN;
}

function valueToDecimal(rawOdds) {
  const odds = Number(rawOdds);
  if (!Number.isFinite(odds)) {
    return NaN;
  }

  return americanToDecimal(odds);
}

function outcomeName(item) {
  if (typeof item === 'string') {
    return item;
  }
  if (item && typeof item === 'object') {
    return item.name || item.outcome || item.label || item.team || '';
  }
  return '';
}

function parseOutcomeNamesFromArray(values) {
  if (!Array.isArray(values) || values.length !== 2) {
    return [];
  }

  const names = values.map((value) => outcomeName(value)).filter((name) => typeof name === 'string' && name.length > 0);

  if (names.length !== 2) {
    return [];
  }

  return names;
}

function parseExactPair(values) {
  if (!Array.isArray(values) || values.length !== 2) {
    return null;
  }

  return values;
}

function extractBookOdds(book, fallbackNames = []) {
  if (!book || typeof book !== 'object') {
    return null;
  }

  const exactPair = parseExactPair(book.odds);
  if (exactPair) {
    return {
      odds: exactPair.map(valueToDecimal),
      outcomeNames: parseOutcomeNamesFromArray(fallbackNames),
    };
  }

  const outcomes = parseExactPair(book.outcomes);
  if (outcomes) {
    const odds = [];
    const outcomeNames = [];
    for (const entry of outcomes) {
      if (entry && typeof entry === 'object') {
        odds.push(valueToDecimal(entry.price ?? entry.odds ?? entry.price_american ?? entry.value));
        outcomeNames.push(outcomeName(entry));
      } else {
        odds.push(valueToDecimal(entry));
        outcomeNames.push('');
      }
    }

    return { odds, outcomeNames };
  }

  if (Array.isArray(book.markets) && book.markets.length > 0) {
    const market = book.markets.find((entry) => entry && entry.key === 'h2h') || book.markets[0];
    const marketOutcomes = parseExactPair(market && market.outcomes);
    if (market && marketOutcomes) {
      const odds = [];
      const outcomeNames = [];
      for (const entry of marketOutcomes) {
        if (entry && typeof entry === 'object') {
          odds.push(valueToDecimal(entry.price ?? entry.odds ?? entry.value));
          outcomeNames.push(outcomeName(entry));
        } else {
          odds.push(valueToDecimal(entry));
          outcomeNames.push('');
        }
      }
      return { odds, outcomeNames };
    }
  }

  return null;
}

function extractOutcomeNamesFromEvent(event) {
  const candidates = [
    parseOutcomeNamesFromArray(event?.outcomes),
    parseOutcomeNamesFromArray(event?.event?.outcomes),
  ];

  for (const candidate of candidates) {
    if (candidate.length === 2) {
      return candidate;
    }
  }

  return [];
}

function getEventMetadata(event) {
  const source = event?.event && typeof event.event === 'object' ? event.event : event;
  if (!source || typeof source !== 'object') {
    return {};
  }

  return {
    id: source.id || event.id,
    league: source.league || event.league,
    startTime: source.startTime || event.startTime,
    home: source.home || event.home,
    away: source.away || event.away,
    title: source.title || event.title,
    market: source.market || event.market,
  };
}

function normalizeOpportunity(opportunity) {
  if (!opportunity || typeof opportunity !== 'object') {
    return null;
  }

  const event = opportunity.event && typeof opportunity.event === 'object' ? opportunity.event : {};

  return {
    event: {
      id: String(event.id ?? ''),
      league: String(event.league ?? ''),
      startTime: event.startTime ?? null,
      home: String(event.home ?? ''),
      away: String(event.away ?? ''),
      title: String(event.title ?? ''),
      market: String(event.market ?? ''),
    },
    eventId: String(opportunity.eventId ?? event.id ?? ''),
    league: String(opportunity.league ?? event.league ?? ''),
    startTime: opportunity.startTime ?? null,
    home: String(opportunity.home ?? event.home ?? ''),
    away: String(opportunity.away ?? event.away ?? ''),
    title: String(opportunity.title ?? event.title ?? ''),
    market: String(opportunity.market ?? event.market ?? ''),
    outcome1: {
      name: String(opportunity.outcome1?.name ?? ''),
      odds: Number(opportunity.outcome1?.odds),
      book: String(opportunity.outcome1?.book ?? ''),
    },
    outcome2: {
      name: String(opportunity.outcome2?.name ?? ''),
      odds: Number(opportunity.outcome2?.odds),
      book: String(opportunity.outcome2?.book ?? ''),
    },
    size: Number(opportunity.size),
  };
}

function findArbitrage(events) {
  const sourceEvents = Array.isArray(events) ? events : [];
  const opportunities = [];

  for (const event of sourceEvents) {
    if (!event || typeof event !== 'object') {
      continue;
    }

    const books = Array.isArray(event.books) ? event.books : [];
    if (books.length === 0) {
      continue;
    }

    let outcomeNames = extractOutcomeNamesFromEvent(event);
    const bestOdds = [-Infinity, -Infinity];
    const bestBooks = [null, null];

    for (const book of books) {
      const extracted = extractBookOdds(book, outcomeNames);
      if (!extracted || !Array.isArray(extracted.odds) || extracted.odds.length !== 2) {
        continue;
      }

      const { odds, outcomeNames: currentNames } = extracted;
      if (outcomeNames.length !== 2 && currentNames.every(Boolean)) {
        outcomeNames = currentNames.slice(0, 2);
      }

      for (let i = 0; i < 2; i++) {
        const decimal = odds[i];
        if (!Number.isFinite(decimal) || decimal <= 1) {
          continue;
        }
        if (decimal > bestOdds[i]) {
          bestOdds[i] = decimal;
          bestBooks[i] = book.name || book.key || book.title || '';
        }
      }
    }

    if (outcomeNames.length !== 2 || !bestOdds.every((value) => Number.isFinite(value) && value > 1)) {
      continue;
    }

    const impliedProbabilitySum = 1 / bestOdds[0] + 1 / bestOdds[1];
    if (!Number.isFinite(impliedProbabilitySum) || impliedProbabilitySum >= 1) {
      continue;
    }

    const size = 1 - impliedProbabilitySum;

    const metadata = getEventMetadata(event);

    opportunities.push(normalizeOpportunity({
      event: metadata,
      eventId: metadata.id,
      league: metadata.league,
      startTime: metadata.startTime,
      home: metadata.home,
      away: metadata.away,
      title: metadata.title,
      market: metadata.market,
      outcome1: {
        name: outcomeNames[0],
        odds: bestOdds[0],
        book: bestBooks[0],
      },
      outcome2: {
        name: outcomeNames[1],
        odds: bestOdds[1],
        book: bestBooks[1],
      },
      size,
    }));
  }

  opportunities.sort((a, b) => b.size - a.size);
  return opportunities;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { findArbitrage };
}

if (typeof globalThis !== 'undefined') {
  globalThis.findArbitrage = findArbitrage;
}
