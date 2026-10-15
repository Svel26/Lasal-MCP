import { describe, it, expect } from "vitest";
import { buildLseScript, resolveLseButtonProperty, LSE_BUTTON_PROPERTIES } from "../src/utils/lseScript.js";

const opts = {
  logPath: "C:\\tmp\\l.log",
  stepsPath: "C:\\tmp\\l.steps",
  resultPath: "C:\\tmp\\l.json",
  saveAtEnd: true,
};

describe("buildLseScript", () => {
  it("wraps the script with the COM host bootstrap and step protocol", () => {
    const { script, expectedSteps } = buildLseScript("C:\\p\\x.lpr", [{ type: "info" }], opts);
    expect(script).toContain("New-Object -ComObject LASALScreen.Application");
    expect(script).toContain("$app.Open('C:\\p\\x.lpr')");
    expect(script).toContain("Write-Step 'CreateApp'");
    expect(script).toContain("Write-Step 'LoadProject'");
    expect(script).toContain("Write-Step '0_info'");
    expect(script).toContain("Write-Step 'SaveProject'");
    expect(script).toContain("Write-Step 'CloseProject'");
    expect(expectedSteps).toEqual(["CreateApp", "LoadProject", "0_info", "SaveProject", "CloseProject"]);
  });

  it("escapes single quotes in PowerShell string literals", () => {
    const { script } = buildLseScript(
      "C:\\p\\O'Brien.lpr",
      [{ type: "textlist_set_text", text_list: "L'ist", item: 0, language_id: 2057, text: "It's fine" }],
      opts,
    );
    expect(script).toContain("$app.Open('C:\\p\\O''Brien.lpr')");
    expect(script).toContain("Get-ItemByRef $prj.TextLists 'L''ist'");
    expect(script).toContain("$it.Text(2057) = 'It''s fine'");
  });

  it("emits download with run flag and connection override", () => {
    const { script } = buildLseScript(
      "C:\\p\\x.lpr",
      [{ type: "download", run: false, connection: "TCPIP:10.0.0.5:1964" }],
      opts,
    );
    expect(script).toContain("$st.OnlineIPAddress = '10.0.0.5'");
    expect(script).toContain("$prj.DownloadProject($false)");
    expect(script).toContain('if ("$r" -eq "False")');
  });

  it("maps button property names to numeric constants", () => {
    expect(resolveLseButtonProperty("Theme", LSE_BUTTON_PROPERTIES)).toBe(2);
    expect(resolveLseButtonProperty("zoom", LSE_BUTTON_PROPERTIES)).toBe(8);
    expect(() => resolveLseButtonProperty("Nope", LSE_BUTTON_PROPERTIES)).toThrow();
  });

  it("emits merge with MergeParameter options and fallback chain", () => {
    const { script } = buildLseScript(
      "C:\\p\\x.lpr",
      [{ type: "merge", file: "C:\\in\\e.lpr", overwrite: true, deep_merge: true }],
      opts,
    );
    expect(script).toContain("$mp = $prj.MergeParameter");
    expect(script).toContain("$mp.Overwrite = $true");
    expect(script).toContain("$mp.DeepMerge = $true");
    expect(script).toContain("$prj.MergeEx('C:\\in\\e.lpr')");
    expect(script).toContain("$prj.Merge('C:\\in\\e.lpr', $true)");
  });

  it("emits export_xml flags and language registration", () => {
    const { script } = buildLseScript(
      "C:\\p\\x.lpr",
      [
        {
          type: "export_xml",
          path: "C:\\out\\x.xml",
          languages: [3079, 2057],
          container_info: true,
          sorted_array: false,
        },
      ],
      { ...opts, saveAtEnd: false },
    );
    expect(script).toContain("[void]$prj.AddCompilationLanguage(3079)");
    expect(script).toContain("[void]$prj.AddCompilationLanguage(2057)");
    expect(script).toContain("[void]$prj.AddContainerInfo($true)");
    expect(script).toContain("[void]$prj.UseSortedArray($false)");
    expect(script).toContain("$prj.ExportToXML('C:\\out\\x.xml', $true)");
    expect(script).not.toContain("Write-Step 'SaveProject'");
  });

  it("emits settings_set through the Settings object", () => {
    const { script } = buildLseScript(
      "C:\\p\\x.lpr",
      [
        {
          type: "settings_set",
          settings: { screen_width: 1280, screen_height: 1024, online_ip: "127.0.0.1", compiler_warnings: true },
        },
      ],
      opts,
    );
    expect(script).toContain("$st.SetScreenResolution(1280, 1024)");
    expect(script).toContain("$st.OnlineIPAddress = '127.0.0.1'");
    expect(script).toContain("$st.SetCompilerWarnings($true)");
  });

  it("emits softkey/button bulk updates with numeric property ids", () => {
    const { script } = buildLseScript(
      "C:\\p\\x.lpr",
      [
        { type: "update_buttons", updates: [{ property: "Theme", value: 5, inverse: true }] },
        { type: "update_softkeys", updates: [{ property: 2, value: "theme5" }] },
      ],
      opts,
    );
    expect(script).toContain("$prj.UpdateButtons(2, 5, $true)");
    expect(script).toContain("$prj.UpdateSoftkeys(2, 'theme5', $false)");
  });
});
