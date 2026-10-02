// Small HTTP helpers shared by the API routes.

// Send a JSON response with the given status code.
function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// Reads a request body as JSON. Resolves null if it is too large or not valid JSON; an empty body is {}.
function readJson(req, limit = 8192) {
  return new Promise((resolve) => {
    let raw = "";
    // Accumulate the body, but give up (and drop the connection) if it grows past the limit.
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > limit) {
        resolve(null);
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

module.exports = { json, readJson };
