/**
 * Compatibility re-export: the footer policy is named for the surface it
 * describes in `footer.ts`, and some embedders/tests reach for it by the
 * function's name instead. Keep one implementation, two import paths.
 */
export * from "./footer.js";
