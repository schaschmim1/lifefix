// Live-Zugdaten für "Mein Plan": holt Verbindungen und Abfahrten vom MVV (EFA) und
// gibt sie mit CORS zurück, damit die Webseite sie direkt abrufen darf.
// Aufruf: /functions/v1/zug?dir=hin|rueck[&at=ISO-Zeit]  oder  ?board=1 (Abfahrtstafel Grafing)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const EFA = "https://efa.mvv-muenchen.de/ng";
const HOME_ID = "de:09175:4050"; // Grafing-Bahnhof
const DEST_COORD = "11.55374:48.15466:WGS84[dd.ddddd]:Hochschule";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "content-type": "application/json; charset=utf-8",
  "cache-control": "public, max-age=20",
};

function berlin(d: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}${p.month}${p.day}`, time: `${p.hour === "24" ? "00" : p.hour}${p.minute}` };
}
const ms = (s?: string) => (s ? new Date(s).getTime() : NaN);
const delaySec = (plan?: string, est?: string) =>
  plan && est ? Math.round((ms(est) - ms(plan)) / 1000) : null;

async function efa(path: string, q: Record<string, string>) {
  const url = `${EFA}/${path}?` + new URLSearchParams({ outputFormat: "rapidJSON", coordOutputFormat: "WGS84[dd.ddddd]", language: "de", ...q });
  const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error("MVV antwortet mit " + r.status);
  return await r.json();
}
const lineName = (t: any) =>
  String(t?.disassembledName || t?.number || t?.name || "").replace(/^(S-Bahn|Regionalbahn|Regional-Express|Bus|Tram|U-Bahn)\s+/i, "").trim();
const platform = (loc: any) => {
  const p = loc?.properties?.platformName || loc?.properties?.platform || loc?.disassembledName || "";
  return String(p).replace(/^(Gleis|Bstg\.?)\s*/i, "").replace(/_.*$/, "");
};

function leg(l: any) {
  const t = l.transportation, o = l.origin, d = l.destination;
  const cls = t?.product?.class;
  const walking = !t || cls === 99 || cls === 100;
  const dep = o.departureTimeEstimated || o.departureTimePlanned, arr = d.arrivalTimeEstimated || d.arrivalTimePlanned;
  if (walking) return { walking: true, departure: dep, arrival: arr };
  return {
    origin: { name: o.name }, destination: { name: d.name },
    line: { name: lineName(t) },
    direction: t.destination?.name || "",
    departure: dep, plannedDeparture: o.departureTimePlanned,
    departureDelay: delaySec(o.departureTimePlanned, o.departureTimeEstimated),
    departurePlatform: platform(o),
    arrival: arr, plannedArrival: d.arrivalTimePlanned,
    cancelled: (l.infos || []).some((i: any) => /fällt aus|Ausfall/i.test(i.title || i.subtitle || "")) || undefined,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const u = new URL(req.url);
  try {
    if (u.searchParams.get("board")) {
      const now = berlin(new Date());
      const j = await efa("XML_DM_REQUEST", {
        type_dm: "stop", name_dm: HOME_ID, mode: "direct", useRealtime: "1", limit: "16",
        itdDate: now.date, itdTime: now.time,
      });
      const departures = (j.stopEvents || []).map((e: any) => ({
        when: e.departureTimeEstimated || e.departureTimePlanned, plannedWhen: e.departureTimePlanned,
        delay: delaySec(e.departureTimePlanned, e.departureTimeEstimated),
        platform: platform(e.location), line: { name: lineName(e.transportation) },
        direction: e.transportation?.destination?.name || "",
      }));
      return new Response(JSON.stringify({ departures }), { headers: CORS });
    }
    const dir = u.searchParams.get("dir") === "rueck" ? "rueck" : "hin";
    const at = new Date(u.searchParams.get("at") || Date.now());
    const when = berlin(isNaN(at.getTime()) ? new Date() : at);
    const q: Record<string, string> = {
      locationServerActive: "1", useRealtime: "1", calcNumberOfTrips: "5",
      itdDate: when.date, itdTime: when.time,
      type_origin: dir === "hin" ? "stop" : "coord", name_origin: dir === "hin" ? HOME_ID : DEST_COORD,
      type_destination: dir === "hin" ? "coord" : "stop", name_destination: dir === "hin" ? DEST_COORD : HOME_ID,
    };
    const j = await efa("XML_TRIP_REQUEST2", q);
    const journeys = (j.journeys || []).map((x: any) => ({ legs: (x.legs || []).map(leg) }));
    return new Response(JSON.stringify({ journeys }), { headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message || e) }), { status: 502, headers: CORS });
  }
});
