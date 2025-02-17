/**
 * @file
 *
 * This file has all helperfunctions related to configuration.
 */

/** */
import { existsSync, lstatSync } from 'fs';
import { Dir, Json } from 'mylas';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import {
  IConfig,
  IOutput,
  IProjectConfig,
  IRawTSConfig,
  ITSConfig,
  ReplaceTscAliasPathsOptions
} from '../interfaces';
import { Output, PathCache, TrieNode } from '../utils';
import { importReplacers } from './replacers';
import normalizePath = require('normalize-path');

/**
 * prepareConfig prepares a IConfig object for tsc-alias to be used.
 * @param {ReplaceTscAliasPathsOptions} options options that are used to prepare a config object.
 * @returns {Promise<IConfig>} a promise of a IConfig object.
 */
export async function prepareConfig(
  options: ReplaceTscAliasPathsOptions
): Promise<IConfig> {
  const output = options.output ?? new Output(options.verbose, options.debug);

  const configFile = !options.configFile
    ? resolve(process.cwd(), 'tsconfig.json')
    : !isAbsolute(options.configFile)
    ? resolve(process.cwd(), options.configFile)
    : options.configFile;

  output.assert(existsSync(configFile), `Invalid file path => ${configFile}`);

  const {
    baseUrl = '',
    outDir,
    declarationDir,
    paths,
    replacers,
    resolveFullPaths,
    verbose,
    fileExtensions
  } = loadConfig(configFile, output);

  if (options?.fileExtensions?.inputGlob) {
    fileExtensions.inputGlob = options.fileExtensions.inputGlob;
  }
  if (options?.fileExtensions?.outputCheck) {
    fileExtensions.outputCheck = options.fileExtensions.outputCheck;
  }

  output.verbose = verbose;

  if (options.resolveFullPaths || resolveFullPaths) {
    output.debug('resolveFullPaths is active');
    options.resolveFullPaths = true;
  }

  const _outDir = options.outDir ?? outDir;
  if (declarationDir && _outDir !== declarationDir) {
    options.declarationDir ??= declarationDir;
  }

  output.assert(_outDir, 'compilerOptions.outDir is not set');

  const configDir: string = normalizePath(dirname(configFile));

  // config with project details and paths
  const projectConfig: IProjectConfig = {
    configFile: configFile,
    baseUrl: baseUrl,
    outDir: _outDir,
    configDir: configDir,
    outPath: _outDir,
    confDirParentFolderName: basename(configDir),
    hasExtraModule: false,
    configDirInOutPath: null,
    relConfDirPathInOutPath: null,
    pathCache: new PathCache(!options.watch, fileExtensions?.outputCheck),
    inputGlob:
      fileExtensions?.inputGlob || '{mjs,cjs,js,jsx,d.{mts,cts,ts,tsx}}'
  };
  output.debug('loaded project config:', projectConfig);

  const config: IConfig = {
    ...projectConfig,
    output: output,
    aliasTrie:
      options.aliasTrie ?? TrieNode.buildAliasTrie(projectConfig, paths),
    replacers: []
  };
  output.debug('loaded full config:', config);

  // Import replacers.
  await importReplacers(config, replacers, options.replacers);
  return config;
}

/**
 * loadConfig loads a config file from fs.
 * @param {string} file file path to the config file that will be loaded.
 * @param {IOutput} output the output instance to log error to.
 * @returns {ITSConfig} a ITSConfig object
 */
export const loadConfig = (file: string, output: IOutput): ITSConfig => {
  if (!existsSync(file)) {
    output.error(`File ${file} not found`, true);
  }
  output.debug('Loading config file:', file);
  const {
    extends: ext,
    compilerOptions: { baseUrl, outDir, declarationDir, paths } = {
      baseUrl: undefined,
      outDir: undefined,
      declarationDir: undefined,
      paths: undefined
    },
    'tsc-alias': TSCAliasConfig
  } = Json.loadS<IRawTSConfig>(file, true);

  const configDir = dirname(file);
  output.debug('configDir', configDir);
  const config: ITSConfig = {};

  if (baseUrl) config.baseUrl = baseUrl;
  if (outDir) {
    config.outDir = isAbsolute(outDir) ? outDir : join(configDir, outDir);
  }
  if (paths) config.paths = paths;
  if (declarationDir) {
    config.declarationDir = isAbsolute(declarationDir)
      ? declarationDir
      : join(configDir, declarationDir);
  }
  if (TSCAliasConfig?.replacers) {
    config.replacers = TSCAliasConfig.replacers;
  }
  if (TSCAliasConfig?.resolveFullPaths) {
    config.resolveFullPaths = TSCAliasConfig.resolveFullPaths;
  }
  if (TSCAliasConfig?.verbose) {
    config.verbose = TSCAliasConfig.verbose;
  }
  if (TSCAliasConfig?.fileExtensions) {
    config.fileExtensions = TSCAliasConfig.fileExtensions;
  }

  const replacerFile = config.replacers?.pathReplacer?.file;

  if (replacerFile) {
    config.replacers.pathReplacer.file = join(configDir, replacerFile);
  }

  output.debug('loaded config (from file):', config);
  if (ext) {
    return {
      ...(ext.startsWith('.')
        ? loadConfig(
            join(configDir, ext.endsWith('.json') ? ext : `${ext}.json`),
            output
          )
        : loadConfig(resolveTsConfigExtendsPath(ext, file), output)),
      ...config
    };
  }

  return config;
};

/**
 * resolveTsConfigExtendsPath resolves the path to the config file that is being inherited.
 * @param {string} ext the value of the extends field in the loaded config file.
 * @param {string} file file path to the config file that was loaded.
 * @returns {string} a file path to the config file that is being inherited.
 */
export function resolveTsConfigExtendsPath(ext: string, file: string): string {
  const tsConfigDir = dirname(file);
  const node_modules: string[] = Dir.nodeModules({ cwd: tsConfigDir }); // Getting all node_modules directories.
  const targetPaths = node_modules.map((v) => join(tsConfigDir, v, ext)); // Mapping node_modules to target paths.

  // Recursively checking ancestor directories for tsconfig.
  for (const targetPath of targetPaths) {
    if (ext.endsWith('.json')) {
      // Check if the file exists.
      if (existsSync(targetPath)) {
        return targetPath;
      } else {
        continue; // Continue checking when ext is a file but not yet found.
      }
    }
    let isDirectory = false;
    try {
      const stats = lstatSync(targetPath);
      isDirectory = stats.isDirectory() || stats.isSymbolicLink();
    } catch (err) {}
    if (isDirectory) {
      return join(targetPath, 'tsconfig.json');
    } else {
      // When target is not a file nor directory check with '.json' extension.
      if (existsSync(`${targetPath}.json`)) {
        return `${targetPath}.json`;
      }
    }
  }
}
