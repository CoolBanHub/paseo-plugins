/**
 * Directory-tree grouping for file lists (IDEA's "Group by Directory"):
 * paths are split on "/", single-child chains are collapsed ("src/git"),
 * directories sort before their sibling files.
 */

export interface TreeDir<T> {
  /** Display name; compressed chains join segments with "/". */
  name: string;
  /** Full directory path. */
  path: string;
  dirs: TreeDir<T>[];
  files: TreeFile<T>[];
}

export interface TreeFile<T> {
  name: string;
  path: string;
  value: T;
}

export interface FileTree<T> {
  /** Files that sit at the root, outside any directory. */
  rootFiles: TreeFile<T>[];
  dirs: TreeDir<T>[];
}

export function buildDirTree<T>(entries: readonly { path: string; value: T }[]): FileTree<T> {
  const root: TreeDir<T> = { name: "", path: "", dirs: [], files: [] };
  for (const entry of entries) {
    const parts = entry.path.split("/").filter((part) => part.length > 0);
    if (parts.length === 0) continue;
    const fileName = parts.pop()!;
    let dir: TreeDir<T> = root;
    let prefix = "";
    for (const part of parts) {
      prefix = prefix.length > 0 ? `${prefix}/${part}` : part;
      let next = dir.dirs.find((child) => child.path === prefix);
      if (!next) {
        next = { name: part, path: prefix, dirs: [], files: [] };
        dir.dirs.push(next);
      }
      dir = next;
    }
    dir.files.push({ name: fileName, path: entry.path, value: entry.value });
  }

  const sortDir = (dir: TreeDir<T>): void => {
    dir.dirs.sort((a, b) => a.name.localeCompare(b.name));
    dir.files.sort((a, b) => a.name.localeCompare(b.name));
    dir.dirs.forEach(sortDir);
  };
  sortDir(root);

  // Collapse chains: a dir holding neither files nor sibling dirs merges
  // into its single child ("src" + "git" → "src/git").
  const collapse = (dir: TreeDir<T>): TreeDir<T> => {
    const dirs = dir.dirs.map(collapse);
    if (dirs.length === 1 && dir.files.length === 0) {
      const only = dirs[0]!;
      return { ...only, name: `${dir.name}/${only.name}` };
    }
    return { ...dir, dirs };
  };

  const collapsedRoot = collapse(root);
  const sortWithFiles = (dir: TreeDir<T>): TreeDir<T> => {
    // Dirs sort by name; the caller renders dirs before sibling files (IDEA order).
    return { ...dir, dirs: dir.dirs.map(sortWithFiles) };
  };
  const finalRoot = sortWithFiles(collapsedRoot);
  return { rootFiles: finalRoot.files, dirs: finalRoot.dirs };
}

/** Collect every file inside a directory subtree, including nested dirs. */
export function collectFiles<T>(dir: TreeDir<T>): TreeFile<T>[] {
  return [...dir.files, ...dir.dirs.flatMap((child) => collectFiles(child))];
}

/** All file paths in the tree, root files included. */
export function collectAllPaths<T>(tree: FileTree<T>): string[] {
  return [
    ...tree.rootFiles.map((file) => file.path),
    ...tree.dirs.flatMap((dir) => collectFiles(dir).map((file) => file.path)),
  ];
}
