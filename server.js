// ClipStudio IA : serveur complet (Node 18+)
// Sert la page, reçoit photo/audio, génère chaque scène, puis monte le clip final.
require("dotenv").config();
const express = require("express"), cors = require("cors");
const fs = require("fs"), path = require("path");
const { execFile } = require("child_process"), { promisify } = require("util");
const run = promisify(execFile);
const FF = require("ffmpeg-static");

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "40mb" }));
const UP = path.join(__dirname, "uploads");
fs.mkdirSync(UP, { recursive: true });
app.use("/files", express.static(UP));
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "index.html")));

const API = "https://api.picsart.com/workflows/v1/models";
const KEY = process.env.PICSART_API_KEY;
const VIDEO_MODEL = process.env.VIDEO_MODEL; // modèle « plan cinématique » du catalogue
const hdr = () => ({ Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => Math.random().toString(36).slice(2, 10);
const base = (req) => `${req.protocol}://${req.get("host")}`;
const safe = (n) => /^[\w-]+\.\w+$/.test(n || "");

async function submit(model, params) {
  const r = await fetch(`${API}/submit`, { method: "POST", headers: hdr(), body: JSON.stringify({ params: { model, params } }) });
  if (!r.ok) throw new Error(`Soumission refusée (${r.status})`);
  const j = await r.json();
  return j.taskId || j.id || j.response?.taskId;
}
async function poll(id) {
  for (let i = 0; i < 90; i++) {
    await wait(4000);
    const j = await (await fetch(`${API}/${id}/result`, { headers: hdr() })).json();
    const st = j.response?.status || j.status;
    if (st === "COMPLETED") return j;
    if (st === "FAILED") throw new Error("La génération a échoué");
  }
  throw new Error("Délai dépassé");
}
function findUrl(o) {
  if (!o || typeof o !== "object") return null;
  if (typeof o.url === "string" && o.url.startsWith("http")) return o.url;
  for (const v of Object.values(o)) { const u = findUrl(v); if (u) return u; }
  return null;
}

app.get("/api/ping", (_, res) => res.json({ ok: true }));

app.post("/api/upload", (req, res) => {
  const m = /^data:([\w/+.-]+)(?:;[^,]*)?;base64,(.*)$/s.exec(req.body.data || "");
  if (!m) return res.status(400).json({ ok: false, error: "Fichier invalide" });
  const ext = m[1].split("/")[1].replace("mpeg", "mp3").replace(/\W/g, "") || "bin";
  const id = `${m[1].startsWith("audio") ? "audio" : "photo"}-${rid()}.${ext}`;
  fs.writeFileSync(path.join(UP, id), Buffer.from(m[2], "base64"));
  res.json({ ok: true, id, url: `${base(req)}/files/${id}` });
});

app.post("/api/generate", async (req, res) => {
  try {
    if (!KEY) throw new Error("PICSART_API_KEY manquante dans .env");
    const { type, prompt, style, format, imageUrl, audioId } = req.body;
    const start = Number(req.body.start) || 0, end = Number(req.body.end) || 10;
    const p = `${prompt || ""}. Style : ${style}. Format ${format}.`;
    let model, params;
    if (type === "Gros plan chanté") {
      if (!imageUrl || !safe(audioId)) throw new Error("Ajoutez d’abord une photo et un audio");
      let audioUrl = `${base(req)}/files/${audioId}`;
      const seg = `seg-${rid()}.mp3`;
      try { // découpe l'extrait audio de cette scène
        await run(FF, ["-y", "-ss", String(start), "-to", String(end), "-i", path.join(UP, audioId), "-c:a", "libmp3lame", path.join(UP, seg)]);
        audioUrl = `${base(req)}/files/${seg}`;
      } catch { console.warn("Découpe audio impossible, audio complet utilisé"); }
      model = "kling-avatar";
      params = { prompt: p, imageUrls: [imageUrl], audioUrl };
    } else {
      if (!VIDEO_MODEL) throw new Error("VIDEO_MODEL manquant dans .env");
      model = VIDEO_MODEL;
      params = { prompt: p, imageUrls: imageUrl ? [imageUrl] : undefined };
    }
    const result = await poll(await submit(model, params));
    const videoUrl = findUrl(result);
    if (!videoUrl) throw new Error("Aucune vidéo dans la réponse");
    res.json({ ok: true, videoUrl });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: e.message }); }
});

app.post("/api/assemble", async (req, res) => {
  try {
    const { videos = [], audioId, format = "16:9" } = req.body;
    if (!videos.length || !videos.every((v) => String(v).startsWith("https://"))) throw new Error("Aucune vidéo valide");
    const [w, h] = { "16:9": [1280, 720], "9:16": [720, 1280], "1:1": [1024, 1024] }[format] || [1280, 720];
    const id = rid(), parts = [];
    for (let i = 0; i < videos.length; i++) {
      const raw = path.join(UP, `r-${id}-${i}.mp4`), norm = path.join(UP, `n-${id}-${i}.mp4`);
      fs.writeFileSync(raw, Buffer.from(await (await fetch(videos[i])).arrayBuffer()));
      await run(FF, ["-y", "-i", raw, "-an", "-vf", `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:-1:-1,setsar=1,fps=30`, "-c:v", "libx264", "-pix_fmt", "yuv420p", norm]);
      parts.push(norm);
    }
    const list = path.join(UP, `l-${id}.txt`), out = `clip-${id}.mp4`;
    fs.writeFileSync(list, parts.map((q) => `file '${q}'`).join("\n"));
    const args = ["-y", "-f", "concat", "-safe", "0", "-i", list];
    if (safe(audioId)) args.push("-i", path.join(UP, audioId), "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-shortest");
    args.push("-c:v", "copy", path.join(UP, out));
    await run(FF, args);
    res.json({ ok: true, url: `${base(req)}/files/${out}` });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: e.message }); }
});

app.listen(process.env.PORT || 3000, () => console.log("ClipStudio prêt ✅"));
