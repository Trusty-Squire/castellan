function escapeHtml(value) {
  const text = value == null ? '' : String(value);

  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toPair(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  if (values.length !== 2) {
    return [];
  }

  return values;
}

function extractNames(event) {
  const direct = toPair(event?.outcomes);
  const nested = toPair(event?.event?.outcomes);
  const sourceOutcomes = nested.length === 2 ? nested : direct.length === 2 ? direct : null;

  if (sourceOutcomes) {
    return sourceOutcomes.map((item) => {
      if (typeof item === 'string') {
        return item;
      }
      if (item && typeof item === 'object' && typeof item.name === 'string') {
        return item.name;
      }
      return '';
    });
  }

  const source = event?.event || event || {};
  const home = typeof source.home === 'string' ? source.home : '';
  const away = typeof source.away === 'string' ? source.away : '';

  if (home || away) {
    return [home, away];
  }

  return [];
}

function extractOddsFromEvent(event) {
  const pairs = [];

  if (Array.isArray(event?.outcomes)) {
    const odds = event.outcomes
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return NaN;
        }
        const raw = entry.price ?? entry.odds;
        const number = Number(raw);
        return Number.isFinite(number) ? number : NaN;
      })
      .filter((value) => Number.isFinite(value));

    if (odds.length === 2) {
      pairs.push(odds);
    }
  }

  const books = Array.isArray(event?.books) ? event.books : [];
  for (const book of books) {
    if (!book || typeof book !== 'object') {
      continue;
    }

    if (Array.isArray(book.odds)) {
      const candidate = toPair(book.odds);
      if (candidate.length === 2) {
        const normalized = candidate.map((value) => Number(value));
        if (normalized.every((value) => Number.isFinite(value))) {
          pairs.push(normalized);
          continue;
        }
      }
    }

    if (Array.isArray(book.outcomes)) {
      const candidate = toPair(book.outcomes);
      if (candidate.length === 2) {
        const normalized = candidate
          .map((entry) => {
            const value = entry && typeof entry === 'object' ? entry.price || entry.odds : entry;
            const number = Number(value);
            return Number.isFinite(number) ? number : NaN;
          })
          .map((value) => Number(value));

        if (normalized.every((value) => Number.isFinite(value))) {
          pairs.push(normalized);
          continue;
        }
      }
    }

    if (Array.isArray(book.markets)) {
      const market = book.markets.find((entry) => entry && entry.key === 'h2h') || book.markets[0];
      const candidate = toPair(market?.outcomes);
      if (candidate.length === 2) {
        const normalized = candidate
          .map((entry) => {
            const value = entry && typeof entry === 'object' ? entry.price || entry.odds : entry;
            const number = Number(value);
            return Number.isFinite(number) ? number : NaN;
          })
          .map((value) => Number(value));

        if (normalized.every((value) => Number.isFinite(value))) {
          pairs.push(normalized);
        }
      }
    }
  }

  return pairs.length > 0 ? pairs[0] : [];
}

function eventFields(event) {
  const source = event?.event && typeof event.event === 'object' ? event.event : event || {};

  return {
    id: source.id || event?.id || '',
    league: source.league || event?.league || '',
    startTime: source.startTime || event?.startTime || '',
    home: source.home || event?.home || '',
    away: source.away || event?.away || '',
    title: source.title || event?.title || '',
    market: source.market || event?.market || '',
  };
}

function formatEventTitle(fields, names) {
  if (typeof fields.title === 'string' && fields.title.length > 0) {
    return fields.title;
  }

  if (typeof fields.home === 'string' && typeof fields.away === 'string' && fields.home && fields.away) {
    return `${fields.home} vs ${fields.away}`;
  }

  const fallback = names.filter(Boolean);
  if (fallback.length > 0) {
    return fallback.join(' vs ');
  }

  return '';
}

