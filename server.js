// MedDeck web server. It has three jobs:
//   1. Serve the static site from /public.
//   2. Hand the browser its public Supabase settings (/config.js) and the Supabase client library.
//   3. Expose the one API route that starts turning an uploaded file into flashcards.
// It deliberately uses only Node built-ins for HTTP; the npm packages are used for Supabase, Claude and PDFs.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

// Load secrets (Supabase keys, Anthropic key) from .env into process.env. `quiet` hides dotenv's startup tip.
require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });
const { handleProcess } = require("./lib/uploadRoute");

const PORT = process.env.PORT || 3000;
// Everything the browser may request as a plain file lives under /public.
const ROOT = path.join(__dirname, "public");
// The browser-ready build of supabase-js; served at /vendor/supabase.js so no CDN or bundler is needed.
const SUPABASE_BUNDLE = path.join(__dirname, "node_modules/@supabase/supabase-js/dist/umd/supabase.js");

// Only the public URL and anon key are exposed here; both are designed to be visible in the browser.
// The .env file uses VITE_-prefixed names, so both spellings are accepted.
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || "";

// File extension -> Content-Type header, so browsers treat each file correctly.
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

http
  .createServer((req, res) => {
    // Strip the query string / hash and decode %-escapes. A malformed escape is a client error.
    let urlPath;
    try {
      urlPath = decodeURIComponent(req.url.split(/[?#]/)[0]);
    } catch {
      res.writeHead(400).end("Bad request");
      return;
    }

    // API: POST /api/uploads/<uuid>/process starts card generation for one upload.
    // The handler is async, so any unexpected failure is turned into a 500 instead of crashing the server.
    const processMatch = req.method === "POST" && /^\/api\/uploads\/([0-9a-f-]{36})\/process$/.exec(urlPath);
    if (processMatch) {
      handleProcess(req, res, processMatch[1]).catch(() => {
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Something went wrong." }));
      });
      return;
    }

    // /config.js is generated on the fly: it sets window.MEDDECK_CONFIG for the browser scripts.
    // It is never cached so changes to .env show up after a server restart.
    if (urlPath === "/config.js") {
      const config = { supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY };
      res.writeHead(200, { "Content-Type": TYPES[".js"], "Cache-Control": "no-store" });
      res.end(`window.MEDDECK_CONFIG = ${JSON.stringify(config)};`);
      return;
    }

    // Everything else is a static file. The vendor bundle is the one file allowed outside /public.
    const isBundle = urlPath === "/vendor/supabase.js";
    const file = isBundle
      ? SUPABASE_BUNDLE
      : path.join(ROOT, urlPath.endsWith("/") ? urlPath + "index.html" : urlPath);

    // Path-traversal guard: a request like /../server.js must never resolve outside /public.
    if (!isBundle && !file.startsWith(ROOT + path.sep)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  })
  .listen(PORT, () => console.log(`MedDeck running at http://localhost:${PORT}`));
