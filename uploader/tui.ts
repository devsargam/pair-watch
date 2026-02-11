import path from "path";
import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { parseIndexList } from "./utils";

export async function selectFiles(files: string[], baseDir: string) {
  if (!process.stdin.isTTY) return files;

  console.log("Select which files to upload:");
  console.log("  1) All files");
  console.log("  2) Choose by folder (top-level)");
  console.log("  3) Choose by file");

  const rl = readline.createInterface({ input, output });
  try {
    const choice = (await rl.question("Choice [1/2/3]: ")).trim();
    if (choice === "2") {
      const folders = Array.from(
        new Set(files.map((file) => path.relative(baseDir, file).split(path.sep)[0])),
      ).sort();
      if (!folders.length) return files;

      console.log("Select folders to upload:");
      folders.forEach((folder, index) => {
        const label = String(index + 1).padStart(2, " ");
        console.log(`${label}. ${folder}`);
      });
      console.log("Type numbers separated by commas (e.g. 1,3) or 'all'.");
      const answer = (await rl.question("Selection: ")).trim().toLowerCase();
      if (!answer || answer === "all") return files;
      const indexes = parseIndexList(answer, folders.length);
      const selectedFolders = new Set(indexes.map((idx) => folders[idx]));
      return files.filter((file) =>
        selectedFolders.has(path.relative(baseDir, file).split(path.sep)[0]),
      );
    }

    if (choice === "3") {
      const relative = files.map((file) => path.relative(baseDir, file));
      relative.forEach((file, index) => {
        const label = String(index + 1).padStart(2, " ");
        console.log(`${label}. ${file}`);
      });
      console.log(
        "Type numbers separated by commas (e.g. 1,3,4), ranges like 2-5, or 'all'.",
      );
      const answer = (await rl.question("Selection: ")).trim().toLowerCase();
      if (!answer || answer === "all") return files;
      const indexes = parseIndexList(answer, relative.length);
      return indexes.map((idx) => files[idx]);
    }

    return files;
  } finally {
    rl.close();
  }
}
