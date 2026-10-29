// Workspace boundary rules (okf:architecture/boundary-rule). Run by
// `pnpm lint` as `depcruise packages`.
//
// Workspace packages are imported by name (`@multitap/addon-protocol`); pnpm links them into
// node_modules and the resolver follows the link to the real path, so the rules
// below match on repository paths.

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'core-allowed-imports',
      comment:
        'packages/core may import only packages/addon-protocol, packages/api and its own code. ' +
        'It knows nothing about the applications built on it.',
      severity: 'error',
      from: { path: '^packages/core/' },
      to: {
        path: '^packages/',
        pathNot: '^packages/(core|addon-protocol|api)/',
      },
    },
    {
      name: 'addon-protocol-no-workspace-imports',
      comment: 'packages/addon-protocol imports nothing from the workspace.',
      severity: 'error',
      from: { path: '^packages/addon-protocol/' },
      to: { path: '^packages/', pathNot: '^packages/addon-protocol/' },
    },
    {
      name: 'api-allowed-imports',
      comment:
        'packages/api may import packages/addon-protocol (shared types), nothing else: ' +
        'never the server.',
      severity: 'error',
      from: { path: '^packages/api/' },
      to: {
        path: '^packages/',
        pathNot: '^packages/(api|addon-protocol)/',
      },
    },
    {
      name: 'not-to-unresolvable',
      comment:
        'Every import must resolve. Except in the /dev page, which runs in a browser and ' +
        "imports URLs that Multitap serves (/dev/hls.mjs, from hls.js's node_modules).",
      severity: 'error',
      from: { pathNot: '^packages/core/dev/' },
      to: { couldNotResolve: true },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-dev-dep',
      comment: 'Runtime code (src/) must not depend on devDependencies.',
      severity: 'error',
      from: { path: '^packages/[^/]+/src/' },
      to: {
        dependencyTypes: ['npm-dev'],
        // Type-only imports are erased at runtime.
        dependencyTypesNot: ['type-only'],
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Build output is never an import target (ESLint's no-restricted-imports
    // rejects dist/ paths), so it is left out of the graph.
    exclude: { path: '^packages/[^/]+/dist/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['development', 'import', 'types', 'node', 'default'],
      extensions: ['.ts', '.js', '.json'],
      mainFields: ['module', 'main', 'types'],
    },
  },
};
