# Provenance

Compiled, **unmodified** copy of the library in `src/` of
[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
(`npm run build`, the files of `dist/` without source maps).

- commit `e3f262a7f4d42bd8dd32ced30d26176f7cb545b0` (17 September 2026)
- license: MIT, see `LICENSE` in this folder
- tests: 29 of 29 passing when built (25 September 2026)

This project uses only its state-building and request helpers
(`collectToolCalls`, `fitState`, `resolveOptions`, `JevClient`, `noulAnswer`);
the compaction logic itself is not used.

To update: clone the repository, `npm ci && npm run build && npm test`, copy
`dist/*.js` here, and run `npm test` in this project.
