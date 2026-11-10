/**
 * CHAD edition switches: what the 3D-printing edition shows.
 *
 * Engineering-only screens are hidden here, not deleted, so CHAD stays in step
 * with the full engineering edition it was split from. Their code and tests
 * stay and keep running. The full list and the reasons are in
 * docs/CHAD_SCOPE.md.
 */
export const EDITION: { readonly drawings: boolean } = {
  /** 2D engineering drawings: ASME/ISO sheets, title blocks, GD&T, PDF/DXF/SVG. Not in CHAD. */
  drawings: false,
};
