// index.js
import express from "express";
import fetch from "node-fetch";
import sharp from "sharp";

const app = express();

// Tragetaschen-Mockup (Hintergrund)
const TOTE_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/Tragetasche_Mockup.jpg?v=1763713012";

// Sehr einfacher In-Memory-Cache: artworkUrl -> fertige PNG-Vorschau
const previewCache = new Map();

/**
 * Heuristik:
 * Prüft, ob der Rand des Bildes überwiegend „fast weiß & entsättigt“ ist.
 * Wenn ja -> wir behandeln das als Motiv auf weißem Hintergrund
 * (z.B. Kissen-Design) und entfernen den Hintergrund.
 * Wenn nein -> vollflächiges Design (Poster/Fußmatte) -> nichts entfernen.
 */
async function shouldRemoveBackground(buffer) {
  const { data, info } = await sharp(buffer)
    .removeAlpha()
    .resize(64, 64, { fit: "fill" }) // stark verkleinert für schnelle Analyse
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;

  let borderPixels = 0;
  let whiteishBorderPixels = 0;

  const isBorder = (x, y) =>
    x === 0 || y === 0 || x === width - 1 || y === height - 1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isBorder(x, y)) continue;
      borderPixels++;

      const idx = (y * width + x) * channels;
      const r = data[idx] / 255;
      const g = data[idx + 1] / 255;
      const b = data[idx + 2] / 255;

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const brightness = max;
      const saturation = max === 0 ? 0 : (max - min) / max;

      // "fast weiß & entsättigt"
      const isWhiteish = brightness > 0.97 && saturation < 0.1;
      if (isWhiteish) whiteishBorderPixels++;
    }
  }

  const ratio = whiteishBorderPixels / borderPixels;
  // Wenn > 85% des Randes "weißlich" sind -> Hintergrundkandidat
  return ratio > 0.85;
}

/**
 * Entfernt "fast weiße" Pixel (Rand-Hintergrund) und macht sie transparent.
 * Die eigentlichen Motiv-Pixel (auch weiße Bereiche im Motiv) bleiben,
 * solange sie nicht super nahe an reinem Weiß sind.
 */
async function removeWhiteBackground(buffer) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const out = Buffer.alloc(data.length);

  const whiteThreshold = 245; // 0-255: je höher, desto weniger wird weggeknallt

  for (let i = 0; i < width * height; i++) {
    const idx = i * channels;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    const a = data[idx + 3];

    const isAlmostWhite =
      r >= whiteThreshold && g >= whiteThreshold && b >= whiteThreshold;

    if (isAlmostWhite) {
      // Hintergrund -> transparent
      out[idx] = r;
      out[idx + 1] = g;
      out[idx + 2] = b;
      out[idx + 3] = 0;
    } else {
      // Motiv unverändert übernehmen
      out[idx] = r;
      out[idx + 1] = g;
      out[idx + 2] = b;
      out[idx + 3] = a;
    }
  }

  return sharp(out, {
    raw: { width, height, channels },
  })
    .png()
    .toBuffer();
}

// Healthcheck
app.get("/", (_req, res) => {
  res.send("teeinblue-artwork-resizer (sharp-only) läuft.");
});

/**
 * GET /tote-preview?url=<URL_DES_ARTWORKS_AUS__customization_image>
 *
 * Ablauf:
 * 1. Artwork laden
 * 2. Entscheiden, ob der Hintergrund entfernt werden soll (nur bei "floating" Designs).
 * 3. Artwork ggf. freistellen.
 * 4. Artwork auf Tragetaschen-Mockup platzieren.
 * 5. Fertige Vorschau als PNG zurückgeben.
 */
app.get("/tote-preview", async (req, res) => {
  const artworkUrl = req.query.url;

  if (!artworkUrl || typeof artworkUrl !== "string") {
    return res
      .status(400)
      .json({ error: "Parameter 'url' fehlt oder ist ungültig." });
  }

  // Cache-Hit?
  if (previewCache.has(artworkUrl)) {
    const cached = previewCache.get(artworkUrl);
    res.setHeader("Content-Type", "image/png");
    return res.send(cached);
  }

  try {
    // 1. Artwork laden
    const artResp = await fetch(artworkUrl);
    if (!artResp.ok) {
      return res.status(400).json({
        error: "Konnte Artwork nicht laden.",
        detail: `HTTP ${artResp.status}`,
      });
    }
    const artArrayBuf = await artResp.arrayBuffer();
    let artBuffer = Buffer.from(artArrayBuf);

    // 2. Entscheiden, ob Hintergrund entfernt werden soll
    let needsBgRemoval = false;
    try {
      needsBgRemoval = await shouldRemoveBackground(artBuffer);
    } catch (e) {
      console.warn("Konnte shouldRemoveBackground nicht ausführen:", e);
    }

    // 3. Hintergrund ggf. entfernen
    if (needsBgRemoval) {
      artBuffer = await removeWhiteBackground(artBuffer);
    } else {
      // Sicherstellen, dass wir PNG mit Alpha haben
      artBuffer = await sharp(artBuffer).ensureAlpha().png().toBuffer();
    }

    // 4. Tragetaschen-Mockup laden
    const toteResp = await fetch(TOTE_MOCKUP_URL);
    if (!toteResp.ok) {
      return res.status(500).json({
        error: "Konnte Tragetaschen-Mockup nicht laden.",
        detail: `HTTP ${toteResp.status}`,
      });
    }
    const toteArrayBuf = await toteResp.arrayBuffer();
    const toteBuffer = Buffer.from(toteArrayBuf);

    const toteSharp = sharp(toteBuffer);
    const toteMeta = await toteSharp.metadata();

    if (!toteMeta.width || !toteMeta.height) {
      return res
        .status(500)
        .json({ error: "Konnte Größe des Tragetaschen-Mockups nicht lesen." });
    }

    // Artwork skalieren (Breite ~45% der Tasche)
    const designOnToteBuffer = await sharp(artBuffer)
      .resize(Math.round(toteMeta.width * 0.45), null, {
        fit: "inside",
        fastShrinkOnLoad: true,
      })
      .png()
      .toBuffer();

    // Position auf der Tasche (wie vorher leicht nach links/unten)
    const offsetLeft = Math.round(toteMeta.width * 0.26);
    const offsetTop = Math.round(toteMeta.height * 0.36);

    const finalBuffer = await toteSharp
      .composite([
        {
          input: designOnToteBuffer,
          left: offsetLeft,
          top: offsetTop,
        },
      ])
      .png()
      .toBuffer();

    // 5. In Cache legen & zurückgeben
    previewCache.set(artworkUrl, finalBuffer);

    res.setHeader("Content-Type", "image/png");
    res.send(finalBuffer);
  } catch (err) {
    console.error("Fehler in /tote-preview:", err);
    return res.status(500).json({
      error: "Interner Fehler in /tote-preview",
      detail: err.message || String(err),
    });
  }
});

// Server starten
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
