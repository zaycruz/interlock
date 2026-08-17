const COORDINATION_NAME = /^[A-Za-z0-9:._-]+$/;

export function validatePaneName(value: string, label = "pane"): string {
  return validateCoordinationName(value, label);
}

export function validateTaskId(value: string, label = "task id"): string {
  return validateCoordinationName(value, label);
}

export function validateCoordinationName(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim() || !COORDINATION_NAME.test(value) || value.includes("..")) {
    throw new Error(label + " must match ^[A-Za-z0-9:._-]+$ and must not contain '..'");
  }
  return value;
}

export function validatePaneToken(value: string): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 512 || value.trim() !== value) {
    throw new Error("pane token must be between 8 and 512 non-whitespace characters");
  }
  return value;
}
