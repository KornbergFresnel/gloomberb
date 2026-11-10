import { describe, expect, test } from "bun:test";
import { APPRUN, DESKTOP_ENTRY, linuxDesktopArchive } from "./build-linux-appimage";

// The archive the release's own manifest names is what an installed app's
// updater downloads, so the AppImage must pack the same file.

describe("the AppImage's source archive", () => {
  const names = ["stable-linux-x64-update.json", "stable-linux-x64-Gloom.tar.zst"];

  test("the one the manifest names, when it is beside it", () => {
    expect(linuxDesktopArchive(names, { artifact: { file: "stable-linux-x64-Gloom.tar.zst" } }, "stable"))
      .toEqual({ archive: "stable-linux-x64-Gloom.tar.zst" });
  });

  test("the name Electrobun gives the archive when the manifest names none, or one that is not there", () => {
    expect(linuxDesktopArchive(names, {}, "stable")).toEqual({ archive: "stable-linux-x64-Gloom.tar.zst" });
    expect(linuxDesktopArchive(names, { artifact: { file: "elsewhere.tar.zst" } }, "stable"))
      .toEqual({ archive: "stable-linux-x64-Gloom.tar.zst" });
  });

  test("nothing without the channel's manifest: no AppImage of a build that is not there", () => {
    expect(linuxDesktopArchive(names, {}, "nightly")).toBeNull();
    expect(linuxDesktopArchive(["stable-linux-x64-Gloom.tar.zst"], {}, "stable")).toBeNull();
  });
});

// The launcher reads ../Resources/build.json relative to its working directory
// (window/create.ts), so AppRun must run it from the app's bin folder; the
// desktop entry must enter through AppRun, the only executable at the AppDir
// root, and say the class the window carries for the dock to group it.

describe("the AppImage's wrapper", () => {
  test("AppRun runs the launcher from the app's own bin folder, at the AppImage's mount", () => {
    expect(APPRUN).toContain('APPDIR="${APPDIR:-');
    expect(APPRUN).toContain('APP_ROOT="$APPDIR/Gloom"');
    expect(APPRUN).toContain('cd "$APP_ROOT/bin"');
    expect(APPRUN).toContain('exec "$APP_ROOT/bin/launcher" "$@"');
  });

  test("the desktop entry enters through AppRun, with the app's icon, scheme and window class", () => {
    expect(DESKTOP_ENTRY).toContain("Exec=AppRun %U");
    expect(DESKTOP_ENTRY).toContain("Icon=gloom");
    expect(DESKTOP_ENTRY).toContain("StartupWMClass=Gloom");
    expect(DESKTOP_ENTRY).toContain("MimeType=x-scheme-handler/gloomberb;");
  });
});
