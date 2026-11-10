# Licences

## CHAD's own code

MIT ([LICENSE](../LICENSE)), copyright "CHAD contributors". `package.json` says the same, and `tests/legal.test.ts` checks both.

## What ships to the browser

The website ships five npm packages (`package.json` `dependencies`). Everything else in `package-lock.json` is a developer tool (Vite, TypeScript, Vitest, Playwright, and the local Claude Code bridge's `ws` and `@modelcontextprotocol/sdk`) and is not part of the built site.

| Package | What it does | Licence |
|---|---|---|
| `replicad-opencascadejs` | Open CASCADE Technology (OCCT) compiled to WebAssembly: the 3D engine | LGPL-2.1-only; upstream OCCT is LGPL-2.1 with the Open CASCADE Exception 1.0 |
| `@salusoft89/planegcs` | FreeCAD's sketch constraint solver, compiled to WebAssembly (contains parts of Eigen and Boost) | LGPL-2.0-or-later (Eigen: MPL-2.0, Boost: BSL-1.0) |
| `three` | 3D view | MIT |
| `react`, `react-dom` | User interface | MIT |

Their dependencies are MIT, ISC or BSD. The full list with every licence text is generated into [public/THIRD_PARTY_NOTICES.txt](../public/THIRD_PARTY_NOTICES.txt) by `node scripts/third-party-notices.mjs`; it ships with every build and opens from the app (Options, About CHAD and licences). `tests/legal.test.ts` fails if the file is out of date, if the About window stops naming a shipped package, or if a dependency arrives with a licence that has not been reviewed (copyleft is allowed only for the two LGPL libraries above).

## Keeping the LGPL obligations

The two LGPL libraries are used unmodified. If you publish or fork CHAD, keep these in place:

1. **Prominent notice.** The About window says the app uses Open CASCADE Technology under the LGPL 2.1 with the Open CASCADE Exception, names planegcs, links the source code of both and shows the notices file.
2. **Replaceable libraries.** Both `.wasm` files are separate files loaded at run time, never inlined into CHAD's own code, so anyone can swap in a modified build. Don't inline, merge or encrypt them (`tests/deploy.test.ts` checks that they stay separate files).
3. **Source.** OCCT: https://github.com/Open-Cascade-SAS/OCCT, the WebAssembly build: https://github.com/sgenoud/replicad, planegcs: https://github.com/Salusoft89/planegcs. CHAD makes no changes to them.
4. **No terms that forbid** modifying those libraries or reverse-engineering CHAD to debug such changes (LGPL-2.1, section 6).

This is a summary to help contributors, not legal advice.

## Names of other products

The code, docs and UI describe CAD behaviour in generic terms and do not use other CAD vendors' product or feature names (`tests/legal.test.ts` scans every file for them). Anthropic, Claude, OpenAI, GPT and Gemini are named only to say which AI services the chat can connect to; CHAD is not affiliated with or endorsed by them. The app's icon (`launcher/chad-icon.svg`) and UI icons are original; the UI uses the system's own fonts.
