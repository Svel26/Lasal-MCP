import * as fs from 'fs';
import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';

// Read file preserving ISO-8859-1 (Latin1 in Node)
export function readLatin1File(filePath: string): string {
  return fs.readFileSync(filePath, 'latin1');
}

// Write file preserving ISO-8859-1
export function writeLatin1File(filePath: string, content: string): void {
  // Ensure the directory exists
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'latin1');
}

export interface ProjectRef {
  name: string;
  path: string; // resolved absolute path
  relativePath: string;
  type: 'class2' | 'visudesigner' | 'unknown';
}

export interface StationInfo {
  name: string;
  lssPath: string; // resolved absolute path
  onlineConnection: string;
  connectionInfo: {
    ip: string | null;
    port: number | null;
    useTls: boolean;
    password: string | null;
    configName: string | null;
  } | null;
  projects: ProjectRef[];
}

export interface SolutionTree {
  solutionPath: string;
  stations: StationInfo[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false
});

function getProjectKind(filePath: string): 'class2' | 'visudesigner' | 'unknown' {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.lcp') return 'class2';
  if (ext === '.lvp') return 'visudesigner';
  return 'unknown';
}

export function parseSolution(solutionPath: string): SolutionTree {
  const slnContent = readLatin1File(solutionPath);
  const slnData = parser.parse(slnContent);
  const slnDir = path.dirname(solutionPath);

  const stations: StationInfo[] = [];

  // Inside .lsm, look for stations
  // Schema varies, let's look for SlnStations.SlnStation or similar
  const root = slnData.LasalSolution || slnData.Solution;
  if (!root) {
    throw new Error('Invalid solution file format: no root element found.');
  }

  // Real .lsm: <Solution><SlnStationFiles><File Path=".\Stations\HMI\HMI.lss"/>...</SlnStationFiles>
  // Tolerate legacy/alternate spellings as a fallback.
  const slnStationsNode = root.SlnStationFiles || root.SlnStations;
  if (slnStationsNode) {
    let stationList =
      slnStationsNode.File || slnStationsNode.SlnStationFile || slnStationsNode.SlnStation;
    if (stationList) {
      if (!Array.isArray(stationList)) {
        stationList = [stationList];
      }
      for (const st of stationList) {
        const relPath = st['@_Path'] || st['@_path'];
        if (!relPath) continue;
        const absLssPath = path.resolve(slnDir, relPath);
        if (fs.existsSync(absLssPath)) {
          stations.push(parseStation(absLssPath));
        }
      }
    }
  }

  return {
    solutionPath,
    stations
  };
}

export function parseStation(lssPath: string): StationInfo {
  const content = readLatin1File(lssPath);
  const data = parser.parse(content);
  const stationDir = path.dirname(lssPath);

  const stationNode = data.SlnStation;
  if (!stationNode) {
    throw new Error(`Invalid station file format in: ${lssPath}`);
  }

  const name = stationNode['@_Name'] || '';
  const onlineConnection = stationNode['@_OnlineConnection'] || '';

  // Parse connection info
  let connectionInfo: StationInfo['connectionInfo'] = null;
  const connInfoNode = stationNode.OnlineConnectionInfo;
  if (connInfoNode && connInfoNode.TCPIP) {
    const tcp = connInfoNode.TCPIP;
    connectionInfo = {
      ip: tcp['@_IP'] || null,
      port: tcp['@_PORT'] ? parseInt(tcp['@_PORT'], 10) : null,
      useTls: tcp['@_SSLTLS'] === '1',
      password: tcp['@_Password'] || null,
      configName: tcp['@_ConfigName'] || null
    };
  }

  // Parse projects.
  // Real .lss uses <SlnClassProject .../> and <SlnVISUDesignerProject .../> with a File="" attribute.
  // Older/alternate shapes (<SlnProject Path="">/<Project>) are tolerated as a fallback.
  const projects: ProjectRef[] = [];
  const projectsNode = stationNode.SlnProjects;
  if (projectsNode) {
    const collect = (list: any, kindHint: ProjectRef['type']) => {
      if (!list) return;
      if (!Array.isArray(list)) list = [list];
      for (const p of list) {
        const relPath = p['@_File'] || p['@_Path'] || p['@_path'] || '';
        if (!relPath) continue;
        const name = p['@_Name'] || p['@_name'] || path.basename(relPath);
        const absProjPath = path.resolve(stationDir, relPath);
        const kind = kindHint !== 'unknown' ? kindHint : getProjectKind(absProjPath);
        projects.push({ name, path: absProjPath, relativePath: relPath, type: kind });
      }
    };
    collect(projectsNode.SlnClassProject, 'class2');
    collect(projectsNode.SlnVISUDesignerProject, 'visudesigner');
    collect(projectsNode.SlnProject, 'unknown');
    collect(projectsNode.Project, 'unknown');
  }

  return {
    name,
    lssPath,
    onlineConnection,
    connectionInfo,
    projects
  };
}

