import { class2Actions } from "../../domains/class2/actions.js";
import { deployActions } from "../../domains/deploy/actions.js";
import { larsActions } from "../../domains/lars/actions.js";
import { projectActions } from "../../domains/core/actions.js";
import { screenActions } from "../../domains/screen/actions.js";
import { visuActions } from "../../domains/visu/actions.js";
import { ActionRegistry } from "./registry.js";

export const pilotActions = [
  ...projectActions,
  ...class2Actions,
  ...visuActions,
  ...screenActions,
  ...larsActions,
  ...deployActions,
];

export function createPilotRegistry(): ActionRegistry {
  return new ActionRegistry(pilotActions);
}
