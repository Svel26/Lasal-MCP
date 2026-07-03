import { readFileSync, existsSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { XMLParser } from "fast-xml-parser";
import * as net from "net";

// Helper to find .lss file from .lcp path
export function findLssPath(lcpPath: string): string | null {
  const lcpDir = dirname(lcpPath);
  try {
    const files = readdirSync(lcpDir);
    for (const f of files) {
      if (f.endsWith(".lss")) return join(lcpDir, f);
    }
  } catch {}
  
  const parentDir = dirname(lcpDir);
  try {
    const parentFiles = readdirSync(parentDir);
    for (const f of parentFiles) {
      if (f.endsWith(".lss")) return join(parentDir, f);
    }
  } catch {}
  return null;
}

export function resolveConnection(
  lcpPath: string,
  explicit?: string
): { connection: string; ip?: string; source: "explicit" | "lss" } {
  if (explicit) {
    let ip: string | undefined;
    const m = explicit.match(/TCPIP:(.+)/i);
    if (m) {
      ip = m[1].split(":")[0];
    } else if (explicit.includes(".")) {
      ip = explicit;
    }
    return { connection: explicit, ip, source: "explicit" };
  }

  const lssPath = findLssPath(lcpPath);
  if (!lssPath || !existsSync(lssPath)) {
    return { connection: "", source: "lss" };
  }

  try {
    const raw = readFileSync(lssPath, "latin1");
    const parser = new XMLParser({ ignoreAttributes: false, parseAttributeValue: false });
    const doc = parser.parse(raw);
    const tcpip = doc.SlnStation?.OnlineConnectionInfo?.TCPIP;
    if (tcpip) {
      const ip = tcpip["@_IP"];
      const port = tcpip["@_PORT"] ?? "1954";
      return {
        connection: `TCPIP:${ip}${port && port !== "1954" ? `:${port}` : ""}`,
        ip,
        source: "lss",
      };
    }
  } catch {}
  return { connection: "", source: "lss" };
}

export function pingHost(ip: string, port = 1954, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    socket.setTimeout(timeoutMs);

    socket.on("connect", () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(true);
      }
    });

    const onError = () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(false);
      }
    };

    socket.on("error", onError);
    socket.on("timeout", onError);

    socket.connect(port, ip);
  });
}

export interface PreflightProblem {
  code: string;
  message: string;
  fix: string;
}

export interface PreflightResult {
  ok: boolean;
  problems: PreflightProblem[];
  connection: string;
  ip?: string;
}

export async function preflightPlc(
  lcpPath: string,
  explicitConn?: string
): Promise<PreflightResult> {
  const problems: PreflightProblem[] = [];

  if (!existsSync(lcpPath)) {
    problems.push({
      code: "LCP_NOT_FOUND",
      message: `Project LCP file does not exist at ${lcpPath}`,
      fix: "Select a valid project using select_project or specify a correct lcp_path."
    });
    return { ok: false, problems, connection: "" };
  }

  const connInfo = resolveConnection(lcpPath, explicitConn);
  if (!connInfo.ip) {
    problems.push({
      code: "NO_IP_RESOLVED",
      message: "Could not resolve an IP address for the connection.",
      fix: "Provide an explicit connection string (e.g. TCPIP:10.195.0.50) or set the target IP using set_target_ip."
    });
    return { ok: false, problems, connection: connInfo.connection };
  }

  const reachable = await pingHost(connInfo.ip, 1954, 2000);
  if (!reachable) {
    problems.push({
      code: "HOST_UNREACHABLE",
      message: `PLC host at ${connInfo.ip} is unreachable on port 1954.`,
      fix: "Ensure the PLC is powered on and connected to the network. Verify the IP using lasal_status or set the correct IP."
    });
  }

  return {
    ok: problems.length === 0,
    problems,
    connection: connInfo.connection,
    ip: connInfo.ip
  };
}

export async function preflightHmi(
  lvpPath: string,
  explicitConn: string
): Promise<PreflightResult> {
  const problems: PreflightProblem[] = [];

  if (!existsSync(lvpPath)) {
    problems.push({
      code: "LVP_NOT_FOUND",
      message: `VISUDesigner LVP file does not exist at ${lvpPath}`,
      fix: "Verify that the VISUDesigner project path is correct."
    });
    return { ok: false, problems, connection: "" };
  }

  if (!explicitConn) {
    problems.push({
      code: "NO_CONN_SPECIFIED",
      message: "No connection string specified for HMI download.",
      fix: "Specify a visu_connection parameter."
    });
    return { ok: false, problems, connection: "" };
  }

  let ip: string | undefined;
  const m = explicitConn.match(/TCPIP:(.+)/i);
  if (m) {
    ip = m[1].split(":")[0];
  } else if (explicitConn.includes(".")) {
    ip = explicitConn;
  }

  if (!ip) {
    problems.push({
      code: "INVALID_HMI_CONN",
      message: `Invalid HMI connection string: ${explicitConn}`,
      fix: "Provide a valid HMI connection string, e.g. 'TCPIP:10.195.0.51'."
    });
    return { ok: false, problems, connection: explicitConn };
  }

  const reachable = await pingHost(ip, 1954, 2000);
  if (!reachable) {
    problems.push({
      code: "HMI_UNREACHABLE",
      message: `HMI host at ${ip} is unreachable on port 1954.`,
      fix: "Ensure the HMI is powered on and connected to the network. Verify the IP using lasal_status."
    });
  }

  return {
    ok: problems.length === 0,
    problems,
    connection: explicitConn,
    ip
  };
}
