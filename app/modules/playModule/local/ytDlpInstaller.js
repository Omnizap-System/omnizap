import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YTDlpWrapImport from 'yt-dlp-wrap';

const YTDlpWrap = YTDlpWrapImport?.default || YTDlpWrapImport;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_BIN_DIR = path.join(__dirname, 'bin');
const DEFAULT_BINARY_NAME = os.platform() === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
export const DEFAULT_YTDLP_BINARY_PATH = path.join(DEFAULT_BIN_DIR, DEFAULT_BINARY_NAME);

export const installYtDlpBinary = async ({ binaryPath = DEFAULT_YTDLP_BINARY_PATH } = {}) => {
  const targetPath = path.resolve(binaryPath);
  const targetDir = path.dirname(targetPath);

  await fs.promises.mkdir(targetDir, { recursive: true });
  await YTDlpWrap.downloadFromGithub(targetPath, undefined, os.platform());

  if (os.platform() !== 'win32') {
    await fs.promises.chmod(targetPath, 0o755);
  }

  return targetPath;
};
