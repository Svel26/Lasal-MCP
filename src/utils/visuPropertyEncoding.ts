import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  newDesignTimeId,
  resolveTextRef,
  resolveSchemeRef,
  resolveColorRef,
  resolveFontRef,
  resolveStyleClassRef,
  resolveTemplateRef,
  resolveMediaRef
} from "./visuDashboardIO.js";

// Clean JSON helper for manifests (strips comments & trailing commas)
export function cleanJson(content: string): string {
  content = content.replace(/\/\*[\s\S]*?\*\//g, "");
  content = content.replace(/^[ \t]*\/\/.*$/gm, "");
  content = content.replace(/,(\s*[\]}])/g, "$1");
  return content;
}

// Load control manifest, merging inherited properties
const manifestCache: Record<string, any> = {};
export function loadControlManifest(projectDir: string, controlId: string): any {
  if (manifestCache[controlId]) return manifestCache[controlId];

  const userPath = join(projectDir, "Runtime", "DesignerRuntime", "res", "components", "user", controlId, `${controlId}.json`);
  const sigmatekPath = join(projectDir, "Runtime", "DesignerRuntime", "res", "components", "sigmatek", controlId, `${controlId}.json`);

  let manifest: any = null;
  if (existsSync(userPath)) {
    manifest = JSON.parse(cleanJson(readFileSync(userPath, "utf-8")));
  } else if (existsSync(sigmatekPath)) {
    manifest = JSON.parse(cleanJson(readFileSync(sigmatekPath, "utf-8")));
  }

  if (!manifest) return null;

  // Resolve base Component properties recursively
  if (manifest.baseComponent && manifest.baseComponent !== controlId) {
    const parent = loadControlManifest(projectDir, manifest.baseComponent);
    if (parent && parent.properties) {
      const mergedProps = [...(parent.properties || [])];
      for (const prop of manifest.properties || []) {
        const idx = mergedProps.findIndex((p: any) => p.name === prop.name);
        if (idx >= 0) mergedProps[idx] = prop;
        else mergedProps.push(prop);
      }
      manifest.properties = mergedProps;
    }
  }

  manifestCache[controlId] = manifest;
  return manifest;
}

// Format UUID function block ID
export function resolveFunctionBlockRef(projectDir: string, fbName: string): string | null {
  const path = join(projectDir, "Functionblocks", `${fbName}.json`);
  if (existsSync(path)) {
    try {
      const data = JSON.parse(cleanJson(readFileSync(path, "utf-8")));
      if (data && data.id) {
        let idStr = data.id;
        if (idStr.startsWith("_")) {
          idStr = idStr.substring(1);
        }
        if (idStr.length === 32) {
          return `${idStr.substring(0, 8)}-${idStr.substring(8, 12)}-${idStr.substring(12, 16)}-${idStr.substring(16, 20)}-${idStr.substring(20)}`;
        }
        return idStr;
      }
    } catch {}
  }
  return null;
}

// Encode property based on manifest entry and sourceType
export function encodeProperty(
  projectDir: string,
  propName: string,
  manifestProp: any,
  sourceType: string,
  value: any
): { name: string; value: any; typeId: number; propTypeId: number; refId?: string; targetName?: string } {
  const propType = manifestProp ? (manifestProp.propertyType || "none") : "none";
  let typeId = 0;
  let propTypeId = 2;
  let refId: string | undefined;

  switch (sourceType) {
    case "constString":
    case "constNumber":
    case "constBool":
      if (propType === "css") {
        if (propName.startsWith("--theme-sig-element-")) {
          typeId = 17;
        } else {
          typeId = 0;
        }
        propTypeId = 2;
      } else if (propType === "rotation") {
        typeId = 17;
        propTypeId = 12;
      } else if (propType === "variable") {
        typeId = 0;
        propTypeId = 1;
      } else {
        typeId = 0;
        propTypeId = 2;
      }
      break;

    case "datapoint":
      typeId = 4;
      propTypeId = 1;
      refId = newDesignTimeId(); // freestanding UUID
      if (typeof value === "string" && !value.includes(":")) {
        value = `0:${value}`;
      }
      break;

    case "text":
      typeId = 5;
      propTypeId = 1;
      if (typeof value === "string" && value.includes(":")) {
        const [listName, aliasName] = value.split(":");
        refId = resolveTextRef(projectDir, listName, aliasName) || undefined;
      }
      break;

    case "colorScheme":
      // If it contains a colon, check if it resolves as a palette color first, then as colorScheme
      if (typeof value === "string" && value.includes(":")) {
        const paletteColorId = resolveColorRef(projectDir, value);
        if (paletteColorId) {
          typeId = 9;
          propTypeId = 2;
          refId = paletteColorId;
          break;
        }
      }
      typeId = 18;
      propTypeId = 2;
      refId = resolveSchemeRef(projectDir, "ColorSchemes", String(value)) || undefined;
      break;

    case "stateScheme":
      typeId = 21;
      propTypeId = 1;
      refId = resolveSchemeRef(projectDir, "StateSchemes", String(value)) || undefined;
      break;

    case "functionBlock":
      typeId = 1;
      propTypeId = 3;
      refId = resolveFunctionBlockRef(projectDir, String(value)) || undefined;
      break;

    case "compositeControl":
      typeId = 23;
      propTypeId = 5;
      refId = resolveTemplateRef(projectDir, String(value)) || undefined;
      break;

    case "imageOrMedia":
      typeId = 15;
      propTypeId = 2;
      refId = resolveMediaRef(projectDir, String(value)) || undefined;
      break;

    case "fontStyle":
      typeId = 26;
      propTypeId = 6;
      refId = resolveFontRef(projectDir, String(value)) || undefined;
      break;

    case "styleClass":
      typeId = 34;
      propTypeId = 14;
      refId = resolveStyleClassRef(projectDir, String(value)) || undefined;
      break;

    default:
      // Fallback
      typeId = 0;
      propTypeId = 2;
  }

  const result: any = {
    name: propName,
    value,
    typeId,
    propTypeId
  };
  if (refId) {
    result.refId = refId;
  }
  return result;
}
