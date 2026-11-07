import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The README announced 2.0.0-rc.5 while package.json (and npm) were on
 * 3.0.0-rc.2, so anyone reading the banner installed an older release candidate
 * on purpose. The banner is the first thing a visitor reads: it must name the
 * version this checkout actually is.
 */
describe("documented version", () => {
  it("names the package's own version in the README banner", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    expect(readme).toContain(`> ### ${pkg.version} —`);
  });

  it("has a changelog section for the released version", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
    const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain(`## ${pkg.version}`);
  });
});
