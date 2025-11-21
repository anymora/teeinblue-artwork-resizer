// index.js
import express from "express";
import fetch from "node-fetch";
import OpenAI, { toFile } from "openai";

const app = express();
const port = process.env.PORT || 8080;

// OpenAI-Client
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Dein Tragetaschen-Mockup (Hintergrundbild)
const TOTE_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/Tragetasche_Mockup.jpg?v=1763713012";

/**
 * Hilfsfunktion: Remote-Bild laden und in ein File für OpenAI konvertieren
 */
async function fetchAsFile(url, fileName) {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Bild konnte nicht geladen werden: ${url} (Status ${resp.status})`);
  }
  const arrayBuffer = await resp.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // toFile macht daraus ein gültiges "FileLike" Objekt
  // WICHTIG: keine zusätzlichen Felder wie "name" oder "data" selbst bauen
  const file = await toFile(buffer, fileName, {
    type: "image/jpeg" // Shopify-Mockups sind i.d.R. JPG
  });

  return file;
}

/**
 * GET /tote-preview?url=<URL_ZUM_KISSEN_MOCKUP>
 *
 * 1. Holt das personalisierte Kissen-Mockup (Teeinblue _customization_image)
 * 2. Holt das Tragetaschen-Mockup
 * 3. Schickt beides an gpt-image-1 mit Prompt:
 *    - Design vom Kissen extrahieren
 *    - Auf die Tragetasche legen
 * 4. Gibt eine Image-URL von OpenAI zurück
 */
app.get("/tote-preview", async (req, res) => {
  const sourceUrl = req.query.url;

  if (!sourceUrl) {
    return res
      .status(400)
      .json({ error: "Fehlender Parameter ?url=<LINK_ZUM_KISSEN_MOCKUP>" });
  }

  try {
    console.log("Starte /tote-preview mit URL:", sourceUrl);

    // 1) Kissen-Mockup als File
    const cushionFile = await fetchAsFile(sourceUrl, "cushion-mockup.jpg");

    // 2) Tragetaschen-Mockup als File
    const toteFile = await fetchAsFile(TOTE_MOCKUP_URL, "tote-mockup.jpg");

    // 3) Beide Bilder an gpt-image-1 schicken
    //    image[0] = Kissen (Quelle des Designs)
    //    image[1] = Tragetasche (Ziel-Mockup)
    const result = await client.images.edit({
      model: "gpt-image-1",
      image: [cushionFile, toteFile],
      prompt:
        "Im ersten Bild ist ein personalisiertes Design auf einem Kissen zu sehen. " +
        "Extrahiere EXAKT dieses komplette Design (inklusive Text, Farben, Schlagschatten usw.) " +
        "transparent aus dem Kissen und platziere es perspektivisch korrekt und gut lesbar " +
        "auf dem zweiten Bild auf der beigen Tragetasche in der Mitte. " +
        "Hintergrund und Umgebung des zweiten Bildes (Holz, Wand, Haken, Blumen) bleiben erhalten. " +
        "Nichts am Design verändern, nur sauber vom Kissen lösen und auf die Tragetasche legen.",
      // Optional kannst du size/quality anpassen
      size: "1024x1024"
    });

    if (!result || !result.data || !result.data[0] || !result.data[0].url) {
      console.error("OpenAI Images-Antwort unerwartet:", result);
      return res.status(500).json({
        error: "OpenAI Images Antwort ohne URL zurückgegeben"
      });
    }

    const imageUrl = result.data[0].url;

    // 4) Einfach als JSON zurückgeben
    res.json({ url: imageUrl });
  } catch (err) {
    console.error("Fehler in /tote-preview:", err);
    res.status(500).json({
      error: "Interner Fehler in /tote-preview",
      detail: String(err.message || err)
    });
  }
});

// Healthcheck
app.get("/", (_req, res) => {
  res.send("teeinblue-artwork-resizer läuft.");
});

app.listen(port, () => {
  console.log(`Server läuft auf Port ${port}`);
});
