import { execFile } from "child_process";
import { existsSync } from "fs";
import { dirname } from "path";
import { MACHINEMANAGER_EXE, killMachineManager } from "./engine.js";

// ─── MachineManager update files (.lutc) ──────────────────────────────────────
//
// Verified against the shipped examples in
// `MachineManager\Runtime\Examples\00x .../Example.lutc`:
//   <UpdateConfig TargetId MachineNr> → <Targets><Target Station><PC><TCPIP/></Target>
//   → <Instructions> with one element per step (DwnLdLC2, DwnLdLSE, DwnLdLVD,
//   DwnLdOS, DwnLdFile, DwnLdFld, UpLdFile, UpLdFld, MvFile, DelFile, MkDir,
//   ExistFile, PrjRun, Boot, WrNr, CLICmd, InstPack). TargetId is the 0-based
//   index into <Targets>.

export interface LutcTarget {
  station: string;
  ip: string;
  port: string;
  ssltls?: string;
  configName?: string;
  password?: string;
}

export interface LutcClass2Instruction {
  kind: "class2";
  file: string;
  savePrj?: boolean;
  /** "Arm" | "X86" | "AUTO" — omit to keep the project's own target. */
  platform?: string;
}

export interface LutcScreenInstruction {
  kind: "screen";
  /** `.lpr` file or the compiled runtime output folder. */
  file: string;
}

export interface LutcVisuInstruction {
  kind: "visu";
  /** Publish folder or `.lvp` file. */
  file: string;
  /** Optional runtime folder (…/Runtime/rt). */
  runtimeFile?: string;
}

export interface LutcOsInstruction {
  kind: "os";
  file: string;
  rebootTimeoutMs?: number;
}

export interface LutcFileInstruction {
  kind: "file";
  direction: "download" | "upload" | "delete" | "mkdir" | "move" | "exists";
  /** download/upload/move source. For delete/mkdir/exists the remote path only. */
  localPath?: string;
  remotePath: string;
  /** move: target path on the control. */
  targetPath?: string;
  folder?: boolean;
}

export interface LutcRunInstruction {
  kind: "run";
}

export interface LutcBootInstruction {
  kind: "boot";
  timeoutMs?: number;
}

export interface LutcWriteInstruction {
  kind: "write";
  channel: string;
  value: string | number;
}

export interface LutcCliInstruction {
  kind: "cli";
  command: string;
}

export interface LutcPackageInstruction {
  kind: "package";
  name: string;
  file: string;
}

export type LutcInstructionData =
  | LutcClass2Instruction
  | LutcScreenInstruction
  | LutcVisuInstruction
  | LutcOsInstruction
  | LutcFileInstruction
  | LutcRunInstruction
  | LutcBootInstruction
  | LutcWriteInstruction
  | LutcCliInstruction
  | LutcPackageInstruction;

export type LutcInstruction = LutcInstructionData & { station: string };

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function param(value: string): string {
  return `\t\t\t<Param Val="${xmlEscape(value)}"/>`;
}

function instructionXml(instr: LutcInstruction, targetId: number): string {
  const t = `TargetId="${targetId}"`;
  switch (instr.kind) {
    case "class2": {
      const attrs = [`SavePrj="${instr.savePrj === false ? "false" : "true"}"`];
      if (instr.platform) attrs.push(`Platform="${xmlEscape(instr.platform)}"`);
      return `\t\t<DwnLdLC2 ${t}>\n${param(instr.file)}\n\t\t\t<Param ${attrs.join(" ")}/>\n\t\t</DwnLdLC2>`;
    }
    case "screen":
      return `\t\t<DwnLdLSE ${t}>\n${param(instr.file)}\n\t\t</DwnLdLSE>`;
    case "visu":
      return `\t\t<DwnLdLVD ${t}>\n${param(instr.file)}\n${
        instr.runtimeFile ? param(instr.runtimeFile) : "\t\t\t<Param/>"
      }\n\t\t</DwnLdLVD>`;
    case "os":
      return `\t\t<DwnLdOS ${t}>\n${param(instr.file)}\n${param(String(instr.rebootTimeoutMs ?? 600000))}\n\t\t</DwnLdOS>`;
    case "file": {
      const tag =
        instr.direction === "download"
          ? instr.folder
            ? "DwnLdFld"
            : "DwnLdFile"
          : instr.direction === "upload"
            ? instr.folder
              ? "UpLdFld"
              : "UpLdFile"
            : instr.direction === "delete"
              ? "DelFile"
              : instr.direction === "mkdir"
                ? "MkDir"
                : instr.direction === "move"
                  ? "MvFile"
                  : "ExistFile";
      const params: string[] = [];
      if (instr.direction === "download") {
        params.push(param(instr.localPath ?? ""));
        params.push(param(instr.remotePath));
      } else if (instr.direction === "upload") {
        params.push(param(instr.remotePath));
        params.push(param(instr.localPath ?? ""));
      } else if (instr.direction === "move") {
        params.push(param(instr.remotePath));
        params.push(param(instr.targetPath ?? ""));
      } else {
        params.push(param(instr.remotePath));
      }
      return `\t\t<${tag} ${t}>\n${params.join("\n")}\n\t\t</${tag}>`;
    }
    case "run":
      return `\t\t<PrjRun ${t}>\n\t\t</PrjRun>`;
    case "boot":
      return `\t\t<Boot ${t}>\n${param(String(instr.timeoutMs ?? 180000))}\n\t\t</Boot>`;
    case "write":
      return `\t\t<WrNr ${t}>\n${param(instr.channel)}\n${param(String(instr.value))}\n\t\t</WrNr>`;
    case "cli":
      return `\t\t<CLICmd ${t}>\n${param(instr.command)}\n\t\t</CLICmd>`;
    case "package":
      return `\t\t<InstPack ${t}>\n${param(instr.name)}\n${param(instr.file)}\n\t\t</InstPack>`;
  }
}