export interface SetTargetOptions {
  ip: string;
  port?: number;
  useTls?: boolean;
  password?: string;
  configName?: string;
  updateRuntimeStationsTxt?: boolean;
}

/** Escapes a value for safe inclusion in an XML attribute value. */
function xmlAttrEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Sets (or inserts) an attribute on a single self-closing XML element string,
 * preserving every other attribute and the surrounding whitespace verbatim.
 */
function setElementAttr(el: string, name: string, value: string): string {
  const escaped = xmlAttrEscape(value);
  // Require a leading whitespace so e.g. "IP" does not match inside "TCPIP"/"PLCID".
  const re = new RegExp(`(\\s${name}\\s*=\\s*")[^"]*(")`);
  if (re.test(el)) {
    return el.replace(re, (_m, pre: string, post: string) => `${pre}${escaped}${post}`);
  }
  // Not present — insert just before the self-closing '/>'.
  return el.replace(/\s*\/>\s*$/, () => ` ${name}="${escaped}"/>`);
}

export function updateStationConnection(lssPath: string, options: SetTargetOptions): void {
  let content = readLatin1File(lssPath);

  // Surgically edit ONLY the <TCPIP .../> element. The .lss is a hand-edited
  // IDE file; rebuilding the whole document through an XML builder is lossy
  // (it dropped attributes such as LoadAtStartup="true", reflowed indentation
  // from tabs to spaces, and collapsed elements). A targeted string edit keeps
  // the rest of the file byte-for-byte, including its ISO-8859-1 declaration.
  const tcpipRe = /<TCPIP\b[^>]*\/>/;
  const match = content.match(tcpipRe);

  if (match) {
    let el = match[0];
    el = setElementAttr(el, 'IP', options.ip);
    if (options.port !== undefined) el = setElementAttr(el, 'PORT', options.port.toString());
    if (options.useTls !== undefined) el = setElementAttr(el, 'SSLTLS', options.useTls ? '1' : '0');
    if (options.password !== undefined) el = setElementAttr(el, 'Password', options.password);
    if (options.configName !== undefined) el = setElementAttr(el, 'ConfigName', options.configName);
    content = content.replace(tcpipRe, () => el);
  } else {
    // No TCPIP profile yet — synthesize one and place it inside (or create) an
    // <OnlineConnectionInfo> block right after the opening <SlnStation ...> tag.
    const port = options.port !== undefined ? options.port : 1954;
    const tls = options.useTls ? '1' : '0';
    const pwd = xmlAttrEscape(options.password ?? '');
    const cfg = xmlAttrEscape(options.configName ?? '');
    const newTcp = `<TCPIP ConfigName="${cfg}" BUS="3" Password="${pwd}" IP="${xmlAttrEscape(options.ip)}" PORT="${port}" SomeFlags="0" PLCID="" Repeater="0" SSLTLS="${tls}" Favorite="0"/>`;

    if (/<OnlineConnectionInfo\b[^>]*>/.test(content)) {
      content = content.replace(/(<OnlineConnectionInfo\b[^>]*>)/, (_m, open: string) => `${open}\n\t\t${newTcp}`);
    } else if (/<SlnStation\b[^>]*>/.test(content)) {
      content = content.replace(/(<SlnStation\b[^>]*>)/, (_m, open: string) => `${open}\n\t<OnlineConnectionInfo>\n\t\t${newTcp}\n\t</OnlineConnectionInfo>`);
    } else {
      throw new Error(`Invalid station file format in: ${lssPath}`);
    }
  }

  writeLatin1File(lssPath, content);

  // If we should update runtime Stations.txt
  if (options.updateRuntimeStationsTxt) {
    // Look for projects in this station to find where Stations.txt would reside
    const stationInfo = parseStation(lssPath);
    for (const project of stationInfo.projects) {
      if (project.type === 'class2') {
        const projectDir = path.dirname(project.path);
        const stationsTxtPath = path.join(projectDir, 'Network', 'Stations.txt');
        if (fs.existsSync(stationsTxtPath)) {
          updateRuntimeStations(stationsTxtPath, stationInfo.name, options.ip);
        }
      }
    }
  }
}

