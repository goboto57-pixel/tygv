import archiver from "archiver";
import { PassThrough } from "stream";

/**
 * Deploys a CodeForge project (array of { path, content }) to Netlify as a
 * static site, using the account whose Personal Access Token lives in
 * NETLIFY_TOKEN. The user never sees or supplies a token — this always
 * deploys under our own Netlify account.
 *
 * Flow (Netlify's documented zip-deploy path):
 *   1. Zip the project's files in memory.
 *   2. POST the zip to /api/v1/sites (new site) or
 *      /api/v1/sites/:site_id/deploys (redeploy of an existing site),
 *      Content-Type: application/zip.
 *   3. Netlify returns a deploy record with `.url`/`.ssl_url` and a
 *      `site_id` we persist so the *next* deploy for this chat updates the
 *      same site instead of creating a new one each time.
 *
 * No dependency beyond `archiver`, which the project already uses for
 * project export.
 */

const NETLIFY_API = "https://api.netlify.com/api/v1";

function getToken() {
  // Accept the documented Netlify CLI env var name too — "access denied"
  // reports usually turn out to be either (a) the token was set under
  // NETLIFY_AUTH_TOKEN (Netlify's own CLI convention) while this code only
  // looked for NETLIFY_TOKEN, so an old/placeholder value or nothing was
  // used, or (b) the value has a trailing newline/space from being pasted
  // into a hosting panel's env var UI, which silently breaks the
  // "Authorization: Bearer <token>" header.
  const raw = process.env.NETLIFY_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
  const token = raw ? raw.trim() : "";
  if (!token) {
    const err = new Error("Хостинг не настроен: отсутствует NETLIFY_TOKEN (или NETLIFY_AUTH_TOKEN) на сервере.");
    err.code = "NO_TOKEN";
    throw err;
  }
  return token;
}

/**
 * Builds a zip buffer from the in-memory file list. Netlify's zip deploy
 * expects the files at the root of the archive (no wrapping folder) — an
 * index.html at the zip root becomes the site's homepage.
 */
function buildZipBuffer(files) {
  return new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const stream = new PassThrough();
    const chunks = [];

    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
    archive.on("warning", (warn) => {
      // Netlify's zip format doesn't care about archiver's stat warnings for
      // in-memory entries — only reject on real errors.
      if (warn.code !== "ENOENT") reject(warn);
    });

    archive.pipe(stream);
    for (const f of files) {
      if (!f?.path) continue;
      archive.append(f.content ?? "", { name: f.path.replace(/^\/+/, "") });
    }
    archive.finalize();
  });
}

/**
 * Ensures the project has something to actually serve. Agent output is
 * always static HTML/CSS/JS per the system prompt, so a missing index.html
 * at the root is a real problem worth catching before we burn a Netlify
 * deploy on a site nobody can open.
 */
function assertDeployable(files) {
  const hasIndex = files.some((f) => /(^|\/)index\.html$/i.test(f.path));
  if (!hasIndex) {
    const err = new Error("В проекте нет index.html — нечего деплоить как сайт.");
    err.code = "NO_INDEX";
    throw err;
  }
}

async function netlifyRequest(pathSuffix, { method = "GET", body, isZip = false } = {}) {
  const token = getToken();
  const res = await fetch(`${NETLIFY_API}${pathSuffix}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": isZip ? "application/zip" : "application/json"
    },
    body: isZip ? body : body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    // Surface Netlify's actual reason (invalid/expired token, wrong scope,
    // site not found, etc) instead of a generic message — "access denied"
    // with no detail is what made this hard to diagnose in the first place.
    const detail = json?.message || json?.error || json?.raw;
    const hint = res.status === 401 ? " (токен недействителен/просрочен, либо неверно назван env var)"
      : res.status === 403 ? " (у токена нет прав на это действие — проверьте его scope в Netlify)"
      : "";
    const err = new Error(`Netlify API error (${res.status})${detail ? `: ${detail}` : ""}${hint}`);
    err.status = res.status;
    err.details = json;
    throw err;
  }
  return json;
}

/**
 * Deploys `files` to Netlify. If `existingSiteId` is provided, redeploys to
 * that same site (so the URL stays stable across iterations of one chat);
 * otherwise creates a brand-new site with a generated name.
 *
 * Returns { siteId, url, deployId, createdNew }.
 */
export async function deployToNetlify({ files, existingSiteId, siteNameHint }) {
  assertDeployable(files);
  const zipBuffer = await buildZipBuffer(files);

  if (existingSiteId) {
    try {
      const deploy = await netlifyRequest(`/sites/${existingSiteId}/deploys`, {
        method: "POST",
        body: zipBuffer,
        isZip: true
      });
      return {
        siteId: existingSiteId,
        url: deploy.ssl_url || deploy.url,
        deployId: deploy.id,
        createdNew: false
      };
    } catch (err) {
      // Site may have been deleted on Netlify's side out-of-band — fall
      // through and create a fresh one rather than failing the whole deploy.
      if (err.status !== 404) throw err;
    }
  }

  const slug = (siteNameHint || "codeforge-site")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "codeforge-site";
  const uniqueName = `${slug}-${Date.now().toString(36)}`;

  const site = await netlifyRequest("/sites", {
    method: "POST",
    body: { name: uniqueName }
  });

  const deploy = await netlifyRequest(`/sites/${site.id}/deploys`, {
    method: "POST",
    body: zipBuffer,
    isZip: true
  });

  return {
    siteId: site.id,
    url: deploy.ssl_url || deploy.url || site.ssl_url || site.url,
    deployId: deploy.id,
    createdNew: true
  };
}

export async function getDeployStatus(deployId) {
  return netlifyRequest(`/deploys/${deployId}`);
}

/**
 * Permanently deletes a site from Netlify (and therefore its live URL).
 * Used by the "снять с публикации" action once a user no longer wants a
 * project reachable online.
 */
export async function deleteNetlifySite(siteId) {
  await netlifyRequest(`/sites/${siteId}`, { method: "DELETE" });
  return { deleted: true };
}
