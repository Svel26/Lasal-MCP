import { existsSync, readdirSync, readFileSync, unlinkSync } from "fs";
import { join, dirname, basename } from "path";
import { z } from "zod";
import { resolveLvpPath } from "../utils/resolvePaths.js";
import { withEngineLock, killVisuDesigner } from "../utils/engine.js";
import { EditTransaction } from "../utils/editTransaction.js";
import {
  newDesignTimeId,
  newInstanceId,
  getFileEntryVersion,
  writeTabIndentedJson
} from "../utils/visuDashboardIO.js";
import {
  loadControlManifest,
  encodeProperty
} from "../utils/visuPropertyEncoding.js";

// Helper to clean JSON manifests
import { cleanJson } from "../utils/visuPropertyEncoding.js";

// ─── Zod Operation Schemas ───────────────────────────────────────────────────

const CreateDashboardOp = z.object({
  op: z.literal("create_dashboard"),
  kind: z.enum(["dashboard", "globalDashboard", "window", "controlTemplate"]),
  name: z.string(),
  width: z.string().optional(),
  height: z.string().optional(),
});

const DeleteDashboardOp = z.object({
  op: z.literal("delete_dashboard"),
  kind: z.enum(["dashboard", "globalDashboard", "window", "controlTemplate"]),
  name: z.string(),
});

const AddElementOp = z.object({
  op: z.literal("add_element"),
  dashboardName: z.string(),
  controlId: z.string(),
  name: z.string(),
  left: z.string().optional(),
  top: z.string().optional(),
  width: z.string().optional(),
  height: z.string().optional(),
});

const RemoveElementOp = z.object({
  op: z.literal("remove_element"),
  dashboardName: z.string(),
  name: z.string(),
});

const PropertyBindInput = z.object({
  name: z.string(),
  sourceType: z.enum([
    "constString",
    "constNumber",
    "constBool",
    "datapoint",
    "text",
    "colorScheme",
    "stateScheme",
    "functionBlock",
    "compositeControl",
    "imageOrMedia",
    "fontStyle",
    "styleClass"
  ]),
  value: z.any(),
});

const SetElementPropertiesOp = z.object({
  op: z.literal("set_element_properties"),
  dashboardName: z.string(),
  name: z.string().optional().describe("Element name to update. Omit or set to '' or '__root' to edit the root dashboard properties."),
  properties: z.array(PropertyBindInput),
});

const MoveElementOp = z.object({
  op: z.literal("move_element"),
  dashboardName: z.string(),
  name: z.string(),
  left: z.string().optional(),
  top: z.string().optional(),
});

const ResizeElementOp = z.object({
  op: z.literal("resize_element"),
  dashboardName: z.string(),
  name: z.string(),
  width: z.string().optional(),
  height: z.string().optional(),
});

const DuplicateElementOp = z.object({
  op: z.literal("duplicate_element"),
  dashboardName: z.string(),
  name: z.string(),
  newName: z.string(),
});

const AddCompositeInstanceOp = z.object({
  op: z.literal("add_composite_instance"),
  dashboardName: z.string(),
  templateName: z.string(),
  name: z.string(),
  left: z.string().optional(),
  top: z.string().optional(),
  width: z.string().optional(),
  height: z.string().optional(),
});

const CreateCompositeTemplateOp = z.object({
  op: z.literal("create_composite_template"),
  name: z.string(),
  width: z.string().optional(),
  height: z.string().optional(),
});

const DescribeControlTypeOp = z.object({
  op: z.literal("describe_control_type"),
  controlId: z.string(),
});

const ListControlTypesOp = z.object({
  op: z.literal("list_control_types"),
});

const VisuDashboardOperation = z.discriminatedUnion("op", [
  CreateDashboardOp,
  DeleteDashboardOp,
  AddElementOp,
  RemoveElementOp,
  SetElementPropertiesOp,
  MoveElementOp,
  ResizeElementOp,
  DuplicateElementOp,
  AddCompositeInstanceOp,
  CreateCompositeTemplateOp,
  DescribeControlTypeOp,
  ListControlTypesOp,
]);

