const events = [
  {
    event: {
      id: 'evt_nba_01',
      league: 'NBA',
      startTime: '2026-06-18T00:00:00Z',
      home: 'Riverton Rockets',
      away: 'Harbor Falcons',
      title: 'Riverton Rockets vs Harbor Falcons',
      market: 'Moneyline'
    },
    books: [
      {
        key: 'fanduel',
        title: 'FanDuel',
        markets: [
          {
            key: 'h2h',
            outcomes: [
              { name: 'Riverton Rockets', price: -110 },
              { name: 'Harbor Falcons', price: -105 }
            ]
          }
        ]
      }
    ],
    outcomes: [
      { name: 'Riverton Rockets', odds: -110 },
      { name: 'Harbor Falcons', odds: -105 }
    ]
  },
  {
    event: {
      id: 'evt_nba_02',
      league: 'NBA',
      startTime: '2026-06-19T01:30:00Z',
      home: 'Midtown Meteors',
      away: 'Coastal Cougars',
      title: 'Midtown Meteors vs Coastal Cougars',
      market: 'Moneyline'
    },
    books: [
      {
        key: 'draftkings',
        title: 'DraftKings',
        markets: [
          {
            key: 'h2h',
            outcomes: [
              { name: 'Midtown Meteors', price: 118 },
              { name: 'Coastal Cougars', price: -142 }
            ]
          }
        ]
      }
    ],
    outcomes: [
      { name: 'Midtown Meteors', odds: 118 },
      { name: 'Coastal Cougars', odds: -142 }
    ]
  }
];

const styles = {
  containerClass: 'fixture-feed',
  headerClass: 'fixture-feed__header',
  eventRowClass: 'fixture-feed__event',
  outcomeClass: 'fixture-feed__outcome',
  accentColor: '#2563eb',
  mutedColor: '#6b7280'
};

const fixtureFeed = { events, styles };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = fixtureFeed;
}

if (typeof globalThis !== 'undefined') {
  globalThis.fixtureFeed = fixtureFeed;
}
