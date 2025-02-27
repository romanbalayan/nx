import {
  createNodesFromFiles,
  detectPackageManager,
  getPackageManagerCommand,
  joinPathFragments,
  logger,
  normalizePath,
  readJsonFile,
  writeJsonFile,
  type CreateDependencies,
  type CreateNodes,
  type CreateNodesContext,
  type CreateNodesResult,
  type CreateNodesV2,
  type NxJsonConfiguration,
  type ProjectConfiguration,
  type TargetConfiguration,
} from '@nx/devkit';
import { getNamedInputs } from '@nx/devkit/src/utils/get-named-inputs';
import { minimatch } from 'minimatch';
import { existsSync, readdirSync, statSync } from 'node:fs';
import {
  basename,
  dirname,
  extname,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path';
import { hashArray, hashFile, hashObject } from 'nx/src/hasher/file-hasher';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { getLockFileName } from 'nx/src/plugins/js/lock-file/lock-file';
import { workspaceDataDirectory } from 'nx/src/utils/cache-directory';
import type { ParsedCommandLine } from 'typescript';
import { readTsConfig } from '../../utils/typescript/ts-config';
import { addBuildAndWatchDepsTargets } from './util';

export interface TscPluginOptions {
  typecheck?:
    | boolean
    | {
        targetName?: string;
      };
  build?:
    | boolean
    | {
        targetName?: string;
        configName?: string;
        buildDepsName?: string;
        watchDepsName?: string;
      };
  verboseOutput?: boolean;
}

interface NormalizedPluginOptions {
  typecheck:
    | false
    | {
        targetName: string;
      };
  build:
    | false
    | {
        targetName: string;
        configName: string;
        buildDepsName?: string;
        watchDepsName?: string;
      };
  verboseOutput: boolean;
}

type TscProjectResult = Pick<ProjectConfiguration, 'targets'>;

const pmc = getPackageManagerCommand();

function readTargetsCache(cachePath: string): Record<string, TscProjectResult> {
  return process.env.NX_CACHE_PROJECT_GRAPH !== 'false' && existsSync(cachePath)
    ? readJsonFile(cachePath)
    : {};
}

function writeTargetsToCache(
  cachePath: string,
  results?: Record<string, TscProjectResult>
) {
  writeJsonFile(cachePath, results);
}

/**
 * @deprecated The 'createDependencies' function is now a no-op. This functionality is included in 'createNodesV2'.
 */
export const createDependencies: CreateDependencies = () => {
  return [];
};

export const PLUGIN_NAME = '@nx/js/typescript';

const tsConfigGlob = '**/tsconfig*.json';

export const createNodesV2: CreateNodesV2<TscPluginOptions> = [
  tsConfigGlob,
  async (configFilePaths, options, context) => {
    const optionsHash = hashObject(options);
    const cachePath = join(workspaceDataDirectory, `tsc-${optionsHash}.hash`);
    const targetsCache = readTargetsCache(cachePath);
    const normalizedOptions = normalizePluginOptions(options);
    const lockFileName = getLockFileName(
      detectPackageManager(context.workspaceRoot)
    );
    try {
      return await createNodesFromFiles(
        (configFile, options, context) =>
          createNodesInternal(
            configFile,
            options,
            context,
            lockFileName,
            targetsCache
          ),
        configFilePaths,
        normalizedOptions,
        context
      );
    } finally {
      writeTargetsToCache(cachePath, targetsCache);
    }
  },
];

export const createNodes: CreateNodes<TscPluginOptions> = [
  tsConfigGlob,
  async (configFilePath, options, context) => {
    logger.warn(
      '`createNodes` is deprecated. Update your plugin to utilize createNodesV2 instead. In Nx 20, this will change to the createNodesV2 API.'
    );
    const normalizedOptions = normalizePluginOptions(options);
    const lockFileName = getLockFileName(
      detectPackageManager(context.workspaceRoot)
    );
    return createNodesInternal(
      configFilePath,
      normalizedOptions,
      context,
      lockFileName,
      {}
    );
  },
];

async function createNodesInternal(
  configFilePath: string,
  options: NormalizedPluginOptions,
  context: CreateNodesContext,
  lockFileName: string,
  targetsCache: Record<string, TscProjectResult>
): Promise<CreateNodesResult> {
  const projectRoot = dirname(configFilePath);
  const fullConfigPath = joinPathFragments(
    context.workspaceRoot,
    configFilePath
  );

  // Do not create a project for the workspace root tsconfig files.
  if (projectRoot === '.') {
    return {};
  }

  // Do not create a project if package.json and project.json isn't there.
  const siblingFiles = readdirSync(join(context.workspaceRoot, projectRoot));
  if (
    !siblingFiles.includes('package.json') &&
    !siblingFiles.includes('project.json')
  ) {
    return {};
  }

  // Do not create a project if it's not a tsconfig.json and there is no tsconfig.json in the same directory
  if (
    basename(configFilePath) !== 'tsconfig.json' &&
    !siblingFiles.includes('tsconfig.json')
  ) {
    return {};
  }

  // Do not create project for Next.js projects since they are not compatible with
  // project references and typecheck will fail.
  if (
    siblingFiles.includes('next.config.js') ||
    siblingFiles.includes('next.config.cjs') ||
    siblingFiles.includes('next.config.mjs') ||
    siblingFiles.includes('next.config.ts')
  ) {
    return {};
  }

  /**
   * The cache key is composed by:
   * - hashes of the content of the relevant files that can affect what's inferred by the plugin:
   *   - current config file
   *   - config files extended by the current config file (recursively up to the root config file)
   *   - referenced config files that are internal to the owning Nx project of the current config file, or is a shallow external reference of the owning Nx project
   *   - lock file
   * - hash of the plugin options
   * - current config file path
   */
  const tsConfig = readCachedTsConfig(fullConfigPath);
  const extendedConfigFiles = getExtendedConfigFiles(fullConfigPath, tsConfig);
  const internalReferencedFiles = resolveInternalProjectReferences(
    tsConfig,
    context.workspaceRoot,
    projectRoot
  );
  const externalProjectReferences = resolveShallowExternalProjectReferences(
    tsConfig,
    context.workspaceRoot,
    projectRoot
  );

  const packageJsonPath = joinPathFragments(projectRoot, 'package.json');
  const packageJson = existsSync(packageJsonPath)
    ? readJsonFile(packageJsonPath)
    : null;

  const nodeHash = hashArray([
    ...[
      fullConfigPath,
      ...extendedConfigFiles.files,
      ...Object.keys(internalReferencedFiles),
      ...Object.keys(externalProjectReferences),
      join(context.workspaceRoot, lockFileName),
    ].map(hashFile),
    hashObject(options),
    ...(packageJson ? [hashObject(packageJson)] : []),
  ]);
  const cacheKey = `${nodeHash}_${configFilePath}`;

  targetsCache[cacheKey] ??= buildTscTargets(
    fullConfigPath,
    projectRoot,
    options,
    context
  );

  const { targets } = targetsCache[cacheKey];

  return {
    projects: {
      [projectRoot]: {
        projectType: 'library',
        targets,
      },
    },
  };
}

function buildTscTargets(
  configFilePath: string,
  projectRoot: string,
  options: NormalizedPluginOptions,
  context: CreateNodesContext
) {
  const targets: Record<string, TargetConfiguration> = {};
  const namedInputs = getNamedInputs(projectRoot, context);
  const tsConfig = readCachedTsConfig(configFilePath);

  let internalProjectReferences: Record<string, ParsedCommandLine>;
  // Typecheck target
  if (basename(configFilePath) === 'tsconfig.json' && options.typecheck) {
    internalProjectReferences = resolveInternalProjectReferences(
      tsConfig,
      context.workspaceRoot,
      projectRoot
    );
    const externalProjectReferences = resolveShallowExternalProjectReferences(
      tsConfig,
      context.workspaceRoot,
      projectRoot
    );
    const targetName = options.typecheck.targetName;
    if (!targets[targetName]) {
      let command = `tsc --build --emitDeclarationOnly${
        options.verboseOutput ? ' --verbose' : ''
      }`;
      if (
        tsConfig.options.noEmit ||
        Object.values(internalProjectReferences).some(
          (ref) => ref.options.noEmit
        ) ||
        Object.values(externalProjectReferences).some(
          (ref) => ref.options.noEmit
        )
      ) {
        // `tsc --build` does not work with `noEmit: true`
        command = `echo "The 'typecheck' target is disabled because one or more project references set 'noEmit: true' in their tsconfig. Remove this property to resolve this issue."`;
      }

      targets[targetName] = {
        dependsOn: [`^${targetName}`],
        command,
        options: { cwd: projectRoot },
        cache: true,
        inputs: getInputs(
          namedInputs,
          configFilePath,
          tsConfig,
          internalProjectReferences,
          context.workspaceRoot,
          projectRoot
        ),
        outputs: getOutputs(
          configFilePath,
          tsConfig,
          internalProjectReferences,
          context.workspaceRoot,
          projectRoot
        ),
        syncGenerators: ['@nx/js:typescript-sync'],
        metadata: {
          technologies: ['typescript'],
          description: 'Runs type-checking for the project.',
          help: {
            command: `${pmc.exec} tsc --build --help`,
            example: {
              args: ['--force'],
            },
          },
        },
      };
    }
  }

  // Build target
  if (
    options.build &&
    basename(configFilePath) === options.build.configName &&
    isValidPackageJsonBuildConfig(tsConfig, context.workspaceRoot, projectRoot)
  ) {
    internalProjectReferences ??= resolveInternalProjectReferences(
      tsConfig,
      context.workspaceRoot,
      projectRoot
    );
    const targetName = options.build.targetName;

    targets[targetName] = {
      dependsOn: [`^${targetName}`],
      command: `tsc --build ${options.build.configName}${
        options.verboseOutput ? ' --verbose' : ''
      }`,
      options: { cwd: projectRoot },
      cache: true,
      inputs: getInputs(
        namedInputs,
        configFilePath,
        tsConfig,
        internalProjectReferences,
        context.workspaceRoot,
        projectRoot
      ),
      outputs: getOutputs(
        configFilePath,
        tsConfig,
        internalProjectReferences,
        context.workspaceRoot,
        projectRoot
      ),
      syncGenerators: ['@nx/js:typescript-sync'],
      metadata: {
        technologies: ['typescript'],
        description: 'Builds the project with `tsc`.',
        help: {
          command: `${pmc.exec} tsc --build --help`,
          example: {
            args: ['--force'],
          },
        },
      },
    };

    addBuildAndWatchDepsTargets(
      context.workspaceRoot,
      projectRoot,
      targets,
      {
        buildDepsTargetName: options.build.buildDepsName,
        watchDepsTargetName: options.build.watchDepsName,
      },
      pmc
    );
  }

  return { targets };
}

function getInputs(
  namedInputs: NxJsonConfiguration['namedInputs'],
  configFilePath: string,
  tsConfig: ParsedCommandLine,
  internalProjectReferences: Record<string, ParsedCommandLine>,
  workspaceRoot: string,
  projectRoot: string
): TargetConfiguration['inputs'] {
  const configFiles = new Set<string>();
  const externalDependencies = ['typescript'];

  const extendedConfigFiles = getExtendedConfigFiles(configFilePath, tsConfig);
  extendedConfigFiles.files.forEach((configPath) => {
    configFiles.add(configPath);
  });
  externalDependencies.push(...extendedConfigFiles.packages);

  const includePaths = new Set<string>();
  const excludePaths = new Set<string>();
  const projectTsConfigFiles: [string, ParsedCommandLine][] = [
    [configFilePath, tsConfig],
    ...Object.entries(internalProjectReferences),
  ];
  const absoluteProjectRoot = join(workspaceRoot, projectRoot);
  projectTsConfigFiles.forEach(([configPath, config]) => {
    configFiles.add(configPath);
    const offset = relative(absoluteProjectRoot, dirname(configPath));
    (config.raw?.include ?? []).forEach((p: string) =>
      includePaths.add(join(offset, p))
    );

    if (config.raw?.exclude) {
      /**
       * We need to filter out the exclude paths that are already included in
       * other tsconfig files. If they are not included in other tsconfig files,
       * they still correctly apply to the current file and we should keep them.
       */
      const otherFilesInclude: string[] = [];
      projectTsConfigFiles.forEach(([path, c]) => {
        if (path !== configPath) {
          otherFilesInclude.push(...(c.raw?.include ?? []));
        }
      });
      const normalize = (p: string) => (p.startsWith('./') ? p.slice(2) : p);
      config.raw.exclude.forEach((excludePath: string) => {
        if (
          !otherFilesInclude.some(
            (includePath) =>
              minimatch(normalize(includePath), normalize(excludePath)) ||
              minimatch(normalize(excludePath), normalize(includePath))
          )
        ) {
          excludePaths.add(excludePath);
        }
      });
    }
  });

  const inputs: TargetConfiguration['inputs'] = [];
  if (includePaths.size) {
    if (existsSync(join(workspaceRoot, projectRoot, 'package.json'))) {
      inputs.push('{projectRoot}/package.json');
    }
    inputs.push(
      ...Array.from(configFiles).map((p: string) =>
        pathToInputOrOutput(p, workspaceRoot, projectRoot)
      ),
      ...Array.from(includePaths).map((p: string) =>
        pathToInputOrOutput(
          joinPathFragments(projectRoot, p),
          workspaceRoot,
          projectRoot
        )
      )
    );
  } else {
    // If we couldn't identify any include paths, we default to the default
    // named inputs.
    inputs.push('production' in namedInputs ? 'production' : 'default');
  }

  if (excludePaths.size) {
    inputs.push(
      ...Array.from(excludePaths).map(
        (p: string) =>
          `!${pathToInputOrOutput(
            joinPathFragments(projectRoot, p),
            workspaceRoot,
            projectRoot
          )}`
      )
    );
  }

  if (
    hasExternalProjectReferences(
      configFilePath,
      tsConfig,
      workspaceRoot,
      projectRoot
    )
  ) {
    // Importing modules from a referenced project will load its output declaration files (d.ts)
    // https://www.typescriptlang.org/docs/handbook/project-references.html#what-is-a-project-reference
    inputs.push({ dependentTasksOutputFiles: '**/*.d.ts' });
  } else {
    inputs.push('production' in namedInputs ? '^production' : '^default');
  }

  inputs.push({ externalDependencies });

  return inputs;
}

function getOutputs(
  configFilePath: string,
  tsConfig: ParsedCommandLine,
  internalProjectReferences: Record<string, ParsedCommandLine>,
  workspaceRoot: string,
  projectRoot: string
): string[] {
  const outputs = new Set<string>();

  // We could have more surgical outputs based on the tsconfig options, but the
  // user could override them through the command line and that wouldn't be
  // reflected in the outputs. So, we just include everything that could be
  // produced by the tsc command.
  [tsConfig, ...Object.values(internalProjectReferences)].forEach((config) => {
    if (config.options.outFile) {
      const outFileName = basename(config.options.outFile, '.js');
      const outFileDir = dirname(config.options.outFile);
      outputs.add(
        pathToInputOrOutput(config.options.outFile, workspaceRoot, projectRoot)
      );
      // outFile is not be used with .cjs, .mjs, .jsx, so the list is simpler
      const outDir = relative(workspaceRoot, outFileDir);
      outputs.add(
        pathToInputOrOutput(
          joinPathFragments(outDir, `${outFileName}.js.map`),
          workspaceRoot,
          projectRoot
        )
      );
      outputs.add(
        pathToInputOrOutput(
          joinPathFragments(outDir, `${outFileName}.d.ts`),
          workspaceRoot,
          projectRoot
        )
      );
      outputs.add(
        pathToInputOrOutput(
          joinPathFragments(outDir, `${outFileName}.d.ts.map`),
          workspaceRoot,
          projectRoot
        )
      );
      // https://www.typescriptlang.org/tsconfig#tsBuildInfoFile
      outputs.add(
        tsConfig.options.tsBuildInfoFile
          ? pathToInputOrOutput(
              tsConfig.options.tsBuildInfoFile,
              workspaceRoot,
              projectRoot
            )
          : pathToInputOrOutput(
              joinPathFragments(outDir, `${outFileName}.tsbuildinfo`),
              workspaceRoot,
              projectRoot
            )
      );
    } else if (config.options.outDir) {
      outputs.add(
        pathToInputOrOutput(config.options.outDir, workspaceRoot, projectRoot)
      );

      if (config.options.tsBuildInfoFile) {
        if (
          !normalize(config.options.tsBuildInfoFile).startsWith(
            `${normalize(config.options.outDir)}${sep}`
          )
        ) {
          // https://www.typescriptlang.org/tsconfig#tsBuildInfoFile
          outputs.add(
            pathToInputOrOutput(
              config.options.tsBuildInfoFile,
              workspaceRoot,
              projectRoot
            )
          );
        }
      } else if (config.options.rootDir && config.options.rootDir !== '.') {
        // If rootDir is set, then the tsbuildinfo file will be outside the outDir so we need to add it.
        const relativeRootDir = relative(
          config.options.rootDir,
          join(workspaceRoot, projectRoot)
        );
        outputs.add(
          pathToInputOrOutput(
            joinPathFragments(
              config.options.outDir,
              relativeRootDir,
              `*.tsbuildinfo`
            ),
            workspaceRoot,
            projectRoot
          )
        );
      }
    } else if (config.fileNames.length) {
      // tsc produce files in place when no outDir or outFile is set
      outputs.add(joinPathFragments('{projectRoot}', '**/*.js'));
      outputs.add(joinPathFragments('{projectRoot}', '**/*.cjs'));
      outputs.add(joinPathFragments('{projectRoot}', '**/*.mjs'));
      outputs.add(joinPathFragments('{projectRoot}', '**/*.jsx'));
      outputs.add(joinPathFragments('{projectRoot}', '**/*.js.map')); // should also include .cjs and .mjs data
      outputs.add(joinPathFragments('{projectRoot}', '**/*.jsx.map'));
      outputs.add(joinPathFragments('{projectRoot}', '**/*.d.ts'));
      outputs.add(joinPathFragments('{projectRoot}', '**/*.d.cts'));
      outputs.add(joinPathFragments('{projectRoot}', '**/*.d.mts'));
      outputs.add(joinPathFragments('{projectRoot}', '**/*.d.ts.map'));
      outputs.add(joinPathFragments('{projectRoot}', '**/*.d.cts.map'));
      outputs.add(joinPathFragments('{projectRoot}', '**/*.d.mts.map'));

      // https://www.typescriptlang.org/tsconfig#tsBuildInfoFile
      const name = basename(configFilePath, '.json');
      outputs.add(
        tsConfig.options.tsBuildInfoFile
          ? pathToInputOrOutput(
              tsConfig.options.tsBuildInfoFile,
              workspaceRoot,
              projectRoot
            )
          : joinPathFragments('{projectRoot}', `${name}.tsbuildinfo`)
      );
    }
  });

  return Array.from(outputs);
}

/**
 * Validates the build configuration of a `package.json` file by ensuring that paths in the `exports`, `module`,
 * and `main` fields reference valid output paths within the `outDir` defined in the TypeScript configuration.
 * Priority is given to the `exports` field, specifically the `.` export if defined. If `exports` is not defined,
 * the function falls back to validating `main` and `module` fields. If `outFile` is specified, it validates that the file
 * is located within the output directory.
 * If no `package.json` file exists, it assumes the configuration is valid.
 *
 * @param tsConfig The TypeScript configuration object.
 * @param workspaceRoot The workspace root path.
 * @param projectRoot The project root path.
 * @returns `true` if the package has a valid build configuration; otherwise, `false`.
 */
function isValidPackageJsonBuildConfig(
  tsConfig: ParsedCommandLine,
  workspaceRoot: string,
  projectRoot: string
): boolean {
  const packageJsonPath = join(workspaceRoot, projectRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    // If the package.json file does not exist.
    // Assume it's valid because it would be using `project.json` instead.
    return true;
  }
  const packageJson = readJsonFile(packageJsonPath);

  const outDir = tsConfig.options.outFile
    ? dirname(tsConfig.options.outFile)
    : tsConfig.options.outDir;
  const resolvedOutDir = outDir
    ? resolve(workspaceRoot, projectRoot, outDir)
    : undefined;

  const isPathSourceFile = (path: string): boolean => {
    if (resolvedOutDir) {
      const pathToCheck = resolve(workspaceRoot, projectRoot, path);
      return !pathToCheck.startsWith(resolvedOutDir);
    }

    const ext = extname(path);
    // Check that the file extension is a TS file extension. As the source files are in the same directory as the output files.
    return ['.ts', '.tsx', '.cts', '.mts'].includes(ext);
  };

  // Checks if the value is a path within the `src` directory.
  const containsInvalidPath = (
    value: string | Record<string, string>
  ): boolean => {
    if (typeof value === 'string') {
      return isPathSourceFile(value);
    } else if (typeof value === 'object') {
      return Object.entries(value).some(([currentKey, subValue]) => {
        // Skip types field
        if (currentKey === 'types') {
          return false;
        }
        if (typeof subValue === 'string') {
          return isPathSourceFile(subValue);
        }
        return false;
      });
    }
    return false;
  };

  const exports = packageJson?.exports;

  // Check the `.` export if `exports` is defined.
  if (exports) {
    if (typeof exports === 'string') {
      return !isPathSourceFile(exports);
    }
    if (typeof exports === 'object' && '.' in exports) {
      return !containsInvalidPath(exports['.']);
    }

    // Check other exports if `.` is not defined or valid.
    for (const key in exports) {
      if (key !== '.' && containsInvalidPath(exports[key])) {
        return false;
      }
    }

    return true;
  }

  // If `exports` is not defined, fallback to `main` and `module` fields.
  const buildPaths = ['main', 'module'];
  for (const field of buildPaths) {
    if (packageJson[field] && isPathSourceFile(packageJson[field])) {
      return false;
    }
  }

  return true;
}

function pathToInputOrOutput(
  path: string,
  workspaceRoot: string,
  projectRoot: string
): string {
  const fullProjectRoot = resolve(workspaceRoot, projectRoot);
  const fullPath = resolve(workspaceRoot, path);
  const pathRelativeToProjectRoot = normalizePath(
    relative(fullProjectRoot, fullPath)
  );
  if (pathRelativeToProjectRoot.startsWith('..')) {
    return joinPathFragments(
      '{workspaceRoot}',
      relative(workspaceRoot, fullPath)
    );
  }

  return joinPathFragments('{projectRoot}', pathRelativeToProjectRoot);
}

function getExtendedConfigFiles(
  tsConfigPath: string,
  tsConfig: ParsedCommandLine
): {
  files: string[];
  packages: string[];
} {
  const extendedConfigFiles = new Set<string>();
  const extendedExternalPackages = new Set<string>();

  let currentConfigPath = tsConfigPath;
  let currentConfig = tsConfig;
  while (currentConfig.raw?.extends) {
    const extendedConfigPath = resolveExtendedTsConfigPath(
      currentConfig.raw.extends,
      dirname(currentConfigPath)
    );
    if (!extendedConfigPath) {
      break;
    }
    if (extendedConfigPath.externalPackage) {
      extendedExternalPackages.add(extendedConfigPath.externalPackage);
      break;
    }
    extendedConfigFiles.add(extendedConfigPath.filePath);
    currentConfig = readCachedTsConfig(extendedConfigPath.filePath);
    currentConfigPath = extendedConfigPath.filePath;
  }

  return {
    files: Array.from(extendedConfigFiles),
    packages: Array.from(extendedExternalPackages),
  };
}

function resolveInternalProjectReferences(
  tsConfig: ParsedCommandLine,
  workspaceRoot: string,
  projectRoot: string,
  projectReferences: Record<string, ParsedCommandLine> = {}
): Record<string, ParsedCommandLine> {
  walkProjectReferences(
    tsConfig,
    workspaceRoot,
    projectRoot,
    (configPath, config) => {
      if (isExternalProjectReference(configPath, workspaceRoot, projectRoot)) {
        return false;
      } else {
        projectReferences[configPath] = config;
      }
    }
  );
  return projectReferences;
}

function resolveShallowExternalProjectReferences(
  tsConfig: ParsedCommandLine,
  workspaceRoot: string,
  projectRoot: string,
  projectReferences: Record<string, ParsedCommandLine> = {}
): Record<string, ParsedCommandLine> {
  walkProjectReferences(
    tsConfig,
    workspaceRoot,
    projectRoot,
    (configPath, config) => {
      if (isExternalProjectReference(configPath, workspaceRoot, projectRoot)) {
        projectReferences[configPath] = config;
      }
      return false;
    }
  );
  return projectReferences;
}

function walkProjectReferences(
  tsConfig: ParsedCommandLine,
  workspaceRoot: string,
  projectRoot: string,
  visitor: (configPath: string, config: ParsedCommandLine) => void | false, // false stops recursion
  projectReferences: Record<string, ParsedCommandLine> = {}
): Record<string, ParsedCommandLine> {
  if (!tsConfig.projectReferences?.length) {
    return projectReferences;
  }

  for (const ref of tsConfig.projectReferences) {
    let refConfigPath = ref.path;
    if (projectReferences[refConfigPath]) {
      // Already resolved
      continue;
    }

    if (!existsSync(refConfigPath)) {
      // the referenced tsconfig doesn't exist, ignore it
      continue;
    }

    if (!refConfigPath.endsWith('.json')) {
      refConfigPath = join(refConfigPath, 'tsconfig.json');
    }
    const refTsConfig = readCachedTsConfig(refConfigPath);
    const result = visitor(refConfigPath, refTsConfig);
    if (result !== false) {
      walkProjectReferences(refTsConfig, workspaceRoot, projectRoot, visitor);
    }
  }

  return projectReferences;
}

function hasExternalProjectReferences(
  tsConfigPath: string,
  tsConfig: ParsedCommandLine,
  workspaceRoot: string,
  projectRoot: string,
  seen = new Set<string>()
): boolean {
  if (!tsConfig.projectReferences?.length) {
    return false;
  }
  seen.add(tsConfigPath);

  for (const ref of tsConfig.projectReferences) {
    let refConfigPath = ref.path;
    if (seen.has(refConfigPath)) {
      // Already seen
      continue;
    }

    if (!existsSync(refConfigPath)) {
      // the referenced tsconfig doesn't exist, ignore it
      continue;
    }

    if (isExternalProjectReference(refConfigPath, workspaceRoot, projectRoot)) {
      return true;
    }

    if (!refConfigPath.endsWith('.json')) {
      refConfigPath = join(refConfigPath, 'tsconfig.json');
    }
    const refTsConfig = readCachedTsConfig(refConfigPath);
    const result = hasExternalProjectReferences(
      refConfigPath,
      refTsConfig,
      workspaceRoot,
      projectRoot,
      seen
    );

    if (result) {
      return true;
    }
  }

  return false;
}

function isExternalProjectReference(
  refTsConfigPath: string,
  workspaceRoot: string,
  projectRoot: string
): boolean {
  const absoluteProjectRoot = join(workspaceRoot, projectRoot);

  let currentPath = getTsConfigDirName(refTsConfigPath);

  if (relative(absoluteProjectRoot, currentPath).startsWith('..')) {
    // it's outside of the project root, so it's an external project reference
    return true;
  }

  while (currentPath !== absoluteProjectRoot) {
    if (
      existsSync(join(currentPath, 'package.json')) ||
      existsSync(join(currentPath, 'project.json'))
    ) {
      // it's inside a nested project root, so it's and external project reference
      return true;
    }
    currentPath = dirname(currentPath);
  }

  // it's inside the project root, so it's an internal project reference
  return false;
}

function getTsConfigDirName(tsConfigPath: string): string {
  return statSync(tsConfigPath).isFile()
    ? dirname(tsConfigPath)
    : normalize(tsConfigPath);
}

const tsConfigCache = new Map<string, ParsedCommandLine>();
function readCachedTsConfig(tsConfigPath: string): ParsedCommandLine {
  const cacheKey = getTsConfigCacheKey(tsConfigPath);

  if (tsConfigCache.has(cacheKey)) {
    return tsConfigCache.get(cacheKey)!;
  }

  const tsConfig = readTsConfig(tsConfigPath);
  tsConfigCache.set(cacheKey, tsConfig);

  return tsConfig;
}

function getTsConfigCacheKey(tsConfigPath: string): string {
  const timestamp = statSync(tsConfigPath).mtimeMs;

  return `${tsConfigPath}-${timestamp}`;
}

function normalizePluginOptions(
  pluginOptions: TscPluginOptions = {}
): NormalizedPluginOptions {
  const defaultTypecheckTargetName = 'typecheck';
  let typecheck: NormalizedPluginOptions['typecheck'] = {
    targetName: defaultTypecheckTargetName,
  };
  if (pluginOptions.typecheck === false) {
    typecheck = false;
  } else if (
    pluginOptions.typecheck &&
    typeof pluginOptions.typecheck !== 'boolean'
  ) {
    typecheck = {
      targetName:
        pluginOptions.typecheck.targetName ?? defaultTypecheckTargetName,
    };
  }

  const defaultBuildTargetName = 'build';
  const defaultBuildConfigName = 'tsconfig.lib.json';
  let build: NormalizedPluginOptions['build'] = {
    targetName: defaultBuildTargetName,
    configName: defaultBuildConfigName,
    buildDepsName: 'build-deps',
    watchDepsName: 'watch-deps',
  };
  // Build target is not enabled by default
  if (!pluginOptions.build) {
    build = false;
  } else if (pluginOptions.build && typeof pluginOptions.build !== 'boolean') {
    build = {
      targetName: pluginOptions.build.targetName ?? defaultBuildTargetName,
      configName: pluginOptions.build.configName ?? defaultBuildConfigName,
      buildDepsName: pluginOptions.build.buildDepsName ?? 'build-deps',
      watchDepsName: pluginOptions.build.watchDepsName ?? 'watch-deps',
    };
  }

  return {
    typecheck,
    build,
    verboseOutput: pluginOptions.verboseOutput ?? false,
  };
}

function resolveExtendedTsConfigPath(
  tsConfigPath: string,
  directory?: string
): { filePath: string; externalPackage?: string } | null {
  try {
    const resolvedPath = require.resolve(tsConfigPath, {
      paths: directory ? [directory] : undefined,
    });

    if (tsConfigPath.startsWith('.')) {
      return { filePath: resolvedPath };
    }

    // parse the package from the tsconfig path
    const packageName = tsConfigPath.startsWith('@')
      ? tsConfigPath.split('/').slice(0, 2).join('/')
      : tsConfigPath.split('/')[0];

    return { filePath: resolvedPath, externalPackage: packageName };
  } catch {
    return null;
  }
}
