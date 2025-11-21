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

// Tragetaschen-Mockup (ohne Design)
const TOTE_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/Tragetasche_Mockup.jpg?v=1763713012";

// Position und Größe des extrahierten Designs auf der Tragetasche
const TOTE_OVERLAY_CONFIG = {
  widthFactor: 0.55, // wie breit das Design auf der Tasche sein soll (relativ zur Mockup-Breite)
  leftFactor: 0.225, // horizontale Position (0–1) – feinjustierbar
  topFactor: 0.26   // vertikale Position (0–1) – feinjustierbar
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

  const base64Input = mockupBuffer.toString("base64");

  // WICHTIG:
  // Wir nutzen die neue Images-API mit gpt-image-1 und geben das Mockup als Bild-Input.
  // Prompt: Design extrahieren, transparent, NICHT verändern.
  const response = await openai.images.generate({
    model: "gpt-image-1",
    prompt:
      "Das Design befindet sich auf einem Produkt-Mockup. " +
      "Extrahiere exakt dieses Design inklusive aller Texte, Formen und Farben " +
      "aus dem Mockup und gib es als PNG mit komplett transparentem Hintergrund zurück. " +
      "Nichts hinzufügen, nichts weglassen, nichts neu zeichnen – nur das vorhandene Design freistellen.",
    size: "1024x1024",
    response_format: "b64_json",
    // Bild-Input
    image: [
      {
        image: base64Input
      }
    ]
  });

  const b64 = response.data[0].b64_json;
  const designPngBuffer = Buffer.from(b64, "base64");
  return designPngBuffer;
}

/**
 * Nimmt das freigestellte Design und legt es auf das Tragetaschen-Mockup.
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
 * Endpoint für komplette Tragetaschen-Vorschau:
 *
 * GET /tote-preview?url=<_customization_image URL>
 * -> gibt PNG der Tragetasche mit extrahiertem Design zurück
 */
app.get("/tote-preview", async (req, res) => {
  try {
    const srcUrl = req.query.url;
    if (!srcUrl) {
      return res.status(400).send("Missing ?url parameter");
    }

    // 1. Mockup (_customization_image) laden
    const mockupBuffer = await fetchImageBuffer(srcUrl);

    // 2. Design durch OpenAI extrahieren (transparentes PNG)
    const designBuffer = await extractDesignWithOpenAI(mockupBuffer);

    // 3. Design auf Tragetaschen-Mockup setzen
    const totePreviewBuffer = await composeDesignOnTote(designBuffer);

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(totePreviewBuffer);
  } catch (err) {
    console.error("Error in /tote-preview:", err);
    res.status(500).send("Internal server error");
  }
});

// Optional: Healthcheck
app.get("/", (_req, res) => {
  res.send("Teeinblue AI Artwork Backend läuft.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Artwork AI backend listening on port ${PORT}`);
});
