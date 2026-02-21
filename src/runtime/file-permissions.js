/**
 * File permission system for all file-related actions.
 *
 * Permission model:
 *   - Per DIRECTORY, per OPERATION TYPE.
 *   - Two levels: "read" (read_file, search) and "write" (edit_file, write_file).
 *   - "read" permission does NOT grant "write" permission.
 *   - GLOBAL singleton: granting permission to any agent grants it to all agents.
 *   - In-memory only (reset between sessions).
 */

import path from 'path';

/**
 * Check if `dir` is equal to or a subdirectory of `allowedDir`.
 */
function isSubdirOf(dir, allowedDir) {
  const normalized = path.resolve(dir) + path.sep;
  const normalizedAllowed = path.resolve(allowedDir) + path.sep;
  return normalized.startsWith(normalizedAllowed) || path.resolve(dir) === path.resolve(allowedDir);
}

export class FilePermissions {
  constructor() {
    this.readDirs = [];   // directories allowed for read/search
    this.writeDirs = [];  // directories allowed for edit/write
  }

  /**
   * Grant permission for a directory.
   * @param {string} directory
   * @param {'read'|'write'} level - "read" for read/search, "write" for edit/write
   */
  allow(directory, level = 'read') {
    const resolved = path.resolve(directory);
    if (level === 'write') {
      if (!this.writeDirs.includes(resolved)) this.writeDirs.push(resolved);
    } else {
      if (!this.readDirs.includes(resolved)) this.readDirs.push(resolved);
    }
  }

  /**
   * Check if a file/directory is allowed for a given operation level.
   * @param {string} filePath
   * @param {'read'|'write'} level
   */
  isAllowed(filePath, level = 'read') {
    const resolved = path.resolve(filePath);
    const dir = path.dirname(resolved);
    const dirs = level === 'write' ? this.writeDirs : this.readDirs;
    // Check both the file's parent dir AND the path itself
    // (handles when filePath is a directory, e.g. search path ".")
    return dirs.some(allowed => isSubdirOf(dir, allowed) || isSubdirOf(resolved, allowed));
  }
}

/**
 * Global shared permission instance — all agents use the same set of grants.
 * Granting permission once applies to every agent in the session.
 */
const _globalFilePermissions = new FilePermissions();

export function getFilePermissions(_agent) {
  return _globalFilePermissions;
}
