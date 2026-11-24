import picomatch from 'picomatch';

const cache = new Map();

/** True when path matches any of the globs (dotfiles included). */
export function matchesAny(path, globs) {
  return globs.some((glob) => {
    if (!cache.has(glob)) cache.set(glob, picomatch(glob, { dot: true }));
    return cache.get(glob)(path);
  });
}
