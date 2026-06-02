import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const vaultArg = process.argv[2] ?? process.env.OBSIDIAN_VAULT;

if (!vaultArg) {
  console.error(
    "Usage: npm run deploy -- <path-to-obsidian-vault>\n" +
      "Or set OBSIDIAN_VAULT and run npm run deploy.",
  );
  process.exit(1);
}

const rootDir = process.cwd();
const vaultDir = path.resolve(vaultArg);
const obsidianDir = path.join(vaultDir, ".obsidian");

if (!existsSync(vaultDir) || !statSync(vaultDir).isDirectory()) {
  console.error(`Vault path does not exist or is not a directory: ${vaultDir}`);
  process.exit(1);
}

if (!existsSync(obsidianDir) || !statSync(obsidianDir).isDirectory()) {
  console.error(`Not an Obsidian vault; missing .obsidian folder: ${obsidianDir}`);
  process.exit(1);
}

const manifestPath = path.join(rootDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const pluginId = manifest.id;

if (!pluginId) {
  console.error("manifest.json is missing an id.");
  process.exit(1);
}

const pluginDir = path.join(obsidianDir, "plugins", pluginId);
mkdirSync(pluginDir, { recursive: true });

for (const fileName of ["main.js", "manifest.json", "styles.css"]) {
  const source = path.join(rootDir, fileName);
  if (!existsSync(source)) {
    console.error(`Missing build artifact: ${source}`);
    process.exit(1);
  }
  copyFileSync(source, path.join(pluginDir, fileName));
}

console.log(`Deployed ${manifest.name ?? pluginId} to ${pluginDir}`);
