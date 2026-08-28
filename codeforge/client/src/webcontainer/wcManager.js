// Thin wrapper around @webcontainer/api.
//
// WebContainer.boot() may only be called ONCE per page load (a second call
// throws), so we keep a single module-level instance/boot-promise and every
// component just awaits getContainer(). This also means the container
// survives switching away from the Preview tab and back — we don't want to
// pay the boot+install cost twice in one session.

let bootPromise = null;
let containerInstance = null;
let mountedOnce = false;

export function isWebContainerSupported() {
  return (
    typeof window !== "undefined" &&
    typeof SharedArrayBuffer !== "undefined" &&
    window.crossOriginIsolated === true
  );
}

export async function getContainer() {
  if (containerInstance) return containerInstance;
  if (!bootPromise) {
    const { WebContainer } = await import("@webcontainer/api");
    bootPromise = WebContainer.boot().catch((e) => {
      bootPromise = null;
      throw e;
    });
  }
  try {
    containerInstance = await bootPromise;
  } catch (e) {
    bootPromise = null;
    throw e;
  }
  return containerInstance;
}

// Converts our flat [{path, content}] array into the nested tree shape
// WebContainer.mount() expects: { dir: { directory: { file: { file: { contents } } } } }
export function filesToTree(files) {
  const root = {};
  for (const f of files) {
    if (typeof f.content !== "string") continue; // skip binary/URL-only attachments
    const parts = f.path.split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLeaf = i === parts.length - 1;
      if (isLeaf) {
        // if intermediate node already exists as directory, keep it but add file
        if (node[part] && node[part].directory && !node[part].file) {
          // conflict: path was previously a directory, now file - overwrite
        }
        node[part] = { file: { contents: f.content } };
      } else {
        if (node[part] && node[part].file) {
          // conflict: file exists where directory needed - convert to directory
          node[part] = { directory: {} };
        } else {
          node[part] = node[part] || { directory: {} };
        }
        node = node[part].directory;
      }
    }
  }
  return root;
}

function dirname(path) {
  if (!path || path === ".") return "";
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

// Writes a single changed/added file into an already-mounted container,
// creating any missing parent directories first. Cheap compared to a full
// re-mount, and lets dev-server HMR (Vite/Next/etc) pick the change up.
export async function syncFile(container, path, content) {
  const dir = dirname(path);
  if (dir) {
    try {
      await container.fs.mkdir(dir, { recursive: true });
    } catch {
      // directory already exists — fine
    }
  }
  await container.fs.writeFile(path, content);
}

export async function removeFile(container, path) {
  try {
    await container.fs.rm(path);
  } catch {
    // already gone / never existed — fine
  }
}

export function hasMountedBefore() {
  return mountedOnce;
}

export function markMounted() {
  mountedOnce = true;
}

// Reads a whitelisted subset of package.json to decide what command boots
// the dev server. Falls back through common script names in priority order.
export function pickDevScript(pkgJsonText) {
  try {
    const pkg = JSON.parse(pkgJsonText || "{}");
    const scripts = pkg.scripts || {};
    for (const name of ["dev", "start", "serve"]) {
      if (scripts[name]) return name;
    }
  } catch {
    // fall through
  }
  return null;
}
