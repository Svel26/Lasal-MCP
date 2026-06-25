import * as path from 'path';

/**
 * Escapes Windows paths for use in Python string literals.
 */
function escapePath(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Generates a Python 2.7 script for Lasal2.exe.
 * Uses unicode literals and encodes them to 'mbcs' for Windows API compatibility.
 */
export function generateClass2Script(options: {
  logPath: string;
  scriptBody: string;
}): string {
  const lines: string[] = [];
  lines.push('# -*- coding: utf-8 -*-');
  lines.push('import sigmatek.lasal.batch as batch');
  lines.push('import sys');
  lines.push('');
  lines.push('def to_mbcs(s):');
  lines.push('    if isinstance(s, unicode):');
  lines.push("        return s.encode('mbcs')");
  lines.push('    return s');
  lines.push('');
  
  // Set up logging
  lines.push(`batch.OpenLogfile(to_mbcs(u"${escapePath(options.logPath)}"), "[%d{%H:%M:%S} (%p) %c] %m%n", False)`);
  lines.push('batch.SetExceptionOnError(True)');
  lines.push('');
  
  // User or generated script body
  lines.push(options.scriptBody);
  
  return lines.join('\n');
}

/**
 * Generates a Python 3.12 script for VISUDesigner.exe.
 */
export function generateVisuScript(options: {
  scriptBody: string;
}): string {
  const lines: string[] = [];
  lines.push('import sigmatek.lasal.lvd as lvd');
  lines.push('import sys');
  lines.push('import traceback');
  lines.push('');
  lines.push('lvd.SetExceptionOnError(True)');
  lines.push('');

  // Wrap the body so any uncaught failure exits with a non-zero code.
  // That is how the process runner detects failure for VISUDesigner
  // (its exit-code-on-exception behaviour is not documented like CLASS 2's 102).
  lines.push('try:');
  for (const bodyLine of options.scriptBody.split('\n')) {
    lines.push(bodyLine.length > 0 ? '    ' + bodyLine : '');
  }
  lines.push('except Exception:');
  lines.push('    traceback.print_exc()');
  lines.push('    sys.exit(1)');

  return lines.join('\n');
}

export interface LutcTarget {
  stationName: string;
  ip: string;
  port: number;
  useTls: boolean;
}

export interface LutcInstruction {
  type:
    | 'DwnLdLC2'
    | 'DwnLdLVD'
    | 'DwnLdLSE'
    | 'DwnLdOS'
    | 'Boot'
    | 'PrjRun'
    | 'DwnLdFile'
    | 'UpLdFile'
    | 'DelFile'
    | 'ExistFile'
    | 'MkDir'
    | 'MvFile'
    | 'DwnLdFld'
    | 'UpLdFld';
  targetId: number;
  params: string[];
  attributes?: Record<string, string>;
}

/**
 * Generates an XML string for a MachineManager .lutc file.
 */
export function generateLutc(targets: LutcTarget[], instructions: LutcInstruction[]): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="ISO-8859-1" ?>');
  lines.push('<UpdateConfig TargetId="0" MachineNr="001">');
  
  // Targets section
  lines.push('\t<Targets>');
  targets.forEach((t, index) => {
    const tlsVal = t.useTls ? '1' : '0';
    lines.push(`\t\t<Target Station="${t.stationName}">`);
    lines.push('\t\t\t<PC>');
    lines.push(`\t\t\t\t<TCPIP ConfigName="MM_${t.stationName}" BUS="3" Password="" IP="${t.ip}" PORT="${t.port.toString()}" SomeFlags="0" PLCID="" Repeater="0" SSLTLS="${tlsVal}" Favorite="0"/>`);
    lines.push('\t\t\t</PC>');
    lines.push('\t\t</Target>');
  });
  lines.push('\t</Targets>');
  
  // Instructions section
  lines.push('\t<Instructions>');
  instructions.forEach(inst => {
    lines.push(`\t\t<${inst.type} TargetId="${inst.targetId}">`);
    if (inst.type === 'DwnLdLC2') {
      const savePrj = inst.attributes?.savePrj ?? 'true';
      const platform = inst.attributes?.platform;
      lines.push(`\t\t\t<Param Val="${inst.params[0]}"/>`);
      if (platform) {
        lines.push(`\t\t\t<Param SavePrj="${savePrj}" Platform="${platform}"/>`);
      } else {
        lines.push(`\t\t\t<Param SavePrj="${savePrj}"/>`);
      }
    } else if (inst.type === 'DwnLdLVD') {
      lines.push(`\t\t\t<Param Val="${inst.params[0]}"/>`);
      lines.push('\t\t\t<Param/>');
    } else {
      inst.params.forEach(p => {
        lines.push(`\t\t\t<Param Val="${p}"/>`);
      });
    }
    lines.push(`\t\t</${inst.type}>`);
  });
  lines.push('\t</Instructions>');
  
  lines.push('</UpdateConfig>');
  return lines.join('\n');
}
