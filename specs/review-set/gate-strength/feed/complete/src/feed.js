// Real odds feed: pulls live lines from the named source, not placeholder data.
const SOURCE = "https://api.the-odds-api.com/v4/sports/upcoming/odds";

export async function fetchLines(apiKey) {
  const res = await fetch(`${SOURCE}?apiKey=${apiKey}&regions=us&markets=h2h`);
  if (!res.ok) throw new Error(`the-odds-api ${res.status}`);
  return res.json();
}
