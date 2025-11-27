// index.js
import express from "express";
import fetch from "node-fetch";
import sharp from "sharp";

const app = express();

// Mockups
const TOTE_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/Tragetasche_Mockup.jpg?v=1763713012";

const MUG_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1833.jpg?v=1764169061";

// In-Memory Cache
const previewCache = new Map();

// Healthcheck
app.get("/", (req, res) => {
  res.send("teeinblue-artwork-resizer läuft (Tasche + Tasse).");
});

// ----------------------
// Hintergrundentfernung
// ----------------------
function colorDist(c1, c2) {
  const dr = c1[0] - c2[0];
  const dg = c1[1] - c2[1];
  const db = c1[2] - c2[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

async function removeBackgroundFloodFill(inputBuffer) {
  const img = sharp(inputBuffer).ensureAlpha();
  const meta = await img.metadata();
  const { width, height } = meta;
  if (!width || !height) return inputBuffer;

  const raw = await img.raw().toBuffer();
  const samples = [];
  const stepX = Math.max(1, Math.floor(width / 50));
  const stepY = Math.max(1, Math.floor(height / 50));

  function samplePixelAt(x, y) {
    const idx = (y * width + x) * 4;
    samples.push([raw[idx], raw[idx + 1], raw[idx + 2]]);
  }

  for (let x = 0; x < width; x += stepX) {
    samplePixelAt(x, 0);
    samplePixelAt(x, height - 1);
  }
  for (let y = 0; y < height; y += stepY) {
    samplePixelAt(0, y);
    samplePixelAt(width - 1, y);
  }

  if (samples.length === 0) return inputBuffer;

  const clusters = [];
  const maxClusterDist = 25;

  for (const col of samples) {
    let found = false;
    for (const cl of clusters) {
      if (colorDist(col, cl.color) < maxClusterDist) {
        cl.count++;
        cl.color[0] = Math.round((cl.color[0] * (cl.count - 1) + col[0]) / cl.count);
        cl.color[1] = Math.round((cl.color[1] * (cl.count - 1) + col[1]) / cl.count);
        cl.color[2] = Math.round((cl.color[2] * (cl.count - 1) + col[2]) / cl.count);
        found = true;
        break;
      }
    }
    if (!found) clusters.push({ color: [...col], count: 1 });
  }

  clusters.sort((a, b) => b.count - a.count);
  const bgColors = clusters.slice(0, 3).map((c) => c.color);

  const visited = new Uint8Array(width * height);
  const queue = [];
  const TOL_START = 28;
  const TOL_GROW = 32;

  function isBg(r, g, b, tol) {
    return bgColors.some((bg) => colorDist([r, g, b], bg) < tol);
  }

  function tryPush(x, y, tol) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const idxPix = y * width + x;
    if (visited[idxPix]) return;

    const idx = idxPix * 4;
    const r = raw[idx], g = raw[idx + 1], b = raw[idx + 2], a = raw[idx + 3];

    if (a === 0 || isBg(r, g, b, tol)) {
      visited[idxPix] = 1;
      queue.push([x, y]);
    }
  }

  for (let x = 0; x < width; x++) tryPush(x, 0, TOL_START), tryPush(x, height - 1, TOL_START);
  for (let y = 0; y < height; y++) tryPush(0, y, TOL_START), tryPush(width - 1, y, TOL_START);

  while (queue.length) {
    const [cx, cy] = queue.pop();
    for (const [nx, ny] of [[cx - 1, cy],[cx + 1, cy],[cx, cy - 1],[cx, cy + 1]]) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const idxPix = ny * width + nx;
      if (visited[idxPix]) continue;

      const idx = idxPix * 4;
      const r = raw[idx], g = raw[idx + 1], b = raw[idx + 2], a = raw[idx + 3];
      if (a === 0 || isBg(r, g, b, TOL_GROW)) {
        visited[idxPix] = 1;
        queue.push([nx, ny]);
      }
    }
  }

  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (visited[y * width + x]) raw[(y * width + x) * 4 + 3] = 0;

  return sharp(raw, { raw: { width, height, channels: 4 }}).png().toBuffer();
}

// --------------------------------------
// 1) /tote-preview bleibt unverändert
// --------------------------------------
app.get("/tote-preview", async (req, res) => {
  const artworkUrl = req.query.url;
  if (!artworkUrl) return res.status(400).json({ error: "url fehlt" });

  if (previewCache.has("tote-" + artworkUrl)) {
    res.setHeader("Content-Type", "image/png");
    return res.send(previewCache.get("tote-" + artworkUrl));
  }

  try {
    const artResp = await fetch(artworkUrl);
    const artBuf = Buffer.from(await artResp.arrayBuffer());
    let transparent = await removeBackgroundFloodFill(artBuf);

    const mock = await fetch(TOTE_MOCKUP_URL);
    const mockBuf = Buffer.from(await mock.arrayBuffer());
    const mockSharp = sharp(mockBuf);
    const meta = await mockSharp.metadata();

    const design = await sharp(transparent)
      .resize(Math.round(meta.width * 0.42))
      .png()
      .toBuffer();

    const left = Math.round(meta.width * 0.26);
    const top = Math.round(meta.height * 0.46);

    const final = await mockSharp
      .composite([{ input: design, left, top }])
      .png()
      .toBuffer();

    previewCache.set("tote-" + artworkUrl, final);
    res.setHeader("Content-Type", "image/png");
    res.send(final);

  } catch (e) {
    res.status(500).json({ error: "Fehler", detail: e.toString() });
  }
});

// --------------------------------------
// 2) Neuer Endpoint: /mug-preview
// --------------------------------------
app.get("/mug-preview", async (req, res) => {
  const artworkUrl = req.query.url;
  if (!artworkUrl) return res.status(400).json({ error: "url fehlt" });

  if (previewCache.has("mug-" + artworkUrl)) {
    res.setHeader("Content-Type", "image/png");
    return res.send(previewCache.get("mug-" + artworkUrl));
  }

  try {
    // Artwork laden
    const artResp = await fetch(artworkUrl);
    const artBuf = Buffer.from(await artResp.arrayBuffer());
    let transparent = await removeBackgroundFloodFill(artBuf);

    // Mug Mockup laden
    const mockResp = await fetch(MUG_MOCKUP_URL);
    const mockBuf = Buffer.from(await mockResp.arrayBuffer());
    const mockSharp = sharp(mockBuf);
    const meta = await mockSharp.metadata();

    // Design skalieren → 28% der Breite der Tasse
    const design = await sharp(transparent)
      .resize(Math.round(meta.width * 0.28))
      .png()
      .toBuffer();

    // Positionierung Tasse (optisch mittig)
    const left = Math.round(meta.width * 0.36);
    const top = Math.round(meta.height * 0.40);

    const final = await mockSharp
      .composite([{ input: design, left, top }])
      .png()
      .toBuffer();

    previewCache.set("mug-" + artworkUrl, final);
    res.setHeader("Content-Type", "image/png");
    res.send(final);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler in /mug-preview", detail: err.toString() });
  }
});

// Server starten
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Server läuft auf Port " + PORT);
});
