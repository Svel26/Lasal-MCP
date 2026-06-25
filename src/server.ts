import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import { discoverToolchain, ToolchainInfo } from './toolchain.js';
import {
  parseSolution,
  parseStation,
  updateStationConnection,
  writeLatin1File
} from './xmlHelper.js';
import {
  generateClass2Script,
  generateVisuScript,
  generateLutc,
  pyStr,
  pyUnicode,
  LutcTarget,
  LutcInstruction
} from './scriptGenerator.js';
import { teardownEngine, runProcess } from './processRunner.js';
import {
  createJob,
  getJob,
  kickoffJob,
  runExclusive,
  getTempFilePath,
  cleanTempFolder
} from './jobRegistry.js';

// Global toolchain info resolved at startup
let toolchain: ToolchainInfo;

// Process-watchdog timeouts (ms). For operations that embed a device-side
// timeout (OS download, reboot), the watchdog is derived from it at the call
// site so we never force-kill the engine mid-operation.
const TIMEOUT = {
  short: 120000,     // run-state change, set connection
  medium: 600000,    // bootdisk, deploy, analyze, file transfer, user scripts
  compile: 1800000,  // RebuildAll on large projects
  publish: 900000    // VISUDesigner publish / deploy
};

const server = new Server(
  {
    name: 'lasal-mcp',
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// Register Tool List
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_toolchain_info',
        description: 'Locate installed LASAL engines and versions.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
      },
      {
        name: 'check_job_status',
        description: 'Poll the status of an asynchronous LASAL engine operation.',
        inputSchema: {
          type: 'object',
          properties: {
            jobId: { type: 'string', description: 'The unique ID of the background job.' }
          },
          required: ['jobId'],
          additionalProperties: false
        }
      },
      {
        name: 'list_solution',
        description: 'Parse a solution .lsm file and its .lss station files into a structured tree.',
        inputSchema: {
          type: 'object',
          properties: {
            solutionPath: { type: 'string', description: 'Absolute path to the .lsm file' }
          },
          required: ['solutionPath'],
          additionalProperties: false
        }
      },
      {
        name: 'get_target_config',
        description: "Read a station's <TCPIP> online connection profile.",
        inputSchema: {
          type: 'object',
          properties: {
            stationLssPath: { type: 'string', description: 'Absolute path to the <station>.lss file' }
          },
          required: ['stationLssPath'],
          additionalProperties: false
        }
      },
      {
        name: 'set_target_ip',
        description: "Write the download/online target IP address and port into a station's .lss profile.",
        inputSchema: {
          type: 'object',
          properties: {
            stationLssPath: { type: 'string', description: 'Absolute path to the <station>.lss file' },
            ip: { type: 'string', pattern: '^(\\d{1,3}\\.){3}\\d{1,3}$|^[A-Za-z0-9.-]+$', description: 'Target IP address or DNS host name' },
            port: { type: 'integer', default: 1954, minimum: 1, maximum: 65535 },
            useTls: { type: 'boolean', default: false },
            password: { type: 'string', default: '' },
            configName: { type: 'string', description: 'Connection profile label (e.g. PLC10)' },
            updateRuntimeStationsTxt: { type: 'boolean', default: false, description: 'If true, also updates Network\\Stations.txt' }
          },
          required: ['stationLssPath', 'ip'],
          additionalProperties: false
        }
      },
      {
        name: 'read_plc_state',
        description: 'Get the state (Run/Stop/Offline) and CPU architecture of a target PLC (Synchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Optional path to .lcp file. If omitted, connectionString is used directly.' },
            connectionString: { type: 'string', description: "Address-book label or 'TCPIP:<ip>[:port]'" }
          },
          required: ['connectionString'],
          additionalProperties: false
        }
      },
      {
        name: 'read_plc_value',
        description: 'Read an Object.Channel value from the PLC (Synchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            connectionString: { type: 'string', description: "Address-book label or 'TCPIP:<ip>[:port]'" },
            name: { type: 'string', description: 'Path to channel, e.g. ObjectName.ChannelName' }
          },
          required: ['connectionString', 'name'],
          additionalProperties: false
        }
      },
      {
        name: 'write_plc_value',
        description: 'Write an Object.Channel value to the PLC (Synchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            connectionString: { type: 'string', description: "Address-book label or 'TCPIP:<ip>[:port]'" },
            name: { type: 'string', description: 'Path to channel, e.g. ObjectName.ChannelName' },
            value: { type: 'string', description: 'The string representation of the value to write' }
          },
          required: ['connectionString', 'name', 'value'],
          additionalProperties: false
        }
      },
      {
        name: 'compile_class2_project',
        description: 'Compile a Class 2 PLC project (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lcp project file' },
            mode: { type: 'string', enum: ['RebuildAll', 'BuildChanges', 'UserClassesOnly'], default: 'RebuildAll' },
            extraOptions: {
              type: 'array',
              items: { type: 'string', enum: ['EraseObjs', 'SuppressRebuild', 'NoDebugInfo', 'NoClearOutput'] },
              default: []
            }
          },
          required: ['projectPath'],
          additionalProperties: false
        }
      },
      {
        name: 'create_class2_bootdisk',
        description: 'Create a PLC bootdisk folder (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lcp project file' },
            outputPath: { type: 'string', description: 'Absolute path to the output directory' },
            platform: { type: 'string', enum: ['AUTO', 'ALL', 'ARM', 'X86'], default: 'AUTO' },
            overwrite: { type: 'boolean', default: true },
            visuPublishFolder: { type: 'string', description: 'Optional Publish folder of a VISUDesigner project to bundle' },
            includeOs: { type: 'string', description: 'Optional path to a LasalOS image (.lbi)' }
          },
          required: ['projectPath', 'outputPath'],
          additionalProperties: false
        }
      },
      {
        name: 'deploy_class2_project',
        description: 'Download a compiled Class 2 project to a live PLC (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lcp project file' },
            connectionString: { type: 'string', description: "Optional target address-book label or 'TCPIP:<ip>[:port]'. If omitted, project connection is used." },
            addLoaderAnyway: { type: 'boolean', default: false },
            startAfter: { type: 'boolean', default: false }
          },
          required: ['projectPath'],
          additionalProperties: false
        }
      },
      {
        name: 'set_plc_run_state',
        description: 'Start or Stop execution of a PLC project on a live target (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lcp project file' },
            connectionString: { type: 'string', description: "Target address-book label or 'TCPIP:<ip>[:port]'" },
            action: { type: 'string', enum: ['start', 'stop'] }
          },
          required: ['connectionString', 'action'],
          additionalProperties: false
        }
      },
      {
        name: 'analyze_class2_code',
        description: 'Perform static code analysis on a Class 2 project or file (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lcp project file' },
            resultFile: { type: 'string', description: 'Absolute path to the output results file' },
            sourceFile: { type: 'string', description: 'Optional absolute path to analyze a single file instead of the whole project' }
          },
          required: ['projectPath', 'resultFile'],
          additionalProperties: false
        }
      },
      {
        name: 'run_class2_script',
        description: 'Execute a custom Python 2.7 automation script using batch API (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            scriptBody: { type: 'string', description: "Python 2.7 script body. 'import sigmatek.lasal.batch as batch' and helper 'to_mbcs()' are auto-imported." },
            args: { type: 'array', items: { type: 'string' }, default: [] }
          },
          required: ['scriptBody'],
          additionalProperties: false
        }
      },
      {
        name: 'publish_visu_project',
        description: 'Publish a VISUDesigner HMI project to Web HMI assets (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lvp file or project directory' },
            debugPublish: { type: 'boolean', default: false }
          },
          required: ['projectPath'],
          additionalProperties: false
        }
      },
      {
        name: 'deploy_visu_project',
        description: 'Publish and download a VISUDesigner HMI project to a live HMI panel (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lvp file or project directory' },
            connectionString: { type: 'string', description: "Target address-book label or 'TCPIP:<ip>[:port]'" },
            mode: { type: 'string', enum: ['full', 'changes', 'publish_and_changes'], default: 'full' },
            addRuntime: { type: 'boolean', default: false }
          },
          required: ['projectPath', 'connectionString'],
          additionalProperties: false
        }
      },
      {
        name: 'set_visu_station_connection',
        description: 'Configure HMI runtime station target settings (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the HMI .lvp file' },
            stationNr: { type: 'integer', description: 'Unique ID of the station to update' },
            connSetting: { type: 'string', description: "HMI connection setting (e.g. 'TCPIP:10.195.0.10')" }
          },
          required: ['projectPath', 'stationNr', 'connSetting'],
          additionalProperties: false
        }
      },
      {
        name: 'run_visu_script',
        description: 'Execute a custom Python 3.12 HMI automation script using lvd API (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            scriptBody: { type: 'string', description: "Python 3.12 script body. 'import sigmatek.lasal.lvd as lvd' is auto-imported." },
            args: { type: 'array', items: { type: 'string' }, default: [] }
          },
          required: ['scriptBody'],
          additionalProperties: false
        }
      },
      {
        name: 'deploy_solution',
        description: 'Deploy multiple stations in a solution using MachineManager (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            solutionPath: { type: 'string', description: 'Absolute path to the solution .lsm file' },
            stations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  target: { type: 'string', description: 'Name of the station in the solution (e.g. PLC)' },
                  kind: { type: 'string', enum: ['class2', 'visudesigner', 'screen'], description: 'Type of station' },
                  artifactPath: { type: 'string', description: 'Absolute path to project file/dir (.lcp, .lvp folder, etc.)' }
                },
                required: ['target', 'kind', 'artifactPath']
              }
            },
            logFolder: { type: 'string', description: 'Directory to place MM logs' },
            holdOnError: { type: 'boolean', default: true },
            rebootAfter: { type: 'boolean', default: false }
          },
          required: ['solutionPath', 'stations', 'logFolder'],
          additionalProperties: false
        }
      },
      {
        name: 'download_os',
        description: 'Download a Sigmatek OS image (.lbi) to a target PLC using MachineManager (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            connectionString: { type: 'string', description: "Target address-book label or 'TCPIP:<ip>[:port]'" },
            osFile: { type: 'string', description: 'Absolute path to the OS .lbi image file' },
            rebootTimeoutMs: { type: 'integer', default: 600000 }
          },
          required: ['connectionString', 'osFile'],
          additionalProperties: false
        }
      },
      {
        name: 'transfer_file',
        description: 'Upload, download, or delete files on a PLC (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            connectionString: { type: 'string', description: "Target address-book label or 'TCPIP:<ip>[:port]'" },
            direction: { type: 'string', enum: ['download', 'upload', 'delete'] },
            localPath: { type: 'string', description: 'Host local path (ignored for delete)' },
            remotePath: { type: 'string', description: 'PLC target file/dir path' }
          },
          required: ['connectionString', 'direction', 'remotePath'],
          additionalProperties: false
        }
      },
      {
        name: 'reboot_target',
        description: 'Reboot a target PLC control (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            connectionString: { type: 'string', description: "Target address-book label or 'TCPIP:<ip>[:port]'" },
            timeoutMs: { type: 'integer', default: 300000 }
          },
          required: ['connectionString'],
          additionalProperties: false
        }
      }
    ]
  };
});

