import { existsSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { z } from "zod";
import { readLatin1, writeLatin1, newGuid } from "../utils/lasalXml.js";
import { lasalCrc32 } from "../utils/crc.js";
import { resolveLcpPath } from "../utils/resolvePaths.js";

export const validateGuidsSchema = {
  lcp_path: z
    .string()
    .optional()
    .describe("Absolute path to the .lcp file. Omit to use the currently selected project."),
  auto_fix: z
    .boolean()
    .optional()
    .default(true)
    .describe("Automatically resolve duplicate GUID collisions and update @CT_ hashes. Default true."),
};

export interface GuidCollision {
  guid: string;
  elements: Array<{
    file: string;
    className: string;
    channelName?: string;
    kind: "class" | "server" | "object";
  }>;
  resolvedGuid?: string;
}

export interface CtHashFix {
  file: string;
  className: string;
  name: string;
  oldHash: number;
  newHash: number;
}

export interface ValidateGuidsResult {
  ok: boolean;
  totalClassesScanned: number;
  collisions: GuidCollision[];
  ctHashFixes: CtHashFix[];
  cleanedMetadata: string[];
  filesModified: string[];
}

function findStFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...findStFiles(full));
    } else if (/\.st$/i.test(entry)) {
      results.push(full);
    }
  }
  return results;
}

function updateMaeExport(stationDir: string, className: string, oldGuid: string, newGuidStr: string): boolean {
  let changed = false;
  const maeTxt = join(stationDir, "MaeExp.txt");
  if (existsSync(maeTxt)) {
    const txt = readLatin1(maeTxt);
    const bareOld = oldGuid.replace(/[{}]/g, "");
    const bareNew = newGuidStr.replace(/[{}]/g, "");
    if (txt.includes(bareOld) || txt.includes(oldGuid)) {
      const lines = txt.split(/\r?\n/);
      const nextLines = lines.map((line) => {
        if (line.includes(`"${className}"`)) {
          return line.replace(bareOld, bareNew).replace(oldGuid, newGuidStr);
        }
        return line;
      });
      const next = nextLines.join(txt.includes("\r\n") ? "\r\n" : "\n");
      if (next !== txt) {
        writeLatin1(maeTxt, next);
        changed = true;
      }
    }
  }

  const maeXml = join(stationDir, "MaeExp.xml");
  if (existsSync(maeXml)) {
    const xml = readLatin1(maeXml);
    const bareOld = oldGuid.replace(/[{}]/g, "");
    const bareNew = newGuidStr.replace(/[{}]/g, "");
    if (xml.includes(bareOld) || xml.includes(oldGuid)) {
      // Scoped replacement inside the class block
      const classStart = xml.search(new RegExp(`<Class\\b[^>]*\\bName\\s*=\\s*"${className}"`, "i"));
      if (classStart >= 0) {
        const classEnd = xml.indexOf("</Class>", classStart);
        if (classEnd > classStart) {
          const before = xml.slice(0, classStart);
          const block = xml.slice(classStart, classEnd);
          const after = xml.slice(classEnd);
          const replacedBlock = block
            .replace(new RegExp(bareOld, "gi"), bareNew)
            .replace(new RegExp(oldGuid, "gi"), newGuidStr);
          if (replacedBlock !== block) {
            writeLatin1(maeXml, before + replacedBlock + after);
            changed = true;
          }
        }
      }
    }
  }

  return changed;
}

/**
 * Scan station project for duplicate GUID collisions and uninitialized TO_UDINT(0) placeholders.
 */
