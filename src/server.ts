import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';
import { discoverToolchain, ToolchainInfo } from './toolchain.js';
import {
  parseSolution,
  parseStation,
  updateStationConnection,
  writeLatin1File,
  parseLcpFile,
  parseLcnFile
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
import { spawn } from 'child_process';
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
      },
      {
        name: 'list_class2_networks',
        description: 'Get a list of all networks defined in a LASAL Class 2 project (Offline / Synchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lcp project file' }
          },
          required: ['projectPath'],
          additionalProperties: false
        }
      },
      {
        name: 'list_class2_classes',
        description: 'Get a list of all classes referenced in a LASAL Class 2 project (Offline / Synchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lcp project file' }
          },
          required: ['projectPath'],
          additionalProperties: false
        }
      },
      {
        name: 'list_class2_objects',
        description: 'Get all objects, their coordinates, visualized status, and channels within a Class 2 network (Offline / Synchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lcp project file' },
            networkName: { type: 'string', description: 'Name of the network or absolute path to its .lcn file' }
          },
          required: ['projectPath', 'networkName'],
          additionalProperties: false
        }
      },
      {
        name: 'list_class2_connections',
        description: 'Get client-to-server channel connections defined within a Class 2 network (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lcp project file' },
            networkName: { type: 'string', description: 'Name of the network or absolute path to its .lcn file' }
          },
          required: ['projectPath', 'networkName'],
          additionalProperties: false
        }
      },
      {
        name: 'create_class2_object',
        description: 'Instantiate a class object into a Class 2 network at a specific position (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lcp project file' },
            networkName: { type: 'string', description: 'Name of the destination network' },
            className: { type: 'string', description: 'Name of the class to instantiate' },
            objectName: { type: 'string', description: 'Name of the new object' },
            xPos: { type: 'integer', description: 'X-coordinate in network graphic view' },
            yPos: { type: 'integer', description: 'Y-coordinate in network graphic view' },
            isVisualized: { type: 'boolean', default: false, description: 'Visualized status flag' }
          },
          required: ['projectPath', 'networkName', 'className', 'objectName', 'xPos', 'yPos'],
          additionalProperties: false
        }
      },
      {
        name: 'delete_class2_object',
        description: 'Delete an object from a Class 2 network (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lcp project file' },
            networkName: { type: 'string', description: 'Name of the network' },
            objectName: { type: 'string', description: 'Name of the object to delete' },
            deleteConnection: { type: 'boolean', default: true, description: 'Whether to delete its connected lines' }
          },
          required: ['projectPath', 'networkName', 'objectName'],
          additionalProperties: false
        }
      },
      {
        name: 'create_class2_connection',
        description: 'Connect a client channel to a server channel in a Class 2 project (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lcp project file' },
            sourceNetwork: { type: 'string', default: '', description: 'Source client network (empty for global search)' },
            sourceObject: { type: 'string', description: 'Source object name containing the client' },
            sourceClient: { type: 'string', description: 'Source client channel name' },
            targetNetwork: { type: 'string', default: '', description: 'Destination server network (empty for global search)' },
            targetObject: { type: 'string', description: 'Destination object name containing the server' },
            targetServer: { type: 'string', description: 'Destination server channel name' }
          },
          required: ['projectPath', 'sourceObject', 'sourceClient', 'targetObject', 'targetServer'],
          additionalProperties: false
        }
      },
      {
        name: 'delete_class2_connection',
        description: 'Disconnect a client channel in a Class 2 project (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lcp project file' },
            networkName: { type: 'string', default: '', description: 'Network containing the object' },
            objectName: { type: 'string', description: 'Object name containing the client' },
            clientName: { type: 'string', description: 'Client channel to disconnect' }
          },
          required: ['projectPath', 'objectName', 'clientName'],
          additionalProperties: false
        }
      },
      {
        name: 'set_class2_init_value',
        description: 'Set the initial value of an object channel in a Class 2 project (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lcp project file' },
            networkName: { type: 'string', default: '', description: 'Optional network containing the object' },
            objectName: { type: 'string', description: 'Name of the object' },
            channelName: { type: 'string', description: 'Name of the channel' },
            value: { type: 'string', description: 'Initial value representation' }
          },
          required: ['projectPath', 'objectName', 'channelName', 'value'],
          additionalProperties: false
        }
      },
      {
        name: 'set_class2_parameter_value',
        description: 'Set the parameter value of an object in a Class 2 project (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lcp project file' },
            networkName: { type: 'string', description: 'Name of the network' },
            objectName: { type: 'string', description: 'Name of the object' },
            parameterName: { type: 'string', description: 'Name of the parameter' },
            value: { type: 'string', description: 'New parameter value' }
          },
          required: ['projectPath', 'networkName', 'objectName', 'parameterName', 'value'],
          additionalProperties: false
        }
      },
      {
        name: 'create_class2_io_label',
        description: 'Create an IO label / connection manager element in a Class 2 project (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lcp project file' },
            ioName: { type: 'string', description: 'Name of the IO label' },
            svrObject: { type: 'string', default: '', description: 'Server object name' },
            svrChannel: { type: 'string', default: '', description: 'Server channel name' },
            cltObject: { type: 'string', default: '', description: 'Client object name' },
            cltChannel: { type: 'string', default: '', description: 'Client channel name' }
          },
          required: ['projectPath', 'ioName'],
          additionalProperties: false
        }
      },
      {
        name: 'change_class2_io_server',
        description: 'Change the server connection of matching IO labels in a Class 2 project (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lcp project file' },
            ioName: { type: 'string', description: 'Name of the IO label' },
            svrObject: { type: 'string', default: '', description: 'New server object name' },
            svrChannel: { type: 'string', default: '', description: 'New server channel name' }
          },
          required: ['projectPath', 'ioName'],
          additionalProperties: false
        }
      },
      {
        name: 'list_visu_stations',
        description: 'List HMI stations defined in a VISUDesigner HMI project (Offline / Synchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lvp file or VISUDesigner project folder' }
          },
          required: ['projectPath'],
          additionalProperties: false
        }
      },
      {
        name: 'list_visu_alarms',
        description: 'List HMI alarms configured in a VISUDesigner HMI project (Offline / Synchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lvp file or VISUDesigner project folder' }
          },
          required: ['projectPath'],
          additionalProperties: false
        }
      },
      {
        name: 'set_visu_station_properties',
        description: 'Modify settings and connections for HMI stations (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lvp file' },
            stationNr: { type: 'integer', description: 'Station ID number' },
            properties: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'HMI station name' },
                connection: { type: 'string', description: 'Target setting, e.g. INTERN, LOCAL, GLOBAL, or IP' },
                importFilePath: { type: 'string', description: 'Relative path to MaeExp.xml' },
                observe: { type: 'boolean', description: 'Observe online status' },
                retry: { type: 'string', enum: ['High', 'Medium', 'Standard', 'Low', 'None'] },
                label: { type: 'string', description: 'Display label' },
                revision: { type: 'string', description: 'Revision value' },
                isActive: { type: 'boolean', description: 'Whether the station is active' },
                isRequired: { type: 'boolean', description: 'Whether the station is required' }
              },
              additionalProperties: false,
              description: 'Key-value properties to update'
            }
          },
          required: ['projectPath', 'stationNr', 'properties'],
          additionalProperties: false
        }
      },
      {
        name: 'add_visu_alarm',
        description: 'Add an alarm configuration to a VISUDesigner HMI project (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lvp file' },
            alarmName: { type: 'string', description: 'Unique name of the alarm' },
            serverOrGroup: { type: 'string', description: 'Alarm server name or group number' },
            revision: { type: 'string', description: 'Revision string' }
          },
          required: ['projectPath', 'alarmName'],
          additionalProperties: false
        }
      },
      {
        name: 'remove_visu_alarm',
        description: 'Remove an alarm from a VISUDesigner HMI project (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lvp file' },
            alarmName: { type: 'string', description: 'Name of the alarm to remove' }
          },
          required: ['projectPath', 'alarmName'],
          additionalProperties: false
        }
      },
      {
        name: 'add_visu_text_list',
        description: 'Add a text list and its text translations to a VISUDesigner HMI project (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lvp file' },
            textListName: { type: 'string', description: 'Name of the text list to add' },
            textElements: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Text element ID' },
                  language: { type: 'string', description: 'Optional language code' },
                  text: { type: 'string', description: 'Optional translation text' }
                },
                required: ['name']
              },
              description: 'Array of translations'
            },
            revision: { type: 'string', description: 'Revision string' }
          },
          required: ['projectPath', 'textListName', 'textElements'],
          additionalProperties: false
        }
      },
      {
        name: 'remove_visu_text_list',
        description: 'Remove a text list from a VISUDesigner HMI project (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lvp file' },
            textListName: { type: 'string', description: 'Name of the text list to remove' }
          },
          required: ['projectPath', 'textListName'],
          additionalProperties: false
        }
      },
      {
        name: 'csv_export_visu_texts',
        description: 'Export HMI text lists to a CSV file (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lvp file' },
            filePath: { type: 'string', description: 'Path to export the CSV file' },
            textLists: { type: 'array', items: { type: 'string' }, description: 'Optional list of text list names' },
            languages: { type: 'array', items: { type: 'string' }, description: 'Optional list of language names' }
          },
          required: ['projectPath', 'filePath'],
          additionalProperties: false
        }
      },
      {
        name: 'csv_import_visu_texts',
        description: 'Import HMI text lists from CSV files (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lvp file' },
            filePaths: { type: 'array', items: { type: 'string' }, description: 'List of CSV file paths to import' },
            textLists: { type: 'array', items: { type: 'string' }, description: 'Optional list of text list names' },
            languages: { type: 'array', items: { type: 'string' }, description: 'Optional list of language names' }
          },
          required: ['projectPath', 'filePaths'],
          additionalProperties: false
        }
      },
      {
        name: 'add_visu_languages',
        description: 'Configure and add languages to a VISUDesigner HMI project (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lvp file' },
            languages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  langCode: { type: 'string', description: 'Language code' },
                  property: { type: 'string', description: 'Optional property name' },
                  value: { type: 'string', description: 'Optional value' }
                },
                required: ['langCode']
              },
              description: 'Array of language objects'
            }
          },
          required: ['projectPath', 'languages'],
          additionalProperties: false
        }
      },
      {
        name: 'remove_visu_languages',
        description: 'Remove languages from a VISUDesigner HMI project (Asynchronous).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lvp file' },
            languages: { type: 'array', items: { type: 'string' }, description: 'List of language codes to remove' }
          },
          required: ['projectPath', 'languages'],
          additionalProperties: false
        }
      },
      {
        name: 'snapshot_project',
        description: 'Create a timestamped backup copy of a project directory next to the original. Call this before any destructive change. Works for both Class 2 (.lcp) and VISUDesigner (.lvp) projects. (Synchronous)',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .lcp/.lvp file or project directory' },
            label: { type: 'string', description: 'Optional short label appended to the snapshot folder name for easy identification' }
          },
          required: ['projectPath'],
          additionalProperties: false
        }
      },
      {
        name: 'open_class2_project',
        description: 'Open the LASAL Class 2 IDE (Lasal2.exe) in GUI mode, optionally loading a project. Note: all async Class 2 tools automatically close the GUI before running their headless script, so you only need to call this when you want the IDE visible for user interaction or GUI-driven automation. (Synchronous, fire-and-forget)',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Optional absolute path to the .lcp file to open. If omitted, Lasal2 starts without a project.' }
          },
          additionalProperties: false
        }
      },
      {
        name: 'close_class2_project',
        description: 'Force-close the LASAL Class 2 IDE (Lasal2.exe) if it is running. Async tools do this automatically, but call this explicitly when you need the IDE closed before a direct file edit or snapshot. (Synchronous)',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false
        }
      },
      {
        name: 'open_visu_project',
        description: 'Open the VISUDesigner IDE in GUI mode, optionally loading a project. Note: all async VISUDesigner tools automatically close the IDE before running their headless script. (Synchronous, fire-and-forget)',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Optional absolute path to the .lvp file or project directory to open.' }
          },
          additionalProperties: false
        }
      },
      {
        name: 'close_visu_project',
        description: 'Force-close the VISUDesigner IDE if it is running. (Synchronous)',
        inputSchema: {
          type: 'object',
          properties: {},
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

        const errFilePath = resultFile + '.err';
        let scriptContent = '';
        scriptContent += `import traceback\n`;
        scriptContent += `__prj = None\n`;
        scriptContent += `try:\n`;
        scriptContent += `    __prj = batch.LoadProject(to_mbcs(${pyUnicode(projectPath)}))\n`;
        if (sourceFile) {
          scriptContent += `    batch.DoCodeAnalysisOnFile(__prj, to_mbcs(${pyUnicode(sourceFile)}), to_mbcs(${pyUnicode(resultFile)}))\n`;
        } else {
          scriptContent += `    batch.DoCodeAnalysisOnProjekt(__prj, to_mbcs(${pyUnicode(resultFile)}))\n`;
        }
        scriptContent += `except Exception as __e:\n`;
        scriptContent += `    __ef = open(to_mbcs(${pyUnicode(errFilePath)}), 'w')\n`;
        scriptContent += `    traceback.print_exc(file=__ef)\n`;
        scriptContent += `    __ef.close()\n`;
        scriptContent += `finally:\n`;
        scriptContent += `    if __prj is not None:\n`;
        scriptContent += `        batch.CloseProject(__prj)\n`;

        const logPath = getTempFilePath('analysis', '.log');
        const scriptBody = generateClass2Script({ logPath, scriptBody: scriptContent });
        const scriptPath = getTempFilePath('analysis', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const analysisDataExtractor = (_result: any) => {
          if (fs.existsSync(errFilePath)) {
            const errMsg = fs.readFileSync(errFilePath, 'utf8');
            try { fs.unlinkSync(errFilePath); } catch {}
            throw new Error(`Code analysis failed: ${errMsg.trim()}`);
          }
          return { resultFile, written: fs.existsSync(resultFile) };
        };

        const jobId = createJob('class2', `Lasal2.exe /script:${scriptPath}`);
        kickoffJob(jobId, 'class2', toolchain.class2.path, [`/script:${scriptPath}`], { logPath, teardownBefore: 'class2', timeoutMs: TIMEOUT.medium, dataExtractor: analysisDataExtractor });

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

      // OFFLINE Class 2 Query Tools
      case 'list_class2_networks': {
        const projectPath = args.projectPath as string;
        if (!fs.existsSync(projectPath)) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: [`Project file not found: ${projectPath}`] }) }] };
        }
        const result = parseLcpFile(projectPath);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: result.networks }) }] };
      }

      case 'list_class2_classes': {
        const projectPath = args.projectPath as string;
        if (!fs.existsSync(projectPath)) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: [`Project file not found: ${projectPath}`] }) }] };
        }
        const result = parseLcpFile(projectPath);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: result.classes }) }] };
      }

      case 'list_class2_objects': {
        const projectPath = args.projectPath as string;
        const networkName = args.networkName as string;
        if (!fs.existsSync(projectPath)) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: [`Project file not found: ${projectPath}`] }) }] };
        }
        try {
          const networkPath = resolveNetworkPath(projectPath, networkName);
          const result = parseLcnFile(networkPath);
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: result.objects }) }] };
        } catch (e: any) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: [e.message] }) }] };
        }
      }

      case 'list_class2_connections': {
        if (!toolchain.class2.installed || !toolchain.class2.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['Lasal CLASS 2 is not installed.'] }) }] };
        }

        const projectPath = args.projectPath as string;
        const networkName = args.networkName as string;
        if (!fs.existsSync(projectPath)) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: [`Project file not found: ${projectPath}`] }) }] };
        }

        try {
          const networkPath = resolveNetworkPath(projectPath, networkName);
          const lcnInfo = parseLcnFile(networkPath);

          // Collect all client channels, mapping inherited channels from base classes (_base) to the top-level objects,
          // and excluding nested composed objects to prevent GetClientConnection C++ reflection engine crashes.
          const queryMap = new Map<string, Set<string>>();
          for (const obj of lcnInfo.objects) {
            const parts = obj.path.split('.');
            const topLevelName = parts[0];
            const isBase = parts.slice(1).every(part => part === '_base');
            if (isBase) {
              if (!queryMap.has(topLevelName)) {
                queryMap.set(topLevelName, new Set<string>());
              }
              const clientSet = queryMap.get(topLevelName)!;
              for (const clt of obj.channels.clients) {
                clientSet.add(clt.name);
              }
            }
          }

          const queries: { objPath: string; clientName: string }[] = [];
          for (const [topLevelName, clients] of queryMap.entries()) {
            for (const clientName of clients) {
              queries.push({
                objPath: topLevelName,
                clientName
              });
            }
          }

          if (queries.length === 0) {
            return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: [] }) }] };
          }

          const inputJsonPath = getTempFilePath('queries-in', '.json');
          const outputJsonPath = getTempFilePath('queries-out', '.json');
          fs.writeFileSync(inputJsonPath, JSON.stringify(queries), 'utf8');

          let scriptContent = '';
          scriptContent += `import json\n`;
          scriptContent += `import traceback\n`;
          scriptContent += `input_path = to_mbcs(${pyUnicode(inputJsonPath)})\n`;
          scriptContent += `output_path = to_mbcs(${pyUnicode(outputJsonPath)})\n`;
          scriptContent += `project_path = to_mbcs(${pyUnicode(projectPath)})\n`;
          scriptContent += `network_name = to_mbcs(${pyUnicode(networkName)})\n`;
          scriptContent += `try:\n`;
          scriptContent += `    with open(input_path, 'r') as f:\n`;
          scriptContent += `        queries = json.load(f)\n`;
          scriptContent += `    prj = batch.LoadProject(project_path)\n`;
          scriptContent += `    results = []\n`;
          scriptContent += `    for q in queries:\n`;
          scriptContent += `        obj_path = to_mbcs(q['objPath'])\n`;
          scriptContent += `        client_name = to_mbcs(q['clientName'])\n`;
          scriptContent += `        try:\n`;
          scriptContent += `            conn = batch.GetClientConnection(prj, obj_path, client_name, network_name)\n`;
          scriptContent += `            if conn:\n`;
          scriptContent += `                src_path = obj_path.replace('\\\\', '.') + '.' + client_name\n`;
          scriptContent += `                dest_path = conn.replace('\\\\', '.')\n`;
          scriptContent += `                results.append({'source': src_path, 'destination': dest_path})\n`;
          scriptContent += `        except Exception as inner_e:\n`;
          scriptContent += `            pass\n`;
          scriptContent += `    batch.CloseProject(prj)\n`;
          scriptContent += `    with open(output_path, 'w') as f:\n`;
          scriptContent += `        json.dump(results, f)\n`;
          scriptContent += `except Exception as e:\n`;
          scriptContent += `    with open(output_path + '.err', 'w') as f:\n`;
          scriptContent += `        traceback.print_exc(file=f)\n`;

          const logPath = getTempFilePath('list-conn', '.log');
          const scriptBody = generateClass2Script({ logPath, scriptBody: scriptContent });
          const scriptPath = getTempFilePath('list-conn', '.py');
          writeLatin1File(scriptPath, scriptBody);

          const dataExtractor = (result: any) => {
            try {
              const errPath = outputJsonPath + '.err';
              if (fs.existsSync(errPath)) {
                const errMsg = fs.readFileSync(errPath, 'utf8');
                try { fs.unlinkSync(errPath); } catch {}
                try { fs.unlinkSync(inputJsonPath); } catch {}
                throw new Error(`Python execution error:\n${errMsg}`);
              }
              if (fs.existsSync(outputJsonPath)) {
                const content = fs.readFileSync(outputJsonPath, 'utf8');
                const parsed = JSON.parse(content);
                // clean up
                if (fs.existsSync(inputJsonPath)) fs.unlinkSync(inputJsonPath);
                if (fs.existsSync(outputJsonPath)) fs.unlinkSync(outputJsonPath);
                return parsed;
              }
            } catch (e: any) {
              console.error('Failed to read connections query output:', e);
              throw e;
            } finally {
              if (fs.existsSync(inputJsonPath)) {
                try { fs.unlinkSync(inputJsonPath); } catch {}
              }
            }
            return [];
          };

          const jobId = createJob('class2', `Lasal2.exe /script:${scriptPath}`);
          kickoffJob(jobId, 'class2', toolchain.class2.path, [`/script:${scriptPath}`], {
            logPath,
            teardownBefore: 'class2',
            timeoutMs: TIMEOUT.medium,
            dataExtractor
          });

          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
        } catch (e: any) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: [e.message] }) }] };
        }
      }

      // ASYNC Class 2 Modification Tools
      case 'create_class2_object': {
        if (!toolchain.class2.installed || !toolchain.class2.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['Lasal CLASS 2 is not installed.'] }) }] };
        }
        const projectPath = args.projectPath as string;
        const networkName = args.networkName as string;
        const className = args.className as string;
        const objectName = args.objectName as string;
        const xPos = args.xPos as number;
        const yPos = args.yPos as number;
        const isVisualized = args.isVisualized as boolean || false;

        let scriptContent = `prj = batch.LoadProject(to_mbcs(${pyUnicode(projectPath)}))\n`;
        scriptContent += `batch.CreateObject(prj, to_mbcs(${pyUnicode(networkName)}), to_mbcs(${pyUnicode(className)}), to_mbcs(${pyUnicode(objectName)}), ${xPos}, ${yPos}, ${isVisualized ? 'True' : 'False'})\n`;
        scriptContent += `batch.Save(prj)\n`;
        scriptContent += `batch.CloseProject(prj)\n`;

        const logPath = getTempFilePath('create-obj', '.log');
        const scriptBody = generateClass2Script({ logPath, scriptBody: scriptContent });
        const scriptPath = getTempFilePath('create-obj', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const jobId = createJob('class2', `Lasal2.exe /script:${scriptPath}`);
        kickoffJob(jobId, 'class2', toolchain.class2.path, [`/script:${scriptPath}`], { logPath, teardownBefore: 'class2', timeoutMs: TIMEOUT.medium });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'delete_class2_object': {
        if (!toolchain.class2.installed || !toolchain.class2.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['Lasal CLASS 2 is not installed.'] }) }] };
        }
        const projectPath = args.projectPath as string;
        const networkName = args.networkName as string;
        const objectName = args.objectName as string;
        const deleteConnection = args.deleteConnection !== undefined ? (args.deleteConnection as boolean) : true;

        let scriptContent = `prj = batch.LoadProject(to_mbcs(${pyUnicode(projectPath)}))\n`;
        scriptContent += `batch.DeleteObject(prj, to_mbcs(${pyUnicode(networkName)}), to_mbcs(${pyUnicode(objectName)}), ${deleteConnection ? 'True' : 'False'})\n`;
        scriptContent += `batch.Save(prj)\n`;
        scriptContent += `batch.CloseProject(prj)\n`;

        const logPath = getTempFilePath('delete-obj', '.log');
        const scriptBody = generateClass2Script({ logPath, scriptBody: scriptContent });
        const scriptPath = getTempFilePath('delete-obj', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const jobId = createJob('class2', `Lasal2.exe /script:${scriptPath}`);
        kickoffJob(jobId, 'class2', toolchain.class2.path, [`/script:${scriptPath}`], { logPath, teardownBefore: 'class2', timeoutMs: TIMEOUT.medium });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'create_class2_connection': {
        if (!toolchain.class2.installed || !toolchain.class2.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['Lasal CLASS 2 is not installed.'] }) }] };
        }
        const projectPath = args.projectPath as string;
        const sourceNetwork = args.sourceNetwork as string || '';
        const sourceObject = args.sourceObject as string;
        const sourceClient = args.sourceClient as string;
        const targetNetwork = args.targetNetwork as string || '';
        const targetObject = args.targetObject as string;
        const targetServer = args.targetServer as string;

        let scriptContent = `prj = batch.LoadProject(to_mbcs(${pyUnicode(projectPath)}))\n`;
        scriptContent += `batch.CreateConnection(prj, to_mbcs(${pyUnicode(sourceNetwork)}), to_mbcs(${pyUnicode(sourceObject)}), to_mbcs(${pyUnicode(sourceClient)}), to_mbcs(${pyUnicode(targetNetwork)}), to_mbcs(${pyUnicode(targetObject)}), to_mbcs(${pyUnicode(targetServer)}))\n`;
        scriptContent += `batch.Save(prj)\n`;
        scriptContent += `batch.CloseProject(prj)\n`;

        const logPath = getTempFilePath('create-conn', '.log');
        const scriptBody = generateClass2Script({ logPath, scriptBody: scriptContent });
        const scriptPath = getTempFilePath('create-conn', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const jobId = createJob('class2', `Lasal2.exe /script:${scriptPath}`);
        kickoffJob(jobId, 'class2', toolchain.class2.path, [`/script:${scriptPath}`], { logPath, teardownBefore: 'class2', timeoutMs: TIMEOUT.medium });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'delete_class2_connection': {
        if (!toolchain.class2.installed || !toolchain.class2.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['Lasal CLASS 2 is not installed.'] }) }] };
        }
        const projectPath = args.projectPath as string;
        const networkName = args.networkName as string || '';
        const objectName = args.objectName as string;
        const clientName = args.clientName as string;

        let scriptContent = `prj = batch.LoadProject(to_mbcs(${pyUnicode(projectPath)}))\n`;
        scriptContent += `batch.DeleteConnection(prj, to_mbcs(${pyUnicode(networkName)}), to_mbcs(${pyUnicode(objectName)}), to_mbcs(${pyUnicode(clientName)}))\n`;
        scriptContent += `batch.Save(prj)\n`;
        scriptContent += `batch.CloseProject(prj)\n`;

        const logPath = getTempFilePath('delete-conn', '.log');
        const scriptBody = generateClass2Script({ logPath, scriptBody: scriptContent });
        const scriptPath = getTempFilePath('delete-conn', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const jobId = createJob('class2', `Lasal2.exe /script:${scriptPath}`);
        kickoffJob(jobId, 'class2', toolchain.class2.path, [`/script:${scriptPath}`], { logPath, teardownBefore: 'class2', timeoutMs: TIMEOUT.medium });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'set_class2_init_value': {
        if (!toolchain.class2.installed || !toolchain.class2.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['Lasal CLASS 2 is not installed.'] }) }] };
        }
        const projectPath = args.projectPath as string;
        const networkName = args.networkName as string || '';
        const objectName = args.objectName as string;
        const channelName = args.channelName as string;
        const value = args.value as string;

        let scriptContent = `prj = batch.LoadProject(to_mbcs(${pyUnicode(projectPath)}))\n`;
        scriptContent += `batch.SetInitValue(prj, to_mbcs(${pyUnicode(networkName)}), to_mbcs(${pyUnicode(objectName)}), to_mbcs(${pyUnicode(channelName)}), to_mbcs(${pyUnicode(value)}))\n`;
        scriptContent += `batch.Save(prj)\n`;
        scriptContent += `batch.CloseProject(prj)\n`;

        const logPath = getTempFilePath('init-val', '.log');
        const scriptBody = generateClass2Script({ logPath, scriptBody: scriptContent });
        const scriptPath = getTempFilePath('init-val', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const jobId = createJob('class2', `Lasal2.exe /script:${scriptPath}`);
        kickoffJob(jobId, 'class2', toolchain.class2.path, [`/script:${scriptPath}`], { logPath, teardownBefore: 'class2', timeoutMs: TIMEOUT.medium });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'set_class2_parameter_value': {
        if (!toolchain.class2.installed || !toolchain.class2.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['Lasal CLASS 2 is not installed.'] }) }] };
        }
        const projectPath = args.projectPath as string;
        const networkName = args.networkName as string;
        const objectName = args.objectName as string;
        const parameterName = args.parameterName as string;
        const value = args.value as string;

        let scriptContent = `prj = batch.LoadProject(to_mbcs(${pyUnicode(projectPath)}))\n`;
        scriptContent += `batch.SetParameterValue(prj, to_mbcs(${pyUnicode(networkName)}), to_mbcs(${pyUnicode(objectName)}), to_mbcs(${pyUnicode(parameterName)}), to_mbcs(${pyUnicode(value)}))\n`;
        scriptContent += `batch.Save(prj)\n`;
        scriptContent += `batch.CloseProject(prj)\n`;

        const logPath = getTempFilePath('param-val', '.log');
        const scriptBody = generateClass2Script({ logPath, scriptBody: scriptContent });
        const scriptPath = getTempFilePath('param-val', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const jobId = createJob('class2', `Lasal2.exe /script:${scriptPath}`);
        kickoffJob(jobId, 'class2', toolchain.class2.path, [`/script:${scriptPath}`], { logPath, teardownBefore: 'class2', timeoutMs: TIMEOUT.medium });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'create_class2_io_label': {
        if (!toolchain.class2.installed || !toolchain.class2.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['Lasal CLASS 2 is not installed.'] }) }] };
        }
        const projectPath = args.projectPath as string;
        const ioName = args.ioName as string;
        const svrObject = args.svrObject as string || '';
        const svrChannel = args.svrChannel as string || '';
        const cltObject = args.cltObject as string || '';
        const cltChannel = args.cltChannel as string || '';

        let scriptContent = `prj = batch.LoadProject(to_mbcs(${pyUnicode(projectPath)}))\n`;
        scriptContent += `batch.CreateLabel(prj, to_mbcs(${pyUnicode(ioName)}), to_mbcs(${pyUnicode(svrObject)}), to_mbcs(${pyUnicode(svrChannel)}), to_mbcs(${pyUnicode(cltObject)}), to_mbcs(${pyUnicode(cltChannel)}))\n`;
        scriptContent += `batch.Save(prj)\n`;
        scriptContent += `batch.CloseProject(prj)\n`;

        const logPath = getTempFilePath('create-label', '.log');
        const scriptBody = generateClass2Script({ logPath, scriptBody: scriptContent });
        const scriptPath = getTempFilePath('create-label', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const jobId = createJob('class2', `Lasal2.exe /script:${scriptPath}`);
        kickoffJob(jobId, 'class2', toolchain.class2.path, [`/script:${scriptPath}`], { logPath, teardownBefore: 'class2', timeoutMs: TIMEOUT.medium });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'change_class2_io_server': {
        if (!toolchain.class2.installed || !toolchain.class2.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['Lasal CLASS 2 is not installed.'] }) }] };
        }
        const projectPath = args.projectPath as string;
        const ioName = args.ioName as string;
        const svrObject = args.svrObject as string || '';
        const svrChannel = args.svrChannel as string || '';

        let scriptContent = `prj = batch.LoadProject(to_mbcs(${pyUnicode(projectPath)}))\n`;
        scriptContent += `batch.ChangeIOServer(prj, to_mbcs(${pyUnicode(ioName)}), to_mbcs(${pyUnicode(svrObject)}), to_mbcs(${pyUnicode(svrChannel)}))\n`;
        scriptContent += `batch.Save(prj)\n`;
        scriptContent += `batch.CloseProject(prj)\n`;

        const logPath = getTempFilePath('change-label', '.log');
        const scriptBody = generateClass2Script({ logPath, scriptBody: scriptContent });
        const scriptPath = getTempFilePath('change-label', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const jobId = createJob('class2', `Lasal2.exe /script:${scriptPath}`);
        kickoffJob(jobId, 'class2', toolchain.class2.path, [`/script:${scriptPath}`], { logPath, teardownBefore: 'class2', timeoutMs: TIMEOUT.medium });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      // OFFLINE VISUDesigner Query Tools
      case 'list_visu_stations': {
        const projectPath = args.projectPath as string;
        if (!fs.existsSync(projectPath)) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: [`Project file/folder not found: ${projectPath}`] }) }] };
        }
        try {
          const dir = getVisuProjectDir(projectPath);
          const stationsJsonPath = path.join(dir, 'Stations', 'Stations.json');
          if (!fs.existsSync(stationsJsonPath)) {
            return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: [] }) }] };
          }
          const content = fs.readFileSync(stationsJsonPath, 'latin1');
          const data = JSON.parse(content);
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: data.stations || [] }) }] };
        } catch (e: any) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: [e.message] }) }] };
        }
      }

      case 'list_visu_alarms': {
        const projectPath = args.projectPath as string;
        if (!fs.existsSync(projectPath)) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: [`Project file/folder not found: ${projectPath}`] }) }] };
        }
        try {
          const dir = getVisuProjectDir(projectPath);
          const alarmJsonPath = path.join(dir, 'Alarms', 'Alarm.json');
          if (!fs.existsSync(alarmJsonPath)) {
            return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: [] }) }] };
          }
          const content = fs.readFileSync(alarmJsonPath, 'latin1');
          const data = JSON.parse(content);
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: data }) }] };
        } catch (e: any) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: [e.message] }) }] };
        }
      }

      // ASYNC VISUDesigner Modification Tools
      case 'set_visu_station_properties': {
        if (!toolchain.visudesigner.installed || !toolchain.visudesigner.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['VISUDesigner is not installed.'] }) }] };
        }
        const projectPath = args.projectPath as string;
        const stationNr = args.stationNr as number;
        const properties = args.properties as any;

        let scriptContent = `prj = lvd.LoadProject(${pyStr(projectPath)})\n`;
        const propSets: string[] = [];
        if (properties.name !== undefined) propSets.push(`lvd.Station.NameSet(${stationNr}, ${pyStr(properties.name)})`);
        if (properties.connection !== undefined) propSets.push(`lvd.Station.ConnectionSet(${stationNr}, ${pyStr(properties.connection)})`);
        if (properties.importFilePath !== undefined) propSets.push(`lvd.Station.ImportPathSet(${stationNr}, ${pyStr(properties.importFilePath)})`);
        if (properties.observe !== undefined) propSets.push(`lvd.Station.ObserveSet(${stationNr}, ${properties.observe ? 'True' : 'False'})`);
        if (properties.retry !== undefined) propSets.push(`lvd.Station.RetrySet(${stationNr}, ${pyStr(properties.retry)})`);
        if (properties.label !== undefined) propSets.push(`lvd.Station.LabelSet(${stationNr}, ${pyStr(properties.label)})`);
        if (properties.revision !== undefined) propSets.push(`lvd.Station.RevisionSet(${stationNr}, ${pyStr(properties.revision)})`);
        if (properties.isActive !== undefined) propSets.push(`lvd.Station.ActiveSet(${stationNr}, ${properties.isActive ? 'True' : 'False'})`);
        if (properties.isRequired !== undefined) propSets.push(`lvd.Station.RequiredSet(${stationNr}, ${properties.isRequired ? 'True' : 'False'})`);

        if (propSets.length > 0) {
          scriptContent += `lvd.SetStationProperties(prj, [${propSets.join(', ')}])\n`;
          scriptContent += `lvd.SaveProject(prj)\n`;
        }
        scriptContent += `lvd.CloseProject(prj)\n`;

        const scriptBody = generateVisuScript({ scriptBody: scriptContent });
        const scriptPath = getTempFilePath('set-visu-prop', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const jobId = createJob('visudesigner', `VISUDesigner.exe --script ${scriptPath}`);
        kickoffJob(jobId, 'visudesigner', toolchain.visudesigner.path, ['--script', scriptPath], { teardownBefore: 'visudesigner', timeoutMs: TIMEOUT.publish });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'add_visu_alarm': {
        if (!toolchain.visudesigner.installed || !toolchain.visudesigner.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['VISUDesigner is not installed.'] }) }] };
        }
        const projectPath = args.projectPath as string;
        const alarmName = args.alarmName as string;
        const serverOrGroup = args.serverOrGroup as string | number | undefined;
        const revision = args.revision as string | undefined;

        let scriptContent = `prj = lvd.LoadProject(${pyStr(projectPath)})\n`;
        let groupVal = 'None';
        if (serverOrGroup !== undefined) {
          groupVal = typeof serverOrGroup === 'number' ? `${serverOrGroup}` : pyStr(serverOrGroup);
        }
        const revVal = revision !== undefined ? pyStr(revision) : 'None';
        scriptContent += `lvd.AddAlarms(prj, lvd.Alarm(${pyStr(alarmName)}, ${groupVal}, ${revVal}))\n`;
        scriptContent += `lvd.SaveProject(prj)\n`;
        scriptContent += `lvd.CloseProject(prj)\n`;

        const scriptBody = generateVisuScript({ scriptBody: scriptContent });
        const scriptPath = getTempFilePath('add-alarm', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const jobId = createJob('visudesigner', `VISUDesigner.exe --script ${scriptPath}`);
        kickoffJob(jobId, 'visudesigner', toolchain.visudesigner.path, ['--script', scriptPath], { teardownBefore: 'visudesigner', timeoutMs: TIMEOUT.publish });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'remove_visu_alarm': {
        if (!toolchain.visudesigner.installed || !toolchain.visudesigner.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['VISUDesigner is not installed.'] }) }] };
        }
        const projectPath = args.projectPath as string;
        const alarmName = args.alarmName as string;

        let scriptContent = `prj = lvd.LoadProject(${pyStr(projectPath)})\n`;
        scriptContent += `lvd.RemoveAlarms(prj, ${pyStr(alarmName)})\n`;
        scriptContent += `lvd.SaveProject(prj)\n`;
        scriptContent += `lvd.CloseProject(prj)\n`;

        const scriptBody = generateVisuScript({ scriptBody: scriptContent });
        const scriptPath = getTempFilePath('rem-alarm', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const jobId = createJob('visudesigner', `VISUDesigner.exe --script ${scriptPath}`);
        kickoffJob(jobId, 'visudesigner', toolchain.visudesigner.path, ['--script', scriptPath], { teardownBefore: 'visudesigner', timeoutMs: TIMEOUT.publish });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'add_visu_text_list': {
        if (!toolchain.visudesigner.installed || !toolchain.visudesigner.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['VISUDesigner is not installed.'] }) }] };
        }
        const projectPath = args.projectPath as string;
        const textListName = args.textListName as string;
        const textElements = args.textElements as any[];
        const revision = args.revision as string | undefined;

        let scriptContent = `prj = lvd.LoadProject(${pyStr(projectPath)})\n`;
        const elList = textElements.map((el: any) => {
          const lang = el.language !== undefined ? pyStr(el.language) : 'None';
          const text = el.text !== undefined ? pyStr(el.text) : 'None';
          return `lvd.TextElement(${pyStr(el.name)}, ${lang}, ${text})`;
        });
        const rev = revision !== undefined ? pyStr(revision) : 'None';
        scriptContent += `lvd.AddTextLists(prj, lvd.TextList(${pyStr(textListName)}, [${elList.join(', ')}], ${rev}))\n`;
        scriptContent += `lvd.SaveProject(prj)\n`;
        scriptContent += `lvd.CloseProject(prj)\n`;

        const scriptBody = generateVisuScript({ scriptBody: scriptContent });
        const scriptPath = getTempFilePath('add-txt-list', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const jobId = createJob('visudesigner', `VISUDesigner.exe --script ${scriptPath}`);
        kickoffJob(jobId, 'visudesigner', toolchain.visudesigner.path, ['--script', scriptPath], { teardownBefore: 'visudesigner', timeoutMs: TIMEOUT.publish });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'remove_visu_text_list': {
        if (!toolchain.visudesigner.installed || !toolchain.visudesigner.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['VISUDesigner is not installed.'] }) }] };
        }
        const projectPath = args.projectPath as string;
        const textListName = args.textListName as string;

        let scriptContent = `prj = lvd.LoadProject(${pyStr(projectPath)})\n`;
        scriptContent += `lvd.RemoveTextLists(prj, ${pyStr(textListName)})\n`;
        scriptContent += `lvd.SaveProject(prj)\n`;
        scriptContent += `lvd.CloseProject(prj)\n`;

        const scriptBody = generateVisuScript({ scriptBody: scriptContent });
        const scriptPath = getTempFilePath('rem-txt-list', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const jobId = createJob('visudesigner', `VISUDesigner.exe --script ${scriptPath}`);
        kickoffJob(jobId, 'visudesigner', toolchain.visudesigner.path, ['--script', scriptPath], { teardownBefore: 'visudesigner', timeoutMs: TIMEOUT.publish });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'csv_export_visu_texts': {
        if (!toolchain.visudesigner.installed || !toolchain.visudesigner.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['VISUDesigner is not installed.'] }) }] };
        }
        const projectPath = args.projectPath as string;
        const filePath = args.filePath as string;
        const textLists = args.textLists as string[] | undefined;
        const languages = args.languages as string[] | undefined;

        let scriptContent = `prj = lvd.LoadProject(${pyStr(projectPath)})\n`;
        const tLists = textLists !== undefined ? `[${textLists.map(pyStr).join(', ')}]` : 'None';
        const lList = languages !== undefined ? `[${languages.map(pyStr).join(', ')}]` : 'None';
        scriptContent += `lvd.CsvExportTextLists(prj, ${pyStr(filePath)}, ${tLists}, ${lList})\n`;
        scriptContent += `lvd.CloseProject(prj)\n`;

        const scriptBody = generateVisuScript({ scriptBody: scriptContent });
        const scriptPath = getTempFilePath('csv-exp-visu', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const jobId = createJob('visudesigner', `VISUDesigner.exe --script ${scriptPath}`);
        kickoffJob(jobId, 'visudesigner', toolchain.visudesigner.path, ['--script', scriptPath], { teardownBefore: 'visudesigner', timeoutMs: TIMEOUT.publish });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'csv_import_visu_texts': {
        if (!toolchain.visudesigner.installed || !toolchain.visudesigner.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['VISUDesigner is not installed.'] }) }] };
        }
        const projectPath = args.projectPath as string;
        const filePaths = args.filePaths as any;
        const textLists = args.textLists as string[] | undefined;
        const languages = args.languages as string[] | undefined;

        let scriptContent = `prj = lvd.LoadProject(${pyStr(projectPath)})\n`;
        const fList = Array.isArray(filePaths) ? `[${filePaths.map(pyStr).join(', ')}]` : pyStr(filePaths);
        const tLists = textLists !== undefined ? `[${textLists.map(pyStr).join(', ')}]` : 'None';
        const lList = languages !== undefined ? `[${languages.map(pyStr).join(', ')}]` : 'None';
        scriptContent += `lvd.CsvImportTextLists(prj, ${fList}, ${tLists}, ${lList})\n`;
        scriptContent += `lvd.SaveProject(prj)\n`;
        scriptContent += `lvd.CloseProject(prj)\n`;

        const scriptBody = generateVisuScript({ scriptBody: scriptContent });
        const scriptPath = getTempFilePath('csv-imp-visu', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const jobId = createJob('visudesigner', `VISUDesigner.exe --script ${scriptPath}`);
        kickoffJob(jobId, 'visudesigner', toolchain.visudesigner.path, ['--script', scriptPath], { teardownBefore: 'visudesigner', timeoutMs: TIMEOUT.publish });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'add_visu_languages': {
        if (!toolchain.visudesigner.installed || !toolchain.visudesigner.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['VISUDesigner is not installed.'] }) }] };
        }
        const projectPath = args.projectPath as string;
        const languages = args.languages as any[];

        let scriptContent = `prj = lvd.LoadProject(${pyStr(projectPath)})\n`;
        const langArgs = languages.map((l: any) => {
          if (typeof l === 'string') {
            return pyStr(l);
          } else {
            const prop = l.property !== undefined ? pyStr(l.property) : 'None';
            const val = l.value !== undefined ? pyStr(l.value) : 'None';
            return `lvd.Language(${pyStr(l.langCode)}, ${prop}, ${val})`;
          }
        });
        scriptContent += `lvd.AddLanguages(prj, [${langArgs.join(', ')}])\n`;
        scriptContent += `lvd.SaveProject(prj)\n`;
        scriptContent += `lvd.CloseProject(prj)\n`;

        const scriptBody = generateVisuScript({ scriptBody: scriptContent });
        const scriptPath = getTempFilePath('add-lang', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const jobId = createJob('visudesigner', `VISUDesigner.exe --script ${scriptPath}`);
        kickoffJob(jobId, 'visudesigner', toolchain.visudesigner.path, ['--script', scriptPath], { teardownBefore: 'visudesigner', timeoutMs: TIMEOUT.publish });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'remove_visu_languages': {
        if (!toolchain.visudesigner.installed || !toolchain.visudesigner.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['VISUDesigner is not installed.'] }) }] };
        }
        const projectPath = args.projectPath as string;
        const languages = args.languages as string[];

        let scriptContent = `prj = lvd.LoadProject(${pyStr(projectPath)})\n`;
        scriptContent += `lvd.RemoveLanguages(prj, [${languages.map(pyStr).join(', ')}])\n`;
        scriptContent += `lvd.SaveProject(prj)\n`;
        scriptContent += `lvd.CloseProject(prj)\n`;

        const scriptBody = generateVisuScript({ scriptBody: scriptContent });
        const scriptPath = getTempFilePath('rem-lang', '.py');
        writeLatin1File(scriptPath, scriptBody);

        const jobId = createJob('visudesigner', `VISUDesigner.exe --script ${scriptPath}`);
        kickoffJob(jobId, 'visudesigner', toolchain.visudesigner.path, ['--script', scriptPath], { teardownBefore: 'visudesigner', timeoutMs: TIMEOUT.publish });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'pending', jobId }) }] };
      }

      case 'snapshot_project': {
        const projectPath = args.projectPath as string;
        const label = args.label as string | undefined;

        if (!fs.existsSync(projectPath)) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: [`Path not found: ${projectPath}`] }) }] };
        }

        const projectDir = fs.statSync(projectPath).isDirectory() ? projectPath : path.dirname(projectPath);
        const parentDir = path.dirname(projectDir);
        const dirName = path.basename(projectDir);

        const now = new Date();
        const ts = now.getFullYear().toString() +
          String(now.getMonth() + 1).padStart(2, '0') +
          String(now.getDate()).padStart(2, '0') + '_' +
          String(now.getHours()).padStart(2, '0') +
          String(now.getMinutes()).padStart(2, '0') +
          String(now.getSeconds()).padStart(2, '0');

        const snapshotBase = path.join(parentDir, '_Snapshots');
        const snapshotName = label ? `${dirName}_${ts}_${label}` : `${dirName}_${ts}`;
        const snapshotDest = path.join(snapshotBase, snapshotName);

        fs.mkdirSync(snapshotBase, { recursive: true });
        fs.cpSync(projectDir, snapshotDest, { recursive: true });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, snapshotPath: snapshotDest }) }] };
      }

      case 'open_class2_project': {
        if (!toolchain.class2.installed || !toolchain.class2.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['Lasal CLASS 2 is not installed.'] }) }] };
        }
        const projectPath = args.projectPath as string | undefined;
        const cliArgs = projectPath ? [projectPath] : [];
        const proc = spawn(toolchain.class2.path, cliArgs, {
          detached: true,
          stdio: 'ignore',
          windowsHide: false
        });
        proc.unref();
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, pid: proc.pid }) }] };
      }

      case 'close_class2_project': {
        await teardownEngine('class2');
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
      }

      case 'open_visu_project': {
        if (!toolchain.visudesigner.installed || !toolchain.visudesigner.path) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['VISUDesigner is not installed.'] }) }] };
        }
        const projectPath = args.projectPath as string | undefined;
        const cliArgs = projectPath ? [projectPath] : [];
        const proc = spawn(toolchain.visudesigner.path, cliArgs, {
          detached: true,
          stdio: 'ignore',
          windowsHide: false
        });
        proc.unref();
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, pid: proc.pid }) }] };
      }

      case 'close_visu_project': {
        await teardownEngine('visudesigner');
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
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

function resolveNetworkPath(projectPath: string, networkName: string): string {
  if (fs.existsSync(networkName) && networkName.toLowerCase().endsWith('.lcn')) {
    return networkName;
  }
  const lcpInfo = parseLcpFile(projectPath);
  const matched = lcpInfo.networks.find(
    n => n.name.toLowerCase() === networkName.toLowerCase() ||
         n.relativePath.toLowerCase().includes(networkName.toLowerCase())
  );
  if (!matched) {
    throw new Error(`Network '${networkName}' not found in project: ${projectPath}`);
  }
  return matched.path;
}

function getVisuProjectDir(projectPath: string): string {
  if (fs.statSync(projectPath).isDirectory()) {
    return projectPath;
  }
  return path.dirname(projectPath);
}

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
