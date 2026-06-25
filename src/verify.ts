import * as fs from 'fs';
import * as path from 'path';
import { discoverToolchain } from './toolchain.js';
import { parseSolution, parseStation, updateStationConnection, readLatin1File } from './xmlHelper.js';
import { generateClass2Script, generateVisuScript, generateLutc } from './scriptGenerator.js';
import { getTempFilePath, cleanTempFolder } from './jobRegistry.js';

async function runTests() {
  console.log('--- STARTING LASAL MCP VERIFICATION TESTS ---');

  // Test 1: Toolchain Discovery
  console.log('\n[Test 1] Toolchain Discovery...');
  const tc = await discoverToolchain();
  console.log('Class 2 Path:', tc.class2.path, '(Installed:', tc.class2.installed, 'Version:', tc.class2.version, ')');
  console.log('VISUDesigner Path:', tc.visudesigner.path, '(Installed:', tc.visudesigner.installed, 'Version:', tc.visudesigner.version, ')');
  console.log('MachineManager Path:', tc.machinemanager.path, '(Installed:', tc.machinemanager.installed, 'Version:', tc.machinemanager.version, ')');

  // Test 2: XML Parsing and Editing (Preserving ISO-8859-1 encoding)
  console.log('\n[Test 2] XML Parsing and Editing...');
  // Mirrors the REAL .lss shape: SlnClassProject / SlnVISUDesignerProject with a File="" attribute.
  const mockLssContent = `<?xml version="1.0" encoding="ISO-8859-1" ?>
<SlnStation Name="PLC" OnlineConnection="PLC10 (Project)" Color="5295279">
  <OnlineConnectionInfo>
    <TCPIP ConfigName="PLC10" BUS="3" Password="" IP="10.195.0.10" PORT="1954" SomeFlags="0" PLCID="" Repeater="0" SSLTLS="0" Favorite="0"/>
  </OnlineConnectionInfo>
  <SlnProjects>
    <SlnClassProject Name="NveniaFilMach1057A01" LoadAtStartup="true" File=".\\NveniaFilMach1057A01\\NveniaFilMach1057A01.lcp"></SlnClassProject>
    <SlnVISUDesignerProject Name="NveniaFil_Visu" LoadAtStartup="true" File=".\\NveniaFil_Visu\\NveniaFil_Visu.lvp"></SlnVISUDesignerProject>
  </SlnProjects>
</SlnStation>`;

  const tempLssPath = getTempFilePath('mock-station', '.lss');
  fs.writeFileSync(tempLssPath, mockLssContent, 'latin1');

  // Parse LSS
  const initialStation = parseStation(tempLssPath);
  console.log('Parsed Station Name:', initialStation.name);
  console.log('Parsed Connection IP:', initialStation.connectionInfo?.ip);
  console.log('Parsed Projects count:', initialStation.projects.length);

  if (initialStation.name !== 'PLC' || initialStation.connectionInfo?.ip !== '10.195.0.10') {
    throw new Error('Test 2 Failed: Initial LSS parse failed.');
  }
  // Real .lss uses <SlnClassProject>/<SlnVISUDesignerProject> with File="" — these must be parsed.
  if (initialStation.projects.length !== 2) {
    throw new Error(`Test 2 Failed: expected 2 projects, got ${initialStation.projects.length}.`);
  }
  if (initialStation.projects[0].type !== 'class2' || initialStation.projects[1].type !== 'visudesigner') {
    throw new Error('Test 2 Failed: project kinds not resolved from element names.');
  }
  console.log('Parsed project kinds:', initialStation.projects.map(p => p.type).join(', '));

  // Update connection settings
  updateStationConnection(tempLssPath, {
    ip: '192.168.1.100',
    port: 2000,
    useTls: true,
    password: 'secure_password',
    configName: 'NewPLC'
  });

  const updatedStation = parseStation(tempLssPath);
  console.log('Updated Connection IP:', updatedStation.connectionInfo?.ip);
  console.log('Updated Connection Port:', updatedStation.connectionInfo?.port);
  console.log('Updated Connection SSLTLS (TLS):', updatedStation.connectionInfo?.useTls);
  console.log('Updated Connection Password:', updatedStation.connectionInfo?.password);
  console.log('Updated Connection ConfigName:', updatedStation.connectionInfo?.configName);

  if (
    updatedStation.connectionInfo?.ip !== '192.168.1.100' ||
    updatedStation.connectionInfo?.port !== 2000 ||
    updatedStation.connectionInfo?.useTls !== true ||
    updatedStation.connectionInfo?.password !== 'secure_password' ||
    updatedStation.connectionInfo?.configName !== 'NewPLC'
  ) {
    throw new Error('Test 2 Failed: LSS update verification failed.');
  }

  // Check that the ISO-8859-1 declaration is preserved
  const rewrittenXml = readLatin1File(tempLssPath);
  if (!rewrittenXml.includes('encoding="ISO-8859-1"')) {
    throw new Error('Test 2 Failed: ISO-8859-1 encoding declaration was lost.');
  }
  console.log('XML encoding declaration successfully preserved.');
  
  // Test 2b: Solution parsing (real .lsm shape: <Solution><SlnStationFiles><File Path=.../>)
  console.log('\n[Test 2b] Solution (.lsm) parsing...');
  const tempLsmPath = getTempFilePath('mock-solution', '.lsm');
  const lssFileName = path.basename(tempLssPath);
  const mockLsmContent = `<?xml version="1.0" encoding="ISO-8859-1" ?>
<Solution Version="3" Name="MockSolution">
\t<SlnStationFiles>
\t\t<File Path=".\\${lssFileName}"/>
\t</SlnStationFiles>
</Solution>`;
  fs.writeFileSync(tempLsmPath, mockLsmContent, 'latin1');
  const sln = parseSolution(tempLsmPath);
  console.log('Parsed stations from solution:', sln.stations.length);
  if (sln.stations.length !== 1) {
    throw new Error(`Test 2b Failed: expected 1 station, got ${sln.stations.length}.`);
  }
  if (sln.stations[0].projects.length !== 2) {
    throw new Error(`Test 2b Failed: station projects not resolved (got ${sln.stations[0].projects.length}).`);
  }
  console.log('Solution parse OK:', sln.stations[0].name, 'with', sln.stations[0].projects.length, 'projects.');
  fs.unlinkSync(tempLsmPath);

  // Cleanup temp LSS
  fs.unlinkSync(tempLssPath);

  // Test 3: Script Generation
  console.log('\n[Test 3] Script Generation (Python 2.7 Encoding & Unicode Wrappers)...');
  const class2Script = generateClass2Script({
    logPath: 'C:\\Program Files\\My Log\\test.log',
    scriptBody: 'prj = batch.LoadProject(to_mbcs(u"C:\\My Project\\test.lcp"))'
  });

  console.log('Generated Class 2 Script Preview:\n-------------------');
  console.log(class2Script);
  console.log('-------------------');

  if (!class2Script.includes('# -*- coding: utf-8 -*-')) {
    throw new Error('Test 3 Failed: Python 2.7 script missing encoding header.');
  }
  if (!class2Script.includes('to_mbcs(u"C:\\\\Program Files\\\\My Log\\\\test.log")')) {
    throw new Error('Test 3 Failed: Path encoding wrappers or path escaping failed.');
  }

  console.log('Generated VISUDesigner Script Preview:\n-------------------');
  const visuScript = generateVisuScript({
    scriptBody: 'prj = lvd.LoadProject("C:\\My Visu\\Visu.lvp")'
  });
  console.log(visuScript);
  console.log('-------------------');

  console.log('Generated LUTC XML Preview:\n-------------------');
  const lutcXml = generateLutc(
    [{ stationName: 'PLC', ip: '10.0.0.10', port: 1954, useTls: false }],
    [
      { type: 'DwnLdLC2', targetId: 0, params: ['.\\PLC\\PLC.lcp'] },
      { type: 'Boot', targetId: 0, params: ['300000'] }
    ]
  );
  console.log(lutcXml);
  console.log('-------------------');

  if (!lutcXml.includes('<TCPIP ConfigName="MM_PLC" BUS="3" Password="" IP="10.0.0.10" PORT="1954"')) {
    throw new Error('Test 3 Failed: LUTC XML targets generation failed.');
  }
  if (!lutcXml.includes('<DwnLdLC2 TargetId="0">')) {
    throw new Error('Test 3 Failed: LUTC XML instructions generation failed.');
  }

  // Clean temp folder
  cleanTempFolder();
  console.log('\n--- ALL VERIFICATION TESTS COMPLETED SUCCESSFULLY ---');
}

runTests().catch(err => {
  console.error('\n!!! VERIFICATION TEST FAILED !!!');
  console.error(err);
  process.exit(1);
});
