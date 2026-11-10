/**
 * Packs the Linux desktop app as an AppImage beside the release files the
 * build already made: `bun scripts/build-linux-appimage.ts <artifacts> [channel=stable]`.
 *
 * The AppImage holds the update archive's app tree unchanged, so it is the
 * same build the updater serves; only the wrapper differs. An AppImage install
 * does not update in place — its runtime mounts read-only, which the app's
 * update check knows and says (src/renderers/electrobun/bun/desktop/update.ts)
 * — so each release is a new download.
 *
 * appimagetool comes from `--appimagetool <path>` or $APPIMAGETOOL, or is
 * fetched pinned by digest: its `continuous` tag moves, and the tool packs a
 * file users run.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import pkg from "../package.json";
import { DESKTOP_APP_NAME, DESKTOP_APP_IDENTIFIER } from "../src/renderers/electrobun/shared/app-name";

const APPIMAGETOOL_URL = "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage";
/** The digest of APPIMAGETOOL_URL; moving to a new build of the tool changes it on purpose. */
const APPIMAGETOOL_SHA256 = "e8c1169c4af66c3184d7ee110713d4be04befe671fa358e2c1591ee840553b03";

/** What an Electrobun update manifest says about the archive it describes. */
export interface UpdateManifest {
  artifact?: { file?: string };
}

/**
 * The update archive the AppImage packs: the one the manifest names when it is
 * beside it, else the name Electrobun gives the Linux archive. Nothing when the
 * channel's manifest is missing, which is the caller's build to answer for.
 */
export function linuxDesktopArchive(
  names: readonly string[],
  manifest: UpdateManifest | null,
  channel: string,
): { archive: string } | null {
  const manifestName = `${channel}-linux-x64-update.json`;
  if (!names.includes(manifestName) || !manifest) return null;
  const named = manifest.artifact?.file;
  if (named && names.includes(named)) return { archive: named };
  return { archive: `${channel}-linux-x64-Gloom.tar.zst` };
}

/**
 * The AppImage's entry point. The launcher reads `../Resources/build.json`
 * relative to its working directory, so it runs from the app's own `bin`, the
 * way the desktop measure's launches do; APPDIR is where the AppImage runtime
 * already points, and the symlink walk keeps a plain unpacked AppDir working.
 */
export const APPRUN = `#!/bin/sh
set -eu

SOURCE="$0"
while [ -L "$SOURCE" ]; do
  SOURCE_DIR="$(CDPATH= cd -- "$(dirname -- "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  case "$SOURCE" in
    /*) ;;
    *) SOURCE="$SOURCE_DIR/$SOURCE" ;;
  esac
done

APPDIR="\${APPDIR:-$(CDPATH= cd -- "$(dirname -- "$SOURCE")" && pwd)}"
APP_ROOT="$APPDIR/${DESKTOP_APP_NAME}"
cd "$APP_ROOT/bin"
exec "$APP_ROOT/bin/launcher" "$@"
`;

/** The desktop entry AppImage integrations read; AppRun is the executable the AppDir root has. */
export const DESKTOP_ENTRY = `[Desktop Entry]
Type=Application
Name=${DESKTOP_APP_NAME}
Comment=${pkg.description}
Exec=AppRun %U
Icon=gloom
Terminal=false
Categories=Office;Finance;
StartupWMClass=${DESKTOP_APP_NAME}
MimeType=x-scheme-handler/gloomberb;
`;

