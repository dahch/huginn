import { accessSync, constants, statSync } from "node:fs";

export function isExecutableBinary(filePath: string): boolean {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return false;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
