# Sled Snow Report

Snow depth now plus forecast snowfall for the next 24 hours, 7 days and 10 days at 25 key snowmobile zones in MT, WY, ID, UT and CO.

## How it works

- `zones.json` lists the 25 riding zones. Each zone has 3 to 4 high-elevation riding spots (for example Two Top, Lionhead, Tepee Basin and South Plateau for West Yellowstone), each with coordinates and typical riding elevation, plus a preferred SNOTEL station. Edit this file to add, remove or move spots or zones.
- `scripts/update.mjs` runs every 3 hours on GitHub Actions. It pulls:
  - **Snow depth** from the USDA NRCS SNOTEL network (AWDB REST API). If a preferred station name isn't found, it picks the closest active SNOTEL station near the riding elevation.
  - **Snowfall forecast** from Open-Meteo for every riding spot at its own elevation, from the GFS (US), ECMWF (Euro) and GEM (Canadian) models. The zone number is the average across spots and models, and the page shows the per-spot breakdown. These are the same models Chris Tomer walks through in his videos.
  - **Chris Tomer's latest YouTube video**, linked on the page.
- It writes `data/conditions.json`. `index.html` reads that file. No server, no API keys, free to host.

The committed `data/conditions.json` holds example numbers until the first run.

## Put it online (about 5 minutes, free)

1. Create a new public repository on GitHub (for example `sled-snow-report`).
2. Upload everything in this folder, keeping the folder structure (including `.github/workflows/update.yml`).
3. In the repo, go to **Settings → Pages**. Under "Build and deployment", choose **Deploy from a branch**, branch `main`, folder `/ (root)`. Save.
4. Go to **Actions → Update snow data → Run workflow** to pull live data right away.
5. Your site is at `https://<your-username>.github.io/sled-snow-report/`. It refreshes on its own every 3 hours.

## Run locally

```
node scripts/update.mjs      # needs Node 20+
npx serve .                  # then open http://localhost:3000
```

## Data sources

- USDA NRCS National Water and Climate Center, SNOTEL network
- Open-Meteo.com weather API (CC BY 4.0)
- Chris Tomer, YouTube @thechristomer
