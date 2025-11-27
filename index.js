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

// Cache
const previewCache = new Map();

// Health Check
app.get("/", (req, res) => {
  res.send("AI Artwork Extractor läuft (Transparent-Version).");
});

/* -------------------------------------------------------
   Hilfsfunktion: Farbdistanz
------------------------------------------------------- */
function colorDist(c1, c2) {
  const dr = c1[0] - c2[0];
  const dg = c1[1] - c2[1];
  const db = c1[2] - c2[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/* -------------------------------------------------------
   HINTERGRUND ENTFERNEN (Flood-Fill)
------------------------------------------------------- */
async function removeBackgroundFloodFill(inputBuffer) {
  const img = sharp(inputBuffer).ensureAlpha();
  const meta = await img.metadata();

  const { width, height } = meta;
  if (!width || !height) throw new Error("Ungültige Bildgröße");

  const raw = await img.raw().toBuffer();
  const samples = [];

  function sample(x, y) {
    const i = (y * width + x) * 4;
    const a = raw[i + 3];
    if (a === 0) return;
    samples.push([raw[i], raw[i + 1], raw[i + 2]]);
  }

  // Rand abtasten
  for (let x = 0; x < width; x += Math.max(1, width / 50)) {
    sample(x, 0);
    sample(x, height - 1);
  }
  for (let y = 0; y < height; y += Math.max(1, height / 50)) {
    sample(0, y);
    sample(width - 1, y);
  }

  if (samples.length === 0) return inputBuffer;

  // Clustern
  const clusters = [];
  const maxDist = 25;

  for (const col of samples) {
    let found = false;
    for (const cl of clusters) {
      if (colorDist(col, cl.color) < maxDist) {
        cl.count++;
        cl.color = [
          (cl.color[0] * (cl.count - 1) + col[0]) / cl.count,
          (cl.color[1] * (cl.count - 1) + col[1]) / cl.count,
          (cl.color[2] * (cl.count - 1) + col[2]) / cl.count,
        ];
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

  function matchBg(r, g, b, tol) {
    return bgColors.some((c) => colorDist([r, g, b], c) < tol);
  }

  function enqueue(x, y, tol) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const idx = y * width + x;
    if (visited[idx]) return;

    const p = idx * 4;
    const r = raw[p];
    const g = raw[p + 1];
    const b = raw[p + 2];
    const a = raw[p + 3];

    if (a === 0 || matchBg(r, g, b, tol)) {
      visited[idx] = 1;
      queue.push([x, y]);
    }
  }

  // Startpunkte Rand
  for (let x = 0; x < width; x++) {
    enqueue(x, 0, 26);
    enqueue(x, height - 1, 26);
  }
  for (let y = 0; y < height; y++) {
    enqueue(0, y, 26);
    enqueue(width - 1, y, 26);
  }

  // Flood-Fill
  while (queue.length) {
    const [cx, cy] = queue.pop();
    const nb = [
      [cx - 1, cy],
      [cx + 1, cy],
      [cx, cy - 1],
      [cx, cy + 1],
    ];
    for (const [nx, ny] of nb) {
      enqueue(nx, ny, 30);
    }
  }

  // Transparenz setzen
  for (let i = 0; i < width * height; i++) {
    if (visited[i]) raw[i * 4 + 3] = 0;
  }

  return sharp(raw, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

/* -------------------------------------------------------
   GENERISCHE FUNKTION:
   Artwork auf Mockup platzieren
------------------------------------------------------- */
async function makePreview(artUrl, mockupUrl, scale, offsetX, offsetY) {
  // Artwork laden
  const a = await fetch(artUrl);
  const ab = Buffer.from(await a.arrayBuffer());

  // Transparenz erzeugen
  let artTransparent;
  try {
    artTransparent = await removeBackgroundFloodFill(ab);
  } catch {
    artTransparent = await sharp(ab).ensureAlpha().png().toBuffer();
  }

  // Mockup laden
  const m = await fetch(mockupUrl);
  const mb = Buffer.from(await m.arrayBuffer());

  const mSharp = sharp(mb);
  const meta = await mSharp.metadata();

  // Artwork skalieren
  const scaled = await sharp(artTransparent)
    .resize(Math.round(meta.width * scale), null, { fit: "inside" })
    .png()
    .toBuffer();

  // Auf Mockup legen
  return mSharp
    .composite([{ input: scaled, left: meta.width * offsetX, top: meta.height * offsetY }])
    .png()
    .toBuffer();
}

/* -------------------------------------------------------
   ENDPOINT: Tragetasche
------------------------------------------------------- */
app.get("/tote-preview", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "url fehlt" });

  if (previewCache.has("TOTE_" + url)) {
    res.setHeader("Content-Type", "image/png");
    return res.send(previewCache.get("TOTE_" + url));
  }

  try {
    const result = await makePreview(
      url,
      TOTE_MOCKUP_URL,
      0.42, // Größe
      0.26, // X
      0.46 // Y
    );

    previewCache.set("TOTE_" + url, result);
    res.setHeader("Content-Type", "image/png");
    res.send(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler bei Tasche" });
  }
});

/* -------------------------------------------------------
   ENDPOINT: Tasse
------------------------------------------------------- */
app.get("/mug-preview", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "url fehlt" });

  if (previewCache.has("MUG_" + url)) {
    res.setHeader("Content-Type", "image/png");
    return res.send(previewCache.get("MUG_" + url));
  }

  try {
    const result = await makePreview(
      url,
      MUG_MOCKUP_URL,
      0.26, // kleiner für Tasse
      0.37,
      0.38
    );

    previewCache.set("MUG_" + url, result);
    res.setHeader("Content-Type", "image/png");
    res.send(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler bei Tasse" });
  }
});

// Start
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Server läuft auf Port " + PORT);
});
