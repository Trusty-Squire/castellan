// Placeholder feed — trivial fake data, no real source. This is the defect.
export async function fetchLines() {
  return [
    { event: "A vs B", book: "Book1", odds: 2.0 },
    { event: "A vs B", book: "Book2", odds: 2.0 },
  ];
}
