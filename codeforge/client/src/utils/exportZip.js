import JSZip from "jszip";
import { saveAs } from "file-saver";

export async function exportZip(files, projectName = "codeforge-project", notify) {
  if (!files || files.length === 0) {
    notify?.("Нет файлов для экспорта", "info");
    return;
  }
  try {
    const zip = new JSZip();
    files.forEach((f) => {
      if (!f.path) return;
      const safePath = String(f.path).replace(/^\/+/, "");
      if (!safePath) return;
      zip.file(safePath, f.content || "");
    });
    const blob = await zip.generateAsync({ type: "blob" });
    saveAs(blob, `${projectName}.zip`);
    notify?.(`Скачан ${projectName}.zip`, "success");
  } catch (e) {
    notify?.(`Ошибка экспорта: ${e.message}`, "error");
    throw e;
  }
}
