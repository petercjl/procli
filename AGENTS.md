# procli Plugin Instructions

- This repository is the only source for the npm-distributed `@petercjl/procli` CLI and its bundled `project-management` Skill. Do not maintain an independent Skill or CLI source in the project-service repository or Agent-specific Skill directories.
- Codex and SealSeek use the same global CLI installation on one host. `procli skill install/update` manages discovery targets: Codex links to the npm package Skill; SealSeek uses a managed copy in the active workspace and registration metadata.
- Keep configuration, login tokens, company addresses, and private project data outside the npm package. Check the package contents with `npm pack --dry-run` before publishing.
- Before a state-dependent project write, resolve the target, read a compact project-scoped context, preview server-side, use the returned context token and one idempotency key, then verify the returned ID by readback. On `PROJECT_STATE_CHANGED`, reread context and resolve any ambiguity.
- Run `npm test`, Skill format/portability/capability validation, and package-content inspection before release. Publish only when requested or when a release has been approved.
- If npm requests browser-based publishing authorization, send the complete authorization link as copyable text; do not open a browser on the user's behalf. Verify the registry version after publishing.
