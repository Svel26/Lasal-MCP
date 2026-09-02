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

export interface ConnectionInfo {
  connection: string;
  ip?: string;
  port?: number;
  source: "explicit" | "lss";
  warning?: string;
}

/** True when the connection targets a local LARS (or other local) runtime. */
export function isLoopbackTarget(conn: ConnectionInfo | { ip?: string }): boolean {
  const ip = conn.ip;
  if (!ip) return false;
  return ip === "127.0.0.1" || ip === "localhost" || ip.startsWith("127.");
}

/** Extract the IP and optional port from a connection string like 'TCPIP:10.0.0.5:1964'. */
export function parseConnectionTarget(conn: string): { ip?: string; port?: number } {
  let target = conn;
  const m = conn.match(/TCPIP:(.+)/i);
  if (m) target = m[1]!;
  if (target.includes(":")) {
    const [ipPart, portPart] = target.split(":");
    if (ipPart && portPart) {
      const port = parseInt(portPart, 10);
      if (!isNaN(port) && port > 0 && port <= 65535) {
        return { ip: ipPart, port };
      }
    }
    return { ip: target.split(":")[0] };
  }
  if (target.includes(".")) return { ip: target };
  return { ip: target };
}

export function resolveConnection(lcpPath: string, explicit?: string): ConnectionInfo {
  if (explicit) {
    const { ip, port } = parseConnectionTarget(explicit);
    return { connection: explicit, ip, port, source: "explicit" };
  }

  const lssPath = findLssPath(lcpPath);
  if (!lssPath) {
    return { connection: "", source: "lss", warning: `No .lss file found near ${lcpPath}` };
  }
  if (!existsSync(lssPath)) {
    return { connection: "", source: "lss", warning: `LSS file not found at ${lssPath}` };
  }

  try {
    const raw = readFileSync(lssPath, "latin1");
    const xmlParser = new XMLParser({ ignoreAttributes: false, parseAttributeValue: false });
    const doc = xmlParser.parse(raw);
    const tcpip = doc.SlnStation?.OnlineConnectionInfo?.TCPIP;
    if (tcpip) {
      const ip = tcpip["@_IP"];
      const port = tcpip["@_PORT"] ?? "1954";
      const portNum = parseInt(port, 10);
      return {
        connection: `TCPIP:${ip}${port && port !== "1954" ? `:${port}` : ""}`,
        ip,
        port: !isNaN(portNum) ? portNum : undefined,
        source: "lss",
      };
    }
    return { connection: "", source: "lss", warning: `LSS file ${lssPath} has no <TCPIP> element` };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { connection: "", source: "lss", warning: `Failed to parse .lss at ${lssPath}: ${msg}` };
  }
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

export async function preflightPlc(lcpPath: string, explicitConn?: string): Promise<PreflightResult> {
  const problems: PreflightProblem[] = [];

  if (!existsSync(lcpPath)) {
    problems.push({
      code: "LCP_NOT_FOUND",
      message: `Project LCP file does not exist at ${lcpPath}`,
      fix: "Select a valid project using select_project or specify a correct lcp_path.",
    });
    return { ok: false, problems, connection: "" };
  }

  const connInfo = resolveConnection(lcpPath, explicitConn);
  if (!connInfo.ip) {
    problems.push({
      code: "NO_IP_RESOLVED",
      message: "Could not resolve an IP address for the connection.",
      fix: "Provide an explicit connection string (e.g. TCPIP:10.195.0.50) or set the target IP using set_target_ip.",
    });
    return { ok: false, problems, connection: connInfo.connection };
  }

  const port = connInfo.port ?? 1954;
  const reachable = await pingHost(connInfo.ip, port, 2000);
  if (!reachable) {
    problems.push({
      code: "HOST_UNREACHABLE",
      message: `PLC host at ${connInfo.ip} is unreachable on port ${port}.`,
      fix: "Ensure the PLC is powered on and connected to the network. Verify the IP using lasal_status or set the correct IP.",
    });
  }

  return {
    ok: problems.length === 0,
    problems,
    connection: connInfo.connection,
    ip: connInfo.ip,
  };
}

export async function preflightHmi(lvpPath: string, explicitConn: string): Promise<PreflightResult> {
  const problems: PreflightProblem[] = [];

  if (!existsSync(lvpPath)) {
    problems.push({
      code: "LVP_NOT_FOUND",
      message: `VISUDesigner LVP file does not exist at ${lvpPath}`,
      fix: "Verify that the VISUDesigner project path is correct.",
    });
    return { ok: false, problems, connection: "" };
  }

  if (!explicitConn) {
    problems.push({
      code: "NO_CONN_SPECIFIED",
      message: "No connection string specified for HMI download.",
      fix: "Specify a visu_connection parameter.",
    });
    return { ok: false, problems, connection: "" };
  }

  let ip: string | undefined;
  let port = 1954;
  const { ip: parsedIp, port: parsedPort } = parseConnectionTarget(explicitConn);
  ip = parsedIp;
  if (parsedPort) port = parsedPort;

  if (!ip) {
    problems.push({
      code: "INVALID_HMI_CONN",
      message: `Invalid HMI connection string: ${explicitConn}`,
      fix: "Provide a valid HMI connection string, e.g. 'TCPIP:10.195.0.51'.",
    });
    return { ok: false, problems, connection: explicitConn };
  }

  const reachable = await pingHost(ip, port, 2000);
  if (!reachable) {
    problems.push({
      code: "HMI_UNREACHABLE",
      message: `HMI host at ${ip} is unreachable on port ${port}.`,
      fix: "Ensure the HMI is powered on and connected to the network. Verify the IP using lasal_status.",
    });
  }

  return {
    ok: problems.length === 0,
    problems,
    connection: explicitConn,
    ip,
  };
}
