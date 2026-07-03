import { copyFileSync, existsSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { join, basename, dirname } from "path";
import { randomUUID } from "crypto";

// Generate UUID v4
export function newDesignTimeId(): string {
  return randomUUID();
}

// Generate stripped instance ID
export function newInstanceId(prefix: string): string {
  const uuid = newDesignTimeId().replace(/-/g, "");
  return `${prefix}${uuid}`;
}

// Read Real Version from .lvp
export function getFileEntryVersion(lvpPath: string, key: string): string {
  try {
    if (existsSync(lvpPath)) {
      const data = JSON.parse(readFileSync(lvpPath, "utf-8"));
      if (data && data.fileEntryVersions && data.fileEntryVersions[key]) {
        return data.fileEntryVersions[key];
      }
    }
  } catch {}
  return "0.0.96"; // standard fallback
}

// Backup file alongside original
const backedUpFiles = new Set<string>();
export function backupFile(filePath: string): string | null {
  if (backedUpFiles.has(filePath)) return null;
  if (!existsSync(filePath)) return null;
  const dir = dirname(filePath);
  const base = basename(filePath);
  const ts = Date.now();
  const backupPath = join(dir, `${base}.bak-${ts}`);
  copyFileSync(filePath, backupPath);
  backedUpFiles.add(filePath);
  return backupPath;
}

// Resolve Text Reference: List:AliasName -> ID
export function resolveTextRef(projectDir: string, listName: string, aliasName: string): string | null {
  const locDir = join(projectDir, "Localization");
  if (!existsSync(locDir)) return null;
  try {
    const langs = readdirSync(locDir);
    for (const lang of langs) {
      const listFile = join(locDir, lang, `${listName}.json`);
      if (existsSync(listFile)) {
        const content = readFileSync(listFile, "utf-8");
        const data = JSON.parse(content);
        if (data && Array.isArray(data.texts)) {
          const item = data.texts.find((t: any) => t.aliasName === aliasName);
          if (item && item.id) return item.id;
        }
      }
    }
  } catch {}
  return null;
}

// Resolve Schemes/StateSchemes: Group:Scheme -> designTimeId
export function resolveSchemeRef(projectDir: string, schemeType: string, schemeName: string): string | null {
  const dir = join(projectDir, "Schemes", schemeType);
  if (!existsSync(dir)) return null;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const content = readFileSync(join(dir, f), "utf-8");
      const data = JSON.parse(content);
      if (data && Array.isArray(data.schemes)) {
        const s = data.schemes.find((x: any) => x.name === schemeName);
        if (s && s.designTimeId) return s.designTimeId;
      }
    }
  } catch {}
  return null;
}

// Resolve Color Reference: Palette:ColorName -> ID
export function resolveColorRef(projectDir: string, colorVal: string): string | null {
  if (!colorVal.includes(":")) return null;
  const [palette, name] = colorVal.split(":");
  const path = join(projectDir, "Resources", `${palette}.colors`);
  if (existsSync(path)) {
    try {
      const content = readFileSync(path, "utf-8");
      const data = JSON.parse(content);
      if (data && Array.isArray(data.colors)) {
        const c = data.colors.find((x: any) => x.name === name);
        if (c && c.id) return c.id;
      }
    } catch {}
  }
  return null;
}

// Resolve Font Reference: FontStyleName -> designTimeId
export function resolveFontRef(projectDir: string, fontName: string): string | null {
  const path = join(projectDir, "FontStyles", "FontStyles.json");
  if (existsSync(path)) {
    try {
      const content = readFileSync(path, "utf-8");
      const data = JSON.parse(content);
      if (data && Array.isArray(data.fontStyles)) {
        const f = data.fontStyles.find((x: any) => x.name === fontName);
        if (f && f.designTimeId) return f.designTimeId;
      }
    } catch {}
  }
  return null;
}

// Resolve StyleClass Reference: StyleClassName -> designTimeId
export function resolveStyleClassRef(projectDir: string, className: string): string | null {
  const path = join(projectDir, "DefaultStyles", "DefaultStyles.json");
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf-8");
    const data = JSON.parse(content);
    if (data && Array.isArray(data.componentStyles)) {
      const findInNode = (node: any): string | null => {
        if (node.name === className && node.designTimeId) return node.designTimeId;
        if (Array.isArray(node.children)) {
          for (const child of node.children) {
            const res = findInNode(child);
            if (res) return res;
          }
        }
        return null;
      };
      for (const style of data.componentStyles) {
        const res = findInNode(style);
        if (res) return res;
      }
    }
  } catch {}
  return null;
}

// Resolve Template Reference: templateName -> designTimeId
export function resolveTemplateRef(projectDir: string, templateName: string): string | null {
  const path = join(projectDir, "ControlTemplate", `${templateName}.json`);
  if (existsSync(path)) {
    try {
      const content = readFileSync(path, "utf-8");
      const data = JSON.parse(content);
      if (data && data.designTimeId) return data.designTimeId;
    } catch {}
  }
  return null;
}

// Resolve Media Reference: mediaPath -> ID
export function resolveMediaRef(projectDir: string, mediaPath: string): string | null {
  const filename = basename(mediaPath.replace(/\\/g, "/"));
  const resDir = join(projectDir, "Resources");
  if (!existsSync(resDir)) return null;
  try {
    for (const sub of readdirSync(resDir)) {
      const subPath = join(resDir, sub);
      if (existsSync(subPath)) {
        for (const file of readdirSync(subPath)) {
          if (file.endsWith("Collection.json")) {
            const content = readFileSync(join(subPath, file), "utf-8");
            const data = JSON.parse(content);
            if (data && Array.isArray(data.mediaItems)) {
              const item = data.mediaItems.find((x: any) => x.name === filename);
              if (item && item.id) return item.id;
            }
          }
        }
      }
    }
  } catch {}
  return null;
}

// Tab indented JSON output
export function writeTabIndentedJson(filePath: string, data: any): void {
  const content = JSON.stringify(data, null, "\t");
  writeFileSync(filePath, content, "utf-8");
}
