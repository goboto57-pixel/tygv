import JSZip from "jszip";
import { saveAs } from "file-saver";

export async function exportZip(files, projectName = "codeforge-project") {
  if (!files || files.length === 0) return;
  const zip = new JSZip();
  files.forEach((f) => {
    zip.file(f.path, f.content || "");
  });
  const blob = await zip.generateAsync({ type: "blob" });
  saveAs(blob, `${projectName}.zip`);
}