export function runGuidValidation(lcpPath: string, autoFix = true): ValidateGuidsResult {
  const stationDir = dirname(lcpPath);
  const classDir = join(stationDir, "Class");
  const stFiles = findStFiles(classDir);

  const guidMap = new Map<
    string,
    Array<{
      file: string;
      className: string;
      channelName?: string;
      kind: "class" | "server" | "object";
    }>
  >();

  const ctFixes: CtHashFix[] = [];
  const cleanedMetadata: string[] = [];
  const modifiedFiles = new Set<string>();

  // Pass 1: Gather all GUIDs and inspect @CT_ hashes
  for (const stPath of stFiles) {
    let content = readLatin1(stPath);
    let fileDirty = false;

    // Check class GUID
    const classMatch =
      content.match(/<Class\b[^>]*\bName\s*=\s*"([^"]+)"[^>]*\bGUID\s*=\s*"([^"]+)"/i) ||
      content.match(/<Class\b[^>]*\bGUID\s*=\s*"([^"]+)"[^>]*\bName\s*=\s*"([^"]+)"/i);
    let currentClassName = "";
    if (classMatch) {
      const isGuidFirst = classMatch[1]!.startsWith("{");
      currentClassName = isGuidFirst ? classMatch[2]! : classMatch[1]!;
      const rawGuid = (isGuidFirst ? classMatch[1]! : classMatch[2]!).toUpperCase();
      const list = guidMap.get(rawGuid) ?? [];
      list.push({ file: stPath, className: currentClassName, kind: "class" });
      guidMap.set(rawGuid, list);
    }

    // Check server GUIDs
    const serverRegex = /<Server\b[^>]*\bName\s*=\s*"([^"]+)"[^>]*\bGUID\s*=\s*"([^"]+)"/gi;
    let sMatch: RegExpExecArray | null;
    while ((sMatch = serverRegex.exec(content)) !== null) {
      const sName = sMatch[1]!;
      const sGuid = sMatch[2]!.toUpperCase();
      const list = guidMap.get(sGuid) ?? [];
      list.push({ file: stPath, className: currentClassName, channelName: sName, kind: "server" });
      guidMap.set(sGuid, list);
    }

    // Check @CT_ table hashes
    const ctStart = content.search(/FUNCTION\s+GLOBAL\s+TAB\s+([A-Za-z0-9_]+)::@CT_/i);
    if (ctStart >= 0) {
      const ctEnd = content.indexOf("END_FUNCTION", ctStart);
      if (ctEnd > ctStart) {
        const ctBlock = content.slice(ctStart, ctEnd);
        let nextBlock = ctBlock;

        const hashRegex = /TO_UDINT\((\d+)\),\s*"([A-Za-z0-9_]+)"/g;
        let hMatch: RegExpExecArray | null;
        while ((hMatch = hashRegex.exec(ctBlock)) !== null) {
          const rawNum = Number(hMatch[1]);
          const name = hMatch[2]!;
          const expected = lasalCrc32(name);
          if (rawNum === 0 || rawNum !== expected) {
            ctFixes.push({
              file: stPath,
              className: currentClassName || name,
              name,
              oldHash: rawNum,
              newHash: expected,
            });
            if (autoFix) {
              const targetStr = hMatch[0];
              const replacement = `TO_UDINT(${expected}), "${name}"`;
              nextBlock = nextBlock.replace(targetStr, replacement);
              fileDirty = true;
            }
          }
        }

        if (fileDirty) {
          content = content.slice(0, ctStart) + nextBlock + content.slice(ctEnd);
        }
      }
    }

    // Check for dangling/empty temp IOObjects
    const ioObjectsRegex =
      /[ \t]*<!--[^\n]*-->\r?\n[ \t]*<IOObjects>\r?\n(?:[ \t]*<IOObject[^\n]*\/>\r?\n)*[ \t]*<\/IOObjects>\r?\n/g;
    if (ioObjectsRegex.test(content)) {
      cleanedMetadata.push(`${currentClassName || stPath}: stripped unused <IOObjects>`);
      if (autoFix) {
        content = content.replace(ioObjectsRegex, "");
        fileDirty = true;
      }
    }

    if (fileDirty && autoFix) {
      writeLatin1(stPath, content);
      modifiedFiles.add(stPath);
    }
  }

  // Pass 2: Detect duplicate GUID collisions
  const collisions: GuidCollision[] = [];
  for (const [guid, elements] of guidMap.entries()) {
    // Filter duplicates across distinct entities
    const uniqueKeys = new Set(elements.map((e) => `${e.className}.${e.channelName ?? ""}`));
    if (uniqueKeys.size > 1) {
      const collision: GuidCollision = { guid, elements };
      collisions.push(collision);

      if (autoFix) {
        // Keep the first element, re-GUID subsequent colliding elements
        for (let i = 1; i < elements.length; i++) {
          const elem = elements[i]!;
          const freshGuid = newGuid();
          collision.resolvedGuid = freshGuid;

          const fileContent = readLatin1(elem.file);
          let updatedContent: string;
          if (elem.kind === "class") {
            const re = new RegExp(`(<Class\\b[^>]*\\bGUID\\s*=\\s*")${guid}"`, "i");
            updatedContent = fileContent.replace(re, `$1${freshGuid}"`);
          } else {
            const re = new RegExp(
              `(<Server\\b[^>]*\\bName\\s*=\\s*"${elem.channelName}"[^>]*\\bGUID\\s*=\\s*")${guid}"`,
              "i",
            );
            updatedContent = fileContent.replace(re, `$1${freshGuid}"`);
          }

          if (updatedContent !== fileContent) {
            writeLatin1(elem.file, updatedContent);
            modifiedFiles.add(elem.file);
          }

          // Update symbol exports
          const maeUpdated = updateMaeExport(stationDir, elem.className, guid, freshGuid);
          if (maeUpdated) {
            const maeTxt = join(stationDir, "MaeExp.txt");
            if (existsSync(maeTxt)) modifiedFiles.add(maeTxt);
            const maeXml = join(stationDir, "MaeExp.xml");
            if (existsSync(maeXml)) modifiedFiles.add(maeXml);
          }
        }
      }
    }
  }

  return {
    ok: collisions.length === 0 && ctFixes.length === 0,
    totalClassesScanned: stFiles.length,
    collisions,
    ctHashFixes: ctFixes,
    cleanedMetadata,
    filesModified: Array.from(modifiedFiles),
  };
}