function renderLines(events) {
  if (!Array.isArray(events)) {
    return '';
  }

  return events
    .map((event) => {
      const fields = eventFields(event);
      const names = extractNames(event);
      const outcomes = names.length === 2 ? names : ['', ''];
      const odds = extractOddsFromEvent(event);
      const formattedOdds = [odds[0], odds[1]].map((value) =>
        Number.isFinite(Number(value)) ? String(Number(value)) : '',
      );
      const title = formatEventTitle(fields, outcomes);

      return `
        <tr data-event-id="${escapeHtml(fields.id)}">
          <td>${escapeHtml(fields.league)}</td>
          <td>${escapeHtml(title)}</td>
          <td>${escapeHtml(fields.market)}</td>
          <td>${escapeHtml(outcomes[0])}</td>
          <td>${escapeHtml(formattedOdds[0])}</td>
          <td>${escapeHtml(outcomes[1])}</td>
          <td>${escapeHtml(formattedOdds[1])}</td>
          <td>${escapeHtml(fields.startTime)}</td>
        </tr>`
        .replace(/\n\s*/g, '')
        .trim();
    })
    .join('');
}

function normalizeOpportunity(opportunity) {
  const source = opportunity && typeof opportunity === 'object' ? opportunity : {};
  const event = source.event && typeof source.event === 'object' ? source.event : {};

  const eventTitle =
    source.title ||
    event.title ||
    (typeof source.home === 'string' && typeof source.away === 'string'
      ? `${source.home} vs ${source.away}`
      : event.home || event.away || source.eventId || source.id || '');

  const size = Number(source.size);
  const pct = Number.isFinite(size) ? `${(size * 100).toFixed(2)}%` : '';

  return {
    id: source.eventId || source.id || event.id || '',
    title: eventTitle,
    market: source.market || event.market || '',
    league: source.league || event.league || '',
    size: pct,
    outcome1Name: source.outcome1 && typeof source.outcome1 === 'object' ? source.outcome1.name || '' : '',
    outcome1Book: source.outcome1 && typeof source.outcome1 === 'object' ? source.outcome1.book || '' : '',
    outcome1Odds: source.outcome1 && typeof source.outcome1 === 'object' ? Number(source.outcome1.odds) : NaN,
    outcome2Name: source.outcome2 && typeof source.outcome2 === 'object' ? source.outcome2.name || '' : '',
    outcome2Book: source.outcome2 && typeof source.outcome2 === 'object' ? source.outcome2.book || '' : '',
    outcome2Odds: source.outcome2 && typeof source.outcome2 === 'object' ? Number(source.outcome2.odds) : NaN,
  };
}

function renderOpportunityRow(opportunity) {
  const normalized = normalizeOpportunity(opportunity);
  const odds1 =
    Number.isFinite(normalized.outcome1Odds) ? normalized.outcome1Odds.toFixed(2) : '';
  const odds2 =
    Number.isFinite(normalized.outcome2Odds) ? normalized.outcome2Odds.toFixed(2) : '';

  return `<li data-event-id="${escapeHtml(normalized.id)}">` +
    `<div class="opportunity__header">` +
    `<span class="opportunity__event">${escapeHtml(normalized.title)}</span>` +
    `<span class="opportunity__market">${escapeHtml(normalized.market)}</span>` +
    `<span class="opportunity__league">${escapeHtml(normalized.league)}</span>` +
    `<span class="opportunity__size">${escapeHtml(normalized.size)}</span>` +
    `</div>` +
    `<div class="opportunity__outcomes">` +
    `<span>${escapeHtml(normalized.outcome1Name)} ${escapeHtml(normalized.outcome1Book ? '(' + normalized.outcome1Book + ')' : '')} ${escapeHtml(odds1)}</span>` +
    `<span>${escapeHtml(normalized.outcome2Name)} ${escapeHtml(normalized.outcome2Book ? '(' + normalized.outcome2Book + ')' : '')} ${escapeHtml(odds2)}</span>` +
    `</div>` +
    `</li>`;
}

function renderOpportunities(opps) {
  if (!Array.isArray(opps)) {
    return '';
  }

  return opps.map(renderOpportunityRow).join('');
}

module.exports = {
  renderLines,
  renderOpportunities,
};

if (typeof globalThis !== 'undefined') {
  globalThis.renderLines = renderLines;
  globalThis.renderOpportunities = renderOpportunities;
}