function updateRuntimeConnectionsContent(content: string, stationName: string, ip: string): string {
  const lines = content.split(/\r?\n/);
  let inConnections = false;
  let updated = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '[CONNECTIONS]') {
      inConnections = true;
      continue;
    }
    if (inConnections && line.startsWith('[')) {
      inConnections = false;
    }
    if (inConnections) {
      // Line is like: "PLC","TCPIP:10.195.0.10",0
      const match = line.match(/^"([^"]+)","TCPIP:[^"]*",(\d+)/);
      if (match && match[1] === stationName) {
        lines[i] = `"${stationName}","TCPIP:${ip}",${match[2]}`;
        updated = true;
        break;
      }
    }
  }

  if (!updated && inConnections) {
    // If not found, append to connections section
    const connIdx = lines.findIndex(l => l.trim() === '[CONNECTIONS]');
    if (connIdx !== -1) {
      lines.splice(connIdx + 1, 0, `"${stationName}","TCPIP:${ip}",0`);
      updated = true;
    }
  }

  return lines.join('\n');
}

function updateRuntimeStations(stationsTxtPath: string, stationName: string, ip: string): void {
  try {
    const content = readLatin1File(stationsTxtPath);
    const updatedContent = updateRuntimeConnectionsContent(content, stationName, ip);
    writeLatin1File(stationsTxtPath, updatedContent);
  } catch (e) {
    // Handle error or log
    console.error(`Failed to update runtime Stations.txt at ${stationsTxtPath}:`, e);
  }
}

export interface LcpFileInfo {
  classes: { name: string; relativePath: string; path: string }[];
  networks: { name: string; relativePath: string; path: string }[];
}

export function parseLcpFile(lcpPath: string): LcpFileInfo {
  const content = readLatin1File(lcpPath);
  const data = parser.parse(content);
  const projectNode = data.Project;
  if (!projectNode) {
    throw new Error(`Invalid LCP file format in: ${lcpPath}`);
  }
  const lcpDir = path.dirname(lcpPath);

  const resolveList = (node: any) => {
    if (!node || !node.File) return [];
    let list = node.File;
    if (!Array.isArray(list)) list = [list];
    return list.map((f: any) => {
      const relPath = f['@_Path'] || f['@_path'] || '';
      const name = path.basename(relPath, path.extname(relPath));
      const absPath = path.resolve(lcpDir, relPath);
      return { name, relativePath: relPath, path: absPath };
    }).filter((f: any) => f.relativePath);
  };

  return {
    classes: resolveList(projectNode.ClassFiles),
    networks: resolveList(projectNode.NetworkFiles)
  };
}

export interface LcnObjectInfo {
  name: string;
  path: string;
  class: string;
  position?: string;
  visualized?: boolean;
  cyclicTime?: string;
  backgroundTime?: string;
  channels: {
    servers: { name: string; value?: string }[];
    clients: { name: string; value?: string }[];
  };
}

export interface LcnConnectionInfo {
  source: string;
  destination: string;
  vertices?: string;
  ioObject?: string;
}

export interface LcnFileInfo {
  name: string;
  objects: LcnObjectInfo[];
  connections: LcnConnectionInfo[];
}

