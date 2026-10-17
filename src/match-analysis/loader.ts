import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createPromptPackage, packageNames } from './package.js';
import { AnalysisError, type PackageFiles, type PromptPackage } from './types.js';
import { ensure, object, parse } from './values.js';

export async function loadPromptPackage(directory: string): Promise<PromptPackage> {
  try {
    const files = Object.fromEntries(await Promise.all(packageNames.map(async name => {
      const bytes = await readFile(join(directory, name));
      const content = bytes.toString('utf8');
      ensure(Buffer.from(content, 'utf8').equals(bytes), 'invalid-package');
      return [name, content];
    })));
    const profile = parse(files['profile.json'], 'invalid-package');
    const evidence = object(profile) && profile.calibration === 'candidate' && object(profile.calibrationReport) && typeof profile.calibrationReport.path === 'string'
      ? await readFile(resolve(directory, profile.calibrationReport.path), 'utf8') : null;
    return createPromptPackage(files as PackageFiles, evidence);
  } catch (error) {
    if (error instanceof AnalysisError) throw error;
    throw new AnalysisError('invalid-package');
  }
}