export const visuDashboardSchema = {
  lvp_path: z
    .string()
    .optional()
    .describe("Full path to the .lvp file. Omit to auto-detect from the selected project."),
  operations: z.array(VisuDashboardOperation).describe("List of dashboard and template operations to execute"),
};

// ─── Helper Functions ────────────────────────────────────────────────────────

function getDashboardFilePath(projectDir: string, kind: string, name: string): string {
  let sub = "Dashboards";
  if (kind === "globalDashboard") sub = "GlobalDashboards";
  else if (kind === "window") sub = "Window";
  else if (kind === "controlTemplate") sub = "ControlTemplate";
  return join(projectDir, sub, `${name}.json`);
}

function findDashboardFile(projectDir: string, name: string): { path: string; kind: string } | null {
  for (const kind of ["dashboard", "globalDashboard", "window", "controlTemplate"]) {
    const p = getDashboardFilePath(projectDir, kind, name);
    if (existsSync(p)) return { path: p, kind };
  }
  return null;
}

function updateLayoutProp(properties: any[], name: string, value: string | undefined) {
  if (value === undefined) return;
  let typeId = 0;
  let propTypeId = 2;
  let realVal: any = value;

  if (name === "rotation") {
    realVal = parseFloat(value) || 0.0;
    typeId = 17;
    propTypeId = 12;
  } else if (name === "--theme-sig-element-zindex") {
    typeId = 0;
    propTypeId = 2;
  } else if (name.startsWith("--theme-sig-element-")) {
    typeId = 17;
    propTypeId = 2;
  }

  const existing = properties.find((p: any) => p.name === name);
  if (existing) {
    existing.value = realVal;
    existing.typeId = typeId;
    existing.propTypeId = propTypeId;
  } else {
    properties.push({
      name,
      value: realVal,
      typeId,
      propTypeId
    });
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function visuDashboardHandler(args: {
  lvp_path?: string;
  operations: Array<z.infer<typeof VisuDashboardOperation>>;
}) {
  const resolved = resolveLvpPath(args.lvp_path);
  if ("error" in resolved) {
    return { content: [{ type: "text" as const, text: resolved.error }], isError: true };
  }

  const lvpPath = resolved.path;
  const projectDir = dirname(lvpPath);

  const results: any[] = [];
  const backups: string[] = [];
  let isError = false;

  const tx = new EditTransaction();
  const backup = (p: string) => {
    tx.backup(p);
    backups.push(p);
  };

  await withEngineLock(async () => {
    // Safety: kill VISUDesigner before any direct file writes
    killVisuDesigner();

    for (const op of args.operations) {
      const opResult: any = { op: op.op };

      try {
        switch (op.op) {
          case "list_control_types": {
            const list: any[] = [];
            const roots = [
              join(projectDir, "Runtime", "DesignerRuntime", "res", "components", "user"),
              join(projectDir, "Runtime", "DesignerRuntime", "res", "components", "sigmatek")
            ];
            for (const r of roots) {
              if (!existsSync(r)) continue;
              for (const entry of readdirSync(r)) {
                const path = join(r, entry, `${entry}.json`);
                if (existsSync(path)) {
                  try {
                    const manifest = JSON.parse(cleanJson(readFileSync(path, "utf-8")));
                    list.push({
                      controlId: entry,
                      shortName: manifest.shortName?.en || entry,
                      version: manifest.version || "unknown",
                      description: manifest.description?.en || ""
                    });
                  } catch {}
                }
              }
            }
            opResult.ok = true;
            opResult.controlTypes = list;
            break;
          }

          case "describe_control_type": {
            const manifest = loadControlManifest(projectDir, op.controlId);
            if (!manifest) {
              throw new Error(`Control manifest for '${op.controlId}' not found.`);
            }
            opResult.ok = true;
            opResult.controlType = {
              controlId: manifest.name,
              description: manifest.description?.en || "",
              properties: (manifest.properties || []).map((p: any) => ({
                name: p.name,
                dataType: p.dataType || "string",
                group: p.group?.en || "Custom",
                description: p.description?.en || "",
                valueSourceTypes: Array.isArray(p.valueSourceTypes)
                  ? p.valueSourceTypes
                  : (p.valueSourceTypes ? [p.valueSourceTypes] : ["constString"])
              }))
            };
            break;
          }

          case "create_dashboard": {
            const path = getDashboardFilePath(projectDir, op.kind, op.name);
            if (existsSync(path)) {
              throw new Error(`File already exists at ${path}`);
            }

            const verKey = op.kind === "controlTemplate" ? "controlTemplateVersion" : (op.kind === "globalDashboard" ? "globalDashboardVersion" : (op.kind === "window" ? "windowVersion" : "dashboardVersion"));
            const version = getFileEntryVersion(lvpPath, verKey);

            const content = {
              type: op.kind === "controlTemplate" ? "controlTemplate" : "dashboard",
              version,
              gridWidth: "10px",
              gridHeight: "10px",
              gridColor: "#000000",
              gridStyle: "dotgrid",
              revision: { type: "Revision" },
              designTimeId: newDesignTimeId(),
              name: op.name,
              instanceId: newInstanceId("design_"),
              controlId: "sig-dashboard",
              properties: [
                { name: "position", value: "absolute", typeId: 0, propTypeId: 2 },
                { name: "top", value: "0px", typeId: 0, propTypeId: 2 },
                { name: "left", value: "0px", typeId: 0, propTypeId: 2 },
                { name: "height", value: op.height || "800px", typeId: 0, propTypeId: 2 },
                { name: "width", value: op.width || "1024px", typeId: 0, propTypeId: 2 },
                { name: "overflow", value: "visible", typeId: 0, propTypeId: 2 },
                { name: "background", value: "transparent", typeId: 0, propTypeId: 2 }
              ],
              dashboardelements: []
            };

            writeTabIndentedJson(path, content);
            opResult.ok = true;
            opResult.path = path;
            break;
          }

          case "create_composite_template": {
            const path = getDashboardFilePath(projectDir, "controlTemplate", op.name);
            if (existsSync(path)) {
              throw new Error(`File already exists at ${path}`);
            }
            const version = getFileEntryVersion(lvpPath, "controlTemplateVersion");
            const content = {
              type: "controlTemplate",
              version,
              gridWidth: "10px",
              gridHeight: "10px",
              gridColor: "#000000",
              gridStyle: "dotgrid",
              revision: { type: "Revision" },
              designTimeId: newDesignTimeId(),
              name: op.name,
              instanceId: newInstanceId("design_"),
              controlId: "sig-dashboard",
              properties: [
                { name: "position", value: "absolute", typeId: 0, propTypeId: 2 },
                { name: "overflow", value: "visible", typeId: 0, propTypeId: 2 },
                { name: "background", value: "transparent", typeId: 0, propTypeId: 2 }
              ],
              dashboardelements: []
            };
            writeTabIndentedJson(path, content);
            opResult.ok = true;
            opResult.path = path;
            break;
          }

          case "delete_dashboard": {
            const path = getDashboardFilePath(projectDir, op.kind, op.name);
            if (!existsSync(path)) {
              throw new Error(`File not found at ${path}`);
            }
            backup(path);

            unlinkSync(path);
            opResult.ok = true;
            break;
          }

          case "add_element": {
            const found = findDashboardFile(projectDir, op.dashboardName);
            if (!found) {
              throw new Error(`Dashboard/template '${op.dashboardName}' not found.`);
            }
            backup(found.path);

            const data = JSON.parse(readFileSync(found.path, "utf-8"));
            if (!Array.isArray(data.dashboardelements)) {
              data.dashboardelements = [];
            }

            if (data.dashboardelements.some((el: any) => el.name === op.name)) {
              throw new Error(`Element with name '${op.name}' already exists in dashboard '${op.dashboardName}'.`);
            }

            const manifest = loadControlManifest(projectDir, op.controlId);
            const defaultWidth = manifest?.defaultDimensions?.width || "100px";
            const defaultHeight = manifest?.defaultDimensions?.height || "100px";

            const elementProperties: any[] = [];
            updateLayoutProp(elementProperties, "--theme-sig-element-left", op.left || "0px");
            updateLayoutProp(elementProperties, "--theme-sig-element-top", op.top || "0px");
            updateLayoutProp(elementProperties, "--theme-sig-element-width", op.width || defaultWidth);
            updateLayoutProp(elementProperties, "--theme-sig-element-height", op.height || defaultHeight);
            updateLayoutProp(elementProperties, "rotation", "0");
            updateLayoutProp(elementProperties, "--theme-sig-element-zindex", "101");

            const newEl = {
              type: "control",
              designTimeId: newDesignTimeId(),
              name: op.name,
              instanceId: newInstanceId("lvd"),
              controlId: op.controlId,
              properties: elementProperties
            };

            data.dashboardelements.push(newEl);
            writeTabIndentedJson(found.path, data);
            opResult.ok = true;
            opResult.designTimeId = newEl.designTimeId;
            opResult.instanceId = newEl.instanceId;
            break;
          }

          case "remove_element": {
            const found = findDashboardFile(projectDir, op.dashboardName);
            if (!found) {
              throw new Error(`Dashboard/template '${op.dashboardName}' not found.`);
            }
            backup(found.path);

            const data = JSON.parse(readFileSync(found.path, "utf-8"));
            const origCount = data.dashboardelements?.length || 0;
            data.dashboardelements = (data.dashboardelements || []).filter((el: any) => el.name !== op.name);

            if (data.dashboardelements.length === origCount) {
              throw new Error(`Element '${op.name}' not found in dashboard '${op.dashboardName}'.`);
            }

            writeTabIndentedJson(found.path, data);
            opResult.ok = true;
            break;
          }

          case "set_element_properties": {
            const found = findDashboardFile(projectDir, op.dashboardName);
            if (!found) {
              throw new Error(`Dashboard/template '${op.dashboardName}' not found.`);
            }
            backup(found.path);

            const data = JSON.parse(readFileSync(found.path, "utf-8"));
            const targetName = op.name || "";

            let targetProps: any[] | null = null;
            let controlId = "sig-dashboard";

            if (targetName === "" || targetName === "__root" || targetName.toLowerCase() === op.dashboardName.toLowerCase()) {
              targetProps = data.properties;
              controlId = data.controlId || "sig-dashboard";
            } else {
              const el = (data.dashboardelements || []).find((x: any) => x.name === targetName);
              if (!el) {
                throw new Error(`Element '${targetName}' not found in dashboard '${op.dashboardName}'.`);
              }
              targetProps = el.properties;
              controlId = el.controlId;
            }

            if (!targetProps) {
              throw new Error(`Properties list not found for target '${targetName}'.`);
            }

            const manifest = loadControlManifest(projectDir, controlId);

            for (const propBind of op.properties) {
              const manifestProp = manifest?.properties?.find((p: any) => p.name === propBind.name);
              const encoded = encodeProperty(projectDir, propBind.name, manifestProp, propBind.sourceType, propBind.value);

              const idx = targetProps.findIndex((p: any) => p.name === propBind.name);
              if (idx >= 0) {
                targetProps[idx] = encoded;
              } else {
                targetProps.push(encoded);
              }
            }

            writeTabIndentedJson(found.path, data);
            opResult.ok = true;
            break;
          }

          case "move_element": {
            const found = findDashboardFile(projectDir, op.dashboardName);
            if (!found) {
              throw new Error(`Dashboard/template '${op.dashboardName}' not found.`);
            }
            backup(found.path);

            const data = JSON.parse(readFileSync(found.path, "utf-8"));
            const el = (data.dashboardelements || []).find((x: any) => x.name === op.name);
            if (!el) {
              throw new Error(`Element '${op.name}' not found in '${op.dashboardName}'.`);
            }

            updateLayoutProp(el.properties, "--theme-sig-element-left", op.left);
            updateLayoutProp(el.properties, "--theme-sig-element-top", op.top);

            writeTabIndentedJson(found.path, data);
            opResult.ok = true;
            break;
          }

          case "resize_element": {
            const found = findDashboardFile(projectDir, op.dashboardName);
            if (!found) {
              throw new Error(`Dashboard/template '${op.dashboardName}' not found.`);
            }
            backup(found.path);

            const data = JSON.parse(readFileSync(found.path, "utf-8"));
            const el = (data.dashboardelements || []).find((x: any) => x.name === op.name);
            if (!el) {
              throw new Error(`Element '${op.name}' not found in '${op.dashboardName}'.`);
            }

            updateLayoutProp(el.properties, "--theme-sig-element-width", op.width);
            updateLayoutProp(el.properties, "--theme-sig-element-height", op.height);

            writeTabIndentedJson(found.path, data);
            opResult.ok = true;
            break;
          }

          case "duplicate_element": {
            const found = findDashboardFile(projectDir, op.dashboardName);
            if (!found) {
              throw new Error(`Dashboard/template '${op.dashboardName}' not found.`);
            }
            backup(found.path);

            const data = JSON.parse(readFileSync(found.path, "utf-8"));
            const srcEl = (data.dashboardelements || []).find((x: any) => x.name === op.name);
            if (!srcEl) {
              throw new Error(`Element '${op.name}' to duplicate not found.`);
            }

            if (data.dashboardelements.some((x: any) => x.name === op.newName)) {
              throw new Error(`An element with name '${op.newName}' already exists.`);
            }

            const duplicated = JSON.parse(JSON.stringify(srcEl));
            duplicated.name = op.newName;
            duplicated.designTimeId = newDesignTimeId();
            duplicated.instanceId = newInstanceId(duplicated.type === "compositecontainer" ? "lvd" : "lvd");

            // shift duplicate slightly so it's visible if stacked directly
            const leftProp = duplicated.properties.find((p: any) => p.name === "--theme-sig-element-left");
            if (leftProp && typeof leftProp.value === "string" && leftProp.value.endsWith("px")) {
              const val = parseInt(leftProp.value) + 10;
              leftProp.value = `${val}px`;
            }

            data.dashboardelements.push(duplicated);
            writeTabIndentedJson(found.path, data);
            opResult.ok = true;
            opResult.designTimeId = duplicated.designTimeId;
            opResult.instanceId = duplicated.instanceId;
            break;
          }

          case "add_composite_instance": {
            const found = findDashboardFile(projectDir, op.dashboardName);
            if (!found) {
              throw new Error(`Dashboard/template '${op.dashboardName}' not found.`);
            }
            const templateFile = getDashboardFilePath(projectDir, "controlTemplate", op.templateName);
            if (!existsSync(templateFile)) {
              throw new Error(`Composite template '${op.templateName}' not found at ${templateFile}.`);
            }
            const templateData = JSON.parse(readFileSync(templateFile, "utf-8"));
            const templateId = templateData.designTimeId;

            backup(found.path);

            const data = JSON.parse(readFileSync(found.path, "utf-8"));
            if (data.dashboardelements?.some((x: any) => x.name === op.name)) {
              throw new Error(`Element with name '${op.name}' already exists.`);
            }

            const elementProperties: any[] = [];
            elementProperties.push({
              name: "sigcompositectrl",
              value: op.templateName,
              typeId: 23,
              propTypeId: 5,
              refId: templateId
            });
            updateLayoutProp(elementProperties, "--theme-sig-element-left", op.left || "0px");
            updateLayoutProp(elementProperties, "--theme-sig-element-top", op.top || "0px");
            updateLayoutProp(elementProperties, "--theme-sig-element-width", op.width || "200px");
            updateLayoutProp(elementProperties, "--theme-sig-element-height", op.height || "150px");
            updateLayoutProp(elementProperties, "rotation", "0");
            updateLayoutProp(elementProperties, "--theme-sig-element-zindex", "101");

            const newComp = {
              type: "compositecontainer",
              controlId: "sig-composite-container",
              designTimeId: newDesignTimeId(),
              name: op.name,
              instanceId: newInstanceId("lvd"),
              properties: elementProperties
            };

            data.dashboardelements = data.dashboardelements || [];
            data.dashboardelements.push(newComp);
            writeTabIndentedJson(found.path, data);

            opResult.ok = true;
            opResult.designTimeId = newComp.designTimeId;
            opResult.instanceId = newComp.instanceId;
            break;
          }
        }
      } catch (e: any) {
        opResult.ok = false;
        opResult.error = e.message;
        isError = true;
      }

      results.push(opResult);
    }

    if (isError) {
      tx.rollback();
    } else {
      tx.commit();
    }
  });

  const responseBody = {
    results,
    backups: backups.map((b) => basename(b))
  };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(responseBody, null, 2) }],
    isError
  };
}
