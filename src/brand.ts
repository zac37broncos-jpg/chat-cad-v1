/**
 * The product's name and identity, read from brand.json at the repository root
 * (one place to rename the product; see the note in that file).
 *
 * Internal identifiers deliberately keep the historical "chatcad" spelling
 * (ChatCAD is the engineering edition CHAD was split from), so part files,
 * autosaves and the Claude bridge stay compatible between the two: the
 * part-file format id ("format": "chatcad"), browser storage keys, the bridge
 * path /chatcad-bridge and the MCP server name "chatcad". None of them is
 * shown to the user.
 */
import brand from '../brand.json';

export const APP_NAME: string = brand.name;
/** Part files are saved as "<part name><PART_FILE_EXT>". ChatCAD's ".chatcad.json" files open too (same format inside). */
export const PART_FILE_EXT: string = brand.fileExtension;