export async function validateGuidsHandler(args: { lcp_path?: string; auto_fix?: boolean }) {
  const resolved = resolveLcpPath(args.lcp_path);
  if ("error" in resolved) {
    return { content: [{ type: "text" as const, text: resolved.error }], isError: true };
  }

  const autoFix = args.auto_fix !== false;
  const result = runGuidValidation(resolved.path, autoFix);

  const lines: string[] = [
    `# GUID & @CT_ Validation Report`,
    `Station: ${resolved.path}`,
    `Classes scanned: ${result.totalClassesScanned}`,
    `Status: ${result.ok ? "Clean (no issues found)" : autoFix ? "Repaired" : "Issues detected"}`,
    "",
  ];

  if (result.collisions.length > 0) {
    lines.push(`## Duplicate GUID Collisions (${result.collisions.length})`);
    for (const c of result.collisions) {
      lines.push(`- GUID: \`${c.guid}\``);
      for (const e of c.elements) {
        lines.push(`  * ${e.kind}: \`${e.className}${e.channelName ? `.${e.channelName}` : ""}\` (${e.file})`);
      }
      if (c.resolvedGuid) {
        lines.push(`  → Assigned new GUID: \`${c.resolvedGuid}\``);
      }
    }
    lines.push("");
  }

  if (result.ctHashFixes.length > 0) {
    lines.push(`## @CT_ Table Hash Updates (${result.ctHashFixes.length})`);
    for (const f of result.ctHashFixes) {
      lines.push(`- \`${f.className}\` / "${f.name}": TO_UDINT(${f.oldHash}) → TO_UDINT(${f.newHash})`);
    }
    lines.push("");
  }

  if (result.cleanedMetadata.length > 0) {
    lines.push(`## Network Metadata Cleanups (${result.cleanedMetadata.length})`);
    for (const m of result.cleanedMetadata) {
      lines.push(`- ${m}`);
    }
    lines.push("");
  }

  if (result.filesModified.length > 0) {
    lines.push(`## Files Modified (${result.filesModified.length})`);
    for (const file of result.filesModified) {
      lines.push(`- ${file}`);
    }
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    isError: false,
  };
}
