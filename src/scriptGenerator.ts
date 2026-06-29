/**
 * Encodes an arbitrary string into the body of a Python string literal, using
 * only ASCII so it survives being written to a latin1-encoded .py file. Handles
 * quotes, backslashes, newlines and any control/non-ASCII character — preventing
 * both syntax breakage and code injection when interpolating untrusted values
 * (paths, channel names, values) into generated scripts.
 *
 * The escape syntax (\n \r \t \xNN \uNNNN \UNNNNNNNN) is valid for both the
 * Python 2.7 (`batch`) and Python 3.12 (`lvd`) hosts.
 */
function toPyLiteralBody(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20) out += '\\x' + code.toString(16).padStart(2, '0');
    else if (code < 0x7f) out += ch;
    else if (code <= 0xffff) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += '\\U' + code.toString(16).padStart(8, '0');
  }
  return out;
}

/** Safe Python `str` literal: `"..."`. Use for VISUDesigner (Python 3.12). */
export function pyStr(s: string): string {
  return '"' + toPyLiteralBody(s) + '"';
}

/** Safe Python `unicode` literal: `u"..."`. Use for CLASS 2 (Python 2.7). */
export function pyUnicode(s: string): string {
  if (!s) return 'u""';
  return 'u"' + toPyLiteralBody(s) + '"';
}

/** Escapes a value for safe inclusion in an XML attribute or text node. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generates a Python 2.7 script for Lasal2.exe.
 * Uses unicode literals and encodes them to 'mbcs' for Windows API compatibility.
 *
 * When errFilePath is provided the entire script body is wrapped in try/except:
 * any unhandled exception is written to that file and the process exits with 102.
 * Without it the body runs unwrapped (legacy behaviour, error visible only via log).
 */
export function generateClass2Script(options: {
  logPath: string;
  scriptBody: string;
  errFilePath?: string;
}): string {
  const lines: string[] = [];
  lines.push('# -*- coding: utf-8 -*-');
  lines.push('import sigmatek.lasal.batch as batch');
  lines.push('import sys');
  lines.push('import traceback');
  lines.push('');
  lines.push('def to_mbcs(s):');
  lines.push('    if isinstance(s, unicode):');
  lines.push("        return s.encode('mbcs')");
  lines.push('    return s');
  lines.push('');

  lines.push(`batch.OpenLogfile(to_mbcs(${pyUnicode(options.logPath)}), "[%d{%H:%M:%S} (%p) %c] %m%n", False)`);
  lines.push('batch.SetExceptionOnError(True)');
  lines.push('');

  if (options.errFilePath) {
    lines.push('try:');
    for (const bodyLine of options.scriptBody.split('\n')) {
      lines.push(bodyLine.length > 0 ? '    ' + bodyLine : '');
    }
    lines.push('except Exception as __e:');
    lines.push(`    __ef = open(to_mbcs(${pyUnicode(options.errFilePath)}), 'w')`);
    lines.push('    traceback.print_exc(file=__ef)');
    lines.push('    __ef.close()');
    lines.push('    sys.exit(102)');
  } else {
    lines.push(options.scriptBody);
  }

  return lines.join('\n');
}

/**
 * Generates a Python 3.12 script for VISUDesigner.exe.
 * If errorFilePath is provided, exceptions are written to that file instead of
 * stderr (VISUDesigner is a GUI-subsystem process; stderr is not reliably captured).
 */
export function generateVisuScript(options: {
  scriptBody: string;
  errorFilePath?: string;
}): string {
  const lines: string[] = [];
  lines.push('import sigmatek.lasal.lvd as lvd');
  lines.push('import sys');
  lines.push('import traceback');
  lines.push('');
  lines.push('lvd.SetExceptionOnError(True)');
  lines.push('');

  lines.push('try:');
  for (const bodyLine of options.scriptBody.split('\n')) {
    lines.push(bodyLine.length > 0 ? '    ' + bodyLine : '');
  }
  lines.push('except Exception:');
  if (options.errorFilePath) {
    lines.push(`    with open(${pyStr(options.errorFilePath)}, 'w', encoding='utf-8') as __ef:`);
    lines.push('        traceback.print_exc(file=__ef)');
  } else {
    lines.push('    traceback.print_exc()');
  }
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
    const station = xmlEscape(t.stationName);
    lines.push(`\t\t<Target Station="${station}">`);
    lines.push('\t\t\t<PC>');
    lines.push(`\t\t\t\t<TCPIP ConfigName="MM_${station}" BUS="3" Password="" IP="${xmlEscape(t.ip)}" PORT="${t.port.toString()}" SomeFlags="0" PLCID="" Repeater="0" SSLTLS="${tlsVal}" Favorite="0"/>`);
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
      lines.push(`\t\t\t<Param Val="${xmlEscape(inst.params[0])}"/>`);
      if (platform) {
        lines.push(`\t\t\t<Param SavePrj="${savePrj}" Platform="${xmlEscape(platform)}"/>`);
      } else {
        lines.push(`\t\t\t<Param SavePrj="${savePrj}"/>`);
      }
    } else if (inst.type === 'DwnLdLVD') {
      lines.push(`\t\t\t<Param Val="${xmlEscape(inst.params[0])}"/>`);
      lines.push('\t\t\t<Param/>');
    } else {
      inst.params.forEach(p => {
        lines.push(`\t\t\t<Param Val="${xmlEscape(p)}"/>`);
      });
    }
    lines.push(`\t\t</${inst.type}>`);
  });
  lines.push('\t</Instructions>');
  
  lines.push('</UpdateConfig>');
  return lines.join('\n');
}