// Tool dispatch handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case 'get_toolchain_info': {
        return { content: [{ type: 'text', text: JSON.stringify(toolchain, null, 2) }] };
      }

      case 'check_job_status': {
        const jobId = args.jobId as string;
        const job = getJob(jobId);
        if (!job) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: [`Job ${jobId} not found.`] }) }]
          };
        }
        return { content: [{ type: 'text', text: JSON.stringify(job, null, 2) }] };
      }

      case 'list_solution': {
        const solutionPath = args.solutionPath as string;
        if (!fs.existsSync(solutionPath)) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: [`Solution file not found: ${solutionPath}`] }) }] };
        }
        const tree = parseSolution(solutionPath);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: tree }) }] };
      }

      case 'get_target_config': {
        const stationLssPath = args.stationLssPath as string;
        if (!fs.existsSync(stationLssPath)) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: [`Station LSS file not found: ${stationLssPath}`] }) }] };
        }
        const config = parseStation(stationLssPath);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: config }) }] };
      }

      case 'set_target_ip': {
        const stationLssPath = args.stationLssPath as string;
        if (!fs.existsSync(stationLssPath)) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: [`Station LSS file not found: ${stationLssPath}`] }) }] };
        }

        // Run on the serialized queue so breaking the IDE's lock cannot kill a
        // job that is mid-flight, then edit the .lss while the lock is clear.
        await runExclusive(async () => {
          await teardownEngine('class2');
          updateStationConnection(stationLssPath, {
            ip: args.ip as string,
            port: args.port as number,
            useTls: args.useTls as boolean,
            password: args.password as string,
            configName: args.configName as string,
            updateRuntimeStationsTxt: args.updateRuntimeStationsTxt as boolean
          });
        });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, engine: 'fs' }) }] };
      }

      case 'read_plc_state': {
        if (!toolchain.class2.installed || !toolchain.class2.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['Lasal CLASS 2 is not installed.'] }) }] };
        }

        const projectPath = args.projectPath as string || '';
        const connectionString = args.connectionString as string;

        // Lasal2.exe is a GUI-subsystem app: its embedded-Python `print` output
        // is discarded (no console is attached), so results MUST be written to a
        // file and read back rather than parsed from stdout.
        const resultPath = getTempFilePath('read-plc-state', '.txt');

        let scriptContent = '';
        if (projectPath) {
          scriptContent += `prj = batch.LoadProject(to_mbcs(${pyUnicode(projectPath)}))\n`;
        } else {
          scriptContent += `prj = None\n`;
        }
        scriptContent += `state = batch.GetPlcState(prj, to_mbcs(${pyUnicode(connectionString)}))\n`;
        scriptContent += `arch = batch.GetProcessorArch(to_mbcs(${pyUnicode(connectionString)}))\n`;
        scriptContent += `__rf = open(to_mbcs(${pyUnicode(resultPath)}), "w")\n`;
        scriptContent += `__rf.write("PLC_STATE:%s\\n" % state)\n`;
        scriptContent += `__rf.write("PLC_ARCH:%s\\n" % arch)\n`;
        scriptContent += `__rf.close()\n`;

        const logPath = getTempFilePath('read-plc-state', '.log');
        const scriptBody = generateClass2Script({ logPath, scriptBody: scriptContent });
        const scriptPath = getTempFilePath('read-plc-state', '.py');
        writeLatin1File(scriptPath, scriptBody);

        // Run synchronously with 15 second timeout
        const exe = toolchain.class2.path;
        const result = await runExclusive(() =>
          runProcess('class2', exe, [`/script:${scriptPath}`], { timeoutMs: 15000 })
        );

        let resultText = '';
        try { resultText = fs.readFileSync(resultPath, 'latin1'); } catch {}

        // Clean up scripts
        try { fs.unlinkSync(scriptPath); } catch {}
        try { fs.unlinkSync(logPath); } catch {}
        try { fs.unlinkSync(resultPath); } catch {}

        if (!result.ok) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: [result.stderr || 'Failed to connect to PLC'] }) }] };
        }

        const stateMatch = resultText.match(/PLC_STATE:(.*)/);
        const archMatch = resultText.match(/PLC_ARCH:(.*)/);
        const stateStr = stateMatch ? stateMatch[1].trim() : 'Unknown';
        const archStr = archMatch ? archMatch[1].trim() : 'Unknown';

        return {
          content: [{ type: 'text', text: JSON.stringify({
            ok: true,
            engine: 'class2',
            data: { plcState: stateStr, arch: archStr }
          }) }]
        };
      }

      case 'read_plc_value': {
        if (!toolchain.class2.installed || !toolchain.class2.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['Lasal CLASS 2 is not installed.'] }) }] };
        }

        const connectionString = args.connectionString as string;
        const name = args.name as string;

        // Results are written to a file and read back: Lasal2.exe (GUI app)
        // discards embedded-Python stdout, so `print` markers never reach us.
        const resultPath = getTempFilePath('read-plc-val', '.txt');

        let scriptContent = '';
        scriptContent += `batch.OpenPlcConnection(None, to_mbcs(${pyUnicode(connectionString)}))\n`;
        scriptContent += `dic = {}\n`;
        scriptContent += `batch.ReadPlcValue(to_mbcs(${pyUnicode(name)}), dic)\n`;
        scriptContent += `batch.ClosePlcConnection()\n`;
        scriptContent += `__v = dic.get('value', '')\n`;
        scriptContent += `__rf = open(to_mbcs(${pyUnicode(resultPath)}), "w")\n`;
        scriptContent += `__rf.write("PLC_VALUE:%s\\n" % __v)\n`;
        scriptContent += `__rf.write("PLC_VALUE_DICT:%r" % (dic,))\n`;
        scriptContent += `__rf.close()\n`;

        const logPath = getTempFilePath('read-plc-val', '.log');
        const scriptBody = generateClass2Script({ logPath, scriptBody: scriptContent });
        const scriptPath = getTempFilePath('read-plc-val', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const exe = toolchain.class2.path;
        const result = await runExclusive(() =>
          runProcess('class2', exe, [`/script:${scriptPath}`], { timeoutMs: 15000 })
        );

        let resultText = '';
        try { resultText = fs.readFileSync(resultPath, 'latin1'); } catch {}

        try { fs.unlinkSync(scriptPath); } catch {}
        try { fs.unlinkSync(logPath); } catch {}
        try { fs.unlinkSync(resultPath); } catch {}

        if (!result.ok) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: [result.stderr || 'Failed to read value'] }) }] };
        }

        const valueMatch = resultText.match(/PLC_VALUE:(.*)/);
        const dictMatch = resultText.match(/PLC_VALUE_DICT:(.*)/);
        const value = valueMatch ? valueMatch[1].trim() : '';
        // The exact dict key from batch.ReadPlcValue is unverified; expose the raw
        // repr so the caller sees the real keys regardless of our 'value' guess.
        const raw = dictMatch ? dictMatch[1].trim() : '';

        return {
          content: [{ type: 'text', text: JSON.stringify({
            ok: true,
            engine: 'class2',
            data: { value, raw }
          }) }]
        };
      }

      case 'write_plc_value': {
        if (!toolchain.class2.installed || !toolchain.class2.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['Lasal CLASS 2 is not installed.'] }) }] };
        }

        const connectionString = args.connectionString as string;
        const name = args.name as string;
        const value = args.value as string;

        let scriptContent = '';
        scriptContent += `batch.OpenPlcConnection(None, to_mbcs(${pyUnicode(connectionString)}))\n`;
        scriptContent += `batch.WritePlcValue(to_mbcs(${pyUnicode(name)}), to_mbcs(${pyUnicode(value)}))\n`;
        scriptContent += `batch.ClosePlcConnection()\n`;

        const logPath = getTempFilePath('write-plc-val', '.log');
        const scriptBody = generateClass2Script({ logPath, scriptBody: scriptContent });
        const scriptPath = getTempFilePath('write-plc-val', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const exe = toolchain.class2.path;
        const result = await runExclusive(() =>
          runProcess('class2', exe, [`/script:${scriptPath}`], { timeoutMs: 15000 })
        );
        
        try { fs.unlinkSync(scriptPath); } catch {}
        try { fs.unlinkSync(logPath); } catch {}

        if (!result.ok) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: [result.stderr || 'Failed to write value'] }) }] };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, engine: 'class2' }) }]
        };
      }

      // ASYNC Class 2 Tools
      case 'compile_class2_project': {
        if (!toolchain.class2.installed || !toolchain.class2.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['Lasal CLASS 2 is not installed.'] }) }] };
        }

        const projectPath = args.projectPath as string;
        const mode = args.mode as string;
        const extraOptions = (args.extraOptions as string[]) || [];

        // Build compile flags
        let optString = `batch.CompileOptions.${mode}`;
        extraOptions.forEach(opt => {
          optString += ` | batch.CompileOptions.${opt}`;
        });

        let scriptContent = '';
        scriptContent += `prj = batch.LoadProject(to_mbcs(${pyUnicode(projectPath)}))\n`;
        scriptContent += `batch.Compile(prj, ${optString})\n`;
        scriptContent += `batch.Save(prj)\n`;
        scriptContent += `batch.CloseProject(prj)\n`;

        const logPath = getTempFilePath('compile', '.log');
        const scriptBody = generateClass2Script({ logPath, scriptBody: scriptContent });
        const scriptPath = getTempFilePath('compile', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const jobId = createJob('class2', `Lasal2.exe /script:${scriptPath}`);
        kickoffJob(jobId, 'class2', toolchain.class2.path, [`/script:${scriptPath}`], { logPath, teardownBefore: 'class2', timeoutMs: TIMEOUT.compile });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'create_class2_bootdisk': {
        if (!toolchain.class2.installed || !toolchain.class2.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['Lasal CLASS 2 is not installed.'] }) }] };
        }

        const projectPath = args.projectPath as string;
        const outputPath = args.outputPath as string;
        const platform = args.platform as string;
        const overwrite = args.overwrite as boolean;
        const visuPublishFolder = args.visuPublishFolder as string || '';
        const includeOs = args.includeOs as string || '';

        // Map platform to platform numbers
        // -1..AUTO, 0..ALL, 1..ARM, 2..X86
        let platNum = -1;
        if (platform === 'ALL') platNum = 0;
        else if (platform === 'ARM') platNum = 1;
        else if (platform === 'X86') platNum = 2;

        let scriptContent = '';
        scriptContent += `prj = batch.LoadProject(to_mbcs(${pyUnicode(projectPath)}))\n`;

        // Use bootdisk manager
        scriptContent += `batch.CreateBootdiskMngr(prj, to_mbcs(${pyUnicode(outputPath)}), ${overwrite ? 'True' : 'False'}, False, 1, True, "", to_mbcs(${pyUnicode(includeOs)}), "", True, ${platNum}, True, to_mbcs(${pyUnicode(visuPublishFolder)}), True)\n`;
        scriptContent += `batch.CloseProject(prj)\n`;

        const logPath = getTempFilePath('bootdisk', '.log');
        const scriptBody = generateClass2Script({ logPath, scriptBody: scriptContent });
        const scriptPath = getTempFilePath('bootdisk', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const jobId = createJob('class2', `Lasal2.exe /script:${scriptPath}`);
        kickoffJob(jobId, 'class2', toolchain.class2.path, [`/script:${scriptPath}`], { logPath, teardownBefore: 'class2', timeoutMs: TIMEOUT.medium });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'deploy_class2_project': {
        if (!toolchain.class2.installed || !toolchain.class2.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['Lasal CLASS 2 is not installed.'] }) }] };
        }

        const projectPath = args.projectPath as string;
        const connectionString = args.connectionString as string || '';
        const addLoaderAnyway = args.addLoaderAnyway as boolean;
        const startAfter = args.startAfter as boolean;

        let scriptContent = '';
        scriptContent += `prj = batch.LoadProject(to_mbcs(${pyUnicode(projectPath)}))\n`;
        scriptContent += `batch.Download(prj, to_mbcs(${pyUnicode(connectionString)}), ${addLoaderAnyway ? 'True' : 'False'})\n`;
        if (startAfter) {
          scriptContent += `batch.Start(prj, to_mbcs(${pyUnicode(connectionString)}))\n`;
        }
        scriptContent += `batch.CloseProject(prj)\n`;

        const logPath = getTempFilePath('deploy-c2', '.log');
        const scriptBody = generateClass2Script({ logPath, scriptBody: scriptContent });
        const scriptPath = getTempFilePath('deploy-c2', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const jobId = createJob('class2', `Lasal2.exe /script:${scriptPath}`);
        kickoffJob(jobId, 'class2', toolchain.class2.path, [`/script:${scriptPath}`], { logPath, teardownBefore: 'class2', timeoutMs: TIMEOUT.medium });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'set_plc_run_state': {
        if (!toolchain.class2.installed || !toolchain.class2.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['Lasal CLASS 2 is not installed.'] }) }] };
        }

        const projectPath = args.projectPath as string || '';
        const connectionString = args.connectionString as string;
        const action = args.action as string;

        let scriptContent = '';
        if (projectPath) {
          scriptContent += `prj = batch.LoadProject(to_mbcs(${pyUnicode(projectPath)}))\n`;
        } else {
          scriptContent += `prj = None\n`;
        }

        if (action === 'start') {
          scriptContent += `batch.Start(prj, to_mbcs(${pyUnicode(connectionString)}))\n`;
        } else {
          scriptContent += `batch.Stop(prj, to_mbcs(${pyUnicode(connectionString)}))\n`;
        }

        if (projectPath) {
          scriptContent += `batch.CloseProject(prj)\n`;
        }

        const logPath = getTempFilePath('runstate', '.log');
        const scriptBody = generateClass2Script({ logPath, scriptBody: scriptContent });
        const scriptPath = getTempFilePath('runstate', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const jobId = createJob('class2', `Lasal2.exe /script:${scriptPath}`);
        kickoffJob(jobId, 'class2', toolchain.class2.path, [`/script:${scriptPath}`], { logPath, teardownBefore: 'class2', timeoutMs: TIMEOUT.short });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'analyze_class2_code': {
        if (!toolchain.class2.installed || !toolchain.class2.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['Lasal CLASS 2 is not installed.'] }) }] };
        }

        const projectPath = args.projectPath as string;
        const resultFile = args.resultFile as string;
        const sourceFile = args.sourceFile as string || '';

        let scriptContent = '';
        scriptContent += `prj = batch.LoadProject(to_mbcs(${pyUnicode(projectPath)}))\n`;
        if (sourceFile) {
          scriptContent += `batch.DoCodeAnalysisOnFile(prj, to_mbcs(${pyUnicode(sourceFile)}), to_mbcs(${pyUnicode(resultFile)}))\n`;
        } else {
          scriptContent += `batch.DoCodeAnalysisOnProjekt(prj, to_mbcs(${pyUnicode(resultFile)}))\n`;
        }
        scriptContent += `batch.CloseProject(prj)\n`;

        const logPath = getTempFilePath('analysis', '.log');
        const scriptBody = generateClass2Script({ logPath, scriptBody: scriptContent });
        const scriptPath = getTempFilePath('analysis', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const jobId = createJob('class2', `Lasal2.exe /script:${scriptPath}`);
        kickoffJob(jobId, 'class2', toolchain.class2.path, [`/script:${scriptPath}`], { logPath, teardownBefore: 'class2', timeoutMs: TIMEOUT.medium });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'run_class2_script': {
        if (!toolchain.class2.installed || !toolchain.class2.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['Lasal CLASS 2 is not installed.'] }) }] };
        }

        const scriptBody = args.scriptBody as string;
        const scriptArgs = (args.args as string[]) || [];

        const logPath = getTempFilePath('user-c2', '.log');
        const scriptContent = generateClass2Script({ logPath, scriptBody });
        const scriptPath = getTempFilePath('user-c2', '.py');
        writeLatin1File(scriptPath, scriptContent);

        const jobId = createJob('class2', `Lasal2.exe /script:${scriptPath}`);
        kickoffJob(jobId, 'class2', toolchain.class2.path, [`/script:${scriptPath}`, ...scriptArgs], { logPath, teardownBefore: 'class2', timeoutMs: TIMEOUT.medium });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      // ASYNC VISUDesigner HMI Tools
      case 'publish_visu_project': {
        if (!toolchain.visudesigner.installed || !toolchain.visudesigner.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['VISUDesigner is not installed.'] }) }] };
        }

        const projectPath = args.projectPath as string;
        const debugPublish = args.debugPublish as boolean;

        let scriptContent = '';
        scriptContent += `prj = lvd.LoadProject(${pyStr(projectPath)})\n`;
        scriptContent += `lvd.PublishProject(prj, ${debugPublish ? 'True' : 'False'})\n`;
        scriptContent += `lvd.CloseProject(prj)\n`;

        const scriptBody = generateVisuScript({ scriptBody: scriptContent });
        const scriptPath = getTempFilePath('publish', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const jobId = createJob('visudesigner', `VISUDesigner.exe --script ${scriptPath}`);
        kickoffJob(jobId, 'visudesigner', toolchain.visudesigner.path, ['--script', scriptPath], { teardownBefore: 'visudesigner', timeoutMs: TIMEOUT.publish });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'deploy_visu_project': {
        if (!toolchain.visudesigner.installed || !toolchain.visudesigner.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['VISUDesigner is not installed.'] }) }] };
        }

        const projectPath = args.projectPath as string;
        const connectionString = args.connectionString as string;
        const mode = args.mode as string;
        const addRuntime = args.addRuntime as boolean;

        // Map mode to uiFlags
        // 0 -> Normal download, 1 -> Download changes, 2 -> Publish and download changes
        let uiFlags = 0;
        if (mode === 'changes') uiFlags = 1;
        else if (mode === 'publish_and_changes') uiFlags = 2;

        let scriptContent = '';
        scriptContent += `prj = lvd.LoadProject(${pyStr(projectPath)})\n`;
        scriptContent += `lvd.DownloadProject(prj, ${pyStr(connectionString)}, ${uiFlags}, ${addRuntime ? 'True' : 'False'})\n`;
        scriptContent += `lvd.CloseProject(prj)\n`;

        const scriptBody = generateVisuScript({ scriptBody: scriptContent });
        const scriptPath = getTempFilePath('deploy-visu', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const jobId = createJob('visudesigner', `VISUDesigner.exe --script ${scriptPath}`);
        kickoffJob(jobId, 'visudesigner', toolchain.visudesigner.path, ['--script', scriptPath], { teardownBefore: 'visudesigner', timeoutMs: TIMEOUT.publish });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'set_visu_station_connection': {
        if (!toolchain.visudesigner.installed || !toolchain.visudesigner.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['VISUDesigner is not installed.'] }) }] };
        }

        const projectPath = args.projectPath as string;
        const stationNr = args.stationNr as number;
        const connSetting = args.connSetting as string;

        let scriptContent = '';
        scriptContent += `prj = lvd.LoadProject(${pyStr(projectPath)})\n`;
        scriptContent += `lvd.SetStationProperties(prj, lvd.Station.ConnectionSet(${stationNr}, ${pyStr(connSetting)}))\n`;
        scriptContent += `lvd.SaveProject(prj)\n`;
        scriptContent += `lvd.CloseProject(prj)\n`;

        const scriptBody = generateVisuScript({ scriptBody: scriptContent });
        const scriptPath = getTempFilePath('visu-conn', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const jobId = createJob('visudesigner', `VISUDesigner.exe --script ${scriptPath}`);
        kickoffJob(jobId, 'visudesigner', toolchain.visudesigner.path, ['--script', scriptPath], { teardownBefore: 'visudesigner', timeoutMs: TIMEOUT.short });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'run_visu_script': {
        if (!toolchain.visudesigner.installed || !toolchain.visudesigner.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['VISUDesigner is not installed.'] }) }] };
        }

        const scriptBody = args.scriptBody as string;
        const scriptArgs = (args.args as string[]) || [];

        const scriptContent = generateVisuScript({ scriptBody });
        const scriptPath = getTempFilePath('user-visu', '.py');
        writeLatin1File(scriptPath, scriptContent);

        const jobId = createJob('visudesigner', `VISUDesigner.exe --script ${scriptPath}`);
        kickoffJob(jobId, 'visudesigner', toolchain.visudesigner.path, ['--script', scriptPath, ...scriptArgs], { teardownBefore: 'visudesigner', timeoutMs: TIMEOUT.medium });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      // ASYNC MachineManager Tools
      case 'deploy_solution': {
        if (!toolchain.machinemanager.installed || !toolchain.machinemanager.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['MachineManager is not installed.'] }) }] };
        }

        const solutionPath = args.solutionPath as string;
        const inputStations = args.stations as any[];
        const logFolder = args.logFolder as string;
        const rebootAfter = args.rebootAfter as boolean;
        const holdOnError = args.holdOnError as boolean;

        // Parse solution first to retrieve connection information
        const solution = parseSolution(solutionPath);

        const targets: LutcTarget[] = [];
        const instructions: LutcInstruction[] = [];

        inputStations.forEach((st, idx) => {
          const solutionStation = solution.stations.find(ss => ss.name.toLowerCase() === st.target.toLowerCase());
          if (!solutionStation || !solutionStation.connectionInfo) {
            throw new Error(`Station ${st.target} has no connection settings in solution: ${solutionPath}`);
          }
          
          targets.push({
            stationName: st.target,
            ip: solutionStation.connectionInfo.ip || '127.0.0.1',
            port: solutionStation.connectionInfo.port || 1954,
            useTls: solutionStation.connectionInfo.useTls
          });

          const kind = st.kind as string;
          if (kind === 'class2') {
            instructions.push({
              type: 'DwnLdLC2',
              targetId: idx,
              params: [st.artifactPath]
            });
            instructions.push({
              type: 'PrjRun',
              targetId: idx,
              params: []
            });
          } else if (kind === 'visudesigner') {
            instructions.push({
              type: 'DwnLdLVD',
              targetId: idx,
              params: [st.artifactPath]
            });
          } else if (kind === 'screen') {
            instructions.push({
              type: 'DwnLdLSE',
              targetId: idx,
              params: [st.artifactPath]
            });
            instructions.push({
              type: 'PrjRun',
              targetId: idx,
              params: []
            });
          }

          if (rebootAfter) {
            instructions.push({
              type: 'Boot',
              targetId: idx,
              params: ['300000']
            });
          }
        });

        const lutcXml = generateLutc(targets, instructions);
        const lutcPath = getTempFilePath('deploy-sol', '.lutc');
        writeLatin1File(lutcPath, lutcXml);

        // Allow generous wall time: downloads plus any per-station reboot waits.
        const deployTimeout = TIMEOUT.compile + (rebootAfter ? 300000 * inputStations.length : 0);

        const jobId = createJob('machinemanager', `MachineManager.exe /update:${lutcPath}`);
        kickoffJob(jobId, 'machinemanager', toolchain.machinemanager.path, [`/update:${lutcPath}`], {
          logFolderToScan: logFolder,
          teardownBefore: 'ide',
          timeoutMs: deployTimeout
        });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'download_os': {
        if (!toolchain.machinemanager.installed || !toolchain.machinemanager.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['MachineManager is not installed.'] }) }] };
        }

        const connectionString = args.connectionString as string;
        const osFile = args.osFile as string;
        const rebootTimeoutMs = args.rebootTimeoutMs as number;

        // Create target matching connectionString
        let ip = '127.0.0.1';
        let port = 1954;
        const match = connectionString.match(/TCPIP:([^:]+)(?::(\d+))?/i);
        if (match) {
          ip = match[1];
          if (match[2]) port = parseInt(match[2], 10);
        } else {
          ip = connectionString;
        }

        const target: LutcTarget = { stationName: 'TargetPLC', ip, port, useTls: false };
        const inst: LutcInstruction = {
          type: 'DwnLdOS',
          targetId: 0,
          params: [osFile, rebootTimeoutMs.toString()]
        };

        const lutcXml = generateLutc([target], [inst]);
        const lutcPath = getTempFilePath('download-os', '.lutc');
        writeLatin1File(lutcPath, lutcXml);

        const jobId = createJob('machinemanager', `MachineManager.exe /update:${lutcPath}`);
        kickoffJob(jobId, 'machinemanager', toolchain.machinemanager.path, [`/update:${lutcPath}`], {
          teardownBefore: 'ide',
          timeoutMs: rebootTimeoutMs + 300000 // flash + reboot must finish before the watchdog fires
        });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'transfer_file': {
        if (!toolchain.machinemanager.installed || !toolchain.machinemanager.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['MachineManager is not installed.'] }) }] };
        }

        const connectionString = args.connectionString as string;
        const direction = args.direction as string;
        const localPath = args.localPath as string || '';
        const remotePath = args.remotePath as string;

        let ip = '127.0.0.1';
        let port = 1954;
        const match = connectionString.match(/TCPIP:([^:]+)(?::(\d+))?/i);
        if (match) {
          ip = match[1];
          if (match[2]) port = parseInt(match[2], 10);
        } else {
          ip = connectionString;
        }

        const target: LutcTarget = { stationName: 'TargetPLC', ip, port, useTls: false };
        let instType: LutcInstruction['type'] = 'DwnLdFile';
        const params: string[] = [];

        if (direction === 'download') {
          instType = 'DwnLdFile';
          params.push(localPath, remotePath);
        } else if (direction === 'upload') {
          instType = 'UpLdFile';
          params.push(remotePath, localPath);
        } else if (direction === 'delete') {
          instType = 'DelFile';
          params.push(remotePath);
        }

        const inst: LutcInstruction = {
          type: instType,
          targetId: 0,
          params
        };

        const lutcXml = generateLutc([target], [inst]);
        const lutcPath = getTempFilePath('file-transfer', '.lutc');
        writeLatin1File(lutcPath, lutcXml);

        const jobId = createJob('machinemanager', `MachineManager.exe /update:${lutcPath}`);
        kickoffJob(jobId, 'machinemanager', toolchain.machinemanager.path, [`/update:${lutcPath}`], {
          teardownBefore: 'ide',
          timeoutMs: TIMEOUT.medium
        });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'reboot_target': {
        if (!toolchain.machinemanager.installed || !toolchain.machinemanager.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['MachineManager is not installed.'] }) }] };
        }

        const connectionString = args.connectionString as string;
        const timeoutMs = args.timeoutMs as number;

        let ip = '127.0.0.1';
        let port = 1954;
        const match = connectionString.match(/TCPIP:([^:]+)(?::(\d+))?/i);
        if (match) {
          ip = match[1];
          if (match[2]) port = parseInt(match[2], 10);
        } else {
          ip = connectionString;
        }

        const target: LutcTarget = { stationName: 'TargetPLC', ip, port, useTls: false };
        const inst: LutcInstruction = {
          type: 'Boot',
          targetId: 0,
          params: [timeoutMs.toString()]
        };

        const lutcXml = generateLutc([target], [inst]);
        const lutcPath = getTempFilePath('reboot', '.lutc');
        writeLatin1File(lutcPath, lutcXml);

        const jobId = createJob('machinemanager', `MachineManager.exe /update:${lutcPath}`);
        kickoffJob(jobId, 'machinemanager', toolchain.machinemanager.path, [`/update:${lutcPath}`], {
          teardownBefore: 'ide',
          timeoutMs: timeoutMs + 120000 // reboot wait must finish before the watchdog fires
        });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (err: any) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: [err.message] }) }],
      isError: true
    };
  }
});

// Main startup function
async function main() {
  // Discover toolchain info
  toolchain = await discoverToolchain();

  // Clear previous temp logs
  cleanTempFolder();

  // Connect Transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Sigmatek LASAL MCP Server successfully started via Stdio Transport.');
}

main().catch(err => {
  console.error('Fatal server error:', err);
  process.exit(1);
});