export interface BuildLutcOptions {
  targets: LutcTarget[];
  instructions: LutcInstruction[];
  machineNr?: string;
}

export function buildLutc(opts: BuildLutcOptions): string {
  const targetIndex = new Map<string, number>();
  opts.targets.forEach((tgt, i) => targetIndex.set(tgt.station.toLowerCase(), i));

  const targetXml = opts.targets.map(
    (tgt) =>
      `\t\t<Target Station="${xmlEscape(tgt.station)}">\n` +
      `\t\t\t<PC>\n` +
      `\t\t\t\t<TCPIP ConfigName="${xmlEscape(tgt.configName ?? tgt.station)}" BUS="3" Password="${xmlEscape(
        tgt.password ?? "",
      )}" IP="${xmlEscape(tgt.ip)}" PORT="${xmlEscape(tgt.port)}" SomeFlags="0" PLCID="" Repeater="0" SSLTLS="${xmlEscape(
        tgt.ssltls ?? "0",
      )}" Favorite="0"/>\n` +
      `\t\t\t</PC>\n` +
      `\t\t</Target>`,
  );

  const instructionXmlParts = opts.instructions.map((instr) => {
    const idx = targetIndex.get(instr.station.toLowerCase());
    if (idx === undefined) {
      throw new Error(`Instruction references unknown station '${instr.station}' — add it to targets first.`);
    }
    return instructionXml(instr, idx);
  });

  return (
    `<?xml version="1.0" encoding="ISO-8859-1" ?>\n` +
    `<UpdateConfig TargetId="0" MachineNr="${xmlEscape(opts.machineNr ?? "000")}">\n` +
    `\t<Targets>\n${targetXml.join("\n")}\n\t</Targets>\n` +
    `\t<Instructions>\n${instructionXmlParts.join("\n")}\n\t</Instructions>\n` +
    `</UpdateConfig>\n`
  );
}

// ─── MachineManager runner ────────────────────────────────────────────────────

export interface LutcRunResult {
  ok: boolean;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTail: string[];
  stderrTail: string[];
  errors: string[];
  hints: string[];
}

export async function runMachineManager(lutcPath: string, timeoutMs: number): Promise<LutcRunResult> {
  const start = Date.now();
  if (!existsSync(MACHINEMANAGER_EXE)) {
    return {
      ok: false,
      exitCode: -1,
      timedOut: false,
      durationMs: 0,
      stdout: "",
      stderr: "",
      stdoutTail: [],
      stderrTail: [],
      errors: [`MachineManager not found at ${MACHINEMANAGER_EXE}`],
      hints: ["Install LASAL MachineManager or set LASAL_MACHINEMANAGER_EXE."],
    };
  }

  return new Promise((resolve) => {
    const child = execFile(
      MACHINEMANAGER_EXE,
      [`/update:${lutcPath}`],
      {
        cwd: dirname(lutcPath),
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - start;
        const timedOut = !!error && (error.killed || (error as NodeJS.ErrnoException).code === "ETIMEDOUT");
        if (timedOut) killMachineManager();

        const outStr = stdout?.toString() ?? "";
        const errStr = stderr?.toString() ?? "";
        const exitCode = error ? (typeof error.code === "number" ? error.code : (child.exitCode ?? 1)) : 0;

        const errors: string[] = [];
        if (timedOut) errors.push(`MachineManager timed out after ${Math.round(timeoutMs / 1000)}s.`);
        else if (exitCode !== 0) errors.push(`MachineManager exited with code ${exitCode}.`);
        errors.push(
          ...errStr
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean),
        );

        const hints: string[] = [];
        if (timedOut) {
          hints.push("Raise timeout_s or LASAL_MCP_TIMEOUT_MM for large multi-station updates.");
        }
        if (errors.some((e) => /unreachable|refused|timeout|not connected/i.test(e))) {
          hints.push(
            "A target was unreachable. Verify station IPs with lasal_status/set_target_ip, or simulate locally with lars_runtime.",
          );
        }
        hints.push("Per-run logs are written to MachineManager's configured Update-Tool log folder.");

        resolve({
          ok: exitCode === 0 && !timedOut && errors.length === 0,
          exitCode,
          timedOut,
          durationMs,
          stdout: outStr,
          stderr: errStr,
          stdoutTail: outStr
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(-20),
          stderrTail: errStr
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(-20),
          errors,
          hints,
        });
      },
    );
  });
}
