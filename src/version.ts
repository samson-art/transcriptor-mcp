import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkgPath = join(process.cwd(), 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };

export const version = pkg.version;
