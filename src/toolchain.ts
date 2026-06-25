import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

export interface EngineInfo {
  installed: boolean;
  path: string | null;
  version: string | null;
}

export interface ToolchainInfo {
  class2: EngineInfo;
  visudesigner: EngineInfo;
  machinemanager: EngineInfo;
  lars: EngineInfo;
}

const DEFAULT_PATHS = {
  class2: 'C:\\Program Files (x86)\\Sigmatek\\Lasal\\Class2\\Bin\\Lasal2.exe',
  visudesigner: 'C:\\Program Files\\Sigmatek\\Lasal\\VISUDesigner\\VISUDesigner.exe',
  machinemanager: 'C:\\Program Files (x86)\\Sigmatek\\Lasal\\MachineManager\\Bin\\MachineManager.exe',
  lars: 'C:\\Program Files (x86)\\Sigmatek\\Lars\\Lars.exe'
};

async function checkFileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function queryRegistry(key: string, valueName: string): Promise<string | null> {
  try {
    const { stdout } = await execPromise(`reg query "${key}" /v "${valueName}"`);
    // Output format is usually:
    // HKEY_LOCAL_MACHINE\SOFTWARE\...
    //     valueName    REG_SZ    C:\path\to\install
    const lines = stdout.split('\n');
    for (const line of lines) {
      if (line.includes(valueName)) {
        const parts = line.trim().split(/\s{2,}/);
        if (parts.length >= 3) {
          return parts[2];
        }
      }
    }
  } catch (e) {
    // Registry query failed (key/value does not exist or access error)
  }
  return null;
}

async function getFileVersion(filePath: string): Promise<string | null> {
  try {
    // On Windows, we can use PowerShell to get the file version info
    const escapedPath = filePath.replace(/"/g, '`"');
    const { stdout } = await execPromise(
      `powershell -NoProfile -Command "(Get-Item '${escapedPath}').VersionInfo.FileVersion"`
    );
    const ver = stdout.trim();
    return ver || null;
  } catch {
    return null;
  }
}

export async function discoverToolchain(): Promise<ToolchainInfo> {
  const result: ToolchainInfo = {
    class2: { installed: false, path: null, version: null },
    visudesigner: { installed: false, path: null, version: null },
    machinemanager: { installed: false, path: null, version: null },
    lars: { installed: false, path: null, version: null }
  };

  // 1. Check CLASS 2
  let class2Path = DEFAULT_PATHS.class2;
  if (!(await checkFileExists(class2Path))) {
    // Fallback: check registry
    const regPath = await queryRegistry('HKLM\\SOFTWARE\\WOW6432Node\\Sigmatek\\LASAL CLASS 2', 'InstallDir');
    if (regPath) {
      const candidate = path.join(regPath, 'Bin', 'Lasal2.exe');
      if (await checkFileExists(candidate)) {
        class2Path = candidate;
      }
    }
  }
  if (await checkFileExists(class2Path)) {
    result.class2.installed = true;
    result.class2.path = class2Path;
    result.class2.version = await getFileVersion(class2Path);
  }

  // 2. Check VISUDesigner
  let visuPath = DEFAULT_PATHS.visudesigner;
  if (!(await checkFileExists(visuPath))) {
    const regPath = await queryRegistry('HKLM\\SOFTWARE\\Sigmatek\\LASAL VISUDesigner', 'InstallDir');
    if (regPath) {
      const candidate = path.join(regPath, 'VISUDesigner.exe');
      if (await checkFileExists(candidate)) {
        visuPath = candidate;
      }
    }
  }
  if (await checkFileExists(visuPath)) {
    result.visudesigner.installed = true;
    result.visudesigner.path = visuPath;
    result.visudesigner.version = await getFileVersion(visuPath);
  }

  // 3. Check MachineManager
  let mmPath = DEFAULT_PATHS.machinemanager;
  if (!(await checkFileExists(mmPath))) {
    const regPath = await queryRegistry('HKLM\\SOFTWARE\\WOW6432Node\\Sigmatek\\LASAL MachineManager', 'InstallDir');
    if (regPath) {
      const candidate = path.join(regPath, 'Bin', 'MachineManager.exe');
      if (await checkFileExists(candidate)) {
        mmPath = candidate;
      }
    }
  }
  if (await checkFileExists(mmPath)) {
    result.machinemanager.installed = true;
    result.machinemanager.path = mmPath;
    result.machinemanager.version = await getFileVersion(mmPath);
  }

  // 4. Check LARS
  let larsPath = DEFAULT_PATHS.lars;
  if (!(await checkFileExists(larsPath))) {
    const regPath = await queryRegistry('HKLM\\SOFTWARE\\WOW6432Node\\Sigmatek\\LARS', 'InstallDir');
    if (regPath) {
      const candidate = path.join(regPath, 'Lars.exe');
      if (await checkFileExists(candidate)) {
        larsPath = candidate;
      }
    }
  }
  if (await checkFileExists(larsPath)) {
    result.lars.installed = true;
    result.lars.path = larsPath;
    result.lars.version = await getFileVersion(larsPath);
  }

  return result;
}
