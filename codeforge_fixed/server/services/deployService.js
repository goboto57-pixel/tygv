/**
 * Deploys a CodeForge project (array of { path, content }) to Vercel as a
 * static site, using the account whose token lives in VERCEL_TOKEN. The
 * user never sees or supplies a token — this always deploys under our own
 * Vercel account.
 *
 * Replaces the previous Netlify integration, which reliably failed with
 * "не авторизован" (401/403) for one of two reasons that are both handled
 * explicitly here so the same class of failure can't silently repeat with
 * a different provider:
 *   1. Wrong/malformed env var — solved here by trimming defensively (a
 *      trailing newline/space pasted from a hosting panel silently breaks
 *      "Authorization: Bearer <token>").
 *   2. TEAM-SCOPED TOKENS: a Vercel Personal Access Token created "on
 *      behalf of" a team must send that team's id as a `teamId` query
 *      param on EVERY API call, or Vercel returns 403 "Not authorized" —
 *      even though the token itself is completely valid. This is the
 *      single most common cause of "authorized-looking token, deploy still
 *      says not authorized" reports for Vercel specifically. Handled via
 *      the optional VERCEL_TEAM_ID env var, appended automatically below.
 *
 * Flow (Vercel's documented inline-files deploy path — no zip needed,
 * unlike Netlify, which simplifies this considerably):
 *   1. POST file contents directly to POST /v13/deployments with
 *      target: "production" and a stable project `name` derived from the
 *      chat, so redeploying the same chat updates the same project/URL
 *      instead of creating a new one each time.
 *   2. Vercel returns a deployment record with `.url` (a live, working
 *      URL immediately, even before the build finishes) and `.id`.
 *   3. Poll GET /v13/deployments/:id for `.readyState` to know when the
 *      build actually finished (or failed).
 */

const VERCEL_API = "https://api.vercel.com";

function getToken() {
  const raw = process.env.VERCEL_TOKEN || process.env.VERCEL_API_TOKEN;
  const token = raw ? raw.trim() : "";
  if (!token) {
    const err = new Error("Хостинг не настроен: отсутствует VERCEL_TOKEN на сервере.");
    err.code = "NO_TOKEN";
    throw err;
  }
  return token;
}

// See the big comment at the top of this file: required for any token that
// was issued under a Vercel TEAM account rather than a personal account.
function getTeamId() {
  const raw = process.env.VERCEL_TEAM_ID || process.env.VERCEL_TEAM_SLUG;
  return raw ? raw.trim() : "";
}

/**
 * Ensures the project has something to actually serve. Agent output is
 * always static HTML/CSS/JS per the system prompt, so a missing index.html
 * at the root is a real problem worth catching before we burn a deploy on
 * a project nobody can open.
 */
function assertDeployable(files) {
  const hasIndex = files.some((f) => /(^|\/)index\.html$/i.test(f.path));
  if (!hasIndex) {
    const err = new Error("В проекте нет index.html — нечего деплоить как сайт.");
    err.code = "NO_INDEX";
    throw err;
  }
}

async function vercelRequest(pathSuffix, { method = "GET", body } = {}) {
  const token = getToken();
  const teamId = getTeamId();
  const url = new URL(`${VERCEL_API}${pathSuffix}`);
  if (teamId) url.searchParams.set("teamId", teamId);

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    // Surface Vercel's actual reason instead of a generic message —
    // "не авторизован" with no detail is exactly what made the previous
    // (Netlify) integration hard to diagnose.
    const detail = json?.error?.message || json?.message || json?.raw;
    const hint =
      res.status === 401
        ? " (токен недействителен/просрочен — проверьте VERCEL_TOKEN)"
        : res.status === 403
          ? " (частая причина: токен выпущен для Vercel-команды (team), а не личного аккаунта — задайте VERCEL_TEAM_ID на сервере; ID команды виден в Vercel → Team Settings → General)"
          : "";
    const err = new Error(`Vercel API error (${res.status})${detail ? `: ${detail}` : ""}${hint}`);
    err.status = res.status;
    err.details = json;
    throw err;
  }
  return json;
}

function slugify(name) {
  return (
    String(name || "codeforge-site")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "codeforge-site"
  );
}

/**
 * Deploys `files` to Vercel. `existingSiteId`, if provided, redeploys to
 * that same project (so the URL stays stable across iterations of one
 * chat) — Vercel attaches a new deployment to an existing project whenever
 * the `name` field matches one you already own, no separate "update" call
 * needed.
 *
 * Returns { siteId, url, deployId, createdNew }. `siteId` holds the Vercel
 * PROJECT NAME (used both as the redeploy key and for deletion) — kept
 * under this field name so the chat-record schema and the client didn't
 * need to change when swapping providers.
 */
export async function deployToVercel({ files, existingSiteId, siteNameHint }) {
  assertDeployable(files);

  const projectName = existingSiteId || `${slugify(siteNameHint)}-${Date.now().toString(36)}`;

  const deployFiles = files
    .map((f) => {
      const path = String(f?.path || "").replace(/\\/g, "/").replace(/^\/+/, "");
      return path ? { file: path, data: f?.content ?? "" } : null;
    })
    .filter(Boolean);

  const deploy = await vercelRequest("/v13/deployments", {
    method: "POST",
    body: {
      name: projectName,
      files: deployFiles,
      target: "production",
      // Plain static files — don't let Vercel try to auto-detect/run a
      // framework build step that isn't there.
      projectSettings: { framework: null }
    }
  });

  return {
    siteId: projectName,
    url: deploy.url ? `https://${deploy.url}` : null,
    deployId: deploy.id,
    createdNew: !existingSiteId
  };
}

export async function getDeployStatus(deployId) {
  const deploy = await vercelRequest(`/v13/deployments/${deployId}`);
  // Normalize Vercel's readyState to the state names the client already
  // understands (it only special-cases "ready"/"error"; anything else is
  // treated as "still going" and polled again).
  const state =
    deploy.readyState === "READY" ? "ready" :
    deploy.readyState === "ERROR" || deploy.readyState === "CANCELED" ? "error" :
    "processing";
  return { state, url: deploy.url ? `https://${deploy.url}` : null, id: deploy.id };
}

/**
 * Permanently deletes a project from Vercel (and therefore its live URL —
 * all its deployments and domains go with it). Used by the "снять с
 * публикации" action once a user no longer wants a project reachable
 * online. `siteId` here is the Vercel project name (see deployToVercel).
 */
export async function deleteVercelProject(siteId) {
  await vercelRequest(`/v10/projects/${encodeURIComponent(siteId)}`, { method: "DELETE" });
  return { deleted: true };
}
