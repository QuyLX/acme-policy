/**
 * Minimal unified-diff parser (output of `git diff`).
 * Returns [{ oldPath, newPath, path, status, hunks: [{ lines: [{ type, text, oldLine, newLine }] }] }].
 */
export function parseUnifiedDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
      file = { oldPath: m?.[1] ?? null, newPath: m?.[2] ?? null, status: 'modified', hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('new file mode')) file.status = 'added';
    else if (raw.startsWith('deleted file mode')) file.status = 'deleted';
    else if (raw.startsWith('rename from ')) file.status = 'renamed';
    else if (raw.startsWith('--- ')) file.oldPath = raw === '--- /dev/null' ? null : raw.replace(/^--- (a\/)?/, '');
    else if (raw.startsWith('+++ ')) file.newPath = raw === '+++ /dev/null' ? null : raw.replace(/^\+\+\+ (b\/)?/, '');
    else if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      oldLine = Number(m?.[1] ?? 0);
      newLine = Number(m?.[2] ?? 0);
      hunk = { lines: [] };
      file.hunks.push(hunk);
    } else if (hunk) {
      const type = raw[0];
      const text = raw.slice(1);
      if (type === '+') hunk.lines.push({ type, text, newLine: newLine++ });
      else if (type === '-') hunk.lines.push({ type, text, oldLine: oldLine++ });
      else if (type === ' ') {
        hunk.lines.push({ type, text, oldLine: oldLine++, newLine: newLine++ });
      }
    }
  }
  for (const f of files) f.path = f.newPath ?? f.oldPath;
  return files;
}