function run(command: string[], cwd: string, env: NodeJS.ProcessEnv = {}): void {
  const result = Bun.spawnSync(command, { cwd, stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed with exit code ${result.exitCode}`);
}

/** The appimagetool to pack with: the caller's, or the pinned download. */
async function appimagetool(flag: string | undefined, cache: string): Promise<string> {
  const given = flag ?? process.env.APPIMAGETOOL;
  if (given) {
    if (!existsSync(given)) throw new Error(`appimagetool is not at ${given}`);
    chmodSync(given, 0o755);
    return given;
  }
  const tool = join(cache, "appimagetool");
  if (existsSync(tool)) {
    chmodSync(tool, 0o755);
    return tool;
  }
  const response = await fetch(APPIMAGETOOL_URL);
  if (!response.ok) throw new Error(`Could not fetch appimagetool: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (digest !== APPIMAGETOOL_SHA256) throw new Error(`appimagetool's digest is ${digest}, not the pinned ${APPIMAGETOOL_SHA256}`);
  mkdirSync(cache, { recursive: true });
  await Bun.write(tool, bytes);
  chmodSync(tool, 0o755);
  return tool;
}

/**
 * Packs the channel's Linux desktop archive in `dir` as
 * `<channel>-linux-x64-${DESKTOP_APP_NAME}.AppImage`. Resolves to its path.
 */
export async function buildLinuxAppImage(dir: string, channel = "stable", appimagetoolFlag?: string): Promise<string> {
  const manifestName = `${channel}-linux-x64-update.json`;
  const names = readdirSync(dir).sort();
  const manifest = names.includes(manifestName) ? JSON.parse(readFileSync(join(dir, manifestName), "utf8")) as UpdateManifest : null;
  const source = linuxDesktopArchive(names, manifest, channel);
  if (!source) throw new Error(`No ${manifestName} in ${dir}; build the desktop app first (bun run desktop:release).`);

  const root = join(resolve(dir), "..", "build");
  const work = join(root, `linux-appimage-${process.pid}-${Date.now().toString(36)}`);
  const appdir = join(work, `${DESKTOP_APP_NAME}.AppDir`);
  mkdirSync(appdir, { recursive: true });
  try {
    // Unpacked with the system tar, as Electrobun packs it, so what the AppImage
    // runs is the update archive's tree as the updater installs it.
    const extract = join(work, "extract");
    mkdirSync(extract, { recursive: true });
    await Bun.write(join(extract, "in.tar"), Bun.zstdDecompressSync(await Bun.file(join(dir, source.archive)).bytes()));
    run(["tar", "-xf", "in.tar", "-C", extract], extract);
    rmSync(join(extract, "in.tar"));
    const top = readdirSync(extract);
    if (top.length !== 1 || top[0] !== DESKTOP_APP_NAME) {
      throw new Error(`${source.archive} should hold one folder, ${DESKTOP_APP_NAME}; it holds ${top.join(", ") || "nothing"}`);
    }
    renameSync(join(extract, DESKTOP_APP_NAME), join(appdir, DESKTOP_APP_NAME));

    writeFileSync(join(appdir, "AppRun"), APPRUN);
    chmodSync(join(appdir, "AppRun"), 0o755);
    writeFileSync(join(appdir, `${DESKTOP_APP_IDENTIFIER}.desktop`), DESKTOP_ENTRY);
    copyFileSync(join(resolve(import.meta.dir, ".."), "icon.iconset", "icon_512x512.png"), join(appdir, "gloom.png"));
    symlinkSync("gloom.png", join(appdir, ".DirIcon"));

    const output = join(resolve(dir), `${channel}-linux-x64-${DESKTOP_APP_NAME}.AppImage`);
    const tool = await appimagetool(appimagetoolFlag, join(root, "appimagetool"));
    run([tool, "--appimage-extract-and-run", "-n", appdir, output], work, { ARCH: "x86_64", VERSION: pkg.version });
    if (!existsSync(output)) throw new Error(`appimagetool wrote no ${output}`);
    return output;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [dir, channel, flag] = process.argv.slice(2);
  if (!dir || !existsSync(dir) || (flag && flag !== "--appimagetool")) {
    console.error("Usage: bun scripts/build-linux-appimage.ts <artifacts folder> [channel] [--appimagetool <path>]");
    process.exit(1);
  }
  const output = await buildLinuxAppImage(resolve(dir), channel ?? "stable", process.argv.includes("--appimagetool") ? process.argv[process.argv.indexOf("--appimagetool") + 1] : undefined);
  console.log(`Built ${output}`);
}
