// Sled Snow Report updater.
// Pulls current snow depth from NRCS SNOTEL and forecast snowfall from
// Open-Meteo (GFS, ECMWF and Canadian GEM models), then writes
// data/conditions.json for the website. Run with Node 20+:  node scripts/update.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AWDB = "https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1";
const MODELS = ["gfs_seamless", "ecmwf_ifs025", "gem_seamless"];
const MODEL_LABEL = { gfs_seamless: "GFS (US)", ecmwf_ifs025: "ECMWF (Euro)", gem_seamless: "GEM (Canada)" };
const TOMER_CHANNEL = "UCb8JPkld8YoOd2n6qAZ2aoQ";
const STATES = ["MT", "WY", "ID", "UT", "CO"];
const UA = { "User-Agent": "sled-snow-report/1.0 (snowmobile conditions site)" };

const CM_TO_IN = 0.393701;
const M_PER_FT = 0.3048;

async function getJSON(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return await r.json();
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((res) => setTimeout(res, 1500 * i));
    }
  }
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function km(aLat, aLon, bLat, bLon) {
  const R = 6371, t = Math.PI / 180;
  const dLat = (bLat - aLat) * t, dLon = (bLon - aLon) * t;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * t) * Math.cos(bLat * t) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const isoDate = (d) => d.toISOString().slice(0, 10);

// ---------- SNOTEL ----------

async function loadStations() {
  const all = [];
  for (const st of STATES) {
    const url = `${AWDB}/stations?stationTriplets=*:${st}:SNTL&returnForecastPointMetadata=false&returnReservoirMetadata=false&returnStationElements=false`;
    const data = await getJSON(url);
    const list = Array.isArray(data) ? data : data.stations || [];
    for (const s of list) {
      if (s.endDate && new Date(s.endDate) < new Date()) continue; // retired station
      all.push({
        triplet: s.stationTriplet,
        name: s.name,
        lat: Number(s.latitude),
        lon: Number(s.longitude),
        elevFt: Number(s.elevation),
      });
    }
  }
  return all;
}

function pickStation(zone, stations) {
  const near = stations
    .map((s) => ({ ...s, km: Math.min(...zone.spots.map((p) => km(p.lat, p.lon, s.lat, s.lon))) }))
    .filter((s) => Number.isFinite(s.km));
  if (zone.snotel) {
    const want = norm(zone.snotel);
    const named = near.filter((s) => s.km < 60 && (norm(s.name) === want || norm(s.name).startsWith(want)));
    if (named.length) return { ...named.sort((a, b) => a.km - b.km)[0], how: "named" };
  }
  // Station closest to any riding spot, favoring ones near riding elevation.
  // Stations well below riding elevation are penalized harder than ones above.
  const scored = near
    .filter((s) => s.km < 45)
    .map((s) => {
      const below = Math.max(0, zone.rideElevFt - (s.elevFt || 0));
      const above = Math.max(0, (s.elevFt || 0) - zone.rideElevFt);
      return { ...s, score: s.km + below / 150 + above / 400 };
    })
    .sort((a, b) => a.score - b.score);
  if (scored.length) return { ...scored[0], how: "nearest" };
  const closest = near.sort((a, b) => a.km - b.km)[0];
  return closest ? { ...closest, how: "nearest" } : null;
}

async function loadSnowDepth(triplets) {
  const end = new Date();
  const begin = new Date(end.getTime() - 9 * 86400000);
  const out = {};
  // AWDB accepts a comma-separated list; chunk to keep URLs short.
  for (let i = 0; i < triplets.length; i += 10) {
    const chunk = triplets.slice(i, i + 10);
    const url = `${AWDB}/data?stationTriplets=${encodeURIComponent(chunk.join(","))}&elements=SNWD,WTEQ&duration=DAILY&beginDate=${isoDate(begin)}&endDate=${isoDate(end)}&ordinal=1`;
    const data = await getJSON(url);
    for (const station of Array.isArray(data) ? data : []) {
      const series = {};
      for (const d of station.data || []) {
        const code = d.stationElement?.elementCode;
        series[code] = (d.values || [])
          .filter((v) => v.value !== null && v.value !== undefined && Number.isFinite(Number(v.value)))
          .map((v) => ({ date: String(v.date).slice(0, 10), value: Number(v.value) }))
          .sort((a, b) => a.date.localeCompare(b.date));
      }
      out[station.stationTriplet] = series;
    }
  }
  return out;
}

function summarizeDepth(series) {
  const snwd = series?.SNWD || [];
  const wteq = series?.WTEQ || [];
  if (!snwd.length) return null;
  const last = snwd[snwd.length - 1];
  const valueOn = (date) => snwd.find((v) => v.date === date)?.value;
  const daysBack = (n) => isoDate(new Date(new Date(last.date + "T12:00:00Z").getTime() - n * 86400000));
  const d1 = valueOn(daysBack(1));
  const d7 = valueOn(daysBack(7));
  return {
    depthIn: Math.max(0, Math.round(last.value)),
    asOf: last.date,
    change24hIn: d1 === undefined ? null : Math.round(last.value - d1),
    change7dIn: d7 === undefined ? null : Math.round(last.value - d7),
    sweIn: wteq.length ? Number(wteq[wteq.length - 1].value.toFixed(1)) : null,
  };
}

// ---------- Forecast ----------

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r1 = (n) => (n === null ? null : Math.round(n * 10) / 10);
const WINDOWS = { d1: 24, d7: 168, d10: 240 };

