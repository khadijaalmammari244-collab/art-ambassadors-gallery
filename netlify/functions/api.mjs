// API for the virtual gallery: visitors counter, visitor opinions, opening ceremony state.
import { getStore } from "@netlify/blobs";

const meta = () => getStore({ name: "gallery-meta", consistency: "strong" });
const visits = () => getStore({ name: "gallery-visits" });
const feedback = () => getStore({ name: "gallery-feedback", consistency: "strong" });

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

// small in-memory cache per function instance (keeps polling cheap)
let cache = { t: 0, visitors: 0, feedback: [] };

async function loadLists(force = false) {
  if (!force && Date.now() - cache.t < 15000) return cache;
  const vs = await visits().list();
  const fbStore = feedback();
  const { blobs } = await fbStore.list();
  const items = (await Promise.all(blobs.map((b) => fbStore.get(b.key, { type: "json" })))).filter(Boolean);
  items.sort((a, b) => (b.t || 0) - (a.t || 0));
  cache = { t: Date.now(), visitors: vs.blobs.length, feedback: items.slice(0, 300) };
  return cache;
}

async function getOpening() {
  return (await meta().get("opening", { type: "json" })) || { opened: false, at: 0 };
}

export default async (req) => {
  const path = new URL(req.url).pathname.replace(/^\/api\/?/, "");
  try {
    if (path === "state" && req.method === "GET") {
      const [opening, lists] = await Promise.all([getOpening(), loadLists()]);
      return json({ opening, visitors: lists.visitors, feedback: lists.feedback });
    }

    if (req.method !== "POST") return json({ error: "method" }, 405);
    const body = await req.json().catch(() => ({}));

    if (path === "visit") {
      if (!ID_RE.test(body.id || "")) return json({ error: "invalid_argument" }, 400);
      const { modified } = await visits().set(body.id, String(Date.now()), { onlyIfNew: true });
      if (modified) cache.t = 0;
      return json({ ok: true });
    }

    if (path === "feedback") {
      if (!ID_RE.test(body.id || "")) return json({ error: "invalid_argument" }, 400);
      const stars = Math.max(0, Math.min(5, parseInt(body.stars, 10) || 0));
      const text = clean(body.text, 500);
      const name = clean(body.name, 40);
      if (!stars && !text) return json({ error: "invalid_argument" }, 400);
      const item = { id: body.id, name, stars, text, t: Date.now() };
      await feedback().setJSON(body.id, item);
      cache.t = 0;
      return json({ ok: true });
    }

    if (path === "admin") {
      const expected = process.env.ADMIN_PASSWORD || "";
      if (!expected || body.password !== expected) return json({ error: "denied" }, 403);
      if (body.action === "check") return json({ ok: true });
      if (body.action === "open") { await meta().setJSON("opening", { opened: true, at: Date.now() }); return json({ ok: true }); }
      if (body.action === "close") { await meta().setJSON("opening", { opened: false, at: 0 }); return json({ ok: true }); }
      if (body.action === "delfb") {
        if (!ID_RE.test(body.id || "")) return json({ error: "invalid_argument" }, 400);
        await feedback().delete(body.id); cache.t = 0; return json({ ok: true });
      }
      return json({ error: "invalid_argument" }, 400);
    }

    return json({ error: "not_found" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: "unavailable" }, 500);
  }
};

export const config = { path: "/api/*" };