function collectObjectsRecursive(componentsNode: any, parentPath = ''): LcnObjectInfo[] {
  if (!componentsNode || !componentsNode.Object) return [];
  let objects = componentsNode.Object;
  if (!Array.isArray(objects)) objects = [objects];

  const result: LcnObjectInfo[] = [];

  for (const obj of objects) {
    const name = obj['@_Name'] || obj['@_name'] || '';
    if (!name) continue;

    const currentPath = parentPath ? `${parentPath}.${name}` : name;
    
    const servers: { name: string; value?: string }[] = [];
    const clients: { name: string; value?: string }[] = [];

    if (obj.Channels) {
      if (obj.Channels.Server) {
        let serverList = obj.Channels.Server;
        if (!Array.isArray(serverList)) serverList = [serverList];
        for (const s of serverList) {
          const sName = s['@_Name'] || s['@_name'] || '';
          if (sName) {
            servers.push({
              name: sName,
              value: s['@_Value'] || s['@_value']
            });
          }
        }
      }

      if (obj.Channels.Client) {
        let clientList = obj.Channels.Client;
        if (!Array.isArray(clientList)) clientList = [clientList];
        for (const c of clientList) {
          const cName = c['@_Name'] || c['@_name'] || '';
          if (cName) {
            clients.push({
              name: cName,
              value: c['@_Value'] || c['@_value']
            });
          }
        }
      }
    }

    result.push({
      name,
      path: currentPath,
      class: obj['@_Class'] || obj['@_class'] || '',
      position: obj['@_Position'] || obj['@_position'],
      visualized: obj['@_Visualized'] === 'true' || obj['@_visualized'] === 'true',
      cyclicTime: obj['@_CyclicTime'] || obj['@_cyclictime'],
      backgroundTime: obj['@_BackgroundTime'] || obj['@_backgroundtime'],
      channels: { servers, clients }
    });

    if (obj.Networks && obj.Networks.Network) {
      let networks = obj.Networks.Network;
      if (!Array.isArray(networks)) networks = [networks];
      for (const net of networks) {
        if (net.Components) {
          result.push(...collectObjectsRecursive(net.Components, currentPath));
        }
      }
    }
  }

  return result;
}

function collectConnectionsRecursive(networkNode: any, parentPath = ''): LcnConnectionInfo[] {
  const result: LcnConnectionInfo[] = [];

  if (networkNode.Connections && networkNode.Connections.Connection) {
    let connections = networkNode.Connections.Connection;
    if (!Array.isArray(connections)) connections = [connections];
    for (const c of connections) {
      const source = c['@_Source'] || c['@_source'] || '';
      const dest = c['@_Destination'] || c['@_destination'] || '';
      if (source || dest) {
        result.push({
          source: parentPath ? `${parentPath}.${source}` : source,
          destination: parentPath ? `${parentPath}.${dest}` : dest,
          vertices: c['@_Vertices'] || c['@_vertices'],
          ioObject: c['@_IOObject'] || c['@_ioobject']
        });
      }
    }
  }

  if (networkNode.Components && networkNode.Components.Object) {
    let objects = networkNode.Components.Object;
    if (!Array.isArray(objects)) objects = [objects];
    for (const obj of objects) {
      const name = obj['@_Name'] || obj['@_name'] || '';
      if (name && obj.Networks && obj.Networks.Network) {
        const currentPath = parentPath ? `${parentPath}.${name}` : name;
        let networks = obj.Networks.Network;
        if (!Array.isArray(networks)) networks = [networks];
        for (const net of networks) {
          result.push(...collectConnectionsRecursive(net, currentPath));
        }
      }
    }
  }

  return result;
}

export function parseLcnFile(lcnPath: string): LcnFileInfo {
  const content = readLatin1File(lcnPath);
  const data = parser.parse(content);
  const networkNode = data.Network;
  if (!networkNode) {
    throw new Error(`Invalid LCN file format in: ${lcnPath}`);
  }

  const name = networkNode['@_Name'] || networkNode['@_name'] || '';
  const objects = collectObjectsRecursive(networkNode.Components || {});
  const connections = collectConnectionsRecursive(networkNode);

  return {
    name,
    objects,
    connections
  };
}
