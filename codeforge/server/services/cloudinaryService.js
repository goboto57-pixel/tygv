import { v2 as cloudinary } from "cloudinary";
import { v4 as uuid } from "uuid";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

const FOLDER_PROJECTS = "codeforge/projects";
const FOLDER_CHATS = "codeforge/chats";
const FOLDER_UPLOADS = "codeforge/uploads";
const FOLDER_SNAPSHOTS = "codeforge/snapshots";

function jsonToBase64(obj) {
  const json = JSON.stringify(obj);
  return `data:application/json;base64,${Buffer.from(json).toString("base64")}`;
}

/** Uploads any raw file buffer (used for user-uploaded project files) */
export async function uploadRawFile(buffer, originalName, folder = FOLDER_UPLOADS) {
  const publicId = `${folder}/${uuid()}-${originalName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const result = await cloudinary.uploader.upload(
    `data:application/octet-stream;base64,${buffer.toString("base64")}`,
    {
      public_id: publicId,
      resource_type: "raw",
      overwrite: true
    }
  );
  return { url: result.secure_url, publicId: result.public_id };
}

/** Saves a JSON document (chat history, project file tree, snapshot) as a raw asset */
export async function saveJson(id, data, kind = "chat") {
  const folder =
    kind === "project" ? FOLDER_PROJECTS : kind === "snapshot" ? FOLDER_SNAPSHOTS : FOLDER_CHATS;
  const publicId = `${folder}/${id}`;
  const result = await cloudinary.uploader.upload(jsonToBase64(data), {
    public_id: publicId,
    resource_type: "raw",
    overwrite: true
  });
  return { url: result.secure_url, publicId: result.public_id };
}

/** Fetches a JSON document previously saved via saveJson */
export async function loadJson(id, kind = "chat") {
  const folder =
    kind === "project" ? FOLDER_PROJECTS : kind === "snapshot" ? FOLDER_SNAPSHOTS : FOLDER_CHATS;
  const publicId = `${folder}/${id}`;
  const url = cloudinary.url(publicId, { resource_type: "raw", secure: true });
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

/** Lists resources of a given kind (for chat/project history sidebar) */
export async function listJson(kind = "chat", maxResults = 100) {
  const folder =
    kind === "project" ? FOLDER_PROJECTS : kind === "snapshot" ? FOLDER_SNAPSHOTS : FOLDER_CHATS;
  const result = await cloudinary.api.resources({
    type: "upload",
    resource_type: "raw",
    prefix: `${folder}/`,
    max_results: maxResults
  });
  return result.resources || [];
}

export async function deleteJson(id, kind = "chat") {
  const folder =
    kind === "project" ? FOLDER_PROJECTS : kind === "snapshot" ? FOLDER_SNAPSHOTS : FOLDER_CHATS;
  const publicId = `${folder}/${id}`;
  await cloudinary.uploader.destroy(publicId, { resource_type: "raw" });
}

export { cloudinary };
