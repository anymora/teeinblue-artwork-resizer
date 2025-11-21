import express from "express";
import fetch from "node-fetch";
import sharp from "sharp";
import OpenAI from "openai";

const app = express();

// ---------- KONFIG ----------

// OpenAI API-Key kommt aus Railway-Env: OPENAI_API_KEY
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Dein Tragetaschen-Mockup (ohne Design)
const TOTE_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/Tragetasche_Mockup.jpg?v=1763713012";

// Position und Größe des Designs auf der Tragetasche
// -> ggf. mit echten Werten feinjustieren
const TOTE_OVERLAY_CONFIG = {
  widthFactor: 0.40, // Bereich auf der Tasche relativ zur Breite
  leftFactor: 0.30,  // Position von links (0-1)
  topFactor: 0.35    // Position von oben (0-1)
};

// ---------- HILFSFUNKTIONEN ----------

async function fetchImageBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Bild-Download fehlgeschlagen: ${res.status} ${res.statusText}`);
  }
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

/**
 * Ruft OpenAI auf, um aus einem Produkt-Mockup-Bild das Design freizustellen.
 * Erwartung: Eingabe = JPG/PNG aus _customization_image
 * Ausgabe: Buffer (PNG mit transparentem Hintergrund)
 */
async function extractDesignWithOpenAI(mockupBuffer) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY ist nicht gesetzt.");
  }

  // OpenAI Images API: wir nutzen gpt-image-1 mit einer klaren Anweisung
  // Hinweis: OpenAI-Images-API liefert base64 PNG zurück.
  const base64Input = mockupBuffer.toString("base64");

  const response = await openai.images.generate({
    model: "gpt-image-1",
    prompt:
      "Extract only the printed design from this product mockup. " +
      "Return a PNG with transparent background, keeping the design's shape and proportions. " +
      "Do not add new elements, do not change colors, do not change text. " +
      "Just isolate the existing design on transparency.",
    // Wir nutzen image-to-image, indem wir das Originalbild als Referenz anhängen
    // (Die OpenAI Node-Lib akzeptiert base64 über 'image' im aktuellen SDK.)
    image: [
      {
        image: base64Input
      }
    ],
    size: "1024x1024",
    n: 1,
    response_format: "b64_json"
  });

  const b64 = response.data[0].b64_json;
  const designPngBuffer = Buffer.from(b64, "base64");
  return designPngBuffer;
}

/**
 * Nimmt freigestelltes Design (PNG) und legt es auf das Tragetaschen-Mockup.
 */
async function composeDesignOnTote(designBuffer) {
  const mockupBuffer = await fetchImageBuffer(TOTE_MOCKUP_URL);
  const mockup = sharp(mockupBuffer);
  const meta = await mockup.metadata();

  const mockW = meta.width || 2000;
  const mockH = meta.height || 2000;

  const targetW = Math.round(mockW * TOTE_OVERLAY_CONFIG.widthFactor);

  const resizedDesign = await sharp(designBuffer)
    .resize({
      width: targetW,
      height: null,
      fit: "inside"
    })
    .png()
    .toBuffer();

  const left = Math.round(mockW * TOTE_OVERLAY_CONFIG.leftFactor);
  const top = Math.round(mockH * TOTE_OVERLAY_CONFIG.topFactor);

  const composed = await sharp(mockupBuffer)
    .composite([
      {
        input: resizedDesign,
        left,
        top
      }
    ])
    .png()
    .toBuffer();

  return composed;
}

// ---------- ENDPOINTS ----------

/**
 * 1) Nur das extrahierte Design aus einem Mockup liefern
 *
 * GET /extract-design?url=<_customization_image URL>
 * -> gibt PNG des freigestellten Designs zurück (Content-Type: image/png)
 */
app.get("/extract-design", async (req, res) => {
  try {
    const srcUrl = req.query.url;
    if (!srcUrl) {
      return res.status(400).send("Missing ?url parameter");
    }

    const mockupBuffer = await fetchImageBuffer(srcUrl);
    const designBuffer = await extractDesignWithOpenAI(mockupBuffer);

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(designBuffer);
  } catch (err) {
    console.error("Error in /extract-design:", err);
    res.status(500).send("Internal server error");
  }
});

/**
 * 2) Vollständige Tragetaschen-Vorschau: KI-extrahiertes Design auf Tasche
 *
 * GET /tote-preview?url=<_customization_image URL>
 * -> gibt PNG der Tragetasche mit Design zurück (Content-Type: image/png)
 */
app.get("/tote-preview", async (req, res) => {
  try {
    const srcUrl = req.query.url;
    if (!srcUrl) {
      return res.status(400).send("Missing ?url parameter");
    }

    const mockupBuffer = await fetchImageBuffer(srcUrl);
    const designBuffer = await extractDesignWithOpenAI(mockupBuffer);
    const totePreviewBuffer = await composeDesignOnTote(designBuffer);

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(totePreviewBuffer);
  } catch (err) {
    console.error("Error in /tote-preview:", err);
    res.status(500).send("Internal server error");
  }
});

// Healthcheck
app.get("/", (_req, res) => {
  res.send("Teeinblue AI Artwork Backend läuft.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Artwork AI backend listening on port ${PORT}`);
});