// Sum one model's hourly snowfall over a window. Returns inches, or null if
// the model doesn't cover (nearly) the whole window.
function windowSum(series, start, hrs, minShare = 0.9) {
  if (!Array.isArray(series)) return null;
  const valid = series.slice(start, start + hrs).filter((v) => v !== null && v !== undefined);
  return valid.length >= hrs * minShare ? valid.reduce((a, b) => a + b, 0) * CM_TO_IN : null;
}

// One request per zone: Open-Meteo takes a list of points, each with its own
// elevation, so every riding spot gets its own downscaled forecast.
async function loadForecast(zone) {
  const spots = zone.spots;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${spots.map((s) => s.lat).join(",")}` +
    `&longitude=${spots.map((s) => s.lon).join(",")}` +
    `&elevation=${spots.map((s) => Math.round(s.elevFt * M_PER_FT)).join(",")}` +
    `&hourly=snowfall&models=${MODELS.join(",")}&forecast_days=11&timezone=GMT`;
  let data = await getJSON(url);
  if (!Array.isArray(data)) data = [data];

  const nowHour = new Date().toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
  const times = data[0]?.hourly?.time || [];
  let start = times.findIndex((t) => t.slice(0, 13) >= nowHour);
  if (start < 0) start = 0;

  // perSpotModel[spotIndex][model][window] = inches
  const perSpotModel = data.map((loc) => {
    const out = {};
    for (const m of MODELS) {
      const series = loc.hourly?.[`snowfall_${m}`];
      out[m] = {};
      for (const [k, hrs] of Object.entries(WINDOWS)) out[m][k] = windowSum(series, start, hrs);
    }
    return out;
  });

  const result = {};
  for (const k of Object.keys(WINDOWS)) {
    // Zone value for each model = average of that model across the riding spots.
    const modelZone = MODELS.map((m) => mean(perSpotModel.map((p) => p[m][k]).filter((v) => v !== null))).filter((v) => v !== null);
    if (!modelZone.length) { result[k] = null; continue; }
    result[k] = { in: r1(mean(modelZone)), low: r1(Math.min(...modelZone)), high: r1(Math.max(...modelZone)), models: modelZone.length };
  }

  // Per-spot consensus (average of models) for the breakdown line.
  result.spots = spots.map((s, i) => {
    const o = { name: s.name, elevFt: s.elevFt };
    for (const k of Object.keys(WINDOWS)) o[k] = r1(mean(MODELS.map((m) => perSpotModel[i]?.[m]?.[k]).filter((v) => v !== null && v !== undefined)));
    return o;
  });

  // Daily totals for the 10-day strip: average over spots and models.
  result.daily = [];
  for (let d = 0; d < 10; d++) {
    const vals = [];
    for (const loc of data) for (const m of MODELS) {
      const v = windowSum(loc.hourly?.[`snowfall_${m}`], start + d * 24, 24, 0.8);
      if (v !== null) vals.push(v);
    }
    result.daily.push(r1(mean(vals)));
  }
  result.startsAt = times[start] ? times[start] + "Z" : null;
  return result;
}

// ---------- Chris Tomer latest video ----------

async function loadTomer() {
  try {
    const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${TOMER_CHANNEL}`, { headers: UA });
    if (!r.ok) return null;
    const xml = await r.text();
    const entry = xml.split("<entry>")[1];
    if (!entry) return null;
    const pick = (re) => (entry.match(re) || [])[1];
    const decode = (s) => (s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    return {
      title: decode(pick(/<title>([\s\S]*?)<\/title>/)),
      url: pick(/<link rel="alternate" href="([^"]+)"/),
      published: pick(/<published>([^<]+)<\/published>/),
    };
  } catch {
    return null;
  }
}

// ---------- Main ----------

async function main() {
  const { zones } = JSON.parse(await readFile(join(ROOT, "zones.json"), "utf8"));
  const stations = await loadStations();
  console.log(`Loaded ${stations.length} active SNOTEL stations`);

  for (const z of zones) z.rideElevFt = Math.round(mean(z.spots.map((s) => s.elevFt)) / 100) * 100;
  const picks = zones.map((z) => ({ zone: z, station: pickStation(z, stations) }));
  const triplets = [...new Set(picks.map((p) => p.station?.triplet).filter(Boolean))];
  let depth = {};
  try { depth = await loadSnowDepth(triplets); } catch (e) { console.error("SNOTEL data failed:", e.message); }

  const out = [];
  for (const { zone, station } of picks) {
    let forecast = null;
    try { forecast = await loadForecast(zone); } catch (e) { console.error(`Forecast failed for ${zone.name}:`, e.message); }
    const snow = station ? summarizeDepth(depth[station.triplet]) : null;
    console.log(`${zone.state} ${zone.name.padEnd(28)} -> ${station ? `${station.name} (${station.triplet}, ${station.how}, ${station.km.toFixed(0)} km)` : "no station"} | depth ${snow?.depthIn ?? "–"} in | 7d ${forecast?.d7?.in ?? "–"} in`);
    out.push({
      ...zone,
      station: station ? {
        name: station.name,
        triplet: station.triplet,
        elevFt: station.elevFt,
        kmFromSpots: Math.round(station.km),
        url: `https://wcc.sc.egov.usda.gov/nwcc/site?sitenum=${station.triplet.split(":")[0]}`,
      } : null,
      snow,
      forecast,
    });
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    sample: false,
    models: MODELS.map((m) => MODEL_LABEL[m]),
    tomer: await loadTomer(),
    zones: out,
  };
  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(join(ROOT, "data", "conditions.json"), JSON.stringify(payload, null, 1));
  console.log("Wrote data/conditions.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
